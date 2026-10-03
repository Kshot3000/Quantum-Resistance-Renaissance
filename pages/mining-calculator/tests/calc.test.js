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

// 9. Snapshot derivation: realistic 2026-10-02 18:10Z capture shapes
t("deriveNetworkDefaults reads the hourly snapshots", function(){
  var cons = { fetched_at: "2026-10-02T18:10:34.156Z", head: 154192,
    current: { height: 154192, difficulty: "669643631900391", est_hashrate_hs: "55803635991699" },
    block_times_ms: { avg_ms: 12669, sample: 3000 } };
  var sup = { fetched_at: "2026-10-02T18:10:42.628Z", block_height: 154192,
    total_supply_plancks: "5766760000247799778" };
  var d = m.deriveNetworkDefaults(cons, sup);
  assert.strictEqual(d.netHs, 55803635991699);
  approx(d.supplyQtc, 5766760.0002, 0.001);
  approx(d.blocksPerDay, 86400000 / 12669, 0.01);
  assert.strictEqual(d.height, 154192);
  assert.strictEqual(d.fetchedAt, "2026-10-02T18:10:34.156Z");
  approx(m.blockReward(d.supplyQtc), 0.3046648, 1e-7);
});

// 10. Derivation rejects junk field-by-field, never throws
t("deriveNetworkDefaults is null-safe and plausibility-gated", function(){
  var d0 = m.deriveNetworkDefaults(null, null);
  assert.deepStrictEqual(d0, { netHs: null, supplyQtc: null, blocksPerDay: null, avgBlockMs: null, height: null, fetchedAt: null });
  var d1 = m.deriveNetworkDefaults(
    { current: { est_hashrate_hs: "0" }, block_times_ms: { avg_ms: 500 } },
    { total_supply_plancks: "4000000000000000000" }); // 4.0M < genesis mint
  assert.strictEqual(d1.netHs, null);
  assert.strictEqual(d1.blocksPerDay, null);
  assert.strictEqual(d1.supplyQtc, null);
});

// 11. Supply falls back to the balances aggregate (total issuance)
t("totalSupplyOf aggregates free+reserved+frozen", function(){
  var sup = { balances_plancks: { free: "5000000000000000000", reserved: "766760000247799778", frozen: "0" } };
  assert.strictEqual(m.totalSupplyOf(sup), "5766760000247799778");
  var d = m.deriveNetworkDefaults(null, sup);
  approx(d.supplyQtc, 5766760.0002, 0.001);
  assert.strictEqual(m.totalSupplyOf(null), null);
  assert.strictEqual(m.totalSupplyOf({}), null);
});

// 12. FALLBACK bundle integrity — one capture, internally consistent
t("fallback bundle is one consistent capture", function(){
  var F = m.FALLBACK;
  assert.strictEqual(F.netHs, Math.floor(Number(F.difficulty) / 12), "netHs = difficulty / 12s");
  approx(Number(F.totalSupplyPlancks) / 1e12, F.supplyQtc, 0.001); // supplyQtc stored rounded to 4dp
  approx(m.blockReward(F.supplyQtc), 0.3046213, 1e-7);
  assert.strictEqual(F.height, 156769);
  assert.ok(F.fetchedAt.indexOf("2026-10-03") === 0, "fallback is dated 2026-10-03");
  // The old bug, pinned: the pre-v1.9.0 static default was 10 GH/s.
  assert.ok(F.netHs > 1e12, "fallback network rate is TH/s-scale, not the old 10 GH/s example");
});

// 13. Estimate honors an observed-pace blocksPerDay override
t("estimate uses observed pace when given", function(){
  var base = { userHs: 1e9, netHs: 1e11, watts: 0, kwhPrice: 0, qtcPrice: 0, reward: 0.3 };
  var target = estimate(base);
  approx(target.blocksPerDay, 72, 1e-9); // 7200/day protocol target
  var paced = estimate(Object.assign({}, base, { blocksPerDay: 7216.84 }));
  approx(paced.blocksPerDay, 0.01 * 7216.84, 1e-6);
  approx(paced.daysPerBlock, 100 / 7216.84, 1e-9);
  approx(paced.qtcPerDay, paced.blocksPerDay * 0.3, 1e-9);
});

// 14. Default-rig honesty: 500 MH/s vs the fallback network ≈ 0.02 QTC/day
t("default rig estimate is honest at fallback defaults", function(){
  var e = estimate({ userHs: 500e6, netHs: m.FALLBACK.netHs, watts: 450, kwhPrice: 0.12,
                     qtcPrice: 0, reward: m.blockReward(m.FALLBACK.supplyQtc),
                     blocksPerDay: 86400000 / m.FALLBACK.avgBlockMs });
  assert.ok(e.qtcPerDay > 0.015 && e.qtcPerDay < 0.025, "expected ~0.0186 QTC/day, got " + e.qtcPerDay);
});

// 15. HTML guards: fallback-accurate defaults + provenance hooks + cache key
t("index.html carries the fallback defaults and v1.9.5 key", function(){
  var fs = require("fs"), path = require("path");
  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.indexOf('id="in-net" type="number" min="0" step="any" value="62.620"') >= 0, "in-net defaults to the fallback TH/s figure");
  assert.ok(html.indexOf('<option selected>TH/s</option>') >= 0, "network unit defaults to TH/s");
  assert.ok(html.indexOf('id="net-hint"') >= 0 && html.indexOf('id="supply-hint"') >= 0 && html.indexOf('id="stats-src"') >= 0, "provenance hooks present");
  assert.ok(html.indexOf("app.js?v=1.9.5") >= 0, "app.js cache key bumped to 1.9.5");
  assert.ok(html.indexOf("Example figure") < 0, "the old 'example figure' network default is gone");
});

console.log(passed + " tests passed");
