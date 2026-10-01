/* QTC Extrinsic Lab — test suite (node).
 * Builds REAL signed extrinsics with noble ML-DSA (same primitives as the web
 * wallet), then decodes them with js/decode.js and verifies signatures with
 * js/verify.js. A tamper test proves verification actually checks the signature.
 * Run: node tests/run-tests.mjs  (from pages/extrinsic-lab/)
 */
import { createRequire } from 'node:module';
import { ml_dsa65, ml_dsa87 } from '../js/vendor/noble/post-quantum/ml-dsa.js';
import { blake2b } from '../js/vendor/noble/hashes/blake2.js';

const require = createRequire(import.meta.url);
const CALLS = require('../js/call-table.js');
// vendor globals needed by decode.js display helpers (ss58 + human checkphrase)
globalThis.QSS58 = require('../js/vendor/ss58.js');
globalThis.QTC_WORDLIST = require('../js/vendor/wordlist.js');
globalThis.QTC_CHECK = require('../js/vendor/checkphrase-core.js');
const D = require('../js/decode.js');
// verify.js reads global.QEL_NOBLE + global.QEL_DECODE; wire them up first
globalThis.QEL_DECODE = D;
globalThis.QEL_NOBLE = { ml_dsa65, ml_dsa87, blake2b };
const V = require('../js/verify.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  const x = typeof a === 'bigint' ? a.toString() : JSON.stringify(a);
  const y = typeof b === 'bigint' ? b.toString() : JSON.stringify(b);
  if (x !== y) throw new Error((msg || 'mismatch') + ': got ' + x + ' want ' + y);
}

const E = require('../js/encode.js');
const compactEncode = E.compactEncode;

/* ---------- test extrinsic builder (via js/encode.js) ---------- */
function u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n), true); return b; }
function ctz(n) { let c = 0; while ((n & 1) === 0 && c < 64) { n = Math.floor(n / 2); c++; } return c; }
function encodeMortalEra(period, phase) {
  const quantize = Math.max(1, Math.floor(period / 4096));
  const encoded = (Math.min(15, Math.max(1, ctz(period) - 1))) | ((Math.floor(phase / quantize)) << 4);
  const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, encoded, true); return b;
}
function buildCallTransfer(dest32, plancks) {
  return D.concatBytes([Uint8Array.of(2, 3, 0x00), dest32, E.compactEncode(plancks)]);
}
function signAndAssemble({ kp, scheme, call, era, nonce, tip, specVersion, txVersion, genesisHash, birthHash }) {
  const mod = scheme === 87 ? ml_dsa87 : ml_dsa65;
  const hex = E.encodeExtrinsic({
    callBytes: call, pub32: kp.accountId, pubKey: kp.publicKey,
    sigVariant: scheme === 87 ? 0 : 1,
    eraBytes: era, nonce, tip, metadataHashMode: 0,
    specVersion, txVersion, genesisHash, eraBirthHash: birthHash,
    signFn: (msg) => mod.sign(msg, kp.secretKey, { context: new TextEncoder().encode('QUANTUS_EXTRINSIC') }),
  });
  const built = D.buildSigningPayload(
    { callBytes: call, eraBytes: era, nonce, tip, metadataHashMode: 0 },
    { specVersion, txVersion, genesisHash, eraBirthHash: birthHash });
  return { hex, built, kp };
}
function rand32(seed) { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i * 7) & 255; return b; }

const SPEC = 153, TXV = 6;
const GENESIS = rand32(1), BIRTH = rand32(2);

console.log('QTC Extrinsic Lab tests');

/* ---------- 1: transfer_keep_alive round trip ---------- */
test('decode signed transfer_keep_alive (ML-DSA-65)', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(9);
  const dest = rand32(10);
  const { hex } = signAndAssemble({ kp, scheme: 65, call: buildCallTransfer(dest, 1500000000000n), era: Uint8Array.of(0), nonce: 7n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assert(d.lengthOk, 'length prefix must match');
  assert(d.version.signed && d.version.format === 4, 'signed v4');
  assertEq(d.nonce, 7n, 'nonce');
  assertEq(d.tip, 0n, 'tip');
  assert(d.era.immortal, 'immortal era');
  assertEq(d.call.palletName, 'Balances', 'pallet');
  assertEq(d.call.callName, 'transfer_keep_alive', 'call');
  assertEq(d.call.args[1].decoded, 1500000000000n, 'amount');
  assert(d.call.args[0].decoded.account.ss58.startsWith('qz'), 'dest ss58 prefix qz, got ' + d.call.args[0].decoded.account.ss58);
  assert(d.call.args[0].decoded.account.checkphrase.split(' ').length >= 3, 'checkphrase words present');
  assert(d.signature.scheme === 'ML-DSA-65', 'scheme');
  assertEq(d.trailing, 0, 'no trailing bytes');
});

test('verify signature of decoded transfer (valid)', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(11);
  const dest = rand32(12);
  const { hex, kp: k2 } = signAndAssemble({ kp, scheme: 65, call: buildCallTransfer(dest, 2500000000000n), era: Uint8Array.of(0), nonce: 3n, tip: 1000n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex); d._hex = hex;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS });
  assert(r.ok === true, 'signature must verify, err=' + r.error);
  assert(r.hashed === false, 'small payload not hashed');
});

test('tampered payload fails verification', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(13);
  const dest = rand32(14);
  const call = buildCallTransfer(dest, 1000000000000n);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 1n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  // flip one amount byte deep in the call section, keeping the signature intact
  const raw = D.hexToBytes(hex);
  const d0 = D.decodeExtrinsic(hex);
  const amtByte = d0.call.args[1].start + 1;
  raw[amtByte] ^= 0x01;
  const hex2 = '0x' + D.bytesToHex(raw);
  const d = D.decodeExtrinsic(hex2); d._hex = hex2;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS });
  assert(r.ok === false, 'tampered payload must NOT verify');
});

/* ---------- 2: ML-DSA-87 + mortal era ---------- */
test('decode + verify ML-DSA-87 mortal-era extrinsic', () => {
  const kp = ml_dsa87.keygen(); kp.accountId = rand32(15);
  const dest = rand32(16);
  const era = encodeMortalEra(64, 8);
  const { hex } = signAndAssemble({ kp, scheme: 87, call: buildCallTransfer(dest, 500000000000n), era, nonce: 12n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: BIRTH });
  const d = D.decodeExtrinsic(hex);
  assert(!d.era.immortal && d.era.period === 64 && d.era.phase === 8, 'mortal era 64/8, got ' + JSON.stringify({ p: d.era.period, ph: d.era.phase }));
  assert(d.signature.scheme === 'ML-DSA-87', 'scheme 87');
  assertEq(V.birthFor(d, 100), 72, 'birth block at height 100');
  d._hex = hex;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: BIRTH, eraBirth: 72 });
  assert(r.ok === true, 'mortal sig verifies, err=' + r.error);
});

/* ---------- 3: batch_all with nested calls (payload > 256B hashing rule) ---------- */
test('batch_all nested decode + hashed-payload verify', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(17);
  const inners = [];
  for (let i = 0; i < 6; i++) inners.push(buildCallTransfer(rand32(20 + i), BigInt(1000000000000 + i)));
  const batchCall = D.concatBytes([Uint8Array.of(9, 2), compactEncode(inners.length), ...inners]);
  const { hex, built } = signAndAssemble({ kp, scheme: 65, call: batchCall, era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  assert(built.hashed === true, 'batch payload must exceed 256 bytes');
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.callName, 'batch_all', 'batch_all');
  const vec = d.call.args[0].decoded;
  assertEq(vec.len, 6, 'six inner calls');
  assertEq(vec.items[0].value.call.callName, 'transfer_keep_alive', 'inner call name');
  assertEq(vec.items[5].value.call.args[1].decoded, 1000000000005n, 'inner amount');
  d._hex = hex;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS });
  assert(r.ok === true && r.hashed === true, 'hashed payload verifies');
});

/* ---------- 4: schedule_transfer (plain u128, NOT compact) ---------- */
test('schedule_transfer decodes plain-u128 amount', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(30);
  const dest = rand32(31);
  const amt = new Uint8Array(16); new DataView(amt.buffer).setBigUint64(0, 777000000000000n, true);
  const call = D.concatBytes([Uint8Array.of(11, 3, 0x00), dest, amt]);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 2n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.callName, 'schedule_transfer', 'call name');
  assertEq(d.call.args[1].decoded, 777000000000000n, 'plain u128 amount');
  assertEq(d.trailing, 0, 'exact consumption proves u128-not-compact');
});

/* ---------- 5: multisig create + propose with embedded call ---------- */
test('multisig create_multisig + propose(callbytes) decode', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(40);
  const s1 = rand32(41), s2 = rand32(42);
  const signers = D.concatBytes([compactEncode(2), s1, s2]);
  const call = D.concatBytes([Uint8Array.of(19, 0), signers, u32le(2), (() => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, 99n, true); return b; })()]);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 5n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.callName, 'create_multisig', 'call name');
  assertEq(d.call.args[0].decoded.len, 2, 'two signers');
  assertEq(d.call.args[1].decoded, 2, 'threshold');
  assertEq(d.call.args[2].decoded, 99n, 'nonce u64');

  // propose with embedded transfer call bytes
  const inner = buildCallTransfer(rand32(43), 1000000000n);
  const call2 = D.concatBytes([Uint8Array.of(19, 1), rand32(44), compactEncode(inner.length), inner, u32le(5000)]);
  const b2 = signAndAssemble({ kp, scheme: 65, call: call2, era: Uint8Array.of(0), nonce: 6n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d2 = D.decodeExtrinsic(b2.hex);
  assertEq(d2.call.callName, 'propose', 'propose');
  assertEq(d2.call.callName && d2.call.args[1].decoded.call.callName, 'transfer_keep_alive', 'embedded call decoded');
  assertEq(d2.call.args[2].decoded, 5000, 'expiry');
});

/* ---------- 6: unsigned inherent (timestamp.set) ---------- */
test('unsigned inherent decodes without signer section', () => {
  const now = compactEncode(1759272000000n);
  const body = D.concatBytes([Uint8Array.of(0x04, 1, 0), now]);
  const hex = '0x' + D.bytesToHex(D.concatBytes([compactEncode(body.length), body]));
  const d = D.decodeExtrinsic(hex);
  assert(!d.version.signed, 'unsigned');
  assertEq(d.call.palletName, 'Timestamp', 'pallet');
  assertEq(d.call.callName, 'set', 'call');
  assertEq(d.call.args[0].decoded, 1759272000000n, 'moment');
});

/* ---------- 7: unknown pallet/call honesty ---------- */
test('unknown pallet index is labeled, not thrown', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(50);
  const call = Uint8Array.of(99, 0, 1, 2, 3);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assert(d.call.unknown && d.call.unknown.indexOf('pallet index 99') === 0, 'honest unknown label');
});
test('unknown call index within known pallet is labeled', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(51);
  const call = Uint8Array.of(2, 99, 7, 7, 7);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.palletName, 'Balances', 'pallet still known');
  assert(d.call.unknown && d.call.unknown.indexOf('call index 99') === 0, 'honest unknown call label');
});
test('malformed hex gives a clear error', () => {
  let threw = false;
  try { D.decodeExtrinsic('0xzzzz'); } catch (e) { threw = /not valid hex/.test(e.message); }
  assert(threw, 'clear hex error');
});
test('bad signature variant gives a clear error', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(52);
  const call = buildCallTransfer(rand32(53), 1n);
  const era = Uint8Array.of(0);
  const body = D.concatBytes([Uint8Array.of(0x84, 0x00), kp.accountId, Uint8Array.of(0x07), era, compactEncode(0n), compactEncode(0n), Uint8Array.of(0), call]);
  const hex = '0x' + D.bytesToHex(D.concatBytes([compactEncode(body.length), body]));
  let threw = false;
  try { D.decodeExtrinsic(hex); } catch (e) { threw = /unknown signature scheme variant 7/.test(e.message); }
  assert(threw, 'clear sig variant error');
});

/* ---------- 8: era vectors ---------- */
test('era decode vectors', () => {
  const r = new D.Reader(Uint8Array.of(0));
  assert(D.decodeEra(r).immortal === true, '0x00 immortal');
  // period 64, phase 8 -> enc = (ctz(64)-1) | (8/1)<<4 = 5 | 128 = 133 -> LE bytes 0x85 0x00
  const e = D.decodeEra(new D.Reader(Uint8Array.of(0x85, 0x00)));
  assert(e.period === 64 && e.phase === 8, 'mortal 64/8');
  assertEq(D.eraBirth(100, 64, 8), 72, 'birth block');
});

/* ---------- 9: compact codec round-trip (all four modes) ---------- */
test('compact round-trip all modes', () => {
  // regression: mode-2 decode once consumed the already-read first byte (u32le over-read)
  const vals = [0n, 1n, 63n, 64n, 1000n, 16383n, 16384n, 1000000000n, 1073741823n, 1073741824n, (1n << 64n) - 1n, 1n << 100n];
  for (const v of vals) {
    const enc = E.compactEncode(v);
    const got = new D.Reader(enc).compact();
    assertEq(got, v, 'compact(' + v + ')');
  }
  // canonical byte shapes per mode
  assertEq(D.bytesToHex(E.compactEncode(63n)), 'fc', 'mode0 max');
  assertEq(D.bytesToHex(E.compactEncode(64n)), '0101', 'mode1 min');
  assertEq(D.bytesToHex(E.compactEncode(16384n)), '02000100', 'mode2 min');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
