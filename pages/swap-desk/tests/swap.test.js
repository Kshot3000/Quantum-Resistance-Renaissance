// Node unit tests for pages/swap-desk/app.js — run: node tests/swap.test.js
var assert = require("assert");
var fs = require("fs");
var m = require("../app.js");

var passed = 0, failed = 0;
function t(name, fn){ try { fn(); passed++; console.log("ok - " + name); }
  catch (e){ failed++; console.error("FAIL - " + name + ": " + (e.message || e)); } }
function approx(a, b, eps){ assert.ok(Math.abs(a - b) <= eps, "expected ~" + b + " got " + a); }

// 1. scanTokensForQTC against the REAL captured 1Click token list (202 tokens, no QTC)
// Fixture: tests/fixtures/tokens.json — vendored capture of
// https://1click.chaindefuser.com/v0/tokens taken 2026-10-02 (202 tokens, no QTC).
// Vendored so the suite is hermetic: the old /tmp/tokens.json path died whenever
// the shared tmpfs was wiped. Re-capture from the live endpoint to refresh; if
// the live count has drifted, update the pinned counts below with the new capture.
t("scanTokensForQTC: real fixture has 202 tokens and no QTC", function(){
  var raw = JSON.parse(fs.readFileSync(__dirname + "/fixtures/tokens.json", "utf8"));
  var r = m.scanTokensForQTC(raw);
  assert.strictEqual(r.total, 202);
  assert.strictEqual(r.listed, false);
  assert.strictEqual(r.asset, null);
});

// 2. scanTokensForQTC detects the placeholder asset id once listed
t("scanTokensForQTC: detects nep141:qtc.omft.near", function(){
  var raw = JSON.parse(fs.readFileSync(__dirname + "/fixtures/tokens.json", "utf8"));
  var list = (Array.isArray(raw) ? raw : raw.tokens).slice();
  list.push({ assetId: m.QTC_ASSET_ID, symbol: "QTC", blockchain: "quantus", decimals: 12, price: "3.5" });
  var r = m.scanTokensForQTC(list);
  assert.strictEqual(r.listed, true);
  assert.strictEqual(r.total, 203);
  assert.strictEqual(r.asset.decimals, 12);
});

// 3. scanTokensForQTC handles wrapped shapes and empty input
t("scanTokensForQTC: {tokens:[...]} shape + empty", function(){
  var r = m.scanTokensForQTC({ tokens: [{ assetId: m.QTC_ASSET_ID, symbol: "QTC" }] });
  assert.strictEqual(r.listed, true);
  var e = m.scanTokensForQTC([]);
  assert.strictEqual(e.listed, false);
  assert.strictEqual(e.total, 0);
});

// 4. platformFeeBps: documented / observed / partner / stable per the wallet docs
t("platformFeeBps modes", function(){
  assert.strictEqual(m.platformFeeBps("documented"), 25);
  assert.strictEqual(m.platformFeeBps("observed"), 20);
  assert.strictEqual(m.platformFeeBps("partner"), 20);
  assert.strictEqual(m.platformFeeBps("stable"), 1);
  assert.strictEqual(m.platformFeeBps("bogus"), 20); // default = observed
});

// 5. illustrativeQuote: fee inside amountOut; min at slippage
t("illustrativeQuote math", function(){
  var q = m.illustrativeQuote(1000, 20, 1);
  assert.strictEqual(q.feeBps, 20);
  approx(q.fee, 2, 1e-9);          // 1000 * 20/10000
  approx(q.net, 998, 1e-9);
  approx(q.minOut, 998 * 0.99, 1e-9);
  var q2 = m.illustrativeQuote(500, 25, 3);
  approx(q2.fee, 1.25, 1e-9);
  approx(q2.minOut, 498.75 * 0.97, 1e-9);
});

// 6. illustrativeQuote: zero / negative / NaN-safe
t("illustrativeQuote edge cases", function(){
  var q = m.illustrativeQuote(0, 20, 1);
  assert.strictEqual(q.fee, 0); assert.strictEqual(q.net, 0); assert.strictEqual(q.minOut, 0);
  var n = m.illustrativeQuote(-50, 20, 1);
  assert.strictEqual(n.offer, 0);
  var g = m.illustrativeQuote("abc", 20, 1);
  assert.strictEqual(g.offer, 0);
});

// 7. deadlineFor: slow chains get 2h, everything else ~20 min
t("deadlineFor chains", function(){
  ["btc","ltc","doge","bch","dash","zec"].forEach(function(c){
    assert.strictEqual(m.deadlineFor(c), "2 hours", c);
    assert.strictEqual(m.deadlineFor(c.toUpperCase()), "2 hours", c);
  });
  ["eth","sol","base","near","quantus",""].forEach(function(c){
    assert.strictEqual(m.deadlineFor(c), "~20 minutes", c || "(empty)");
  });
});

// 8. statusInfo covers every documented 1Click status + app-side Expired
t("statusInfo covers lifecycle", function(){
  ["PENDING_DEPOSIT","KNOWN_DEPOSIT_TX","INCOMPLETE_DEPOSIT","PROCESSING",
   "SUCCESS","REFUNDED","FAILED","EXPIRED"].forEach(function(s){
    var info = m.statusInfo(s);
    assert.ok(info && info.who && info.what, s);
  });
  assert.strictEqual(m.statusInfo("NOPE"), null);
});

// 9. STEPS: both directions, 6 steps each, non-empty copy
t("STEPS both directions", function(){
  assert.strictEqual(m.STEPS.out.length, 6);
  assert.strictEqual(m.STEPS.in.length, 6);
  m.STEPS.out.concat(m.STEPS.in).forEach(function(s){
    assert.ok(s[0] && s[1] && s[1].length > 40, s[0]);
  });
});

// 10. TIMELINE + SOURCES: dated entries, real links
t("TIMELINE entries", function(){
  assert.ok(m.TIMELINE.length >= 5);
  m.TIMELINE.forEach(function(e){
    assert.ok(e[0] && e[1] && e[2], "timeline fields");
  });
  var links = m.TIMELINE.map(function(e){ return e[3]; }).filter(Boolean);
  assert.ok(links.length >= 2, "timeline needs sourced links");
});
t("SOURCES entries", function(){
  assert.ok(m.SOURCES.length >= 3);
  m.SOURCES.forEach(function(s){
    assert.ok(s[0] && s[1] && s[2]);
    assert.ok(/^https:\/\//.test(s[1]), s[1]);
  });
});

// 11. Attribution constants present
t("attribution + endpoint constants", function(){
  assert.strictEqual(m.QTC_ASSET_ID, "nep141:qtc.omft.near");
  assert.strictEqual(m.ONECLICK_TOKENS_URL, "https://1click.chaindefuser.com/v0/tokens");
  var html = fs.readFileSync(__dirname + "/../index.html", "utf8");
  assert.ok(html.indexOf("qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau") !== -1, "donation address");
  assert.ok(html.indexOf("https://x.com/kshot9000") !== -1, "x link");
  assert.ok(html.indexOf("app.js?v=1.18.0") !== -1, "js cache key");
  // De-pinned (2026-10-02): the a11y contrast pass bumped the css key to
  // 1.17.2 without updating this pin. Assert a keyed css load at >= the
  // 1.17.0 floor instead of an exact version that drifts every release.
  var cssKey = (html.match(/styles\.css\?v=([0-9]+)\.([0-9]+)\.([0-9]+)/) || []).slice(1).map(Number);
  assert.ok(cssKey.length === 3 && (cssKey[0] > 1 || (cssKey[0] === 1 && (cssKey[1] > 17 || (cssKey[1] === 17 && cssKey[2] >= 0)))), "css cache key >= 1.17.0, got " + cssKey.join("."));
});

// 12. No mock-data-as-real language on the page
t("honesty labels present", function(){
  var html = fs.readFileSync(__dirname + "/../index.html", "utf8");
  assert.ok(/not a quote/i.test(html), "must say the lab is not a quote");
  assert.ok(/illustrative/i.test(html), "must label illustrative figures");
  assert.ok(/Not financial advice/.test(html), "disclaimer");
});

// 13. Listing reality (verified against the live API 2026-10-12): QTC is on
// the list as nep141:qtc.omft.near on blockchain "qtc" (NOT "quantus"),
// plus a 1cs_v1-wrapped NEAR form. Rows below are the real captured entries.
var LIVE_QTC_ROWS = [
  { assetId: "nep141:qtc.omft.near", decimals: 12, blockchain: "qtc", symbol: "QTC", price: 132.01297962032564, priceUpdatedAt: "2026-10-12T21:22:00.689Z", coingeckoId: "custom:qtc" },
  { assetId: "1cs_v1:near:nep141:qtc.omft.near", decimals: 12, blockchain: "near", symbol: "QTC", price: 132.01297962032564, priceUpdatedAt: "2026-10-12T21:22:00.689Z", contractAddress: "qtc.omft.near", coingeckoId: "custom:qtc" }
];
t("scanTokensForQTC: the real listed rows are detected, nep141 entry wins", function(){
  var r = m.scanTokensForQTC(LIVE_QTC_ROWS);
  assert.strictEqual(r.listed, true);
  assert.strictEqual(r.asset.assetId, "nep141:qtc.omft.near");
  assert.strictEqual(r.total, 2);
});
t("scanTokensForQTC: the 1cs_v1-wrapped form alone is detected", function(){
  var r = m.scanTokensForQTC([LIVE_QTC_ROWS[1]]);
  assert.strictEqual(r.listed, true);
});
t("scanTokensForQTC: chain 'qtc' + symbol QTC detected; chain alone is not enough", function(){
  var byChain = m.scanTokensForQTC([{ assetId: "nep141:other.qtc.near", symbol: "QTC", blockchain: "qtc" }]);
  assert.strictEqual(byChain.listed, true);
  var chainOnly = m.scanTokensForQTC([{ assetId: "nep141:weth.qtc.near", symbol: "WETH", blockchain: "qtc" }]);
  assert.strictEqual(chainOnly.listed, false);
  var fakeQuantus = m.scanTokensForQTC([{ assetId: "x", symbol: "FAKE", blockchain: "quantus" }]);
  assert.strictEqual(fakeQuantus.listed, false);
});

// 14. An empty scan is inconclusive, never a NOT LISTED verdict
t("isConclusiveScan: zero rows prove nothing", function(){
  assert.strictEqual(m.isConclusiveScan(m.scanTokensForQTC([])), false);
  assert.strictEqual(m.isConclusiveScan(m.scanTokensForQTC(LIVE_QTC_ROWS)), true);
  assert.strictEqual(m.isConclusiveScan(null), false);
});

// 15. The persisted probe is validated before it paints (load boundary)
t("sanitizeCachedProbe: valid caches survive, poison does not paint", function(){
  var now = Date.now();
  var good = { ok: true, ms: 812, at: now - 60000, result: { listed: true, total: 204, asset: { assetId: "nep141:qtc.omft.near", decimals: 12 } } };
  var s = m.sanitizeCachedProbe(good, now);
  assert.ok(s && s.result.listed === true && s.result.total === 204 && s.at === good.at);
  var goodUnlisted = { ok: true, ms: 100, at: now - 1000, result: { listed: false, total: 204, asset: null } };
  assert.ok(m.sanitizeCachedProbe(goodUnlisted, now));
  assert.strictEqual(m.sanitizeCachedProbe(null, now), null);
  assert.strictEqual(m.sanitizeCachedProbe("junk", now), null);
  assert.strictEqual(m.sanitizeCachedProbe({ ok: false, ms: 1, at: now, result: { listed: false, total: 5, asset: null } }, now), null, "cached failure");
  assert.strictEqual(m.sanitizeCachedProbe({ ok: true, ms: 1, at: now + 3600e3, result: { listed: true, total: 204, asset: {} } }, now), null, "future at");
  assert.strictEqual(m.sanitizeCachedProbe({ ok: true, ms: 1, at: Date.UTC(2020, 0, 1), result: { listed: false, total: 5, asset: null } }, now), null, "pre-desk at");
  assert.strictEqual(m.sanitizeCachedProbe({ ok: true, ms: "fast", at: now, result: { listed: false, total: 5, asset: null } }, now), null, "ms string");
  assert.strictEqual(m.sanitizeCachedProbe({ ok: true, ms: 1, at: now, result: { listed: false, total: 0, asset: null } }, now), null, "total 0");
  assert.strictEqual(m.sanitizeCachedProbe({ ok: true, ms: 1, at: now, result: { listed: true, total: 204, asset: null } }, now), null, "listed without asset");
  assert.strictEqual(m.sanitizeCachedProbe({ ok: true, ms: 1, at: now, result: { listed: "yes", total: 204, asset: null } }, now), null, "listed non-boolean");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
