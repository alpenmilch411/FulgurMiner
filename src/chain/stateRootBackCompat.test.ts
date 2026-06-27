/**
 * stateRoot back-compat — the make-or-break scripting-hardfork invariant.
 *
 * The post-fork State shape adds a `locks` Map, but the stateRoot algorithm
 * MUST hash an accounts-only state (locks.size === 0) byte-identically to the
 * legacy pre-fork chain. If it does not, all pre-fork history (and all
 * transfer-only post-fork blocks) would produce wrong stateRoot values and be
 * rejected — a chain-split.
 *
 * Both golden values below were controller-cross-checked against the pre-merge
 * legacy flat-Map stateRoot implementation for the same accounts and
 * produced IDENTICAL hashes (MATCH_ACCOUNTS=true, MATCH_EMPTY=true).
 * This is a genuine back-compat proof, not a self-pin of the merged code.
 */
import { describe, expect, it } from 'vitest';
import { emptyState, stateRoot } from './state.js';
import { bytesToHex } from '../util/binary.js';

/** Accounts-only state root (back-compat with the legacy format). */
const ACCOUNTS_ONLY_ROOT_HEX =
  '8f96c72970ba26b9980ca401934cb6e1b509c7d7ea08b2a4d0c8d1b705c9b006';

/** Empty-state root — must equal the legacy all-zeros root. */
const EMPTY_ROOT_HEX = '0'.repeat(64);

describe('stateRoot back-compat (locks.size===0 hashes like the legacy chain)', () => {
  it('an accounts-only state has zero locks and hashes to the frozen legacy root', () => {
    const s = emptyState();
    s.accounts.set('11'.repeat(32), { balance: 1234n, nonce: 5 });
    s.accounts.set('22'.repeat(32), { balance: 9999n, nonce: 0 });

    // Prove no locks were introduced
    expect(s.locks.size).toBe(0);

    // The stateRoot of an accounts-only post-fork state MUST equal the
    // pre-merge flat-Map stateRoot for the same accounts.
    expect(bytesToHex(stateRoot(s))).toBe(ACCOUNTS_ONLY_ROOT_HEX);
  });

  it('the empty state root is unchanged from legacy (all-zeros)', () => {
    // The legacy chain produced 32 zero bytes for an empty state.
    // The merged stateRoot MUST preserve this.
    expect(bytesToHex(stateRoot(emptyState()))).toBe(EMPTY_ROOT_HEX);
  });
});
