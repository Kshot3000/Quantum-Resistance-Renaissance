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
  assert.strictEqual(r.tipPlancks, 200000000, "tip parsed exactly, not 0.0002*1e12 float");
  assert.strictEqual(r.totalPlancks, r.lengthPlancks + r.weightPlancks + r.tipPlancks);
  assert.strictEqual(r.toMinerPlancks, r.totalPlancks, "100% of fees to miner, no dev tax");
  var r2 = m.standardFee(7500, 0, 0);
  assert.strictEqual(r2.totalPlancks, 750000000);
});

// 7. Wormhole exit at a whole-quanta boundary: 100 QTC -> exactly 4 quanta
t("wormhole fee split", function(){
  var r = m.wormholeFee(100);
  assert.strictEqual(r.amountPlancks, 100n * 1000000000000n);
  assert.strictEqual(r.feeQuanta, 4n);
  assert.strictEqual(r.feePlancks, 4n * m.QUANTUM_PLANCKS, "0.04% of 100 QTC = 0.04 QTC");
  assert.strictEqual(r.burnPlancks, 2n * m.QUANTUM_PLANCKS, "ceil(50%) in whole quanta");
  assert.strictEqual(r.minerPlancks, 2n * m.QUANTUM_PLANCKS);
  assert.strictEqual(r.burnPlancks + r.minerPlancks, r.feePlancks);
});

// 8. Wormhole settlement ceil-rounds to whole quanta (pallet semantics).
// The pre-fix float code returned the raw 0.04% with no quantum rounding —
// wrong in 199,920 of the first 200,000 whole-quanta amounts.
t("wormhole quantum ceil rounding", function(){
  var r = m.wormholeFee("101"); // raw 0.0404 QTC -> 5 quanta
  assert.strictEqual(r.feeQuanta, 5n);
  assert.strictEqual(r.feePlancks, 5n * m.QUANTUM_PLANCKS);
  assert.strictEqual(r.burnPlancks, 3n * m.QUANTUM_PLANCKS, "ceil(5/2) quanta — rounds against the miner");
  assert.strictEqual(r.minerPlancks, 2n * m.QUANTUM_PLANCKS);
  var small = m.wormholeFee("10"); // raw 0.004 QTC -> minimum 1 quantum
  assert.strictEqual(small.feeQuanta, 1n);
  assert.strictEqual(small.burnPlancks, 1n * m.QUANTUM_PLANCKS);
  assert.strictEqual(small.minerPlancks, 0n);
  var tiny = m.wormholeFee("0.00075"); // sub-quantum exit still pays 1 quantum
  assert.strictEqual(tiny.feeQuanta, 1n);
  assert.strictEqual(m.wormholeFee(0).feePlancks, 0n, "zero amount -> zero fee");
  assert.strictEqual(m.wormholeFee("").feePlancks, 0n);
});

// 9. High-security: 1% volume fee, burned in full, Permill floor to the planck
t("high-security 1% burned", function(){
  var r = m.highSecFee(50);
  assert.strictEqual(r.feePlancks, 500000000000n);
  assert.strictEqual(r.burnPlancks, r.feePlancks);
  assert.strictEqual(r.minerPlancks, 0n);
  var odd = m.highSecFee("1.234567890123"); // 1,234,567,890,123 plancks
  assert.strictEqual(odd.amountPlancks, 1234567890123n);
  assert.strictEqual(odd.feePlancks, 12345678901n, "floor(amount/100), not float Math.round");
});

// 17. Exact decimal -> planck parser (the Pay Desk float lesson, applied here)
t("qtcToPlancksExact", function(){
  var p = m.qtcToPlancksExact;
  assert.strictEqual(p("1.005"), 1005000000000n);
  assert.strictEqual(p("0.0002"), 200000000n);
  assert.strictEqual(p("100"), 100000000000000n);
  assert.strictEqual(p("0.0000000000005"), 1n, "half a planck rounds half-up");
  assert.strictEqual(p("0.0000000000004"), 0n);
  assert.strictEqual(p("1e-13"), 0n);
  assert.strictEqual(p("2.5e-12"), 3n, "exponent form, 2.5 plancks -> 3");
  assert.strictEqual(p("9007199.254740993"), 9007199254740993000n, "exact above 2^53 plancks");
  assert.strictEqual(p("-5"), 0n);
  assert.strictEqual(p(""), 0n);
  assert.strictEqual(p(0.0002), 200000000n, "number input via shortest round-trip string");
});

// 18. Sweep: wormhole fee vs the pallet's own fixed point. The pallet charges
// ceil(net_quanta*4/9996) on the minted amount; for every gross (in whole
// quanta) that decomposes exactly, the app fee must equal the pallet fee.
t("wormhole sweep vs pallet fixed point", function(){
  for (var g = 1; g <= 20000; g++){
    var grossFee = m.wormholeFee(String(g / 100)).feeQuanta; // g quanta = g/100 QTC
    var found = -1;
    for (var o = Math.max(0, g - Math.ceil(g * 4 / 9996) - 2); o <= g; o++){
      if (o + Math.ceil(o * 4 / 9996) === g){ found = o; break; }
    }
    if (found < 0) continue; // gross totals the pallet map skips
    var palletFee = BigInt(Math.ceil(found * 4 / 9996));
    assert.strictEqual(grossFee, palletFee, "gross " + g + " quanta");
  }
});

// 19. Sweep: high-sec fee is exactly floor(amount/100) on random decimal inputs
t("high-sec floor sweep", function(){
  var seed = 123456789;
  function rnd(){ seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  for (var i = 0; i < 5000; i++){
    var int = Math.floor(rnd() * 1e6), frac = String(Math.floor(rnd() * 1e12)).padStart(12, "0");
    var s = int + "." + frac;
    var r = m.highSecFee(s);
    assert.strictEqual(r.feePlancks, r.amountPlancks / 100n, s);
    assert.strictEqual(r.amountPlancks, BigInt(int) * 1000000000000n + BigInt(frac), s);
  }
});

// 20. fmtQTC is exact for BigInt plancks (all 12 decimals, trimmed)
t("fmtQTC exact BigInt rendering", function(){
  assert.strictEqual(m.fmtQTC(1n), "0.000000000001");
  assert.strictEqual(m.fmtQTC(5n * m.QUANTUM_PLANCKS), "0.05");
  assert.strictEqual(m.fmtQTC(1234567890123n), "1.234567890123");
  assert.strictEqual(m.fmtPlancks(1234567890123n), "1,234,567,890,123 plancks");
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
