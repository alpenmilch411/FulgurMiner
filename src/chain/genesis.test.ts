import { describe, expect, it } from 'vitest';
import { FORK1_ACTIVATION_TIME, MAX_TX_BYTES, MAX_BLOCK_BYTES } from './genesis.js';

describe('hardfork genesis constants', () => {
  it('pins FORK1_ACTIVATION_TIME to 2026-07-05T16:00:00Z', () => {
    expect(FORK1_ACTIVATION_TIME).toBe(1783267200);
    expect(new Date(FORK1_ACTIVATION_TIME * 1000).toISOString()).toBe('2026-07-05T16:00:00.000Z');
  });
  it('sets MAX_TX_BYTES above the worst-case Redeem (62,287) and below the block cap', () => {
    expect(MAX_TX_BYTES).toBe(65_536);
    expect(MAX_TX_BYTES).toBeGreaterThan(62_287);
    expect(MAX_TX_BYTES).toBeLessThan(MAX_BLOCK_BYTES);
  });
});
