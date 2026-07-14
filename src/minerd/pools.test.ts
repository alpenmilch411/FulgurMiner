import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_POOLS,
  FULGURPOOL_ALIASES,
  builtinByUrl,
  canonicalisePoolUrl,
  decodePoolChoice,
  isFulgurPool,
  sanitiseForDisplay,
} from './pools.js';

/** Unwrap a CanonResult that must have succeeded. */
function canon(raw: string): string {
  const r = canonicalisePoolUrl(raw);
  assert.equal(r.ok, true, `expected ${JSON.stringify(raw)} to canonicalise`);
  return r.ok ? r.url : '';
}

/** The reason a CanonResult failed (asserts that it DID fail). */
function reason(raw: string): string {
  const r = canonicalisePoolUrl(raw);
  assert.equal(r.ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
  return r.ok ? '' : r.reason;
}

test('canonicalisePoolUrl normalises scheme, case, trailing slash, query and fragment', () => {
  assert.equal(canon('https://pool.foo.org'), 'https://pool.foo.org');
  assert.equal(canon('  https://pool.foo.org  '), 'https://pool.foo.org');
  assert.equal(canon('HTTPS://Pool.FulgurPool.xyz/'), 'https://pool.fulgurpool.xyz');
  assert.equal(canon('https://pool.foo.org///'), 'https://pool.foo.org');
  assert.equal(canon('https://pool.foo.org/api/v2/'), 'https://pool.foo.org/api/v2');
  assert.equal(canon('https://pool.foo.org:8443/api'), 'https://pool.foo.org:8443/api');
  assert.equal(canon('https://pool.foo.org/api?x=1#frag'), 'https://pool.foo.org/api');
  assert.equal(canon('http://pool.foo.org'), 'http://pool.foo.org');
});

test('canonicalisePoolUrl is idempotent over the whole table', () => {
  const table = [
    'https://pool.foo.org',
    'HTTPS://Pool.FulgurPool.xyz/',
    'https://pool.foo.org/api/v2/',
    'https://pool.foo.org:8443/api?x=1#f',
    'pool.foo.org',
    'localhost:3000',
    '192.168.1.50:8080',
    '[::1]:3000',
    'http://pool.foo.org',
  ];
  for (const raw of table) {
    const once = canon(raw);
    assert.equal(canon(once), once, `not idempotent for ${JSON.stringify(raw)}`);
  }
});

test('a scheme-less URL gets https:// — a plaintext pool must be typed with http://', () => {
  assert.equal(canon('pool.foo.org'), 'https://pool.foo.org');
  assert.equal(canon('pool.foo.org/api/'), 'https://pool.foo.org/api');
  // LAN/loopback hosts are accepted because they carry a port (or are localhost),
  // and they get https:// like everything else. Pinned deliberately: we never
  // silently downgrade a URL the user typed. A plaintext LAN pool needs http://.
  assert.equal(canon('localhost:3000'), 'https://localhost:3000');
  assert.equal(canon('192.168.1.50:8080'), 'https://192.168.1.50:8080');
  assert.equal(canon('http://localhost:3000'), 'http://localhost:3000');
  // u.host (not u.hostname) keeps the brackets, so an IPv6 literal survives.
  assert.equal(canon('[::1]:3000'), 'https://[::1]:3000');
});

test('an explicit scheme allows a single-label intranet host; a scheme-less one does not', () => {
  assert.equal(canon('https://brcpool'), 'https://brcpool');
  assert.equal(reason('brcpool'), 'not a pool URL - expected a host such as pool.example.org');
});

test('canonicalisePoolUrl rejects control characters and spaces (the OSC 8 hole)', () => {
  assert.equal(reason('\x07evil'), 'contains control characters');
  assert.equal(reason('https://pool.foo.org/\x1b]8;;x'), 'contains control characters');
  assert.equal(reason('https://pool foo.org'), 'contains spaces');
});

test('canonicalisePoolUrl rejects a non-http(s) scheme, credentials, and an empty value', () => {
  assert.equal(reason('ftp://pool.foo.org'), 'only http:// and https:// pool URLs are supported');
  assert.equal(reason('file:///etc/passwd'), 'only http:// and https:// pool URLs are supported');
  assert.equal(reason('https://user:pass@pool.foo.org'), 'a pool URL must not contain a username or password');
  assert.equal(reason(''), 'a pool URL is required');
  assert.equal(reason('   '), 'a pool URL is required');
});

test("a typo'd solo is rejected with a did-you-mean, not turned into https://solo1", () => {
  const r = reason('solo1');
  assert.match(r, /did you mean solo\?/);
  assert.doesNotMatch(r, /https:\/\/solo1/);
});

test('BUILTIN_POOLS is FulgurPool then brcpool, and only FulgurPool has the jackpot', () => {
  assert.deepEqual(
    BUILTIN_POOLS.map((p) => [p.id, p.name, p.url, p.jackpot]),
    [
      ['fulgurpool', 'FulgurPool', 'https://pool.fulgurpool.xyz', true],
      ['brcpool', 'brcpool', 'https://brcpool.cryptec.tech', false],
    ],
  );
});

test('every built-in URL (and page, and alias) is already canonical', () => {
  for (const p of BUILTIN_POOLS) {
    assert.equal(canon(p.url), p.url, `${p.id}.url is not canonical`);
    if (p.page) assert.equal(canon(p.page), p.page, `${p.id}.page is not canonical`);
  }
  for (const a of FULGURPOOL_ALIASES) assert.equal(canon(a), a, `alias ${a} is not canonical`);
});

test('built-in descriptions say what the pool IS, never what you will earn', () => {
  for (const p of BUILTIN_POOLS) {
    assert.ok(p.description.length > 0, `${p.id} has no description`);
    assert.doesNotMatch(
      p.description,
      /fee|variance|earn|income|payout|profit|reward|%/i,
      `${p.id}'s description talks about money`,
    );
  }
});

test('builtinByUrl matches on the canonical URL, not on spelling', () => {
  assert.equal(builtinByUrl('https://pool.fulgurpool.xyz')?.id, 'fulgurpool');
  assert.equal(builtinByUrl('HTTPS://Pool.FulgurPool.xyz/')?.id, 'fulgurpool');
  assert.equal(builtinByUrl('pool.fulgurpool.xyz')?.id, 'fulgurpool');
  assert.equal(builtinByUrl('https://brcpool.cryptec.tech')?.id, 'brcpool');
  assert.equal(builtinByUrl('https://pool.foo.org'), undefined);
  assert.equal(builtinByUrl('nonsense'), undefined);
});

test('the legacy FulgurPool origin is an identity alias, but is not a picker entry', () => {
  assert.equal(builtinByUrl('https://fulgurpool-core.onrender.com')?.id, 'fulgurpool');
  assert.equal(isFulgurPool('https://fulgurpool-core.onrender.com'), true);
  assert.ok(!BUILTIN_POOLS.some((p) => FULGURPOOL_ALIASES.includes(p.url)));
});

test('isFulgurPool fails closed: a plaintext origin never paints the branded panel', () => {
  assert.equal(isFulgurPool('https://pool.fulgurpool.xyz'), true);
  assert.equal(isFulgurPool('http://pool.fulgurpool.xyz'), false);
  assert.equal(builtinByUrl('http://pool.fulgurpool.xyz'), undefined);
  assert.equal(isFulgurPool('https://brcpool.cryptec.tech'), false);
  assert.equal(isFulgurPool('https://pool.foo.org'), false);
  assert.equal(isFulgurPool(''), false);
});

test('decodePoolChoice: absent/blank means NEVER ASKED — not a pool, not solo', () => {
  assert.deepEqual(decodePoolChoice(undefined), { kind: 'unset' });
  assert.deepEqual(decodePoolChoice(''), { kind: 'unset' });
  assert.deepEqual(decodePoolChoice('   '), { kind: 'unset' });
});

test('decodePoolChoice: solo, and the legacy off/none spellings', () => {
  assert.deepEqual(decodePoolChoice('solo'), { kind: 'solo' });
  assert.deepEqual(decodePoolChoice('  Solo '), { kind: 'solo' });
  assert.deepEqual(decodePoolChoice('OFF'), { kind: 'solo' });
  assert.deepEqual(decodePoolChoice('none'), { kind: 'solo' });
});

test('decodePoolChoice: a pool URL carries its built-in id, a custom one does not', () => {
  assert.deepEqual(decodePoolChoice('https://pool.fulgurpool.xyz/'), {
    kind: 'pool',
    url: 'https://pool.fulgurpool.xyz',
    builtin: 'fulgurpool',
  });
  assert.deepEqual(decodePoolChoice('https://brcpool.cryptec.tech'), {
    kind: 'pool',
    url: 'https://brcpool.cryptec.tech',
    builtin: 'brcpool',
  });
  assert.deepEqual(decodePoolChoice('pool.foo.org'), {
    kind: 'pool',
    url: 'https://pool.foo.org',
  });
});

test('decodePoolChoice: unusable values are invalid + a reason, never a silent pool', () => {
  const bel = decodePoolChoice('\x07evil');
  assert.equal(bel.kind, 'invalid');
  assert.equal(bel.kind === 'invalid' && bel.raw, '\x07evil');
  assert.equal(bel.kind === 'invalid' && bel.reason, 'contains control characters');

  assert.equal(decodePoolChoice('ftp://x.org').kind, 'invalid');

  const typo = decodePoolChoice('solo1');
  assert.equal(typo.kind, 'invalid');
  assert.match(typo.kind === 'invalid' ? typo.reason : '', /did you mean solo\?/);
});

test('sanitiseForDisplay strips control chars so a raw value cannot inject an escape', () => {
  assert.equal(sanitiseForDisplay('\x07evil'), 'evil');
  assert.equal(sanitiseForDisplay('https://pool.foo.org'), 'https://pool.foo.org');
  // A BEL-terminated OSC 8 opener loses its ESC/BEL bytes: what remains is inert text.
  const osc8 = sanitiseForDisplay('\x1b]8;;http://x\x07click');
  assert.equal(osc8, ']8;;http://xclick');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(osc8, /[\x00-\x1f\x7f]/);
});
