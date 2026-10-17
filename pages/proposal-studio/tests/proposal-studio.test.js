/* QTC Proposal Studio — node test suite.
 * Every expectation is anchored to a verified source:
 *  - referendum #0's real indexer args (block 95606): note_preimage bytes,
 *    blake2b preimage hash, submit args (Origins>FastUpgrade, Lookup, After(0))
 *  - Quantus-Network/chain @ 482c5b9 (definitions.rs, configs/mod.rs,
 *    runtime/src/lib.rs, pallets/*)
 *  - Quantus-Network/quantus-apps metadata-generated Dart codecs
 *    (OriginCaller variants system=0x00/Origins=0x17, Bounded Lookup=0x02,
 *     DispatchTime At=0x00/After=0x01)
 */
const C = require("../js/gov-codec.js");
const CR = require("../js/vendor/scale-crypto.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function eq(name, got, want) {
  t(name, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}

// --- blake2b sanity: referendum #0's preimage hash is blake2b-256 of its bytes
const ref0bytes = CR.fromHex(C.REF0.noteBytes);
const h = CR.toHex(Array.from(CR.blake2b(new Uint8Array(ref0bytes), 32)));
eq("blake2b-256(#0 call bytes) = on-chain preimage hash", h, C.REF0.preimageHash);

// --- preimage economics: 34-byte call => 0.01 + 35*0.00001 = 0.01035 QTC
eq("preimage deposit 34B (plancks)", C.preimageDeposit(34).toString(), "10350000000");
eq("preimage deposit 34B (QTC)", C.qtc(C.preimageDeposit(34)), "0.01035");
eq("preimage deposit 4096B", C.qtc(C.preimageDeposit(4096)), "0.05097");
eq("submission deposit", C.qtc(C.SUBMISSION_DEPOSIT), "0.1");

// --- note_preimage encoding: 0700 ++ compact(34)=0x88 ++ bytes
const np = C.buildNotePreimage(ref0bytes);
eq("note_preimage hex", np.hex, "0700" + "88" + C.REF0.noteBytes);
eq("note_preimage sections", np.sections.length, 3);

// --- submit reconstruction: must equal the independently derived #0 bytes
const sub = C.buildSubmit(1, CR.fromHex(C.REF0.preimageHash), 34, { kind: "after", value: 0 });
eq("submit(#0) == reconstructed on-chain call", sub.hex, C.REF0.submitHex);
eq("submit origin bytes (FastUpgrade)", sub.hex.slice(4, 8), "1700");
eq("submit bounded discriminant (Lookup=0x02)", sub.hex.slice(8, 10), "02");
eq("submit enactment (After(0))", sub.hex.slice(-10), "01" + "00000000");

// --- Root origin encoding
const subRoot = C.buildSubmit(0, new Array(32).fill(0), 2, { kind: "at", value: 8000 });
eq("submit origin bytes (Root)", subRoot.hex.slice(4, 8), "0000");
eq("submit enactment At(8000)", subRoot.hex.slice(-10), "00" + "401f0000");

// --- place_decision_deposit / refunds / vote
eq("place_decision_deposit(0)", C.buildPlaceDecisionDeposit(0).hex, "0e01" + "00000000");
eq("place_decision_deposit(7)", C.buildPlaceDecisionDeposit(7).hex, "0e01" + "07000000");
eq("refund_submission_deposit(3)", C.buildRefundSubmissionDeposit(3).hex, "0e07" + "03000000");
eq("refund_decision_deposit(3)", C.buildRefundDecisionDeposit(3).hex, "0e02" + "03000000");
eq("collective vote aye", C.buildCollectiveVote(0, true).hex, "0d04" + "00000000" + "01");
eq("collective vote nay", C.buildCollectiveVote(12, false).hex, "0d04" + "0c000000" + "00");
eq("unnote_preimage", C.buildUnnotePreimage(CR.fromHex(C.REF0.preimageHash)).hex,
   "0701" + C.REF0.preimageHash);

// --- templates
eq("authorize_upgrade == #0 proposal bytes",
   C.tplAuthorizeUpgrade(CR.fromHex("78389c85e3698b7e24cf292907f2eec0657297fd8a4d82669cf357974f15ec56")).hex,
   C.REF0.noteBytes);
const rk = C.tplRemark("hello");
eq("remark('hello')", rk.hex, "0000" + "14" + "68656c6c6f"); // compact(5)=0x14
const zero32 = new Array(32).fill(0);
eq("set_treasury_account prefix", C.tplSetTreasuryAccount(zero32).hex.slice(0, 4), "0f00");
eq("set_treasury_account len", C.tplSetTreasuryAccount(zero32).hex.length, 68);
eq("add_member encoding", C.tplAddMember(zero32).hex, "0d00" + "00" + "00".repeat(32));

// --- compact edge cases (canonical SCALE)
eq("compact(0)", C.bytesToHex(C.compactU32(0)), "00");
eq("compact(63)", C.bytesToHex(C.compactU32(63)), "fc");
eq("compact(64)", C.bytesToHex(C.compactU32(64)), "0101");
eq("compact(16383)", C.bytesToHex(C.compactU32(16383)), "fdff");

// --- track constants (definitions.rs)
const t0 = C.TRACKS[0], t1 = C.TRACKS[1];
eq("track0 prepare blocks", t0.prepare, 600);
eq("track0 decision/confirm/minEnactment", [t0.decision, t0.confirm, t0.minEnactment].join(","), "7200,7200,7200");
eq("track0 curves", t0.approval + "/" + t0.support, "61/60");
eq("track1 prepare", t1.prepare, 50);
eq("track1 confirm/minEnactment", [t1.confirm, t1.minEnactment].join(","), "50,50");
eq("track1 curves", t1.approval + "/" + t1.support, "80/80");
eq("track1 origin bytes", t1.originBytes, "1700");
eq("both decision deposits 0.1 QTC", C.qtc(t0.decisionDeposit) + "/" + C.qtc(t1.decisionDeposit), "0.1/0.1");

// --- caps (configs/mod.rs)
eq("caps", [C.CAPS.maxActive, C.CAPS.maxPerAccount, C.CAPS.maxQueued, C.CAPS.undecidingTimeout].join(","), "128,8,100,324000");
eq("max proposal bytes", C.MAX_PROPOSAL, 4096);
eq("member bounds", C.MIN_MEMBERS + "/" + C.MAX_MEMBERS, "5/13");

// --- proposal inspection
const insp = C.inspectCall(C.REF0.noteBytes);
eq("inspect #0 ok", insp.ok, true);
eq("inspect #0 pallet/call", insp.palletName + "." + insp.callName, "System.authorize_upgrade");
t("inspect rejects >4KiB", !C.inspectCall("00".repeat(4097)).ok);
t("inspect accepts exactly 4KiB", C.inspectCall("00".repeat(4096)).ok);
t("inspect rejects bad hex", !C.inspectCall("zz").ok);
const insp2 = C.inspectCall("0500" + "00".repeat(10));
eq("inspect unknown pallet label", insp2.palletName, "pallet 5 (not in the studio's verified table)");
eq("inspect unknown call known=false", insp2.known, false);

// --- lifecycle model
const lc = C.lifecycle(1);
eq("lifecycle steps", lc.length, 5);
t("lifecycle mentions decision deposit", lc[2].detail.includes("0.1"));
t("lifecycle step1 mentions preimage-first rule", lc[0].detail.includes("MUST exist"));

// --- clock helper
eq("600 blocks ~ 2h", C.blocksToClock(600), "2h");
eq("50 blocks ~ 10m", C.blocksToClock(50), "10m");
eq("7200 blocks ~ 24h", C.blocksToClock(7200), "24h");

// --- draft vault sanitizer: both load paths (localStorage + JSON import)
// are untrusted. A poisoned entry used to crash renderVault (numeric
// created.slice, null checks[i], lifecycle(unknown track)) and the pack
// builders (hexToBytes(bad callHex) -> null.length), and the import path
// persisted the poison so every later visit crashed the same way.
const hashOf = (bytes) => CR.toHex(Array.from(CR.blake2b(new Uint8Array(bytes), 32)));
const goodDraft = {
  id: "d1", name: "Ref0 replay", notes: "note", trackId: 1,
  callHex: C.REF0.noteBytes, callName: "System.authorize_upgrade",
  hash: C.REF0.preimageHash, enactKind: "after", enactVal: 0,
  created: "2026-10-01T00:00:00.000Z", checks: [true, false, true, false, false]
};
const kept = C.sanitizeDrafts([goodDraft], hashOf);
eq("sanitizer keeps a well-formed draft (hash relation holds)", kept.length, 1);
eq("sanitizer preserves checks", JSON.stringify(kept[0].checks), "[true,false,true,false,false]");
eq("sanitizer preserves id/track", kept[0].id + "/" + kept[0].trackId, "d1/1");
t("sanitizer: non-array inputs -> []",
  [null, undefined, {}, "x", 42].every((v) => Array.isArray(C.sanitizeDrafts(v, hashOf)) && C.sanitizeDrafts(v, hashOf).length === 0));
t("sanitizer: non-object entries dropped",
  C.sanitizeDrafts([null, 42, "x", [1], goodDraft], hashOf).length === 1);
// hash relation: hash must be blake2b-256 of the call bytes
const wrongHash = Object.assign({}, goodDraft, { id: "d2", hash: "0".repeat(64) });
eq("sanitizer drops hash/call mismatch", C.sanitizeDrafts([wrongHash], hashOf).length, 0);
eq("sanitizer without hashOf keeps shape-valid hash", C.sanitizeDrafts([wrongHash]).length, 1);
t("sanitizer drops non-hex / short hash",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { hash: "zz" })], hashOf).length === 0);
// call shape: valid hex, 2..4096 bytes
t("sanitizer drops bad-hex call", C.sanitizeDrafts([Object.assign({}, goodDraft, { callHex: "zzzz" })], hashOf).length === 0);
t("sanitizer drops 1-byte call", C.sanitizeDrafts([Object.assign({}, goodDraft, { callHex: "00", hash: hashOf([0]) })], hashOf).length === 0);
const bigCall = new Array(4097).fill(0);
t("sanitizer drops over-cap (4097B) call",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { trackId: 0, callHex: C.bytesToHex(bigCall), hash: hashOf(bigCall) })], hashOf).length === 0);
const maxCall = new Array(4096).fill(0);
eq("sanitizer keeps exactly-4KiB call",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { trackId: 0, callHex: C.bytesToHex(maxCall), hash: hashOf(maxCall) })], hashOf).length, 1);
// track relation: lifecycle/buildSubmit index TRACKS[trackId]
t("sanitizer drops unknown/string track",
  [99, -1, "1", null].every((tr) => C.sanitizeDrafts([Object.assign({}, goodDraft, { trackId: tr })], hashOf).length === 0));
// field hardening on a kept entry
const messy = C.sanitizeDrafts([Object.assign({}, goodDraft, {
  id: "d3", name: 42, notes: 7, created: 12345, checks: null, enactKind: "whenever", enactVal: -5
})], hashOf);
eq("sanitizer: numeric name falls back to callName", messy[0].name, "System.authorize_upgrade");
eq("sanitizer: numeric notes -> empty", messy[0].notes, "");
eq("sanitizer: numeric created -> empty (render prints 'date unknown')", messy[0].created, "");
eq("sanitizer: null checks -> 5 falses", JSON.stringify(messy[0].checks), "[false,false,false,false,false]");
eq("sanitizer: garbage enactKind -> after", messy[0].enactKind, "after");
eq("sanitizer: negative enactVal -> 0", messy[0].enactVal, 0);
const partialChecks = C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "d4", checks: [true, "yes", 1] })], hashOf);
eq("sanitizer: only strict true survives in checks", JSON.stringify(partialChecks[0].checks), "[true,false,false,false,false]");
// id dedupe: delete/load match on id, so duplicates must not survive
const dupes = C.sanitizeDrafts([goodDraft, Object.assign({}, goodDraft, { name: "copy" })], hashOf);
eq("sanitizer dedupes ids", new Set(dupes.map((d) => d.id)).size, 2);
// --- draft vault relations round (2026-10-13): values no producer writes
// callName is DERIVED from callHex (the composer sets it from the built
// template / inspectCall); a stored name that disagrees is replaced.
const relabeled = C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r1", callName: "TreasuryPallet.set_treasury_account" })], hashOf);
eq("relations: stored callName re-derived from the call bytes", relabeled[0].callName, "System.authorize_upgrade");
const relabeledFallback = C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r2", callName: "Evil.fake", name: 42 })], hashOf);
eq("relations: name fallback uses the derived callName", relabeledFallback[0].name, "System.authorize_upgrade");
// track relation: track 1 (fast_upgrade) honors authorize_upgrade only —
// the composer locks the template; any other call on track 1 never executes.
const remarkCall = C.tplRemark("hello quantus");
eq("relations: track-1 remark draft dropped",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r3", trackId: 1, callHex: remarkCall.hex, callName: remarkCall.name, hash: hashOf(remarkCall.bytes) })], hashOf).length, 0);
eq("relations: track-0 remark draft kept",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r4", trackId: 0, callHex: remarkCall.hex, callName: remarkCall.name, hash: hashOf(remarkCall.bytes) })], hashOf).length, 1);
const upgCall = C.tplAuthorizeUpgrade(new Array(32).fill(7));
eq("relations: track-1 upgrade draft kept",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r5", trackId: 1, callHex: upgCall.hex, callName: upgCall.name, hash: hashOf(upgCall.bytes) })], hashOf).length, 1);
// created window: dv-save stamps new Date().toISOString()
eq("relations: pre-launch created -> empty",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r6", created: "2020-01-01T00:00:00.000Z" })], hashOf)[0].created, "");
eq("relations: future created -> empty",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r7", created: "2999-01-01T00:00:00.000Z" })], hashOf)[0].created, "");
eq("relations: plausible created kept verbatim",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "r8" })], hashOf)[0].created, "2026-10-01T00:00:00.000Z");

// cap
const many = Array.from({ length: 150 }, (_, i) => Object.assign({}, goodDraft, { id: "m" + i }));
eq("sanitizer caps at MAX_DRAFTS", C.sanitizeDrafts(many, hashOf).length, C.MAX_DRAFTS);

// --- draftRoom creation gate: sanitizeDrafts enforces the cap only at
// load, so dv-save's unshift and dv-import's concat ask this gate first —
// an uncapped create persisted past the cap and the next load silently
// evicted the tail (oldest draft on save; every existing draft past the
// cap on import) under a success message.
eq("draftRoom(0) = full cap", C.draftRoom(0), 100);
eq("draftRoom(99) = 1", C.draftRoom(99), 1);
eq("draftRoom(100) = 0", C.draftRoom(100), 0);
eq("draftRoom(5000) = 0 (never negative)", C.draftRoom(5000), 0);
eq("draftRoom(NaN) = 0 (fail-closed)", C.draftRoom(NaN), 0);
eq("draftRoom('x') = 0 (fail-closed)", C.draftRoom("x"), 0);
eq("draftRoom(undefined) = 0 (fail-closed)", C.draftRoom(undefined), 0);
eq("draftRoom(-3) = 0", C.draftRoom(-3), 0);
eq("draftRoom(99.9) floors", C.draftRoom(99.9), 1);

// --- fileRoom file-pick gate: both file inputs used to read and
// Array.from-convert the whole picked file before any size check ran
// (the wasm path had no cap at all); File.size is known before a byte
// is read, so over-cap picks are now refused unread.
eq("fileRoom: wasm cap is 16 MiB", C.MAX_WASM_BYTES, 16 * 1024 * 1024);
eq("fileRoom(4096, MAX_PROPOSAL) at cap passes", C.fileRoom(4096, C.MAX_PROPOSAL), true);
eq("fileRoom(4097, MAX_PROPOSAL) over cap fails", C.fileRoom(4097, C.MAX_PROPOSAL), false);
eq("fileRoom(16 MiB, MAX_WASM_BYTES) at cap passes", C.fileRoom(C.MAX_WASM_BYTES, C.MAX_WASM_BYTES), true);
eq("fileRoom(16 MiB + 1, MAX_WASM_BYTES) fails", C.fileRoom(C.MAX_WASM_BYTES + 1, C.MAX_WASM_BYTES), false);
eq("fileRoom(0) passes (empty file reaches the normal empty path)", C.fileRoom(0, C.MAX_PROPOSAL), true);
eq("fileRoom(NaN) fail-closed", C.fileRoom(NaN, 4096), false);
eq("fileRoom(-1) fail-closed", C.fileRoom(-1, 4096), false);
eq("fileRoom('100') fail-closed (no string coercion)", C.fileRoom("100", 4096), false);
eq("fileRoom(size, NaN cap) fail-closed", C.fileRoom(100, NaN), false);
eq("fileRoom(undefined) fail-closed", C.fileRoom(undefined, 4096), false);

// --- draftFileRoom draft-vault file gate: dv-import used to readAsText
// and JSON.parse the WHOLE picked file before sanitizeDrafts was
// consulted; the sanitizer's own producer bound (100 drafts, bounded
// fields) makes every larger file guaranteed-sanitized-away, so the
// import now refuses over-cap picks unread.
eq("draftFileRoom: cap is 4 MiB", C.MAX_DRAFT_FILE_BYTES, 4 * 1024 * 1024);
eq("draftFileRoom(at cap) passes", C.draftFileRoom(C.MAX_DRAFT_FILE_BYTES), true);
eq("draftFileRoom(cap + 1) fails", C.draftFileRoom(C.MAX_DRAFT_FILE_BYTES + 1), false);
eq("draftFileRoom(0) passes", C.draftFileRoom(0), true);
eq("draftFileRoom(NaN) fail-closed", C.draftFileRoom(NaN), false);
eq("draftFileRoom(-1) fail-closed", C.draftFileRoom(-1), false);
eq("draftFileRoom('1024') fail-closed (no string coercion)", C.draftFileRoom("1024"), false);
eq("draftFileRoom(undefined) fail-closed (sizeless file)", C.draftFileRoom(undefined), false);
eq("draftFileRoom(null) fail-closed", C.draftFileRoom(null), false);
eq("draftFileRoom(Infinity) fail-closed", C.draftFileRoom(Infinity), false);
{
  const maxCallB = new Array(4096).fill(0xab); maxCallB[0] = 0; maxCallB[1] = 0;
  const mkMax = (fill) => Array.from({ length: 100 }, (_, i) => ({
    id: (fill.repeat(60) + String(i).padStart(4, "0")).slice(0, 64),
    name: fill.repeat(120), notes: fill.repeat(2000), trackId: 0,
    callHex: C.bytesToHex(maxCallB), hash: hashOf(maxCallB), enactKind: "after",
    enactVal: 4294967295, created: "2026-10-01T00:00:00.000Z",
    checks: [true, true, true, true, true]
  }));
  const plainMax = C.sanitizeDrafts(mkMax("a"), hashOf);
  eq("producer-maximum plain draft vault fits the gate",
    C.draftFileRoom(Buffer.byteLength(JSON.stringify(plainMax, null, 2))), true);
  const escMax = C.sanitizeDrafts(mkMax(""), hashOf);
  eq("producer-maximum worst-escaping draft vault fits the gate",
    C.draftFileRoom(Buffer.byteLength(JSON.stringify(escMax, null, 2))), true);
}

// --- hexInputRoom hex-parse bound: hexToBytes used to strip, regex-test
// and parseInt-loop the whole string before any caller checked a length,
// and its live callers parse on every keystroke (pd-hex, inspectCall via
// the composer's custom path) while inspectCall/sanitizeDrafts bound
// only the parsed result. The largest legitimate input is a 4,096-byte
// proposal: 8,194 chars plain, 12,289 chars byte-spaced (measured above
// with this codec's own helpers) — a 16,384-char cap admits both.
eq("hexbound: cap is 16,384 chars", C.MAX_HEX_INPUT_CHARS, 16384);
eq("hexbound: room(0) = cap", C.hexInputRoom(0), 16384);
eq("hexbound: room(cap) = 0", C.hexInputRoom(16384), 0);
eq("hexbound: room(cap+1) = 0", C.hexInputRoom(16385), 0);
eq("hexbound: room(NaN) fail-closed", C.hexInputRoom(NaN), 0);
eq("hexbound: room(-1) fail-closed", C.hexInputRoom(-1), 0);
eq("hexbound: room(2.5) fail-closed", C.hexInputRoom(2.5), 0);
eq("hexbound: room('100') fail-closed", C.hexInputRoom("100"), 0);
eq("hexbound: room(undefined) fail-closed", C.hexInputRoom(undefined), 0);
eq("hexbound: room(null) fail-closed", C.hexInputRoom(null), 0);
eq("hexbound: room(Infinity) fail-closed", C.hexInputRoom(Infinity), 0);
t("hexbound: cap+2 chars refused unparsed (null)", C.hexToBytes("ab".repeat(8193)) === null);
t("hexbound: 2,000,000 chars refused unparsed (null)", C.hexToBytes("ab".repeat(1000000)) === null);
eq("hexbound: exactly-cap 16,384 chars still parses", C.hexToBytes("ab".repeat(8192)).length, 8192);
t("hexbound: byte-spaced max proposal still inspects ok", C.inspectCall(maxSpacedHex()).ok);
t("hexbound: inspectCall over-cap names the cap", /too long/.test(C.inspectCall("ab".repeat(1000000)).error) && C.inspectCall("ab".repeat(1000000)).error.includes("16384"));
t("hexbound: sanitizer drops an over-cap callHex draft",
  C.sanitizeDrafts([Object.assign({}, goodDraft, { id: "hx1", callHex: "ab".repeat(10000) })], hashOf).length === 0);
function maxSpacedHex() {
  const mc = new Array(4096).fill(0); mc[0] = 0; mc[1] = 9;
  return "0x" + mc.map((b) => ("0" + b.toString(16)).slice(-2)).join(" ");
}

console.log(pass + "/" + (pass + fail) + " proposal-studio tests green");
process.exit(fail ? 1 : 0);
