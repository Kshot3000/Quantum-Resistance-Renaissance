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
  buildTransferCall, buildBatchAllCall, buildTransferWithServiceFee,
  computeServiceFee, feeBpsLabel, buildSigningPayload, buildExtrinsic,
  decodeAccountInfo, plancksToQtc, qtcToPlancks,
  BALANCES_PALLET_INDEX, TRANSFER_KEEP_ALIVE_CALL_INDEX,
  UTILITY_PALLET_INDEX, BATCH_ALL_CALL_INDEX,
  SERVICE_FEE_ADDRESS, SERVICE_FEE_MAX_BPS,
} from '../js/scale.js';
import {
  setWordlistForTests, entropyToMnemonic, validateMnemonic, mnemonicToSeed,
  keypairFromSeed, keypairFromMnemonic, loadWordlist, embeddedWordlist,
  MAX_MNEMONIC_CHARS, mnemonicInputRoom, normalizeMnemonic,
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

test('mnemonic: input length cap refuses over-cap pastes before splitting', () => {
  setWordlistForTests(MINI_WORDS);
  assert.equal(MAX_MNEMONIC_CHARS, 1024);
  assert.equal(mnemonicInputRoom(0), 1024);
  assert.equal(mnemonicInputRoom(1024), 0);
  assert.equal(mnemonicInputRoom(1025), 0);
  assert.equal(mnemonicInputRoom(-1), 0);
  assert.equal(mnemonicInputRoom(1.5), 0);
  assert.equal(mnemonicInputRoom('12'), 0);
  assert.equal(mnemonicInputRoom(NaN), 0);
  const m = entropyToMnemonic(new Uint8Array(32)); // 187 chars with the fixture list
  // exactly at the cap (phrase + trailing padding) still validates
  const atCap = m + ' '.repeat(MAX_MNEMONIC_CHARS - m.length);
  assert.equal(atCap.length, MAX_MNEMONIC_CHARS);
  assert.ok(validateMnemonic(atCap).ok, 'exactly-cap padded phrase must validate');
  // one char over is refused on length, naming the cap — not as a word count
  const over = validateMnemonic(atCap + ' ');
  assert.ok(!over.ok && /too long/.test(over.reason) && /1024/.test(over.reason), over.reason);
  // a giant word-salad paste is refused on length, never split
  const giant = validateMnemonic('abandon '.repeat(2500000));
  assert.ok(!giant.ok && /too long/.test(giant.reason), giant.reason);
  // non-string input fails closed instead of throwing
  assert.equal(validateMnemonic(null).ok, false);
  assert.equal(validateMnemonic(undefined).ok, false);
});

test('mnemonic: seed + normalize paths ask the same length gate', () => {
  setWordlistForTests(MINI_WORDS);
  const m = entropyToMnemonic(new Uint8Array(32));
  assert.equal(normalizeMnemonic('  ' + m.split(' ').join('   \n ') + ' '), m);
  assert.throws(() => normalizeMnemonic('abandon '.repeat(2500000)), /1024/);
  assert.throws(() => mnemonicToSeed('abandon '.repeat(2500000)), /1024/);
  assert.throws(() => keypairFromMnemonic('abandon '.repeat(2500000)), /1024/);
  // a legit phrase still seeds deterministically through the gate
  assert.deepEqual(mnemonicToSeed(m), mnemonicToSeed(normalizeMnemonic(m)));
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

test('ss58Decode rejects the reserved prefix forms', () => {
  // hand-built 0xBD / 0xC0 payloads carry valid checksums over their own
  // bytes; the reserved forms are not SS58 and must never read as 189/192
  assert.throws(() => ss58Decode('KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC'), /Reserved SS58 prefix form/);
  assert.throws(() => ss58Decode('LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ'), /Reserved SS58 prefix form/);
});

test('ss58Decode refuses over-long input before decoding', () => {
  // base58Decode is quadratic in input length; the gate is 128 chars
  // (a Quantus address is 49) and must fire before any decoding loop
  assert.throws(() => ss58Decode('z'.repeat(20000)), /Address too long/);
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

test('units: qtcToPlancks supply cap (21M QTC hard cap)', () => {
  assert.equal(qtcToPlancks('21000000'), 21000000000000000000n); // exactly the cap stays valid
  assert.equal(qtcToPlancks('21000000.000000000000'), 21000000000000000000n);
  assert.throws(() => qtcToPlancks('21000000.000000000001'), /21,000,000 QTC total supply/); // 1 planck over
  assert.throws(() => qtcToPlancks('21000001'), /total supply/);
  assert.throws(() => qtcToPlancks('1000000000000'), /total supply/);
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
  buildUnsignedTransfer, parseRecipient as parseRecipientDirect,
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

test('activity round 3: a timestamp must fit the era its block height can occupy', () => {
  // Genesis 2026-09-09; sustained average block interval band 6–30 s ± 1 day.
  assert.equal(sanitizeActivityRows([aRow({ block_height: 1, timestamp: '2026-10-11T04:20:31Z' })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ block_height: 100, timestamp: '2026-10-11T04:20:31Z' })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ timestamp: '2026-09-20T00:00:00Z' })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ timestamp: '2026-09-09T00:00:01Z' })], WALLET, NOW).length, 0);
  assert.equal(sanitizeActivityRows([aRow({ block_height: 100, timestamp: '2026-09-09T01:00:00Z' })], WALLET, NOW).length, 1);
});

test('activity round 3: timestamp order must not contradict height order', () => {
  const inverted = sanitizeActivityRows([
    aRow({ id: 'a', block_height: 203723, timestamp: '2026-10-11T04:00:00Z' }),
    aRow({ id: 'b', block_height: 203700, timestamp: '2026-10-11T05:00:00Z' }),
  ], WALLET, NOW);
  assert.equal(inverted, null);
  const equal = sanitizeActivityRows([
    aRow({ id: 'a', block_height: 203723, timestamp: '2026-10-11T04:20:31Z' }),
    aRow({ id: 'b', block_height: 203722, timestamp: '2026-10-11T04:20:31Z' }),
  ], WALLET, NOW);
  assert.equal(equal.length, 2);
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

/* ---- Optional builder service fee (profit route, 2026-10-11): ON TOP of
 * the amount, recipient leg untouched and FIRST, fee leg LAST, both in ONE
 * atomic Utility.batch_all to Kyle's QTC address. Fee-free sends stay
 * byte-identical plain transfers. ---- */
const FEE_KEY_HEX = '88714241713efd0732437b5a44f8541f69310374de19cc539700caf09d00354c';

test('service fee: address pins — SS58-189, fleet-pinned key, cap 100 bps', () => {
  assert.equal(SERVICE_FEE_ADDRESS, 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau');
  assert.equal(SERVICE_FEE_MAX_BPS, 100);
  const { prefix, accountId } = ss58Decode(SERVICE_FEE_ADDRESS);
  assert.equal(prefix, 189);
  assert.equal(Buffer.from(accountId).toString('hex'), FEE_KEY_HEX);
  assert.deepEqual(parseRecipientDirect(SERVICE_FEE_ADDRESS), accountId);
});

test('service fee: exact floor math, never above the quoted rate, capped', () => {
  assert.deepEqual(computeServiceFee(10000000000000n, 50), { feePlancks: 50000000000n, feeBps: 50 }); // 10 QTC @0.5% = 0.05
  assert.deepEqual(computeServiceFee(1000000000000n, 25), { feePlancks: 2500000000n, feeBps: 25 });   // 1 QTC @0.25%
  assert.deepEqual(computeServiceFee(1000000000000n, 100), { feePlancks: 10000000000n, feeBps: 100 }); // 1 QTC @1%
  for (const amt of [0n, 1n, 99n, 9999n, 10000n, 10001n, 123456789n, 21000000000000000000n]) {
    for (const bps of [0, 1, 25, 33, 50, 99, 100, 200, 10000]) {
      const wantBps = Math.min(bps, 100);
      const want = amt <= 0n || wantBps === 0 ? 0n : (amt * BigInt(wantBps)) / 10000n;
      const got = computeServiceFee(amt, bps);
      assert.equal(got.feeBps, wantBps, `bps sanitize ${bps}`);
      assert.equal(got.feePlancks, want, `fee ${amt} @ ${bps}`);
      assert.ok(got.feePlancks * 10000n <= amt * BigInt(wantBps), 'fee never exceeds the quoted percentage');
    }
  }
  // garbage rates sanitize to no fee, never to a surprise fee
  assert.deepEqual(computeServiceFee(1000000000000n, -5), { feePlancks: 0n, feeBps: 0 });
  assert.deepEqual(computeServiceFee(1000000000000n, NaN), { feePlancks: 0n, feeBps: 0 });
  assert.deepEqual(computeServiceFee(1000000000000n, 33.9), { feePlancks: 3300000000n, feeBps: 33 });
});

test('service fee: labels', () => {
  assert.equal(feeBpsLabel(0), '0%');
  assert.equal(feeBpsLabel(25), '0.25%');
  assert.equal(feeBpsLabel(50), '0.5%');
  assert.equal(feeBpsLabel(100), '1%');
  assert.equal(feeBpsLabel(33), '0.33%');
});

test('batch_all: encoding is [9, 2, compact(count), calls…]', () => {
  const a = buildTransferCall(new Uint8Array(32).fill(7), 1000n);
  const b = buildTransferCall(new Uint8Array(32).fill(8), 2000n);
  const batch = buildBatchAllCall([a, b]);
  assert.equal(batch[0], UTILITY_PALLET_INDEX);
  assert.equal(batch[1], BATCH_ALL_CALL_INDEX);
  assert.equal(batch[2], 2 << 2, 'compact count 2');
  assert.deepEqual(batch.slice(3, 3 + a.length), a);
  assert.deepEqual(batch.slice(3 + a.length), b);
  assert.equal(batch.length, 3 + a.length + b.length);
  assert.throws(() => buildBatchAllCall([]), /at least one call/);
  assert.throws(() => buildBatchAllCall([new Uint8Array(0)]), /bad call bytes/);
});

test('transfer with service fee: fee-free and floored-tiny are byte-identical plain transfers', () => {
  const dest = new Uint8Array(32).fill(7);
  const feeDest = ss58Decode(SERVICE_FEE_ADDRESS).accountId;
  const plain = buildTransferCall(dest, 1500000000000n);
  const off = buildTransferWithServiceFee(dest, 1500000000000n, feeDest, 0);
  assert.deepEqual(off.call, plain);
  assert.equal(off.kind, 'transfer_keep_alive');
  assert.equal(off.feePlancks, 0n);
  assert.equal(off.totalDebitPlancks, 1500000000000n);
  // 100 plancks at 0.5% floors to 0 — no invalid 0-planck leg, plain bytes
  const tiny = buildTransferWithServiceFee(dest, 100n, feeDest, 50);
  assert.deepEqual(tiny.call, buildTransferCall(dest, 100n));
  assert.equal(tiny.kind, 'transfer_keep_alive');
  assert.equal(tiny.feePlancks, 0n);
  assert.equal(tiny.feeBps, 50, 'the chosen rate is still reported honestly');
});

test('transfer with service fee: batch wraps recipient leg FIRST (untouched) + fee leg LAST', () => {
  const dest = new Uint8Array(32).fill(7);
  const feeDest = ss58Decode(SERVICE_FEE_ADDRESS).accountId;
  const amount = 10000000000000n; // 10 QTC
  const built = buildTransferWithServiceFee(dest, amount, feeDest, 50);
  assert.equal(built.kind, 'batch_all');
  assert.equal(built.feePlancks, 50000000000n); // 0.05 QTC
  assert.equal(built.totalDebitPlancks, amount + 50000000000n);
  const recipientLeg = buildTransferCall(dest, amount);
  const feeLeg = buildTransferCall(feeDest, 50000000000n);
  assert.deepEqual(built.call, buildBatchAllCall([recipientLeg, feeLeg]));
  // leg order + exact sum, decoded back out of the batch bytes
  assert.deepEqual(built.call.slice(3, 3 + recipientLeg.length), recipientLeg, 'recipient leg passes through byte-for-byte');
  const feeInBatch = built.call.slice(3 + recipientLeg.length);
  assert.deepEqual(feeInBatch.slice(3, 35), feeDest, 'fee leg pays the disclosed address key');
  const { value } = compactDecode(feeInBatch, 35);
  assert.equal(value, 50000000000n);
  // cap: 500 bps asked -> 100 bps charged
  const capped = buildTransferWithServiceFee(dest, amount, feeDest, 500);
  assert.equal(capped.feeBps, 100);
  assert.equal(capped.feePlancks, 100000000000n);
  // a fee with a malformed fee destination is refused, never misdirected
  assert.throws(() => buildTransferWithServiceFee(dest, amount, new Uint8Array(31), 50), /32 bytes/);
});

/* buildUnsignedTransfer against a stub node: the fee choice is pinned in
 * the returned object, the signed call carries it byte-for-byte, and the
 * fee-quote placeholder is length-accurate per ML-DSA scheme. */
const stubNode = (captured) => ({
  call: async (method, params) => {
    switch (method) {
      case 'state_getRuntimeVersion': return { specName: 'quantus', specVersion: 153, transactionVersion: 6 };
      case 'chain_getBlockHash':
        if (params && params[0] === 0) return '0x' + 'aa'.repeat(32);       // genesis
        if (!params || params.length === 0) return '0x' + 'bb'.repeat(32);  // latest
        return '0x' + 'cc'.repeat(32);                                       // era birth
      case 'chain_getHeader': return { number: '0x2fca4' };
      case 'system_accountNextIndex': return 7;
      case 'payment_queryFeeDetails':
        captured.placeholderHex = params[0];
        return { inclusionFee: { baseFee: '100', lenFee: '200', adjustedWeightFee: '300' } };
      default: throw new Error('no stub for ' + method);
    }
  },
});

test('buildUnsignedTransfer: fee off is the plain transfer, pinned as such', async () => {
  const captured = {};
  const dest = ss58Encode(new Uint8Array(32).fill(7), 189);
  const from = ss58Encode(new Uint8Array(32).fill(1), 189);
  const u = await buildUnsignedTransfer(stubNode(captured), {
    fromAddress: from, fromAccountId: new Uint8Array(32).fill(1),
    destAddress: dest, amountPlancks: 10000000000000n,
  });
  assert.deepEqual(u.call, buildTransferCall(new Uint8Array(32).fill(7), 10000000000000n));
  assert.equal(u.callKind, 'transfer_keep_alive');
  assert.equal(u.serviceFeePlancks, 0n);
  assert.equal(u.serviceFeeBps, 0);
  assert.equal(u.totalDebitPlancks, 10000000000000n);
  assert.equal(u.fee, 600n, 'node fee quote still sums the three validated fields');
  assert.deepEqual(u.payload.slice(0, u.call.length), u.call, 'the signing payload signs the pinned call');
});

test('buildUnsignedTransfer: fee on pins the batch call + fee figures', async () => {
  const captured = {};
  const dest = ss58Encode(new Uint8Array(32).fill(7), 189);
  const from = ss58Encode(new Uint8Array(32).fill(1), 189);
  const u = await buildUnsignedTransfer(stubNode(captured), {
    fromAddress: from, fromAccountId: new Uint8Array(32).fill(1),
    destAddress: dest, amountPlancks: 10000000000000n, serviceFeeBps: 50,
  });
  assert.equal(u.callKind, 'batch_all');
  assert.equal(u.serviceFeePlancks, 50000000000n);
  assert.equal(u.serviceFeeBps, 50);
  assert.equal(u.totalDebitPlancks, 10050000000000n);
  const feeDest = ss58Decode(SERVICE_FEE_ADDRESS).accountId;
  assert.deepEqual(u.call, buildBatchAllCall([
    buildTransferCall(new Uint8Array(32).fill(7), 10000000000000n),
    buildTransferCall(feeDest, 50000000000n),
  ]));
  assert.deepEqual(u.payload.slice(0, u.call.length), u.call);
});

test('buildUnsignedTransfer: fee-quote placeholder is length-accurate per scheme and per call', async () => {
  const dest = ss58Encode(new Uint8Array(32).fill(7), 189);
  const from = ss58Encode(new Uint8Array(32).fill(1), 189);
  const base = { fromAddress: from, fromAccountId: new Uint8Array(32).fill(1), destAddress: dest, amountPlancks: 10000000000000n };
  const c65 = {}; await buildUnsignedTransfer(stubNode(c65), { ...base });
  const c87 = {}; await buildUnsignedTransfer(stubNode(c87), { ...base, scheme: 87 });
  // ML-DSA-87 wire (1+4627+2592) is 1958 bytes longer than ML-DSA-65 (1+3309+1952)
  assert.equal((c87.placeholderHex.length - c65.placeholderHex.length) / 2, 1958);
  const cFee = {}; const uFee = await buildUnsignedTransfer(stubNode(cFee), { ...base, serviceFeeBps: 50 });
  const cPlain = {}; const uPlain = await buildUnsignedTransfer(stubNode(cPlain), { ...base });
  assert.equal((cFee.placeholderHex.length - cPlain.placeholderHex.length) / 2, uFee.call.length - uPlain.call.length,
    'the batch call length is fully reflected in the quoted placeholder');
});

/* ---------- keystore vault-blob boundary ----------
 * The vault blob is untrusted (localStorage / user-supplied backup file).
 * Before the fix, importVaultFile checked only v + field presence and
 * wrote a shaped-but-garbage blob straight over the existing vault, and
 * openVault fed unvalidated hex to the decryptor: parseInt NaN silently
 * became 0 bytes, so a corrupt vault reported "wrong password". */
const vaultStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (vaultStore.has(k) ? vaultStore.get(k) : null),
  setItem: (k, v) => vaultStore.set(k, String(v)),
  removeItem: (k) => vaultStore.delete(k),
};
const VAULT_KEY = 'qtc-web-wallet-vault-v1';
const ks = await import('../js/keystore.js');

function genuineBlob() {
  return {
    v: 1, scheme: 65, kdf: 'PBKDF2-HMAC-SHA256', iterations: 250000,
    cipher: 'AES-GCM-256', salt: 'ab'.repeat(16), iv: 'cd'.repeat(12),
    ciphertext: 'ef'.repeat(64),
  };
}

test('keystore: validateVaultBlob accepts genuine shapes (65 and 87)', () => {
  assert.equal(ks.validateVaultBlob(genuineBlob()).ok, true);
  assert.equal(ks.validateVaultBlob({ ...genuineBlob(), scheme: 87 }).ok, true);
});

test('keystore: validateVaultBlob rejects the poison matrix', () => {
  const bad = [
    null, undefined, 42, 'vault', [],
    { ...genuineBlob(), v: 2 },
    { ...genuineBlob(), scheme: 99 },
    { ...genuineBlob(), scheme: '65' },
    { ...genuineBlob(), kdf: 'argon2' },
    { ...genuineBlob(), cipher: 'AES-CBC' },
    { ...genuineBlob(), iterations: 1 },
    { ...genuineBlob(), salt: 'ab'.repeat(15) },
    { ...genuineBlob(), salt: 'zz'.repeat(16) },
    { ...genuineBlob(), salt: 1234 },
    { ...genuineBlob(), iv: 'cd'.repeat(11) },
    { ...genuineBlob(), iv: 'not-hex-at-all!!' },
    { ...genuineBlob(), ciphertext: '' },
    { ...genuineBlob(), ciphertext: 'abc' },
    { ...genuineBlob(), ciphertext: 'zz'.repeat(32) },
    { ...genuineBlob(), ciphertext: 'ef'.repeat(70000) },
    { v: 1, scheme: 65 },
  ];
  for (const b of bad) assert.equal(ks.validateVaultBlob(b).ok, false, String(JSON.stringify(b)).slice(0, 60));
});

test('keystore: save/open round-trip preserves keys, scheme and mnemonic', async () => {
  vaultStore.clear();
  const secretKey = new Uint8Array(64); for (let i = 0; i < 64; i++) secretKey[i] = i;
  const publicKey = new Uint8Array(32).fill(9);
  await ks.saveVault({ scheme: 87, secretKey, publicKey, mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, 'correct horse battery');
  const data = await ks.openVault('correct horse battery');
  assert.equal(data.scheme, 87);
  assert.deepEqual(data.secretKey, secretKey);
  assert.deepEqual(data.publicKey, publicKey);
  assert.match(data.mnemonic, /^legal winner/);
});

test('keystore: wrong password on a well-formed vault says wrong password', async () => {
  await assert.rejects(() => ks.openVault('wrong horse'), /wrong password/);
});

test('keystore: corrupt stored blob says corrupted, never wrong password / TypeError', async () => {
  const good = vaultStore.get(VAULT_KEY);
  const blob = JSON.parse(good);
  vaultStore.set(VAULT_KEY, JSON.stringify({ ...blob, salt: 'z'.repeat(32) }));
  await assert.rejects(() => ks.openVault('correct horse battery'), (e) => /corrupted/.test(e.message) && !/wrong password/.test(e.message));
  vaultStore.set(VAULT_KEY, JSON.stringify({ v: 1, scheme: 65 }));
  await assert.rejects(() => ks.openVault('correct horse battery'), (e) => !(e instanceof TypeError) && /vault/.test(e.message));
  vaultStore.set(VAULT_KEY, 'this is not json');
  await assert.rejects(() => ks.openVault('correct horse battery'), /not a QTC web-wallet vault file/);
  vaultStore.set(VAULT_KEY, good);
});

test('keystore: garbage import is rejected and the existing vault survives', async () => {
  const before = vaultStore.get(VAULT_KEY);
  const garbage = { v: 1, scheme: 99, salt: 'zzzz', iv: 'nope', ciphertext: 'abc' };
  await assert.rejects(() => ks.importVaultFile({ size: JSON.stringify(garbage).length, text: async () => JSON.stringify(garbage) }));
  await assert.rejects(() => ks.importVaultFile({ size: 8, text: async () => 'not json' }), /not a QTC web-wallet vault file/);
  assert.equal(vaultStore.get(VAULT_KEY), before, 'a rejected import must not touch the stored vault');
  const data = await ks.openVault('correct horse battery');
  assert.equal(data.scheme, 87, 'the surviving vault still opens');
});

test('keystore: valid import round-trips and persists only the known fields', async () => {
  const exported = vaultStore.get(VAULT_KEY);
  const withStray = JSON.stringify({ ...JSON.parse(exported), stray: 'drop me', nested: { x: 1 } });
  vaultStore.clear();
  await ks.importVaultFile({ size: withStray.length, text: async () => withStray });
  const persisted = JSON.parse(vaultStore.get(VAULT_KEY));
  assert.deepEqual(Object.keys(persisted).sort(), ['cipher', 'ciphertext', 'iterations', 'iv', 'kdf', 'salt', 'scheme', 'v']);
  const data = await ks.openVault('correct horse battery');
  assert.equal(data.scheme, 87);
});

/* ---------- keystore vault-file size gate (white-hat, 2026-10-16) -----
 * importVaultFile used to file.text() + JSON.parse the WHOLE picked
 * backup before validateVaultBlob ran — yet that validator caps
 * ciphertext at 131,072 hex chars, so every legitimate backup is
 * < ~132 KiB and any larger file was guaranteed-reject, but only after
 * its full text + parse tree were allocated. The import now asks the
 * fail-closed vaultFileRoom(file.size) gate first (cap 256 KiB, ~2x
 * the largest backup saveVault can produce) and refuses over-cap
 * picks unread, naming size + cap, with the stored vault untouched. */
test('keystore: vaultFileRoom arithmetic is fail-closed at the 256 KiB cap', () => {
  assert.equal(ks.MAX_VAULT_FILE_BYTES, 256 * 1024);
  assert.equal(ks.vaultFileRoom(0), true);
  assert.equal(ks.vaultFileRoom(131072), true, 'a max-ciphertext backup fits');
  assert.equal(ks.vaultFileRoom(ks.MAX_VAULT_FILE_BYTES), true);
  assert.equal(ks.vaultFileRoom(ks.MAX_VAULT_FILE_BYTES + 1), false);
  assert.equal(ks.vaultFileRoom(20 * 1024 * 1024), false);
  for (const bad of [NaN, -1, Infinity, '100', undefined, null, {}]) {
    assert.equal(ks.vaultFileRoom(bad), false, 'fail-closed: ' + String(bad));
  }
});

test('keystore: over-cap import is refused unread and the vault survives', async () => {
  const before = vaultStore.get(VAULT_KEY);
  let reads = 0;
  await assert.rejects(
    () => ks.importVaultFile({ size: 20 * 1024 * 1024, text: async () => { reads++; return '{}'; } }),
    (e) => /20971520/.test(e.message) && /262144/.test(e.message) && /not read/.test(e.message),
  );
  assert.equal(reads, 0, 'an over-cap file must never be read');
  assert.equal(vaultStore.get(VAULT_KEY), before, 'a refused import must not touch the stored vault');
  // a sizeless file is fail-closed too, also unread
  await assert.rejects(() => ks.importVaultFile({ text: async () => { reads++; return '{}'; } }), /not read/);
  assert.equal(reads, 0);
  assert.equal(vaultStore.get(VAULT_KEY), before);
});

test('keystore: at-cap import (genuine blob padded to exactly the cap) succeeds', async () => {
  const genuine = JSON.stringify(genuineBlob());
  const padded = genuine + ' '.repeat(ks.MAX_VAULT_FILE_BYTES - genuine.length);
  assert.equal(padded.length, ks.MAX_VAULT_FILE_BYTES);
  await ks.importVaultFile({ size: padded.length, text: async () => padded });
  const persisted = JSON.parse(vaultStore.get(VAULT_KEY));
  assert.equal(persisted.ciphertext, genuineBlob().ciphertext);
});
