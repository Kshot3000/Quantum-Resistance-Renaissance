/* QTC Proposal Studio — app.js
 * UI wiring. Pure encoding lives in gov-codec.js (unit-tested);
 * crypto (blake2b-256, SS58) is the vendored, test-vector-verified
 * scale-crypto.js. This file never signs anything.
 */
(function () {
  "use strict";
  var C = window.QPS_CODEC, CR = window.QSL_CRYPTO;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };

  /* ---------------- toast + copy ---------------- */
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "qps-toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  function copyText(s, msg) {
    var done = function () { toast(msg || "Copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = s; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed — select manually"); }
      ta.remove();
    }
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (b) { copyText(b.getAttribute("data-copy"), "Address copied"); return; }
    var c = e.target.closest("[data-copytarget]");
    if (c) {
      var el = $(c.getAttribute("data-copytarget"));
      if (el) copyText(el.textContent.trim().replace(/^0x/, ""), "Hex copied");
    }
    var g = e.target.closest("[data-goto]");
    if (g) { e.preventDefault(); showTab(g.getAttribute("data-goto")); }
  });

  /* ---------------- tabs ---------------- */
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll(".tabs [data-tab]"));
  function showTab(name) {
    tabBtns.forEach(function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === name ? "true" : "false"); });
    ["tracks", "composer", "pack", "preimage", "vault", "sources"].forEach(function (n) {
      $("tab-" + n).classList.toggle("hidden", n !== name);
    });
    if (name === "pack") renderPack();
    if (name === "vault") renderVault();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  tabBtns.forEach(function (b) { b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); }); });

  /* ---------------- tracks tab ---------------- */
  function renderTracks() {
    $("track-cards").innerHTML = C.TRACKS.map(function (t) {
      var rows = [
        ["Proposal origin", t.originName + " <span class='dim'>(bytes " + t.originBytes + ")</span>"],
        ["Prepare period", t.prepare + " blocks (~" + C.blocksToClock(t.prepare) + ")"],
        ["Decision period", t.decision + " blocks (~" + C.blocksToClock(t.decision) + ")"],
        ["Confirm period", t.confirm + " blocks (~" + C.blocksToClock(t.confirm) + ")"],
        ["Min. enactment", t.minEnactment + " blocks (~" + C.blocksToClock(t.minEnactment) + ")"],
        ["Approval / support", "≥" + t.approval + "% / ≥" + t.support + "% (flat curves)"],
        ["Decision deposit", C.qtc(t.decisionDeposit) + " QTC"],
        ["Max deciding", t.maxDeciding + " at a time"]
      ].map(function (r) {
        return "<div class='tk'>" + r[0] + "</div><div class='tv'>" + r[1] + "</div>";
      }).join("");
      return "<div class='track-card" + (t.id === 1 ? " fast" : "") + "'>" +
        "<h3>" + esc(t.label) + "<span class='tid'>track " + t.id + " · " + esc(t.key) + "</span></h3>" +
        "<div class='origin'>origin bytes: 0x" + t.originBytes + "</div>" +
        "<p class='blurb'>" + esc(t.blurb) + "</p>" +
        "<div class='tgrid'>" + rows + "</div></div>";
    }).join("");
    $("lifecycle").innerHTML = C.lifecycle(1).map(function (s) {
      return "<div class='life-step'><div class='life-n'>" + s.n + "</div>" +
        "<div><h4>" + esc(s.title) + "</h4><p>" + s.detail + "</p></div></div>";
    }).join("");
  }

  /* ---------------- composer ---------------- */
  var cmp = { trackId: 1, template: "upgrade", callBytes: null, callName: "", hashHex: "" };

  function blake256(bytes) {
    return Array.from(CR.blake2b(new Uint8Array(bytes), 32));
  }
  function ss58ToPubkey(addr) {
    var d = CR.ss58Decode(String(addr).trim());
    if (!d.ok) return { ok: false, error: d.error };
    if (d.prefix !== 189) return { ok: false, error: "Prefix " + d.prefix + " — Quantus addresses use prefix 189." };
    if (d.key.length !== 32) return { ok: false, error: "Decoded key is " + d.key.length + " bytes, expected 32." };
    return { ok: true, key: d.key };
  }

  function renderCmpArgs() {
    var host = $("cmp-args"), tpl = cmp.template;
    if (tpl === "upgrade") {
      host.innerHTML =
        "<div class='field'><label for='cmp-hash'>Runtime code hash <span class='dim'>(blake2b-256, 64 hex chars)</span></label>" +
        "<input id='cmp-hash' class='mono' type='text' placeholder='78389c85…' maxlength='66'></div>" +
        "<div class='field'><label for='cmp-wasm'>…or hash a .wasm file directly</label>" +
        "<input id='cmp-wasm' type='file' accept='.wasm,application/wasm'></div>" +
        "<p class='fine'>The hash commits to the exact runtime blob. The wasm itself is submitted later via <code>apply_authorized_upgrade</code> (permissionless) and version-checked on-chain.</p>";
      $("cmp-wasm").addEventListener("change", function (e) {
        var f = e.target.files[0]; if (!f) return;
        var r = new FileReader();
        r.onload = function () {
          var bytes = Array.from(new Uint8Array(r.result));
          var hh = CR.toHex(blake256(bytes));
          $("cmp-hash").value = hh;
          toast("Hashed " + f.name + " (" + bytes.length + " bytes)");
          updateCmpPreview();
        };
        r.readAsArrayBuffer(f);
      });
      $("cmp-hash").addEventListener("input", updateCmpPreview);
    } else if (tpl === "remark") {
      host.innerHTML =
        "<div class='field'><label for='cmp-text'>Remark text <span class='dim'>(utf-8)</span></label>" +
        "<input id='cmp-text' type='text' placeholder='e.g. Proposal Studio test remark'></div>" +
        "<p class='fine'>A remark does nothing on-chain — the harmless way to exercise the full referendum pipeline.</p>";
      $("cmp-text").addEventListener("input", updateCmpPreview);
    } else if (tpl === "treasury") {
      host.innerHTML =
        "<div class='field'><label for='cmp-addr1'>Treasury account <span class='dim'>(SS58, prefix 189)</span></label>" +
        "<input id='cmp-addr1' class='mono' type='text' placeholder='qz…'></div>" +
        "<p class='fine'>Root-only. Redirects where <em>future</em> treasury credits go — existing balances are not migrated.</p>";
      $("cmp-addr1").addEventListener("input", updateCmpPreview);
    } else if (tpl === "member") {
      host.innerHTML =
        "<div class='field'><label for='cmp-addr2'>New member <span class='dim'>(SS58, prefix 189)</span></label>" +
        "<input id='cmp-addr2' class='mono' type='text' placeholder='qz…'></div>" +
        "<p class='fine'>Root-only. Add-then-remove keeps the collective within the 5–13 member bounds.</p>";
      $("cmp-addr2").addEventListener("input", updateCmpPreview);
    } else {
      host.innerHTML =
        "<div class='field'><label for='cmp-custom'>Raw call hex <span class='dim'>(pallet byte, call byte, args…)</span></label>" +
        "<textarea id='cmp-custom' class='mono' rows='3' placeholder='0x0009…'></textarea></div>" +
        "<p class='fine'>Validated against the studio's verified call table and the 4&nbsp;KiB cap. Unknown pallets are labeled, not rejected.</p>";
      $("cmp-custom").addEventListener("input", updateCmpPreview);
    }
  }

  function buildProposalFromForm() {
    var tpl = cmp.template, err = null, built = null;
    if (tpl === "upgrade") {
      var hb = C.hexToBytes(($("cmp-hash") || { value: "" }).value || "");
      if (!hb) err = "Enter a 64-character hex code hash (or hash a .wasm file above).";
      else if (hb.length !== 32) err = "Code hash must be exactly 32 bytes.";
      else built = C.tplAuthorizeUpgrade(hb);
    } else if (tpl === "remark") {
      var txt = ($("cmp-text") || { value: "" }).value || "";
      if (!txt) err = "Enter remark text.";
      else built = C.tplRemark(txt);
    } else if (tpl === "treasury" || tpl === "member") {
      var id = tpl === "treasury" ? "cmp-addr1" : "cmp-addr2";
      var pk = ss58ToPubkey(($(id) || { value: "" }).value || "");
      if (!pk.ok) err = pk.error || "Enter a valid address.";
      else built = tpl === "treasury" ? C.tplSetTreasuryAccount(pk.key) : C.tplAddMember(pk.key);
    } else {
      var hx = (($("cmp-custom") || { value: "" }).value || "").trim();
      if (!hx) err = "Paste call hex.";
      else {
        var insp = C.inspectCall(hx);
        if (!insp.ok) err = insp.error;
        else built = {
          hex: C.bytesToHex(insp.bytes), bytes: insp.bytes,
          name: insp.palletName + "." + insp.callName,
          sections: [
            { label: insp.palletName + " — pallet " + insp.palletIndex + ", call " + insp.callIndex, bytes: insp.bytes.slice(0, 2) },
            { label: "call arguments (" + (insp.bytes.length - 2) + " B)", bytes: insp.bytes.slice(2) }
          ]
        };
      }
    }
    return { err: err, built: built };
  }

  function byteMapHTML(sections) {
    return sections.map(function (s) {
      return "<div class='bm-row'><div class='bl'>" + esc(s.label) + "</div>" +
        "<div class='bv'>0x" + C.bytesToHex(s.bytes) + "</div></div>";
    }).join("");
  }

  function updateCmpPreview() {
    var host = $("cmp-preview");
    var r = buildProposalFromForm();
    if (r.err) {
      cmp.callBytes = null;
      host.innerHTML = "<p class='err'>" + esc(r.err) + "</p>";
      return;
    }
    var b = r.built;
    cmp.callBytes = b.bytes; cmp.callName = b.name;
    cmp.hashHex = CR.toHex(blake256(b.bytes));
    var dep = C.preimageDeposit(b.bytes.length);
    host.innerHTML =
      "<div class='kv'><div class='k'>call</div><div class='v'>" + esc(b.name) + " · " + b.bytes.length + " bytes</div>" +
      "<div class='k'>blake2b-256</div><div class='v'>0x" + cmp.hashHex + "</div>" +
      "<div class='k'>preimage deposit</div><div class='v'>" + C.qtc(dep) + " QTC (reserved)</div></div>" +
      "<div class='bytewrap'><div class='hexout'>0x" + b.hex + "</div></div>" +
      "<div class='bytemap'>" + byteMapHTML(b.sections) + "</div>";
  }

  function applyTrackLock() {
    var sel = $("cmp-template");
    if (cmp.trackId === 1) {
      // FastUpgrade origin is honored only by system.authorize_upgrade.
      Array.prototype.forEach.call(sel.options, function (o) { o.disabled = o.value !== "upgrade"; });
      sel.value = "upgrade"; cmp.template = "upgrade";
      $("cmp-track-note").innerHTML = "Locked: on the fast_upgrade track only <code>System.authorize_upgrade</code> can execute — the runtime rejects every other proposal origin pairing.";
    } else {
      Array.prototype.forEach.call(sel.options, function (o) { o.disabled = false; });
      $("cmp-track-note").innerHTML = "FastUpgrade origin is honored only by <code>system.authorize_upgrade</code> — the composer locks the template accordingly.";
    }
  }
  $("cmp-track").addEventListener("change", function (e) {
    cmp.trackId = parseInt(e.target.value, 10);
    applyTrackLock();
    renderCmpArgs(); updateCmpPreview();
  });
  $("cmp-template").addEventListener("change", function (e) {
    cmp.template = e.target.value;
    renderCmpArgs(); updateCmpPreview();
  });
  $("cmp-to-pack").addEventListener("click", function () {
    updateCmpPreview();
    if (!cmp.callBytes) { toast("Fix the proposal first"); return; }
    packState = {
      trackId: cmp.trackId, callBytes: cmp.callBytes,
      callName: cmp.callName, hashHex: cmp.hashHex,
      enactKind: "after", enactVal: 0, index: 1
    };
    showTab("pack");
    toast("Draft loaded into the Submission Pack");
  });
  $("cmp-copy").addEventListener("click", function () {
    if (!cmp.callBytes) { toast("Nothing to copy"); return; }
    copyText(C.bytesToHex(cmp.callBytes), "Call hex copied");
  });

  /* ---------------- submission pack ---------------- */
  var packState = null;

  function renderPack() {
    if (!packState) { $("pack-empty").classList.remove("hidden"); $("pack-body").classList.add("hidden"); }
    else {
      $("pack-empty").classList.add("hidden"); $("pack-body").classList.remove("hidden");
      renderPackSteps();
    }
    renderRef0();
  }

  function renderPackSteps() {
    var p = packState, t = C.TRACKS[p.trackId];
    // Step 1
    var s1 = C.buildNotePreimage(p.callBytes);
    $("pack-hex1").textContent = "0x" + s1.hex;
    $("pack-map1").innerHTML = byteMapHTML(s1.sections);
    $("pack-dep1").textContent = C.qtc(C.preimageDeposit(p.callBytes.length)) + " QTC reserved";
    // Step 2
    var kind = $("pack-enact-kind").value, val = Math.max(0, parseInt($("pack-enact-val").value || "0", 10));
    p.enactKind = kind; p.enactVal = val;
    var s2 = C.buildSubmit(p.trackId, C.hexToBytes(p.hashHex), p.callBytes.length, { kind: kind, value: val });
    $("pack-hex2").textContent = "0x" + s2.hex;
    $("pack-map2").innerHTML = byteMapHTML(s2.sections);
    $("pack-dep2").textContent = C.qtc(C.SUBMISSION_DEPOSIT) + " QTC reserved";
    var minB = t.minEnactment;
    $("pack-enact-note").innerHTML =
      "Track minimum: <strong>" + minB + " blocks (~" + C.blocksToClock(minB) + ")</strong>. " +
      (kind === "after"
        ? "The scheduler clamps your moment up to <em>now + min_enactment</em> — it never rejects. <code>After(0)</code> means “as soon as the track allows” (what referendum #0 used)."
        : "Must be a future block; the scheduler still enforces <em>now + min_enactment</em> as the earliest dispatch.");
    // Step 3
    var idx = Math.max(0, parseInt($("pack-index").value || "0", 10));
    p.index = idx;
    var s3 = C.buildPlaceDecisionDeposit(idx);
    $("pack-hex3").textContent = "0x" + s3.hex;
    $("pack-map3").innerHTML = byteMapHTML(s3.sections);
    $("pack-dep3").textContent = C.qtc(t.decisionDeposit) + " QTC reserved";
    // Costs
    var len1 = s1.hex.length / 2, len2 = s2.hex.length / 2, len3 = s3.hex.length / 2;
    var rows = [
      ["Preimage deposit", C.qtc(C.preimageDeposit(p.callBytes.length)) + " QTC", "reserved — reclaim via unnote_preimage"],
      ["Submission deposit", C.qtc(C.SUBMISSION_DEPOSIT) + " QTC", "reserved — refund_submission_deposit after conclusion"],
      ["Decision deposit", C.qtc(t.decisionDeposit) + " QTC", "reserved — refund_decision_deposit after conclusion"],
      ["Length fee · note_preimage (~" + len1 + " B)", "≈ " + C.qtc(BigInt(len1) * C.LENGTH_FEE_PER_BYTE) + " QTC", "per-byte component only"],
      ["Length fee · submit (~" + len2 + " B)", "≈ " + C.qtc(BigInt(len2) * C.LENGTH_FEE_PER_BYTE) + " QTC", "per-byte component only"],
      ["Length fee · place_decision_deposit (~" + len3 + " B)", "≈ " + C.qtc(BigInt(len3) * C.LENGTH_FEE_PER_BYTE) + " QTC", "per-byte component only"]
    ];
    $("pack-costs").innerHTML = "<table class='spec'><tr><th>Item</th><th>Amount</th><th>Note</th></tr>" +
      rows.map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td><td>" + r[2] + "</td></tr>"; }).join("") + "</table>";
  }
  ["pack-enact-kind", "pack-enact-val", "pack-index"].forEach(function (id) {
    $(id).addEventListener("input", function () { if (packState) renderPackSteps(); });
    $(id).addEventListener("change", function () { if (packState) renderPackSteps(); });
  });

  function showAux(builder, label) {
    if (!packState) { toast("Load a draft first"); return; }
    var r = builder(packState.index);
    $("pack-hex4").textContent = "0x" + r.hex;
    $("pack-hex4").classList.remove("dim");
    $("pack-map4").innerHTML = "<p class='fine'>" + esc(label) + "</p>" + byteMapHTML(r.sections);
  }
  $("vote-aye").addEventListener("click", function () {
    var poll = Math.max(0, parseInt($("vote-poll").value || "0", 10));
    var r = C.buildCollectiveVote(poll, true);
    $("pack-hex4").textContent = "0x" + r.hex; $("pack-hex4").classList.remove("dim");
    $("pack-map4").innerHTML = byteMapHTML(r.sections);
  });
  $("vote-nay").addEventListener("click", function () {
    var poll = Math.max(0, parseInt($("vote-poll").value || "0", 10));
    var r = C.buildCollectiveVote(poll, false);
    $("pack-hex4").textContent = "0x" + r.hex; $("pack-hex4").classList.remove("dim");
    $("pack-map4").innerHTML = byteMapHTML(r.sections);
  });
  $("refund-sub").addEventListener("click", function () { showAux(C.buildRefundSubmissionDeposit, "Callable by any signed account once the referendum has concluded."); });
  $("refund-dec").addEventListener("click", function () { showAux(C.buildRefundDecisionDeposit, "Callable by any signed account once the referendum is no longer in the deciding queue."); });
  $("unnote").addEventListener("click", function () {
    if (!packState) { toast("Load a draft first"); return; }
    showAux(function () { return C.buildUnnotePreimage(C.hexToBytes(packState.hashHex)); }, "Reclaims the preimage deposit. Safe once the referendum no longer needs the bytes (submit requests/pins them through enactment).");
  });

  function renderRef0() {
    var hex = C.REF0.submitHex;
    $("ref0-submit").textContent = "0x" + hex;
    var hashBytes = C.hexToBytes(C.REF0.preimageHash);
    var s2 = C.buildSubmit(1, hashBytes, 34, { kind: "after", value: 0 });
    var match = s2.hex === hex;
    $("ref0-map").innerHTML =
      "<p class='" + (match ? "okline" : "err") + "'>" +
      (match ? "✓ studio encoder reproduces these exact bytes" : "✗ MISMATCH — encoder diverged") + "</p>" +
      byteMapHTML(s2.sections);
  }

  /* ---------------- preimage desk ---------------- */
  var pdBytes = null;
  function pdRender() {
    var host = $("pd-out");
    if (!pdBytes || !pdBytes.length) { host.innerHTML = "<p class='fine'>Enter hex, text, or pick a file.</p>"; return; }
    if (pdBytes.length > 4096) {
      host.innerHTML = "<p class='err'>" + pdBytes.length + " bytes — over the 4 KiB proposal cap. The chain would reject this as a referendum preimage.</p>";
      return;
    }
    var hash = blake256(pdBytes), hashHex = CR.toHex(hash);
    var dep = C.preimageDeposit(pdBytes.length);
    var np = C.buildNotePreimage(pdBytes);
    var un = C.buildUnnotePreimage(hash);
    host.innerHTML =
      "<div class='kv'><div class='k'>size</div><div class='v'>" + pdBytes.length + " bytes</div>" +
      "<div class='k'>blake2b-256</div><div class='v'>0x" + hashHex + "</div>" +
      "<div class='k'>deposit</div><div class='v'>" + C.qtc(dep) + " QTC (reserved)</div></div>" +
      "<p class='fine'><strong>note_preimage</strong> — <button class='btn sm' id='pd-copy-note'>Copy</button></p>" +
      "<div class='hexout'>0x" + np.hex + "</div>" +
      "<p class='fine'><strong>unnote_preimage</strong> (reclaim) — <button class='btn sm' id='pd-copy-un'>Copy</button></p>" +
      "<div class='hexout'>0x" + un.hex + "</div>";
    $("pd-copy-note").addEventListener("click", function () { copyText(np.hex, "note_preimage hex copied"); });
    $("pd-copy-un").addEventListener("click", function () { copyText(un.hex, "unnote_preimage hex copied"); });
  }
  $("pd-hex").addEventListener("input", function (e) {
    var b = C.hexToBytes(e.target.value.trim());
    pdBytes = b; pdRender();
    if (e.target.value.trim() && !b) $("pd-out").innerHTML = "<p class='err'>Not valid hex.</p>";
  });
  $("pd-text").addEventListener("input", function (e) {
    var t = e.target.value;
    pdBytes = t ? C.utf8(t) : null; pdRender();
  });
  $("pd-file").addEventListener("change", function (e) {
    var f = e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { pdBytes = Array.from(new Uint8Array(r.result)); pdRender(); toast("Loaded " + f.name); };
    r.readAsArrayBuffer(f);
  });
  $("pd-clear").addEventListener("click", function () {
    pdBytes = null; $("pd-hex").value = ""; $("pd-text").value = ""; $("pd-file").value = ""; pdRender();
  });

  /* ---------------- draft vault ---------------- */
  var VKEY = "qps_drafts_v1";
  function loadDrafts() {
    try { return JSON.parse(localStorage.getItem(VKEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveDrafts(d) { localStorage.setItem(VKEY, JSON.stringify(d)); }
  $("dv-save").addEventListener("click", function () {
    if (!packState || !packState.callBytes) { $("dv-save-note").textContent = "Compose a proposal and send it to the Submission Pack first."; return; }
    var name = $("dv-name").value.trim() || ("Draft " + new Date().toLocaleString());
    var d = loadDrafts();
    d.unshift({
      id: "d" + Date.now(), name: name, notes: $("dv-notes").value.trim(),
      trackId: packState.trackId, callHex: C.bytesToHex(packState.callBytes),
      callName: packState.callName, hash: packState.hashHex,
      enactKind: packState.enactKind, enactVal: packState.enactVal,
      created: new Date().toISOString(), checks: [false, false, false, false, false]
    });
    saveDrafts(d);
    $("dv-name").value = ""; $("dv-notes").value = "";
    $("dv-save-note").textContent = "Saved “" + name + "”.";
    renderVault();
  });
  $("dv-export").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(loadDrafts(), null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "proposal-studio-drafts.json"; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });
  $("dv-import").addEventListener("change", function (e) {
    var f = e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var arr = JSON.parse(r.result);
        if (!Array.isArray(arr)) throw new Error("not an array");
        saveDrafts(arr.concat(loadDrafts()));
        renderVault(); toast("Imported " + arr.length + " draft(s)");
      } catch (err) { toast("Import failed: " + err.message); }
    };
    r.readAsText(f);
  });
  function renderVault() {
    var d = loadDrafts(), host = $("dv-list");
    if (!d.length) { host.innerHTML = "<p class='fine'>No drafts yet.</p>"; return; }
    host.innerHTML = d.map(function (x) {
      var steps = C.lifecycle(x.trackId).map(function (s, i) {
        var on = x.checks[i];
        return "<label class='" + (on ? "done" : "") + "'><input type='checkbox' data-did='" + x.id + "' data-step='" + i + "'" + (on ? " checked" : "") + "><span><strong>" + s.n + ". " + esc(s.title) + "</strong> — " + esc(s.detail.split(".")[0]) + ".</span></label>";
      }).join("");
      return "<div class='draft'><div class='draft-head'><h4>" + esc(x.name) + "</h4>" +
        "<span class='when'>" + esc(x.created.slice(0, 10)) + " · track " + x.trackId + "</span><span class='spacer'></span>" +
        "<button class='btn sm' data-load='" + x.id + "'>Load into pack</button>" +
        "<button class='btn sm' data-del='" + x.id + "'>Delete</button></div>" +
        (x.notes ? "<p class='fine'>" + esc(x.notes) + "</p>" : "") +
        "<div class='kv'><div class='k'>proposal</div><div class='v'>" + esc(x.callName) + "</div>" +
        "<div class='k'>call hex</div><div class='v'>0x" + esc(x.callHex.slice(0, 64)) + (x.callHex.length > 64 ? "…" : "") + "</div>" +
        "<div class='k'>preimage</div><div class='v'>0x" + esc(x.hash) + "</div></div>" +
        "<div class='checks'>" + steps + "</div></div>";
    }).join("");
    host.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        saveDrafts(loadDrafts().filter(function (x) { return x.id !== b.getAttribute("data-del"); }));
        renderVault();
      });
    });
    host.querySelectorAll("[data-load]").forEach(function (b) {
      b.addEventListener("click", function () {
        var x = loadDrafts().find(function (d0) { return d0.id === b.getAttribute("data-load"); });
        if (!x) return;
        packState = {
          trackId: x.trackId, callBytes: C.hexToBytes(x.callHex),
          callName: x.callName, hashHex: x.hash,
          enactKind: x.enactKind || "after", enactVal: x.enactVal || 0, index: 1
        };
        $("pack-enact-kind").value = packState.enactKind;
        $("pack-enact-val").value = packState.enactVal;
        showTab("pack");
      });
    });
    host.querySelectorAll("[data-did]").forEach(function (c) {
      c.addEventListener("change", function () {
        var all = loadDrafts();
        var x = all.find(function (d0) { return d0.id === c.getAttribute("data-did"); });
        if (x) { x.checks[parseInt(c.getAttribute("data-step"), 10)] = c.checked; saveDrafts(all); }
        c.closest("label").classList.toggle("done", c.checked);
      });
    });
  }

  /* ---------------- sources ---------------- */
  function renderSources() {
    var rows = [
      ["Track windows, 61/60 & 80/80 curves, decision deposits", "<code>runtime/src/governance/definitions.rs</code> — TechCollectiveTracksInfo"],
      ["Submission deposit 0.1 QTC · caps 128/8/100 · 45-day timeout · 4 KiB max", "<code>runtime/src/configs/mod.rs</code> — ReferendumSubmissionDeposit, MaxActive(PerAccount), ReferendumMaxProposals, UndecidingTimeout, MaxReferendaProposalSize"],
      ["Preimage fee: 0.01 + 0.00001×(size+1) QTC", "<code>definitions.rs</code> — preimage_amount, via <code>scale_fee</code>"],
      ["Fee scale 1/10 · UNIT = 10¹² plancks · 12 s blocks", "<code>runtime/src/lib.rs</code> — scale_fee, UNIT, TARGET_BLOCK_TIME_MS"],
      ["Submitter must be a signed collective member (no Root submit)", "<code>definitions.rs</code> — RootOrMemberForTechReferendaOrigin (#91248)"],
      ["Member floor 5 / ceiling 13", "<code>runtime/src/genesis_config_presets/mod.rs</code> + <code>configs/mod.rs</code>"],
      ["Origin bytes: Root = 0x0000 · FastUpgrade = 0x1700", "metadata-generated <code>quantus_sdk/lib/generated/bell/types/quantus_runtime/origin_caller.dart</code> (Quantus-Network/quantus-apps)"],
      ["Bounded::Lookup = 0x02 · DispatchTime At=0x00/After=0x01", "metadata-generated <code>…/frame_support/traits/preimages/bounded.dart</code> + <code>…/traits/schedule/dispatch_time.dart</code>"],
      ["Call indices: Preimage 7 · TechReferenda 14 · TechCollective 13 · System 0 · Treasury 15", "<code>pallets/*/src/lib.rs</code> #[pallet::call_index] + <code>runtime/src/lib.rs</code> pallet map"],
      ["FastUpgrade honored only by system.authorize_upgrade", "<code>pallets/frame-system/src/lib.rs</code> AuthorizeUpgradeOrigin + <code>definitions.rs</code> track docs"],
      ["Preimage must exist at submit · enactment clamps to now+min_enactment", "<code>pallets/referenda/src/lib.rs</code> — submit() V12 audit note, schedule check"],
      ["Slashed deposits burned · refunds callable by any signed account", "<code>configs/mod.rs</code> Slash=() · <code>pallets/referenda</code> refund_*"],
      ["Scheduler user calls disabled", "<code>runtime/src/lib.rs</code> — #[runtime::disable_call] on Scheduler"],
      ["Referendum #0 worked example (block 95,606)", "public indexer snapshot <code>data/governance.json</code> — real note_preimage bytes, preimage hash, submit args"],
      ["Length fee ≈100,000 plancks/byte", "runtime polynomial — see the <a href='../fee-throughput-lab/'>Fee &amp; Throughput Lab</a>"]
    ];
    $("sources-table").innerHTML = "<table class='spec'><tr><th>Fact</th><th>Source</th></tr>" +
      rows.map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("") + "</table>";
  }

  /* ---------------- init ---------------- */
  renderTracks();
  applyTrackLock();
  renderCmpArgs();
  updateCmpPreview();
  renderRef0();
  pdRender();
  renderSources();
})();
