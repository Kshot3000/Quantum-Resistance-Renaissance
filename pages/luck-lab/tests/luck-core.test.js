/* QTC Luck Lab — node test suite.
 * Anchored to exact math (all verifiable by hand):
 *  - solo wait: E = D/h; quantile t_p = -E*ln(1-p); P(>=1 in E) = 1-1/e
 *  - Poisson PMF sums to 1; seeded RNG is deterministic
 *  - retarget catch-up: 2048*ln(r) up, ln(r)/ln(1-99/2048) down
 *  - emission: R = (21M - S)/50M
 * Run: node tests/luck-core.test.js
 */
const L = require("../js/luck-core.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function approx(name, got, want, tol) {
  t(name, Math.abs(got - want) <= tol, "got " + got + " want ~" + want);
}

// --- solo wait math (fixture: D = 357641624641568, h = 10 GH/s)
const D = 357641624641568, H = 1e10;
const E = D / H; // 35764.1624641568 s
approx("E = D/h", L.soloExpectedWaitSec(D, H), 35764.1624641568, 1e-6);
approx("median = E*ln2", L.soloQuantileWaitSec(D, H, 0.5), E * Math.LN2, 1e-6);
approx("p90 = E*ln10", L.soloQuantileWaitSec(D, H, 0.9), E * Math.log(10), 1e-6);
approx("p99 = E*ln100", L.soloQuantileWaitSec(D, H, 0.99), E * Math.log(100), 1e-6);
t("quantile p=0 -> 0", L.soloQuantileWaitSec(D, H, 0) === 0);
t("quantile p=1 -> Infinity", L.soloQuantileWaitSec(D, H, 1) === Infinity);
t("zero hashrate -> never", L.soloExpectedWaitSec(D, 0) === Infinity);
t("zero hashrate -> P=0", L.probAtLeastOneBlock(D, 0, 86400) === 0);
approx("P(>=1 in E) = 1-1/e", L.probAtLeastOneBlock(D, H, E), 1 - 1 / Math.E, 1e-12);
approx("P(>=1 in 2E) = 1-1/e^2", L.probAtLeastOneBlock(D, H, 2 * E), 1 - 1 / (Math.E * Math.E), 1e-12);
approx("P(>=1 in 24h)", L.probAtLeastOneBlock(D, H, 86400), 1 - Math.exp(-86400 / E), 1e-12);
t("non-positive time -> 0", L.probAtLeastOneBlock(D, H, -5) === 0);

// --- Poisson
let sum = 0;
for (let k = 0; k <= 40; k++) sum += L.poissonPmf(k, 5);
approx("poisson pmf sums to 1 (lambda=5)", sum, 1, 1e-9);
approx("poisson pmf k=0 lambda=3", L.poissonPmf(0, 3), Math.exp(-3), 1e-12);
t("poisson lambda=0, k=0 -> 1", L.poissonPmf(0, 0) === 1);
t("poisson lambda=0, k=2 -> 0", L.poissonPmf(2, 0) === 0);
t("poisson k<0 -> 0", L.poissonPmf(-1, 5) === 0);
t("poisson non-integer k -> 0", L.poissonPmf(2.5, 5) === 0);

// --- seeded RNG determinism
const r1 = L.makeRng(12345), r2 = L.makeRng(12345), r3 = L.makeRng(999);
let same = true, diff = false;
for (let i = 0; i < 50; i++) {
  const a = r1(), b = r2(), c = r3();
  if (a !== b) same = false;
  if (a !== c) diff = true;
  if (!(a >= 0 && a < 1)) { same = false; break; }
}
t("same seed -> identical stream", same);
t("different seed -> different stream", diff);

// --- Monte Carlo solo waits converge to the theory
const waits = L.simulateSoloWaits(D, H, 60000, 7);
const mean = waits.reduce((a, b) => a + b, 0) / waits.length;
approx("sim mean ~= E (2% tol)", mean, E, E * 0.02);
const srt = waits.slice().sort((a, b) => a - b);
approx("sim median ~= E*ln2 (3% tol)", L.percentile(srt, 0.5), E * Math.LN2, E * 0.03);
approx("sim p90 ~= E*ln10 (6% tol)", L.percentile(srt, 0.9), E * Math.log(10), E * 0.06);
const fracUnderE = srt.filter((w) => w <= E).length / srt.length;
approx("P(wait <= E) ~= 1-1/e", fracUnderE, 1 - 1 / Math.E, 0.02);

// --- pool expected daily (fixture: net 29.80346872013 TH/s, R=0.4191068384, 1% fee)
const NET = 29803468720130, R = 0.4191068384, BPD = 86400000 / 13539;
approx("pool expected daily 10GH/s @1%",
  L.poolExpectedDailyQtc(1e10, NET, R, 0.01, BPD),
  (1e10 / NET) * BPD * R * 0.99, 1e-12);
t("pool expected with 0 hashrate -> 0", L.poolExpectedDailyQtc(0, NET, R, 0.01, BPD) === 0);
t("pool expected with 0 net -> 0", L.poolExpectedDailyQtc(1e10, 0, R, 0.01, BPD) === 0);
// pool sim mean converges to the analytic expectation
const poolDays = L.simulatePoolDailyEarnings(1e10, NET, R, 0.01, BPD, 4000, 21);
const poolMean = poolDays.reduce((a, b) => a + b, 0) / poolDays.length;
approx("pool sim mean ~= analytic (5% tol)", poolMean, L.poolExpectedDailyQtc(1e10, NET, R, 0.01, BPD), L.poolExpectedDailyQtc(1e10, NET, R, 0.01, BPD) * 0.05);
// solo daily sim: mean matches lambda*R
const soloDays = L.simulateSoloDailyEarnings(1e10, D, R, 20000, 33);
const soloMean = soloDays.reduce((a, b) => a + b, 0) / soloDays.length;
approx("solo daily sim mean ~= lambda*R (10% tol)", soloMean, (1e10 * 86400 / D) * R, (1e10 * 86400 / D) * R * 0.10);

// --- retarget catch-up blocks
t("r=2 -> 1420 blocks", L.retargetCatchupBlocks(2) === Math.ceil(2048 * Math.LN2));
t("r=1 -> 0", L.retargetCatchupBlocks(1) === 0);
t("r=0.5 -> 14 blocks", L.retargetCatchupBlocks(0.5) === Math.ceil(Math.log(0.5) / Math.log(1 - 99 / 2048)));
t("r<=0 -> NaN", Number.isNaN(L.retargetCatchupBlocks(0)));
t("down move is fast, up move is slow", L.retargetCatchupBlocks(0.5) < L.retargetCatchupBlocks(2));

// --- emission: S = TOTAL supply (total_issuance incl. genesis)
approx("R at 5,762,370.5 total supply", L.currentRewardQtc(5762370499457120000), (21e6 - 5762370.49945712) / 50e6, 1e-9);
approx("R at genesis (S=0)", L.currentRewardQtc(0), 0.42, 1e-12);

// --- formatting
t("fmtDuration 90061", L.fmtDuration(90061) === "1d 1h 1m 1s", L.fmtDuration(90061));
t("fmtDuration 59", L.fmtDuration(59) === "59s", L.fmtDuration(59));
t("fmtDuration Infinity", L.fmtDuration(Infinity) === "never");
t("fmtHashrate 29.8 TH/s", L.fmtHashrate(29803468720130) === "29.8 TH/s", L.fmtHashrate(29803468720130));
t("fmtHashrate 0", L.fmtHashrate(0) === "0 H/s");
t("fmtQtc", L.fmtQtc(0.4191068384) === "0.4191", L.fmtQtc(0.4191068384));
t("fmtPct", L.fmtPct(0.6321) === "63.2%", L.fmtPct(0.6321));
t("percentile empty -> NaN", Number.isNaN(L.percentile([], 0.5)));
t("percentile p=0 -> min", L.percentile([3, 1, 2].sort((a, b) => a - b), 0) === 1);

// --- fallback bundles: ONE capture across luck-lab + energy-observatory ----
// Regression guard for the 2026-10-02 mixed-date bug (Oct 1 difficulty paired
// with an Oct 2 supply-derived reward in both apps' snapshot-failure fallbacks).
{
  const fs = require("fs"), path = require("path");
  const luckSrc = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
  const nrgSrc = fs.readFileSync(path.join(__dirname, "../../energy-observatory/js/app.js"), "utf8");
  const grab = (src, re) => { const m = src.match(re); return m ? m[1] : null; };
  const lDiff = grab(luckSrc, /difficulty:\s*(\d+),/), eDiff = grab(nrgSrc, /difficulty:\s*"(\d+)"/);
  const lNet = Number(grab(luckSrc, /netHs:\s*(\d+)/));
  const lRew = Number(grab(luckSrc, /reward:\s*([\d.]+)/));
  const lBpd = Number(grab(luckSrc, /blocksPerDay:\s*(\d+)/));
  const lAvg = Number(grab(luckSrc, /avgBlockMs:\s*(\d+)/));
  const lHead = grab(luckSrc, /head:\s*(\d+)/), eHead = grab(nrgSrc, /height:\s*(\d+)/);
  const eSup = grab(nrgSrc, /totalSupplyPlancks:\s*"(\d+)"/);
  t("fallback: both apps parse", !!(lDiff && eDiff && eSup && lHead && eHead));
  t("fallback: same difficulty in both apps", lDiff === eDiff, lDiff + " vs " + eDiff);
  t("fallback: same head/height in both apps", lHead === eHead, lHead + " vs " + eHead);
  t("fallback: netHs = difficulty / 12", Math.abs(lNet - Number(lDiff) / 12) <= 1, lNet);
  t("fallback: blocksPerDay = 86400000 / avgBlockMs", Math.abs(lBpd - 86400000 / lAvg) <= 1.5, lBpd + " vs " + (86400000 / lAvg));
  approx("fallback: luck reward = emission(energy supply)", lRew, L.currentRewardQtc(Number(eSup)), 5e-8);
}

// --- snapshot boundary (app.js deriveSnapshotState): poisoned payloads must
// not anchor a difficulty, a reward, or a pace — payloads fail independently.
// RED evidence (real browser, pre-fix): sci difficulty painted 8.25 TH/s; an
// est mismatch painted 1.00 kH/s; a contradictory total painted 0.2400 QTC;
// an over-cap total painted a negative reward; a gapped/compressed recent
// window painted 78,545 blocks/day; a fractional balance painted 0.4200 QTC.
global.LuckCore = L;
const A = require("../js/app.js");
{
  const mkRecent = (n, stepMs, h0, ts0) =>
    Array.from({ length: n }, (_, i) => [h0 + i, ts0 + i * stepMs, "669104327575800"]);
  const CONS = { fetched_at: "2026-10-02T15:00:29.848Z", head: 153406,
    current: { height: 153406, difficulty: "669104327575800", est_hashrate_hs: "55758693964650" },
    recent: mkRecent(1500, 14000, 151907, 1756944000000) };
  const SUP = { fetched_at: "2026-10-02T15:00:40.038Z", block_height: 153406,
    total_supply_plancks: "5766179473775204913",
    balances_plancks: { free: "5766179473775204813", reserved: "100", frozen: "0" } };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const okD = A.deriveSnapshotState(clone(CONS), clone(SUP));
  t("boundary: valid capture anchors", okD.snapshotOk === true && okD.difficulty === 669104327575800 && okD.head === 153406);
  approx("boundary: netHs = difficulty / 12", okD.netHs, 669104327575800 / 12, 1);
  approx("boundary: reward from cross-checked total", okD.rewardQtc, L.currentRewardQtc(5766179473775204913), 1e-12);
  approx("boundary: pace from consecutive window", okD.avgBlockMs, 14000, 1e-9);
  approx("boundary: blocksPerDay = 86400000 / avg", okD.blocksPerDay, 86400000 / 14000, 1e-6);

  const sci = clone(CONS); sci.current.difficulty = "9.9e13"; sci.current.est_hashrate_hs = "8250000000000";
  t("boundary: scientific-notation difficulty rejected", A.deriveSnapshotState(sci, clone(SUP)).snapshotOk === false);
  const mis = clone(CONS); mis.current.est_hashrate_hs = "1000";
  t("boundary: est contradicting difficulty rejected", A.deriveSnapshotState(mis, clone(SUP)).snapshotOk === false);
  const noEst = clone(CONS); delete noEst.current.est_hashrate_hs;
  t("boundary: est absent still anchors (netHs derived)", A.deriveSnapshotState(noEst, clone(SUP)).snapshotOk === true);
  const fracH = clone(CONS); fracH.current.height = 153406.5; fracH.head = 153406.5;
  t("boundary: fractional height rejected", A.deriveSnapshotState(fracH, clone(SUP)).snapshotOk === false);
  const disH = clone(CONS); disH.head = 153407;
  t("boundary: current.height vs head disagreement rejected", A.deriveSnapshotState(disH, clone(SUP)).snapshotOk === false);
  const badDate = clone(CONS); badDate.fetched_at = '<b id="pwn">PWNED</b>';
  t("boundary: garbage fetched_at rejected", A.deriveSnapshotState(badDate, clone(SUP)).snapshotOk === false);

  const contra = clone(SUP); contra.total_supply_plancks = "9000000000000000000";
  const dContra = A.deriveSnapshotState(clone(CONS), contra);
  t("boundary: contradictory total -> no reward, consensus still anchors", dContra.rewardQtc === null && dContra.snapshotOk === true);
  const fracB = clone(SUP); delete fracB.total_supply_plancks; fracB.balances_plancks.free = "1.5";
  const dFrac = A.deriveSnapshotState(clone(CONS), fracB);
  t("boundary: fractional balance -> no reward, no throw, neighbours anchor", dFrac.rewardQtc === null && dFrac.snapshotOk === true);
  const balOnly = clone(SUP); delete balOnly.total_supply_plancks;
  approx("boundary: balances-only supply anchors from the sum", A.deriveSnapshotState(clone(CONS), balOnly).rewardQtc, L.currentRewardQtc(5766179473775204913), 1e-12);
  const over = clone(SUP); over.total_supply_plancks = "22000000000000000000";
  over.balances_plancks = { free: "22000000000000000000", reserved: "0", frozen: "0" };
  t("boundary: over-cap (22M) total -> no negative reward", A.deriveSnapshotState(clone(CONS), over).rewardQtc === null);
  const mixed = clone(SUP); mixed.block_height = 100000; mixed.total_supply_plancks = "9000000000000000000";
  mixed.balances_plancks = { free: "9000000000000000000", reserved: "0", frozen: "0" };
  t("boundary: cross-capture supply -> no reward", A.deriveSnapshotState(clone(CONS), mixed).rewardQtc === null);
  const undated = clone(SUP); delete undated.fetched_at;
  t("boundary: undated supply -> no reward", A.deriveSnapshotState(clone(CONS), undated).rewardQtc === null);
  t("totalSupplyOf: null payload -> null", A.totalSupplyOf(null) === null);
  t("totalSupplyOf: contradiction -> null", A.totalSupplyOf(contra) === null);

  const nullRec = clone(CONS); nullRec.recent[500] = null;
  const dNullRec = A.deriveSnapshotState(nullRec, clone(SUP));
  t("boundary: poisoned recent entry -> pace dropped, difficulty anchors", dNullRec.avgBlockMs === null && dNullRec.snapshotOk === true);
  const gapRec = clone(CONS); gapRec.recent = mkRecent(11, 1100, 150000, 1756944000000).map((p, i) => [p[0] + i * 99, p[1], p[2]]);
  t("boundary: gapped heights -> no pace (span would overcount blocks)", A.deriveSnapshotState(gapRec, clone(SUP)).avgBlockMs === null);
  const strTs = clone(CONS); strTs.recent = mkRecent(11, 14000, 153396, 1756944000000).map((p) => [p[0], String(p[1]), p[2]]);
  t("boundary: string timestamps -> no pace", A.deriveSnapshotState(strTs, clone(SUP)).avgBlockMs === null);
  const few = clone(CONS); few.recent = mkRecent(10, 14000, 153397, 1756944000000);
  t("boundary: <11-entry window -> no pace", A.deriveSnapshotState(few, clone(SUP)).avgBlockMs === null);
  const fast = clone(CONS); fast.recent = mkRecent(11, 500, 153396, 1756944000000);
  t("boundary: 500ms average -> no pace (outside the plausible band)", A.deriveSnapshotState(fast, clone(SUP)).avgBlockMs === null);

  // The REAL current snapshots must pass their own boundary unchanged.
  const fs2 = require("fs"), path2 = require("path");
  const realC = JSON.parse(fs2.readFileSync(path2.join(__dirname, "../../../data/consensus.json"), "utf8"));
  const realS = JSON.parse(fs2.readFileSync(path2.join(__dirname, "../../../data/supply.json"), "utf8"));
  const dReal = A.deriveSnapshotState(realC, realS);
  t("boundary: real snapshots anchor", dReal.snapshotOk === true && dReal.rewardQtc !== null && dReal.avgBlockMs !== null);
  t("boundary: real difficulty/head unchanged", dReal.difficulty === Number(realC.current.difficulty) && dReal.head === realC.current.height);
  approx("boundary: real reward unchanged", dReal.rewardQtc, L.currentRewardQtc(Number(realS.total_supply_plancks)), 1e-9);
  const realAvg = (realC.recent[realC.recent.length - 1][1] - realC.recent[0][1]) / (realC.recent.length - 1);
  approx("boundary: real pace unchanged", dReal.avgBlockMs, realAvg, 1e-9);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
