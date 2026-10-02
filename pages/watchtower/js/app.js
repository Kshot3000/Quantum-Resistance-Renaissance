/* QTC Watchtower — app UI (browser only). Classic script, no modules. */
(function () {
"use strict";

var $ = function (id) { return document.getElementById(id); };
var LS_KEY = "qtc-watchtower-v1";
var INDEXER = "https://sqm.quantus.com/v1/graphql";
var FETCH_TIMEOUT_MS = 8000;
var LIVE_QUERY = "query { status: chain_stats_by_pk(id: \"global\") { block_height total_accounts total_immediate_transfers total_scheduled_transfers } blocks: block(limit: 5, order_by: {height: desc}) { height hash timestamp reward } }";

/* ---------- tiny helpers ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function copyText(t) {
  function done(btn) { /* noop */ }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(function () { fallback(); });
  } else fallback();
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
}
function toast(msg, kind) {
  var el = $("watch-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = "form-msg " + (kind || "");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.textContent = ""; }, 6000);
}
function relTime(iso) {
  if (!iso) return "—";
  var ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return "just now";
  return QWATCH.formatAge(ms) + " ago";
}

/* ---------- state ---------- */
function blankState() {
  return {
    watchlist: [],   // {address, nick, note, addedAt, checkphrase:[5]}
    rules: [],       // {id, type, address, threshold, changeMode, severity, enabled}
    baselines: null, // QWATCH shape
    alerts: [],      // newest first, {id, ruleId, address, severity, title, detail, ts, read, synthetic}
    settings: { pollMinutes: 0, notify: false },
    lastScan: null,
    ruleSeq: 1,
  };
}
var state = blankState();
try {
  var raw = localStorage.getItem(LS_KEY);
  if (raw) {
    var parsed = JSON.parse(raw);
    Object.keys(blankState()).forEach(function (k) { if (parsed[k] !== undefined) state[k] = parsed[k]; });
  }
} catch (e) { /* corrupted storage: start clean */ }
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
}
function nextRuleId() { return "rule-" + (state.ruleSeq++) + "-" + Date.now().toString(36); }

/* ---------- validation ---------- */
function validateQuantusAddress(addr) {
  var a = String(addr == null ? "" : addr).trim();
  if (!a) return { ok: false, message: "Paste an address first." };
  var d = QSS58.ss58Decode(a);
  if (!d.ok) return { ok: false, message: d.error || "Bad SS58 checksum." };
  if (d.prefix !== 189)
    return { ok: false, message: "Valid checksum, but prefix " + d.prefix + " — not Quantus (189). Do not send QTC to it." };
  if (!d.key || d.key.length !== 32)
    return { ok: false, message: "Valid checksum, but the payload is not a 32-byte account key." };
  return { ok: true, address: a };
}
function derivePhrase(addr) {
  return QTC_CHECK.addressToChecksumAsync(addr, QTC_WORDLIST).catch(function () { return null; });
}

/* ---------- data loading (live-first, snapshot fallback) ---------- */
var chainData = null; // {live: {ok, source, fetchedAt, data}|null, source:"live"|"snapshot", ...}
function fetchJson(url, timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, cache: "no-store" })
    .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .catch(function (e) { clearTimeout(t); throw e; });
}
function loadChainData() {
  var bust = "?t=" + Date.now();
  var base = "../../data/";
  return fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: LIVE_QUERY }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (j) {
    if (j.errors) throw new Error(j.errors[0].message);
    return fetchJson(base + "live.json").catch(function () { return null; }).then(function (snap) {
      return { live: { ok: true, source: INDEXER, fetched_at: new Date().toISOString(), data: j.data }, snapshot: snap, mode: "live" };
    });
  }).catch(function () {
    return Promise.all([
      fetchJson(base + "live.json").catch(function () { return null; }),
      fetchJson(base + "flows.json" + bust).catch(function () { return null; }),
      fetchJson(base + "governance.json").catch(function () { return null; }),
      fetchJson(base + "whales.json").catch(function () { return null; }),
    ]).then(function (r) {
      return { live: r[0], flows: r[1], gov: r[2], whales: r[3], mode: "snapshot" };
    });
  }).then(function (both) {
    // Attach the auxiliary snapshots in live mode too (they're same-origin).
    if (both.mode === "live") {
      return Promise.all([
        fetchJson(base + "flows.json" + bust).catch(function () { return null; }),
        fetchJson(base + "governance.json").catch(function () { return null; }),
        fetchJson(base + "whales.json").catch(function () { return null; }),
      ]).then(function (r) {
        both.flows = r[0]; both.gov = r[1]; both.whales = r[2];
        return both;
      });
    }
    return both;
  });
}

function buildScanContext(bundle) {
  // flows.json is stored columnar (format v2, assets/flows-decode.js);
  // decode once here — idempotent, v1 object rows pass through untouched.
  if (bundle.flows && typeof QFlows !== "undefined" && QFlows.decode) bundle.flows = QFlows.decode(bundle.flows);
  var live = bundle.mode === "live" ? bundle.live : bundle.live;
  var src = bundle.mode === "live" ? bundle.live : bundle.live; // bundle.live is snapshot in snapshot mode
  var blocks = (src && src.data && src.data.blocks) || [];
  var head = blocks[0] || null;
  var transfers = (bundle.flows && bundle.flows.transfers) || [];
  var govData = (bundle.gov && bundle.gov.data) || {};
  var referenda = (govData.referenda || []).length;
  var upgrades = (govData.upgrades || []).length;
  var balances = QWATCH.buildBalanceMap((bundle.whales && bundle.whales.top) || []);
  return {
    bundle: bundle,
    balances: balances,
    byAddr: QWATCH.indexTransfers(transfers),
    transfers: transfers,
    referenda: referenda,
    upgrades: upgrades,
    upgradesList: govData.upgrades || [],
    headHeight: head ? head.height : null,
    headTsMs: head && head.timestamp ? new Date(head.timestamp).getTime() : NaN,
    snapshotCapturedAt: (bundle.mode === "snapshot" && src && src.fetched_at) || null,
    flowsMeta: (bundle.flows && bundle.flows.meta) || null,
    govFetchedAt: (bundle.gov && bundle.gov.fetched_at) || null,
  };
}

/* ---------- scan ---------- */
var scanning = false;
function scanNow() {
  if (scanning) return;
  scanning = true;
  var btn = $("btn-scan");
  btn.disabled = true; btn.textContent = "⟳ Scanning…";
  var started = Date.now();
  loadChainData().then(function (bundle) {
    var ctx = buildScanContext(bundle);
    chainData = ctx;
    var nowMs = Date.now();
    var res = QWATCH.evaluateRules(state.rules, state.baselines, {
      balances: ctx.balances, byAddr: ctx.byAddr, transfers: ctx.transfers,
      referenda: ctx.referenda, upgrades: ctx.upgrades, upgradesList: ctx.upgradesList,
      headHeight: ctx.headHeight, headTsMs: ctx.headTsMs,
      snapshotCapturedAt: ctx.snapshotCapturedAt,
    }, nowMs);
    state.baselines = res.baselines;
    var fresh = [];
    res.alerts.forEach(function (a) {
      if (!state.alerts.some(function (x) { return x.id === a.id; })) {
        a.read = false;
        state.alerts.unshift(a);
        fresh.push(a);
      }
    });
    state.alerts = state.alerts.slice(0, 500);
    state.lastScan = new Date(nowMs).toISOString();
    save();
    renderAll();
    if (fresh.length && state.settings.notify && "Notification" in window && Notification.permission === "granted") {
      fresh.slice(0, 3).forEach(function (a) {
        try { new Notification("QTC Watchtower: " + a.title, { body: a.detail.slice(0, 180) }); } catch (e) { /* ignore */ }
      });
    }
    toast("Scan complete in " + ((Date.now() - started) / 1000).toFixed(1) + "s — " +
          fresh.length + " new alert" + (fresh.length === 1 ? "" : "s") + ".", "ok");
    window.__watchtowerScanDone = true;
  }).catch(function (e) {
    toast("Scan failed: " + (e && e.message ? e.message : e), "err");
    window.__watchtowerScanDone = false;
  }).finally(function () {
    scanning = false;
    btn.disabled = false; btn.textContent = "⟳ Scan now";
  });
}

/* ---------- rendering ---------- */
var SEV_LABEL = { crit: "critical", warn: "warning", info: "info" };

function renderFacts() {
  var unread = state.alerts.filter(function (a) { return !a.read; }).length;
  var armed = state.rules.filter(function (r) { return r.enabled; }).length;
  $("fact-watched").textContent = state.watchlist.length + " address" + (state.watchlist.length === 1 ? "" : "es");
  $("fact-rules").textContent = armed + " active";
  $("fact-alerts").textContent = unread + " unread";
  var pill = $("alert-count");
  if (unread > 0) { pill.hidden = false; pill.textContent = unread; }
  else pill.hidden = true;
  if (chainData) {
    $("fact-head").textContent = chainData.headHeight != null ? "#" + chainData.headHeight.toLocaleString("en-US") : "—";
    $("fact-source").textContent = chainData.bundle.mode === "live" ? "live indexer" : "snapshot";
  }
  var lb = $("live-badge"), sb = $("snap-badge");
  if (chainData && chainData.bundle.mode === "live") {
    lb.hidden = false; sb.hidden = true;
  } else {
    lb.hidden = true; sb.hidden = false;
    var snap = chainData && chainData.bundle.live;
    var when = snap && snap.fetched_at;
    sb.textContent = when
      ? "◌ snapshot · block " + (chainData.headHeight != null ? "#" + chainData.headHeight.toLocaleString("en-US") : "?") +
        " · captured " + QWATCH.formatAge(Date.now() - new Date(when).getTime()) + " ago"
      : "◌ snapshot — unavailable";
  }
  $("scan-meta").textContent = "Last scan: " + (state.lastScan ? relTime(state.lastScan) + " (" + new Date(state.lastScan).toLocaleString() + ")" : "never");
}

function renderDash() {
  var cards = [];
  var w = state.watchlist.length;
  var armed = state.rules.filter(function (r) { return r.enabled; }).length;
  var unread = state.alerts.filter(function (a) { return !a.read; }).length;
  var crit = state.alerts.filter(function (a) { return !a.read && a.severity === "crit"; }).length;
  cards.push({ k: "Watching", v: String(w), sub: w === 1 ? "1 address under the lens" : w + " addresses under the lens", tone: "cool" });
  cards.push({ k: "Rules armed", v: String(armed), sub: state.rules.length + " total rules configured", tone: "warm" });
  cards.push({ k: "Unread alerts", v: String(unread), sub: crit ? crit + " critical need attention" : "nothing critical pending", tone: unread ? "hot" : "" });
  if (chainData) {
    var age = isNaN(chainData.headTsMs) ? "—" : QWATCH.formatAge(Date.now() - chainData.headTsMs);
    cards.push({ k: "Chain head", v: chainData.headHeight != null ? "#" + chainData.headHeight.toLocaleString("en-US") : "—",
                 sub: "newest block " + age + " old", tone: "" });
    cards.push({ k: "Referenda", v: String(chainData.referenda), sub: "on-chain parliament", tone: "" });
    cards.push({ k: "Transfers in window", v: chainData.transfers.length.toLocaleString("en-US"), sub: "15,000-block snapshot window", tone: "cool" });
  } else {
    cards.push({ k: "Chain head", v: "—", sub: "run a scan to light the tower", tone: "" });
  }
  $("dash-cards").innerHTML = cards.map(function (c) {
    return '<div class="card ' + c.tone + '"><span class="ck">' + esc(c.k) + '</span>' +
      '<span class="cv">' + esc(c.v) + '</span><span class="cs">' + esc(c.sub) + "</span></div>";
  }).join("");

  // Pulse: latest transfers, flagging watched addresses.
  var watched = {};
  state.watchlist.forEach(function (x) { watched[x.address] = x.nick || QWATCH.shortAddr(x.address); });
  var rows = (chainData ? chainData.transfers : []).slice().sort(function (a, b) { return b.block_height - a.block_height; }).slice(0, 12);
  var tb = $("pulse-body");
  if (!chainData) { tb.innerHTML = '<tr><td colspan="5" class="muted">Run a scan to load chain data.</td></tr>'; return; }
  tb.innerHTML = rows.map(function (t) {
    var amt;
    try { amt = QWATCH.formatQtc(BigInt(String(t.amount))); } catch (e) { amt = "?"; }
    function addrCell(a) {
      var wtag = watched[a] ? ' <span class="wtag" title="' + esc(watched[a]) + '">👁</span>' : "";
      return '<code title="' + esc(a) + '">' + esc(QWATCH.shortAddr(a)) + "</code>" + wtag;
    }
    return "<tr><td>#" + t.block_height + "</td><td>" + addrCell(t.from_id) + "</td><td>" +
      addrCell(t.to_id) + '</td><td class="num">' + esc(amt) + "</td><td>" +
      (watched[t.from_id] || watched[t.to_id] ? '<span class="wtag">watching</span>' : '<span class="muted">—</span>') + "</td></tr>";
  }).join("") || '<tr><td colspan="5" class="muted">No transfers in the current window.</td></tr>';
}

function renderWatchlist() {
  var el = $("watchlist");
  var sel = $("rule-address");
  sel.innerHTML = state.watchlist.map(function (x) {
    return '<option value="' + esc(x.address) + '">' + esc(x.nick || QWATCH.shortAddr(x.address)) + "</option>";
  }).join("") || '<option value="">— add an address first —</option>';
  if (!state.watchlist.length) {
    el.innerHTML = '<div class="empty">No addresses under watch yet. Add your first one above — cold wallets, the vesting pool, an exchange hot wallet, a miner you admire.</div>';
    return;
  }
  el.innerHTML = state.watchlist.map(function (x, i) {
    var bal = null, balNote = "";
    if (chainData) {
      if (chainData.balances.has(x.address)) bal = chainData.balances.get(x.address);
      else balNote = "balance unknown — outside the top-200 snapshot";
    } else balNote = "run a scan to load balances";
    var act = chainData ? QWATCH.addressActivity(chainData.byAddr, x.address) : null;
    var phrases = (x.checkphrase || []).map(function (w) { return '<span class="pw">' + esc(w) + "</span>"; }).join("");
    var rules = state.rules.filter(function (r) { return r.address === x.address; });
    return '<div class="wcard" data-i="' + i + '">' +
      '<div class="whead"><strong>' + esc(x.nick || QWATCH.shortAddr(x.address)) + "</strong>" +
      '<button class="mini danger" data-act="rm" title="Remove from watchlist">✕</button></div>' +
      '<div class="waddr" data-copy-addr title="Click to copy">' + esc(x.address) + "</div>" +
      '<div class="pcheck">' + (phrases || '<span class="muted">deriving checkphrase…</span>') + "</div>" +
      (x.note ? '<div class="wnote">' + esc(x.note) + "</div>" : "") +
      '<div class="wstats">' +
        '<span><b>Balance</b> ' + (bal != null ? esc(QWATCH.formatQtc(bal)) + " QTC" : '<em class="muted">' + esc(balNote) + "</em>") + "</span>" +
        '<span><b>Window activity</b> ' + (act ? act.count + " transfers" : "—") + "</span>" +
        '<span><b>Rules</b> ' + rules.length + " (" + rules.filter(function (r) { return r.enabled; }).length + " armed)</span>" +
      "</div></div>";
  }).join("");
  el.querySelectorAll('[data-copy-addr]').forEach(function (n) {
    n.addEventListener("click", function () { copyText(n.textContent.trim()); toast("Address copied.", "ok"); });
  });
  el.querySelectorAll('[data-act="rm"]').forEach(function (b) {
    b.addEventListener("click", function () {
      var i = +b.closest(".wcard").dataset.i;
      var removed = state.watchlist.splice(i, 1)[0];
      state.rules = state.rules.filter(function (r) { return r.address !== removed.address; });
      delete (state.baselines && state.baselines.addresses || {})[removed.address];
      save(); renderAll();
    });
  });
}

function ruleNeedsThreshold(type) {
  return ["balance_below", "balance_above", "balance_change", "incoming_ge", "outgoing_ge", "whale_ge", "chain_stall"].indexOf(type) !== -1;
}
function ruleThresholdHint(type) {
  switch (type) {
    case "balance_below": case "balance_above": return "QTC, e.g. 1000";
    case "balance_change": return "% or QTC, e.g. 10";
    case "incoming_ge": case "outgoing_ge": return "QTC, e.g. 5000";
    case "whale_ge": return "QTC, e.g. 50000";
    case "chain_stall": return "minutes, e.g. 30";
    default: return "";
  }
}
function syncRuleForm() {
  var type = $("rule-type").value;
  var t = QWATCH.RULE_TYPES[type];
  $("rule-addr-wrap").style.display = t.scope === "address" ? "" : "none";
  $("rule-thr-wrap").style.display = ruleNeedsThreshold(type) ? "" : "none";
  $("rule-mode-wrap").hidden = type !== "balance_change";
  $("rule-threshold").placeholder = ruleThresholdHint(type);
}
function renderRules() {
  syncRuleForm();
  var el = $("rules-list");
  if (!state.rules.length) {
    el.innerHTML = '<div class="empty">No rules armed. Build your first above — the self-test button shows you exactly what an alert looks like before the chain produces one.</div>';
    return;
  }
  el.innerHTML = state.rules.map(function (r) {
    var nick = "";
    if (r.address) {
      var w = state.watchlist.find(function (x) { return x.address === r.address; });
      nick = w ? (w.nick || QWATCH.shortAddr(r.address)) : QWATCH.shortAddr(r.address);
    }
    return '<div class="rule' + (r.enabled ? "" : " off") + '" data-id="' + esc(r.id) + '">' +
      '<span class="sev ' + r.severity + '">' + SEV_LABEL[r.severity] + "</span>" +
      '<span class="rbody"><strong>' + esc(QWATCH.ruleLabel(r)) + "</strong>" +
      (nick ? '<span class="rmuted">on ' + esc(nick) + "</span>" : "") + "</span>" +
      '<button class="mini" data-ract="toggle">' + (r.enabled ? "⏸ pause" : "▶ arm") + "</button>" +
      '<button class="mini danger" data-ract="del">✕</button></div>';
  }).join("");
  el.querySelectorAll("[data-ract]").forEach(function (b) {
    b.addEventListener("click", function () {
      var id = b.closest(".rule").dataset.id;
      var r = state.rules.find(function (x) { return x.id === id; });
      if (!r) return;
      if (b.dataset.ract === "toggle") r.enabled = !r.enabled;
      else state.rules = state.rules.filter(function (x) { return x.id !== id; });
      save(); renderAll();
    });
  });
}

var syntheticAlerts = []; // self-test output, shown but never persisted
function renderAlerts() {
  var feed = $("alerts-feed");
  var f = $("alert-filter").value;
  var all = syntheticAlerts.concat(state.alerts).filter(function (a) {
    return f === "all" || a.severity === f;
  });
  if (!all.length) {
    feed.innerHTML = '<div class="empty">No alerts yet. Arm some rules and hit <strong>Scan now</strong> — or press <strong>Self-test rules</strong> to preview the alarm sound of each one.</div>';
    return;
  }
  feed.innerHTML = all.map(function (a) {
    return '<div class="alert ' + a.severity + (a.read ? " read" : "") + '" data-id="' + esc(a.id) + '">' +
      '<span class="sev ' + a.severity + '">' + SEV_LABEL[a.severity] + "</span>" +
      '<div class="abody"><strong>' + esc(a.title) + "</strong>" +
      (a.synthetic ? ' <span class="synth">SELF-TEST</span>' : "") +
      "<p>" + esc(a.detail) + "</p>" +
      '<span class="amuted">' + esc(relTime(a.ts)) + (a.address && a.address.indexOf("self-test") === -1 ? " · " + esc(QWATCH.shortAddr(a.address)) : "") + "</span></div>" +
      (a.synthetic ? "" : '<button class="mini" data-aact="read">' + (a.read ? "↩ unread" : "✓ read") + "</button>") +
      "</div>";
  }).join("");
  feed.querySelectorAll("[data-aact]").forEach(function (b) {
    b.addEventListener("click", function () {
      var id = b.closest(".alert").dataset.id;
      var a = state.alerts.find(function (x) { return x.id === id; });
      if (a) { a.read = !a.read; save(); renderAll(); }
    });
  });
}

function renderDataKv() {
  var kv = $("data-kv");
  if (!chainData) { kv.innerHTML = "<dt>Status</dt><dd>Run a scan to load chain data.</dd>"; return; }
  var b = chainData.bundle;
  var snap = b.live; // snapshot payload in snapshot mode; live response in live mode
  var rows = [
    ["Mode", b.mode === "live" ? "LIVE — public Subsquid indexer (sqm.quantus.com)" : "SNAPSHOT — committed same-origin data (indexer unreachable from this browser)"],
    ["Snapshot captured", (snap && snap.fetched_at) ? new Date(snap.fetched_at).toLocaleString() + " (" + QWATCH.formatAge(Date.now() - new Date(snap.fetched_at).getTime()) + " ago)" : "—"],
    ["Chain head in data", chainData.headHeight != null ? "#" + chainData.headHeight.toLocaleString("en-US") : "—"],
    ["Transfer window", chainData.flowsMeta ? chainData.flowsMeta.window_blocks.toLocaleString("en-US") + " blocks · " + chainData.transfers.length.toLocaleString("en-US") + " transfers ≥ " + chainData.flowsMeta.dust_threshold_qtc + " QTC" : chainData.transfers.length + " transfers"],
    ["Governance snapshot", chainData.govFetchedAt ? new Date(chainData.govFetchedAt).toLocaleString() + " · " + chainData.referenda + " referenda · " + chainData.upgrades + " upgrades" : chainData.referenda + " referenda · " + chainData.upgrades + " upgrades"],
    ["Balance coverage", "top-200 rich-list snapshot (" + chainData.balances.size + " addresses)"],
    ["Last scan", state.lastScan ? new Date(state.lastScan).toLocaleString() : "never"],
  ];
  kv.innerHTML = rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("");
}

function renderAll() {
  renderFacts(); renderDash(); renderWatchlist(); renderRules(); renderAlerts(); renderDataKv();
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tabnav .tab").forEach(function (t) {
  t.addEventListener("click", function () {
    document.querySelectorAll(".tabnav .tab").forEach(function (x) { x.classList.remove("active"); });
    t.classList.add("active");
    document.querySelectorAll(".tabpane").forEach(function (p) { p.hidden = true; p.classList.remove("active"); });
    var pane = $("tab-" + t.dataset.tab);
    pane.hidden = false; pane.classList.add("active");
    try { history.replaceState(null, "", "#" + t.dataset.tab); } catch (e) { /* ignore */ }
  });
});

/* ---------- watchlist form ---------- */
$("watch-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var addrIn = $("watch-address").value;
  var v = validateQuantusAddress(addrIn);
  if (!v.ok) { toast(v.message, "err"); return; }
  if (state.watchlist.some(function (x) { return x.address === v.address; })) {
    toast("That address is already under watch.", "err"); return;
  }
  var entry = {
    address: v.address,
    nick: $("watch-nick").value.trim(),
    note: $("watch-note").value.trim(),
    addedAt: new Date().toISOString(),
    checkphrase: null,
  };
  state.watchlist.push(entry);
  save(); renderAll();
  toast("Watching " + (entry.nick || QWATCH.shortAddr(entry.address)) + " — deriving checkphrase…", "ok");
  $("watch-address").value = ""; $("watch-nick").value = ""; $("watch-note").value = "";
  derivePhrase(entry.address).then(function (w) {
    entry.checkphrase = w; save(); renderWatchlist();
  });
});

/* ---------- rule form ---------- */
$("rule-type").addEventListener("change", syncRuleForm);
$("rule-form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var type = $("rule-type").value;
  var t = QWATCH.RULE_TYPES[type];
  var rule = { id: nextRuleId(), type: type, severity: $("rule-severity").value, enabled: true };
  if (t.scope === "address") {
    var addr = $("rule-address").value;
    if (!addr) { toast("Add a watched address first.", "err"); return; }
    rule.address = addr;
  }
  if (ruleNeedsThreshold(type)) {
    var thr = $("rule-threshold").value.trim();
    try {
      if (type === "chain_stall") { if (!(parseFloat(thr) > 0)) throw new Error("minutes must be > 0"); }
      else if (type === "balance_change" && $("rule-mode").value === "pct") { if (!(parseFloat(thr) > 0)) throw new Error("percent must be > 0"); }
      else QWATCH.parseQtcToPlancks(thr);
    } catch (e) { toast("Bad threshold: " + e.message, "err"); return; }
    rule.threshold = thr;
    if (type === "balance_change") rule.changeMode = $("rule-mode").value;
  }
  state.rules.push(rule);
  save(); renderAll();
  toast("Rule armed: " + QWATCH.ruleLabel(rule), "ok");
  $("rule-threshold").value = "";
});

$("btn-selftest").addEventListener("click", function () {
  var enabled = state.rules.filter(function (r) { return r.enabled; });
  if (!enabled.length) { toast("Arm at least one rule before self-testing.", "err"); return; }
  syntheticAlerts = QWATCH.runSelfTest(state.rules, Date.now()).map(function (a) {
    a.read = false; return a;
  });
  document.querySelector('.tab[data-tab="alerts"]').click();
  renderAlerts();
  toast(syntheticAlerts.length + " self-test alerts generated (synthetic — not chain data).", "ok");
});

/* ---------- alerts controls ---------- */
$("btn-read").addEventListener("click", function () {
  state.alerts.forEach(function (a) { a.read = true; });
  save(); renderAll();
});
$("btn-clear").addEventListener("click", function () {
  var n = state.alerts.filter(function (a) { return a.read; }).length;
  state.alerts = state.alerts.filter(function (a) { return !a.read; });
  save(); renderAll();
  toast(n + " read alerts cleared.", "ok");
});
$("alert-filter").addEventListener("change", renderAlerts);
$("btn-notify").addEventListener("click", function () {
  if (!("Notification" in window)) { toast("This browser does not support notifications.", "err"); return; }
  Notification.requestPermission().then(function (p) {
    state.settings.notify = (p === "granted");
    save(); updateNotifyBtn();
    toast(p === "granted" ? "Notifications on — the tower will ping you on new alerts." : "Notification permission " + p + ".", p === "granted" ? "ok" : "err");
  });
});
function updateNotifyBtn() {
  var ok = "Notification" in window && Notification.permission === "granted";
  $("btn-notify").textContent = ok ? "🔔 Notifications on" : "🔔 Enable browser notifications";
  $("notify-note").textContent = ok
    ? "Notifications fire only while this tab is open. The tower never sends your watchlist anywhere — everything is evaluated in this browser."
    : "Notifications fire only while this tab is open. The tower never sends your watchlist anywhere — everything is evaluated in this browser.";
}
var pollTimer = null;
function armPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  var mins = +$("poll-interval").value;
  state.settings.pollMinutes = mins;
  save();
  if (mins > 0) pollTimer = setInterval(scanNow, mins * 60000);
}
$("poll-interval").addEventListener("change", armPolling);
$("poll-interval").value = String(state.settings.pollMinutes || 0);
$("btn-scan").addEventListener("click", scanNow);

/* ---------- export / import ---------- */
$("btn-export").addEventListener("click", function () {
  var payload = {
    app: "qtc-watchtower", version: 1, exportedAt: new Date().toISOString(),
    watchlist: state.watchlist, rules: state.rules, baselines: state.baselines,
  };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "qtc-watchtower-backup.json";
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
});
$("file-import").addEventListener("change", function (ev) {
  var f = ev.target.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function () {
    try {
      var p = JSON.parse(rd.result);
      if (!p || p.app !== "qtc-watchtower" || !Array.isArray(p.watchlist)) throw new Error("not a Watchtower backup");
      var added = 0;
      p.watchlist.forEach(function (x) {
        var v = validateQuantusAddress(x.address);
        if (!v.ok) return;
        if (!state.watchlist.some(function (y) { return y.address === v.address; })) {
          state.watchlist.push({ address: v.address, nick: String(x.nick || ""), note: String(x.note || ""), addedAt: new Date().toISOString(), checkphrase: null });
          added++;
        }
      });
      (p.rules || []).forEach(function (r) {
        if (QWATCH.RULE_TYPES[r.type]) {
          r.id = nextRuleId();
          state.rules.push(r);
        }
      });
      save(); renderAll();
      // backfill checkphrases for imported entries
      state.watchlist.filter(function (x) { return !x.checkphrase; }).forEach(function (x) {
        derivePhrase(x.address).then(function (w) { x.checkphrase = w; save(); renderWatchlist(); });
      });
      toast("Imported " + added + " new addresses and " + (p.rules || []).length + " rules.", "ok");
    } catch (e) { toast("Import failed: " + e.message, "err"); }
    ev.target.value = "";
  };
  rd.readAsText(f);
});

/* ---------- footer copy buttons ---------- */
document.querySelectorAll("[data-copy]").forEach(function (btn) {
  btn.addEventListener("click", function () { copyText(btn.dataset.copy); toast("Donation address copied.", "ok"); });
});

/* ---------- radar canvas ---------- */
(function radar() {
  var cv = $("scanfield"), ctx = cv.getContext("2d"), W2, H2, ang = 0;
  var dots = [];
  function size() {
    W2 = cv.width = window.innerWidth; H2 = cv.height = window.innerHeight;
    dots = [];
    for (var i = 0; i < 40; i++) {
      dots.push({ x: Math.random() * W2, y: Math.random() * H2, r: Math.random() * 1.6 + 0.4, p: Math.random() * Math.PI * 2 });
    }
  }
  size(); window.addEventListener("resize", size);
  var cx = function () { return W2 / 2; }, cy = function () { return 120; };
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function frame() {
    ctx.clearRect(0, 0, W2, H2);
    ang += 0.006;
    var maxR = Math.min(W2, H2) * 0.7;
    // sweep
    for (var ring = 1; ring <= 3; ring++) {
      ctx.beginPath();
      ctx.arc(cx(), cy(), (maxR / 3) * ring, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(143,214,255,0.05)";
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx(), cy());
    ctx.arc(cx(), cy(), maxR, ang - 0.35, ang);
    ctx.closePath();
    var grad = ctx.createRadialGradient(cx(), cy(), 0, cx(), cy(), maxR);
    grad.addColorStop(0, "rgba(143,214,255,0.10)");
    grad.addColorStop(1, "rgba(143,214,255,0)");
    ctx.fillStyle = grad;
    ctx.fill();
    // drifting dots
    var t = Date.now() / 1000;
    dots.forEach(function (d) {
      var tw = 0.35 + 0.3 * Math.sin(t * 1.4 + d.p);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(143,214,255," + tw.toFixed(3) + ")";
      ctx.fill();
    });
    if (!REDUCE_MOTION) requestAnimationFrame(frame);
  }
  frame();
})();

/* ---------- init ---------- */
(function init() {
  updateNotifyBtn();
  renderAll();
  if (state.settings.pollMinutes > 0) armPolling();
  // backfill checkphrases quietly
  state.watchlist.filter(function (x) { return !x.checkphrase; }).forEach(function (x) {
    derivePhrase(x.address).then(function (w) { x.checkphrase = w; save(); renderWatchlist(); });
  });
  var startTab = (location.hash || "").replace("#", "");
  if (["dash", "watch", "rules", "alerts", "data"].indexOf(startTab) >= 0) {
    var btn = document.querySelector('.tab[data-tab="' + startTab + '"]');
    if (btn) btn.click();
  }
  // Auto-load chain data on boot so the tower lights up by itself.
  scanNow();
  window.__watchtowerReady = true;
})();
})();
