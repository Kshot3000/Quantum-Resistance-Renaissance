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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
