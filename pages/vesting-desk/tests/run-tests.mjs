#!/usr/bin/env node
/* QTC Vesting Desk — node unit tests for js/vesting-core.js.
 * All money math is BigInt plancks; every vector asserts exact equality.
 */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const VC = require(join(__dirname, "..", "js", "vesting-core.js"));

const Q = 1000000000000n; // plancks per QTC
let pass = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { console.error("FAIL", name, "->", e.message); process.exitCode = 1; }
}

/* --- vestedAmount: exact upstream semantics --- */
t("before cliff vests nothing", () => {
  assert.equal(VC.vestedAmount(1000n * Q, 200n, 100n, 300n, 199n), 0n);
});
t("at cliff with start==cliff vests zero elapsed", () => {
  assert.equal(VC.vestedAmount(1000n * Q, 100n, 100n, 300n, 100n), 0n);
});
t("at end vests total", () => {
  assert.equal(VC.vestedAmount(1000n * Q, 100n, 100n, 300n, 300n), 1000n * Q);
});
t("after end vests total", () => {
  assert.equal(VC.vestedAmount(1000n * Q, 100n, 100n, 300n, 999999n), 1000n * Q);
});
t("midpoint exact with even total", () => {
  assert.equal(VC.vestedAmount(1000n * Q, 0n, 0n, 200n, 100n), 500n * Q);
});
t("floor rounding with odd total", () => {
  // total=7 plancks, elapsed=1 of 2 -> floor(3.5)=3
  assert.equal(VC.vestedAmount(7n, 0n, 0n, 2n, 1n), 3n);
});
t("elapsed measured from start, not cliff", () => {
  // start=0, cliff=100, end=200, now=150 -> total*150/200
  assert.equal(VC.vestedAmount(8n, 100n, 0n, 200n, 150n), 6n);
});
t("intents schedule (id 45) vests linearly from TGE", () => {
  const total = 42000n * Q;
  const start = VC.INTENTS_START_MS, end = VC.INTENTS_END_MS;
  assert.equal(VC.vestedAmount(total, start, start, end, start), 0n);
  assert.equal(VC.vestedAmount(total, start, start, end, end), total);
  const mid = (start + end) / 2n;
  assert.equal(VC.vestedAmount(total, start, start, end, mid), total / 2n);
});
t("liquidity schedule (id 46) fully vested after 16 days", () => {
  const total = 210000n * Q;
  assert.equal(VC.vestedAmount(total, VC.LIQUIDITY_START_MS, VC.LIQUIDITY_START_MS, VC.LIQUIDITY_END_MS, VC.LIQUIDITY_END_MS), total);
});
t("grant schedule vests nothing before 2027-09-09", () => {
  const total = 840000n * Q;
  const now = VC.GRANT_START_MS - 1n;
  assert.equal(VC.vestedAmount(total, VC.GRANT_START_MS, VC.GRANT_START_MS, VC.GRANT_END_MS, now), 0n);
});

/* --- claimableEstimate: 25-QTC non-final alignment --- */
t("nothing owed -> 0", () => {
  assert.equal(VC.claimableEstimate(1000n * Q, 1000n * Q, 1000n * Q), 0n);
});
t("final claim pays exact remainder incl. sub-25-QTC dust", () => {
  assert.equal(VC.claimableEstimate(210000n * Q, 209999n * Q, 210000n * Q), 1n * Q);
});
t("non-final floors to 25 QTC multiples", () => {
  // owed 101 QTC -> pays 100
  assert.equal(VC.claimableEstimate(1000n * Q, 0n, 101n * Q), 100n * Q);
});
t("non-final owed below 25 QTC pays nothing", () => {
  // 24.5 QTC owed -> 0 (alignment leaves <25 QTC)
  assert.equal(VC.claimableEstimate(1000n * Q, 0n, 24500000000000n), 0n);
});
t("non-final exactly 25 QTC pays 25", () => {
  assert.equal(VC.claimableEstimate(1000n * Q, 0n, 25n * Q), 25n * Q);
});
t("id-45 real case: ~2441 QTC owed -> 2425 pays", () => {
  const vested = 2441283332572298n;
  assert.equal(VC.claimableEstimate(42000n * Q, 0n, vested), 2425n * Q);
});
t("vested < claimed never pays (defensive)", () => {
  assert.equal(VC.claimableEstimate(1000n * Q, 900n * Q, 800n * Q), 0n);
});

/* --- formatting: exact, no floats --- */
t("fmtQTC exact decimals", () => {
  assert.equal(VC.fmtQTC(1000000000000n), "1.000");
  assert.equal(VC.fmtQTC(171475000000000000n), "171,475.000");
  assert.equal(VC.fmtQTC(2441283332572298n, 6), "2,441.283332");
  assert.equal(VC.fmtQTC(0n), "0.000");
});
t("fmtQTC0 thousands separators", () => {
  assert.equal(VC.fmtQTC0(5669940000000000000n), "5,669,940");
  assert.equal(VC.fmtQTC0(210000000000000000n), "210,000");
});

/* --- cohort taxonomy --- */
t("cohortOf classifies the three genesis cohorts", () => {
  assert.equal(VC.cohortOf(VC.GRANT_START_MS, VC.GRANT_END_MS), "grant");
  assert.equal(VC.cohortOf(VC.INTENTS_START_MS, VC.INTENTS_END_MS), "intents");
  assert.equal(VC.cohortOf(VC.LIQUIDITY_START_MS, VC.LIQUIDITY_END_MS), "liquidity");
  assert.equal(VC.cohortOf(1n, 2n), "unknown");
});

/* --- genesis constants from mainnet_vesting.rs --- */
t("genesis mint is 27% of 21M", () => {
  assert.equal(VC.GENESIS_MINT_QTC * 100n / 21000000n, 27n);
});
t("cohort durations match pallet comments", () => {
  const day = 86400000n;
  assert.equal((VC.GRANT_END_MS - VC.GRANT_START_MS) / day, 1095n); // 3 years
  assert.equal((VC.INTENTS_END_MS - VC.INTENTS_START_MS) / day, 365n);
  assert.equal((VC.LIQUIDITY_END_MS - VC.LIQUIDITY_START_MS) / day, 16n);
  assert.equal((VC.GRANT_START_MS - VC.TGE_MS) / day, 365n); // 1-year delay
});
t("grant start/end == intents end (all grants share one finish)", () => {
  assert.equal(VC.GRANT_END_MS, VC.INTENTS_START_MS + 4n * 365n * 86400000n);
});
t("min claim interval is one day", () => {
  assert.equal(VC.MIN_CLAIM_INTERVAL_MS, 86400000);
});

/* --- monthly curve sanity --- */
t("monthly curve is monotone and sums to the full vesting total", () => {
  const mk = (total, cliff, start, end) => ({
    total_plancks: String(total), cliff_ms: String(cliff),
    start_ms: String(start), end_ms: String(end),
  });
  const schedules = [
    mk(5417940n * Q, VC.GRANT_START_MS, VC.GRANT_START_MS, VC.GRANT_END_MS),
    mk(42000n * Q, VC.INTENTS_START_MS, VC.INTENTS_START_MS, VC.INTENTS_END_MS),
    mk(210000n * Q, VC.LIQUIDITY_START_MS, VC.LIQUIDITY_START_MS, VC.LIQUIDITY_END_MS),
  ];
  const pts = VC.monthlyCurve(schedules, Date.now());
  assert.ok(pts.length > 40, "covers TGE..2030-09");
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].vested >= pts[i - 1].vested, "monotone");
  const last = pts[pts.length - 1];
  assert.equal(last.vested, 5669940n * Q);
  // the final segment is past the last end date: it carries the tail inflow
  const preFinal = pts[pts.length - 2];
  assert.ok(preFinal.vested < last.vested, "tail unlocks in the last segment");
  assert.equal(last.inflow, last.vested - preFinal.vested);
  // month boundaries are UTC month starts
  assert.equal(new Date(pts[0].monthMs).getUTCDate(), 1);
});

/* --- snapshot integrity: data/vesting.json --- */
t("vesting.json: 48 schedules, cohort math reconciles", () => {
  const d = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "data", "vesting.json"), "utf8"));
  assert.equal(d.schedules.length, 48);
  const now = BigInt(d.fetched_at_ms);
  let totalT = 0n, totalC = 0n;
  for (const s of d.schedules) {
    totalT += BigInt(s.total_plancks);
    totalC += BigInt(s.claimed_plancks);
    const recomputed = VC.vestedAmount(
      BigInt(s.total_plancks), BigInt(s.cliff_ms),
      BigInt(s.start_ms), BigInt(s.end_ms), now);
    assert.equal(recomputed.toString(), s.vested_plancks, "schedule " + s.id);
    assert.equal(VC.cohortOf(s.start_ms, s.end_ms), s.cohort, "schedule " + s.id);
    assert.ok(/^qz[1-9A-HJ-NP-Za-km-z]{47}$/.test(s.beneficiary), "schedule " + s.id);
  }
  assert.equal(totalT, 5669940n * Q);
  for (const [k, b] of Object.entries(d.by_cohort)) {
    const rows = d.schedules.filter((s) => s.cohort === k);
    const sumT = rows.reduce((a, s) => a + BigInt(s.total_plancks), 0n);
    const sumC = rows.reduce((a, s) => a + BigInt(s.claimed_plancks), 0n);
    assert.equal(BigInt(b.total_plancks), sumT, k);
    assert.equal(BigInt(b.claimed_plancks), sumC, k);
  }
});

/* --- load boundary round 2 (app.js, 2026-10-10): cliff/cohort/cap/height ---
 * The browser boundary QA (qa-vesting-boundary2) demonstrated each class
 * RED through the real page; these pin the validator functions directly. */
const VApp = require(join(__dirname, "..", "app.js"));
const REAL_V = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "data", "vesting.json"), "utf8"));
const freshSeen = () => new Set();
const baseRow = () => ({ ...REAL_V.schedules[0] }); // a real grant schedule

t("boundary: every real snapshot schedule passes validSchedule (48/48)", () => {
  const seen = freshSeen();
  for (const s of REAL_V.schedules) assert.ok(VApp.validSchedule(s, seen), "schedule " + s.id);
  assert.equal(seen.size, 48);
});
t("boundary: cliff before start is rejected (negative-vested poison)", () => {
  const r = baseRow();
  r.cliff_ms = String(BigInt(r.start_ms) - 1n);
  assert.equal(VApp.validSchedule(r, freshSeen()), null);
});
t("boundary: cliff == start and cliff inside the window are accepted", () => {
  assert.ok(VApp.validSchedule(baseRow(), freshSeen()));
  const r = baseRow();
  r.cliff_ms = String(BigInt(r.start_ms) + 1000n);
  assert.ok(VApp.validSchedule(r, freshSeen()));
});
t("boundary: (start,end) outside the genesis cohorts is rejected", () => {
  const r = baseRow();
  r.cliff_ms = String(BigInt(r.cliff_ms) + 1000n);
  r.start_ms = String(BigInt(r.start_ms) + 1000n);
  r.end_ms = String(BigInt(r.end_ms) + 1000n);
  assert.equal(VApp.validSchedule(r, freshSeen()), null);
});
t("boundary: a total above the whole genesis mint is rejected", () => {
  const r = baseRow();
  r.total_plancks = (VC.GENESIS_MINT_QTC * Q + 1n).toString();
  assert.equal(VApp.validSchedule(r, freshSeen()), null);
  const okRow = baseRow();
  okRow.total_plancks = (VC.GENESIS_MINT_QTC * Q).toString();
  assert.ok(VApp.validSchedule(okRow, freshSeen()));
});
t("boundary: validBlockHeight is the fleet 1..10,000,000 shape", () => {
  assert.equal(VApp.validBlockHeight(REAL_V.block_height), REAL_V.block_height);
  assert.equal(VApp.validBlockHeight(String(REAL_V.block_height)), REAL_V.block_height);
  assert.equal(VApp.validBlockHeight("9".repeat(40)), null);
  assert.equal(VApp.validBlockHeight(0), null);
  assert.equal(VApp.validBlockHeight(10000001), null);
  assert.equal(VApp.validBlockHeight("1.5"), null);
  assert.equal(VApp.validBlockHeight(null), null);
});

console.log(`\nvesting-core: ${pass} tests green`);
