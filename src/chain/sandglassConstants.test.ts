import { describe, it, expect } from 'vitest';
import {
  SANDGLASS_FORK_HEIGHT,
  SANDGLASS_ANCHOR_TIMESTAMP,
  SANDGLASS_ANCHOR_CLAMP_BLOCKS,
  SANDGLASS_ANCHOR_ATTEMPTS,
} from './genesis.js';

// Consensus constants — a follower MUST match upstream's sandglass-v3-fork or it
// computes a different reset difficulty and diverges. These pins fail loudly on
// any accidental local edit. Re-verify against upstream immediately before deploy.
describe('fork #2 Sandglass consensus constants (byte-match upstream fe8153a)', () => {
  it('pins the fork height (community-vote, 2026-07-22)', () => {
    expect(SANDGLASS_FORK_HEIGHT).toBe(33_550);
  });
  it('pins the ASERT re-anchor timestamp (2026-07-22 12:00 UTC / 14:00 CEST)', () => {
    expect(SANDGLASS_ANCHOR_TIMESTAMP).toBe(1784721600);
    expect(new Date(SANDGLASS_ANCHOR_TIMESTAMP * 1000).toISOString()).toBe('2026-07-22T12:00:00.000Z');
  });
  it('pins the post-fork difficulty-clamp window', () => {
    expect(SANDGLASS_ANCHOR_CLAMP_BLOCKS).toBe(2000);
  });
  it('pins the anchor attempts (reset difficulty input)', () => {
    expect(SANDGLASS_ANCHOR_ATTEMPTS).toBe(5_000_000);
  });
});
