/* QTC MultiSig Vault — UI. Core crypto lives in js/msig-core.js (MsigCore). */
(function(){
"use strict";
var C = window.MsigCore;
function $(id){ return document.getElementById(id); }
function toast(msg){
  var t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.classList.remove("show"); }, 2600);
}
function copyText(text, label){
  function done(){ toast((label || "Value") + " copied"); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, function(){ fallback(); });
  } else fallback();
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch(e){ toast("Copy failed — select manually"); }
    document.body.removeChild(ta);
  }
}
document.addEventListener("click", function(e){
  var c = e.target.closest("[data-copy]");
  if (c){ copyText(c.getAttribute("data-copy"), c.getAttribute("data-label") || "Value"); }
});
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ---------- 01 factory ---------- */
var signerState = { valid: [], invalid: [] };  // valid: [{addr, keyHex}]
function parseSigners(){
  var lines = $("signer-input").value.split(/\r?\n/).map(function(s){ return s.trim(); })
    .filter(function(s){ return s.length > 0; });
  var valid = [], invalid = [];
  lines.forEach(function(line, i){
    var d = C.ss58Decode(line);
    if (!d.ok){ invalid.push({ line: i + 1, addr: line, err: d.error }); return; }
    if (d.prefix !== C.SS58_PREFIX){
      invalid.push({ line: i + 1, addr: line, err: "Wrong prefix " + d.prefix + " — want 189 (Quantus mainnet)." });
      return;
    }
    if (d.key.length !== 32){
      invalid.push({ line: i + 1, addr: line, err: "Key is " + d.key.length + " bytes — want 32." });
      return;
    }
    valid.push({ addr: line, keyHex: C.toHex(d.key) });
  });
  signerState = { valid: valid, invalid: invalid };
  var hint = $("signer-hint");
  var dupes = valid.length - new Set(valid.map(function(v){ return v.keyHex; })).size;
  var msg = valid.length + " valid signer" + (valid.length === 1 ? "" : "s");
  if (invalid.length) msg += ' · <span class="bad">' + invalid.length + " invalid</span>";
  if (dupes) msg += ' · <span class="bad">' + dupes + " duplicate" + (dupes === 1 ? "" : "s") + "</span>";
  hint.innerHTML = '<span class="ok">' + msg + "</span>";
  var thr = $("threshold");
  thr.max = Math.max(2, valid.length);
  $("thr-max-label").textContent = valid.length + " — unanimous";
  if (Number(thr.value) > valid.length) thr.value = valid.length;
  $("threshold-val").textContent = thr.value;
  deriveVault();
}
function deriveVault(){
  var box = $("vault-result");
  var uniq = [];
  var seen = {};
  signerState.valid.forEach(function(v){
    if (!seen[v.keyHex]){ seen[v.keyHex] = 1; uniq.push(v.keyHex); }
  });
  var nonce = $("nonce").value.trim();
  if (uniq.length < 2){
    box.innerHTML = '<div class="empty-state">Add at least 2 valid, unique signer addresses.</div>';
    return;
  }
  var r = C.deriveMultisigAddress(uniq, Number($("threshold").value), nonce === "" ? "0" : nonce);
  if (!r.ok){
    box.innerHTML = '<div class="empty-state">' + esc(r.error) + "</div>";
    return;
  }
  var lb = C.lifecycleBudget(uniq.length);
  box.innerHTML =
    '<div class="fld-label">Vault address — deterministic, permanent</div>' +
    '<div class="vault-addr">' + esc(r.ss58) + "</div>" +
    '<dl class="kv">' +
    '<dt>Threshold</dt><dd>' + r.threshold + " of " + r.signerCount + "</dd>" +
    '<dt>Nonce</dt><dd>' + esc(r.nonce) + "</dd>" +
    '<dt>Account id (hex)</dt><dd>' + esc(r.hex) + "</dd>" +
    '<dt>Creation fee</dt><dd>' + C.plancksToQtc(lb.createFee) + " QTC (burned by the creator)</dd>" +
    "</dl>" +
    '<div class="fld-label">Signers, chain sort order (byte-wise)</div>' +
    '<ol class="sortlist">' + r.sortedHex.map(function(h){ return "<li>" + esc(h) + "</li>"; }).join("") + "</ol>" +
    '<details><summary class="fld-label" style="cursor:pointer">Derivation preimage (blake2b-256 input)</summary>' +
    '<div class="hexbox">py/mltsg ‖ SCALE(Vec&lt;AccountId32&gt;) ‖ u32 ' + r.threshold + " ‖ u64 " + esc(r.nonce) +
    "<br>" + esc(r.preimageHex) + "</div></details>" +
    '<div class="btnrow">' +
    '<button class="btn small" data-copy="' + esc(r.ss58) + '" data-label="Vault address">Copy address</button>' +
    '<button class="btn small" id="vault-to-builder">Use in call builder ↓</button>' +
    "</div>";
  $("vault-to-builder").addEventListener("click", function(){
    $("b-vault").value = r.ss58;
    $("b-vault-err").textContent = "";
    document.getElementById("builder").scrollIntoView({ behavior: "smooth" });
    toast("Vault address loaded into the call builder");
  });
}
$("signer-input").addEventListener("input", parseSigners);
$("threshold").addEventListener("input", function(){
  $("threshold-val").textContent = this.value;
  deriveVault();
});
$("nonce").addEventListener("input", deriveVault);

/* ---------- 02 cost engine ---------- */
function renderBudget(){
  var n = Math.max(2, Math.min(100, Number($("cost-n").value) || 3));
  var lb = C.lifecycleBudget(n);
  var fee = lb.proposalFee, burned = lb.createFee + fee;
  $("budget").innerHTML =
    '<div class="row"><span>Vault creation <span class="muted">(burned)</span></span><span class="pv">' + C.plancksToQtc(lb.createFee) + " QTC</span></div>" +
    '<div class="row"><span>One proposal fee <span class="muted">(burned)</span></span><span class="pv">' + C.plancksToQtc(fee) + " QTC</span></div>" +
    '<div class="row"><span>Proposal deposit <span class="muted">(reserved → refunded)</span></span><span class="pv">' + C.plancksToQtc(lb.proposalDeposit) + " QTC</span></div>" +
    '<div class="row total"><span>Total first-proposal outlay</span><span class="pv">' + C.plancksToQtc(lb.totalOutlay) + " QTC</span></div>" +
    '<div class="row"><span class="muted">of which burned</span><span class="pv">' + C.plancksToQtc(burned) + " QTC</span></div>";
}
$("cost-n").addEventListener("input", renderBudget);
renderBudget();

/* ---------- 03 call builder ---------- */
$("b-kind").addEventListener("change", function(){
  $("b-keepalive-wrap").style.display = this.value === "transfer_all" ? "" : "none";
});
$("b-keepalive-wrap").style.display = "none";
function decodeSignerField(el, errEl){
  var v = el.value.trim();
  errEl.textContent = "";
  if (!v){ errEl.textContent = "Required."; return null; }
  var d = C.ss58Decode(v);
  if (!d.ok){ errEl.textContent = d.error; return null; }
  if (d.prefix !== C.SS58_PREFIX){ errEl.textContent = "Prefix " + d.prefix + " — want 189."; return null; }
  if (d.key.length !== 32){ errEl.textContent = "Key must be 32 bytes."; return null; }
  return C.toHex(d.key);
}
function payloadCard(title, hex, meta, explain){
  return '<div class="payload"><h4>' + esc(title) +
    ' <button class="btn small" data-copy="' + esc(hex) + '" data-label="' + esc(title) + '">Copy hex</button></h4>' +
    '<div class="meta">' + esc(meta) + "</div>" +
    '<div class="hexbox">' + esc(hex) + "</div>" +
    (explain ? '<p class="explain">' + explain + "</p>" : "") + "</div>";
}
$("b-build").addEventListener("click", function(){
  var out = $("builder-out");
  var vaultHex = decodeSignerField($("b-vault"), $("b-vault-err"));
  var recipHex = decodeSignerField($("b-recipient"), $("b-recipient-err"));
  var amount = C.qtcToPlancks($("b-amount").value);
  var height = Number($("b-height").value);
  var window_ = Number($("b-window").value);
  var pid = Math.max(0, Number($("b-proposal").value) || 0);
  if (!vaultHex || !recipHex) { out.innerHTML = '<div class="empty-state">Fix the highlighted fields first.</div>'; return; }
  if (amount === null || amount <= 0n){
    out.innerHTML = '<div class="empty-state">Amount must be a positive QTC value (up to 12 decimals).</div>';
    return;
  }
  if (!(height >= 1)){
    out.innerHTML = '<div class="empty-state">Enter the current chain height — <code>propose</code> needs an expiry block.</div>';
    return;
  }
  if (window_ > C.MAX_EXPIRY_DURATION){
    out.innerHTML = '<div class="empty-state">Window exceeds the 100,800-block chain maximum.</div>';
    return;
  }
  var kind = $("b-kind").value;
  var inner = kind === "transfer_all"
    ? C.encodeTransferAll(recipHex, $("b-keepalive").checked)
    : C.encodeTransferKeepAlive(recipHex, amount);
  if (!inner.ok){ out.innerHTML = '<div class="empty-state">' + esc(inner.error) + "</div>"; return; }
  var expiry = C.expiryBlockNow(height, window_);
  var propose = C.encodePropose(vaultHex, inner.hex, expiry);
  var approve = C.encodeApprove(vaultHex, pid, inner.hex);
  var execute = C.encodeExecute(vaultHex, pid, inner.hex);
  var cancel = C.encodeCancel(vaultHex, pid);
  var remove = C.encodeRemoveExpired(vaultHex, pid);
  var claim = C.encodeClaimDeposits(vaultHex);
  var innerName = kind === "transfer_all" ? "Balances.transfer_all" : "Balances.transfer_keep_alive";
  var html = payloadCard("Inner call — " + innerName,
    inner.hex,
    "pallet 2 · call " + (kind === "transfer_all" ? "4" : "3") + " · MultiAddress::Id · " + (inner.hex.length / 2) + " bytes" +
      (kind === "transfer_all" ? "" : " · " + C.plancksToQtc(amount) + " QTC"),
    "The exact bytes the pallet stores and every approver must resubmit <b>byte-equal</b>.");
  html += payloadCard("1 · Multisig.propose", propose.hex,
    "pallet 19 · call 1 · expiry block " + expiry + " (~" + C.blocksToHuman(window_) + " from height " + height + ")",
    "Signed by a vault <b>signer</b>. Burns the proposal fee, reserves the 0.01 QTC deposit. Proposal id is assigned by the chain's proposal nonce — it increments per vault.");
  html += payloadCard("2 · Multisig.approve (proposal " + pid + ")", approve.hex,
    "pallet 19 · call 2 · signed by each approving signer",
    "Approvers resubmit the inner call — approval is only valid if it matches the stored payload <b>byte-for-byte</b>. At threshold, status flips to Approved.");
  html += payloadCard("6 · Multisig.execute (proposal " + pid + ")", execute.hex,
    "pallet 19 · call 6 · anyone may call once Approved and unexpired",
    "Dispatches the inner call <b>as the vault</b> and returns the deposit to the proposer.");
  html += payloadCard("3 · Multisig.cancel (proposal " + pid + ")", cancel.hex,
    "pallet 19 · call 3 · proposer only, while Active/Approved",
    "Refunds the deposit to the proposer. The burned fee is gone.");
  html += payloadCard("4 · Multisig.remove_expired + 5 · claim_deposits", remove.hex + "<br>" + claim.hex,
    "pallet 19 · calls 4 and 5 · cleanup after expiry",
    "Anyone can remove an <b>expired</b> proposal; the proposer reclaims deposits in bulk with <code>claim_deposits</code>.");
  out.innerHTML = html +
    '<p class="note">Unsigned SCALE payloads — sign with <code>quantus-cli</code> or your wallet, then broadcast. Verify the pallet index (19) and call indices against the runtime before mainnet use.</p>';
});

/* ---------- 04 proposal board (local only) ---------- */
var LS_KEY = "msig-board-v1";
function loadBoard(){
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch (e){ return []; }
}
function saveBoard(b){ localStorage.setItem(LS_KEY, JSON.stringify(b)); }
function callFingerprint(callHex){
  var bytes = C.fromHex(callHex);
  return C.toHex(C.blake2b(bytes, 32));
}
function renderBoard(){
  var list = $("board-list");
  var b = loadBoard();
  if (!b.length){
    list.innerHTML = '<div class="empty-board">No proposals logged yet. Proposals you submit on-chain can be tracked here by hand.</div>';
    return;
  }
  list.innerHTML = b.map(function(p, i){
    var pct = Math.min(100, Math.round(100 * p.approvals / Math.max(1, p.threshold)));
    return '<div class="proposal">' +
      '<div class="ph"><span class="pid">#' + p.id + " · " + esc(p.vault.slice(0, 18)) + "…</span>" +
      '<span class="status ' + p.status + '">' + p.status + "</span></div>" +
      '<div class="fph">vault ' + esc(p.vault) + "<br>call fingerprint blake2b-256: " + esc(callFingerprint(p.callHex)) + "<br>expiry block " + p.expiry + "</div>" +
      '<div class="appr"><span>' + p.approvals + "/" + p.threshold + " approvals</span>" +
      '<span class="bar"><span class="fill" style="width:' + pct + '%"></span></span></div>' +
      '<div class="btnrow">' +
      '<button class="btn small" data-bact="approve" data-i="' + i + '">+ approval</button>' +
      ['active','approved','executed','expired'].map(function(s){
        return '<button class="btn small' + (p.status === s ? " primary" : "") + '" data-bact="status" data-s="' + s + '" data-i="' + i + '">' + s + "</button>";
      }).join("") +
      '<button class="btn small" data-copy="' + esc(p.callHex) + '" data-label="Inner call">copy call</button>' +
      '<button class="btn small ghost" data-bact="del" data-i="' + i + '">remove</button>' +
      "</div></div>";
  }).join("");
}
$("board-list").addEventListener("click", function(e){
  var b = e.target.closest("[data-bact]");
  if (!b) return;
  var items = loadBoard();
  var i = Number(b.getAttribute("data-i"));
  var act = b.getAttribute("data-bact");
  if (act === "del") items.splice(i, 1);
  else if (act === "approve"){ items[i].approvals = Math.min(items[i].threshold, items[i].approvals + 1); }
  else if (act === "status") items[i].status = b.getAttribute("data-s");
  saveBoard(items); renderBoard();
});
$("board-add").addEventListener("click", function(){
  $("board-form").classList.remove("hidden");
  $("bp-vault").value = $("b-vault").value.trim();
});
$("board-clear").addEventListener("click", function(){
  if (loadBoard().length && confirm("Remove all logged proposals?")){ saveBoard([]); renderBoard(); }
});
$("bp-cancel").addEventListener("click", function(){
  $("board-form").classList.add("hidden");
  $("bp-err").textContent = "";
});
$("bp-save").addEventListener("click", function(){
  var err = $("bp-err");
  err.textContent = "";
  var v = $("bp-vault").value.trim();
  var d = C.ss58Decode(v);
  if (!d.ok || d.prefix !== C.SS58_PREFIX || d.key.length !== 32){ err.textContent = "Vault address is not a valid prefix-189 SS58 address."; return; }
  var callHex = $("bp-call").value.trim().replace(/^0x/i, "");
  if (!C.fromHex(callHex) || !callHex.length){ err.textContent = "Inner call must be hex."; return; }
  var expiry = Number($("bp-expiry").value);
  if (!(expiry >= 1)){ err.textContent = "Expiry block required."; return; }
  var items = loadBoard();
  items.push({
    vault: v, id: Number($("bp-id").value) || 0, callHex: callHex,
    expiry: expiry, threshold: Math.max(1, Number($("bp-thr").value) || 1),
    approvals: 1, status: "active"
  });
  saveBoard(items); renderBoard();
  $("board-form").classList.add("hidden");
  toast("Proposal logged (local only)");
});
renderBoard();
})();
