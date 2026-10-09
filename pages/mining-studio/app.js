/* QTC Mining Studio — setup wizard, rig builder, benchmark grader, checklist.
 * Pure logic lives in Studio.* (exported for node tests); DOM wiring below.
 * Facts: emission (21M-supply)/50M, 100% block reward to miner, wormhole exit fee
 * 0.04% — per upstream docs/reference/tokenomics.md (verified 2026-09-29).
 * Commands follow upstream chain/MINING.md + quantus-miner README.
 */
(function () {
"use strict";

var Studio = {};

Studio.CHAIN = {
  MAX_SUPPLY: 21000000,
  GENESIS_MINT: 5670000,
  EMISSION_DIVISOR: 50000000,
  BLOCK_TIME_S: 12,
  DECIMALS: 12,
  SS58_PREFIX: 189,
  MINER_PROTOCOL: "quantus-miner/2",
  WORMHOLE_EXIT_FEE_BPS: 4
};

Studio.GPUS = [
  { name: "RTX 5090",      lo: 1200, hi: 1500, src: "bytwork community bench" },
  { name: "RTX 4090",      lo: 1120, hi: 1140, src: "bytwork · Fl4shMiner" },
  { name: "RTX 4080 SUPER",lo: 765,  hi: 765,  src: "bytwork (SRBminer Multi)" },
  { name: "RTX 4070",      lo: 874,  hi: 874,  src: "bytwork" },
  { name: "RTX 4070 Ti",   lo: 600,  hi: 600,  src: "bytwork" },
  { name: "RTX 3080 Ti",   lo: 458,  hi: 458,  src: "Fl4shMiner tested" },
  { name: "RTX 3090 Ti",   lo: 164,  hi: 347,  src: "longcipher (official vs tuned build)" },
  { name: "RTX 3070",      lo: 218,  hi: 320,  src: "bytwork (eco → max)" },
  { name: "RTX 5060 Ti",   lo: 302,  hi: 313,  src: "bytwork" },
  { name: "RTX 3060",      lo: 190,  hi: 190,  src: "bytwork" },
  { name: "CMP 90HX",      lo: 300,  hi: 300,  src: "bytwork (weak on Poseidon2)" }
];
Studio.CPU_PER_THREAD_MH = 15; // official miner, per 0xmoei guide

Studio.BENCH_DEVICES = Studio.GPUS.map(function (g) {
  return { name: g.name, mid: (g.lo + g.hi) / 2, src: g.src };
}).concat([{ name: "CPU thread", mid: Studio.CPU_PER_THREAD_MH, src: "0xmoei guide" }]);

/* ---- math ---- */
Studio.blockReward = function (supply) {
  var c = Studio.CHAIN;
  return Math.max(0, (c.MAX_SUPPLY - supply) / c.EMISSION_DIVISOR);
};
Studio.blocksPerDay = function () { return 86400 / Studio.CHAIN.BLOCK_TIME_S; };
/* Derive the earnings estimator's network defaults from the builder's
 * hourly chain snapshots (data/consensus.json + data/supply.json), so the
 * pre-filled inputs track the real chain instead of a dated static guess:
 *  - netGH:         consensus.current.est_hashrate_hs (difficulty / 12 s)
 *  - supplyQtc:     supply.total_supply_plancks — total issuance incl.
 *                   genesis, the emission formula's S (NOT mined-only)
 *  - blocksPerDay:  observed pace from consensus.block_times_ms.avg_ms,
 *                   not the 12 s target (the chain currently runs slower)
 * Any field that is missing or implausible comes back null; the caller
 * keeps its dated static fallback for that field and says so. */
/* Snapshot scalar validation: the indexer emits plancks and hashrate as
 * integer strings and heights as integers — accept only that shape.
 * Number() alone accepts fractional ("…2547.5") and scientific ("6.5e18")
 * strings for fields that are never fractional on chain, so a poisoned
 * snapshot could silently rewrite the earnings defaults; a garbage
 * fetched_at was likewise String()-coerced and rendered verbatim into
 * the provenance hint's innerHTML. Invalid fields come back null and
 * the caller keeps its dated static fallback for that field. */
function intField(v) {
  if (typeof v === "string") {
    if (!/^\d+$/.test(v.trim())) return null;
    var n = Number(v.trim());
    return isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  return null;
}
function validHeight(v) {
  var h = intField(v);
  return (h != null && h > 0) ? h : null;
}
function validFetchedAt(v) {
  if (typeof v !== "string" || !v) return null;
  return isFinite(Date.parse(v)) ? v : null;
}
Studio.deriveNetworkDefaults = function (consensus, supply) {
  var out = { netGH: null, supplyQtc: null, blocksPerDay: null, avgBlockMs: null, height: null, fetchedAt: null };
  if (consensus && consensus.current) {
    var hs = intField(consensus.current.est_hashrate_hs);
    if (hs != null && hs > 0) out.netGH = hs / 1e9;
    out.height = validHeight(consensus.current.height);
    if (out.height == null) out.height = validHeight(consensus.head);
    out.fetchedAt = validFetchedAt(consensus.fetched_at);
  }
  if (consensus && consensus.block_times_ms) {
    var avg = Number(consensus.block_times_ms.avg_ms);
    if (isFinite(avg) && avg > 1000 && avg < 120000) {
      out.avgBlockMs = avg;
      out.blocksPerDay = 86400000 / avg;
    }
  }
  if (supply && supply.total_supply_plancks != null) {
    var plancks = intField(supply.total_supply_plancks);
    if (plancks != null) {
      var qtc = plancks / 1e12;
      if (qtc >= Studio.CHAIN.GENESIS_MINT && qtc <= Studio.CHAIN.MAX_SUPPLY) out.supplyQtc = qtc;
      if (!out.fetchedAt) out.fetchedAt = validFetchedAt(supply.fetched_at);
      if (out.height == null) out.height = validHeight(supply.block_height);
    }
  }
  return out;
};
Studio.estimate = function (userMH, netGH, supply, blocksPerDay) {
  if (!isFinite(supply) || supply < 0) return null;
  var reward = Studio.blockReward(supply);
  var bpd = (isFinite(blocksPerDay) && blocksPerDay > 0) ? blocksPerDay : Studio.blocksPerDay();
  if (!(userMH > 0) || !(netGH > 0)) return null;
  var share = userMH / (netGH * 1000);
  return {
    share: share,
    reward: reward,
    qtcPerDay: share * bpd * reward,
    blocksPerDay: share * bpd,
    networkBlocksPerDay: bpd
  };
};
Studio.gradeBenchmark = function (rateMH, deviceMid) {
  if (!(rateMH > 0) || !(deviceMid > 0)) return null;
  var r = rateMH / deviceMid;
  if (r < 0.5)  return { cls: "low",   label: "Well below expected", r: r };
  if (r < 0.9)  return { cls: "good",  label: "Below reference — check build & drivers", r: r };
  if (r <= 1.15) return { cls: "great", label: "On target", r: r };
  return { cls: "great", label: "Above reference — excellent silicon or tuned build", r: r };
};
Studio.formatHash = function (mh) {
  if (mh >= 1000) return (mh / 1000).toFixed(2) + " GH/s";
  if (mh >= 1) return mh.toFixed(mh >= 100 ? 0 : 1) + " MH/s";
  return (mh * 1000).toFixed(0) + " kH/s";
};

/* ---- shell sanitizing (user input -> generated commands) ---- */
Studio.sanitize = function (s, fallback) {
  s = String(s == null ? "" : s).trim().replace(/[^A-Za-z0-9._~\/-]/g, "");
  return s || fallback;
};

/* ---- command builders ---- */
Studio.nodeRunCmd = function (o) {
  var lines = ["./quantus-node --validator \\",
    "  --chain mainnet \\",
    "  --name " + o.name + " \\",
    "  --node-key-file ~/.quantus/node_key.p2p \\",
    "  --rewards-inner-hash <YOUR_PREIMAGE> \\"];
  if (o.external) lines.push("  --miner-listen-port 9833 \\");
  lines.push("  --sync full --max-blocks-per-request 64");
  return lines.join("\n");
};
Studio.minerServeCmd = function (o) {
  var cuda = o.cuda ? " \\\n  --cuda-gpu" : "";
  return "./quantus-miner serve \\\n" +
    "  --node-addr 127.0.0.1:9833 \\\n" +
    "  --auth-token-file " + o.base + "/chains/mainnet/miner-auth-token \\\n" +
    "  --tls-cert-sha256-file " + o.base + "/chains/mainnet/miner-tls-cert-sha256 \\\n" +
    "  --cpu-workers " + o.cpu + " --gpu-devices " + o.gpu + cuda;
};
Studio.buildSteps = function (os, o) {
  var steps = [];
  var bin = os === "windows" ? ".\\quantus-node.exe" : "./quantus-node";
  var mbin = os === "windows" ? ".\\quantus-miner.exe" : "./quantus-miner";

  if (os === "docker") {
    steps.push({ t: "Prepare a data directory", d: "Holds your node data, P2P key, and miner auth token across restarts.",
      cmds: [{ code: "mkdir -p ./quantus_node_data\nchmod 755 ./quantus_node_data" }] });
    steps.push({ t: "Generate your node identity", d: "A unique P2P key so the network recognizes your node.",
      cmds: [{ code: "docker run --rm \\\n  -v \"$(pwd)/quantus_node_data\":/var/lib/quantus_data_in_container \\\n  ghcr.io/quantus-network/quantus-node:latest \\\n  key generate-node-key --file /var/lib/quantus_data_in_container/node_key.p2p" }] });
    steps.push({ t: "Generate your wormhole key", d: "Save the inner_hash — it is your 32-byte mining preimage. Rewards are derived from it.",
      cmds: [{ code: "docker run --rm ghcr.io/quantus-network/quantus-node:latest \\\n  key quantus --scheme wormhole" }],
      warn: "Back up the inner_hash offline and encrypted. Lose it and your rewards are unspendable." });
    steps.push({ t: "Run the node", d: "Starts syncing mainnet, then mines once the tip is fresh. Replace YOUR_PREIMAGE with the inner_hash.",
      cmds: [{ code: "docker run -d --name quantus-node --restart unless-stopped \\\n  -v \"$(pwd)/quantus_node_data\":/var/lib/quantus \\\n  -p 30333:30333 \\\n  ghcr.io/quantus-network/quantus-node:latest \\\n  --validator --base-path /var/lib/quantus \\\n  --chain mainnet --name " + o.name + " \\\n  --node-key-file /var/lib/quantus/node_key.p2p \\\n  --rewards-inner-hash <YOUR_PREIMAGE> \\\n  --sync full --max-blocks-per-request 64" }] });
    steps.push({ t: "Verify", d: "Logs first, then a benchmark, then your wormhole balance.",
      cmds: [{ code: "docker logs -f quantus-node   # look for: Imported #..." }] });
    return steps;
  }

  if (os === "windows") {
    steps.push({ t: "Exclude the data dir from Windows Defender", d: "One-time, elevated PowerShell. Real-time scanning on the RocksDB directory causes silent sync stalls — the #1 Windows failure mode.",
      cmds: [{ code: 'Add-MpPreference -ExclusionPath "$env:USERPROFILE\\.quantus"' }],
      warn: "Run PowerShell as Administrator for this step. Skip it and a full sync will likely never complete on the native build." });
  }

  steps.push({ t: "Download the binaries", d: "Get the latest node and miner for your platform. Node and miner must share the same miner protocol (quantus-miner/2) — update them together.",
    cmds: [{ label: "Download pages (open in your browser)", code: "# node:  https://github.com/Quantus-Network/chain/releases\n# miner: https://github.com/Quantus-Network/quantus-miner/releases" }],
    note: os === "macos" ? "Apple Silicon users: grab the arm64 build; only fall back to x86_64 under Rosetta if no native build is published." : null });
  steps.push({ t: "Generate your node identity", d: "A unique P2P key so the network recognizes your node.",
    cmds: [{ code: bin + " key generate-node-key --file ~/.quantus/node_key.p2p" }] });
  steps.push({ t: "Generate your wormhole key", d: "Prints your wormhole Address and the inner_hash preimage. The node derives your reward address from the preimage — no address to paste anywhere.",
    cmds: [{ code: bin + " key quantus --scheme wormhole" }],
    warn: "Save the inner_hash now — offline, encrypted. It is effectively your mining private key." });
  steps.push({ t: "Run the node", d: "Starts syncing mainnet. Mining begins automatically once the node sees a fresh tip (it refuses to mine on a stale chain). Replace <YOUR_PREIMAGE> with your inner_hash.",
    cmds: [{ code: Studio.nodeRunCmd(o).replace(/\.\/quantus-node/g, bin) }],
    note: o.external ? "The --miner-listen-port 9833 flag turns the node into a QUIC server for your external miner and disables built-in mining. Keep that port off the public internet." : "Built-in mining is CPU-only (~15 MH/s per thread). For real hashrate, enable the external miner option above." });
  if (o.external) {
    steps.push({ t: "Connect the external miner", d: "In a second terminal. The auth token and TLS fingerprint are written by the node on first start under <base-path>/chains/mainnet/.",
      cmds: [{ code: Studio.minerServeCmd(o).replace(/\.\/quantus-miner/g, mbin).replace(/^~\/\.local\/share\/quantus-node/, o.base) }],
      warn: "The miner port (9833/UDP) is a private control channel between YOUR node and YOUR miners. Never expose it to the internet — token auth + TLS pinning are not a substitute for a firewall." });
  }
  steps.push({ t: "Verify", d: "Three checks: sync is progressing, your hardware performs, and the node knows where rewards go.",
    cmds: [
      { label: "1 · sync progress", code: "tail -f " + o.base + "/chains/mainnet/network/quantus-node.log   # look for: Imported #..." },
      { label: "2 · benchmark", code: mbin + " benchmark --cpu-workers " + o.cpu + " --gpu-devices " + o.gpu + " --duration 30" },
      { label: "3 · latest block via local RPC", code: "curl -s -H \"Content-Type: application/json\" \\\n  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"chain_getBlock\",\"params\":[]}' \\\n  http://localhost:9944 | head -c 300" }
    ],
    note: "On startup the node logs “Mining rewards will be sent to wormhole address …” — confirm it matches the Address from step 3." });
  return steps;
};

/* ---- checklist + troubleshooter data ---- */
Studio.SECURITY = [
  { t: "Only port 30333/TCP is publicly reachable", d: "The P2P port is the only service meant for the open internet." },
  { t: "Miner port (9833) is private", d: "Loopback for local miners, or a VPN / private subnet for remote rigs. Never 0.0.0.0 in a firewall rule." },
  { t: "RPC (9944) and Prometheus (9615) stay local", d: "Expose only to hosts that genuinely need them. (Prometheus default is disputed upstream — 9615 vs 9616; confirm with quantus-node --help.)" },
  { t: "Auth token + TLS fingerprint files are locked down", d: "miner-auth-token and miner-tls-cert-sha256 under <base-path>/chains/mainnet/ — readable only by you." },
  { t: "Windows: Defender exclusion added (native build)", d: "Add-MpPreference -ExclusionPath on your data dir, or use WSL2." },
  { t: "inner_hash backed up offline, encrypted", d: "Your 32-byte preimage is your mining private key. Paper or encrypted USB, never a screenshot in the cloud." },
  { t: "Node P2P key backed up", d: "node_key.p2p — losing it just means a new peer identity, but keep a copy anyway." },
  { t: "Binaries from official releases, kept updated", d: "Node and miner must stay on the same miner protocol (quantus-miner/2)." }
];
Studio.FIXES = [
  { q: "Node won't finish syncing (block numbers stall)", a: "<b>Windows native build?</b> Add the Defender exclusion for your data dir, then restart with <code>--sync full --max-blocks-per-request 64</code>. Real-time scanning on RocksDB causes silent stalls: healthy peers, active downloads, zero block progression.<br><b>Any platform:</b> confirm 3+ Mbps sustained — below that, sync will likely fail. Check the log for <code>Imported #…</code>; if it's absent for minutes while peers are connected, it's an IO or bandwidth problem, not a network problem." },
  { q: "Mining isn't producing anything", a: "Check in order: <b>1.</b> <code>--validator</code> is present. <b>2.</b> The preimage is the exact <code>inner_hash</code> from key generation. <b>3.</b> The node is synced — it refuses to mine until its best block is at most 24 h old (the tip-age freshness gate). <b>4.</b> Node and miner share miner protocol <code>quantus-miner/2</code> — update both together." },
  { q: "External miner connects then silently drops", a: "The node enforces a <b>60-second idle timeout</b> and sends no keep-alives. The bundled miner heartbeats every 5 s; third-party miners must send keep-alives every 5–15 s or the node drops them mid-job and the work is lost." },
  { q: "Can't find my rewards", a: "Rewards go to the <b>wormhole address</b>, not the preimage string. Compare the <code>Address</code> from <code>key quantus --scheme wormhole</code> against the “Mining rewards will be sent to wormhole address …” line in the node startup log, then query that address on the Block Explorer. No claim step exists — if the address matches and blocks were mined, the balance is there." },
  { q: "Port already in use", a: "Override with <code>--port 30334 --prometheus-port 9617</code> (and <code>--miner-listen-port</code> for the QUIC server). Remember to keep the miner port private regardless of which port you choose." },
  { q: "Database corruption after a crash", a: "Purge and resync: <code>quantus-node purge-chain --chain mainnet</code>. Your keys live outside the chain DB (node_key.p2p, inner_hash backup), so a purge never touches your rewards." },
  { q: "Connection issues / no peers", a: "Allow <b>30333/TCP outbound</b> in your firewall. Verify general connectivity, then try different bootnodes from the chain spec. Below 3 Mbps, sync will likely fail — upgrade the link before debugging further." }
];

/* export for node tests */
if (typeof module !== "undefined" && module.exports) { module.exports = Studio; return; }

/* ================= DOM ================= */
var $ = function (id) { return document.getElementById(id); };

/* embers background */
(function embers() {
  var cv = $("embers"); if (!cv) return;
  var ctx = cv.getContext("2d"), W, H, ps = [];
  function size() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
  size(); addEventListener("resize", size);
  for (var i = 0; i < 70; i++) ps.push({ x: Math.random(), y: Math.random(), r: Math.random() * 2.2 + .6, s: Math.random() * .0009 + .0003, o: Math.random() * .5 + .15, hue: 18 + Math.random() * 22 });
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (var j = 0; j < ps.length; j++) {
      var p = ps[j]; p.y -= p.s; if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r, 0, 7);
      ctx.fillStyle = "hsla(" + p.hue + ",95%,55%," + p.o + ")"; ctx.fill();
    }
    if (!REDUCE_MOTION) requestAnimationFrame(tick);
  })();
})();

/* copy buttons (static + dynamic) */
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-copy]");
  if (b) {
    var v = b.getAttribute("data-copy");
    if (navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
    var old = b.textContent; b.textContent = "copied ✓";
    setTimeout(function () { b.textContent = old; }, 1200);
    return;
  }
  var c = e.target.closest("button.copy");
  if (c) {
    var pre = c.parentElement.querySelector("pre");
    if (pre && navigator.clipboard) navigator.clipboard.writeText(pre.textContent).catch(function () {});
    c.textContent = "copied ✓"; setTimeout(function () { c.textContent = "copy"; }, 1200);
  }
});

/* version note */
$("verNote").textContent = "Node v1.0.1 · miner v4.1.0 (community mainnet guide, 2026-09-10 — always confirm on the releases pages above; protocol " + Studio.CHAIN.MINER_PROTOCOL + ")";

/* studio nav active state */
(function navSpy() {
  var links = Array.prototype.slice.call(document.querySelectorAll(".sn"));
  var secs = links.map(function (a) { return document.querySelector(a.getAttribute("href")); }).filter(Boolean);
  function onScroll() {
    var y = scrollY + 160, cur = secs[0];
    for (var i = 0; i < secs.length; i++) if (secs[i].offsetTop <= y) cur = secs[i];
    links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + cur.id); });
  }
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
})();

/* ---- setup wizard ---- */
var wizard = { os: "linux" };
function wizardOpts() {
  return {
    name: Studio.sanitize($("kName").value, "my-quantus-node"),
    base: Studio.sanitize($("kBase").value, "~/.local/share/quantus-node"),
    cpu: Math.max(0, Math.min(128, parseInt($("kCpu").value, 10) || 0)),
    gpu: Math.max(0, Math.min(16, parseInt($("kGpu").value, 10) || 0)),
    cuda: $("kCuda").checked,
    external: $("kExt").checked
  };
}
function renderSteps() {
  var o = wizardOpts(), host = $("steps");
  var steps = Studio.buildSteps(wizard.os, o);
  host.innerHTML = steps.map(function (s, i) {
    var blocks = s.cmds.map(function (c) {
      return '<div class="cmd">' +
        (c.label ? '<div class="step-note"><b>' + c.label + "</b></div>" : "") +
        "<pre>" + c.code.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>" +
        '<button class="copy" type="button">copy</button></div>';
    }).join("");
    return '<div class="step"><div class="step-head"><span class="step-n">' + (i + 1) + "</span><h3>" + s.t + "</h3><p>" + s.d + "</p></div>" +
      blocks +
      (s.warn ? '<div class="step-note warn">⚠ ' + s.warn + "</div>" : "") +
      (s.note ? '<div class="step-note">' + s.note + "</div>" : "") + "</div>";
  }).join("");
}
document.querySelectorAll(".os-tab").forEach(function (t) {
  t.addEventListener("click", function () {
    document.querySelectorAll(".os-tab").forEach(function (x) { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
    t.classList.add("active"); t.setAttribute("aria-selected", "true");
    wizard.os = t.getAttribute("data-os");
    renderSteps();
  });
});
["kName", "kBase", "kCpu", "kGpu", "kCuda", "kExt"].forEach(function (id) {
  $(id).addEventListener("input", renderSteps);
  $(id).addEventListener("change", renderSteps);
});
renderSteps();

/* ---- rig builder ---- */
var rig = [];
function rigHash() {
  var mh = 0;
  rig.forEach(function (r) { mh += r.qty * ((r.lo + r.hi) / 2); });
  mh += (parseInt($("cpuThreads").value, 10) || 0) * Studio.CPU_PER_THREAD_MH;
  return mh;
}
function renderRig() {
  var host = $("rigList");
  host.innerHTML = rig.length ? rig.map(function (r, i) {
    return "<li><b>" + r.qty + "×</b> " + r.name +
      " <span style='color:var(--dim)'>≈ " + Studio.formatHash(r.qty * ((r.lo + r.hi) / 2)) + "</span>" +
      '<button class="rm" data-i="' + i + '">remove</button></li>';
  }).join("") : '<li style="border-style:dashed;color:var(--dim)">No GPUs yet — add your cards above.</li>';
  $("rigHash").textContent = Studio.formatHash(rigHash());
  renderEarn();
}
function renderEarn() {
  var net = parseFloat($("netHash").value), sup = parseFloat($("curSupply").value);
  var e = Studio.estimate(rigHash(), net, sup, earnPace);
  if (!e) {
    ["eShare", "eReward", "eDay", "eBlocks"].forEach(function (id) { $(id).textContent = "—"; });
    return;
  }
  $("eShare").textContent = (e.share * 100).toFixed(e.share < 0.0001 ? 5 : 3) + "%";
  $("eReward").textContent = e.reward.toFixed(4) + " QTC";
  $("eDay").textContent = e.qtcPerDay.toFixed(3) + " QTC";
  $("eBlocks").textContent = e.blocksPerDay.toFixed(2);
}
(function initGpuSel() {
  $("gpuSel").innerHTML = Studio.GPUS.map(function (g, i) {
    return '<option value="' + i + '">' + g.name + " — " + Studio.formatHash((g.lo + g.hi) / 2) + " (ref)</option>";
  }).join("");
  $("bDev").innerHTML = Studio.BENCH_DEVICES.map(function (d, i) {
    return '<option value="' + i + '">' + d.name + " — ref " + Studio.formatHash(d.mid) + "</option>";
  }).join("");
  var tb = document.querySelector("#gpuTable tbody");
  tb.innerHTML = Studio.GPUS.map(function (g) {
    var hr = g.lo === g.hi ? Studio.formatHash(g.lo) : Studio.formatHash(g.lo) + " – " + Studio.formatHash(g.hi);
    return "<tr><td><b>" + g.name + "</b></td><td>" + hr + '</td><td class="src">' + g.src + "</td></tr>";
  }).join("");
})();
$("gpuAdd").addEventListener("click", function () {
  var g = Studio.GPUS[parseInt($("gpuSel").value, 10)];
  var q = Math.max(1, Math.min(32, parseInt($("gpuQty").value, 10) || 1));
  var ex = rig.filter(function (r) { return r.name === g.name; })[0];
  if (ex) ex.qty = Math.min(32, ex.qty + q); else rig.push({ name: g.name, lo: g.lo, hi: g.hi, qty: q });
  renderRig();
});
$("rigList").addEventListener("click", function (e) {
  var b = e.target.closest(".rm"); if (!b) return;
  rig.splice(parseInt(b.getAttribute("data-i"), 10), 1); renderRig();
});
/* ---- earnings defaults from the hourly chain snapshots ----
 * Pre-fill netHash / curSupply / block pace from data/consensus.json +
 * data/supply.json (same derivation as pool-desk v1.44.0). Fields the user
 * has already edited are never overwritten; when the snapshots can't be
 * loaded, the dated static defaults in the HTML stand and say so. */
var earnPace = null; // observed blocks/day once snapshots land
var netDirty = false, supDirty = false;
function fmtUtc(iso) {
  if (!iso) return "unknown time";
  var d = new Date(iso);
  return isNaN(d) ? "unknown time" : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}
function loadNetworkDefaults() {
  if (typeof fetch !== "function") return;
  function get(url) {
    return fetch(url, { signal: timeoutSignal(9000) }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function () { return null; });
  }
  Promise.all([get("../../data/consensus.json"), get("../../data/supply.json")]).then(function (arr) {
    var d = Studio.deriveNetworkDefaults(arr[0], arr[1]);
    if (!d || (d.netGH == null && d.supplyQtc == null && d.blocksPerDay == null)) return;
    if (d.netGH != null && !netDirty) {
      $("netHash").value = Math.round(d.netGH);
      $("netHash").placeholder = "snapshot: " + Math.round(d.netGH).toLocaleString("en-US") + " GH/s";
    }
    if (d.supplyQtc != null && !supDirty) $("curSupply").value = Math.round(d.supplyQtc);
    if (d.blocksPerDay != null) earnPace = d.blocksPerDay;
    var hint = $("supplyHint");
    if (hint) {
      hint.innerHTML = "Defaults refreshed from the builder's chain snapshot (fetched " + fmtUtc(d.fetchedAt) +
        (d.height ? ", block " + Number(d.height).toLocaleString("en-US") : "") +
        "): network hashrate from live difficulty, supply = total issuance for the emission formula" +
        (d.avgBlockMs ? ", earnings paced at the observed ~" + (d.avgBlockMs / 1000).toFixed(1) + "s block time — not the 12s target" : "") +
        ". Edit any field and your numbers win. Verify with the <a href=\"../block-explorer/\">Block Explorer</a>.";
    }
    var note = $("earnNote");
    if (note && d.avgBlockMs) {
      note.textContent = "Estimate only: assumes constant difficulty and the observed ~" + (d.avgBlockMs / 1000).toFixed(1) +
        "s block pace from the latest chain snapshot. Real results follow luck and network growth.";
    }
    renderEarn();
  });
}
["cpuThreads", "netHash", "curSupply"].forEach(function (id) { $(id).addEventListener("input", function () { if (id === "netHash") netDirty = true; if (id === "curSupply") supDirty = true; $("rigHash").textContent = Studio.formatHash(rigHash()); renderEarn(); }); });
renderRig();
loadNetworkDefaults();

/* ---- benchmark grader ---- */
$("bGo").addEventListener("click", function () {
  var d = Studio.BENCH_DEVICES[parseInt($("bDev").value, 10)];
  var rate = parseFloat($("bRate").value);
  var g = Studio.gradeBenchmark(rate, d.mid);
  var out = $("bOut");
  if (!g) { out.innerHTML = '<div class="grade"><h3>Enter a hashrate</h3><p>Type the MH/s number your benchmark printed.</p></div>'; return; }
  var tip = g.cls === "low"
    ? "Something is off: wrong engine (wgpu instead of CUDA?), thermal throttling, or an old miner build. Re-run with <code>--cuda-gpu</code> on NVIDIA and compare."
    : g.cls === "good"
    ? "Usable, but there's headroom. Try the CUDA build, update drivers, and check <code>--gpu-throttle-ms</code> isn't set."
    : "You're getting what the card owes you. Lock in those clocks and point it at the network.";
  out.innerHTML = '<div class="grade"><h3>' + d.name + ": " + Studio.formatHash(rate) + "</h3>" +
    '<span class="verdict ' + g.cls + '">' + g.label + "</span>" +
    "<p>Reference for this card: <b>" + Studio.formatHash(d.mid) + "</b> (" + d.src + "). " +
    "Your run sits at <b>" + (g.r * 100).toFixed(0) + "%</b> of reference. " + tip + "</p></div>";
});

/* ---- security checklist ---- */
var SEC_KEY = "qtc-studio-sec-v1";
function renderSec() {
  var done = {};
  try { done = JSON.parse(localStorage.getItem(SEC_KEY) || "{}"); } catch (e) {}
  var n = 0;
  $("secList").innerHTML = Studio.SECURITY.map(function (s, i) {
    var d = !!done[i]; if (d) n++;
    return '<li class="' + (d ? "done" : "") + '" data-i="' + i + '"><input type="checkbox" ' + (d ? "checked" : "") + ' aria-label="' + s.t.replace(/"/g, "") + '"><span class="t"><b>' + s.t + "</b><span>" + s.d + "</span></span></li>";
  }).join("");
  $("secBar").innerHTML = "<i></i>";
  $("secBar").firstChild.style.width = (n / Studio.SECURITY.length * 100) + "%";
  $("secCount").textContent = n + " / " + Studio.SECURITY.length + " hardened";
}
$("secList").addEventListener("click", function (e) {
  var li = e.target.closest("li"); if (!li) return;
  var i = li.getAttribute("data-i"), done = {};
  try { done = JSON.parse(localStorage.getItem(SEC_KEY) || "{}"); } catch (err) {}
  done[i] = !done[i];
  try { localStorage.setItem(SEC_KEY, JSON.stringify(done)); } catch (err) {}
  renderSec();
});
renderSec();

/* ---- troubleshooter ---- */
$("fixList").innerHTML = Studio.FIXES.map(function (f) {
  return '<details class="fix"><summary>' + f.q + '</summary><div class="body">' + f.a + "</div></details>";
}).join("");

})();
