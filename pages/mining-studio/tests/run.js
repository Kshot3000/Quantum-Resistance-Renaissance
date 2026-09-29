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

console.log("\n" + (n - fails) + "/" + n + " passed" + (fails ? " — FAILURES" : ""));
process.exit(fails ? 1 : 0);
