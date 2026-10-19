import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B58, LEAD, MAX_PATTERN, FIRST_CHAR_SET, FIRST_CHAR_PROB, WORST_FIRST_FACTOR,
  validatePattern, variantsForChar, expectedAttempts,
  probFoundBy, attemptsForQuantile, medianAttempts,
  expectedSeconds, fmtInt, fmtDuration, difficultyLadder,
  addressMatches, SS58_189_RE, sanitizeVault, sanitizeBench,
  vaultRoom, MAX_VAULT_RECORDS, plausibleRate, MAX_PLAUSIBLE_RATE,
} from '../js/vanity.js';

test('base58 alphabet has 58 chars and excludes 0/O/I/l', () => {
  assert.equal(B58.length, 58);
  for (const bad of ['0', 'O', 'I', 'l']) assert.ok(!B58.includes(bad), bad);
});

test('lead is qz', () => assert.equal(LEAD, 'qz'));

test('pinned first character: exact 7-symbol set, probs sum to 1', () => {
  assert.equal(FIRST_CHAR_SET, 'jkmnopq');
  const sum = Object.values(FIRST_CHAR_PROB).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-5, sum);
  assert.ok(Math.abs(WORST_FIRST_FACTOR - 1 / 0.041395) < 1e-9);
});

test('validatePattern: happy path', () => {
  const r = validatePattern('mSHT', 'prefix');
  assert.ok(r.ok); assert.equal(r.pattern, 'mSHT'); assert.equal(r.leadNote, false);
});

test('validatePattern: strips automatic qz lead', () => {
  const r = validatePattern('qzmSHT', 'prefix');
  assert.ok(r.ok); assert.equal(r.pattern, 'mSHT'); assert.equal(r.leadNote, true);
});

test('validatePattern: rejects empty, bad chars, too long', () => {
  assert.ok(!validatePattern('', 'prefix').ok);
  assert.ok(!validatePattern('   ', 'prefix').ok);
  assert.ok(!validatePattern('mB0', 'prefix').ok); // 0 not in base58
  assert.ok(!validatePattern('mBCDEF7', 'prefix').ok); // 7 chars
  assert.ok(validatePattern('mBCDEF', 'prefix').ok); // exactly 6 ok
});

test('validatePattern: rejects impossible pinned first char (prefix only)', () => {
  const bad = validatePattern('AX', 'prefix'); // 'a' not in jkmnopq
  assert.ok(!bad.ok);
  assert.ok(bad.error.includes('pins that position'), bad.error);
  // suffix mode has no pinned position
  assert.ok(validatePattern('AX', 'suffix').ok);
  assert.ok(validatePattern('A0', 'suffix').ok === false); // 0 still not base58
});

test('validatePattern: the pinned position is case-aware', () => {
  // Case-sensitive (the page default): position 3 is ALWAYS lowercase
  // j/k/m/n/o/p/q, so an uppercase twin can never match — grinding for it
  // would run forever. It must be rejected, not folded.
  const cs = validatePattern('K5', 'prefix', true);
  assert.ok(!cs.ok);
  assert.ok(/case-sensitive/i.test(cs.error), cs.error);
  assert.ok(!validatePattern('KNET', 'prefix', true).ok);
  assert.ok(!validatePattern('Q', 'prefix', true).ok);
  assert.ok(validatePattern('k5', 'prefix', true).ok);
  assert.ok(validatePattern('mSHT', 'prefix', true).ok); // only char 1 is pinned
  // Case-insensitive: 'K' folds to 'k', which IS in the set — accepted.
  assert.ok(validatePattern('K5', 'prefix', false).ok);
  assert.ok(validatePattern('KNET', 'prefix', false).ok);
  // Suffix mode has no pinned position in either case mode.
  assert.ok(validatePattern('K5', 'suffix', true).ok);
});

test('variantsForChar: case-sensitive always 1', () => {
  assert.equal(variantsForChar('A', true), 1);
  assert.equal(variantsForChar('5', true), 1);
});

test('variantsForChar: case-insensitive letters 2, digits 1', () => {
  assert.equal(variantsForChar('A', false), 2);
  assert.equal(variantsForChar('z', false), 2);
  assert.equal(variantsForChar('5', false), 1);
  assert.equal(variantsForChar('1', false), 1);
});

test('expectedAttempts prefix: pinned first char × 58^(k-1)', () => {
  const P = { caseSensitive: true, position: 'prefix' };
  assert.ok(Math.abs(expectedAttempts('m', P) - 1 / 0.172794) < 1e-9);
  assert.ok(Math.abs(expectedAttempts('k5', P) - (1 / 0.172794) * 58) < 1e-9);
  assert.ok(Math.abs(expectedAttempts('q', P) - WORST_FIRST_FACTOR) < 1e-9);
  // case-insensitive: first char folds to the same probability
  const I = { caseSensitive: false, position: 'prefix' };
  assert.ok(Math.abs(expectedAttempts('K', I) - 1 / 0.172794) < 1e-9);
  assert.ok(Math.abs(expectedAttempts('K5', I) - (1 / 0.172794) * 58) < 1e-9); // digit 58
  assert.ok(Math.abs(expectedAttempts('Ka', I) - (1 / 0.172794) * 29) < 1e-9); // letter folds: 29
  // case-sensitive uppercase at the pinned position: probability exactly 0
  assert.equal(expectedAttempts('K', P), Infinity);
  assert.equal(expectedAttempts('KNET', P), Infinity);
});

test('expectedAttempts suffix: 58^k (approximate, checksum-coupled)', () => {
  const S = { caseSensitive: true, position: 'suffix' };
  assert.equal(expectedAttempts('A', S), 58);
  assert.equal(expectedAttempts('AB', S), 58 * 58);
  const SI = { caseSensitive: false, position: 'suffix' };
  assert.equal(expectedAttempts('A5', SI), 29 * 58);
});

test('probFoundBy: ~63.2% at n = expected (1 - 1/e)', () => {
  const p = probFoundBy(5800, 5800);
  assert.ok(Math.abs(p - (1 - 1 / Math.E)) < 1e-3, p);
  assert.equal(probFoundBy(0, 5800), 0);
  assert.ok(probFoundBy(1e12, 58) > 0.999999);
});

test('median is ln2 * expected', () => {
  const m = medianAttempts(100000);
  assert.ok(Math.abs(m - 100000 * Math.LN2) < 1, m);
});

test('attemptsForQuantile: 90th percentile', () => {
  const q90 = attemptsForQuantile(0.9, 1000);
  assert.ok(Math.abs(probFoundBy(q90, 1000) - 0.9) < 1e-9);
});

test('expectedSeconds: Infinity at zero rate', () => {
  assert.equal(expectedSeconds(1000, 0), Infinity);
  assert.equal(expectedSeconds(1000, 50), 20);
});

test('expectedSeconds: a non-finite rate is refused, never a 0-second ETA', () => {
  // !(x > 0) passes Infinity: expected/Infinity collapsed to 0 and
  // fmtDuration painted "< 1 second" for multi-year grinds.
  assert.equal(expectedSeconds(1000, Infinity), Infinity);
  assert.equal(expectedSeconds(1000, -Infinity), Infinity);
  assert.equal(expectedSeconds(1000, NaN), Infinity);
  assert.equal(expectedSeconds(Infinity, Infinity), Infinity); // never NaN
  assert.equal(expectedSeconds(Infinity, 50), Infinity); // impossible pattern stays unknown
  const rows = difficultyLadder(Infinity);
  assert.ok(rows.every((r) => r.seconds === Infinity));
  assert.equal(fmtDuration(rows[5].seconds), '—');
});

test('plausibleRate: only finite in-cap measured rates are quotable', () => {
  assert.equal(plausibleRate(42.5), 42.5);
  assert.equal(plausibleRate(MAX_PLAUSIBLE_RATE), MAX_PLAUSIBLE_RATE);
  assert.equal(plausibleRate(Infinity), null); // 0 ms benchmark timer
  assert.equal(plausibleRate(NaN), null);
  assert.equal(plausibleRate(0), null);
  assert.equal(plausibleRate(-3), null);
  assert.equal(plausibleRate(MAX_PLAUSIBLE_RATE + 1), null);
  assert.equal(plausibleRate('fast'), null);
});

test('fmtDuration bands', () => {
  assert.equal(fmtDuration(0.2), '< 1 second');
  assert.equal(fmtDuration(45), '45 seconds');
  assert.equal(fmtDuration(600), '10 minutes');
  assert.equal(fmtDuration(5400), '1.5 hours');
  assert.equal(fmtDuration(90000), '25 hours');
  assert.equal(fmtDuration(864000), '10 days');
  assert.equal(fmtDuration(1e8), '3.2 years');
  assert.equal(fmtDuration(Infinity), '—');
});

test('fmtInt', () => {
  assert.equal(fmtInt(3364), '3,364');
  assert.equal(fmtInt(Infinity), '—');
});

test('difficultyLadder: 6 rows, worst-first-char × 58^(k-1)', () => {
  const rows = difficultyLadder(100);
  assert.equal(rows.length, MAX_PATTERN);
  assert.ok(Math.abs(rows[0].expected - WORST_FIRST_FACTOR) < 1e-9);
  assert.ok(Math.abs(rows[2].expected - WORST_FIRST_FACTOR * 58 * 58) < 1e-6);
  assert.ok(Math.abs(rows[5].expected - WORST_FIRST_FACTOR * 58 ** 5) < 1e-3);
  assert.ok(Math.abs(rows[2].median - rows[2].expected * Math.LN2) < 1);
  assert.ok(Math.abs(rows[0].seconds - WORST_FIRST_FACTOR / 100) < 1e-9);
});

test('addressMatches: prefix mode', () => {
  const addr = 'qzKSHOTabc123xyz';
  assert.ok(addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(!addressMatches(addr, 'kshot', { caseSensitive: true, position: 'prefix' }));
  assert.ok(addressMatches(addr, 'kshot', { caseSensitive: false, position: 'prefix' }));
  assert.ok(!addressMatches(addr, 'SHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(!addressMatches('abKSHOTxx', 'KSHOT', { caseSensitive: true, position: 'prefix' }));
});

test('SS58_189_RE: qz + 47 base58, fleet-shaped addresses only', () => {
  assert.ok(SS58_189_RE.test('qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv'));
  assert.ok(SS58_189_RE.test('qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau'));
  assert.ok(!SS58_189_RE.test('qzshort'));
  assert.ok(!SS58_189_RE.test('qz0sbEcAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv')); // 0 not base58
});

/* Producer-exact fixture: pattern 'msb' case-insensitively matches the
 * address after the qz lead, and the secret is a full ML-DSA-65 secret
 * key hex-encoded (4032 bytes -> 8064 chars) — the old 4-char 'abcd'
 * fixture was a secret no forge run could ever have written. */
const GOOD_REC = {
  address: 'qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv',
  scheme: '65', pattern: 'msb', caseSensitive: false, position: 'prefix',
  attempts: 1234, ms: 5678, date: '2026-10-01T00:00:00.000Z', secretHex: 'ab'.repeat(4032),
};

test('sanitizeVault: well-formed records survive, poison is dropped', () => {
  assert.equal(sanitizeVault([GOOD_REC]).length, 1);
  assert.equal(sanitizeVault('junk').length, 0);
  assert.equal(sanitizeVault(null).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, scheme: '99' }]).length, 0); // was a boot crash
  assert.equal(sanitizeVault([{ ...GOOD_REC, address: '<img src=x>' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, pattern: '<b>x</b>' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, attempts: -1 }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, date: 'whenever' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, secretHex: 'zz' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, secretHex: null }]).length, 1);
  assert.equal(sanitizeVault([GOOD_REC, null, 42, GOOD_REC]).length, 1); // dup address: first wins
  assert.ok(sanitizeVault(Array.from({ length: 500 }, () => GOOD_REC)).length <= 200);
});

test('sanitizeVault relations: a record must be a find the forge could have written', () => {
  const NOW = Date.parse('2026-10-13T12:00:00.000Z');
  const n = (recs, opts) => sanitizeVault(recs, { nowMs: NOW, ...opts }).length;
  // The address must actually match the pattern it claims (onFound only
  // fires when addressMatches passes).
  assert.equal(n([{ ...GOOD_REC, address: 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau' }]), 0);
  assert.equal(n([{ ...GOOD_REC, position: 'suffix' }]), 0); // address does not END with msb
  // The pattern must be one the forge itself would run, in stored
  // (normalized) form: impossible pinned char, case-sensitive uppercase
  // pinned char, and an unstripped leading qz are all non-producer.
  assert.equal(n([{ ...GOOD_REC, pattern: 'asb' }]), 0);
  assert.equal(n([{ ...GOOD_REC, pattern: 'Msb', caseSensitive: true }]), 0);
  assert.equal(n([{ ...GOOD_REC, pattern: 'qzmsb' }]), 0);
  // Dates are Date.now() at find time: chain-era window only.
  assert.equal(n([{ ...GOOD_REC, date: '2020-06-01T00:00:00.000Z' }]), 0);
  assert.equal(n([{ ...GOOD_REC, date: '2999-01-01T00:00:00.000Z' }]), 0);
  assert.equal(n([{ ...GOOD_REC, date: '2026-10-13T11:59:00.000Z' }]), 1);
  // Secret length is pinned by scheme (ML-DSA-65 4032 B, ML-DSA-87 4896 B).
  assert.equal(n([{ ...GOOD_REC, secretHex: 'abcd' }]), 0);
  assert.equal(n([{ ...GOOD_REC, scheme: '87' }]), 0); // 65-length secret on an 87 record
  assert.equal(n([{ ...GOOD_REC, scheme: '87', secretHex: 'cd'.repeat(4896) }]), 1);
  // attempts/ms may not imply a grind rate above the bench plausibility cap.
  assert.equal(n([{ ...GOOD_REC, attempts: 1e9, ms: 5 }]), 0);
  assert.equal(n([{ ...GOOD_REC, attempts: 3, ms: 0 }]), 1);
  // The app-supplied full decoder gates bad-checksum shape-valid strings.
  assert.equal(n([GOOD_REC], { validateAddress: () => false }), 0);
  assert.equal(n([GOOD_REC], { validateAddress: () => true }), 1);
});

test('sanitizeBench: only plausible measured rates survive', () => {
  assert.equal(sanitizeBench({ '65': 42.5 })['65'], 42.5);
  assert.equal(sanitizeBench({ '65': 1e15 })['65'], undefined);
  assert.equal(sanitizeBench({ '65': 'fast' })['65'], undefined);
  assert.equal(sanitizeBench({ '65': -3 })['65'], undefined);
  assert.deepEqual(sanitizeBench('junk'), {});
  assert.equal(sanitizeBench({ '87': 12, evil: 5 }).evil, undefined);
});

test('vaultRoom: creation gate arithmetic, fail-closed (onFound must not unshift past the load cap)', () => {
  assert.equal(MAX_VAULT_RECORDS, 200);
  assert.equal(vaultRoom(0), 200);
  assert.equal(vaultRoom(199), 1);
  assert.equal(vaultRoom(199.9), 1); // floored
  assert.equal(vaultRoom(200), 0);
  assert.equal(vaultRoom(5000), 0); // never negative
  assert.equal(vaultRoom(NaN), 0);
  assert.equal(vaultRoom('x'), 0);
  assert.equal(vaultRoom(-3), 0); // fail closed on garbage
});

test('addressMatches: suffix mode', () => {
  const addr = 'qzabc123KSHOT';
  assert.ok(addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'suffix' }));
  assert.ok(!addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(addressMatches(addr, 'kshot', { caseSensitive: false, position: 'suffix' }));
});
