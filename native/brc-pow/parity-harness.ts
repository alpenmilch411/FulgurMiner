/**
 * Parity harness.
 *
 * Proves the native Rust Argon2id core (native/brc-pow) is byte-identical to
 * the WASM `powHash` (src/crypto/pow.ts) for a battery of 148-byte inputs.
 *
 * For each input byte-vector it:
 *   (a) computes the digest via the WASM `powHash` (WASM RFC 9106 Argon2id)
 *   (b) computes the digest via the Rust binary `brc-pow hash <hex>`
 *   (c) compares the two lowercase-hex strings byte-for-byte.
 *
 * Inputs: all-zeros, all-0xFF, several patterned/incrementing vectors, plus 3
 * real block headers fetched live from the BrowserCoin API (first 148 bytes of
 * each block's hex — the same bytes are hashed through both impls).
 *
 * Run:  npx tsx native/brc-pow/parity-harness.ts
 * Exit: 0 if ALL vectors match, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { powHash } from '../../src/crypto/pow.js';
import { sandglassHash } from '../../src/crypto/sandglass.js';
import { SANDGLASS_FORK_HEIGHT } from '../../src/chain/genesis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUST_BIN = resolve(__dirname, 'target/release/brc-pow');
const HEADER_LEN = 148;
const API_URL = 'https://api1.browsercoin.org/blocks?fromHeight=1&max=3';

// Fork #2 frozen Sandglass vectors — the post-fork parity arbiter (TS==Rust==frozen).
// Named frozenVectors (NOT vectors) to avoid shadowing main()'s local Argon2id list.
const frozenVectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../src/crypto/sandglass.vectors.json'), 'utf8'),
) as { headerHex: string; digestHex: string }[];

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function rustHash(headerHex: string): string {
  return execFileSync(RUST_BIN, ['hash', headerHex], { encoding: 'utf8' }).trim();
}

// continuous=1, throttle=1 → every nonce in [start,end) is reported as SOLVED.
// stderr (HASHRATE) ignored; stdin ignored (no throttle stream for the harness).
function rustGrind(headerHex: string, targetHex: string, start: number, end: number): string[] {
  const out = execFileSync(
    RUST_BIN,
    ['grind', headerHex, targetHex, String(start), String(end), '1', '1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return out.split('\n').filter((l) => l.startsWith('SOLVED '));
}

function setHeightBE(header: Uint8Array, height: number): void {
  header[0] = (height >>> 24) & 0xff;
  header[1] = (height >>> 16) & 0xff;
  header[2] = (height >>> 8) & 0xff;
  header[3] = height & 0xff;
}

function heightPrefix(headerHex: string): number {
  return parseInt(headerHex.slice(0, 8), 16) >>> 0;
}

interface Vec {
  name: string;
  bytes: Uint8Array;
}

function makeVectors(): Vec[] {
  const v: Vec[] = [];

  // 1. all zeros
  v.push({ name: 'all-zeros', bytes: new Uint8Array(HEADER_LEN) });

  // 2. all 0xFF
  v.push({ name: 'all-0xFF', bytes: new Uint8Array(HEADER_LEN).fill(0xff) });

  // 3. incrementing byte = index & 0xFF
  {
    const b = new Uint8Array(HEADER_LEN);
    for (let i = 0; i < HEADER_LEN; i++) b[i] = i & 0xff;
    v.push({ name: 'incrementing-i', bytes: b });
  }

  // 4. reverse incrementing
  {
    const b = new Uint8Array(HEADER_LEN);
    for (let i = 0; i < HEADER_LEN; i++) b[i] = (HEADER_LEN - 1 - i) & 0xff;
    v.push({ name: 'reverse-incrementing', bytes: b });
  }

  // 5. alternating 0xAA / 0x55
  {
    const b = new Uint8Array(HEADER_LEN);
    for (let i = 0; i < HEADER_LEN; i++) b[i] = i % 2 === 0 ? 0xaa : 0x55;
    v.push({ name: 'alternating-aa55', bytes: b });
  }

  // 6. single 0x01 sentinel at byte 4 (NOT byte 0 — setHeightBE below overwrites
  //    bytes [0..4), so a byte-0 sentinel would collapse to all-zeros and be lost).
  {
    const b = new Uint8Array(HEADER_LEN);
    b[4] = 0x01;
    v.push({ name: 'one-at-4', bytes: b });
  }

  // 7. single 0x01 at last byte
  {
    const b = new Uint8Array(HEADER_LEN);
    b[HEADER_LEN - 1] = 0x01;
    v.push({ name: 'one-at-end', bytes: b });
  }

  // 8. all 0x80 (high bit set)
  v.push({ name: 'all-0x80', bytes: new Uint8Array(HEADER_LEN).fill(0x80) });

  // 9. deterministic LCG pseudo-random fill
  {
    const b = new Uint8Array(HEADER_LEN);
    let x = 0x1234_5678 >>> 0;
    for (let i = 0; i < HEADER_LEN; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      b[i] = (x >>> 16) & 0xff;
    }
    v.push({ name: 'lcg-pseudo-1', bytes: b });
  }

  // 10. second LCG with different seed
  {
    const b = new Uint8Array(HEADER_LEN);
    let x = 0xdead_beef >>> 0;
    for (let i = 0; i < HEADER_LEN; i++) {
      x = (Math.imul(x, 22695477) + 1) >>> 0;
      b[i] = (x >>> 24) & 0xff;
    }
    v.push({ name: 'lcg-pseudo-2', bytes: b });
  }

  // 11. blocky pattern: 0x00 x37, 0x11 x37, 0x22 x37, 0x33 x37
  {
    const b = new Uint8Array(HEADER_LEN);
    for (let i = 0; i < HEADER_LEN; i++) b[i] = (Math.floor(i / 37) * 0x11) & 0xff;
    v.push({ name: 'blocky-37', bytes: b });
  }

  // 12. ASCII-ish "BrowserCoin" repeated then padded
  {
    const seed = new TextEncoder().encode('BrowserCoin-PoW-parity-vector!');
    const b = new Uint8Array(HEADER_LEN);
    for (let i = 0; i < HEADER_LEN; i++) b[i] = seed[i % seed.length]!;
    v.push({ name: 'ascii-repeat', bytes: b });
  }

  // Fork #2: powHash is height-gated. Every Argon2id-parity fixture MUST decode to
  // a PRE-FORK height, or powHash would return Sandglass for it while the Rust
  // `hash` also returns Sandglass — masking a real Argon2id drift. Give each a
  // DISTINCT varying pre-fork height (varies multiple prefix bytes) so a native
  // impl that ignored the height prefix is still caught.
  v.forEach((vec, i) => {
    const height = (i + 1) * 2749;
    if (height >= SANDGLASS_FORK_HEIGHT) {
      throw new Error(`synthetic vector height ${height} must be pre-fork (< ${SANDGLASS_FORK_HEIGHT})`);
    }
    setHeightBE(vec.bytes, height);
  });

  return v;
}

async function fetchRealHeaders(): Promise<Vec[]> {
  const out: Vec[] = [];
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { blocks: string[] };
    data.blocks.slice(0, 3).forEach((blockHex, i) => {
      // First 148 bytes (296 hex chars) of each encoded block = the header.
      const headerHex = blockHex.slice(0, HEADER_LEN * 2);
      if (headerHex.length !== HEADER_LEN * 2) {
        throw new Error(`block[${i}] too short: ${blockHex.length} hex chars`);
      }
      out.push({ name: `real-block-${i + 1}-h${i + 1}`, bytes: fromHex(headerHex) });
    });
  } catch (e) {
    console.error(`WARNING: could not fetch real blocks: ${(e as Error).message}`);
  }
  return out;
}

async function main(): Promise<void> {
  const synthetic = makeVectors();
  const real = await fetchRealHeaders();
  const vectors = [...synthetic, ...real];

  console.log(`Comparing ${vectors.length} vectors (${synthetic.length} synthetic + ${real.length} real)`);
  console.log(`Rust binary: ${RUST_BIN}\n`);

  let mismatches = 0;
  const samples: string[] = [];

  for (const vec of vectors) {
    if (vec.bytes.length !== HEADER_LEN) {
      console.error(`FAIL ${vec.name}: length ${vec.bytes.length} != ${HEADER_LEN}`);
      mismatches++;
      continue;
    }
    const hex = toHex(vec.bytes);
    const tsHash = toHex(await powHash(vec.bytes));
    const rsHash = rustHash(hex);
    const ok = tsHash === rsHash;
    if (!ok) mismatches++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${vec.name.padEnd(24)} ts=${tsHash} rs=${rsHash}`);
    if (samples.length < 2) {
      samples.push(`${vec.name}: input148hex=${hex}\n    ts=${tsHash}\n    rs=${rsHash}`);
    }
    if (!ok) {
      console.error(`  >>> MISMATCH on ${vec.name}`);
      console.error(`      input148hex = ${hex}`);
    }
  }

  console.log('\n--- SAMPLE PAIRS ---');
  for (const s of samples) console.log(s);

  console.log(
    `\n--- ERA 1: Argon2id (pre-fork) --- ${vectors.length - mismatches}/${vectors.length} matched`,
  );

  // ─── ERA 2: Sandglass v3 (post-fork) — TS == Rust == frozen vectors ───
  console.log('\n--- ERA 2: Sandglass v3 (post-fork) ---');
  for (const v of frozenVectors) {
    const bytes = fromHex(v.headerHex);
    const ts = toHex(sandglassHash(bytes));
    const rs = rustHash(v.headerHex);
    const okTs = ts === v.digestHex;
    const okRs = rs === v.digestHex;
    if (!okTs || !okRs) mismatches++;
    console.log(`${okTs && okRs ? 'PASS' : 'FAIL'}  sandglass h=${heightPrefix(v.headerHex)} ts=${okTs} rs=${okRs}`);
    if (!okTs) console.error(`  >>> TS != frozen for ${v.headerHex}`);
    if (!okRs) console.error(`  >>> RUST != frozen (${rs}) for ${v.headerHex}`);
  }

  // Sandglass grind-path: consecutive nonces on a post-fork header, target all-FF
  // so every nonce solves. Each Rust SOLVED digest must equal TS sandglassHash of
  // the same header+nonce — proves grind routes to Sandglass AND the reused 512 KiB
  // buffer doesn't corrupt across hits.
  console.log('\n--- Sandglass grind-path (buffer reuse across nonces) ---');
  {
    const header = fromHex(frozenVectors[0]!.headerHex); // height 0x9c40 = 40000 (post-fork)
    const targetFF = 'ff'.repeat(32);
    const solved = rustGrind(toHex(header), targetFF, 0, 8);
    let gpMismatch = 0;
    for (const line of solved) {
      const parts = line.split(' ');
      const nonce = Number(parts[1]);
      const rs = parts[2]!;
      const h2 = header.slice();
      h2[112] = (nonce >>> 24) & 0xff;
      h2[113] = (nonce >>> 16) & 0xff;
      h2[114] = (nonce >>> 8) & 0xff;
      h2[115] = nonce & 0xff;
      const ts = toHex(sandglassHash(h2));
      if (ts !== rs) {
        gpMismatch++;
        mismatches++;
        console.error(`  >>> grind nonce ${nonce}: ts=${ts} rs=${rs}`);
      }
    }
    if (solved.length !== 8) {
      mismatches++;
      console.error(`  >>> expected 8 SOLVED, got ${solved.length}`);
    }
    console.log(
      `${solved.length === 8 && gpMismatch === 0 ? 'PASS' : 'FAIL'}  grind-path ${solved.length}/8 nonces, ${gpMismatch} mismatched`,
    );
  }

  // Boundary anti-drift: 33549 → Argon2id, 33550 → Sandglass. Rust must match the
  // (height-gated) TS powHash at BOTH — catches a drifted Rust SANDGLASS_FORK_HEIGHT.
  console.log('\n--- boundary (Rust fork-height vs genesis.ts) ---');
  for (const height of [SANDGLASS_FORK_HEIGHT - 1, SANDGLASS_FORK_HEIGHT]) {
    const b = new Uint8Array(HEADER_LEN);
    setHeightBE(b, height);
    const ts = toHex(await powHash(b));
    const rs = rustHash(toHex(b));
    const ok = ts === rs;
    if (!ok) mismatches++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  boundary h=${height} ts=${ts.slice(0, 16)}… rs=${rs.slice(0, 16)}…`);
    if (!ok) console.error(`  >>> boundary MISMATCH at height ${height}: Rust gate disagrees with genesis.ts`);
  }

  if (mismatches > 0) {
    console.error(`\nPARITY FAILED — ${mismatches} mismatch(es) across both eras`);
    process.exit(1);
  }
  console.log('\nPARITY ACHIEVED — all vectors byte-identical, both eras (Argon2id + Sandglass).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
