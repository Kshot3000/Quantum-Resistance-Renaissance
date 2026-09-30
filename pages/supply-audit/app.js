/* QTC Supply Audit — UI layer (DOM, charts, data loading).
 * Exact math lives in js/audit-core.js (window.QTCAudit), shared with the
 * node unit tests. This file only renders.
 */
(function(){
"use strict";
var A = window.QTCAudit;
function $(id){ return document.getElementById(id); }
function shortAddr(a){
  return A.esc(a.slice(0,10)) + "…" + A.esc(a.slice(-6));
}

/* ================= data loading ================= */
function gqlQuery(){
  return `query {
    status: chain_stats_by_pk(id: "global") { block_height total_accounts }
    totals: account_aggregate { aggregate { count sum { free reserved frozen } } }
    mined: miner_reward_aggregate { aggregate { count sum { reward } } }
    vestAgg: vesting_schedule_aggregate { aggregate { count sum { total claimed } } }
    genesis: transfer(where: { block_height: { _eq: 1 } }, order_by: { amount: desc }, limit: 100) { amount from_id to_id }
    mintAcct: account_by_pk(id: "${A.MINT_SENTINEL}") { id free }
    mintOutRecent: transfer_aggregate(where: { from_id: { _eq: "${A.MINT_SENTINEL}" }, block_height: { _gt: 1 } }) { aggregate { count sum { amount } } }
  }`;
}
function toSnapshot(core, fetchedAt, poolFree){
  return {
    ok: true, source: A.ENDPOINT, fetched_at: fetchedAt, live: true,
    block_height: core.status.block_height,
    accounts_total: core.totals.aggregate.count,
    mint_sentinel_id: A.MINT_SENTINEL,
    genesis: {
      count: core.genesis.length,
      total_plancks: core.genesis.reduce(function(a,t){ return a + BigInt(t.amount); }, 0n).toString(),
      transfers: core.genesis.map(function(t){ return { amount_plancks: t.amount, from: t.from_id, to: t.to_id }; })
    },
    mined: { reward_events: core.mined.aggregate.count, total_plancks: core.mined.aggregate.sum.reward },
    balances_plancks: {
      free: core.totals.aggregate.sum.free,
      reserved: core.totals.aggregate.sum.reserved,
      frozen: core.totals.aggregate.sum.frozen
    },
    vesting: {
      schedules: core.vestAgg.aggregate.count,
      total_plancks: core.vestAgg.aggregate.sum.total,
      claimed_plancks: core.vestAgg.aggregate.sum.claimed,
      pool_account: core.genesis.length ? core.genesis[0].to_id : null,
      pool_free_plancks: poolFree
    },
    mint_sentinel: {
      free_plancks: core.mintAcct ? core.mintAcct.free : "0",
      out_nongenesis_count: core.mintOutRecent.aggregate.count,
      out_nongenesis_plancks: core.mintOutRecent.aggregate.sum.amount
    }
  };
}
async function fetchJson(url, timeoutMs){
  var ctrl = new AbortController();
  var t = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 9000);
  try {
    var r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function loadSupply(){
  try {
    var ctrl = new AbortController();
    var t = setTimeout(function(){ ctrl.abort(); }, 8000);
    var r = await fetch(A.ENDPOINT, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: gqlQuery() })
    });
    clearTimeout(t);
    if (!r.ok) throw new Error("HTTP " + r.status);
    var j = await r.json();
    if (j.errors) throw new Error("GraphQL error");
    var core = j.data, poolFree = null;
    try {
      var pq = await fetch(A.ENDPOINT, { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `query { account_by_pk(id: "${core.genesis[0].to_id}") { free } }` }) });
      var pj = await pq.json();
      poolFree = pj.data && pj.data.account_by_pk ? pj.data.account_by_pk.free : null;
    } catch (e) {}
    return toSnapshot(core, new Date().toISOString(), poolFree);
  } catch (e) {
    var snap = await fetchJson("../../data/supply.json");
    snap.live = false;
    return snap;
  }
}

/* ================= rendering ================= */
function renderHero(a, d){
  $("f-protocol").textContent = A.fmtQtc(a.base.supply) + " QTC";
  $("f-recorded").textContent = A.fmtQtc(a.recorded) + " QTC";
  $("f-reported").textContent = A.fmtQtc(a.bal) + " QTC";
  $("f-gap").textContent = "+" + A.fmtQtc(a.gap) + " QTC";
  $("f-height").textContent = A.fmtInt(a.h);
  $("data-mode").textContent = (d.live ? "live · " : "snapshot · ") + new Date(d.fetched_at).toLocaleString();
}
function renderVerdict(a, d){
  var gapTxt = "+" + A.fmtQtc(a.gap) + " QTC";
  $("v-gap-inline").textContent = gapTxt;
  $("v-gap2").textContent = gapTxt;
  $("v-gap-pct").textContent = (Number(a.gap * 1000000n / a.bal) / 10000).toFixed(3) + "%";
  $("v-first-reward").textContent = A.fmtInt(300000000000) + " plancks";
  $("v-first-note").textContent = "(matches the indexer's first MinerRewarded event to the planck)";
  $("v-genesis").textContent = A.fmtQtc(a.s0) + " QTC";
  $("v-sentinel").textContent = d.mint_sentinel_id;
  $("v-sentinel-out").textContent = A.fmtQtc(a.sentinelOut) + " QTC";
  $("v-sentinel-x").textContent = (Number(a.sentinelOut * 1000n / a.mined) / 1000).toFixed(3) + "×";
  $("v-true-supply").textContent = A.fmtQtc(a.recorded) + " QTC";
}
function renderLedgers(a, d){
  $("l1-s0").textContent = A.fmtQtc(a.s0) + " QTC";
  $("l1-h").textContent = A.fmtInt(a.h);
  $("l1-total").textContent = A.fmtQtc(a.base.supply) + " QTC";
  $("l1-reward").textContent = A.fmtQtc(a.subsidy) + " QTC";
  $("l2-genesis").textContent = A.fmtQtc(a.s0) + " QTC";
  $("l2-n").textContent = A.fmtInt(d.mined.reward_events);
  $("l2-mined").textContent = A.fmtQtc(a.mined) + " QTC";
  $("l2-fees").textContent = "+" + A.fmtQtc(a.feeWedge) + " QTC";
  $("l2-total").textContent = A.fmtQtc(a.recorded) + " QTC";
  $("l3-free").textContent = A.fmtQtc(BigInt(d.balances_plancks.free)) + " QTC";
  $("l3-res").textContent = A.fmtQtc(BigInt(d.balances_plancks.reserved)) + " QTC";
  $("l3-fro").textContent = A.fmtQtc(BigInt(d.balances_plancks.frozen)) + " QTC";
  $("l3-acct").textContent = A.fmtInt(d.accounts_total);
  $("l3-total").textContent = A.fmtQtc(a.bal) + " QTC";
  $("r-gap").textContent = "+" + A.fmtQtc(a.gap) + " QTC";
  $("r-pct").textContent = (Number(a.gap * 1000000n / a.bal) / 10000).toFixed(3) + "%";
  $("r-rate").textContent = "≈ " + A.fmtQtc(a.subsidy) + " QTC / block (one reward per block)";
  $("r-mult").textContent = (Number(a.sentinelOut * 1000n / a.mined) / 1000).toFixed(3) + "×";
}
function renderGenesis(a, d){
  $("g-total").textContent = A.fmtQtc(a.s0) + " QTC";
  var html = "";
  d.genesis.transfers.forEach(function(t, i){
    var note = (i === 0) ? "Genesis vesting pool" : "Grant — purpose not labeled on-chain";
    html += "<tr" + (i === 0 ? " class=\"hl\"" : "") + "><td>" + (i+1) + "</td><td>" +
      A.fmtQtc(BigInt(t.amount_plancks)) + "</td>" +
      "<td class=\"addr\">" + shortAddr(t.from) + "</td>" +
      "<td class=\"addr\">" + shortAddr(t.to) + "</td><td>" + A.esc(note) + "</td></tr>";
  });
  document.querySelector("#genesis-table tbody").innerHTML = html;
  $("g-pct").textContent = (Number(a.s0 * 1000000000n / A.MAX_SUPPLY) / 10000000).toFixed(7) + "%";
  $("g-vest-n").textContent = A.fmtInt(d.vesting.schedules);
  $("g-vest-c").textContent = A.fmtQtc(a.vestClaimed) + " / " + A.fmtQtc(a.vestTotal) + " QTC";
  var el = $("g-pool");
  if (a.poolFree != null){
    var diff = a.poolFree - a.unclaimed;
    var adiff = diff < 0n ? -diff : diff;
    var ok = adiff <= 100000000000n; // within 0.1 QTC
    el.textContent = (ok ? "PASS" : "CHECK") + " · Δ " + A.fmtQtc(adiff, 6) + " QTC";
    el.className = "v mono " + (ok ? "ok" : "warn");
  } else {
    el.textContent = "n/a (pool balance unavailable)";
  }
}

/* ================= charts ================= */
function setupCanvas(id, hAttr){
  var c = $(id), dpr = window.devicePixelRatio || 1;
  var w = c.clientWidth || 900;
  c.width = w * dpr; c.height = hAttr * dpr;
  var ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx: ctx, w: w, h: hAttr };
}
function stat(k, v){
  return "<div class=\"stat\"><span class=\"k\">" + A.esc(k) + "</span><span class=\"v mono\">" + A.esc(v) + "</span></div>";
}
function drawCurve(a){
  var s = setupCanvas("ch-curve", 380), ctx = s.ctx, W = s.w, H = s.h;
  var padL = 86, padR = 18, padT = 18, padB = 40;
  var iw = W - padL - padR, ih = H - padT - padB;
  var maxY = Number(a.base.supply / A.PLANCK) * 1.02;
  function X(h){ return padL + (h / a.h) * iw; }
  function Y(qtc){ return padT + ih - (qtc / maxY) * ih; }
  ctx.strokeStyle = "#1c2a20"; ctx.fillStyle = "#93a89a";
  ctx.font = "11px ui-monospace, monospace"; ctx.lineWidth = 1; ctx.textAlign = "right";
  var m;
  for (m = 0; m <= maxY; m += 1000000){
    var y = Y(m);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText((m/1000000).toFixed(1) + "M", padL - 8, y + 4);
  }
  ctx.textAlign = "center";
  [0, 0.25, 0.5, 0.75, 1].forEach(function(f){
    ctx.fillText(A.fmtInt(Math.round(a.h * f)), X(a.h * f), H - 14);
  });
  ctx.fillStyle = "#5b6f61"; ctx.textAlign = "left";
  ctx.fillText("block height →", padL, H - 14);
  ctx.fillText("QTC", 8, padT + 4);
  var yBase = Y(Number(a.base.supply / A.PLANCK)), yRec = Y(Number(a.recorded / A.PLANCK));
  ctx.fillStyle = "rgba(232,197,106,0.16)";
  ctx.fillRect(X(a.h) - 26, yRec, 26, yBase - yRec);
  ctx.beginPath();
  a.base.samples.forEach(function(pt, i){
    var x = X(pt[0]), y = Y(Number(pt[1] / A.PLANCK));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#8fe3b0"; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(X(a.h), yRec, 6, 0, 7);
  ctx.fillStyle = "#e8c56a"; ctx.fill();
  ctx.strokeStyle = "#070a08"; ctx.lineWidth = 2; ctx.stroke();
  ctx.font = "12px ui-monospace, monospace"; ctx.textAlign = "right";
  ctx.fillStyle = "#8fe3b0";
  ctx.fillText("baseline " + A.fmtQtc(a.base.supply, 0), X(a.h) - 34, yBase + 4);
  ctx.fillStyle = "#e8c56a";
  ctx.fillText("recorded " + A.fmtQtc(a.recorded, 0), X(a.h) - 34, yRec - 10);
  $("curve-stats").innerHTML =
    stat("Baseline mining (fee-free)", A.fmtQtc(a.baselineMined) + " QTC") +
    stat("Recorded mining", A.fmtQtc(a.mined) + " QTC") +
    stat("Fee wedge", "+" + A.fmtQtc(a.feeWedge) + " QTC") +
    stat("Wedge share of mining", (Number(a.feeWedge * 10000n / a.mined) / 100).toFixed(2) + "%");
}
function drawRewards(a, blocks){
  var s = setupCanvas("ch-reward", 300), ctx = s.ctx, W = s.w, H = s.h;
  var padL = 70, padR = 18, padT = 18, padB = 40;
  var iw = W - padL - padR, ih = H - padT - padB;
  var sub = Number(a.subsidy) / 1e12; // display only
  var maxY = 0.36, minY = 0.26;
  function Y(v){ return padT + ih - ((v - minY) / (maxY - minY)) * ih; }
  ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "right"; ctx.lineWidth = 1;
  var q;
  for (q = 0.27; q <= 0.361; q += 0.01){
    var y = Y(q);
    ctx.strokeStyle = (Math.abs(q - 0.30) < 1e-9 || Math.abs(q - 0.31) < 1e-9) ? "#2a3d30" : "#182119";
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = "#93a89a";
    ctx.fillText(q.toFixed(2), padL - 8, y + 4);
  }
  var ys = Y(sub);
  ctx.strokeStyle = "#8fe3b0"; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
  ctx.beginPath(); ctx.moveTo(padL, ys); ctx.lineTo(W - padR, ys); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#8fe3b0"; ctx.textAlign = "left"; ctx.font = "12px ui-monospace, monospace";
  ctx.fillText("protocol subsidy " + sub.toFixed(4) + " QTC", padL + 8, ys - 8);
  if (blocks && blocks.length){
    var n = blocks.length;
    blocks.forEach(function(b, i){
      var v = Number(BigInt(b.reward)) / 1e12;
      var x = padL + (i / Math.max(1, n - 1)) * iw;
      ctx.beginPath(); ctx.arc(x, Y(v), 5, 0, 7);
      ctx.fillStyle = "#e8c56a"; ctx.fill();
      ctx.strokeStyle = "#070a08"; ctx.lineWidth = 1.5; ctx.stroke();
    });
    ctx.fillStyle = "#93a89a"; ctx.textAlign = "center"; ctx.font = "11px ui-monospace, monospace";
    ctx.fillText("← older · recent " + n + " blocks · newer →", padL + iw / 2, H - 12);
  } else {
    ctx.fillStyle = "#93a89a"; ctx.textAlign = "center";
    ctx.fillText("recent block data unavailable in this snapshot", padL + iw / 2, padT + ih / 2);
  }
  ctx.fillStyle = "#5b6f61"; ctx.textAlign = "left";
  ctx.fillText("QTC / block", 8, padT + 4);
}

/* ================= ambient ledger rain ================= */
function ledgerRain(){
  var c = $("ledger-rain");
  if (!c) return;
  var ctx = c.getContext("2d");
  function size(){ c.width = innerWidth; c.height = innerHeight; }
  size(); addEventListener("resize", size);
  var glyphs = "0123456789abcdefΣΔλ", cols = [], n = Math.max(20, Math.floor(innerWidth / 26)), i;
  for (i = 0; i < n; i++) cols.push({ x: i * 26, y: Math.random() * innerHeight, v: 12 + Math.random() * 22 });
  ctx.font = "13px ui-monospace, monospace";
  (function tick(){
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "rgba(143,227,176,0.10)";
    for (var k = 0; k < cols.length; k++){
      var col = cols[k];
      ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], col.x, col.y);
      col.y += col.v * 0.16;
      if (col.y > innerHeight + 20){ col.y = -20; col.v = 12 + Math.random() * 22; }
    }
    requestAnimationFrame(tick);
  })();
}

/* ================= tabs ================= */
function initTabs(){
  var btns = document.querySelectorAll(".tabnav button");
  btns.forEach(function(b){
    b.addEventListener("click", function(){
      btns.forEach(function(x){ x.classList.remove("active"); });
      document.querySelectorAll(".tab").forEach(function(t){ t.classList.remove("active"); });
      b.classList.add("active");
      $("tab-" + b.getAttribute("data-tab")).classList.add("active");
      if (b.getAttribute("data-tab") === "curve" && window.__audit) redrawCharts(window.__audit);
    });
  });
}
function redrawCharts(a){
  drawCurve(a);
  drawRewards(a, window.__blocks || null);
}

/* ================= boot ================= */
async function boot(){
  initTabs();
  ledgerRain();
  var d = await loadSupply();
  var blocks = null;
  try {
    var live = await fetchJson("../../data/live.json", 8000);
    if (live && live.data && live.data.blocks) blocks = live.data.blocks;
  } catch (e) {}
  window.__blocks = blocks;
  var t0 = Date.now();
  var a = A.computeAudit(d);
  window.__audit = a;
  window.__supplyData = d;
  renderHero(a, d);
  renderVerdict(a, d);
  renderLedgers(a, d);
  renderGenesis(a, d);
  redrawCharts(a);
  window.__auditMs = Date.now() - t0;
  addEventListener("resize", function(){
    if ($("tab-curve").classList.contains("active")) redrawCharts(a);
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
