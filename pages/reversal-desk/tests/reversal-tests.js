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

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
