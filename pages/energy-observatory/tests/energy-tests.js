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

/* --- emission --- */
t("block reward at 44,658.08 QTC supply ≈ 0.419107",
  approx(E.blockRewardQtc("44658080000000000"), 0.4191068384, 1e-9));

/* --- rig builder --- */
const rigHs = 818e6;
const qtcDay = E.rigExpectedQtcPerDay(rigHs, net, 0.4191068384);
t("1×4090 expected QTC/day ≈ 0.0828", approx(qtcDay, 0.08282, 1e-2), qtcDay);
t("expected QTC scales with rig hashrate",
  approx(E.rigExpectedQtcPerDay(2 * rigHs, net, 0.4191068384), 2 * qtcDay, 1e-12));
t("zero rig → zero QTC", E.rigExpectedQtcPerDay(0, net, 0.4191) === 0);
t("zero network → zero QTC", E.rigExpectedQtcPerDay(rigHs, 0, 0.4191) === 0);
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

console.log(pass + "/" + (pass + fail) + " tests green");
process.exit(fail ? 1 : 0);
