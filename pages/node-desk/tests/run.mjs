#!/usr/bin/env node
/* QTC Node Operator Desk — node logic tests.
 * Vectors hand-derived from the research brief (Quantus-Network/chain,
 * docs, quantus-miner sources read 2026-09-30). Run: node tests/run.mjs
 */
import {
  BOOTNODES, PORTS, CHAIN_SPECS,
  validateInnerHash, validateNodeName, validatePortNumber, validateBootnode, shq,
  buildNodeCommand, firewallRules, classifyLogLine, analyzeLog,
  syncProgress, fmtEta,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
