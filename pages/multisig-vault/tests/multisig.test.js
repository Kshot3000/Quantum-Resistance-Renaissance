/* QTC MultiSig Vault — node unit tests.
 * Run: node tests/multisig.test.js
 * Derivation vectors generated with Python hashlib.blake2b (independent impl).
 */
const C = require("../js/msig-core.js");

let pass = 0, fail = 0;
function ok(cond, name, extra){
  if (cond){ pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function eq(a, b, name){ ok(a === b, name, "got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }

/* --- derivation vectors (Python hashlib.blake2b, digest_size=32) --- */
const V1_SIGNERS = ["00".repeat(32), "ff".repeat(32)];
const V1_EXPECT = "752dd0c31ec3a927e102f68266f020c22c3753238c4599f66b07f3e010aafc0f";
const V2_SIGNERS = ["ab".repeat(32), "11".repeat(32), "cd".repeat(32)];
const V2_EXPECT = "99b81d7e80aaf6020fed1d9d50b63a158eb2783b0cd93b76d801587bb2a42621";
const V3_SIGNERS = ["0123456789abcdef".repeat(4), "fedcba9876543210".repeat(4)];
const V3_EXPECT = "3f5bd23686bd08049f6db51422845d67de64a6ab671b70dd8e9634dc911d0658";

let r1 = C.deriveMultisigAddress(V1_SIGNERS, 2, 0);
ok(r1.ok, "V1 ok");
eq(r1.hex, V1_EXPECT, "V1 digest matches Python vector");

let r2 = C.deriveMultisigAddress(V2_SIGNERS, 1, 7);
ok(r2.ok, "V2 ok");
eq(r2.hex, V2_EXPECT, "V2 digest matches Python vector");

let r3 = C.deriveMultisigAddress(V3_SIGNERS, 1, "18446744073709551615");
ok(r3.ok, "V3 ok (u64 max nonce)");
eq(r3.hex, V3_EXPECT, "V3 digest matches Python vector");

/* order-independence: chain sorts signers before hashing */
let r2b = C.deriveMultisigAddress(V2_SIGNERS.slice().reverse(), 1, 7);
eq(r2b.ss58, r2.ss58, "signer order does not change the address");
eq(r2.sortedHex.join(","), ["11".repeat(32), "ab".repeat(32), "cd".repeat(32)].join(","), "sorted lexicographically");

/* SS58 of a derived address: prefix 189, checksum verifies, key round-trips */
let d1 = C.ss58Decode(r1.ss58);
ok(d1.ok && d1.prefix === 189, "derived SS58 prefix 189 + checksum ok");
eq(C.toHex(d1.key), V1_EXPECT, "derived SS58 key = digest");
ok(!C.ss58Decode("KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC").ok, "rejects reserved prefix form (0xBD, fake 189)");
ok(!C.ss58Decode("LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ").ok, "rejects reserved prefix form (0xC0, fake 192)");
ok(C.ss58Decode("z".repeat(20000)).kind === "length", "rejects 20,000-char input as length before decoding (quadratic decoder DoS bound)");

/* validation */
ok(!C.deriveMultisigAddress([V1_SIGNERS[0]], 1, 0).ok, "rejects <2 signers");
ok(!C.deriveMultisigAddress([V1_SIGNERS[0], V1_SIGNERS[0]], 1, 0).ok, "rejects duplicates");
ok(!C.deriveMultisigAddress(V1_SIGNERS, 3, 0).ok, "rejects threshold > signers");
ok(!C.deriveMultisigAddress(V1_SIGNERS, 0, 0).ok, "rejects threshold 0");
ok(!C.deriveMultisigAddress(new Array(101).fill("01".repeat(32)), 2, 0).ok, "rejects >100 signers");
ok(!C.deriveMultisigAddress(["zz"], 1, 0).ok, "rejects bad hex");
ok(!C.deriveMultisigAddress(V1_SIGNERS, 1, -1).ok, "rejects negative nonce");

/* proposal fee: base + Permill(1%).mul_floor(base * n) — exact BigInt math */
eq(C.proposalFeePlancks(1).toString(), "50500000000", "fee n=1 -> 0.0505 QTC");
eq(C.proposalFeePlancks(2).toString(), "51000000000", "fee n=2 -> 0.051 QTC");
eq(C.proposalFeePlancks(3).toString(), "51500000000", "fee n=3 -> 0.0515 QTC");
eq(C.proposalFeePlancks(100).toString(), "100000000000", "fee n=100 -> 0.1 QTC");
let lb = C.lifecycleBudget(3);
eq(lb.createFee.toString(), "30000000000", "create fee 0.03 QTC");
eq(lb.proposalDeposit.toString(), "10000000000", "proposal deposit 0.01 QTC");
eq(lb.totalOutlay.toString(), (30000000000n + 51500000000n + 10000000000n).toString(), "lifecycle total");

/* money */
eq(C.qtcToPlancks("0.0515").toString(), "51500000000", "qtc->plancks 0.0515");
eq(C.qtcToPlancks("1").toString(), "1000000000000", "qtc->plancks 1");
eq(C.plancksToQtc(51500000000n), "0.0515", "plancks->qtc");
eq(C.plancksToQtc(C.qtcToPlancks("123.456789")), "123.456789", "money round-trip");
ok(C.qtcToPlancks("abc") === null, "rejects bad amount");
eq(C.qtcToPlancks("21000000").toString(), "21000000000000000000", "qtc->plancks exactly the 21M supply cap stays valid");
ok(C.qtcToPlancks("21000000.000000000001") === null, "rejects 1 planck over the supply cap");
ok(C.qtcToPlancks("25000000") === null, "rejects amount over the supply cap");

/* SCALE compact */
eq(C.toHex(C.compactU128(0n)), "00", "compact 0");
eq(C.toHex(C.compactU128(63n)), "fc", "compact 63");
eq(C.toHex(C.compactU128(64n)), "0101", "compact 64");
eq(C.toHex(C.compactU128(16383n)), "fdff", "compact 16383");
eq(C.toHex(C.compactU128(16384n)), "02000100", "compact 16384");
eq(C.toHex(C.compactU128(1000000000000n)), "070010a5d4e8", "compact 1e12 (1 QTC)");

// independent compact decode sanity: 0x07 prefix => 5 LE bytes = 0xE8D4A51000
{
  const b = C.compactU128(1000000000000n);
  ok(b[0] === 0x07 && b.length === 6, "compact 1e12 length");
  let v = 0n;
  for (let i = b.length - 1; i >= 1; i--) v = (v << 8n) | BigInt(b[i]);
  eq(v.toString(), "1000000000000", "compact 1e12 LE bytes decode");
}

/* inner calls: pallet 2, calls 3/4, MultiAddress::Id = 0x00 */
const DEST = "11".repeat(32);
let tka = C.encodeTransferKeepAlive(DEST, 1000000000000n);
ok(tka.ok, "transfer_keep_alive ok");
eq(tka.hex.slice(0, 6), "020300", "tka = pallet 2 / call 3 / MultiAddress::Id");
eq(tka.hex.slice(6, 70), DEST, "tka dest bytes");
eq(tka.hex.slice(70), "070010a5d4e8", "tka compact 1 QTC");
let ta = C.encodeTransferAll(DEST, true);
ok(ta.ok, "transfer_all ok");
eq(ta.hex, "0204" + "00" + DEST + "01", "transfer_all keep_alive=true bytes");
let ta2 = C.encodeTransferAll(DEST, false);
eq(ta2.hex.slice(-2), "00", "transfer_all keep_alive=false byte");
ok(!C.encodeTransferKeepAlive("zz", 1n).ok, "rejects bad dest");
ok(!C.encodeTransferKeepAlive(DEST, 0n).ok, "rejects zero amount");

/* multisig extrinsic payloads: pallet 19 + call index, SCALE args */
let ms = r1.hex, callHex = tka.hex;
let p = C.encodePropose(ms, callHex, 200000);
ok(p.ok, "propose ok");
eq(p.hex.slice(0, 4), "1301", "propose = 0x13 0x01");
eq(p.hex.slice(4, 68), ms, "propose multisig bytes");
{ // next: compact len of inner call, then inner call bytes
  const innerBytes = callHex.length / 2;
  const prefix = C.toHex(C.compactU128(BigInt(innerBytes)));
  eq(p.hex.slice(68, 68 + prefix.length), prefix, "propose call length prefix");
  eq(p.hex.slice(68 + prefix.length, 68 + prefix.length + callHex.length), callHex, "propose inner call bytes");
  // trailing: u32 LE expiry
  eq(p.hex.slice(-8), "400d0300", "propose expiry 200000 LE");
}
let ap = C.encodeApprove(ms, 7, callHex);
ok(ap.ok, "approve ok");
eq(ap.hex.slice(0, 4), "1302", "approve = 0x13 0x02");
eq(ap.hex.slice(4, 68), ms, "approve multisig bytes");
eq(ap.hex.slice(68, 76), "07000000", "approve proposal_id 7 LE");
let cx = C.encodeCancel(ms, 7);
eq(cx.hex, "1303" + ms + "07000000", "cancel bytes exact");
let re = C.encodeRemoveExpired(ms, 41);
eq(re.hex, "1304" + ms + "29000000", "remove_expired bytes exact");
let cd = C.encodeClaimDeposits(ms);
eq(cd.hex, "1305" + ms, "claim_deposits bytes exact");
let ex = C.encodeExecute(ms, 7, callHex);
ok(ex.ok && ex.hex.slice(0, 4) === "1306", "execute = 0x13 0x06");
let cm = C.encodeCreateMultisig(V1_SIGNERS, 2, 0);
ok(cm.ok, "create_multisig ok");
eq(cm.hex.slice(0, 4), "1300", "create_multisig = 0x13 0x00");
eq(cm.derived.ss58, r1.ss58, "create payload derives same address");

/* nonce must never throw: a bad nonce used to raise inside deriveVault's
 * input handler, leaving the PREVIOUS vault address on screen */
["-", "1.5", "abc", "1e3", "0x10", "", " "].forEach(function(n){
  let r;
  try { r = C.deriveMultisigAddress(V1_SIGNERS, 2, n); }
  catch (e) { r = { ok: true, error: "THREW " + e.message }; }
  ok(!r.ok, "rejects nonce " + JSON.stringify(n) + " without throwing", r.error);
});
ok(!C.deriveMultisigAddress(V1_SIGNERS, 2, 1.5).ok, "rejects fractional numeric nonce");
ok(!C.deriveMultisigAddress(V1_SIGNERS, 2, NaN).ok, "rejects NaN nonce");
eq(C.deriveMultisigAddress(V1_SIGNERS, 2, "42").nonce, "42", "accepts decimal-string nonce");
eq(C.deriveMultisigAddress(V1_SIGNERS, 2, 42).nonce, "42", "accepts numeric nonce");
eq(C.deriveMultisigAddress(V1_SIGNERS, 2, 42n).nonce, "42", "accepts BigInt nonce");
ok(!C.deriveMultisigAddress(V1_SIGNERS, 2, "18446744073709551616").ok, "rejects nonce > u64 max");

/* u32 arguments must never wrap silently in a payload */
ok(!C.encodeApprove(ms, 4294967296, callHex).ok, "approve rejects proposal id 2^32 (was: wrapped to 0)");
ok(!C.encodeApprove(ms, 4294967297, callHex).ok, "approve rejects proposal id 2^32+1 (was: wrapped to 1)");
ok(!C.encodeApprove(ms, -1, callHex).ok, "approve rejects negative proposal id");
ok(!C.encodeApprove(ms, 1.5, callHex).ok, "approve rejects fractional proposal id");
ok(C.encodeApprove(ms, 4294967295, callHex).ok, "approve accepts u32-max proposal id");
ok(!C.encodeCancel(ms, 4294967296).ok, "cancel rejects proposal id 2^32");
ok(!C.encodeRemoveExpired(ms, -1).ok, "remove_expired rejects negative proposal id");
ok(!C.encodeExecute(ms, 4294967296, callHex).ok, "execute rejects proposal id 2^32");
ok(!C.encodePropose(ms, callHex, 4294967390).ok, "propose rejects expiry > u32 max (was: encoded as block 94)");
ok(C.encodePropose(ms, callHex, 4294967295).ok, "propose accepts u32-max expiry");
eq(C.expiryBlockNow(4294967290, 100), 4294967390, "expiryBlockNow does not wrap the sum the UI displays");

/* expiry helpers */
eq(C.blocksToHuman(100800), "14d 0h", "max expiry = 14 days");
eq(C.blocksToHuman(7200), "1d 0h", "7200 blocks = 1 day");
eq(C.expiryBlockNow(150000, 7200), 157200, "expiry block math");
eq(C.MAX_EXPIRY_DURATION, 100800, "max expiry constant");
eq(C.PALLET_INDEX, 19, "pallet index constant");

/* --- optional vault service fee (disclosed, ON TOP — profit mandate) ---
 * A vault payout is the recipient's money (a promise), so the fee is never
 * split out of it: recipient leg passes through untouched, and the fee is a
 * SECOND transfer_keep_alive to the builder's QTC address, wrapped with the
 * recipient leg in one atomic Utility.batch_all (pallet 9, call 2 — the
 * Quantus fork exposes only batch_all; encoding verified against the
 * Extrinsic Lab's fleet-verified batch sample: [9, 2, compact(n), calls…]). */
eq(C.SERVICE_FEE_ADDRESS, "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau", "service fee address pin");
{
  const fd = C.ss58Decode(C.SERVICE_FEE_ADDRESS);
  ok(fd.ok && fd.prefix === 189 && fd.key.length === 32, "service fee address is SS58-189, 32-byte key");
  eq(C.toHex(fd.key), "88714241713efd0732437b5a44f8541f69310374de19cc539700caf09d00354c", "service fee key hex pin");
  eq(C.SERVICE_FEE_KEY_HEX, "88714241713efd0732437b5a44f8541f69310374de19cc539700caf09d00354c", "core fee key hex matches address");
}
eq(C.SERVICE_FEE_MAX_BPS, 100, "service fee capped at 100 bps");
eq(C.UTILITY_PALLET_INDEX, 9, "utility pallet index 9");
eq(C.BATCH_ALL_CALL_IDX, 2, "batch_all call index 2");

/* fee math: floor(total * bps / 10,000), never over the quote */
eq(C.computeServiceFee(1000000000000n, 50).feePlancks.toString(), "5000000000", "fee 0.5% of 1 QTC = 0.005 QTC");
eq(C.computeServiceFee(1000000000000n, 50).feeBps, 50, "fee bps restated");
eq(C.computeServiceFee(199n, 50).feePlancks.toString(), "0", "fee floors to zero on a tiny total");
eq(C.computeServiceFee(1000000000000n, 500).feePlancks.toString(), "10000000000", "fee bps capped at 100 (1%)");
eq(C.computeServiceFee(1000000000000n, -5).feePlancks.toString(), "0", "negative bps = no fee");
eq(C.computeServiceFee(0n, 50).feePlancks.toString(), "0", "zero total = no fee");
for (const [tot, bps] of [[123456789012345n, 25], [999999999999n, 100], [5000000000000n, 50], [7n, 100]]) {
  const f = C.computeServiceFee(tot, bps);
  eq(f.feePlancks.toString(), ((tot * BigInt(Math.min(bps, 100))) / 10000n).toString(),
     "fee sweep floor tot=" + tot + " bps=" + bps);
  ok(f.feePlancks * 10000n <= tot * BigInt(Math.min(bps, 100)), "fee never exceeds quoted % tot=" + tot);
}
eq(C.feeBpsLabel(0), "0%", "label 0");
eq(C.feeBpsLabel(25), "0.25%", "label 25");
eq(C.feeBpsLabel(50), "0.5%", "label 50");
eq(C.feeBpsLabel(100), "1%", "label 100");

/* batch_all encoding: [9, 2, compact(count), call bytes concatenated] */
{
  const c1 = C.encodeTransferKeepAlive(DEST, 1000000000000n).hex;
  const c2 = C.encodeTransferKeepAlive(DEST, 2000000000000n).hex;
  const b = C.encodeBatchAll([c1, c2]);
  ok(b.ok, "batch_all ok");
  eq(b.hex, "0902" + "08" + c1 + c2, "batch_all bytes exact (compact 2 = 0x08)");
  eq(b.kind, "batch_all", "batch_all kind");
  ok(!C.encodeBatchAll([]).ok, "batch_all rejects empty");
  ok(!C.encodeBatchAll(["zz"]).ok, "batch_all rejects bad hex");
  ok(!C.encodeBatchAll([c1]).ok === false, "batch_all accepts a single call");
}

/* payout builder: no fee -> the plain single transfer, byte-identical */
{
  const plain = C.encodeTransferKeepAlive(DEST, 1000000000000n);
  const p0 = C.encodePayoutWithServiceFee(DEST, 1000000000000n, 0);
  ok(p0.ok, "payout no-fee ok");
  eq(p0.inner.hex, plain.hex, "no-fee payout is the plain transfer_keep_alive");
  eq(p0.feePlancks.toString(), "0", "no-fee payout fee 0");
  eq(p0.totalOutflowPlancks.toString(), "1000000000000", "no-fee outflow = amount");
  const pTiny = C.encodePayoutWithServiceFee(DEST, 100n, 25);
  ok(pTiny.ok && pTiny.feePlancks === 0n && pTiny.inner.hex === C.encodeTransferKeepAlive(DEST, 100n).hex,
     "fee floored to zero adds NO second transfer (a 0-planck transfer is invalid)");
}
/* payout builder: fee on -> atomic batch of [recipient untouched, fee last] */
{
  const p = C.encodePayoutWithServiceFee(DEST, 1000000000000n, 50);
  ok(p.ok, "payout fee ok");
  eq(p.feePlancks.toString(), "5000000000", "payout fee 0.005 QTC at 0.5%");
  eq(p.feeBps, 50, "payout fee bps");
  eq(p.totalOutflowPlancks.toString(), "1005000000000", "vault outflow = recipient + fee (fee ON TOP)");
  const recipLeg = C.encodeTransferKeepAlive(DEST, 1000000000000n).hex;
  const feeLeg = C.encodeTransferKeepAlive(C.SERVICE_FEE_KEY_HEX, 5000000000n).hex;
  eq(p.inner.hex, "0902" + "08" + recipLeg + feeLeg, "batch = recipient leg untouched, fee leg LAST");
  eq(p.inner.kind, "batch_all", "fee payout inner kind batch_all");
  ok(p.inner.hex.indexOf(feeLeg) > p.inner.hex.indexOf(recipLeg), "fee leg follows recipient leg");
  ok(!C.encodePayoutWithServiceFee("zz", 1000000000000n, 50).ok, "payout rejects bad recipient");
  ok(!C.encodePayoutWithServiceFee(DEST, 0n, 50).ok, "payout rejects zero amount");
}

/* board sanitizer: shape floor + producer relations (2026-10-13).
 * sanitizeBoard moved from app.js into the core so it is testable here;
 * app.js loadBoard routes through it and persists the clean copy. */
{
  const VAULT1 = C.deriveMultisigAddress(V1_SIGNERS, 2, 0).ss58;
  const VAULT2 = C.deriveMultisigAddress(V2_SIGNERS, 2, 7).ss58;
  const good = { vault: VAULT1, id: 3, callHex: "0x0400", expiry: 300000, threshold: 2, approvals: 1, status: "active" };
  const S = C.sanitizeBoard;
  eq(typeof S, "function", "board: sanitizeBoard exported from core");
  eq(C.MAX_BOARD_ENTRIES, 500, "board: entry cap constant");
  eq(C.MAX_BOARD_BLOCK, 10000000, "board: plausible-height ceiling constant");
  eq(S(null).length, 0, "board: non-array -> []");
  eq(S("nope").length, 0, "board: string -> []");
  eq(S([good]).length, 1, "board: good entry survives");
  eq(S([good])[0].callHex, "0400", "board: callHex normalized (0x stripped, lowercase)");
  eq(S([null, 42, "x", [good]]).length, 0, "board: non-plain-object entries dropped");
  eq(S([{ ...good, vault: "not-an-address" }]).length, 0, "board: garbage vault dropped");
  eq(S([{ ...good, vault: VAULT2 }]).length, 1, "board: second real vault kept");
  eq(S([{ ...good, callHex: "zz" }]).length, 0, "board: non-hex call dropped");
  eq(S([{ ...good, callHex: "" }]).length, 0, "board: empty call dropped");
  eq(S([{ ...good, callHex: "ab".repeat(C.MAX_CALL_SIZE + 1) }]).length, 0, "board: call > MAX_CALL_SIZE dropped (no builder produces one)");
  eq(S([{ ...good, callHex: "ab".repeat(C.MAX_CALL_SIZE) }]).length, 1, "board: call == MAX_CALL_SIZE kept");
  eq(S([{ ...good, threshold: C.MAX_SIGNERS + 1 }]).length, 0, "board: threshold > MAX_SIGNERS dropped (no such vault exists)");
  eq(S([{ ...good, threshold: C.MAX_SIGNERS }]).length, 1, "board: threshold == MAX_SIGNERS kept");
  eq(S([{ ...good, threshold: 2.9 }])[0].threshold, 2, "board: fractional threshold floored (the form can write one)");
  eq(S([{ ...good, expiry: 0 }]).length, 0, "board: expiry 0 dropped");
  eq(S([{ ...good, expiry: C.MAX_BOARD_BLOCK + 1 }]).length, 0, "board: expiry beyond height ceiling dropped");
  eq(S([{ ...good, expiry: C.MAX_BOARD_BLOCK }]).length, 1, "board: expiry == ceiling kept");
  eq(S([{ ...good, expiry: 300000.7 }])[0].expiry, 300000, "board: fractional expiry floored (the form can write one)");
  eq(S([{ ...good, id: 4294967295 }]).length, 1, "board: u32-max proposal id kept");
  eq(S([{ ...good, id: 4294967296 }]).length, 0, "board: proposal id beyond u32 dropped (encodeApprove rejects it)");
  eq(S([{ ...good, id: -4 }])[0].id, 0, "board: negative id coerced to 0");
  const dup = S([good, { ...good, callHex: "0x9999", status: "executed" }]);
  eq(dup.length, 1, "board: duplicate (vault,id) dropped");
  eq(dup[0].callHex, "0400", "board: dedupe is first-wins (the first call stands)");
  eq(S([good, { ...good, vault: VAULT2 }]).length, 2, "board: same id on a different vault is a different proposal");
  eq(S([{ ...good, approvals: 99 }])[0].approvals, 2, "board: approvals clamped to threshold");
  eq(S([{ ...good, approvals: -1 }])[0].approvals, 0, "board: negative approvals coerced to 0");
  eq(S([{ ...good, status: "bogus" }])[0].status, "active", "board: unknown status -> active");
  eq(S([{ ...good, status: "executed" }])[0].status, "executed", "board: known status kept");
  const many = Array.from({ length: 600 }, (_, i) => ({ ...good, id: i }));
  eq(S(many).length, C.MAX_BOARD_ENTRIES, "board: capped at MAX_BOARD_ENTRIES");
  /* boardRoom: the creation-path gate the add form asks before pushing —
   * sanitize alone dropped an appended 501st entry (the NEW proposal) in
   * the same paint that toasted "Proposal logged". */
  eq(typeof C.boardRoom, "function", "board: boardRoom exported from core");
  eq(C.boardRoom(0), 500, "board: boardRoom(0) = full cap");
  eq(C.boardRoom(499), 1, "board: boardRoom(499) = 1");
  eq(C.boardRoom(500), 0, "board: boardRoom(500) = 0 (at cap)");
  eq(C.boardRoom(5000), 0, "board: boardRoom never negative");
  eq(C.boardRoom(NaN), 0, "board: boardRoom(non-finite) = 0 (fail-closed)");
  eq(C.boardRoom(-3), 0, "board: boardRoom(negative) = 0 (fail-closed)");
  eq(C.boardRoom(499.9), 1, "board: boardRoom floors fractional counts");
}

/* signer parse window: parseSigners decodes every parsed line on every
 * keystroke (base58 + blake2b-512 each), so the line count is windowed
 * at MAX_SIGNER_LINES — 5x the pallet's MAX_SIGNERS cap, giving duplicate
 * and invalid lines headroom while bounding the decode work. Lines past
 * the window are counted as skipped so the hint can disclose them. */
{
  const W = C.signerParseWindow;
  eq(typeof W, "function", "signerwindow: signerParseWindow exported from core");
  eq(C.MAX_SIGNER_LINES, 500, "signerwindow: line cap constant is 500");
  const six = ["a", "b", "c", "d", "e", "f"];
  const w1 = W(six, 500);
  eq(w1.parse.length, 6, "signerwindow: under cap parses all");
  eq(w1.skipped, 0, "signerwindow: under cap skips 0");
  eq(w1.parse.join(","), "a,b,c,d,e,f", "signerwindow: parse is the input prefix");
  const w2 = W(six, 3);
  eq(w2.parse.length, 3, "signerwindow: over cap parses exactly cap");
  eq(w2.total, 6, "signerwindow: total counts every line");
  eq(w2.skipped, 3, "signerwindow: skipped counts the unparsed tail");
  eq(w2.parse.join(","), "a,b,c", "signerwindow: over-cap parse keeps the FIRST lines");
  eq(W(six, 6).skipped, 0, "signerwindow: exactly at cap skips 0");
  eq(W([], 500).parse.length, 0, "signerwindow: empty input -> empty window");
  eq(W(six, 0).skipped, 6, "signerwindow: cap 0 parses nothing, skips all");
  eq(W(six, NaN).parse.length, 0, "signerwindow: NaN cap fails closed");
  eq(W(six, -1).parse.length, 0, "signerwindow: negative cap fails closed");
  eq(W(six, 2.5).parse.length, 0, "signerwindow: fractional cap fails closed");
  eq(W(six, "500").parse.length, 0, "signerwindow: string cap fails closed");
  eq(W(six, NaN).skipped, 6, "signerwindow: bad cap still reports total/skipped");
  eq(W(null, 500).total, 0, "signerwindow: non-array input -> empty window");
  eq(six.length, 6, "signerwindow: input array is not mutated");
  const big = Array.from({ length: 20000 }, () => "x");
  eq(W(big, C.MAX_SIGNER_LINES).parse.length, 500, "signerwindow: 20,000 lines window to the cap");
  eq(W(big, C.MAX_SIGNER_LINES).skipped, 19500, "signerwindow: 20,000 lines skip the tail");
}

/* signer text scan window: signerParseWindow bounded the decode work,
 * but parseSigners still split/mapped/filtered the WHOLE textarea value
 * to build the line array — a 19,600,000-char paste of 400,000 lines
 * built all 400,000 strings in ~325 ms in Node on every keystroke, all
 * to decode 500. signerTextWindow scans only the first
 * MAX_SIGNER_SCAN_CHARS chars (500 max-length 128-char lines plus
 * separators are 64,500 chars, so the full line window scans intact),
 * backs the cut off to the last newline, and reports skippedChars. */
{
  const T = C.signerTextWindow;
  eq(typeof T, "function", "signerscan: signerTextWindow exported from core");
  eq(C.MAX_SIGNER_SCAN_CHARS, 65536, "signerscan: scan cap constant is 65,536");
  const small = T("  qzAAA  \n\nqzBBB\n");
  eq(small.lines.join(","), "qzAAA,qzBBB", "signerscan: small input lines trimmed, blanks dropped");
  eq(small.skippedChars, 0, "signerscan: small input skips 0 chars");
  eq(small.scannedChars, small.totalChars, "signerscan: small input scans in full");
  const maxLines = Array.from({ length: 500 }, () => "x".repeat(128)).join("\n");
  const ml = T(maxLines);
  eq(ml.lines.length, 500, "signerscan: 500 max-length lines all scanned");
  eq(ml.skippedChars, 0, "signerscan: 500 max-length lines skip 0 chars");
  const rows = Array.from({ length: 1000 }, () => "x".repeat(100)).join("\n");
  const mid = T(rows);
  eq(mid.lines.every((l) => l.length === 100), true, "signerscan: cut backs off to a line boundary — no partial line");
  eq(mid.scannedChars <= C.MAX_SIGNER_SCAN_CHARS, true, "signerscan: scanned window at or under cap");
  eq(mid.skippedChars, mid.totalChars - mid.scannedChars, "signerscan: skippedChars is the unscanned tail");
  const giant = ("qz" + "a".repeat(46) + "\n").repeat(400000);
  const g = T(giant);
  eq(g.totalChars, 19600000, "signerscan: giant paste total counted");
  eq(g.skippedChars > 19000000, true, "signerscan: giant paste tail skipped and counted");
  const oneLine = T("x".repeat(200000));
  eq(oneLine.lines.length, 0, "signerscan: single over-window line scans as empty");
  eq(oneLine.scannedChars, 0, "signerscan: single over-window line scans 0 chars");
  eq(T(null).lines.length, 0, "signerscan: null fails closed as empty");
  eq(T(undefined).totalChars, 0, "signerscan: undefined fails closed as empty");
  eq(T(42).lines.length, 0, "signerscan: non-string fails closed as empty");
  eq(T("").lines.length, 0, "signerscan: empty string -> no lines");
}

/* hexInputRoom + fromHex bound: fromHex parsed the WHOLE string before
 * any caller checked a length (every encode* bounds only the parsed
 * result; sanitizeBoard and the board form parse first, check after) —
 * a 20,000,000-char paste built a 10,000,000-element array (~3.4 s in
 * Node) only to be rejected. The gate refuses over-cap inputs unparsed;
 * the cap (32,768) sits above the largest legitimate input, a
 * byte-spaced MAX_CALL_SIZE call at 30,721 chars incl. the 0x prefix. */
{
  eq(typeof C.hexInputRoom, "function", "hexbound: hexInputRoom exported from core");
  eq(C.MAX_HEX_INPUT_CHARS, 32768, "hexbound: cap constant is 32768");
  eq(C.hexInputRoom(0), 32768, "hexbound: room(0) = cap");
  eq(C.hexInputRoom(32768), 0, "hexbound: room(cap) = 0");
  eq(C.hexInputRoom(32769), 0, "hexbound: room(cap+1) = 0");
  eq(C.hexInputRoom(NaN), 0, "hexbound: room(NaN) fails closed");
  eq(C.hexInputRoom(-1), 0, "hexbound: room(-1) fails closed");
  eq(C.hexInputRoom(2.5), 0, "hexbound: room(2.5) fails closed");
  eq(C.hexInputRoom("100"), 0, "hexbound: room(string) fails closed");
  eq(C.hexInputRoom(undefined), 0, "hexbound: room(undefined) fails closed");
  eq(C.hexInputRoom(null), 0, "hexbound: room(null) fails closed");
  eq(C.hexInputRoom(Infinity), 0, "hexbound: room(Infinity) fails closed");
  eq(C.fromHex("ab".repeat(20000)), null, "hexbound: 40,000-char input refused unparsed");
  eq(C.fromHex("ab".repeat(1000000)), null, "hexbound: 2,000,000-char input refused unparsed");
  const atCap = C.fromHex("ab".repeat(16384));
  eq(atCap && atCap.length, 16384, "hexbound: exactly-cap 32,768 chars still parses");
  const spacedMax = C.fromHex("0x" + "ab ".repeat(C.MAX_CALL_SIZE).trimEnd());
  eq(spacedMax && spacedMax.length, C.MAX_CALL_SIZE, "hexbound: byte-spaced max call (30,721 chars) still parses to MAX_CALL_SIZE bytes");
  const key = C.fromHex("0x" + "ab".repeat(32));
  eq(key && key.length, 32, "hexbound: ordinary 32-byte key hex still parses");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
