/* Unit tests for the QTC Block Explorer pure helpers. Run: node tests/explorer.test.js */
var assert = require("assert");
var A = require("../app.js");

var pass = 0, fail = 0;
function t(name, fn){
  try { fn(); pass++; }
  catch (e){ fail++; console.error("FAIL " + name + ": " + e.message); }
}

/* --- esc --- */
t("esc escapes html", function(){
  assert.strictEqual(A.esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.strictEqual(A.esc(null), "");
  assert.strictEqual(A.esc(123), "123");
});

/* --- fmtInt --- */
t("fmtInt commas", function(){
  assert.strictEqual(A.fmtInt(135565), "135,565");
  assert.strictEqual(A.fmtInt(null), "—");
  assert.strictEqual(A.fmtInt(0), "0");
});

/* --- fmtQTC (10^12 planck) --- */
t("fmtQTC exact values", function(){
  assert.strictEqual(A.fmtQTC("310000000000"), "0.31");
  assert.strictEqual(A.fmtQTC("1000000000000"), "1");
  assert.strictEqual(A.fmtQTC("3552989979"), "0.0035");
  assert.strictEqual(A.fmtQTC("154164656048"), "0.1541");
  assert.strictEqual(A.fmtQTC("0"), "0");
  assert.strictEqual(A.fmtQTC(null), "—");
  assert.strictEqual(A.fmtQTC("21000000000000000000"), "21,000,000");
});

/* --- ageFmt --- */
t("ageFmt buckets", function(){
  assert.strictEqual(A.ageFmt(0, 45000), "45s ago");
  assert.strictEqual(A.ageFmt(0, 5 * 60000), "5m ago");
  assert.strictEqual(A.ageFmt(0, 3 * 3600000), "3h ago");
  assert.strictEqual(A.ageFmt(0, 2 * 86400000), "2d ago");
  assert.strictEqual(A.ageFmt(99999, 10000), "0s ago");
});

/* --- shortHash --- */
t("shortHash truncates", function(){
  var h = "0x" + "ab".repeat(32);
  assert.strictEqual(A.shortHash(h), "0xabababab…" + "ab".repeat(4));
  assert.strictEqual(A.shortHash("short"), "short");
  assert.strictEqual(A.shortHash(null), "—");
});

/* --- input classification --- */
t("isHeight", function(){
  assert.ok(A.isHeight("135564"));
  assert.ok(!A.isHeight("0x1234"));
  assert.ok(!A.isHeight("qzabc"));
  assert.ok(!A.isHeight(""));
});
t("isHex64", function(){
  assert.ok(A.isHex64("0x" + "ab".repeat(32)));
  assert.ok(!A.isHex64("0x1234"));
  assert.ok(!A.isHex64("135564"));
});
t("isQz", function(){
  assert.ok(A.isQz("qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv"));
  assert.ok(!A.isQz("qzshort"));
  assert.ok(!A.isQz("prl1abc"));
});

/* --- detectQuery --- */
t("detectQuery kinds", function(){
  assert.deepStrictEqual(A.detectQuery("135564"), { kind: "block", key: "135564" });
  var r = A.detectQuery("0x" + "AB".repeat(32));
  assert.strictEqual(r.kind, "hash");
  assert.strictEqual(r.key, "0x" + "ab".repeat(32));
  r = A.detectQuery("qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv");
  assert.strictEqual(r.kind, "account");
  assert.strictEqual(A.detectQuery("   ").kind, "empty");
  assert.strictEqual(A.detectQuery("garbage!").kind, "unknown");
});

/* --- routeFor --- */
t("routeFor maps to hash paths", function(){
  assert.strictEqual(A.routeFor("135564"), "#/block/135564");
  assert.strictEqual(A.routeFor("0x" + "ab".repeat(32)), "#/hash/" + "0x" + "ab".repeat(32));
  assert.strictEqual(A.routeFor("qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv"), "#/account/qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv");
  assert.strictEqual(A.routeFor("junk!"), null);
  assert.strictEqual(A.routeFor(""), null);
});

/* --- parseRoute --- */
t("parseRoute views", function(){
  assert.deepStrictEqual(A.parseRoute("#/block/135564"), { view: "block", key: "135564" });
  assert.deepStrictEqual(A.parseRoute("#/extrinsic/0xabc"), { view: "extrinsic", key: "0xabc" });
  assert.deepStrictEqual(A.parseRoute("#/account/qzxyz"), { view: "account", key: "qzxyz" });
  assert.deepStrictEqual(A.parseRoute("#/hash/0xabc"), { view: "hash", key: "0xabc" });
  assert.deepStrictEqual(A.parseRoute(""), { view: "home", key: "" });
  assert.deepStrictEqual(A.parseRoute("#/"), { view: "home", key: "" });
  assert.deepStrictEqual(A.parseRoute("#/nope/1"), { view: "home", key: "" });
});

/* --- prettyArgs --- */
t("prettyArgs formats json", function(){
  var out = A.prettyArgs('{"dest":{"__kind":"Id","value":"qzabc"},"value":"110946499011"}');
  assert.ok(out.indexOf('"value": "110946499011"') !== -1);
  assert.strictEqual(A.prettyArgs(null), "(no arguments)");
  assert.strictEqual(A.prettyArgs("{not json"), "{not json");
});

/* --- load-boundary validation (indexer responses are untrusted) --- */
t("fmt hardening: garbage never becomes a figure", function(){
  assert.strictEqual(A.fmtQTC("abc"), "—");
  assert.strictEqual(A.fmtQTC("1.5"), "—");
  assert.strictEqual(A.fmtQTC("6.5e18"), "—");
  assert.strictEqual(A.fmtQTC(""), "—");
  assert.strictEqual(A.fmtInt(-5), "—");
  assert.strictEqual(A.fmtInt(194626.9), "—");
  assert.strictEqual(A.fmtInt("garbage"), "—");
  assert.strictEqual(A.fmtInt("135564"), "135,564");
});
t("validators: shapes", function(){
  assert.strictEqual(A.validHeight(135564), 135564);
  assert.strictEqual(A.validHeight(0), null);
  assert.strictEqual(A.validHeight(-5), null);
  assert.strictEqual(A.validHeight(1.5), null);
  assert.strictEqual(A.validHeight("oops"), null);
  assert.strictEqual(A.validCount(0), 0);
  assert.strictEqual(A.validPlanck("310000000000"), "310000000000");
  assert.strictEqual(A.validPlanck("1.5"), null);
  assert.strictEqual(A.validPlanck(-1), null);
  assert.ok(A.validTimestamp("2026-09-29T19:00:00.792+00:00"));
  assert.strictEqual(A.validTimestamp("garbage!!"), null);
  assert.strictEqual(A.validTimestamp(12345), null);
});
var GOOD_MINER = "qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv";
var GOOD_SENDER = "qzo4QjZzBFC4gL72EjtG7kQkemGmP67wWmruLLN9sgMNAQSzb";
t("cleanBlockRow drops poison, keeps good rows", function(){
  var good = { height: 135568, hash: "0x" + "ab".repeat(32), timestamp: "2026-09-29T19:00:20.000+00:00", reward: "310000000000", mined_by_id: GOOD_MINER, extrinsics_aggregate: { aggregate: { count: '<b id="pwn">X</b>' } } };
  var c = A.cleanBlockRow(good);
  assert.ok(c && c.height === 135568 && c.extrinsicsCount === null); // markup count -> dash, not injection
  assert.strictEqual(A.cleanBlockRow({ ...good, reward: "abc" }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, timestamp: "garbage" }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, height: 135568.9 }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, mined_by_id: "not-an-address" }), null);
  assert.strictEqual(A.cleanBlockRow(null), null);
});
t("cleanTransferRow drops poison", function(){
  var good = { id: "0000135565-6452c-000004", amount: "310000000000", from_id: GOOD_SENDER, to_id: GOOD_MINER, block_height: 135565, timestamp: "2026-09-29T19:00:08.755+00:00" };
  assert.ok(A.cleanTransferRow(good));
  assert.strictEqual(A.cleanTransferRow({ ...good, amount: "oops" }), null);
  assert.strictEqual(A.cleanTransferRow({ ...good, block_height: '"><svg onload=1>' }), null);
  assert.strictEqual(A.cleanTransferRow({ ...good, from_id: "garbage" }), null);
});
t("cleanHome: malformed stats fail, poisoned rows drop", function(){
  var home = { stats: { block_height: 135568, total_accounts: 6595, total_immediate_transfers: 154203, total_scheduled_transfers: 12 },
    blocks: [], transfers: [] };
  assert.ok(A.cleanHome(home));
  assert.strictEqual(A.cleanHome({ ...home, stats: { ...home.stats, block_height: "oops" } }), null);
  assert.strictEqual(A.cleanHome(null), null);
  assert.strictEqual(A.cleanHome({ ...home, blocks: {} }), null);
});
t("cleanAccount / cleanExtrinsicRow boundaries", function(){
  assert.ok(A.cleanAccount({ free: "1000", frozen: "0", reserved: "0" }));
  assert.strictEqual(A.cleanAccount({ free: "1.5", frozen: "0", reserved: "0" }), null);
  var x = { id: "0x" + "ab".repeat(32), index_in_block: 1, pallet: "Balances", call: "transfer_allow_death", signer_id: GOOD_SENDER, success: true, fee: "3552989979", args: "{}" };
  assert.ok(A.cleanExtrinsicRow(x));
  assert.strictEqual(A.cleanExtrinsicRow({ ...x, index_in_block: "<b>pwn</b>" }), null);
  assert.strictEqual(A.cleanExtrinsicRow({ ...x, fee: "abc" }), null);
  assert.strictEqual(A.cleanExtrinsicRow({ ...x, success: "yes" }), null);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
