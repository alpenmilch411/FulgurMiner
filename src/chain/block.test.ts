// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeHeader, decodeHeader, encodeBlock, decodeBlock, HEADER_LEN, type BlockHeader, type Block } from './block.js';
import { TX_ENCODED_LEN, encodeTx, TxKind, type Transaction } from './transaction.js';
import { u32be, u64be } from '../util/binary.js';

function sampleHeader(timestamp = 1_700_000_000): BlockHeader {
  return {
    height: 5,
    prevHash: new Uint8Array(32).fill(1),
    txRoot: new Uint8Array(32).fill(2),
    stateRoot: new Uint8Array(32).fill(3),
    timestamp,
    difficulty: 0x1f00ffff,
    nonce: 42,
    miner: new Uint8Array(32).fill(4),
  };
}

describe('decodeHeader timestamp guard', () => {
  it('round-trips a normal header', () => {
    const dec = decodeHeader(encodeHeader(sampleHeader()));
    expect(dec.timestamp).toBe(1_700_000_000);
    expect(dec.height).toBe(5);
  });
  it('rejects a u64 timestamp beyond MAX_SAFE_INTEGER', () => {
    const buf = encodeHeader(sampleHeader());
    buf.set(u64be(BigInt(Number.MAX_SAFE_INTEGER) + 1n), 100); // timestamp field offset = 4+32+32+32
    expect(() => decodeHeader(buf)).toThrow('timestamp out of range');
  });
});

describe('decodeBlock rejects malformed blocks', () => {
  const emptyBlock: Block = { header: sampleHeader(), transactions: [] };
  it('round-trips an empty block', () => {
    const dec = decodeBlock(encodeBlock(emptyBlock));
    expect(dec.transactions).toHaveLength(0);
    expect(dec.header.height).toBe(5);
  });
  it('rejects a hostile txCount before the tx loop', () => {
    const buf = encodeBlock(emptyBlock);
    buf.set(u32be(1_000_000), HEADER_LEN); // claim 1e6 txs in a header-only buffer
    // the first decodeTx underruns and throws 'tx truncated'
    expect(() => decodeBlock(buf)).toThrow('tx truncated');
  });
  it('rejects an oversized buffer (trailing bytes)', () => {
    const buf = encodeBlock(emptyBlock);
    const longer = new Uint8Array(buf.length + TX_ENCODED_LEN);
    longer.set(buf, 0);
    longer.set(u32be(0), HEADER_LEN); // txCount still 0 but buffer is longer
    // the post-loop p !== buf.length guard fires
    expect(() => decodeBlock(longer)).toThrow('trailing bytes in block');
  });
});

// ---------------------------------------------------------------------------
// Decode-safety edge: a TRUNCATED Lock/Redeem tx inside a block — a
// length/count field claiming more bytes than the buffer holds — is NOT caught
// inside decodeTx (buf.slice silently clamps, readU*be has no bounds check); it
// is caught DOWNSTREAM at the block boundary. These pin the current reject so a
// future refactor that drops a downstream guard fails loudly. (This fix does NOT
// harden the decoders — it pins behavior only.)
// ---------------------------------------------------------------------------
describe('decodeBlock rejects truncated Lock/Redeem txs (decode-safety edge)', () => {
  /** Wrap a single (possibly-truncated) tx body in a 1-tx block buffer. */
  function blockWithTxBytes(txBytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(HEADER_LEN + 4 + txBytes.length);
    out.set(encodeHeader(sampleHeader()), 0);
    out.set(u32be(1), HEADER_LEN); // txCount = 1
    out.set(txBytes, HEADER_LEN + 4);
    return out;
  }

  const sampleRedeem = (): Transaction => ({
    kind: TxKind.Redeem,
    from: new Uint8Array(32),
    to: new Uint8Array(32).fill(2),
    amount: 5n, fee: 1n, nonce: 0,
    signature: new Uint8Array(0),
    lockId: new Uint8Array(32).fill(7),
    redeemScript: new Uint8Array(20).fill(0xab),
    witness: [new Uint8Array(8).fill(0xcd)],
  });

  const sampleLock = (): Transaction => ({
    kind: TxKind.Lock,
    from: new Uint8Array(32).fill(0x11),
    to: new Uint8Array(32),
    amount: 5n, fee: 1n, nonce: 0,
    signature: new Uint8Array(64).fill(0x22),
    scriptHash: new Uint8Array(32).fill(0x33),
  });

  it('rejects a Redeem whose declared redeemScript length exceeds the remaining buffer', () => {
    // scriptLen claims 20 bytes; only ~4 are present. decodeTx clamps but advances `next`
    // past the buffer end → the block loop sets p > buf.length → post-loop p!==buf.length.
    const truncated = encodeTx(sampleRedeem()).slice(0, 90);
    expect(() => decodeBlock(blockWithTxBytes(truncated))).toThrow('trailing bytes in block');
  });

  it('rejects a Lock truncated mid-from (readU64be underrun)', () => {
    // Truncating inside `from` leaves decodeLock reading amount/fee past the buffer end:
    // readU64be hits undefined → BigInt(undefined) throws (a loud downstream reject).
    const midFrom = encodeTx(sampleLock()).slice(0, 24);
    expect(() => decodeBlock(blockWithTxBytes(midFrom))).toThrow();
  });

  it('rejects a Lock truncated mid-signature (trailing-bytes / over-read)', () => {
    // The clamped short signature makes decodeTx advance `next` past the buffer end →
    // the block loop's post-loop p!==buf.length guard fires.
    const midSig = encodeTx(sampleLock()).slice(0, encodeTx(sampleLock()).length - 30);
    expect(() => decodeBlock(blockWithTxBytes(midSig))).toThrow('trailing bytes in block');
  });
});
