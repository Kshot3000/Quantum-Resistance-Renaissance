/* QTC Energy Observatory — node test suite.
 * Anchored to exact, hand-verifiable math:
 *  - hashrate: E[hashes]=D, 12 s target → H = D/12
 *  - power: W = (H/s)/(H/J); annual TWh = MW*8760/1e6
 *  - reward: R = (21M - S)/50M with S in plancks
 *  - fleet mix: hashrate-weighted harmonic mean of efficiencies
 *  - history: 100-block-sample daily buckets; per-tx energy guards /0
 * Run: node tests/energy-tests.js
 */
const E = require("../js/energy-core.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function approx(a, b, rel) {
  if (!isFinite(a) || !isFinite(b)) return a === b;
  return Math.abs(a - b) <= Math.abs(b) * (rel || 1e-9);
}

/* --- hashrate --- */
t("hashrate from live difficulty", approx(E.hashrateHs("357641624641568"), 29803468720130.666, 1e-9));
t("hashrate ~29.80 TH/s", approx(E.hashrateHs(357641624641568) / 1e12, 29.8035, 1e-4));

/* --- network power band --- */
const net = E.hashrateHs("357641624641568");
const eff4090 = 818 / 350; // 2.337142857 MH/J
t("all-4090 efficiency", approx(eff4090, 2.337142857, 1e-9));
const mwBest = E.powerMW(net, eff4090);
t("all-4090 network power ≈ 12.76 MW", approx(mwBest, 12.7563, 1e-3), mwBest);
const mwWorst = E.powerMW(net, 68.04 / 200);
t("all-3060Ti network power ≈ 87.66 MW", approx(mwWorst, 87.6634, 1e-3), mwWorst);
t("band ordering", mwBest < mwWorst);
t("powerW rejects bad efficiency", isNaN(E.powerW(net, 0)) && isNaN(E.powerW(net, -1)));

/* --- annual energy --- */
t("annual TWh all-4090 ≈ 0.11175", approx(E.annualTWh(mwBest), 0.11175, 1e-3), E.annualTWh(mwBest));
t("annual TWh worst ≈ 0.76793", approx(E.annualTWh(mwWorst), 0.76793, 1e-3), E.annualTWh(mwWorst));
t("annualMWh = TWh*1e6", approx(E.annualMWh(mwBest), E.annualTWh(mwBest) * 1e6, 1e-9));

/* --- per-block / per-tx energy --- */
const wBest = E.powerW(net, eff4090);
t("per-block energy all-4090 ≈ 42.52 kWh", approx(E.perBlockEnergyKWh(wBest), 42.521, 1e-3), E.perBlockEnergyKWh(wBest));
t("per-block energy = power*12/3.6e6", approx(E.perBlockEnergyKWh(wBest), wBest * 12 / 3.6e6, 1e-12));
const txRate = E.txRatePerSec(157880, 137536, 12);
t("actual tx rate ≈ 0.09566 tx/s", approx(txRate, 0.09566, 1e-3), txRate);
const perTxActual = E.perTxEnergyKWh(wBest, txRate);
t("per-tx actual ≈ 37.06 kWh", approx(perTxActual, 37.06, 1e-2), perTxActual);
const perTxDesign = E.perTxEnergyKWh(wBest, 430);
t("per-tx at 430 QTPS ≈ 8.24 Wh", approx(perTxDesign * 1000, 8.24, 1e-2), perTxDesign * 1000);
t("per-tx guards zero rate", E.perTxEnergyKWh(wBest, 0) === Infinity);
t("per-tx ratio actual/design ≈ 4496×", approx(perTxActual / perTxDesign, 430 / txRate, 1e-9));

/* --- emission ---
 * S = TOTAL supply (total_issuance incl. genesis), per pallets/mining-rewards
 * on_finalize — R = (MaxSupply − S) / 50M. Mined-only S overstates R by ~37%. */
t("block reward at 5,762,370.50 QTC total supply ≈ 0.3047526",
  approx(E.blockRewardQtc("5762370499457120000"), 0.30475259, 1e-8));
t("block reward boundary S=0 → 0.42", approx(E.blockRewardQtc(0), 0.42, 1e-12));

/* --- rig builder --- */
const rigHs = 818e6;
const qtcDay = E.rigExpectedQtcPerDay(rigHs, net, 0.3047526);
t("1×4090 expected QTC/day ≈ 0.0602", approx(qtcDay, 0.0602, 1e-2), qtcDay);
t("expected QTC scales with rig hashrate",
  approx(E.rigExpectedQtcPerDay(2 * rigHs, net, 0.3047526), 2 * qtcDay, 1e-12));
t("zero rig → zero QTC", E.rigExpectedQtcPerDay(0, net, 0.3047) === 0);
t("zero network → zero QTC", E.rigExpectedQtcPerDay(rigHs, 0, 0.3047) === 0);
t("dailyKwh of 350 W rig = 8.4", approx(E.dailyKwh(350), 8.4, 1e-12));
t("cost at $0.15/kWh = $1.26", approx(E.electricityCostUsd(8.4, 0.15), 1.26, 1e-12));

/* --- mix efficiency --- */
t("harmonic mean 50/50 of 2.34 & 1.155 ≈ 1.5466",
  approx(E.mixEfficiency([{ share: 0.5, mhPerJ: 2.34 }, { share: 0.5, mhPerJ: 1.155 }]), 1.5466, 1e-3));
t("single-part mix = part efficiency",
  approx(E.mixEfficiency([{ share: 1, mhPerJ: 0.9 }]), 0.9, 1e-12));
t("mix rejects bad part", isNaN(E.mixEfficiency([{ share: 1, mhPerJ: 0 }])));

/* --- hardware presets --- */
t("8 presets", E.HARDWARE_PRESETS.length === 8);
const expectedEff = {
  "rtx4090-pr100": 818 / 350,
  "rtx3080ti-pr100": 380.5 / 330,
  "rtx3080ti-cuda402": 273.83 / 300,
  "rtx3080ti-wgsl402": 106.03 / 300,
  "rtx5060ti": 104.5 / 180,
  "rtx4060ti": 79.13 / 160,
  "rtx3070": 81.49 / 220,
  "rtx3060ti": 68.04 / 200,
};
for (const id of Object.keys(expectedEff)) {
  const p = E.presetById(id);
  t("preset " + id + " exists", !!p);
  t("preset " + id + " efficiency", approx(E.presetEfficiency(p), expectedEff[id], 1e-9));
  t("preset " + id + " has source+date", !!p.source && !!p.date && !!p.sourceUrl);
}
t("presetById unknown → null", E.presetById("nope") === null);

/* --- fleet totals --- */
const fleet = E.fleetTotals([
  { presetId: "rtx4090-pr100", count: 2 },
  { presetId: "rtx3060ti", count: 3 },
]);
t("fleet 2×4090+3×3060Ti = 5 gpus", fleet.gpus === 5);
t("fleet hashrate", approx(fleet.hashrateHs, (2 * 818 + 3 * 68.04) * 1e6, 1e-9));
t("fleet power", approx(fleet.powerW, 2 * 350 + 3 * 200, 1e-9));
t("fleet ignores unknown ids", E.fleetTotals([{ presetId: "nope", count: 9 }]).gpus === 0);
t("fleet ignores zero counts", E.fleetTotals([{ presetId: "rtx4090-pr100", count: 0 }]).powerW === 0);

/* --- history aggregation --- */
// 3 days of synthetic 100-block samples at constant difficulty 1.2e9
function synthTrend() {
  const pts = [];
  const t0 = Date.UTC(2026, 8, 10, 0, 0, 0);
  let h = 1;
  for (let d = 0; d < 3; d++) {
    for (let s = 0; s < 8; s++) { // 8 samples/day at exact 3 h spacing
      pts.push([h, t0 + d * 86400000 + s * 10800000, "1200000000"]);
      h += 100;
    }
  }
  return pts;
}
const hist = E.dailyEnergyHistory(synthTrend(), 2.0);
t("history yields 3 days", hist.length === 3);
t("history dates ascending", hist[0].date < hist[1].date && hist[1].date < hist[2].date);
const expectedHs = 1200000000 / 12;
t("history avg hashrate", approx(hist[0].avgHashrateHs, expectedHs, 1e-9));
t("history 8 samples/day", hist[0].samples === 8);
const expectedMwh = (expectedHs / 2e6 / 1e6) * 8760 / 365; // MW*8760/365
t("history daily MWh at 2.0 MH/J", approx(hist[0].mwh, expectedMwh, 1e-9), hist[0].mwh);
t("history empty trend → empty", E.dailyEnergyHistory([], 2.0).length === 0);

/* --- trend lookup --- */
const tr = [[1, 1000, "10"], [100, 2000, "20"], [200, 3000, "30"]];
t("trendPointAtOrBelow exact", E.trendPointAtOrBelow(tr, 100)[0] === 100);
t("trendPointAtOrBelow below", E.trendPointAtOrBelow(tr, 150)[0] === 100);
t("trendPointAtOrBelow above last", E.trendPointAtOrBelow(tr, 999)[0] === 200);
t("trendPointAtOrBelow none", E.trendPointAtOrBelow(tr, 0) === null);

/* --- carbon --- */
t("1 TWh at 0.42 kg/kWh = 420 kt", approx(E.co2Tonnes(1e9, 0.42), 420000, 1e-9));
t("QTC annual all-4090 at 0.42 ≈ 46.9 kt",
  approx(E.co2Tonnes(E.annualTWh(mwBest) * 1e9, 0.42), 46935, 1e-2));

/* --- formatting --- */
t("fmtHashrate TH", E.fmtHashrate(29803468720130.666) === "29.80 TH/s");
t("fmtHashrate MH", E.fmtHashrate(818e6) === "818.00 MH/s");
t("fmtPowerMW", E.fmtPowerMW(12.756) === "12.76 MW");
t("fmtPowerMW kW", E.fmtPowerMW(0.35) === "350.0 kW");
t("fmtKwh TWh", E.fmtKwh(1.1175e8) === "111.75 GWh");
t("fmtKwh kWh", E.fmtKwh(42.52) === "42.52 kWh");
t("fmtJoules MJ", E.fmtJoules(1.53e8) === "153.0 MJ");
t("fmtMoney", E.fmtMoney(1234.5) === "$1.23k");
t("fmtMoney small", E.fmtMoney(1.26) === "$1.26");
t("fmtNum", E.fmtNum(137536) === "137,536");

/* --- external figures --- */
var extKeys = Object.keys(E.EXTERNAL);
t("external figures populated", extKeys.length >= 6);
for (var ei = 0; ei < extKeys.length; ei++) {
  var ex = E.EXTERNAL[extKeys[ei]];
  t("external " + extKeys[ei] + " has value+unit", typeof ex.value === "number" && ex.value > 0 && !!ex.unit);
  t("external " + extKeys[ei] + " has source+url+date", !!ex.source && /^https?:\/\//.test(ex.sourceUrl) && !!ex.date);
}
t("bitcoin cambridge 138 TWh", E.EXTERNAL.bitcoin_annual_twh_ccaf.value === 138);
t("bitcoin digiconomist 204.44 TWh", E.EXTERNAL.bitcoin_annual_twh_digiconomist.value === 204.44);
t("digiconomist > cambridge", E.EXTERNAL.bitcoin_annual_twh_digiconomist.value > E.EXTERNAL.bitcoin_annual_twh_ccaf.value);
t("us home 10,791 kWh/yr", E.EXTERNAL.us_home_kwh_2022.value === 10791);

/* --- fallback bundle: one capture, cross-checked with luck-lab ---------- */
// Regression guard for the 2026-10-02 mixed-date bug (see luck-core.test.js).
{
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
  const luckSrc = fs.readFileSync(path.join(__dirname, "../../luck-lab/js/app.js"), "utf8");
  const grab = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
  const diff = grab(src, /difficulty:\s*"(\d+)"/), sup = grab(src, /totalSupplyPlancks:\s*"(\d+)"/);
  const lDiff = grab(luckSrc, /difficulty:\s*(\d+),/), lRew = Number(grab(luckSrc, /reward:\s*([\d.]+)/));
  t("fallback: fields parse", !!(diff && sup && lDiff));
  t("fallback: difficulty matches luck-lab", diff === lDiff, diff + " vs " + lDiff);
  t("fallback: reward from own supply matches luck-lab reward",
    Math.abs(E.blockRewardQtc(sup) - lRew) <= 5e-8, E.blockRewardQtc(sup) + " vs " + lRew);
}

/* --- snapshot boundary (deriveSnapshotState) ---
 * app.js is a plain browser script; its Node hook exports the boundary
 * once EnergyCore is on the global (the browser gets it from the
 * energy-core.js <script> tag). */
{
  global.EnergyCore = E;
  const app = require("../js/app.js");
  const D = app.deriveSnapshotState;
  const CONS = { fetched_at: "2026-10-02T15:00:29.848Z", head: 153406,
    current: { height: 153406, difficulty: "669104327575800", est_hashrate_hs: "55758693964650" },
    trend: [[153000, 1756944000000, "669104327575800"], [153406, 1757030400000, "669104327575800"]] };
  const SUP = { fetched_at: "2026-10-02T15:00:40.038Z", block_height: 153406,
    total_supply_plancks: "5766179473775204913",
    balances_plancks: { free: "5766179473775204813", reserved: "100", frozen: "0" } };
  const LIV = { fetched_at: "2026-10-02T15:00:11.401Z",
    data: { daily: [{ date: "2026-10-02T00:00:00+00:00", blocks_count: 6000, tx_count: 12000 }] } };
  const cp = (o) => JSON.parse(JSON.stringify(o));

  const okD = D(CONS, SUP, LIV);
  t("boundary: valid capture anchors difficulty+height", okD.snapshotOk && okD.difficulty === "669104327575800" && okD.height === 153406);
  t("boundary: valid capture hashrate = difficulty/12", approx(okD.netHs, 669104327575800 / 12, 1e-12));
  t("boundary: valid capture reward from total", approx(okD.rewardQtc, E.blockRewardQtc("5766179473775204913"), 1e-12));
  t("boundary: valid capture tx rate", approx(okD.txRate, 12000 / (6000 * 12), 1e-12));
  t("boundary: valid capture trend survives whole", okD.trend.length === 2);

  const sci = cp(CONS); sci.current.difficulty = "9.9e13"; sci.current.est_hashrate_hs = "8250000000000";
  t("boundary: scientific-notation difficulty rejected", D(sci, SUP, LIV).snapshotOk === false);
  const mis = cp(CONS); mis.current.est_hashrate_hs = "1000";
  t("boundary: est_hashrate contradicting difficulty rejected", D(mis, SUP, LIV).snapshotOk === false);
  const frac = cp(CONS); frac.current.height = 153406.5; frac.head = 153406.5;
  t("boundary: fractional height rejected", D(frac, SUP, LIV).snapshotOk === false);
  const dis = cp(CONS); dis.head = 153407;
  t("boundary: head/current.height disagreement rejected", D(dis, SUP, LIV).snapshotOk === false);
  const und = cp(CONS); und.fetched_at = '<b id="pwn">PWNED</b>';
  t("boundary: garbage fetched_at rejected (payload is undated)", D(und, SUP, LIV).snapshotOk === false);

  const contra = cp(SUP); contra.total_supply_plancks = "9000000000000000000";
  t("boundary: total contradicting balances itemization rejected", D(CONS, contra, LIV).rewardQtc === null);
  const throwS = cp(SUP); delete throwS.total_supply_plancks; throwS.balances_plancks.free = "1.5";
  const throwD = D(CONS, throwS, LIV);
  t("boundary: fractional balance never throws; reward null, neighbours anchor",
    throwD.rewardQtc === null && throwD.snapshotOk === true && throwD.txRate > 0);
  const over = cp(SUP); over.total_supply_plancks = "22000000000000000000000";
  over.balances_plancks = { free: "22000000000000000000000", reserved: "0", frozen: "0" };
  t("boundary: over-cap total issuance rejected", D(CONS, over, LIV).rewardQtc === null);
  const mixed = cp(SUP); mixed.block_height = 100000;
  mixed.total_supply_plancks = "9000000000000000000";
  mixed.balances_plancks = { free: "9000000000000000000", reserved: "0", frozen: "0" };
  t("boundary: cross-capture supply rejected (one-capture rule)", D(CONS, mixed, LIV).rewardQtc === null);
  t("boundary: supply alone anchors reward (layered fallback)", D(null, SUP, null).rewardQtc > 0);

  const tr = cp(CONS);
  tr.trend = [[153406, "not-a-date", "669104327575800"], [153300, 1757030400000, "9.9e13"],
              [153000, 1756944000000, "669104327575800"]];
  t("boundary: poisoned trend points drop individually", D(tr, SUP, LIV).trend.length === 1);

  const ld = cp(LIV);
  ld.data.daily = [{ date: "2026-10-02T00:00:00+00:00", blocks_count: 6000, tx_count: "abc" },
                   { date: "2026-10-01T00:00:00+00:00", blocks_count: 6000, tx_count: 12000 }];
  t("boundary: poisoned daily row skipped, next valid row anchors", approx(D(CONS, SUP, ld).txRate, 12000 / 72000, 1e-12));
  const neg = cp(LIV); neg.data.daily[0].tx_count = -5;
  t("boundary: negative tx_count rejected", D(CONS, SUP, neg).txRate === null);
  const zb = cp(LIV); zb.data.daily[0].blocks_count = 0;
  t("boundary: zero blocks_count rejected", D(CONS, SUP, zb).txRate === null);
  const bd = cp(LIV); bd.data.daily[0].date = "not-a-date";
  t("boundary: garbage daily date rejected", D(CONS, SUP, bd).txRate === null);
  const ul = cp(LIV); delete ul.fetched_at;
  t("boundary: undated live payload rejected", D(CONS, SUP, ul).txRate === null);

  // The REAL current snapshots must pass their own boundary unchanged.
  const fs2 = require("fs"), path2 = require("path");
  const root = path2.join(__dirname, "..", "..", "..");
  const rCon = JSON.parse(fs2.readFileSync(path2.join(root, "data/consensus.json"), "utf8"));
  const rSup = JSON.parse(fs2.readFileSync(path2.join(root, "data/supply.json"), "utf8"));
  const rLiv = JSON.parse(fs2.readFileSync(path2.join(root, "data/live.json"), "utf8"));
  const rD = D(rCon, rSup, rLiv);
  t("boundary: real snapshots anchor (difficulty+reward+rate)", rD.snapshotOk && rD.rewardQtc > 0 && rD.txRate > 0);
  t("boundary: real trend survives whole", rD.trend.length === rCon.trend.length, rD.trend.length + " vs " + rCon.trend.length);
}

console.log(pass + "/" + (pass + fail) + " tests green");
process.exit(fail ? 1 : 0);
