/* QTC Ledger Desk — app.js (UI layer).
 * Pure-logic lives in ledger-core.js (global QTCLedger).
 * Reuses the shared, vector-tested SS58 + checkphrase modules from
 * ../contact-vault/js/ (globals QSS58, QTC_CHECK, QTC_WORDLIST).
 */
(function () {
"use strict";
var L = window.QTCLedger;
var LS_KEY = "qtc-ledger-desk-v1";
var DATA = "../../data/";
var ANCHOR_REWARD = 320000000000n; // planck; indexer-observed at block 137536
var ANCHOR_HEIGHT = 137536;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function uid() { return "ev" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

/* ---------------- state ---------------- */
var state = { addresses: [], events: [], prices: [], method: "FIFO" };
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state, function (k, v) {
      return typeof v === "bigint" ? "bigint:" + v.toString() : v;
    }));
  } catch (e) { /* storage full/blocked: session-only */ }
}
function load() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    state = JSON.parse(raw, function (k, v) {
      if (typeof v === "string" && v.indexOf("bigint:") === 0) return BigInt(v.slice(7));
      return v;
    });
  } catch (e) { state = { addresses: [], events: [], prices: [], method: "FIFO" }; }
  if (!state.addresses) state.addresses = [];
  if (!state.events) state.events = [];
  if (!state.prices) state.prices = [];
  if (!state.method) state.method = "FIFO";
}

function priceLookup(ms) {
  var k = L.dayKey(ms), best = null;
  state.prices.forEach(function (p) { if (p.day <= k) best = BigInt(p.micro); });
  return best;
}
function typePill(t) {
  var cls = L.INFLOW[t] ? "in" : (t === "fee" ? "fee" : "out");
  var label = t.replace(/_/g, " ");
  return '<span class="type-pill ' + cls + '">' + esc(label) + "</span>";
}
function shortAddr(a) {
  return a.length > 22 ? a.slice(0, 12) + "\u2026" + a.slice(-8) : a;
}
function addrLabel(a) {
  var f = state.addresses.find(function (x) { return x.address === a; });
  return f ? (f.label || shortAddr(a)) : shortAddr(a);
}

/* ---------------- wallet vault ---------------- */
function renderVault() {
  var box = $("addrList");
  if (!state.addresses.length) {
    box.innerHTML = '<div class="empty">No addresses yet &mdash; add the wallets you control above.</div>';
  } else {
    box.innerHTML = state.addresses.map(function (a, i) {
      return '<div class="addr-row"><span class="a">' + esc(a.address) + "</span>" +
        '<span class="lbl">' + esc(a.label || "") + "</span>" +
        '<span class="words">' + esc((a.words || []).join(" ")) + "</span>" +
        '<button class="btn danger-ghost" data-rm="' + i + '" type="button">remove</button></div>';
    }).join("");
  }
  box.querySelectorAll("[data-rm]").forEach(function (b) {
    b.addEventListener("click", function () {
      state.addresses.splice(Number(b.getAttribute("data-rm")), 1);
      save(); renderVault(); renderEventForm(); renderHero();
    });
  });
  renderEventForm();
}

function handleAddrSubmit(ev) {
  ev.preventDefault();
  var input = $("addrInput").value.trim();
  var label = $("addrLabel").value.trim();
  var line = $("addrCheck");
  line.innerHTML = '<span class="muted">validating\u2026</span>';
  var dec;
  try { dec = window.QSS58.ss58Decode(input); }
  catch (e) { line.innerHTML = '<span class="bad">Not a valid SS58 address: ' + esc(e.message) + "</span>"; return; }
  if (!dec.ok) { line.innerHTML = '<span class="bad">' + esc(dec.error || "Invalid address") + "</span>"; return; }
  if (dec.prefix !== 189) {
    line.innerHTML = '<span class="bad">Valid SS58, but prefix ' + dec.prefix +
      " \u2014 not a Quantus (189) address.</span>";
    return;
  }
  if (state.addresses.some(function (a) { return a.address === input; })) {
    line.innerHTML = '<span class="bad">Already in your vault.</span>'; return;
  }
  line.innerHTML = '<span class="muted">deriving checkphrase (40k PBKDF2 rounds)\u2026</span>';
  window.QTC_CHECK.addressToChecksumAsync(input, window.QTC_WORDLIST).then(function (words) {
    line.innerHTML = '<span class="ok">\u2713 checksum valid &middot; SS58 prefix 189.</span><br>' +
      '<span class="words">checkphrase: ' + esc(words.join(" ")) + "</span><br>" +
      '<span class="muted">Read the five words back. If they match what you expect for this address, confirm:</span> ' +
      '<button class="btn" id="addrConfirm" type="button">Words match &mdash; add address</button>';
    $("addrConfirm").addEventListener("click", function () {
      state.addresses.push({ address: input, label: label, words: words, addedAt: Date.now() });
      $("addrInput").value = ""; $("addrLabel").value = "";
      line.innerHTML = '<span class="ok">\u2713 added to vault.</span>';
      save(); renderVault(); renderHero();
    });
  }).catch(function (e) {
    line.innerHTML = '<span class="bad">checkphrase failed: ' + esc(e.message) + "</span>";
  });
}

/* ---------------- auto-detect ---------------- */
var detections = [];
function tsForHeight(h, anchorH, anchorMs, blockS) {
  return Math.round(anchorMs - (anchorH - h) * blockS * 1000);
}
/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}

async function runScan() {
  var status = $("scanStatus"), list = $("detectList");
  detections = [];
  $("detectActions").hidden = true;
  if (!state.addresses.length) {
    status.textContent = "Add at least one vault address first.";
    return;
  }
  status.textContent = "Loading snapshots\u2026";
  list.innerHTML = "";
  var miners, live, flows;
  try {
    miners = await (await fetch(DATA + "miners.json", { signal: timeoutSignal(9000) })).json();
    live = await (await fetch(DATA + "live.json", { signal: timeoutSignal(9000) })).json();
    // flows.json is stored columnar (format v2, assets/flows-decode.js);
    // decode restores the v1 object rows (id/fee/extrinsic_id included).
    var flowsRaw = await (await fetch(DATA + "flows.json", { signal: timeoutSignal(20000) })).json();
    flows = (typeof QFlows !== "undefined" && QFlows.decode) ? QFlows.decode(flowsRaw) : flowsRaw;
  } catch (e) {
    status.textContent = "Could not load snapshots: " + e.message;
    return;
  }
  var headBlock = live.data.blocks[0];
  var anchorMs = Date.parse(headBlock.timestamp);
  var anchorH = headBlock.height;
  var blockS = miners.window.observed_block_time_s;
  var existingRefs = {};
  state.events.forEach(function (e) { if (e.ref) existingRefs[e.ref] = 1; });
  var vault = {};
  state.addresses.forEach(function (a) { vault[a.address] = 1; });

  // --- mining income: per-bucket counts x modeled reward at bucket midpoint
  state.addresses.forEach(function (va) {
    var addr = va.address;
    var winBlocks = (miners.window_miners && miners.window_miners[addr]) || 0;
    (miners.buckets || []).forEach(function (b) {
      var c = (b.miners && b.miners[addr]) || 0;
      if (!c) return;
      var mid = Math.floor((b.start + b.end) / 2);
      var qty = BigInt(c) * L.rewardModelPlancks(mid, ANCHOR_HEIGHT, ANCHOR_REWARD);
      if (qty <= 0n) return;
      var ref = "mine:" + addr + ":" + b.start + "-" + b.end;
      if (existingRefs[ref]) return;
      detections.push({ key: ref, ref: ref, dateMs: tsForHeight(b.end, anchorH, anchorMs, blockS),
        type: "mining_income", address: addr, qtyPlanck: qty,
        note: c + " blocks in " + b.start + "\u2013" + b.end + " \u00d7 modeled reward",
        flag: "modeled" });
    });
    // pre-window aggregate: clearly labeled, user splits by tax year
    var all = (miners.all_time || []).find(function (r) { return r.address === addr; });
    var pre = all ? all.blocks - winBlocks : 0;
    if (pre > 0) {
      var preMid = Math.floor(miners.window.start_height / 2);
      var preQty = BigInt(pre) * L.rewardModelPlancks(preMid, ANCHOR_HEIGHT, ANCHOR_REWARD);
      var preRef = "mine-pre:" + addr;
      if (!existingRefs[preRef]) {
        detections.push({ key: preRef, ref: preRef,
          dateMs: tsForHeight(miners.window.start_height, anchorH, anchorMs, blockS),
          type: "mining_income", address: addr, qtyPlanck: preQty,
          note: pre.toLocaleString("en-US") + " blocks 1\u2013" + miners.window.start_height +
            " \u00d7 avg modeled reward \u2014 AGGREGATE, split by tax year from your miner logs",
          flag: "aggregate" });
      }
    }
  });

  // --- transfers touching vault addresses (snapshot floor: >= 1 QTC)
  (flows.transfers || []).forEach(function (t) {
    var fromMine = !!vault[t.from_id], toMine = !!vault[t.to_id];
    if (!fromMine && !toMine) return;
    var ref = "tx:" + t.id;
    if (existingRefs[ref]) return;
    var bothMine = fromMine && toMine;
    detections.push({ key: ref, ref: ref, dateMs: Date.parse(t.timestamp),
      type: toMine ? "transfer_in" : "transfer_out",
      address: toMine ? t.to_id : t.from_id,
      qtyPlanck: BigInt(t.amount),
      feePlanck: BigInt(t.fee || "0"),
      note: "block " + t.block_height + " \u00b7 " + String(t.extrinsic_id).slice(0, 18) + "\u2026" +
        (bothMine ? " \u00b7 both ends are yours \u2014 marked internal" : ""),
      internal: bothMine, flag: null });
  });

  detections.sort(function (a, b) { return a.dateMs - b.dateMs; });
  status.textContent = detections.length ?
    detections.length + " candidate events found. Review, then add the ones that are yours." :
    "No new on-chain activity for your vault addresses in these snapshots.";
  renderDetections();
  $("detectActions").hidden = !detections.length;
}
function renderDetections() {
  var list = $("detectList");
  list.innerHTML = detections.map(function (d, i) {
    return '<label class="detect-item"><input type="checkbox" data-det="' + i + '" checked>' +
      '<span class="grow"><span class="t">' + esc(d.type.replace(/_/g, " ")) + "</span>" +
      (d.flag ? '<span class="flag">' + esc(d.flag) + "</span>" : "") +
      '<div class="d">' + L.dayKey(d.dateMs) + " \u00b7 " + esc(addrLabel(d.address)) +
      " \u00b7 " + esc(d.note) + "</div></span>" +
      '<span class="amt">' + L.formatQtc(d.qtyPlanck, 2) + " QTC</span></label>";
  }).join("");
}
function addSelectedDetections() {
  var added = 0;
  document.querySelectorAll("[data-det]").forEach(function (cb) {
    if (!cb.checked) return;
    var d = detections[Number(cb.getAttribute("data-det"))];
    state.events.push({ id: uid(), dateMs: d.dateMs, type: d.type, address: d.address,
      qtyPlanck: d.qtyPlanck, priceMicro: null, feePlanck: d.feePlanck || 0n,
      note: d.note, source: "detect", ref: d.ref, internal: !!d.internal,
      flags: d.flag ? [d.flag] : [] });
    added++;
  });
  detections = [];
  $("detectList").innerHTML = "";
  $("detectActions").hidden = true;
  $("scanStatus").textContent = added ? added + " events added to the ledger." : "Nothing selected.";
  save(); renderAll();
}

/* ---------------- event ledger ---------------- */
function renderEventForm() {
  var sel = $("evAddress");
  var cur = sel.value;
  sel.innerHTML = '<option value="">(no address / external)</option>' +
    state.addresses.map(function (a) {
      return '<option value="' + esc(a.address) + '"' + (a.address === cur ? " selected" : "") + ">" +
        esc((a.label || shortAddr(a.address)) + " \u00b7 " + shortAddr(a.address)) + "</option>";
    }).join("");
}
function renderEvents() {
  var tb = $("eventTable").querySelector("tbody");
  var evs = state.events.map(L.normEvent).sort(function (a, b) { return b.dateMs - a.dateMs; });
  if (!evs.length) {
    tb.innerHTML = '<tr><td colspan="8"><div class="empty">Ledger is empty &mdash; add events manually or run auto-detect.</div></td></tr>';
  } else {
    tb.innerHTML = evs.map(function (e) {
      return "<tr><td>" + L.dayKey(e.dateMs) + "</td><td>" + typePill(e.type) +
        (e.internal ? ' <span class="type-pill">internal</span>' : "") + "</td>" +
        '<td class="addr" title="' + esc(e.address) + '">' + esc(shortAddr(e.address) || "\u2014") + "</td>" +
        '<td class="num">' + L.formatQtc(e.qtyPlanck, 4) + "</td>" +
        '<td class="num">' + (e.priceMicro === null ? '<span class="muted">\u2014</span>' : L.formatUsd(e.priceMicro)) + "</td>" +
        "<td>" + esc(e.note || "") + "</td>" +
        "<td>" + esc(e.source) + "</td>" +
        '<td><button class="rowbtn" data-del="' + e.id + '" type="button">delete</button></td></tr>';
    }).join("");
  }
  tb.querySelectorAll("[data-del]").forEach(function (b) {
    b.addEventListener("click", function () {
      state.events = state.events.filter(function (e) { return e.id !== b.getAttribute("data-del"); });
      save(); renderAll();
    });
  });
  // warnings from the engine
  var res = L.runLedger(state.events, state.method, priceLookup);
  var box = $("ledgerWarnings");
  box.innerHTML = res.errors.map(function (w) {
    return '<div class="warning' + (w.kind === "shortfall" ? " err" : "") + '">\u26a0 ' +
      esc(w.msg) + "</div>";
  }).join("");
}
function handleEventSubmit(ev) {
  ev.preventDefault();
  var qty = L.parseQtcToPlanck($("evQty").value);
  if (qty === null || qty <= 0n) { alert("Enter a valid QTC amount."); return; }
  var price = L.parseUsdPerQtcToMicro($("evPrice").value);
  if ($("evPrice").value.trim() !== "" && price === null) { alert("Enter a valid USD price."); return; }
  var dateMs = Date.parse($("evDate").value + "T12:00:00Z");
  if (!isFinite(dateMs)) { alert("Pick a date."); return; }
  state.events.push({ id: uid(), dateMs: dateMs, type: $("evType").value,
    address: $("evAddress").value, qtyPlanck: qty,
    priceMicro: price, feePlanck: 0n, note: $("evNote").value.trim(),
    source: "manual", ref: "", internal: $("evInternal").checked, flags: [] });
  $("evQty").value = ""; $("evPrice").value = ""; $("evNote").value = "";
  $("evInternal").checked = false;
  save(); renderAll();
}
function download(name, text, mime) {
  var b = new Blob([text], { type: mime || "text/plain" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportEventsCsv() {
  download("qtc-ledger-events.csv", L.eventsToCsv(state.events), "text/csv");
}
function importEventsCsv(file) {
  var rd = new FileReader();
  rd.onload = function () {
    var rows = L.parseCsv(String(rd.result || ""));
    if (!rows.length) { alert("Empty CSV."); return; }
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var idx = function (n) { return head.indexOf(n); };
    var added = 0, bad = 0;
    for (var i = 1; i < rows.length; i++) {
      try {
        var r = rows[i];
        var qty = L.parseQtcToPlanck(r[idx("amount_qtc")] || "");
        if (qty === null || qty <= 0n) { bad++; continue; }
        var dm = Date.parse(r[idx("date")] || "");
        if (!isFinite(dm)) { bad++; continue; }
        var t = (r[idx("type")] || "").trim();
        if (!L.INFLOW[t] && !L.OUTFLOW[t]) { bad++; continue; }
        var fee = L.parseQtcToPlanck(r[idx("fee_qtc")] || "") || 0n;
        state.events.push({ id: uid(), dateMs: dm, type: t,
          address: r[idx("address")] || "", qtyPlanck: qty,
          priceMicro: L.parseUsdPerQtcToMicro(r[idx("price_usd_per_qtc")] || ""),
          feePlanck: fee, note: r[idx("note")] || "", source: "csv-import",
          ref: "", internal: /^y/i.test(r[idx("internal")] || ""), flags: [] });
        added++;
      } catch (e) { bad++; }
    }
    save(); renderAll();
    alert("Imported " + added + " events" + (bad ? " (" + bad + " rows skipped)" : "") + ".");
  };
  rd.readAsText(file);
}

/* ---------------- price table ---------------- */
function renderPrices() {
  var box = $("priceList");
  var ps = state.prices.slice().sort(function (a, b) { return a.day < b.day ? -1 : 1; });
  box.innerHTML = ps.length ? ps.map(function (p, i) {
    return '<span class="price-chip">' + esc(p.day) + " \u00b7 " + L.formatUsd(BigInt(p.micro)) +
      '<button data-px="' + i + '" type="button" aria-label="remove">\u00d7</button></span>';
  }).join("") : '<div class="empty">No prices yet &mdash; USD figures will be flagged unpriced until you add some.</div>';
  box.querySelectorAll("[data-px]").forEach(function (b) {
    b.addEventListener("click", function () {
      var p = ps[Number(b.getAttribute("data-px"))];
      state.prices = state.prices.filter(function (x) { return x !== p; });
      save(); renderPrices(); renderAll();
    });
  });
}
function handlePriceSubmit(ev) {
  ev.preventDefault();
  var micro = L.parseUsdPerQtcToMicro($("pxValue").value);
  if (micro === null) { alert("Enter a valid USD price."); return; }
  var day = $("pxDate").value;
  if (!day) { alert("Pick a date."); return; }
  state.prices = state.prices.filter(function (p) { return p.day !== day; });
  state.prices.push({ day: day, micro: micro });
  $("pxValue").value = "";
  save(); renderPrices(); renderAll();
}

/* ---------------- cost-basis lots ---------------- */
function renderLots() {
  document.querySelectorAll('input[name="method"]').forEach(function (r) {
    r.checked = r.value === state.method;
  });
  var res = L.runLedger(state.events, state.method, priceLookup);
  var tb = $("lotTable").querySelector("tbody");
  if (!res.lots.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="empty">No lots yet &mdash; add inflow events.</div></td></tr>';
    return;
  }
  tb.innerHTML = res.lots.map(function (l) {
    var status = l.qtyPlanck === 0n ? '<span class="muted">consumed</span>' :
      l.basisUnknown ? '<span class="warning" style="border:none;background:none;padding:0">review basis</span>' :
      '<span class="type-pill in">open</span>';
    return "<tr><td>" + l.seq + "</td><td>" + L.dayKey(l.dateMs) + "</td>" +
      "<td>" + esc(l.type.replace(/_/g, " ")) + "</td>" +
      '<td class="num">' + L.formatQtc(l.qtyPlanck, 4) + "</td>" +
      '<td class="num">' + (l.basisUnknown ? '<span class="muted">?</span>' : L.formatUsd(l.unitCostMicro)) + "</td>" +
      '<td class="num">' + L.formatUsd(L.usdValueMicro(l.qtyPlanck, l.unitCostMicro)) + "</td>" +
      "<td>" + status + "</td></tr>";
  }).join("");
}

/* ---------------- tax-year report ---------------- */
var lastReport = null;
function buildReport() {
  var year = Number($("repYear").value) || 2026;
  lastReport = L.taxYearReport(state.events, state.method, priceLookup, year);
  var r = lastReport;
  var card = function (title, big, sub, cls) {
    return '<div class="rep-card"><h3>' + title + '</h3><div class="big ' + (cls || "") + '">' +
      big + '</div><div class="sub">' + sub + "</div></div>";
  };
  var unpricedNote = function (q) {
    return q > 0n ? " \u26a0 " + L.formatQtc(q, 2) + " QTC unpriced" : "";
  };
  var html = '<div class="rep-grid">' +
    card("Mining income (" + year + ")", L.formatUsd(r.mining.usd),
      L.formatQtc(r.mining.qty, 2) + " QTC" + unpricedNote(r.mining.unpricedQty)) +
    card("Other income", L.formatUsd(r.otherIncome.usd),
      L.formatQtc(r.otherIncome.qty, 2) + " QTC" + unpricedNote(r.otherIncome.unpricedQty)) +
    card("Short-term gain/loss", L.formatUsd(r.shortTerm.gain),
      r.shortTerm.count + " disposals \u00b7 proceeds " + L.formatUsd(r.shortTerm.proceeds), r.shortTerm.gain < 0n ? "neg" : "pos") +
    card("Long-term gain/loss", L.formatUsd(r.longTerm.gain),
      r.longTerm.count + " disposals \u00b7 proceeds " + L.formatUsd(r.longTerm.proceeds), r.longTerm.gain < 0n ? "neg" : "pos") +
    card("Fees paid", L.formatUsd(r.fees.usd), L.formatQtc(r.fees.qty, 4) + " QTC") +
    card("Inventory, Dec 31", L.formatQtc(r.inventory.qty, 2) + " QTC",
      "basis " + L.formatUsd(r.inventory.basis) +
      (r.inventory.market !== null ? " \u00b7 est. value " + L.formatUsd(r.inventory.market) : "")) +
    "</div>";
  if (r.errors.length) {
    html += '<div class="warnings">' + r.errors.map(function (w) {
      return '<div class="warning">\u26a0 ' + esc(w.msg) + "</div>";
    }).join("") + "</div>";
  }
  if (r.matches.length) {
    html += '<div class="table-wrap"><table class="ledger-table"><thead><tr>' +
      "<th>Disposal</th><th>Lot</th><th class=\"num\">Qty</th><th class=\"num\">Proceeds</th>" +
      "<th class=\"num\">Basis</th><th class=\"num\">Gain/Loss</th><th>Held</th></tr></thead><tbody>" +
      r.matches.map(function (m) {
        return "<tr><td>" + L.dayKey(m.disposalDateMs) + "</td><td>lot #" + m.lotSeq +
          (m.basisUnknown ? ' <span class="flag">basis?</span>' : "") + "</td>" +
          '<td class="num">' + L.formatQtc(m.qtyPlanck, 4) + "</td>" +
          '<td class="num">' + L.formatUsd(m.proceedsMicro) + "</td>" +
          '<td class="num">' + L.formatUsd(m.basisMicro) + "</td>" +
          '<td class="num">' + L.formatUsd(m.gainMicro) + "</td>" +
          "<td>" + m.heldDays + "d " + (m.longTerm ? "(LT)" : "(ST)") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  } else {
    html += '<div class="empty">No disposals in ' + year + ".</div>";
  }
  html += '<p class="rep-note">Method: ' + esc(r.method) + " \u00b7 long-term threshold: 365 days \u00b7 " +
    "unpriced events are excluded from USD totals and flagged above. " +
    "This report is a record-keeping aid, not tax advice.</p>";
  $("reportOut").innerHTML = html;
}
function exportReportCsv() {
  if (!lastReport) { alert("Build the report first."); return; }
  var r = lastReport, rows = [];
  rows.push(["section", "date", "detail", "qty_qtc", "usd"]);
  r.incomeRows.forEach(function (x) {
    rows.push(["income", L.dayKey(x.dateMs), x.type,
      (Number(x.qtyPlanck) / 1e12).toFixed(8),
      x.priced ? (Number(x.usdMicro) / 1e6).toFixed(2) : "UNPRICED"]);
  });
  r.matches.forEach(function (m) {
    rows.push(["disposal", L.dayKey(m.disposalDateMs),
      "lot #" + m.lotSeq + (m.longTerm ? " long-term" : " short-term"),
      (Number(m.qtyPlanck) / 1e12).toFixed(8),
      (Number(m.gainMicro) / 1e6).toFixed(2)]);
  });
  rows.push(["summary", String(r.year), "mining income USD", "",
    (Number(r.mining.usd) / 1e6).toFixed(2)]);
  rows.push(["summary", String(r.year), "short-term gain USD", "",
    (Number(r.shortTerm.gain) / 1e6).toFixed(2)]);
  rows.push(["summary", String(r.year), "long-term gain USD", "",
    (Number(r.longTerm.gain) / 1e6).toFixed(2)]);
  var csv = rows.map(function (x) {
    return x.map(function (c) { return "\"" + String(c).replace(/"/g, "\"\"") + "\""; }).join(",");
  }).join("\n");
  download("qtc-tax-report-" + r.year + ".csv", csv, "text/csv");
}

/* ---------------- hero stats ---------------- */
function renderHero() {
  var res = L.runLedger(state.events, state.method, priceLookup);
  var open = 0n, basis = 0n;
  res.lots.forEach(function (l) {
    if (l.qtyPlanck > 0n) { open += l.qtyPlanck; basis += L.usdValueMicro(l.qtyPlanck, l.unitCostMicro); }
  });
  var mined = 0n;
  state.events.forEach(function (e) {
    if (e.type === "mining_income") mined += BigInt(e.qtyPlanck);
  });
  $("heroStats").innerHTML =
    '<div class="stat"><div class="k">Tracked inventory</div><div class="v">' +
    L.formatQtc(open, 2) + ' <span style="font-size:1rem">QTC</span></div>' +
    '<div class="s">cost basis ' + L.formatUsd(basis) + " \u00b7 " + esc(state.method) + "</div></div>" +
    '<div class="stat"><div class="k">Mining income detected</div><div class="v">' +
    L.formatQtc(mined, 2) + ' <span style="font-size:1rem">QTC</span></div>' +
    '<div class="s">' + state.events.length + " ledger events \u00b7 " +
    state.addresses.length + " watched addresses</div></div>";
}

/* ---------------- vault export / wipe ---------------- */
function exportVault() {
  save();
  download("qtc-ledger-vault.json",
    localStorage.getItem(LS_KEY) || "{}",
    "application/json");
}
function wipeVault() {
  if (!confirm("Delete the entire local vault (addresses, events, prices)? This cannot be undone.")) return;
  state = { addresses: [], events: [], prices: [], method: "FIFO" };
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  renderAll();
}

/* ---------------- wiring ---------------- */
function renderAll() {
  renderVault(); renderEvents(); renderPrices(); renderLots(); renderHero();
}
function init() {
  load();
  $("addrForm").addEventListener("submit", handleAddrSubmit);
  $("btnScan").addEventListener("click", runScan);
  $("btnAddSelected").addEventListener("click", addSelectedDetections);
  $("btnDetectNone").addEventListener("click", function () {
    detections = []; $("detectList").innerHTML = "";
    $("detectActions").hidden = true; $("scanStatus").textContent = "";
  });
  $("eventForm").addEventListener("submit", handleEventSubmit);
  $("btnCsvExport").addEventListener("click", exportEventsCsv);
  $("btnCsvImport").addEventListener("click", function () { $("csvFile").click(); });
  $("csvFile").addEventListener("change", function () {
    if ($("csvFile").files[0]) importEventsCsv($("csvFile").files[0]);
    $("csvFile").value = "";
  });
  $("priceForm").addEventListener("submit", handlePriceSubmit);
  $("btnPxCsv").addEventListener("click", function () {
    var csv = "day,usd_per_qtc\n" + state.prices.map(function (p) {
      return p.day + "," + (Number(p.micro) / 1e6).toFixed(6);
    }).join("\n");
    download("qtc-price-table.csv", csv, "text/csv");
  });
  document.querySelectorAll('input[name="method"]').forEach(function (r) {
    r.addEventListener("change", function () {
      state.method = document.querySelector('input[name="method"]:checked').value;
      save(); renderLots(); renderHero(); renderEvents();
    });
  });
  $("btnReport").addEventListener("click", buildReport);
  $("btnRepCsv").addEventListener("click", exportReportCsv);
  $("btnRepJson").addEventListener("click", function () {
    if (!lastReport) { alert("Build the report first."); return; }
    download("qtc-tax-report-" + lastReport.year + ".json",
      JSON.stringify(lastReport, function (k, v) {
        return typeof v === "bigint" ? v.toString() : v;
      }, 2), "application/json");
  });
  $("btnPrint").addEventListener("click", function () { window.print(); });
  $("btnExportAll").addEventListener("click", exportVault);
  $("btnWipe").addEventListener("click", wipeVault);
  renderAll();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
})();
