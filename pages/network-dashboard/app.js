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

/* Indexer/snapshot boundary (fleet pattern, Batch 23; relations round
 * 2, Batch 36): every field that crosses from the indexer or the
 * snapshot file is validated BEFORE it anchors a stat, a block row,
 * or a chart point. Round 1 validated each field's SHAPE; round 2
 * validates the RELATIONS between fields — the status height must be
 * a plausible chain height and agree with the blocks list's head,
 * kept rows must run newest-first in height and time with no
 * duplicates, every reward must fit the emission schedule for its
 * own height, a day's active accounts cannot exceed all accounts,
 * and the snapshot's capture time must be real. Core status fields
 * and payload-level contradictions reject the whole payload (the
 * caller reads it exactly like a failed fetch — last good telemetry
 * stays, the pill reports the failure); individual rows that are
 * malformed or relationally impossible are dropped, never rendered.
 * The format helpers below are hardened the same way as defense in
 * depth, so a raw value can never reach innerHTML. */
function nonNegInt(v){
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)){
    var n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function validPlancks(v){
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return v.replace(/^0+(?=\d)/, "");
  return null;
}

/* A block hash is an H256: 0x + exactly 64 hex digits (verified against
 * live data/live.json). The hex-only charset is what makes the hash
 * safe to interpolate into the row's data-hash attribute. */
function validHash(v){
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : null;
}

/* The chain did not exist before this floor (mainnet Sept 2026; the
 * fleet-wide genesis floor used by every round-2 validator). A capture
 * time or block time before it is not an early record, it is poison. */
var GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z");

/* Fleet validBlockHeight (round 2): the status height anchors the
 * supply/reward ESTIMATES, so it must be a plausible chain height —
 * a strict safe integer 1..10,000,000. Round 1's nonNegInt accepted 0
 * and MAX_SAFE_INTEGER, and both painted as chain fact. Canonical
 * digit strings are accepted (the indexer serializes counts both
 * ways); booleans, fractions and scientific strings reject. */
function validBlockHeight(v){
  var n;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) n = Number(v);
  else return null;
  return (Number.isSafeInteger(n) && n >= 1 && n <= 10000000) ? n : null;
}

/* A capture time must be real: parseable, not before the chain
 * existed, not in the future. Returns epoch ms or null. */
function validFetchedAt(v, nowMs){
  if (typeof v !== "string") return null;
  var ms = Date.parse(v);
  if (!isFinite(ms)) return null;
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  return (ms >= GENESIS_FLOOR_MS && ms <= now + 3600000) ? ms : null;
}

/* Emission relation (round 2): a block's reward is not a free
 * number. The schedule pays (21M - supply)/50,000,000 — ~0.3066 QTC
 * at genesis, declining from there — and the indexer reports the
 * total rounded to the nearest 0.01 QTC, fees included: live blocks
 * sit at 0.30/0.31 around the ~0.305 model value and fee-bearing
 * blocks reach 0.37. Two bounds follow. The FLOOR is definitional:
 * fees only add, so a reward below the schedule minus the 0.01
 * rounding slack (0.25 when the schedule pays 0.305, or 0 for any
 * mined block) did not come from this chain. The CEILING is a
 * sanity bound, labeled as such: the largest fee deviation observed
 * live is +0.07 QTC, so a block paying more than 0.5 QTC above its
 * schedule is not a fee spike, it is poison (999 QTC included). */
function rewardPlausible(height, rewardPlanckStr){
  var est = blockRewardEst(height);
  if (!isFinite(est)) return false;
  var qtc = Number(rewardPlanckStr) / CHAIN.PLANCK;
  return isFinite(qtc) && qtc >= est - 0.01 && qtc <= est + 0.5;
}

function sanitizeData(data, opts){
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  var st = data.status;
  if (!st || typeof st !== "object" || Array.isArray(st)) return null;
  var height = validBlockHeight(st.block_height);
  var accounts = nonNegInt(st.total_accounts);
  var imm = nonNegInt(st.total_immediate_transfers);
  var sched = nonNegInt(st.total_scheduled_transfers);
  if (height === null || accounts === null || imm === null || sched === null) return null;
  var nowMs = (opts && typeof opts.nowMs === "number" && isFinite(opts.nowMs)) ? opts.nowMs : Date.now();
  /* When the caller knows when this payload was captured (the
   * snapshot's fetched_at, or the live fetch time), that capture
   * time must itself be real, and no block may postdate it. */
  var fetchedMs = null;
  if (opts && opts.fetchedAt !== undefined){
    fetchedMs = validFetchedAt(opts.fetchedAt, nowMs);
    if (fetchedMs === null) return null;
  }
  if (!Array.isArray(data.blocks) || data.blocks.length === 0 || data.blocks.length > BLOCKS_LIMIT) return null;
  /* Head relation: the query asks for the newest blocks first, so a
   * parseable first-row height that disagrees with the status height
   * means the two halves of the payload describe different chain
   * states — the whole answer is poison, not a table with a caveat. */
  var rawHead = (data.blocks[0] && typeof data.blocks[0] === "object" && !Array.isArray(data.blocks[0]))
    ? nonNegInt(data.blocks[0].height) : null;
  if (rawHead !== null && rawHead !== height) return null;
  var blocks = [];
  var seenHeights = {}, seenHashes = {};
  var orderBroken = false;
  data.blocks.forEach(function(b){
    if (orderBroken) return;
    if (!b || typeof b !== "object" || Array.isArray(b)) return;
    var h = nonNegInt(b.height);
    var hash = validHash(b.hash);
    var reward = validPlancks(b.reward);
    if (h === null || hash === null || reward === null) return;
    if (typeof b.timestamp !== "string" || !isFinite(Date.parse(b.timestamp))) return;
    var tsMs = Date.parse(b.timestamp);
    if (h < 1 || h > height) return; /* a block above the claimed head contradicts it */
    if (seenHeights[h] || seenHashes[hash]) return; /* the same block twice is one block */
    if (tsMs < GENESIS_FLOOR_MS || tsMs > nowMs + 3600000) return;
    if (fetchedMs !== null && tsMs > fetchedMs + 120000) return;
    if (!rewardPlausible(h, reward)) return;
    /* Order relation: two otherwise-valid rows that run ascending
     * (in height or in time) contradict the newest-first query —
     * payload-level poison, not a row to quietly drop. */
    if (blocks.length){
      var prev = blocks[blocks.length - 1];
      if (h >= prev.height || tsMs >= Date.parse(prev.timestamp)){ orderBroken = true; return; }
    }
    seenHeights[h] = 1; seenHashes[hash] = 1;
    blocks.push({ height: h, hash: hash, timestamp: b.timestamp, reward: reward });
  });
  if (orderBroken) return null;
  if (!blocks.length) return null; /* every row poisoned: nothing may anchor the stats */
  var dailyRaw = data.daily === undefined ? [] : data.daily;
  if (!Array.isArray(dailyRaw) || dailyRaw.length > DAILY_LIMIT) return null;
  var daily = [];
  var seenDates = {};
  var dailyOrderBroken = false;
  dailyRaw.forEach(function(d){
    if (dailyOrderBroken) return;
    if (!d || typeof d !== "object" || Array.isArray(d)) return;
    var bc = nonNegInt(d.blocks_count);
    var tc = nonNegInt(d.tx_count);
    var aa = nonNegInt(d.active_accounts);
    if (bc === null || tc === null || aa === null) return;
    if (typeof d.date !== "string" || !isFinite(Date.parse(d.date))) return;
    var dateMs = Date.parse(d.date);
    if (dateMs % 86400000 !== 0) return; /* a daily aggregate starts at UTC midnight */
    if (dateMs < GENESIS_FLOOR_MS || dateMs > nowMs + 86400000) return;
    if (aa > accounts) return; /* a day's active accounts are a subset of all accounts */
    if (seenDates[dateMs]) return;
    if (daily.length && dateMs >= Date.parse(daily[daily.length - 1].date)){ dailyOrderBroken = true; return; }
    seenDates[dateMs] = 1;
    daily.push({ date: d.date, blocks_count: bc, tx_count: tc, active_accounts: aa });
  });
  if (dailyOrderBroken) return null;
  if (dailyRaw.length && !daily.length) return null; /* TPS must never be fabricated from an empty set */
  return {
    status: { block_height: height, total_accounts: accounts,
      total_immediate_transfers: imm, total_scheduled_transfers: sched },
    blocks: blocks, daily: daily
  };
}

function fmtInt(n){
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* planck string -> QTC string, trimmed to 4 decimals max.
 * Anything that is not a digit string is not a reward: "—", never a
 * pass-through (pre-fix, non-digit characters rode straight into the
 * blocks table's innerHTML). */
function fmtQTC(planckStr){
  var valid = validPlancks(planckStr);
  if (valid === null) return "—";
  var neg = false, s = valid;
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
  var n = nonNegInt(txCount24h);
  return n === null ? 0 : n / 86400;
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
  var n = nonNegInt(blocks);
  if (n === null) return NaN;
  var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-n / CHAIN.EMISSION_DIVISOR);
  return CHAIN.MAX_SUPPLY - remaining;
}

function blockRewardEst(blocks){
  var n = nonNegInt(blocks);
  if (n === null) return NaN;
  var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-n / CHAIN.EMISSION_DIVISOR);
  return remaining / CHAIN.EMISSION_DIVISOR;
}

function shortHash(h){
  if (typeof h !== "string" || h.length < 18) return "—";
  return h.slice(0, 10) + "…" + h.slice(-8);
}

var API = { fmtInt: fmtInt, fmtQTC: fmtQTC, fmtRewardQTC: fmtRewardQTC, ageFmt: ageFmt,
  tps24h: tps24h, avgBlockGap: avgBlockGap, supplyEst: supplyEst,
  blockRewardEst: blockRewardEst, shortHash: shortHash, CHAIN: CHAIN,
  nonNegInt: nonNegInt, validPlancks: validPlancks, validHash: validHash,
  validBlockHeight: validBlockHeight, validFetchedAt: validFetchedAt,
  rewardPlausible: rewardPlausible, sanitizeData: sanitizeData };
if (typeof module !== "undefined" && module.exports) module.exports = API;

/* ---------------- fetch layer ---------------- */

var SNAPSHOT = "../../data/live.json";

/* Every fetch resolves a self-describing result {data, mode, fetchedAt} —
 * never shared globals: a superseded poll landing late must not be able to
 * relabel (or redate) a newer poll's render through a mutated dataMode. */
function gql(query){
  /* Test hook for headless QA:
   * QA injects window.__qtcdash_mock = {ok:true,data:{...}} before load. */
  if (typeof window !== "undefined" && window.__qtcdash_mock){
    var m = window.__qtcdash_mock;
    return m.ok
      ? Promise.resolve({ data: m.data, mode: "mock", fetchedAt: new Date().toISOString() })
      : Promise.reject(new Error(m.error || "mock indexer failure"));
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
  /* The timer stays armed until the body is parsed: clearing it when the
   * headers land (the old code) left res.json() with no timeout at all, so a
   * stalled body could strand this poll past the 60s refresh interval and
   * into the next poll — the overlap the refresh sequence token now has to
   * defend against. Whatever settles first clears it exactly once. */
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query }),
    signal: ctl.signal
  }).then(function(res){
    if (!res.ok) throw new Error("indexer HTTP " + res.status);
    return res.json();
  }).then(function(json){
    clearTimeout(timer);
    if (json.errors) throw new Error("indexer: " + json.errors[0].message);
    return { data: json.data, mode: "live", fetchedAt: new Date().toISOString() };
  }).catch(function(err){
    clearTimeout(timer);
    throw err;
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
    /* The snapshot's capture time is itself indexer-adjacent data:
     * a pre-genesis or future fetched_at would defeat the pill's
     * freshness label and the block-time ceiling alike — reject it
     * like any other failed fetch. */
    if (validFetchedAt(payload.fetched_at) === null) throw new Error("snapshot capture time invalid");
    return { data: payload.data, mode: "snapshot", fetchedAt: payload.fetched_at };
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
  var rewardEst = blockRewardEst(st.block_height || 0);
  els.stSupplyFoot.textContent = "est. · block reward ≈ " + (isFinite(rewardEst) ? rewardEst.toFixed(3) : "—") + " QTC";

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
var refreshSeq = 0;
var displayedHeight = null; /* block height of the telemetry currently on screen */
var lastGoodLabel = null;

function incomingHeight(data){
  var st = data && data.status;
  if (st && typeof st.block_height === "number") return st.block_height;
  var blocks = (data && data.blocks) || [];
  return blocks.length && typeof blocks[0].height === "number" ? blocks[0].height : null;
}

function refresh(){
  var mySeq = ++refreshSeq;
  setPill("", "connecting…");
  gql(QUERY).then(function(result){
    /* A superseded poll renders nothing: its slow snapshot (or its failure)
     * must not paint over a newer poll's fresher telemetry. */
    if (mySeq !== refreshSeq) return;
    /* Boundary: no field renders until the whole payload validates.
     * A malformed answer is thrown into the catch below and read
     * exactly like a failed fetch — last good telemetry stays on
     * screen, the pill reports the failure, nothing is fabricated. */
    var data = sanitizeData(result.data, { fetchedAt: result.fetchedAt, nowMs: Date.now() });
    if (!data) throw new Error("malformed chain data");
    var h = incomingHeight(data);
    if (result.mode === "snapshot" && h !== null && displayedHeight !== null && h < displayedHeight){
      /* The snapshot file is refreshed only periodically, so a current poll
       * whose direct call failed can carry a height older than the one
       * already on screen. Discard it instead of regressing the dashboard;
       * a direct (live) result is the indexer's own word and renders as-is. */
      if (lastGoodLabel) setPill("on", lastGoodLabel);
      return;
    }
    var modeLabel = result.mode === "live"
      ? "live · direct indexer"
      : ("snapshot · updated " + (result.fetchedAt ? new Date(result.fetchedAt).toLocaleString() : "recently"));
    setPill("on", modeLabel);
    lastGoodLabel = modeLabel;
    renderStats(data);
    renderBlocks(data.blocks);
    if (h !== null) displayedHeight = h;
  }).catch(function(err){
    if (mySeq !== refreshSeq) return;
    setPill("err", "indexer unreachable");
    /* Keep last good telemetry on screen — the pill carries the failure.
     * Only a dashboard that has never rendered paints the error row. */
    if (displayedHeight !== null) return;
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
