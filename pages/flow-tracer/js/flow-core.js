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

var MAX_SUPPLY_PLANCKS = 21000000n * PLANCKS_PER_QTC; // 21M QTC hard cap
var GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z"); // chain genesis was 2026-09-09
var MAX_CHAIN_HEIGHT = 10000000; // fleet bound (validBlockHeight elsewhere)

function parseHeight(v) { // fleet chain height: indexer transfers live at 1..10,000,000
  var n = nonNegInt(v);
  return (n !== null && n >= 1 && n <= MAX_CHAIN_HEIGHT) ? n : null;
}

function parseableTs(v) {
  if (typeof v === "string" && v && Number.isFinite(Date.parse(v))) return v;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  return null;
}

/* Round 2 (2026-10-11): a present timestamp must sit inside the chain's
 * lifetime — a 2020 stamp predates genesis and a 2999 stamp defeats every
 * freshness notion; both are poison, not recoverable formatting. (A
 * MISSING timestamp stays recoverable: genesis rows carry none.)
 * Heights and amounts get the same treatment below: a transfer's height
 * is a fleet chain height (1..10,000,000), its amount a positive planck
 * count no larger than the 21M supply cap — 0-planck rows are not
 * transfers, and a 100M QTC row cannot exist on this chain. */
function chainLifetimeTs(v) {
  var ts = parseableTs(v);
  if (ts === null) return null;
  var ms = Date.parse(ts);
  if (ms < GENESIS_FLOOR_MS || ms > Date.now() + 3600000) return null;
  return ts;
}

/* Round 3 (2026-10-14): the extrinsic id is the indexer-written extrinsic
 * hash — 0x + 64 lowercase hex — optionally suffixed with the extrinsic's
 * own indexer id (same grammar as a transfer id), whose height segment
 * must then name THIS row's block: the transfer lives inside that
 * extrinsic, so they share a block. Verified on the real snapshot
 * (capture 221,996): 6,010 plain, 1 suffixed with a matching segment,
 * 101 null (genesis / system rows), 0 other shapes. Anything else is not
 * a value the producer writes; the field anchors no total here, so it
 * nulls (the round-1 recoverable convention) rather than dropping the row. */
var EXTRINSIC_RE = /^0x[0-9a-f]{64}(?:-(\d{10})-[0-9a-f]{5}-\d{6})?$/;
function cleanExtrinsicId(v, height) {
  if (typeof v !== "string" || !v) return null;
  var m = EXTRINSIC_RE.exec(v);
  if (!m) return null;
  if (m[1] != null && Number(m[1]) !== height) return null;
  return v;
}

function sanitizeTransfer(r, i) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  var amount = validPlancks(r.amount);
  if (amount === null || BigInt(amount) <= 0n || BigInt(amount) > MAX_SUPPLY_PLANCKS) return null; // core field
  var height = parseHeight(r.block_height);
  if (height === null) return null; // core field
  if (typeof r.from_id !== "string" || !r.from_id) return null;
  if (typeof r.to_id !== "string" || !r.to_id) return null;
  var fee = r.fee == null ? "0" : validPlancks(r.fee);
  if (fee === null) fee = "0"; // recoverable: anchors nothing in this app
  var ts = null;
  if (r.timestamp != null && parseableTs(r.timestamp) !== null) {
    ts = chainLifetimeTs(r.timestamp);
    if (ts === null) return null; // a parseable-but-impossible timestamp is poison (round 2);
    // an UNPARSEABLE one still coerces to null (round 1: it anchors no total)
  }
  var id = null;
  if (typeof r.id === "string" && r.id) id = r.id;
  else if (typeof r.id === "number" && Number.isFinite(r.id)) id = String(r.id);
  if (!id) id = "row-" + i + ":" + r.from_id + ">" + r.to_id + "@" + height + ":" + amount;
  return {
    id: id, amount: amount, from_id: r.from_id, to_id: r.to_id,
    block_height: height, timestamp: ts,
    fee: fee, extrinsic_id: cleanExtrinsicId(r.extrinsic_id, height),
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
  var captured = chainLifetimeTs(m.captured_at); // round 2: a real capture time, not any parseable date
  if (captured === null) return null;
  var out = { window_from: from, chain_height: head, captured_at: captured };
  // Round 2: the meta's redundant fields must restate the core fields
  // when present — window_blocks IS head - from by construction, and the
  // row counts are checked against the payload by the loader.
  if (m.window_blocks != null) {
    var wb = nonNegInt(m.window_blocks);
    if (wb === null || wb !== head - from) return null;
    out.window_blocks = wb;
  }
  if (m.transfers != null) {
    var tc = nonNegInt(m.transfers);
    if (tc === null) return null;
    out.transfers = tc;
  }
  if (m.genesis_rows != null) {
    var gr = nonNegInt(m.genesis_rows);
    if (gr === null) return null;
    out.genesis_rows = gr;
  }
  if (m.dust_threshold_planck != null) {
    var dt = validPlancks(m.dust_threshold_planck);
    if (dt === null || BigInt(dt) <= 0n) return null;
    out.dust_threshold_planck = dt;
  }
  return out;
}

var SS58_189_SHAPE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/; // strict shape (fleet standard; checksum lives in ss58.js)

/* Snapshot-row relations (round 2, 2026-10-11) — verified against the
 * live snapshot first (head 207,263: every one of 1,146 addresses matches
 * the strict SS58-189 shape, heights run 1..207,256 <= chain_height,
 * in-window rows are all >= the 1 QTC dust floor exactly, timestamps run
 * genesis..captured_at, meta.transfers restates the row count, and the
 * block-1 rows are exactly the 22 genesis transfers). The generic
 * sanitizer checks each row against itself; this layer checks rows
 * against the SNAPSHOT they claim to belong to:
 *   - both endpoints must be SS58-189-shaped (the graph's nodes are
 *     presented as chain addresses; "qzABC" is not one);
 *   - no row may sit above the snapshot's own chain_height, nor carry
 *     a timestamp after its capture time (5 min indexer slack);
 *   - rows inside the window owe the window's dust floor — the fetch
 *     query filters amount >= threshold, so a sub-floor in-window row
 *     is not window data;
 *   - a synthetic genesis-* row whose facts duplicate an indexer row is
 *     the SAME transfer twice: the fetch merge namespaced the genesis
 *     ids, so id-dedupe missed that the top-600 query already carried
 *     the 5,669,940 QTC vesting transfer — the live snapshot painted it
 *     twice (double totals, and the "largest organic move" quick pick
 *     pointed at the genesis duplicate). The indexer row (real
 *     timestamp) wins; the synthetic copy drops. */
function sanitizeSnapshotTransfers(rows, meta) {
  if (!meta) return [];
  var clean = sanitizeTransfers(rows);
  var capturedMs = Date.parse(meta.captured_at);
  var dust = meta.dust_threshold_planck != null ? BigInt(meta.dust_threshold_planck) : PLANCKS_PER_QTC;
  var genesisFacts = new Set();
  clean.forEach(function (r) {
    if (r.block_height === 1 && !r.id.startsWith("genesis-"))
      genesisFacts.add(r.from_id + ">" + r.to_id + "@1:" + r.amount);
  });
  var kept = clean.filter(function (r) {
    if (!SS58_189_SHAPE.test(r.from_id) || !SS58_189_SHAPE.test(r.to_id)) return false;
    if (r.block_height > meta.chain_height) return false;
    if (r.timestamp !== null && Date.parse(r.timestamp) > capturedMs + 300000) return false;
    if (r.block_height >= meta.window_from && BigInt(r.amount) < dust) return false;
    if (r.block_height === 1 && r.id.startsWith("genesis-") &&
        genesisFacts.has(r.from_id + ">" + r.to_id + "@1:" + r.amount)) return false;
    return true;
  });
  /* Round 3 (2026-10-14): id and block-time relations, both verified on
   * the real snapshot (capture 221,996) before being held:
   *   - a row's id must be one of the two producer grammars AND agree
   *     with its own fields: an indexer id <10-digit height>-<5 hex>-<6
   *     digits> embeds the block height it names (6,091/6,091 segments
   *     equal their row's height), and a synthetic genesis-N id exists
   *     only at block 1 (21/21). A row whose identity contradicts its
   *     block — or matches no grammar the producer writes — is not
   *     snapshot data (the generic path's synthetic "row-…" ids are
   *     minted in-memory only; they never appear in a written file).
   *   - a transfer's timestamp IS its block's timestamp: at any one
   *     height every non-null stamp is identical (0 conflicts across
   *     3,658 heights), and block time never runs backwards as height
   *     grows. A height carrying two different stamps has no agreed
   *     block time, and a height stamped earlier than a lower height
   *     breaks the chain's forward time — the timestamped rows at such
   *     heights drop (rows claiming no time, e.g. the synthetic genesis
   *     rows, stay; their facts are restated by the loader's genesis
   *     count check). */
  kept = kept.filter(function (r) {
    var m = INDEXER_ID_RE.exec(r.id);
    if (m) return Number(m[1]) === r.block_height;
    if (GENESIS_ID_RE.test(r.id)) return r.block_height === 1;
    return false;
  });
  var tsByHeight = new Map();
  kept.forEach(function (r) {
    if (r.timestamp === null) return;
    if (!tsByHeight.has(r.block_height)) tsByHeight.set(r.block_height, new Set());
    tsByHeight.get(r.block_height).add(r.timestamp);
  });
  var badTime = new Set(), agreed = new Map();
  tsByHeight.forEach(function (set, h) {
    if (set.size > 1) badTime.add(h);
    else agreed.set(h, Array.from(set)[0]);
  });
  var maxMs = -Infinity;
  Array.from(agreed.keys()).sort(function (a, b) { return a - b; }).forEach(function (h) {
    var ms = Date.parse(agreed.get(h));
    if (ms < maxMs) badTime.add(h);
    else maxMs = ms;
  });
  if (badTime.size) kept = kept.filter(function (r) {
    return r.timestamp === null || !badTime.has(r.block_height);
  });
  return kept;
}

var INDEXER_ID_RE = /^(\d{10})-[0-9a-f]{5}-\d{6}$/; // indexer transfer id; segment 1 is the block height
var GENESIS_ID_RE = /^genesis-\d+$/; // synthetic ids minted by fetch-flow-data.mjs for block-1 rows

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
  sanitizeSnapshotTransfers: sanitizeSnapshotTransfers,
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
