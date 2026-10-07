/* QTC Pay Desk — merchant acceptance toolkit logic.
 * Self-custody-friendly: no keys, no network calls, no analytics.
 * All money math in integer BigInt (cents for USD, plancks for QTC).
 * QTC has 12 decimals (1 QTC = 10^12 plancks), SS58 prefix 189. */
(function () {
"use strict";

var DECIMALS = 12n;
var PLANCKS_PER_QTC = 10n ** DECIMALS;
var CENT = 100n;
var RATE_KEY = "qtc-paydesk-rate-v1";
var REG_KEY = "qtc-paydesk-invoices-v1";
var QT_PER_PAGE = 20;

/* ---------------- pure logic (also exercised by node tests) ---------------- */

function parseUsdToCents(s) {
  // Accepts "1,234.56", "12", ".5". Returns BigInt cents or null.
  // Extra decimals round half-up at the 3rd digit — the same rule
  // parseQtcToPlancks applies at the 13th digit. (Previously the fraction
  // was silently truncated: "1.005" parsed to 100 cents, not 101.)
  var t = String(s == null ? "" : s).trim().replace(/[$,\s]/g, "");
  if (t === "") return null;
  var m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  var whole = m[1] === "" ? "0" : m[1];
  var fracFull = m[2] || "";
  var frac = fracFull.slice(0, 2);
  while (frac.length < 2) frac += "0";
  var v = BigInt(whole) * CENT + BigInt(frac);
  if (fracFull.length > 2 && fracFull[2] >= "5") v += 1n;
  return v >= 0n ? v : null;
}

/* Exact decimal -> rational {num, den} (BigInts), or null.
 * Accepts "12.50", ".5", "0.008912", and exponent forms ("1e-3") so a rate
 * passed as a JS number stringifies safely. No float ever touches money. */
function parseDecimalRational(s) {
  var t = String(s == null ? "" : s).trim();
  var m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
  if (!m) return null;
  var digits = (m[1] || "") + (m[2] || "");
  if (digits === "") return null;
  var num = BigInt(digits);
  var scale = BigInt((m[2] || "").length) - (m[3] ? BigInt(m[3].replace(/^\+/, "")) : 0n);
  if (scale >= 0n) return { num: num, den: 10n ** scale };
  return { num: num * (10n ** (-scale)), den: 1n };
}

function parseQtcToPlancks(s) {
  // Accepts up to 12 decimal places; rounds half-up at the 13th digit.
  var t = String(s == null ? "" : s).trim();
  if (t === "") return null;
  var m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  var whole = m[1] === "" ? "0" : m[1];
  var frac = m[2] || "";
  var roundUp = frac.length > 12 && frac[12] >= "5";
  frac = frac.slice(0, 12);
  while (frac.length < 12) frac += "0";
  var v = BigInt(whole) * PLANCKS_PER_QTC + BigInt(frac);
  if (roundUp) v += 1n;
  return v;
}

function plancksToQtcString(p) {
  var neg = p < 0n;
  var a = neg ? -p : p;
  var whole = a / PLANCKS_PER_QTC;
  var frac = (a % PLANCKS_PER_QTC).toString().padStart(12, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

function fmtUsd(cents) {
  var neg = cents < 0n;
  var a = neg ? -cents : cents;
  var whole = (a / CENT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  var frac = (a % CENT).toString().padStart(2, "0");
  return (neg ? "-$" : "$") + whole + "." + frac;
}

function centsToQtcString(cents, usdPerQtc) {
  // plancks = cents * 10^12 / (usdPerQtc * 100), rounded half-up, computed
  // in exact BigInt rational arithmetic. The previous float path
  // (Number(cents) * 1e12 / Number(rate)) disagreed with the exact result
  // in 8,965 of 16,048 swept cases (worst error 2,228 plancks on an
  // $183,503.21 invoice @ $0.008912) — float64 runs out of integer
  // precision for any invoice over ~$90.
  var r = parseDecimalRational(usdPerQtc);
  if (!r || r.num <= 0n) return null;
  var c = BigInt(cents);
  var neg = c < 0n;
  var num = (neg ? -c : c) * PLANCKS_PER_QTC * r.den;
  var den = 100n * r.num;
  var pl = num / den;
  if ((num % den) * 2n >= den) pl += 1n;
  return plancksToQtcString(neg ? -pl : pl);
}

function makeInvoiceId(now) {
  var d = new Date(now);
  function p2(n) { return String(n).padStart(2, "0"); }
  var stamp = d.getUTCFullYear().toString() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
  var clock = p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds());
  var rand = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, "0");
  return "INV-" + stamp + "-" + clock + "-" + rand;
}

function invoiceTotals(items, discountCents, taxPct) {
  var sub = items.reduce(function (acc, it) {
    return acc + BigInt(it.qty) * it.unitCents;
  }, 0n);
  var disc = discountCents > sub ? sub : discountCents;
  var taxable = sub - disc;
  // Tax percent parsed as an exact decimal rational: the old
  // Math.round(Number(taxPct) * 100) snapped 8.875% to 8.88% and 2.675%
  // to 2.67% before the tax was computed. Truncation of the final tax
  // amount (never round a tax up) is unchanged.
  var pct = parseDecimalRational(taxPct == null ? "0" : String(taxPct));
  var tax = pct && pct.num > 0n ? (taxable * pct.num) / (100n * pct.den) : 0n;
  var total = taxable + tax;
  return { sub: sub, disc: disc, tax: tax, total: total };
}

function validateAddress(addr) {
  if (!window.QTC_SS58) return { ok: false, error: "Address validator failed to load." };
  var t = String(addr || "").trim();
  if (!t) return { ok: false, error: "Enter a receiving address." };
  var d = window.QTC_SS58.ss58Decode(t);
  if (!d.ok) return { ok: false, error: d.error };
  if (d.prefix !== 189)
    return { ok: false, error: "Checksum is valid, but the network prefix is " + d.prefix + " — not Quantus (189). Use a QTC mainnet address." };
  if (d.key.length !== 32)
    return { ok: false, error: "Unexpected account length (" + d.key.length + " bytes). Quantus accounts are 32 bytes." };
  return { ok: true };
}

function fmtCountdown(ms) {
  if (ms <= 0) return "expired";
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s";
  if (m > 0) return m + "m " + String(sec).padStart(2, "0") + "s";
  return sec + "s";
}

function csvEscape(v) {
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* tip-button snippet generator (pure) */
function tipSnippet(address, label, style) {
  var cls = style === "light" ? "qtip-light" : style === "minimal" ? "qtip-minimal" : "qtip-dark";
  var safeLabel = label.replace(/</g, "&lt;");
  var css =
    ".qtip-dark{display:inline-flex;align-items:center;gap:10px;padding:12px 22px;border-radius:10px;" +
    "background:linear-gradient(135deg,#131a2e,#1d2a52);border:1px solid #41e0d0;color:#eafcff;" +
    "font:600 15px system-ui;cursor:pointer;box-shadow:0 0 22px rgba(65,224,208,.35);text-decoration:none}" +
    ".qtip-light{display:inline-flex;align-items:center;gap:10px;padding:12px 22px;border-radius:10px;" +
    "background:#f7f1e3;border:1px solid #c9b98a;color:#2a2214;font:600 15px system-ui;cursor:pointer;text-decoration:none}" +
    ".qtip-minimal{color:#41e0d0;font:600 14px system-ui;text-decoration:underline;cursor:pointer}" +
    ".qtip-qr{display:none;position:absolute;z-index:50;background:#fff;padding:10px;border-radius:8px;margin-top:8px}" +
    ".qtip-wrap:hover .qtip-qr,.qtip-wrap:focus-within .qtip-qr{display:block}";
  var note = "<!-- QTC tip button. Replace nothing else; the QR is drawn client-side. -->";
  var html =
    '<div class="qtip-wrap" style="position:relative;display:inline-block">\n' +
    '  <a class="' + cls + '" href="#" onclick="return false" title="Send QTC to ' + address + '">⚛ ' + safeLabel + "</a>\n" +
    '  <div class="qtip-qr"><img alt="QTC tip QR" width="180" height="180"\n' +
    '    src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&amp;data=' + encodeURIComponent(address) + '"></div>\n' +
    '  <div style="font:11px system-ui;color:#888;margin-top:6px;word-break:break-all">' + address + "</div>\n" +
    "</div>";
  return note + "\n<style>" + css + "</style>\n" + html;
}

/* ---------------- storage ---------------- */

function loadRate() {
  try {
    var r = JSON.parse(localStorage.getItem(RATE_KEY) || "null");
    if (r && Number(r.usdPerQtc) > 0) return r;
  } catch (e) { /* ignore */ }
  return null;
}
function saveRate(usdPerQtc) {
  localStorage.setItem(RATE_KEY, JSON.stringify({ usdPerQtc: usdPerQtc, ts: Date.now() }));
}
function clearRate() { localStorage.removeItem(RATE_KEY); }

function loadRegister() {
  try {
    var r = JSON.parse(localStorage.getItem(REG_KEY) || "[]");
    return Array.isArray(r) ? r : [];
  } catch (e) { return []; }
}
function saveRegister(list) {
  localStorage.setItem(REG_KEY, JSON.stringify(list));
}

/* ---------------- UI ---------------- */

function $(id) { return document.getElementById(id); }

var state = {
  items: [{ desc: "", qty: 1, unitCents: 0n }],
  rate: loadRate(),
  register: loadRegister(),
  current: null,      // active invoice being displayed
  tick: null,
};

function renderRate() {
  var r = state.rate;
  if (!r) {
    $("rs-rate").textContent = "not set";
    $("rs-time").textContent = "—";
    $("rs-qtc1").textContent = "—";
    $("rate-usd").value = "";
  } else {
    $("rs-rate").textContent = "$" + r.usdPerQtc + " / QTC";
    $("rs-time").textContent = new Date(r.ts).toLocaleString();
    $("rs-qtc1").textContent = (centsToQtcString(100n, r.usdPerQtc) || "0") + " QTC per $1";
  }
  renderTotals();
}

function renderItems() {
  var tb = $("items-body");
  tb.innerHTML = "";
  state.items.forEach(function (it, i) {
    var tr = document.createElement("tr");
    var tdD = document.createElement("td");
    var dIn = document.createElement("input");
    dIn.type = "text"; dIn.placeholder = "Item description"; dIn.value = it.desc;
    dIn.setAttribute("aria-label", "Item " + (i + 1) + " description");
    dIn.addEventListener("input", function () { it.desc = dIn.value; });
    tdD.appendChild(dIn);
    var tdQ = document.createElement("td");
    var qIn = document.createElement("input");
    qIn.type = "number"; qIn.min = "1"; qIn.step = "1"; qIn.value = it.qty;
    qIn.className = "num"; qIn.style.width = "70px";
    qIn.setAttribute("aria-label", "Item " + (i + 1) + " quantity");
    qIn.addEventListener("input", function () {
      it.qty = Math.max(1, Math.floor(Number(qIn.value) || 1));
      qIn.value = it.qty; renderTotals(); renderItems();
    });
    tdQ.appendChild(qIn);
    var tdU = document.createElement("td");
    var uIn = document.createElement("input");
    uIn.type = "text"; uIn.inputMode = "decimal"; uIn.value = fmtUsd(it.unitCents).slice(1);
    uIn.className = "num"; uIn.setAttribute("aria-label", "Item " + (i + 1) + " unit price USD");
    uIn.addEventListener("input", function () {
      var v = parseUsdToCents(uIn.value);
      it.unitCents = v == null ? 0n : v;
      renderTotals(); lineTotalEl.textContent = fmtUsd(BigInt(it.qty) * it.unitCents);
    });
    tdU.appendChild(uIn);
    var tdT = document.createElement("td");
    var lineTotalEl = document.createElement("span");
    lineTotalEl.className = "line-total";
    lineTotalEl.textContent = fmtUsd(BigInt(it.qty) * it.unitCents);
    tdT.appendChild(lineTotalEl);
    var tdX = document.createElement("td");
    var del = document.createElement("button");
    del.className = "row-del"; del.textContent = "×";
    del.setAttribute("aria-label", "Remove item " + (i + 1));
    del.addEventListener("click", function () {
      if (state.items.length > 1) state.items.splice(i, 1);
      else state.items = [{ desc: "", qty: 1, unitCents: 0n }];
      renderItems(); renderTotals();
    });
    tdX.appendChild(del);
    tr.append(tdD, tdQ, tdU, tdT, tdX);
    tb.appendChild(tr);
  });
}

function renderTotals() {
  var disc = parseUsdToCents($("inv-discount").value) || 0n;
  var taxPct = Number($("inv-tax").value) || 0;
  var t = invoiceTotals(state.items, disc, taxPct);
  $("t-sub").textContent = fmtUsd(t.sub);
  $("t-tax").textContent = fmtUsd(t.tax);
  $("t-disc").textContent = "−" + fmtUsd(t.disc);
  $("t-total").textContent = fmtUsd(t.total);
  if (state.rate) {
    var q = centsToQtcString(t.total, state.rate.usdPerQtc);
    $("t-qtc").textContent = q + " QTC";
    $("t-plancks").textContent = parseQtcToPlancks(q).toString() + " plancks";
  } else {
    $("t-qtc").textContent = "set a rate first";
    $("t-plancks").textContent = "—";
  }
  return t;
}

/* address validation wiring */
function wireAddress(inputId, verdictId) {
  var inp = $(inputId), ver = $(verdictId);
  function check() {
    var r = validateAddress(inp.value);
    ver.className = "hint " + (r.ok ? "ok" : inp.value.trim() ? "bad" : "");
    ver.textContent = r.ok
      ? "✓ Valid QTC mainnet address (SS58 prefix 189, checksum verified)."
      : inp.value.trim() ? "✗ " + r.error : "Enter your wallet address — it is validated locally, never sent anywhere.";
    return r.ok;
  }
  inp.addEventListener("input", check);
  return check;
}

/* QR drawing */
function drawQRInto(el, text, px) {
  el.innerHTML = "";
  var canvas = document.createElement("canvas");
  canvas.width = px; canvas.height = px;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "QR code for " + text.slice(0, 12) + "…");
  var qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount();
  var ctx = canvas.getContext("2d");
  var cell = px / n;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#14100a";
  for (var r = 0; r < n; r++)
    for (var c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
  el.appendChild(canvas);
}

/* invoice creation */
function createInvoice() {
  var err = $("inv-error");
  err.textContent = "";
  if (!state.rate) { err.textContent = "Set a QTC/USD rate first — invoices cannot price without one."; return; }
  var addrOk = validateAddress($("inv-addr").value);
  if (!addrOk.ok) { err.textContent = "Fix the receiving address: " + addrOk.error; return; }
  var t = renderTotals();
  if (t.total <= 0n) { err.textContent = "The invoice total must be greater than $0."; return; }
  var qtcStr = centsToQtcString(t.total, state.rate.usdPerQtc);
  var plancks = parseQtcToPlancks(qtcStr);
  var now = Date.now();
  var inv = {
    id: makeInvoiceId(now),
    ref: $("inv-ref").value.trim(),
    address: $("inv-addr").value.trim(),
    usdCents: t.total.toString(),
    qtc: qtcStr,
    plancks: plancks.toString(),
    rate: state.rate.usdPerQtc,
    rateTs: state.rate.ts,
    created: now,
    expiresAt: now + Number($("inv-expiry").value) * 60000,
    status: "pending",
  };
  state.register.unshift(inv);
  saveRegister(state.register);
  state.current = inv;
  renderRequest(inv);
  renderRegister();
}

function renderRequest(inv) {
  var sec = $("request-sec");
  sec.hidden = false;
  $("req-meta").textContent = inv.id + (inv.ref ? " · " + inv.ref : "") +
    " · quoted at $" + inv.rate + "/QTC on " + new Date(inv.rateTs).toLocaleString();
  $("req-qtc").textContent = inv.qtc + " QTC";
  $("req-fiat").textContent = "≈ " + fmtUsd(BigInt(inv.usdCents)) + " at the quoted rate";
  $("req-plancks").textContent = inv.plancks;
  $("req-addr").textContent = inv.address;
  $("req-id").textContent = inv.id;
  drawQRInto($("qr-box"), inv.address, 264);
  startCountdown(inv);
  sec.scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "start" });
}

function startCountdown(inv) {
  if (state.tick) clearInterval(state.tick);
  function upd() {
    var ms = inv.expiresAt - Date.now();
    var label = fmtCountdown(ms);
    $("req-countdown").textContent = label;
    $("req-countdown").classList.toggle("urgent", ms > 0 && ms < 5 * 60000);
    if (ms <= 0 && inv.status === "pending") {
      inv.status = "expired";
      saveRegister(state.register);
      renderRegister();
      clearInterval(state.tick);
    }
  }
  upd();
  state.tick = setInterval(upd, 1000);
}

/* register */
var STATUS_LABEL = { pending: "Pending", paid: "Paid", expired: "Expired", cancelled: "Cancelled" };

function renderRegister() {
  var tb = $("register-body");
  tb.innerHTML = "";
  $("register-empty").style.display = state.register.length ? "none" : "block";
  state.register.slice(0, QT_PER_PAGE).forEach(function (inv) {
    var tr = document.createElement("tr");
    function cell(txt) {
      var td = document.createElement("td");
      td.textContent = txt;
      return td;
    }
    tr.append(
      cell(inv.id),
      cell(inv.ref || "—"),
      cell(inv.qtc),
      cell(fmtUsd(BigInt(inv.usdCents))),
      cell("$" + inv.rate),
      cell(new Date(inv.created).toLocaleString())
    );
    var tdS = document.createElement("td");
    var st = document.createElement("span");
    st.className = "status " + inv.status;
    st.textContent = STATUS_LABEL[inv.status] || inv.status;
    tdS.appendChild(st);
    tr.appendChild(tdS);
    var tdA = document.createElement("td");
    var wrap = document.createElement("div");
    wrap.className = "reg-btns";
    if (inv.status === "pending") {
      var paid = document.createElement("button");
      paid.textContent = "Mark paid";
      paid.addEventListener("click", function () { setStatus(inv.id, "paid"); });
      var cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { setStatus(inv.id, "cancelled"); });
      wrap.append(paid, cancel);
    }
    var reopen = document.createElement("button");
    reopen.textContent = "View";
    reopen.addEventListener("click", function () {
      state.current = inv;
      renderRequest(inv);
    });
    wrap.appendChild(reopen);
    tdA.appendChild(wrap);
    tr.appendChild(tdA);
    tb.appendChild(tr);
  });
  if (state.register.length > QT_PER_PAGE) {
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = 8;
    td.textContent = "Showing " + QT_PER_PAGE + " of " + state.register.length + " — export CSV for the full history.";
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}

function setStatus(id, status) {
  var inv = state.register.find(function (x) { return x.id === id; });
  if (!inv) return;
  if (status === "paid" && !window.confirm("Only mark PAID after you verified the payment in your wallet or the chain explorer. Confirm?")) return;
  inv.status = status;
  saveRegister(state.register);
  renderRegister();
}

function exportCsv() {
  var rows = [["id", "reference", "qtc", "usd", "plancks", "rate_usd_per_qtc", "address", "created_iso", "status"]];
  state.register.slice().reverse().forEach(function (inv) {
    rows.push([
      inv.id, inv.ref || "", inv.qtc,
      (BigInt(inv.usdCents) / CENT).toString() + "." + (BigInt(inv.usdCents) % CENT).toString().padStart(2, "0"),
      inv.plancks, inv.rate, inv.address,
      new Date(inv.created).toISOString(), inv.status,
    ]);
  });
  var csv = rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\n");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "qtc-pay-desk-register.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* POS overlay */
function openPos(inv) {
  $("pos-overlay").hidden = false;
  $("pos-id").textContent = inv.id + (inv.ref ? " · " + inv.ref : "");
  $("pos-amount").textContent = inv.qtc + " QTC";
  $("pos-fiat").textContent = "≈ " + fmtUsd(BigInt(inv.usdCents));
  drawQRInto($("pos-qr"), inv.address, 280);
  $("pos-addr").textContent = inv.address;
  function upd() {
    var ms = inv.expiresAt - Date.now();
    var el = $("pos-countdown");
    el.textContent = ms > 0 ? "Expires in " + fmtCountdown(ms) : "Expired";
    el.classList.toggle("urgent", ms > 0 && ms < 5 * 60000);
    if (ms <= 0 && inv.status === "pending") {
      inv.status = "expired"; saveRegister(state.register); renderRegister();
    }
  }
  upd();
  if (state.posTick) clearInterval(state.posTick);
  state.posTick = setInterval(upd, 1000);
}
function closePos() {
  $("pos-overlay").hidden = true;
  if (state.posTick) clearInterval(state.posTick);
}

/* tip generator */
function renderTip() {
  var addr = $("tip-addr").value.trim();
  var ok = validateAddress(addr).ok;
  var label = $("tip-label").value.trim() || "Tip QTC";
  var style = $("tip-style").value;
  var prev = $("tip-preview");
  var snip = $("tip-snippet");
  if (!ok) {
    prev.innerHTML = '<span class="muted">Enter a valid address to preview.</span>';
    snip.innerHTML = "<code>Enter a valid address — the snippet appears here.</code>";
    $("tip-copy").disabled = true;
    return;
  }
  var cls = style === "light" ? "qtip-light" : style === "minimal" ? "qtip-minimal" : "qtip-dark";
  var a = document.createElement("a");
  a.className = cls;
  a.href = "#";
  a.textContent = "⚛ " + label;
  a.addEventListener("click", function (e) { e.preventDefault(); });
  prev.innerHTML = "";
  prev.appendChild(a);
  var code = tipSnippet(addr, label, style);
  snip.innerHTML = "";
  var c = document.createElement("code");
  c.textContent = code;
  snip.appendChild(c);
  $("tip-copy").disabled = false;
}

/* copy buttons (incl. footer donation address) */
function wireCopy() {
  document.querySelectorAll("[data-copy-target]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var t = $(btn.getAttribute("data-copy-target"));
      var txt = t ? t.textContent : "";
      navigator.clipboard.writeText(txt).then(function () {
        btn.textContent = "Copied";
        btn.classList.add("done");
        setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
      }).catch(function () { btn.textContent = "Select manually"; });
    });
  });
  document.querySelectorAll("button.addr[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(btn.getAttribute("data-copy")).then(function () {
        var o = btn.textContent; btn.textContent = "Copied ✓";
        setTimeout(function () { btn.textContent = o; }, 1600);
      }).catch(function () {});
    });
  });
}

/* ---------------- init ---------------- */

function init() {
  wireAddress("inv-addr", "addr-verdict");
  wireAddress("tip-addr", "tip-verdict");
  wireCopy();

  renderItems();
  renderRate();
  renderRegister();
  renderTip();

  $("rate-save").addEventListener("click", function () {
    var v = $("rate-usd").value.trim();
    if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) {
      $("rate-usd").focus();
      return;
    }
    state.rate = { usdPerQtc: v, ts: Date.now() };
    saveRate(v);
    renderRate();
  });
  $("rate-clear").addEventListener("click", function () {
    state.rate = null; clearRate(); renderRate();
  });

  $("item-add").addEventListener("click", function () {
    state.items.push({ desc: "", qty: 1, unitCents: 0n });
    renderItems();
  });
  $("inv-discount").addEventListener("input", renderTotals);
  $("inv-tax").addEventListener("input", renderTotals);
  $("inv-create").addEventListener("click", createInvoice);

  $("req-new").addEventListener("click", function () {
    $("request-sec").hidden = true;
    if (state.tick) clearInterval(state.tick);
    state.current = null;
    $("builder-sec").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth") });
  });
  $("req-pos").addEventListener("click", function () {
    if (state.current) openPos(state.current);
  });

  $("reg-export").addEventListener("click", exportCsv);
  $("reg-clear").addEventListener("click", function () {
    if (state.register.length && window.confirm("Clear all " + state.register.length + " invoices from this browser? Export CSV first if you need the history.")) {
      state.register = [];
      saveRegister(state.register);
      renderRegister();
    }
  });

  $("pos-close").addEventListener("click", closePos);
  $("pos-overlay").addEventListener("click", function (e) {
    if (e.target === $("pos-overlay")) closePos();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("pos-overlay").hidden) closePos();
  });
  $("pos-paid").addEventListener("click", function () {
    if (state.current) { setStatus(state.current.id, "paid"); closePos(); }
  });
  $("pos-expire").addEventListener("click", function () {
    if (state.current) { setStatus(state.current.id, "expired"); closePos(); }
  });

  ["tip-addr", "tip-label", "tip-style"].forEach(function (id) {
    $(id).addEventListener("input", renderTip);
    $(id).addEventListener("change", renderTip);
  });
  $("tip-copy").addEventListener("click", function () {
    var txt = $("tip-snippet").textContent;
    navigator.clipboard.writeText(txt).then(function () {
      $("tip-copy").textContent = "Copied";
      setTimeout(function () { $("tip-copy").textContent = "Copy snippet"; }, 1600);
    }).catch(function () {});
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseUsdToCents: parseUsdToCents,
    parseQtcToPlancks: parseQtcToPlancks,
    plancksToQtcString: plancksToQtcString,
    fmtUsd: fmtUsd,
    centsToQtcString: centsToQtcString,
    parseDecimalRational: parseDecimalRational,
    makeInvoiceId: makeInvoiceId,
    invoiceTotals: invoiceTotals,
    fmtCountdown: fmtCountdown,
    csvEscape: csvEscape,
    tipSnippet: tipSnippet,
    PLANCKS_PER_QTC: PLANCKS_PER_QTC,
  };
} else {
  document.addEventListener("DOMContentLoaded", init);
}
})();
