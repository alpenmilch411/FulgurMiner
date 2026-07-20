import { describe, it, expect } from 'vitest';
import { nextDifficulty, SANDGLASS_ANCHOR_DIFFICULTY_COMPACT } from './consensus.js';
import { type BlockHeader } from './block.js';
import {
  SANDGLASS_FORK_HEIGHT,
  SANDGLASS_ANCHOR_TIMESTAMP,
  SANDGLASS_ANCHOR_CLAMP_BLOCKS,
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
    const nextHeight = SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS;
    const parent = hdr({ height: nextHeight - 1, timestamp: earlyTs });
    const d = nextDifficulty(nextHeight, [parent], earlyTs + 1);
    // Held at the 4× clamp floor (target ≈ anchorTarget/4), NOT exploded below it.
    expect(compactToTarget(d)).toBeGreaterThan(anchorTarget / 8n);
    expect(compactToTarget(d)).toBeLessThan(anchorTarget); // still harder than the reset
  });

  it('does NOT clamp one block past the window (nextHeight = fork + CLAMP_BLOCKS + 1)', () => {
    const nextHeight = SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS + 1;
    const parent = hdr({ height: nextHeight - 1, timestamp: earlyTs });
    const d = nextDifficulty(nextHeight, [parent], earlyTs + 1);
    // Clamp no longer applies → the raw exploded target, far below the 4× floor.
    expect(compactToTarget(d)).toBeLessThan(anchorTarget / 8n);
  });
});
