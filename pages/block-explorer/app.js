/* QTC Block Explorer — mainnet explorer for the Quantus post-quantum blockchain.
 * Data source (verified 2026-09-29): https://sqm.quantus.com/v1/graphql (public Subsquid indexer).
 * 1 QTC = 10^12 planck. All figures below are read from the indexer, never invented.
 */
(function(){
"use strict";

var ENDPOINT = "https://sqm.quantus.com/v1/graphql";
var REFRESH_MS = 15000;
var PLANCK = 1e12;

/* ---------------- pure helpers (Node-testable) ---------------- */

function esc(s){
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtInt(n){
  /* Counts and heights are unsigned integers on chain. A float, a
   * negative, or a non-numeric value is not a figure to floor or print —
   * it is malformed data, and renders as a dash, never as fact. */
  var v;
  if (typeof n === "number") v = n;
  else if (typeof n === "string" && /^\d+$/.test(n)) v = Number(n);
  else return "—";
  if (!isFinite(v) || Math.floor(v) !== v || v < 0) return "—";
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* planck string -> QTC, trimmed to 4 decimals */
function fmtQTC(planckStr){
  if (planckStr === null || planckStr === undefined) return "—";
  /* Planck amounts are unsigned integer strings. Anything else ("abc",
   * "1.5", "6.5e18") used to be mangled into a plausible-looking figure
   * ("0.abc"); it is malformed data and renders as a dash instead. */
  if (typeof planckStr === "number"){
    if (!isFinite(planckStr) || Math.floor(planckStr) !== planckStr || planckStr < 0) return "—";
    planckStr = String(planckStr);
  }
  if (!/^-?\d+$/.test(String(planckStr))) return "—";
  var neg = false, s = String(planckStr);
  if (s.charAt(0) === "-"){ neg = true; s = s.slice(1); }
  s = s.replace(/^0+/, "") || "0";
  var pad = s.length <= 12 ? ("000000000000" + s).slice(-12) : s.slice(-12);
  var whole = s.length <= 12 ? "0" : s.slice(0, -12);
  var frac = pad.replace(/0+$/, "");
  if (frac.length > 4) frac = frac.slice(0, 4);
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

function ageFmt(atMs, nowMs){
  var d = Math.max(0, (nowMs || Date.now()) - atMs);
  var s = Math.floor(d / 1000);
  if (s < 60) return s + "s ago";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function shortHash(h, head, tail){
  if (!h) return "—";
  head = head || 10; tail = tail || 8;
  if (h.length <= head + tail + 1) return h;
  return h.slice(0, head) + "…" + h.slice(-tail);
}

function isHex64(s){ return /^0x[0-9a-fA-F]{64}$/.test(s); }
function isQz(s){ return /^qz[a-zA-Z0-9]{40,50}$/.test(s); }
function isHeight(s){ return /^\d{1,10}$/.test(s); }

/* classify a search string -> route descriptor */
function detectQuery(q){
  q = String(q || "").trim();
  if (!q) return { kind: "empty" };
  if (isHeight(q)) return { kind: "block", key: q };
  if (isHex64(q)) return { kind: "hash", key: q.toLowerCase() };
  if (isQz(q)) return { kind: "account", key: q };
  return { kind: "unknown", key: q };
}

/* parse location hash -> route */
function parseRoute(hash){
  var h = String(hash || "").replace(/^#/, "");
  var m = h.match(/^\/?block\/(.+)$/);
  if (m) return { view: "block", key: decodeURIComponent(m[1]) };
  m = h.match(/^\/?extrinsic\/(.+)$/);
  if (m) return { view: "extrinsic", key: decodeURIComponent(m[1]) };
  m = h.match(/^\/?account\/(.+)$/);
  if (m) return { view: "account", key: decodeURIComponent(m[1]) };
  m = h.match(/^\/?hash\/(.+)$/);
  if (m) return { view: "hash", key: decodeURIComponent(m[1]) };
  return { view: "home", key: "" };
}

/* route descriptor -> hash path */
function routeFor(q){
  var d = detectQuery(q);
  if (d.kind === "block") return "#/block/" + d.key;
  if (d.kind === "hash") return "#/hash/" + d.key;
  if (d.kind === "account") return "#/account/" + d.key;
  return null;
}

/* pretty-print extrinsic args JSON, tolerant of junk */
function prettyArgs(args){
  if (!args) return "(no arguments)";
  try {
    var o = typeof args === "string" ? JSON.parse(args) : args;
    return JSON.stringify(o, null, 2);
  } catch (e){
    return String(args);
  }
}

/* ---------------- load-boundary validation ----------------
 * Indexer (GraphQL) responses are an untrusted boundary, exactly like the
 * fleet's snapshot files: every field a renderer dereferences is validated
 * before it is used, because the sinks differ per field — an unescaped
 * extrinsics count reached innerHTML verbatim (markup injection), a
 * garbage reward/amount was mangled by fmtQTC into a plausible figure
 * ("0.abc"), a garbage timestamp rendered literally as "Invalid Date",
 * a float/negative height was printed as fact and interpolated raw into
 * hrefs, and a null data payload threw a TypeError that the views then
 * misreported. Core objects (home stats, a block, an extrinsic, an
 * account's balances) fail honestly when malformed; row collections
 * (blocks, transfers, extrinsics, events) drop the poisoned rows and
 * render the survivors.
 *
 * Round 2 (relations, not just shapes — verified against live indexer
 * data at head 204,204 before coding): shapes alone still let a home
 * payload whose blocks head disagreed with its own stats paint, a
 * 999 QTC block reward (the emission schedule pays ~0.305) paint, a
 * transfer of 100M QTC (over the 21M hard cap) paint, an ascending or
 * future-dated block list paint as "latest", a transfer between two
 * strangers paint as the queried account's own history (rendered as an
 * outgoing payment from it), account balances summing past the supply
 * cap paint, duplicate extrinsic indices and events belonging to a
 * different block paint, and a block returned for a different height
 * than the one requested paint. The cleaners below therefore verify
 * relations: fleet validBlockHeight (1..10,000,000), timestamps inside
 * the chain's lifetime (genesis floor 2026-09-01, <= now+1h), strict
 * SS58-189 address shape (qz + 47 base58 chars — the loose isQz shape
 * stays ONLY for classifying user search input), every planck figure
 * within the 21M cap, rewards within the emission schedule (floor:
 * schedule - 0.01 rounding slack; sanity ceiling: schedule + 0.5, the
 * fleet bound from Network Dashboard), list limits (home 10/10,
 * account 25) respected, kept rows newest-first with duplicates
 * dropped, account transfers involving the queried account and not
 * above its last_updated height, and a block answer matching the key
 * it was asked for. Payload-level contradictions (head mismatch,
 * order broken, over-limit, a raw list that cleans to empty) fail the
 * whole payload honestly instead of painting a partial lie. */
var MAX_HEIGHT = 10000000;
var GENESIS_FLOOR_MS = Date.UTC(2026, 8, 1); // chain genesis: Sept 2026
var MAX_SUPPLY_PLANCKS = "21000000000000000000"; // 21M QTC hard cap, in planck
var ADDR_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/;
var HOME_LIMIT = 10, ACCOUNT_TX_LIMIT = 25;

function validCount(v){
  if (typeof v === "number") return (Number.isSafeInteger(v) && v >= 0) ? v : null;
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)){
    var n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}
/* Fleet validBlockHeight: a strict safe integer 1..10,000,000. Round
 * 1's validCount-based check accepted 0 (rejected separately), 2^53-1
 * and "007" — all of which painted as chain fact. */
function validHeight(v){
  var n = validCount(v);
  return (n !== null && n >= 1 && n <= MAX_HEIGHT) ? n : null;
}
function validPlanck(v){
  if (typeof v === "number") return (isFinite(v) && Math.floor(v) === v && v >= 0) ? String(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  return null;
}
/* Planck figure within the chain's hard cap, compared as BigInt so a
 * 20-digit string cannot round its way past the cap through Number. */
function planckWithinSupply(p){
  if (p === null) return null;
  return BigInt(p) <= BigInt(MAX_SUPPLY_PLANCKS) ? p : null;
}
/* A chain timestamp must be a time this chain could have produced:
 * at/after the genesis floor and at most an hour ahead of now. */
function validTimestamp(v, nowMs){
  if (typeof v !== "string") return null;
  var ms = Date.parse(v);
  if (!isFinite(ms)) return null;
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  return (ms >= GENESIS_FLOOR_MS && ms <= now + 3600000) ? v : null;
}
function validHashStr(v){
  return (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) ? v : null;
}
function validIdStr(v){
  return (typeof v === "string" && /^[\w-]+$/.test(v)) ? v : null;
}
function validName(v){
  return (typeof v === "string" && /^\w+$/.test(v)) ? v : null;
}
/* Strict SS58-189 shape for INDEXER DATA (the fleet ADDR_RE). User
 * search input keeps the looser isQz classifier; data rows must be
 * real base58 — the loose shape accepted 0/O/I/l, which base58 never
 * contains, and lengths no Quantus address has. */
function validAddress(v){
  return (typeof v === "string" && ADDR_RE.test(v)) ? v : null;
}
/* Emission relation (fleet formula, as in Network Dashboard): the
 * schedule pays (21M - supply)/50,000,000 with a 5.67M genesis mint —
 * ~0.3058 QTC at height 135,568, ~0.3054 at 204,204 — the indexer
 * rounds to 0.01 and fees only add (live fee blocks reach +0.07). */
function blockRewardEst(height){
  var remaining = (21000000 - 5670000) * Math.exp(-height / 50000000);
  return remaining / 50000000;
}
function rewardPlausible(height, rewardPlanckStr){
  var est = blockRewardEst(height);
  if (!isFinite(est)) return false;
  var qtc = Number(rewardPlanckStr) / PLANCK;
  return isFinite(qtc) && qtc >= est - 0.01 && qtc <= est + 0.5;
}

function cleanStats(raw){
  if (!raw || typeof raw !== "object") return null;
  var bh = validHeight(raw.block_height);
  var ac = validCount(raw.total_accounts);
  var ti = validCount(raw.total_immediate_transfers);
  var ts = validCount(raw.total_scheduled_transfers);
  if (bh === null || ac === null || ti === null || ts === null) return null;
  return { block_height: bh, total_accounts: ac, total_immediate_transfers: ti, total_scheduled_transfers: ts };
}

function cleanBlockRow(raw){
  if (!raw || typeof raw !== "object") return null;
  var height = validHeight(raw.height);
  var hash = validHashStr(raw.hash);
  var ts = validTimestamp(raw.timestamp);
  var reward = planckWithinSupply(validPlanck(raw.reward));
  if (height === null || hash === null || ts === null || reward === null) return null;
  if (!rewardPlausible(height, reward)) return null;
  if (validAddress(raw.mined_by_id || "") === null) return null;
  var cnt = null;
  if (raw.extrinsics_aggregate && raw.extrinsics_aggregate.aggregate)
    cnt = validCount(raw.extrinsics_aggregate.aggregate.count);
  return { height: height, hash: hash, timestamp: ts, reward: reward,
    mined_by_id: raw.mined_by_id, extrinsicsCount: cnt };
}

/* Round 3 (producer identity relations — verified live 2026-10-14):
 * a row's own indexer id names the block it belongs to. Transfer ids
 * are <10-digit zero-padded height>-<5 lowercase hex>-<6 digits> and
 * the height segment EQUALS block_height (200/200 sampled rows incl.
 * genesis); an extrinsic's block_id is <padded height>-<5 hex> and
 * its segment EQUALS block.height; and the extrinsic view's events
 * are queried BY extrinsic_id, so every real event restates the
 * queried id (the query now selects the field it filters on). A row
 * whose identity contradicts its claim painted as chain fact
 * pre-fix — a transfer could carry any string id at any height, an
 * extrinsic could name a different block than its own block object,
 * and a foreign or duplicated event painted on an extrinsic's page. */
var TRANSFER_ID_RE = /^(\d{10})-[0-9a-f]{5}-\d{6}$/;
var BLOCK_ID_RE = /^(\d{10})-[0-9a-f]{5}$/;

function cleanTransferRow(raw){
  if (!raw || typeof raw !== "object") return null;
  var id = validIdStr(raw.id);
  var amount = planckWithinSupply(validPlanck(raw.amount));
  var height = validHeight(raw.block_height);
  var ts = validTimestamp(raw.timestamp);
  if (id === null || amount === null || height === null || ts === null) return null;
  var idm = TRANSFER_ID_RE.exec(id);
  if (!idm || Number(idm[1]) !== height) return null;
  if (validAddress(raw.from_id || "") === null || validAddress(raw.to_id || "") === null) return null;
  if (raw.fee !== undefined && raw.fee !== null && planckWithinSupply(validPlanck(raw.fee)) === null) return null;
  return { id: id, amount: amount, from_id: raw.from_id, to_id: raw.to_id,
    block_height: height, timestamp: ts, fee: raw.fee };
}

function cleanExtrinsicRow(raw){
  if (!raw || typeof raw !== "object") return null;
  var id = validIdStr(raw.id) || validHashStr(raw.id);
  var idx = validCount(raw.index_in_block);
  var pallet = validName(raw.pallet);
  var call = validName(raw.call);
  var fee = planckWithinSupply(validPlanck(raw.fee));
  if (id === null || idx === null || pallet === null || call === null || fee === null) return null;
  if (typeof raw.success !== "boolean") return null;
  if (raw.signer_id !== null && raw.signer_id !== undefined && validAddress(raw.signer_id) === null) return null;
  return { id: id, index_in_block: idx, pallet: pallet, call: call,
    signer_id: raw.signer_id || null, success: raw.success, fee: fee, args: raw.args };
}

function cleanEventRow(raw){
  if (!raw || typeof raw !== "object") return null;
  var id = validIdStr(raw.id);
  var type = validName(raw.type);
  if (id === null || type === null) return null;
  if (raw.extrinsic_id !== null && raw.extrinsic_id !== undefined &&
      validIdStr(raw.extrinsic_id) === null && validHashStr(raw.extrinsic_id) === null) return null;
  return { id: id, type: type, extrinsic_id: raw.extrinsic_id || null };
}

function cleanBlock(raw){
  var base = cleanBlockRow(raw);
  if (!base) return null;
  if (!Array.isArray(raw.extrinsics) || !Array.isArray(raw.events)) return null;
  /* Relations inside the block: extrinsic indices are the block's
   * ordering (the query asks index-ascending) — a duplicate or
   * descending index is a second, conflicting claim about the same
   * slot, so the row drops; an event naming an extrinsic that is not
   * in this block does not belong to this block and drops; duplicate
   * event ids are one event. Live blocks start at index 1 (index 0
   * is not an extrinsic row in this indexer), so ascending-unique is
   * the relation, not 0-based contiguity. */
  var xts = [], lastIdx = -1, xtIds = {};
  raw.extrinsics.map(cleanExtrinsicRow).filter(Boolean).forEach(function(x){
    if (x.index_in_block <= lastIdx) return;
    lastIdx = x.index_in_block;
    xts.push(x); xtIds[x.id] = 1;
  });
  var evs = [], seenEv = {};
  raw.events.map(cleanEventRow).filter(Boolean).forEach(function(e){
    if (seenEv[e.id]) return;
    if (e.extrinsic_id !== null && !xtIds[e.extrinsic_id]) return;
    seenEv[e.id] = 1;
    evs.push(e);
  });
  base.extrinsics = xts;
  base.events = evs;
  return base;
}

function cleanExtrinsic(raw){
  var base = cleanExtrinsicRow(raw);
  if (!base) return null;
  var ts = validTimestamp(raw.timestamp);
  if (ts === null) return null;
  base.timestamp = ts;
  base.blockHeight = null;
  if (raw.block !== null && raw.block !== undefined){
    base.blockHeight = validHeight(raw.block && raw.block.height);
    if (base.blockHeight === null) return null;
  }
  /* block_id relation: when the indexer row carries a block_id, it
   * must be the producer form and, when the block object is present,
   * its height segment must restate that block's height — a block_id
   * naming a different block than the one displayed is a forged or
   * mismatched answer, and the extrinsic fails honestly. */
  if (raw.block_id !== null && raw.block_id !== undefined){
    var bm = (typeof raw.block_id === "string") ? BLOCK_ID_RE.exec(raw.block_id) : null;
    if (!bm) return null;
    if (base.blockHeight !== null && Number(bm[1]) !== base.blockHeight) return null;
    base.block_id = raw.block_id;
  }
  return base;
}

/* The extrinsic view's event list is a claim about ONE extrinsic —
 * the query filters event.extrinsic_id = the requested id, so a kept
 * event must restate that id (a foreign or block-level event painted
 * on the extrinsic's page pre-fix) and duplicate ids are one event.
 * A non-array payload is malformed wholesale, like the other views. */
function cleanExtrinsicEvents(rawList, xid){
  if (!Array.isArray(rawList)) return null;
  var out = [], seen = {};
  rawList.map(cleanEventRow).filter(Boolean).forEach(function(e){
    if (e.extrinsic_id !== xid) return;
    if (seen[e.id]) return;
    seen[e.id] = 1;
    out.push(e);
  });
  return out;
}

function cleanAccount(raw){
  if (!raw || typeof raw !== "object") return null;
  var free = planckWithinSupply(validPlanck(raw.free));
  var frozen = planckWithinSupply(validPlanck(raw.frozen));
  var reserved = planckWithinSupply(validPlanck(raw.reserved));
  if (free === null || frozen === null || reserved === null) return null;
  /* Relation: one account cannot hold more than will ever exist —
   * each field under the cap but a 22M total still painted pre-fix. */
  if (BigInt(free) + BigInt(frozen) + BigInt(reserved) > BigInt(MAX_SUPPLY_PLANCKS)) return null;
  var lastUpdated = null;
  if (raw.last_updated !== null && raw.last_updated !== undefined){
    lastUpdated = validHeight(raw.last_updated);
    if (lastUpdated === null) return null;
  }
  return { free: free, frozen: frozen, reserved: reserved, last_updated: lastUpdated,
    is_deposit_only: raw.is_deposit_only === true, is_guardian: raw.is_guardian === true,
    is_high_security: raw.is_high_security === true, is_multisig: raw.is_multisig === true };
}

/* Account view payload (vAccount): the transfers list is a claim
 * about THE QUERIED account — every kept row must involve it (a
 * stranger-to-stranger row painted as this account's outgoing payment
 * pre-fix), must not sit above the account record's own last_updated
 * height, must respect the query's limit:25 and run newest-first
 * (equal heights/timestamps within one block are normal), with
 * duplicate ids dropped. A raw list that cleans to empty is
 * malformed wholesale — the honest indexer error instead of a painted
 * "no transfers" — exactly the Wallet Activity round-2 rule. */
function cleanAccountData(d, id){
  if (!d || typeof d !== "object" || !Array.isArray(d.t)) return null;
  if (d.t.length > ACCOUNT_TX_LIMIT) return null;
  var a = null;
  if (d.a !== null && d.a !== undefined){
    a = cleanAccount(d.a);
    if (!a) return null;
  }
  var mined = (d.mined && d.mined.aggregate) ? validCount(d.mined.aggregate.count) : null;
  var txs = [], seen = {}, orderBroken = false;
  d.t.forEach(function(raw){
    if (orderBroken) return;
    var t = cleanTransferRow(raw);
    if (!t) return;
    if (t.from_id !== id && t.to_id !== id) return; // not this account's transfer
    if (a && a.last_updated !== null && t.block_height > a.last_updated) return;
    if (seen[t.id]) return;
    if (txs.length){
      var prev = txs[txs.length - 1];
      if (t.block_height > prev.block_height || Date.parse(t.timestamp) > Date.parse(prev.timestamp)){ orderBroken = true; return; }
    }
    seen[t.id] = 1;
    txs.push(t);
  });
  if (orderBroken) return null;
  if (d.t.length && !txs.length) return null;
  return { a: a, txs: txs, mined: mined };
}

/* Home payload: stats and lists are one answer about one chain
 * state. The blocks head must restate the stats height, both lists
 * must respect their limit:10, kept blocks must run strictly
 * newest-first in height AND time (duplicate height/hash rows are
 * one block, dropped), kept transfers must run newest-first (ties
 * inside one block are normal) and cannot sit above the stats head,
 * and a raw list that cleans to empty fails the payload — the stats
 * must not anchor on a list that was entirely poison. */
function cleanHome(d){
  if (!d || typeof d !== "object") return null;
  var stats = cleanStats(d.stats);
  if (!stats) return null;
  if (!Array.isArray(d.blocks) || !Array.isArray(d.transfers)) return null;
  if (d.blocks.length > HOME_LIMIT || d.transfers.length > HOME_LIMIT) return null;
  var rawHead = (d.blocks[0] && typeof d.blocks[0] === "object") ? validCount(d.blocks[0].height) : null;
  if (rawHead !== null && rawHead !== stats.block_height) return null;
  var blocks = [], seenH = {}, seenHash = {}, orderBroken = false;
  d.blocks.forEach(function(raw){
    if (orderBroken) return;
    var b = cleanBlockRow(raw);
    if (!b) return;
    if (b.height > stats.block_height) return;
    if (seenH[b.height] || seenHash[b.hash]) return;
    if (blocks.length){
      var prev = blocks[blocks.length - 1];
      if (b.height >= prev.height || Date.parse(b.timestamp) >= Date.parse(prev.timestamp)){ orderBroken = true; return; }
    }
    seenH[b.height] = 1; seenHash[b.hash] = 1;
    blocks.push(b);
  });
  if (orderBroken) return null;
  if (d.blocks.length && !blocks.length) return null;
  var txs = [], seenT = {};
  d.transfers.forEach(function(raw){
    if (orderBroken) return;
    var t = cleanTransferRow(raw);
    if (!t) return;
    if (t.block_height > stats.block_height) return;
    if (seenT[t.id]) return;
    if (txs.length){
      var prev = txs[txs.length - 1];
      if (t.block_height > prev.block_height || Date.parse(t.timestamp) > Date.parse(prev.timestamp)){ orderBroken = true; return; }
    }
    seenT[t.id] = 1;
    txs.push(t);
  });
  if (orderBroken) return null;
  if (d.transfers.length && !txs.length) return null;
  return { stats: stats, blocks: blocks, transfers: txs };
}

/* A block answer must be the block that was asked for: by height,
 * the returned height restates the key; by hash, the returned hash
 * restates it (case-insensitively — the query lowercases). */
function blockMatchesKey(b, key){
  if (!b || key === null || key === undefined) return false;
  var k = String(key);
  if (isHeight(k)) return b.height === Number(k);
  if (isHex64(k)) return typeof b.hash === "string" && b.hash.toLowerCase() === k.toLowerCase();
  return false;
}

var API = { esc: esc, fmtInt: fmtInt, fmtQTC: fmtQTC, ageFmt: ageFmt,
  shortHash: shortHash, isHex64: isHex64, isQz: isQz, isHeight: isHeight,
  detectQuery: detectQuery, parseRoute: parseRoute, routeFor: routeFor,
  prettyArgs: prettyArgs, validCount: validCount, validHeight: validHeight,
  validPlanck: validPlanck, validTimestamp: validTimestamp,
  cleanStats: cleanStats, cleanBlockRow: cleanBlockRow,
  cleanTransferRow: cleanTransferRow, cleanExtrinsicRow: cleanExtrinsicRow,
  cleanEventRow: cleanEventRow, cleanBlock: cleanBlock,
  cleanExtrinsic: cleanExtrinsic, cleanExtrinsicEvents: cleanExtrinsicEvents,
  cleanAccount: cleanAccount, cleanHome: cleanHome,
  validAddress: validAddress, rewardPlausible: rewardPlausible,
  blockRewardEst: blockRewardEst, cleanAccountData: cleanAccountData,
  blockMatchesKey: blockMatchesKey };
if (typeof module !== "undefined" && module.exports) module.exports = API;

/* ---------------- fetch layer ---------------- */

function gql(query){
  /* Test hook for headless QA (the sandbox has no network egress):
   * QA injects window.__qtx_mock = {ok:true,data:{...}} before load. */
  if (typeof window !== "undefined" && window.__qtx_mock){
    var m = window.__qtx_mock;
    return m.ok ? Promise.resolve(m.data) : Promise.reject(new Error(m.error || "mock indexer failure"));
  }
  var ctl = new AbortController();
  var timer = setTimeout(function(){ ctl.abort(); }, 15000);
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query }),
    signal: ctl.signal
  }).then(function(res){
    /* The timer stays armed until the body is parsed: clearing it here, when
     * the headers land, would leave res.json() with no timeout at all, so a
     * stalled body could hang every explorer view on "loading" forever. */
    if (!res.ok) throw new Error("indexer HTTP " + res.status);
    return res.json();
  }).then(function(json){
    clearTimeout(timer);
    if (!json || typeof json !== "object")
      throw new Error("indexer returned a malformed response");
    if (json.errors && json.errors.length)
      throw new Error("indexer: " + json.errors.map(function(e){ return e.message; }).join("; "));
    if (!json.data || typeof json.data !== "object")
      throw new Error("indexer returned no data");
    return json.data;
  }).catch(function(err){
    clearTimeout(timer);
    throw err;
  });
}

/* ---------------- dom ---------------- */

var view = (typeof document !== "undefined") ? document.getElementById("view") : null;
var chainHeightEl = (typeof document !== "undefined") ? document.getElementById("chainHeight") : null;
var chainBadge = (typeof document !== "undefined") ? document.getElementById("chainBadge") : null;

function setBadge(state, text){
  if (!chainBadge) return;
  chainBadge.classList.remove("live", "down");
  if (state === "live") chainBadge.classList.add("live");
  if (state === "down") chainBadge.classList.add("down");
  if (chainHeightEl) chainHeightEl.textContent = text;
}

function copyText(text, el){
  function done(){ if (el){ var o = el.textContent; el.textContent = "copied ✓"; setTimeout(function(){ el.textContent = o; }, 900); } }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); done();
  }
}

function bindCopies(root){
  var els = root.querySelectorAll("[data-copy]");
  for (var i = 0; i < els.length; i++){
    (function(el){
      el.addEventListener("click", function(ev){ ev.preventDefault(); copyText(el.getAttribute("data-copy"), el); });
    })(els[i]);
  }
}

function showError(title, msg, retryFn){
  view.innerHTML =
    '<div class="error-box"><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' +
    '<button class="btn" id="retryBtn">↻ Retry</button></div>';
  var b = document.getElementById("retryBtn");
  if (b && retryFn) b.addEventListener("click", retryFn);
  setBadge("down", "indexer unreachable");
}

function showLoading(label){
  view.innerHTML = '<div class="loading"><div class="spin"></div><br>' + esc(label || "querying the indexer…") + '</div>';
}

/* live "x ago" ticking for elements with data-ts */
function tickAges(root){
  var now = Date.now();
  var cells = (root || document).querySelectorAll("[data-ts]");
  for (var i = 0; i < cells.length; i++){
    var t = Date.parse(cells[i].getAttribute("data-ts"));
    if (!isNaN(t)) cells[i].textContent = ageFmt(t, now);
  }
}
if (typeof window !== "undefined") setInterval(function(){ tickAges(view); }, 10000);

/* ---------------- queries ---------------- */

var Q_HOME =
  'query { ' +
  'stats: chain_stats_by_pk(id: "global") { block_height total_accounts total_immediate_transfers total_scheduled_transfers } ' +
  'blocks: block(limit: 10, order_by: {height: desc}) { height hash timestamp reward mined_by_id extrinsics_aggregate { aggregate { count } } } ' +
  'transfers: transfer(limit: 10, order_by: {block_height: desc}) { id amount from_id to_id block_height timestamp } ' +
  '}';

function qBlock(key){
  var where = isHeight(key) ? 'where: {height: {_eq: ' + parseInt(key, 10) + '}}'
                            : 'where: {hash: {_eq: "' + key.toLowerCase() + '"}}';
  return 'query { b: block(' + where + ', limit: 1) { id height hash timestamp reward mined_by_id ' +
    'extrinsics(order_by: {index_in_block: asc}) { id index_in_block pallet call signer_id success fee args } ' +
    'events(order_by: {id: asc}) { id type extrinsic_id } } }';
}

function qExtrinsic(id){
  return 'query { x: extrinsic(where: {id: {_eq: "' + id + '"}}, limit: 1) { id index_in_block pallet call signer_id success fee args timestamp block_id block { height } } ' +
    'ev: event(where: {extrinsic_id: {_eq: "' + id + '"}}) { id type extrinsic_id } }';
}

function qAccount(id){
  return 'query { a: account_by_pk(id: "' + id + '") { id free frozen reserved is_deposit_only is_guardian is_high_security is_multisig last_updated } ' +
    't: transfer(where: {_or: [{from_id: {_eq: "' + id + '"}}, {to_id: {_eq: "' + id + '"}}]}, limit: 25, order_by: {block_height: desc}) { id amount from_id to_id block_height timestamp fee } ' +
    'mined: block_aggregate(where: {mined_by_id: {_eq: "' + id + '"}}) { aggregate { count } } }';
}

/* ---------------- views ---------------- */

var homeTimer = null;
function stopHomeTimer(){ if (homeTimer){ clearInterval(homeTimer); homeTimer = null; } }

function vHome(){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("querying the indexer…");
  function load(){
    gql(Q_HOME).then(function(d){
      if (!alive(my)) return;
      var clean = cleanHome(d);
      if (!clean) throw new Error("indexer returned malformed home data");
      var st = clean.stats;
      var blocks = clean.blocks;
      var txs = clean.transfers;
      setBadge("live", "height " + fmtInt(st.block_height));

      var statHtml =
        '<div class="stats">' +
        stat("Latest block", fmtInt(st.block_height), true) +
        stat("Accounts", fmtInt(st.total_accounts), false) +
        stat("Immediate transfers", fmtInt(st.total_immediate_transfers), false) +
        stat("Scheduled transfers", fmtInt(st.total_scheduled_transfers), false) +
        '</div>';

      var blockRows = blocks.map(function(b){
        var n = (b.extrinsicsCount === null || b.extrinsicsCount === undefined) ? "—" : String(b.extrinsicsCount);
        return '<tr>' +
          '<td class="num"><a class="hash" href="#/block/' + b.height + '">' + fmtInt(b.height) + '</a></td>' +
          '<td class="hash" data-copy="' + esc(b.hash) + '" title="Click to copy">' + esc(shortHash(b.hash)) + '</td>' +
          '<td class="age" data-ts="' + esc(b.timestamp) + '"></td>' +
          '<td class="num">' + esc(n) + '</td>' +
          '<td><a class="acct" href="#/account/' + esc(b.mined_by_id) + '">' + esc(shortHash(b.mined_by_id, 8, 6)) + '</a></td>' +
          '<td class="num">' + esc(fmtQTC(b.reward)) + '</td>' +
          '</tr>';
      }).join("");

      var txRows = txs.map(function(t){
        return '<tr>' +
          '<td class="hash" data-copy="' + esc(t.id) + '" title="Click to copy transfer id">' + esc(shortHash(t.id)) + '</td>' +
          '<td><a class="acct" href="#/account/' + esc(t.from_id) + '">' + esc(shortHash(t.from_id, 8, 6)) + '</a></td>' +
          '<td><a class="acct" href="#/account/' + esc(t.to_id) + '">' + esc(shortHash(t.to_id, 8, 6)) + '</a></td>' +
          '<td class="num"><a class="hash" href="#/block/' + t.block_height + '">' + fmtInt(t.block_height) + '</a></td>' +
          '<td class="num">' + esc(fmtQTC(t.amount)) + '</td>' +
          '<td class="age" data-ts="' + esc(t.timestamp) + '"></td>' +
          '</tr>';
      }).join("");

      view.innerHTML =
        '<section class="hero panel">' +
          '<div class="kicker">Quantus mainnet &middot; post-quantum PoW</div>' +
          '<h1>Follow every <span class="grad">quantum-signed</span> block.</h1>' +
          '<p>Search block heights, 0x hashes, and qz&hellip; addresses. Live data from the public Quantus indexer — block times, miner rewards, transfers, and account balances, straight off the chain.</p>' +
          '<form class="hero-search" id="heroSearch" autocomplete="off">' +
            '<input id="heroInput" type="text" spellcheck="false" placeholder="Block height · 0x hash · qz… address">' +
            '<button type="submit">Search</button>' +
          '</form>' +
          '<div class="hint-row">' +
            '<span class="hint" data-q="' + (st.block_height || "") + '">latest block</span>' +
            '<span class="hint" data-q="135564">block 135564</span>' +
            '<span class="hint" data-q="qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv">a miner address</span>' +
          '</div>' +
        '</section>' +
        statHtml +
        '<div class="two-col">' +
          '<div><div class="section-head"><h2>Latest blocks</h2><span class="updated" id="blkUpd"></span></div>' +
          '<div class="tbl-wrap"><table><thead><tr><th>Height</th><th>Hash</th><th>Age</th><th>Extr.</th><th>Miner</th><th style="text-align:right">Reward</th></tr></thead>' +
          '<tbody>' + (blockRows || '<tr><td colspan="6" class="empty">no blocks returned</td></tr>') + '</tbody></table></div></div>' +
          '<div><div class="section-head"><h2>Latest transfers</h2><span class="updated" id="txUpd"></span></div>' +
          '<div class="tbl-wrap"><table><thead><tr><th>ID</th><th>From</th><th>To</th><th>Block</th><th style="text-align:right">Amount</th><th>Age</th></tr></thead>' +
          '<tbody>' + (txRows || '<tr><td colspan="6" class="empty">no transfers returned</td></tr>') + '</tbody></table></div></div>' +
        '</div>' +
        '<p class="sub" style="margin-top:14px">Auto-refreshes every 15 seconds. Amounts in QTC; raw unit is planck (10<sup>12</sup> per QTC).</p>';

      bindCopies(view);
      tickAges(view);
      var upd = document.getElementById("blkUpd");
      if (upd) upd.textContent = "updated " + new Date().toLocaleTimeString();
      var upd2 = document.getElementById("txUpd");
      if (upd2) upd2.textContent = "updated " + new Date().toLocaleTimeString();
      var hs = document.getElementById("heroSearch");
      if (hs) hs.addEventListener("submit", onSearchSubmit);
      var hints = view.querySelectorAll(".hint");
      for (var i = 0; i < hints.length; i++){
        (function(el){ el.addEventListener("click", function(){ location.hash = routeFor(el.getAttribute("data-q")) || "#/"; }); })(hints[i]);
      }
    }).catch(function(err){
      if (!alive(my)) return;
      showError("Indexer unreachable", "Could not reach sqm.quantus.com: " + err.message + ". The chain keeps moving — try again in a moment.", load);
    });
  }
  load();
  homeTimer = setInterval(function(){ if (!document.hidden) load(); }, REFRESH_MS);
}

function stat(k, v, cyan){
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' + (cyan ? " cyan" : "") + '">' + esc(v) + '</div></div>';
}

function vBlock(key){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("loading block…");
  gql(qBlock(key)).then(function(d){
    if (!alive(my)) return;
    if (!d || !Array.isArray(d.b)) throw new Error("indexer returned malformed block data");
    var rawB = d.b[0] || null;
    if (!rawB){
      showError("Block not found", "No block matches “" + key + "” in the indexer. It may not be indexed yet, or the input may be off.", function(){ vBlock(key); });
      return;
    }
    var b = cleanBlock(rawB);
    if (!b) throw new Error("indexer returned malformed block data");
    if (!blockMatchesKey(b, key)) throw new Error("indexer returned malformed block data");
    setBadge("live", "height " + fmtInt(b.height));
    var xt = b.extrinsics || [];
    var ev = b.events || [];
    var evByXt = {};
    ev.forEach(function(e){ var k = e.extrinsic_id || "_block"; (evByXt[k] = evByXt[k] || []).push(e); });

    var xtRows = xt.map(function(x, i){
      var argsId = "args-" + i;
      return '<tr>' +
        '<td class="num">' + x.index_in_block + '</td>' +
        '<td><a class="hash" href="#/extrinsic/' + esc(x.id) + '">' + esc(x.pallet) + '.' + esc(x.call) + '</a></td>' +
        '<td>' + (x.signer_id ? '<a class="acct" href="#/account/' + esc(x.signer_id) + '">' + esc(shortHash(x.signer_id, 8, 6)) + '</a>' : '<span class="pill dim">inherent</span>') + '</td>' +
        '<td>' + (x.success ? '<span class="pill ok">ok</span>' : '<span class="pill bad">failed</span>') + '</td>' +
        '<td class="num">' + esc(fmtQTC(x.fee)) + '</td>' +
        '<td><button class="toggle-args" data-args="' + argsId + '">args ▾</button></td>' +
        '</tr>' +
        '<tr class="args-row" id="' + argsId + '" style="display:none"><td></td><td colspan="5"><div class="args-pre">' + esc(prettyArgs(x.args)) + '</div></td></tr>';
    }).join("");

    var evRows = ev.map(function(e){
      return '<div class="event-row"><span class="etype">' + esc(e.type) + '</span>' +
        '<span class="mono" style="color:var(--ink-faint)">' + esc(shortHash(e.id, 12, 6)) + '</span>' +
        (e.extrinsic_id ? '<a class="hash" href="#/extrinsic/' + esc(e.extrinsic_id) + '">extrinsic ↗</a>' : '<span class="pill dim">block-level</span>') +
        '</div>';
    }).join("");

    view.innerHTML =
      '<div class="navline">' +
        '<a class="btn ghost" href="#/">← home</a>' +
        '<a class="btn" href="#/block/' + (b.height - 1) + '">← ' + fmtInt(b.height - 1) + '</a>' +
        '<a class="btn" href="#/block/' + (b.height + 1) + '">' + fmtInt(b.height + 1) + ' →</a>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="kicker">Block</div><h2>#' + fmtInt(b.height) + '</h2>' +
        '<p class="sub">Hash <span class="mono copy" data-copy="' + esc(b.hash) + '" title="Click to copy">' + esc(b.hash) + '</span></p>' +
        '<div class="detail-grid">' +
          field("Height", fmtInt(b.height)) +
          field("Timestamp", esc(new Date(b.timestamp).toLocaleString()) + ' <span class="age" data-ts="' + esc(b.timestamp) + '"></span>') +
          field("Miner", '<a class="acct" href="#/account/' + esc(b.mined_by_id) + '">' + esc(b.mined_by_id) + '</a>') +
          field("Miner reward", '<span class="big">' + esc(fmtQTC(b.reward)) + ' QTC</span>') +
          field("Extrinsics", fmtInt(xt.length)) +
          field("Events", fmtInt(ev.length)) +
        '</div>' +
      '</div>' +
      '<div class="section-head"><h2>Extrinsics (' + xt.length + ')</h2></div>' +
      (xt.length
        ? '<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Call</th><th>Signer</th><th>Status</th><th style="text-align:right">Fee (QTC)</th><th></th></tr></thead><tbody>' + xtRows + '</tbody></table></div>'
        : '<div class="empty panel">Empty block — no extrinsics.</div>') +
      '<div class="section-head"><h2>Events (' + ev.length + ')</h2></div>' +
      (ev.length ? '<div class="event-list">' + evRows + '</div>' : '<div class="empty panel">No events recorded for this block.</div>');

    bindCopies(view);
    tickAges(view);
    var toggles = view.querySelectorAll(".toggle-args");
    for (var i = 0; i < toggles.length; i++){
      (function(btn){
        btn.addEventListener("click", function(){
          var row = document.getElementById(btn.getAttribute("data-args"));
          var open = row.style.display !== "none";
          row.style.display = open ? "none" : "";
          btn.textContent = open ? "args ▾" : "args ▴";
        });
      })(toggles[i]);
    }
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t load block", err.message, function(){ vBlock(key); });
  });
}

function field(k, v){ return '<div class="field"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }

function vExtrinsic(id){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("loading extrinsic…");
  gql(qExtrinsic(id)).then(function(d){
    if (!alive(my)) return;
    if (!d || !Array.isArray(d.x)) throw new Error("indexer returned malformed extrinsic data");
    var rawX = d.x[0] || null;
    if (!rawX){
      showError("Extrinsic not found", "No extrinsic matches “" + id + "”.", function(){ vExtrinsic(id); });
      return;
    }
    var x = cleanExtrinsic(rawX);
    if (!x) throw new Error("indexer returned malformed extrinsic data");
    if (x.id !== id) throw new Error("indexer returned malformed extrinsic data");
    var evs = cleanExtrinsicEvents(d.ev, id);
    if (!evs) throw new Error("indexer returned malformed extrinsic data");
    var height = x.blockHeight;
    var evRows = evs.map(function(e){
      return '<div class="event-row"><span class="etype">' + esc(e.type) + '</span><span class="mono" style="color:var(--ink-faint)">' + esc(shortHash(e.id, 12, 6)) + '</span></div>';
    }).join("");
    view.innerHTML =
      '<div class="navline"><a class="btn ghost" href="#/">← home</a>' +
      (height !== null ? '<a class="btn" href="#/block/' + height + '">block ' + fmtInt(height) + ' ↗</a>' : '') + '</div>' +
      '<div class="panel"><div class="kicker">Extrinsic</div>' +
      '<h2>' + esc(x.pallet) + '.' + esc(x.call) + '</h2>' +
      '<p class="sub">ID <span class="mono copy" data-copy="' + esc(x.id) + '" title="Click to copy">' + esc(x.id) + '</span></p>' +
      '<div class="detail-grid">' +
        field("Index in block", String(x.index_in_block)) +
        field("Signer", x.signer_id ? '<a class="acct" href="#/account/' + esc(x.signer_id) + '">' + esc(x.signer_id) + '</a>' : "— (inherent)") +
        field("Status", x.success ? '<span class="pill ok">succeeded</span>' : '<span class="pill bad">failed</span>') +
        field("Fee", '<span class="big">' + esc(fmtQTC(x.fee)) + ' QTC</span>') +
        field("Timestamp", esc(new Date(x.timestamp).toLocaleString()) + ' <span class="age" data-ts="' + esc(x.timestamp) + '"></span>') +
      '</div>' +
      '<div class="kicker" style="margin-top:18px">Arguments</div>' +
      '<div class="args-pre">' + esc(prettyArgs(x.args)) + '</div>' +
      '</div>' +
      '<div class="section-head"><h2>Events (' + evs.length + ')</h2></div>' +
      (evs.length ? '<div class="event-list">' + evRows + '</div>' : '<div class="empty panel">No events attached to this extrinsic.</div>');
    bindCopies(view);
    tickAges(view);
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t load extrinsic", err.message, function(){ vExtrinsic(id); });
  });
}

function vAccount(id){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("loading account…");
  gql(qAccount(id)).then(function(d){
    if (!alive(my)) return;
    var cleaned = cleanAccountData(d, id);
    if (!cleaned) throw new Error("indexer returned malformed account data");
    var a = cleaned.a;
    var txs = cleaned.txs;
    var mined = cleaned.mined;
    setBadge("live", "account lookup");

    var flags = [];
    if (a){
      if (a.is_guardian) flags.push('<span class="pill info">guardian</span>');
      if (a.is_high_security) flags.push('<span class="pill info">high-security</span>');
      if (a.is_multisig) flags.push('<span class="pill info">multisig</span>');
      if (a.is_deposit_only) flags.push('<span class="pill dim">deposit-only</span>');
    }

    var bal = a
      ? '<div class="detail-grid">' +
        field("Free", '<span class="big">' + esc(fmtQTC(a.free)) + ' QTC</span>') +
        field("Frozen", esc(fmtQTC(a.frozen)) + " QTC") +
        field("Reserved", esc(fmtQTC(a.reserved)) + " QTC") +
        field("Blocks mined", fmtInt(mined)) +
        '</div>' +
        (flags.length ? '<div class="flags">' + flags.join("") + '</div>' : '')
      : '<div class="empty">This address has no account record in the indexer yet — it has never transacted or mined on-chain.</div>';

    var txRows = txs.map(function(t){
      var incoming = t.to_id === id;
      return '<tr>' +
        '<td>' + (incoming ? '<span class="dir-in">← in</span>' : '<span class="dir-out">out →</span>') + '</td>' +
        '<td><a class="acct" href="#/account/' + esc(incoming ? t.from_id : t.to_id) + '">' + esc(shortHash(incoming ? t.from_id : t.to_id, 8, 6)) + '</a></td>' +
        '<td class="num">' + (incoming ? "+" : "−") + esc(fmtQTC(t.amount)) + '</td>' +
        '<td class="num"><a class="hash" href="#/block/' + t.block_height + '">' + fmtInt(t.block_height) + '</a></td>' +
        '<td class="age" data-ts="' + esc(t.timestamp) + '"></td>' +
        '</tr>';
    }).join("");

    view.innerHTML =
      '<div class="navline"><a class="btn ghost" href="#/">← home</a></div>' +
      '<div class="panel"><div class="kicker">Account</div>' +
      '<h2 class="mono" style="font-size:17px;word-break:break-all">' + esc(id) + '</h2>' +
      '<p class="sub"><button class="addr" data-copy="' + esc(id) + '">copy address</button></p>' +
      bal + '</div>' +
      '<div class="section-head"><h2>Transfers (' + txs.length + ' shown)</h2></div>' +
      (txs.length
        ? '<div class="tbl-wrap"><table><thead><tr><th>Dir</th><th>Counterparty</th><th style="text-align:right">Amount (QTC)</th><th>Block</th><th>Age</th></tr></thead><tbody>' + txRows + '</tbody></table></div>'
        : '<div class="empty panel">No transfers indexed for this address.</div>');

    bindCopies(view);
    tickAges(view);
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t load account", err.message, function(){ vAccount(id); });
  });
}

/* ---------------- hash resolver (0x could be block or extrinsic) ---------------- */

function vHash(key){
  stopHomeTimer();
  var my = ++viewSeq;
  showLoading("resolving hash…");
  gql('query { b: block(where: {hash: {_eq: "' + key + '"}}, limit: 1) { height } ' +
      'x: extrinsic(where: {id: {_eq: "' + key + '"}}, limit: 1) { id } }')
  .then(function(d){
    if (!alive(my)) return;
    if (!d || typeof d !== "object") throw new Error("indexer returned malformed hash data");
    var bh = (d.b && d.b[0]) ? validHeight(d.b[0].height) : null;
    if (bh !== null){ location.hash = "#/block/" + bh; return; }
    var xid = (d.x && d.x[0]) ? (validIdStr(d.x[0].id) || validHashStr(d.x[0].id)) : null;
    if (xid !== null){ location.hash = "#/extrinsic/" + xid; return; }
    showError("Hash not found", "“" + key + "” matches no indexed block or extrinsic. It may be from before the indexer's retention window, or mistyped.", function(){ vHash(key); });
  }).catch(function(err){
    if (!alive(my)) return;
    showError("Couldn’t resolve hash", err.message, function(){ vHash(key); });
  });
}

/* ---------------- search + router ---------------- */

function onSearchSubmit(ev){
  ev.preventDefault();
  var inp = ev.target.querySelector("input");
  var target = routeFor(inp.value);
  if (target) location.hash = target;
  else if (view) showError("Not a block, hash, or address",
    "Try a block height (e.g. 135564), a 64-hex 0x hash, or a qz… Quantus address.", function(){});
}

/* View generation guard: every route() bumps viewSeq; async continuations
 * that belong to an older view must not write into the current one. */
var viewSeq = 0;
function alive(my){ return my === viewSeq; }

function route(){
  var r = parseRoute(location.hash);
  if (r.view === "block") vBlock(r.key);
  else if (r.view === "extrinsic") vExtrinsic(r.key);
  else if (r.view === "account") vAccount(r.key);
  else if (r.view === "hash") vHash(r.key);
  else vHome();
}

if (typeof window !== "undefined"){
  var sf = document.getElementById("searchForm");
  if (sf) sf.addEventListener("submit", onSearchSubmit);
  window.addEventListener("hashchange", route);
  route();
}

})();
