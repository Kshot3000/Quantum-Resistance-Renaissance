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

/* expiry helpers */
eq(C.blocksToHuman(100800), "14d 0h", "max expiry = 14 days");
eq(C.blocksToHuman(7200), "1d 0h", "7200 blocks = 1 day");
eq(C.expiryBlockNow(150000, 7200), 157200, "expiry block math");
eq(C.MAX_EXPIRY_DURATION, 100800, "max expiry constant");
eq(C.PALLET_INDEX, 19, "pallet index constant");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
