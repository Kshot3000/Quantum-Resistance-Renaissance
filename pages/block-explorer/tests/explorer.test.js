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

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
