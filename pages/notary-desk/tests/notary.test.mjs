/* QTC Notary Desk — node test suite (run: node tests/notary.test.mjs) */
import { createHash } from "node:crypto";
import { blake2b } from "../../../assets/vendor/noble/hashes/blake2.js";
import twox from "../js/vendor/twox.js";
import codec from "../js/notary-codec.js";

const b2b256 = (bytes) => Array.from(blake2b(new Uint8Array(bytes), { dkLen: 32 }));
const b2b512 = (bytes) => Array.from(blake2b(new Uint8Array(bytes), { dkLen: 64 }));
const sha256 = (bytes) => Array.from(createHash("sha256").update(Buffer.from(bytes)).digest());

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : extra); }
}

/* --- hash primitive KATs (independent anchors) --- */
t("sha256('abc') KAT",
  codec.bytesToHex(sha256(codec.utf8ToBytes("abc"))) ===
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
t("blake2b-256('') KAT",
  codec.bytesToHex(b2b256([])) ===
  "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
t("twox_128('System') KAT",
  twox.twox128hex(codec.utf8ToBytes("System")) ===
  "26aa394eea5630e07c48ae0c9558cef7");

/* --- compact --- */
for (const n of [0, 1, 63, 64, 255, 16383, 16384, 1000000, 1073741823]) {
  const rc = codec.readCompact(codec.compactU32(n), 0);
  t("compact round-trip " + n, rc && rc.value === n && rc.next === codec.compactU32(n).length);
}
t("compact(0) = [0]", codec.bytesToHex(codec.compactU32(0)) === "00");
t("compact(64) two-byte", codec.bytesToHex(codec.compactU32(64)) === "0101");

/* --- envelope --- */
const zeroDigest = new Array(32).fill(0);
const env = codec.buildEnvelope(1, zeroDigest, "");
t("envelope ok", env.ok === true);
t("envelope known vector",
  env.hex === "514e4f542f3101" + "00".repeat(32) + "00", env.hex);
const env2 = codec.buildEnvelope(2, zeroDigest.map((_, i) => i), "Test deed #1");
t("envelope with label ok", env2.ok === true);
const p2 = codec.parseRemark(env2.bytes);
t("envelope parse round-trip",
  p2.kind === "envelope" && p2.algo === "BLAKE2b-256" &&
  p2.digestHex === codec.bytesToHex(zeroDigest.map((_, i) => i)) &&
  p2.label === "Test deed #1", JSON.stringify(p2));
t("envelope rejects bad algo", codec.buildEnvelope(9, zeroDigest, "").ok === false);
t("envelope rejects short digest", codec.buildEnvelope(1, [1, 2, 3], "").ok === false);
t("envelope rejects long label",
  codec.buildEnvelope(1, zeroDigest, "x".repeat(65)).ok === false);
t("envelope accepts 64B label",
  codec.buildEnvelope(1, zeroDigest, "x".repeat(64)).ok === true);
t("message parse (no magic)",
  (() => { const p = codec.parseRemark(codec.utf8ToBytes("hello chain")); return p.kind === "message" && p.text === "hello chain"; })());
t("raw parse (invalid utf8)",
  codec.parseRemark([0xff, 0xfe]).kind === "raw");

/* --- remark call --- */
const call = codec.buildRemarkCall([0x41], true);
t("remark_with_event call bytes", call.ok && call.callHex === "00070441", call.callHex);
t("remark call bytes",
  codec.buildRemarkCall([0x41], false).callHex === "00000441");
t("remark call pallet/call indices",
  call.pallet === 0 && call.call === 7);
const bigCall = codec.buildRemarkCall(env2.bytes, true);
t("envelope call compact len",
  bigCall.callHex.startsWith("0007") &&
  codec.readCompact(codec.hexToBytes(bigCall.callHex), 2).value === env2.bytes.length);
t("empty remark rejected", codec.buildRemarkCall([], true).ok === false);

/* --- fees --- */
const est = codec.signedLengthEstimate(100, "mldsa65", 0);
t("signed length math (mldsa65, nonce 0, call 100)",
  est.ok && est.totalBytes === 5402 && est.bodyBytes === 5400,
  "total=" + est.totalBytes + " body=" + est.bodyBytes);
t("length fee exact", est.feePlancks === 540200000n, String(est.feePlancks));
t("fee QTC format", est.feeQTC === "0.0005402", est.feeQTC);
const est87 = codec.signedLengthEstimate(100, "mldsa87", 0);
// body: 1 + 33 + (1+4627+2592=7220) + 2 + 1 + 1 + 100 = 7358; prefix 2 -> 7360
t("signed length math (mldsa87)",
  est87.ok && est87.totalBytes === 7360, "total=" + est87.totalBytes);
t("unknown scheme rejected", codec.signedLengthEstimate(100, "rsa", 0).ok === false);
t("formatQTC whole", codec.formatQTC(1000000000000n) === "1");
t("formatQTC trims zeros", codec.formatQTC(1500000000000n) === "1.5");

/* --- System.Events decoding --- */
function craftEvents() {
  const sender = new Array(32).fill(0x11), hash = new Array(32).fill(0x22);
  return [0x04, // compact(1): one record
    0x00, 0x03, 0x00, 0x00, 0x00, // ApplyExtrinsic(3)
    0x00, 0x05, // pallet 0, variant 5 = Remarked
    ...sender, ...hash,
    0x00]; // 0 topics
}
const dec = codec.decodeSystemEvents(craftEvents());
t("events decode ok", dec.ok === true && dec.records.length === 1, dec.error);
t("events sender/hash",
  dec.records[0] && dec.records[0].senderHex === "11".repeat(32) &&
  dec.records[0].hashHex === "22".repeat(32) &&
  dec.records[0].phase.kind === "ApplyExtrinsic" && dec.records[0].phase.index === 3);
t("events reject unknown shape",
  codec.decodeSystemEvents([0x01, 0x01, 0x02, 0x00]).ok === false);
t("events empty vector", (() => {
  const d = codec.decodeSystemEvents([0x00]); return d.ok && d.records.length === 0;
})());

/* --- SS58 ---
 * Ground truth: real upstream Quantus addresses (genesis vesting table,
 * validated by the address-toolkit suite). Decode with the toolkit, re-encode
 * with this codec: the string must round-trip exactly. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const AT = require("../../address-toolkit/app.js");
const UPSTREAM_ADDR = "qzkmmtHL1XZ94LnDc43hTuUUW6o2jkjQBSgwSYF7Dm2JErapB";
const upDec = AT.ss58Decode(UPSTREAM_ADDR);
t("upstream address decodes (prefix 189, 32B key)",
  upDec.ok === true && upDec.prefix === 189 && upDec.key.length === 32);
const reEnc = codec.ss58Encode32(upDec.key, b2b512);
t("ss58Encode32 reproduces upstream address", reEnc === UPSTREAM_ADDR, reEnc);
const qAddr = codec.ss58Encode32(upDec.key, b2b512);
t("ss58Encode32 prefix-189 shape",
  typeof qAddr === "string" && qAddr.startsWith("qz") && qAddr.length >= 46 && qAddr.length <= 50, qAddr);
t("ss58Encode32 deterministic", codec.ss58Encode32(upDec.key, b2b512) === qAddr);
t("ss58Encode32 rejects bad key", codec.ss58Encode32([1, 2, 3], b2b512) === null);

/* --- fees: nonce must never wrap --- */
t("signed length rejects a wrapping nonce (2^32)",
  codec.signedLengthEstimate(100, "mldsa65", 4294967296).ok === false);
t("signed length rejects a fractional nonce",
  codec.signedLengthEstimate(100, "mldsa65", 2.5).ok === false);
t("signed length rejects a nonce past the compact-encodable range (2^30, would throw)",
  codec.signedLengthEstimate(100, "mldsa65", 1073741824).ok === false);
t("signed length accepts the max compact-encodable nonce (2^30 - 1)",
  codec.signedLengthEstimate(100, "mldsa65", 1073741823).ok === true);

/* --- RPC-boundary validators --- */
t("parseBlockNumber hex", codec.parseBlockNumber("0x2f") === 47);
t("parseBlockNumber decimal string", codec.parseBlockNumber("47") === 47);
t("parseBlockNumber integer", codec.parseBlockNumber(47) === 47);
t("parseBlockNumber rejects garbage", codec.parseBlockNumber("garbage!!") === null);
t("parseBlockNumber rejects bad hex", codec.parseBlockNumber("0xZZ") === null);
t("parseBlockNumber rejects float", codec.parseBlockNumber(1.5) === null);
t("parseBlockNumber rejects negative", codec.parseBlockNumber(-3) === null);
t("parseBlockNumber rejects object", codec.parseBlockNumber({}) === null);
t("isHash32 accepts a real hash", codec.isHash32("0x" + "ab".repeat(32)) === true);
t("isHash32 rejects short hex", codec.isHash32("0x1234") === false);
t("isHash32 rejects non-string", codec.isHash32({}) === false);
t("validSubscriptionId accepts string id", codec.validSubscriptionId("sub-1") === true);
t("validSubscriptionId rejects empty/object",
  codec.validSubscriptionId("") === false && codec.validSubscriptionId({}) === false);

/* --- vault sanitizer --- */
const goodDigest = codec.bytesToHex(sha256(codec.utf8ToBytes("abc")));
const goodEnv = codec.buildEnvelope(1, sha256(codec.utf8ToBytes("abc")), "Deed");
const goodCall = codec.buildRemarkCall(goodEnv.bytes, true);
const GOOD = { id: "n1", created: "2026-10-01T12:00:00.000Z", mode: "document",
  algo: "SHA-256", digestHex: goodDigest, label: "Deed", envelopeHex: goodEnv.hex,
  callHex: goodCall.callHex, withEvent: true, feeQTC: "0.0005354", block: "123" };
const GOOD_MSG2 = { id: "n2", created: "2026-10-02T12:00:00.000Z", mode: "message",
  algo: null, digestHex: null, label: null, envelopeHex: null,
  callHex: codec.buildRemarkCall(codec.utf8ToBytes("hi"), false).callHex,
  withEvent: false, feeQTC: "0.0005", block: null };
t("sanitizeVault keeps valid doc + message anchors verbatim",
  (() => { const v = codec.sanitizeVault([GOOD, GOOD_MSG2]);
    return v.length === 2 && v[0].digestHex === goodDigest && v[0].block === "123" &&
      v[1].mode === "message"; })());
t("sanitizeVault rejects a non-array payload",
  Array.isArray(codec.sanitizeVault({})) && codec.sanitizeVault("junk").length === 0 &&
  codec.sanitizeVault(null).length === 0);
t("sanitizeVault drops null / primitive entries",
  codec.sanitizeVault([null, "x", 42, GOOD]).length === 1);
t("sanitizeVault drops a bad digest", codec.sanitizeVault([{ ...GOOD, digestHex: "zz" }]).length === 0);
t("sanitizeVault drops a garbage envelope (never hashed into a verify fingerprint)",
  codec.sanitizeVault([{ ...GOOD, envelopeHex: "zzzz" }]).length === 0);
t("sanitizeVault drops an envelope whose digest mismatches the stored digest",
  codec.sanitizeVault([{ ...GOOD, envelopeHex: codec.buildEnvelope(1, new Array(32).fill(9), "Deed").hex }]).length === 0);
t("sanitizeVault drops a markup-bearing fee",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "<img src=x>" }]).length === 0);
t("sanitizeVault drops a missing/garbage callHex",
  codec.sanitizeVault([{ ...GOOD, callHex: undefined }]).length === 0 &&
  codec.sanitizeVault([{ ...GOOD, callHex: "zzzz" }]).length === 0);
t("sanitizeVault drops a call whose index contradicts withEvent",
  codec.sanitizeVault([{ ...GOOD, withEvent: false }]).length === 0);
t("sanitizeVault drops an unparseable created date",
  codec.sanitizeVault([{ ...GOOD, created: "garbage" }]).length === 0);
t("sanitizeVault drops a non-string label",
  codec.sanitizeVault([{ ...GOOD, label: { evil: 1 } }]).length === 0);
t("sanitizeVault drops an unknown mode",
  codec.sanitizeVault([{ ...GOOD, mode: "carrier-pigeon" }]).length === 0);
t("sanitizeVault drops a message anchor carrying a digest",
  codec.sanitizeVault([{ ...GOOD_MSG2, digestHex: goodDigest }]).length === 0);
t("sanitizeVault coerces a non-numeric block annotation to null, anchor survives",
  (() => { const v = codec.sanitizeVault([{ ...GOOD, block: "<b>9</b>" }]);
    return v.length === 1 && v[0].block === null; })());

/* --- storage key --- */
const evKey = codec.systemEventsKey((b) => twox.twox128bytes(b));
t("System.Events key shape",
  evKey.startsWith("0x26aa394eea5630e07c48ae0c9558cef7") && evKey.length === 66, evKey);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
