/* QTC ZkTree Desk — UI wiring (ES module).
 *
 * Tabs: Observatory (live ZkTreeApi reads) · Leaf Lab (exact hash_leaf) ·
 * Tree Simulator (exact batched folding + canvas) · Proof Lab (generate /
 * verify / live-chain proofs) · Wormhole & circuits · Spec.
 *
 * Chain facts: Quantus-Network/chain @ 482c5b9, pallets/zk-tree.
 * 100% client-side. Never signs. No mock chain data: when the node is
 * unreachable the Observatory says so.
 */
import { ZK } from "./zktree-core.js";
import { hashToBytes, hexEncode, hexDecode } from "./quantus-crypto.js";

const TWOX = window.QSL_TWOX;
if (!TWOX) throw new Error("twox.js (window.QSL_TWOX) must load before app.js");

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shortHash = (hex) => {
  const h = String(hex).replace(/^0x/, "");
  return h.length > 20 ? "0x" + h.slice(0, 10) + "…" + h.slice(-8) : "0x" + h;
};
function fmtInt(n) {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtYears(y) {
  if (!isFinite(y)) return "—";
  if (y >= 1000) return "≈ " + fmtInt(Math.round(y)) + " years";
  if (y >= 10) return "≈ " + y.toFixed(0) + " years";
  if (y >= 1) return "≈ " + y.toFixed(1) + " years";
  const d = y * 365.25;
  if (d >= 2) return "≈ " + d.toFixed(0) + " days";
  return "≈ " + (d * 24).toFixed(1) + " hours";
}

// ---------------------------------------------------------------- tabs
document.querySelectorAll(".tabs [role=tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    document.querySelectorAll(".tabpage").forEach((p) => p.classList.add("hidden"));
    $("tab-" + btn.dataset.tab).classList.remove("hidden");
  });
});

// ---------------------------------------------------------------- RPC client (WebSocket JSON-RPC)
const rpc = {
  ws: null,
  endpoint: "wss://rpc.quantus.network",
  connected: false,
  pending: new Map(),
  id: 1,
  reconnectTimer: null,
  reconnectAttempt: 0,
  wantConnection: false,
  live: { leaves: null, depth: null, root: null, pending: null, header: null },

  log(msg, cls) {
    const el = $("obs-status");
    el.textContent = msg;
    el.className = "status" + (cls ? " " + cls : "");
  },
  setDot(state) {
    const d = $("obs-live-dot");
    d.className = "live-dot" + (state === "on" ? " on" : state === "off" ? " off" : "");
  },

  connect(endpoint) {
    if (endpoint) this.endpoint = endpoint;
    this.wantConnection = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setDot("");
    this.log("connecting…");
    let ws;
    try {
      ws = new WebSocket(this.endpoint);
    } catch (e) {
      this.log("connection failed: " + e.message, "bad");
      this.setDot("off");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.setDot("on");
      this.log("connected — reading tree state…", "ok");
      this.refresh().catch((e) => this.log("read failed: " + e.message, "bad"));
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "RPC error"));
      else p.resolve(m.result);
    };
    ws.onerror = () => {
      /* onclose carries the detail */
    };
    ws.onclose = () => {
      this.connected = false;
      this.setDot("off");
      for (const [, p] of this.pending) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (this.wantConnection) {
        this.log("disconnected — retrying…", "bad");
        this.scheduleReconnect();
      } else {
        this.log("disconnected", "bad");
      }
    };
  },

  scheduleReconnect() {
    if (this.reconnectTimer || !this.wantConnection) return;
    const wait = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  },

  disconnect() {
    this.wantConnection = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) this.ws.close();
  },

  call(req) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: req.method, params: req.params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("request timed out"));
        }
      }, 20000);
    });
  },

  async refresh() {
    const [leafCountHex, depthHex, rootHex, pendingHex, header] = await Promise.all([
      this.call(ZK.ZK_RPC.getLeafCount()),
      this.call(ZK.ZK_RPC.getDepth()),
      this.call(ZK.ZK_RPC.getRoot()),
      this.call(ZK.ZK_RPC.getStorage(ZK.storageKeyPlain(TWOX, "ZkTree", "UnprocessedLeaves"))).catch(() => null),
      this.call(ZK.ZK_RPC.getHeader()).catch(() => null),
    ]);
    const leaves = ZK.decodeU64LeHex(leafCountHex);
    const depth = parseInt(String(depthHex).replace(/^0x/, ""), 16);
    const root = String(rootHex);
    const pending = pendingHex ? ZK.decodeU64LeHex(pendingHex) : null;
    this.live = { leaves, depth, root, pending, header };
    renderObservatory();
    this.log(
      "connected — live at block " + (header && header.number ? parseInt(header.number, 16).toLocaleString("en-US") : "?"),
      "ok"
    );
  },
};

function renderObservatory() {
  const L = rpc.live;
  if (L.leaves === null) return;
  $("obs-leaves").textContent = fmtInt(L.leaves);
  const cap = ZK.capacityAtDepth(L.depth);
  $("obs-depth").textContent = String(L.depth);
  $("obs-depth-sub").textContent = "capacity " + fmtInt(cap);
  $("obs-pending").textContent = L.pending === null ? "n/a" : fmtInt(L.pending);
  $("obs-root").textContent = L.root;
  // gauge: log scale toward the circuit ceiling (depth 16)
  const frac = Math.log(Number(L.leaves) + 1) / Math.log(Number(ZK.capacityAtDepth(ZK.CIRCUIT_MAX_TREE_DEPTH)));
  $("obs-gauge-fill").style.width = Math.min(100, Math.max(0.5, frac * 100)).toFixed(2) + "%";
  $("obs-gauge-left").textContent =
    "depth " + L.depth + " · " + fmtInt(L.leaves) + " / " + fmtInt(ZK.capacityAtDepth(ZK.CIRCUIT_MAX_TREE_DEPTH)) + " leaves (log scale)";
  // exhaustion at the 1-leaf/block floor
  try {
    const p = ZK.exhaustionProjection(L.leaves, 1);
    $("obs-exhaust").innerHTML =
      "At the <strong>1 leaf/block floor</strong> (every block records its mining reward), depth 16 lasts " +
      "<strong>" + fmtYears(p.yearsLeft) + "</strong> from here — " + fmtInt(Math.floor(p.blocksLeft)) + " blocks of headroom. " +
      "Exhaustion is years away and fully observable in <code>LeafCount</code>.";
  } catch (e) {
    $("obs-exhaust").textContent = "";
  }
  // feed the wormhole tab's manual input
  const wh = $("wh-leaves");
  if (wh && !wh.dataset.touched) wh.value = L.leaves.toString();
}

$("obs-connect").addEventListener("click", () => {
  rpc.disconnect();
  rpc.live = { leaves: null, depth: null, root: null, pending: null, header: null };
  rpc.connect($("obs-endpoint").value.trim());
});
$("obs-refresh").addEventListener("click", () => {
  if (!rpc.connected) {
    rpc.log("not connected — press Connect", "bad");
    return;
  }
  rpc.log("refreshing…");
  rpc.refresh().catch((e) => rpc.log("read failed: " + e.message, "bad"));
});
// best-effort auto-connect on load
rpc.connect($("obs-endpoint").value.trim());

// ---------------------------------------------------------------- Leaf Lab
const FELT_LABELS = [
  ["to_account", "limb 0 (bytes 0–7 LE)"],
  ["to_account", "limb 1 (bytes 8–15 LE)"],
  ["to_account", "limb 2 (bytes 16–23 LE)"],
  ["to_account", "limb 3 (bytes 24–31 LE)"],
  ["transfer_count", "high 32 bits"],
  ["transfer_count", "low 32 bits"],
  ["asset_id", "u32, saturated"],
  ["amount", "quantized ÷10¹⁰, u32, saturated"],
];
let lastLeafFields = null;

function leafLabError(msg) {
  const e = $("leaf-error");
  if (!msg) {
    e.hidden = true;
    return;
  }
  e.textContent = msg;
  e.hidden = false;
}

$("leaf-hash").addEventListener("click", () => {
  leafLabError(null);
  try {
    const acct = ZK.parseAccount($("leaf-to").value);
    const tc = BigInt($("leaf-tc").value.trim() || "0");
    if (tc < 0n || tc > 0xffffffffffffffffn) throw new Error("transfer_count must fit in u64");
    const asset = BigInt($("leaf-asset").value.trim() || "0");
    const amount = ZK.parseQtcToPlancks($("leaf-amount").value);
    const fields = { to: acct.bytes, transferCount: tc, assetId: asset, amountPlancks: amount };
    const r = ZK.hashLeaf(fields);
    lastLeafFields = fields;
    // felt table
    const tb = $("leaf-felts").querySelector("tbody");
    tb.innerHTML = FELT_LABELS.map((lab, i) => {
      const bad = i < 4 && !r.canonical;
      return (
        "<tr" + (bad ? ' class="hl"' : "") + '><td class="n">' + i + "</td><td>" + esc(lab[0]) +
        '<br><span class="dim">' + esc(lab[1]) + "</span></td>" +
        '<td class="f">0x' + r.felts[i].toString(16).padStart(16, "0") +
        '<br><span class="dim">' + r.felts[i].toString() + "</span></td></tr>"
      );
    }).join("");
    // result
    const lines = [];
    lines.push("leaf hash: 0x" + r.hashHex);
    lines.push("quantized amount: " + r.quantized.toString() + " units  (= " + ZK.formatQtc(r.quantized * ZK.AMOUNT_SCALE_DOWN_FACTOR) + " QTC committed)");
    lines.push("asset_id committed: " + r.assetIdU32.toString() + (r.saturated && r.assetIdU32 === 4294967295n ? " (SATURATED at u32::MAX)" : ""));
    if (r.saturated && r.quantizedU32 === 4294967295n) lines.push("amount SATURATED at u32::MAX — oversized values pin to the cap, never wrap");
    lines.push(r.canonical ? "recipient canonical: yes — all 4 limbs < Goldilocks p" : "recipient canonical: NO — " + r.reducedLimbs + " limb(s) reduced mod p (lossy alias of the canonical form)");
    const box = $("leaf-result");
    box.hidden = false;
    box.innerHTML = esc(lines.join("\n")) + '\n<button class="btn" id="leaf-to-sim" style="margin-top:10px">＋ Send this leaf to the simulator</button>';
    $("leaf-to-sim").addEventListener("click", () => {
      sim.queue = lastLeafFields;
      sim.status("leaf queued — press “＋ Append leaf”");
      document.querySelector('[data-tab="simulator"]').click();
    });
  } catch (e) {
    leafLabError(e.message);
  }
});

$("leaf-golden").addEventListener("click", () => {
  const g = ZK.GOLDEN_LEAF;
  $("leaf-to").value = "0x" + g.toHex;
  $("leaf-tc").value = g.transferCount.toString();
  $("leaf-asset").value = String(g.assetId);
  // 1234 * 10^10 plancks = 12.34 QTC
  $("leaf-amount").value = "12.34";
  $("leaf-hash").click();
  const box = $("leaf-result");
  const match = lastLeafFields && ZK.hashLeaf(lastLeafFields).hashHex === g.expectedHex;
  box.innerHTML += "\n" + '<span class="' + (match ? "ok-line" : "warn-line") + '">' +
    (match ? "✓ matches the upstream golden vector (tests.rs::hash_leaf_golden_vector)" : "✗ MISMATCH vs golden vector — do not trust this build") + "</span>";
});

// ---------------------------------------------------------------- Simulator
const sim = {
  settled: [], // leaf field objects
  pending: [],
  queue: null,
  depth: 0,
  root: null, // hex string or null
  events: [],
  nodeHits: [],
  counter: 0,

  status(msg, cls) {
    const el = $("sim-status");
    el.textContent = msg;
    el.className = "status" + (cls ? " " + cls : "");
  },

  genLeaf(i) {
    // deterministic pseudo-leaf from the counter (simulation only — labeled as such)
    const to = hashToBytes([BigInt(i), 0x5eedn]);
    const q = 1n + BigInt((i * 37) % 100);
    return { to, transferCount: BigInt(i), assetId: 0n, amountPlancks: q * ZK.AMOUNT_SCALE_DOWN_FACTOR, simulated: true };
  },

  append() {
    if (this.settled.length + this.pending.length >= 64) {
      this.status("simulator caps at 64 leaves for drawing — reset to grow again", "bad");
      return;
    }
    const f = this.queue || this.genLeaf(this.counter++);
    this.queue = null;
    this.pending.push(f);
    this.events.push({ t: "queue", text: "leaf queued (pending, not yet in tree) — tc=" + f.transferCount });
    this.render();
    this.status(this.pending.length + " pending — finalize a block to fold them in");
  },

  appendN(n) {
    for (let k = 0; k < n; k++) {
      if (this.settled.length + this.pending.length >= 64) break;
      this.append();
    }
  },

  finalize() {
    if (this.pending.length === 0) {
      this.status("nothing pending — append leaves first", "bad");
      return;
    }
    const all = this.settled.concat(this.pending);
    const newDepth = ZK.depthForLeaves(all.length);
    if (newDepth > this.depth && this.depth > 0) {
      // grow_tree parking is implicit in computeRoot's settled semantics
    }
    const startIdx = this.settled.length;
    this.pending.forEach((f, k) => {
      this.events.push({ t: "leaf", text: "LeafInserted { index: " + (startIdx + k) + " }" });
    });
    if (newDepth > this.depth) {
      this.events.push({ t: "grow", text: "TreeGrew { new_depth: " + newDepth + " }  (capacity " + ZK.capacityAtDepth(newDepth) + ")" });
    }
    this.settled = all;
    this.pending = [];
    this.depth = newDepth;
    const hashes = this.settled.map((f) => ZK.hashLeaf(f).hash);
    this.root = hexEncode(ZK.computeRoot(hashes, this.depth));
    this.render();
    this.status("block finalized — " + this.settled.length + " leaves settled at depth " + this.depth, "ok");
  },

  reset() {
    this.settled = [];
    this.pending = [];
    this.queue = null;
    this.depth = 0;
    this.root = null;
    this.events = [];
    this.counter = 0;
    this.render();
    this.status("empty tree");
  },

  nodeMaps() {
    // level -> Map(index -> hash), settled only, mirroring the pallet's Nodes
    const E = ZK.emptyHash();
    const maps = {};
    let level = this.settled.map((f) => ZK.hashLeaf(f).hash);
    for (let l = 1; l <= this.depth; l++) {
      const m = new Map();
      const next = [];
      for (let i = 0; i < level.length; i += 4) {
        const ch = [];
        for (let k = 0; k < 4; k++) ch.push(i + k < level.length ? level[i + k] : E);
        const h = ZK.hashNode(ch);
        m.set(next.length, h);
        next.push(h);
      }
      maps[l] = m;
      level = next;
    }
    return maps;
  },

  render() {
    $("sim-settled").textContent = this.settled.length;
    $("sim-pending").textContent = this.pending.length;
    $("sim-depth").textContent = this.depth;
    $("sim-cap").textContent = fmtInt(ZK.capacityAtDepth(this.depth));
    $("sim-root").textContent = "root: " + (this.root ? "0x" + this.root : "— (empty_hash)");
    const ev = $("sim-events");
    ev.innerHTML = this.events.length
      ? this.events.slice(-40).map((e) => '<div class="' + (e.t === "grow" ? "ev-grow" : e.t === "leaf" ? "ev-leaf" : "dim") + '">' + esc(e.text) + "</div>").join("")
      : '<span class="dim">No events yet — append a leaf, then finalize.</span>';
    ev.scrollTop = ev.scrollHeight;
    this.draw();
  },

  draw() {
    const cv = $("sim-canvas");
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    this.nodeHits = [];
    const n = this.settled.length;
    if (n === 0) {
      ctx.fillStyle = "#6b739e";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("empty tree — every subtree reads as the zero hash", W / 2, H / 2 - 8);
      if (this.pending.length) {
        ctx.fillStyle = "#fbbf24";
        ctx.fillText(this.pending.length + " leaf(s) pending — finalize a block to fold them", W / 2, H / 2 + 16);
      }
      $("sim-nodeinfo").textContent = "Click any node to inspect its hash.";
      return;
    }
    const d = this.depth;
    const E = ZK.emptyHash();
    const leafHashes = this.settled.map((f) => ZK.hashLeaf(f).hash);
    // levels[0] = leaves … levels[d] = [root]
    const levels = [leafHashes];
    let cur = leafHashes;
    for (let l = 1; l <= d; l++) {
      const next = [];
      for (let i = 0; i < cur.length; i += 4) {
        const ch = [];
        for (let k = 0; k < 4; k++) ch.push(i + k < cur.length ? cur[i + k] : E);
        next.push(ZK.hashNode(ch));
      }
      levels.push(next);
      cur = next;
    }
    const rowY = (lvl) => 44 + (d - lvl) * ((H - 110) / Math.max(1, d));
    const dotR = (lvl) => (lvl === d ? 10 : lvl === 0 ? 5 : 7);
    const pos = [];
    for (let lvl = 0; lvl <= d; lvl++) {
      const nodes = levels[lvl];
      const row = [];
      for (let i = 0; i < nodes.length; i++) {
        const x = nodes.length === 1 ? W / 2 : 34 + (i * (W - 68)) / (nodes.length - 1);
        row.push({ x, y: rowY(lvl), hash: nodes[i], label: lvl === 0 ? "leaf " + i : lvl === d ? "root" : "L" + lvl + "·" + i, lvl });
      }
      pos.push(row);
    }
    // edges (child -> parent), parent x = mean of drawn children
    ctx.lineWidth = 1;
    for (let lvl = 0; lvl < d; lvl++) {
      for (let i = 0; i < pos[lvl].length; i++) {
        const p = pos[Math.min(lvl + 1, d)][Math.floor(i / 4)] || pos[d][0];
        ctx.strokeStyle = "rgba(167,139,250,.28)";
        ctx.beginPath();
        ctx.moveTo(pos[lvl][i].x, pos[lvl][i].y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
    // nodes
    for (let lvl = 0; lvl <= d; lvl++) {
      for (const nd of pos[lvl]) {
        const r = dotR(lvl);
        const grad = ctx.createRadialGradient(nd.x - r / 3, nd.y - r / 3, 1, nd.x, nd.y, r * 2);
        if (lvl === d) {
          grad.addColorStop(0, "#5eead4");
          grad.addColorStop(1, "#0f766e");
        } else if (lvl === 0) {
          grad.addColorStop(0, "#a78bfa");
          grad.addColorStop(1, "#4c1d95");
        } else {
          grad.addColorStop(0, "#7dd3fc");
          grad.addColorStop(1, "#1e3a8a");
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
        ctx.fill();
        this.nodeHits.push({ x: nd.x, y: nd.y, r: r + 6, hash: nd.hash, label: nd.label });
      }
    }
    // pending strip
    if (this.pending.length) {
      ctx.fillStyle = "#fbbf24";
      ctx.font = "12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("◌ " + this.pending.length + " pending leaf(s) — not yet folded (finalize to include)", W / 2, H - 14);
    }
    ctx.fillStyle = "#6b739e";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(d + " levels · " + n + " leaves · arity 4 · children sorted before every hash", 12, H - 14);
  },
};

$("sim-add").addEventListener("click", () => sim.append());
$("sim-add5").addEventListener("click", () => sim.appendN(5));
$("sim-finalize").addEventListener("click", () => sim.finalize());
$("sim-reset").addEventListener("click", () => sim.reset());
$("sim-canvas").addEventListener("click", (ev) => {
  const cv = $("sim-canvas");
  const rect = cv.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * cv.width;
  const y = ((ev.clientY - rect.top) / rect.height) * cv.height;
  let best = null,
    bestD = 1e9;
  for (const h of sim.nodeHits) {
    const dd = Math.hypot(h.x - x, h.y - y);
    if (dd < h.r && dd < bestD) {
      best = h;
      bestD = dd;
    }
  }
  $("sim-nodeinfo").textContent = best ? best.label + ": 0x" + hexEncode(best.hash) : "Click any node to inspect its hash.";
});
sim.render();

// ---------------------------------------------------------------- Proof Lab
function proofLabError(id, msg) {
  const e = $(id);
  if (!msg) {
    e.hidden = true;
    return;
  }
  e.textContent = msg;
  e.hidden = false;
}

$("proof-gen").addEventListener("click", () => {
  proofLabError("proof-gen-error", null);
  try {
    const idx = Number($("proof-idx").value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= sim.settled.length)
      throw new Error("leaf index out of range — the simulator holds " + sim.settled.length + " settled leaves (finalize a block first)");
    const E = ZK.emptyHash();
    const maps = sim.nodeMaps();
    const leafHashes = sim.settled.map((f) => ZK.hashLeaf(f).hash);
    const getLeafHash = (i) => (Number(i) < leafHashes.length ? leafHashes[Number(i)] : E);
    const getNodeHash = (lvl, i) => maps[lvl].get(Number(i)) || E;
    const proof = ZK.generateProof(idx, sim.depth, getLeafHash, getNodeHash);
    const out = $("proof-gen-out");
    out.hidden = false;
    out.textContent = JSON.stringify(proof, null, 2);
    // fill the verify form for the full loop
    const f = sim.settled[idx];
    $("pv-to").value = "0x" + hexEncode(f.to);
    $("pv-tc").value = f.transferCount.toString();
    $("pv-asset").value = f.assetId.toString();
    $("pv-amount").value = ZK.formatQtc(f.amountPlancks);
    $("proof-paste").value = JSON.stringify(proof);
    $("proof-root").value = "0x" + sim.root;
  } catch (e) {
    proofLabError("proof-gen-error", e.message);
  }
});

$("proof-verify").addEventListener("click", () => {
  const box = $("proof-verify-out");
  try {
    const proof = JSON.parse($("proof-paste").value);
    if (!proof || !Array.isArray(proof.siblings)) throw new Error("proof JSON needs {leaf_index, siblings: [[h,h,h], …]}");
    const acct = ZK.parseAccount($("pv-to").value);
    const fields = {
      to: acct.bytes,
      transferCount: BigInt($("pv-tc").value.trim() || "0"),
      assetId: BigInt($("pv-asset").value.trim() || "0"),
      amountPlancks: ZK.parseQtcToPlancks($("pv-amount").value.trim() || "0"),
    };
    const rootHex = $("proof-root").value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(rootHex)) throw new Error("expected root must be 32-byte hex");
    const ok = ZK.verifyProof(fields, proof, rootHex);
    const leafHash = ZK.hashLeaf(fields).hashHex;
    box.hidden = false;
    box.className = "verdict " + (ok ? "pass" : "fail");
    box.innerHTML =
      (ok ? "✓ PROOF VALID — the leaf recomputes and the path folds to the expected root." : "✗ PROOF INVALID — leaf hash, siblings, or root do not line up.") +
      '<span class="detail">leaf hash 0x' + esc(leafHash) + "<br>" + proof.siblings.length + " levels × 3 siblings · index-free verification (children sorted at every node)</span>";
  } catch (e) {
    box.hidden = false;
    box.className = "verdict fail";
    box.textContent = "✗ " + e.message;
  }
});

$("liveproof-go").addEventListener("click", async () => {
  const box = $("liveproof-out");
  const detail = $("liveproof-detail");
  box.hidden = true;
  detail.hidden = true;
  if (!rpc.connected) {
    box.hidden = false;
    box.className = "verdict fail";
    box.textContent = "✗ Not connected — connect the Observatory first.";
    return;
  }
  const idx = $("liveproof-idx").value.trim();
  if (!/^\d+$/.test(idx)) {
    box.hidden = false;
    box.className = "verdict fail";
    box.textContent = "✗ Leaf index must be a non-negative integer.";
    return;
  }
  box.hidden = false;
  box.className = "verdict";
  box.textContent = "… fetching leaf + proof from the chain";
  try {
    const leafKey = ZK.leavesStorageKey(TWOX, idx);
    const leafScale = await rpc.call(ZK.ZK_RPC.getStorage(leafKey));
    if (!leafScale) throw new Error("no leaf at index " + idx + " (beyond LeafCount?)");
    const fields = ZK.decodeLeaf(leafScale);
    const proofHex = await rpc.call(ZK.ZK_RPC.getMerkleProof(idx));
    const proof = ZK.decodeMerkleProofRpc(proofHex);
    if (!proof) throw new Error("node returned None — leaf out of bounds or not yet settled (try an older index)");
    const rootHex = await rpc.call(ZK.ZK_RPC.getRoot());
    const ok = ZK.verifyProof(fields, proof, rootHex);
    const leafHash = ZK.hashLeaf(fields).hashHex;
    box.className = "verdict " + (ok ? "pass" : "fail");
    const sameRoot = proof.root.toLowerCase() === String(rootHex).toLowerCase();
    box.innerHTML =
      (ok
        ? "✓ LIVE PROOF VALID — leaf " + esc(idx) + " is in the on-chain tree."
        : "✗ LIVE PROOF INVALID — recomputed path does not reach the live root.") +
      '<span class="detail">leaf hash 0x' + esc(leafHash) + "<br>proof root " + esc(proof.root) + (sameRoot ? " (matches live Root)" : " (DIFFERS from live Root — tree advanced mid-check; retry)") +
      "<br>" + proof.siblings.length + " levels · node depth " + proof.depth + "</span>";
    detail.hidden = false;
    detail.textContent =
      "decoded leaf " + idx + ":\n" +
      "  to:             0x" + hexEncode(fields.to) + "\n" +
      "  transfer_count: " + fields.transferCount + "\n" +
      "  asset_id:       " + fields.assetId + "\n" +
      "  amount:         " + ZK.formatQtc(fields.amountPlancks) + " QTC  (quantized: " + (fields.amountPlancks / ZK.AMOUNT_SCALE_DOWN_FACTOR) + " units)";
  } catch (e) {
    box.className = "verdict fail";
    box.textContent = "✗ " + e.message;
  }
});

// ---------------------------------------------------------------- Wormhole tab: exhaustion projector
function renderExhaustion(leaves) {
  const rate = Number($("wh-rate").value);
  const out = $("wh-out");
  if (!(rate > 0)) {
    out.hidden = false;
    out.textContent = "Enter a positive leaves/block rate.";
    return;
  }
  try {
    const p = ZK.exhaustionProjection(leaves, rate);
    out.hidden = false;
    out.textContent =
      fmtInt(leaves) + " leaves → depth-16 ceiling (" + fmtInt(p.capacity) + ") at " + rate + " leaves/block: " +
      fmtYears(p.yearsLeft) + " (" + fmtInt(Math.floor(p.blocksLeft)) + " blocks).";
  } catch (e) {
    out.hidden = false;
    out.textContent = e.message;
  }
  const scenarios = [
    ["wh-s1", 1],
    ["wh-s2", 120], // 10/sec × 12s blocks
    ["wh-s3", 600], // ~50 tps × 12s
  ];
  for (const [id, r] of scenarios) {
    try {
      $(id).textContent = fmtYears(ZK.exhaustionProjection(leaves, r).yearsLeft);
    } catch {
      $(id).textContent = "—";
    }
  }
}

$("wh-calc").addEventListener("click", () => {
  const v = $("wh-leaves").value.trim();
  if (!/^\d+$/.test(v)) {
    $("wh-out").hidden = false;
    $("wh-out").textContent = "Enter the current leaf count (connect the Observatory to fill it live).";
    return;
  }
  $("wh-leaves").dataset.touched = "1";
  renderExhaustion(BigInt(v));
});
// manual leaves input lives next to the rate input
(function addLeavesInput() {
  const row = $("wh-rate").closest(".row");
  const lab = document.createElement("label");
  lab.innerHTML = 'current leaves <span class="hint">live from Observatory when connected</span>';
  const inp = document.createElement("input");
  inp.id = "wh-leaves";
  inp.className = "mono";
  inp.setAttribute("size", "14");
  inp.placeholder = "e.g. 150000";
  inp.addEventListener("input", () => (inp.dataset.touched = "1"));
  lab.appendChild(inp);
  row.insertBefore(lab, row.firstChild);
})();
