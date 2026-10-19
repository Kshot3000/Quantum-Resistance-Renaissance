/* QTC Watchtower — core logic (pure, no DOM).
 *
 * The rule engine behind the watcher desk: planck math, transfer indexing,
 * balance lookups, and rule evaluation against live-first chain data.
 * Environment-agnostic: browser global QWATCH, Node module.exports.
 */
(function (global) {
"use strict";

var PLANCK_PER_QTC = 1000000000000n; // 1e12
var MAX_SEEN_IDS = 400;              // cap per stored id-set
var MAX_SUPPLY_PLANCKS = 21000000n * PLANCK_PER_QTC; // 21M QTC hard cap
var MAX_CHAIN_HEIGHT = 10000000;     // fleet bound on a plausible height
var GENESIS_FLOOR_MS = Date.UTC(2026, 8, 1); // 2026-09-01; genesis was 2026-09-09
var SS58_189_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/; // strict shape: qz + 47 base58

/* ---------- planck <-> QTC ---------- */

/* Amount-input length bound (white-hat): the regex below admits an
 * unbounded whole part and BigInt(parts[0]) converts it whole —
 * BigInt decimal conversion is superlinear (20M digits ~7.1 s
 * measured), so an over-long amount froze the parse. Cap 512 chars
 * (the fleet amount cap; the largest genuine amount string is 21
 * chars), refused on length alone before the regex/BigInt, in this
 * parser's throw convention, input never echoed. */
var MAX_AMOUNT_CHARS = 512;
function amountInputRoom(chars) {
  return typeof chars === "number" && isFinite(chars) && chars >= 0 && Math.floor(chars) === chars && chars <= MAX_AMOUNT_CHARS;
}

function parseQtcToPlancks(str) {
  // Accepts "1", "1.5", "0.000001", "1,234.5". Returns BigInt plancks. Throws on garbage.
  if (typeof str !== "string") throw new Error("amount must be a string");
  var s = str.trim().replace(/,/g, "");
  if (!amountInputRoom(s.length))
    throw new Error("amount is " + s.length + " characters — over the amount-input cap of " + MAX_AMOUNT_CHARS + " characters; refused before parsing");
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error("invalid QTC amount: " + str);
  var parts = s.split(".");
  var whole = BigInt(parts[0] || "0");
  var frac = (parts[1] || "").padEnd(12, "0");
  return whole * PLANCK_PER_QTC + BigInt(frac);
}

function formatQtc(plancks) {
  // BigInt plancks -> "1,234.5678" (up to 4 decimals, trimmed)
  var p = typeof plancks === "bigint" ? plancks : BigInt(String(plancks));
  var neg = p < 0n;
  if (neg) p = -p;
  var whole = p / PLANCK_PER_QTC;
  var frac = (p % PLANCK_PER_QTC).toString().padStart(12, "0").slice(0, 4).replace(/0+$/, "");
  var w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}

function formatAge(ms) {
  if (!(ms >= 0)) return "—";
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  var d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h";
}

function shortAddr(addr) {
  if (!addr || addr.length < 16) return addr || "—";
  return addr.slice(0, 8) + "…" + addr.slice(-6);
}

/* ---------- transfer indexing ---------- */

function indexTransfers(transfers) {
  // transfers: [{id, amount, from_id, to_id, block_height, timestamp, ...}]
  var byAddr = new Map();
  function push(addr, side, t) {
    var e = byAddr.get(addr);
    if (!e) { e = { "in": [], out: [] }; byAddr.set(addr, e); }
    e[side].push(t);
  }
  (transfers || []).forEach(function (t) {
    if (!t || typeof t !== "object") return;
    if (t.from_id) push(t.from_id, "out", t);
    if (t.to_id) push(t.to_id, "in", t);
  });
  byAddr.forEach(function (e) {
    e["in"].sort(function (a, b) { return b.block_height - a.block_height; });
    e.out.sort(function (a, b) { return b.block_height - a.block_height; });
  });
  return byAddr;
}

function addressActivity(byAddr, address) {
  var e = byAddr.get(address);
  if (!e) return { "in": [], out: [], count: 0, lastTs: null };
  var all = e["in"].concat(e.out);
  var lastTs = null;
  all.forEach(function (t) {
    if (t.timestamp && (!lastTs || t.timestamp > lastTs)) lastTs = t.timestamp;
  });
  return { "in": e["in"], out: e.out, count: all.length, lastTs: lastTs };
}

function buildBalanceMap(whalesTop) {
  // whales.json "top" rows -> Map address -> free plancks (BigInt).
  // A row anchors balance rules, so it must carry a strict SS58-189
  // address with a non-negative integer planck count — a negative
  // "balance" (BigInt accepts "-5") would fire balance_below on
  // fiction, and a free balance above the 21M supply cap is not a
  // balance at all. A duplicated address counts once: the first valid
  // row wins, so a poisoned second copy cannot overwrite a good one
  // (and a poisoned first copy cannot suppress a good second one,
  // because only validated rows are set).
  var m = new Map();
  (whalesTop || []).forEach(function (row) {
    if (!row || typeof row.address !== "string" || !SS58_189_RE.test(row.address)) return;
    if (m.has(row.address)) return;
    var v = validPlancks(row.free_plancks);
    if (v === null || v > MAX_SUPPLY_PLANCKS) return;
    m.set(row.address, v);
  });
  return m;
}

/* ---------- boundary validation (load + scan) ----------
 * Every payload the tower did not create itself — the localStorage state
 * and the chain payloads (indexer answer / committed snapshots) — is
 * validated here before it can anchor a render, a balance, or a rule
 * baseline. Classification per field: core (drop the row / the count is
 * unknown), poison (drop the row), absent-but-recoverable (coerce to a
 * safe neutral and let the next scan re-derive it). */

function parseHeight(v) {
  // Positive integer block height: number (integer) or pure-digit string.
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    var n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function nonNegInt(v) {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    var n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/* Float threshold gate (white-hat, Batch 199): the two float-measured
 * rule types (chain_stall minutes, balance_change percent) validated
 * with `parseFloat(thr) > 0` — but parseFloat("1e999") is Infinity and
 * Infinity > 0, so a rule could be ARMED with an infinite threshold
 * from the free-text form field, a backup import, or stored state, and
 * then NEVER fire (ageMs > Infinity and pct >= Infinity are both
 * always false): a stall/change alert silently disarmed while the UI
 * showed it armed. floatThreshold is the one gate every layer routes
 * through — form, stored-rule sanitizer, and the evaluators — and it
 * returns the finite positive number or null. A finite exponent form
 * ("1e2" = 100) stays valid, exactly as parseFloat read it before. */
function floatThreshold(v) {
  var n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).trim());
  return isFinite(n) && n > 0 ? n : null;
}

/* Integer-string length bound before BigInt (white-hat, Batch 195): the
 * digit grammar below admits an UNBOUNDED string and BigInt() converts it
 * whole BEFORE any range/supply check can refuse it — BigInt decimal
 * conversion is superlinear (2M digits ~7 s measured), so an over-long
 * value from an untrusted answer froze the tab at this validator. Cap
 * MAX_INT_CHARS = 512 (the fleet cap; the largest genuine chain integer
 * string is 39 digits, a u128), refused on length alone before the
 * regex/BigInt. */
var MAX_INT_CHARS = 512;
function validPlancks(v) {
  // Non-negative integer plancks as BigInt, or null. Strings must be pure
  // digits (BigInt alone accepts "-5" and throws on "12.5"/"1e3").
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && v.length <= MAX_INT_CHARS && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

function parseableTs(v) {
  return typeof v === "string" && isFinite(Date.parse(v)) ? v : null;
}

function eraTs(v) {
  // A timestamp string that could be a producer stamp of this chain's
  // era: parseable AND inside [genesis floor, now + 1h skew] — the
  // chainTimeMs window sanitizeAlerts already holds. Round 4: the
  // stamps whose only producers stamp "now" (watchlist addedAt, the
  // stored lastScan, the snapshots' fetched_at) held only parseableTs,
  // so a 2020 or 2999 stamp survived as fact — a 2999 lastScan painted
  // "Last scan: just now" forever and a 2999 fetched_at defeated the
  // snapshot-staleness badge. Returns the string verbatim or null.
  return chainTimeMs(v) !== null ? v : null;
}

function validChainHeight(v) {
  // A height the chain could actually be at: parseHeight plus the
  // fleet 10,000,000 ceiling — 99,999,999,999 parses fine and painted
  // as chain fact in round 1.
  var h = parseHeight(v);
  return h !== null && h <= MAX_CHAIN_HEIGHT ? h : null;
}

function chainTimeMs(v) {
  // Milliseconds of a timestamp that could be a chain time: parseable
  // AND inside the chain's lifetime (genesis floor 2026-09-01, now+1h
  // ceiling with 1h clock skew tolerated). A parseable 2020 stamp is
  // not a chain time, and a 2999 stamp is not either — round 1's
  // parseable-only check let the first fire instant false chain_stall
  // alerts and the second disable stall detection forever.
  if (typeof v !== "string") return null;
  var ms = Date.parse(v);
  if (!isFinite(ms)) return null;
  return ms >= GENESIS_FLOOR_MS && ms <= Date.now() + 3600000 ? ms : null;
}

var HASH32_RE = /^0x[0-9a-fA-F]{64}$/;

function sanitizeBlocks(rows) {
  // Only blocks whose height AND timestamp both validate may anchor
  // the head / stall math; hash and reward are kept only when
  // well-formed. Round 2 validates the RELATIONS between blocks, all
  // verified on live data (live.json runs strictly newest-first,
  // timestamps monotonic in height, inside the chain's lifetime):
  // heights are bounded (validChainHeight), timestamps must be real
  // chain times (chainTimeMs — a 2020 head stamp fired instant false
  // chain_stall alerts, a 2999 stamp disabled stall detection
  // forever), a duplicated height counts once, the result is sorted
  // newest-first so blocks[0] IS the head even when the payload
  // arrives shuffled (round 1 trusted input order, so an ascending
  // list made the OLDEST block the head), and a block whose timestamp
  // contradicts the height order (later than a higher block's) drops.
  // Dedupe happens after validation, so a poisoned first copy of a
  // height cannot suppress a good second one. An over-cap reward is
  // an annotation, not core: it coerces to null, the block survives.
  if (!Array.isArray(rows)) return [];
  var byHeight = new Map();
  rows.forEach(function (b) {
    if (!b || typeof b !== "object") return;
    var h = validChainHeight(b.height);
    if (h === null) return;
    var ms = chainTimeMs(b.timestamp);
    if (ms === null) return;
    if (byHeight.has(h)) return;
    var reward = validPlancks(b.reward);
    byHeight.set(h, {
      height: h, timestamp: b.timestamp, ms: ms,
      hash: typeof b.hash === "string" && HASH32_RE.test(b.hash) ? b.hash : null,
      reward: reward !== null && reward <= MAX_SUPPLY_PLANCKS ? reward.toString() : null,
    });
  });
  var sorted = Array.from(byHeight.values()).sort(function (a, b) { return b.height - a.height; });
  var out = [], lastMs = Infinity;
  sorted.forEach(function (b) {
    if (b.ms > lastMs) return; // timestamp contradicts the height order
    lastMs = b.ms;
    out.push({ height: b.height, timestamp: b.timestamp, hash: b.hash, reward: b.reward });
  });
  return out;
}

function resolveHead(blocks, status) {
  // The head is the one fact the stall math and the head readout both
  // anchor on, and the payload carries it TWICE: status.block_height
  // and blocks[0]. Round 1 never looked at the status, so the two
  // reads could disagree and the block list's version painted as
  // chain fact. When a status is present it must restate the head
  // exactly (a bounded height equal to blocks[0]); any disagreement —
  // or an unparseable / out-of-bound status — trusts NEITHER read and
  // the head is unknown (null), never a guess. An absent status
  // leaves the validated blocks to decide alone.
  if (!Array.isArray(blocks) || !blocks.length) return null;
  var head = blocks[0];
  if (status && typeof status === "object") {
    var sh = validChainHeight(status.block_height);
    if (sh === null || sh !== head.height) return null;
  }
  return head;
}

function sanitizeTransfers(rows, maxHeight) {
  // A transfer row anchors rule evaluation and the pulse table: id,
  // from/to, a non-negative integer amount, and an integer block
  // height are core — a row missing any of them is dropped, never
  // repaired into a plausible-looking transfer. A garbage timestamp
  // is recoverable (sorting and ages use block height), so it coerces
  // to null. Round 2 validates the RELATIONS, all verified on live
  // data (5,300/5,300 flows rows pass with zero drops): the amount is
  // positive and within the 21M supply cap (a 0-planck row and a 100M
  // QTC row both painted in round 1), the height is a real chain
  // height and — when the caller knows the snapshot's own head
  // (maxHeight, from flows meta chain_height) — not above it, both
  // endpoints match the strict SS58-189 shape (a non-address endpoint
  // anchored the rollup in round 1), a PRESENT timestamp must be a
  // real chain time (2020 pre-genesis / 2999 drops the row; only the
  // unparseable still coerces to null), and ids dedupe AFTER
  // validation so a duplicated id counts once and a poisoned first
  // copy cannot suppress a good second one.
  if (!Array.isArray(rows)) return [];
  var capH = validChainHeight(maxHeight);
  var out = [], seen = {};
  rows.forEach(function (t) {
    if (!t || typeof t !== "object") return;
    if (typeof t.id !== "string" || !t.id) return;
    if (typeof t.from_id !== "string" || !SS58_189_RE.test(t.from_id)) return;
    if (typeof t.to_id !== "string" || !SS58_189_RE.test(t.to_id)) return;
    var amt = validPlancks(t.amount);
    if (amt === null || amt <= 0n || amt > MAX_SUPPLY_PLANCKS) return;
    var h = validChainHeight(t.block_height);
    if (h === null) return;
    if (capH !== null && h > capH) return;
    var ts = null;
    if (t.timestamp != null) {
      if (parseableTs(t.timestamp) !== null) {
        if (chainTimeMs(t.timestamp) === null) return; // present but impossible
        ts = t.timestamp;
      }
    }
    if (seen[t.id]) return;
    seen[t.id] = true;
    out.push({
      id: t.id, amount: amt.toString(), from_id: t.from_id, to_id: t.to_id,
      block_height: h, timestamp: ts,
      extrinsic_id: typeof t.extrinsic_id === "string" ? t.extrinsic_id : null,
    });
  });
  return out;
}

var UPGRADE_ID_RE = /^\d{10}-[0-9a-f]{5}-\d{6}$/; // runtime_upgrade id (extrinsic-id grammar)
var UPGRADE_BLOCK_RE = /^\d{10}-[0-9a-f]{5}$/;    // its block_id prefix

function sanitizeGovernance(data) {
  // Returns { referenda, upgrades, upgradesList } or null when the
  // payload's counts cannot be known. A FAILED governance load must read
  // as UNKNOWN — counting it as 0 resets the chain baselines, and the
  // next good scan then fires false "new referendum" alerts.
  // Round 5 (governance-count relations): the producer
  // (fetch-governance-data.mjs) writes data.referenda as
  // tech_referendum_event LIFECYCLE rows — SUBMITTED, DECISION_STARTED,
  // CONFIRM_STARTED, CONFIRMED, ... — so one referendum produces many
  // rows (verified on the real snapshot: 4 event rows, distinct
  // referendum_index {0} — ONE referendum). Counting rows painted
  // "Referenda: 4" and armed the new_referendum baseline with the EVENT
  // count, so a stage transition of an existing referendum (a 5th event
  // row) fired a false "new referendum" alert, indistinguishable from a
  // genuinely new referendum's SUBMITTED row. The count is now the
  // DISTINCT referendum_index set. Every event row must carry a valid
  // index (non-negative, under the gov ceiling): a row without one is
  // evidence the payload is not the producer's, so the count is UNKNOWN
  // (null), never a guess — guessing low resets the baseline and the
  // next good scan fires falsely, the exact failure this boundary
  // exists to prevent. Upgrades get the same treatment: a
  // runtime_upgrade row is {id, block_id, timestamp} in the extrinsic-id
  // grammar with block_id the id's own prefix and a chain-era timestamp;
  // any other row makes the count unknown, and exact duplicate ids
  // dedupe first-wins (the same upgrade restated is one upgrade).
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.referenda) || !Array.isArray(data.upgrades)) return null;
  var seenRef = {}, refs = 0;
  for (var i = 0; i < data.referenda.length; i++) {
    var r = data.referenda[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    var idx = nonNegInt(r.referendum_index);
    if (idx === null || idx > MAX_GOV_COUNT) return null;
    if (!seenRef[idx]) { seenRef[idx] = true; refs++; }
  }
  var ups = [], seenUp = {};
  for (var j = 0; j < data.upgrades.length; j++) {
    var u = data.upgrades[j];
    if (!u || typeof u !== "object" || Array.isArray(u)) return null;
    if (typeof u.id !== "string" || !UPGRADE_ID_RE.test(u.id)) return null;
    if (typeof u.block_id !== "string" || !UPGRADE_BLOCK_RE.test(u.block_id)) return null;
    if (u.id.slice(0, u.block_id.length + 1) !== u.block_id + "-") return null;
    if (chainTimeMs(u.timestamp) === null) return null;
    if (seenUp[u.id]) continue;
    seenUp[u.id] = true;
    ups.push({ spec_version: nonNegInt(u.spec_version) });
  }
  return { referenda: refs, upgrades: ups.length, upgradesList: ups };
}

function sanitizeIdList(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  v.forEach(function (id) {
    if (typeof id === "string" && id && out.indexOf(id) === -1) out.push(id);
  });
  return out.length > MAX_SEEN_IDS ? out.slice(out.length - MAX_SEEN_IDS) : out;
}

var MAX_GOV_COUNT = 1000000; // plausible ceiling for referenda/upgrade counts

function govCount(v) {
  if (v == null) return null;
  var n = nonNegInt(v);
  return n !== null && n <= MAX_GOV_COUNT ? n : null;
}

function sanitizeBaselines(raw) {
  var out = { addresses: {}, chain: blankChainBaseline() };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.addresses && typeof raw.addresses === "object" && !Array.isArray(raw.addresses)) {
    Object.keys(raw.addresses).forEach(function (addr) {
      // Round 3 relations: a baseline is keyed by a real Quantus
      // account — a garbage key is not an address baseline at all and
      // would persist forever, since evaluateRules only ever advances
      // baselines for ruled (watched, validated) addresses.
      if (!SS58_189_RE.test(addr)) return;
      var b = raw.addresses[addr];
      if (!b || typeof b !== "object") return;
      // A poisoned balance coerces to null (unknown): the next scan
      // re-baselines instead of throwing BigInt() on every scan forever.
      // A balance above the whole 21M supply is poison of the same
      // kind, not a balance the chain could ever report.
      var bal = b.balance == null ? null : validPlancks(b.balance);
      out.addresses[addr] = {
        balance: bal !== null && bal <= MAX_SUPPLY_PLANCKS ? bal.toString() : null,
        seenIn: sanitizeIdList(b.seenIn),
        seenOut: sanitizeIdList(b.seenOut),
      };
    });
  }
  if (raw.chain && typeof raw.chain === "object" && !Array.isArray(raw.chain)) {
    out.chain = {
      referenda: govCount(raw.chain.referenda),
      upgrades: govCount(raw.chain.upgrades),
      // The stall head is a chain height, held to the same fleet
      // ceiling as every other height (parseHeight alone admitted
      // 99,999,999,999, which no scan could ever re-arm against).
      stallFiredHead: raw.chain.stallFiredHead == null ? null : validChainHeight(raw.chain.stallFiredHead),
      seenWhale: sanitizeIdList(raw.chain.seenWhale),
    };
  }
  return out;
}

var MAX_ALERTS = 500; // scanNow slices the live feed to the same cap

function sanitizeAlerts(raw) {
  // Stored alerts are rendered and counted: an entry survives only with
  // a string id and a parseable timestamp (its age is displayed). A bad
  // severity is recoverable (coerce to info) and a non-string address is
  // an annotation (coerce to null) — neither may brick the feed.
  // Round 3 relations: alert ids are the feed's identity (read toggles
  // and scan dedupe match on id), so duplicates count once, first
  // wins; the timestamp is a scan time, so it must be a real chain-era
  // time (chainTimeMs) — a parseable 2020 or 2999 stamp is not an
  // alert this tower could have produced; a present address must be a
  // Quantus address (producers only ever alert on watched addresses or
  // null), anything else coerces to null; title/detail are capped at
  // generous multiples of anything the producers write; and the feed
  // is capped at MAX_ALERTS, the same cap the scan path applies.
  if (!Array.isArray(raw)) return [];
  var out = [], seen = {};
  raw.forEach(function (a) {
    if (!a || typeof a !== "object") return;
    if (typeof a.id !== "string" || !a.id) return;
    if (seen[a.id]) return;
    if (typeof a.title !== "string" || typeof a.detail !== "string") return;
    if (chainTimeMs(a.ts) === null) return;
    seen[a.id] = true;
    out.push({
      id: a.id,
      ruleId: typeof a.ruleId === "string" ? a.ruleId.slice(0, 100) : null,
      address: typeof a.address === "string" && SS58_189_RE.test(a.address) ? a.address : null,
      severity: ["info", "warn", "crit"].indexOf(a.severity) !== -1 ? a.severity : "info",
      title: a.title.slice(0, 200), detail: a.detail.slice(0, 1000), ts: a.ts,
      read: a.read === true,
      synthetic: a.synthetic === true ? true : undefined,
    });
  });
  return out.slice(0, MAX_ALERTS);
}

var MAX_WATCHLIST = 500;

function sanitizeWatchlist(rows, validateFn) {
  // The watchlist is persisted state with a producer relation per
  // field (round 3): the add form validates the address at full grade
  // (SS58 checksum + prefix 189 + 32-byte key, via the validateFn the
  // app supplies; the strict SS58-189 shape is the fallback when no
  // validator is available), caps nick at the form's maxlength 40 and
  // note at 140, and the checkphrase is a DERIVED field of exactly 5
  // words — any other shape is not a phrase the derivation could have
  // produced, so it nulls and the app re-derives it (a wrong-length
  // stored phrase used to paint forever, since only null backfilled).
  // Addresses dedupe first-wins (the form refuses duplicates) and the
  // list is capped, since every entry renders and scans.
  if (!Array.isArray(rows)) return [];
  var out = [], seen = {};
  rows.forEach(function (x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return;
    var addr = null;
    if (typeof validateFn === "function") {
      var v = validateFn(x.address);
      if (!v || !v.ok) return;
      addr = v.address;
    } else {
      if (typeof x.address !== "string" || !SS58_189_RE.test(x.address)) return;
      addr = x.address;
    }
    if (seen[addr]) return;
    seen[addr] = true;
    var phrase = null;
    if (Array.isArray(x.checkphrase) && x.checkphrase.length === 5 &&
        x.checkphrase.every(function (w) { return typeof w === "string" && w; })) {
      phrase = x.checkphrase.slice();
    }
    out.push({
      address: addr,
      nick: typeof x.nick === "string" ? x.nick.slice(0, 40) : "",
      note: typeof x.note === "string" ? x.note.slice(0, 140) : "",
      addedAt: eraTs(x.addedAt), // producer stamps now: era window, not mere parseability (round 4)
      checkphrase: phrase, // null -> re-derived at init
    });
  });
  return out.slice(0, MAX_WATCHLIST);
}

/* Room left under the watchlist cap. The cap must hold at CREATION, not
 * only in sanitizeWatchlist at load: the add form and the backup importer
 * both create entries, and an entry created past the cap is silently
 * trimmed on the next load — after the import toast claimed it, and after
 * the app paid a 40,000-iteration checkphrase derivation for it. Every
 * creation path asks this gate first (the Ledger eventRoom rule). */
function watchRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) n = 0;
  return Math.max(0, MAX_WATCHLIST - n);
}

var MAX_RULES = 500;

/* Room left under the rule cap. Rules had NO cap on any path while the
 * watchlist beside them was capped everywhere: the load repair sanitized
 * and deduped stored rules but never sliced, the backup importer pushed
 * every distinct rule (with an O(n*m) dedupe scan over the growing list —
 * a 20,000-rule backup burned ~2s in Node before the browser even
 * rendered), and the rule form pushed uncapped. Every scan then ran
 * evaluateRules over all rules and renderRules mapped all of them to
 * DOM. The cap must hold at CREATION (form + importer) and at LOAD
 * (repair slice), exactly like watchRoom (the Ledger eventRoom rule). */
function ruleRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) n = 0;
  return Math.max(0, MAX_RULES - n);
}

/* ---------- backup file size gate ----------
 * The backup importer used to readAsText the WHOLE picked file and
 * JSON.parse it before any cap was consulted, then pay an SS58 decode
 * (base58 + blake2b-512) for EVERY watchlist row and rule inside it
 * before watchRoom/ruleRoom were asked — a wrong pick (a log, a disk
 * image, a crafted million-row file) froze or OOM-killed the tab.
 * Everything a genuine backup can carry is producer-bounded: the
 * exporter writes {watchlist, rules, baselines} where the watchlist
 * caps at 500 entries (49-char address, nick 40, note 140, a
 * 5-word checkphrase of at most 14 chars per word), rules cap at
 * 500, and baselines hold at most 500 address entries whose seenIn /
 * seenOut lists cap at MAX_SEEN_IDS=400 distinct indexer transfer
 * ids (23 chars each) plus one chain seenWhale list of the same.
 * Measured with this module's own sanitizers: the largest backup the
 * exporter can produce serializes to 15,285,312 bytes as
 * JSON.stringify(payload, null, 2) writes it, and 15,735,312 bytes
 * even when every nick/note character needs JSON's worst 6-byte
 * escaping — so the bound must come from the PRODUCER (baselines
 * dominate it), not from what the importer keeps (the importer drops
 * baselines entirely). File.size is known before a byte is read: the
 * importer asks this fail-closed gate first and refuses over-cap
 * picks unread. 32 MiB is ~2x the worst-escaping maximum. */
var MAX_BACKUP_FILE_BYTES = 32 * 1024 * 1024;
function backupFileRoom(size) {
  return typeof size === "number" && isFinite(size) && size >= 0 && size <= MAX_BACKUP_FILE_BYTES;
}

/* ---------- rules ---------- */

var RULE_TYPES = {
  balance_below:  { scope: "address", label: "Balance drops below",   unit: "QTC" },
  balance_above:  { scope: "address", label: "Balance rises above",    unit: "QTC" },
  balance_change: { scope: "address", label: "Balance moves by",       unit: "% or QTC" },
  incoming_ge:    { scope: "address", label: "Incoming transfer ≥",    unit: "QTC" },
  outgoing_ge:    { scope: "address", label: "Outgoing transfer ≥",     unit: "QTC" },
  activity:       { scope: "address", label: "Any new activity",       unit: "" },
  whale_ge:       { scope: "chain",   label: "Whale transfer ≥",       unit: "QTC" },
  new_referendum: { scope: "chain",   label: "New governance referendum", unit: "" },
  new_upgrade:    { scope: "chain",   label: "New runtime upgrade",     unit: "" },
  chain_stall:    { scope: "chain",   label: "No new block for",       unit: "minutes" },
};

function defaultThreshold(type) {
  switch (type) {
    case "balance_below": case "balance_above": return "100";
    case "balance_change": return "10";
    case "incoming_ge": case "outgoing_ge": return "1000";
    case "whale_ge": return "50000";
    case "chain_stall": return "30";
    default: return "";
  }
}

function ruleLabel(rule) {
  var t = RULE_TYPES[rule.type];
  if (!t) return rule.type;
  var s = t.label;
  if (rule.threshold != null && rule.threshold !== "") {
    if (rule.type === "balance_change" && rule.changeMode === "pct") s += " " + rule.threshold + "%";
    else if (rule.type === "balance_change") s += " " + rule.threshold + " QTC";
    else if (rule.type === "chain_stall") s += " " + rule.threshold + " min";
    else s += " " + rule.threshold + " QTC";
  }
  return s;
}

/* Baselines live under state.baselines:
 *   addresses: { [addr]: { balance: "plancks"|null, seenIn: [ids], seenOut: [ids] } }
 *   chain: { referenda: n|null, upgrades: n|null, stallFiredHead: n|null, seenWhale: [ids] }
 */
function blankChainBaseline() {
  return { referenda: null, upgrades: null, stallFiredHead: null, seenWhale: [] };
}
function blankAddressBaseline() {
  return { balance: null, seenIn: [], seenOut: [] };
}
function ensureBaselines(baselines) {
  // Baselines are persisted state: sanitize on every evaluation so a
  // poisoned stored baseline can never throw inside a rule (BigInt on a
  // garbage balance wedged every scan) or masquerade as chain fact.
  return sanitizeBaselines(baselines);
}

function pushSeen(arr, id) {
  if (arr.indexOf(id) === -1) {
    arr.push(id);
    if (arr.length > MAX_SEEN_IDS) arr.splice(0, arr.length - MAX_SEEN_IDS);
  }
}

function alertId(parts) {
  return parts.join("|");
}

/* Evaluate ONE address-scoped rule. Returns {alerts, baseline} (baseline mutated+returned). */
function evalAddressRule(rule, address, baseline, ctx) {
  // ctx: { balance: BigInt|null, act: {in,out}, nowMs }
  var alerts = [];
  var th;
  function mk(title, detail, idSuffix) {
    alerts.push({
      id: alertId([rule.id, idSuffix]),
      ruleId: rule.id, address: address,
      severity: rule.severity || "info",
      title: title, detail: detail,
      ts: new Date(ctx.nowMs).toISOString(),
    });
  }
  switch (rule.type) {
    case "balance_below":
    case "balance_above": {
      if (ctx.balance == null) break;
      th = parseQtcToPlancks(rule.threshold);
      var wasKnown = baseline.balance != null;
      var wasBelow = wasKnown && BigInt(baseline.balance) < th;
      var wasAbove = wasKnown && BigInt(baseline.balance) >= th;
      var isBelow = ctx.balance < th;
      if (rule.type === "balance_below" && isBelow && (!wasKnown || wasAbove)) {
        mk("Balance below " + rule.threshold + " QTC",
           shortAddr(address) + " now holds " + formatQtc(ctx.balance) + " QTC (threshold " + rule.threshold + ").",
           "balance|" + ctx.balance.toString());
      } else if (rule.type === "balance_above" && !isBelow && (!wasKnown || wasBelow)) {
        mk("Balance above " + rule.threshold + " QTC",
           shortAddr(address) + " now holds " + formatQtc(ctx.balance) + " QTC (threshold " + rule.threshold + ").",
           "balance|" + ctx.balance.toString());
      }
      break;
    }
    case "balance_change": {
      if (ctx.balance == null || baseline.balance == null) break;
      var base = BigInt(baseline.balance);
      if (base === 0n) break;
      var diff = ctx.balance >= base ? ctx.balance - base : base - ctx.balance;
      var fired = false, how;
      if (rule.changeMode === "pct") {
        var pct = Number(diff * 10000n / base) / 100; // 2dp
        var need = floatThreshold(rule.threshold);
        if (need !== null && pct >= need) { fired = true; how = pct.toFixed(2) + "% (" + formatQtc(diff) + " QTC)"; }
      } else {
        var needAbs = parseQtcToPlancks(rule.threshold);
        if (diff >= needAbs) { fired = true; how = formatQtc(diff) + " QTC"; }
      }
      if (fired) {
        mk("Balance moved " + how,
           shortAddr(address) + ": " + formatQtc(base) + " → " + formatQtc(ctx.balance) + " QTC.",
           "change|" + ctx.balance.toString());
      }
      break;
    }
    case "incoming_ge":
    case "outgoing_ge": {
      th = parseQtcToPlancks(rule.threshold);
      var side = rule.type === "incoming_ge" ? "in" : "out";
      var seen = side === "in" ? baseline.seenIn : baseline.seenOut;
      ctx.act[side].forEach(function (t) {
        if (seen.indexOf(t.id) !== -1) return;
        var amt;
        try { amt = BigInt(String(t.amount)); } catch (e) { return; }
        if (amt >= th) {
          var dir = side === "in" ? "received" : "sent";
          mk((side === "in" ? "Incoming ≥ " : "Outgoing ≥ ") + rule.threshold + " QTC",
             shortAddr(address) + " " + dir + " " + formatQtc(amt) + " QTC at block " +
             t.block_height + (side === "in" ? " from " + shortAddr(t.from_id) : " to " + shortAddr(t.to_id)) + ".",
             "tx|" + t.id);
        }
      });
      break;
    }
    case "activity": {
      var fresh = [];
      ctx.act["in"].forEach(function (t) { if (baseline.seenIn.indexOf(t.id) === -1) fresh.push({ t: t, side: "in" }); });
      ctx.act.out.forEach(function (t) { if (baseline.seenOut.indexOf(t.id) === -1) fresh.push({ t: t, side: "out" }); });
      fresh.slice(0, 25).forEach(function (f) {
        var amt;
        try { amt = BigInt(String(f.t.amount)); } catch (e) { amt = null; }
        mk("New activity on " + shortAddr(address),
           (f.side === "in" ? "← " : "→ ") + (amt == null ? "?" : formatQtc(amt)) + " QTC · block " + f.t.block_height + ".",
           "tx|" + f.t.id);
      });
      break;
    }
  }
  // NOTE: baseline advancement happens once per address per scan, in
  // evaluateRules (advanceAddressBaseline), so multiple rules on the same
  // address all see the same fresh transfers.
  return { alerts: alerts, baseline: baseline };
}

/* Advance one address baseline after all its rules ran: balances + seen ids. */
function advanceAddressBaseline(baseline, ctx) {
  if (ctx.balance != null) baseline.balance = ctx.balance.toString();
  ctx.act["in"].forEach(function (t) { pushSeen(baseline.seenIn, t.id); });
  ctx.act.out.forEach(function (t) { pushSeen(baseline.seenOut, t.id); });
  return baseline;
}

/* Evaluate ONE chain-scoped rule. */
function evalChainRule(rule, chain, ctx) {
  // ctx: { transfers: [], referenda: n, upgrades: n, upgradesList: [], headHeight, headTsMs, nowMs }
  var alerts = [];
  function mk(title, detail, idSuffix) {
    alerts.push({
      id: alertId([rule.id, idSuffix]),
      ruleId: rule.id, address: null,
      severity: rule.severity || "info",
      title: title, detail: detail,
      ts: new Date(ctx.nowMs).toISOString(),
    });
  }
  switch (rule.type) {
    case "whale_ge": {
      var th = parseQtcToPlancks(rule.threshold);
      (ctx.transfers || []).forEach(function (t) {
        if (chain.seenWhale.indexOf(t.id) !== -1) return;
        var amt;
        try { amt = BigInt(String(t.amount)); } catch (e) { return; }
        if (amt >= th) {
          mk("Whale move ≥ " + rule.threshold + " QTC",
             formatQtc(amt) + " QTC · " + shortAddr(t.from_id) + " → " + shortAddr(t.to_id) +
             " · block " + t.block_height + ".",
             "whale|" + t.id);
        }
      });
      (ctx.transfers || []).forEach(function (t) { pushSeen(chain.seenWhale, t.id); });
      break;
    }
    case "new_referendum": {
      // An unknown count (governance payload failed/malformed) must
      // neither fire nor RESET the baseline — assigning it would make
      // the next good scan compare against null/0 and fire falsely.
      if (nonNegInt(ctx.referenda) === null) break;
      if (chain.referenda != null && ctx.referenda > chain.referenda) {
        mk("New governance referendum",
           "Referendum count rose " + chain.referenda + " → " + ctx.referenda + ". Check the Governance Tracker for details.",
           "ref|" + ctx.referenda);
      }
      chain.referenda = ctx.referenda;
      break;
    }
    case "new_upgrade": {
      if (nonNegInt(ctx.upgrades) === null) break;
      if (chain.upgrades != null && ctx.upgrades > chain.upgrades) {
        var latest = (ctx.upgradesList || []).slice(-1)[0];
        mk("Runtime upgrade detected",
           "Upgrade count rose " + chain.upgrades + " → " + ctx.upgrades +
           (latest ? " (latest: " + (latest.spec_version != null ? "spec v" + latest.spec_version : "see tracker") + ")." : "."),
           "upg|" + ctx.upgrades);
      }
      chain.upgrades = ctx.upgrades;
      break;
    }
    case "chain_stall": {
      var mins = floatThreshold(rule.threshold);
      if (mins === null) break;
      var ageMs = ctx.nowMs - ctx.headTsMs;
      if (ageMs > mins * 60000 && chain.stallFiredHead !== ctx.headHeight) {
        mk("No new block for " + formatAge(ageMs),
           "Head block " + ctx.headHeight + " is " + formatAge(ageMs) + " old. Chain may be stalled — or the snapshot is simply stale; check Data sources.",
           "stall|" + ctx.headHeight);
        chain.stallFiredHead = ctx.headHeight;
      } else if (ageMs <= mins * 60000) {
        chain.stallFiredHead = null; // recovered; re-arm
      }
      break;
    }
  }
  return { alerts: alerts, chain: chain };
}

/* Full scan. data = {
 *   balances: Map addr->BigInt, byAddr: Map, transfers: [],
 *   referenda: n, upgrades: n, upgradesList: [], headHeight, headTsMs,
 *   snapshotCapturedAt: iso|null
 * }  nowMs: number.
 * Returns { alerts, baselines } with baselines advanced.
 */
function evaluateRules(rules, baselines, data, nowMs) {
  baselines = ensureBaselines(baselines);
  var alerts = [];
  var addrRules = {}, chainRules = [];
  (rules || []).forEach(function (r) {
    if (!r.enabled) return;
    var t = RULE_TYPES[r.type];
    if (!t) return;
    if (t.scope === "address" && r.address) {
      (addrRules[r.address] = addrRules[r.address] || []).push(r);
    } else if (t.scope === "chain") {
      chainRules.push(r);
    }
  });
  Object.keys(addrRules).forEach(function (addr) {
    var b = baselines.addresses[addr] || blankAddressBaseline();
    var bal = data.balances.has(addr) ? data.balances.get(addr) : null;
    var ctx = { balance: bal, act: addressActivity(data.byAddr, addr), nowMs: nowMs };
    addrRules[addr].forEach(function (r) {
      var out = evalAddressRule(r, addr, b, ctx);
      alerts = alerts.concat(out.alerts);
      b = out.baseline;
    });
    baselines.addresses[addr] = advanceAddressBaseline(b, ctx);
  });
  chainRules.forEach(function (r) {
    var out = evalChainRule(r, baselines.chain, {
      transfers: data.transfers, referenda: data.referenda, upgrades: data.upgrades,
      upgradesList: data.upgradesList, headHeight: data.headHeight,
      headTsMs: data.headTsMs, nowMs: nowMs,
    });
    alerts = alerts.concat(out.alerts);
    baselines.chain = out.chain;
  });
  return { alerts: alerts, baselines: baselines };
}

/* Self-test: run every enabled rule against synthetic fixtures so the user can
 * preview alert behavior. Returns alerts flagged synthetic:true. */
function runSelfTest(rules, nowMs) {
  var addr = "qzSELFTESTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  var t0 = new Date(nowMs - 3600000).toISOString();
  var t1 = new Date(nowMs - 1800000).toISOString();
  var fixtures = [
    { id: "SELFTEST-1", amount: (5000n * PLANCK_PER_QTC).toString(), from_id: "qzSENDERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", to_id: addr, block_height: 999001, timestamp: t0, extrinsic_id: "0xself1" },
    { id: "SELFTEST-2", amount: (120000n * PLANCK_PER_QTC).toString(), from_id: addr, to_id: "qzRECVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", block_height: 999002, timestamp: t1, extrinsic_id: "0xself2" },
  ];
  var byAddr = indexTransfers(fixtures);
  var balances = new Map();
  balances.set(addr, 1500n * PLANCK_PER_QTC);
  var data = {
    balances: byAddr.size ? balances : balances,
    byAddr: byAddr,
    transfers: fixtures,
    referenda: 2, upgrades: 1, upgradesList: [{ spec_version: 42 }],
    headHeight: 999002, headTsMs: nowMs - 45 * 60000,
    snapshotCapturedAt: null,
  };
  var baselines = {
    addresses: {},
    chain: { referenda: 1, upgrades: 0, stallFiredHead: null, seenWhale: [] },
  };
  baselines.addresses[addr] = { balance: (3000n * PLANCK_PER_QTC).toString(), seenIn: [], seenOut: [] };
  // Baseline sits above common balance_below thresholds (current: 1,500 QTC),
  // so a below-threshold self-test rule fires on the transition.
  // Clone rules with the fixture address where address-scoped.
  var testRules = (rules || []).filter(function (r) { return r.enabled; }).map(function (r) {
    var c = JSON.parse(JSON.stringify(r));
    c.id = "selftest-" + r.id;
    if (RULE_TYPES[r.type] && RULE_TYPES[r.type].scope === "address") c.address = addr;
    return c;
  });
  var out = evaluateRules(testRules, baselines, data, nowMs);
  out.alerts.forEach(function (a) {
    a.synthetic = true;
    a.address = a.address === addr ? "(self-test address)" : a.address;
  });
  return out.alerts;
}

var api = {
  PLANCK_PER_QTC: PLANCK_PER_QTC,
  parseQtcToPlancks: parseQtcToPlancks,
  formatQtc: formatQtc,
  formatAge: formatAge,
  shortAddr: shortAddr,
  indexTransfers: indexTransfers,
  addressActivity: addressActivity,
  buildBalanceMap: buildBalanceMap,
  RULE_TYPES: RULE_TYPES,
  defaultThreshold: defaultThreshold,
  ruleLabel: ruleLabel,
  ensureBaselines: ensureBaselines,
  parseHeight: parseHeight,
  floatThreshold: floatThreshold,
  nonNegInt: nonNegInt,
  validPlancks: validPlancks,
  parseableTs: parseableTs,
  eraTs: eraTs,
  validChainHeight: validChainHeight,
  chainTimeMs: chainTimeMs,
  MAX_SUPPLY_PLANCKS: MAX_SUPPLY_PLANCKS,
  sanitizeBlocks: sanitizeBlocks,
  resolveHead: resolveHead,
  sanitizeTransfers: sanitizeTransfers,
  sanitizeGovernance: sanitizeGovernance,
  sanitizeBaselines: sanitizeBaselines,
  sanitizeAlerts: sanitizeAlerts,
  sanitizeWatchlist: sanitizeWatchlist,
  watchRoom: watchRoom, MAX_WATCHLIST: MAX_WATCHLIST,
  ruleRoom: ruleRoom, MAX_RULES: MAX_RULES,
  backupFileRoom: backupFileRoom, MAX_BACKUP_FILE_BYTES: MAX_BACKUP_FILE_BYTES,
  advanceAddressBaseline: advanceAddressBaseline,
  blankChainBaseline: blankChainBaseline,
  blankAddressBaseline: blankAddressBaseline,
  evaluateRules: evaluateRules,
  runSelfTest: runSelfTest,
};

global.QWATCH = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})(typeof globalThis !== "undefined" ? globalThis : this);
