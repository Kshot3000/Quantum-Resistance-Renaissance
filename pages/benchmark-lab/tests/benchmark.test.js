// Node unit tests for pages/benchmark-lab/app.js — run: node tests/benchmark.test.js
var assert = require("assert");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + e.message); } }
function approx(a, b, eps){ assert.ok(Math.abs(a-b) <= eps, "expected ~" + b + " got " + a); }

// 1. Chain roster: 5 chains, unique ids, all have colors
t("chain roster complete", function(){
  assert.strictEqual(m.CHAINS.length, 5);
  var ids = m.CHAINS.map(function(c){ return c.id; });
  assert.deepStrictEqual(ids, ["qtc","btc","eth","sol","erg"]);
  m.CHAINS.forEach(function(c){
    assert.ok(/^#[0-9a-f]{6}$/.test(c.color), c.id + " color");
    assert.ok(c.name && c.sym && c.tag, c.id + " labels");
  });
});

// 2. Every metric has a row for every chain
t("matrix fully populated", function(){
  assert.ok(m.METRICS.length >= 10, "at least 10 metrics, got " + m.METRICS.length);
  m.METRICS.forEach(function(met){
    m.CHAINS.forEach(function(c){
      assert.ok(met.rows[c.id], met.id + " missing row for " + c.id);
    });
  });
});

// 3. Every cell cited; "unverified" allowed ONLY as an explicit, sourced absence statement
t("no unverified cells; all cited", function(){
  var bad = [];
  m.METRICS.forEach(function(met){
    m.CHAINS.forEach(function(c){
      var cell = met.rows[c.id];
      if (!cell || cell.v === "TODO") { bad.push(met.id + "/" + c.id); return; }
      assert.ok(m.BADGE_LABEL[cell.b], met.id + "/" + c.id + " unknown badge " + cell.b);
      assert.ok(/^https:\/\//.test(cell.s || ""), met.id + "/" + c.id + " missing source");
      if (cell.b === "unverified"){
        assert.ok(cell.n && cell.n.length > 20, met.id + "/" + c.id + " unverified needs explanatory note");
        assert.ok(/^no /i.test(cell.v) || /not published|could not/i.test(cell.v),
          met.id + "/" + c.id + " unverified must state the absence, not a number");
      }
    });
  });
  assert.strictEqual(bad.length, 0, "uncited cells: " + bad.join(", "));
});

// 4. Quantus signature sizes match FIPS 204
t("ML-DSA sizes per FIPS 204", function(){
  var sigRows = {};
  m.SIGS.forEach(function(s){ sigRows[s.name] = s.bytes; });
  assert.strictEqual(sigRows["ML-DSA-65"], 3309);
  assert.strictEqual(sigRows["ML-DSA-87"], 4627);
  assert.strictEqual(sigRows["ECDSA (secp256k1)"], 64);
});

// 5. TPS ceiling math
t("tpsCeiling arithmetic", function(){
  // Bitcoin: 4M weight units / 250 B / 600 s ≈ 26.7
  approx(m.tpsCeiling(4000000, 600, 250), 26.67, 0.01);
  // null-safety
  assert.strictEqual(m.tpsCeiling(0, 600, 250), null);
  assert.strictEqual(m.tpsCeiling(4000000, 600, 0), null);
  assert.strictEqual(m.tpsCeiling(4000000, 600, -5), null);
});

// 6. fmt helpers
t("formatters", function(){
  assert.strictEqual(m.fmtTps(26500), "26.5k");
  assert.strictEqual(m.fmtTps(26504), "26.5k");
  assert.strictEqual(m.fmtTps(430), "430");
  assert.strictEqual(m.fmtTps(7.25), "7.25");
  assert.strictEqual(m.fmtTps(null), "n/a");
  assert.strictEqual(m.fmtBytes(7000), "6.8 KB");
  assert.strictEqual(m.fmtBytes(64), "64 B");
  assert.strictEqual(m.fmtBytes(3309), "3.2 KB");
});

// 7. Fairness cards + verdicts complete for all chains
t("fairness and verdicts complete", function(){
  assert.strictEqual(m.FAIRNESS.length, 5);
  m.FAIRNESS.forEach(function(f){
    assert.strictEqual(f.rows.length, 4, f.id);
    f.rows.forEach(function(r){ assert.ok(r[1] !== "TODO", f.id + " " + r[0]); });
  });
  assert.strictEqual(m.VERDICTS.length, 5);
  m.VERDICTS.forEach(function(v){
    assert.ok(v.pro !== "TODO" && v.con !== "TODO", v.id);
    assert.ok(v.pro.length > 40, v.id + " pro too thin");
    assert.ok(v.con.length > 40, v.id + " con too thin");
  });
});

// 8. Sources list non-empty, all https
t("sources well-formed", function(){
  assert.ok(m.SOURCES.length >= 5, "want >=5 sources, got " + m.SOURCES.length);
  m.SOURCES.forEach(function(s){
    assert.ok(/^https:\/\//.test(s.u), s.t);
    assert.ok(s.d, s.t + " missing date");
  });
});

// 9. Quantus TPS design target consistent with its own params
t("quantus tps params self-consistent", function(){
  var p = m.TPS_PARAMS.qtc;
  // capacity implied: 430 tps * 7000 B * 12 s
  assert.strictEqual(p.capBytes, 430*7000*12);
  approx(m.tpsCeiling(p.capBytes, p.blockS, 7000), 430, 0.001);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
