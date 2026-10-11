/* QTC Web Wallet — offline logic tests. Run: node tests/run-tests.mjs
 * Covers: xxhash vectors, SCALE compact, era codec, mnemonic (BIP-39 vectors),
 * key derivation determinism, sign/verify with the chain context, extrinsic
 * assembly, account-info decoding, unit conversions. Live RPC checks live in
 * tests/live-rpc-check.mjs (needs network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { xxh64, xxhash128, storageKey } from '../js/xxhash.js';
import {
  concat, u32le, compactEncode, compactDecode, encodeMortalEra, eraBirth,
  buildTransferCall, buildSigningPayload, buildExtrinsic,
  decodeAccountInfo, plancksToQtc, qtcToPlancks,
  BALANCES_PALLET_INDEX, TRANSFER_KEEP_ALIVE_CALL_INDEX,
} from '../js/scale.js';
import {
  setWordlistForTests, entropyToMnemonic, validateMnemonic, mnemonicToSeed,
  keypairFromSeed, keypairFromMnemonic, loadWordlist, embeddedWordlist,
} from '../js/mnemonic.js';
import { readFileSync } from 'node:fs';

test('wordlist: embedded list is the authentic 2048-word BIP-39 English list', () => {
  const emb = embeddedWordlist();
  assert.equal(emb.length, 2048);
  assert.equal(new Set(emb).size, 2048, 'words must be unique');
  assert.equal(emb[0], 'abandon');
  assert.equal(emb[2047], 'zoo');
  const file = readFileSync(new URL('../vendor/bip39-english.txt', import.meta.url), 'utf8')
    .trim().split('\n').map((w) => w.trim());
  assert.deepEqual(emb, file, 'embedded list must be byte-identical to vendor/bip39-english.txt');
  // loadWordlist resolves to the same list with no network
  return loadWordlist().then((w) => assert.deepEqual(w, emb));
});
import { ss58Decode, hexDecode } from '../js/quantus-crypto.js';
import { ml_dsa65 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';

/* BIP-39 English wordlist stand-in: unique filler words (indexOf must resolve
 * to the right index) plus the real words needed by the fixed vectors. */
const MINI_WORDS = (() => {
  const w = new Array(2048);
  for (let i = 0; i < 2048; i++) w[i] = 'word' + i;
  w[0] = 'abandon'; w[3] = 'about'; w[1027] = 'legal'; w[2047] = 'zoo';
  w[1093] = 'winner';
  return w;
})();

test('xxh64: published test vectors', () => {
  const enc = new TextEncoder();
  assert.equal(xxh64(enc.encode(''), 0n), 0xEF46DB3751D8E999n);
  assert.equal(xxh64(enc.encode('abc'), 0n), 0x44BC2CF5AD770999n);
  // seed sensitivity + determinism (no invented magic numbers)
  const s1 = xxh64(enc.encode('abc'), 0x9E3779B97F4A7C15n);
  assert.equal(s1, xxh64(enc.encode('abc'), 0x9E3779B97F4A7C15n));
  assert.notEqual(s1, xxh64(enc.encode('abc'), 0n));
  // long-input path (>= 32 bytes) determinism
  const long = enc.encode('abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(xxh64(long, 0n), xxh64(long, 0n));
});

test('xxhash128: 16 bytes, deterministic', () => {
  const a = xxhash128(new TextEncoder().encode('System'));
  const b = xxhash128(new TextEncoder().encode('System'));
  assert.equal(a.length, 16);
  assert.deepEqual(a, b);
});

test('xxhash128: canonical Substrate vector (chain-verified 2026-09-30)', () => {
  // twox_128("System") as the Quantus chain computes it: XxHash64 seeds 0 and 1.
  // Verified against sp-crypto-hashing 0.1.0 (behind the chain's sp-core 39.0.0),
  // Quantus-Network/chain frame/support/src/hash.rs, and @polkadot/util-crypto.
  const got = Buffer.from(xxhash128(new TextEncoder().encode('System'))).toString('hex');
  assert.equal(got, '26aa394eea5630e07c48ae0c9558cef7');
});

test('storageKey: layout = xxh128(pallet) ++ xxh128(storage) ++ blake2_128(key) ++ key', () => {
  const key = new Uint8Array(32).fill(9);
  const sk = storageKey('System', 'Account', key);
  assert.equal(sk.length, 32 + 16 + 32);
  assert.deepEqual(sk.slice(48), key);
});

test('compact: boundary round-trips', () => {
  for (const v of [0n, 1n, 63n, 64n, 16383n, 16384n, 1073741823n, 1073741824n, 2n ** 64n, 2n ** 128n - 1n]) {
    const enc = compactEncode(v);
    const { value, next } = compactDecode(enc);
    assert.equal(value, v, `round-trip ${v}`);
    assert.equal(next, enc.length);
  }
  // known encodings
  assert.deepEqual(compactEncode(0n), Uint8Array.of(0x00));
  assert.deepEqual(compactEncode(63n), Uint8Array.of(0xfc));
  assert.deepEqual(compactEncode(64n), Uint8Array.of(0x01, 0x01));
});

test('era: mortal encode + birth', () => {
  const e = encodeMortalEra(64, 5);
  assert.deepEqual(e, Uint8Array.of(0x55, 0x00)); // 5 | (5<<4), LE u16
  assert.equal(eraBirth(100, 64, 36), 100);
  assert.equal(eraBirth(100, 64, 40), 40);
  assert.equal(eraBirth(64, 64, 0), 64);
});

test('mnemonic: real list — zero entropy -> 23x abandon + checksum word; round-trip', async () => {
  await loadWordlist(); // real embedded list, no fixture
  const emb = embeddedWordlist();
  const m = entropyToMnemonic(new Uint8Array(32));
  const words = m.split(' ');
  assert.equal(words.length, 24);
  assert.ok(words.slice(0, 23).every((w) => w === 'abandon'));
  assert.equal(words[23], emb[0b00001100110]); // checksum bits of sha256(zeros32)[0]=0x66
  const v = validateMnemonic(m);
  assert.ok(v.ok);
  assert.deepEqual(v.entropy, new Uint8Array(32));
  // every word is a real BIP-39 word
  assert.ok(words.every((w) => emb.includes(w)));
});

test('mnemonic: fixture-based zero-entropy vector (kept for determinism docs)', () => {
  setWordlistForTests(MINI_WORDS);
  const m = entropyToMnemonic(new Uint8Array(32));
  const words = m.split(' ');
  assert.equal(words.length, 24);
  assert.ok(words.slice(0, 23).every((w) => w === 'abandon'));
  // checksum = first 8 bits of sha256(zeros32) = 0x66 -> last index 0b00001100110
  assert.equal(words[23], MINI_WORDS[0b00001100110]);
  const v = validateMnemonic(m);
  assert.ok(v.ok);
  assert.deepEqual(v.entropy, new Uint8Array(32));
});

test('mnemonic: checksum tamper is rejected', () => {
  setWordlistForTests(MINI_WORDS);
  const bad = ('abandon '.repeat(23) + 'zoo').trim();
  const v = validateMnemonic(bad);
  assert.ok(!v.ok, 'tampered checksum must fail');
});

test('mnemonic: unknown word rejected', () => {
  setWordlistForTests(MINI_WORDS);
  const v = validateMnemonic(('abandon '.repeat(23) + 'nope').trim());
  assert.ok(!v.ok);
});

test('mnemonicToSeed: deterministic, 64 bytes', () => {
  setWordlistForTests(MINI_WORDS);
  const m = entropyToMnemonic(new Uint8Array(32).fill(1));
  const s1 = mnemonicToSeed(m);
  const s2 = mnemonicToSeed(m);
  assert.equal(s1.length, 64);
  assert.deepEqual(s1, s2);
});

test('keypair: deterministic from mnemonic; address is SS58-189', async () => {
  setWordlistForTests(embeddedWordlist()); // reset: earlier fixture test overrides WORDLIST
  const m = entropyToMnemonic(new Uint8Array(32).fill(2));
  assert.ok(m.split(' ').every((w) => embeddedWordlist().includes(w)), 'real BIP-39 words');
  const a = keypairFromMnemonic(m, '', 65);
  const b = keypairFromMnemonic(m, '', 65);
  assert.equal(a.address, b.address);
  assert.ok(a.address.startsWith('qz'), 'SS58-189 addresses start with qz, got ' + a.address);
  const { prefix, accountId } = ss58Decode(a.address);
  assert.equal(prefix, 189);
  assert.deepEqual(accountId, a.accountId); // checksum round-trip
  // different mnemonic -> different address
  const c = keypairFromMnemonic(entropyToMnemonic(new Uint8Array(32).fill(3)), '', 65);
  assert.notEqual(a.address, c.address);
});

test('parseRecipient: enforces prefix 189, rejects bad checksum', async () => {
  const { parseRecipient } = await import('../js/rpc.js');
  await loadWordlist();
  const a = keypairFromMnemonic(entropyToMnemonic(new Uint8Array(32).fill(4)), '', 65);
  assert.deepEqual(parseRecipient(a.address), a.accountId);
  // tampered address -> checksum error
  const bad = a.address.slice(0, -1) + (a.address.endsWith('1') ? '2' : '1');
  assert.throws(() => parseRecipient(bad), /checksum/);
  // valid checksum but wrong prefix (e.g. generic Substrate 42) -> rejected
  const { ss58Encode } = await import('../js/quantus-crypto.js');
  const other = ss58Encode(a.accountId, 42);
  assert.throws(() => parseRecipient(other), /prefix/);
});

test('keypair: same seed -> same keys (FIPS-204 determinism)', () => {
  const seed = new Uint8Array(32).fill(42);
  const a = keypairFromSeed(seed, 65);
  const b = keypairFromSeed(seed, 65);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.equal(a.publicKey.length, 1952);
  assert.equal(a.secretKey.length, 4032);
});

test('sign/verify: QUANTUS_EXTRINSIC context binds; plain context fails', () => {
  const kp = keypairFromSeed(new Uint8Array(32).fill(9), 65);
  const ctx = new TextEncoder().encode('QUANTUS_EXTRINSIC');
  const msg = new TextEncoder().encode('payload-bytes');
  const sig = ml_dsa65.sign(msg, kp.secretKey, { context: ctx });
  assert.equal(sig.length, 3309);
  assert.ok(ml_dsa65.verify(sig, msg, kp.publicKey, { context: ctx }));
  assert.ok(!ml_dsa65.verify(sig, msg, kp.publicKey), 'no-context verify must fail');
  assert.ok(!ml_dsa65.verify(sig, new TextEncoder().encode('other'), kp.publicKey, { context: ctx }));
});

test('buildTransferCall: pallet 2, call 3, MultiAddress::Id, compact amount', () => {
  const dest = new Uint8Array(32).fill(7);
  const call = buildTransferCall(dest, 1500000000000n);
  assert.equal(call[0], BALANCES_PALLET_INDEX);
  assert.equal(call[1], TRANSFER_KEEP_ALIVE_CALL_INDEX);
  assert.equal(call[2], 0x00); // MultiAddress::Id
  assert.deepEqual(call.slice(3, 35), dest);
  const { value } = compactDecode(call, 35);
  assert.equal(value, 1500000000000n);
});

test('buildSigningPayload: exact field layout', () => {
  const call = buildTransferCall(new Uint8Array(32).fill(7), 1000n);
  const era = encodeMortalEra(64, 5);
  const p = buildSigningPayload({
    call, era, nonce: 3, tip: 0n,
    specVersion: 153, txVersion: 6,
    genesisHash: new Uint8Array(32).fill(0xaa),
    eraBirthHash: new Uint8Array(32).fill(0xbb),
  });
  let o = 0;
  assert.deepEqual(p.slice(0, call.length), call); o += call.length;
  assert.deepEqual(p.slice(o, o + 2), era); o += 2;
  const n = compactDecode(p, o); assert.equal(n.value, 3n); o = n.next;
  const t = compactDecode(p, o); assert.equal(t.value, 0n); o = t.next;
  assert.equal(p[o], 0x00, 'metadata-hash mode disabled'); o += 1;
  assert.equal(new DataView(p.buffer, p.byteOffset + o, 4).getUint32(0, true), 153); o += 4;
  assert.equal(new DataView(p.buffer, p.byteOffset + o, 4).getUint32(0, true), 6); o += 4;
  assert.deepEqual(p.slice(o, o + 32), new Uint8Array(32).fill(0xaa)); o += 32;
  assert.deepEqual(p.slice(o, o + 32), new Uint8Array(32).fill(0xbb)); o += 32;
  assert.equal(o, p.length);
  assert.ok(p.length < 256, 'transfer payload must stay under the 256-byte hash threshold');
});

test('buildExtrinsic: 0x84, length prefix, variant byte, total layout', () => {
  const accountId = new Uint8Array(32).fill(1);
  const call = buildTransferCall(new Uint8Array(32).fill(7), 1000n);
  const sigWire = new Uint8Array(1 + 3309 + 1952).fill(0xcc);
  sigWire[0] = 1; // Dilithium65 variant
  const xt = buildExtrinsic({
    accountId, signatureWire: sigWire,
    era: encodeMortalEra(64, 5), nonce: 0, tip: 0n, call,
  });
  const { value: bodyLen, next } = compactDecode(xt, 0);
  assert.equal(Number(bodyLen), xt.length - next);
  const body = xt.slice(next);
  assert.equal(body[0], 0x84);
  assert.equal(body[1], 0x00); // MultiAddress::Id
  assert.deepEqual(body.slice(2, 34), accountId);
  assert.equal(body[34], 1, 'DilithiumSignatureScheme::Dilithium65 = variant 1');
  assert.equal(body.length, 1 + 1 + 32 + sigWire.length + 2 + 1 + 1 + 1 + call.length);
});

test('decodeAccountInfo: field layout', () => {
  const buf = new Uint8Array(4 * 4 + 16 * 3 + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 7, true);          // nonce
  dv.setUint32(4, 0, true);          // consumers
  dv.setUint32(8, 1, true);          // providers
  dv.setUint32(12, 0, true);         // sufficients
  dv.setBigUint64(16, 1234567890123n, true); // free lo
  dv.setBigUint64(24, 0n, true);             // free hi
  const info = decodeAccountInfo(buf);
  assert.equal(info.nonce, 7);
  assert.equal(info.free, 1234567890123n);
  assert.equal(info.reserved, 0n);
});

test('units: plancks <-> QTC', () => {
  assert.equal(plancksToQtc(1000000000000n), '1');
  assert.equal(plancksToQtc(1500000000000n), '1.5');
  assert.equal(plancksToQtc(1000000000n), '0.001');
  assert.equal(qtcToPlancks('1.5'), 1500000000000n);
  assert.equal(qtcToPlancks('0.001'), 1000000000n);
  assert.throws(() => qtcToPlancks('abc'));
  assert.throws(() => qtcToPlancks('1.1234567890123')); // >12 decimals
});

test('u32le', () => {
  assert.deepEqual(u32le(153), Uint8Array.of(0x99, 0x00, 0x00, 0x00));
});

/* ---- RPC boundary: node answers are validated before they anchor a
 * balance, a signing payload, a fee quote, or a broadcast result ---- */
import {
  parseBlockNumber, isHash32, parseVersionNumber, parseNonce, parseFeeField, validStorageHex,
} from '../js/rpc-validate.js';
import {
  getRuntimeVersion, getGenesisHash, getLatestHeader, getAccountInfo, getNonce, submitExtrinsic,
} from '../js/rpc.js';
import { ss58Encode, hexEncode } from '../js/quantus-crypto.js';

test('rpc-validate: block numbers accept int/decimal/hex, reject garbage', () => {
  assert.equal(parseBlockNumber(7), 7);
  assert.equal(parseBlockNumber('42'), 42);
  assert.equal(parseBlockNumber('0x2fca4'), 195748);
  assert.equal(parseBlockNumber('0xZZ'), null);
  assert.equal(parseBlockNumber('garbage'), null);
  assert.equal(parseBlockNumber(1.5), null);
  assert.equal(parseBlockNumber(-1), null);
  assert.equal(parseBlockNumber({}), null);
  assert.equal(parseBlockNumber(null), null);
});

test('rpc-validate: hashes are exactly 0x + 64 hex', () => {
  assert.ok(isHash32('0x' + 'aa'.repeat(32)));
  assert.ok(!isHash32('0x1234'));
  assert.ok(!isHash32('aa'.repeat(32)));
  assert.ok(!isHash32({}));
  assert.ok(!isHash32(null));
});

test('rpc-validate: versions and nonces are u32 (no float truncation, no negative wrap)', () => {
  assert.equal(parseVersionNumber(153), 153);
  assert.equal(parseVersionNumber(0xffffffff), 0xffffffff);
  assert.equal(parseVersionNumber(0x100000000), null);
  assert.equal(parseVersionNumber(153.5), null);
  assert.equal(parseVersionNumber(-1), null);
  assert.equal(parseNonce('abc'), null);
  assert.equal(parseNonce(7), 7);
});

test('rpc-validate: fee fields whitelist integer shapes (BigInt("-5") is a coercion, not validation)', () => {
  assert.equal(parseFeeField('100'), 100n);
  assert.equal(parseFeeField('0x10'), 16n);
  assert.equal(parseFeeField(42), 42n);
  assert.equal(parseFeeField(42n), 42n);
  assert.equal(parseFeeField('-5'), null);
  assert.equal(parseFeeField('1.5'), null);
  assert.equal(parseFeeField({}), null);
  assert.equal(parseFeeField(null), null);
});

test('rpc-validate: storage hex is 0x + even hex bytes', () => {
  assert.ok(validStorageHex('0x00ff'));
  assert.ok(!validStorageHex('0x0'));
  assert.ok(!validStorageHex('0xZZ'));
  assert.ok(!validStorageHex(42));
  assert.ok(!validStorageHex('00ff'));
});

const stubRpc = (answers) => ({
  call: async (method) => {
    if (method in answers) return answers[method];
    throw new Error('no stub for ' + method);
  },
});
const HH = '0x' + 'aa'.repeat(32);

test('rpc boundary: runtime version is normalized, poison rejected', async () => {
  const rt = await getRuntimeVersion(stubRpc({ state_getRuntimeVersion: { specName: 'quantus', specVersion: 153, transactionVersion: 6 } }));
  assert.deepEqual(rt, { specName: 'quantus', specVersion: 153, transactionVersion: 6 });
  await assert.rejects(() => getRuntimeVersion(stubRpc({ state_getRuntimeVersion: { specName: 'quantus', specVersion: 153.5, transactionVersion: 6 } })), /malformed runtime version/);
  await assert.rejects(() => getRuntimeVersion(stubRpc({ state_getRuntimeVersion: { specName: {}, specVersion: 153, transactionVersion: 6 } })), /malformed runtime version/);
});

test('rpc boundary: genesis + latest header require real hashes and heights', async () => {
  assert.equal(await getGenesisHash(stubRpc({ chain_getBlockHash: HH })), HH);
  await assert.rejects(() => getGenesisHash(stubRpc({ chain_getBlockHash: '0x1234' })), /malformed genesis hash/);
  const l = await getLatestHeader(stubRpc({ chain_getBlockHash: HH, chain_getHeader: { number: '0x2fca4' } }));
  assert.equal(l.number, 195748);
  await assert.rejects(() => getLatestHeader(stubRpc({ chain_getBlockHash: HH, chain_getHeader: null })), /malformed latest header/);
  await assert.rejects(() => getLatestHeader(stubRpc({ chain_getBlockHash: HH, chain_getHeader: { number: '0xZZ' } })), /malformed latest header/);
});

test('rpc boundary: account storage — null is not-on-chain, poison is malformed', async () => {
  const acct = new Uint8Array(32).fill(7);
  assert.equal(await getAccountInfo(stubRpc({ state_getStorage: null }), acct), null);
  await assert.rejects(() => getAccountInfo(stubRpc({ state_getStorage: 42 }), acct), /malformed account storage/);
  await assert.rejects(() => getAccountInfo(stubRpc({ state_getStorage: '0x' + '00'.repeat(10) }), acct), /malformed account storage/);
  const blob = new Uint8Array(68);
  new DataView(blob.buffer).setBigUint64(16, 5000n, true);
  const info = await getAccountInfo(stubRpc({ state_getStorage: '0x' + hexEncode(blob) }), acct);
  assert.equal(info.free, 5000n);
});

/* ---- Activity boundary round 2: indexer rows must be ABOUT this
 * wallet, between real SS58-189 addresses, at real heights, for
 * amounts the chain can hold (verified against live indexer data). */
import { validBlockHeight, sanitizeActivityRows, MAX_SUPPLY_PLANCKS } from '../js/rpc-validate.js';

const WALLET = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';
const SENTINEL = 'qzjUYyuN4L3HKmBPMxHvK2n8HYnaLZcQvLSQTgdwB2nQ1g2mc';
const OTHER = 'qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv';
const NOW = Date.parse('2026-10-11T04:30:00Z');
const aRow = (over = {}) => ({
  id: 'r1', from_id: SENTINEL, to_id: WALLET, amount: '300000000000',
  block_height: 203723, extrinsic_id: null, timestamp: '2026-10-11T04:20:31.721+00:00', ...over,
});

test('activity-validate: block heights are fleet-shaped (1..10M, canonical)', () => {
  assert.equal(validBlockHeight(203723), 203723);
  assert.equal(validBlockHeight('203723'), 203723);
  assert.equal(validBlockHeight(0), null);
  assert.equal(validBlockHeight(9007199254740991), null);
  assert.equal(validBlockHeight('0203723'), null);
  assert.equal(validBlockHeight(203723.5), null);
  assert.equal(validBlockHeight(true), null);
});

test('activity boundary: a live-shaped row passes, normalized', () => {
  const rows = sanitizeActivityRows([aRow()], WALLET, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, '300000000000');
  assert.equal(rows[0].block_height, 203723);
});

test('activity boundary: a stranger transfer is not this wallet history', () => {
  const rows = sanitizeActivityRows([aRow({ from_id: SENTINEL, to_id: OTHER })], WALLET, NOW);
  assert.equal(rows.length, 0);
});

test('activity boundary: non-SS58 and wrong-prefix endpoints drop', () => {
  assert.equal(sanitizeActivityRows([aRow({ from_id: 'garbage' })], WALLET, NOW).length, 0);
  const wrongPrefix = ss58Encode(new Uint8Array(32).fill(7), 42);
  assert.equal(sanitizeActivityRows([aRow({ from_id: wrongPrefix })], WALLET, NOW).length, 0);
});

test('activity boundary: absurd height and over-supply amount drop', () => {
  assert.equal(sanitizeActivityRows([aRow({ block_height: 9007199254740991 })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ amount: (MAX_SUPPLY_PLANCKS + 1n).toString() })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ amount: MAX_SUPPLY_PLANCKS.toString() })], WALLET, NOW).length, 1);
});

test('activity boundary: future and pre-genesis timestamps drop, missing is allowed', () => {
  assert.equal(sanitizeActivityRows([aRow({ timestamp: '2027-01-01T00:00:00Z' })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ timestamp: '2026-08-01T00:00:00Z' })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ timestamp: null })], WALLET, NOW).length, 1);
});

test('activity boundary: duplicate ids render once; ascending and over-limit payloads are malformed', () => {
  const dup = sanitizeActivityRows([aRow(), aRow({ block_height: 203722 })], WALLET, NOW);
  assert.equal(dup.length, 1);
  const asc = sanitizeActivityRows([aRow({ id: 'a', block_height: 203722 }), aRow({ id: 'b', block_height: 203723 })], WALLET, NOW);
  assert.equal(asc, null);
  const many = Array.from({ length: 26 }, (_, i) => aRow({ id: 'm' + i, block_height: 203723 - i }));
  assert.equal(sanitizeActivityRows(many, WALLET, NOW), null);
  assert.equal(sanitizeActivityRows('nope', WALLET, NOW), null);
});

test('rpc boundary: nonce and submit hash are validated', async () => {
  const addr = ss58Encode(new Uint8Array(32).fill(7), 189);
  assert.equal(await getNonce(stubRpc({ system_accountNextIndex: 7 }), addr), 7);
  await assert.rejects(() => getNonce(stubRpc({ system_accountNextIndex: 'abc' }), addr), /malformed nonce/);
  assert.equal(await submitExtrinsic(stubRpc({ author_submitExtrinsic: HH }), '0x84'), HH);
  await assert.rejects(() => submitExtrinsic(stubRpc({ author_submitExtrinsic: '0x1234' }), '0x84'), /malformed transaction hash/);
});
