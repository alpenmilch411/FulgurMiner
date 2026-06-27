/**
 * Consensus capstone — boundary reorg over the script hard-fork.
 *
 * Two properties that no other suite locks down:
 *
 *  (1) REORG CORRECTNESS for script state. A reorg stores every valid block and
 *      lets the heaviest-work tip win; per-block state is immutable
 *      (`ChainBlock.state`), never mutated in place. So a Lock redeemed only on
 *      an orphaned branch must NOT be consumed on the canonical branch, and a
 *      Lock created only on an orphaned branch must NOT exist on canonical.
 *      A bug that mutated a shared state object across branches (or mis-walked
 *      the reorg) would corrupt balances/locks — this test would catch it.
 *
 *  (2) SUPPLY CONSERVATION with scripts active. For every canonical block,
 *      Δ(Σ account balances + Σ lock amounts) == blockReward(height), EXACTLY.
 *      A Lock moves `amount` from accounts into `locks` and pays `fee` to the
 *      miner; a Redeem moves it back out (minus fee, which also goes to the
 *      miner). In all cases the only net new value per block is the subsidy.
 *      A bug that minted/burned value inside Lock/Redeem would break this.
 *
 * The reorg is REAL (a heavier competing branch actually displaces the tip via
 * `addBlockWithPow`), and the conservation arithmetic is computed from the
 * per-block immutable snapshots — not asserted tautologically.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Blockchain, type ChainBlock } from './blockchain.js';
import { buildBlock, emptyMine } from './testutil.js';
import {
  applyBlockTxs,
  cloneState,
  getAccount,
  getLock,
  stateRoot,
  type State,
} from './state.js';
import {
  hashHeader,
  computeTxRoot,
  type Block,
  type BlockHeader,
} from './block.js';
import { checkPoW, medianTimePast, nextDifficulty } from './consensus.js';
import {
  TxKind,
  lockIdOf,
  signLock,
  type Transaction,
} from './transaction.js';
import { Op } from './script.js';
import { generateKeyPair } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat, bytesToHex } from '../util/binary.js';
import {
  COIN,
  GENESIS_TIMESTAMP,
  DIFFICULTY_WINDOW,
  MTP_WINDOW,
  TARGET_BLOCK_TIME_S,
  blockReward,
} from './genesis.js';
import {
  resetForkActivationTimeForTesting,
  scriptsActiveForMtp,
  setForkActivationTimeForTesting,
} from './fork.js';

afterEach(() => resetForkActivationTimeForTesting());

// --- script helpers (mirror scripttx.test.ts) ------------------------------
const ZERO32 = new Uint8Array(32);
function push(data: Uint8Array): Uint8Array {
  if (data.length <= 0x4b) return concat(new Uint8Array([data.length]), data);
  return concat(new Uint8Array([Op.OP_PUSHDATA1, data.length]), data);
}
function op(c: number): Uint8Array { return new Uint8Array([c]); }
/** Hash-lock redeem script: SHA256 <h> EQUAL. Unlock witness = [preimage]. */
function hashLockScript(preimage: Uint8Array): Uint8Array {
  return concat(op(Op.OP_SHA256), push(sha256(preimage)), op(Op.OP_EQUAL));
}
function makeRedeem(opts: {
  lockId: Uint8Array; to: Uint8Array; amount: bigint; fee: bigint;
  redeemScript: Uint8Array; witness: Uint8Array[];
}): Transaction {
  const base: Transaction = {
    kind: TxKind.Redeem,
    from: new Uint8Array(32),
    to: opts.to,
    amount: opts.amount,
    fee: opts.fee,
    nonce: 0,
    signature: new Uint8Array(0),
    lockId: opts.lockId,
    redeemScript: opts.redeemScript,
    witness: [],
  };
  base.witness = opts.witness;
  return base;
}

/**
 * Build a fully-valid PoW block on an ARBITRARY stored parent (not just the
 * tip). Mirrors `testutil.buildBlock` exactly — same difficulty/MTP lookback,
 * same stateRoot derivation — but lets us fork off a buried block to create a
 * competing branch. Test-only; production never builds on a non-tip parent.
 */
async function buildBlockOn(
  chain: Blockchain,
  parentHashHex: string,
  miner: Uint8Array,
  txs: Transaction[],
  timestamp: number,
): Promise<Block> {
  const parent = chain.getBlock(parentHashHex);
  if (!parent) throw new Error('buildBlockOn: unknown parent');
  if (parent.state === null) throw new Error('buildBlockOn: parent state not materialized');
  const height = parent.block.header.height + 1;

  const lookback = chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1, parentHashHex);
  const difficulty = nextDifficulty(height, lookback, timestamp);

  // Apply against a clone of the parent's immutable state to derive stateRoot —
  // identical to how addBlockInternal will re-derive + check it on insert.
  const mtp = medianTimePast(chain.getRecentHeaders(MTP_WINDOW, parentHashHex));
  const sim = cloneState(parent.state);
  const err = applyBlockTxs(sim, height, miner, txs, {
    scriptsActive: scriptsActiveForMtp(mtp),
    blockMtp: mtp,
  });
  if (err) throw new Error('buildBlockOn apply failed: ' + err);

  const base: BlockHeader = {
    height,
    prevHash: parent.hash,
    txRoot: computeTxRoot(txs),
    stateRoot: stateRoot(sim),
    timestamp,
    difficulty,
    nonce: 0,
    miner,
  };
  for (let nonce = 0; nonce < 0x7fff_ffff; nonce++) {
    const h: BlockHeader = { ...base, nonce };
    if (await checkPoW(h)) return { header: h, transactions: txs };
    if ((nonce & 0x7) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('buildBlockOn failed to find PoW');
}

/** Σ account balances + Σ lock amounts — total value tracked by a state. */
function totalValue(s: State): bigint {
  let sum = 0n;
  for (const a of s.accounts.values()) sum += a.balance;
  for (const l of s.locks.values()) sum += l.amount;
  return sum;
}

/** Walk genesis→tip and assert each block's value delta == blockReward(height). */
function assertConservation(chain: Blockchain): void {
  const canonical: ChainBlock[] = [...chain.iterateCanonical()].reverse(); // genesis first
  for (let i = 1; i < canonical.length; i++) {
    const prev = canonical[i - 1]!;
    const cur = canonical[i]!;
    expect(prev.state, `parent state materialized @${prev.block.header.height}`).not.toBeNull();
    expect(cur.state, `block state materialized @${cur.block.header.height}`).not.toBeNull();
    const delta = totalValue(cur.state!) - totalValue(prev.state!);
    expect(delta, `Δvalue @height ${cur.block.header.height}`).toBe(
      blockReward(cur.block.header.height),
    );
  }
}

describe('boundary reorg: locks unspend correctly + supply is conserved', () => {
  it('a reorg to a branch without the redeem leaves the lock LIVE on canonical, and conserves supply on both branches', async () => {
    // Scripts active from genesis so the reorg-correctness core is exercised
    // without depending on the activation-MTP straddle (covered separately below).
    setForkActivationTimeForTesting(GENESIS_TIMESTAMP);

    const miner = generateKeyPair();
    const bob = generateKeyPair();
    const chain = new Blockchain();

    // Block 1: coinbase funds the miner.
    expect(await chain.addBlockWithPow(await emptyMine(chain, miner.publicKey), true)).toBeNull();

    // Block 2: miner locks 10 BRC under a hash-lock — the branch point.
    const preimage = new TextEncoder().encode('reorg-secret');
    const rs = hashLockScript(preimage);
    const lock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 10n * COIN, fee: 100n, nonce: 0, scriptHash: sha256(rs) },
      miner.privateKey,
    );
    const lockId = lockIdOf(lock);
    const lockIdHex = bytesToHex(lockId);
    expect(await chain.addBlockWithPow(await buildBlock(chain, miner.publicKey, [lock]), true)).toBeNull();
    expect(getLock(chain.tipState, lockIdHex)).toBeDefined();
    const branchPointHex = bytesToHex(chain.tip.hash);
    const branchPointHeight = chain.height; // == 2

    // --- Branch A (built first → current tip): block 3a REDEEMS the lock to bob,
    //     and also creates a SECOND, A-only lock that must vanish after the reorg.
    const redeem = makeRedeem({ lockId, to: bob.publicKey, amount: 10n * COIN, fee: 100n, redeemScript: rs, witness: [preimage] });
    const aOnlyPre = new TextEncoder().encode('a-only-lock');
    const aOnlyRs = hashLockScript(aOnlyPre);
    const aOnlyLock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 5n * COIN, fee: 0n, nonce: 1, scriptHash: sha256(aOnlyRs) },
      miner.privateKey,
    );
    const aOnlyLockIdHex = bytesToHex(lockIdOf(aOnlyLock));
    const block3a = await buildBlock(chain, miner.publicKey, [redeem, aOnlyLock]);
    expect(await chain.addBlockWithPow(block3a, true)).toBeNull();

    // Branch A is canonical now: lock consumed, A-only lock present, bob paid.
    expect(getLock(chain.tipState, lockIdHex)).toBeUndefined();
    expect(getLock(chain.tipState, aOnlyLockIdHex)).toBeDefined();
    expect(getAccount(chain.tipState, bob.address).balance).toBe(10n * COIN - 100n);
    expect(chain.height).toBe(3);
    assertConservation(chain); // conservation holds on branch A

    // --- Branch B (competing, HEAVIER): two empty blocks on the branch point,
    //     neither of which redeems the lock. Longer chain at floor difficulty =>
    //     more cumulative work => fork choice must reorg onto B.
    //     Offset timestamps so B's blocks are distinct + still satisfy MTP.
    const t3 = GENESIS_TIMESTAMP + 3 * TARGET_BLOCK_TIME_S + 7;
    const block3b = await buildBlockOn(chain, branchPointHex, miner.publicKey, [], t3);
    expect(await chain.addBlockWithPow(block3b, true)).toBeNull();
    // 3b is equal work to 3a — tip should NOT move yet (first-seen wins ties).
    expect(bytesToHex(chain.tip.hash)).toBe(bytesToHex(hashHeader(block3a.header)));
    expect(chain.height).toBe(3);

    const t4 = t3 + TARGET_BLOCK_TIME_S;
    const block3bHex = bytesToHex(hashHeader(block3b.header));
    const block4b = await buildBlockOn(chain, block3bHex, miner.publicKey, [], t4);
    expect(await chain.addBlockWithPow(block4b, true)).toBeNull();

    // REORG: branch B (height 4) is now canonical.
    expect(chain.height).toBe(4);
    expect(bytesToHex(chain.tip.hash)).toBe(bytesToHex(hashHeader(block4b.header)));

    // CORE ASSERTIONS — reorg correctness for script state:
    //  • the original lock, redeemed only on the orphaned branch A, is LIVE again
    //    on canonical B (the orphan redeem did NOT consume it).
    expect(getLock(chain.tipState, lockIdHex), 'orphan-redeemed lock is live on canonical').toBeDefined();
    expect(getLock(chain.tipState, lockIdHex)!.amount).toBe(10n * COIN);
    //  • the A-only lock, created only on the orphaned branch, does NOT exist.
    expect(getLock(chain.tipState, aOnlyLockIdHex), 'orphan-created lock absent on canonical').toBeUndefined();
    //  • bob was paid only on the orphan → zero balance on canonical.
    expect(getAccount(chain.tipState, bob.address).balance).toBe(0n);

    // Branch A's immutable state snapshot is UNTOUCHED by the reorg (no shared mutation).
    const aTip = chain.getBlock(bytesToHex(hashHeader(block3a.header)))!;
    expect(aTip.state, 'branch A snapshot retained').not.toBeNull();
    expect(getLock(aTip.state!, lockIdHex), 'branch A still shows the redeem consumed it').toBeUndefined();
    expect(getAccount(aTip.state!, bob.address).balance).toBe(10n * COIN - 100n);

    // Branch-point state (block 2) is shared history — lock present there on BOTH branches.
    const branchPoint = chain.getBlock(branchPointHex)!;
    expect(getLock(branchPoint.state!, lockIdHex)).toBeDefined();
    expect(branchPoint.block.header.height).toBe(branchPointHeight);

    // Conservation holds across the NEW canonical chain (genesis→B tip), block by block.
    assertConservation(chain);
  });
});

describe('boundary reorg: straddling the activation MTP', () => {
  it('crosses the fork-activation boundary — a lock block is rejected just below it, accepted just above, and supply is conserved across the straddle', async () => {
    // Strategy: build an empty prefix with activation far in the PAST (so the
    // empties validate identically), capturing the LIVE next-block MTP the chain
    // computes at each step. MTP is pure timestamp math — independent of the
    // activation override — so we can then pin activation strictly BETWEEN two
    // adjacent observed MTPs and CONTINUE on the same chain. Empty blocks are
    // valid regardless of activation, so no rebuild is needed.
    const miner = generateKeyPair();
    const bob = generateKeyPair();

    setForkActivationTimeForTesting(GENESIS_TIMESTAMP); // everything active during the probe build
    const chain = new Blockchain();
    const PREFIX = 13; // > MTP_WINDOW (11) so the MTP schedule has advanced off genesis
    // nextMtp[h] = MTP the chain assigns to the block built when the tip is at height h.
    const nextMtp = new Map<number, number>();
    for (let i = 0; i < PREFIX; i++) {
      nextMtp.set(chain.height, chain.nextBlockScriptContext().blockMtp);
      expect(await chainAdd(chain, await emptyMine(chain, miner.publicKey))).toBeNull();
    }
    nextMtp.set(chain.height, chain.nextBlockScriptContext().blockMtp); // MTP for the NEXT block (tip == PREFIX)
    expect(chain.height).toBe(PREFIX);

    // The next block (built on tip PREFIX) is the FIRST that should be script-active.
    const mtpBelow = nextMtp.get(PREFIX - 1)!; // MTP of the block we already mined at height PREFIX
    const mtpAbove = nextMtp.get(PREFIX)!;     // MTP of the NEXT block (height PREFIX+1)
    expect(mtpAbove).toBeGreaterThan(mtpBelow); // a real gap → the boundary lands strictly between
    const activation = mtpBelow + 1;            // inactive at height PREFIX, active at PREFIX+1
    setForkActivationTimeForTesting(activation);
    expect(scriptsActiveForMtp(mtpBelow)).toBe(false);
    expect(scriptsActiveForMtp(mtpAbove)).toBe(true);

    // Sanity: the block we ALREADY mined at height PREFIX was below activation —
    // a lock there would have forked off a legacy node. Confirm the boundary is real
    // by re-deriving: a child built on tip PREFIX-1 would have rejected a lock.
    // (We assert the live next-block context instead, which is what matters.)
    const preimage = new TextEncoder().encode('straddle');
    const rs = hashLockScript(preimage);

    // We're at tip PREFIX, whose next block (PREFIX+1) is the first ACTIVE one.
    // But first prove the BELOW-boundary rejection on a fork built from PREFIX-1:
    // build a lock block on the height-(PREFIX-1) ancestor → its MTP == mtpBelow < activation → reject.
    const ancestorHex = ancestorAtHeight(chain, PREFIX - 1);
    const earlyLock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 1n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      miner.privateKey,
    );
    await expect(buildBlockOn(chain, ancestorHex, miner.publicKey, [earlyLock], GENESIS_TIMESTAMP + 9_999_999))
      .rejects.toThrow(/before fork activation/);

    // Now ABOVE the boundary: the next block (height PREFIX+1) accepts a lock.
    expect(chain.nextBlockScriptContext().scriptsActive).toBe(true);
    const lock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 10n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      miner.privateKey,
    );
    const lockIdHex = bytesToHex(lockIdOf(lock));
    expect(await chainAdd(chain, await buildBlock(chain, miner.publicKey, [lock]))).toBeNull();
    expect(getLock(chain.tipState, lockIdHex)).toBeDefined();

    // Redeem it post-activation to bob.
    const redeem = makeRedeem({ lockId: lockIdOf(lock), to: bob.publicKey, amount: 10n * COIN, fee: 0n, redeemScript: rs, witness: [preimage] });
    expect(await chainAdd(chain, await buildBlock(chain, miner.publicKey, [redeem]))).toBeNull();
    expect(getLock(chain.tipState, lockIdHex)).toBeUndefined();
    expect(getAccount(chain.tipState, bob.address).balance).toBe(10n * COIN);

    // Supply is conserved across the entire straddling chain (pre- AND post-fork blocks).
    assertConservation(chain);
  });
});

/** Hex hash of the canonical ancestor at a given height (walks back from the tip). */
function ancestorAtHeight(chain: Blockchain, height: number): string {
  for (const cb of chain.iterateCanonical()) {
    if (cb.block.header.height === height) return bytesToHex(cb.hash);
  }
  throw new Error('no canonical ancestor at height ' + height);
}

/** addBlockWithPow shorthand (PoW already valid for test-mined blocks). */
function chainAdd(chain: Blockchain, block: Block): Promise<string | null> {
  return chain.addBlockWithPow(block, true);
}
