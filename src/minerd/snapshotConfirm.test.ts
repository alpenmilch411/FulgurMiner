// Confirm a restored local snapshot against the network
// (helper-anchor confirmation + a single anchor PoW check) before trusting it.
// Pure unit tests — deps (helper fetch + PoW) are injected, no network/workers.
//
// The result is CLASSIFIED so the caller can react correctly:
//   ok:true                         → trust the snapshot (warm start)
//   ok:false kind:'forged'          → the helper proves a DIFFERENT canonical
//                                      block here (or bad PoW) → delete + full sync
//   ok:false kind:'indeterminate'   → couldn't confirm (helper down/lagging/timeout)
//                                      → keep the file, full-sync this session only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmRestoredSnapshot } from './miner.js';
import { GENESIS } from '../chain/genesis.js';
import { hashHeader } from '../chain/block.js';

const genesisHash = hashHeader(GENESIS.header);

test('confirm: helper returns the canonical anchor with valid PoW → ok (trust the snapshot)', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: GENESIS.header.height,
    anchorHash: genesisHash,
    fetchBlockAt: async () => GENESIS,
    checkPoW: async () => true,
  });
  assert.deepEqual(r, { ok: true });
});

test('confirm: helper has a DIFFERENT block at the same height → forged (delete + full sync)', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: GENESIS.header.height, // 0 — matches GENESIS height
    anchorHash: new Uint8Array(32).fill(0xab), // a forged tip hash, not the helper's
    fetchBlockAt: async () => GENESIS,
    checkPoW: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'forged');
});

test('confirm: anchor hash matches but its PoW is invalid → forged', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: GENESIS.header.height,
    anchorHash: genesisHash,
    fetchBlockAt: async () => GENESIS,
    checkPoW: async () => false,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'forged');
});

test('confirm: helper unreachable (fetch throws) → indeterminate (keep file, full-sync this session)', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: 100,
    anchorHash: genesisHash,
    fetchBlockAt: async () => { throw new Error('ECONNRESET'); },
    checkPoW: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'indeterminate');
});

test('confirm: helper has no block at the anchor height → indeterminate', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: 999_999,
    anchorHash: genesisHash,
    fetchBlockAt: async () => undefined,
    checkPoW: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'indeterminate');
});

test('confirm: helper returns a block at the WRONG height (lagging/clamping helper) → indeterminate (not a forgery)', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: 100, // but the helper hands back GENESIS at height 0
    anchorHash: genesisHash,
    fetchBlockAt: async () => GENESIS,
    checkPoW: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'indeterminate');
});

test('confirm: PoW check itself throws → indeterminate (the check errored; not proof of bad PoW)', async () => {
  const r = await confirmRestoredSnapshot({
    anchorHeight: GENESIS.header.height,
    anchorHash: genesisHash,
    fetchBlockAt: async () => GENESIS,
    checkPoW: async () => { throw new Error('wasm init failed'); },
  });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, 'indeterminate');
});
