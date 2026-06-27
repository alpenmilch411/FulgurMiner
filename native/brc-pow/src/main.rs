//! Native Rust Argon2id PoW core for BrowserCoin.
//!
//! Invariant: the digest produced here MUST be
//! byte-identical to the WASM `powHash` (src/crypto/pow.ts), which uses the
//! openpgpjs/argon2id WASM implementation of RFC 9106 Argon2id.
//!
//! Parameters (mirrored from POW_PARAMS in src/crypto/pow.ts):
//!   - Algorithm : Argon2id
//!   - Version   : 0x13 (RFC 9106 / v1.3)
//!   - Memory    : 32 * 1024 KiB = 32768 KiB (32 MB)
//!   - Iterations: 1 (passes)
//!   - Parallelism: 1 (lanes)
//!   - Output    : 32 bytes
//!   - Salt      : raw ASCII bytes of "browsercoin-pow-v5" (NOT base64-decoded)
//!   - Password  : the raw header bytes (encodeHeader output, 148 bytes)
//!
//! CLI:
//!   brc-pow hash <header-hex>
//!     -> prints lowercase hex of the 32-byte Argon2id digest.
//!
//!   brc-pow grind <header-hex> <target-hex> <start> <end> <throttle> [continuous]
//!     -> loops nonce in [start, end), writing the u32 nonce BIG-ENDIAN at byte
//!        offset 112 of the 148-byte header (same offset as src/minerd/powWorker.ts),
//!        argon2id-hashes, and big-endian-compares hash < target. On each hit
//!        prints `SOLVED <nonce> <hashhex>` to stdout. By default it exits after
//!        the first hit; with continuous set to `1` or `true`, it keeps scanning
//!        the range and reports every hit. If the range is exhausted prints
//!        `EXHAUSTED`. Honors `throttle` in (0,1] with the same duty-cycle idea
//!        as powWorker.ts (rest in proportion to time just spent hashing). Emits
//!        `HASHRATE <n>` to stderr roughly once per second. Single-threaded per
//!        process — Node spawns one process per nonce range.

use argon2::{Algorithm, Argon2, Block, Params, Version};
use std::io::BufRead;
use std::process::exit;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Network-wide fixed salt — must match `SALT` in src/crypto/pow.ts exactly.
const SALT: &[u8] = b"browsercoin-pow-v5";

const MEM_KIB: u32 = 32 * 1024; // 32768 KiB
const ITERATIONS: u32 = 1;
const PARALLELISM: u32 = 1;
const OUTPUT_LEN: usize = 32;

/// u32 nonce position in the 148-byte header — must match NONCE_OFFSET in
/// src/minerd/powWorker.ts (and miner.worker.ts).
const NONCE_OFFSET: usize = 112;
const HEADER_LEN: usize = 148;
const HASHRATE_REPORT: Duration = Duration::from_millis(1000);

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(format!("hex string has odd length ({})", s.len()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let nib = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("invalid hex char: {:?}", c as char)),
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        let hi = nib(bytes[i])?;
        let lo = nib(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Compute the Argon2id PoW digest of `password` using the fixed network salt.
/// Byte-identical to the WASM `powHash`.
pub fn pow_hash(password: &[u8]) -> Result<[u8; OUTPUT_LEN], String> {
    let params = Params::new(MEM_KIB, ITERATIONS, PARALLELISM, Some(OUTPUT_LEN))
        .map_err(|e| format!("invalid argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; OUTPUT_LEN];
    argon2
        .hash_password_into(password, SALT, &mut out)
        .map_err(|e| format!("argon2 hashing failed: {e}"))?;
    Ok(out)
}

/// Write `nonce` as a big-endian u32 at NONCE_OFFSET of `header`.
/// Mirrors writeNonceBE() in src/minerd/powWorker.ts byte-for-byte.
#[inline]
fn write_nonce_be(header: &mut [u8], nonce: u32) {
    header[NONCE_OFFSET] = ((nonce >> 24) & 0xff) as u8;
    header[NONCE_OFFSET + 1] = ((nonce >> 16) & 0xff) as u8;
    header[NONCE_OFFSET + 2] = ((nonce >> 8) & 0xff) as u8;
    header[NONCE_OFFSET + 3] = (nonce & 0xff) as u8;
}

/// Big-endian 256-bit comparison: returns true iff `hash` < `target`.
/// Both are 32-byte arrays interpreted as big-endian unsigned integers — the
/// same numeric semantics as hashMeetsTarget() in src/util/binary.ts.
#[inline]
fn meets_target(hash: &[u8; OUTPUT_LEN], target: &[u8; OUTPUT_LEN]) -> bool {
    for i in 0..OUTPUT_LEN {
        if hash[i] != target[i] {
            return hash[i] < target[i];
        }
    }
    false // equal => not strictly less than
}

/// Grind a contiguous nonce range single-threaded.
///
/// Returns the exit code to use. Prints `SOLVED <nonce> <hashhex>` to stdout for
/// each nonce whose digest is strictly below the target. In non-continuous mode
/// it returns 0 after the first hit; in continuous mode it keeps scanning the
/// range. Otherwise prints `EXHAUSTED` and returns 0. Emits `HASHRATE <n>` to
/// stderr roughly once per second (n = hashes completed in the last ~1s window).
fn grind(
    mut header: Vec<u8>,
    target: [u8; OUTPUT_LEN],
    start: u64,
    end: u64,
    throttle: f64,
    continuous: bool,
) -> Result<i32, String> {
    if header.len() != HEADER_LEN {
        return Err(format!(
            "header must be {HEADER_LEN} bytes, got {}",
            header.len()
        ));
    }
    // Clamp throttle into (0, 1], mirroring powWorker.ts's duty-cycle clamp
    // (Math.min(1, Math.max(0.05, throttle))).
    let throttle = throttle.max(0.05).min(1.0);
    let throttle_bits = Arc::new(AtomicU64::new(throttle.to_bits()));
    {
        let tb = Arc::clone(&throttle_bits);
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines().flatten() {
                if let Some(rest) = line.trim().strip_prefix("THROTTLE ") {
                    if let Ok(v) = rest.trim().parse::<f64>() {
                        tb.store(v.max(0.05).min(1.0).to_bits(), Ordering::Relaxed);
                    }
                }
            }
        });
    }

    let params = Params::new(MEM_KIB, ITERATIONS, PARALLELISM, Some(OUTPUT_LEN))
        .map_err(|e| format!("invalid argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.clone());
    let mut blocks = vec![Block::new(); params.block_count()];

    let mut hashes_window: u64 = 0;
    let mut last_report = Instant::now();

    // u64 loop counter so `end == 2^32` (the exclusive upper bound of the
    // nonce space, i.e. partitionNonceSpace's last range end) is representable
    // without overflow. Nonces themselves are always < 2^32 (u32 in the header).
    let mut nonce: u64 = start;
    while nonce < end {
        write_nonce_be(&mut header, nonce as u32);
        let t0 = Instant::now();
        let mut out = [0u8; OUTPUT_LEN];
        argon2
            .hash_password_into_with_memory(&header, SALT, &mut out, &mut blocks)
            .map_err(|e| format!("argon2 hashing failed: {e}"))?;
        let work = t0.elapsed();
        hashes_window += 1;

        if meets_target(&out, &target) {
            println!("SOLVED {} {}", nonce, to_hex(&out));
            if !continuous {
                return Ok(0);
            }
        }

        // Duty-cycle throttle: rest in proportion to the time just spent
        // hashing, so sustained CPU is capped at ~throttle (same idea as
        // powWorker.ts). 1.0 = full blast (no sleep).
        let throttle = f64::from_bits(throttle_bits.load(Ordering::Relaxed));
        if throttle < 1.0 {
            let work_ms = work.as_secs_f64() * 1000.0;
            let sleep_ms = (work_ms * (1.0 - throttle) / throttle).min(1000.0);
            if sleep_ms >= 1.0 {
                std::thread::sleep(Duration::from_secs_f64(sleep_ms / 1000.0));
            }
        }

        let now = Instant::now();
        if now.duration_since(last_report) >= HASHRATE_REPORT {
            eprintln!("HASHRATE {}", hashes_window);
            hashes_window = 0;
            last_report = now;
        }

        nonce += 1;
    }

    println!("EXHAUSTED");
    Ok(0)
}

/// Parse a nonce-space bound (start or end). Accepts decimal in [0, 2^32].
/// 2^32 (4294967296) is the exclusive upper bound used by partitionNonceSpace
/// for the final range's `end`.
fn parse_bound(s: &str, name: &str) -> Result<u64, String> {
    let s = s.trim();
    match s.parse::<u64>() {
        Ok(v) if v <= 1u64 << 32 => Ok(v),
        Ok(v) => Err(format!("{name}={v} exceeds 2^32")),
        Err(_) => Err(format!("invalid {name}: {s:?}")),
    }
}

const USAGE: &str = "usage:\n  brc-pow hash <header-hex>\n  brc-pow grind <header-hex> <target-hex> <start> <end> <throttle> [continuous]";

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {msg}");
    exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("{USAGE}");
        exit(2);
    }
    match args[1].as_str() {
        "hash" => {
            if args.len() != 3 {
                eprintln!("{USAGE}");
                exit(2);
            }
            let header = decode_hex(&args[2]).unwrap_or_else(|e| fail(e));
            match pow_hash(&header) {
                Ok(digest) => println!("{}", to_hex(&digest)),
                Err(e) => fail(e),
            }
        }
        "grind" => {
            if args.len() != 7 && args.len() != 8 {
                eprintln!("{USAGE}");
                exit(2);
            }
            let header = decode_hex(&args[2]).unwrap_or_else(|e| fail(e));
            let target_bytes = decode_hex(&args[3]).unwrap_or_else(|e| fail(e));
            if target_bytes.len() != OUTPUT_LEN {
                fail(format!(
                    "target must be {OUTPUT_LEN} bytes ({} hex chars), got {} bytes",
                    OUTPUT_LEN * 2,
                    target_bytes.len()
                ));
            }
            let mut target = [0u8; OUTPUT_LEN];
            target.copy_from_slice(&target_bytes);

            let start = parse_bound(&args[4], "start").unwrap_or_else(|e| fail(e));
            let end = parse_bound(&args[5], "end").unwrap_or_else(|e| fail(e));
            if start > end {
                fail(format!("start ({start}) > end ({end})"));
            }
            let throttle: f64 = args[6]
                .trim()
                .parse()
                .unwrap_or_else(|_| fail(format!("invalid throttle: {:?}", args[6])));
            let continuous = args
                .get(7)
                .map(|v| {
                    let v = v.trim();
                    v == "1" || v.eq_ignore_ascii_case("true")
                })
                .unwrap_or(false);

            match grind(header, target, start, end, throttle, continuous) {
                Ok(code) => exit(code),
                Err(e) => fail(e),
            }
        }
        other => {
            eprintln!("unknown subcommand: {other}");
            eprintln!("{USAGE}");
            exit(2);
        }
    }
}
