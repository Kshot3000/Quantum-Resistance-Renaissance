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

wireDrop("drop", "fileInput", async (file) => {
  const drop = $("drop");
  drop.querySelector(".drop-ico").textContent = "⏳";
  try {
    studio.fileHash = await hashFile(file, (p) => {
      drop.querySelector("strong").textContent = "Hashing… " + Math.round(p * 100) + "%";
    });
    $("digestInput").value = studio.fileHash.sha256;
    $("algoSel").value = "1";
    drop.querySelector("strong").textContent = "✓ " + file.name;
    drop.querySelector(".hint").textContent =
      file.size.toLocaleString("en-US") + " bytes · SHA-256 " + studio.fileHash.sha256.slice(0, 16) + "… · BLAKE2b-256 " +
      studio.fileHash.blake2.slice(0, 16) + "… (digests filled below — pick the algorithm, then build)";
  } catch (err) {
    drop.querySelector("strong").textContent = "Hashing failed — try again";
  }
  drop.querySelector(".drop-ico").textContent = "📥";
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
  const nonce = Math.max(0, parseInt($("nonceInput").value || "0", 10) || 0);
  const est = C.signedLengthEstimate(call.callLen, sigScheme, nonce);
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
function loadVault() { try { return JSON.parse(localStorage.getItem(VKEY) || "[]"); } catch { return []; } }
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
    if (a.digestHex) d.appendChild(el("code", "", a.algo + ": " + a.digestHex));
    d.appendChild(el("code", "", "call: 0x" + a.callHex.slice(0, 60) + "…"));
    const meta = el("div", "vmeta");
    meta.innerHTML = `${a.withEvent ? "📯 remark_with_event" : "📝 remark"} · fee ≈ ${a.feeQTC} QTC · `;
    const blk = el("input", "blk"); blk.placeholder = "block #"; blk.value = a.block || "";
    blk.title = "Fill in the block number once your extrinsic lands";
    blk.addEventListener("change", () => {
      const vv = loadVault(); vv[idx].block = blk.value.trim() || null; saveVault(vv);
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
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------------- Verify Desk ---------------- */
wireDrop("vDrop", "vFileInput", async (file) => {
  const drop = $("vDrop");
  drop.querySelector(".drop-ico").textContent = "⏳";
  try {
    const h = await hashFile(file, null);
    $("vDigestInput").value = h.sha256;
    drop.querySelector("strong").textContent = "✓ " + file.name + " — digest filled below";
  } catch { drop.querySelector("strong").textContent = "Hashing failed — try again"; }
  drop.querySelector(".drop-ico").textContent = "🔍";
});

$("vCheckBtn").addEventListener("click", () => {
  const d = $("vDigestInput").value.trim().toLowerCase();
  const box = $("vResult"); box.hidden = false;
  if (!/^[0-9a-f]{64}$/.test(d)) {
    box.className = "vresult miss";
    box.innerHTML = "<strong>⚠ Not a digest</strong>Paste a 64-character hex digest, or drop the file above to hash it.";
    return;
  }
  const hit = loadVault().find((a) => a.digestHex === d);
  if (hit) {
    const fp = hit.envelopeHex ? C.bytesToHex(b2b256(C.hexToBytes(hit.envelopeHex))) : null;
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
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!board.ws || board.ws.readyState !== 1) return reject(new Error("not connected"));
    const id = ++board.id;
    board.pending.set(id, { resolve, reject });
    board.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || [] }));
    setTimeout(() => {
      if (board.pending.has(id)) { board.pending.delete(id); reject(new Error("rpc timeout: " + method)); }
    }, 15000);
  });
}
function setStatus(mode, text) {
  $("connDot").className = "dot" + (mode ? " " + mode : "");
  $("connStatus").textContent = text;
}
function hexToNum(h) { return parseInt(h, 16); }

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
  board.seen.add(key);
  const empty = document.querySelector("#boardList .empty");
  if (empty) empty.remove();
  const sender = C.ss58Encode32(C.hexToBytes(senderHex), b2b512);
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

async function processBlock(blockHash) {
  const [blockRes, evRes] = await Promise.all([
    rpc("chain_getBlock", [blockHash]),
    rpc("state_getStorage", [EVENTS_KEY, blockHash])
  ]);
  const blockNum = hexToNum(blockRes.block.header.number);
  if (!evRes) return;
  const evBytes = C.hexToBytes(evRes);
  const dec = C.decodeSystemEvents(evBytes);
  if (!dec.ok || !dec.records.length) return;
  const exts = blockRes.block.extrinsics || [];
  const seenAt = new Date().toLocaleTimeString();
  for (const r of dec.records) {
    if (r.skipped) continue;
    let payloadInfo = null;
    for (const ex of exts) {
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
    const subId = await rpc("chain_subscribeNewHeads", []);
    board.headSub = subId;
  };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && board.pending.has(msg.id)) {
      const p = board.pending.get(msg.id); board.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "rpc error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "chain_newHead" && msg.params && msg.params.result) {
      const h = msg.params.result;
      try {
        // the subscription yields a header (no hash): resolve it to a block hash
        const hash = await rpc("chain_getBlockHash", [hexToNum(h.number)]);
        await processBlock(hash);
      } catch (e) { /* one bad block never kills the watch */ }
    }
  };
  const fail = () => {
    board.watching = false; board.ws = null;
    $("connBtn").textContent = "Connect & watch";
    $("backBtn").disabled = true;
    setStatus("", "Connection failed or closed. The node may be unreachable from this network — the rest of the desk works fully offline.");
  };
  ws.onerror = fail;
  ws.onclose = () => { if (board.watching) fail(); };
});

$("backBtn").addEventListener("click", async () => {
  if (board.scanning || !board.ws || board.ws.readyState !== 1) return;
  board.scanning = true;
  $("backBtn").disabled = true;
  const prog = $("scanProg"); prog.hidden = false;
  const bar = prog.querySelector(".bar"), lbl = prog.querySelector(".lbl");
  setStatus("scan", "Scanning history…");
  try {
    const head = await rpc("chain_getHeader", []);
    const headNum = hexToNum(head.number);
    const N = 720, from = Math.max(1, headNum - N + 1);
    let found = 0;
    for (let n = headNum; n >= from; n--) {
      const hash = await rpc("chain_getBlockHash", [n]);
      const before = board.seen.size;
      await processBlock(hash);
      found += board.seen.size - before;
      const done = headNum - n + 1;
      bar.style.width = Math.round((done / (headNum - from + 1)) * 100) + "%";
      lbl.textContent = `block ${n.toLocaleString("en-US")} — ${found} remark${found === 1 ? "" : "s"} found`;
    }
    setStatus("live", `History scan complete — ${found} remark${found === 1 ? "" : "s"} in the last ${(headNum - from + 1).toLocaleString("en-US")} blocks. Still watching new heads.`);
  } catch (e) {
    setStatus("live", "History scan hit an error (" + e.message + ") — still watching new heads.");
  }
  prog.hidden = true;
  board.scanning = false;
  $("backBtn").disabled = false;
});

/* ---------------- init ---------------- */
renderVault();
