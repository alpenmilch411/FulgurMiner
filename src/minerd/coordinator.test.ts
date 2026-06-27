import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinerCoordinator, type CoordinatorDeps } from './miner.js';

// the busy flag must ALWAYS reset, even when submit() or syncCatchUp() throws —
// otherwise the miner wedges (every future solve / tip-advance early-returns on busy,
// the stale grind keeps running, found blocks are ignored). Tested via the injected
// CoordinatorDeps with no real grind pool / chain.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeCoord(opts: { submit?: () => Promise<{ label: string }>; catchUp?: () => Promise<void> } = {}): {
  coord: MinerCoordinator;
  calls: { builds: number; starts: number; stops: number; submits: number; catchUps: number; logs: string[] };
  solve: (nonce: number) => void;
} {
  const calls = { builds: 0, starts: 0, stops: 0, submits: 0, catchUps: 0, logs: [] as string[] };
  let solvedCb: ((nonce: number) => void) | null = null;
  const deps: CoordinatorDeps = {
    buildTemplate: () => { calls.builds++; return { header: { height: 1 }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any; },
    poolStart: (_hb, _tx, onSolved) => { calls.starts++; solvedCb = onSolved; },
    poolStop: () => { calls.stops++; },
    submit: async () => { calls.submits++; return opts.submit ? await opts.submit() : { label: 'h=1' }; },
    syncCatchUp: async () => { calls.catchUps++; if (opts.catchUp) await opts.catchUp(); },
    onLog: (m) => calls.logs.push(m),
  };
  const coord = new MinerCoordinator(deps);
  return { coord, calls, solve: (n) => solvedCb!(n) };
}

test('onSolved (happy path): poolStop, submit, rebuild; busy resets so the next solve is processed', async () => {
  const { coord, calls, solve } = makeCoord();
  coord.rebuild();
  assert.equal(calls.builds, 1);
  solve(5);
  await flush();
  assert.equal(calls.stops, 1);
  assert.equal(calls.submits, 1);
  assert.equal(calls.builds, 2, 'rebuilt after the solve');
  assert.ok(calls.logs.some((l) => l.startsWith('solved:')));
});

test('onSolved: a THROWING submit still resets busy + rebuilds (no wedge)', async () => {
  const { coord, calls, solve } = makeCoord({ submit: async () => { throw new Error('helpers down'); } });
  coord.rebuild();
  solve(5);
  await flush();
  assert.equal(calls.builds, 2, 'rebuilt despite the submit throw');
  // The real proof of "no wedge": a SECOND solve is processed (busy was reset).
  solve(6);
  await flush();
  assert.equal(calls.submits, 2, 'second solve processed → busy did not stick');
  assert.equal(calls.builds, 3);
});

test('tipAdvanced (happy path): catchUp, poolStop, rebuild; busy resets', async () => {
  const { coord, calls } = makeCoord();
  coord.rebuild();
  await coord.tipAdvanced();
  assert.equal(calls.catchUps, 1);
  assert.equal(calls.stops, 1);
  assert.equal(calls.builds, 2, 'rebuilt on the new tip');
});

test('tipAdvanced: a THROWING syncCatchUp resets busy AND stops the known-stale grind (no private fork); a later catch-up rebuilds', async () => {
  let fail = true;
  const { coord, calls } = makeCoord({ catchUp: async () => { if (fail) throw new Error('getBlocks 500'); } });
  coord.rebuild();
  assert.equal(calls.builds, 1);
  await coord.tipAdvanced(); // catchUp throws
  // the tip moved (that's why we're here) so the template is known-stale — STOP it
  // (a stale solve could be adopted via a lagging helper → private fork). No rebuild.
  assert.equal(calls.stops, 1, 'stale grind stopped on catch-up failure');
  assert.equal(calls.builds, 1, 'no rebuild on failure');
  // busy must have reset → a subsequent successful tip-advance proceeds.
  fail = false;
  await coord.tipAdvanced();
  assert.equal(calls.catchUps, 2);
  assert.equal(calls.stops, 2, 'stop again + rebuild on the successful catch-up');
  assert.equal(calls.builds, 2);
});

test('HIGH rebuild-guard: a throwing buildTemplate is caught + logged (no unhandled rejection), busy resets', async () => {
  let builds = 0;
  const logs: string[] = [];
  let solvedCb: ((n: number) => void) | null = null;
  const deps: CoordinatorDeps = {
    buildTemplate: () => {
      builds++;
      if (builds >= 2) throw new Error('chain in a bad state'); // startup build ok; the post-solve rebuild throws
      return { header: { height: 1 }, headerBytes: new Uint8Array(), targetHex: 'ff' } as any;
    },
    poolStart: (_h, _t, onSolved) => { solvedCb = onSolved; },
    poolStop: () => {},
    submit: async () => ({ label: 'h=1' }),
    syncCatchUp: async () => {},
    onLog: (m) => logs.push(m),
  };
  const coord = new MinerCoordinator(deps);
  coord.rebuild();   // build #1 ok
  solvedCb!(5);      // onSolved → submit → finally safeRebuild → build #2 THROWS (must be caught)
  await flush();
  assert.ok(logs.some((l) => /error:rebuild failed/.test(l)), 'rebuild failure surfaced via the error: channel');
  // No unhandled rejection (the runner would fail the test). busy must have reset:
  let caughtUp = false;
  deps.syncCatchUp = async () => { caughtUp = true; };
  await coord.tipAdvanced();
  assert.equal(caughtUp, true, 'busy reset → a later tip-advance still runs after the rebuild failure');
});

test('busy guard: a tip-advance in progress blocks a re-entrant solve', async () => {
  let release: (() => void) | null = null;
  const { coord, calls, solve } = makeCoord({ catchUp: () => new Promise<void>((r) => { release = () => r(); }) });
  coord.rebuild();
  const adv = coord.tipAdvanced(); // enters, awaits catchUp (busy=true)
  await flush();
  solve(9); // should early-return: busy
  await flush();
  assert.equal(calls.submits, 0, 'solve ignored while a catch-up is in flight');
  release!();
  await adv;
  assert.equal(calls.catchUps, 1);
});
