// src/minerd/nativeParity.ts
//
// Native-engine consensus self-check.
//
// The native brc-pow binary is cached at native/brc-pow/target/release/brc-pow
// and is NOT rebuilt by a plain `git pull` upgrade — nothing in the upgrade path
// touches target/. So a binary built with an OLD PoW rule keeps grinding it and,
// past the current fork height, produces 100% invalid shares/blocks (it "does the
// old algo"). `existsSync(NATIVE_BIN)` and the `continuous`-arg probe cannot tell a
// current binary from a stale one — both pass for such a build.
//
// This gate proves the binary GRINDS the current PoW at the EXACT fork boundary
// before we grind a single real share. Two subtleties, both learned the hard way:
//
//   1. Check at EXACTLY SANDGLASS_FORK_HEIGHT, not at some arbitrary post-fork
//      height. The fork height moved during development (an earlier spec used
//      34,800 before it settled on 33,550). A binary compiled against the old
//      34,800 constant computes Sandglass by height 40,000 but still Argon2id in
//      [33,550, 34,800) — the live range right after activation — so a probe at
//      40,000 would wave it through while it mines invalid work now. Probing at
//      SANDGLASS_FORK_HEIGHT catches a wrong fork-height constant.
//
//   2. Exercise `grind`, not `hash`. Real work goes through `brc-pow grind`, which
//      selects its algorithm INDEPENDENTLY of `hash` in the Rust binary. A
//      half-ported binary (correct `hash` branch, stale `grind` branch) would pass
//      a `hash`-only check and still mine invalid shares. So we grind one nonce and
//      compare the SOLVED digest — the same reason the parity harness tests grind
//      separately. (A successful continuous grind here also proves the binary
//      accepts the `continuous` arg, i.e. it subsumes nativeContinuousOk.)
//
// The reference digest is the wasm-side Sandglass mirror (`sandglassHash`, gated
// byte-identical to the frozen vectors in CI) — we never re-implement consensus,
// we compare the native binary against the engine the rest of the miner trusts.
// Spawns the binary once (~ms) — the same class of one-time startup probe as
// nativeContinuousOk(). Fails CLOSED (false) on every error path: a native binary
// we can't positively verify is treated as unusable so the caller uses wasm.
import { execFileSync } from 'node:child_process';
import { NATIVE_BIN } from './nativeGrindPool.js';
import { sandglassHash } from '../crypto/sandglass.js';
import { SANDGLASS_FORK_HEIGHT } from '../chain/genesis.js';

const HEADER_LEN = 148;

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/**
 * A deterministic 148-byte header whose big-endian height prefix (bytes [0..4)) is
 * `height`, everything else zero. The nonce field (bytes [112..116)) is zero, so
 * grinding nonce 0 hashes exactly this header — letting us predict the digest with
 * sandglassHash(header).
 */
function headerAtHeight(height: number): Uint8Array {
  const h = new Uint8Array(HEADER_LEN);
  h[0] = (height >>> 24) & 0xff;
  h[1] = (height >>> 16) & 0xff;
  h[2] = (height >>> 8) & 0xff;
  h[3] = height & 0xff;
  return h;
}

/**
 * True iff the native binary GRINDS the current post-fork PoW (Sandglass) at the
 * exact fork boundary. We grind a single nonce (0) at height SANDGLASS_FORK_HEIGHT
 * with an all-ff target (so nonce 0 always solves regardless of algorithm) and
 * require the SOLVED digest to equal the TS Sandglass reference for that header.
 * A pre-fork / wrong-fork-height / half-ported binary returns a different digest
 * (or no SOLVED line) → false.
 *
 * `bin` is injectable for tests; production callers pass nothing (→ NATIVE_BIN).
 */
export function nativePowIsCurrent(bin: string = NATIVE_BIN): boolean {
  try {
    // Note: the boundary check is deliberately ONE-SIDED. A binary whose fork
    // constant is ABOVE 33,550 (e.g. the old 34,800) is rejected — that's the live
    // risk (it grinds the old algo in the range we mine now). A binary whose
    // constant is BELOW 33,550 passes, but that is harmless: it selects Sandglass
    // for every height ≥ 33,550, i.e. it is correct for all work we will ever grind
    // (we never mine pre-fork history). So we don't add an async pre-fork Argon2id
    // probe for a non-live case.
    const header = headerAtHeight(SANDGLASS_FORK_HEIGHT);
    const expected = toHex(sandglassHash(header)); // nonce 0 ⇒ digest of this header
    // grind <header> <target=ff…> <start=0> <end=1> <throttle=1> <continuous=1>
    // → grinds only nonce 0, which solves against the max target, then (continuous)
    // keeps going, reaches end, and prints EXHAUSTED before exiting. stderr
    // (HASHRATE) and stdin (throttle stream) are ignored.
    const out = execFileSync(
      bin,
      ['grind', toHex(header), 'ff'.repeat(32), '0', '1', '1', '1'],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lines = out.split('\n').map((l) => l.trimEnd());
    // Require EXACTLY one SOLVED line, and it must be `SOLVED 0 <expected>`. This
    // pins the nonce (a grinder that hashes nonce 0 but MISLABELS it "SOLVED 1"
    // would emit shifted/invalid nonces in real mining) AND the digest. Requiring a
    // trailing EXHAUSTED proves the binary honored continuous=1 and ran the range to
    // completion (a binary that ignores continuous and exits after one solve would
    // respawn-churn the pool) — so this also subsumes the nativeContinuousOk intent.
    const solvedLines = lines.filter((l) => l.startsWith('SOLVED '));
    if (solvedLines.length !== 1) return false;
    if (solvedLines[0] !== `SOLVED 0 ${expected}`) return false;
    return lines.includes('EXHAUSTED');
  } catch {
    return false;
  }
}
