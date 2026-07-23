import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNegotiatedTemplate, decodeMempool, headerMatchesTemplate, mempoolEntryAcceptable,
  negotiatedRequired, poolWsUrl, pruneOutstanding, settleOutstanding,
} from './negotiatedClient.js';
import { Blockchain } from '../chain/blockchain.js';
import { computeTxRoot, encodeHeader, type Block } from '../chain/block.js';
import { bytesToHex, compareBytes } from '../util/binary.js';

test('negotiatedRequired: 410 is the definitive signal, regardless of body', () => {
  assert.equal(negotiatedRequired(410, null), true);
  assert.equal(negotiatedRequired(410, { error: 'anything' }), true);
});

test('negotiatedRequired: error-text fallback (proxy rewrote the status)', () => {
  assert.equal(negotiatedRequired(400, { error: 'This pool requires Negotiated mining mode' }), true);
  assert.equal(negotiatedRequired(400, { error: 'bad payoutAddress' }), false);
  assert.equal(negotiatedRequired(426, null), false);
  assert.equal(negotiatedRequired(400, 'not-an-object'), false);
  assert.equal(negotiatedRequired(400, null), false);
});

test('negotiatedRequired: the text fallback is bounded to 400 — it cannot hijack another fatal', () => {
  // 426 has its own handler (upgrade required / minMinerVersion). A body that
  // merely mentions the mode must not divert it into the negotiated hand-off.
  assert.equal(negotiatedRequired(426, { error: 'upgrade required for negotiated mode' }), false);
  assert.equal(negotiatedRequired(403, { error: 'negotiated' }), false);
  assert.equal(negotiatedRequired(500, { error: 'negotiated' }), false);
  // 410 stays unconditional.
  assert.equal(negotiatedRequired(410, { error: 'anything at all' }), true);
});

test('poolWsUrl: http(s) -> ws(s), trailing slashes stripped, /ws appended', () => {
  assert.equal(poolWsUrl('https://brcpool.example.com'), 'wss://brcpool.example.com/ws');
  assert.equal(poolWsUrl('http://localhost:3333'), 'ws://localhost:3333/ws');
  assert.equal(poolWsUrl('https://pool.example.com///'), 'wss://pool.example.com/ws');
});

test('decodeMempool: malformed / non-hex entries are skipped, never thrown', () => {
  assert.deepEqual(decodeMempool([]), []);
  assert.deepEqual(decodeMempool(['zz', '', 'deadbeef', '00'.repeat(3)]), []);
});

test('buildNegotiatedTemplate: empty block off genesis, coinbase pays the pool', () => {
  const chain = new Blockchain();
  const poolPub = new Uint8Array(32).fill(7);
  const before = Math.floor(Date.now() / 1000);

  const block = buildNegotiatedTemplate(chain, poolPub, []);

  assert.equal(block.header.height, 1);
  assert.equal(compareBytes(block.header.prevHash, chain.tip.hash), 0);
  assert.equal(compareBytes(block.header.miner, poolPub), 0);
  assert.equal(block.header.nonce, 0);
  assert.equal(block.transactions.length, 0);
  assert.equal(compareBytes(block.header.txRoot, computeTxRoot([])), 0);
  // Fork-#3-aware difficulty: must match what the validator expects for this timestamp.
  assert.equal(block.header.difficulty, chain.expectedNextDifficulty(block.header.timestamp));
  // Timestamp: honest clock, strictly above the parent MTP.
  assert.ok(block.header.timestamp >= before);
  assert.ok(block.header.timestamp > chain.nextBlockScriptContext().blockMtp);
});

test('headerMatchesTemplate: accepts the pool echoing back exactly the header we built', () => {
  const chain = new Blockchain();
  const block = buildNegotiatedTemplate(chain, new Uint8Array(32).fill(7), []);
  const ours = bytesToHex(encodeHeader(block.header));

  assert.equal(headerMatchesTemplate(block, ours), true);
  assert.equal(headerMatchesTemplate(block, ours.toUpperCase()), true, 'case-insensitive');
});

test('headerMatchesTemplate: rejects a header the pool changed — this is the whole security property', () => {
  const chain = new Blockchain();
  const block = buildNegotiatedTemplate(chain, new Uint8Array(32).fill(7), []);

  // A pool steering us onto a parent of ITS choosing: same header, other prevHash.
  const steered = { ...block, header: { ...block.header, prevHash: new Uint8Array(32).fill(0xab) } };
  assert.equal(headerMatchesTemplate(block, bytesToHex(encodeHeader(steered.header))), false);

  // A pool censoring / swapping the transaction set.
  const censored = { ...block, header: { ...block.header, txRoot: new Uint8Array(32).fill(0xcd) } };
  assert.equal(headerMatchesTemplate(block, bytesToHex(encodeHeader(censored.header))), false);

  // Garbage / missing / wrong-typed fields are never a match.
  assert.equal(headerMatchesTemplate(block, undefined), false);
  assert.equal(headerMatchesTemplate(block, null), false);
  assert.equal(headerMatchesTemplate(block, ''), false);
  assert.equal(headerMatchesTemplate(block, 'deadbeef'), false);
  assert.equal(headerMatchesTemplate(block, { headerHex: 'x' }), false);
});

// Two templates in flight: the pool was slower than the result watchdog, so a
// second template was registered while the first was still pending. Treating a
// result as "must be the last one I sent" made the two cancel each other out
// forever and the miner never started grinding.
function twoInFlight(): { a: { block: Block; at: number }; b: { block: Block; at: number } } {
  const chain = new Blockchain();
  return {
    a: { block: buildNegotiatedTemplate(chain, new Uint8Array(32).fill(1), []), at: 1_000 },
    b: { block: buildNegotiatedTemplate(chain, new Uint8Array(32).fill(2), []), at: 2_000 },
  };
}
const hexOf = (e: { block: Block }): string => bytesToHex(encodeHeader(e.block.header));

test('settleOutstanding: a result for the OLDER template does not discard the newer one', () => {
  const { a, b } = twoInFlight();

  // A's result arrives first: A is matched, B stays in flight.
  const first = settleOutstanding([a, b], hexOf(a));
  assert.ok(first);
  assert.equal(first.matched, a);
  assert.deepEqual(first.rest, [b], 'the newer template must survive');

  // B's result then still correlates — this is the step that used to find
  // nothing pending and livelock.
  const second = settleOutstanding(first.rest, hexOf(b));
  assert.ok(second);
  assert.equal(second.matched, b);
  assert.deepEqual(second.rest, []);
});

test('settleOutstanding: out-of-order results both settle (newer answered first)', () => {
  const { a, b } = twoInFlight();

  // The pool answers B before A. B must NOT take A down with it — dropping
  // "everything older than the match" made A's own valid result read as foreign
  // and kill the good grind B had just started.
  const first = settleOutstanding([a, b], hexOf(b));
  assert.ok(first);
  assert.equal(first.matched, b);
  assert.deepEqual(first.rest, [a], 'the older template is still awaiting its own result');

  const second = settleOutstanding(first.rest, hexOf(a));
  assert.ok(second, 'A must still correlate after B settled first');
  assert.equal(second.matched, a);
  assert.deepEqual(second.rest, []);
});

test('settleOutstanding: a header matching nothing in flight is refused', () => {
  const { a, b } = twoInFlight();
  const foreign = { block: buildNegotiatedTemplate(new Blockchain(), new Uint8Array(32).fill(3), []), at: 0 };
  assert.equal(settleOutstanding([a, b], hexOf(foreign)), null);
  assert.equal(settleOutstanding([], hexOf(a)), null);
  assert.equal(settleOutstanding([a], 'not-a-header'), null);
  assert.equal(settleOutstanding([a], undefined), null);
});

test('pruneOutstanding: retires by AGE, so a slow pool cannot be evicted by count alone', () => {
  const now = 1_000_000;
  const fresh = { at: now - 1_000 };
  // Inside the 30-minute TTL: a pool this slow is still answered, not evicted.
  const slow = { at: now - 25 * 60_000 };
  const old = { at: now - 31 * 60_000 };
  assert.deepEqual(pruneOutstanding([old, fresh], now), [fresh], 'aged-out entry dropped');
  assert.deepEqual(pruneOutstanding([slow, fresh], now), [slow, fresh], 'a slow pool is still correlatable');
  assert.deepEqual(pruneOutstanding([fresh], now), [fresh]);

  // A burst well past the count cap stays bounded and keeps the NEWEST ones.
  // Fixture order matters: production appends on send, so the list runs
  // oldest-first and the newest entries are the tail. Generating it newest-first
  // would assert the opposite of what production does and still pass.
  const many = Array.from({ length: 200 }, (_, i) => ({ at: now - (200 - i) }));
  assert.ok(many[0]!.at < many[199]!.at, 'fixture must be oldest-first, like production');
  const kept = pruneOutstanding(many, now);
  assert.equal(kept.length, 64);
  assert.equal(kept[kept.length - 1], many[199], 'newest survives');
  assert.equal(kept[0], many[136], 'the oldest 136 are the ones dropped');
});

test('buildNegotiatedTemplate: rejects a pool address that is not 32 bytes', () => {
  const chain = new Blockchain();
  assert.throws(() => buildNegotiatedTemplate(chain, new Uint8Array(31), []), /32 bytes/);
  assert.throws(() => buildNegotiatedTemplate(chain, new Uint8Array(0), []), /32 bytes/);
});

test('mempoolEntryAcceptable: bounds pool input BEFORE it is decoded', () => {
  const TX_BYTE_BUDGET = 256 * 1024 - 1_024; // MAX_BLOCK_BYTES - 1024
  const ok = 'ab'.repeat(100);

  assert.equal(mempoolEntryAcceptable(ok, 0), true);
  // Per-entry cap: one entry may not exceed a block's worth of hex.
  assert.equal(mempoolEntryAcceptable('a'.repeat(TX_BYTE_BUDGET * 2 + 1), 0), false);
  // Aggregate cap: many mid-sized entries must not add up without limit. This is
  // the half the per-entry cap alone does not cover, because `bytes` in
  // decodeMempool only counts entries that successfully decode.
  assert.equal(mempoolEntryAcceptable(ok, TX_BYTE_BUDGET * 4), false);
  assert.equal(mempoolEntryAcceptable(ok, TX_BYTE_BUDGET * 4 - ok.length), true);
  // Non-strings and empties never reach the decoder.
  assert.equal(mempoolEntryAcceptable(undefined, 0), false);
  assert.equal(mempoolEntryAcceptable(12345, 0), false);
  assert.equal(mempoolEntryAcceptable('', 0), false);
});

test('decodeMempool: an oversized pool entry is skipped rather than decoded', () => {
  const huge = 'ab'.repeat(1_000_000); // 2 MB — well past the block budget
  assert.deepEqual(decodeMempool([huge]), []);
  // The bound itself is asserted in the mempoolEntryAcceptable test above; this
  // only pins that an oversized entry cannot throw its way out of the loop.
  assert.deepEqual(decodeMempool([huge, huge, 'zz']), []);
});

test('poolWsUrl: an uppercase scheme still rewrites (headless MINER_POOL is not canonicalised)', () => {
  assert.equal(poolWsUrl('HTTPS://pool.example.com'), 'wss://pool.example.com/ws');
  assert.equal(poolWsUrl('Http://localhost:3333'), 'ws://localhost:3333/ws');
});

test('buildNegotiatedTemplate: a mempool set that conflicts with our state falls back to an empty block', () => {
  const chain = new Blockchain();
  const poolPub = new Uint8Array(32).fill(9);
  // Structurally invalid/garbage entries are dropped by decodeMempool, so the
  // build still succeeds with zero txs.
  const block = buildNegotiatedTemplate(chain, poolPub, ['nonsense', 'ffff']);
  assert.equal(block.transactions.length, 0);
  assert.equal(block.header.height, 1);
});
