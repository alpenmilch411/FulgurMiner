import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitSoloBlock, type SubmitSoloDeps } from './submitSolo.js';

// a solo block must reach the network BEFORE it's adopted locally — else a
// failed broadcast strands the miner on a private fork. These tests pin the
// ordering + the adoption gate with injected fakes (no network, no real chain).

const template: any = { header: { height: 42, prevHash: new Uint8Array(32), stateRoot: new Uint8Array(32), nonce: 0 }, headerBytes: new Uint8Array(), targetHex: 'ff' };

function deps(over: Partial<SubmitSoloDeps> & { addBlockResult?: string | null } = {}): {
  d: SubmitSoloDeps;
  calls: { adds: number; posts: string[] };
} {
  const calls = { adds: 0, posts: [] as string[] };
  const d: SubmitSoloDeps = {
    helpers: over.helpers ?? ['http://h1', 'http://h2'],
    chain: over.chain ?? { addBlock: async () => { calls.adds++; return over.addBlockResult ?? null; } },
    postBlock: over.postBlock ?? (async (base) => { calls.posts.push(base); return { status: 'added' }; }),
  };
  return { d, calls };
}

test('≥1 helper accepts → block adopted locally AFTER broadcast', async () => {
  const { d, calls } = deps();
  const out = await submitSoloBlock(d, template, 7);
  assert.equal(out.helperAccepted, true);
  assert.equal(out.attempts, 1);
  assert.equal(out.adopted, true);
  assert.equal(out.localError, null);
  assert.equal(calls.posts.length, 2, 'broadcast to all helpers');
  assert.equal(calls.adds, 1, 'adopted exactly once');
  assert.equal(out.block.header.nonce, 7);
});

test('ALL helpers fail → NOT adopted (no private fork), chain.addBlock never called', async () => {
  const { d, calls } = deps({ postBlock: async () => { throw new Error('ECONNREFUSED'); } });
  const sleeps: number[] = [];
  const out = await submitSoloBlock(d, template, 1, {
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(out.helperAccepted, false);
  assert.equal(out.attempts, 3);
  assert.equal(out.adopted, false);
  assert.equal(calls.adds, 0, 'the block is NOT applied locally when the network never took it');
  assert.deepEqual(sleeps, [1500, 1500]);
  assert.ok(out.statuses.every((s) => /^error:/.test(s)));
});

test('helper rejects the block (invalid) → NOT adopted', async () => {
  const { d, calls } = deps({ postBlock: async () => ({ status: 'invalid' }) });
  const out = await submitSoloBlock(d, template, 1, { sleep: async () => {} });
  assert.equal(out.helperAccepted, false);
  assert.equal(out.attempts, 3);
  assert.equal(out.adopted, false);
  assert.equal(calls.adds, 0);
});

test('one helper accepts, one errors → adopted (≥1 confirmation is enough)', async () => {
  let n = 0;
  const { d } = deps({ postBlock: async (base) => { if (n++ === 0) throw new Error('down'); return { status: 'added' }; } });
  const out = await submitSoloBlock(d, template, 1);
  assert.equal(out.helperAccepted, true);
  assert.equal(out.attempts, 1);
  assert.equal(out.adopted, true);
});

test('helper accepts but local addBlock fails → adopted=false, localError surfaced', async () => {
  const { d } = deps({ addBlockResult: 'stateRoot mismatch' });
  const out = await submitSoloBlock(d, template, 1);
  assert.equal(out.helperAccepted, true);
  assert.equal(out.adopted, false);
  assert.equal(out.localError, 'stateRoot mismatch');
});

test('accept on attempt 1 → no rebroadcast sleep', async () => {
  const sleeps: number[] = [];
  const { d, calls } = deps();
  const out = await submitSoloBlock(d, template, 11, {
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(out.helperAccepted, true);
  assert.equal(out.adopted, true);
  assert.equal(out.attempts, 1);
  assert.equal(calls.posts.length, 2);
  assert.deepEqual(sleeps, []);
});

test('no accept then accept on attempt 2 → one sleep and local adoption', async () => {
  let round = 0;
  const sleeps: number[] = [];
  const { d, calls } = deps({
    postBlock: async (base) => {
      calls.posts.push(base);
      return { status: round === 0 ? 'invalid' : 'added' };
    },
  });
  const out = await submitSoloBlock(d, template, 12, {
    sleep: async (ms) => {
      sleeps.push(ms);
      round++;
    },
  });
  assert.equal(out.helperAccepted, true);
  assert.equal(out.adopted, true);
  assert.equal(out.attempts, 2);
  assert.equal(calls.adds, 1);
  assert.equal(calls.posts.length, 4);
  assert.deepEqual(sleeps, [1500]);
});

test('never accepts across bounded attempts → not adopted and chain is untouched', async () => {
  const sleeps: number[] = [];
  const { d, calls } = deps({
    postBlock: async (base) => {
      calls.posts.push(base);
      return { status: 'invalid' };
    },
  });
  const out = await submitSoloBlock(d, template, 13, {
    maxBroadcastAttempts: 4,
    rebroadcastDelayMs: 7,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(out.helperAccepted, false);
  assert.equal(out.adopted, false);
  assert.equal(out.attempts, 4);
  assert.equal(calls.adds, 0);
  assert.equal(calls.posts.length, 8);
  assert.deepEqual(sleeps, [7, 7, 7]);
});
