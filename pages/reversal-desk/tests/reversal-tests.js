/* QTC Reversal Desk — node tests for reversal-core.js.
 * Run: node tests/reversal-tests.js
 * Grounding: blake2b vectors from Python hashlib (independent implementation);
 * SS58 vector is Kyle's real Quantus donation address (prefix 189, verified live);
 * SCALE layout verified against Quantus-Network/chain rev 482c5b9
 * (pallets/reversible-transfers/src/lib.rs + runtime/src/lib.rs pallet_index 11).
 */
"use strict";
const RC = require("../js/reversal-core.js");

let passed = 0, failed = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error("FAIL", name, "\n  got     ", a, "\n  expected", e); }
}
function ok(cond, name) {
  if (cond) passed++; else { failed++; console.error("FAIL", name); }
}

/* ---------- blake2b ---------- */
const H = (b) => b.map((x) => (x < 16 ? "0" : "") + x.toString(16)).join("");
eq(
  H(RC.blake2b([])),
  "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
  "blake2b-512 empty vector (Python hashlib)"
);
eq(
  H(RC.blake2b([97, 98, 99])),
  "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  "blake2b-512 'abc' vector (Python hashlib)"
);
// multi-block input (>128 bytes) exercises the t-counter path
const long = [];
for (let i = 0; i < 300; i++) long.push(i & 0xff);
eq(
  H(RC.blake2b(long)).slice(0, 32),
  require("crypto").createHash("blake2b512").update(Buffer.from(long)).digest("hex").slice(0, 32),
  "blake2b 300-byte input matches Node crypto"
);

/* ---------- SS58 ---------- */
const DONATION = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
const dec = RC.ss58Decode(DONATION);
ok(dec.ok === true, "SS58 decode of real qz address ok");
eq(dec.prefix, 189, "SS58 prefix 189");
eq(dec.key.length, 32, "SS58 key 32 bytes");
const bad = RC.ss58Decode("qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbaX");
ok(!bad.ok && /Checksum/.test(bad.error), "SS58 checksum catches typo");
const eth = RC.ss58Decode("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1");
ok(!eth.ok, "SS58 rejects hex address");
const res189 = RC.ss58Decode("KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC");
ok(!res189.ok && /Reserved SS58 prefix form/.test(res189.error), "SS58 reserved form (0xBD) rejected, not read as prefix 189");
const res192 = RC.ss58Decode("LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ");
ok(!res192.ok && /Reserved SS58 prefix form/.test(res192.error), "SS58 reserved form (0xC0) rejected");
const longSs58 = RC.ss58Decode("z".repeat(20000));
ok(!longSs58.ok && /Too long/.test(longSs58.error), "SS58 20,000-char input refused as too long before decoding");

/* ---------- SCALE primitives ---------- */
eq(RC.u32LE(7200), [0x20, 0x1c, 0x00, 0x00], "u32LE 7200");
eq(RC.u64LE(12000n), [0xe0, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], "u64LE 12000");
eq(RC.u128LE(341500000000n).length, 16, "u128LE 16 bytes");
eq(
  RC.u128LE(341500000000n),
  [0x00, 0x77, 0xfc, 0x82, 0x4f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  "u128LE 0.3415 QTC in planck (341500000000 = 0x4F82FC7700)"
);
eq(RC.delayEnum({ kind: "blocks", blocks: 7200 }), [0x00, 0x20, 0x1c, 0x00, 0x00], "delayEnum BlockNumber(7200)");
eq(
  RC.delayEnum({ kind: "ms", ms: 86400000 }),
  [0x01, 0x00, 0x5c, 0x26, 0x05, 0x00, 0x00, 0x00, 0x00],
  "delayEnum Timestamp(86400000ms = 0x05265C00)"
);

/* ---------- call-data builders ---------- */
const KEY = [];
for (let i = 0; i < 32; i++) KEY.push(i + 1);
const TXID = [];
for (let i = 0; i < 32; i++) TXID.push(0xff - i);

let hex = RC.encodeScheduleTransfer(KEY, 1000000000000n);
ok(hex.startsWith("0x0b03"), "schedule_transfer: pallet 11 call 3");
// layout: "0x" | 0b | 03 | 00(MultiAddress::Id) | 32B key | 16B amount (u128 LE)
eq(hex.slice(6, 8), "00", "schedule_transfer: MultiAddress::Id variant");
eq(hex.length, 2 + (2 + 1 + 32 + 16) * 2, "schedule_transfer: 51 bytes total");
eq(
  hex.slice(8, 8 + 64),
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "schedule_transfer: 32-byte AccountId inline"
);
eq(
  hex.slice(-32),
  "0010a5d4e80000000000000000000000",
  "schedule_transfer: amount = 1 QTC (10^12) u128 LE, NOT compact"
);

hex = RC.encodeScheduleTransferWithDelay(KEY, 1000000000000n, { kind: "blocks", blocks: 2 });
ok(hex.startsWith("0x0b04"), "schedule_transfer_with_delay: pallet 11 call 4");
ok(hex.endsWith("0002000000"), "schedule_transfer_with_delay: min delay BlockNumber(2)");

hex = RC.encodeSetHighSecurity({ kind: "blocks", blocks: 7200 }, KEY);
ok(hex.startsWith("0x0b00"), "set_high_security: pallet 11 call 0");
eq(hex.length, 2 + (2 + 5 + 32) * 2, "set_high_security: 39 bytes total");
eq(hex.slice(6, 16), "00201c0000", "set_high_security: delay BlockNumber(7200)");

hex = RC.encodeCancel(TXID);
ok(hex.startsWith("0x0b01"), "cancel: pallet 11 call 1");
eq(hex.length, 2 + (2 + 32) * 2, "cancel: 34 bytes total");

hex = RC.encodeRecoverFunds(KEY);
ok(hex.startsWith("0x0b07"), "recover_funds: pallet 11 call 7");
eq(hex.length, 2 + (2 + 32) * 2, "recover_funds: 34 bytes total");

/* real-address round trip: decode donation address -> build schedule_transfer call data */
const destKey = RC.ss58Decode(DONATION).key;
const realHex = RC.encodeScheduleTransferWithDelay(destKey, 5000000000000n, { kind: "ms", ms: 3600000 });
ok(realHex.startsWith("0x0b04") && realHex.includes("01"), "end-to-end: real qz address -> call data");
eq(realHex.length, 2 + (2 + 1 + 32 + 16 + 9) * 2, "end-to-end: 62 bytes total");

/* ---------- delay validation ---------- */
ok(RC.validateDelay({ kind: "blocks", blocks: 2 }).ok, "delay 2 blocks ok (min)");
ok(!RC.validateDelay({ kind: "blocks", blocks: 1 }).ok, "delay 1 block rejected");
ok(!RC.validateDelay({ kind: "blocks", blocks: 1.5 }).ok, "delay fractional blocks rejected");
ok(RC.validateDelay({ kind: "ms", ms: 12000 }).ok, "delay 12000ms ok (min)");
ok(!RC.validateDelay({ kind: "ms", ms: 11999 }).ok, "delay 11999ms rejected");
eq(RC.blocksToMs(7200), 86400000, "7200 blocks = 24h at 12s");
eq(RC.executeAtBlock(146270, 7200), 153470, "execute-at block arithmetic");

/* ---------- volume fee (1% burn, integer floor) ---------- */
eq(RC.volumeFee(1000000000000n).toString(), "10000000000", "1% of 1 QTC");
eq(RC.volumeFee(999n).toString(), "9", "1% of 999 planck floors to 9");
eq(RC.volumeFee(0n).toString(), "0", "1% of 0 is 0");

/* ---------- quota ---------- */
let q = RC.quotaCheck([], 100000);
ok(q.allowed && q.remaining === 16, "empty quota: 16 remaining");
q = RC.quotaCheck([99999, 99998, 99997], 100000);
ok(q.allowed && q.remaining === 13 && q.inWindow === 3, "3 recent txs: 13 remaining");
const full = [];
for (let i = 0; i < 16; i++) full.push(100000 - i);
q = RC.quotaCheck(full, 100000);
ok(!q.allowed && q.remaining === 0, "16 txs in window: locked out");
q = RC.quotaCheck([100000 - 7200], 100000); // exactly at window edge: aged out
ok(q.allowed && q.inWindow === 0, "tx exactly 7200 blocks old has aged out");

/* ---------- formatting ---------- */
eq(RC.formatQTC(1000000000000n), "1", "format 1 QTC");
eq(RC.formatQTC(341500000000n), "0.3415", "format 0.3415 QTC");
eq(RC.formatQTC(1234567890123456789n), "1,234,567.890123", "format with thousands separators");
eq(RC.formatDuration(90061000), "1d 1h 1m 1s", "duration formatting");
eq(RC.formatDuration(5000), "5s", "short duration");

/* ---------- snapshot boundary (round 2) ---------- */
const REAL_SNAP = JSON.parse(require("fs").readFileSync(
  require("path").join(__dirname, "..", "..", "..", "data", "reversal.json"), "utf8"));
const NOW = Date.parse(REAL_SNAP.fetched_at) + 60000; // deterministic "now" just after capture
const snapClone = () => JSON.parse(JSON.stringify(REAL_SNAP));

ok(RC.validateSnapshot(snapClone(), NOW) !== null, "boundary: the REAL snapshot passes its own boundary");
{
  const c = RC.validateSnapshot(snapClone(), NOW);
  eq(c.data.status.block_height, REAL_SNAP.data.status.block_height, "boundary: cleaned height is the validated number");
  eq(c.data.scheduled.length, REAL_SNAP.data.scheduled.length, "boundary: real scheduled rows all survive cleaning");
  eq(c.data.cancelled.length, REAL_SNAP.data.cancelled.length, "boundary: real cancelled rows all survive cleaning");
  eq(c.data.executed.length, REAL_SNAP.data.executed.length, "boundary: real executed rows all survive cleaning");
  eq(c.data.totals.scheduled, REAL_SNAP.data.totals.scheduled, "boundary: cleaned totals preserved");
}
eq(RC.validBlockHeight(202509), 202509, "validBlockHeight: plain height");
eq(RC.validBlockHeight("202509"), 202509, "validBlockHeight: canonical digit string");
eq(RC.validBlockHeight(9007199254740991), null, "validBlockHeight: absurd height rejects");
/* Batch 195: integer-string length bound before BigInt. */
eq(RC.validPlancks("7000000000000"), "7000000000000", "int bound: validPlancks genuine");
eq(RC.validPlancks("9".repeat(600)), null, "int bound: 600-digit refused by gate");
eq(RC.validPlancks("9".repeat(512)), "9".repeat(512), "int bound: at-cap not refused by gate");
eq(RC.validPlancks("9".repeat(2000000)), null, "int bound: 2M-digit refused");
eq(RC.validBlockHeight(202509.5), null, "validBlockHeight: fractional rejects");
eq(RC.validBlockHeight("2.02e5"), null, "validBlockHeight: scientific string rejects");
eq(RC.validBlockHeight(true), null, "validBlockHeight: boolean rejects");
eq(RC.validBlockHeight(0), null, "validBlockHeight: zero rejects");

const POISONS = {
  "absurd height": (s) => { s.data.status.block_height = 9007199254740991; },
  "fractional height": (s) => { s.data.status.block_height += 0.5; },
  "ok false": (s) => { s.ok = false; },
  "fetched_at in 2999": (s) => { s.fetched_at = "2999-01-01T00:00:00.000Z"; },
  "fetched_at pre-genesis": (s) => { s.fetched_at = "2020-01-01T00:00:00.000Z"; },
  "status total disagrees with aggregate": (s) => { s.data.status.total_scheduled_transfers += 1; },
  "aggregate scheduled disagrees with status": (s) => { s.data.totals.scheduled += 5; },
  "scheduled total null": (s) => { s.data.totals.scheduled = null; },
  "pending would go negative": (s) => { s.data.totals.cancelled = s.data.totals.scheduled; },
  "fractional total": (s) => { s.data.totals.executed += 0.5; },
  "list longer than its total": (s) => { s.data.totals.cancelled = 5; },
  "list over the fetcher cap": (s) => { s.data.scheduled.push({ ...s.data.scheduled[0] }); },
  "scheduled list ascending (fetcher is desc)": (s) => { s.data.scheduled.reverse(); },
  "every scheduled amount poisoned": (s) => { s.data.scheduled.forEach((r) => { r.amount = "abc"; }); },
};
for (const [name, poison] of Object.entries(POISONS)) {
  const s = snapClone(); poison(s);
  eq(RC.validateSnapshot(s, NOW), null, "boundary rejects: " + name);
}
{
  const s = snapClone(); s.data.scheduled[3].amount = "12.5";
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.scheduled.length === REAL_SNAP.data.scheduled.length - 1,
    "boundary drops: one fractional amount drops its row only");
}
{
  const s = snapClone(); s.data.scheduled[2].to_id = "not-an-address";
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.scheduled.length === REAL_SNAP.data.scheduled.length - 1,
    "boundary drops: one non-SS58 recipient drops its row only");
}
{
  const s = snapClone(); s.data.scheduled[5].tx_id = s.data.scheduled[4].tx_id;
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.scheduled.length === REAL_SNAP.data.scheduled.length - 1,
    "boundary drops: a duplicated tx_id drops the dupe only");
}
{
  const s = snapClone();
  s.data.executed[0].timestamp = new Date(Date.parse(s.fetched_at) + 3600000).toISOString();
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.executed.length === REAL_SNAP.data.executed.length - 1,
    "boundary drops: a row postdating its snapshot drops only");
}
{
  const s = snapClone(); s.data.totals.cancelled = null;
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.totals.cancelled === null,
    "boundary: a null non-scheduled total stays null (paints —, never 0)");
}

/* ---------- snapshot boundary round 3: lifecycle + supply relations ---------- */
{
  const s = snapClone(); s.data.scheduled[0].amount = "21000000000000000000"; // exactly the 21M cap
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.scheduled.length === REAL_SNAP.data.scheduled.length,
    "round3: an amount of exactly the 21M cap stays valid");
}
{
  const s = snapClone(); s.data.scheduled[1].amount = "21000000000000000001"; // cap + 1 planck
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.scheduled.length === REAL_SNAP.data.scheduled.length - 1,
    "round3 drops: an amount 1 planck over the cap drops its row only");
}
{
  const s = snapClone(); s.data.scheduled[2].fee = "100000000000000000000"; // 100M QTC fee
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.scheduled.length === REAL_SNAP.data.scheduled.length - 1,
    "round3 drops: an over-cap fee drops its row only");
}
{
  const s = snapClone();
  const tgt = s.data.executed.find((r) => s.data.scheduled.some((x) => x.tx_id === r.tx_id));
  const sch = s.data.scheduled.find((x) => x.tx_id === tgt.tx_id);
  tgt.timestamp = new Date(Date.parse(sch.timestamp) - 12000).toISOString();
  s.data.executed.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.executed.length === REAL_SNAP.data.executed.length - 1 &&
     !c.data.executed.some((r) => r.tx_id === tgt.tx_id),
    "round3 drops: an executed row predating its scheduled row drops");
}
{
  const s = snapClone();
  const tgt = s.data.cancelled.find((r) => s.data.scheduled.some((x) => x.tx_id === r.tx_id));
  const sch = s.data.scheduled.find((x) => x.tx_id === tgt.tx_id);
  tgt.timestamp = new Date(Date.parse(sch.timestamp) - 12000).toISOString();
  s.data.cancelled.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.cancelled.length === REAL_SNAP.data.cancelled.length - 1 &&
     !c.data.cancelled.some((r) => r.tx_id === tgt.tx_id),
    "round3 drops: a cancelled row predating its scheduled row drops");
}
{
  const s = snapClone();
  const tgt = s.data.executed.find((r) => s.data.scheduled.some((x) => x.tx_id === r.tx_id));
  const sch = s.data.scheduled.find((x) => x.tx_id === tgt.tx_id);
  tgt.timestamp = sch.timestamp; // same-block lifecycle is legitimate
  s.data.executed.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const c = RC.validateSnapshot(s, NOW);
  ok(c !== null && c.data.executed.some((r) => r.tx_id === tgt.tx_id),
    "round3: a terminal row at exactly its scheduled time is kept");
}
{
  const s = snapClone();
  const exe = s.data.executed[0];
  s.data.cancelled[s.data.cancelled.length - 1] = {
    tx_id: exe.tx_id, timestamp: exe.timestamp,
    cancelled_by_id: s.data.cancelled[0].cancelled_by_id,
  };
  s.data.cancelled.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  eq(RC.validateSnapshot(s, NOW), null,
    "round3 rejects: one tx claiming both cancelled and executed fails the snapshot");
}

/* ---------- service fee (profit mandate, 2026-10-11) ---------- */
eq(RC.SERVICE_FEE_ADDRESS, DONATION, "fee: routes only to Kyle's QTC address");
eq(RC.SERVICE_FEE_MAX_BPS, 100, "fee: capped at 100 bps in code");
eq(H(RC.SERVICE_FEE_KEY), "88714241713efd0732437b5a44f8541f69310374de19cc539700caf09d00354c",
  "fee: key derived from the disclosed address (fleet-pinned SS58-189 key)");

eq(RC.computeServiceFee(1000000000000n, 50).feePlancks.toString(), "5000000000", "fee: 0.5% of 1 QTC");
eq(RC.computeServiceFee(1000000000000n, 25).feePlancks.toString(), "2500000000", "fee: 0.25% of 1 QTC");
eq(RC.computeServiceFee(1000000000000n, 100).feePlancks.toString(), "10000000000", "fee: 1% of 1 QTC");
eq(RC.computeServiceFee(1000000000000n, 500).feePlancks.toString(), "10000000000", "fee: 500 bps clamped to the 100 bps cap");
eq(RC.computeServiceFee(1000000000000n, 500).feeBps, 100, "fee: clamped bps reported back");
eq(RC.computeServiceFee(0n, 50).feePlancks.toString(), "0", "fee: zero amount, zero fee");
eq(RC.computeServiceFee(1000000000000n, -5).feePlancks.toString(), "0", "fee: negative bps is no fee");
eq(RC.computeServiceFee(999n, 25).feePlancks.toString(), "2", "fee: floor — 999 planck at 0.25% is 2, never rounded up");
for (const [amt, bps] of [[1000000000000n, 25], [123456789n, 50], [777777777777n, 100], [5n, 100], [21000000000000000000n, 33]]) {
  const f = RC.computeServiceFee(amt, bps);
  ok(f.feePlancks * 10000n <= amt * BigInt(Math.min(bps, 100)) &&
     amt * BigInt(Math.min(bps, 100)) < (f.feePlancks + 1n) * 10000n,
    "fee: floor sweep exact at " + amt + " / " + bps + " bps");
}
eq(RC.feeBpsLabel(0), "0%", "fee label: 0");
eq(RC.feeBpsLabel(25), "0.25%", "fee label: 25 bps");
eq(RC.feeBpsLabel(50), "0.5%", "fee label: 50 bps");
eq(RC.feeBpsLabel(100), "1%", "fee label: 100 bps");
eq(RC.feeBpsLabel(Infinity), "0%", "fee label: Infinity -> 0% (Batch 199)");
eq(RC.feeBpsLabel(-Infinity), "0%", "fee label: -Infinity -> 0% (Batch 199)");
eq(RC.feeBpsLabel(NaN), "0%", "fee label: NaN -> 0% (Batch 199)");

/* compact encoder: standard SCALE boundary vectors */
eq(RC.compactU128(63n), [252], "compact: 63 single-byte mode edge");
eq(RC.compactU128(64n), [1, 1], "compact: 64 two-byte mode edge");
eq(RC.compactU128(16383n), [253, 255], "compact: 16383 two-byte max");
eq(RC.compactU128(16384n), [2, 0, 1, 0], "compact: 16384 four-byte mode edge");
eq(RC.compactU128(5000000000n), [7, 0, 242, 5, 42, 1], "compact: 5e9 big-integer mode");
eq(RC.compactU128(1000000000000n), [7, 0, 16, 165, 212, 232], "compact: 1 QTC in planck big-integer mode");

/* fee leg: Balances pallet 2, call 3, MultiAddress::Id, compact value */
const feeLegHex = RC.encodeTransferKeepAlive(KEY, 5000000000n);
eq(feeLegHex, "0x0203" + "00" +
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" + "0700f2052a01",
  "fee leg: exact transfer_keep_alive bytes");

/* batch: Utility pallet 9, call 2, compact count, calls concatenated */
eq(RC.encodeBatchAll(["0x0b01", "0x0203"]), "0x0902080b010203", "batch_all: exact bytes for two tiny calls");

/* the combined builder */
const DKEY = RC.ss58Decode(DONATION).key;
const plainHex = RC.encodeScheduleTransferWithDelay(DKEY, 1000000000000n, { kind: "blocks", blocks: 7200 });
const noFee = RC.encodeScheduleWithServiceFee(DKEY, 1000000000000n, { kind: "blocks", blocks: 7200 }, 0);
eq(noFee.hex, plainHex, "fee off: byte-identical to the plain schedule call");
eq(noFee.kind, "schedule_transfer_with_delay", "fee off: kind stays the plain call");

const withFee = RC.encodeScheduleWithServiceFee(DKEY, 1000000000000n, { kind: "blocks", blocks: 7200 }, 50);
eq(withFee.kind, "batch_all", "fee on: one atomic batch_all");
eq(withFee.feePlancks.toString(), "5000000000", "fee on: fee is 0.005 QTC on 1 QTC at 0.5%");
eq(withFee.totalOutflowPlancks.toString(), "1005000000000", "fee on: total = amount + fee exactly");
ok(withFee.hex.startsWith("0x090208"), "fee on: batch_all prefix + compact count 2");
ok(withFee.hex.includes(plainHex.slice(2)), "fee on: schedule leg passes through byte-for-byte");
const realFeeLeg = RC.encodeTransferKeepAlive(RC.SERVICE_FEE_KEY, 5000000000n);
ok(withFee.hex.endsWith(realFeeLeg.slice(2)), "fee on: fee leg is LAST in the batch");
ok(withFee.hex.indexOf(plainHex.slice(2)) < withFee.hex.indexOf(realFeeLeg.slice(2)),
  "fee on: schedule leg precedes the fee leg");

const tinyFee = RC.encodeScheduleWithServiceFee(DKEY, 100n, { kind: "blocks", blocks: 7200 }, 25);
eq(tinyFee.kind, "schedule_transfer_with_delay", "fee floored to zero: plain call, no invalid 0-planck leg");
eq(tinyFee.feePlancks.toString(), "0", "fee floored to zero: fee is 0");

const msFee = RC.encodeScheduleWithServiceFee(DKEY, 2000000000000n, { kind: "ms", ms: 3600000 }, 100);
eq(msFee.kind, "batch_all", "fee on: timestamp-delay schedules batch the same way");
eq(msFee.feePlancks.toString(), "20000000000", "fee on: 1% of 2 QTC");

/* Batch 194: amount-input length bound in app.js parseQTC (not exported —
 * the app is a DOM IIFE — so the pure function is extracted and evaluated
 * against a stub C, the same shape the page closes over). */
{
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/../js/app.js", "utf8");
  const m = src.match(/function parseQTC\(s\) \{[\s\S]*?\n  \}/);
  ok(!!m, "amountbound: parseQTC located in app.js");
  const parseQTC = new Function("C", m[0] + "; return parseQTC;")({ UNIT: 1000000000000n });
  ok(parseQTC("1.5") === 1500000000000n, "amountbound: genuine parses");
  eq(parseQTC("9".repeat(600)), null, "amountbound: 600 digits -> null");
  eq(parseQTC("0".repeat(600) + "1.5"), null, "amountbound: long-but-tiny -> null by gate");
  eq(parseQTC("9".repeat(2000000)), null, "amountbound: 2M digits -> null");
  ok(typeof parseQTC("9".repeat(512)) === "bigint", "amountbound: at-cap parses");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
