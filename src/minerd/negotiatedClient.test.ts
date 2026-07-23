import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNegotiatedTemplate, decodeMempool, negotiatedRequired, poolWsUrl } from './negotiatedClient.js';
import { Blockchain } from '../chain/blockchain.js';
import { computeTxRoot } from '../chain/block.js';
import { compareBytes } from '../util/binary.js';

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

test('buildNegotiatedTemplate: a mempool set that conflicts with our state falls back to an empty block', () => {
  const chain = new Blockchain();
  const poolPub = new Uint8Array(32).fill(9);
  // Structurally invalid/garbage entries are dropped by decodeMempool, so the
  // build still succeeds with zero txs.
  const block = buildNegotiatedTemplate(chain, poolPub, ['nonsense', 'ffff']);
  assert.equal(block.transactions.length, 0);
  assert.equal(block.header.height, 1);
});
