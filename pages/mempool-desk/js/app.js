/* QTC Mempool Desk — app logic (DOM + WebSocket JSON-RPC).
 *
 * Connects to any Substrate node (default: the upstream-documented mainnet
 * RPC wss://rpc.quantus.network) and drives three live surfaces:
 *   1. mempool gauge — author_pendingExtrinsics polled every 8s
 *   2. txWatch watchers — the upstream transaction-pool listener RPC
 *      (txWatch_watchAddress / txWatch_transfer), honest zero-conf signals
 *   3. fee desk — payment_queryInfo fee estimates on pending extrinsics
 *
 * No mock data anywhere: every surface shows an explicit "no node
 * connection" state until a real socket answers. 100% client-side.
 */
(function () {
"use strict";

var C = window.QMEMCORE;
var SS = window.QSS58;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

var DEFAULT_ENDPOINT = "wss://rpc.quantus.network";
var POOL_POLL_MS = 8000;
var CONNECT_TIMEOUT_MS = 12000;
var HISTORY_CAP = 120;
var FEED_CAP = 200;
var FEE_BATCH_MAX = 25;

var LS = {
  endpoint: "qmem_endpoint",
  watchers: "qmem_watchers",
  notify: "qmem_notify",
};

var state = {
  endpoint: DEFAULT_ENDPOINT,
  ws: null,
  connected: false,
  userDisconnected: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  connectTimer: null,
  chain: null,
  version: null,
  head: null,              // {number, hash}
  pending: new Map(),      // rpc id -> {resolve, reject, timer}
  subToWatcher: new Map(), // txWatch subscription id -> address
  reqToWatcher: new Map(), // rpc id -> address (pending subscribe)
  pool: [],                // extrinsic hex strings
  poolLastPoll: 0,
  poolUnsupported: false,
  poolError: null,
  poolHistory: [],         // {t, count}
  poolSummary: null,
  feeRows: [],
  feeRunning: false,
  feeProgress: null,
  watchers: [],            // {address, label, status, subId, note}
  feed: [],                // parsed txWatch notifications, newest first
  notifyWanted: false,
};

/* ================= persistence ================= */

function loadSaved() {
  try {
    var ep = localStorage.getItem(LS.endpoint);
    if (ep && C.isWsUrl(ep)) state.endpoint = ep;
    var w = JSON.parse(localStorage.getItem(LS.watchers) || "[]");
    if (Array.isArray(w)) {
      state.watchers = w.filter(function (x) {
        return x && typeof x.address === "string";
      }).map(function (x) {
        return { address: x.address, label: String(x.label || ""), status: "waiting", subId: null, note: "" };
      });
    }
    state.notifyWanted = localStorage.getItem(LS.notify) === "1";
  } catch (e) { /* storage unavailable — run session-only */ }
}

function saveEndpoint() {
  try { localStorage.setItem(LS.endpoint, state.endpoint); } catch (e) {}
}
function saveWatchers() {
  try {
    localStorage.setItem(LS.watchers, JSON.stringify(state.watchers.map(function (w) {
      return { address: w.address, label: w.label };
    })));
  } catch (e) {}
}

/* ================= connection ================= */

function setConnBadge() {
  var b = $("conn-badge");
  if (state.connected) {
    b.className = "badge live";
    b.textContent = "● CONNECTED";
  } else if (state.ws && !state.userDisconnected) {
    b.className = "badge snap";
    b.textContent = "◌ CONNECTING…";
  } else {
    b.className = "badge off";
    b.textContent = "○ OFFLINE";
  }
  $("btn-connect").textContent = state.connected ? "Disconnect" : "Connect";
  $("btn-connect").classList.toggle("danger", state.connected);
}

function renderConn() {
  setConnBadge();
  var g = $("conn-grid");
  var rows = [
    ["Endpoint", "<span class='mono'>" + esc(state.endpoint) + "</span>"],
    ["Chain", state.chain ? esc(state.chain) : "—"],
    ["Node version", state.version ? "<span class='mono'>" + esc(state.version) + "</span>" : "—"],
    ["Head block", state.head ? "#" + state.head.number.toLocaleString("en-US") : "—"],
    ["Head hash", state.head ? "<span class='mono'>" + esc(C.shorten(state.head.hash)) + "</span>" : "—"],
    ["Reconnect tries", state.connected ? "0 (connected)" : String(state.reconnectAttempt)],
    ["Last pool poll", state.poolLastPoll ? C.formatAge(Date.now() - state.poolLastPoll) + " ago" : "never"],
  ];
  g.innerHTML = rows.map(function (r) {
    return "<div class='kv-row'><span class='k'>" + r[0] + "</span><span class='v'>" + r[1] + "</span></div>";
  }).join("");
  renderHero();
}

function logConn(msg, isErr) {
  var box = $("conn-log");
  var line = document.createElement("div");
  line.className = "log-line" + (isErr ? " err" : "");
  line.innerHTML = "<span class='t'>" + new Date().toLocaleTimeString("en-US", { hour12: false }) +
    "</span> " + esc(msg);
  box.prepend(line);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}

function rpcCall(payload) {
  return new Promise(function (resolve, reject) {
    if (!state.ws || state.ws.readyState !== 1) {
      reject(new Error("no open socket"));
      return;
    }
    var timer = setTimeout(function () {
      state.pending.delete(payload.id);
      reject(new Error("request timed out: " + payload.method));
    }, CONNECT_TIMEOUT_MS);
    state.pending.set(payload.id, { resolve: resolve, reject: reject, timer: timer });
    try {
      state.ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(payload.id);
      reject(e);
    }
  });
}

function routeMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.id !== undefined && msg.id !== null && state.pending.has(msg.id)) {
    var p = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      var err = new Error(msg.error.message || "RPC error");
      err.code = msg.error.code;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
    return;
  }
  if (msg.method && msg.params && msg.params.subscription) {
    handleSubscription(msg);
  }
}

function handleSubscription(msg) {
  var sub = msg.params.subscription;
  var result = msg.params.result;
  if (msg.method === "chain_subscribeNewHeads" || msg.method === "chain_newHead") {
    if (result && result.number !== undefined) {
      var n = result.number;
      var num = typeof n === "string" && n.indexOf("0x") === 0 ? parseInt(n, 16) : n;
      state.head = { number: num, hash: null };
      renderConn();
      renderPoolHeader();
      renderHero();
      // The Header notification carries no block hash; ask the node for it.
      rpcCall(C.buildRpc("chain_getBlockHash", [n])).then(function (h) {
        if (state.head && state.head.number === num) {
          state.head.hash = h;
          renderConn();
        }
      }).catch(function () { /* head hash stays blank */ });
    }
    return;
  }
  if (msg.method === "txWatch_transfer") {
    var addr = state.subToWatcher.get(sub);
    if (!addr) return;
    var note;
    try {
      note = C.parseTxWatchNotification(result);
    } catch (e) {
      logConn("txWatch: malformed notification ignored (" + e.message + ")", true);
      return;
    }
    note.watchAddress = addr;
    state.feed.unshift(note);
    if (state.feed.length > FEED_CAP) state.feed.length = FEED_CAP;
    renderFeed();
    renderWatchers();
    renderHero();
    maybeNotify(note);
  }
}

function clearTimers() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.connectTimer) { clearTimeout(state.connectTimer); state.connectTimer = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

function connect() {
  var url;
  try {
    url = C.normalizeEndpoint($("endpoint-input").value);
  } catch (e) {
    $("conn-msg").textContent = "That doesn't look like a WebSocket URL — try wss://host or ws://host:9944";
    $("conn-msg").className = "form-msg err";
    return;
  }
  state.endpoint = url;
  saveEndpoint();
  state.userDisconnected = false;
  clearTimers();
  openSocket();
}

function openSocket() {
  closeSocketQuiet();
  $("conn-msg").textContent = "Opening socket to " + state.endpoint + " …";
  $("conn-msg").className = "form-msg";
  logConn("connecting to " + state.endpoint);
  var ws;
  try {
    ws = new WebSocket(state.endpoint);
  } catch (e) {
    logConn("WebSocket constructor threw: " + e.message, true);
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  setConnBadge();

  state.connectTimer = setTimeout(function () {
    if (state.ws !== ws) return; // superseded socket's timer must not kill the current connection
    if (!state.connected) {
      logConn("connection timed out after " + (CONNECT_TIMEOUT_MS / 1000) + "s", true);
      try { ws.close(); } catch (e) {}
      scheduleReconnect();
    }
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = function () {
    if (state.ws !== ws) return; // a superseded socket never starts a handshake
    logConn("socket open — running handshake");
    handshake().then(function () {
      if (state.ws !== ws) return; // superseded mid-handshake — the current socket owns the desk
      state.connected = true;
      state.reconnectAttempt = 0;
      if (state.connectTimer) { clearTimeout(state.connectTimer); state.connectTimer = null; }
      $("conn-msg").textContent = "";
      logConn("handshake ok: " + (state.chain || "?") + " @ head #" +
        (state.head ? state.head.number.toLocaleString("en-US") : "?"));
      setConnBadge();
      renderConn();
      subscribeHeads();
      startPoolPolling();
      subscribeAllWatchers();
    }).catch(function (e) {
      // A superseded socket's handshake is rejected by closeSocketQuiet()
      // when its replacement opens. That rejection must discard itself:
      // scheduleReconnect() here would clearTimers() the NEW socket's
      // timers and schedule a competing socket that tears the healthy
      // connection down seconds later.
      if (state.ws !== ws) return;
      logConn("handshake failed: " + e.message, true);
      try { ws.close(); } catch (err) {}
      scheduleReconnect();
    });
  };

  ws.onmessage = function (ev) { routeMessage(ev.data); };

  ws.onerror = function () {
    if (state.ws !== ws) return;
    logConn("socket error", true);
  };

  ws.onclose = function () {
    if (state.ws !== ws) return; // a superseded socket's close changes nothing
    var was = state.connected;
    state.connected = false;
    state.head = null;
    state.poolUnsupported = state.poolUnsupported; // sticky per endpoint session
    markWatchersWaiting("socket closed");
    setConnBadge();
    renderConn();
    renderPoolHeader();
    if (was) logConn("socket closed", true);
    if (!state.userDisconnected) scheduleReconnect();
    else {
      $("conn-msg").textContent = "Disconnected. Your watchers are saved and will resubscribe on reconnect.";
      $("conn-msg").className = "form-msg";
    }
  };
}

function handshake() {
  var calls = C.buildHandshake();
  return rpcCall(calls[0]).then(function (chain) {
    state.chain = String(chain);
    return rpcCall(calls[1]);
  }).then(function (version) {
    state.version = String(version);
    return rpcCall(calls[2]);
  }).then(function (header) {
    if (header && header.number !== undefined) {
      var n = header.number;
      state.head = {
        number: typeof n === "string" && n.indexOf("0x") === 0 ? parseInt(n, 16) : n,
        hash: null,
      };
      return rpcCall(C.buildRpc("chain_getBlockHash", [])).then(function (h) {
        state.head.hash = h;
      }).catch(function () { /* head hash optional */ });
    }
  });
}

function subscribeHeads() {
  var p = C.buildNewHeadsSubscribe();
  rpcCall(p).then(function (subId) {
    logConn("subscribed to new heads (" + C.shorten(String(subId), 8, 4) + ")");
  }).catch(function (e) {
    logConn("new-heads subscription failed: " + e.message + " — head will refresh on pool polls", true);
  });
}

function scheduleReconnect() {
  if (state.userDisconnected) return;
  clearTimers();
  var wait = C.backoffMs(state.reconnectAttempt);
  state.reconnectAttempt += 1;
  logConn("reconnecting in " + (wait / 1000) + "s (attempt " + state.reconnectAttempt + ")");
  setConnBadge();
  renderConn();
  state.reconnectTimer = setTimeout(function () {
    if (!state.userDisconnected) openSocket();
  }, wait);
}

function disconnect() {
  state.userDisconnected = true;
  clearTimers();
  closeSocketQuiet();
  state.connected = false;
  markWatchersWaiting("disconnected");
  setConnBadge();
  renderConn();
  renderPoolHeader();
  $("conn-msg").textContent = "Disconnected. Watchers are saved locally and will resubscribe on reconnect.";
  $("conn-msg").className = "form-msg";
  logConn("user disconnected");
}

function closeSocketQuiet() {
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.onerror = null; state.ws.close(); } catch (e) {}
    state.ws = null;
  }
  state.pending.forEach(function (p) {
    clearTimeout(p.timer);
    p.reject(new Error("socket closed"));
  });
  state.pending.clear();
}

/* ================= mempool polling ================= */

function startPoolPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollPool();
  state.pollTimer = setInterval(function () {
    if (state.connected && !state.poolUnsupported) pollPool();
  }, POOL_POLL_MS);
}

function pollPool() {
  rpcCall(C.buildPendingExtrinsics()).then(function (list) {
    state.pool = Array.isArray(list) ? list : [];
    state.poolLastPoll = Date.now();
    state.poolError = null;
    try {
      state.poolSummary = C.summarizePool(state.pool);
    } catch (e) {
      state.poolSummary = null;
    }
    state.poolHistory.push({ t: Date.now(), count: state.pool.length });
    if (state.poolHistory.length > HISTORY_CAP) {
      state.poolHistory.splice(0, state.poolHistory.length - HISTORY_CAP);
    }
    renderPool();
  }).catch(function (e) {
    if (e.code === -32601) {
      state.poolUnsupported = true;
      state.poolError = "This node does not expose author_pendingExtrinsics (common on public RPCs) — the pool gauge is unavailable here. txWatch watchers and head tracking still work.";
      logConn("author_pendingExtrinsics not available on this node", true);
    } else {
      state.poolError = "Pool poll failed: " + e.message;
    }
    renderPool();
  });
}

function renderPoolHeader() {
  var h = $("pool-health");
  var health = state.connected ? C.poolHealth(state.poolLastPoll, Date.now()) : "dead";
  h.className = "badge " + (health === "live" ? "live" : health === "stale" ? "snap" : "off");
  h.textContent = health === "live" ? "● POOL LIVE"
    : health === "stale" ? "◌ POOL STALE" : "○ NO POOL DATA";
}

function renderPool() {
  renderPoolHeader();
  var body = $("pool-body");
  var meta = $("pool-meta");

  if (!state.connected) {
    body.innerHTML = "<div class='qmb-empty'>No node connection — connect to a node on the Connection tab and the live pool will appear here. Nothing is simulated.</div>";
    meta.textContent = "Waiting for a socket.";
    drawSparkline();
    renderGauge(null);
    return;
  }
  if (state.poolUnsupported) {
    body.innerHTML = "<div class='qmb-error'>" + esc(state.poolError) + "</div>";
    meta.textContent = "Pool polling disabled for this node.";
    drawSparkline();
    renderGauge(null);
    return;
  }
  if (!state.poolLastPoll) {
    body.innerHTML = "<div class='qmb-loading'>Polling the transaction pool…</div>";
    return;
  }
  renderGauge(state.poolSummary);
  meta.textContent = "Last poll " + C.formatAge(Date.now() - state.poolLastPoll) + " ago · " +
    state.pool.length + " pending extrinsic" + (state.pool.length === 1 ? "" : "s") +
    " · poll every " + (POOL_POLL_MS / 1000) + "s";

  var rows = state.pool.slice(0, C.MAX_PENDING_LISTED);
  var feeByHex = {};
  state.feeRows.forEach(function (r) { feeByHex[r.hex] = r.fee; });

  var html = "<table class='pool'><thead><tr><th>#</th><th>Extrinsic</th><th class='num'>Bytes</th>" +
    "<th class='num'>Fee (QTC)</th></tr></thead><tbody>";
  rows.forEach(function (hex, i) {
    var bytes;
    try { bytes = C.hexByteLen(hex); } catch (e) { bytes = null; }
    var fee = feeByHex[hex];
    var feeTxt = fee === undefined ? "<span class='muted'>—</span>"
      : fee === null ? "<span class='muted'>n/a</span>"
      : "<span class='mono'>" + esc(C.formatQtc(fee)) + "</span>";
    html += "<tr><td class='muted'>" + (i + 1) + "</td>" +
      "<td><span class='mono'>" + esc(C.shorten(hex, 14, 10)) + "</span> " +
      "<button class='mini' data-copy='" + esc(hex) + "' title='Copy full extrinsic hex'>⧉</button></td>" +
      "<td class='num'>" + (bytes === null ? "?" : bytes.toLocaleString("en-US")) + "</td>" +
      "<td class='num'>" + feeTxt + "</td></tr>";
  });
  html += "</tbody></table>";
  if (state.pool.length > rows.length) {
    html += "<p class='muted small'>Showing " + rows.length + " of " + state.pool.length +
      " — the gauge above always covers the full pool.</p>";
  }
  body.innerHTML = html;
  bindCopyButtons(body);
  drawSparkline();
  renderHero();
}

function renderGauge(s) {
  var g = $("pool-gauge");
  if (!s) {
    g.innerHTML = ["Pending", "Pool bytes", "Avg size", "Largest"].map(function (k) {
      return "<div class='fact'><span class='k'>" + k + "</span><span class='v'>—</span></div>";
    }).join("");
    return;
  }
  var facts = [
    ["Pending", s.count.toLocaleString("en-US"), "hot"],
    ["Pool bytes", s.totalBytes.toLocaleString("en-US") + " B", ""],
    ["Avg size", s.avgBytes.toLocaleString("en-US") + " B", "cool"],
    ["Largest", s.maxBytes.toLocaleString("en-US") + " B", "warm"],
  ];
  g.innerHTML = facts.map(function (f) {
    return "<div class='fact'><span class='k'>" + f[0] + "</span><span class='v " + f[2] + "'>" + f[1] + "</span></div>";
  }).join("");
}

function drawSparkline() {
  var cv = $("pool-spark");
  var ctx = cv.getContext("2d");
  var W = cv.width = cv.offsetWidth * 2 || 600;
  var H = cv.height = 180;
  ctx.clearRect(0, 0, W, H);
  var pts = state.poolHistory;
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(139,163,189,.7)";
    ctx.font = "22px Inter, sans-serif";
    ctx.fillText(state.connected ? "Collecting pool history…" : "Pool history appears once connected", 16, H / 2);
    return;
  }
  var max = Math.max.apply(null, pts.map(function (p) { return p.count; }).concat([1]));
  ctx.strokeStyle = "rgba(64,224,255,.25)";
  ctx.lineWidth = 1;
  for (var gline = 0; gline <= 3; gline++) {
    var y = 12 + (H - 24) * gline / 3;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  var grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(64,224,255,.35)");
  grad.addColorStop(1, "rgba(64,224,255,0)");
  ctx.beginPath();
  pts.forEach(function (p, i) {
    var x = (i / (pts.length - 1)) * W;
    var y = H - 12 - ((H - 24) * p.count / max);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#40e0ff";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  var last = pts[pts.length - 1];
  ctx.fillStyle = "#e9edf9";
  ctx.font = "bold 26px Inter, sans-serif";
  ctx.fillText(last.count + " pending", 16, 36);
}

/* ================= fee desk ================= */

function estimatePoolFees() {
  if (state.feeRunning || !state.connected || !state.pool.length) return;
  var batch = state.pool.slice(0, FEE_BATCH_MAX);
  state.feeRunning = true;
  state.feeRows = [];
  renderPool();
  $("fee-msg").textContent = "";
  var i = 0;
  function next() {
    if (i >= batch.length || !state.connected) {
      state.feeRunning = false;
      state.feeRows = C.sortPoolByFee(state.feeRows);
      renderPool();
      renderFeeDesk();
      $("fee-msg").textContent = "Estimated " + state.feeRows.length + " of " +
        Math.min(batch.length, state.pool.length) + " sampled extrinsics (node-quoted partialFee at current head).";
      return;
    }
    var hex = batch[i];
    i += 1;
    $("fee-msg").textContent = "Asking the node for fee " + i + " of " + batch.length + " …";
    var bytes = null;
    try { bytes = C.hexByteLen(hex); } catch (e) {}
    rpcCall(C.buildPaymentQueryInfo(hex)).then(function (res) {
      var fee = null;
      try { fee = C.decodePartialFee(res); } catch (e) {}
      state.feeRows.push({ hex: hex, bytes: bytes, fee: fee });
      next();
    }).catch(function () {
      state.feeRows.push({ hex: hex, bytes: bytes, fee: null });
      next();
    });
  }
  next();
}

function renderFeeDesk() {
  var box = $("fee-results");
  if (!state.feeRows.length) {
    box.innerHTML = "<div class='qmb-empty'>No fee estimates yet. Connect a node, then run “Estimate pool fees” on the Mempool tab — or paste any extrinsic hex below.</div>";
    return;
  }
  var known = state.feeRows.filter(function (r) { return r.fee !== null; });
  var top = known.length ? known[0].fee : null;
  var html = "<p class='muted'>" + known.length + " of " + state.feeRows.length +
    " sampled extrinsics returned a fee quote." +
    (top !== null ? " Highest quoted fee: <strong class='mono'>" + esc(C.formatQtc(top)) + " QTC</strong>." : "") + "</p>";
  html += "<div class='table-wrap'><table class='pool'><thead><tr><th>Extrinsic</th>" +
    "<th class='num'>Bytes</th><th class='num'>Quoted fee (QTC)</th></tr></thead><tbody>";
  state.feeRows.forEach(function (r) {
    html += "<tr><td><span class='mono'>" + esc(C.shorten(r.hex, 14, 10)) + "</span></td>" +
      "<td class='num'>" + (r.bytes === null ? "?" : r.bytes.toLocaleString("en-US")) + "</td>" +
      "<td class='num'>" + (r.fee === null ? "<span class='muted'>n/a</span>"
        : "<span class='mono'>" + esc(C.formatQtc(r.fee)) + "</span>") + "</td></tr>";
  });
  html += "</tbody></table></div>";
  box.innerHTML = html;
}

function estimatePasted() {
  var hex = $("fee-hex").value.trim();
  var msg = $("fee-paste-msg");
  if (!state.connected) {
    msg.textContent = "Connect a node first — the fee quote comes from the node, never from this page.";
    msg.className = "form-msg err";
    return;
  }
  try {
    C.hexByteLen(hex);
  } catch (e) {
    msg.textContent = "That isn't valid 0x hex.";
    msg.className = "form-msg err";
    return;
  }
  msg.textContent = "Asking the node…";
  msg.className = "form-msg";
  rpcCall(C.buildPaymentQueryInfo(hex)).then(function (res) {
    var fee = C.decodePartialFee(res);
    var bytes = C.hexByteLen(hex);
    msg.innerHTML = "Node quote: <strong class='mono'>" + esc(C.formatQtc(fee)) + " QTC</strong> " +
      "<span class='muted'>(" + fee.toString() + " planck · " + bytes.toLocaleString("en-US") + " bytes)</span>";
    msg.className = "form-msg ok";
  }).catch(function (e) {
    msg.textContent = "Node refused the quote: " + e.message;
    msg.className = "form-msg err";
  });
}

/* ================= txWatch watchers ================= */

function decodeAddr(a) {
  return SS.ss58Decode(a);
}

function addWatcher() {
  var addrEl = $("watch-address");
  var labelEl = $("watch-label");
  var msg = $("watch-msg");
  var addr = addrEl.value.trim();
  var chk = C.checkAddress(addr, decodeAddr);
  if (!chk.ok) {
    msg.textContent = "Rejected: " + chk.reason + ". Only Quantus SS58-189 addresses can be watched.";
    msg.className = "form-msg err";
    return;
  }
  var exists = state.watchers.some(function (w) { return w.address === addr; });
  if (exists) {
    msg.textContent = "That address is already on the watch list.";
    msg.className = "form-msg err";
    return;
  }
  state.watchers.push({ address: addr, label: labelEl.value.trim().slice(0, 40), status: "waiting", subId: null, note: "" });
  saveWatchers();
  addrEl.value = "";
  labelEl.value = "";
  msg.textContent = state.connected ? "Added — subscribing…" : "Added — it will subscribe when you connect.";
  msg.className = "form-msg ok";
  renderWatchers();
  if (state.connected) subscribeWatcher(state.watchers[state.watchers.length - 1]);
}

function subscribeWatcher(w) {
  if (w.status === "live" || w.status === "subscribing") return;
  var ws = state.ws;
  var p = C.buildTxWatchSubscribe(w.address);
  state.reqToWatcher.set(p.id, w.address);
  w.status = "subscribing";
  w.note = "";
  renderWatchers();
  // The subscribe resolves seconds later, by which time the watcher may
  // have been removed or the socket replaced (disconnect / reconnect
  // rejects the pending RPC via closeSocketQuiet). A continuation that
  // ignores that would register a live node subscription for a removed
  // address — never unsubscribed, still feeding signals — or stamp
  // ERROR over the "waiting" state a clean disconnect just set.
  function stillCurrent() {
    return state.ws === ws && state.watchers.indexOf(w) !== -1;
  }
  rpcCall(p).then(function (subId) {
    if (state.reqToWatcher.get(p.id) === w.address) state.reqToWatcher.delete(p.id);
    if (!stillCurrent()) {
      // Superseded. If the socket that granted the subscription is
      // still the current one, the subscription is live on the node
      // for an address nobody watches — release it instead of leaking
      // it into subToWatcher. (On a dead socket it died with it.)
      if (state.ws === ws && ws) {
        try { rpcCall(C.buildTxWatchUnsubscribe(String(subId))).catch(function () {}); } catch (e) {}
      }
      return;
    }
    w.subId = String(subId);
    w.status = "live";
    state.subToWatcher.set(w.subId, w.address);
    logConn("txWatch live for " + C.shorten(w.address, 12, 8));
    renderWatchers();
  }).catch(function (e) {
    if (state.reqToWatcher.get(p.id) === w.address) state.reqToWatcher.delete(p.id);
    if (!stillCurrent()) return; // a superseded attempt's failure changes nothing
    w.status = "error";
    w.note = e.code === 5011 ? "node rejected the address (invalid SS58)" : e.message;
    logConn("txWatch subscribe failed for " + C.shorten(w.address, 12, 8) + ": " + e.message, true);
    renderWatchers();
  });
}

function subscribeAllWatchers() {
  state.watchers.forEach(function (w) {
    if (w.status !== "live") subscribeWatcher(w);
  });
}

function markWatchersWaiting(note) {
  state.watchers.forEach(function (w) {
    w.status = "waiting";
    w.subId = null;
    w.note = note || "";
  });
  state.subToWatcher.clear();
  state.reqToWatcher.clear();
  renderWatchers();
}

function removeWatcher(addr) {
  var w = null;
  state.watchers = state.watchers.filter(function (x) {
    if (x.address === addr) { w = x; return false; }
    return true;
  });
  if (w) {
    // A subscribe may still be in flight for this address; drop its
    // pending-request entries now — subscribeWatcher's continuations
    // identity-check the watch list and release a late-granted
    // subscription instead of registering it.
    state.reqToWatcher.forEach(function (addr, id) {
      if (addr === w.address) state.reqToWatcher.delete(id);
    });
  }
  if (w && w.subId && state.connected) {
    rpcCall(C.buildTxWatchUnsubscribe(w.subId)).catch(function () {});
    state.subToWatcher.delete(w.subId);
  }
  saveWatchers();
  renderWatchers();
}

function renderWatchers() {
  var box = $("watchers-list");
  var pill = $("watcher-count");
  pill.hidden = !state.watchers.length;
  pill.textContent = state.watchers.length;
  if (!state.watchers.length) {
    box.innerHTML = "<div class='qmb-empty'>No addresses on the watch list yet. Add one above — the moment a transfer <em>requesting</em> that address enters the node's pool, it lands in the signal feed below.</div>";
    return;
  }
  box.innerHTML = state.watchers.map(function (w) {
    var badge = w.status === "live" ? "<span class='badge live'>● LIVE</span>"
      : w.status === "subscribing" ? "<span class='badge snap'>◌ SUBSCRIBING</span>"
      : w.status === "error" ? "<span class='badge off'>✕ ERROR</span>"
      : "<span class='badge off'>○ WAITING</span>";
    return "<div class='watcher qmb-rise'>" +
      "<div class='w-main'>" +
      "<div class='w-label'>" + (w.label ? esc(w.label) : "<span class='muted'>Unlabeled</span>") + " " + badge + "</div>" +
      "<div class='mono w-addr'>" + esc(C.shorten(w.address, 16, 12)) + "</div>" +
      (w.note ? "<div class='w-note'>" + esc(w.note) + "</div>" : "") +
      "</div>" +
      "<div class='w-actions'>" +
      "<button class='mini' data-copy='" + esc(w.address) + "'>⧉ copy</button>" +
      "<button class='mini danger' data-remove='" + esc(w.address) + "'>remove</button>" +
      "</div></div>";
  }).join("");
  box.querySelectorAll("[data-remove]").forEach(function (b) {
    b.addEventListener("click", function () { removeWatcher(b.getAttribute("data-remove")); });
  });
  bindCopyButtons(box);
  renderHero();
}

function renderFeed() {
  var box = $("signal-feed");
  var count = $("signal-count");
  if (!state.feed.length) {
    box.innerHTML = "<div class='qmb-empty'>No pool signals yet. When connected and watching at least one address, every transfer that <em>requests</em> a watched address appears here within seconds of entering the node's pool — before any block confirms it.</div>";
    count.hidden = true;
    return;
  }
  count.hidden = false;
  count.textContent = state.feed.length;
  box.innerHTML = state.feed.map(function (n) {    var w = state.watchers.find(function (x) { return x.address === n.watchAddress; });
    var wlabel = w && w.label ? esc(w.label) : "watched address";
    return "<div class='signal qmb-rise'>" +
      "<div class='s-amount'>" + esc(C.formatCompact(n.amountPlanck)) + "</div>" +
      "<div class='s-body'>" +
      "<div class='s-row'><span class='tag'>" + esc(C.assetLabel(n.assetId)) + "</span>" +
      "<span class='tag warn'>unconfirmed</span>" +
      "<span class='muted small'>→ " + wlabel + " · " + C.formatAge(Date.now() - n.receivedAt) + " ago</span></div>" +
      "<div class='s-row small'>from <span class='mono'>" + (n.from ? esc(C.shorten(n.from, 12, 8)) : "<span class='muted'>unsigned / non-standard</span>") + "</span></div>" +
      "<div class='s-row small'>tx <span class='mono'>" + esc(C.shorten(n.txHash, 14, 10)) + "</span> " +
      "<button class='mini' data-copy='" + esc(n.txHash) + "'>⧉ copy hash</button></div>" +
      "</div></div>";
  }).join("");
  bindCopyButtons(box);
  renderHero();
}

function maybeNotify(note) {
  if (!state.notifyWanted) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    var w = state.watchers.find(function (x) { return x.address === note.watchAddress; });
    new Notification("QTC pool signal — " + C.formatCompact(note.amountPlanck), {
      body: "Unconfirmed transfer " + (w && w.label ? "to " + w.label : "to a watched address") +
        " detected in the node pool.",
      tag: note.txHash,
    });
  } catch (e) { /* notifications unavailable */ }
}

function requestNotify() {
  var msg = $("notify-msg");
  if (!("Notification" in window)) {
    msg.textContent = "This browser doesn't support notifications.";
    return;
  }
  var done = function () {
    if (Notification.permission === "granted") {
      state.notifyWanted = true;
      try { localStorage.setItem(LS.notify, "1"); } catch (e) {}
      msg.textContent = "On — pool signals will pop up while this tab is open.";
      msg.className = "form-msg ok";
    } else {
      msg.textContent = "Permission " + Notification.permission + " — signals stay in the feed.";
      msg.className = "form-msg";
    }
    renderNotifyBtn();
  };
  try {
    var p = Notification.requestPermission();
    if (p && p.then) p.then(done); else done();
  } catch (e) { done(); }
}

function renderNotifyBtn() {
  var b = $("btn-notify");
  b.textContent = state.notifyWanted ? "🔔 Signals popups: on" : "🔔 Enable signal popups";
}

/* ================= misc ui ================= */

function renderHero() {
  $("fact-node").textContent = state.connected
    ? state.endpoint.replace(/^wss?:\/\//, "").split("/")[0]
    : "offline";
  $("fact-pending").textContent = state.connected && state.poolLastPoll && !state.poolUnsupported
    ? state.pool.length.toLocaleString("en-US")
    : "—";
  $("fact-bytes").textContent = state.connected && state.poolSummary && !state.poolUnsupported
    ? state.poolSummary.totalBytes.toLocaleString("en-US") + " B"
    : "—";
  $("fact-watchers").textContent = state.watchers.length + " address" +
    (state.watchers.length === 1 ? "" : "es");
  $("fact-signals").textContent = String(state.feed.length);
}

function bindCopyButtons(root) {
  root.querySelectorAll("[data-copy]").forEach(function (b) {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", function () {
      var v = b.getAttribute("data-copy");
      var original = b.textContent;
      var done = function () {
        b.textContent = "copied ✓";
        setTimeout(function () { b.textContent = original; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(done, function () { fallbackCopy(v); done(); });
      } else { fallbackCopy(v); done(); }
    });
  });
}

function fallbackCopy(v) {
  try {
    var ta = document.createElement("textarea");
    ta.value = v;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch (e) {}
}

function switchTab(name) {
  document.querySelectorAll(".tabnav .tab").forEach(function (t) {
    var on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tabpane").forEach(function (p) {
    var on = p.id === "tab-" + name;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
  if (name === "mempool") drawSparkline();
}

/* ================= boot ================= */

function boot() {
  loadSaved();
  $("endpoint-input").value = state.endpoint;
  $("btn-connect").addEventListener("click", function () {
    if (state.connected || (state.ws && !state.userDisconnected)) disconnect();
    else connect();
  });
  $("watch-form").addEventListener("submit", function (e) {
    e.preventDefault();
    addWatcher();
  });
  $("btn-estimate-fees").addEventListener("click", estimatePoolFees);
  $("btn-fee-paste").addEventListener("click", estimatePasted);
  $("btn-notify").addEventListener("click", requestNotify);

  document.querySelectorAll(".tabnav .tab").forEach(function (t) {
    t.addEventListener("click", function () { switchTab(t.dataset.tab); });
  });

  renderConn();
  renderGauge(null);
  renderPoolHeader();
  renderPool();
  renderWatchers();
  renderFeed();
  renderFeeDesk();
  renderNotifyBtn();
  renderHero();
  drawSparkline();
  bindCopyButtons(document);

  window.addEventListener("resize", function () { drawSparkline(); });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
})();
