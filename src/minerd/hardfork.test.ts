// Miner-specific coverage for the scripting hard-fork port.
//
// The mirrored vitest suite (src/chain/*.test.ts) proves the consensus files
// themselves — including Blockchain validation of post-activation Lock/Redeem
// blocks (scripttx, boundaryReorg). What it does NOT cover is the MINER's own
// self-check path: buildTemplate() + validateTemplate(), the 5-arg applyBlockTxs
// call sites this port changed. These must agree with the validator on BOTH
// sides of the fork boundary, and the solo chain must accept a real post-
// activation script block end-to-end.
//
// Runs under node:test (the miner's runner) — NOT vitest — so it imports the
// chain test helpers (testutil.ts) directly; those carry no test-framework deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain } from '../chain/blockchain.js';
import { buildTemplate } from './template.js';
import { validateTemplate } from './index.js';
import {
  setForkActivationTimeForTesting,
  resetForkActivationTimeForTesting,
} from '../chain/fork.js';
import { GENESIS_TIMESTAMP, COIN } from '../chain/genesis.js';
import { generateKeyPair } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat, bytesToHex } from '../util/binary.js';
import { signLock, lockIdOf } from '../chain/transaction.js';
import { getLock } from '../chain/state.js';
import { Op } from '../chain/script.js';
import { buildBlock, emptyMine } from '../chain/testutil.js';

const ZERO32 = new Uint8Array(32);

/** Minimal canonical push for data ≤ 75 bytes (sha256 output is 32). */
function push(data: Uint8Array): Uint8Array {
  return concat(new Uint8Array([data.length]), data);
}
/** Hash-lock redeem script: OP_SHA256 <h> OP_EQUAL. */
function hashLockScript(preimage: Uint8Array): Uint8Array {
  return concat(new Uint8Array([Op.OP_SHA256]), push(sha256(preimage)), new Uint8Array([Op.OP_EQUAL]));
}

/** buildTemplate + the independent validateTemplate recompute must both agree. */
function selfCheckAgrees(chain: Blockchain, minerPubkey: Uint8Array): boolean {
  const t = buildTemplate(chain, minerPubkey);
  const { okPrev, okStateRoot } = validateTemplate(
    t,
    chain.tip.hash,
    chain.tipState,
    minerPubkey,
    chain.nextBlockScriptContext(),
  );
  return okPrev && okStateRoot;
}

test('solo self-check agrees with the validator when scripts are ACTIVE (post-fork)', { timeout: 120_000 }, async () => {
  setForkActivationTimeForTesting(GENESIS_TIMESTAMP); // mtp at genesis == GENESIS_TIMESTAMP → active
  try {
    const chain = new Blockchain();
    const miner = generateKeyPair();
    assert.equal(chain.nextBlockScriptContext().scriptsActive, true, 'scripts must be active at/after the activation mtp');
    assert.ok(selfCheckAgrees(chain, miner.publicKey), 'empty-block self-check must agree with the validator post-fork');
    // Independent of the template self-check (which shares its recompute shape):
    // the REAL validator (addBlockInternal, computing its OWN scriptsActive/blockMtp
    // ctx) must accept a post-fork empty block — proving non-circular agreement.
    assert.equal(await chain.addBlock(await emptyMine(chain, miner.publicKey)), null, 'real validator must accept a post-fork empty block');
    assert.ok(selfCheckAgrees(chain, miner.publicKey), 'self-check still agrees on the new tip');
  } finally {
    resetForkActivationTimeForTesting();
  }
});

test('solo self-check agrees with the validator when scripts are INACTIVE (pre-fork)', () => {
  setForkActivationTimeForTesting(GENESIS_TIMESTAMP + 1_000_000_000); // far future → inactive
  try {
    const chain = new Blockchain();
    const miner = generateKeyPair();
    assert.equal(chain.nextBlockScriptContext().scriptsActive, false, 'scripts must be inactive before the activation mtp');
    assert.ok(selfCheckAgrees(chain, miner.publicKey), 'empty-block self-check must agree with the validator pre-fork');
  } finally {
    resetForkActivationTimeForTesting();
  }
});

test('solo accepts a post-activation Lock block end-to-end + self-check survives', { timeout: 120_000 }, async () => {
  setForkActivationTimeForTesting(GENESIS_TIMESTAMP);
  try {
    const miner = generateKeyPair();
    const chain = new Blockchain();

    // Block 1: coinbase funds the miner (empty block).
    assert.equal(await chain.addBlock(await emptyMine(chain, miner.publicKey)), null);

    // Block 2: a real post-activation Lock tx — what would WEDGE an unported solo node.
    const rs = hashLockScript(new TextEncoder().encode('solo-secret'));
    const lock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 10n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      miner.privateKey,
    );
    const lockId = lockIdOf(lock);
    assert.equal(
      await chain.addBlock(await buildBlock(chain, miner.publicKey, [lock])),
      null,
      'post-activation Lock block must be accepted by the solo validator',
    );
    assert.ok(getLock(chain.tipState, bytesToHex(lockId)), 'the lock must be live in state');

    // The miner self-check must still agree on a tip whose state now carries a lock.
    assert.ok(selfCheckAgrees(chain, miner.publicKey), 'self-check must agree after applying a real script block');
  } finally {
    resetForkActivationTimeForTesting();
  }
});
