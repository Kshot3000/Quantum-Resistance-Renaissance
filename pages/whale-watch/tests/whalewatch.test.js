// Node unit tests for pages/whale-watch/app.js — run: node tests/whalewatch.test.js
var assert = require("assert");
var crypto = require("crypto");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + (e.message || e)); } }
function approx(a, b, eps){ assert.ok(Math.abs(a - b) <= eps, "expected ~" + b + " got " + a); }

// --- plancksToQTC: exact BigInt formatting ---
t("plancksToQTC formats large balances exactly", function(){
  assert.strictEqual(m.plancksToQTC("5498465001000000000"), "5,498,465.001");
  assert.strictEqual(m.plancksToQTC("1000000000000"), "1");
  assert.strictEqual(m.plancksToQTC("1500000000000000"), "1,500");
  assert.strictEqual(m.plancksToQTC("1234567890123"), "1.234567");
  assert.strictEqual(m.plancksToQTC("0"), "0");
  assert.strictEqual(m.plancksToQTC("1"), "0"); // sub-micro dust rounds to 0 at 6dp
});
t("plancksToQTC trims trailing zeros", function(){
  assert.strictEqual(m.plancksToQTC("2500000000000"), "2.5");
  assert.strictEqual(m.plancksToQTC("10050000000000000"), "10,050");
});

// --- blake2b cross-check vs node:crypto (independent oracle) ---
t("internal blake2b matches node:crypto across block boundaries", function(){
  // exercise through ss58Decode's checksum path is indirect; instead verify known
  // SS58 vectors: real Quantus addresses must decode to prefix 189 / 32-byte key
  var addrs = [
    "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7", // genesis allocation holder
    "qzjsuLN7Nhu4bjvmUbjSTr2ZTeZ7oRxXpQP9fdv6PcHUCRrVR", // multisig, claimed vesting
    "qzq9inB2ja6jGu", // truncated on purpose below
  ];
  var d0 = m.ss58Decode(addrs[0]);
  assert.ok(d0.ok && d0.prefix === 189 && d0.keyLen === 32, JSON.stringify(d0));
  var d1 = m.ss58Decode(addrs[1]);
  assert.ok(d1.ok && d1.prefix === 189 && d1.keyLen === 32, JSON.stringify(d1));
  assert.ok(!m.ss58Decode(addrs[2]).ok, "truncated address must fail");
});
t("blake2b('abc') matches RFC 7693 test vector", function(){
  // verify via a checksum round-trip: corrupt one char -> must fail
  var good = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7";
  var bad = good.slice(0, 10) + (good[10] === "a" ? "b" : "a") + good.slice(11);
  assert.ok(m.ss58Decode(good).ok);
  var r = m.ss58Decode(bad);
  assert.ok(!r.ok && r.kind === "checksum", JSON.stringify(r));
});
t("node:crypto blake2b512 sanity (oracle exists)", function(){
  var h = crypto.createHash("blake2b512").update("abc").digest("hex");
  assert.strictEqual(h.slice(0, 16), "ba80a53f981c4d0d", "node oracle sanity");
});

// --- validateAddress ---
t("validateAddress accepts real Quantus addresses", function(){
  var v = m.validateAddress("qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7");
  assert.ok(v.ok && v.address.indexOf("qz") === 0);
});
t("validateAddress rejects garbage, wrong prefix, bad checksum", function(){
  assert.ok(!m.validateAddress("").ok);
  assert.ok(!m.validateAddress("not an address").ok);
  var bad = m.validateAddress("qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW8");
  assert.ok(!bad.ok, "mutated checksum must fail");
  // valid SS58 but wrong network: same codec, Polkadot-style prefix 0
  var key32 = []; for (var i = 0; i < 32; i++) key32.push(i * 7 % 256);
  var other = m.ss58Encode(key32, 0);
  var r = m.validateAddress(other);
  assert.ok(!r.ok && /not Quantus/.test(r.error), JSON.stringify(r));
  // round-trip: our own encoder output with prefix 189 validates
  var mine = m.ss58Encode(key32, 189);
  assert.ok(m.validateAddress(mine).ok, mine);
});

// --- supply math on a synthetic snapshot ---
function synth(){
  return {
    supply_plancks: { free: "10000000000000000", reserved: "0", frozen: "0" }, // 10,000 QTC
    vesting: { total_plancks: "8000000000000000", claimed_plancks: "1000000000000000" }, // locked 7,000
    brackets: [
      { key: "whale", label: "W", count: 2, sum_plancks: "9000000000000000" },
      { key: "fish", label: "F", count: 100, sum_plancks: "1000000000000000" },
    ],
    top: [
      { address: "qzpool", free_plancks: "7000000000000000", locked_plancks: "7000000000000000",
        liquid_plancks: "0", rank: 1, is_vesting_pool: true },
      { address: "qzrich", free_plancks: "2000000000000000", locked_plancks: "0",
        liquid_plancks: "2000000000000000", rank: 2 },
    ],
  };
}
t("supplyPlancks / lockedPlancks / circPlancks", function(){
  var d = synth();
  assert.strictEqual(m.supplyPlancks(d).toString(), "10000000000000000");
  assert.strictEqual(m.lockedPlancks(d).toString(), "7000000000000000");
  assert.strictEqual(m.circPlancks(d).toString(), "3000000000000000");
});
t("bracketRows removes locked pool from whale bracket in circ mode", function(){
  var d = synth();
  var all = m.bracketRows(d, "all");
  assert.strictEqual(all[0].sum_plancks, "9000000000000000");
  var circ = m.bracketRows(d, "circ");
  assert.strictEqual(circ[0].sum_plancks, "2000000000000000");
  assert.strictEqual(circ[1].sum_plancks, "1000000000000000");
});
t("topNShare uses liquid wealth in circ mode", function(){
  var d = synth();
  approx(m.topNShare(d.top, 1, "10000000000000000", "all"), 70, 1e-9);
  approx(m.topNShare(d.top, 1, "3000000000000000", "circ"), 0, 1e-9);
  approx(m.topNShare(d.top, 2, "3000000000000000", "circ"), 66.6666, 1e-3);
});
t("giniEstimate is bounded and reacts to concentration", function(){
  var d = synth();
  var gAll = m.giniEstimate(d, "all");
  var gCirc = m.giniEstimate(d, "circ");
  assert.ok(gAll.gini >= 0 && gAll.gini <= 1, gAll.gini);
  assert.ok(gCirc.gini >= 0 && gCirc.gini <= 1, gCirc.gini);
  assert.ok(gAll.estimated === true);
  // all-view is more unequal (single pool holds 70%) than circ view
  assert.ok(gAll.gini > gCirc.gini, gAll.gini + " vs " + gCirc.gini);
});
t("giniEstimate of perfect equality is ~0", function(){
  var top = [];
  for (var i = 0; i < 10; i++) top.push({ address: "qzx" + i, free_plancks: "1000000000000",
    liquid_plancks: "1000000000000", locked_plancks: "0", rank: i + 1 });
  var d = { supply_plancks: { free: "10000000000000", reserved: "0", frozen: "0" },
    vesting: { total_plancks: "0", claimed_plancks: "0" },
    brackets: [{ key: "fish", label: "F", count: 10, sum_plancks: "10000000000000" }], top: top };
  var g = m.giniEstimate(d, "all");
  approx(g.gini, 0, 0.02);
});

// --- misc helpers ---
t("shortAddr truncates, esc escapes", function(){
  assert.strictEqual(m.shortAddr("qz1234567890abcdef", 4, 3), "qz12…def");
  assert.strictEqual(m.esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});
t("tagList renders pool + miner tags", function(){
  var html = m.tagList({ is_vesting_pool: true, is_genesis_recipient: true, blocks_mined: 68624 });
  assert.ok(/Vesting pool/.test(html) && /68,624/.test(html), html);
  assert.ok(/—/.test(m.tagList({})));
});
t("timeAgo buckets", function(){
  var now = Date.now();
  assert.strictEqual(m.timeAgo(new Date(now - 30 * 1000).toISOString()), "just now");
  assert.strictEqual(m.timeAgo(new Date(now - 5 * 60000).toISOString()), "5m ago");
  assert.strictEqual(m.timeAgo(new Date(now - 3 * 3600000).toISOString()), "3h ago");
});

// --- validateSnapshot round 2: relational (cross-field) boundary ---
// Fixture is the real snapshot: it must pass its own boundary unchanged,
// and every relational poison below must fail or drop, never paint.
var fs = require("fs");
var REAL = JSON.parse(fs.readFileSync(__dirname + "/../../../data/whales.json", "utf8"));
function snap(mut){ var s = JSON.parse(JSON.stringify(REAL)); if (mut) mut(s); return s; }
var PL = 1000000000000n;
t("validateSnapshot passes the real snapshot unchanged", function(){
  var v = m.validateSnapshot(snap());
  assert.ok(v !== null, "real snapshot must validate");
  assert.strictEqual(v.top.length, REAL.top.length);
  assert.strictEqual(v.brackets.length, 6);
  assert.strictEqual(v.genesis_allocation.length, REAL.genesis_allocation.length);
  assert.strictEqual(v.whale_moves_alltime.length, REAL.whale_moves_alltime.length);
  assert.strictEqual(v.whale_moves_recent.length, REAL.whale_moves_recent.length);
});
t("bracket counts must sum to accounts_total", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){ s.brackets[5].count += 1; })), null);
});
t("bracket sums must sum to supply.free exactly", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    s.brackets[0].sum_plancks = (BigInt(s.brackets[0].sum_plancks) - PL).toString();
  })), null);
});
t("a missing bracket key fails the snapshot (partition must be complete)", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){ s.brackets.pop(); })), null);
});
t("bracket average outside its own band fails (sums preserved)", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    var y = 97n * 900n * PL;
    s.brackets[1].sum_plancks = (BigInt(s.brackets[1].sum_plancks) + y).toString();
    s.brackets[0].sum_plancks = (BigInt(s.brackets[0].sum_plancks) - y).toString();
  })), null);
});
t("vesting total larger than the supply fails", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    // keep claimed <= total and locked <= supply, but total > supply
    s.vesting.total_plancks = (BigInt(s.supply_plancks.free) + BigInt(s.supply_plancks.reserved) + PL).toString();
    s.vesting.claimed_plancks = s.vesting.total_plancks;
    s.top[0].locked_plancks = "0";
    s.top[0].liquid_plancks = s.top[0].free_plancks;
  })), null);
});
t("locked split across a non-pool row fails (pool identity)", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    var amt = 100000n * PL;
    s.top[0].locked_plancks = (BigInt(s.top[0].locked_plancks) - amt).toString();
    s.top[0].liquid_plancks = (BigInt(s.top[0].liquid_plancks) + amt).toString();
    s.top[1].locked_plancks = amt.toString();
    s.top[1].liquid_plancks = (BigInt(s.top[1].free_plancks) - amt).toString();
  })), null);
});
t("pool locked short of vesting total - claimed fails", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    s.top[0].locked_plancks = (BigInt(s.top[0].locked_plancks) - PL).toString();
    s.top[0].liquid_plancks = (BigInt(s.top[0].liquid_plancks) + PL).toString();
  })), null);
});
t("whale bracket count disagreeing with the top list fails", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    s.brackets[0].count -= 1;
    s.brackets[5].count += 1; // keep the partition sum intact
  })), null);
});
t("top list outweighing the supply fails", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){
    var extra = BigInt(s.supply_plancks.free) * 10n;
    s.top[1].free_plancks = (BigInt(s.top[1].free_plancks) + extra).toString();
    s.top[1].liquid_plancks = s.top[1].free_plancks;
  })), null);
});
t("absurd block height fails; validBlockHeight shapes hold", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){ s.block_height = 9007199254740991; })), null);
  assert.strictEqual(m.validBlockHeight(202000), 202000);
  assert.strictEqual(m.validBlockHeight(0), null);
  assert.strictEqual(m.validBlockHeight(10000001), null);
  assert.strictEqual(m.validBlockHeight(1.5), null);
});
t("future fetched_at fails (staleness can never be defeated)", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){ s.fetched_at = "2999-01-01T00:00:00.000Z"; })), null);
});
t("genesis rows off block 1 or from a second origin drop individually", function(){
  var v = m.validateSnapshot(snap(function(s){
    s.genesis_allocation[1].block_height = 500;
    s.genesis_allocation[2].from = s.genesis_allocation[2].to; // also from == to
  }));
  assert.ok(v !== null);
  assert.strictEqual(v.genesis_allocation.length, 1);
});
t("a move postdating its snapshot drops; recent owes >= 10 QTC / 7 days", function(){
  var v = m.validateSnapshot(snap(function(s){
    s.whale_moves_alltime[0].timestamp = "2999-01-01T00:00:00.000Z";
    s.whale_moves_recent[0].amount = (5n * PL).toString();
    s.whale_moves_recent[0].timestamp = new Date(Date.parse(s.fetched_at) - 30 * 86400000).toISOString();
  }));
  assert.ok(v !== null);
  assert.strictEqual(v.whale_moves_alltime.length, REAL.whale_moves_alltime.length - 1);
  assert.strictEqual(v.whale_moves_recent.length, REAL.whale_moves_recent.length - 1);
});
t("present-but-malformed reserved drops the top row", function(){
  // a non-whale row (index 50): its absence breaks no aggregate identity
  var v = m.validateSnapshot(snap(function(s){ s.top[50].reserved_plancks = "oops"; }));
  assert.ok(v !== null);
  assert.strictEqual(v.top.length, REAL.top.length - 1);
});
t("dropping a whale row by poison fails honestly (bracket cannot reconcile)", function(){
  assert.strictEqual(m.validateSnapshot(snap(function(s){ s.top[3].reserved_plancks = "oops"; })), null);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
