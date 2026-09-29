// Node unit tests for pages/mining-calculator/app.js — run: node tests/calc.test.js
var assert = require("assert");
var m = require("../app.js");
var CHAIN = m.CHAIN, chainState = m.chainState, estimate = m.estimate;

var passed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ console.error("FAIL - " + name + ": " + e.message); process.exitCode = 1; } }
function approx(a, b, eps){ assert.ok(Math.abs(a-b) <= eps, "expected ~" + b + " got " + a); }

// 1. Genesis state: supply = 5.67M, reward = 15.33M/50M = 0.3066
t("genesis supply and reward", function(){
  var s = chainState(CHAIN.MAINNET_T0);
  assert.strictEqual(s.supply, 5670000);
  approx(s.reward, 0.3066, 1e-9);
  assert.strictEqual(s.blocks, 0);
  assert.strictEqual(s.blocksPerDay, 7200);
});

// 2. Decay: reward strictly decreases, supply grows; 1-year spot values
t("emission decays smoothly over one year", function(){
  var y0 = chainState(CHAIN.MAINNET_T0).reward;
  var y1 = chainState(CHAIN.MAINNET_T0 + 365.25*86400*1000);
  assert.ok(y1.reward < y0, "reward must decay");
  assert.ok(y1.supply > 5670000, "supply must grow");
  // blocks/yr = 365.25*7200 = 2,629,800; remaining = 15.33M * e^(-2629800/50M)
  var exp = 15330000 * Math.exp(-2629800/50000000);
  approx(y1.supply, 21000000 - exp, 1);
  approx(y1.reward, exp/50000000, 1e-6);
});

// 3. Estimator: 1 GH/s vs 100 GH/s network
t("estimator share math", function(){
  var s = chainState(CHAIN.MAINNET_T0);
  var e = estimate({ userHs: 1e9, netHs: 1e11, watts: 450, kwhPrice: 0.12, qtcPrice: 0, reward: s.reward });
  approx(e.share, 0.01, 1e-12);
  approx(e.blocksPerDay, 72, 1e-9);
  approx(e.qtcPerDay, 72 * s.reward, 1e-9);
  approx(e.daysPerBlock, 100/7200, 1e-9);
  approx(e.powerCost, 0.45*24*0.12, 1e-9);
  assert.strictEqual(e.hasPrice, false);
  assert.strictEqual(e.profit, -e.powerCost); // no price -> profit is -cost
});

// 4. Share clamps at 100%
t("share clamps at 100%", function(){
  var e = estimate({ userHs: 5e9, netHs: 1e9, watts: 0, kwhPrice: 0, qtcPrice: 0, reward: 0.3 });
  assert.strictEqual(e.share, 1);
  assert.strictEqual(e.shareClamped, true);
  approx(e.blocksPerDay, 7200, 1e-9);
});

// 5. Break-even: 1000W @ $0.10/kWh = $2.40/day; mining 1 QTC/day -> $2.40/QTC
t("break-even price math", function(){
  var e = estimate({ userHs: 1e9, netHs: 1e9, watts: 1000, kwhPrice: 0.10, qtcPrice: 0, reward: 1/7200 });
  approx(e.powerCost, 2.40, 1e-9);
  approx(e.qtcPerDay, 1, 1e-9);
  approx(e.breakeven, 2.40, 1e-9);
});

// 6. Revenue & profit with a price
t("revenue and profit with assumed price", function(){
  var e = estimate({ userHs: 1e9, netHs: 1e11, watts: 450, kwhPrice: 0.12, qtcPrice: 10, reward: 0.3 });
  approx(e.revenue, e.qtcPerDay * 10, 1e-9);
  approx(e.profit, e.revenue - e.powerCost, 1e-9);
  assert.strictEqual(e.hasPrice, true);
});

// 7. Zero network hashrate -> zero share, no crash
t("zero network hashrate is safe", function(){
  var e = estimate({ userHs: 1e9, netHs: 0, watts: 100, kwhPrice: 0.1, qtcPrice: 5, reward: 0.3 });
  assert.strictEqual(e.share, 0);
  assert.strictEqual(e.qtcPerDay, 0);
  assert.strictEqual(isFinite(e.daysPerBlock), false);
});

// 8. Formatters handle edge values
t("formatters", function(){
  assert.strictEqual(m.fmtQTC(Infinity), "\u2014");
  assert.strictEqual(m.fmtMoney(-2.4), "-$2.40");
  assert.strictEqual(m.fmtDuration(Infinity), "\u2014");
  assert.strictEqual(m.fmtDuration(0.5), "12.0 hours");
});

console.log(passed + " tests passed");
