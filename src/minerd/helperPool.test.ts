import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HelperPool, AllHelpersFailed } from './helperPool.js';
import type { Tip } from './http.js';

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';
const tip = (h: number): Tip => ({ height: h, tipHash: 'hash' + h });
const noSleep = async (): Promise<void> => {};
const sink = { onDebug() {}, onInfo() {} };

test('getTip returns the primary when it succeeds', async () => {
  const pool = new HelperPool([A, B], { ...sink, sleep: noSleep, getTip: async (base) => { assert.equal(base, A); return tip(10); } });
  assert.deepEqual(await pool.getTip(), tip(10));
  assert.equal(pool.primary(), A);
});

test('getTip fails over to the next helper on a primary error', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => { seen.push(base); if (base === A) throw new Error('525'); return tip(7); },
  });
  assert.deepEqual(await pool.getTip(), tip(7));
  assert.deepEqual(seen, [A, B]); // tried A, then B
});

test('getTip throws AllHelpersFailed only when every helper fails a round', async () => {
  const pool = new HelperPool([A, B], { ...sink, sleep: noSleep, getTip: async () => { throw new Error('boom'); } });
  await assert.rejects(() => pool.getTip(), (e) => e instanceof AllHelpersFailed && /a\.example.*b\.example/s.test(e.message));
});

test('a caller AbortError propagates immediately (no failover, no retry)', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getTip: async (base) => { seen.push(base); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  await assert.rejects(() => pool.getTip(), (e) => (e as Error).name === 'AbortError');
  assert.deepEqual(seen, [A]); // did not try B
});

test('primary rotates after rotateThreshold sustained failures', async () => {
  const warned: string[] = [];
  let aUp = false;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, rotateThreshold: 3, onInfo: (m) => warned.push(m),
    getTip: async (base) => { if (base === A && !aUp) throw new Error('down'); return tip(1); },
  });
  // 3 rounds: A fails each time, B serves. On the 3rd, primary rotates to B.
  await pool.getTip(); await pool.getTip();
  assert.equal(pool.primary(), A);            // not yet
  await pool.getTip();
  assert.equal(pool.primary(), B);            // rotated
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /b\.example/);
});

test('a primary success resets the failure streak', async () => {
  let aFails = true;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, rotateThreshold: 3,
    getTip: async (base) => { if (base === A && aFails) throw new Error('down'); return tip(1); },
  });
  await pool.getTip(); await pool.getTip(); // 2 primary failures
  aFails = false; await pool.getTip();      // primary recovers → streak reset
  aFails = true; await pool.getTip(); await pool.getTip(); // 2 again, still < 3
  assert.equal(pool.primary(), A);
});

test('getBlocks fails over within a round, then bounded-retries rounds', async () => {
  let calls = 0;
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep, blocksRounds: 4,
    getBlocks: async (base) => { calls++; if (calls < 4) throw new Error('5xx'); return []; },
  });
  await pool.getBlocks(0, 200);
  assert.equal(calls, 4); // A,B (round1) A,B... until the 4th attempt returns
});

test('blockAt is a single failover round (A down -> B serves the block)', async () => {
  const seen: string[] = [];
  const pool = new HelperPool([A, B], {
    ...sink, sleep: noSleep,
    getBlocks: async (base, from, max) => { seen.push(base); assert.equal(max, 1); if (base === A) throw new Error('x'); return [{ header: { height: from } } as any]; },
  });
  const blk = await pool.blockAt(42);
  assert.equal((blk as any).header.height, 42);
  assert.deepEqual(seen, [A, B]);
});

test('blockAt returns undefined when the winning helper has no block there', async () => {
  const pool = new HelperPool([A], { ...sink, sleep: noSleep, getBlocks: async () => [] });
  assert.equal(await pool.blockAt(9), undefined);
});

test('constructor rejects an empty helper list', () => {
  assert.throws(() => new HelperPool([], {}), /at least one/);
});

test('getTip rotates with wraparound across 3 helpers', async () => {
  let downA = true;
  const seen: string[] = [];
  const pool = new HelperPool([A, B, C], {
    ...sink, sleep: noSleep, rotateThreshold: 2,
    getTip: async (base) => { seen.push(base); if (base === A && downA) throw new Error('down'); return tip(3); },
  });
  await pool.getTip(); await pool.getTip();   // 2 primary(A) failures -> rotate to B
  assert.equal(pool.primary(), B);
  seen.length = 0;
  await pool.getTip();                          // now starts at B (success), order begins at B
  assert.equal(seen[0], B);
});

test('getBlocks propagates an AbortError from the inter-round sleep', async () => {
  let calls = 0;
  const pool = new HelperPool([A, B], {
    ...sink, blocksRounds: 4,
    getBlocks: async () => { calls++; throw new Error('5xx'); },           // every helper fails -> round fails
    sleep: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, // abort during backoff
  });
  await assert.rejects(() => pool.getBlocks(0, 200), (e) => (e as Error).name === 'AbortError');
  assert.equal(calls, 2); // one full round (A,B) then the sleep aborts before round 2
});
