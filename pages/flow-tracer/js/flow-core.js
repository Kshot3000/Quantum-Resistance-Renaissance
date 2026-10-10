/* QTC Flow Tracer - pure graph logic (environment-agnostic).
 * Browser global: QFlow. Node: module.exports.
 * All money math is BigInt plancks. Rows: {id, amount(str|bigint), from_id,
 * to_id, block_height, timestamp, fee, extrinsic_id}.
 */
(function (global) {
"use strict";

var PLANCKS_PER_QTC = 1000000000000n;

function toBig(x) { return typeof x === "bigint" ? x : BigInt(x); }

/* ---- load/RPC boundary ----
 * Every row that reaches the graph crossed a trust boundary first: the
 * same-origin snapshot file (rewritten by scripts on a schedule) or a
 * live Subsquid answer. Classification per field:
 *   core — amount (a non-negative integer planck count), block_height,
 *          and non-empty string from/to: a row missing any of them is
 *          dropped, never repaired into a plausible-looking transfer
 *          (pre-fix, buildGraph's toBig() THREW on one fractional or
 *          garbage amount/fee and killed the whole app);
 *   poison — a non-object row, or a second row carrying an id already
 *          kept (an id IS a transfer's identity: the live per-address
 *          query returns the same transfer in both directions, and a
 *          duplicate kept twice would double-count every total);
 *   absent-but-recoverable — a garbage timestamp coerces to null, a
 *          missing/garbage fee coerces to "0" (the fee is carried for
 *          completeness; it anchors no total and no render here), a
 *          non-string extrinsic_id coerces to null, and an id-less row
 *          gets a fact-derived synthetic id — pre-fix every id-less row
 *          shared trace()'s seenEdge key `undefined`, so all but the
 *          first silently vanished from every trace.
 */
function validPlancks(v) {
  if (typeof v === "bigint") return v >= 0n ? v.toString() : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return v.replace(/^0+(?=\d)/, "");
  return null;
}

function nonNegInt(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    var n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function parseHeight(v) { return nonNegInt(v); }

function parseableTs(v) {
  if (typeof v === "string" && v && Number.isFinite(Date.parse(v))) return v;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  return null;
}

function sanitizeTransfer(r, i) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  var amount = validPlancks(r.amount);
  if (amount === null) return null; // core field
  var height = parseHeight(r.block_height);
  if (height === null) return null; // core field
  if (typeof r.from_id !== "string" || !r.from_id) return null;
  if (typeof r.to_id !== "string" || !r.to_id) return null;
  var fee = r.fee == null ? "0" : validPlancks(r.fee);
  if (fee === null) fee = "0"; // recoverable: anchors nothing in this app
  var id = null;
  if (typeof r.id === "string" && r.id) id = r.id;
  else if (typeof r.id === "number" && Number.isFinite(r.id)) id = String(r.id);
  if (!id) id = "row-" + i + ":" + r.from_id + ">" + r.to_id + "@" + height + ":" + amount;
  return {
    id: id, amount: amount, from_id: r.from_id, to_id: r.to_id,
    block_height: height, timestamp: parseableTs(r.timestamp),
    fee: fee, extrinsic_id: typeof r.extrinsic_id === "string" && r.extrinsic_id ? r.extrinsic_id : null,
  };
}

function sanitizeTransfers(rows) {
  if (!Array.isArray(rows)) return [];
  var out = [], seenId = new Set();
  for (var i = 0; i < rows.length; i++) {
    var clean = sanitizeTransfer(rows[i], i);
    if (!clean) continue;
    if (seenId.has(clean.id)) continue; // a duplicate id is the same transfer, never a second one
    seenId.add(clean.id);
    out.push(clean);
  }
  return out;
}

/* Snapshot meta anchors the badge and the methodology window: both
 * heights and the capture time are core (they are presented as chain
 * fact), so a malformed meta fails the load honestly instead of
 * rendering "[object Object]" bounds or a fake capture date. */
function sanitizeSnapshotMeta(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  var from = parseHeight(m.window_from), head = parseHeight(m.chain_height);
  if (from === null || head === null || from > head) return null;
  var captured = parseableTs(m.captured_at);
  if (captured === null) return null;
  return { window_from: from, chain_height: head, captured_at: captured };
}

/* Build adjacency indexes over a row list. Rows are sanitized at this
 * boundary (see above), so every graph consumer — snapshot, live, or
 * test — sees only rows whose BigInt math cannot throw. */
function buildGraph(rows) {
  var out = new Map(), inn = new Map(), norm = [];
  var clean = sanitizeTransfers(rows);
  for (var i = 0; i < clean.length; i++) {
    var r = clean[i];
    var row = {
      id: r.id,
      amount: toBig(r.amount),
      from_id: r.from_id,
      to_id: r.to_id,
      block_height: r.block_height,
      timestamp: r.timestamp,
      fee: toBig(r.fee),
      extrinsic_id: r.extrinsic_id,
    };
    norm.push(row);
    if (!out.has(row.from_id)) out.set(row.from_id, []);
    if (!inn.has(row.to_id)) inn.set(row.to_id, []);
    out.get(row.from_id).push(row);
    inn.get(row.to_id).push(row);
  }
  return { out: out, inn: inn, rows: norm };
}

/* BFS trace from a seed address. direction: 'out' | 'in' | 'both'.
 * Returns { nodes: Map(addr -> {depth, via}), edges: [row], truncated,
 * edgeTruncated }. Depth is signed for 'both' (negative = inbound side).
 * Nodes are capped at maxNodes AND edges at maxEdges: a hub seed (the
 * biggest distributor) can be incident to thousands of transfers in the
 * snapshot, and an uncapped edge list once produced 6,600+ SVG elements
 * for a 160-node graph — visual noise and the fleet's heaviest DOM. */
function trace(graph, seed, opts) {
  opts = opts || {};
  var direction = opts.direction || "both";
  var maxHops = Math.max(1, Math.min(4, opts.maxHops || 2));
  var maxNodes = Math.max(10, Math.min(400, opts.maxNodes || 160));
  var maxEdges = Math.max(50, Math.min(10000, opts.maxEdges || 1200));
  var nodes = new Map();
  var edges = [];
  var seenEdge = new Set();
  nodes.set(seed, { depth: 0, via: null });
  var frontier = [seed];
  var truncated = false;
  var edgeTruncated = false;
  for (var hop = 1; hop <= maxHops && !edgeTruncated; hop++) {
    var next = [];
    for (var f = 0; f < frontier.length && !edgeTruncated; f++) {
      var addr = frontier[f];
      var d0 = nodes.get(addr).depth;
      var outs = (direction === "out" || direction === "both") ? (graph.out.get(addr) || []) : [];
      var ins = (direction === "in" || direction === "both") ? (graph.inn.get(addr) || []) : [];
      var all = outs.concat(ins);
      for (var e = 0; e < all.length; e++) {
        var row = all[e];
        if (seenEdge.has(row.id)) continue;
        seenEdge.add(row.id);
        if (edges.length >= maxEdges) { truncated = true; edgeTruncated = true; break; }
        edges.push(row);
        var other = row.from_id === addr ? row.to_id : row.from_id;
        var nd = row.from_id === addr ? Math.abs(d0) + 1 : -(Math.abs(d0) + 1);
        if (direction !== "both") nd = d0 + 1;
        if (!nodes.has(other)) {
          if (nodes.size >= maxNodes) { truncated = true; continue; }
          nodes.set(other, { depth: nd, via: addr });
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { nodes: nodes, edges: edges, truncated: truncated, edgeTruncated: edgeTruncated };
}

/* Aggregate parallel transfers between the same ordered pair into ONE
 * drawable edge: { from_id, to_id, amount (summed BigInt plancks), count,
 * maxAmount, lastBlock, timestamp (of lastBlock), genesis }.
 * First-seen pair order is preserved. The renderer draws one path per
 * pair — 40 transfers A->B are one relationship, not 40 stacked paths. */
function aggregateEdges(rows) {
  var byPair = new Map(), out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var key = row.from_id + ">" + row.to_id;
    var a = byPair.get(key);
    if (!a) {
      a = { from_id: row.from_id, to_id: row.to_id, amount: 0n, count: 0,
            maxAmount: 0n, lastBlock: 0, timestamp: null, genesis: false };
      byPair.set(key, a); out.push(a);
    }
    a.amount += row.amount;
    a.count++;
    if (row.amount > a.maxAmount) a.maxAmount = row.amount;
    if (row.block_height >= a.lastBlock) { a.lastBlock = row.block_height; a.timestamp = row.timestamp; }
    if (row.block_height === 1) a.genesis = true;
  }
  return out;
}

/* Deterministic layered layout for a trace. Returns
 * { pos: Map(addr -> {x, y}), width, height, layers: Map(depth -> [addr]) }. */
var XSTEP = 250, YSTEP = 62, MARGIN = 90;
function layoutTrace(t) {
  var layers = new Map();
  t.nodes.forEach(function (n, addr) {
    if (!layers.has(n.depth)) layers.set(n.depth, []);
    layers.get(n.depth).push(addr);
  });
  var depths = Array.from(layers.keys()).sort(function (a, b) { return a - b; });
  var pos = new Map(), maxN = 1;
  depths.forEach(function (d, li) {
    var arr = layers.get(d);
    // Deterministic order: most-connected first, then address.
    arr.sort();
    maxN = Math.max(maxN, arr.length);
    for (var i = 0; i < arr.length; i++) {
      pos.set(arr[i], {
        x: MARGIN + li * XSTEP,
        y: MARGIN + (i - (arr.length - 1) / 2) * YSTEP,
      });
    }
  });
  return {
    pos: pos,
    width: MARGIN * 2 + Math.max(0, depths.length - 1) * XSTEP,
    height: Math.max(220, MARGIN * 2 + (maxN - 1) * YSTEP),
    layers: layers,
  };
}

/* Peel chains: maximal runs where every intermediate node has exactly one
 * incoming and one outgoing transfer inside the graph. A classic
 * forwarding / peel pattern. Returns [{path:[addr], hops:[row], moved}] sorted
 * by length desc. minLen >= 2 counts edges; default reports chains of >= 3 edges. */
function detectPeelChains(graph, minLen) {
  minLen = minLen || 3;
  var out = graph.out, inn = graph.inn;
  function indeg(a) { return (inn.get(a) || []).length; }
  function outdeg(a) { return (out.get(a) || []).length; }
  var chains = [];
  var claimed = new Set(); // nodes already inside a reported chain
  out.forEach(function (rows, start) {
    if (rows.length !== 1 || claimed.has(start)) return;
    // Only start at a head: not a one-in-one-out middle.
    if (indeg(start) === 1 && outdeg(start) === 1) return;
    var path = [start], hops = [rows[0]], moved = rows[0].amount;
    var cur = rows[0].to_id;
    var guard = 0;
    while (guard++ < 2000) {
      if (claimed.has(cur)) break;
      path.push(cur);
      var io = out.get(cur) || [], ii = inn.get(cur) || [];
      if (io.length === 1 && ii.length === 1) {
        hops.push(io[0]);
        moved += io[0].amount;
        cur = io[0].to_id;
      } else break;
    }
    if (hops.length >= minLen) {
      path.forEach(function (a) { claimed.add(a); });
      chains.push({ path: path, hops: hops, moved: moved });
    }
  });
  chains.sort(function (a, b) { return b.hops.length - a.hops.length; });
  return chains;
}

/* Fan-out (distribution): one sender -> >= minRecipients distinct recipients. */
function detectFanOut(graph, minRecipients) {
  minRecipients = minRecipients || 5;
  var res = [];
  graph.out.forEach(function (rows, addr) {
    var byTo = new Map();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!byTo.has(r.to_id)) byTo.set(r.to_id, { to: r.to_id, total: 0n, count: 0 });
      var e = byTo.get(r.to_id);
      e.total += r.amount; e.count++;
    }
    if (byTo.size >= minRecipients) {
      var rec = Array.from(byTo.values()).sort(function (a, b) { return b.total > a.total ? 1 : -1; });
      var total = rec.reduce(function (s, x) { return s + x.total; }, 0n);
      res.push({ addr: addr, recipients: rec, distinct: byTo.size, total: total, txs: rows.length });
    }
  });
  res.sort(function (a, b) { return b.total > a.total ? 1 : -1; });
  return res;
}

/* Fan-in (consolidation): >= minSenders distinct senders -> one recipient. */
function detectFanIn(graph, minSenders) {
  minSenders = minSenders || 5;
  var res = [];
  graph.inn.forEach(function (rows, addr) {
    var byFrom = new Map();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!byFrom.has(r.from_id)) byFrom.set(r.from_id, { from: r.from_id, total: 0n, count: 0 });
      var e = byFrom.get(r.from_id);
      e.total += r.amount; e.count++;
    }
    if (byFrom.size >= minSenders) {
      var snd = Array.from(byFrom.values()).sort(function (a, b) { return b.total > a.total ? 1 : -1; });
      var total = snd.reduce(function (s, x) { return s + x.total; }, 0n);
      res.push({ addr: addr, senders: snd, distinct: byFrom.size, total: total, txs: rows.length });
    }
  });
  res.sort(function (a, b) { return b.total > a.total ? 1 : -1; });
  return res;
}

/* Round-amount transfers: exact whole-QTC amounts (often manual/OTC moves). */
function roundAmountTransfers(rows) {
  return rows
    .filter(function (r) { return r.amount % PLANCKS_PER_QTC === 0n; })
    .sort(function (a, b) { return b.amount > a.amount ? 1 : -1; });
}

/* Miner forwarding: for coinbase recipients of the mint sentinel, their
 * onward transfers (where pool payouts / miner spending actually goes). */
function minerForwarding(graph, sentinel) {
  var rewards = graph.out.get(sentinel) || [];
  var miners = new Map();
  for (var i = 0; i < rewards.length; i++) {
    var m = rewards[i].to_id;
    if (!miners.has(m)) miners.set(m, { miner: m, rewards: 0n, rewardTxs: 0, onward: [] });
    var e = miners.get(m);
    e.rewards += rewards[i].amount; e.rewardTxs++;
  }
  miners.forEach(function (e, m) {
    var outs = graph.out.get(m) || [];
    for (var i = 0; i < outs.length; i++) e.onward.push(outs[i]);
    e.onwardTotal = e.onward.reduce(function (s, r) { return s + r.amount; }, 0n);
  });
  return Array.from(miners.values())
    .filter(function (e) { return e.onward.length > 0; })
    .sort(function (a, b) { return b.onwardTotal > a.onwardTotal ? 1 : -1; });
}

/* Full dossier for one address. */
function summarizeAddress(graph, addr) {
  var ins = graph.inn.get(addr) || [], outs = graph.out.get(addr) || [];
  var inTotal = 0n, outTotal = 0n, firstBlock = Infinity, lastBlock = 0;
  var firstTs = null, lastTs = null;
  function touch(r) {
    if (r.block_height < firstBlock) firstBlock = r.block_height;
    if (r.block_height > lastBlock) lastBlock = r.block_height;
    if (r.timestamp) {
      if (!firstTs || r.timestamp < firstTs) firstTs = r.timestamp;
      if (!lastTs || r.timestamp > lastTs) lastTs = r.timestamp;
    }
  }
  var cOut = new Map(), cIn = new Map();
  for (var i = 0; i < ins.length; i++) {
    inTotal += ins[i].amount; touch(ins[i]);
    var f = ins[i].from_id;
    if (!cIn.has(f)) cIn.set(f, { addr: f, total: 0n, count: 0 });
    var e1 = cIn.get(f); e1.total += ins[i].amount; e1.count++;
  }
  for (var j = 0; j < outs.length; j++) {
    outTotal += outs[j].amount; touch(outs[j]);
    var t = outs[j].to_id;
    if (!cOut.has(t)) cOut.set(t, { addr: t, total: 0n, count: 0 });
    var e2 = cOut.get(t); e2.total += outs[j].amount; e2.count++;
  }
  function top(m) {
    return Array.from(m.values()).sort(function (a, b) { return b.total > a.total ? 1 : -1; }).slice(0, 6);
  }
  return {
    addr: addr,
    inCount: ins.length, outCount: outs.length,
    inTotal: inTotal, outTotal: outTotal, net: inTotal - outTotal,
    firstBlock: firstBlock === Infinity ? null : firstBlock,
    lastBlock: lastBlock === 0 ? null : lastBlock,
    firstTs: firstTs, lastTs: lastTs,
    topSenders: top(cIn), topRecipients: top(cOut),
  };
}

/* ---- formatting ---- */
function fmtQTC(plancks, decimals) {
  var neg = plancks < 0n;
  var v = neg ? -plancks : plancks;
  var whole = v / PLANCKS_PER_QTC;
  var frac = v % PLANCKS_PER_QTC;
  var dec = decimals == null ? 4 : decimals;
  var f = frac.toString().padStart(12, "0").slice(0, dec).replace(/0+$/, "");
  var w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (f ? "." + f : "");
}

function shortAddr(a) {
  if (!a || a.length < 16) return a || "";
  return a.slice(0, 8) + "\u2026" + a.slice(-6);
}

function fmtTime(ts) {
  if (!ts) return "genesis (block 1)";
  var d = new Date(ts);
  return isNaN(d) ? String(ts) : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

var api = {
  PLANCKS_PER_QTC: PLANCKS_PER_QTC,
  validPlancks: validPlancks,
  nonNegInt: nonNegInt,
  parseHeight: parseHeight,
  parseableTs: parseableTs,
  sanitizeTransfer: sanitizeTransfer,
  sanitizeTransfers: sanitizeTransfers,
  sanitizeSnapshotMeta: sanitizeSnapshotMeta,
  buildGraph: buildGraph,
  trace: trace,
  aggregateEdges: aggregateEdges,
  layoutTrace: layoutTrace,
  detectPeelChains: detectPeelChains,
  detectFanOut: detectFanOut,
  detectFanIn: detectFanIn,
  roundAmountTransfers: roundAmountTransfers,
  minerForwarding: minerForwarding,
  summarizeAddress: summarizeAddress,
  fmtQTC: fmtQTC,
  shortAddr: shortAddr,
  fmtTime: fmtTime,
  XSTEP: XSTEP, YSTEP: YSTEP,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.QFlow = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
