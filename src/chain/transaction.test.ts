// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeTx, decodeTx, TX_ENCODED_LEN, TxKind, type Transaction } from './transaction.js';
import { concat } from '../util/binary.js';

const sampleTx = (): Transaction => ({
  from: new Uint8Array(32).fill(1),
  to: new Uint8Array(32).fill(2),
  amount: 1234n,
  fee: 5n,
  nonce: 7,
  signature: new Uint8Array(64).fill(9),
});

const sampleRedeem = (): Transaction => ({
  kind: TxKind.Redeem,
  from: new Uint8Array(32),
  to: new Uint8Array(32).fill(2),
  amount: 5n,
  fee: 1n,
  nonce: 0,
  signature: new Uint8Array(0),
  lockId: new Uint8Array(32).fill(7),
  redeemScript: new Uint8Array(20).fill(0xab),
  witness: [new Uint8Array(8).fill(0xcd)],
});

const sampleLock = (): Transaction => ({
  kind: TxKind.Lock,
  from: new Uint8Array(32).fill(0x11),
  to: new Uint8Array(32),
  amount: 5n,
  fee: 1n,
  nonce: 0,
  signature: new Uint8Array(64).fill(0x22),
  scriptHash: new Uint8Array(32).fill(0x33),
});

describe('decodeTx', () => {
  it('round-trips a valid tx', () => {
    const tx = sampleTx();
    const { tx: out, next } = decodeTx(encodeTx(tx));
    expect(next).toBe(TX_ENCODED_LEN);
    expect(Array.from(out.from)).toEqual(Array.from(tx.from));
    expect(Array.from(out.to)).toEqual(Array.from(tx.to));
    expect(out.amount).toBe(tx.amount);
    expect(out.fee).toBe(tx.fee);
    expect(out.nonce).toBe(tx.nonce);
    expect(Array.from(out.signature)).toEqual(Array.from(tx.signature));
  });
  it('detects trailing bytes via next at a standalone decode', () => {
    const buf = concat(encodeTx(sampleTx()), new Uint8Array([0, 0, 0]));
    const { next } = decodeTx(buf, 0);
    // next < buf.length means trailing bytes are present — callers must check next === buf.length
    expect(next).not.toBe(buf.length);
    expect(next).toBe(TX_ENCODED_LEN);
  });
  it('tolerates trailing bytes for positional multi-tx decode (block.ts loop pattern)', () => {
    const buf = concat(encodeTx(sampleTx()), new Uint8Array([0, 0, 0]));
    const { next } = decodeTx(buf); // block.ts loop uses next to advance to the next tx
    expect(next).toBe(TX_ENCODED_LEN);
  });
  it('still rejects a truncated buffer', () => {
    const buf = encodeTx(sampleTx()).slice(0, TX_ENCODED_LEN - 1);
    expect(() => decodeTx(buf)).toThrow('tx truncated');
  });
});

// ---------------------------------------------------------------------------
// Decode-safety edge: Lock/Redeem use buf.slice (silently clamps) +
// readU*be (no bounds check), so a TRUNCATED Lock/Redeem — a length/count field
// claiming more bytes than the buffer has — is only caught DOWNSTREAM. These
// tests PIN that downstream reject so a future refactor that drops a guard fails
// loudly. NOTE: this fix does NOT harden the decoders / readU*be — it pins the
// CURRENT behavior at the decodeTx boundary. (Block-level rejection is pinned in
// block.test.ts.)
// ---------------------------------------------------------------------------
describe('decodeTx truncated Lock/Redeem (decode-safety edge — pins current reject)', () => {
  it('Redeem whose declared redeemScript length exceeds the buffer advances next PAST the end (caught downstream by next/p check)', () => {
    // redeemScript declares 20 bytes; truncate so only ~4 of them are present. buf.slice
    // clamps the script to what is there, but `p += scriptLen` still advances by the
    // DECLARED length → next > buf.length. The single-tx guard (getMempool: next===buf.length)
    // and the block loop (block.ts: p!==buf.length) both reject on that. We PIN that the
    // standalone decode does NOT silently report a consistent next.
    const full = encodeTx(sampleRedeem());
    // scriptLen u16 sits at 4(tag)+32(lockId)+32(to)+8(amount)+8(fee)=84; script starts at 86.
    const truncated = full.slice(0, 90); // declares scriptLen=20, only 4 script bytes remain
    const { next } = decodeTx(truncated, 0);
    expect(next).toBeGreaterThan(truncated.length); // over-read advance → rejected by next/p guard
  });

  it('Lock truncated mid-from is rejected (readU64be underruns → throws)', () => {
    // Truncate inside the `from` field (before amount). decodeLock then calls readU64be
    // past the buffer end where buf[off+i] is undefined → BigInt(undefined) throws.
    const full = encodeTx(sampleLock());
    const midFrom = full.slice(0, 24); // 4 tag + 4 chainId + 16 of 32 `from`
    expect(() => decodeTx(midFrom, 0)).toThrow();
  });

  it('Lock truncated mid-signature advances next PAST the end (caught downstream by next/p check)', () => {
    // Truncate inside the trailing 64-byte signature. buf.slice clamps the signature to
    // a short array, but `p += 64` advances by the DECLARED length → next > buf.length.
    const full = encodeTx(sampleLock());
    const midSig = full.slice(0, full.length - 30); // drop 30 of 64 signature bytes
    const { next } = decodeTx(midSig, 0);
    expect(next).toBeGreaterThan(midSig.length); // over-read advance → rejected by next/p guard
  });
});
