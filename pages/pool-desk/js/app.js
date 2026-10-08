/* QTC Pool Desk — pool data + pure logic.
 * Every pool fact is anchored to a verified source (see SOURCES below).
 * AriaPool facts read verbatim from https://pool.ariabrain.com/qtc.html on 2026-10-01.
 * Quanpool terms from the 0xmoei/quantus community guide (terms as published on
 * quanpool.com at guide-writing time), verified 2026-10-01.
 * Pool-software facts from github.com/mining-pool/not-only-mining-pool
 * (README + docs/PLUGGABLE_ENGINES.md), verified 2026-10-01.
 */
"use strict";

const BLOCK_TIME_S = 12; // protocol target, Quantus-Network/chain runtime/src/lib.rs TARGET_BLOCK_TIME_MS
const BLOCKS_PER_DAY = 86400 / BLOCK_TIME_S; // 7200 — protocol target; comparator uses observed pace when snapshots load
// Emission model per pallets/mining-rewards on_finalize (verified against
// Quantus-Network/chain): R = (MaxSupply - total_issuance) / 50_000_000,
// where total_issuance = Currency::total_issuance() INCLUDES genesis endowments.
const MAX_SUPPLY_QTC = 21000000;
const PLANCK = 1e12;
const EMISSION_DENOM = 50000000;
const NETWORK_DEFAULTS = {
  // Dated static FALLBACKS — replaced at load by deriveNetworkDefaults() from the
  // hourly data/*.json snapshots (initComparator -> loadLiveDefaults). Kept honest
  // and dated for the no-fetch path (file://, offline). All four figures come from
  // ONE capture (2026-10-08 21:21Z): consensus difficulty @189,029 and total
  // issuance @189,029, 11 seconds apart — never mix snapshot dates in one bundle
  // (the Sept-30 bundle survived to Oct 2 at half the real hashrate and skewed
  // every fallback-path earnings figure ~2x; guarded in tests).
  blockRewardQTC: 0.3041789, // emission formula: (21M − 5,791,052.5063 total issuance) / 50M, data/supply.json @189029, 2026-10-08
  blockRewardLabel: "0.3042 QTC · emission formula @ height 189029, 2026-10-08",
  netHashHS: 54569270392611, // difficulty 654831244711333 / 12s, data/consensus.json @189029, 2026-10-08
  netHashLabel: "≈54.57 TH/s · from difficulty 654831244711333 @ height 189029, 2026-10-08",
};

const SOURCES = [
  { label: "AriaPool pool page", url: "https://pool.ariabrain.com/qtc.html", date: "2026-10-01", note: "Fee, PPLNS terms, payout schedule, endpoints, miner builds + SHA-256 checksums, TLS pin, QPoW constants" },
  { label: "0xmoei/quantus community mining guide", url: "https://github.com/0xmoei/quantus", date: "2026-10-01", note: "Quanpool terms table (pool fee, miner dev fee, PPLNS/Solo, min payout, payout interval, confirmations), Start-mining flow, pool-vs-solo-vs-node matrix" },
  { label: "quanpool.com", url: "https://quanpool.com/", date: "2026-10-01", note: "Pool stats + per-address lookup (JS-rendered; terms re-copied from the live Start mining tab)" },
  { label: "not-only-mining-pool", url: "https://github.com/mining-pool/not-only-mining-pool", date: "2026-10-01", note: "Open-source Go pool software: Quantus engine (QUIC + LuckyPool Stratum), PROP/SOLO payouts, CI E2E on a real node" },
  { label: "quantus.com weekly update (mainnet week 1)", url: "https://www.quantus.com/blog/weekly-update-09-16-2026/", date: "2026-09-16", note: "11.2 TH/s avg / 24.4 TH/s peak hashrate, 7,000+ GPUs, 53,000+ blocks, miner v4.2.0" },
];

const POOLS = [
  {
    id: "ariapool",
    name: "AriaPool",
    tagline: "Independent QTC pool with its own full node",
    site: "https://pool.ariabrain.com/qtc.html",
    verified: "2026-10-01",
    independence: "AriaPool states it is independent of the Quantus developers and runs its own full node.",
    poolFee: 0.01,
    scheme: "PPLNS",
    schemeDetail: "Pay Per Last N Shares — window = 2 × the block's difficulty. When the pool finds a block it splits that block across recent shares; stop mining and your shares fall out of the window.",
    minPayoutQTC: 0.11,
    payoutSchedule: "Automatic, twice a day — 06:00 and 18:00 Paris time",
    payoutNotes: ["Balances below the minimum carry over to the next run", "Network fees are paid by the pool", "Rewards are credited once a block is confirmed at the finality depth"],
    signup: "None — your qz… address is the account. Your entry appears under My stats seconds after your first share.",
    miners: [
      {
        id: "official",
        name: "Official quantus-miner (QUIC)",
        devFee: 0,
        devFeeNote: "No dev fee — stock upstream miner, unmodified",
        proto: "quic",
        endpoint: "qtc-node.ariabrain.com:9834",
        tlsPin: "870d67d848c69661a5e86aeea37b63332af3b7d642855e4aa5f19156d1cab889",
        tlsPinNote: "Copied from the pool page 2026-10-01 — re-verify on the pool's own site before connecting",
      },
      {
        id: "ariaminer",
        name: "AriaMiner-QTC v2.1.1 (RTX 30/40/50)",
        devFee: 0.01,
        devFeeNote: "1% of mining time, separate from the 1% pool fee",
        proto: "getwork",
        endpoint: "http://qtc-node.ariabrain.com:9412/",
        download: "https://pub-4bc92882522745e291a08f11119e3205.r2.dev/qtc-dl/6hwvzd49dvt/ariaminer-qtc-v2.1.1-linux-x86_64.tar.gz",
        sha256linux: "416617e73d8aa2f67ec3813d27b79b479d799af0844071d06a690fbee696dedb",
        sha256hiveos: "3e74c905f8cc2b6905b125be925782539268a1a27427291a20b14a0225190bc1",
        notes: ["Self-checks its own hashing on your card at every start and refuses to mine if anything differs", "Faster on RTX 50; RTX 30/40 unchanged vs prior build", "Vast.ai rental: public CUDA image + on-start script, see the pool page's Rent a GPU section"],
      },
      {
        id: "ariadtc",
        name: "aria_dtc v1.0.0 (datacenter: A100 / H100 / H200 / B200)",
        devFee: 0.01,
        devFeeNote: "1% of mining time, separate from the 1% pool fee",
        proto: "getwork",
        endpoint: "http://qtc-node.ariabrain.com:9412/",
        download: "https://pub-4bc92882522745e291a08f11119e3205.r2.dev/qtc-dl/6hwvzd49dvt/aria_dtc-v1.0.0-linux-x86_64.tar.gz",
        sha256linux: "8ae7359ab34ba86c62992c8194d3abfd544c85a5d0cebe739a5a7a1f31b03553",
        sha256hiveos: "e12c1cfd6ef0a2e30c4de959bfbc466d32c0bae8d9db91f9fd604bedbf18ebaa",
        notes: ["Separate build of the same miner for datacenter cards; 4096-vector oracle check on every card", "Driver 580 or newer required"],
      },
      {
        id: "ariacpu",
        name: "AriaMiner-QTC CPU v1.1.2 (AMD Zen 3/4/5, Intel)",
        devFee: 0.03,
        devFeeNote: "3% on this older build — use only if you have no GPU",
        proto: "getwork",
        endpoint: "http://qtc-node.ariabrain.com:9412/",
        download: "https://pub-4bc92882522745e291a08f11119e3205.r2.dev/qtc-dl/6hwvzd49dvt/ariaminer-qtc-cpu-v1.1.2-linux-x86_64.tar.gz",
        sha256linux: "eda2d60e59d27d7619a1f443494e682be7878a70d1d2af33bef8271d7872ad75",
        sha256hiveos: "1f630b22125efdde11b4556312a9187b48c9ad34963effc85a924696781bf1b9",
        notes: ["CLI shape differs: ./ariaminer-qtc-cpu mine --pool … --address … --worker …"],
      },
    ],
  },
  {
    id: "quanpool",
    name: "Quanpool",
    tagline: "Community pool — PPLNS or Solo",
    site: "https://quanpool.com/",
    verified: "2026-10-01",
    independence: "Community-run pool (see the 0xmoei/quantus guide). Terms below were taken from quanpool.com via that guide — re-copy the live Start mining command from the site; do not invent server or TLS pin.",
    poolFee: 0.01,
    scheme: "PPLNS or Solo",
    schemeDetail: "PPLNS: when the pool finds a block it splits that block across recent shares. Solo: your shares hunt the block; if you find it you keep the block minus fees — lottery, still on the pool's node.",
    minPayoutQTC: 0.25,
    payoutSchedule: "Hourly (check the Start mining tab)",
    payoutNotes: ["Confirmations: 105 blocks", "Address lookup on the site is your reward dashboard: Pending / Paid / My workers / Next payout"],
    signup: "None — your qz… address is the account. Nothing to sign up for.",
    miners: [
      {
        id: "quanpoolminer",
        name: "quanpool-miner 6.0.0",
        devFee: 0.05,
        devFeeNote: "5% miner fee taken before the pool → 6% total with the 1% pool fee",
        proto: "quic",
        endpoint: "re-copy from the live Start mining tab (example seen: 37.187.143.115:9834)",
        endpointIsExample: true,
        tlsPin: "PASTE_FROM_SITE",
        tlsPinNote: "Copied live from quanpool.com's Start mining tab after entering your address — never reuse a stale pin",
        download: "https://download.quanpool.com/quanpool-miner-6.0.0-linux-x86_64",
        notes: ["Pool claims ~6.3× stock hashrate on an RTX 4090 in their test — that is their measurement", "HiveOS: github.com/Enotny/quanpool-hiveos", "Worker name rules: a-z 0-9 . - _ , max 32 chars", "One GPU = one worker; do not run the miner twice on one card"],
      },
    ],
    extras: [
      { label: "Discord", url: "https://discord.gg/vPkuc8eu42" },
      { label: "Public API (GPU benchmarks)", url: "https://quanpool.com/", note: "Exposes GPU benchmarks used by third-party calculators" },
    ],
  },
];

/* ---------------- pure math ---------------- */

function clamp01(x) { return Math.min(1, Math.max(0, x)); }

/** Stacked fee: pool fee then miner dev fee, both as fractions. */
function effectiveFee(poolFee, devFee) {
  return 1 - (1 - clamp01(poolFee)) * (1 - clamp01(devFee));
}

/** Expected gross QTC/day before any fee. Hashes in H/s.
 * blocksPerDay defaults to the 7200 protocol target; pass the observed network
 * pace (from snapshot block_times_ms) for honest expectation math. */
function grossPerDay(userHashHS, netHashHS, blockRewardQTC, blocksPerDay) {
  if (!(userHashHS > 0) || !(netHashHS > 0) || !(blockRewardQTC > 0)) return 0;
  const bpd = blocksPerDay > 0 ? blocksPerDay : BLOCKS_PER_DAY;
  return (userHashHS / netHashHS) * bpd * blockRewardQTC;
}

function netPerDay(userHashHS, netHashHS, blockRewardQTC, poolFee, devFee, blocksPerDay) {
  return grossPerDay(userHashHS, netHashHS, blockRewardQTC, blocksPerDay) * (1 - effectiveFee(poolFee, devFee));
}

/** Solo-lottery stats: expected days to find a block at current difficulty. */
function soloStats(userHashHS, netHashHS, blocksPerDay) {
  if (!(userHashHS > 0) || !(netHashHS > 0)) return { daysPerBlock: Infinity, blocksPerDay: 0 };
  const bpd = blocksPerDay > 0 ? blocksPerDay : BLOCKS_PER_DAY;
  const pace = (userHashHS / netHashHS) * bpd;
  return { daysPerBlock: pace > 0 ? 1 / pace : Infinity, blocksPerDay: pace };
}

/** PPLNS window explainer: window = 2 × difficulty → approx blocks covered. */
function pplnsWindowBlocks(difficulty) {
  // window is 2× difficulty in "share-difficulty" units; in block terms it is
  // roughly 2 blocks' worth of network work at the current difficulty.
  return { windowMultiple: 2, approxBlocks: 2 };
}

function toHS(value, unit) {
  const mult = { "MH/s": 1e6, "GH/s": 1e9, "TH/s": 1e12 }[unit] || 1e12;
  return value * mult;
}

function fmtQTC(x, digits) {
  if (!isFinite(x)) return "—";
  const d = digits === undefined ? 4 : digits;
  return x.toFixed(d).replace(/\.?0+$/, "") || "0";
}

function fmtDays(d) {
  if (!isFinite(d)) return "—";
  if (d < 1) return (d * 24).toFixed(1) + " h";
  if (d < 60) return d.toFixed(1) + " days";
  return Math.round(d).toLocaleString("en-US") + " days";
}

/* ---------------- live snapshot derivation ---------------- */

/** Current block reward from the emission formula. Pass total supply in plancks
 * (data/supply.json total_supply_plancks), NOT mined rewards alone — mined-only
 * input overstates the reward by ~37% at current supply. Exact to the planck. */
function blockRewardQtc(totalSupplyPlancks) {
  return (MAX_SUPPLY_QTC - Number(totalSupplyPlancks) / PLANCK) / EMISSION_DENOM;
}

/** Total supply in plancks from a supply snapshot: the first-class
 * total_supply_plancks field when present, else the balances aggregate
 * (free + reserved + frozen) = Currency::total_issuance(). Null when neither. */
function totalSupplyOf(sup) {
  if (!sup) return null;
  if (sup.total_supply_plancks) return String(sup.total_supply_plancks);
  var b = sup.balances_plancks;
  if (b && b.free != null && b.reserved != null && b.frozen != null) {
    return (BigInt(b.free) + BigInt(b.reserved) + BigInt(b.frozen)).toString();
  }
  return null;
}

/** Observed blocks/day from a snapshot's average block time in ms.
 * Falls back to the 7200 protocol target when the snapshot has no sample. */
function paceBlocksPerDay(avgMs) {
  if (avgMs > 0 && isFinite(avgMs)) return 86400000 / avgMs;
  return BLOCKS_PER_DAY;
}

/** "2026-10-02 06:00 UTC" from an ISO timestamp. */
function formatUtc(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown time";
  function p(n) { return String(n).padStart(2, "0"); }
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " UTC";
}

/** Derive the comparator's network defaults from hourly chain snapshots.
 * Layered fallbacks keep the page honest when a snapshot field is missing:
 * reward falls back to the average of recent mainnet block rewards, then to the
 * dated static default; hashrate falls back to the dated static default;
 * pace falls back to the 7200 protocol target. Returns null when no snapshot
 * object is usable at all (caller keeps the static defaults). */
function deriveNetworkDefaults(snap) {
  if (!snap || typeof snap !== "object") return null;
  var live = snap.live, consensus = snap.consensus, supply = snap.supply;
  if (!live && !consensus && !supply) return null;

  var out = { snapshotTime: null, rewardLabel: null, netHashLabel: null, paceLabel: null };

  // --- block reward: emission formula first (exact to the planck)
  var supplyPlancks = totalSupplyOf(supply);
  if (supplyPlancks) {
    out.rewardQtc = blockRewardQtc(supplyPlancks);
    var when = (supply && supply.fetched_at) || (live && live.fetched_at) || null;
    out.snapshotTime = when;
    out.rewardLabel = out.rewardQtc.toFixed(4) + " QTC · emission formula, snapshot " + formatUtc(when);
  } else {
    // fallback: average of recent mainnet block rewards (planck-exact ints)
    var rewards = [];
    try {
      (live.data.blocks || []).forEach(function (b) {
        if (b && b.reward != null) rewards.push(Number(b.reward) / PLANCK);
      });
    } catch (e) { /* keep empty */ }
    if (rewards.length) {
      out.rewardQtc = rewards.reduce(function (a, b) { return a + b; }, 0) / rewards.length;
      out.snapshotTime = live.fetched_at || null;
      out.rewardLabel = out.rewardQtc.toFixed(4) + " QTC · avg of last " + rewards.length +
        " mainnet blocks, snapshot " + formatUtc(out.snapshotTime);
    } else {
      out.rewardQtc = NETWORK_DEFAULTS.blockRewardQTC;
      out.rewardLabel = NETWORK_DEFAULTS.blockRewardLabel;
    }
  }

  // --- network hashrate: recomputed difficulty / 12s target
  var estHs = consensus && consensus.current && consensus.current.est_hashrate_hs;
  if (estHs != null && Number(estHs) > 0) {
    out.netHashHs = Number(estHs);
    var cwhen = consensus.fetched_at || out.snapshotTime;
    out.netHashLabel = "≈" + (out.netHashHs / 1e12).toFixed(2) +
      " TH/s · difficulty ÷ 12 s target, snapshot " + formatUtc(cwhen);
    if (!out.snapshotTime) out.snapshotTime = consensus.fetched_at || null;
  } else {
    out.netHashHs = NETWORK_DEFAULTS.netHashHS;
    out.netHashLabel = NETWORK_DEFAULTS.netHashLabel;
  }

  // --- daily pace: observed block times beat the 12s target on honesty
  var avgMs = consensus && consensus.block_times_ms && consensus.block_times_ms.avg_ms;
  var sample = consensus && consensus.block_times_ms && consensus.block_times_ms.sample;
  out.blocksPerDay = paceBlocksPerDay(Number(avgMs));
  out.paceLabel = "≈" + Math.round(out.blocksPerDay).toLocaleString("en-US") +
    " blocks/day · " + (avgMs > 0
      ? "observed pace, last " + (sample || "—") + " blocks (target 7,200)"
      : "protocol target");

  return out;
}

/* ---------------- validation ---------------- */

function validateAddress(addr) {
  const a = String(addr || "").trim();
  if (!a) return { ok: false, msg: "Enter your Quantus payout address." };
  if (!a.startsWith("qz")) return { ok: false, msg: "Quantus mainnet addresses start with “qz” (SS58 prefix 189)." };
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return { ok: false, msg: "Address contains characters outside Base58 — check for typos." };
  if (a.length < 40 || a.length > 52) return { ok: false, msg: "Unusual length for a qz… address (" + a.length + " chars) — double-check it.", soft: true };
  return { ok: true, msg: "Looks like a qz… address." };
}

function validateWorker(w) {
  const s = String(w || "").trim();
  if (!s) return { ok: true, msg: "Worker is optional — omit it or append .name to your address." };
  if (!/^[a-z0-9.\-_]{1,32}$/.test(s)) return { ok: false, msg: "Worker: a-z 0-9 . - _ only, max 32 chars (Quanpool's rule — safe everywhere)." };
  return { ok: true, msg: "Worker name OK." };
}

/* ---------------- command builder ---------------- */

function authToken(address, worker) {
  const w = String(worker || "").trim();
  return w ? address.trim() + "." + w : address.trim();
}

function buildCommand(poolId, minerId, address, worker) {
  const pool = POOLS.find((p) => p.id === poolId);
  if (!pool) return { ok: false, msg: "Unknown pool." };
  const miner = pool.miners.find((m) => m.id === minerId);
  if (!miner) return { ok: false, msg: "Unknown miner for this pool." };
  const addr = String(address || "").trim();
  const token = authToken(addr, worker);
  const warn = [];

  if (poolId === "ariapool" && minerId === "official") {
    warn.push("Re-verify the TLS pin on pool.ariabrain.com/qtc.html — pins rotate; a stale pin fails permanently.");
    return {
      ok: true, warn,
      title: "AriaPool via official quantus-miner (QUIC/UDP)",
      cmd: "quantus-miner serve \\\n  --node-addr qtc-node.ariabrain.com:9834 \\\n  --auth-token " + token + " \\\n  --tls-cert-sha256 870d67d848c69661a5e86aeea37b63332af3b7d642855e4aa5f19156d1cab889 \\\n  --cpu-workers 8 --gpu-devices 1",
    };
  }
  if (poolId === "ariapool" && miner.proto === "getwork") {
    const bin = minerId === "ariacpu" ? "ariaminer-qtc-cpu" : minerId === "ariadtc" ? "aria_dtc" : "ariaminer-qtc";
    const dir = minerId === "ariacpu" ? "ariaminer-qtc-cpu" : minerId === "ariadtc" ? "aria_dtc" : "ariaminer-qtc";
    const mineWord = minerId === "ariacpu" ? " mine" : "";
    const tarball = miner.download.split("/").pop();
    warn.push("Verify the SHA-256 before running — the pool publishes one per build; the values below were copied 2026-10-01.");
    return {
      ok: true, warn,
      title: "AriaPool via " + miner.name + " (getwork)",
      cmd:
        "wget " + miner.download + "\n" +
        "sha256sum " + tarball + "   # must match " + miner.sha256linux + "\n" +
        "tar xzf " + tarball + " && cd " + dir + "\n" +
        "./" + bin + mineWord + " \\\n" +
        "  --pool http://qtc-node.ariabrain.com:9412/ \\\n" +
        "  --address " + addr + " \\\n" +
        "  --worker " + (String(worker || "rig1").trim() || "rig1"),
    };
  }
  if (poolId === "quanpool") {
    warn.push("Server and TLS pin MUST come from quanpool.com's live Start mining tab — re-copy them; do not reuse the example.");
    warn.push("Pool claims ~6.3× stock hashrate on RTX 4090 in their test — that is their measurement, not ours.");
    return {
      ok: true, warn,
      title: "Quanpool via quanpool-miner (Start mining command shape)",
      cmd:
        "./quanpool-miner-6.0.0 serve \\\n" +
        "  --node-addr PASTE_SERVER_FROM_SITE \\\n" +
        "  --auth-token " + token + " \\\n" +
        "  --tls-cert-sha256 PASTE_FROM_SITE",
    };
  }
  return { ok: false, msg: "No command template for this combination yet." };
}

/* ---------------- pool lookup helpers ---------------- */

function poolById(id) { return POOLS.find((p) => p.id === id); }
function minerOptions(poolId) {
  const p = poolById(poolId);
  return p ? p.miners : [];
}

/* ---------------- DOM wiring (browser only) ---------------- */
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

function init() {
  renderPools();
  initComparator();
  initCommandBuilder();
  initMatrix();
  initCopyButtons();
  initNav();
}

function $(id) { return document.getElementById(id); }

function renderPools() {
  const host = $("poolCards");
  if (!host) return;
  host.innerHTML = POOLS.map((p, i) => {
    const miners = p.miners.map((m) => {
      const feePct = (effectiveFee(p.poolFee, m.devFee) * 100);
      return '<li><strong>' + esc(m.name) + '</strong>' +
        '<span class="fee">effective fee ' + feePct.toFixed(2).replace(/\.?0+$/, "") + '%</span>' +
        '<span class="devnote">' + esc(m.devFeeNote) + "</span>" +
        (m.endpoint ? '<code class="ep">' + esc(m.endpoint) + "</code>" : "") +
        (m.notes ? '<ul class="mnotes">' + m.notes.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>" : "") +
        "</li>";
    }).join("");
    const payouts = p.payoutNotes.map((n) => "<li>" + esc(n) + "</li>").join("");
    const extras = (p.extras || []).map((e) => '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.label) + "</a>" + (e.note ? ' <span class="xnote">' + esc(e.note) + "</span>" : "")).join("<br>");
    return '<article class="pool-card p' + i + '">' +
      '<div class="pc-head"><h3>' + esc(p.name) + '</h3><span class="verified">verified ' + esc(p.verified) + "</span></div>" +
      '<p class="tagline">' + esc(p.tagline) + "</p>" +
      '<dl class="facts">' +
      fact("Pool fee", (p.poolFee * 100).toFixed(0) + "%") +
      fact("Scheme", esc(p.scheme)) +
      fact("Min payout", p.minPayoutQTC + " QTC") +
      fact("Payouts", esc(p.payoutSchedule)) +
      fact("Signup", esc(p.signup)) +
      "</dl>" +
      '<p class="scheme">' + esc(p.schemeDetail) + "</p>" +
      "<ul class='payouts'>" + payouts + "</ul>" +
      '<h4>Miner software</h4><ul class="miners">' + miners + "</ul>" +
      (extras ? '<h4>Links</h4><p class="extras">' + extras + "</p>" : "") +
      '<p class="indep">' + esc(p.independence) + "</p>" +
      '<a class="pool-link" href="' + esc(p.site) + '" target="_blank" rel="noopener">Open ' + esc(p.name) + " &rarr;</a>" +
      "</article>";
  }).join("");
}

function fact(k, v) { return "<div><dt>" + k + "</dt><dd>" + v + "</dd></div>"; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function initComparator() {
  const els = { hash: $("c-hash"), unit: $("c-unit"), net: $("c-net"), reward: $("c-reward"), out: $("c-out") };
  if (!els.hash) return;
  // Live-derived defaults (updated async below); static fallbacks are honest and dated.
  const pace = {
    value: BLOCKS_PER_DAY,
    label: "≈7,200 blocks/day · protocol target",
  };
  els.net.value = (NETWORK_DEFAULTS.netHashHS / 1e12).toFixed(2);
  els.reward.value = NETWORK_DEFAULTS.blockRewardQTC;
  // A late live-defaults load must never overwrite a field the user has
  // already typed in (same clobber class as Node Desk's netHeadEdited fix):
  // the snapshots can take seconds to arrive, and the fields invite editing
  // the whole time. The landed values still update NETWORK_DEFAULTS/pace
  // and the provenance fine print — only the input writes are gated.
  const userEdited = { net: false, reward: false };
  els.net.addEventListener("input", () => { userEdited.net = true; });
  els.reward.addEventListener("input", () => { userEdited.reward = true; });
  const recalc = () => {
    const uh = toHS(parseFloat(els.hash.value) || 0, els.unit.value);
    const nh = toHS(parseFloat(els.net.value) || 0, "TH/s");
    const rw = parseFloat(els.reward.value) || 0;
    const gross = grossPerDay(uh, nh, rw, pace.value);
    let rows = "";
    POOLS.forEach((p) => {
      p.miners.forEach((m) => {
        const fee = effectiveFee(p.poolFee, m.devFee);
        const net = gross * (1 - fee);
        rows += "<tr><td>" + esc(p.name) + "<br><span class='mname'>" + esc(m.name) + "</span></td>" +
          "<td class='num'>" + (fee * 100).toFixed(2).replace(/\.?0+$/, "") + "%</td>" +
          "<td class='num'>" + fmtQTC(gross) + "</td>" +
          "<td class='num'>" + fmtQTC(net) + "</td>" +
          "<td class='num'>" + fmtQTC(net * 30, 2) + "</td></tr>";
      });
    });
    const solo = soloStats(uh, nh, pace.value);
    const soloGross = gross;
    let sens = "";
    [1, 1.5, 2].forEach((k) => {
      const g = grossPerDay(uh, nh * k, rw, pace.value);
      sens += "<tr><td class='num'>" + k + "×</td><td class='num'>" + fmtQTC(g) + "</td><td class='num'>" + fmtQTC(g * 0.99) + "</td></tr>";
    });
    els.out.innerHTML =
      '<table class="cmp"><thead><tr><th>Pool / miner</th><th>Effective fee</th><th>Gross / day</th><th>Net / day</th><th>Net / 30 d</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table>" +
      '<div class="solo-line">Solo on your own node: expected <strong>' + fmtQTC(soloGross) + ' QTC/day</strong> at 0% fee — but as a lottery: about <strong>' + fmtDays(solo.daysPerBlock) + "</strong> per block at this hashrate. " +
      "A pool smooths that variance into daily payouts; the fee is the price of smoothing.</div>" +
      '<h4>Network-hashrate sensitivity (best effective-fee option, 1% pool fee)</h4>' +
      '<table class="cmp small"><thead><tr><th>Network hashrate</th><th>Gross / day</th><th>Net / day</th></tr></thead><tbody>' + sens + "</tbody></table>" +
      '<p class="fine">Expectation, not a guarantee — pools say the same on their own pages. ' + esc(pace.label) + " Defaults: block reward " + esc(NETWORK_DEFAULTS.blockRewardLabel) + "; network hashrate " + esc(NETWORK_DEFAULTS.netHashLabel) + ". QPoW has no ASICs: your share is hashrate ÷ network hashrate.</p>";
  };
  ["hash", "unit", "net", "reward"].forEach((k) => els[k].addEventListener("input", recalc));
  recalc();
  // Refresh the network defaults from the hourly chain snapshots (<=1h old),
  // replacing the dated static fallbacks. Inputs stay user-editable.
  loadLiveDefaults().then((d) => {
    if (!d) return;
    NETWORK_DEFAULTS.blockRewardQTC = d.rewardQtc;
    NETWORK_DEFAULTS.blockRewardLabel = d.rewardLabel;
    NETWORK_DEFAULTS.netHashHS = d.netHashHs;
    NETWORK_DEFAULTS.netHashLabel = d.netHashLabel;
    pace.value = d.blocksPerDay;
    pace.label = d.paceLabel;
    if (!(userEdited.net && els.net.value.trim() !== "")) els.net.value = (d.netHashHs / 1e12).toFixed(2);
    if (!(userEdited.reward && els.reward.value.trim() !== "")) els.reward.value = d.rewardQtc.toFixed(4);
    recalc();
  }).catch(() => { /* static defaults stand; labels already say so */ });
}

/* Fetch the hourly chain snapshots and derive live network defaults.
 * QA hook: qa-pooldesk-livedefaults.mjs injects real snapshot payloads via
 * window.__qtcpooldesk_mock because file:// fetch is blocked headless. */
/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}
function loadLiveDefaults() {
  function get(url) {
    var mock = typeof window !== "undefined" ? window.__qtcpooldesk_mock : null;
    if (mock) {
      for (var k in mock) {
        if (url.indexOf(k) >= 0) return Promise.resolve(mock[k]);
      }
    }
    return fetch(url, { cache: "no-store", signal: timeoutSignal(9000) }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  return Promise.all([
    get("../../data/live.json").catch(function () { return null; }),
    get("../../data/consensus.json").catch(function () { return null; }),
    get("../../data/supply.json").catch(function () { return null; }),
  ]).then(function (parts) {
    return deriveNetworkDefaults({ live: parts[0], consensus: parts[1], supply: parts[2] });
  });
}

function initCommandBuilder() {
  const poolSel = $("b-pool"), minerSel = $("b-miner"), addr = $("b-addr"), worker = $("b-worker"),
    out = $("b-out"), warn = $("b-warn"), go = $("b-go");
  if (!poolSel) return;
  const refreshMiners = () => {
    minerSel.innerHTML = minerOptions(poolSel.value).map((m) => '<option value="' + esc(m.id) + '">' + esc(m.name) + "</option>").join("");
    render();
  };
  const render = () => {
    const va = validateAddress(addr.value), vw = validateWorker(worker.value);
    warn.innerHTML = "";
    if (addr.value && !va.ok) warn.innerHTML += '<p class="w ' + (va.soft ? "soft" : "hard") + '">' + esc(va.msg) + "</p>";
    if (worker.value && !vw.ok) warn.innerHTML += '<p class="w hard">' + esc(vw.msg) + "</p>";
    if (!addr.value.trim()) { out.textContent = "Enter your qz… payout address to generate the command."; return; }
    const r = buildCommand(poolSel.value, minerSel.value, addr.value, worker.value);
    if (!r.ok) { out.textContent = r.msg; return; }
    out.textContent = "# " + r.title + "\n" + r.cmd;
    warn.innerHTML += r.warn.map((w) => '<p class="w soft">' + esc(w) + "</p>").join("");
  };
  poolSel.innerHTML = POOLS.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>").join("");
  poolSel.addEventListener("change", refreshMiners);
  minerSel.addEventListener("change", render);
  [addr, worker].forEach((el) => el.addEventListener("input", render));
  go.addEventListener("click", () => {
    const t = out.textContent;
    if (navigator.clipboard && t && !t.startsWith("Enter your")) navigator.clipboard.writeText(t);
  });
  refreshMiners();
}

function initMatrix() {
  const host = $("matrix");
  if (!host) return;
  const rows = [
    { k: "Who finds the block", a: "The pool", b: "The pool", c: "Your shares", d: "Your node" },
    { k: "Who gets paid", a: "Everyone in the last N-share window", b: "Everyone in the last N-share window", c: "You keep the block minus fees", d: "You keep the full block" },
    { k: "Fee", a: "1% pool + miner dev fee (1–3%)", b: "1% pool + 5% miner fee", c: "Same as PPLNS", d: "0%" },
    { k: "Payout feel", a: "Smaller, more often (2×/day)", b: "Smaller, more often (hourly)", c: "Lottery", d: "Lottery, no pool cut" },
    { k: "You run a synced node", a: "No", b: "No", c: "No", d: "Yes — you must stay synced" },
    { k: "Trust", a: "Pool operator", b: "Pool operator", c: "Pool operator", d: "Your keys, your node" },
    { k: "Min payout", a: "0.11 QTC", b: "0.25 QTC", c: "0.25 QTC", d: "No minimum — it lands on your wormhole address" },
  ];
  host.innerHTML = '<table class="matrix"><thead><tr><th></th><th>AriaPool PPLNS</th><th>Quanpool PPLNS</th><th>Quanpool Solo</th><th>Own node</th></tr></thead><tbody>' +
    rows.map((r) => "<tr><th>" + esc(r.k) + "</th><td>" + esc(r.a) + "</td><td>" + esc(r.b) + "</td><td>" + esc(r.c) + "</td><td>" + esc(r.d) + "</td></tr>").join("") +
    "</tbody></table>" +
    '<p class="fine">Matrix adapted from the pool-vs-solo-vs-node comparison in the 0xmoei/quantus community guide. Pool solo still uses the pool\u2019s node — if you find the block you keep it minus fees; if not, that height pays nothing. Pick PPLNS on a single GPU; never run a pool miner and your own node on the same GPU.</p>';
}

function initCopyButtons() {
  document.querySelectorAll(".addr[data-copy]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(b.dataset.copy).then(() => {
        const t = b.textContent; b.textContent = "Copied!";
        setTimeout(() => { b.textContent = t; }, 1200);
      });
    });
  });
}

function initNav() {
  const nav = document.querySelector("header.nav");
  if (!nav) return;
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });
}

/* node test hook */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    BLOCK_TIME_S, BLOCKS_PER_DAY, NETWORK_DEFAULTS, POOLS, SOURCES,
    effectiveFee, grossPerDay, netPerDay, soloStats, pplnsWindowBlocks,
    toHS, fmtQTC, fmtDays, validateAddress, validateWorker, authToken, buildCommand,
    poolById, minerOptions,
    blockRewardQtc, totalSupplyOf, paceBlocksPerDay, deriveNetworkDefaults, formatUtc,
  };
}
