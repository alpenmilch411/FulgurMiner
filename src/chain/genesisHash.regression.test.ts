/**
 * Genesis-hash regression — don't-bump-PoW gate.
 *
 * This test byte-pins the header/PoW encoding so a future change
 * (or any future change) cannot silently shift the genesis block hash.
 *
 * If this test fails after a patch, the PoW or header encoding changed and
 * every existing proof-of-work on the chain is invalidated — treat as CRITICAL.
 *
 * Golden value was pinned to the canonical value
 * This is a
 * genuine proof, not a self-pin.
 */
import { describe, expect, it } from 'vitest';
import { GENESIS } from './genesis.js';
import { hashHeader } from './block.js';
import { bytesToHex } from '../util/binary.js';

const GENESIS_HASH_HEX =
  '9fe010e8bdb735a5f7afacec8f5b6810550a4b25e73ea69d0159c44adf10ff74';

describe("genesis hash regression (don't-bump-PoW gate)", () => {
  it('genesis header hash is byte-frozen (header/PoW encoding did not move under the merge)', () => {
    expect(bytesToHex(hashHeader(GENESIS.header))).toBe(GENESIS_HASH_HEX);
  });
});
