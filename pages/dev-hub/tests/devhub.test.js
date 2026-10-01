// Node unit tests for pages/dev-hub/app.js — run: node tests/devhub.test.js
var assert = require("assert");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + (e.message || e)); } }

// 1. CHAIN constants match upstream source values
t("CHAIN constants are the verified upstream values", function(){
  assert.strictEqual(m.CHAIN.ss58Prefix, 189);
  assert.strictEqual(m.CHAIN.tokenSymbol, "QTC");
  assert.strictEqual(m.CHAIN.tokenDecimals, 12);
  assert.strictEqual(m.CHAIN.specVersion, 153);
  assert.strictEqual(m.CHAIN.transactionVersion, 6);
  assert.strictEqual(m.CHAIN.blockTimeMs, 12000);
  assert.strictEqual(m.CHAIN.blocksPerDay, 7200);
  assert.strictEqual(m.CHAIN.unit, "1000000000000");
  assert.strictEqual(m.CHAIN.existentialDeposit, "1000000000");
  assert.strictEqual(m.CHAIN.chainId, "mainnet");
  assert.strictEqual(m.CHAIN.specName, "quantus-runtime");
});

// 2. qtcToPlancks exact bigint math
t("qtcToPlancks exact conversions", function(){
  assert.strictEqual(String(m.qtcToPlancks("1")), "1000000000000");
  assert.strictEqual(String(m.qtcToPlancks("0.001")), "1000000000");
  assert.strictEqual(String(m.qtcToPlancks("21000000")), "21000000000000000000");
  assert.strictEqual(String(m.qtcToPlancks("0.000000000001")), "1"); // smallest unit
  assert.strictEqual(String(m.qtcToPlancks("0.32")), "320000000000");
});

// 3. qtcToPlancks rejects junk
t("qtcToPlancks rejects invalid input", function(){
  assert.strictEqual(m.qtcToPlancks("abc"), null);
  assert.strictEqual(m.qtcToPlancks(""), null);
  assert.strictEqual(m.qtcToPlancks("1.0000000000001"), null); // 13 decimals
  assert.strictEqual(m.qtcToPlancks("-1"), null);
  assert.strictEqual(m.qtcToPlancks("1e3"), null);
});

// 4. plancksToQtc round-trips
t("plancksToQtc round-trips", function(){
  assert.strictEqual(m.plancksToQtc("1000000000000"), "1");
  assert.strictEqual(m.plancksToQtc("1000000000"), "0.001");
  assert.strictEqual(m.plancksToQtc("1"), "0.000000000001");
  assert.strictEqual(m.plancksToQtc("100000"), "0.0000001");
  assert.strictEqual(m.plancksToQtc("abc"), null);
  assert.strictEqual(m.plancksToQtc("1.5"), null);
  var big = "21000000000000000000";
  assert.strictEqual(String(m.qtcToPlancks(m.plancksToQtc(big))), big);
});

// 5. belowED threshold
t("belowED existential-deposit guard", function(){
  assert.strictEqual(m.belowED("999999999"), true);
  assert.strictEqual(m.belowED("1000000000"), false);
  assert.strictEqual(m.belowED("5000000000000"), false);
  assert.strictEqual(m.belowED(null), false);
});

// 6. Pallet map covers every index 0..23
t("PALLETS covers indices 0-23 exactly once", function(){
  var seen = {};
  m.PALLETS.forEach(function(p){
    assert.ok(p.i >= 0 && p.i <= 23, "index in range: " + p.i);
    assert.ok(!seen[p.i], "no duplicate index " + p.i);
    seen[p.i] = true;
  });
  for (var i = 0; i <= 23; i++) assert.ok(seen[i], "index " + i + " present");
});

// 7. Removed/vacant indices are the documented ones
t("vacant indices match upstream removals", function(){
  var vacant = m.PALLETS.filter(function(p){ return p.status === "removed"; }).map(function(p){ return p.i; }).sort(function(a,b){return a-b;});
  assert.deepStrictEqual(vacant, [4, 10, 12, 16, 17, 18]);
  var sched = m.lookupPallet(8);
  assert.strictEqual(sched.name, "Scheduler");
  assert.strictEqual(sched.status, "restricted");
});

// 8. lookupPallet by index and by name prefix
t("lookupPallet index + name lookup", function(){
  assert.strictEqual(m.lookupPallet(11).name, "ReversibleTransfers");
  assert.strictEqual(m.lookupPallet("11").name, "ReversibleTransfers");
  assert.strictEqual(m.lookupPallet(0).name, "System");
  assert.strictEqual(m.lookupPallet(23).name, "Origins");
  assert.strictEqual(m.lookupPallet("multisig").i, 19);
  assert.strictEqual(m.lookupPallet("balances").i, 2);
  assert.strictEqual(m.lookupPallet(24), null);
  assert.strictEqual(m.lookupPallet(99), null);
  assert.strictEqual(m.lookupPallet("nope"), null);
});

// 9. Key pallet call names present (verified from source)
t("pallet call references include verified extrinsics", function(){
  var rt = m.lookupPallet(11);
  assert.ok(rt.calls.indexOf("schedule_transfer") >= 0);
  assert.ok(rt.calls.indexOf("recover_funds") >= 0);
  assert.ok(rt.calls.indexOf("cancel") >= 0);
  var wh = m.lookupPallet(20);
  assert.ok(wh.calls.indexOf("verify_private_batch") >= 0);
  assert.ok(wh.calls.indexOf("verify_public_batch") >= 0);
  assert.ok(wh.calls.indexOf("record_transfer") < 0, "record_transfer is an internal helper, not a dispatchable");
  var ms = m.lookupPallet(19);
  assert.ok(ms.calls.indexOf("as_multi") >= 0);
});

// 10. buildJsonRpc valid payload
t("buildJsonRpc builds valid JSON-RPC", function(){
  var r = m.buildJsonRpc("chain_getBlockHash", "[137536]");
  assert.strictEqual(r.ok, true);
  var body = JSON.parse(r.json);
  assert.strictEqual(body.jsonrpc, "2.0");
  assert.strictEqual(body.method, "chain_getBlockHash");
  assert.deepStrictEqual(body.params, [137536]);
  assert.ok(r.curl.indexOf("localhost:9944") >= 0);
  assert.ok(r.curl.indexOf("chain_getBlockHash") >= 0);
});

// 11. buildJsonRpc rejects bad params
t("buildJsonRpc rejects invalid params", function(){
  assert.strictEqual(m.buildJsonRpc("system_chain", "not json").ok, false);
  assert.strictEqual(m.buildJsonRpc("system_chain", "{\"a\":1}").ok, false);
  assert.strictEqual(m.buildJsonRpc("system_chain", "[]").ok, true);
  assert.strictEqual(m.buildJsonRpc("system_chain", "").ok, true);
});

// 12. groupDigits
t("groupDigits formats thousands", function(){
  assert.strictEqual(m.groupDigits("1000000000000"), "1,000,000,000,000");
  assert.strictEqual(m.groupDigits("100000"), "100,000");
  assert.strictEqual(m.groupDigits("999"), "999");
});

// 13. REPOS entries carry dates + org links implied
t("REPOS has descriptions and activity dates", function(){
  var names = m.REPOS.map(function(r){ return r.name; });
  ["chain", "quantus-cli", "quantus-miner", "quantus-apps", "quantus-api-client",
   "explorer", "docs", "qp-human-checkphrase", "qpow-benchmark"].forEach(function(n){
    assert.ok(names.indexOf(n) >= 0, "repo " + n);
  });
  m.REPOS.forEach(function(r){
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.pushed), "date for " + r.name);
    assert.ok(r.desc.length > 10, "desc for " + r.name);
  });
});

// 14. Donation address is the exact one
t("donation address exact", function(){
  assert.strictEqual(m.DONATE_ADDR, "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau");
});

// 15. RECIPES are honest: browser-CORS caveat present
t("recipes include honest CORS caveats", function(){
  assert.ok(m.RECIPES["r-gql"].note.indexOf("allowlisted") >= 0);
  assert.ok(m.RECIPES["r-tx"].note.indexOf("ML-DSA") >= 0);
  assert.ok(m.RECIPES["r-tx"].code.indexOf("transferKeepAlive") >= 0);
  assert.ok(m.RECIPES["r-safesend"].code.indexOf("reversibleTransfers") >= 0);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
