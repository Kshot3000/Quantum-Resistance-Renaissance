// QTC Mining Studio logic tests (node). Run: node tests/run.js
var Studio = require("../app.js");
var n = 0, fails = 0;
function ok(name, cond, extra) {
  n++; if (!cond) { fails++; console.log("FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
  else console.log("PASS " + name);
}

/* emission math — (21M - supply)/50M, per upstream docs/reference/tokenomics.md */
ok("reward at genesis mint", Math.abs(Studio.blockReward(5670000) - 0.3066) < 1e-9, Studio.blockReward(5670000));
ok("reward halves nowhere (smooth)", Studio.blockReward(10000000) < Studio.blockReward(5670000));
ok("reward zero at cap", Studio.blockReward(21000000) === 0);
ok("reward never negative past cap", Studio.blockReward(22000000) === 0);
ok("blocks/day = 7200", Studio.blocksPerDay() === 7200);

/* earnings estimate */
var e = Studio.estimate(1200, 50, 5720000); // 1.2 GH/s vs 50 GH/s net
ok("estimate not null", !!e);
ok("estimate share = 2.4%", Math.abs(e.share - 0.024) < 1e-12);
ok("estimate qtc/day sane", e.qtcPerDay > 0 && e.qtcPerDay < 100, e.qtcPerDay);
var e2 = Studio.estimate(1200, 50, 5720000);
ok("estimate deterministic", Math.abs(e.qtcPerDay - e2.qtcPerDay) < 1e-12);
ok("estimate null on bad input", Studio.estimate(0, 50, 5720000) === null && Studio.estimate(1200, 0, 5720000) === null);

/* benchmark grading */
ok("grade on-target", Studio.gradeBenchmark(1100, 1130).cls === "great");
ok("grade below-ref", Studio.gradeBenchmark(700, 1130).cls === "good");
ok("grade way-low", Studio.gradeBenchmark(300, 1130).cls === "low");
ok("grade exceptional", Studio.gradeBenchmark(1600, 1130).cls === "great");
ok("grade null on bad input", Studio.gradeBenchmark(0, 1130) === null);

/* formatting */
ok("format GH", Studio.formatHash(1200) === "1.20 GH/s");
ok("format MH", Studio.formatHash(765) === "765 MH/s");
ok("format small", Studio.formatHash(0.5) === "500 kH/s");

/* sanitizer */
ok("sanitize strips injection", Studio.sanitize("node; rm -rf /", "fb") === "noderm-rf/");
ok("sanitize keeps path chars", Studio.sanitize("~/.local/share/quantus-node", "fb") === "~/.local/share/quantus-node");
ok("sanitize fallback", Studio.sanitize("!!!", "fb") === "fb");

/* command builders */
var o = { name: "rig1", base: "~/.local/share/quantus-node", cpu: 4, gpu: 1, cuda: true, external: true };
var nc = Studio.nodeRunCmd(o);
ok("node cmd has chain mainnet", /--chain mainnet/.test(nc));
ok("node cmd has validator", /--validator/.test(nc));
ok("node cmd has name", /--name rig1/.test(nc));
ok("node cmd has rewards-inner-hash placeholder", /--rewards-inner-hash <YOUR_PREIMAGE>/.test(nc));
ok("node cmd has sync flags", /--sync full --max-blocks-per-request 64/.test(nc));
ok("node cmd miner port when external", /--miner-listen-port 9833/.test(nc));
var nc2 = Studio.nodeRunCmd(Object.assign({}, o, { external: false }));
ok("node cmd omits miner port when solo", !/--miner-listen-port/.test(nc2));
var mc = Studio.minerServeCmd(o);
ok("miner cmd has QUIC addr", /--node-addr 127.0.0.1:9833/.test(mc));
ok("miner cmd has auth token", /--auth-token-file/.test(mc));
ok("miner cmd has tls fingerprint", /--tls-cert-sha256-file/.test(mc));
ok("miner cmd cuda flag", /--cuda-gpu/.test(mc));
ok("miner cmd workers", /--cpu-workers 4 --gpu-devices 1/.test(mc));

/* step builders per OS */
["linux", "macos", "windows", "docker"].forEach(function (os) {
  var steps = Studio.buildSteps(os, o);
  ok(os + " steps non-empty", steps.length >= 4, steps.length);
  ok(os + " has wormhole step", steps.some(function (s) { return /wormhole/i.test(s.t); }));
  ok(os + " every step has title+desc", steps.every(function (s) { return s.t && s.d && s.cmds && s.cmds.length; }));
});
var wst = Studio.buildSteps("windows", o);
ok("windows has defender step", wst.some(function (s) { return /Defender/i.test(s.t); }));
ok("windows uses exe", wst.some(function (s) { return s.cmds.some(function (c) { return /quantus-node\.exe/.test(c.code); }); }));
var dst = Studio.buildSteps("docker", o);
ok("docker uses ghcr image", dst.some(function (s) { return s.cmds.some(function (c) { return /ghcr\.io\/quantus-network/.test(c.code); }); }));

/* data integrity */
ok("11 GPUs listed", Studio.GPUS.length === 11);
ok("GPU rows have lo<=hi", Studio.GPUS.every(function (g) { return g.lo <= g.hi && g.lo > 0; }));
ok("GPU rows sourced", Studio.GPUS.every(function (g) { return g.src && g.src.length > 3; }));
ok("8 security items", Studio.SECURITY.length === 8);
ok("7 troubleshooters", Studio.FIXES.length === 7);
ok("no dev-tax claim in constants", Studio.CHAIN.WORMHOLE_EXIT_FEE_BPS === 4);

/* snapshot-derived network defaults (v1.1.0) — fixtures mirror the real
 * data/consensus.json + data/supply.json shapes at block ~151,373 */
var CONS = { fetched_at: "2026-10-02T08:02:18.680Z", head: 151372,
  current: { height: 151372, difficulty: "541503155817540", est_hashrate_hs: "45125262984795" },
  block_times_ms: { avg_ms: 12413 } };
var SUP = { fetched_at: "2026-10-02T08:02:28.460Z", block_height: 151373, total_supply_plancks: "5763610080351232263" };
var dn = Studio.deriveNetworkDefaults(CONS, SUP);
ok("derive netGH from est hashrate", Math.abs(dn.netGH - 45125.262984795) < 1e-6, dn.netGH);
ok("derive supply = total issuance", Math.abs(dn.supplyQtc - 5763610.080351232) < 1e-6, dn.supplyQtc);
ok("derive pace from observed avg block time", Math.abs(dn.blocksPerDay - 86400000 / 12413) < 1e-9, dn.blocksPerDay);
ok("derive height + fetchedAt", dn.height === 151372 && dn.fetchedAt === CONS.fetched_at);
ok("derive reward at snapshot supply = 0.3047278", Math.abs(Studio.blockReward(dn.supplyQtc) - 0.3047278) < 1e-6, Studio.blockReward(dn.supplyQtc));
var dnull = Studio.deriveNetworkDefaults(null, null);
ok("derive null-safe", dnull.netGH === null && dnull.supplyQtc === null && dnull.blocksPerDay === null);
var dbad = Studio.deriveNetworkDefaults({ current: { est_hashrate_hs: "0" }, block_times_ms: { avg_ms: 5 } }, { total_supply_plancks: "100" });
ok("derive rejects implausible fields", dbad.netGH === null && dbad.blocksPerDay === null && dbad.supplyQtc === null);
var dpart = Studio.deriveNetworkDefaults(CONS, null);
ok("derive partial: consensus only", dpart.netGH > 0 && dpart.supplyQtc === null && dpart.blocksPerDay > 0);

/* load-boundary hardening (2026-10-09): the indexer emits plancks/hashrate
 * as integer strings and heights as integers — fractional/scientific
 * strings, float heights, and unparseable fetched_at values are poison,
 * not defaults. Pre-fix, Number()/String() coercion accepted all of them:
 * "6.5e18" plancks rewrote supply to 6,500,000, a markup-bearing
 * fetched_at was rendered verbatim into the hint's innerHTML, and a
 * float height was cited as the capture height. */
var dpoison = Studio.deriveNetworkDefaults(
  { fetched_at: '<b id="pwn">PWNED</b>', head: 194177.9, current: { height: 194177.9, est_hashrate_hs: "9.9e13" }, block_times_ms: { avg_ms: 15000 } },
  { fetched_at: "garbage!!", block_height: -5, total_supply_plancks: "6.5e18" });
ok("derive rejects sci hashrate", dpoison.netGH === null, dpoison.netGH);
ok("derive rejects float height (no supply fallback either)", dpoison.height === null, dpoison.height);
ok("derive drops garbage fetched_at from both snapshots", dpoison.fetchedAt === null, dpoison.fetchedAt);
ok("derive rejects sci plancks", dpoison.supplyQtc === null, dpoison.supplyQtc);
ok("derive keeps valid pace amid poison", Math.abs(dpoison.blocksPerDay - 86400000 / 15000) < 1e-9);
var dfrac = Studio.deriveNetworkDefaults(null, { total_supply_plancks: "5763610080351232263.5" });
ok("derive rejects fractional plancks", dfrac.supplyQtc === null);
var dtsfall = Studio.deriveNetworkDefaults(
  { fetched_at: "not-a-date", current: { height: 151372, est_hashrate_hs: "45125262984795" } }, SUP);
ok("derive falls back to supply fetched_at when consensus is garbage",
   dtsfall.fetchedAt === SUP.fetched_at && dtsfall.height === 151372, dtsfall.fetchedAt);
var dhfall = Studio.deriveNetworkDefaults(
  { current: { height: 1.5, est_hashrate_hs: "45125262984795" } }, SUP);
ok("derive falls back to supply integer height when consensus height is a float",
   dhfall.height === SUP.block_height, dhfall.height);

/* estimate supply guard: a cleared/negative supply field must dash the
 * earnings, never paint "NaN QTC" (blockReward(NaN) is NaN). */
ok("estimate null on NaN supply", Studio.estimate(1200, 50, NaN) === null);
ok("estimate null on negative supply", Studio.estimate(1200, 50, -100) === null);
var ecap = Studio.estimate(1200, 50, 22000000);
ok("estimate past cap is zero, not null", !!ecap && ecap.reward === 0 && ecap.qtcPerDay === 0);

/* estimate pace param (backward compatible) */
var ep = Studio.estimate(1200, 50, 5720000, 6000);
ok("estimate honors pace param", Math.abs(ep.networkBlocksPerDay - 6000) < 1e-12 && Math.abs(ep.qtcPerDay - ep.share * 6000 * ep.reward) < 1e-12);
var ed = Studio.estimate(1200, 50, 5720000);
ok("estimate default pace still 7200", ed.networkBlocksPerDay === 7200);
ok("estimate bad pace falls back", Studio.estimate(1200, 50, 5720000, -5).networkBlocksPerDay === 7200 && Studio.estimate(1200, 50, 5720000, NaN).networkBlocksPerDay === 7200);
ok("slower observed pace lowers qtc/day", ep.qtcPerDay < ed.qtcPerDay);

/* static HTML fallback integrity — on the no-fetch path (file://, offline,
 * snapshots unreachable) the painted defaults ARE the estimator's inputs, so
 * they must be present, plausible, and dated to one capture. Regression
 * guard for the pre-v1.2.0 state: netHash painted empty (dead estimator)
 * with a stale "45,125" example ~18% under the real network rate, and a
 * curSupply paint from an hours-older capture than the hint claimed. */
var html = require("fs").readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
function inputVal(id) {
  var m = html.match(new RegExp('id="' + id + '"[^>]*value="([^"]*)"')) ||
          html.match(new RegExp('value="([^"]*)"[^>]*id="' + id + '"'));
  return m ? m[1] : null;
}
var nhVal = inputVal("netHash"), csVal = inputVal("curSupply");
ok("fallback netHash paints a value (estimator alive offline)", nhVal !== null && nhVal !== "" && isFinite(Number(nhVal)), nhVal);
ok("fallback netHash plausible GH/s band", Number(nhVal) >= 1000 && Number(nhVal) <= 500000, nhVal);
ok("fallback curSupply paints a value", csVal !== null && csVal !== "" && isFinite(Number(csVal)), csVal);
ok("fallback curSupply within emission bounds", Number(csVal) >= 5670000 && Number(csVal) <= 21000000, csVal);
var hintM = html.match(/id="supplyHint"[^>]*>([\s\S]*?)<\/p>/);
ok("fallback hint cites a dated capture height", !!hintM && /block 1[0-9]{2},[0-9]{3} on 2026-/.test(hintM[1]), hintM && hintM[1].slice(0, 80));
ok("fallback hint difficulty matches painted netHash (one capture)",
   !!hintM && /505,287,407,820,345/.test(hintM[1]) && Math.abs(Number(nhVal) - 505287407820345 / 12 / 1e9) < 1,
   nhVal);
ok("stale 45,125 example gone", !/45,125/.test(html));

console.log("\n" + (n - fails) + "/" + n + " passed" + (fails ? " — FAILURES" : ""));
process.exit(fails ? 1 : 0);
