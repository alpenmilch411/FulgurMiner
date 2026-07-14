// src/minerd/pools.ts
//
// The pool vocabulary: what a mining destination IS, how a pool URL is spelled,
// which pools ship with the miner, and which URL is FulgurPool's.
//
// PURE LEAF MODULE - no node:fs, no env, no imports from config / menu / settings /
// targets. Everything else imports THIS, so it must never import them back.

/** The result of normalising a pool URL. Never throws; a failure carries a reason. */
export type CanonResult = { ok: true; url: string } | { ok: false; reason: string };

/** Requires `://` - so `localhost:3000` is not read as the protocol `localhost:`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
/** A typo'd solo (solo1, offf, ...) gets a did-you-mean instead of https://solo1. */
const SOLOISH_RE = /^(solo|off|none)/i;

/** Scheme-less input only: does this actually look like a host? */
function looksLikeHost(hostname: string, port: string): boolean {
  if (port !== '') return true; // localhost:3000, 192.168.1.50:8080
  if (hostname === 'localhost') return true;
  if (hostname.startsWith('[')) return true; // IPv6 literal, e.g. [::1]
  return hostname.includes('.'); // pool.foo.org, 10.0.0.5
}

/**
 * The ONE pool-URL normaliser, used by decodePoolChoice, the pools.json reader and
 * both Add-a-pool forms, so every surface agrees on what a pool URL is.
 *
 * trim -> reject control chars + spaces -> prepend https:// when there is no scheme
 * -> new URL() -> http(s) only, no credentials -> (scheme-less only) the host must
 * look like a host -> lowercase scheme+host, keep the port, keep the path minus
 * trailing slashes, drop query + fragment. IDEMPOTENT (pinned by test).
 *
 * NOTE - plaintext LAN pools: scheme-less input ALWAYS gets https://, so
 * `localhost:3000` becomes `https://localhost:3000` and a plaintext dev pool will
 * fail at TLS. Deliberate: we never silently downgrade a URL the user typed. To
 * reach a plaintext pool, type the scheme: `http://localhost:3000`.
 */
export function canonicalisePoolUrl(raw: string): CanonResult {
  const v = raw.trim();
  if (v === '') return { ok: false, reason: 'a pool URL is required' };
  if (CONTROL_RE.test(v)) return { ok: false, reason: 'contains control characters' };
  if (/\s/.test(v)) return { ok: false, reason: 'contains spaces' };

  const hadScheme = SCHEME_RE.test(v);
  const candidate = hadScheme ? v : `https://${v}`;

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'only http:// and https:// pool URLs are supported' };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, reason: 'a pool URL must not contain a username or password' };
  }
  if (u.hostname === '') return { ok: false, reason: 'missing host' };

  if (!hadScheme && !looksLikeHost(u.hostname, u.port)) {
    return {
      ok: false,
      reason: SOLOISH_RE.test(v)
        ? 'not a pool URL - did you mean solo? (MINER_POOL=solo mines on your own)'
        : 'not a pool URL - expected a host such as pool.example.org',
    };
  }

  // u.protocol and u.host are already lower-cased by the URL parser. Use u.host,
  // NEVER u.hostname: host keeps the port and the [] around an IPv6 literal. The
  // path keeps its case; query + fragment are dropped - a mining endpoint is a
  // base URL, not a request.
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

export type BuiltinPoolId = 'fulgurpool' | 'brcpool';

export interface BuiltinPool {
  id: BuiltinPoolId;
  name: string;
  /** Canonical mining endpoint: canonicalisePoolUrl(url) === url (pinned by test). */
  url: string;
  /** Website, rendered as an OSC 8 link. Only for origins we have checked. */
  page?: string;
  /** FulgurPool only: poll GET /jackpot and render the jackpot panel. */
  jackpot: boolean;
  /** WHAT THE POOL IS. Never what you will earn - no fee/variance/income copy. */
  description: string;
}

/**
 * The pools that ship with the miner, in picker order. Solo is NOT here: it is not
 * a pool. targets.ts owns the Solo row and its description.
 */
export const BUILTIN_POOLS: readonly BuiltinPool[] = [
  {
    id: 'fulgurpool',
    name: 'FulgurPool',
    url: 'https://pool.fulgurpool.xyz',
    page: 'https://fulgurpool.xyz',
    jackpot: true,
    description: "the project's own pool",
  },
  {
    id: 'brcpool',
    name: 'brcpool',
    url: 'https://brcpool.cryptec.tech',
    page: 'https://brcpool.cryptec.tech',
    jackpot: false,
    description: 'community pool',
  },
];

/**
 * Origins that ARE FulgurPool but are not offered in the picker. FULGURPOOL_URL was
 * https://fulgurpool-core.onrender.com until 2026-06-27 (the same Render backend,
 * now behind a Cloudflare CNAME) and miners - including our own fleet scripts - are
 * still pointed at it, so it must keep its identity: the label and the jackpot.
 * Identity ONLY: an alias is never offered in a picker, and persistTarget always
 * writes the canonical URL. Never alias an http:// origin - a plaintext origin must
 * not be able to paint the project's branded panel.
 */
export const FULGURPOOL_ALIASES: readonly string[] = ['https://fulgurpool-core.onrender.com'];

/**
 * The single pool-identity predicate: exact canonical-URL equality against
 * BUILTIN_POOLS (plus FULGURPOOL_ALIASES). NEVER a label - pools.json reserves no
 * names today, so a custom entry may legally be NAMED "FulgurPool".
 */
export function builtinByUrl(url: string): BuiltinPool | undefined {
  const c = canonicalisePoolUrl(url);
  if (!c.ok) return undefined;
  const hit = BUILTIN_POOLS.find((p) => p.url === c.url);
  if (hit) return hit;
  if (FULGURPOOL_ALIASES.includes(c.url)) return BUILTIN_POOLS.find((p) => p.id === 'fulgurpool');
  return undefined;
}

/** The jackpot gate. Fails closed: only a real FulgurPool origin gets the panel. */
export function isFulgurPool(url: string): boolean {
  return builtinByUrl(url)?.id === 'fulgurpool';
}

/**
 * Where the user has told us to mine. Four states, and 'unset' is a real one: an
 * absent MINER_POOL means NEVER ASKED - it is not a pool and it is not solo, and no
 * entry point may infer a destination from it.
 */
export type PoolChoice =
  | { kind: 'unset' }
  | { kind: 'solo' }
  | { kind: 'pool'; url: string; builtin?: BuiltinPoolId }
  | { kind: 'invalid'; raw: string; reason: string };

/** MINER_POOL values meaning "mine on my own". off/none are legacy spellings we still read. */
const SOLO_RE = /^(solo|off|none)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE_G = /[\x00-\x1f\x7f]/g;

/**
 * Strip control characters before ANY terminal render. A raw MINER_POOL value is
 * echoed back at the user (the refusal message, the invalid-target row) and a pool
 * URL is rendered as an OSC 8 hyperlink - a stray BEL/ESC would terminate the escape
 * early and corrupt the line. Everything user-supplied goes through here on the way out.
 */
export function sanitiseForDisplay(raw: string): string {
  return raw.replace(CONTROL_RE_G, '');
}

/**
 * Decode MINER_POOL. PURE - no fs, no pools.json, never throws. The ONE decoder:
 * every UI and every entry point reads the union it returns.
 */
export function decodePoolChoice(raw: string | undefined): PoolChoice {
  const v = (raw ?? '').trim();
  if (v === '') return { kind: 'unset' };
  if (SOLO_RE.test(v)) return { kind: 'solo' };
  const c = canonicalisePoolUrl(v);
  if (!c.ok) return { kind: 'invalid', raw: v, reason: c.reason };
  const b = builtinByUrl(c.url);
  return b ? { kind: 'pool', url: c.url, builtin: b.id } : { kind: 'pool', url: c.url };
}
