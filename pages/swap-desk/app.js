/* QTC Swap Desk — NEAR Intents 1Click listing watch + swap mechanics.
 * Mechanics sourced from Quantus-Network/quantus-apps mobile-app/docs/near-intents-swaps.md
 * (verified against the live API 2026-09-20; fee probes 2026-09-26) and PR #675
 * (swap in both directions, merged 2026-09-28).
 * Listing status is probed LIVE from https://1click.chaindefuser.com/v0/tokens
 * (CORS-open, no key). Nothing here is a quote: solver quotes only exist post-listing.
 */
"use strict";

var ONECLICK_TOKENS_URL = "https://1click.chaindefuser.com/v0/tokens";
var QTC_ASSET_ID = "nep141:qtc.omft.near"; // placeholder in the wallet until listing
var PROBE_TIMEOUT_MS = 12000;
var AUTO_REFRESH_MS = 5 * 60 * 1000;
var LS_KEY = "qtc-swapdesk-last-probe";

/* ---- Pure logic (unit-tested) ---- */

/* Scan a 1Click token list for QTC. Returns { listed, asset, total }. */
function scanTokensForQTC(tokens) {
  var list = Array.isArray(tokens) ? tokens : (tokens && tokens.tokens) || [];
  var hit = null;
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var id = String(t.assetId || t.asset_id || "");
    var chain = String(t.blockchain || t.chain || "").toLowerCase();
    var sym = String(t.symbol || "").toUpperCase();
    if (id === QTC_ASSET_ID || chain === "quantus" || (sym === "QTC" && chain.indexOf("quantus") !== -1)) {
      hit = t; break;
    }
  }
  return { listed: !!hit, asset: hit, total: list.length };
}

/* Platform fee in basis points, per the wallet docs:
 * documented 25 bps; observed 20 bps in the 2026-09-26 live probes;
 * 20 bps with a partner key; 1 bp on stablecoin/same-asset routes. */
function platformFeeBps(mode) {
  if (mode === "documented") return 25;
  if (mode === "partner") return 20;
  if (mode === "stable") return 1;
  return 20; // "observed" default
}

/* Illustrative fee math on a hypothetical solver offer. Fee lives inside amountOut. */
function illustrativeQuote(offer, feeBps, slippagePct) {
  offer = Math.max(0, Number(offer) || 0);
  var fee = offer * feeBps / 10000;
  var net = offer - fee;
  var minOut = net * (1 - Math.max(0, Number(slippagePct) || 0) / 100);
  return { offer: offer, feeBps: feeBps, fee: fee, net: net, minOut: minOut, slippagePct: slippagePct };
}

/* Deposit deadline wording per the docs. */
function deadlineFor(blockchain) {
  var slow = ["btc", "ltc", "doge", "bch", "dash", "zec"];
  var b = String(blockchain || "").toLowerCase();
  for (var i = 0; i < slow.length; i++) if (b === slow[i]) return "2 hours";
  return "~20 minutes";
}

var STATUS_INFO = {
  PENDING_DEPOSIT: { who: "You (swap in) / wallet (swap out)", what: "Live quote issued; waiting for the deposit to arrive at the deposit address before the deadline." },
  KNOWN_DEPOSIT_TX: { who: "1Click", what: "Deposit transaction seen on the origin chain; waiting for enough confirmations (seconds on SOL, minutes on ETH, up to an hour on BTC)." },
  INCOMPLETE_DEPOSIT: { who: "1Click, then you", what: "Less than the quoted amount arrived. After the deadline the shortfall is refunded to your refund address minus the refund fee." },
  PROCESSING: { who: "Solvers + NEAR", what: "Deposit confirmed. 1Click publishes the intent, solvers compete to fill it, settlement happens in the Intents Verifier contract on NEAR." },
  SUCCESS: { who: "1Click", what: "Filled and paid out. Destination-chain tx hashes are attached to the order — verify the payout landed in your recipient wallet." },
  REFUNDED: { who: "1Click", what: "No solver could fill, the price moved past your slippage, or the deadline passed — funds go back to your refund address." },
  FAILED: { who: "1Click", what: "Something errored mid-flight. Check the order status detail; the refund path is the same as REFUNDED." },
  EXPIRED: { who: "The wallet UI", what: "Not a 1Click status — the app's own view when the deadline has passed with no deposit. It keeps polling in case a late deposit turns into a refund." }
};
function statusInfo(s) { return STATUS_INFO[s] || null; }

var STEPS = {
  out: [
    ["Pick direction & amount", "In the wallet's swap screen you choose QTC → a token on another chain, the amount, and the recipient address on the destination chain. Your QTC account doubles as the refund address."],
    ["Review the dry quote", "The wallet fetches a dry (non-binding) quote: rate, guaranteed minimum at your slippage, and time estimate. Slippage presets are 0.5 / 1 / 2 / 3% (default 1%)."],
    ["Confirm → live quote", "Confirming fetches a live quote: a reserved deposit address on Quantus plus a deadline (~20 min). Every quote is Ed25519-signed and the wallet verifies the signature and the echoed terms before proceeding."],
    ["Sign the deposit", "After device authentication the wallet sends an ordinary QTC transfer of the exact quoted amount to the deposit address, then posts the tx hash to 1Click via /v0/deposit/submit."],
    ["Watch the lifecycle", "The wallet polls order status every 5 s: PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS (or REFUNDED / FAILED)."],
    ["Payout lands", "1Click publishes the intent, a solver fills it, settlement finalizes on NEAR, and the destination token is withdrawn to your recipient address."]
  ],
  in: [
    ["Pick direction & amount", "Choose a token on another chain → QTC, the amount, and a refund address on the origin chain. Your QTC account is the recipient."],
    ["Review the dry quote", "Same dry quote as swapping out: rate, guaranteed minimum at slippage, time estimate."],
    ["Confirm → live quote", "Confirming reserves a deposit address on the origin chain with a deadline — 2 hours for BTC, LTC, DOGE, BCH, DASH, ZEC; ~20 minutes otherwise."],
    ["Send the deposit yourself", "From your own wallet on the origin chain (MetaMask, Phantom, a BTC wallet…) you send the exact quoted amount to the deposit address. Some chains (e.g. Stellar) also need a deposit memo — shown with its own copy button and warning."],
    ["Watch the lifecycle", "Same 5-second status polling through PENDING_DEPOSIT → … → SUCCESS."],
    ["QTC arrives", "After solver fill and NEAR settlement, 1Click withdraws the QTC to your Quantus account."]
  ]
};

var TIMELINE = [
  ["Sept 2026", "NEAR Intents named as Quantus's first exchange venue", "Launch coverage names NEAR Intents (1Click) as the first place QTC will trade. No listing date is confirmed — the venue is announced, the asset is not yet listed.", null],
  ["Sept 20, 2026", "Wallet team documents the integration against the live API", "The near-intents-swaps doc in quantus-apps records the full flow — and the blocker: QTC is not on the 1Click token list, so every quote fails with tokenIn/tokenOut is not valid.", "https://github.com/Quantus-Network/quantus-apps/blob/main/mobile-app/docs/near-intents-swaps.md"],
  ["Sept 26, 2026", "Live fee probes: 20 bps observed", "Probes against the live API show the platform fee echoed as 20 bps (docs say 25 without a partner key). Fees live inside amountOut — nothing on top.", "https://github.com/Quantus-Network/quantus-apps/blob/main/mobile-app/docs/near-intents-swaps.md#fees"],
  ["Sept 28, 2026", "PR #675 merged: swaps in both directions", "The wallet's swap UI now handles QTC → other chains and other chains → QTC: live quotes, re-confirmation on price moves, deposit submission, and a progress screen.", "https://github.com/Quantus-Network/quantus-apps/pull/675"],
  ["Sept 30, 2026", "This desk's live probe: still unlisted", "The 1Click token list is scanned for the Quantus asset on every visit. Until it appears, the swap flow above is built but cannot execute.", null]
];

var SOURCES = [
  ["Wallet integration doc — near-intents-swaps.md", "https://github.com/Quantus-Network/quantus-apps/blob/main/mobile-app/docs/near-intents-swaps.md", "How swaps work, both directions; actors; fees; refunds; blockers. Verified against the live API Sept 20, 2026."],
  ["quantus-apps PR #675 — swap in both directions through NEAR Intents 1Click", "https://github.com/Quantus-Network/quantus-apps/pull/675", "Merged Sept 28, 2026: one form for both directions, live quotes, deposit submission, progress screen."],
  ["1Click API token list (live)", "https://1click.chaindefuser.com/v0/tokens", "The public list this desk probes. 202 assets, no Quantus entry, as of Sept 30, 2026."],
  ["NEAR Intents docs", "https://docs.near-intents.org", "Intent model, solver auction, 1Click API reference."]
];

/* ---- Formatting helpers ---- */
function fmtInt(n) { return Number(n).toLocaleString("en-US"); }
function timeAgo(ts) {
  var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  var m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  var h = Math.floor(m / 60); if (h < 48) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function esc(s) { return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

/* ---- Live probe ---- */
function probeTokens() {
  var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, PROBE_TIMEOUT_MS) : null;
  var t0 = Date.now();
  var p = fetch(ONECLICK_TOKENS_URL, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
    .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function(j){ return { ok: true, result: scanTokensForQTC(j), ms: Date.now() - t0, at: Date.now() }; })
    .catch(function(e){ return { ok: false, error: String((e && e.name === "AbortError") ? "timeout" : (e && e.message) || e), ms: Date.now() - t0, at: Date.now() }; });
  if (timer) p.then(function(){ clearTimeout(timer); });
  return p;
}

/* ---- DOM ---- */
function $(id) { return document.getElementById(id); }

function renderWatch(res) {
  var pill = $("status-pill"), txt = $("status-text"), det = $("status-detail");
  pill.className = "status-pill";
  if (!res.ok) {
    pill.classList.add("unknown");
    txt.textContent = "Probe unreachable";
    det.textContent = "Could not reach the 1Click API (" + res.error + "). The listing state below is the last known one — treat it as stale, not as proof.";
    $("stat-status").textContent = "unknown";
    $("stat-status-sub").textContent = "probe failed";
  } else if (res.result.listed) {
    pill.classList.add("listed");
    txt.textContent = "QTC IS LISTED";
    var a = res.result.asset || {};
    det.textContent = "Found " + (a.assetId || QTC_ASSET_ID) + " — " + (a.decimals != null ? a.decimals + " decimals" : "decimals n/a") +
      (a.price ? ", $" + a.price + " USD" : "") + ". Quotes can now exist; depth still depends on solvers.";
    $("stat-status").textContent = "LISTED";
    $("stat-status-sub").textContent = "quotes possible";
  } else {
    pill.classList.add("unlisted");
    txt.textContent = "NOT LISTED";
    det.textContent = "Scanned " + fmtInt(res.result.total) + " assets on the live 1Click list — no Quantus entry. Swaps cannot execute yet; the wallet's flow stays behind its enableSwap flag.";
    $("stat-status").textContent = "not listed";
    $("stat-status-sub").textContent = "live 1Click probe";
  }
  $("stat-tokens").textContent = res.ok ? fmtInt(res.result.total) : "—";
  $("watch-checked").textContent = new Date(res.at).toLocaleString() + " (" + timeAgo(res.at) + ")";
  $("watch-latency").textContent = res.ms + " ms";
  $("hero-note").textContent = res.ok
    ? (res.result.listed ? "Listing detected on the live 1Click token list." : "Live probe " + timeAgo(res.at) + ": " + fmtInt(res.result.total) + " tokens scanned, QTC absent.")
    : "Probe failed " + timeAgo(res.at) + " — showing last known state.";
  try { localStorage.setItem(LS_KEY, JSON.stringify(res)); } catch (e) {}
}

function refreshProbe(manual) {
  var btn = $("probe-now");
  btn.disabled = true; btn.textContent = "Probing…";
  probeTokens().then(function(res){
    renderWatch(res);
    btn.disabled = false; btn.textContent = "Probe now";
    if (manual) scheduleAuto();
  });
}
var autoTimer = null;
function scheduleAuto() {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(function(){ refreshProbe(false); }, AUTO_REFRESH_MS);
}

function renderSteps(dir) {
  var list = $("steps-list");
  list.innerHTML = STEPS[dir].map(function(s, i){
    return '<li><span class="n">' + (i + 1) + '</span><div><strong>' + esc(s[0]) + '</strong><p>' + esc(s[1]) + '</p></div></li>';
  }).join("");
  $("how-note").innerHTML = dir === "out"
    ? "<strong>Key detail (swap out):</strong> the deposit is an ordinary signed QTC transfer from your account, so only transparent accounts whose key lives in the app can swap — encrypted, Keystone and watch-only accounts see the swap button disabled."
    : "<strong>Key detail (swap in):</strong> you send the deposit from your own wallet on the other chain; the wallet never touches those funds. The app polls status every 5 s and it is safe to leave the progress screen — 1Click keeps processing.";
  $("dir-out").classList.toggle("on", dir === "out");
  $("dir-in").classList.toggle("on", dir === "in");
  $("dir-out").setAttribute("aria-pressed", dir === "out");
  $("dir-in").setAttribute("aria-pressed", dir === "in");
}

var slipPct = 1;
function renderFeeLab() {
  var offer = Math.max(0, parseFloat($("fee-offer").value) || 0);
  var token = $("fee-token").value;
  var sym = { usdc: "USDC", eth: "ETH", sol: "SOL", btc: "BTC" }[token] || token.toUpperCase();
  var q = illustrativeQuote(offer, platformFeeBps($("fee-mode").value), slipPct);
  var f = function(n){ return n.toLocaleString("en-US", { maximumFractionDigits: 6 }); };
  $("fee-gross").textContent = f(q.offer) + " " + sym;
  $("fee-take").textContent = f(q.fee) + " " + sym + " (" + q.feeBps + " bps)";
  $("fee-net").textContent = f(q.net) + " " + sym;
  $("fee-min").textContent = "≥ " + f(q.minOut) + " " + sym + " @" + q.slippagePct + "%";
  $("fee-math").textContent = "fee = " + f(q.offer) + " × " + q.feeBps + "/10000 = " + f(q.fee) +
    "  ·  net = offer − fee  ·  min = net × (1 − " + q.slippagePct + "%)";
  document.querySelectorAll(".slip-row button").forEach(function(b){
    b.classList.toggle("on", parseFloat(b.dataset.slip) === slipPct);
  });
}

function renderStates() {
  var order = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED", "EXPIRED"];
  $("states").innerHTML = order.map(function(s, i){
    return '<button class="state' + (i === 0 ? " on" : "") + '" role="listitem" data-s="' + s + '">' + s.replace(/_/g, " ") + '</button>';
  }).join("");
  var show = function(s){
    var info = statusInfo(s);
    document.querySelectorAll(".state").forEach(function(b){ b.classList.toggle("on", b.dataset.s === s); });
    $("state-detail").innerHTML = info
      ? '<h3>' + esc(s.replace(/_/g, " ")) + '</h3><p><strong>Who acts:</strong> ' + esc(info.who) + '</p><p>' + esc(info.what) + '</p>'
      : '<p class="fine">Unknown state.</p>';
  };
  document.querySelectorAll(".state").forEach(function(b){
    b.addEventListener("click", function(){ show(b.dataset.s); });
  });
  show("PENDING_DEPOSIT");
}

function renderTimeline() {
  $("timeline").innerHTML = TIMELINE.map(function(e){
    return '<li><span class="t-date">' + esc(e[0]) + '</span><div><strong>' + esc(e[1]) + '</strong><p>' + esc(e[2]) + '</p>' +
      (e[3] ? '<a class="src" href="' + esc(e[3]) + '" target="_blank" rel="noopener">source ↗</a>' : "") + '</div></li>';
  }).join("");
}

function renderSources() {
  $("source-list").innerHTML = SOURCES.map(function(s){
    return '<li><a href="' + esc(s[1]) + '" target="_blank" rel="noopener">' + esc(s[0]) + '</a><span>' + esc(s[2]) + '</span></li>';
  }).join("");
}

/* ---- init ---- */
function init() {
  renderSteps("out");
  renderFeeLab();
  renderStates();
  renderTimeline();
  renderSources();
  $("dir-out").addEventListener("click", function(){ renderSteps("out"); });
  $("dir-in").addEventListener("click", function(){ renderSteps("in"); });
  ["fee-offer", "fee-token", "fee-mode"].forEach(function(id){
    $(id).addEventListener("input", renderFeeLab);
    $(id).addEventListener("change", renderFeeLab);
  });
  document.querySelectorAll(".slip-row button").forEach(function(b){
    b.addEventListener("click", function(){ slipPct = parseFloat(b.dataset.slip); renderFeeLab(); });
  });
  $("probe-now").addEventListener("click", function(){ refreshProbe(true); });
  // Copy buttons (footer donation address etc.)
  document.addEventListener("click", function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest("[data-copy]") : null;
    if (!btn) return;
    var v = btn.getAttribute("data-copy") || "";
    var done = function(){
      var orig = btn.textContent;
      btn.textContent = "copied ✓";
      setTimeout(function(){ btn.textContent = orig; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(done, done);
    } else {
      var ta = document.createElement("textarea");
      ta.value = v; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta); done();
    }
  });
  // Last known state paints instantly; the live probe replaces it.
  try {
    var cached = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (cached && cached.at) renderWatch(cached);
  } catch (e) {}
  refreshProbe(false);
}

if (typeof document !== "undefined" && document.readyState !== "loading") init();
else if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init());

/* Node export for tests */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    scanTokensForQTC: scanTokensForQTC,
    platformFeeBps: platformFeeBps,
    illustrativeQuote: illustrativeQuote,
    deadlineFor: deadlineFor,
    statusInfo: statusInfo,
    STEPS: STEPS,
    TIMELINE: TIMELINE,
    SOURCES: SOURCES,
    QTC_ASSET_ID: QTC_ASSET_ID,
    ONECLICK_TOKENS_URL: ONECLICK_TOKENS_URL
  };
}
