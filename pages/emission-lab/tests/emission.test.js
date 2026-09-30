// Node unit tests for pages/emission-lab/app.js — run: node tests/emission.test.js
var assert = require("assert");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + e.message); } }
function approx(a, b, eps){ assert.ok(Math.abs(a - b) <= eps, "expected ~" + b + " got " + a); }

// 1. Protocol constants match the verified sources
t("verified protocol constants", function(){
  assert.strictEqual(m.MAX_SUPPLY, 21000000);
  assert.strictEqual(m.GENESIS_MINT, 5670000, "27% of 21M");
  assert.strictEqual(m.MINING_EMISSIONS, 15330000, "73% of 21M");
  assert.strictEqual(m.EMISSION_DIVISOR, 50000000, "runtime/src/configs/mod.rs");
  assert.strictEqual(m.GENESIS_MINT + m.MINING_EMISSIONS, m.MAX_SUPPLY);
  assert.strictEqual(m.PLANCKS, 1e12);
  assert.strictEqual(m.LEAF_QUANTUM_QTC, 0.01);
});

// 2. Reward formula: reward = remaining / divisor
t("reward formula", function(){
  approx(m.rewardQtc(0, 15300000), 0.306, 1e-9);
  approx(m.rewardQtc(0, 5000000), 0.1, 1e-12);
  approx(m.rewardQtc(0, 500000), 0.01, 1e-12);
});

// 3. Supply + remaining = MAX always
t("supply conservation", function(){
  var R0 = 15288000;
  [0, 1e5, 1e6, 34.66e6, 171e6].forEach(function(n){
    approx(m.supplyQtc(n, R0) + m.remainingQtc(n, R0), m.MAX_SUPPLY, 1e-3);
  });
});

// 4. Exponential limit: after D blocks, remaining -> R0/e
t("decay limit R0/e after D blocks", function(){
  var R0 = 15288000, r = m.remainingQtc(m.EMISSION_DIVISOR, R0) / R0;
  approx(r, 1 / Math.E, 2e-6);
});

// 5. blocksToRemaining inverts remainingQtc
t("blocksToRemaining inverts the decay", function(){
  var R0 = 15288000;
  [15288000, 11466000, 7644000, 3822000, 1528800, 500000].forEach(function(Rt){
    var n = m.blocksToRemaining(R0, Rt);
    approx(m.remainingQtc(n, R0), Rt, Rt * 1e-9);
  });
  assert.strictEqual(m.blocksToRemaining(R0, R0), 0);
  assert.strictEqual(m.blocksToRemaining(R0, R0 + 1), 0);
});

// 6. Halving time: ln(0.5)/ln(1-1/D) ≈ 34.657M blocks
t("halving blocks ≈ 34.657M", function(){
  approx(m.halvingBlocks(), 34657359, 2);
  var R0 = 15288000;
  approx(m.remainingQtc(m.halvingBlocks(), R0), R0 / 2, R0 * 1e-9);
});

// 7. issuanceOver + remaining = R0
t("issuance conservation", function(){
  var R0 = 15288000;
  [0, 6292, 2.3e6, 34.66e6].forEach(function(n){
    approx(m.issuanceOver(n, R0) + m.remainingQtc(n, R0), R0, 1e-3);
  });
});

// 8. Daily issuance ≈ current reward × blocks/day (decay within a day is tiny)
t("daily issuance sanity", function(){
  var R0 = 15288000, bpd = 6292;
  var daily = m.issuanceOver(bpd, R0);
  approx(daily / (m.rewardQtc(0, R0) * bpd), 1, 0.001);
  approx(daily, 1925, 15, "≈0.306 × 6292");
});

// 9. Annual inflation is sane at anchor (~12% early on, decaying)
t("annual inflation sanity", function(){
  var R0 = 15288000, bpd = 6292;
  var infl = m.annualInflation(R0, Math.round(bpd * 365.25));
  assert.ok(infl > 0.08 && infl < 0.16, "got " + infl);
  // inflation falls over time
  var later = m.issuanceOver(Math.round(bpd * 365.25), R0) * (m.remainingQtc(34.66e6, R0) / R0) / m.supplyQtc(34.66e6, R0);
  assert.ok(later < infl, "inflation should decay");
});

// 10. Quantization to leaf quantum
t("leaf quantum quantization", function(){
  assert.strictEqual(m.quantizeQuantum(0.306), 0.31);
  assert.strictEqual(m.quantizeQuantum(0.303), 0.30);
  assert.strictEqual(m.quantizeQuantum(0.1), 0.1);
  assert.strictEqual(m.quantizeQuantum(0), 0);
});

// 11. Milestones are ordered, sane, and carry reward/supply projections
t("milestones ordered and sane", function(){
  var R0 = 15288000, ms = m.milestones(R0, 6292);
  assert.strictEqual(ms.length, 7);
  for (var i = 1; i < ms.length; i++) assert.ok(ms[i].blocks > ms[i-1].blocks, "ordered: " + ms[i].label);
  assert.ok(ms[0].blocks > 10e6, "25% mined is >10M blocks out");
  ms.forEach(function(x){
    approx(x.rewardAt, (m.MAX_SUPPLY - x.supplyAt) / m.EMISSION_DIVISOR, 1e-9);
    assert.ok(x.days > 0 && x.blocks > 0);
  });
  // spot check: 50% of mining emissions: n = ln(0.5·15.33M/15.288M)/ln(1-1/50M) ≈ 34.52M
  var half = ms.filter(function(x){ return /50%/.test(x.label); })[0];
  approx(half.blocks, 34519650, 2e5);
});

// 12. Formatting helpers
t("formatters", function(){
  assert.strictEqual(m.fmtQTC(0.306, 4), "0.3060");
  assert.strictEqual(m.fmtInt(34565759), "34,565,759");
  assert.strictEqual(m.fmtCompact(15288000), "15.29M");
  assert.strictEqual(m.fmtCompact(21000000), "21.00M");
  assert.strictEqual(m.fmtDays(100), "100 days");
  assert.strictEqual(m.fmtDays(5932), "16.2 yrs");
  assert.ok(/2026|2027/.test(m.fmtDate(Date.UTC(2026, 8, 30))));
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
