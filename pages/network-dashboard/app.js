/* QTC Network Dashboard — live telemetry from the public Quantus indexer.
 * Endpoint (verified 2026-09-29): https://sqm.quantus.com/v1/graphql
 * Chain math reused from pages/mining-calculator (verified vs docs/reference/tokenomics.md):
 *   12s blocks · reward = (21M - supply)/50,000,000 · 27% genesis mint (5.67M QTC) · 1 QTC = 10^12 planck
 */
(function(){
"use strict";

var ENDPOINT = "https://sqm.quantus.com/v1/graphql";
var REFRESH_MS = 60000;
var BLOCKS_LIMIT = 15;
var DAILY_LIMIT = 14;

var CHAIN = {
  BLOCK_TIME_S: 12,
  MAX_SUPPLY: 21000000,
  GENESIS_MINT: 5670000,
  EMISSION_DIVISOR: 50000000,
  PLANCK: 1e12
};

/* ---------------- pure helpers (Node-testable) ---------------- */

function fmtInt(n){
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* planck string -> QTC string, trimmed to 4 decimals max */
function fmtQTC(planckStr){
  if (planckStr === null || planckStr === undefined) return "—";
  var neg = false, s = String(planckStr);
  if (s.charAt(0) === "-"){ neg = true; s = s.slice(1); }
  s = s.replace(/^0+/, "") || "0";
  var pad = s.length <= 12 ? ("000000000000" + s).slice(-12) : s.slice(-12);
  var whole = s.length <= 12 ? "0" : s.slice(0, -12);
  var frac = pad.replace(/0+$/, "");
  if (frac.length > 4) frac = frac.slice(0, 4);
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

function fmtRewardQTC(planckStr){
  var s = fmtQTC(planckStr);
  return s === "—" ? s : s + " QTC";
}

/* age from timestamp ms -> "12s ago" style */
function ageFmt(atMs, nowMs){
  var d = Math.max(0, (nowMs || Date.now()) - atMs);
  var s = Math.floor(d / 1000);
  if (s < 60) return s + "s ago";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function tps24h(txCount24h){
  if (!txCount24h || txCount24h < 0) return 0;
  return txCount24h / 86400;
}

/* mean gap in seconds between consecutive block timestamps (newest first) */
function avgBlockGap(tsMs){
  if (!tsMs || tsMs.length < 2) return null;
  var sum = 0, n = 0;
  for (var i = 0; i < tsMs.length - 1; i++){
    var gap = tsMs[i] - tsMs[i + 1];
    if (gap > 0 && gap < 600000){ sum += gap; n++; }
  }
  return n > 0 ? sum / n / 1000 : null;
}

function supplyEst(blocks){
  var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-Math.max(0, blocks) / CHAIN.EMISSION_DIVISOR);
  return CHAIN.MAX_SUPPLY - remaining;
}

function blockRewardEst(blocks){
  var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-Math.max(0, blocks) / CHAIN.EMISSION_DIVISOR);
  return remaining / CHAIN.EMISSION_DIVISOR;
}

function shortHash(h){
  if (!h || h.length < 18) return h || "—";
  return h.slice(0, 10) + "…" + h.slice(-8);
}

var API = { fmtInt: fmtInt, fmtQTC: fmtQTC, fmtRewardQTC: fmtRewardQTC, ageFmt: ageFmt,
  tps24h: tps24h, avgBlockGap: avgBlockGap, supplyEst: supplyEst,
  blockRewardEst: blockRewardEst, shortHash: shortHash, CHAIN: CHAIN };
if (typeof module !== "undefined" && module.exports) module.exports = API;

/* ---------------- fetch layer ---------------- */

var SNAPSHOT = "../../data/live.json";
var lastFetchedAt = null;
var dataMode = "snapshot"; /* snapshot | live | mock */

function gql(query){
  /* Test hook for headless QA:
   * QA injects window.__qtcdash_mock = {ok:true,data:{...}} before load. */
  if (typeof window !== "undefined" && window.__qtcdash_mock){
    var m = window.__qtcdash_mock;
    dataMode = "mock";
    lastFetchedAt = new Date().toISOString();
    return m.ok ? Promise.resolve(m.data) : Promise.reject(new Error(m.error || "mock indexer failure"));
  }
  /* Browser CORS: sqm.quantus.com only allowlists explorer.quantus.com / quantus.com.
   * On GitHub Pages we load a same-origin snapshot refreshed about hourly by the
   * builder's data pipeline. Still attempt a direct call first in case CORS opens;
   * fall back to snapshot. */
  return fetchDirect(query).catch(function(){ return fetchSnapshot(); });
}

function fetchDirect(query){
  var ctl = new AbortController();
  var timer = setTimeout(function(){ ctl.abort(); }, 4000);
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query }),
    signal: ctl.signal
  }).then(function(res){
    clearTimeout(timer);
    if (!res.ok) throw new Error("indexer HTTP " + res.status);
    return res.json();
  }).then(function(json){
    if (json.errors) throw new Error("indexer: " + json.errors[0].message);
    dataMode = "live";
    lastFetchedAt = new Date().toISOString();
    return json.data;
  });
}

/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}

function fetchSnapshot(){
  var bust = SNAPSHOT + "?t=" + Math.floor(Date.now() / 60000);
  return fetch(bust, { cache: "no-store", signal: timeoutSignal(9000) }).then(function(res){
    if (!res.ok) throw new Error("snapshot HTTP " + res.status);
    return res.json();
  }).then(function(payload){
    if (!payload || !payload.ok || !payload.data) throw new Error("snapshot empty");
    dataMode = "snapshot";
    lastFetchedAt = payload.fetched_at || null;
    return payload.data;
  });
}

var QUERY = 'query { ' +
  'status: chain_stats_by_pk(id: "global") { block_height total_accounts total_immediate_transfers total_scheduled_transfers } ' +
  'blocks: block(limit: ' + BLOCKS_LIMIT + ', order_by: {height: desc}) { height hash timestamp reward } ' +
  'daily: daily_chain_stats(order_by: {date: desc}, limit: ' + DAILY_LIMIT + ') { date blocks_count tx_count active_accounts } ' +
  '}';

/* ---------------- rendering ---------------- */

var els = {};
var knownHeights = {};
var chartData = [];

function $(id){ return document.getElementById(id); }

function setPill(mode, text){
  var pill = els.livePill;
  pill.classList.toggle("on", mode === "on");
  pill.classList.toggle("err", mode === "err");
  els.liveText.textContent = text;
}

function copyText(t, btn){
  function done(){ var o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(function(){ btn.textContent = o; }, 1600); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(done, done);
  } else {
    var ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch(e){}
    document.body.removeChild(ta); done();
  }
}

function renderStats(data){
  var st = data.status || {};
  var blocks = data.blocks || [];
  var daily = (data.daily || []).slice().reverse(); // oldest -> newest

  els.stHeight.textContent = fmtInt(st.block_height);

  var ts = blocks.map(function(b){ return Date.parse(b.timestamp); }).filter(function(x){ return !isNaN(x); });
  var gap = avgBlockGap(ts);
  els.stBlockTime.innerHTML = gap === null ? "—" : gap.toFixed(1) + '<span class="unit">s</span>';

  var today = daily.length ? daily[daily.length - 1].tx_count : 0;
  var tps = tps24h(today);
  els.stTps.innerHTML = (tps >= 0.1 ? tps.toFixed(2) : tps.toFixed(3)) + '<span class="unit">tx/s</span>';
  els.stTpsFoot.textContent = fmtInt(today) + " txs in last 24h";

  els.stAccounts.textContent = fmtInt(st.total_accounts);

  var tx = (st.total_immediate_transfers || 0) + (st.total_scheduled_transfers || 0);
  els.stTxs.textContent = fmtInt(tx);

  var sup = supplyEst(st.block_height || 0);
  els.stSupply.innerHTML = fmtInt(sup) + '<span class="unit">QTC</span>';
  els.stSupplyFoot.textContent = "est. · block reward ≈ " + blockRewardEst(st.block_height || 0).toFixed(3) + " QTC";

  els.chartNote.textContent = "Daily aggregates from the indexer's daily_chain_stats table. TPS counts only user transactions.";
  chartData = daily;
  drawChart();
}

function renderBlocks(blocks){
  var tb = els.blocksBody;
  if (!blocks || !blocks.length){
    tb.innerHTML = '<tr><td colspan="4" class="loading">No blocks returned by the indexer.</td></tr>';
    return;
  }
  var html = "";
  blocks.forEach(function(b){
    var fresh = !knownHeights[b.height] ? " fresh" : "";
    knownHeights[b.height] = 1;
    html += '<tr class="brow' + fresh + '">' +
      '<td class="height">' + fmtInt(b.height) + '</td>' +
      '<td class="hash" data-hash="' + b.hash + '" title="Click to copy full hash">' + shortHash(b.hash) + '</td>' +
      '<td class="age" data-ts="' + b.timestamp + '">' + ageFmt(Date.parse(b.timestamp)) + '</td>' +
      '<td class="reward">' + fmtRewardQTC(b.reward) + '</td></tr>';
  });
  tb.innerHTML = html;
  var cells = tb.querySelectorAll("td.hash");
  for (var i = 0; i < cells.length; i++){
    (function(c){ c.addEventListener("click", function(){ copyText(c.getAttribute("data-hash"), c); }); })(cells[i]);
  }
  els.blocksUpdated.textContent = "updated " + new Date().toLocaleTimeString();
  tickAges();
}

function tickAges(){
  var cells = els.blocksBody.querySelectorAll("td.age");
  var now = Date.now();
  for (var i = 0; i < cells.length; i++){
    var t = Date.parse(cells[i].getAttribute("data-ts"));
    if (!isNaN(t)) cells[i].textContent = ageFmt(t, now);
  }
}

/* ---------------- activity chart ---------------- */

function drawChart(){
  var cv = els.chart;
  if (!chartData.length) return;
  var dpr = window.devicePixelRatio || 1;
  var W = 960, H = 280, padL = 56, padR = 14, padT = 16, padB = 34;
  cv.width = W * dpr; cv.height = H * dpr;
  var ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  var maxTx = Math.max.apply(null, chartData.map(function(d){ return d.tx_count; }).concat([1]));
  var maxBlk = Math.max.apply(null, chartData.map(function(d){ return d.blocks_count; }).concat([1]));
  var iw = W - padL - padR, ih = H - padT - padB;
  var n = chartData.length, bw = iw / n;

  /* gridlines */
  ctx.strokeStyle = "rgba(148,163,184,.12)";
  ctx.fillStyle = "#8fa3c8";
  ctx.font = "11px ui-monospace,monospace";
  ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++){
    var y = padT + ih - (ih * g / 4);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(fmtInt(maxTx * g / 4), 6, y + 4);
  }

  /* bars: tx/day */
  for (var i = 0; i < n; i++){
    var d = chartData[i];
    var bh = ih * (d.tx_count / maxTx);
    var x = padL + i * bw + bw * 0.18, w = bw * 0.64;
    var y = padT + ih - bh;
    var grd = ctx.createLinearGradient(0, y, 0, y + bh);
    grd.addColorStop(0, "rgba(34,211,238,.9)");
    grd.addColorStop(1, "rgba(34,211,238,.12)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, Math.max(2, bh), [4, 4, 0, 0]); else ctx.rect(x, y, w, Math.max(2, bh));
    ctx.fill();
  }

  /* line: blocks/day */
  ctx.strokeStyle = "#a78bfa";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (var j = 0; j < n; j++){
    var bx = padL + j * bw + bw / 2;
    var by = padT + ih - ih * (chartData[j].blocks_count / maxBlk);
    if (j === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
  }
  ctx.stroke();
  ctx.fillStyle = "#a78bfa";
  for (var k = 0; k < n; k++){
    var dx = padL + k * bw + bw / 2;
    var dy = padT + ih - ih * (chartData[k].blocks_count / maxBlk);
    ctx.beginPath(); ctx.arc(dx, dy, 3, 0, Math.PI * 2); ctx.fill();
  }

  /* x labels: day-of-month */
  ctx.fillStyle = "#8fa3c8";
  for (var l = 0; l < n; l++){
    var dt = new Date(chartData[l].date);
    if (isNaN(dt)) continue;
    ctx.fillText(String(dt.getUTCDate()).padStart(2, "0"), padL + l * bw + bw * 0.3, H - 12);
  }

  cv.onmousemove = function(ev){
    var r = cv.getBoundingClientRect();
    var mx = (ev.clientX - r.left) * (W / r.width);
    var idx = Math.floor((mx - padL) / bw);
    if (idx < 0 || idx >= n){ els.tip.hidden = true; return; }
    var dd = chartData[idx];
    var ddt = new Date(dd.date);
    els.tip.innerHTML =
      '<div class="tt-date">' + (isNaN(ddt) ? dd.date : ddt.toUTCString().slice(0, 16)) + '</div>' +
      '<div class="tt-tx">◆ ' + fmtInt(dd.tx_count) + ' txs</div>' +
      '<div class="tt-blk">◆ ' + fmtInt(dd.blocks_count) + ' blocks</div>' +
      '<div>◆ ' + fmtInt(dd.active_accounts) + ' active accounts</div>';
    els.tip.hidden = false;
    var tipX = Math.min(ev.clientX - r.left + 16, r.width - 190);
    els.tip.style.left = tipX + "px";
    els.tip.style.top = (ev.clientY - r.top - 20) + "px";
  };
  cv.onmouseleave = function(){ els.tip.hidden = true; };
}

/* ---------------- refresh loop ---------------- */

var refreshTimer = null;

function refresh(){
  setPill("", "connecting…");
  gql(QUERY).then(function(data){
    var modeLabel = dataMode === "live"
      ? "live · direct indexer"
      : ("snapshot · updated " + (lastFetchedAt ? new Date(lastFetchedAt).toLocaleString() : "recently"));
    setPill("on", modeLabel);
    renderStats(data);
    renderBlocks(data.blocks);
  }).catch(function(err){
    setPill("err", "indexer unreachable");
    els.blocksBody.innerHTML = '<tr><td colspan="4" class="perror">Could not load chain data (' +
      String(err && err.message || err) + '). Direct indexer is CORS-locked to official domains; the same-origin snapshot was also unreachable. Retrying…</td></tr>';
    els.chartNote.textContent = "Daily activity unavailable — snapshot and indexer both failed.";
  });
}

function boot(){
  els = {
    livePill: $("livePill"), liveText: $("liveText"),
    stHeight: $("stHeight"), stBlockTime: $("stBlockTime"), stTps: $("stTps"),
    stTpsFoot: $("stTpsFoot"), stAccounts: $("stAccounts"), stTxs: $("stTxs"),
    stSupply: $("stSupply"), stSupplyFoot: $("stSupplyFoot"),
    blocksBody: $("blocksBody"), blocksUpdated: $("blocksUpdated"),
    chart: $("activityChart"), tip: $("chartTip"), chartNote: $("chartNote")
  };
  $("donateCopy").addEventListener("click", function(){
    copyText("qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau", $("donateCopy"));
  });
  window.addEventListener("resize", function(){ if (chartData.length) drawChart(); });
  refresh();
  refreshTimer = setInterval(function(){
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  setInterval(tickAges, 10000);
}

if (typeof document !== "undefined"){
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
})();
