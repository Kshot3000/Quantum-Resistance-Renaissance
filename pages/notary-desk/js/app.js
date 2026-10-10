/* QTC Notary Desk — app.js (ES module)
 * Timestamp Studio + Verify Desk + live Remark Board.
 * Chain facts: see js/notary-codec.js header (all verified @ 482c5b9).
 * This desk never signs: it builds byte-exact unsigned calls and quotes exact
 * length fees. Signing happens in the user's wallet / Chain Console.
 */
import { blake2b } from "../../../assets/vendor/noble/hashes/blake2.js";
import { sha256 } from "../../../assets/vendor/noble/hashes/sha2.js";

const C = window.QNOT_CODEC;
const TWOX = window.QSL_TWOX;
const $ = (id) => document.getElementById(id);
const b2b256 = (bytes) => Array.from(blake2b(new Uint8Array(bytes), { dkLen: 32 }));
const b2b512 = (bytes) => Array.from(blake2b(new Uint8Array(bytes), { dkLen: 64 }));
const EVENTS_KEY = C.systemEventsKey((b) => TWOX.twox128bytes(b));

/* ---------------- tiny helpers ---------------- */
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function copyText(t, btn) {
  navigator.clipboard.writeText(t).then(() => {
    const old = btn.textContent; btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = old; }, 1400);
  }).catch(() => { btn.textContent = "Copy failed"; });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText($(b.getAttribute("data-copy")).textContent, b);
});
function shortAddr(a) { return a.length > 20 ? a.slice(0, 10) + "…" + a.slice(-8) : a; }

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    document.querySelectorAll(".panel").forEach((p) => { p.hidden = true; p.classList.remove("active"); });
    const p = $("tab-" + tab.dataset.tab);
    p.hidden = false; p.classList.add("active");
  });
});
function segWire(id, cb) {
  const seg = $(id);
  seg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      seg.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-checked", b === btn ? "true" : "false");
      });
      cb(btn);
    });
  });
}

/* ---------------- streaming file hashing ---------------- */
async function hashFile(file, onProgress) {
  const CHUNK = 1024 * 1024;
  const s256 = sha256.create();
  const b2 = blake2b.create({ dkLen: 32 });
  let done = 0;
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    s256.update(buf); b2.update(buf);
    done += buf.length;
    if (onProgress) onProgress(done / file.size);
  }
  return {
    sha256: C.bytesToHex(Array.from(s256.digest())),
    blake2: C.bytesToHex(Array.from(b2.digest())),
    size: file.size, name: file.name
  };
}

/* ---------------- Timestamp Studio ---------------- */
const studio = { mode: "document", withEvent: true, fileHash: null };

segWire("modeSeg", (btn) => {
  studio.mode = btn.dataset.mode;
  $("docInputs").hidden = studio.mode !== "document";
  $("msgInputs").hidden = studio.mode !== "message";
});
segWire("eventSeg", (btn) => { studio.withEvent = btn.dataset.ev === "1"; });

function wireDrop(dropId, inputId, onFile) {
  const drop = $(dropId), input = $(inputId);
  drop.addEventListener("click", (e) => { if (e.target.id !== "browseLink") input.click(); });
  $("browseLink") && dropId === "drop" && $("browseLink").addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); });
}

/* A drop's hash lands asynchronously (streaming chunks), so two drops in
 * flight can land out of order. Without a token, the SUPERSEDED file's late
 * completion overwrote studio.fileHash, the digest field and the drop label
 * with its digests — the build then anchored the file the user had already
 * replaced, credited to the wrong name — and its late failure overwrote the
 * current file's success label with "Hashing failed". A sequence token lets
 * only the latest drop store, render, or report; a superseded success or
 * failure discards itself silently. */
let studioHashSeq = 0;
wireDrop("drop", "fileInput", async (file) => {
  const mySeq = ++studioHashSeq;
  const drop = $("drop");
  drop.querySelector(".drop-ico").textContent = "⏳";
  try {
    const h = await hashFile(file, (p) => {
      if (mySeq !== studioHashSeq) return;
      drop.querySelector("strong").textContent = "Hashing… " + Math.round(p * 100) + "%";
    });
    if (mySeq !== studioHashSeq) return;
    studio.fileHash = h;
    $("digestInput").value = h.sha256;
    $("algoSel").value = "1";
    drop.querySelector("strong").textContent = "✓ " + file.name;
    drop.querySelector(".hint").textContent =
      file.size.toLocaleString("en-US") + " bytes · SHA-256 " + h.sha256.slice(0, 16) + "… · BLAKE2b-256 " +
      h.blake2.slice(0, 16) + "… (digests filled below — pick the algorithm, then build)";
  } catch (err) {
    if (mySeq !== studioHashSeq) return;
    drop.querySelector("strong").textContent = "Hashing failed — try again";
  }
  if (mySeq === studioHashSeq) drop.querySelector(".drop-ico").textContent = "📥";
});

/* The dropped file's two digests must stay bound to the algorithm selector:
 * switching algorithms swaps in the digest that was actually computed with
 * that algorithm (hashFile always computes both). Building an envelope whose
 * algo byte names BLAKE2b-256 while the bytes are the file's SHA-256 digest
 * would anchor a permanently unverifiable proof. A manual digest edit that
 * matches neither of the file's digests voids the file attribution, so the
 * build output never credits a pasted digest to the dropped file. */
$("algoSel").addEventListener("change", () => {
  if (!studio.fileHash) return;
  const cur = $("digestInput").value.trim().toLowerCase();
  if (cur === studio.fileHash.sha256 || cur === studio.fileHash.blake2) {
    $("digestInput").value = parseInt($("algoSel").value, 10) === 2
      ? studio.fileHash.blake2 : studio.fileHash.sha256;
  }
});
$("digestInput").addEventListener("input", () => {
  if (!studio.fileHash) return;
  const cur = $("digestInput").value.trim().toLowerCase();
  if (cur === studio.fileHash.sha256) $("algoSel").value = "1";
  else if (cur === studio.fileHash.blake2) $("algoSel").value = "2";
  else studio.fileHash = null;
});

$("msgInput").addEventListener("input", () => {
  const n = new TextEncoder().encode($("msgInput").value).length;
  $("msgBytes").textContent = n.toLocaleString("en-US") + " / 4096 bytes";
  $("msgBytes").style.color = n > C.MAX_MESSAGE_BYTES ? "var(--red)" : "";
});

function anatomyRows(rows) {
  const box = $("oAnatomy"); box.innerHTML = "";
  rows.forEach(([k, v]) => box.appendChild(el("div", "arow",
    `<div class="k">${k}</div><div class="v">${v}</div>`)));
}

let lastBuild = null;

$("buildBtn").addEventListener("click", () => {
  $("stampEmpty").hidden = true; $("stampOut").hidden = false;
  /* A failed build must never leave a previous build saveable: clear the
   * pending anchor up front, so Save can only ever persist the build the
   * user is actually looking at. */
  lastBuild = null;
  let remarkBytes, digestHex, algoId, label, envelopeHex = null, parsed = null;

  if (studio.mode === "document") {
    const d = $("digestInput").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(d)) {
      $("oDigest").textContent = "⚠ Paste a 64-character hex digest (or drop a file to hash it).";
      return;
    }
    digestHex = d; algoId = parseInt($("algoSel").value, 10);
    label = $("labelInput").value;
    const env = C.buildEnvelope(algoId, C.hexToBytes(digestHex), label);
    if (!env.ok) { $("oDigest").textContent = "⚠ " + env.error; return; }
    remarkBytes = env.bytes; envelopeHex = env.hex;
    parsed = C.parseRemark(remarkBytes);
  } else {
    const msgBytes = Array.from(new TextEncoder().encode($("msgInput").value));
    if (msgBytes.length === 0 || msgBytes.length > C.MAX_MESSAGE_BYTES) {
      $("oDigest").textContent = "⚠ Message must be 1–4096 bytes.";
      return;
    }
    remarkBytes = msgBytes; digestHex = null; algoId = null; label = null;
    parsed = C.parseRemark(remarkBytes);
  }

  const call = C.buildRemarkCall(remarkBytes, studio.withEvent);
  const sigScheme = $("sigSel").value;
  /* The nonce is parsed STRICTLY: parseInt silently truncated "2.5" to 2
   * (a fee quote for a nonce the user never typed) and the codec's
   * compact encoder wrapped a nonce past the u32 range back to small
   * values. Anything but a plain u32 digit string is a build error. */
  const nonceRaw = $("nonceInput").value.trim();
  let nonce = 0;
  if (nonceRaw !== "") {
    if (!/^\d+$/.test(nonceRaw) || Number(nonceRaw) > 1073741823) {
      $("oDigest").textContent = "⚠ Nonce must be a whole number between 0 and 1073741823 (the largest nonce the compact encoder can represent) — fix it and build again.";
      return;
    }
    nonce = Number(nonceRaw);
  }
  const est = C.signedLengthEstimate(call.callLen, sigScheme, nonce);
  if (!est.ok) { $("oDigest").textContent = "⚠ " + (est.error || "could not estimate the signed length"); return; }
  const callFee = BigInt(call.callLen) * C.LENGTH_FEE_PER_BYTE;

  lastBuild = {
    id: "n" + Date.now(), created: new Date().toISOString(),
    mode: studio.mode, algo: algoId ? C.ALGOS[algoId] : null, digestHex,
    label: label || null, envelopeHex, callHex: call.callHex,
    withEvent: studio.withEvent, feeQTC: est.feeQTC, block: null
  };

  $("oDigest").textContent = digestHex
    ? `${C.ALGOS[algoId]}: ${digestHex}` + (studio.fileHash ? `  (${studio.fileHash.name}, ${studio.fileHash.size.toLocaleString("en-US")} bytes)` : "")
    : "(message mode — no document digest)";
  $("oEnvelope").textContent = envelopeHex || "(raw message — no envelope)";
  $("oCall").textContent = "0x" + call.callHex;

  const rows = [
    ["pallet", `00 — System (pallet 0)`],
    ["call", (studio.withEvent ? "07 — remark_with_event (call 7)" : "00 — remark (call 0)")],
    ["compact length", `${C.bytesToHex(C.compactU32(remarkBytes.length))} — ${remarkBytes.length} bytes of remark payload`],
  ];
  if (parsed.kind === "envelope") {
    rows.push(
      ["magic", "51 4E 4F 54 2F 31 — ASCII “QNOT/1”"],
      ["algo", "0" + algoId + " — " + C.ALGOS[algoId]],
      ["digest", digestHex],
      ["label", `compact(${C.utf8ToBytes(label || "").length}) + “${label || "∅"}”`],
    );
  } else {
    rows.push(["payload", `${remarkBytes.length} bytes of UTF-8 message (stored verbatim)`]);
  }
  anatomyRows(rows);

  const fees = $("oFees"); fees.innerHTML = "";
  const feeRows = [
    ["Remark payload", `${remarkBytes.length.toLocaleString("en-US")} bytes`],
    ["Unsigned call (00 07 + len + payload)", `${call.callLen.toLocaleString("en-US")} bytes`],
    ["Length fee on call bytes (floor)", `${callFee.toLocaleString("en-US")} plancks`],
    [`Signed extrinsic ≈ ${est.totalBytes.toLocaleString("en-US")} bytes (${est.scheme}, nonce ${nonce})`, `${est.feePlancks.toLocaleString("en-US")} plancks`],
  ];
  feeRows.forEach(([k, v]) => fees.appendChild(el("tr", "", `<td>${k}</td><td>${v}</td>`)));
  fees.appendChild(el("tr", "total", `<td>Length-fee quote</td><td>${est.feeQTC} QTC</td>`));
  fees.appendChild(el("tr", "", `<td colspan="2" style="text-align:left;color:var(--faint);font-size:12px">Exact length fee @ 100,000 plancks/byte. Weight fee (~0.1 planck/ps ref_time) is benchmark-dependent and not included. Keep ≥ 0.001 QTC existential deposit.</td>`));
});

/* ---------------- vault ---------------- */
const VKEY = "qnot_vault_v1";
/* localStorage is an untrusted boundary: a hand-edited, corrupted, or
 * older-format vault must never brick this desk or mint a verify result.
 * Every load routes through the codec's sanitizeVault — valid anchors
 * survive verbatim, poisoned entries drop, and renderers/verify only
 * ever see fields that have already checked out. */
function loadVault() {
  try { return C.sanitizeVault(JSON.parse(localStorage.getItem(VKEY) || "[]")); }
  catch { return []; }
}
function saveVault(v) { localStorage.setItem(VKEY, JSON.stringify(v)); }

$("saveVaultBtn").addEventListener("click", () => {
  if (!lastBuild) return;
  const v = loadVault();
  v.unshift(lastBuild);
  saveVault(v); renderVault();
  $("saveVaultBtn").textContent = "✓ Saved to vault";
  setTimeout(() => { $("saveVaultBtn").textContent = "💾 Save anchor to my vault"; }, 1600);
});
$("vaultClear").addEventListener("click", () => {
  if (confirm("Delete all saved anchors from this browser?")) { saveVault([]); renderVault(); }
});

function renderVault() {
  const box = $("vaultList"); box.innerHTML = "";
  const v = loadVault();
  if (!v.length) { box.appendChild(el("div", "empty", "No anchors saved yet.")); return; }
  v.forEach((a, idx) => {
    const d = el("div", "vitem");
    const head = el("div", "vh",
      `<strong>${a.mode === "document" ? "📄" : "💬"} ${a.label ? escapeHtml(a.label) : (a.mode === "document" ? "Document anchor" : "Message anchor")}</strong><time>${new Date(a.created).toLocaleString()}</time>`);
    d.appendChild(head);
    if (a.digestHex) { const c1 = el("code"); c1.textContent = a.algo + ": " + a.digestHex; d.appendChild(c1); }
    const c2 = el("code"); c2.textContent = "call: 0x" + a.callHex.slice(0, 60) + "…"; d.appendChild(c2);
    const meta = el("div", "vmeta");
    meta.innerHTML = `${a.withEvent ? "📯 remark_with_event" : "📝 remark"} · fee ≈ ${escapeHtml(a.feeQTC)} QTC · `;
    const blk = el("input", "blk"); blk.placeholder = "block #"; blk.value = a.block || "";
    blk.title = "Fill in the block number once your extrinsic lands";
    blk.addEventListener("change", () => {
      /* A block annotation is a plain block number or nothing — free
       * text stored here would be re-rendered as the anchor's landing
       * block, a chain fact the user never proved. */
      const t = blk.value.trim();
      const vv = loadVault(); if (!vv[idx]) return;
      vv[idx].block = /^\d+$/.test(t) ? t : null;
      if (t && !vv[idx].block) blk.value = "";
      saveVault(vv);
    });
    meta.appendChild(document.createTextNode("landed in block "));
    meta.appendChild(blk);
    const del = el("button", "btn tiny danger", "Delete");
    del.style.marginLeft = "8px";
    del.addEventListener("click", () => { const vv = loadVault(); vv.splice(idx, 1); saveVault(vv); renderVault(); });
    meta.appendChild(del);
    d.appendChild(meta);
    box.appendChild(d);
  });
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------------- Verify Desk ---------------- */
/* Verify-by-file must try BOTH of the file's digests: a vault anchor built
 * as BLAKE2b-256 stores that digest, so filling only the SHA-256 into the
 * box (the old behaviour) reported a matching file as "not in your vault".
 * A manual edit that matches neither digest voids the file pairing. */
let verifyFileHash = null;
/* Same superseded-drop discipline as the Timestamp Studio (see
 * studioHashSeq): only the latest Verify Desk drop may store its hash,
 * fill the digest field, or render its label/error. A superseded file's
 * late digests would otherwise be checked against the vault as if they
 * were the file the user last dropped, and its late failure would
 * overwrite the current file's success label. */
let verifyHashSeq = 0;
wireDrop("vDrop", "vFileInput", async (file) => {
  const mySeq = ++verifyHashSeq;
  const drop = $("vDrop");
  drop.querySelector(".drop-ico").textContent = "⏳";
  try {
    const h = await hashFile(file, null);
    if (mySeq !== verifyHashSeq) return;
    verifyFileHash = h;
    $("vDigestInput").value = h.sha256;
    drop.querySelector("strong").textContent = "✓ " + file.name + " — digest filled below";
  } catch {
    if (mySeq !== verifyHashSeq) return;
    drop.querySelector("strong").textContent = "Hashing failed — try again";
  }
  if (mySeq === verifyHashSeq) drop.querySelector(".drop-ico").textContent = "🔍";
});
$("vDigestInput").addEventListener("input", () => {
  if (!verifyFileHash) return;
  const cur = $("vDigestInput").value.trim().toLowerCase();
  if (cur !== verifyFileHash.sha256 && cur !== verifyFileHash.blake2) verifyFileHash = null;
});

$("vCheckBtn").addEventListener("click", () => {
  const d = $("vDigestInput").value.trim().toLowerCase();
  const box = $("vResult"); box.hidden = false;
  if (!/^[0-9a-f]{64}$/.test(d)) {
    box.className = "vresult miss";
    box.innerHTML = "<strong>⚠ Not a digest</strong>Paste a 64-character hex digest, or drop the file above to hash it.";
    return;
  }
  const candidates = verifyFileHash ? [d, verifyFileHash.sha256, verifyFileHash.blake2] : [d];
  const hit = loadVault().find((a) => candidates.includes(a.digestHex));
  if (hit) {
    /* The envelope reached the vault only by parsing back to this very
     * digest/algo/label at load (sanitizeVault); still, never hash a
     * null decode — a failed decode is no fingerprint, not the hash of
     * the empty input presented as one. */
    let fp = null;
    if (hit.envelopeHex) { const eb = C.hexToBytes(hit.envelopeHex); if (eb) fp = C.bytesToHex(b2b256(eb)); }
    box.className = "vresult hit";
    box.innerHTML = "<strong>✓ Anchored in your vault</strong>" +
      `<div>${hit.label ? "“" + escapeHtml(hit.label) + "” · " : ""}${hit.algo} · built ${new Date(hit.created).toLocaleString()}</div>` +
      (fp ? `<div style="margin-top:8px">Expected <code>System.Remarked</code> event hash (Blake2-256 of the envelope):<br><code>${fp}</code></div>
             <div class="hint" style="margin-top:6px">With <code>remark_with_event</code>, find this hash on the Remark Board or in any block explorer reading <code>System.Events</code> — the block number is the timestamp.${hit.block ? ` Your vault says block <strong>${escapeHtml(hit.block)}</strong>.` : ""}</div>`
          : `<div class="hint" style="margin-top:6px">Message-mode anchor — no envelope, so verify by matching the raw message bytes on-chain.</div>`);
  } else {
    box.className = "vresult miss";
    box.innerHTML = "<strong>◌ Not in your vault</strong>" +
      `<div class="hint">No anchor built in this browser matches <code>${d.slice(0, 24)}…</code>. ` +
      `It may have been anchored from another device — check the Remark Board's history scan, or verify the digest against the sender's own records.</div>`;
  }
});

/* ---------------- Remark Board (live) ---------------- */
const board = {
  ws: null, id: 0, pending: new Map(), watching: false,
  seen: new Set(), scanning: false
};
/* A history scan awaits many RPCs in sequence, so it can land long
 * after the connection it started on is gone. Without a token, a
 * superseded scan's late landing rendered unconditionally: its error
 * path claimed "still watching new heads" (live dot) over the
 * disconnect's own status, its tail re-enabled the Scan button the
 * disconnect had disabled, and — after a reconnect — the dead scan
 * kept issuing block/storage RPCs on the replacement socket and
 * wedged `scanning` so the new connection could never scan. A
 * sequence token pinned to the starting socket lets only the latest
 * scan on the still-current socket render, error, or clean up; a
 * superseded success or failure discards itself silently, and the
 * disconnect path (fail) invalidates the token, resets `scanning`
 * and hides progress so a reconnect starts clean. */
let boardScanSeq = 0;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!board.ws || board.ws.readyState !== 1) return reject(new Error("not connected"));
    const id = ++board.id;
    board.pending.set(id, { resolve, reject });
    try {
      board.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || [] }));
    } catch (e) { board.pending.delete(id); return reject(e); }
    setTimeout(() => {
      if (board.pending.has(id)) { board.pending.delete(id); reject(new Error("rpc timeout: " + method)); }
    }, 15000);
  });
}
function setStatus(mode, text) {
  $("connDot").className = "dot" + (mode ? " " + mode : "");
  $("connStatus").textContent = text;
}

// Parse one signed/unsigned extrinsic; return {pallet, call, payload} for
// System.remark-shaped calls, else null. Defensive: any anomaly -> null.
function spotRemarkCall(extHex) {
  try {
    const b = C.hexToBytes(extHex);
    if (!b || b.length < 4) return null;
    let o = 0;
    const lc = C.readCompact(b, o); if (!lc) return null; o = lc.next;
    const version = b[o++];
    if (version === 0x84) {
      // signed: MultiAddress::Id
      if (b[o++] !== 0x00) return null; o += 32;
      const variant = b[o++];
      const spec = variant === 0x00 ? { sig: 4627, pub: 2592 } : variant === 0x01 ? { sig: 3309, pub: 1952 } : null;
      if (!spec) return null; o += spec.sig + spec.pub;
      // era: 0x00 immortal (1B) else mortal (2B)
      o += (b[o] === 0x00) ? 1 : 2;
      const nonce = C.readCompact(b, o); if (!nonce) return null; o = nonce.next;
      const tip = C.readCompact(b, o); if (!tip) return null; o = tip.next;
    } else if (version !== 0x04) {
      return null; // not a plain signed/unsigned extrinsic
    }
    if (o + 2 > b.length) return null;
    const pallet = b[o], callIdx = b[o + 1];
    if (pallet !== 0 || (callIdx !== 0 && callIdx !== 7)) return null;
    const pl = C.readCompact(b, o + 2); if (!pl) return null;
    if (pl.next + pl.value > b.length) return null;
    return { pallet, call: callIdx, payload: b.slice(pl.next, pl.next + pl.value) };
  } catch { return null; }
}

function renderRemarked(blockNum, senderHex, eventHash, payloadInfo, seenAt) {
  const key = blockNum + ":" + eventHash;
  if (board.seen.has(key)) return;
  const senderBytes = C.hexToBytes(senderHex);
  const sender = senderBytes ? C.ss58Encode32(senderBytes, b2b512) : null;
  if (!sender) return; // an unencodable sender is not a board row
  board.seen.add(key);
  const empty = document.querySelector("#boardList .empty");
  if (empty) empty.remove();
  const item = el("div", "bitem" + (payloadInfo && payloadInfo.parsed.kind === "raw" ? " raw" : ""));
  let body = "";
  if (payloadInfo) {
    const p = payloadInfo.parsed;
    if (p.kind === "envelope") {
      body = `<div class="doc-label">📄 ${p.label ? escapeHtml(p.label) : "Untitled document"}</div>
              <div class="digest">${p.algo}: ${p.digestHex}</div>`;
    } else if (p.kind === "message") {
      body = `<div class="msg">${escapeHtml(p.text)}</div>`;
    } else {
      body = `<div class="digest">raw bytes: ${p.hex.slice(0, 200)}${p.hex.length > 200 ? "…" : ""}</div>`;
    }
  } else {
    body = `<div class="hint">Payload not recovered from this block's extrinsics (event seen, bytes not matched).</div>`;
  }
  item.innerHTML =
    `<div class="bhead"><span class="blk">#${blockNum.toLocaleString("en-US")}</span>
      <span class="sender" title="${sender}">${shortAddr(sender)}</span>
      <span>· observed ${seenAt}</span></div>
     <div class="bbody">${body}</div>
     <div class="bfoot">System.Remarked hash: ${eventHash}</div>`;
  const list = $("boardList");
  list.prepend(item);
  while (list.children.length > 120) list.lastChild.remove();
}

/* The node is an untrusted boundary: every answer is validated BEFORE
 * it anchors a board row or a scan verdict. A malformed block hash,
 * block, header number, events blob, or extrinsics list is an honest
 * error (the scan reports it; the live watch drops that one block) —
 * never a "#NaN" row, never a silently-swallowed blob behind a
 * "scan complete" claim, and never a fake empty block. A null storage
 * answer is legitimate (no System.Events value at that hash). */
async function processBlock(blockHash) {
  if (!C.isHash32(blockHash)) throw new Error("node returned a malformed block hash");
  const [blockRes, evRes] = await Promise.all([
    rpc("chain_getBlock", [blockHash]),
    rpc("state_getStorage", [EVENTS_KEY, blockHash])
  ]);
  if (!blockRes || typeof blockRes !== "object" || !blockRes.block ||
      typeof blockRes.block !== "object" || !blockRes.block.header ||
      typeof blockRes.block.header !== "object")
    throw new Error("node returned a malformed block");
  const blockNum = C.parseBlockNumber(blockRes.block.header.number);
  if (blockNum === null) throw new Error("node returned a malformed block number");
  if (evRes === null || evRes === undefined) return;
  if (typeof evRes !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(evRes))
    throw new Error("node returned malformed System.Events data");
  const evBytes = C.hexToBytes(evRes);
  if (!evBytes) throw new Error("node returned malformed System.Events data");
  const dec = C.decodeSystemEvents(evBytes);
  if (!dec.ok) throw new Error("node returned malformed System.Events data (" + (dec.error || "decode failed") + ")");
  if (!dec.records.length) return;
  if (!Array.isArray(blockRes.block.extrinsics))
    throw new Error("node returned a malformed block (extrinsics is not a list)");
  const exts = blockRes.block.extrinsics;
  const seenAt = new Date().toLocaleTimeString();
  for (const r of dec.records) {
    if (r.skipped) continue;
    let payloadInfo = null;
    for (const ex of exts) {
      if (typeof ex !== "string") continue;
      const spot = spotRemarkCall(ex);
      if (!spot) continue;
      const h = C.bytesToHex(b2b256(spot.payload));
      if (h === r.hashHex) {
        payloadInfo = { parsed: C.parseRemark(spot.payload), call: spot.call };
        break;
      }
    }
    renderRemarked(blockNum, r.senderHex, r.hashHex, payloadInfo, seenAt);
  }
}

$("connBtn").addEventListener("click", () => {
  if (board.ws && board.ws.readyState === 1) {
    board.ws.close(); return;
  }
  const url = $("rpcUrl").value.trim();
  setStatus("scan", "Connecting to " + url + " …");
  let ws;
  try { ws = new WebSocket(url); } catch (e) {
    setStatus("", "Could not open that URL (" + e.message + "). Check the address and try again.");
    return;
  }
  board.ws = ws;
  ws.onopen = async () => {
    board.watching = true;
    $("connBtn").textContent = "Disconnect";
    $("backBtn").disabled = false;
    setStatus("live", "Live — watching new heads. Remarks appear as their blocks arrive.");
    try {
      const subId = await rpc("chain_subscribeNewHeads", []);
      if (!C.validSubscriptionId(subId))
        throw new Error("node returned a malformed subscription id");
      board.headSub = subId;
    } catch (e) {
      /* A rejected/malformed subscription must not leave the "Live —
       * watching" claim standing: nothing is being watched. Reset via
       * fail(), then replace its generic text with the specific cause. */
      try { ws.close(); } catch { /* already closed */ }
      fail();
      setStatus("", "Connected, but the new-heads subscription failed (" + e.message + ") — not watching new heads.");
    }
  };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    /* A raw "null" / array / scalar frame is junk, not a response: the
     * old handler dereferenced msg.id and threw on every such frame. */
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.id && board.pending.has(msg.id)) {
      const p = board.pending.get(msg.id); board.pending.delete(msg.id);
      if (msg.error) p.reject(new Error((msg.error && msg.error.message) || "rpc error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "chain_newHead" && msg.params && msg.params.result) {
      const h = msg.params.result;
      if (!h || typeof h !== "object") return;
      const hn = C.parseBlockNumber(h.number);
      if (hn === null) return; // a garbage head number anchors nothing
      try {
        // the subscription yields a header (no hash): resolve it to a block hash
        const hash = await rpc("chain_getBlockHash", [hn]);
        if (!C.isHash32(hash)) return;
        await processBlock(hash);
      } catch (e) { /* one bad block never kills the watch */ }
    }
  };
  const fail = () => {
    board.watching = false; board.ws = null;
    /* Invalidate any in-flight history scan (see boardScanSeq): its
     * late landing must not render, error, or clean up over this
     * disconnect state, and the scan UI resets here because the
     * superseded scan's own tail will (correctly) never run. */
    boardScanSeq++;
    board.scanning = false;
    $("scanProg").hidden = true;
    $("connBtn").textContent = "Connect & watch";
    $("backBtn").disabled = true;
    setStatus("", "Connection failed or closed. The node may be unreachable from this network — the rest of the desk works fully offline.");
  };
  ws.onerror = fail;
  ws.onclose = () => { if (board.watching) fail(); };
});

$("backBtn").addEventListener("click", async () => {
  if (board.scanning || !board.ws || board.ws.readyState !== 1) return;
  const myScan = ++boardScanSeq;
  const myWs = board.ws;
  const isCurrent = () => myScan === boardScanSeq && board.ws === myWs &&
    board.watching && board.ws && board.ws.readyState === 1;
  board.scanning = true;
  $("backBtn").disabled = true;
  const prog = $("scanProg"); prog.hidden = false;
  const bar = prog.querySelector(".bar"), lbl = prog.querySelector(".lbl");
  setStatus("scan", "Scanning history…");
  try {
    const head = await rpc("chain_getHeader", []);
    if (!isCurrent()) return;
    const headNum = (head && typeof head === "object") ? C.parseBlockNumber(head.number) : null;
    if (headNum === null) throw new Error("node returned a malformed head");
    const N = 720, from = Math.max(1, headNum - N + 1);
    let found = 0;
    for (let n = headNum; n >= from; n--) {
      if (!isCurrent()) return;
      const hash = await rpc("chain_getBlockHash", [n]);
      if (!isCurrent()) return;
      const before = board.seen.size;
      await processBlock(hash);
      if (!isCurrent()) return;
      found += board.seen.size - before;
      const done = headNum - n + 1;
      bar.style.width = Math.round((done / (headNum - from + 1)) * 100) + "%";
      lbl.textContent = `block ${n.toLocaleString("en-US")} — ${found} remark${found === 1 ? "" : "s"} found`;
    }
    if (!isCurrent()) return;
    setStatus("live", `History scan complete — ${found} remark${found === 1 ? "" : "s"} in the last ${(headNum - from + 1).toLocaleString("en-US")} blocks. Still watching new heads.`);
  } catch (e) {
    if (!isCurrent()) return;
    setStatus("live", "History scan hit an error (" + e.message + ") — still watching new heads.");
  }
  /* Only the still-current scan owns this cleanup; a superseded scan
   * returns above, and its disconnect already reset scanning/progress
   * (fail) — touching them here would clobber that state or a newer
   * connection's scan. */
  if (myScan === boardScanSeq) {
    prog.hidden = true;
    board.scanning = false;
    $("backBtn").disabled = false;
  }
});

/* ---------------- init ---------------- */
renderVault();
