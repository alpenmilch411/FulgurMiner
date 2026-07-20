import { defineConfig } from 'vitest/config';

// FulgurMiner runs TWO test runners:
//   - vitest (this config) for the mirrored consensus suite under src/chain/*,
//     which exercises the BrowserCoin consensus rules — the chain/crypto/util
//     files (Argon2id PoW + state transitions).
//   - node:test for the miner-specific suite under src/minerd/* (see the
//     "test:minerd" script). Those files import 'node:test', so vitest must NOT
//     pick them up — hence the chain-only include below.
export default defineConfig({
  test: {
    include: ['src/chain/**/*.test.ts', 'src/crypto/**/*.test.ts'],
    environment: 'node',
    // Several chain tests mine real Argon2id blocks (boundaryReorg, scripttx,
    // chain-build helpers in testutil). At the v5 PoW floor that is ~10–15 s per
    // mined block, so the default 5 s timeout would always fail. Give
    // headroom for mining.
    testTimeout: 180_000,
    // Sequential files: parallel CPU-bound Argon2id mining starves vitest's
    // worker-IPC heartbeat and trips a spurious 60 s timeout.
    fileParallelism: false,
  },
});
