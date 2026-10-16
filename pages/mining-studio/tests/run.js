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
  block_times_ms: { avg_ms: 12413, sample: 3000, last: Array(3000).fill(12413) } };
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
  { fetched_at: '<b id="pwn">PWNED</b>', head: 194177.9, current: { height: 194177.9, est_hashrate_hs: "9.9e13" }, block_times_ms: { avg_ms: 15000, sample: 3000, last: Array(3000).fill(15000) } },
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

/* snapshot-boundary round 2 (relations, not just shapes — the
 * mining-calculator standard, verified on live data at head 206,532:
 * est_hashrate_hs == difficulty/12 exactly, current.height == head,
 * block_times sample 3000, supply total == free+reserved+frozen exactly,
 * consensus/supply heights equal). Pre-fix every case below painted:
 * a hashrate of "1000" against a 5.4e14 difficulty rounded the network
 * input to 0 GH/s, a total contradicting its balances rewrote supply,
 * a 50,000-block-stale supply mixed captures, a 3-block sample anchored
 * the pace, a 2999 fetched_at was cited as provenance, and a
 * 99,999,999,999 height was cited as the capture height. */
var dr = Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: { height: 151372, difficulty: "541503155817540", est_hashrate_hs: "1000" }, block_times_ms: { avg_ms: 12413, sample: 3000 } }, SUP);
ok("round2: hashrate contradicting its difficulty rejected", dr.netGH === null, dr.netGH);
var dr2 = Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151379, current: { height: 151372, difficulty: "541503155817540", est_hashrate_hs: "45125262984795" }, block_times_ms: { avg_ms: 12413, sample: 3000 } },
  { fetched_at: SUP.fetched_at, block_height: 151379, total_supply_plancks: SUP.total_supply_plancks });
ok("round2: height disagreement trusts neither consensus read (supply-agreed head wins)", dr2.height === 151379 && Math.abs(dr2.supplyQtc - 5763610.080351232) < 1e-6, dr2.height);
var SUPBAL = { fetched_at: SUP.fetched_at, block_height: 151373, total_supply_plancks: "5763610080351232263",
  balances_plancks: { free: "5763610080351232163", reserved: "100", frozen: "0" } };
ok("round2: totalSupplyOf accepts a total restated by its balances", Studio.totalSupplyOf(SUPBAL) === "5763610080351232263");
var SUPBAD = JSON.parse(JSON.stringify(SUPBAL)); SUPBAD.balances_plancks.free = "5763610080351231163";
ok("round2: total contradicting its balances rejected", Studio.totalSupplyOf(SUPBAD) === null);
ok("round2: derive rejects the contradictory supply", Studio.deriveNetworkDefaults(CONS, SUPBAD).supplyQtc === null);
var SUPAGG = JSON.parse(JSON.stringify(SUPBAL)); delete SUPAGG.total_supply_plancks;
ok("round2: balances aggregate adopted when the total is missing", Math.abs(Studio.deriveNetworkDefaults(CONS, SUPAGG).supplyQtc - 5763610.080351232) < 1e-6);
var SUPFRAC = JSON.parse(JSON.stringify(SUPAGG)); SUPFRAC.balances_plancks.free = "5763610080351232163.5";
ok("round2: fractional balance poisons the aggregate", Studio.totalSupplyOf(SUPFRAC) === null);
var SUPSTALE = { fetched_at: SUP.fetched_at, block_height: 101373, total_supply_plancks: SUP.total_supply_plancks };
ok("round2: supply from a different capture rejected", Studio.deriveNetworkDefaults(CONS, SUPSTALE).supplyQtc === null);
var SUPNEAR = { fetched_at: SUP.fetched_at, block_height: 151374, total_supply_plancks: SUP.total_supply_plancks };
ok("round2: supply one block from consensus adopted", Math.abs(Studio.deriveNetworkDefaults(CONS, SUPNEAR).supplyQtc - 5763610.080351232) < 1e-6);
var dpace = Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: { avg_ms: 12413, sample: 3 } }, SUP);
ok("round2: pace from a 3-block sample rejected", dpace.blocksPerDay === null && dpace.avgBlockMs === null);
var dpace2 = Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: { avg_ms: 12413.5, sample: 3000 } }, SUP);
ok("round2: fractional avg_ms rejected (fetch emits a rounded mean)", dpace2.blocksPerDay === null);
var dfut = Studio.deriveNetworkDefaults(
  { fetched_at: "2999-01-01T00:00:00.000Z", head: 151372, current: CONS.current, block_times_ms: CONS.block_times_ms }, SUP);
ok("round2: future fetched_at rejected, supply capture time stands", dfut.fetchedAt === SUP.fetched_at, dfut.fetchedAt);
var dold = Studio.deriveNetworkDefaults(
  { fetched_at: "2020-01-01T00:00:00.000Z", head: 151372, current: CONS.current, block_times_ms: CONS.block_times_ms }, SUP);
ok("round2: pre-genesis fetched_at rejected", dold.fetchedAt === SUP.fetched_at, dold.fetchedAt);
var dhuge = Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 99999999999, current: { height: 99999999999, difficulty: "541503155817540", est_hashrate_hs: "45125262984795" }, block_times_ms: CONS.block_times_ms },
  { fetched_at: SUP.fetched_at, block_height: 99999999999, total_supply_plancks: SUP.total_supply_plancks });
ok("round2: height past the 10,000,000 fleet bound rejected everywhere", dhuge.height === null, dhuge.height);
/* the REAL current snapshots pass their own boundary unchanged */
var fsr = require("fs"), pathr = require("path");
var realCons = JSON.parse(fsr.readFileSync(pathr.join(__dirname, "..", "..", "..", "data", "consensus.json"), "utf8"));
var realSup = JSON.parse(fsr.readFileSync(pathr.join(__dirname, "..", "..", "..", "data", "supply.json"), "utf8"));
var dreal = Studio.deriveNetworkDefaults(realCons, realSup);
ok("round2: real snapshots pass unchanged", dreal.netGH === Number(realCons.current.est_hashrate_hs) / 1e9 &&
  Math.abs(dreal.supplyQtc - Number(realSup.total_supply_plancks) / 1e12) < 1e-6 &&
  dreal.height === realCons.head && Math.abs(dreal.blocksPerDay - 86400000 / realCons.block_times_ms.avg_ms) < 1e-9,
  JSON.stringify(dreal));

/* snapshot-boundary round 3 (pace recompute — the consensus-lab
 * standard): avg_ms must BE Math.round(mean(last)) with sample ===
 * last.length, the fetch script's own construction. Pre-fix, a tampered
 * avg_ms of 2,000 beside an honest 14,000 window painted 43,200
 * blocks/day (~7x the honest pace) here and in the two sibling apps
 * reading the same snapshot (mining-calculator, pool-desk). */
var BT3 = { avg_ms: 14000, sample: 300, last: Array(300).fill(14000) };
var dpace3 = Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: BT3 }, SUP);
ok("round3: honest window anchors the pace", Math.abs(dpace3.blocksPerDay - 86400000 / 14000) < 1e-9, dpace3.blocksPerDay);
ok("round3: paceAvgMs accepts an exact varied mean", Studio.paceAvgMs({ avg_ms: 15000, sample: 200, last: Array(100).fill(10000).concat(Array(100).fill(20000)) }) === 15000);
var bt3tamper = JSON.parse(JSON.stringify(BT3)); bt3tamper.avg_ms = 2000;
ok("round3: tampered avg rejected", Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: bt3tamper }, SUP).blocksPerDay === null);
var bt3short = JSON.parse(JSON.stringify(BT3)); bt3short.sample = 3000;
ok("round3: sample != last.length rejected", Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: bt3short }, SUP).blocksPerDay === null);
var bt3none = { avg_ms: 14000, sample: 300 };
ok("round3: missing last rejected", Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: bt3none }, SUP).blocksPerDay === null);
var bt3neg = JSON.parse(JSON.stringify(BT3)); bt3neg.last[0] = -5;
ok("round3: negative delta rejected", Studio.deriveNetworkDefaults(
  { fetched_at: CONS.fetched_at, head: 151372, current: CONS.current, block_times_ms: bt3neg }, SUP).blocksPerDay === null);

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
ok("fallback hint cites a dated capture height", !!hintM && /block [0-9]{1,3},[0-9]{3} on 2026-/.test(hintM[1]), hintM && hintM[1].slice(0, 80));
ok("fallback hint difficulty matches painted netHash (one capture)",
   !!hintM && /438,101,530,539,520/.test(hintM[1]) && Math.abs(Number(nhVal) - 438101530539520 / 12 / 1e9) < 1,
   nhVal);
ok("stale 45,125 example gone", !/45,125/.test(html));

/* checklist localStorage boundary (white-hat track, 2026-10-16): the old
 * loaders only caught JSON syntax errors — valid-JSON "null" crashed
 * renderSec (aborting init before the troubleshooter rendered), "abc"
 * counted 3 phantom hardened items off its string indices, arrays
 * counted, and unknown keys were preserved unbounded on every toggle
 * save. sanitizeSecDone rebuilds: real indices only, strict true only. */
ok("sec sanitize: null -> empty, no throw", JSON.stringify(Studio.sanitizeSecDone(null)) === "{}");
ok("sec sanitize: string -> empty (no phantom hardened)", JSON.stringify(Studio.sanitizeSecDone("abc")) === "{}");
ok("sec sanitize: number/bool -> empty", JSON.stringify(Studio.sanitizeSecDone(123)) === "{}" && JSON.stringify(Studio.sanitizeSecDone(true)) === "{}");
ok("sec sanitize: array -> empty", JSON.stringify(Studio.sanitizeSecDone([true, true])) === "{}");
ok("sec sanitize: honest booleans kept, false dropped", JSON.stringify(Studio.sanitizeSecDone({ 0: true, 2: true, 3: false })) === '{"0":true,"2":true}');
ok("sec sanitize: truthy non-booleans dropped", JSON.stringify(Studio.sanitizeSecDone({ 0: "yes", 1: 1, 2: true })) === '{"2":true}');
ok("sec sanitize: out-of-range indices + unknown keys dropped", JSON.stringify(Studio.sanitizeSecDone({ 0: true, 8: true, 999: true, poison: true })) === '{"0":true}');
ok("sec sanitize: fresh object, input unmutated", (function () { var inp = { 0: "yes", 9: true }; var out = Studio.sanitizeSecDone(inp); return out !== inp && inp[0] === "yes" && !("0" in out); })());

console.log("\n" + (n - fails) + "/" + n + " passed" + (fails ? " — FAILURES" : ""));
process.exit(fails ? 1 : 0);
