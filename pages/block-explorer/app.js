/* QTC Block Explorer — mainnet explorer for the Quantus post-quantum blockchain.
 * Data source (verified 2026-09-29): https://sqm.quantus.com/v1/graphql (public Subsquid indexer).
 * 1 QTC = 10^12 planck. All figures below are read from the indexer, never invented.
 */
(function(){
"use strict";

var ENDPOINT = "https://sqm.quantus.com/v1/graphql";
var REFRESH_MS = 15000;
var PLANCK = 1e12;

/* ---------------- pure helpers (Node-testable) ---------------- */

function esc(s){
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtInt(n){
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* planck string -> QTC, trimmed to 4 decimals */
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

function shortHash(h, head, tail){
  if (!h) return "—";
  head = head || 10; tail = tail || 8;
  if (h.length <= head + tail + 1) return h;
  return h.slice(0, head) + "…" + h.slice(-tail);
}

function isHex64(s){ return /^0x[0-9a-fA-F]{64}$/.test(s); }
function isQz(s){ return /^qz[a-zA-Z0-9]{40,50}$/.test(s); }
function isHeight(s){ return /^\d{1,10}$/.test(s); }

/* classify a search string -> route descriptor */
function detectQuery(q){
  q = String(q || "").trim();
  if (!q) return { kind: "empty" };
  if (isHeight(q)) return { kind: "block", key: q };
  if (isHex64(q)) return { kind: "hash", key: q.toLowerCase() };
  if (isQz(q)) return { kind: "account", key: q };
  return { kind: "unknown", key: q };
}

/* parse location hash -> route */
function parseRoute(hash){
  var h = String(hash || "").replace(/^#/, "");
  var m = h.match(/^\/?block\/(.+)$/);
  if (m) return { view: "block", key: decodeURIComponent(m[1]) };
  m = h.match(/^\/?extrinsic\/(.+)$/);
  if (m) return { view: "extrinsic", key: decodeURIComponent(m[1]) };
  m = h.match(/^\/?account\/(.+)$/);
  if (m) return { view: "account", key: decodeURIComponent(m[1]) };
  m = h.match(/^\/?hash\/(.+)$/);
  if (m) return { view: "hash", key: decodeURIComponent(m[1]) };
  return { view: "home", key: "" };
}

/* route descriptor -> hash path */
function routeFor(q){
  var d = detectQuery(q);
  if (d.kind === "block") return "#/block/" + d.key;
  if (d.kind === "hash") return "#/hash/" + d.key;
  if (d.kind === "account") return "#/account/" + d.key;
  return null;
}

/* pretty-print extrinsic args JSON, tolerant of junk */
function prettyArgs(args){
  if (!args) return "(no arguments)";
  try {
    var o = typeof args === "string" ? JSON.parse(args) : args;
    return JSON.stringify(o, null, 2);
  } catch (e){
    return String(args);
  }
}

var API = { esc: esc, fmtInt: fmtInt, fmtQTC: fmtQTC, ageFmt: ageFmt,
  shortHash: shortHash, isHex64: isHex64, isQz: isQz, isHeight: isHeight,
  detectQuery: detectQuery, parseRoute: parseRoute, routeFor: routeFor,
  prettyArgs: prettyArgs };
if (typeof module !== "undefined" && module.exports) module.exports = API;

/* ---------------- fetch layer ---------------- */

function gql(query){
  /* Test hook for headless QA (the sandbox has no network egress):
   * QA injects window.__qtx_mock = {ok:true,data:{...}} before load. */
  if (typeof window !== "undefined" && window.__qtx_mock){
    var m = window.__qtx_mock;
    return m.ok ? Promise.resolve(m.data) : Promise.reject(new Error(m.error || "mock indexer failure"));
  }
  var ctl = new AbortController();
  var timer = setTimeout(function(){ ctl.abort(); }, 15000);
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
    if (json.errors && json.errors.length)
      throw new Error("indexer: " + json.errors.map(function(e){ return e.message; }).join("; "));
    return json.data;
  }).catch(function(err){
    clearTimeout(timer);
    throw err;
  });
}

/* ---------------- dom ---------------- */

var view = (typeof document !== "undefined") ? document.getElementById("view") : null;
var chainHeightEl = (typeof document !== "undefined") ? document.getElementById("chainHeight") : null;
var chainBadge = (typeof document !== "undefined") ? document.getElementById("chainBadge") : null;

function setBadge(state, text){
  if (!chainBadge) return;
  chainBadge.classList.remove("live", "down");
  if (state === "live") chainBadge.classList.add("live");
  if (state === "down") chainBadge.classList.add("down");
  if (chainHeightEl) chainHeightEl.textContent = text;
}

function copyText(text, el){
  function done(){ if (el){ var o = el.textContent; el.textContent = "copied ✓"; setTimeout(function(){ el.textContent = o; }, 900); } }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); done();
  }
}

function bindCopies(root){
  var els = root.querySelectorAll("[data-copy]");
  for (var i = 0; i < els.length; i++){
    (function(el){
      el.addEventListener("click", function(ev){ ev.preventDefault(); copyText(el.getAttribute("data-copy"), el); });
    })(els[i]);
  }
}

function showError(title, msg, retryFn){
  view.innerHTML =
    '<div class="error-box"><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' +
    '<button class="btn" id="retryBtn">↻ Retry</button></div>';
  var b = document.getElementById("retryBtn");
  if (b && retryFn) b.addEventListener("click", retryFn);
  setBadge("down", "indexer unreachable");
}

function showLoading(label){
  view.innerHTML = '<div class="loading"><div class="spin"></div><br>' + esc(label || "querying the indexer…") + '</div>';
}

/* live "x ago" ticking for elements with data-ts */
function tickAges(root){
  var now = Date.now();
  var cells = (root || document).querySelectorAll("[data-ts]");
  for (var i = 0; i < cells.length; i++){
    var t = Date.parse(cells[i].getAttribute("data-ts"));
    if (!isNaN(t)) cells[i].textContent = ageFmt(t, now);
  }
}
if (typeof window !== "undefined") setInterval(function(){ tickAges(view); }, 10000);

/* ---------------- queries ---------------- */

var Q_HOME =
  'query { ' +
  'stats: chain_stats_by_pk(id: "global") { block_height total_accounts total_immediate_transfers total_scheduled_transfers } ' +
  'blocks: block(limit: 10, order_by: {height: desc}) { height hash timestamp reward mined_by_id extrinsics_aggregate { aggregate { count } } } ' +
  'transfers: transfer(limit: 10, order_by: {block_height: desc}) { id amount from_id to_id block_height timestamp } ' +
  '}';

function qBlock(key){
  var where = isHeight(key) ? 'where: {height: {_eq: ' + parseInt(key, 10) + '}}'
                            : 'where: {hash: {_eq: "' + key.toLowerCase() + '"}}';
  return 'query { b: block(' + where + ', limit: 1) { id height hash timestamp reward mined_by_id ' +
    'extrinsics(order_by: {index_in_block: asc}) { id index_in_block pallet call signer_id success fee args } ' +
    'events(order_by: {id: asc}) { id type extrinsic_id } } }';
}

function qExtrinsic(id){
  return 'query { x: extrinsic(where: {id: {_eq: "' + id + '"}}, limit: 1) { id index_in_block pallet call signer_id success fee args timestamp block_id block { height } } ' +
    'ev: event(where: {extrinsic_id: {_eq: "' + id + '"}}) { id type } }';
}

function qAccount(id){
  return 'query { a: account_by_pk(id: "' + id + '") { id free frozen reserved is_deposit_only is_guardian is_high_security is_multisig last_updated } ' +
    't: transfer(where: {_or: [{from_id: {_eq: "' + id + '"}}, {to_id: {_eq: "' + id + '"}}]}, limit: 25, order_by: {block_height: desc}) { id amount from_id to_id block_height timestamp fee } ' +
    'mined: block_aggregate(where: {mined_by_id: {_eq: "' + id + '"}}) { aggregate { count } } }';
}

/* ---------------- views ---------------- */

var homeTimer = null;
function stopHomeTimer(){ if (homeTimer){ clearInterval(homeTimer); homeTimer = null; } }

function vHome(){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("querying the indexer…");
  function load(){
    gql(Q_HOME).then(function(d){
      if (!alive(my)) return;
      var st = d.stats || {};
      var blocks = d.blocks || [];
      var txs = d.transfers || [];
      setBadge("live", "height " + fmtInt(st.block_height));

      var statHtml =
        '<div class="stats">' +
        stat("Latest block", fmtInt(st.block_height), true) +
        stat("Accounts", fmtInt(st.total_accounts), false) +
        stat("Immediate transfers", fmtInt(st.total_immediate_transfers), false) +
        stat("Scheduled transfers", fmtInt(st.total_scheduled_transfers), false) +
        '</div>';

      var blockRows = blocks.map(function(b){
        var n = (b.extrinsics_aggregate && b.extrinsics_aggregate.aggregate) ? b.extrinsics_aggregate.aggregate.count : "—";
        return '<tr>' +
          '<td class="num"><a class="hash" href="#/block/' + b.height + '">' + fmtInt(b.height) + '</a></td>' +
          '<td class="hash" data-copy="' + esc(b.hash) + '" title="Click to copy">' + esc(shortHash(b.hash)) + '</td>' +
          '<td class="age" data-ts="' + esc(b.timestamp) + '"></td>' +
          '<td class="num">' + n + '</td>' +
          '<td><a class="acct" href="#/account/' + esc(b.mined_by_id) + '">' + esc(shortHash(b.mined_by_id, 8, 6)) + '</a></td>' +
          '<td class="num">' + esc(fmtQTC(b.reward)) + '</td>' +
          '</tr>';
      }).join("");

      var txRows = txs.map(function(t){
        return '<tr>' +
          '<td class="hash" data-copy="' + esc(t.id) + '" title="Click to copy transfer id">' + esc(shortHash(t.id)) + '</td>' +
          '<td><a class="acct" href="#/account/' + esc(t.from_id) + '">' + esc(shortHash(t.from_id, 8, 6)) + '</a></td>' +
          '<td><a class="acct" href="#/account/' + esc(t.to_id) + '">' + esc(shortHash(t.to_id, 8, 6)) + '</a></td>' +
          '<td class="num"><a class="hash" href="#/block/' + t.block_height + '">' + fmtInt(t.block_height) + '</a></td>' +
          '<td class="num">' + esc(fmtQTC(t.amount)) + '</td>' +
          '<td class="age" data-ts="' + esc(t.timestamp) + '"></td>' +
          '</tr>';
      }).join("");

      view.innerHTML =
        '<section class="hero panel">' +
          '<div class="kicker">Quantus mainnet &middot; post-quantum PoW</div>' +
          '<h1>Follow every <span class="grad">quantum-signed</span> block.</h1>' +
          '<p>Search block heights, 0x hashes, and qz&hellip; addresses. Live data from the public Quantus indexer — block times, miner rewards, transfers, and account balances, straight off the chain.</p>' +
          '<form class="hero-search" id="heroSearch" autocomplete="off">' +
            '<input id="heroInput" type="text" spellcheck="false" placeholder="Block height · 0x hash · qz… address">' +
            '<button type="submit">Search</button>' +
          '</form>' +
          '<div class="hint-row">' +
            '<span class="hint" data-q="' + (st.block_height || "") + '">latest block</span>' +
            '<span class="hint" data-q="135564">block 135564</span>' +
            '<span class="hint" data-q="qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv">a miner address</span>' +
          '</div>' +
        '</section>' +
        statHtml +
        '<div class="two-col">' +
          '<div><div class="section-head"><h2>Latest blocks</h2><span class="updated" id="blkUpd"></span></div>' +
          '<div class="tbl-wrap"><table><thead><tr><th>Height</th><th>Hash</th><th>Age</th><th>Extr.</th><th>Miner</th><th style="text-align:right">Reward</th></tr></thead>' +
          '<tbody>' + (blockRows || '<tr><td colspan="6" class="empty">no blocks returned</td></tr>') + '</tbody></table></div></div>' +
          '<div><div class="section-head"><h2>Latest transfers</h2><span class="updated" id="txUpd"></span></div>' +
          '<div class="tbl-wrap"><table><thead><tr><th>ID</th><th>From</th><th>To</th><th>Block</th><th style="text-align:right">Amount</th><th>Age</th></tr></thead>' +
          '<tbody>' + (txRows || '<tr><td colspan="6" class="empty">no transfers returned</td></tr>') + '</tbody></table></div></div>' +
        '</div>' +
        '<p class="sub" style="margin-top:14px">Auto-refreshes every 15 seconds. Amounts in QTC; raw unit is planck (10<sup>12</sup> per QTC).</p>';

      bindCopies(view);
      tickAges(view);
      var upd = document.getElementById("blkUpd");
      if (upd) upd.textContent = "updated " + new Date().toLocaleTimeString();
      var upd2 = document.getElementById("txUpd");
      if (upd2) upd2.textContent = "updated " + new Date().toLocaleTimeString();
      var hs = document.getElementById("heroSearch");
      if (hs) hs.addEventListener("submit", onSearchSubmit);
      var hints = view.querySelectorAll(".hint");
      for (var i = 0; i < hints.length; i++){
        (function(el){ el.addEventListener("click", function(){ location.hash = routeFor(el.getAttribute("data-q")) || "#/"; }); })(hints[i]);
      }
    }).catch(function(err){
      if (!alive(my)) return;
      showError("Indexer unreachable", "Could not reach sqm.quantus.com: " + err.message + ". The chain keeps moving — try again in a moment.", load);
    });
  }
  load();
  homeTimer = setInterval(function(){ if (!document.hidden) load(); }, REFRESH_MS);
}

function stat(k, v, cyan){
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' + (cyan ? " cyan" : "") + '">' + esc(v) + '</div></div>';
}

function vBlock(key){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("loading block…");
  gql(qBlock(key)).then(function(d){
    if (!alive(my)) return;
    var b = (d.b && d.b[0]) || null;
    if (!b){
      showError("Block not found", "No block matches “" + key + "” in the indexer. It may not be indexed yet, or the input may be off.", function(){ vBlock(key); });
      return;
    }
    setBadge("live", "height " + fmtInt(b.height));
    var xt = b.extrinsics || [];
    var ev = b.events || [];
    var evByXt = {};
    ev.forEach(function(e){ var k = e.extrinsic_id || "_block"; (evByXt[k] = evByXt[k] || []).push(e); });

    var xtRows = xt.map(function(x, i){
      var argsId = "args-" + i;
      return '<tr>' +
        '<td class="num">' + x.index_in_block + '</td>' +
        '<td><a class="hash" href="#/extrinsic/' + esc(x.id) + '">' + esc(x.pallet) + '.' + esc(x.call) + '</a></td>' +
        '<td>' + (x.signer_id ? '<a class="acct" href="#/account/' + esc(x.signer_id) + '">' + esc(shortHash(x.signer_id, 8, 6)) + '</a>' : '<span class="pill dim">inherent</span>') + '</td>' +
        '<td>' + (x.success ? '<span class="pill ok">ok</span>' : '<span class="pill bad">failed</span>') + '</td>' +
        '<td class="num">' + esc(fmtQTC(x.fee)) + '</td>' +
        '<td><button class="toggle-args" data-args="' + argsId + '">args ▾</button></td>' +
        '</tr>' +
        '<tr class="args-row" id="' + argsId + '" style="display:none"><td></td><td colspan="5"><div class="args-pre">' + esc(prettyArgs(x.args)) + '</div></td></tr>';
    }).join("");

    var evRows = ev.map(function(e){
      return '<div class="event-row"><span class="etype">' + esc(e.type) + '</span>' +
        '<span class="mono" style="color:var(--ink-faint)">' + esc(shortHash(e.id, 12, 6)) + '</span>' +
        (e.extrinsic_id ? '<a class="hash" href="#/extrinsic/' + esc(e.extrinsic_id) + '">extrinsic ↗</a>' : '<span class="pill dim">block-level</span>') +
        '</div>';
    }).join("");

    view.innerHTML =
      '<div class="navline">' +
        '<a class="btn ghost" href="#/">← home</a>' +
        '<a class="btn" href="#/block/' + (b.height - 1) + '">← ' + fmtInt(b.height - 1) + '</a>' +
        '<a class="btn" href="#/block/' + (b.height + 1) + '">' + fmtInt(b.height + 1) + ' →</a>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="kicker">Block</div><h2>#' + fmtInt(b.height) + '</h2>' +
        '<p class="sub">Hash <span class="mono copy" data-copy="' + esc(b.hash) + '" title="Click to copy">' + esc(b.hash) + '</span></p>' +
        '<div class="detail-grid">' +
          field("Height", fmtInt(b.height)) +
          field("Timestamp", esc(new Date(b.timestamp).toLocaleString()) + ' <span class="age" data-ts="' + esc(b.timestamp) + '"></span>') +
          field("Miner", '<a class="acct" href="#/account/' + esc(b.mined_by_id) + '">' + esc(b.mined_by_id) + '</a>') +
          field("Miner reward", '<span class="big">' + esc(fmtQTC(b.reward)) + ' QTC</span>') +
          field("Extrinsics", fmtInt(xt.length)) +
          field("Events", fmtInt(ev.length)) +
        '</div>' +
      '</div>' +
      '<div class="section-head"><h2>Extrinsics (' + xt.length + ')</h2></div>' +
      (xt.length
        ? '<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Call</th><th>Signer</th><th>Status</th><th style="text-align:right">Fee (QTC)</th><th></th></tr></thead><tbody>' + xtRows + '</tbody></table></div>'
        : '<div class="empty panel">Empty block — no extrinsics.</div>') +
      '<div class="section-head"><h2>Events (' + ev.length + ')</h2></div>' +
      (ev.length ? '<div class="event-list">' + evRows + '</div>' : '<div class="empty panel">No events recorded for this block.</div>');

    bindCopies(view);
    tickAges(view);
    var toggles = view.querySelectorAll(".toggle-args");
    for (var i = 0; i < toggles.length; i++){
      (function(btn){
        btn.addEventListener("click", function(){
          var row = document.getElementById(btn.getAttribute("data-args"));
          var open = row.style.display !== "none";
          row.style.display = open ? "none" : "";
          btn.textContent = open ? "args ▾" : "args ▴";
        });
      })(toggles[i]);
    }
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t load block", err.message, function(){ vBlock(key); });
  });
}

function field(k, v){ return '<div class="field"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }

function vExtrinsic(id){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("loading extrinsic…");
  gql(qExtrinsic(id)).then(function(d){
    if (!alive(my)) return;
    var x = (d.x && d.x[0]) || null;
    if (!x){
      showError("Extrinsic not found", "No extrinsic matches “" + id + "”.", function(){ vExtrinsic(id); });
      return;
    }
    var height = (x.block && x.block.height) || null;
    var evs = d.ev || [];
    var evRows = evs.map(function(e){
      return '<div class="event-row"><span class="etype">' + esc(e.type) + '</span><span class="mono" style="color:var(--ink-faint)">' + esc(shortHash(e.id, 12, 6)) + '</span></div>';
    }).join("");
    view.innerHTML =
      '<div class="navline"><a class="btn ghost" href="#/">← home</a>' +
      (height !== null ? '<a class="btn" href="#/block/' + height + '">block ' + fmtInt(height) + ' ↗</a>' : '') + '</div>' +
      '<div class="panel"><div class="kicker">Extrinsic</div>' +
      '<h2>' + esc(x.pallet) + '.' + esc(x.call) + '</h2>' +
      '<p class="sub">ID <span class="mono copy" data-copy="' + esc(x.id) + '" title="Click to copy">' + esc(x.id) + '</span></p>' +
      '<div class="detail-grid">' +
        field("Index in block", String(x.index_in_block)) +
        field("Signer", x.signer_id ? '<a class="acct" href="#/account/' + esc(x.signer_id) + '">' + esc(x.signer_id) + '</a>' : "— (inherent)") +
        field("Status", x.success ? '<span class="pill ok">succeeded</span>' : '<span class="pill bad">failed</span>') +
        field("Fee", '<span class="big">' + esc(fmtQTC(x.fee)) + ' QTC</span>') +
        field("Timestamp", esc(new Date(x.timestamp).toLocaleString()) + ' <span class="age" data-ts="' + esc(x.timestamp) + '"></span>') +
      '</div>' +
      '<div class="kicker" style="margin-top:18px">Arguments</div>' +
      '<div class="args-pre">' + esc(prettyArgs(x.args)) + '</div>' +
      '</div>' +
      '<div class="section-head"><h2>Events (' + evs.length + ')</h2></div>' +
      (evs.length ? '<div class="event-list">' + evRows + '</div>' : '<div class="empty panel">No events attached to this extrinsic.</div>');
    bindCopies(view);
    tickAges(view);
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t load extrinsic", err.message, function(){ vExtrinsic(id); });
  });
}

function vAccount(id){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("loading account…");
  gql(qAccount(id)).then(function(d){
    if (!alive(my)) return;
    var a = d.a || null;
    var txs = d.t || [];
    var mined = (d.mined && d.mined.aggregate) ? d.mined.aggregate.count : 0;
    setBadge("live", "account lookup");

    var flags = [];
    if (a){
      if (a.is_guardian) flags.push('<span class="pill info">guardian</span>');
      if (a.is_high_security) flags.push('<span class="pill info">high-security</span>');
      if (a.is_multisig) flags.push('<span class="pill info">multisig</span>');
      if (a.is_deposit_only) flags.push('<span class="pill dim">deposit-only</span>');
    }

    var bal = a
      ? '<div class="detail-grid">' +
        field("Free", '<span class="big">' + esc(fmtQTC(a.free)) + ' QTC</span>') +
        field("Frozen", esc(fmtQTC(a.frozen)) + " QTC") +
        field("Reserved", esc(fmtQTC(a.reserved)) + " QTC") +
        field("Blocks mined", fmtInt(mined)) +
        '</div>' +
        (flags.length ? '<div class="flags">' + flags.join("") + '</div>' : '')
      : '<div class="empty">This address has no account record in the indexer yet — it has never transacted or mined on-chain.</div>';

    var txRows = txs.map(function(t){
      var incoming = t.to_id === id;
      return '<tr>' +
        '<td>' + (incoming ? '<span class="dir-in">← in</span>' : '<span class="dir-out">out →</span>') + '</td>' +
        '<td><a class="acct" href="#/account/' + esc(incoming ? t.from_id : t.to_id) + '">' + esc(shortHash(incoming ? t.from_id : t.to_id, 8, 6)) + '</a></td>' +
        '<td class="num">' + (incoming ? "+" : "−") + esc(fmtQTC(t.amount)) + '</td>' +
        '<td class="num"><a class="hash" href="#/block/' + t.block_height + '">' + fmtInt(t.block_height) + '</a></td>' +
        '<td class="age" data-ts="' + esc(t.timestamp) + '"></td>' +
        '</tr>';
    }).join("");

    view.innerHTML =
      '<div class="navline"><a class="btn ghost" href="#/">← home</a></div>' +
      '<div class="panel"><div class="kicker">Account</div>' +
      '<h2 class="mono" style="font-size:17px;word-break:break-all">' + esc(id) + '</h2>' +
      '<p class="sub"><button class="addr" data-copy="' + esc(id) + '">copy address</button></p>' +
      bal + '</div>' +
      '<div class="section-head"><h2>Transfers (' + txs.length + ' shown)</h2></div>' +
      (txs.length
        ? '<div class="tbl-wrap"><table><thead><tr><th>Dir</th><th>Counterparty</th><th style="text-align:right">Amount (QTC)</th><th>Block</th><th>Age</th></tr></thead><tbody>' + txRows + '</tbody></table></div>'
        : '<div class="empty panel">No transfers indexed for this address.</div>');

    bindCopies(view);
    tickAges(view);
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t load account", err.message, function(){ vAccount(id); });
  });
}

/* ---------------- hash resolver (0x could be block or extrinsic) ---------------- */

function vHash(key){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("resolving hash…");
  gql('query { b: block(where: {hash: {_eq: "' + key + '"}}, limit: 1) { height } ' +
      'x: extrinsic(where: {id: {_eq: "' + key + '"}}, limit: 1) { id } }')
  .then(function(d){
    if (!alive(my)) return;
    if (d.b && d.b.length){ location.hash = "#/block/" + d.b[0].height; return; }
    if (d.x && d.x.length){ location.hash = "#/extrinsic/" + d.x[0].id; return; }
    showError("Hash not found", "“" + key + "” matches no indexed block or extrinsic. It may be from before the indexer's retention window, or mistyped.", function(){ vHash(key); });
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t resolve hash", err.message, function(){ vHash(key); });
  });
}

/* ---------------- search + router ---------------- */

function onSearchSubmit(ev){
  ev.preventDefault();
  var inp = ev.target.querySelector("input");
  var target = routeFor(inp.value);
  if (target) location.hash = target;
  else if (view) showError("Not a block, hash, or address",
    "Try a block height (e.g. 135564), a 64-hex 0x hash, or a qz… Quantus address.", function(){});
}

/* View generation guard: every route() bumps viewSeq; async continuations
 * that belong to an older view must not write into the current one. */
var viewSeq = 0;
function alive(my){ return my === viewSeq; }

function route(){
  var r = parseRoute(location.hash);
  if (r.view === "block") vBlock(r.key);
  else if (r.view === "extrinsic") vExtrinsic(r.key);
  else if (r.view === "account") vAccount(r.key);
  else if (r.view === "hash") vHash(r.key);
  else vHome();
}

if (typeof window !== "undefined"){
  var sf = document.getElementById("searchForm");
  if (sf) sf.addEventListener("submit", onSearchSubmit);
  window.addEventListener("hashchange", route);
  route();
}

})();
