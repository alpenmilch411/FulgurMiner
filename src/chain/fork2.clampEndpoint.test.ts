import { describe, it, expect } from 'vitest';
import { nextDifficulty, SANDGLASS_ANCHOR_DIFFICULTY_COMPACT } from './consensus.js';
import { type BlockHeader } from './block.js';
import {
  SANDGLASS_FORK_HEIGHT,
  SANDGLASS_ANCHOR_TIMESTAMP,
  SANDGLASS_ANCHOR_CLAMP_BLOCKS,
  SANDGLASS2_ANCHOR_HEIGHT,
} from './genesis.js';
import { compactToTarget } from '../util/binary.js';

// Repo-only regression guard (NOT from upstream — kept out of fork2.test.ts so a
// future `git checkout upstream -- fork2.test.ts` re-sync can't silently drop it).
//
// Upstream's clamp test (fork2.test.ts) exercises an INTERIOR post-fork height
// (fork+6) with loose bands, so it would NOT catch flipping the window guard
// `nextHeight <= SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS` to `<`
// (Codex layered-review LOW, 2026-07-20). This pins the exact endpoint: the last
// block in the window is clamped, the first block past it is not.
function hdr(over: Partial<BlockHeader>): BlockHeader {
  return {
    height: 1,
    prevHash: new Uint8Array(32).fill(1),
    txRoot: new Uint8Array(32).fill(2),
    stateRoot: new Uint8Array(32).fill(3),
    timestamp: SANDGLASS_ANCHOR_TIMESTAMP,
    difficulty: 0x20020000,
    nonce: 0,
    miner: new Uint8Array(32).fill(4),
    ...over,
  };
}

describe('fork #2 — difficulty clamp WINDOW ENDPOINT (repo-only guard)', () => {
  // A parent 60 days ahead of the anchor schedule drives the raw ASERT target
  // FAR past the 4× clamp band (difficulty explodes / target collapses), so the
  // clamped vs. unclamped result is unambiguously distinguishable.
  const earlyTs = SANDGLASS_ANCHOR_TIMESTAMP - 60 * 24 * 3600;
  const anchorTarget = compactToTarget(SANDGLASS_ANCHOR_DIFFICULTY_COMPACT);

  it('CLAMPS the last block in the window (nextHeight = fork + CLAMP_BLOCKS)', () => {
    // == SANDGLASS2_ANCHOR_HEIGHT, still inside the fork-#2 clamp window (frozen
    // history that must keep validating). Anchor is null: fork #3 owns > this.
    const nextHeight = SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS;
    expect(nextHeight).toBe(SANDGLASS2_ANCHOR_HEIGHT);
    const parent = hdr({ height: nextHeight - 1, timestamp: earlyTs });
    const d = nextDifficulty(nextHeight, [parent], earlyTs + 1, null);
    // Held at the 4× clamp floor (target ≈ anchorTarget/4), NOT exploded below it.
    expect(compactToTarget(d)).toBeGreaterThan(anchorTarget / 8n);
    expect(compactToTarget(d)).toBeLessThan(anchorTarget); // still harder than the reset
  });

  it('hands the block one past the window to fork #3, not the fork-#2 raw tail', () => {
    // fork + CLAMP_BLOCKS + 1 == SANDGLASS2_ANCHOR_HEIGHT + 1: the exact block
    // where the fork-#2 clamp used to expire and discharge all its accumulated
    // drift in one retarget — the cliff that bricked the chain. Fork #3
    // intercepts it (anchored on the REAL block SANDGLASS2_ANCHOR_HEIGHT) instead
    // of falling through to the raw fork-#2 tail, and without the real anchor it
    // REFUSES to retarget rather than guess.
    const nextHeight = SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS + 1;
    expect(nextHeight).toBe(SANDGLASS2_ANCHOR_HEIGHT + 1);
    const parent = hdr({ height: nextHeight - 1, timestamp: earlyTs });
    expect(() => nextDifficulty(nextHeight, [parent], earlyTs + 1, null)).toThrow(/anchor header/);
  });
});
