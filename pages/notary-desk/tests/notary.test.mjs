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
  callHex: goodCall.callHex, withEvent: true, feeQTC: "0.0005349", block: "123" };
const GOOD_MSG2 = { id: "n2", created: "2026-10-02T12:00:00.000Z", mode: "message",
  algo: null, digestHex: null, label: null, envelopeHex: null,
  callHex: codec.buildRemarkCall(codec.utf8ToBytes("hi"), false).callHex,
  withEvent: false, feeQTC: "0.0005307", block: null };
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

/* --- round 2: RELATIONS, not just shapes --- */
t("validChainHeight accepts a real height", codec.validChainHeight(204982) === true);
t("validChainHeight accepts genesis 0 (valid over RPC)", codec.validChainHeight(0) === true);
t("validChainHeight rejects 99,999,999,999", codec.validChainHeight(99999999999) === false);
t("validChainHeight rejects negative/fractional/string",
  codec.validChainHeight(-1) === false && codec.validChainHeight(1.5) === false &&
  codec.validChainHeight("204982") === false);
t("sanitizeVault drops a call carrying a different payload than the envelope",
  codec.sanitizeVault([{ ...GOOD, callHex: codec.buildRemarkCall(codec.utf8ToBytes("hi"), true).callHex }]).length === 0);
t("sanitizeVault drops a call carrying another document's envelope",
  codec.sanitizeVault([{ ...GOOD, callHex: codec.buildRemarkCall(codec.buildEnvelope(1, new Array(32).fill(9), "Deed").bytes, true).callHex }]).length === 0);
t("sanitizeVault drops a call whose length prefix lies",
  codec.sanitizeVault([{ ...GOOD, callHex: codec.bytesToHex([0, 7].concat(codec.compactU32(100)).concat(codec.hexToBytes(goodEnv.hex))) }]).length === 0);
t("sanitizeVault drops a call with a trailing byte",
  codec.sanitizeVault([{ ...GOOD, callHex: goodCall.callHex + "ff" }]).length === 0);
t("sanitizeVault nulls an absurd block annotation, anchor survives",
  (() => { const v = codec.sanitizeVault([{ ...GOOD, block: "99999999999999999999999" }]);
    return v.length === 1 && v[0].block === null; })());
t("sanitizeVault nulls a block-0 annotation (genesis holds no remarks)",
  (() => { const v = codec.sanitizeVault([{ ...GOOD, block: "0" }]);
    return v.length === 1 && v[0].block === null; })());
/* --- round 3: PRODUCER relations --- */
t("sanitizeVault drops a payload above the producer cap (4097-byte message)",
  codec.sanitizeVault([{ ...GOOD_MSG2, id: "n3", callHex: codec.buildRemarkCall(new Array(4097).fill(0x61), false).callHex }]).length === 0);
t("sanitizeVault keeps a payload at exactly the cap (4096-byte message)",
  (() => { const c = codec.buildRemarkCall(new Array(4096).fill(0x61), false);
    return codec.sanitizeVault([{ ...GOOD_MSG2, id: "n4", callHex: c.callHex,
      feeQTC: codec.formatQTC(BigInt(c.callHex.length / 2 + 5302) * 100000n) }]).length === 1; })());
t("sanitizeVault drops a fee above the length band for the stored call",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "5" }]).length === 0);
t("sanitizeVault drops a fee below the length band",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "0.0001" }]).length === 0);
t("sanitizeVault drops a fee not divisible by the per-byte length fee",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "0.00053495" }]).length === 0);
t("sanitizeVault drops a non-canonical fee (trailing-zero fraction)",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "0.00053490" }]).length === 0);
t("sanitizeVault drops a non-canonical fee (leading-zero integer)",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "00.0005349" }]).length === 0);
t("sanitizeVault keeps a fee at the band maximum (ML-DSA-87 + widest nonce)",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "0.000731" }]).length === 1);
t("sanitizeVault drops a fee implying a 3-byte nonce (compact widths are 1, 2 or 4)",
  codec.sanitizeVault([{ ...GOOD, feeQTC: "0.0005351" }]).length === 0);
t("validFeeForCall pins the GOOD anchor's fee and rejects its neighbours",
  codec.validFeeForCall(GOOD.feeQTC, GOOD.callHex.length / 2) === true &&
  codec.validFeeForCall("0.0005353", GOOD.callHex.length / 2) === false &&
  codec.validFeeForCall("0.0007311", GOOD.callHex.length / 2) === false);
t("sanitizeVault drops a message anchor carrying a label (builds write null)",
  codec.sanitizeVault([{ ...GOOD_MSG2, label: "hi" }]).length === 0);
t("sanitizeVault dedupes duplicate callHex anchors, first wins",
  (() => { const v = codec.sanitizeVault([GOOD, { ...GOOD, id: "n9" }]);
    return v.length === 1 && v[0].id === "n1"; })());
t("sanitizeVault reassigns a duplicate id instead of dropping the anchor",
  (() => { const v = codec.sanitizeVault([GOOD, { ...GOOD_MSG2, id: "n1" }]);
    return v.length === 2 && v[0].id !== v[1].id; })());
t("sanitizeVault reassigns a non-producer id shape",
  (() => { const v = codec.sanitizeVault([{ ...GOOD, id: "<img src=x>" }]);
    return v.length === 1 && /^n-sanitized-\d+$/.test(v[0].id); })());
t("sanitizeVault caps the vault at MAX_VAULT_ENTRIES",
  (() => { const rows = [];
    for (let i = 0; i < 600; i++) { const c = codec.buildRemarkCall(codec.utf8ToBytes("m" + i), false);
      rows.push({ ...GOOD_MSG2, id: "n" + (1000 + i), callHex: c.callHex,
        feeQTC: codec.formatQTC(BigInt(c.callHex.length / 2 + 5302) * 100000n) }); }
    return codec.sanitizeVault(rows).length === codec.MAX_VAULT_ENTRIES; })());
t("vaultRoom reports the room left under the vault cap",
  codec.vaultRoom(0) === 500 && codec.vaultRoom(499) === 1 && codec.vaultRoom(250) === 250);
t("vaultRoom is zero at and past the cap (never negative)",
  codec.vaultRoom(500) === 0 && codec.vaultRoom(5000) === 0);
t("vaultRoom treats a non-finite or negative count as no room",
  codec.vaultRoom(NaN) === 0 && codec.vaultRoom("x") === 0 && codec.vaultRoom(-3) === 0);
t("sanitizeVault drops a future-dated anchor",
  codec.sanitizeVault([{ ...GOOD, created: new Date(Date.now() + 86400000).toISOString() }]).length === 0);
t("sanitizeVault drops a pre-launch anchor (before Sept 2026)",
  codec.sanitizeVault([{ ...GOOD, created: "2020-01-01T00:00:00.000Z" }]).length === 0);

t("events reject trailing bytes after the last record",
  codec.decodeSystemEvents(craftEvents().concat([0xaa])).ok === false);
t("events reject a Remarked record under the Finalization phase",
  codec.decodeSystemEvents([0x04, 0x01, 0x00, 0x05,
    ...new Array(32).fill(0x11), ...new Array(32).fill(0x22), 0x00]).ok === false);

/* --- hex-parse bound (white-hat track): hexToBytes used to strip,
 * regex-test and parseInt-loop the WHOLE string before any caller
 * checked a length, and its callers hand it untrusted strings: the
 * node's System.Events value + per-block extrinsics and the vault
 * sanitizer's stored callHex/envelopeHex on every load. A
 * 20,000,000-char string built a 10,000,000-byte array in ~584 ms in
 * Node. The cap sits above every legitimate input measured with the
 * codec's own producers: digest 64 chars, max envelope 210 chars,
 * max vault call 8,200 chars, largest signed ML-DSA-87 remark
 * extrinsic 22,728 chars (0x-prefixed), and a 7,000-record
 * System.Events blob at 1,008,006 chars (the cap admits 7,281
 * records). --- */
t("hexInputRoom at 0 is the whole cap",
  codec.hexInputRoom(0) === codec.MAX_HEX_INPUT_CHARS && codec.MAX_HEX_INPUT_CHARS === 1048576);
t("hexInputRoom arithmetic below the cap", codec.hexInputRoom(48576) === 1000000);
t("hexInputRoom is 0 at and past the cap",
  codec.hexInputRoom(1048576) === 0 && codec.hexInputRoom(2000000) === 0);
/* --- endpoint URL length gate (white-hat): the board's rpcUrl field
 * went straight to new WebSocket with no validation at all. Cap
 * 2,048 is >4x the largest genuine endpoint (hostname ≤253 per RFC
 * 1035 + scheme/port/path/key material well under 500 total). --- */
t("endpoint cap exported at 2,048", codec.MAX_ENDPOINT_URL_CHARS === 2048);
t("endpointUrlRoom fail-closed",
  codec.endpointUrlRoom(0) === 2048 && codec.endpointUrlRoom(2048) === 0 &&
  codec.endpointUrlRoom(2049) === 0 && codec.endpointUrlRoom(-1) === 0 &&
  codec.endpointUrlRoom(1.5) === 0 && codec.endpointUrlRoom("5") === 0 &&
  codec.endpointUrlRoom(NaN) === 0 && codec.endpointUrlRoom(undefined) === 0);
t("endpoint: genuine validates", codec.validateEndpointUrl("wss://rpc.quantus.network").ok === true);
t("endpoint: exactly-cap validates",
  (() => { const u = "ws://127.0.0.1:9944/" + "p".repeat(2048 - "ws://127.0.0.1:9944/".length); return u.length === 2048 && codec.validateEndpointUrl(u).ok; })());
t("endpoint: over-cap refused naming size + cap",
  (() => { const u = "ws://127.0.0.1:9944/" + "p".repeat(2049 - "ws://127.0.0.1:9944/".length); const r = codec.validateEndpointUrl(u); return !r.ok && /2049/.test(r.error) && /2048/.test(r.error); })());
t("endpoint: 20M-char paste refused before connecting",
  (() => { const r = codec.validateEndpointUrl("wss://" + "a".repeat(20000000)); return !r.ok && /20000006/.test(r.error); })());
t("endpoint: http/empty/non-string refused",
  !codec.validateEndpointUrl("https://example.com").ok && !codec.validateEndpointUrl("").ok && !codec.validateEndpointUrl(null).ok);
t("hexInputRoom fail-closed on NaN/negative/fraction/string/undefined/null/Infinity",
  codec.hexInputRoom(NaN) === 0 && codec.hexInputRoom(-1) === 0 &&
  codec.hexInputRoom(1.5) === 0 && codec.hexInputRoom("10") === 0 &&
  codec.hexInputRoom(undefined) === 0 && codec.hexInputRoom(null) === 0 &&
  codec.hexInputRoom(Infinity) === 0);
t("hexToBytes refuses a 2,000,002-char input unparsed",
  codec.hexToBytes("aa".repeat(1000001)) === null);
t("hexToBytes refuses cap+2 chars", codec.hexToBytes("a".repeat(1048578)) === null);
t("hexToBytes still parses exactly-cap input to 524,288 bytes",
  (() => { const b = codec.hexToBytes("ab".repeat(524288)); return Array.isArray(b) && b.length === 524288; })());
t("hexToBytes still parses a 0x-prefixed input at exactly the cap",
  (() => { const b = codec.hexToBytes("0x" + "ab".repeat(524287)); return Array.isArray(b) && b.length === 524287; })());
t("hexToBytes parses the largest envelope (210 chars) unchanged",
  (() => { const e = codec.buildEnvelope(1, new Array(32).fill(1), "x".repeat(64));
    return e.hex.length === 210 && JSON.stringify(codec.hexToBytes(e.hex)) === JSON.stringify(e.bytes); })());
t("hexToBytes parses the largest vault call (8,200 chars) unchanged",
  (() => { const c = codec.buildRemarkCall(new Array(4096).fill(0x61), true);
    const b = codec.hexToBytes(c.callHex); return c.callHex.length === 8200 && b && b.length === 4100; })());
t("a 7,000-record System.Events blob still parses and decodes under the cap",
  (() => { const rec = [0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x05,
      ...new Array(32).fill(0x11), ...new Array(32).fill(0x22), 0x00];
    const blob = codec.compactU32(7000).concat(Array.from({ length: 7000 }, () => rec).flat());
    const hex = "0x" + codec.bytesToHex(blob);
    if (hex.length > codec.MAX_HEX_INPUT_CHARS) return false;
    const d = codec.decodeSystemEvents(codec.hexToBytes(hex));
    return d.ok && d.records.length === 7000; })());
t("sanitizeVault drops an anchor whose callHex is over the hex cap",
  codec.sanitizeVault([{ ...GOOD_MSG2, callHex: "0007" + "aa".repeat(1000000) }]).length === 0);
t("hexToBytes still rejects malformed hex below the cap",
  codec.hexToBytes("zz") === null && codec.hexToBytes("abc") === null &&
  codec.hexToBytes(null) === null);

/* --- storage key --- */
const evKey = codec.systemEventsKey((b) => twox.twox128bytes(b));
t("System.Events key shape",
  evKey.startsWith("0x26aa394eea5630e07c48ae0c9558cef7") && evKey.length === 66, evKey);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
