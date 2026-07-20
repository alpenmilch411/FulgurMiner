import { describe, it, expect } from 'vitest';
import { powHash } from './pow.js';
import { sandglassHash } from './sandglass.js';
import { SANDGLASS_FORK_HEIGHT } from '../chain/genesis.js';
import { bytesToHex } from '../util/binary.js';

// Build a 148-ish-byte header whose first 4 bytes are `height` (big-endian),
// matching encodeHeader's layout — powHash reads only those 4 bytes to gate.
function headerWithHeight(height: number): Uint8Array {
  const b = new Uint8Array(148);
  b[0] = (height >>> 24) & 0xff;
  b[1] = (height >>> 16) & 0xff;
  b[2] = (height >>> 8) & 0xff;
  b[3] = height & 0xff;
  for (let i = 4; i < b.length; i++) b[i] = (i * 7 + 1) & 0xff;
  return b;
}

describe('powHash fork #2 height gate', () => {
  it('uses Sandglass at/after the fork height', async () => {
    for (const h of [SANDGLASS_FORK_HEIGHT, SANDGLASS_FORK_HEIGHT + 1, SANDGLASS_FORK_HEIGHT + 9999]) {
      const bytes = headerWithHeight(h);
      expect(bytesToHex(await powHash(bytes))).toBe(bytesToHex(sandglassHash(bytes)));
    }
  });
  it('uses Argon2id (not Sandglass) below the fork height', async () => {
    const bytes = headerWithHeight(SANDGLASS_FORK_HEIGHT - 1);
    expect(bytesToHex(await powHash(bytes))).not.toBe(bytesToHex(sandglassHash(bytes)));
  });
});
