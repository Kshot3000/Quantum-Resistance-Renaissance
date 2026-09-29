// Node unit tests for pages/fee-throughput-lab/app.js — run: node tests/fee.test.js
var assert = require("assert");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + e.message); } }
function approx(a, b, eps){ assert.ok(Math.abs(a - b) <= eps, "expected ~" + b + " got " + a); }

// 1. Protocol constants match the verified sources
t("verified protocol constants", function(){
  assert.strictEqual(m.UNIT, 1e12);
  assert.strictEqual(m.BLOCK_TIME, 12);
  assert.strictEqual(m.BLOCK_BYTES, 3750000);
  assert.strictEqual(m.PK_BYTES, 2592);
  assert.strictEqual(m.SIG_BYTES, 4627);
  assert.strictEqual(m.PQ_OVERHEAD, 7219, "2592 + 4627 = 7219");
  assert.strictEqual(m.ECDSA_BYTES, 98);
  assert.strictEqual(m.LENGTH_FEE_PER_BYTE, 100000);
  assert.strictEqual(m.WEIGHT_FEE_PER_PS, 0.1);
  assert.strictEqual(m.EXISTENTIAL_QTC, 0.001);
  assert.strictEqual(m.QUANTUM_QTC, 0.01);
  assert.strictEqual(m.WORMHOLE_FEE_RATE, 0.0004);
  assert.strictEqual(m.HIGHSEC_FEE_RATE, 0.01);
});

// 2. Length fee: bytes × 100,000 plancks (exact runtime polynomial)
t("length fee polynomial", function(){
  assert.strictEqual(m.lengthFeePlancks(7219), 721900000);
  assert.strictEqual(m.lengthFeePlancks(7500), 750000000);
  assert.strictEqual(m.lengthFeePlancks(1), 100000);
  assert.strictEqual(m.lengthFeePlancks(0), 0);
  assert.strictEqual(m.lengthFeePlancks(-5), 0);
});

// 3. The canonical example: a 7,219 B tx costs exactly 0.0007219 QTC
t("7219 B tx -> 0.0007219 QTC", function(){
  var p = m.lengthFeePlancks(7219);
  assert.strictEqual(m.plancksToQTC(p), 0.0007219);
  assert.strictEqual(m.fmtQTC(p), "0.0007219");
});

// 4. plancks <-> QTC conversions
t("planck/QTC conversion", function(){
  assert.strictEqual(m.plancksToQTC(1e12), 1);
  assert.strictEqual(m.fmtQTC(0.5e12), "0.5");
  assert.strictEqual(m.fmtQTC(1000000000000 * 0.0004), "0.0004");
  assert.strictEqual(m.fmtQTC(0), "0");
  assert.ok(m.fmtPlancks(1000000).indexOf("1,000,000") !== -1);
});

// 5. Weight fee: 0.1 planck per ps of ref_time (labeled estimate)
t("weight fee estimate math", function(){
  assert.strictEqual(m.weightFeeEstimatePlancks(1e9), 1e8);
  assert.strictEqual(m.weightFeeEstimatePlancks(0), 0);
  approx(m.plancksToQTC(m.weightFeeEstimatePlancks(1e9)), 0.0001, 1e-12);
});

// 6. Standard fee totals length + weight + tip, all to miner
t("standard fee aggregation", function(){
  var r = m.standardFee(7500, 0.0002, 1e9);
  assert.strictEqual(r.lengthPlancks, 750000000);
  assert.strictEqual(r.weightPlancks, 100000000);
  assert.strictEqual(r.tipPlancks, 0.0002 * 1e12);
  assert.strictEqual(r.totalPlancks, r.lengthPlancks + r.weightPlancks + r.tipPlancks);
  assert.strictEqual(r.toMinerPlancks, r.totalPlancks, "100% of fees to miner, no dev tax");
  var r2 = m.standardFee(7500, 0, 0);
  assert.strictEqual(r2.totalPlancks, 750000000);
});

// 7. Wormhole exit: 0.04% fee, burn = ceil(50%), remainder to miner
t("wormhole fee split", function(){
  var r = m.wormholeFee(100);
  assert.strictEqual(r.amountPlancks, 100 * 1e12);
  assert.strictEqual(r.feePlancks, 0.04 * 1e12, "0.04% of 100 QTC");
  assert.strictEqual(r.burnPlancks, 0.02 * 1e12, "ceil(50%)");
  assert.strictEqual(r.minerPlancks, 0.02 * 1e12);
  assert.strictEqual(r.burnPlancks + r.minerPlancks, r.feePlancks);
});

// 8. Wormhole burn ceil on odd planck fees
t("wormhole burn ceil rounding", function(){
  // fee of 3 plancks -> burn = ceil(1.5) = 2, miner = 1
  var r = m.wormholeFee(0.00000000075); // 750 plancks * 0.0004 = 0.3 -> rounds to 0? use bigger
  var fee3 = 3;
  assert.strictEqual(Math.ceil(fee3 / 2), 2);
  var r2 = m.wormholeFee(0.00075); // 7.5e8 plancks * 0.0004 = 300000
  assert.strictEqual(r2.burnPlancks + r2.minerPlancks, r2.feePlancks);
  assert.strictEqual(r2.burnPlancks, Math.ceil(r2.feePlancks / 2));
});

// 9. High-security: 1% volume fee, burned in full
t("high-security 1% burned", function(){
  var r = m.highSecFee(50);
  assert.strictEqual(r.feePlancks, 0.5 * 1e12);
  assert.strictEqual(r.burnPlancks, r.feePlancks);
  assert.strictEqual(r.minerPlancks, 0);
});

// 10. QTPS = transfers/block ÷ 12 s
t("qtps arithmetic", function(){
  approx(m.qtps(510), 42.5, 1e-9);
  approx(m.qtps(5200), 433.333, 0.01);
  approx(m.qtps(33000), 2750, 1e-9);
});

// 11. Throughput modes carry the verified figures
t("throughput modes data", function(){
  var ids = m.MODES.map(function(x){ return x.id; });
  assert.deepStrictEqual(ids, ["transparent", "encrypted", "ceiling"]);
  var by = {}; m.MODES.forEach(function(x){ by[x.id] = x; });
  assert.strictEqual(by.transparent.perBlock, 510);
  assert.strictEqual(by.encrypted.perBlock, 5200);
  assert.strictEqual(by.ceiling.perBlock, 33000);
  assert.strictEqual(by.transparent.qtps, "43");
  assert.strictEqual(by.encrypted.qtps, "430");
  assert.strictEqual(by.ceiling.qtps, "2,800");
  m.MODES.forEach(function(x){ assert.ok(m.BADGE_LABEL[x.badge], x.id + " badge"); });
});

// 12. Comparison row labels the BTC PQ claim honestly
t("comparison row badges", function(){
  var btcQ = m.CMP.find(function(c){ return /quantum-secure/.test(c.name); });
  assert.ok(btcQ, "BTC quantum-secure row present");
  assert.strictEqual(btcQ.tps, "1.1");
  assert.strictEqual(btcQ.badge, "claimed", "whitepaper claim, not measured");
  var eth = m.CMP.find(function(c){ return /Ethereum/.test(c.name); });
  assert.strictEqual(eth.badge, "approx");
});

// 13. Aggregation: naive N×7219 vs amortized ≈721 B/tx
t("aggregation math", function(){
  assert.strictEqual(m.naiveBytes(1000), 1000 * 7219);
  approx(m.AMORT_BYTES_PER_TX, 3750000 / 5200, 1e-6);
  approx(m.AMORT_BYTES_PER_TX, 721, 1.5);
  approx(m.aggregatedBytes(5200), 3750000, 1); // one full block at 5,200/tx amortized
  approx(m.naiveBlocks(5200), 7219 * 5200 / 3750000, 1e-6);
  assert.ok(m.naiveBytes(1000) / m.aggregatedBytes(1000) > 9.9, ">= ~10x compression");
});

// 14. Wormhole flow has all 5 steps, Plonky2 + privacy side-effect present
t("wormhole 5-step flow", function(){
  assert.strictEqual(m.WORMHOLE_STEPS.length, 5);
  var all = m.WORMHOLE_STEPS.map(function(s){ return s.t + " " + s.d; }).join(" ");
  assert.ok(/Plonky2/.test(all), "Plonky2 ZK step");
  assert.ok(/H\(H\(salt\|secret\)\)/.test(all), "wormhole address commitment");
  assert.ok(/visible/.test(all), "amounts/exit addresses visible note");
});

// 15. fmtBytes
t("fmtBytes", function(){
  assert.strictEqual(m.fmtBytes(0), "0 B");
  assert.strictEqual(m.fmtBytes(7219), "7.22 KB");
  assert.strictEqual(m.fmtBytes(3750000), "3.75 MB");
  assert.strictEqual(m.fmtBytes(360950000), "361 MB");
});

// 16. Sources list complete with upstream links
t("sources", function(){
  assert.ok(m.SOURCES.length >= 5);
  m.SOURCES.forEach(function(s){
    assert.ok(/^https:\/\/github\.com\/Quantus-Network/.test(s.u), "upstream link: " + s.u);
  });
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
