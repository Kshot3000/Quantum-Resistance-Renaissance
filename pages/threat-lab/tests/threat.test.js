// Node unit tests for pages/threat-lab/app.js — run: node tests/threat.test.js
var assert = require("assert");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + e.message); } }

// 1. Scenarios: 3 sourced horizons, ascending UTC dates, one default
t("scenarios are ordered, unique, and have a default", function(){
  assert.strictEqual(m.SCENARIOS.length, 3);
  var ids = m.SCENARIOS.map(function(s){ return s.id; });
  assert.deepStrictEqual(ids, ["aggressive","benchmark","cautious"]);
  for (var i = 1; i < m.SCENARIOS.length; i++)
    assert.ok(m.SCENARIOS[i].date > m.SCENARIOS[i-1].date, "dates must ascend");
  assert.strictEqual(m.SCENARIOS[1].date, Date.UTC(2029,11,31));
  assert.ok(m.SCENARIOS.filter(function(s){ return s.def; }).length === 1);
  m.SCENARIOS.forEach(function(s){
    assert.ok(s.claim && s.src && s.who, "every scenario sourced");
    assert.ok(s.claim.toLowerCase().indexOf("predict") === -1, "no prediction language: " + s.id);
  });
});

// 2. Countdown math
t("countdownParts decomposes a known diff", function(){
  var now = Date.UTC(2026,8,29,12,0,0);
  var target = now + ((2*86400 + 3*3600 + 4*60 + 5) * 1000);
  var p = m.countdownParts(target, now);
  assert.deepStrictEqual([p.d,p.h,p.m,p.s,p.past], [2,3,4,5,false]);
});
t("countdownParts clamps past dates", function(){
  var p = m.countdownParts(1000, 2000);
  assert.ok(p.past === true && p.d === 0 && p.h === 0 && p.m === 0 && p.s === 0);
});

// 3. Exposure classification — the heart of the simulator
t("BTC exposure rules", function(){
  assert.strictEqual(m.assess("btc","btc-p2pk",1).exposure, "exposed");
  assert.strictEqual(m.assess("btc","btc-reused",1).exposure, "exposed");
  assert.strictEqual(m.assess("btc","btc-p2tr",1).exposure, "exposed");
  assert.strictEqual(m.assess("btc","btc-fresh",1).exposure, "safe-today");
});
t("ETH / SOL / ADA exposure rules", function(){
  assert.strictEqual(m.assess("eth","eth-spent",1).exposure, "exposed");
  assert.strictEqual(m.assess("eth","eth-fresh",1).exposure, "safe-today");
  assert.strictEqual(m.assess("sol","sol-standard",1).exposure, "exposed");
  assert.strictEqual(m.assess("sol","sol-vault",1).exposure, "partial");
  assert.strictEqual(m.assess("ada","ada-spent",1).exposure, "exposed");
  assert.strictEqual(m.assess("ada","ada-fresh",1).exposure, "safe-today");
});
t("QTC is always quantum-safe", function(){
  var r = m.assess("qtc","qtc-any",100);
  assert.strictEqual(r.exposure, "pq-safe");
  assert.strictEqual(r.label, "QUANTUM-SAFE");
  assert.strictEqual(r.risk, "0 at risk — by design");
});

// 4. Risk figures follow the verdict
t("amount at risk follows verdict", function(){
  assert.strictEqual(m.assess("btc","btc-p2pk",2.5).risk, "2.5 BTC at risk");
  assert.strictEqual(m.assess("btc","btc-fresh",2.5).risk, "0 at risk — until the first spend");
  assert.strictEqual(m.assess("eth","eth-spent",10).risk, "10 ETH at risk");
});
t("negative/NaN amounts are sanitized", function(){
  assert.strictEqual(m.assess("btc","btc-p2pk",-5).risk, "0 BTC at risk");
  assert.strictEqual(m.assess("btc","btc-p2pk",NaN).risk, "0 BTC at risk");
});

// 5. Every verdict carries why / crack / action copy
t("verdicts carry full copy", function(){
  m.CHAINS.forEach(function(c){
    c.wallets.forEach(function(w){
      var r = m.assess(c.id, w.id, 1);
      assert.ok(r.why.length > 40, c.id + "/" + w.id + " why too short");
      assert.ok(r.crack.length > 40, c.id + "/" + w.id + " crack too short");
      assert.ok(r.action.length > 20, c.id + "/" + w.id + " action too short");
      assert.ok(r.plan.length > 20, c.id + " plan missing");
    });
  });
});

// 6. Chain table data integrity
t("chains have exactly 5 entries with valid status classes", function(){
  assert.strictEqual(m.CHAINS.length, 5);
  var valid = ["st-bad","st-warn","st-safe"];
  m.CHAINS.forEach(function(c){
    assert.ok(valid.indexOf(c.statusClass) !== -1, c.id);
    assert.ok(c.sigs && c.plan && c.unit && c.icon, c.id);
    assert.ok(c.wallets.length >= 1, c.id);
  });
  var ids = m.CHAINS.map(function(c){ return c.id; });
  assert.deepStrictEqual(ids, ["btc","eth","sol","ada","qtc"]);
});

// 7. Timeline ordered + future markers sane
t("timeline is chronological", function(){
  var prev = -1;
  m.TIMELINE.forEach(function(e){
    var key = e.y * 100 + (e.m || 0);
    assert.ok(key >= prev, "timeline out of order at " + e.t);
    prev = key;
    assert.ok(e.t && e.d, "timeline entry needs title + detail");
  });
  assert.ok(m.TIMELINE.length >= 12, "timeline should be substantial");
});

// 8. Sources: every entry has a full https URL
t("sources are complete https URLs", function(){
  assert.ok(m.SOURCES.length >= 15, "expected a deep source list");
  m.SOURCES.forEach(function(s){
    assert.ok(/^https:\/\//.test(s.u), "bad URL: " + s.u);
    assert.ok(s.t && s.d, "source needs title + verified date");
  });
});

// 9. assess() is robust to bad input
t("assess falls back on unknown ids", function(){
  var r = m.assess("nope","nope",1);
  assert.ok(r.chain === "Bitcoin", "falls back to first chain");
  assert.ok(r.exposure, "still produces a verdict");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
