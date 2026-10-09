/* QTC SafeSend Lab — UI.
 * Checkphrase crypto lives in js/checkphrase-core.js (validated 1171/1171 upstream vectors).
 * Delay constants mirror the chain runtime: MinDelayPeriodBlocks = 2,
 * DefaultDelay = DAYS = 7200 blocks, TargetBlockTime = 12s.
 *
 * Input boundary (this app has no RPC/load boundary — it is fully local, so
 * its boundary is user input): the verifier SS58-validates the pasted string
 * (js/ss58.js — base58 charset, checksum, Quantus prefix 189, 32-byte key,
 * the same gate Contact Vault applies) BEFORE any phrase is derived, so a
 * corrupted or foreign address never gets an authoritative-looking
 * checkphrase; the simulator parses amount and delay strictly (planck-exact
 * amount shape, whole-block delays) instead of parseFloat/parseInt coercion.
 */
(function () {
"use strict";

var BLOCK_MS = 12000;
var MIN_DELAY_BLOCKS = 2;
var DEFAULT_DELAY_BLOCKS = 7200;
var MAX_SUPPLY_QTC = 21000000; // the chain's hard cap — no transfer can exceed it

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
/* Sequence token for the poisoning demo's async KDF. EVERY path that
 * changes what the displayed checkphrase is bound to — an address edit or
 * example fill (voidDerived), a new derive, a new poison run — bumps it, so
 * a tampered-phrase result that lands late can be told apart from the
 * current one and discarded instead of rendering over newer state. */
var poisonSeq = 0;
var POISON_LABEL = "Tamper with one character — show the poisoning demo";
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

/* The displayed checkphrase is a pin bound to lastAddr. Any edit that makes
 * the field diverge from lastAddr must void it: leaving the old words on
 * screen would present them as the checkphrase of the address now in the
 * box — exactly the mismatch this verifier exists to catch. */
function renderPlaceholderWords() {
  var row = $("wordRow"); row.innerHTML = "";
  for (var i = 0; i < 5; i++) {
    var s = document.createElement("span");
    s.className = "word empty"; s.textContent = "—";
    row.appendChild(s);
  }
}
function voidDerived(msg) {
  /* Invalidate any in-flight poison KDF and own the button's full state —
   * its LABEL is part of that state: a void landing mid-demo must not
   * leave the button reading "Deriving tampered phrase…" for a demo that
   * will never render. */
  poisonSeq++;
  $("poisonBtn").textContent = POISON_LABEL;
  if (!lastAddr && !lastWords) return;
  lastAddr = ""; lastWords = null;
  $("poisonBtn").disabled = true;
  $("poisonCard").hidden = true;
  renderPlaceholderWords();
  $("resNote").textContent = msg;
}
var CHANGED_MSG = "Address changed — the checkphrase shown was for the previous address and has been cleared. Derive again for the address now in the box.";

$("addrInput").addEventListener("input", function () {
  if ($("addrInput").value.trim() !== lastAddr) voidDerived(CHANGED_MSG);
});
/* Example buttons set the field programmatically (no input event fires),
 * so they must void the pin explicitly. */
$("exKyle").addEventListener("click", function () { $("addrInput").value = KYLE; voidDerived(CHANGED_MSG); });
$("exGenesis").addEventListener("click", function () { $("addrInput").value = GENESIS; voidDerived(CHANGED_MSG); });

/* A checkphrase is only meaningful for the exact, uncorrupted Quantus
 * address it was derived from. Gate derivation on a real SS58 decode:
 * a mistyped character (checksum mismatch), a non-base58 string, or a
 * foreign chain's address must be rejected with the reason — never
 * rendered as a five-word phrase a user could read back as verified. */
function rejectAddress(msg) {
  lastAddr = ""; lastWords = null;
  poisonSeq++;
  $("poisonBtn").disabled = true;
  $("poisonBtn").textContent = POISON_LABEL;
  $("poisonCard").hidden = true;
  renderPlaceholderWords();
  $("resNote").textContent = msg;
}
function quantusAddressError(addr) {
  if (typeof QSS58 === "undefined" || !QSS58.ss58Decode)
    return "The address validator failed to load, so no checkphrase can be derived safely. Reload the page.";
  var dec = QSS58.ss58Decode(addr);
  if (!dec.ok) return "Not a valid Quantus address — " + dec.error;
  if (dec.prefix !== QSS58.QUANTUS_PREFIX)
    return "Not a Quantus address — this string is a valid SS58 address for prefix " + dec.prefix +
      ", not Quantus (prefix " + QSS58.QUANTUS_PREFIX + "). Its Quantus checkphrase would be meaningless.";
  if (!dec.key || dec.key.length !== 32)
    return "Not a Quantus account address — it decodes cleanly but carries a " +
      (dec.key ? dec.key.length : 0) + "-byte key, not the 32-byte account key Quantus uses.";
  return null;
}

$("deriveBtn").addEventListener("click", function () {
  poisonSeq++; // a new derive supersedes any poison demo still in flight
  var addr = $("addrInput").value.trim();
  if (!addr) { $("resNote").textContent = "Paste an address first."; return; }
  var addrErr = quantusAddressError(addr);
  if (addrErr) { rejectAddress(addrErr + " No checkphrase was derived."); return; }
  var wrap = $("progWrap"), bar = $("progBar"), note = $("progNote");
  wrap.hidden = false; bar.style.width = "0%"; note.textContent = "Running 40,000 KDF iterations…";
  $("deriveBtn").disabled = true; $("poisonBtn").disabled = true;
  QTC_CHECK.addressToChecksumAsync(addr, QTC_WORDLIST, function (done, total) {
    bar.style.width = (100 * done / total).toFixed(1) + "%";
  }).then(function (words) {
    wrap.hidden = true; $("deriveBtn").disabled = false;
    if ($("addrInput").value.trim() !== addr) {
      /* The field moved while the KDF ran (e.g. an example button — no
       * input event): this result belongs to the previous address. */
      lastAddr = addr; lastWords = words; // make voidDerived act, then clear
      voidDerived("The address changed while deriving — that result was for the previous address and was discarded. Derive again for the address now in the box.");
      return;
    }
    lastAddr = addr; lastWords = words;
    renderWords($("wordRow"), words, true);
    $("resNote").textContent = "Derived locally from " + addr.length + "-character address · 5 words · 2,048-word list. Read them back to the recipient.";
    $("poisonBtn").disabled = false;
    $("poisonCard").hidden = true;
  }).catch(function (e) {
    wrap.hidden = true; $("deriveBtn").disabled = false;
    if ($("addrInput").value.trim() !== addr) {
      /* Same pin as the success path: this failure belongs to the previous
       * address. Painting its error would blame the address now in the box
       * for a derivation it never attempted. */
      lastAddr = addr; lastWords = ["discarded"]; // make voidDerived act, then clear
      voidDerived("The address changed while deriving — that attempt failed for the previous address and was discarded. Derive again for the address now in the box.");
      return;
    }
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
  /* Pin this run to the derivation it demos. A void (address edit / example
   * fill), a new derive, or a newer poison run bumps poisonSeq and/or moves
   * lastAddr; a completion that finds either moved is stale — it must not
   * render its tampered words, re-enable the button over a void, or scroll
   * a hidden card. */
  var pinAddr = lastAddr, myPoison = ++poisonSeq;
  function stale() { return myPoison !== poisonSeq || lastAddr !== pinAddr; }
  QTC_CHECK.addressToChecksumAsync(tamp, QTC_WORDLIST, null).then(function (tw) {
    if (stale()) return;
    renderWords($("tampWords"), tw, true);
    $("poisonBtn").disabled = false; $("poisonBtn").textContent = POISON_LABEL;
    $("poisonCard").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "nearest" });
  }).catch(function (e) {
    if (stale()) return;
    /* Without this catch a failed demo wedged the button disabled at
     * "Deriving tampered phrase…" forever (unhandled rejection). */
    $("poisonBtn").disabled = false; $("poisonBtn").textContent = POISON_LABEL;
    $("resNote").textContent = "Poisoning demo failed: " + e.message;
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
function fmtAmt(n) { return n.toLocaleString("en-US", { maximumFractionDigits: 12 }); }
/* Strict whole-block delay: digits only. parseInt("7200.9") silently
 * truncated to 7200 and parseInt("2.5") to 2 — a delay the user never
 * chose was scheduled under their amount. Fractional or non-numeric
 * input is rejected, never rounded. */
function parseDelayStrict(raw) {
  var s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  var b = Number(s);
  return Number.isSafeInteger(b) ? b : null;
}
/* Planck-exact amount shape (mirrors the Web Wallet's parseQTC): a whole
 * number of QTC with at most 12 decimals — one planck is 0.000000000001.
 * parseFloat accepted sub-planck dust (rendered "1e-13 QTC") and amounts
 * beyond the 21M supply cap as schedulable transfers. */
function parseAmountStrict(raw) {
  var s = String(raw).trim();
  if (!/^\d+(\.\d{1,12})?$/.test(s)) return null;
  var a = Number(s);
  return Number.isFinite(a) ? a : null;
}
function railDelayText(b) {
  return fmtNum(b) + " blocks ≈ " + fmtBlocks(b) +
    " on mainnet (12 s blocks). Below the 2-block runtime minimum is rejected by the chain.";
}
function activatePreset(blocks) {
  document.querySelectorAll(".preset").forEach(function (x) {
    x.classList.toggle("active", +x.dataset.blocks === blocks);
  });
  $("railDelay").textContent = railDelayText(blocks);
}

document.querySelectorAll(".preset").forEach(function (p) {
  p.addEventListener("click", function () {
    document.querySelectorAll(".preset").forEach(function (x) { x.classList.remove("active"); });
    p.classList.add("active");
    $("customBlocks").value = "";
    $("railDelay").textContent = railDelayText(+p.dataset.blocks);
  });
});
$("customBlocks").addEventListener("input", function () {
  if (!$("customBlocks").value.trim()) {
    /* Clearing the custom field must restore a preset. It used to leave
     * NO preset active, and Schedule then dereferenced
     * querySelector(".preset.active").dataset — a TypeError that killed
     * the button with no error shown. */
    activatePreset(DEFAULT_DELAY_BLOCKS);
    return;
  }
  document.querySelectorAll(".preset").forEach(function (x) { x.classList.remove("active"); });
  var b = parseDelayStrict($("customBlocks").value);
  if (b !== null && b > 0) $("railDelay").textContent = railDelayText(b);
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
  /* A finished/cancelled run disables Cancel and renames the final step
   * ("Executed"/"Cancelled"). Reset both, or the NEXT scheduled transfer
   * can never be cancelled — the lab's core action. */
  $("cancelBtn").disabled = false;
  var doneLbl = document.querySelector('.tl-step[data-s="done"] .lbl');
  if (doneLbl) doneLbl.textContent = "Final";
}

$("resetBtn").addEventListener("click", clearSim);

$("scheduleBtn").addEventListener("click", function () {
  clearSim();
  var err = $("simErr"); err.hidden = true;
  var dest = $("simAddr").value.trim();
  var amt = parseAmountStrict($("simAmt").value);
  var custom = $("customBlocks").value.trim();
  var blocks;
  if (custom) {
    blocks = parseDelayStrict(custom);
    if (blocks === null) {
      err.textContent = "Delay must be a whole number of blocks — fractional or non-numeric delays are rejected, not rounded.";
      err.hidden = false; return;
    }
  } else {
    /* Defensive: the custom-clear path restores the default preset, but
     * Schedule must never dereference a missing active preset again. */
    var act = document.querySelector(".preset.active");
    blocks = act ? +act.dataset.blocks : DEFAULT_DELAY_BLOCKS;
  }
  if (!dest) { err.textContent = "Enter a recipient address (any string works in the simulation)."; err.hidden = false; return; }
  if (amt === null) {
    err.textContent = "Amount must look like 1.5 — a QTC amount with at most 12 decimals (one planck is 0.000000000001 QTC).";
    err.hidden = false; return;
  }
  if (!(amt > 0)) { err.textContent = "Amount must be greater than zero."; err.hidden = false; return; }
  if (amt > MAX_SUPPLY_QTC) {
    err.textContent = "Amount exceeds the total QTC supply cap of 21,000,000 — no account can send more QTC than will ever exist.";
    err.hidden = false; return;
  }
  if (!Number.isInteger(blocks) || blocks < MIN_DELAY_BLOCKS) {
    err.textContent = "Delay must be a whole number of blocks ≥ 2 (the runtime minimum)."; err.hidden = false; return;
  }
  if (blocks > 1000000) { err.textContent = "Keep the demo under 1,000,000 blocks."; err.hidden = false; return; }

  $("simEmpty").hidden = true; $("simActive").hidden = false; $("liveDot").hidden = false;
  $("simLog").innerHTML = "";
  var short = dest.length > 26 ? dest.slice(0, 22) + "…" + dest.slice(-4) : dest;
  $("txAmt").textContent = fmtAmt(amt) + " QTC";
  $("txDest").textContent = short; $("txDest").title = dest;

  // Demo clock: compress the window to ~45s max so any delay is watchable.
  var rate = Math.max(1, Math.ceil(blocks / 45)); // blocks per tick (1 tick = 1s)
  var remaining = blocks;
  simState = { blocks: blocks, remaining: remaining, rate: rate, amt: amt, cancelled: false };

  simLog("<b>schedule_transfer_with_delay</b> dispatched — " + fmtAmt(amt) + " QTC → escrow hold, delay " + fmtNum(blocks) + " blocks.");
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
      simLog("<b>Delay expired</b> — Scheduler pallet executed the transfer: " + fmtAmt(amt) + " QTC delivered to the recipient.");
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
  simLog("Escrow hold released — full <b>" + fmtAmt(simState.amt) + " QTC</b> returned to the sender. No reversal fee on sender-cancelled one-time transfers; only the cancel extrinsic's network fee.", "warn");
});

})();
