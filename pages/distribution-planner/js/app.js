/* QTC Distribution Planner — UI wiring.
 * Pure planning logic lives in js/core.js (tested). This file owns the DOM:
 * debounced validation, progressive checkphrases via fast WebCrypto PBKDF2,
 * batch rendering, fee breakdown, and file/command exports. Never submits. */
(function () {
"use strict";

var $ = function (id) { return document.getElementById(id); };
var core = window.DistCore, ss58 = window.QSS58, check = window.QTC_CHECK;
var WORDLIST = window.QTC_WORDLIST;

var state = { validated: [], batches: [], fees: [], scheme: "ml-dsa-65" };
var cpCache = {};   // address -> phrase
var cpQueued = [];  // addresses awaiting checkphrase
var cpRunning = false;

var SAMPLE =
  "# Sample distribution — public mainnet addresses, demo amounts only\n" +
  "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7  150\n" +
  "qzjsuLN7Nhu4bjvmUbjSTr2ZTeZ7oRxXpQP9fdv6PcHUCRrVR, 25.5\n" +
  "qzowWAgbzjc2XfHY4vyEo2eVLKbknTESUFoXnisQuUh1x1koo\t10.000001\n" +
  "qzjvYrYuPNfhpwD1TTWKkPtkWc8j16U2aDauCvhm1qQGRt6dP  0.75\n";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function toast(msg) {
  var el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.classList.remove("show"); }, 2600);
}
function copyText(txt, label) {
  function done() { toast((label || "Copied") + " ✓"); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done, function () { fallback(); });
  } else fallback();
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); }
    catch (e) { toast("Copy failed — select manually"); }
    document.body.removeChild(ta);
  }
}
function download(name, content, mime) {
  var blob = new Blob([content], { type: mime || "application/octet-stream" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- fast checkphrase: WebCrypto PBKDF2, progressive ---------- */
function pbkdf2Key(address) {
  var subtle = window.crypto && window.crypto.subtle;
  var enc = new TextEncoder();
  if (subtle && subtle.importKey) {
    return subtle.importKey("raw", enc.encode(address), "PBKDF2", false, ["deriveBits"])
      .then(function (k) {
        return subtle.deriveBits(
          { name: "PBKDF2", salt: enc.encode("human-readable-checksum"),
            iterations: 40000, hash: "SHA-256" }, k, 56);
      })
      .then(function (bits) {
        return core.wordsFromKey(new Uint8Array(bits), WORDLIST).join("-");
      });
  }
  // Fallback: chunked reference implementation (slow but correct).
  return check.addressToChecksumAsync(address, WORDLIST).then(function (w) { return w.join("-"); });
}

function pumpCheckphrases() {
  if (cpRunning) return;
  cpRunning = true;
  (function step() {
    var batch = cpQueued.splice(0, 6);
    if (!batch.length) {
      cpRunning = false;
      $("cp-progress").textContent = "";
      return;
    }
    var done = 0, total = batch.length + cpQueued.length + done;
    $("cp-progress").textContent = "computing checkphrases…";
    var chain = Promise.resolve();
    batch.forEach(function (addr) {
      chain = chain.then(function () { return pbkdf2Key(addr); })
        .then(function (phrase) {
          cpCache[addr] = phrase;
          done++;
          var cells = document.querySelectorAll('[data-cp-for="' + addr + '"]');
          for (var i = 0; i < cells.length; i++) cells[i].textContent = phrase;
        })
        .catch(function () { cpCache[addr] = "—"; });
    });
    chain.then(function () { setTimeout(step, 0); });
  })();
}

/* ---------- validation pipeline ---------- */
var debounceT = null;
function scheduleRevalidate() {
  clearTimeout(debounceT);
  debounceT = setTimeout(revalidate, 250);
}

function revalidate() {
  var text = $("recipients").value;
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).length;
  $("rowcount").textContent = lines + (lines === 1 ? " line" : " lines");
  var rows = core.parseInput(text);
  var validated = core.validateRows(rows, ss58, { addressToChecksum: function () { return ["…"]; } }, WORDLIST);
  // checkphrases are filled in progressively; keep a placeholder object shape
  validated.forEach(function (v) { v.checkphrase = null; });
  state.validated = validated;
  cpCache = {};
  cpQueued = [];
  validated.forEach(function (v) {
    if (v.ok && !cpQueued.includes(v.address)) cpQueued.push(v.address);
  });
  renderReview();
  renderPlan();
  pumpCheckphrases();
}

function statusCell(v) {
  if (!v.ok) return '<span class="st bad">✕ ' + esc(v.error) + "</span>";
  if (v.warnings.length)
    return '<span class="st warn">⚠ valid — ' + esc(v.warnings.join("; ")) + "</span>";
  return '<span class="st ok">✓ valid</span>';
}

function renderReview() {
  var sum = core.summarize(state.validated);
  var chips = $("chips");
  chips.innerHTML =
    chip(sum.valid + " valid", "ok") +
    chip(sum.invalid + " invalid", sum.invalid ? "bad" : "") +
    chip(sum.warned + " with warnings", sum.warned ? "warn" : "") +
    chip(core.formatQTC(sum.totalPlancks) + " QTC total", "");
  function chip(txt, cls) { return '<span class="chip ' + cls + '">' + esc(txt) + "</span>"; }

  var body = $("review-body");
  var CAP = 500;
  var rows = state.validated.slice(0, CAP);
  if (!rows.length) {
    body.innerHTML = '<tr class="empty"><td colspan="6">Paste a recipient list above to start the review.</td></tr>';
  } else {
    body.innerHTML = rows.map(function (v) {
      var cp = v.ok ? '<span data-cp-for="' + esc(v.address) + '">computing…</span>' : "—";
      return "<tr class=\"" + (v.ok ? (v.warnings.length ? "wr" : "vr") : "ir") + "\">" +
        "<td class=\"ln\">" + v.line + "</td>" +
        "<td class=\"addr mono\">" + esc(v.address) + "</td>" +
        "<td class=\"cp mono\">" + cp + "</td>" +
        "<td class=\"num\">" + esc(v.amountStr) + "</td>" +
        "<td class=\"num mono\">" + (v.plancks != null ? v.plancks.toString() : "—") + "</td>" +
        "<td>" + statusCell(v) + "</td></tr>";
    }).join("");
  }
  var cap = $("table-cap");
  if (state.validated.length > CAP) {
    cap.hidden = false;
    cap.textContent = "Showing the first " + CAP + " of " + state.validated.length +
      " rows — the full list is still validated and exported.";
  } else cap.hidden = true;
}

/* ---------- batch plan ---------- */
function currentBatchSize() {
  var n = parseInt($("batch-size").value, 10);
  if (!isFinite(n) || n < 1) n = core.DEFAULT_BATCH_SIZE;
  return Math.min(n, 100000);
}
function currentTipPlancks() {
  var s = $("tip").value.trim();
  if (!s) return { ok: true, plancks: BigInt(0) };
  var p = core.parseAmountToPlancks(s);
  return p.ok ? { ok: true, plancks: p.plancks } : { ok: false, error: p.error };
}

function renderPlan() {
  var sum = core.summarize(state.validated);
  var totals = $("totals"), cards = $("batch-cards"), feeBox = $("fee-breakdown");
  if (!sum.valid) {
    totals.innerHTML = '<span class="fine">No valid recipients yet — the batch plan appears here.</span>';
    cards.innerHTML = "";
    feeBox.innerHTML = "<p class=\"fine\">—</p>";
    $("export-btns").innerHTML = '<span class="fine">Validate a recipient list first.</span>';
    $("script-preview").firstChild.textContent = "—";
    updateBalanceCheck(null);
    return;
  }
  state.scheme = $("scheme").value;
  var batches = core.planBatches(sum.validRows, currentBatchSize());
  var fees = batches.map(function (b) { return core.estimateBatchFee(b, state.scheme); });
  state.batches = batches;
  state.fees = fees;

  var tip = currentTipPlancks();
  var feeTotal = fees.reduce(function (a, f) { return a + f.feePlancks; }, BigInt(0));
  var tipTotal = tip.ok ? tip.plancks * BigInt(batches.length) : BigInt(0);
  var grand = sum.totalPlancks + feeTotal + tipTotal;

  totals.innerHTML =
    totalCard("Recipients", sum.valid + " addresses", core.formatQTC(sum.totalPlancks) + " QTC") +
    totalCard("Fee floor", batches.length + (batches.length === 1 ? " batch" : " batches") +
      " · length fee only", core.formatQTC6(feeTotal) + " QTC") +
    (tip.ok && tip.plancks > BigInt(0)
      ? totalCard("Tips", tip.plancks > BigInt(0) ? core.formatQTC(tip.plancks) + " × " + batches.length : "—",
          core.formatQTC(tipTotal) + " QTC") : "") +
    totalCard("Sender needs ≥", "recipients + fee floor" + (tipTotal > BigInt(0) ? " + tips" : ""),
      core.formatQTC(grand) + " QTC", true);
  function totalCard(k, s, v, hot) {
    return '<div class="tcard' + (hot ? " hot" : "") + '"><div class="k">' + esc(k) +
      '</div><div class="v">' + esc(v) + '</div><div class="s">' + esc(s) + "</div></div>";
  }
  if (!tip.ok) {
    totals.innerHTML += '<div class="tcard warn"><div class="k">Tip</div><div class="v">invalid</div>' +
      '<div class="s">' + esc(tip.error) + " — tip ignored</div></div>";
  }

  cards.innerHTML = batches.map(function (b, i) {
    return '<div class="bcard"><div class="bh"><span>Batch ' + b.index + " / " + batches.length +
      "</span><span>" + b.rows.length + " transfers</span></div>" +
      '<div class="bv">' + esc(core.formatQTC(b.totalPlancks)) + ' <span class="u">QTC</span></div>' +
      '<div class="bs">fee floor ≈ ' + esc(core.formatQTC6(fees[i].feePlancks)) + " QTC · " +
      esc(String(fees[i].totalBytes)) + " bytes</div></div>";
  }).join("");

  var f0 = fees[0], b0 = batches[0];
  feeBox.innerHTML =
    "<p>Batch 1 (" + b0.rows.length + " transfers, " + esc(state.scheme) + " signature):</p>" +
    '<table class="feetab"><tbody>' +
    feeRow("Signature + signer + extensions", f0.overheadBytes,
      "1 (sig version) + " + f0.sigBytes + " (sig) + 33 (signer id) + " +
      core.EXTENSIONS_ESTIMATE_BYTES + " (era/nonce/tip — estimate)") +
    feeRow("batch_all wrapper", f0.wrapperBytes, "pallet + call index + compact transfer count") +
    feeRow("Transfer calls", f0.callBytes,
      b0.rows.length + " × (1 + 1 + 33 + compact amount) — compact length computed per amount") +
    feeRow("<strong>Total bytes</strong>", f0.totalBytes, "") +
    feeRow("<strong>Length-fee floor</strong>", null,
      esc(String(f0.totalBytes)) + " × 100,000 = <strong>" + f0.feePlancks.toString() +
      "</strong> plancks ≈ " + esc(core.formatQTC6(f0.feePlancks)) + " QTC") +
    "</tbody></table>";
  function feeRow(k, bytes, note) {
    return "<tr><td>" + k + "</td><td class=\"num mono\">" +
      (bytes == null ? "—" : esc(String(bytes)) + " B") + "</td><td class=\"fine\">" + note + "</td></tr>";
  }

  renderExports(tip.ok ? tip.plancks : BigInt(0));
  updateBalanceCheck(grand);
}

function updateBalanceCheck(grand) {
  var el = $("balance-verdict");
  var s = $("sender-balance").value.trim();
  if (grand == null || !s) {
    el.className = "fine";
    el.textContent = "Enter the funding wallet's balance to check it covers recipients + fee floor.";
    return;
  }
  var p = core.parseAmountToPlancks(s);
  if (!p.ok) {
    el.className = "fine bad";
    el.textContent = "Balance not parseable: " + p.error;
    return;
  }
  if (p.plancks >= grand) {
    el.className = "fine ok";
    el.textContent = "✓ " + core.formatQTC(p.plancks) + " QTC covers the " +
      core.formatQTC(grand) + " QTC needed (with " +
      core.formatQTC(p.plancks - grand) + " QTC headroom above the fee floor).";
  } else {
    el.className = "fine bad";
    el.textContent = "✕ Short by " + core.formatQTC(grand - p.plancks) +
      " QTC — the sender needs at least " + core.formatQTC(grand) + " QTC.";
  }
}

/* ---------- exports ---------- */
function renderExports(tipPlancks) {
  var box = $("export-btns");
  var wallet = $("wallet").value.trim() || "my_wallet";
  var btns = state.batches.map(function (b) {
    return '<button class="ghost" data-dl-batch="' + b.index + '" type="button">' +
      "Download transfers-batch-" + b.index + ".json</button>";
  }).join("");
  box.innerHTML = btns +
    ' <button class="primary" data-dl-script="1" type="button">Download run-batches.sh</button>';
  var tipStr = tipPlancks > BigInt(0)
    ? core.formatQTC(tipPlancks) : "";
  var script = core.buildRunScript(state.batches, wallet, tipStr);
  $("script-preview").firstChild.textContent = script;
  state.script = script;
  state.wallet = wallet;
}

function commandsOnly() {
  var wallet = $("wallet").value.trim() || "my_wallet";
  var tip = currentTipPlancks();
  var tipFlag = (tip.ok && tip.plancks > BigInt(0))
    ? " --tip " + core.formatQTC(tip.plancks) : "";
  var cmds = ["quantus batch config --limits"];
  state.batches.forEach(function (b) {
    cmds.push("quantus batch send --from '" + wallet.replace(/'/g, "'\\''") +
      "' --batch-file transfers-batch-" + b.index + ".json" + tipFlag);
  });
  return cmds.join("\n");
}

/* ---------- wiring ---------- */
function init() {
  $("recipients").addEventListener("input", scheduleRevalidate);
  ["batch-size", "wallet", "tip", "scheme"].forEach(function (id) {
    $(id).addEventListener("input", renderPlan);
    $(id).addEventListener("change", renderPlan);
  });
  $("sender-balance").addEventListener("input", function () {
    var sum = core.summarize(state.validated);
    if (!sum.valid) return;
    var feeTotal = state.fees.reduce(function (a, f) { return a + f.feePlancks; }, BigInt(0));
    var tip = currentTipPlancks();
    var tipTotal = (tip.ok ? tip.plancks : BigInt(0)) * BigInt(state.batches.length);
    updateBalanceCheck(sum.totalPlancks + feeTotal + tipTotal);
  });
  $("load-sample").addEventListener("click", function () {
    $("recipients").value = SAMPLE;
    revalidate();
    toast("Sample loaded — demo amounts only");
  });
  $("clear").addEventListener("click", function () {
    $("recipients").value = "";
    revalidate();
  });
  $("file-input").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      $("recipients").value = String(r.result || "");
      revalidate();
      toast("Loaded " + f.name);
    };
    r.readAsText(f);
    e.target.value = "";
  });
  $("copy-script").addEventListener("click", function () {
    if (state.script) copyText(state.script, "Run script");
  });
  $("copy-cmds").addEventListener("click", function () {
    if (state.batches.length) copyText(commandsOnly(), "Commands");
  });
  $("export-btns").addEventListener("click", function (e) {
    var b = e.target.closest("[data-dl-batch]");
    if (b) {
      var idx = parseInt(b.getAttribute("data-dl-batch"), 10) - 1;
      download("transfers-batch-" + (idx + 1) + ".json",
        core.buildBatchJson(state.batches[idx]), "application/json");
      return;
    }
    if (e.target.closest("[data-dl-script]") && state.script) {
      download("run-batches.sh", state.script, "text/x-sh");
    }
  });
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-copy]");
    if (c) copyText(c.getAttribute("data-copy"), "Address");
  });
  // background canvas
  var cv = $("abyss"), ctx = cv.getContext("2d"), stars = [];
  function size() {
    cv.width = innerWidth; cv.height = innerHeight;
    stars = [];
    for (var i = 0; i < 130; i++)
      stars.push({ x: Math.random() * cv.width, y: Math.random() * cv.height,
        r: Math.random() * 1.6 + 0.3, s: Math.random() * 0.25 + 0.05, h: Math.random() });
  }
  size();
  addEventListener("resize", size);
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      st.y -= st.s;
      if (st.y < -4) { st.y = cv.height + 4; st.x = Math.random() * cv.width; }
      var tw = 0.35 + 0.65 * Math.abs(Math.sin(Date.now() / 1400 + st.h * 6.28));
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, 6.283);
      ctx.fillStyle = "rgba(167,139,250," + (0.5 * tw).toFixed(3) + ")";
      ctx.fill();
    }
    if (!REDUCE_MOTION) requestAnimationFrame(draw);
  })();
  revalidate();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

})();
