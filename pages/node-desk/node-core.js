/* QTC Node Operator Desk — node-core.js
 * Pure, testable logic: command builders, validators, log forensics,
 * port map, firewall rule generation, bootnode registry.
 * Every constant below was read from Quantus-Network sources on 2026-09-30
 * (see README.md "Method & sources"). Anything unverified is NOT here.
 */

/* ---------- verified bootnodes: chain/node/src/chain-specs/mainnet.json ---------- */
export const BOOTNODES = [
  "/dns/a1-p2p-mainnet.quantus.com/tcp/30333/p2p/QmQPbu6ehSrE5BAaHxc9q8eneYYKCEWhm1PLyj7r2mvdSs",
  "/dns/a2-p2p-mainnet.quantus.com/tcp/30333/p2p/QmfTXSJYhmC16KKdYzQ75ZKqcYvmqC8DDAFGeEtM6H3MYp",
  "/dns/a3-p2p-mainnet.quantus.com/tcp/30333/p2p/QmZ7by28DRrEyZwgUxWvE8V9KquXmxktMfHDFzjYJpGG7w",
  "/dns/a4-p2p-mainnet.quantus.com/tcp/30333/p2p/QmV5SAgF7mvf5MxR8exWYCso7qZSpyR9BD4HhoszHS9X6K",
  "/dns/a5-p2p-mainnet.quantus.com/tcp/30333/p2p/QmNYp95prP12qi7fsyyjwC5TtAbZgy3fuaCyvMTuJqgmxd",
  "/dns/a6-p2p-mainnet.quantus.com/tcp/30333/p2p/QmXkz5xc9Nv3e4zgRxm8sELShtBHEKUrxREXkceRpH7QNH",
  "/dns/a7-p2p-mainnet.quantus.com/tcp/30333/p2p/QmUCmm1ide7k6Yww959ysPN3xUZjhRq6sK93dvvoMqDQxe",
];

/* ---------- verified ports ---------- */
export const PORTS = [
  { port: 30333, proto: "TCP", service: "P2P networking", expose: "PUBLIC — the only port that should face the internet", src: "chain default --port" },
  { port: 9944, proto: "TCP", service: "RPC (HTTP + WebSocket)", expose: "LOCALHOST ONLY — never expose publicly", src: "docs mining guide; polkadot-js ws://localhost:9944" },
  { port: 9833, proto: "UDP", service: "Miner QUIC job server", expose: "LOCALHOST / VPN ONLY — binds 0.0.0.0 by default", src: "--miner-listen-port, chain/node/src/cli.rs" },
  { port: 9615, proto: "TCP", service: "Prometheus metrics", expose: "LOCALHOST ONLY", src: "docs mining guide + mining-skill.md + sc-cli default (chain/MINING.md lists 9616 — verify with quantus-node --help)" },
  { port: 9900, proto: "TCP", service: "quantus-miner metrics", expose: "LOCALHOST ONLY", src: "--metrics-port, quantus-miner/README.md" },
];

/* ---------- chain specs: chain/node/src/command.rs load_spec ---------- */
export const CHAIN_SPECS = [
  { id: "mainnet", token: "QTC", decimals: 12, ss58: 189, note: "Production network. Requires node v1.0.1+." },
  { id: "planck", token: "PLK", decimals: 12, ss58: 189, note: "Retired testnet — no carryover to mainnet. Old docs examples still say planck; use mainnet." },
  { id: "heisenberg", token: "—", decimals: 12, ss58: 189, note: "Accepted by --chain; purpose unverified in the sources read — treat as reserved." },
];

export const TELEMETRY = "https://telemetry.quantus.cat/";
export const EXPLORER = "https://explorer.quantus.com/";
export const RELEASES = "https://github.com/Quantus-Network/chain/releases/latest";
export const DOCKER_IMAGE = "ghcr.io/quantus-network/quantus-node:latest";
export const SETUP_SCRIPT = "https://docs.quantus.com/scripts/quantus-mining.sh";
export const PUBLIC_RPC = "wss://rpc.quantus.network";

/* ---------- validators ---------- */

/** 32-byte wormhole preimage: 0x-prefixed, 64 hex chars. */
export function validateInnerHash(s) {
  const v = String(s || "").trim();
  if (!v) return { ok: false, error: "Empty — generate one with: quantus-node key quantus --scheme wormhole" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(v))
    return { ok: false, error: "Must be 0x followed by exactly 64 hex characters (32 bytes)" };
  return { ok: true, value: v.toLowerCase() };
}

export function validateNodeName(s) {
  const v = String(s || "").trim();
  if (!v) return { ok: false, error: "Node name is required" };
  if (v.length > 40) return { ok: false, error: "Keep it ≤ 40 characters (telemetry display)" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v))
    return { ok: false, error: "Use letters, digits, dots, dashes, underscores — start with a letter or digit" };
  return { ok: true, value: v };
}

export function validatePortNumber(s, label) {
  const n = Number(String(s || "").trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    return { ok: false, error: `${label}: must be an integer 1–65535` };
  if (n < 1024) return { ok: false, error: `${label}: ${n} is privileged (<1024) — pick ≥1024 or run as root (not recommended)` };
  return { ok: true, value: n };
}

export function validateBootnode(s) {
  const v = String(s || "").trim();
  if (/^\/(dns|dns4|dns6|ip4|ip6)\/[^/]+\/tcp\/\d+\/p2p\/[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(v))
    return { ok: true, value: v };
  return { ok: false, error: "Not a valid libp2p multiaddr — expected /dns|ip4|ip6/host/tcp/PORT/p2p/PEERID" };
}

/** Shell-quote one argument. */
export function shq(s) {
  const v = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v;
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

/* ---------- launch command builder ----------
 * Mirrors the canonical startup from the docs mining guide plus the custom
 * flags in chain/node/src/cli.rs. Returns { cmd, minerCmd, warnings[], errors[] }.
 *
 * opts: {
 *   name, validator=true, mode: 'external'|'local'|'fullnode',
 *   minerListenPort, innerHash, nodeKeyFile, basePath, chain='mainnet',
 *   forceAuthoring, maxTipAgeSec, experimentalRpc, prometheusPort,
 *   miner: { nodeAddr, authTokenFile, tlsCertFile, cpuWorkers, gpuDevices, cuda, metricsPort }
 * }
 */
export function buildNodeCommand(o = {}) {
  const errors = [], warnings = [];
  const chain = (o.chain || "mainnet").trim() || "mainnet";
  if (!["mainnet", "planck", "heisenberg"].includes(chain) && !chain.endsWith(".json"))
    warnings.push(`--chain "${chain}" is not one of the embedded specs (mainnet|planck|heisenberg); it will be treated as a path to a JSON spec file.`);

  const parts = ["./quantus-node"];

  const nn = validateNodeName(o.name);
  if (!nn.ok) errors.push("Node name: " + nn.error); else parts.push("--name", shq(nn.value));

  const mode = o.mode || "external";
  const validator = o.validator !== false;
  if (validator) parts.push("--validator");
  if (!validator) warnings.push("Without --validator the node will not mine and --miner-listen-port will fail at startup.");

  if (mode === "external") {
    const mp = validatePortNumber(o.minerListenPort ?? 9833, "Miner listen port");
    if (!mp.ok) errors.push(mp.error); else parts.push("--miner-listen-port", String(mp.value));
    if (mp.ok && mp.value !== 9833) warnings.push(`Non-default miner port ${mp.value}: point quantus-miner at it with --node-addr 127.0.0.1:${mp.value}.`);
    warnings.push("The miner QUIC port binds 0.0.0.0 — keep it off the public internet (localhost or VPN only).");
    const ih = validateInnerHash(o.innerHash);
    if (!ih.ok) errors.push("Rewards inner hash: " + ih.error); else parts.push("--rewards-inner-hash", ih.value);
  } else if (mode === "local") {
    const ih = validateInnerHash(o.innerHash);
    if (!ih.ok) errors.push("Rewards inner hash: " + ih.error); else parts.push("--rewards-inner-hash", ih.value);
    warnings.push("Local CPU mining grinds ~50k nonces/batch — fine for testing, not competitive (see Mining Studio).");
  } else {
    warnings.push("Full-node-only mode: syncs and serves RPC, does not mine. Omit --rewards-inner-hash.");
  }

  if (o.nodeKeyFile) parts.push("--node-key-file", shq(o.nodeKeyFile.trim()));
  else warnings.push("No --node-key-file: the node generates an ephemeral peer identity each restart — fine for testing, pin one for production.");

  if (o.basePath) parts.push("--base-path", shq(o.basePath.trim()));

  parts.push("--chain", shq(chain));

  if (o.forceAuthoring) {
    parts.push("--force-authoring");
    warnings.push("--force-authoring bypasses the 24h freshness gate — bootstrap use only; remove once synced.");
  } else {
    warnings.push("Freshness gate: the node refuses to mine until the best block is ≤ 24 h old (--max-tip-age).");
  }

  parts.push("--max-blocks-per-request", "64", "--sync", "full");

  if (o.experimentalRpc) {
    parts.push("--experimental-rpc-endpoint", shq("listen-addr=127.0.0.1:9944,methods=unsafe,cors=all"));
    warnings.push("Experimental RPC endpoint with methods=unsafe on localhost — never expose 9944 publicly.");
  }

  if (o.prometheusPort) {
    const pp = validatePortNumber(o.prometheusPort, "Prometheus port");
    if (!pp.ok) errors.push(pp.error); else parts.push("--prometheus-port", String(pp.value));
  }

  // miner command (external mode only)
  let minerCmd = null;
  if (mode === "external" && errors.length === 0) {
    const m = o.miner || {};
    const mp = validatePortNumber(o.minerListenPort ?? 9833, "Miner listen port").value || 9833;
    const mc = ["./quantus-miner", "serve",
      "--node-addr", `127.0.0.1:${mp}`,
      "--auth-token-file", shq((m.authTokenFile || "<base-path>/chains/mainnet/miner-auth-token").trim()),
      "--tls-cert-sha256-file", shq((m.tlsCertFile || "<base-path>/chains/mainnet/miner-tls-cert-sha256").trim())];
    if (m.cpuWorkers) mc.push("--cpu-workers", String(Math.max(1, Math.floor(m.cpuWorkers))));
    if (m.gpuDevices) mc.push("--gpu-devices", String(Math.max(1, Math.floor(m.gpuDevices))));
    if (m.cuda) mc.push("--cuda-gpu");
    if (m.metricsPort) mc.push("--metrics-port", String(m.metricsPort));
    minerCmd = mc.join(" ");
  }

  return { cmd: errors.length ? null : parts.join(" "), minerCmd, warnings, errors };
}

/* ---------- firewall rule generator ---------- */
export function firewallRules(tool, p2pPort = 30333) {
  const p = Number(p2pPort) || 30333;
  if (tool === "ufw") return [
    `sudo ufw allow ${p}/tcp comment 'Quantus P2P'`,
    `sudo ufw deny 9944/tcp comment 'Quantus RPC stays local'`,
    `sudo ufw deny 9833/udp comment 'Quantus miner QUIC stays local'`,
    `sudo ufw enable && sudo ufw status numbered`,
  ].join("\n");
  if (tool === "iptables") return [
    `sudo iptables -A INPUT -p tcp --dport ${p} -j ACCEPT   # Quantus P2P (public)`,
    `sudo iptables -A INPUT -p tcp --dport 9944 ! -s 127.0.0.1 -j DROP   # RPC: localhost only`,
    `sudo iptables -A INPUT -p udp --dport 9833 ! -s 127.0.0.1 -j DROP   # miner QUIC: localhost only`,
  ].join("\n");
  if (tool === "nftables") return [
    `sudo nft add rule inet filter input tcp dport ${p} accept   # Quantus P2P (public)`,
    `sudo nft add rule inet filter input tcp dport 9944 ip saddr != 127.0.0.1 drop`,
    `sudo nft add rule inet filter input udp dport 9833 ip saddr != 127.0.0.1 drop`,
  ].join("\n");
  throw new Error("unknown firewall tool: " + tool);
}

/* ---------- log forensics ----------
 * classifyLogLine(line) -> { level: 'ok'|'info'|'warn'|'error', title, detail, fix }
 * Patterns are real log lines documented in chain/MINING.md, docs mining guide,
 * and the troubleshooting notes in the research brief.
 */
const LOG_PATTERNS = [
  {
    re: /Mining rewards will be sent to wormhole address/i,
    level: "ok", title: "Miner identity confirmed",
    detail: "The node derived your wormhole reward address from --rewards-inner-hash. Confirm it matches the Address printed by `quantus-node key quantus --scheme wormhole`.",
  },
  {
    re: /miner-auth-token/i,
    level: "info", title: "Miner auth token",
    detail: "Random token generated on first run (mode 0600), never logged. quantus-miner must present it via --auth-token-file.",
  },
  {
    re: /\bIdle\b.*\(\d+ peers?\)/i,
    level: "ok", title: "Node synced (Idle)",
    detail: "The node is caught up with the network tip and idling between blocks. Ready to mine.",
  },
  {
    re: /\bSyncing\b/i,
    level: "info", title: "Still syncing",
    detail: "Catching up from genesis. Expect ~15 minutes to a couple of hours; done when the log switches from Syncing to Idle.",
  },
  {
    re: /Verification failed/i,
    level: "error", title: "Version mismatch — upgrade the node",
    detail: "The node is out of step with the network (often stalls with 0 peers). Download the latest node+miner pair from the releases page; ALPN quantus-miner/2 must match on both.",
    fix: "Upgrade to the latest release pair, then restart. See the Update desk below.",
  },
  {
    re: /idle.*(timeout|timed out)|no application protocol|ALPN/i,
    level: "error", title: "Miner connection problem",
    detail: "Idle timeout (node drops miner connections after 60 s without keep-alive — miners must heartbeat every 5–15 s) or TLS ALPN mismatch (node/miner versions disagree on quantus-miner/2).",
    fix: "Use the matching node+miner release pair; ensure keep-alives are on.",
  },
  {
    re: /maximum tip age|too old|max-tip-age/i,
    level: "warn", title: "Freshness gate blocked authoring",
    detail: "The node refuses to mine until the best block is ≤ 24 h old (--max-tip-age). Wait for sync to finish; --force-authoring bypasses it for bootstrap only.",
  },
  {
    re: /warp|snapshot/i,
    level: "warn", title: "No fast-sync available",
    detail: "Quantus publishes no official snapshots or warp sync — the only recovery is purge-chain --chain mainnet and a full resync.",
  },
  {
    re: /\bpanic\b|FATAL|failed to/i,
    level: "error", title: "Node error",
    detail: "A hard failure. Check disk space, file permissions on the base path, and that no other node holds the DB lock.",
  },
  {
    re: /\bWARN\b|\bwarn/i,
    level: "warn", title: "Warning",
    detail: "Non-fatal. Watch whether it repeats — repeated warnings during sync are usually benign.",
  },
  {
    re: /\bERROR\b|\berror/i,
    level: "error", title: "Error",
    detail: "Something failed. Match it against the known patterns above; otherwise check the Update desk.",
  },
];

export function classifyLogLine(line) {
  const s = String(line || "");
  if (!s.trim()) return null;
  for (const p of LOG_PATTERNS) {
    if (p.re.test(s)) return { level: p.level, title: p.title, detail: p.detail, fix: p.fix || null, line: s.slice(0, 300) };
  }
  return { level: "info", title: "Unrecognized line", detail: "No known pattern matches. It may be routine (peer chatter, block import). Paste surrounding lines for context.", line: s.slice(0, 300) };
}

export function analyzeLog(text) {
  const lines = String(text || "").split("\n").map(l => l.trim()).filter(Boolean);
  const seen = new Map();
  for (const l of lines) {
    const c = classifyLogLine(l);
    if (!c || c.title === "Unrecognized line") continue;
    const key = c.title;
    if (!seen.has(key)) seen.set(key, { ...c, count: 0, samples: [] });
    const e = seen.get(key);
    e.count++;
    if (e.samples.length < 2) e.samples.push(c.line);
  }
  return { total: lines.length, findings: [...seen.values()] };
}

/* ---------- sync progress ---------- */
export function syncProgress(localHeight, networkHeight) {
  const l = Number(localHeight), n = Number(networkHeight);
  if (!Number.isFinite(l) || !Number.isFinite(n) || l < 0 || n <= 0) return null;
  const behind = Math.max(0, Math.floor(n - l));
  const pct = Math.min(100, (l / n) * 100);
  const etaMin = behind > 0 ? Math.ceil((behind * 12) / 60) : 0; // 12 s target block time
  return { behind, pct, etaMin, synced: behind === 0 };
}

export function fmtEta(min) {
  if (min <= 0) return "caught up";
  if (min < 60) return `≈ ${min} min at 12 s/block`;
  const h = Math.floor(min / 60);
  return h < 48 ? `≈ ${h} h at 12 s/block` : `≈ ${(h / 24).toFixed(1)} days at 12 s/block`;
}
