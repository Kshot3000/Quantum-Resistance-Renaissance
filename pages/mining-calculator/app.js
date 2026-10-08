/* QTC Mining Calculator — pure chain math + UI.
 * Chain facts (verified 2026-09-29 against Quantus-Network/docs):
 *   - 12s target block time (docs/architecture.md)
 *   - Block reward = (21,000,000 - currentSupply) / 50,000,000 (docs/reference/tokenomics.md)
 *   - 21M cap, 27% genesis mint (5.67M QTC), 73% to miners, 100% of each block reward to miner
 *   - 1 QTC = 10^12 planck; mainnet live Sept 9, 2026
 * Defaults (v1.9.0): network hashrate, total issuance, and observed block
 * pace derive live from the builder's hourly chain snapshots
 * (data/consensus.json + data/supply.json) — the same derivation as
 * mining-studio v1.1.0 / pool-desk v1.44.0. Before v1.9.0 this page
 * pre-filled a static "10 GH/s" example network rate and modeled supply
 * from wall-clock time since launch at exactly 12 s/block: at the real
 * ~55.8 TH/s network the default 500 MH/s estimate read ~110 QTC/day
 * against a true ~0.02 QTC/day (~5,500x overstatement), and the modeled
 * block count ran +10.9% ahead of the real chain.
 */
(function(){
"use strict";

var CHAIN = {
  BLOCK_TIME_S: 12,
  MAX_SUPPLY: 21000000,
  GENESIS_MINT: 5670000,
  EMISSION_DIVISOR: 50000000,
  MAINNET_T0: Date.parse("2026-09-09T00:00:00Z"),
  UNITS: {"H/s":1,"kH/s":1e3,"MH/s":1e6,"GH/s":1e9,"TH/s":1e12}
};
CHAIN.BLOCKS_PER_DAY = 86400 / CHAIN.BLOCK_TIME_S; // 7200

/* Dated static FALLBACK bundle — replaced at load by deriveNetworkDefaults()
 * from the hourly data/*.json snapshots. Kept honest and dated for the
 * no-fetch path (file://, offline). Every figure comes from ONE capture
 * (2026-10-08 17:24Z): consensus difficulty @189,029 and total issuance
 * @189,029, fetched 16 seconds apart — never mix snapshot dates in one bundle.
 * Guarded by tests/calc.test.js (fallback-integrity suite). */
var FALLBACK = {
  difficulty: "654831244711333",        // data/consensus.json @189,029
  netHs: 54569270392611,                // = floor(difficulty / 12 s)
  totalSupplyPlancks: "5791052506292137223", // data/supply.json @189,029
  supplyQtc: 5791052.5063,              // total issuance incl. genesis
  avgBlockMs: 12622,                    // consensus block_times_ms (3,000-block sample)
  height: 189029,
  fetchedAt: "2026-10-08T17:24:28.811Z"
};

/* Pure: block reward from total issuance (the emission formula's S —
 * genesis endowments INCLUDED, per Currency::total_issuance()). A
 * mined-only supply input overstates the reward by ~37% at current
 * issuance; see the fleet-wide fix in commit ccc1391. */
function blockReward(supplyQtc){
  return Math.max(0, (CHAIN.MAX_SUPPLY - supplyQtc) / CHAIN.EMISSION_DIVISOR);
}

/* Pure: total supply in plancks from a supply snapshot — the first-class
 * total_supply_plancks field when present, else the balances aggregate
 * (free + reserved + frozen) = Currency::total_issuance(). Null when
 * neither is usable. */
function totalSupplyOf(sup){
  if (!sup) return null;
  if (sup.total_supply_plancks != null && sup.total_supply_plancks !== "") {
    var p = String(sup.total_supply_plancks);
    if (/^\d+$/.test(p)) return p;
  }
  var b = sup.balances_plancks;
  if (b && b.free != null && b.reserved != null && b.frozen != null) {
    try { return (BigInt(b.free) + BigInt(b.reserved) + BigInt(b.frozen)).toString(); }
    catch (e) { return null; }
  }
  return null;
}

/* Pure: derive the calculator's network defaults from the builder's
 * hourly chain snapshots (data/consensus.json + data/supply.json):
 *  - netHs:        consensus.current.est_hashrate_hs (difficulty / 12 s)
 *  - supplyQtc:    supply total issuance incl. genesis (see totalSupplyOf)
 *  - blocksPerDay: observed pace from consensus.block_times_ms.avg_ms,
 *                  not the 12 s target
 * Any field that is missing or implausible comes back null; the caller
 * keeps the dated FALLBACK for that field and says so. */
function deriveNetworkDefaults(consensus, supply){
  var out = { netHs: null, supplyQtc: null, blocksPerDay: null, avgBlockMs: null, height: null, fetchedAt: null };
  if (consensus && consensus.current) {
    var hs = Number(consensus.current.est_hashrate_hs);
    if (isFinite(hs) && hs > 0) out.netHs = hs;
    var h = Number(consensus.current.height || consensus.head);
    if (isFinite(h) && h > 0) out.height = h;
    if (consensus.fetched_at) out.fetchedAt = String(consensus.fetched_at);
  }
  if (consensus && consensus.block_times_ms) {
    var avg = Number(consensus.block_times_ms.avg_ms);
    if (isFinite(avg) && avg > 1000 && avg < 120000) {
      out.avgBlockMs = avg;
      out.blocksPerDay = 86400000 / avg;
    }
  }
  var plancks = totalSupplyOf(supply);
  if (plancks != null) {
    var qtc = Number(plancks) / 1e12;
    if (isFinite(qtc) && qtc >= CHAIN.GENESIS_MINT && qtc <= CHAIN.MAX_SUPPLY) out.supplyQtc = qtc;
    if (!out.fetchedAt && supply.fetched_at) out.fetchedAt = String(supply.fetched_at);
    if (!out.height && supply.block_height) out.height = Number(supply.block_height) || null;
  }
  return out;
}

/* Pure: chain state at a timestamp, from the genesis-anchored decay model.
 * Kept as the theoretical emission model (and for its tests); since v1.9.0
 * it no longer drives the calculator's defaults — the real chain's block
 * count runs ~11% behind the 12 s wall-clock model, so defaults come from
 * the snapshots above instead. */
function chainState(atMs){
  var blocks = Math.max(0, Math.floor((atMs - CHAIN.MAINNET_T0) / (CHAIN.BLOCK_TIME_S*1000)));
  var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-blocks / CHAIN.EMISSION_DIVISOR);
  var supply = CHAIN.MAX_SUPPLY - remaining;
  var reward = remaining / CHAIN.EMISSION_DIVISOR;
  return { blocks: blocks, supply: supply, reward: reward, blocksPerDay: CHAIN.BLOCKS_PER_DAY };
}

/* Pure: mining estimate. All rates per day. o.blocksPerDay is the
 * NETWORK's blocks/day (observed pace when known); it defaults to the
 * 7,200/day protocol target. */
function estimate(o){
  var userHs = o.userHs > 0 ? o.userHs : 0;
  var netHs  = o.netHs  > 0 ? o.netHs  : 0;
  var share = netHs > 0 ? userHs / netHs : 0;
  var clamped = false;
  if (share > 1){ share = 1; clamped = true; }
  var netBpd = (isFinite(o.blocksPerDay) && o.blocksPerDay > 0) ? o.blocksPerDay : CHAIN.BLOCKS_PER_DAY;
  var blocksPerDay = share * netBpd;
  var qtcPerDay = blocksPerDay * o.reward;
  var daysPerBlock = share > 0 ? (1 / share) / netBpd : Infinity;
  var kwhPerDay = Math.max(0, o.watts) * 24 / 1000;
  var powerCost = kwhPerDay * Math.max(0, o.kwhPrice);
  var revenue = o.qtcPrice > 0 ? qtcPerDay * o.qtcPrice : 0;
  var profit = o.qtcPrice > 0 ? revenue - powerCost : -powerCost;
  var breakeven = qtcPerDay > 0 ? powerCost / qtcPerDay : Infinity;
  return {
    share: share, shareClamped: clamped, blocksPerDay: blocksPerDay,
    qtcPerDay: qtcPerDay, daysPerBlock: daysPerBlock,
    powerCost: powerCost, revenue: revenue, profit: profit,
    breakeven: breakeven, hasPrice: o.qtcPrice > 0
  };
}

function fmtNum(n, digits){
  if (!isFinite(n)) return "\u2014";
  if (n === 0) return "0";
  var a = Math.abs(n);
  var suf = "", v = n;
  if (a >= 1e9){ v = n/1e9; suf = "B"; }
  else if (a >= 1e6){ v = n/1e6; suf = "M"; }
  else if (a >= 1e3){ v = n/1e3; suf = "K"; }
  return v.toFixed(digits == null ? 2 : digits).replace(/\.?0+$/,"") + (suf ? " " + suf : "");
}
function fmtQTC(n){
  if (!isFinite(n)) return "\u2014";
  return n >= 100 ? fmtNum(n,2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
function fmtMoney(n){
  if (!isFinite(n)) return "\u2014";
  var sign = n < 0 ? "-" : "", a = Math.abs(n), suf = "", v = a;
  if (a >= 1e9){ v = a/1e9; suf = "B"; }
  else if (a >= 1e6){ v = a/1e6; suf = "M"; }
  else if (a >= 1e3){ v = a/1e3; suf = "K"; }
  return sign + "$" + v.toFixed(2) + (suf ? " " + suf : "");
}
function fmtDuration(days){
  if (!isFinite(days)) return "\u2014";
  if (days < 1) return (days*24).toFixed(1) + " hours";
  if (days < 60) return days.toFixed(1) + " days";
  if (days < 730) return (days/30.44).toFixed(1) + " months";
  return (days/365.25).toFixed(1) + " years";
}
function fmtUtc(iso){
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown time";
  function p(n){ return String(n).padStart(2, "0"); }
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " UTC";
}

/* ---------- UI wiring (browser only) ---------- */
function init(){
  var $ = function(id){ return document.getElementById(id); };
  var inputs = ["in-user","in-user-unit","in-net","in-net-unit","in-watts","in-kwh","in-price","in-supply"];

  /* Live network state: starts at the dated FALLBACK bundle, replaced
   * field-by-field when the hourly snapshots land. Fields the user has
   * edited are never overwritten. */
  var live = {
    netHs: FALLBACK.netHs,
    supplyQtc: FALLBACK.supplyQtc,
    blocksPerDay: 86400000 / FALLBACK.avgBlockMs,
    avgBlockMs: FALLBACK.avgBlockMs,
    height: FALLBACK.height,
    fetchedAt: FALLBACK.fetchedAt,
    snapshot: false
  };
  var netDirty = false, supplyDirty = false;

  // Hash-rain canvas: falling hex glyphs, gold on obsidian.
  (function(){
    var c = $("hashrain"), x = c.getContext("2d"), cols = [], glyphs = "0123456789abcdef";
    function size(){ c.width = innerWidth; c.height = innerHeight;
      var n = Math.floor(innerWidth/26); cols = [];
      for (var i=0;i<n;i++) cols.push({x:i*26, y:Math.random()*innerHeight, v:1+Math.random()*2.4});
    }
    size(); addEventListener("resize", size);
    x.font = "15px monospace";
    var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (function tick(){
      x.fillStyle = "rgba(8,5,3,0.14)"; x.fillRect(0,0,c.width,c.height);
      for (var i=0;i<cols.length;i++){ var col = cols[i];
        var g = glyphs[(Math.random()*16)|0];
        x.fillStyle = Math.random() < .06 ? "rgba(255,217,122,.85)" : "rgba(245,185,66,.34)";
        x.fillText(g, col.x, col.y);
        col.y += col.v * 15;
        if (col.y > c.height + 20){ col.y = -20; col.v = 1 + Math.random()*2.4; }
      }
      if (!REDUCE_MOTION) requestAnimationFrame(tick);
    })();
  })();

  function readInputs(){
    var supplyOv = parseFloat($("in-supply").value);
    var supply = isFinite(supplyOv) && supplyOv > 0 ? supplyOv : live.supplyQtc;
    return {
      userHs: parseFloat($("in-user").value) * (CHAIN.UNITS[$("in-user-unit").value] || 1),
      netHs:  parseFloat($("in-net").value)  * (CHAIN.UNITS[$("in-net-unit").value]  || 1),
      watts: parseFloat($("in-watts").value) || 0,
      kwhPrice: parseFloat($("in-kwh").value) || 0,
      qtcPrice: parseFloat($("in-price").value),
      reward: blockReward(supply), supply: supply
    };
  }

  function recalc(){
    var inp = readInputs();
    if (!isFinite(inp.qtcPrice) || inp.qtcPrice < 0) inp.qtcPrice = 0;
    var e = estimate({ userHs: inp.userHs, netHs: inp.netHs, watts: inp.watts,
                       kwhPrice: inp.kwhPrice, qtcPrice: inp.qtcPrice, reward: inp.reward,
                       blocksPerDay: live.blocksPerDay });
    $("r-qtcday").textContent = fmtQTC(e.qtcPerDay);
    $("r-profit").textContent = e.hasPrice ? fmtMoney(e.profit) : "\u2014";
    $("r-share").textContent = (e.share*100) >= 0.01 ? (e.share*100).toFixed(e.share*100 >= 1 ? 2 : 4) + "%" : "< 0.01%";
    $("r-blocks").textContent = fmtNum(e.blocksPerDay, 2);
    $("r-ttp").textContent = fmtDuration(e.daysPerBlock);
    $("r-reward").textContent = fmtQTC(inp.reward) + " QTC";
    $("r-cost").textContent = fmtMoney(e.powerCost);
    $("r-rev").textContent = e.hasPrice ? fmtMoney(e.revenue) : "\u2014";
    $("r-breakeven").textContent = e.hasPrice || e.qtcPerDay > 0 ? fmtMoney(e.breakeven) + " / QTC" : "\u2014";
    var warn = $("r-warn");
    if (e.shareClamped){ warn.hidden = false; warn.textContent = "Your hashrate meets or exceeds the network figure — share capped at 100%. Check the network value."; }
    else if (inp.netHs <= 0){ warn.hidden = false; warn.textContent = "Enter the live network hashrate (see telemetry) for a real estimate."; }
    else warn.hidden = true;
  }
  inputs.forEach(function(id){
    $(id).addEventListener("input", recalc);
    $(id).addEventListener("change", recalc);
  });
  $("in-net").addEventListener("input", function(){ netDirty = true; });
  $("in-net-unit").addEventListener("change", function(){ netDirty = true; });
  $("in-supply").addEventListener("input", function(){ supplyDirty = true; });

  // Emission chart: block-reward decay over 12 years + "today" marker.
  (function(){
    var c = $("chart"), x = c.getContext("2d");
    function draw(){
      var W = c.width, H = c.height, padL = 64, padR = 16, padT = 18, padB = 34;
      var YEARS = 12, pts = [];
      for (var i=0;i<=240;i++){
        var yrs = YEARS * i/240;
        var blocks = yrs * 365.25 * CHAIN.BLOCKS_PER_DAY;
        var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-blocks / CHAIN.EMISSION_DIVISOR);
        pts.push({x: yrs, y: remaining / CHAIN.EMISSION_DIVISOR});
      }
      var maxY = pts[0].y * 1.05;
      var X = function(v){ return padL + (v/YEARS)*(W-padL-padR); };
      var Y = function(v){ return H-padB - (v/maxY)*(H-padT-padB); };
      x.clearRect(0,0,W,H);
      x.strokeStyle = "rgba(245,185,66,.12)"; x.fillStyle = "rgba(168,152,128,.9)";
      x.font = "11px monospace"; x.lineWidth = 1;
      for (var g=0; g<=4; g++){
        var gy = Y(maxY*g/4);
        x.beginPath(); x.moveTo(padL,gy); x.lineTo(W-padR,gy); x.stroke();
        x.fillText((maxY*g/4).toFixed(2), 8, gy+4);
      }
      for (var gx=0; gx<=YEARS; gx+=2){
        x.fillText(gx+"y", X(gx)-6, H-12);
      }
      x.fillText("QTC / block", 8, 14);
      // area
      var grad = x.createLinearGradient(0,padT,0,H-padB);
      grad.addColorStop(0,"rgba(245,185,66,.5)"); grad.addColorStop(1,"rgba(245,185,66,.02)");
      x.beginPath(); x.moveTo(X(0), Y(pts[0].y));
      pts.forEach(function(p){ x.lineTo(X(p.x), Y(p.y)); });
      x.lineTo(X(YEARS), H-padB); x.lineTo(X(0), H-padB); x.closePath();
      x.fillStyle = grad; x.fill();
      x.beginPath(); x.moveTo(X(0), Y(pts[0].y));
      pts.forEach(function(p){ x.lineTo(X(p.x), Y(p.y)); });
      x.strokeStyle = "#f5b942"; x.lineWidth = 2.5; x.stroke();
      // today marker
      var nowYrs = (Date.now() - CHAIN.MAINNET_T0) / (365.25*86400*1000);
      if (nowYrs >= 0 && nowYrs <= YEARS){
        x.strokeStyle = "rgba(255,107,53,.8)"; x.setLineDash([5,4]); x.lineWidth = 1.5;
        x.beginPath(); x.moveTo(X(nowYrs), padT); x.lineTo(X(nowYrs), H-padB); x.stroke();
        x.setLineDash([]);
        x.fillStyle = "#ff8a5c"; x.fillText("today", X(nowYrs)-14, padT+2);
      }
    }
    draw();
  })();

  // Chain stats strip under the chart — from the live/fallback state,
  // never the wall-clock model.
  function paintStats(){
    var reward = blockReward(live.supplyQtc);
    $("s-reward").textContent = fmtQTC(reward) + " QTC";
    $("s-supply").textContent = fmtNum(live.supplyQtc, 2) + " QTC";
    $("s-daily").textContent = fmtNum(reward * live.blocksPerDay, 0) + " QTC";
    var src = $("stats-src");
    if (src) src.textContent = live.snapshot
      ? "Network state from the builder's chain snapshot (fetched " + fmtUtc(live.fetchedAt) +
        (live.height ? ", block " + Number(live.height).toLocaleString("en-US") : "") +
        "): difficulty-implied hashrate, total issuance, and the observed ~" +
        (live.avgBlockMs / 1000).toFixed(1) + "s block pace."
      : "Network state from the dated fallback capture (" + fmtUtc(live.fetchedAt) +
        (live.height ? ", block " + Number(live.height).toLocaleString("en-US") : "") +
        ") — the latest snapshot could not be loaded, so these are the newest verified figures, labeled as such.";
  }
  paintStats();

  /* ---- network defaults from the hourly chain snapshots ----
   * QA hook: qa-miningcalc-browser.mjs injects real snapshot payloads via
   * window.__qtcminingcalc_mock because file:// fetch is blocked headless. */
  function timeoutSignal(ms){
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var ctl = new AbortController();
    setTimeout(function(){ ctl.abort(); }, ms);
    return ctl.signal;
  }
  function loadNetworkDefaults(){
    function get(url){
      var mock = typeof window !== "undefined" ? window.__qtcminingcalc_mock : null;
      if (mock) {
        for (var k in mock) { if (url.indexOf(k) >= 0) return Promise.resolve(mock[k]); }
      }
      if (typeof fetch !== "function") return Promise.resolve(null);
      return fetch(url, { cache: "no-store", signal: timeoutSignal(9000) })
        .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .catch(function(){ return null; });
    }
    return Promise.all([get("../../data/consensus.json"), get("../../data/supply.json")]).then(function(arr){
      var d = deriveNetworkDefaults(arr[0], arr[1]);
      if (!d || (d.netHs == null && d.supplyQtc == null && d.blocksPerDay == null)) return;
      if (d.netHs != null) live.netHs = d.netHs;
      if (d.supplyQtc != null) live.supplyQtc = d.supplyQtc;
      if (d.blocksPerDay != null) { live.blocksPerDay = d.blocksPerDay; live.avgBlockMs = d.avgBlockMs; }
      if (d.height != null) live.height = d.height;
      if (d.fetchedAt) live.fetchedAt = d.fetchedAt;
      live.snapshot = true;
      if (d.netHs != null && !netDirty) {
        $("in-net").value = (d.netHs / 1e12).toFixed(4);
        $("in-net-unit").value = "TH/s";
      }
      if (d.supplyQtc != null && !supplyDirty) $("in-supply").value = Math.round(d.supplyQtc);
      var nh = $("net-hint");
      if (nh) nh.innerHTML = "Live from the builder's chain snapshot (fetched " + fmtUtc(live.fetchedAt) +
        (live.height ? ", block " + Number(live.height).toLocaleString("en-US") : "") +
        "): difficulty-implied network rate \u2248" + (live.netHs / 1e12).toFixed(2) +
        " TH/s. Cross-check at <a href=\"https://telemetry.quantus.cat\" target=\"_blank\" rel=\"noopener\">telemetry.quantus.cat</a> \u2014 edit the field and your number wins.";
      var sh = $("supply-hint");
      if (sh) sh.textContent = "From the same snapshot: total issuance " + Math.round(live.supplyQtc).toLocaleString("en-US") +
        " QTC (genesis endowments included, as the emission formula requires). Override if you know a fresher figure \u2014 the block reward recalculates.";
      paintStats();
      recalc();
    });
  }
  loadNetworkDefaults();

  // Donation address click-to-copy.
  document.querySelectorAll(".addr").forEach(function(b){
    b.addEventListener("click", function(){
      var done = function(){ var t=b.textContent; b.textContent="Copied!"; setTimeout(function(){ b.textContent=t; },1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.dataset.copy).then(done, done);
      else done();
    });
  });

  recalc();
}

if (typeof document !== "undefined" && typeof window !== "undefined"){
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

/* Node test hook */
if (typeof module !== "undefined" && module.exports){
  module.exports = { CHAIN: CHAIN, FALLBACK: FALLBACK, chainState: chainState, estimate: estimate,
                     blockReward: blockReward, totalSupplyOf: totalSupplyOf,
                     deriveNetworkDefaults: deriveNetworkDefaults,
                     fmtNum: fmtNum, fmtQTC: fmtQTC, fmtMoney: fmtMoney, fmtDuration: fmtDuration, fmtUtc: fmtUtc };
}
})();
