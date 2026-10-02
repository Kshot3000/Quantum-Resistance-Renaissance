/* QTC Flow Tracer — UI wiring.
 * Data: tries the live Subsquid indexer first (8s abort); falls back to the
 * same-origin snapshot at ../../data/flows.json. All graph math lives in
 * js/flow-core.js (QFlow); SS58 validation in js/ss58.js (QSS58).
 */
(function () {
"use strict";
var F = window.QFlow, S58 = window.QSS58;
var ENDPOINT = "https://sqm.quantus.com/v1/graphql";
var FIELDS = "id amount from_id to_id block_height timestamp fee extrinsic_id";
// Canonical minting account: runtime/src/configs/mod.rs
// `pub const MintingAccount: AccountId = AccountId::new([1u8; 32]);`
var MINT_SENTINEL = "qzjUYyuN4L3HKmBPMxHvK2n8HYnaLZcQvLSQTgdwB2nQ1g2mc";
var SVGNS = "http://www.w3.org/2000/svg";

var snap = null, snapGraph = null, liveOk = false;
var radar = null; // {peel, fanout, fanin, round, miner}
var lastTrace = null;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function el(tag, attrs, parent) {
  var n = document.createElementNS(SVGNS, tag);
  for (var k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/* ---------------- data ---------------- */
async function gql(query, timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000);
  try {
    var res = await fetch(ENDPOINT, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: query }), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var json = await res.json();
    if (json.errors) throw new Error("GraphQL error");
    return json.data;
  } finally { clearTimeout(t); }
}

/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}

async function loadData() {
  var r = await fetch("../../data/flows.json", { cache: "no-store", signal: timeoutSignal(20000) });
  if (!r.ok) throw new Error("snapshot HTTP " + r.status);
  // flows.json is stored columnar (format v2, assets/flows-decode.js);
  // decode restores the v1 object rows buildGraph expects. v1 files pass
  // through untouched.
  snap = (typeof QFlows !== "undefined" && QFlows.decode) ? QFlows.decode(await r.json()) : await r.json();
  snapGraph = F.buildGraph(snap.transfers);
  var m = snap.meta;
  $("snap-badge").textContent = "snapshot: " + snap.transfers.length.toLocaleString() +
    " transfers · blocks " + m.window_from.toLocaleString() + "–" + m.chain_height.toLocaleString() +
    " + all-time top " + 600 + " · " + m.captured_at.slice(0, 10);
  $("method-window").textContent =
    "Every transfer ≥ 1 QTC in the 15,000 blocks before capture (" +
    m.window_from.toLocaleString() + "–" + m.chain_height.toLocaleString() +
    ", captured " + m.captured_at.slice(0, 16).replace("T", " ") + " UTC), plus the 600 largest " +
    "transfers of all time, plus the full 22-transfer block-1 genesis allocation — " +
    snap.transfers.length.toLocaleString() + " transfers across " +
    new Set(snap.transfers.flatMap(function (t) { return [t.from_id, t.to_id]; })).size.toLocaleString() +
    " addresses.";
  // Live probe (badge only; trace console does its own live attempt per address).
  try {
    await gql("{ status: chain_stats_by_pk(id: \"global\") { block_height } }", 8000);
    liveOk = true;
    $("live-badge").hidden = false;
  } catch (e) { /* sandbox / Pages: snapshot mode */ }
}

/* ---------------- trace ---------------- */
function validAddress(a) {
  a = a.trim();
  if (!/^qz[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(a)) return null;
  try {
    var d = S58.ss58Decode(a);
    if (!d || d.prefix !== S58.QUANTUS_PREFIX) return null;
    return a;
  } catch (e) { return null; }
}

async function liveTraceRows(addr) {
  var q = "{ a: transfer(where: { from_id: { _eq: \"" + addr + "\" } }, order_by: { block_height: desc }, limit: 500) { " + FIELDS + " }" +
          "  b: transfer(where: { to_id: { _eq: \"" + addr + "\" } }, order_by: { block_height: desc }, limit: 500) { " + FIELDS + " } }";
  var d = await gql(q, 8000);
  var seen = new Set(), rows = [];
  (d.a.concat(d.b)).forEach(function (r) { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } });
  return rows;
}

async function doTrace(addr, direction, hops) {
  var status = $("trace-status");
  status.innerHTML = "Tracing <b>" + esc(F.shortAddr(addr)) + "</b>…";
  var graph = snapGraph, mode = "snapshot", rows = null;
  if (liveOk) {
    try {
      rows = await liveTraceRows(addr);
      if (rows.length) { graph = F.buildGraph(rows); mode = "live"; }
    } catch (e) { /* fall through to snapshot */ }
  }
  var t = F.trace(graph, addr, { direction: direction, maxHops: hops, maxNodes: 160 });
  lastTrace = { trace: t, addr: addr, graph: graph, mode: mode };
  renderGraph(t, addr, graph);
  var nAddr = t.nodes.size, nEdge = t.edges.length;
  var truncNote = "";
  if (t.truncated) {
    var caps = [];
    if (t.edgeTruncated) caps.push(nEdge.toLocaleString() + " transfers");
    if (nAddr >= 160) caps.push("160 addresses");
    truncNote = " · <b>truncated at " + (caps.join(" + ") || "trace cap") + "</b> — narrow the hops or direction";
  }
  status.innerHTML = "Trace of <b>" + esc(F.shortAddr(addr)) + "</b>: <b>" + nAddr + "</b> addresses, <b>" +
    nEdge + "</b> transfers, " + hops + " hop" + (hops > 1 ? "s" : "") + " " + esc(direction) +
    " · <span class=\"" + (mode === "live" ? "mode-live" : "mode-snap") + "\">" +
    (mode === "live" ? "live indexer (" + rows.length + " transfers for this address)" : "snapshot dataset") + "</span>" +
    truncNote +
    (nEdge === 0 ? " · <b>no transfers found</b> for this address in the " + mode + " dataset" : "");
  openDossier(addr, graph);
}

function edgeWidth(amount) {
  var qtc = Number(amount / F.PLANCKS_PER_QTC);
  return Math.min(9, 1 + Math.log10(qtc + 1) * 2.2);
}

function renderGraph(t, seed, graph) {
  var svg = $("graph");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var lay = F.layoutTrace(t);
  svg.setAttribute("viewBox", "0 0 " + lay.width + " " + lay.height);
  svg.setAttribute("width", Math.max(600, lay.width));
  svg.setAttribute("height", lay.height);

  var defs = el("defs", {}, svg);
  var grad = el("linearGradient", { id: "bothgrad", x1: "0", y1: "0", x2: "1", y2: "1" }, defs);
  el("stop", { offset: "0", "stop-color": "#7ef0c9" }, grad);
  el("stop", { offset: "1", "stop-color": "#b79bff" }, grad);

  // Aggregate per-node volume + role for sizing/coloring.
  var vol = new Map(), role = new Map();
  t.nodes.forEach(function (n, a) {
    var ins = graph.inn.get(a) || [], outs = graph.out.get(a) || [];
    var v = 0n;
    ins.forEach(function (r) { v += r.amount; });
    outs.forEach(function (r) { v += r.amount; });
    vol.set(a, v);
    role.set(a, ins.length && outs.length ? "both" : ins.length ? "receiver" : "sender");
  });
  role.set(seed, "seed");

  var gE = el("g", { class: "edges" }, svg);
  // One path per ordered pair: parallel transfers are aggregated (summed)
  // so a hub trace stays readable instead of stacking thousands of paths.
  var aggEdges = F.aggregateEdges(t.edges);
  aggEdges.forEach(function (r) {
    var p1 = lay.pos.get(r.from_id), p2 = lay.pos.get(r.to_id);
    if (!p1 || !p2) return;
    var path = el("path", {
      d: "M " + p1.x + " " + p1.y + " C " + (p1.x + 70) + " " + p1.y + ", " + (p2.x - 70) + " " + p2.y + ", " + p2.x + " " + p2.y,
      class: "edge" + (r.genesis ? " genesis" : ""),
      "stroke-width": edgeWidth(r.amount).toFixed(1),
    }, gE);
    var tip = el("title", {}, path);
    tip.textContent = r.count === 1
      ? F.fmtQTC(r.amount) + " QTC · block " + r.lastBlock +
        (r.timestamp ? " · " + F.fmtTime(r.timestamp) : " · genesis") +
        "\n" + F.shortAddr(r.from_id) + " → " + F.shortAddr(r.to_id)
      : F.fmtQTC(r.amount) + " QTC total · " + r.count + " transfers · largest " +
        F.fmtQTC(r.maxAmount) + " QTC · latest block " + r.lastBlock.toLocaleString() +
        "\n" + F.shortAddr(r.from_id) + " → " + F.shortAddr(r.to_id);
    if (aggEdges.length <= 14) {
      var lx = (p1.x + p2.x) / 2, ly = (p1.y + p2.y) / 2 - 6;
      var lab = el("text", { x: lx, y: ly, class: "amt-label", "text-anchor": "middle" }, gE);
      lab.textContent = F.fmtQTC(r.amount, 2);
    }
  });

  var gN = el("g", { class: "nodes" }, svg);
  var colors = { seed: "#f5c453", sender: "#7ef0c9", receiver: "#b79bff", both: "url(#bothgrad)" };
  t.nodes.forEach(function (n, a) {
    var p = lay.pos.get(a);
    var v = vol.get(a) || 0n;
    var rad = Math.min(22, 7 + Math.log10(Number(v / F.PLANCKS_PER_QTC) + 1) * 3);
    var g = el("g", { class: "node" + (a === seed ? " seed" : ""), transform: "translate(" + p.x + "," + p.y + ")" }, gN);
    if (a === MINT_SENTINEL) {
      el("circle", { r: rad + 7, class: "halo", fill: "#ff7d7d" }, g);
    } else if (a === seed) {
      el("circle", { r: rad + 6, class: "halo", fill: "#f5c453" }, g);
    }
    var core = el("circle", {
      r: rad, class: "core",
      fill: a === MINT_SENTINEL ? "#ff7d7d" : colors[role.get(a)] || "#8b95ab",
      stroke: "#07090f", "stroke-width": 2,
    }, g);
    var tip = el("title", {}, g);
    var s = summarizeCached(graph, a);
    tip.textContent = a + "\nin " + F.fmtQTC(s.inTotal) + " (" + s.inCount + ") · out " +
      F.fmtQTC(s.outTotal) + " (" + s.outCount + ")\nclick for dossier";
    var tx = el("text", { y: rad + 15, "text-anchor": "middle" }, g);
    tx.textContent = F.shortAddr(a);
    g.addEventListener("click", function () { openDossier(a, graph); });
    g.style.cursor = "pointer";
  });

  $("graph-wrap").hidden = false;
  $("graph-legend").hidden = false;
}

var dossierCache = new Map();
function summarizeCached(graph, addr) {
  var key = addr + "|" + (graph === snapGraph ? "snap" : "live");
  if (!dossierCache.has(key)) dossierCache.set(key, F.summarizeAddress(graph, addr));
  return dossierCache.get(key);
}

/* ---------------- dossier ---------------- */
function openDossier(addr, graph) {
  graph = graph || snapGraph;
  var s = summarizeCached(graph, addr);
  $("dossier-panel").hidden = false;
  $("dossier-addr").textContent = addr;
  var stats = [
    ["Received", F.fmtQTC(s.inTotal) + " QTC", s.inCount + " transfers", "teal"],
    ["Sent", F.fmtQTC(s.outTotal) + " QTC", s.outCount + " transfers", "violet"],
    ["Net flow", (s.net >= 0n ? "+" : "") + F.fmtQTC(s.net) + " QTC", "in − out in dataset", s.net >= 0n ? "teal" : "gold"],
    ["First seen", s.firstBlock == null ? "—" : "block " + s.firstBlock.toLocaleString(), s.firstTs ? F.fmtTime(s.firstTs) : "genesis (block 1)", ""],
    ["Last seen", s.lastBlock == null ? "—" : "block " + s.lastBlock.toLocaleString(), s.lastTs ? F.fmtTime(s.lastTs) : "genesis (block 1)", ""],
  ];
  if (addr === MINT_SENTINEL) stats.push(["Identity", "Mint sentinel", "canonical coinbase account", "gold"]);
  $("dossier-stats").innerHTML = stats.map(function (st) {
    return '<div class="stat"><div class="stat-label">' + st[0] + '</div><div class="stat-value ' + st[3] + '">' +
      esc(st[1]) + '</div><div class="stat-sub">' + esc(st[2]) + '</div></div>';
  }).join("");
  function cpList(list, cls) {
    if (!list.length) return '<div class="fine">none in dataset</div>';
    return list.map(function (c) {
      return '<div class="cp-row" data-addr="' + esc(c.addr) + '"><span class="addr-link">' + esc(F.shortAddr(c.addr)) +
        '</span><span><span class="amt">' + F.fmtQTC(c.total) + ' QTC</span> <span class="cnt">×' + c.count + '</span></span></div>';
    }).join("");
  }
  $("dossier-senders").innerHTML = cpList(s.topSenders);
  $("dossier-recipients").innerHTML = cpList(s.topRecipients);
  Array.prototype.forEach.call($("dossier-panel").querySelectorAll(".cp-row"), function (row) {
    row.addEventListener("click", function () { openDossier(row.getAttribute("data-addr"), graph); });
  });
  $("dossier-window").textContent = "Totals cover the active dataset only (" +
    (graph === snapGraph ? "snapshot: ≥1 QTC window + all-time top 600 + genesis" : "live per-address query, ≤500 transfers per direction") +
    ") — not a full balance.";
  $("dossier-trace").onclick = function () {
    $("trace-addr").value = addr;
    doTrace(addr, $("trace-dir").value, parseInt($("trace-hops").value, 10));
    $("trace-panel").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "start" });
  };
  if (graph === snapGraph) { /* keep panel in place */ }
}

/* ---------------- pattern radar ---------------- */
function computeRadar() {
  radar = {
    peel: F.detectPeelChains(snapGraph, 3),
    fanout: F.detectFanOut(snapGraph, 5),
    fanin: F.detectFanIn(snapGraph, 5),
    round: F.roundAmountTransfers(snapGraph.rows).slice(0, 30),
    miner: F.minerForwarding(snapGraph, MINT_SENTINEL).slice(0, 25),
  };
  renderRadarTab("peel");
}

function traceBtn(addr, label) {
  return '<button class="btn small ghost" data-trace="' + esc(addr) + '">' + (label || "trace") + '</button>';
}

function renderRadarTab(tab) {
  var body = $("radar-body"), h = "";
  if (tab === "peel") {
    if (!radar.peel.length) h = '<div class="radar-empty">No one-in-one-out chains of ≥3 hops in the dataset.</div>';
    h = radar.peel.slice(0, 20).map(function (c, i) {
      var route = c.path.map(F.shortAddr).join(' <span class="arrow">→</span> ');
      var maxHop = c.hops.reduce(function (m, r) { return r.amount > m ? r.amount : m; }, 0n);
      return '<div class="radar-row"><div class="radar-route"><b>#' + (i + 1) + "</b> " + esc(route) +
        '<div class="peel-bar"><i style="width:' + Math.min(100, c.hops.length * 12) + '%"></i></div></div>' +
        '<div class="radar-meta"><b>' + c.hops.length + ' hops</b> · moved ' + F.fmtQTC(c.moved) +
        ' QTC · blocks ' + c.hops[0].block_height.toLocaleString() + '–' +
        c.hops[c.hops.length - 1].block_height.toLocaleString() + '</div>' +
        traceBtn(c.path[0], "trace chain") + '</div>';
    }).join("") || h;
  } else if (tab === "fanout") {
    h = radar.fanout.slice(0, 20).map(function (f) {
      return '<div class="radar-row"><div class="radar-route"><b>' + esc(F.shortAddr(f.addr)) + '</b> → ' +
        f.distinct + ' distinct recipients</div><div class="radar-meta"><b>' + F.fmtQTC(f.total) +
        ' QTC</b> across ' + f.txs + ' transfers</div>' + traceBtn(f.addr) + '</div>';
    }).join("") || '<div class="radar-empty">No distributor with ≥5 distinct recipients in the dataset.</div>';
  } else if (tab === "fanin") {
    h = radar.fanin.slice(0, 20).map(function (f) {
      return '<div class="radar-row"><div class="radar-route">' + f.distinct +
        ' distinct senders → <b>' + esc(F.shortAddr(f.addr)) + '</b></div><div class="radar-meta"><b>' +
        F.fmtQTC(f.total) + ' QTC</b> across ' + f.txs + ' transfers</div>' + traceBtn(f.addr) + '</div>';
    }).join("") || '<div class="radar-empty">No consolidator with ≥5 distinct senders in the dataset.</div>';
  } else if (tab === "round") {
    h = radar.round.map(function (r) {
      return '<div class="radar-row"><div class="radar-route"><b>' + F.fmtQTC(r.amount) + ' QTC</b> ' +
        esc(F.shortAddr(r.from_id)) + ' <span class="arrow">→</span> ' + esc(F.shortAddr(r.to_id)) +
        '</div><div class="radar-meta">block ' + r.block_height.toLocaleString() +
        (r.timestamp ? ' · ' + F.fmtTime(r.timestamp) : ' · genesis') + '</div>' + traceBtn(r.from_id) + '</div>';
    }).join("");
  } else if (tab === "miner") {
    h = radar.miner.map(function (m) {
      var share = m.rewards > 0n ? Number((m.onwardTotal * 10000n) / m.rewards) / 100 : 0;
      return '<div class="radar-row"><div class="radar-route">miner <b>' + esc(F.shortAddr(m.miner)) +
        '</b> forwarded <b>' + F.fmtQTC(m.onwardTotal) + ' QTC</b> in ' + m.onward.length + ' transfers</div>' +
        '<div class="radar-meta">coinbase earned ' + F.fmtQTC(m.rewards) + ' QTC (' + m.rewardTxs +
        ' rewards) · forwarded ' + share.toFixed(1) + '%</div>' + traceBtn(m.miner) + '</div>';
    }).join("") || '<div class="radar-empty">No miner onward transfers in the dataset.</div>';
  }
  body.innerHTML = h;
  Array.prototype.forEach.call(body.querySelectorAll("[data-trace]"), function (b) {
    b.addEventListener("click", function () {
      var a = b.getAttribute("data-trace");
      $("trace-addr").value = a;
      doTrace(a, $("trace-dir").value, parseInt($("trace-hops").value, 10));
      $("trace-panel").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "start" });
    });
  });
}

/* ---------------- notable transfers ---------------- */
function renderNotable() {
  var top = snapGraph.rows.slice().sort(function (a, b) { return b.amount > a.amount ? 1 : -1; }).slice(0, 25);
  $("notable-body").innerHTML = top.map(function (r, i) {
    return "<tr><td>" + (i + 1) + '</td><td class="amt">' + F.fmtQTC(r.amount) + '</td><td><span class="addr-link" data-a="' +
      esc(r.from_id) + '">' + esc(F.shortAddr(r.from_id)) + '</span></td><td><span class="addr-link" data-a="' +
      esc(r.to_id) + '">' + esc(F.shortAddr(r.to_id)) + '</span></td><td>' + r.block_height.toLocaleString() +
      "</td><td>" + esc(F.fmtTime(r.timestamp)) + '</td><td><button class="btn small ghost" data-trace="' +
      esc(r.from_id) + '">trace</button></td></tr>';
  }).join("");
  Array.prototype.forEach.call($("notable-body").querySelectorAll(".addr-link"), function (s) {
    s.addEventListener("click", function () { openDossier(s.getAttribute("data-a"), snapGraph); });
  });
  Array.prototype.forEach.call($("notable-body").querySelectorAll("[data-trace]"), function (b) {
    b.addEventListener("click", function () {
      var a = b.getAttribute("data-trace");
      $("trace-addr").value = a;
      doTrace(a, $("trace-dir").value, parseInt($("trace-hops").value, 10));
      $("trace-panel").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "start" });
    });
  });
}

/* ---------------- quick picks ---------------- */
function renderQuickPicks() {
  var picks = [];
  var vest = snapGraph.rows.find(function (r) { return r.block_height === 1; });
  if (vest) picks.push(["Vesting pool (5.67M QTC genesis)", vest.to_id]);
  var top = snapGraph.rows.slice().sort(function (a, b) { return b.amount > a.amount ? 1 : -1; })[1];
  if (top) picks.push(["Largest organic move (" + F.fmtQTC(top.amount, 0) + " QTC)", top.from_id]);
  if (radar.fanout.length) picks.push(["Biggest distributor", radar.fanout[0].addr]);
  if (radar.peel.length) picks.push(["Longest peel chain", radar.peel[0].path[0]]);
  if (radar.miner.length) picks.push(["Top forwarding miner", radar.miner[0].miner]);
  $("quick-picks").innerHTML = picks.map(function (p, i) {
    return '<button data-pick="' + i + '">' + esc(p[0]) + '</button>';
  }).join("");
  Array.prototype.forEach.call($("quick-picks").querySelectorAll("[data-pick]"), function (b) {
    b.addEventListener("click", function () {
      var a = picks[parseInt(b.getAttribute("data-pick"), 10)][1];
      $("trace-addr").value = a;
      doTrace(a, $("trace-dir").value, parseInt($("trace-hops").value, 10));
    });
  });
}

/* ---------------- background drift ---------------- */
function flowDrift() {
  var c = $("flow-drift"), ctx = c.getContext("2d"), w, h, ps;
  function size() {
    w = c.width = window.innerWidth; h = c.height = window.innerHeight;
    ps = Array.from({ length: Math.min(60, w / 22) }, function () {
      return { x: Math.random() * w, y: Math.random() * h, s: .25 + Math.random() * .8, l: 24 + Math.random() * 60, o: .04 + Math.random() * .08 };
    });
  }
  size();
  window.addEventListener("resize", size);
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function frame() {
    ctx.clearRect(0, 0, w, h);
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      var g = ctx.createLinearGradient(p.x, p.y, p.x + p.l, p.y);
      g.addColorStop(0, "rgba(126,240,201,0)");
      g.addColorStop(1, "rgba(126,240,201," + p.o + ")");
      ctx.strokeStyle = g; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.l, p.y); ctx.stroke();
      p.x += p.s;
      if (p.x - p.l > w) { p.x = -p.l - 10; p.y = Math.random() * h; }
    }
    if (!REDUCE_MOTION) requestAnimationFrame(frame);
  })();
}

/* ---------------- boot ---------------- */
async function boot() {
  $("hops-val").textContent = $("trace-hops").value;
  $("trace-hops").addEventListener("input", function () { $("hops-val").textContent = $("trace-hops").value; });
  $("trace-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var a = validAddress($("trace-addr").value);
    if (!a) {
      $("trace-status").innerHTML = "<b>Invalid address.</b> Expected a <code>qz…</code> address (SS58 prefix 189) with a valid checksum.";
      return;
    }
    doTrace(a, $("trace-dir").value, parseInt($("trace-hops").value, 10));
  });
  Array.prototype.forEach.call($("radar-tabs").querySelectorAll("[data-tab]"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call($("radar-tabs").querySelectorAll("[data-tab]"), function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      renderRadarTab(b.getAttribute("data-tab"));
    });
  });
  $("dossier-close").addEventListener("click", function () { $("dossier-panel").hidden = true; });
  $("dossier-copy").addEventListener("click", function () {
    var a = $("dossier-addr").textContent.trim();
    if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () {
      $("dossier-copy").textContent = "copied";
      setTimeout(function () { $("dossier-copy").textContent = "copy"; }, 1500);
    });
  });
  var dc = $("donate-copy");
  if (dc) dc.addEventListener("click", function () {
    var a = $("donate-addr").textContent.trim();
    if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () {
      dc.textContent = "copied"; setTimeout(function () { dc.textContent = "copy"; }, 1500);
    });
  });

  try {
    await loadData();
  } catch (e) {
    $("snap-badge").textContent = "data unavailable — " + e.message;
    $("snap-badge").classList.add("warn");
    $("trace-status").innerHTML = "<b>Could not load flow data.</b> " + esc(e.message);
    return;
  }
  try {
    computeRadar();
    renderQuickPicks();
    renderNotable();
  } catch (e) {
    $("trace-status").innerHTML = "<b>Error building flow views:</b> " + esc(e.message);
    return;
  }
  // Auto-trace the most interesting starting point so the console isn't empty.
  var seed = radar.fanout.length ? radar.fanout[0].addr : snapGraph.rows[0].from_id;
  $("trace-addr").value = seed;
  try { await doTrace(seed, "both", 2); }
  catch (e) { $("trace-status").innerHTML = "<b>Auto-trace failed:</b> " + esc(e.message); }

  flowDrift();
  window.__flowTracerReady = true;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
