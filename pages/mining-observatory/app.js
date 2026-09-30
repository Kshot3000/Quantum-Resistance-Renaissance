/* QTC Mining Observatory — miner decentralization measured from real mainnet coinbase data.
 * Reads the server-side snapshot ../../data/miners.json (the Subsquid indexer allowlists only
 * explorer.quantus.com / quantus.com for browser CORS, so community Pages apps read a snapshot).
 *
 * Math: Nakamoto coefficient = smallest n miners with cumulative share > 50%.
 *        Herfindahl index (HHI) = sum of squared shares on a 0-100 scale (0-10,000).
 *        DOJ bands: <1,500 competitive · 1,500-2,500 moderately concentrated · >2,500 highly concentrated.
 * Honesty: coinbase address != entity. A pool pays many rigs through one address; one operator can
 * split across many. This measures ADDRESS-level concentration — a floor, not a roster of people.
 */
var SNAPSHOT_URL = "../../data/miners.json";
var SIG = "#ff7849", SIG_DEEP = "#e0521f", TEAL = "#2dd4bf", DANGER = "#ff3b5c", OK = "#34d399";
var MUTED = "#8f97b8", INK = "#eef2ff";

/* ---------------- pure math (node-tested) ---------------- */

function sortedShares(counts, total){
  // counts: {address: blocks} | [{address, blocks}]  -> [{address, blocks, share}] desc
  var rows = Array.isArray(counts)
    ? counts.map(function(m){ return { address: m.address, blocks: m.blocks }; })
    : Object.keys(counts).map(function(a){ return { address: a, blocks: counts[a] }; });
  rows.sort(function(a, b){ return b.blocks - a.blocks; });
  return rows.map(function(r){
    return { address: r.address, blocks: r.blocks, share: total > 0 ? (r.blocks / total) * 100 : 0 };
  });
}

function nakamotoCoefficient(rows){
  var cum = 0;
  for (var i = 0; i < rows.length; i++){
    cum += rows[i].share;
    if (cum > 50) return i + 1;
  }
  return rows.length; // never crossed: every miner counts
}

function herfindahl(rows){
  return rows.reduce(function(t, r){ return t + r.share * r.share; }, 0);
}

function hhiBand(h){
  if (h < 1500) return { label: "Competitive", cls: "ok" };
  if (h <= 2500) return { label: "Moderately concentrated", cls: "" };
  return { label: "Highly concentrated", cls: "danger" };
}

function cumulative(rows){
  var cum = 0;
  return rows.map(function(r, i){
    cum += r.share;
    return { rank: i + 1, cum: cum };
  });
}

function bucketStats(bucket){
  var entries = Object.keys(bucket.miners).map(function(a){
    return { address: a, blocks: bucket.miners[a] };
  });
  var rows = sortedShares(entries, bucket.blocks);
  return {
    distinct: rows.length,
    hhi: herfindahl(rows),
    topShare: rows.length ? rows[0].share : 0,
    topAddr: rows.length ? rows[0].address : null,
  };
}

function fmtAddr(a){
  if (!a || a.length < 14) return a || "";
  return a.slice(0, 6) + "…" + a.slice(-5);
}

function timeAgo(iso){
  var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + "s ago";
  var m = Math.floor(s / 60);
  if (m < 60) return m + " min ago";
  var h = Math.floor(m / 60);
  if (h < 48) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function num(n){ return Number(n).toLocaleString("en-US"); }
function pct(x, d){ return x.toFixed(d === undefined ? 1 : d) + "%"; }

/* ---------------- data ---------------- */

function loadData(){
  /* Test hook for headless QA: window.__qtcminers_mock = full snapshot payload */
  if (typeof window !== "undefined" && window.__qtcminers_mock){
    return Promise.resolve(window.__qtcminers_mock);
  }
  return fetch(SNAPSHOT_URL, { cache: "no-store" }).then(function(res){
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

function buildViews(data){
  var wrows = sortedShares(data.window_miners, data.window.block_count);
  var arows = sortedShares(data.all_time, data.chain_height);
  return {
    window: { rows: wrows, total: data.window.block_count, label: "recent 15,000-block window" },
    alltime: { rows: arows, total: data.chain_height, label: "all-time (genesis → snapshot)" },
  };
}

/* ---------------- canvas helpers ---------------- */

function fitCanvas(cv, h){
  var dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  var w = cv.clientWidth || 800;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  var ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, w: w, h: h };
}

function axes(ctx, w, h, pad){
  ctx.strokeStyle = "rgba(143,151,184,.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b);
  ctx.stroke();
}

function drawCurve(cv, rows, nak){
  var f = fitCanvas(cv, 320), ctx = f.ctx, w = f.w, h = f.h;
  var pad = { l: 52, r: 18, t: 18, b: 34 };
  axes(ctx, w, h, pad);
  var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  var n = rows.length;
  var X = function(i){ return pad.l + (n <= 1 ? 0 : (i / (n - 1))) * iw; };
  var Y = function(v){ return pad.t + ih - Math.min(100, v) / 100 * ih; };

  // 51% line
  ctx.strokeStyle = DANGER; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(pad.l, Y(51)); ctx.lineTo(w - pad.r, Y(51)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = DANGER; ctx.font = "11px Inter, sans-serif";
  ctx.fillText("51% — majority line", pad.l + 8, Y(51) - 7);

  // filled curve
  var cum = 0;
  var grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, "rgba(255,120,73,.4)"); grad.addColorStop(1, "rgba(255,120,73,.02)");
  ctx.beginPath(); ctx.moveTo(X(0), h - pad.b);
  rows.forEach(function(r, i){ cum += r.share; ctx.lineTo(X(i), Y(cum)); });
  ctx.lineTo(X(n - 1), h - pad.b); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // curve line
  cum = 0;
  ctx.beginPath();
  rows.forEach(function(r, i){ cum += r.share; var x = X(i), y = Y(cum); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = SIG; ctx.lineWidth = 2.5; ctx.stroke();

  // Nakamoto marker
  if (nak >= 1 && nak <= n){
    var cn = 0;
    for (var i = 0; i < nak; i++) cn += rows[i].share;
    var mx = X(nak - 1), my = Y(cn);
    ctx.fillStyle = DANGER;
    ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,59,92,.4)"; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = INK; ctx.font = "bold 12px Inter, sans-serif";
    var label = "Nakamoto = " + nak;
    ctx.fillText(label, Math.min(mx + 12, w - pad.r - ctx.measureText(label).width - 4), my - 10);
  }

  // axis ticks
  ctx.fillStyle = MUTED; ctx.font = "11px Inter, sans-serif";
  [0, 25, 50, 75, 100].forEach(function(v){
    ctx.fillText(v + "%", 8, Y(v) + 4);
    ctx.strokeStyle = "rgba(143,151,184,.12)";
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
  });
  ctx.fillText("rank 1", pad.l, h - 12);
  ctx.fillText("rank " + n, w - pad.r - 52, h - 12);
}

function drawHhi(cv, buckets){
  var f = fitCanvas(cv, 240), ctx = f.ctx, w = f.w, h = f.h;
  var pad = { l: 52, r: 18, t: 18, b: 30 };
  var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  var Y = function(v){ return pad.t + ih - Math.min(10000, v) / 10000 * ih; };
  var X = function(i){ return pad.l + (buckets.length <= 1 ? 0 : (i / (buckets.length - 1))) * iw; };

  // DOJ bands
  ctx.fillStyle = "rgba(52,211,153,.07)";
  ctx.fillRect(pad.l, Y(1500), iw, Y(0) - Y(1500));
  ctx.fillStyle = "rgba(255,120,73,.07)";
  ctx.fillRect(pad.l, Y(2500), iw, Y(1500) - Y(2500));
  ctx.fillStyle = "rgba(255,59,92,.08)";
  ctx.fillRect(pad.l, pad.t, iw, Y(2500) - pad.t);
  ctx.fillStyle = MUTED; ctx.font = "10.5px Inter, sans-serif";
  ctx.fillText("DOJ: highly concentrated > 2,500", pad.l + 8, Y(2500) - 6);
  ctx.fillText("moderate 1,500–2,500", pad.l + 8, Y(1500) - 6);

  axes(ctx, w, h, pad);
  ctx.beginPath();
  buckets.forEach(function(b, i){
    var s = bucketStats(b);
    var x = X(i), y = Y(s.hhi);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = SIG; ctx.lineWidth = 2.5; ctx.stroke();
  buckets.forEach(function(b, i){
    var s = bucketStats(b);
    ctx.fillStyle = s.hhi > 2500 ? DANGER : (s.hhi >= 1500 ? SIG : OK);
    ctx.beginPath(); ctx.arc(X(i), Y(s.hhi), 3.2, 0, Math.PI * 2); ctx.fill();
  });

  ctx.fillStyle = MUTED; ctx.font = "11px Inter, sans-serif";
  [0, 2500, 5000, 7500, 10000].forEach(function(v){
    ctx.fillText(num(v), 6, Y(v) + 4);
  });
  var step = Math.ceil(buckets.length / 6);
  buckets.forEach(function(b, i){
    if (i % step === 0 || i === buckets.length - 1)
      ctx.fillText("#" + num(b.start), X(i) - 18, h - 10);
  });
}

function drawField(cv, buckets){
  var f = fitCanvas(cv, 240), ctx = f.ctx, w = f.w, h = f.h;
  var pad = { l: 52, r: 52, t: 18, b: 30 };
  var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  var bw = iw / buckets.length;
  var maxD = Math.max.apply(null, buckets.map(function(b){ return bucketStats(b).distinct; }).concat([1]));

  // bars: distinct miners (left axis)
  buckets.forEach(function(b, i){
    var s = bucketStats(b);
    var bh = (s.distinct / maxD) * ih;
    ctx.fillStyle = "rgba(45,212,191,.55)";
    var x = pad.l + i * bw + bw * 0.18;
    ctx.fillRect(x, pad.t + ih - bh, bw * 0.64, bh);
  });

  // line: top-miner share % (right axis 0-100)
  ctx.beginPath();
  buckets.forEach(function(b, i){
    var s = bucketStats(b);
    var x = pad.l + i * bw + bw / 2;
    var y = pad.t + ih - (s.topShare / 100) * ih;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = DANGER; ctx.lineWidth = 2; ctx.stroke();
  buckets.forEach(function(b, i){
    var s = bucketStats(b);
    ctx.fillStyle = DANGER;
    ctx.beginPath(); ctx.arc(pad.l + i * bw + bw / 2, pad.t + ih - (s.topShare / 100) * ih, 2.6, 0, Math.PI * 2); ctx.fill();
  });

  axes(ctx, w, h, pad);
  ctx.fillStyle = MUTED; ctx.font = "11px Inter, sans-serif";
  ctx.fillText("miners", 8, pad.t + 4);
  ctx.fillText("top %", w - 44, pad.t + 4);
  for (var g = 0; g <= 4; g++){
    var v = g * 25;
    var y = pad.t + ih - (v / 100) * ih;
    ctx.fillStyle = "rgba(255,59,92,.75)";
    ctx.fillText(v + "%", w - 40, y + 4);
  }
  var step = Math.ceil(buckets.length / 6);
  ctx.fillStyle = MUTED;
  buckets.forEach(function(b, i){
    if (i % step === 0 || i === buckets.length - 1)
      ctx.fillText("#" + num(b.start), pad.l + i * bw - 10, h - 10);
  });
}

/* ---------------- render ---------------- */

var DATA = null, VIEWS = null, VIEW = "window", EXPANDED = false;

function el(id){ return document.getElementById(id); }

function setKpi(id, value, cls){
  var e = el(id);
  e.textContent = value;
  e.className = "v" + (cls ? " " + cls : "");
}

function render(view){
  VIEW = view;
  EXPANDED = false;
  var v = VIEWS[view];
  var rows = v.rows, total = v.total;
  var nak = nakamotoCoefficient(rows);
  var hhi = herfindahl(rows);
  var band = hhiBand(hhi);

  el("view-window").classList.toggle("on", view === "window");
  el("view-alltime").classList.toggle("on", view === "alltime");
  el("view-window").setAttribute("aria-pressed", view === "window");
  el("view-alltime").setAttribute("aria-pressed", view === "alltime");

  setKpi("stat-nakamoto", nak, nak === 1 ? "danger" : (nak <= 3 ? "" : "ok"));
  el("stat-nakamoto-sub").textContent = "miners to pass 50% · " + v.label;
  setKpi("stat-hhi", num(Math.round(hhi)), band.cls);
  el("stat-hhi-band").textContent = band.label + " · DOJ band";
  setKpi("stat-top", pct(rows[0] ? rows[0].share : 0), rows[0] && rows[0].share > 50 ? "danger" : "");
  setKpi("stat-distinct", num(rows.length));
  el("stat-distinct-sub").textContent = view === "window" ? "coinbase addresses · 15k blocks" : "coinbase addresses · all-time";
  setKpi("stat-blocks", num(total));

  // curve
  drawCurve(el("curve-chart"), rows, nak);
  var top = rows[0];
  el("curve-readout").textContent = nak === 1
    ? "One address — " + fmtAddr(top.address) + " — mined " + pct(top.share) + " of blocks: the 51% line is crossed at rank 1."
    : "It takes the top " + nak + " miners to cross 51%; the largest holds " + pct(top.share) + ".";
  el("curve-note").innerHTML = "Computed over <strong>" + num(total) + " blocks</strong> (" + v.label + "). " +
    "Steep early curve = concentrated; a flatter, longer tail = decentralized.";

  // table
  renderTable(rows, nak);

  // timeline (window only)
  var tl = el("timeline-card");
  if (view === "window" && DATA.buckets && DATA.buckets.length > 1){
    tl.style.display = "";
    drawHhi(el("hhi-chart"), DATA.buckets);
    drawField(el("field-chart"), DATA.buckets);
    var stats = DATA.buckets.map(bucketStats);
    var avgHhi = stats.reduce(function(t, s){ return t + s.hhi; }, 0) / stats.length;
    var minD = Math.min.apply(null, stats.map(function(s){ return s.distinct; }));
    var maxD = Math.max.apply(null, stats.map(function(s){ return s.distinct; }));
    var bucketHrs = DATA.window.observed_block_time_s
      ? (DATA.buckets[0].blocks * DATA.window.observed_block_time_s / 3600).toFixed(1) : "—";
    el("timeline-note").innerHTML = "Each bucket ≈ <strong>" + num(DATA.buckets[0].blocks) + " blocks (~" + bucketHrs + "h)</strong>. " +
      "Mean HHI across buckets: <strong>" + num(Math.round(avgHhi)) + "</strong> (" + hhiBand(avgHhi).label.toLowerCase() + "). " +
      "Distinct miners per bucket ranged <strong>" + minD + "–" + maxD + "</strong>.";
  } else {
    tl.style.display = "none";
  }
}

function renderTable(rows, nak){
  var tb = el("miner-rows");
  var limit = EXPANDED ? rows.length : Math.min(viewLimit(), rows.length);
  var html = "";
  var cum = 0;
  for (var i = 0; i < limit; i++){
    var r = rows[i];
    cum += r.share;
    var hot = i < nak;
    html += "<tr" + (hot ? ' class="cutoff"' : "") + ">" +
      "<td class=\"" + (hot ? "rank-hot" : "") + "\">" + (i + 1) + "</td>" +
      "<td><span class=\"addr-cell\"><code title=\"" + r.address + "\">" + fmtAddr(r.address) + "</code>" +
      "<button class=\"mini\" data-copy=\"" + r.address + "\" title=\"Copy full address\">copy</button>" +
      "<a class=\"ext\" href=\"../block-explorer/#/account/" + r.address + "\" title=\"Open in Block Explorer\">explorer ↗</a>" +
      "</span></td>" +
      "<td>" + num(r.blocks) + "</td>" +
      "<td><span class=\"share-bar\"><i style=\"width:" + Math.max(2, r.share) + "%\"></i></span> " + pct(r.share) + "</td>" +
      "<td>" + pct(cum) + "</td></tr>";
  }
  tb.innerHTML = html;
  var more = el("more-miners");
  if (rows.length > limit){
    more.hidden = false;
    more.textContent = "Show all " + num(rows.length) + " miners";
  } else {
    more.hidden = true;
  }
  el("leaderboard-note").innerHTML = "<strong>" + num(rows.length) + "</strong> distinct coinbase addresses. " +
    "Highlighted rows are the Nakamoto set — together they clear 51%. " +
    (nak === 1 ? "A single address holds the majority: chain liveness currently depends on one operator's continued mining."
               : "No single address holds a majority in this view.");
}

function viewLimit(){ return VIEW === "window" ? 15 : 25; }

function snapshotLine(){
  var age = timeAgo(DATA.fetched_at);
  var stale = (Date.now() - new Date(DATA.fetched_at).getTime()) > 12 * 3600 * 1000;
  el("stat-snapshot").textContent = "#" + num(DATA.chain_height);
  el("stat-snapshot").className = "v" + (stale ? " danger" : "");
  el("stat-snapshot-sub").textContent = "fetched " + age + (stale ? " · STALE" : "");
  var hrs = DATA.window.observed_block_time_s
    ? (DATA.window.block_count * DATA.window.observed_block_time_s / 3600).toFixed(1) : "—";
  el("hero-note").innerHTML = "Snapshot <code>data/miners.json</code> · chain height <strong>#" + num(DATA.chain_height) + "</strong> · " +
    "window <strong>#" + num(DATA.window.start_height) + "–#" + num(DATA.window.end_height) + "</strong> " +
    "(" + num(DATA.window.block_count) + " blocks ≈ " + hrs + "h at " +
    (DATA.window.observed_block_time_s ? DATA.window.observed_block_time_s.toFixed(1) : "—") + "s/block) · fetched " + age + ". " +
    "Source: the public Subsquid indexer; refreshed hourly server-side because the indexer allowlists only explorer.quantus.com / quantus.com for browser CORS." +
    (stale ? " <strong style=\"color:#ff3b5c\">Snapshot is over 12h old — treat figures as dated.</strong>" : "");
}

function showError(msg){
  ["stat-nakamoto","stat-hhi","stat-top","stat-distinct","stat-blocks","stat-snapshot"].forEach(function(id){
    el(id).textContent = "—";
  });
  el("hero-note").innerHTML = "";
  var d = document.createElement("div");
  d.className = "status-err";
  d.innerHTML = "<strong>Could not load the miner snapshot.</strong> " + msg +
    " This station reads <code>../../data/miners.json</code>, generated hourly by <code>scripts/fetch-miner-data.mjs</code>. No figures are shown rather than stale or invented ones.";
  el("hero-note").appendChild(d);
  el("timeline-card").style.display = "none";
}

/* ---------------- ambient radar grain ---------------- */

function initGrain(){
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var cv = document.getElementById("sigrain"); if (!cv) return;
  var ctx = cv.getContext("2d"), W, H, parts = [];
  function size(){ W = cv.width = innerWidth; H = cv.height = innerHeight; }
  size(); addEventListener("resize", size);
  for (var i = 0; i < 46; i++){
    parts.push({ x: Math.random(), y: Math.random(), r: Math.random() * 1.8 + .6,
      s: Math.random() * .00016 + .00004, a: Math.random() * .5 + .15,
      teal: Math.random() < .3 });
  }
  (function tick(){
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < parts.length; i++){
      var p = parts[i];
      p.y -= p.s; if (p.y < -0.02){ p.y = 1.02; p.x = Math.random(); }
      var tw = p.a * (0.6 + 0.4 * Math.sin(Date.now() / 900 + i));
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.teal ? "rgba(45,212,191," + tw.toFixed(3) + ")" : "rgba(255,120,73," + tw.toFixed(3) + ")";
      ctx.fill();
    }
    requestAnimationFrame(tick);
  })();
}

/* ---------------- init ---------------- */

function init(){
  // delegated copy buttons (static + dynamically rendered rows)
  document.addEventListener("click", function(ev){
    var btn = ev.target.closest ? ev.target.closest("[data-copy]") : null;
    if (!btn) return;
    var v = btn.getAttribute("data-copy");
    function done(){
      var t = btn.textContent; btn.textContent = "copied ✓";
      setTimeout(function(){ btn.textContent = t; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done);
    else done();
  });

  el("view-window").addEventListener("click", function(){ if (DATA) render("window"); });
  el("view-alltime").addEventListener("click", function(){ if (DATA) render("alltime"); });
  el("more-miners").addEventListener("click", function(){
    EXPANDED = true;
    var v = VIEWS[VIEW];
    renderTable(v.rows, nakamotoCoefficient(v.rows));
  });
  var rz;
  window.addEventListener("resize", function(){
    clearTimeout(rz);
    rz = setTimeout(function(){ if (DATA) render(VIEW); }, 250);
  });

  loadData().then(function(data){
    if (!data || !data.ok) throw new Error("snapshot payload missing or not ok");
    DATA = data;
    VIEWS = buildViews(data);
    snapshotLine();
    render("window");
  }).catch(function(e){
    showError(e.message || String(e));
  });
  initGrain();
}

if (typeof document !== "undefined" && document.readyState !== "loading") init();
else if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init());

/* Node export for tests */
if (typeof module !== "undefined" && module.exports){
  module.exports = {
    sortedShares: sortedShares,
    nakamotoCoefficient: nakamotoCoefficient,
    herfindahl: herfindahl,
    hhiBand: hhiBand,
    cumulative: cumulative,
    bucketStats: bucketStats,
    fmtAddr: fmtAddr,
    timeAgo: timeAgo,
  };
}
