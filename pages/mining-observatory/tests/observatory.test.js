// Node unit tests for pages/mining-observatory/app.js — run: node tests/observatory.test.js
var assert = require("assert");
var m = require("../app.js");
var fs = require("fs");
var path = require("path");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + (e.message || e)); } }
function approx(a, b, eps){ assert.ok(Math.abs(a - b) <= eps, "expected ~" + b + " got " + a); }

// 1. sortedShares: object form, desc order, share math
t("sortedShares sorts desc and computes shares", function(){
  var rows = m.sortedShares({ a: 30, b: 60, c: 10 }, 100);
  assert.strictEqual(rows[0].address, "b");
  assert.strictEqual(rows[1].address, "a");
  assert.strictEqual(rows[2].address, "c");
  assert.strictEqual(rows[0].share, 60);
  approx(rows[1].share, 30, 1e-9);
  assert.strictEqual(rows.reduce(function(t, r){ return t + r.share; }, 0), 100);
});

// 2. sortedShares: array form
t("sortedShares accepts [{address, blocks}]", function(){
  var rows = m.sortedShares([{ address: "x", blocks: 5 }, { address: "y", blocks: 15 }], 20);
  assert.strictEqual(rows[0].address, "y");
  assert.strictEqual(rows[0].share, 75);
});

// 3. Nakamoto: strict >50% boundary
t("nakamotoCoefficient is smallest n with cumulative > 50", function(){
  assert.strictEqual(m.nakamotoCoefficient([{ share: 51 }]), 1);
  assert.strictEqual(m.nakamotoCoefficient([{ share: 50 }, { share: 1 }]), 2, "exactly 50% does not cross");
  assert.strictEqual(m.nakamotoCoefficient([{ share: 30 }, { share: 25 }, { share: 45 }]), 2);
  assert.strictEqual(m.nakamotoCoefficient([{ share: 20 }, { share: 20 }, { share: 20 }, { share: 20 }, { share: 20 }]), 3);
});

// 4. HHI: monopoly = 10000, even split of 4 = 2500
t("herfindahl scale 0-10000", function(){
  approx(m.herfindahl([{ share: 100 }]), 10000, 1e-6);
  approx(m.herfindahl([{ share: 25 }, { share: 25 }, { share: 25 }, { share: 25 }]), 2500, 1e-6);
  approx(m.herfindahl([{ share: 50 }, { share: 50 }]), 5000, 1e-6);
});

// 5. HHI bands follow DOJ thresholds
t("hhiBand thresholds", function(){
  assert.strictEqual(m.hhiBand(1499).label, "Competitive");
  assert.strictEqual(m.hhiBand(1500).label, "Moderately concentrated");
  assert.strictEqual(m.hhiBand(2500).label, "Moderately concentrated");
  assert.strictEqual(m.hhiBand(2501).label, "Highly concentrated");
  assert.strictEqual(m.hhiBand(2501).cls, "danger");
  assert.strictEqual(m.hhiBand(100).cls, "ok");
});

// 6. cumulative sums monotonically to 100
t("cumulative is monotone and ends at 100", function(){
  var rows = m.sortedShares({ a: 50, b: 30, c: 20 }, 100);
  var c = m.cumulative(rows);
  assert.deepStrictEqual(c.map(function(x){ return x.rank; }), [1, 2, 3]);
  assert.ok(c[0].cum < c[1].cum && c[1].cum < c[2].cum);
  approx(c[2].cum, 100, 1e-9);
});

// 7. bucketStats
t("bucketStats aggregates a bucket", function(){
  var s = m.bucketStats({ start: 1, end: 500, blocks: 100, miners: { a: 60, b: 30, c: 10 } });
  assert.strictEqual(s.distinct, 3);
  approx(s.topShare, 60, 1e-9);
  assert.strictEqual(s.topAddr, "a");
  approx(s.hhi, 60 * 60 + 30 * 30 + 10 * 10, 1e-6);
});

// 8. fmtAddr truncation
t("fmtAddr truncates long addresses", function(){
  var a = "qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv";
  assert.strictEqual(m.fmtAddr(a), "qzmsbe…3SErv");
  assert.strictEqual(m.fmtAddr("short"), "short");
  assert.strictEqual(m.fmtAddr(""), "");
});

// 9. Real snapshot sanity: window Nakamoto=1, HHI~3671, band highly concentrated
t("real snapshot: window stats match measured values", function(){
  var data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "data", "miners.json"), "utf8"));
  assert.ok(data.ok, "snapshot ok flag");
  assert.strictEqual(data.window.block_count, 15000);
  var rows = m.sortedShares(data.window_miners, data.window.block_count);
  assert.strictEqual(m.nakamotoCoefficient(rows), 1, "single address > 50% in window");
  var hhi = m.herfindahl(rows);
  // Drift band: the 15,000-block window rotates hourly, so HHI moves with
  // miner mix — 3,6xx in the Sept-30 capture, 4,628.8 at block ~152,606
  // (2026-10-02). The substantive claim is the floor + band label below.
  assert.ok(hhi > 3600 && hhi <= 10000, "HHI in expected range, got " + hhi);
  assert.strictEqual(m.hhiBand(hhi).label, "Highly concentrated");
  // Top-miner share drifts with the rotating window too: 53.2% in the
  // Sept-30 capture, 65.05% (9,758/15,000) at block ~152,606 (2026-10-02).
  // The substantive claim is majority control (Nakamoto = 1, asserted above).
  assert.ok(rows[0].share > 50 && rows[0].share < 75, "top miner holds a majority, got " + rows[0].share);
  // addresses look like Quantus SS58 (qz prefix)
  rows.slice(0, 5).forEach(function(r){ assert.ok(/^qz/.test(r.address), "qz prefix: " + r.address); });
});

// 10. Real snapshot: all-time Nakamoto=2, buckets well-formed
t("real snapshot: all-time + buckets well-formed", function(){
  var data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "data", "miners.json"), "utf8"));
  var arows = m.sortedShares(data.all_time, data.chain_height);
  assert.strictEqual(m.nakamotoCoefficient(arows), 2);
  assert.strictEqual(data.buckets.length, 30);
  data.buckets.forEach(function(b){
    var sum = Object.keys(b.miners).reduce(function(t, k){ return t + b.miners[k]; }, 0);
    assert.strictEqual(sum, b.blocks, "bucket counts sum to blocks");
  });
  assert.ok(data.window.observed_block_time_s > 5 && data.window.observed_block_time_s < 60,
    "plausible block time");
});

// 11. timeAgo formatting
t("timeAgo formats durations", function(){
  var now = Date.now();
  assert.strictEqual(m.timeAgo(new Date(now - 30 * 1000).toISOString()), "30s ago");
  assert.strictEqual(m.timeAgo(new Date(now - 5 * 60 * 1000).toISOString()), "5 min ago");
  assert.strictEqual(m.timeAgo(new Date(now - 3 * 3600 * 1000).toISOString()), "3h ago");
});

// 12. sanitizeMiners: a well-formed payload passes and is normalized
var VA = function(c){ return "qz" + c.repeat(47); }; // valid SS58-189 shape
function goodPayload(){
  return {
    ok: true,
    source: "https://sqm.quantus.com/v1/graphql",
    fetched_at: new Date().toISOString(),
    chain_height: 2000,
    window: { start_height: 1001, end_height: 2000, block_count: 1000, observed_block_time_s: 10 },
    window_miners: {},
    buckets: [
      { start: 1001, end: 1500, blocks: 500, miners: {} },
      { start: 1501, end: 2000, blocks: 500, miners: {} },
    ],
    all_time: [
      { address: VA("a"), blocks: 1200 }, { address: VA("b"), blocks: 500 }, { address: VA("c"), blocks: 200 },
    ],
  };
}
function fillGood(p){
  p.window_miners[VA("a")] = 600; p.window_miners[VA("b")] = 250; p.window_miners[VA("c")] = 150;
  p.buckets[0].miners[VA("a")] = 300; p.buckets[0].miners[VA("b")] = 200;
  p.buckets[1].miners[VA("a")] = 300; p.buckets[1].miners[VA("b")] = 50; p.buckets[1].miners[VA("c")] = 150;
  return p;
}
function expectBad(name, mut){
  t(name, function(){
    var p = fillGood(goodPayload());
    mut(p);
    assert.throws(function(){ m.sanitizeMiners(p); }, /malformed miners snapshot/);
  });
}

t("sanitizeMiners accepts a well-formed payload", function(){
  var out = m.sanitizeMiners(fillGood(goodPayload()));
  assert.strictEqual(out.chain_height, 2000);
  assert.strictEqual(out.window.observed_block_time_s, 10);
  assert.strictEqual(out.buckets.length, 2);
});

expectBad("sanitizeMiners rejects a markup-carrying window address", function(p){
  p.window_miners = {}; p.window_miners['qz"><img src=x>'] = 600;
  p.window_miners[VA("b")] = 250; p.window_miners[VA("c")] = 150;
});
expectBad("sanitizeMiners rejects window counts that do not sum to block_count", function(p){
  p.window_miners[VA("c")] = 100;
});
expectBad("sanitizeMiners rejects a negative miner count", function(p){
  p.window_miners[VA("a")] = 900; p.window_miners[VA("c")] = -150;
});
expectBad("sanitizeMiners rejects a fractional miner count", function(p){
  p.window_miners[VA("a")] = 600.5; p.window_miners[VA("c")] = 149.5;
});
expectBad("sanitizeMiners rejects a string miner count", function(p){
  p.window_miners[VA("a")] = "600";
});
expectBad("sanitizeMiners rejects a garbage fetched_at", function(p){
  p.fetched_at = "not-a-date";
});
expectBad("sanitizeMiners rejects window end != chain_height", function(p){
  p.window.end_height = 1999; p.window.start_height = 1000;
});
expectBad("sanitizeMiners rejects a window range that disagrees with block_count", function(p){
  p.window.start_height = 1002;
});
expectBad("sanitizeMiners rejects a duplicate all-time address", function(p){
  p.all_time.push({ address: VA("a"), blocks: 10 });
});
expectBad("sanitizeMiners rejects an all-time count above chain height", function(p){
  p.all_time[0].blocks = 5000;
});
expectBad("sanitizeMiners rejects all-time counts summing past chain height", function(p){
  p.all_time[1].blocks = 900;
});
expectBad("sanitizeMiners rejects an empty window_miners", function(p){
  p.window_miners = {};
});
expectBad("sanitizeMiners rejects a zero chain_height", function(p){
  p.chain_height = 0;
});

// 13. Auxiliary degradation: block time and buckets never kill the core
t("sanitizeMiners degrades a string block time to null, keeps figures", function(){
  var p = fillGood(goodPayload());
  p.window.observed_block_time_s = "10.0";
  var out = m.sanitizeMiners(p);
  assert.strictEqual(out.window.observed_block_time_s, null);
  assert.strictEqual(out.chain_height, 2000);
});
t("sanitizeMiners keeps a null block time null (fetch script emits null)", function(){
  var p = fillGood(goodPayload());
  p.window.observed_block_time_s = null;
  assert.strictEqual(m.sanitizeMiners(p).window.observed_block_time_s, null);
});
t("sanitizeMiners drops a poisoned bucket, keeps the clean one", function(){
  var p = fillGood(goodPayload());
  p.buckets[0].miners = null;
  var out = m.sanitizeMiners(p);
  assert.strictEqual(out.buckets.length, 1);
  assert.strictEqual(out.buckets[0].start, 1501);
});
t("cleanBuckets drops a bucket whose miners do not sum to its blocks", function(){
  var b = { start: 1, end: 500, blocks: 500, miners: {} };
  b.miners[VA("a")] = 499;
  assert.deepStrictEqual(m.cleanBuckets([b]), []);
});
t("cleanBuckets tolerates a non-array buckets field", function(){
  assert.deepStrictEqual(m.cleanBuckets(undefined), []);
  assert.deepStrictEqual(m.cleanBuckets("junk"), []);
});

// 14. Real snapshot passes its own boundary
t("real snapshot passes sanitizeMiners unchanged in shape", function(){
  var data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "data", "miners.json"), "utf8"));
  var out = m.sanitizeMiners(data);
  assert.strictEqual(out.chain_height, data.chain_height);
  assert.strictEqual(out.buckets.length, data.buckets.length);
  assert.ok(out.window.observed_block_time_s > 5 && out.window.observed_block_time_s < 60);
});

// 15. Round 2: bucket RELATIONS — the kept buckets are one contiguous,
// in-window, uniform-span run whose totals never exceed window_miners.
t("sanitizeMiners drops a duplicated bucket", function(){
  var p = fillGood(goodPayload());
  p.buckets = [p.buckets[0], p.buckets[0], p.buckets[1]];
  var out = m.sanitizeMiners(p);
  assert.strictEqual(out.buckets.length, 2);
  assert.strictEqual(out.buckets[1].start, 1501);
});
t("sanitizeMiners drops an out-of-window bucket", function(){
  var p = fillGood(goodPayload());
  p.buckets.unshift({ start: 1, end: 500, blocks: 500, miners: {} });
  p.buckets[0].miners[VA("a")] = 500;
  assert.strictEqual(m.sanitizeMiners(p).buckets.length, 2);
});
t("sanitizeMiners drops a bucket that breaks contiguity", function(){
  var p = fillGood(goodPayload());
  p.buckets[1] = { start: 1601, end: 2000, blocks: 400, miners: {} };
  p.buckets[1].miners[VA("a")] = 250; p.buckets[1].miners[VA("c")] = 150;
  var out = m.sanitizeMiners(p);
  assert.strictEqual(out.buckets.length, 1);
  assert.strictEqual(out.buckets[0].start, 1001);
});
t("sanitizeMiners drops a bucket whose miners exceed the window totals", function(){
  var p = fillGood(goodPayload());
  p.buckets[0].miners[VA("a")] = 400; p.buckets[0].miners[VA("b")] = 100;
  var out = m.sanitizeMiners(p); // bucket 2 would take A to 700 > window 600
  assert.strictEqual(out.buckets.length, 1);
});
t("sanitizeMiners drops a bucket mining for an address the window never saw", function(){
  var p = fillGood(goodPayload());
  p.buckets[0].miners = {}; p.buckets[0].miners[VA("d")] = 500;
  var out = m.sanitizeMiners(p);
  assert.strictEqual(out.buckets.length, 1);
  assert.strictEqual(out.buckets[0].start, 1501);
});
t("sanitizeMiners keeps a short final bucket at the window end", function(){
  var p = goodPayload();
  p.chain_height = 1750;
  p.window = { start_height: 1001, end_height: 1750, block_count: 750, observed_block_time_s: 10 };
  p.window_miners[VA("a")] = 450; p.window_miners[VA("b")] = 300;
  p.buckets = [
    { start: 1001, end: 1500, blocks: 500, miners: {} },
    { start: 1501, end: 1750, blocks: 250, miners: {} },
  ];
  p.buckets[0].miners[VA("a")] = 300; p.buckets[0].miners[VA("b")] = 200;
  p.buckets[1].miners[VA("a")] = 150; p.buckets[1].miners[VA("b")] = 100;
  p.all_time = [{ address: VA("a"), blocks: 900 }, { address: VA("b"), blocks: 600 }];
  assert.strictEqual(m.sanitizeMiners(p).buckets.length, 2);
});
expectBad("sanitizeMiners rejects a fetched_at in the future", function(p){
  p.fetched_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
});
t("sanitizeMiners tolerates a fetched_at within the 1h future-skew bound", function(){
  var p = fillGood(goodPayload());
  p.fetched_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  assert.strictEqual(m.sanitizeMiners(p).chain_height, 2000);
});
expectBad("sanitizeMiners rejects a pre-genesis fetched_at", function(p){
  p.fetched_at = "2020-01-01T00:00:00.000Z";
});
expectBad("sanitizeMiners rejects a fetched_at just before the genesis floor", function(p){
  p.fetched_at = "2026-08-31T23:59:59.000Z";
});
t("sanitizeMiners tolerates a fetched_at at the genesis floor", function(){
  var p = fillGood(goodPayload());
  p.fetched_at = "2026-09-01T00:00:00.000Z";
  assert.strictEqual(m.sanitizeMiners(p).chain_height, 2000);
});

// 16. Round 4: all_time producer relations — the top-100 cap and the
// cross-view count relation (an address's all-time count covers its
// window count; the two tabs are one chain at one capture).
expectBad("sanitizeMiners rejects an all-time count below the same address's window count", function(p){
  p.all_time[0].blocks = 500; // window credits A with 600 of the last 1,000
});
t("sanitizeMiners accepts an all-time count equal to the window count", function(){
  var p = fillGood(goodPayload());
  p.all_time[0].blocks = 600;
  assert.strictEqual(m.sanitizeMiners(p).chain_height, 2000);
});
var ALPHA4 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function addr4(i){
  return "qz" + ALPHA4[10 + Math.floor(i / 40)] + ALPHA4[10 + (i % 40)].repeat(46);
}
function topPayload(n){
  var p = fillGood(goodPayload());
  p.chain_height = 100000;
  p.window = { start_height: 99001, end_height: 100000, block_count: 1000, observed_block_time_s: 10 };
  p.buckets = [
    { start: 99001, end: 99500, blocks: 500, miners: p.buckets[0].miners },
    { start: 99501, end: 100000, blocks: 500, miners: p.buckets[1].miners },
  ];
  p.all_time = [];
  for (var i = 0; i < n - 3; i++) p.all_time.push({ address: addr4(i), blocks: 10 });
  p.all_time.push({ address: VA("a"), blocks: 1200 }, { address: VA("b"), blocks: 500 }, { address: VA("c"), blocks: 200 });
  return p;
}
t("sanitizeMiners accepts exactly 100 all-time rows (the producer cap)", function(){
  assert.strictEqual(m.sanitizeMiners(topPayload(100)).all_time.length, 100);
});
t("sanitizeMiners rejects 101 all-time rows (over the producer's top-100)", function(){
  assert.throws(function(){ m.sanitizeMiners(topPayload(101)); }, /malformed miners snapshot/);
});

// 17. Round 5: window producer caps — the producer always emits a
// WINDOW_BLOCKS = 15,000-block window in BUCKET_SIZE = 500 buckets, so
// an over-cap window fails the snapshot (like the 101st all-time row)
// and an over-cap bucket is dropped by cleanBucket.
t("window caps are pinned at the producer constants", function(){
  assert.strictEqual(m.MAX_WINDOW_BLOCKS, 15000);
  assert.strictEqual(m.MAX_BUCKET_BLOCKS, 500);
});
function winPayload(winBlocks, miners){
  var p = fillGood(goodPayload());
  p.chain_height = 100000;
  p.window = { start_height: 100000 - winBlocks + 1, end_height: 100000, block_count: winBlocks, observed_block_time_s: 10 };
  p.window_miners = miners;
  p.buckets = [];
  p.all_time = [{ address: VA("a"), blocks: 90000 }];
  return p;
}
t("sanitizeMiners accepts a window at exactly the producer cap (15,000)", function(){
  var miners = {}; miners[VA("a")] = 10000; miners[VA("b")] = 5000;
  assert.strictEqual(m.sanitizeMiners(winPayload(15000, miners)).window.block_count, 15000);
});
expectBad("sanitizeMiners rejects a window one block over the producer cap", function(p){
  p.chain_height = 100000;
  p.window = { start_height: 85000, end_height: 100000, block_count: 15001, observed_block_time_s: 10 };
  p.window_miners = {}; p.window_miners[VA("a")] = 15001;
  p.buckets = [];
});
t("cleanBuckets drops a bucket counting past BUCKET_SIZE", function(){
  var b = { start: 1, end: 500, blocks: 501, miners: {} };
  b.miners[VA("a")] = 501;
  var wm = {}; wm[VA("a")] = 501;
  assert.deepStrictEqual(m.cleanBuckets([b], { start: 1, end: 500 }, wm), []);
});
t("cleanBuckets drops a bucket spanning past BUCKET_SIZE", function(){
  var b = { start: 1, end: 501, blocks: 500, miners: {} };
  b.miners[VA("a")] = 500;
  var wm = {}; wm[VA("a")] = 500;
  assert.deepStrictEqual(m.cleanBuckets([b], { start: 1, end: 501 }, wm), []);
});
t("cleanBuckets keeps a bucket at exactly BUCKET_SIZE", function(){
  var b = { start: 1, end: 500, blocks: 500, miners: {} };
  b.miners[VA("a")] = 500;
  var wm = {}; wm[VA("a")] = 500;
  assert.strictEqual(m.cleanBuckets([b], { start: 1, end: 500 }, wm).length, 1);
});

// 18. Round 6: the bucket LIST's producer count — the producer emits
// exactly ceil(15000 / 500) = 30 buckets, so cleanBuckets checks the RAW
// length against MAX_BUCKETS before cleaning any row and an over-cap
// list degrades wholesale to [] (auxiliary timeline; core survives).
t("bucket-count cap is pinned at the producer ceil (30)", function(){
  assert.strictEqual(m.MAX_BUCKETS, 30);
});
function tilingBuckets(n){
  var out = [];
  for (var i = 0; i < n; i++){
    var b = { start: 85001 + i * 500, end: 85001 + i * 500 + 499, blocks: 500, miners: {} };
    b.miners[VA("a")] = 500;
    out.push(b);
  }
  return out;
}
t("cleanBuckets keeps exactly MAX_BUCKETS valid buckets", function(){
  assert.strictEqual(m.cleanBuckets(tilingBuckets(30)).length, 30);
});
t("cleanBuckets refuses 31 valid buckets wholesale (no truncation to 30)", function(){
  assert.deepStrictEqual(m.cleanBuckets(tilingBuckets(31)), []);
});
t("sanitizeMiners drops an over-cap bucket list but keeps the core verdicts", function(){
  var p = winPayload(15000, (function(){ var mm = {}; mm[VA("a")] = 15000; return mm; })());
  p.buckets = tilingBuckets(31);
  var out = m.sanitizeMiners(p);
  assert.strictEqual(out.buckets.length, 0);
  assert.strictEqual(out.window.block_count, 15000);
});

// 19. Round 7: the window_miners map's RAW key count — round 5 bounded
// the map only by construction for accepted payloads, but the walk ran
// before the sum relation could reject (a 500,000-key map walked whole,
// 879.8 ms). The producer aggregates over 15,000 blocks, one author per
// block, so sanitizeMiners now checks the raw key count against
// MAX_WINDOW_BLOCKS before the walk.
function wideAddr(i){ // addr4 tops out at ~1,600 distinct shapes; base58-encode the index instead
  var s = "", n = i;
  do { s = ALPHA4[n % 58] + s; n = Math.floor(n / 58); } while (n > 0);
  return "qz" + s.padStart(47, "1");
}
function wideWindowPayload(nKeys){
  var miners = {};
  for (var i = 0; i < nKeys; i++) miners[wideAddr(i)] = 1;
  return winPayload(15000, miners);
}
t("sanitizeMiners accepts exactly 15,000 distinct window miners", function(){
  var out = m.sanitizeMiners(wideWindowPayload(15000));
  assert.strictEqual(Object.keys(out.window_miners).length, 15000);
});
t("sanitizeMiners rejects a 15,001-key window_miners map on the raw count", function(){
  assert.throws(function(){ m.sanitizeMiners(wideWindowPayload(15001)); }, /window_miners exceeds the producer window/);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
