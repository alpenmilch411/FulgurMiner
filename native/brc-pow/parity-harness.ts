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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { powHash } from '../../src/crypto/pow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUST_BIN = resolve(__dirname, 'target/release/brc-pow');
const HEADER_LEN = 148;
const API_URL = 'https://api1.browsercoin.org/blocks?fromHeight=1&max=3';

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

  // 6. single 0x01 at byte 0, rest zero
  {
    const b = new Uint8Array(HEADER_LEN);
    b[0] = 0x01;
    v.push({ name: 'one-at-0', bytes: b });
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
    `\nRESULT: ${vectors.length - mismatches}/${vectors.length} matched, ${mismatches} mismatched`,
  );
  if (mismatches > 0) {
    console.error('PARITY FAILED');
    process.exit(1);
  }
  console.log('PARITY ACHIEVED — all vectors byte-identical.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
