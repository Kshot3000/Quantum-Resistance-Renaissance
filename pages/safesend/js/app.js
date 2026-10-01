/* QTC SafeSend Lab — UI.
 * Checkphrase crypto lives in js/checkphrase-core.js (validated 1171/1171 upstream vectors).
 * Delay constants mirror the chain runtime: MinDelayPeriodBlocks = 2,
 * DefaultDelay = DAYS = 7200 blocks, TargetBlockTime = 12s.
 */
(function () {
"use strict";

var BLOCK_MS = 12000;
var MIN_DELAY_BLOCKS = 2;
var DEFAULT_DELAY_BLOCKS = 7200;

function $(id) { return document.getElementById(id); }

/* ---------- vault field canvas ---------- */
(function () {
  var c = $("vaultfield"); if (!c) return;
  var ctx = c.getContext("2d"), W, H, parts = [];
  function size() { W = c.width = innerWidth; H = c.height = innerHeight; }
  size(); addEventListener("resize", size);
  for (var i = 0; i < 70; i++) parts.push({
    x: Math.random() * 2000, y: Math.random() * 1200,
    r: .6 + Math.random() * 2.2, s: .12 + Math.random() * .4,
    a: .05 + Math.random() * .28, ph: Math.random() * 6.28
  });
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function tick(t) {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var y = (p.y - t * .001 * p.s * 60) % (H + 40); if (y < -20) y += H + 40;
      var tw = p.a * (0.6 + 0.4 * Math.sin(t * .001 + p.ph));
      ctx.beginPath();
      ctx.arc(p.x % W, y, p.r, 0, 6.29);
      ctx.fillStyle = "rgba(46,242,184," + tw.toFixed(3) + ")";
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(tick);
  })(0);
})();

/* ---------- section nav highlight ---------- */
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll(".lab-nav .sn"));
  var secs = links.map(function (a) { return $(a.getAttribute("href").slice(1)); });
  function onScroll() {
    var best = 0, y = scrollY + 180;
    secs.forEach(function (s, i) { if (s && s.offsetTop <= y) best = i; });
    links.forEach(function (a, i) { a.classList.toggle("active", i === best); });
  }
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
})();

/* ---------- footer copy ---------- */
document.querySelectorAll("[data-copy]").forEach(function (b) {
  b.addEventListener("click", function () {
    var v = b.getAttribute("data-copy");
    function done() { var t = b.textContent; b.textContent = "copied ✓"; setTimeout(function () { b.textContent = t; }, 1200); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done);
    else { var ta = document.createElement("textarea"); ta.value = v; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove(); done(); }
  });
});

$("verNote").textContent = "Checkphrase core validated 1,171/1,171 upstream test vectors · delay constants from the chain runtime (MinDelayPeriodBlocks = 2, DefaultDelay = 7,200 blocks).";

/* ---------- checkphrase verifier ---------- */
var lastAddr = "", lastWords = null;
var KYLE = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
var GENESIS = "qzka7DZXAT7GnzgXQfxiSwrPKRWgW6m6G89QRsQiLThThZ6Cw"; // upstream genesis vesting table

function renderWords(el, words, animate) {
  el.innerHTML = "";
  words.forEach(function (w) {
    var s = document.createElement("span");
    s.className = "word" + (animate ? "" : " no-anim");
    if (!animate) s.style.animation = "none";
    s.textContent = w;
    el.appendChild(s);
  });
}

$("exKyle").addEventListener("click", function () { $("addrInput").value = KYLE; });
$("exGenesis").addEventListener("click", function () { $("addrInput").value = GENESIS; });

$("deriveBtn").addEventListener("click", function () {
  var addr = $("addrInput").value.trim();
  if (!addr) { $("resNote").textContent = "Paste an address first."; return; }
  var wrap = $("progWrap"), bar = $("progBar"), note = $("progNote");
  wrap.hidden = false; bar.style.width = "0%"; note.textContent = "Running 40,000 KDF iterations…";
  $("deriveBtn").disabled = true; $("poisonBtn").disabled = true;
  QTC_CHECK.addressToChecksumAsync(addr, QTC_WORDLIST, function (done, total) {
    bar.style.width = (100 * done / total).toFixed(1) + "%";
  }).then(function (words) {
    wrap.hidden = true; $("deriveBtn").disabled = false;
    lastAddr = addr; lastWords = words;
    renderWords($("wordRow"), words, true);
    $("resNote").textContent = "Derived locally from " + addr.length + "-character address · 5 words · 2,048-word list. Read them back to the recipient.";
    $("poisonBtn").disabled = false;
    $("poisonCard").hidden = true;
  }).catch(function (e) {
    wrap.hidden = true; $("deriveBtn").disabled = false;
    $("resNote").textContent = "Error: " + e.message;
  });
});

/* poisoning demo: mutate one char, derive both phrases */
$("poisonBtn").addEventListener("click", function () {
  if (!lastAddr) return;
  var chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var idx = 2 + Math.floor(Math.random() * (lastAddr.length - 2)); // keep the qz(k) prefix readable
  var cur = lastAddr[idx], rep = cur;
  while (rep === cur) rep = chars[Math.floor(Math.random() * chars.length)];
  var tamp = lastAddr.slice(0, idx) + rep + lastAddr.slice(idx + 1);

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  $("origAddr").innerHTML = esc(lastAddr);
  $("tampAddr").innerHTML = esc(tamp.slice(0, idx)) + '<span class="mut">' + esc(rep) + "</span>" + esc(tamp.slice(idx + 1));
  renderWords($("origWords"), lastWords, false);
  $("poisonCard").hidden = false;
  $("poisonBtn").disabled = true; $("poisonBtn").textContent = "Deriving tampered phrase…";
  QTC_CHECK.addressToChecksumAsync(tamp, QTC_WORDLIST, null).then(function (tw) {
    renderWords($("tampWords"), tw, true);
    $("poisonBtn").disabled = false; $("poisonBtn").textContent = "Tamper with one character — show the poisoning demo";
    $("poisonCard").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "nearest" });
  });
});

/* ---------- reversible transfer simulator ---------- */
var simTimer = null, simState = null;

function fmtBlocks(b) {
  var ms = b * BLOCK_MS, s = Math.round(ms / 1000);
  if (s < 90) return s + "s";
  var m = Math.round(s / 60);
  if (m < 90) return m + " min";
  var h = Math.round(m / 60);
  if (h < 48) return h + " h";
  return (h / 24).toFixed(h % 24 === 0 ? 0 : 1) + " d";
}
function fmtNum(n) { return n.toLocaleString("en-US"); }

document.querySelectorAll(".preset").forEach(function (p) {
  p.addEventListener("click", function () {
    document.querySelectorAll(".preset").forEach(function (x) { x.classList.remove("active"); });
    p.classList.add("active");
    $("customBlocks").value = "";
    $("railDelay").textContent = fmtNum(+p.dataset.blocks) + " blocks ≈ " + fmtBlocks(+p.dataset.blocks) +
      " on mainnet (12 s blocks). Below the 2-block runtime minimum is rejected by the chain.";
  });
});
$("customBlocks").addEventListener("input", function () {
  if ($("customBlocks").value.trim()) {
    document.querySelectorAll(".preset").forEach(function (x) { x.classList.remove("active"); });
    var b = parseInt($("customBlocks").value, 10);
    if (Number.isInteger(b) && b > 0)
      $("railDelay").textContent = fmtNum(b) + " blocks ≈ " + fmtBlocks(b) +
        " on mainnet (12 s blocks). Below the 2-block runtime minimum is rejected by the chain.";
  }
});

function simLog(msg, cls) {
  var d = document.createElement("div");
  d.className = "le" + (cls ? " " + cls : "");
  d.innerHTML = msg;
  var log = $("simLog");
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function setStep(name) {
  var order = ["created", "inblock", "scheduled", "done"];
  document.querySelectorAll(".tl-step").forEach(function (el) {
    var s = el.dataset.s;
    el.classList.toggle("on", order.indexOf(s) <= order.indexOf(name));
    el.classList.remove("bad");
  });
  var fill = $("tlFill");
  fill.style.width = (order.indexOf(name) / (order.length - 1) * 100) + "%";
  fill.style.background = ""; fill.style.boxShadow = "";
}
function markBad() {
  document.querySelectorAll(".tl-step").forEach(function (el) {
    if (el.dataset.s === "done") { el.classList.add("bad"); el.querySelector(".lbl").textContent = "Cancelled"; }
  });
  var fill = $("tlFill");
  fill.style.background = "var(--warn)"; fill.style.boxShadow = "0 0 8px var(--warn)";
}

function clearSim() {
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  simState = null;
  $("simActive").hidden = true; $("simEmpty").hidden = false;
  $("liveDot").hidden = true;
}

$("resetBtn").addEventListener("click", clearSim);

$("scheduleBtn").addEventListener("click", function () {
  clearSim();
  var err = $("simErr"); err.hidden = true;
  var dest = $("simAddr").value.trim();
  var amt = parseFloat($("simAmt").value);
  var custom = $("customBlocks").value.trim();
  var blocks = custom ? parseInt(custom, 10) : +document.querySelector(".preset.active").dataset.blocks;
  if (!dest) { err.textContent = "Enter a recipient address (any string works in the simulation)."; err.hidden = false; return; }
  if (!(amt > 0)) { err.textContent = "Amount must be greater than zero."; err.hidden = false; return; }
  if (!Number.isInteger(blocks) || blocks < MIN_DELAY_BLOCKS) {
    err.textContent = "Delay must be a whole number of blocks ≥ 2 (the runtime minimum)."; err.hidden = false; return;
  }
  if (blocks > 1000000) { err.textContent = "Keep the demo under 1,000,000 blocks."; err.hidden = false; return; }

  $("simEmpty").hidden = true; $("simActive").hidden = false; $("liveDot").hidden = false;
  $("simLog").innerHTML = "";
  var short = dest.length > 26 ? dest.slice(0, 22) + "…" + dest.slice(-4) : dest;
  $("txAmt").textContent = amt + " QTC";
  $("txDest").textContent = short; $("txDest").title = dest;

  // Demo clock: compress the window to ~45s max so any delay is watchable.
  var rate = Math.max(1, Math.ceil(blocks / 45)); // blocks per tick (1 tick = 1s)
  var remaining = blocks;
  simState = { blocks: blocks, remaining: remaining, rate: rate, amt: amt, cancelled: false };

  simLog("<b>schedule_transfer_with_delay</b> dispatched — " + amt + " QTC → escrow hold, delay " + fmtNum(blocks) + " blocks.");
  simLog("Demo clock: <b>" + rate + " block" + (rate > 1 ? "s" : "") + "/sec</b> (simulated). On mainnet this window is " + fmtBlocks(blocks) + ".", "warn");
  setStep("created");
  $("cdNum").textContent = fmtNum(blocks); $("cdLbl").textContent = "blocks remaining";

  simTimer = setInterval(function () {
    if (!simState || simState.cancelled) return;
    if (simState.remaining === simState.blocks) {
      simLog("Included in a block — status <b>SCHEDULED</b>. Countdown running; <b>cancel(tx_id)</b> is available.");
      setStep("inblock");
      setTimeout(function () { if (simState && !simState.cancelled) setStep("scheduled"); }, 900);
    }
    simState.remaining = Math.max(0, simState.remaining - simState.rate);
    $("cdNum").textContent = fmtNum(simState.remaining);
    var doneFrac = 1 - simState.remaining / simState.blocks;
    $("tlFill").style.width = (66 + 34 * doneFrac).toFixed(1) + "%";
    if (simState.remaining <= 0) {
      clearInterval(simTimer); simTimer = null;
      setStep("done");
      document.querySelector('.tl-step[data-s="done"] .lbl').textContent = "Executed";
      $("cdNum").textContent = "0"; $("cdLbl").textContent = "window elapsed";
      $("cancelBtn").disabled = true; $("liveDot").hidden = true;
      simLog("<b>Delay expired</b> — Scheduler pallet executed the transfer: " + amt + " QTC delivered to the recipient.");
      simLog("Sender's cancellation window is now closed. This is final.", "warn");
    }
  }, 1000);
});

$("cancelBtn").addEventListener("click", function () {
  if (!simState || simState.cancelled) return;
  simState.cancelled = true;
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  markBad();
  $("cancelBtn").disabled = true; $("liveDot").hidden = true;
  $("cdLbl").textContent = "cancelled with " + fmtNum(simState.remaining) + " blocks left";
  simLog("<b>cancel(tx_id)</b> dispatched by the sender.", "warn");
  simLog("Escrow hold released — full <b>" + simState.amt + " QTC</b> returned to the sender. No reversal fee on sender-cancelled one-time transfers; only the cancel extrinsic's network fee.", "warn");
});

})();
