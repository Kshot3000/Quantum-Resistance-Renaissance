/* QTC Contact Vault — app logic.
 * The address book with a built-in poisoning alarm. 100% client-side:
 * checkphrases via the upstream algorithm (js/checkphrase-core.js),
 * SS58 validation via the shared codec (js/ss58.js), pure logic in
 * js/vault-logic.js, QR cards via ../../assets/vendor/qrcode.js. No funds move; the vault
 * never leaves this browser (localStorage).
 */
/* global QTC_CHECK, QTC_WORDLIST, QSS58, QTC_VAULT_LOGIC, qrcode */
(function () {
"use strict";

var LOGIC = QTC_VAULT_LOGIC;
var STORE_KEY = "qcv-vault-v1";
var MAX_BATCH = 200;

/* ---------- tiny utils ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function debounce(fn, ms) {
  var t = null;
  return function () {
    var a = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, a); }, ms);
  };
}
function uid() {
  var b = new Uint8Array(12);
  (crypto.getRandomValues ? crypto.getRandomValues(b)
    : b.map(function () { return Math.floor(Math.random() * 256); }));
  return Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
}
function toast(msg, kind) {
  var t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(function () { t.remove(); }, 4200);
}
function copyText(text) {
  function done(ok) { toast(ok ? "Copied to clipboard." : "Copy failed — select it manually.", ok ? "ok" : "err"); }
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
  else done(false);
}
function chipsHTML(words, diffWords) {
  return '<div class="chips">' + words.map(function (w, i) {
    var cls = "chip";
    if (diffWords) cls += diffWords[i] ? " diff" : "same";
    return '<span class="' + cls + '"><span class="wn">' + (i + 1) + "</span>" + esc(w) + "</span>";
  }).join("") + "</div>";
}
function wordsDiff(a, b) {
  return a.map(function (w, i) { return w !== b[i]; });
}
function setVerdict(el, cls, title, sub) {
  el.innerHTML = '<div class="verdict ' + cls + '"><div class="v-title">' + title +
    '</div><div class="v-sub">' + sub + "</div></div>";
}

/* ---------- scanfield: subtle security-desk sweep ---------- */
(function scanfield() {
  var cv = $("scanfield");
  if (!cv) return;
  var ctx = cv.getContext("2d"), W = 0, H = 0, y = 0;
  var dots = [];
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = [];
    for (var i = 0; i < 40; i++)
      dots.push({ x: Math.random() * W, y: Math.random() * H, p: Math.random() * 6.28 });
  }
  resize();
  window.addEventListener("resize", resize);
  var t = 0;
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function frame() {
    if (!REDUCE_MOTION) requestAnimationFrame(frame);
    if (document.hidden) return;
    t += 0.016;
    ctx.clearRect(0, 0, W, H);
    y = (y + 0.9) % (H + 160);
    var g = ctx.createLinearGradient(0, y - 90, 0, y + 10);
    g.addColorStop(0, "rgba(255,69,69,0)");
    g.addColorStop(1, "rgba(255,69,69,0.05)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 90, W, 100);
    ctx.fillStyle = "rgba(255,69,69,0.16)";
    ctx.fillRect(0, y, W, 1);
    ctx.fillStyle = "rgba(255,176,46,0.20)";
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      if (Math.sin(t * 1.4 + d.p) > 0.55) ctx.fillRect(d.x, d.y, 2, 2);
    }
  })();
})();

/* ---------- tabs ---------- */
var tabs = Array.prototype.slice.call(document.querySelectorAll(".tabnav button"));
function showTab(name) {
  tabs.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); });
  ["vault", "verify", "lab", "batch", "xfer", "scope"].forEach(function (n) {
    $("tab-" + n).hidden = n !== name;
  });
  try { history.replaceState(null, "", "#" + name); } catch (e) { /* file:// */ }
}
tabs.forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.tab); }); });

/* ---------- checkphrase derivation (cached) ---------- */
var phraseCache = new Map();
function derivePhrase(addr, onProgress) {
  if (phraseCache.has(addr)) return Promise.resolve(phraseCache.get(addr));
  return QTC_CHECK.addressToChecksumAsync(addr, QTC_WORDLIST, onProgress || null)
    .then(function (words) { phraseCache.set(addr, words); return words; });
}

/* ---------- vault store ---------- */
function loadVault() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(function (c) { return c && c.address; }) : [];
  } catch (e) { return []; }
}
function saveVault() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(vault)); }
  catch (e) { toast("Could not save vault: storage unavailable.", "err"); }
}
var vault = loadVault();
function findByAddress(addr) {
  addr = String(addr).trim();
  for (var i = 0; i < vault.length; i++) if (vault[i].address === addr) return vault[i];
  return null;
}
function sortedVault() {
  return vault.slice().sort(function (a, b) {
    if (!!a.trusted !== !!b.trusted) return a.trusted ? -1 : 1;
    return String(b.addedAt || "").localeCompare(String(a.addedAt || ""));
  });
}

/* ---------- vault tab ---------- */
function renderVaultList() {
  var q = $("vaultSearch").value.trim().toLowerCase();
  var list = sortedVault().filter(function (c) {
    return !q || c.label.toLowerCase().indexOf(q) >= 0 ||
      c.address.toLowerCase().indexOf(q) >= 0 || (c.note || "").toLowerCase().indexOf(q) >= 0;
  });
  $("vaultCount").textContent = vault.length + (vault.length === 1 ? " contact" : " contacts");
  $("vaultEmpty").style.display = list.length ? "none" : "";
  var html = list.map(function (c) {
    var chips = c.checkphrase ? chipsHTML(c.checkphrase)
      : '<div class="chips"><span class="chip"><span class="spinner"></span>deriving checkphrase…</span></div>';
    return '<div class="contact' + (c.trusted ? " trusted" : "") + '" data-id="' + c.id + '">' +
      '<div class="c-head"><span class="c-label">' + (c.trusted ? '<span class="star">★</span>' : "") +
      esc(c.label) + '</span><span class="c-added">' + esc(c.addedAt ? c.addedAt.slice(0, 10) : "") + "</span></div>" +
      '<div class="c-addr" data-copy-addr title="Click to copy">' + esc(c.address) + "</div>" +
      (c.note ? '<div class="c-note">' + esc(c.note) + "</div>" : "") +
      chips +
      '<div class="c-actions">' +
      '<button class="btn small ghost" data-act="trusted">' + (c.trusted ? "☆ Unmark trusted" : "★ Mark trusted") + "</button>" +
      '<button class="btn small ghost" data-act="qr">▦ QR share card</button>' +
      '<button class="btn small ghost" data-act="edit">✎ Edit</button>' +
      '<button class="btn small danger-ghost" data-act="del">Delete</button>' +
      "</div></div>";
  }).join("");
  $("vaultList").innerHTML = html;
  // lazy checkphrase fill for contacts missing one
  list.forEach(function (c) {
    if (!c.checkphrase) {
      derivePhrase(c.address).then(function (words) {
        c.checkphrase = words; saveVault();
        var card = document.querySelector('.contact[data-id="' + c.id + '"] .chips');
        if (card) card.outerHTML = chipsHTML(words);
      }).catch(function () { /* keep spinner */ });
    }
  });
  refreshContactSelects();
}
function refreshContactSelects() {
  ["simContact", "avContact"].forEach(function (id) {
    var sel = $(id), cur = sel.value;
    sel.innerHTML = vault.length
      ? sortedVault().map(function (c) {
          return '<option value="' + c.id + '">' + esc(c.label) + " · " + esc(c.address.slice(0, 12)) + "…</option>";
        }).join("")
      : '<option value="">— vault is empty —</option>';
    if (cur) sel.value = cur;
  });
}
$("vaultSearch").addEventListener("input", debounce(renderVaultList, 200));
$("vaultList").addEventListener("click", function (ev) {
  var addrEl = ev.target.closest("[data-copy-addr]");
  if (addrEl) { copyText(addrEl.textContent.trim()); return; }
  var btn = ev.target.closest("[data-act]");
  if (!btn) return;
  var card = ev.target.closest(".contact");
  var c = vault.filter(function (x) { return x.id === card.dataset.id; })[0];
  if (!c) return;
  var act = btn.dataset.act;
  if (act === "trusted") { c.trusted = !c.trusted; saveVault(); renderVaultList(); }
  else if (act === "qr") { openQr(c); }
  else if (act === "edit") { startEdit(card, c); }
  else if (act === "del") {
    if (btn.dataset.armed) {
      vault = vault.filter(function (x) { return x.id !== c.id; });
      saveVault(); renderVaultList(); toast("Contact deleted.", "ok");
    } else {
      btn.dataset.armed = "1"; btn.textContent = "Click again to confirm";
      setTimeout(function () { delete btn.dataset.armed; renderVaultList(); }, 3000);
    }
  }
});
function startEdit(card, c) {
  card.innerHTML =
    '<label class="f">Label</label><input type="text" id="e-label" maxlength="80" value="' + esc(c.label) + '">' +
    '<label class="f">Address</label><input type="text" class="mono" id="e-addr" value="' + esc(c.address) + '" spellcheck="false">' +
    '<label class="f">Note</label><input type="text" id="e-note" maxlength="500" value="' + esc(c.note || "") + '">' +
    '<div class="msg" id="e-msg"></div>' +
    '<div class="c-actions"><button class="btn small primary" id="e-save">Save</button>' +
    '<button class="btn small ghost" id="e-cancel">Cancel</button></div>';
  $("e-cancel").addEventListener("click", renderVaultList);
  $("e-save").addEventListener("click", function () {
    var label = $("e-label").value.trim(), addr = $("e-addr").value.trim(), note = $("e-note").value.trim();
    var msg = $("e-msg");
    if (!label) { msg.className = "msg err"; msg.textContent = "Label is required."; return; }
    var v = LOGIC.validateQuantusAddress(addr);
    if (!v.ok) { msg.className = "msg err"; msg.textContent = v.message; return; }
    var dupe = findByAddress(v.address);
    if (dupe && dupe.id !== c.id) { msg.className = "msg err"; msg.textContent = "That address is already saved as “" + dupe.label + "”."; return; }
    var changed = v.address !== c.address;
    c.label = label; c.address = v.address; c.note = note;
    if (changed) c.checkphrase = null;
    saveVault(); renderVaultList(); toast("Contact updated.", "ok");
  });
}
$("addForm").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var label = $("nc-label").value.trim(), addr = $("nc-addr").value.trim(), note = $("nc-note").value.trim();
  var msg = $("addMsg"), btn = $("addBtn");
  function fail(t) { msg.className = "msg err"; msg.textContent = t; }
  if (!label) return fail("Give the contact a label.");
  var v = LOGIC.validateQuantusAddress(addr);
  if (!v.ok) return fail(v.message);
  if (findByAddress(v.address)) return fail("That address is already in your vault as “" + findByAddress(v.address).label + "”.");
  msg.className = "msg"; msg.innerHTML = '<span class="spinner"></span>Checksum OK — deriving checkphrase…';
  btn.disabled = true;
  derivePhrase(v.address).then(function (words) {
    vault.push({ id: uid(), label: label, address: v.address, note: note,
                 trusted: false, addedAt: new Date().toISOString(), checkphrase: words });
    saveVault(); renderVaultList();
    $("nc-label").value = ""; $("nc-addr").value = ""; $("nc-note").value = "";
    msg.className = "msg ok"; msg.textContent = "✓ Saved — checkphrase: " + words.join(" · ");
    btn.disabled = false;
    toast("Contact added to the vault.", "ok");
  }).catch(function () {
    btn.disabled = false;
    fail("Checkphrase derivation failed — try again.");
  });
});

/* ---------- QR share card ---------- */
function openQr(c) {
  $("qrTitle").textContent = c.label;
  $("qrAddr").textContent = c.address;
  var words = c.checkphrase || phraseCache.get(c.address);
  function render(wordsNow) {
    $("qrPhrase").innerHTML = chipsHTML(wordsNow);
  }
  var qr = qrcode(0, "M");
  qr.addData(c.address); qr.make();
  $("qrImg").innerHTML = qr.createImgTag(6, 4);
  if (words) render(words);
  else {
    $("qrPhrase").innerHTML = '<span class="chip"><span class="spinner"></span>deriving…</span>';
    derivePhrase(c.address).then(function (w) {
      c.checkphrase = w; saveVault(); render(w); renderVaultList();
    });
  }
  $("qrModal").hidden = false;
}
$("qrClose").addEventListener("click", function () { $("qrModal").hidden = true; });
$("qrModal").addEventListener("click", function (ev) {
  if (ev.target === $("qrModal") || ev.target.closest("#qrClose")) $("qrModal").hidden = true;
});
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") $("qrModal").hidden = true;
});

/* ---------- verify-on-paste ---------- */
var vToken = 0;
$("vAddr").addEventListener("input", debounce(onVerifyInput, 350));
function onVerifyInput() {
  var my = ++vToken;
  var raw = $("vAddr").value.trim();
  $("vAddBtn").hidden = true;
  $("vSim").innerHTML = "";
  if (!raw) {
    setVerdict($("vVerdict"), "idle", "Awaiting input", "Paste an address above — the verdict lands here.");
    $("vPhrase").innerHTML = "";
    return;
  }
  var v = LOGIC.validateQuantusAddress(raw);
  if (!v.ok) {
    setVerdict($("vVerdict"), "err", "✗ Invalid address", esc(v.message));
    $("vPhrase").innerHTML = "";
    return;
  }
  setVerdict($("vVerdict"), "idle",
    '<span class="spinner"></span>Deriving checkphrase…',
    "PBKDF2-HMAC-SHA256, 40,000 iterations — a moment.");
  $("vPhrase").innerHTML = "";
  var match = findByAddress(v.address);
  derivePhrase(v.address).then(function (words) {
    if (my !== vToken) return;
    $("vPhrase").innerHTML = chipsHTML(words);
    if (match) {
      setVerdict($("vVerdict"), "ok",
        "✓ MATCH — " + esc(match.label) + (match.trusted ? " ★ trusted" : ""),
        "This exact address is saved in your vault" + (match.note ? " (“" + esc(match.note) + "”)" : "") +
        ". Checkphrase confirmed — safe to use <em>if</em> you trust the label.");
    } else {
      setVerdict($("vVerdict"), "warn",
        "? Unknown address — not in your vault",
        "Checksum is valid, but nobody you saved uses this address. Read the five words back to the sender before you trust it.");
      $("vAddBtn").hidden = false;
      $("vAddBtn").onclick = function () {
        $("nc-addr").value = v.address;
        showTab("vault");
        $("nc-label").focus();
        toast("Address dropped into the add-contact form.", "ok");
      };
      if (vault.length) {
        var best = LOGIC.closestContact(v.address, vault);
        if (best && best.contact.address !== v.address) renderSimilarity($("vSim"), v.address, best);
      }
    }
  });
}
function renderSimilarity(el, addr, best) {
  function bar(label, frac, val, good) {
    return '<div class="bar-row"><span class="bl">' + label + '</span>' +
      '<div class="bar' + (good ? " g" : "") + '"><i style="width:' + Math.round(frac * 100) + '%"></i></div>' +
      '<span class="bv">' + val + "</span></div>";
  }
  el.innerHTML = '<div class="sim"><h4>🎯 Similarity meter — closest saved contact: <strong>' +
    esc(best.contact.label) + "</strong></h4>" +
    bar("Shared prefix", best.prefix / addr.length, best.prefix + " chars", false) +
    bar("Shared suffix", best.suffix / addr.length, best.suffix + " chars", false) +
    bar("Edit distance", 1 - Math.min(best.dist, addr.length) / addr.length, best.dist + " edits", true) +
    '<div class="note">A poisoned lookalike is engineered to score high here — matching prefixes and suffixes are <em>cheap to grind</em>. ' +
    "The checkphrase above is the part that cannot be faked cheaply: it changes completely on any single-character difference.</div></div>";
}

/* ---------- spoken checkphrase ---------- */
$("sCheckBtn").addEventListener("click", function () {
  var out = $("sResult");
  var v = LOGIC.validateQuantusAddress($("sAddr").value);
  if (!v.ok) { out.innerHTML = ""; setVerdict(out, "err", "✗ Invalid address", esc(v.message)); return; }
  var typed = $("sWords").value.toLowerCase().split(/[\s\-_.,;\/]+/).filter(Boolean);
  if (typed.length !== 5) {
    out.innerHTML = "";
    setVerdict(out, "err", "✗ Need exactly five words", "You entered " + typed.length + ". Ask them to read the checkphrase again, slowly.");
    return;
  }
  out.innerHTML = '<div class="msg"><span class="spinner"></span>Deriving the true checkphrase…</div>';
  derivePhrase(v.address).then(function (words) {
    var diff = wordsDiff(words.map(function (w) { return w.toLowerCase(); }), typed);
    var bad = diff.filter(Boolean).length;
    out.innerHTML = '<div class="chips">' + words.map(function (w, i) {
      return '<span class="chip ' + (diff[i] ? "diff" : "same") + '"><span class="wn">' + (i + 1) +
        "</span>" + esc(w) + (diff[i] ? ' <span class="wn">you heard: ' + esc(typed[i]) + "</span>" : "") + "</span>";
    }).join("") + "</div>";
    if (bad === 0)
      setVerdict(out, "ok", "✓ Words match", "All five words match the address. This is the address they meant.");
    else
      setVerdict(out, "err", '<span class="pulse-dot"></span>✗ ' + bad + " of 5 words differ",
        "Stop. The address in front of you is <strong>not</strong> the one those words describe — it was swapped or mistyped.");
  });
});

/* ---------- poisoning lab: grind real lookalikes ---------- */
var grindStop = false;
$("simGrind").addEventListener("click", function () {
  var sel = $("simContact");
  var c = vault.filter(function (x) { return x.id === sel.value; })[0];
  var out = $("simResults");
  if (!c) { out.innerHTML = '<div class="msg err">Add a contact to the vault first — the lab needs a target.</div>'; return; }
  var k = parseInt($("simK").value, 10);
  var want = parseInt($("simWant").value, 10);
  var maxAttempts = k <= 2 ? 300000 : k === 3 ? 2000000 : 6000000;
  var target = c.address.slice(0, 2 + k);
  grindStop = false;
  $("simGrind").disabled = true;
  $("simStop").hidden = false;
  $("simProgWrap").hidden = false;
  out.innerHTML = "";
  derivePhrase(c.address).then(function (realWords) {
    var found = [], attempts = 0, t0 = performance.now();
    function tick() {
      var el = Math.round((performance.now() - t0) / 1000);
      $("simProgLine").textContent = attempts.toLocaleString() + " attempts · " + found.length + "/" + want +
        " lookalikes · " + el + "s" + (attempts >= maxAttempts ? " · attempt cap reached" : "");
    }
    function chunk() {
      if (grindStop || found.length >= want || attempts >= maxAttempts) return finish();
      var n = Math.min(600, maxAttempts - attempts);
      for (var i = 0; i < n; i++) {
        attempts++;
        var key = new Uint8Array(32);
        crypto.getRandomValues(key);
        var addr = QSS58.ss58Encode(Array.prototype.slice.call(key), 189);
        if (addr !== c.address && addr.slice(0, 2 + k) === target) found.push(addr);
        if (found.length >= want) break;
      }
      $("simProg").style.width = Math.min(100, (attempts / maxAttempts) * 100) + "%";
      tick();
      setTimeout(chunk, 0);
    }
    function finish() {
      $("simGrind").disabled = false;
      $("simStop").hidden = true;
      $("simProgWrap").hidden = true;
      var capped = attempts >= maxAttempts && found.length < want;
      out.innerHTML = '<div class="msg ' + (found.length ? "ok" : "err") + '">' +
        (grindStop ? "Stopped by you. " : "") +
        "Ground <strong>" + found.length + "</strong> real, valid Quantus address" + (found.length === 1 ? "" : "es") +
        " sharing <span class='mono'>" + esc(target) + "…</span> in " + attempts.toLocaleString() + " attempts." +
        (capped ? " The attempt cap was reached — longer matching prefixes take exponentially more grinding, which is exactly the honest cost curve." : "") +
        "</div><div id='simRows'></div>";
      var rows = $("simRows"), idx = 0;
      (function next() {
        if (idx >= found.length) return;
        var a = found[idx++];
        var hl = '<span class="hl">' + esc(a.slice(0, 2 + k)) + "</span>" + esc(a.slice(2 + k));
        derivePhrase(a).then(function (w) {
          var d = wordsDiff(realWords, w);
          var row = document.createElement("div");
          row.className = "look";
          row.innerHTML = '<div class="lk-cap"><span class="pulse-dot"></span>poisoned lookalike — do not trust</div>' +
            '<div class="lk-addr">' + hl + "</div>" +
            '<div class="vs"><div class="side"><h5>Real contact · ' + esc(c.label) + "</h5>" + chipsHTML(realWords) +
            '</div><div class="side bad"><h5>Lookalike checkphrase · ' + d.filter(Boolean).length + "/5 words differ</h5>" +
            chipsHTML(w, d) + "</div></div>";
          rows.appendChild(row);
          next();
        });
      })();
    }
    chunk();
  });
});
$("simStop").addEventListener("click", function () { grindStop = true; });

/* ---------- poisoning lab: one-character avalanche ---------- */
$("avRun").addEventListener("click", function () {
  var sel = $("avContact");
  var c = vault.filter(function (x) { return x.id === sel.value; })[0];
  var out = $("avOut");
  if (!c) { out.innerHTML = '<div class="msg err">Add a contact to the vault first.</div>'; return; }
  out.innerHTML = '<div class="msg"><span class="spinner"></span>Deriving both checkphrases…</div>';
  var m = LOGIC.mutateMiddleChar(c.address);
  Promise.all([derivePhrase(c.address), derivePhrase(m.mutated)]).then(function (r) {
    var realW = r[0], mutW = r[1];
    var d = wordsDiff(realW, mutW);
    var n = d.filter(Boolean).length;
    var shown = esc(m.mutated.slice(0, m.index)) + '<span class="hl" style="background:rgba(255,69,69,.25);color:#ffb3b3;border-radius:4px;padding:1px 3px">' +
      esc(m.to) + "</span>" + esc(m.mutated.slice(m.index + 1));
    out.innerHTML = '<div class="look"><div class="lk-cap"><span class="pulse-dot"></span>avalanche demo — 1 character changed at position ' +
      (m.index + 1) + " (“" + esc(m.from) + "” → “" + esc(m.to) + "”)</div>" +
      '<div class="lk-addr mono">' + shown + "</div>" +
      '<div class="vs"><div class="side"><h5>Original · ' + esc(c.label) + "</h5>" + chipsHTML(realW) +
      '</div><div class="side bad"><h5>Mutated · ' + n + "/5 words differ</h5>" + chipsHTML(mutW, d) + "</div></div>" +
      '<div class="note" style="font-size:13px;color:var(--desk-muted);margin-top:10px">The mutated string is just a string — its checkphrase still computes, because a checkphrase is a pure function of the characters. ' +
      "That is why words beat eyeballs: a one-character swap is invisible at a glance and unmistakable in the words.</div></div>";
  });
});

/* ---------- batch verify ---------- */
$("bRun").addEventListener("click", function () {
  var lines = $("bAddrs").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  var body = $("bBody"), table = $("bTable"), summary = $("bSummary"), prog = $("bProg");
  body.innerHTML = ""; summary.innerHTML = "";
  if (!lines.length) { prog.textContent = "Paste at least one address."; return; }
  if (lines.length > MAX_BATCH) lines = lines.slice(0, MAX_BATCH);
  table.hidden = false;
  var btn = $("bRun");
  btn.disabled = true;
  var counts = { match: 0, unknown: 0, invalid: 0 }, i = 0;
  (function next() {
    if (i >= lines.length) {
      btn.disabled = false;
      prog.textContent = "Done.";
      summary.innerHTML =
        '<span>✓ matched <b>' + counts.match + '</b></span>' +
        '<span>? unknown <b>' + counts.unknown + '</b></span>' +
        '<span>✗ invalid <b>' + counts.invalid + '</b></span>';
      return;
    }
    var addr = lines[i];
    prog.textContent = "Verifying " + (i + 1) + "/" + lines.length + "…";
    var v = LOGIC.validateQuantusAddress(addr);
    var tr = document.createElement("tr");
    function pill(cls, txt) { return '<span class="pill ' + cls + '">' + txt + "</span>"; }
    function row(statusPill, phrase, verdictPill) {
      tr.innerHTML = "<td>" + (i + 1) + '</td><td class="mono">' + esc(addr.length > 34 ? addr.slice(0, 18) + "…" + addr.slice(-12) : addr) +
        "</td><td>" + statusPill + "</td><td>" + phrase + "</td><td>" + verdictPill + "</td>";
      body.appendChild(tr);
      i++;
      setTimeout(next, 0);
    }
    if (!v.ok) {
      counts.invalid++;
      row(pill("bad", "✗ invalid"), '<span style="color:var(--desk-dim)">—</span>',
        pill("bad", "invalid") + '<div style="font-size:12px;color:var(--desk-dim);margin-top:4px">' + esc(v.message) + "</div>");
      return;
    }
    var match = findByAddress(v.address);
    derivePhrase(v.address).then(function (words) {
      if (match) { counts.match++; row(pill("ok", "✓ valid"), chipsHTML(words), pill("ok", "✓ " + esc(match.label))); }
      else { counts.unknown++; row(pill("ok", "✓ valid"), chipsHTML(words), pill("unk", "? unknown")); }
    });
  })();
});

/* ---------- export / import ---------- */
function download(name, text) {
  var blob = new Blob([text], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
var lastEncText = null;
$("xShow").addEventListener("click", function () {
  var payload = LOGIC.buildExportPayload(vault);
  $("xOut").value = JSON.stringify(payload, null, 2);
  $("xMsg").className = "msg ok";
  $("xMsg").textContent = "Plain backup ready — " + payload.contacts.length + " contacts.";
});
$("xDl").addEventListener("click", function () {
  download("qtc-contact-vault.json", JSON.stringify(LOGIC.buildExportPayload(vault), null, 2));
  toast("Backup downloaded.", "ok");
});
$("xEnc").addEventListener("click", function () {
  var p1 = $("xPass").value, p2 = $("xPass2").value, msg = $("xMsg");
  if (p1 !== p2) { msg.className = "msg err"; msg.textContent = "Passwords do not match."; return; }
  if (p1.length < 8) { msg.className = "msg err"; msg.textContent = "Password must be at least 8 characters."; return; }
  msg.className = "msg";
  msg.innerHTML = '<span class="spinner"></span>Deriving key (PBKDF2, 200,000 iterations)…';
  var plain = JSON.stringify(LOGIC.buildExportPayload(vault));
  LOGIC.encryptBackup(p1, plain).then(function (armored) {
    lastEncText = JSON.stringify(armored, null, 2);
    $("xOut").value = lastEncText;
    $("xEncDl").disabled = false;
    msg.className = "msg ok";
    msg.textContent = "✓ Encrypted backup ready — AES-GCM-256. Store it anywhere; it is useless without the password.";
    $("xPass").value = ""; $("xPass2").value = "";
  }).catch(function (e) {
    msg.className = "msg err"; msg.textContent = e.message;
  });
});
$("xEncDl").addEventListener("click", function () {
  if (lastEncText) { download("qtc-contact-vault.enc.json", lastEncText); toast("Encrypted backup downloaded.", "ok"); }
});
$("iRun").addEventListener("click", function () {
  var msg = $("iMsg"), raw = $("iIn").value.trim();
  msg.className = "msg"; msg.textContent = "";
  if (!raw) { msg.className = "msg err"; msg.textContent = "Paste a backup first."; return; }
  var obj;
  try { obj = JSON.parse(raw); }
  catch (e) { msg.className = "msg err"; msg.textContent = "Not valid JSON: " + e.message; return; }
  function handlePlain(parsed) {
    var res = LOGIC.parseImportPayload(parsed);
    if (!res.ok) { msg.className = "msg err"; msg.textContent = res.errors.join(" "); return; }
    importContacts(res.contacts, res.errors, msg);
  }
  if (obj.app === LOGIC.ENC_APP) {
    var pw = $("iPass").value;
    if (!pw) { msg.className = "msg err"; msg.textContent = "This backup is encrypted — enter the password."; return; }
    msg.innerHTML = '<span class="spinner"></span>Decrypting…';
    LOGIC.decryptBackup(pw, obj).then(function (plain) {
      var parsed;
      try { parsed = JSON.parse(plain); }
      catch (e) { msg.className = "msg err"; msg.textContent = "Decrypted, but the inner JSON is corrupt."; return; }
      $("iPass").value = "";
      handlePlain(parsed);
    }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
  } else {
    handlePlain(obj);
  }
});
function importContacts(contacts, warnings, msg) {
  msg.innerHTML = '<span class="spinner"></span>Re-validating ' + contacts.length + " checkphrases…";
  var added = 0, skipped = 0, rejected = 0, i = 0;
  (function next() {
    if (i >= contacts.length) {
      saveVault(); renderVaultList();
      var parts = ["Import complete: <strong>" + added + "</strong> added",
        skipped + " duplicates skipped", rejected + " rejected"];
      if (warnings.length) parts.push(warnings.length + " row warnings");
      msg.className = "msg " + (rejected ? "err" : "ok");
      msg.innerHTML = parts.join(" · ") +
        (warnings.length ? '<div style="margin-top:6px;font-size:13px">' + esc(warnings.slice(0, 5).join(" ")) + "</div>" : "");
      toast("Imported " + added + " contacts.", added ? "ok" : "err");
      return;
    }
    var c = contacts[i++];
    if (findByAddress(c.address)) { skipped++; next(); return; }
    if (c.checkphrase) {
      derivePhrase(c.address).then(function (words) {
        if (JSON.stringify(words) === JSON.stringify(c.checkphrase)) {
          vault.push(finishImport(c, words)); added++;
        } else { rejected++; }
        next();
      });
    } else {
      derivePhrase(c.address).then(function (words) {
        vault.push(finishImport(c, words)); added++; next();
      });
    }
  })();
}
function finishImport(c, words) {
  return { id: uid(), label: c.label, address: c.address, note: c.note,
           trusted: c.trusted, addedAt: c.addedAt || new Date().toISOString(), checkphrase: words };
}
var wipeArmed = false;
$("wipeBtn").addEventListener("click", function () {
  var b = $("wipeBtn");
  if (!wipeArmed) {
    wipeArmed = true;
    b.textContent = "Click again to confirm — this cannot be undone";
    setTimeout(function () { wipeArmed = false; b.textContent = "Delete all contacts"; }, 4000);
    return;
  }
  wipeArmed = false;
  b.textContent = "Delete all contacts";
  vault = [];
  phraseCache.clear();
  saveVault(); renderVaultList();
  toast("Vault wiped.", "err");
});

/* ---------- footer copy buttons ---------- */
document.querySelectorAll("[data-copy]").forEach(function (btn) {
  btn.addEventListener("click", function () { copyText(btn.dataset.copy); });
});

/* ---------- init ---------- */
renderVaultList();
(function backfill() {
  // recompute any checkphrases missing from storage, quietly, in the background
  var missing = vault.filter(function (c) { return !c.checkphrase; });
  (function next(i) {
    if (i >= missing.length) return;
    derivePhrase(missing[i].address).then(function (w) {
      missing[i].checkphrase = w; saveVault(); next(i + 1);
    }).catch(function () { next(i + 1); });
  })(0);
})();
var startTab = (location.hash || "").replace("#", "");
if (["vault", "verify", "lab", "batch", "xfer", "scope"].indexOf(startTab) >= 0) showTab(startTab);

})();
