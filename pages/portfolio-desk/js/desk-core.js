/* QTC Portfolio Desk — core logic (pure, no DOM).
 *
 * The aggregation engine behind the portfolio desk: planck math, the exact
 * pallet vesting schedule math, portfolio rollups, vesting claimability,
 * activity scoring, and export builders.
 * Environment-agnostic: browser global QPORT, Node module.exports.
 */
(function (global) {
"use strict";

var PLANCK_PER_QTC = 1000000000000n; // 1e12
var MAX_SUPPLY_QTC = 21000000n;
var MAX_SUPPLY_PLANCKS = MAX_SUPPLY_QTC * PLANCK_PER_QTC;
var VAULT_KEY = "qtc-portfolio-desk-vault-v1";
var MAX_ADDRESSES = 200;

/* Fleet boundary bounds (round 2, 2026-10-11): the same relations the
 * Flow Tracer / Ledger Desk cores enforce — verified against live data
 * at head 207,818 before being written down here. Quantus launched
 * 2026-09-09; no chain fact predates the 2026-09-01 genesis floor, no
 * block height exceeds the fleet's 10,000,000 sanity ceiling, and no
 * account or transfer can exceed the 21M supply cap. */
var MAX_CHAIN_HEIGHT = 10000000;
var GENESIS_FLOOR_MS = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z
var SS58_189_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/; // strict shape: qz + 47 base58
var SCHED_MS_MIN = 946684800000;   // 2000-01-01 (vesting desk msStr shape)
var SCHED_MS_MAX = 4102444800000;  // 2100-01-01

/* ---------- planck <-> QTC ---------- */

function parseQtcToPlancks(str) {
  if (typeof str !== "string") throw new Error("amount must be a string");
  var s = str.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error("invalid QTC amount: " + str);
  var parts = s.split(".");
  var whole = BigInt(parts[0] || "0");
  var frac = (parts[1] || "").padEnd(12, "0");
  return whole * PLANCK_PER_QTC + BigInt(frac);
}

function formatQtc(plancks, decimals) {
  var p = typeof plancks === "bigint" ? plancks : BigInt(String(plancks));
  var dec = (typeof decimals === "number" && decimals >= 0 && decimals <= 12) ? decimals : 4;
  var neg = p < 0n;
  if (neg) p = -p;
  var whole = p / PLANCK_PER_QTC;
  var frac = (p % PLANCK_PER_QTC).toString().padStart(12, "0").slice(0, dec).replace(/0+$/, "");
  var w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}

/* ---------- boundary validation ----------
 *
 * Every value the desk did not produce itself — a stored vault, an
 * indexer answer, a snapshot row — crosses one of these gates before it
 * can anchor a balance, a vesting split, a transfer row, or a mined
 * count. The failure modes they close are BigInt-class: BigInt("12.5"),
 * BigInt("abc"), and BigInt(NaN-producing input) all THROW, so one
 * poisoned field used to brick renderAll outright; subtler poison
 * (a negative "-5" balance, a duplicated vault entry, a garbage head
 * height) rendered as fabricated chain fact or double-counted the
 * portfolio. Classification per field:
 *   core  — a balance with an invalid free amount, a schedule with an
 *           invalid total/window, a transfer with an invalid amount or
 *           height: the row is dropped (balance reads "unknown", never
 *           a fabricated number);
 *   poison — a vault entry that is not an object with a non-empty
 *           string address, or a duplicate of an entry already kept:
 *           dropped (duplicates double-counted every total);
 *   absent-but-recoverable — a missing reserved/frozen/claimed reads
 *           as "0", a garbage transfer timestamp coerces to null, a
 *           non-string cohort/id is coerced, never thrown on.
 *
 * Round 2 (2026-10-11) validates RELATIONS between fields, not just
 * their shapes — every relation below was verified against live data
 * first: mined counts take all_time over the window (the window is
 * already inside all_time; summing double-counted), a balance's
 * components sum to at most the 21M cap, a schedule's claimed never
 * exceeds its total and its cliff never follows its end, and transfer
 * rows carry a positive in-cap amount between strict SS58-189
 * endpoints at a height of 1..10,000,000 with no duplicated id and no
 * present-but-impossible timestamp.
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

function sanitizeBalance(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  var free = validPlancks(row.free);
  if (free === null) return null; // core field: no honest balance without it
  var reserved = row.reserved == null ? "0" : validPlancks(row.reserved);
  var frozen = row.frozen == null ? "0" : validPlancks(row.frozen);
  if (reserved === null || frozen === null) return null;
  // Relation: one account can never hold more than the whole supply —
  // neither in a single component nor summed (verified: every live
  // top-200 row sums under the cap).
  if (BigInt(free) + BigInt(reserved) + BigInt(frozen) > MAX_SUPPLY_PLANCKS) return null;
  return { free: free, reserved: reserved, frozen: frozen };
}

function sanitizeSchedule(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  var total = validPlancks(s.total_plancks);
  if (total === null) return null; // core field
  var claimed = s.claimed_plancks == null ? "0" : validPlancks(s.claimed_plancks);
  if (claimed === null) return null;
  // Relations (verified on all 48 live schedules): the grant cannot
  // exceed the supply cap, and claimed can never exceed the grant.
  if (BigInt(total) > MAX_SUPPLY_PLANCKS) return null;
  if (BigInt(claimed) > BigInt(total)) return null;
  var cliff = nonNegInt(s.cliff_ms), start = nonNegInt(s.start_ms), end = nonNegInt(s.end_ms);
  if (cliff === null || start === null || end === null || end < start) return null;
  // The window fields are millisecond instants, not bare counts: the
  // vesting desk's 2000..2100 shape applies (an end_ms of 1 is 1970 —
  // it would vest the whole grant instantly at any real "now"), and a
  // cliff after the end is a window that can never exist on-chain.
  if (cliff < SCHED_MS_MIN || cliff > SCHED_MS_MAX ||
      start < SCHED_MS_MIN || start > SCHED_MS_MAX ||
      end < SCHED_MS_MIN || end > SCHED_MS_MAX) return null;
  if (cliff > end) return null;
  return {
    id: nonNegInt(s.id),
    cohort: typeof s.cohort === "string" && s.cohort ? s.cohort : "—",
    total_plancks: total, claimed_plancks: claimed,
    cliff_ms: String(cliff), start_ms: String(start), end_ms: String(end),
  };
}

/* Round 3 (2026-10-14): schedule-list relations. The producer
 * (fetch-vesting-data.mjs over the genesis vesting snapshot) writes
 * schedule ids that are globally unique (verified 48/48 on the real
 * snapshot) and per-beneficiary grants whose totals sum to the
 * 5,669,940 QTC vesting pool — far under the supply cap. A duplicated
 * row therefore restates the SAME grant: counting it twice doubles
 * the beneficiary's locked/claimable in every rollup. And two grants
 * that are each under the per-row cap can still sum past every QTC
 * that will ever exist for one beneficiary. First copy wins; a row
 * that would push the beneficiary's total over the cap is dropped. */
function dedupeScheduleList(list) {
  var seenIds = {}, total = 0n, out = [];
  list.forEach(function (s) {
    if (s.id !== null && s.id !== undefined) {
      if (seenIds[s.id]) return;
      seenIds[s.id] = 1;
    }
    var t = BigInt(s.total_plancks);
    if (total + t > MAX_SUPPLY_PLANCKS) return;
    total += t;
    out.push(s);
  });
  return out;
}

function sanitizeSchedules(rows) {
  var byBeneficiary = new Map();
  if (!Array.isArray(rows)) return byBeneficiary;
  rows.forEach(function (s) {
    if (!s || typeof s !== "object") return;
    if (typeof s.beneficiary !== "string" || !SS58_189_RE.test(s.beneficiary)) return;
    var clean = sanitizeSchedule(s);
    if (!clean) return;
    var arr = byBeneficiary.get(s.beneficiary);
    if (!arr) { arr = []; byBeneficiary.set(s.beneficiary, arr); }
    arr.push(clean);
  });
  byBeneficiary.forEach(function (arr, addr) { byBeneficiary.set(addr, dedupeScheduleList(arr)); });
  return byBeneficiary;
}

function sanitizeTransfers(rows) {
  if (!Array.isArray(rows)) return [];
  var out = [];
  var seenIds = {};
  var nowCeil = Date.now() + 3600000; // capture-time ceiling, fleet standard
  rows.forEach(function (t) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return;
    var amount = validPlancks(t.amount);
    var height = parseHeight(t.block_height);
    if (amount === null || height === null) return; // core fields
    // Relations, not just shapes: a transfer moves a positive amount no
    // larger than the whole supply, between two strict SS58-189
    // endpoints, at a real chain height (1..10,000,000).
    if (BigInt(amount) <= 0n || BigInt(amount) > MAX_SUPPLY_PLANCKS) return;
    if (height < 1 || height > MAX_CHAIN_HEIGHT) return;
    if (typeof t.from_id !== "string" || !SS58_189_RE.test(t.from_id)) return;
    if (typeof t.to_id !== "string" || !SS58_189_RE.test(t.to_id)) return;
    // A PRESENT-but-impossible timestamp (pre-genesis, or past the
    // capture ceiling) poisons the row — the desk must not present it
    // as chain fact. An UNPARSEABLE one still coerces to null (ages and
    // ordering run on block height), per the round-1 classification.
    var ts = parseableTs(t.timestamp);
    if (ts !== null) {
      var ms = Date.parse(ts);
      if (!(ms >= GENESIS_FLOOR_MS && ms <= nowCeil)) return;
    }
    var id = (typeof t.id === "string" && t.id) || (typeof t.id === "number" && Number.isFinite(t.id)) ? String(t.id) : null;
    // Dedupe AFTER validation (a poisoned first copy must not suppress
    // a good one): a duplicated transfer id double-indexed into the
    // per-address in/out counts the rollup reports.
    if (id !== null) {
      if (seenIds[id]) return;
      seenIds[id] = 1;
    }
    out.push({
      id: id,
      amount: amount, from_id: t.from_id, to_id: t.to_id,
      block_height: height, timestamp: ts,
    });
  });
  return out;
}

function sanitizeTopBalances(rows) {
  var byAddr = new Map();
  if (!Array.isArray(rows)) return byAddr;
  rows.forEach(function (a) {
    if (!a || typeof a !== "object") return;
    if (typeof a.address !== "string" || !SS58_189_RE.test(a.address)) return;
    var bal = sanitizeBalance({ free: a.free_plancks, reserved: a.reserved_plancks, frozen: a.frozen_plancks });
    if (bal) byAddr.set(a.address, bal);
  });
  return byAddr;
}

function sanitizeMinedCounts(windowMiners, allTime, bounds) {
  // Round 3 (2026-10-14): chain-containment relations, verified on the
  // real miners.json at capture 225,165 before being held: every block
  // has exactly one author, so no address's all_time count can exceed
  // chain_height (live max 95,851), the top-100 all_time counts SUM to
  // at most chain_height (live 225,021), and no window count can
  // exceed the window's own block_count (live max 10,390 of 15,000;
  // window counts sum to exactly 15,000). bounds is optional — without
  // it the round-2 behaviour stands. An over-height all_time entry is
  // not the address's count: the window floor (if any) stands instead.
  // An all_time list whose kept entries sum past chain_height is not
  // producer data at all: the whole list is voided, window floors kept.
  var chainHeight = bounds ? nonNegInt(bounds.chainHeight) : null;
  var windowBlocks = bounds ? nonNegInt(bounds.windowBlocks) : null;
  // miners.json carries TWO views of the same fact: window_miners is
  // complete for the last 15,000 blocks, all_time is cumulative since
  // genesis for the top-100 miners — and all_time already INCLUDES the
  // window blocks for every address present in both (verified at head
  // 207,818: 35/35 shared addresses have all_time >= window). Adding
  // the two maps — what this function used to do — double-counted the
  // window: the top miner painted 94,310 blocks mined against a true
  // all-time 83,778. The honest count is all_time where the address is
  // listed there, else the window count (a floor: it mined at least
  // that many). A duplicated all_time row restates the same cumulative
  // fact, so it is counted once, never summed.
  var counts = new Map();
  if (windowMiners && typeof windowMiners === "object" && !Array.isArray(windowMiners))
    Object.keys(windowMiners).forEach(function (addr) {
      if (!SS58_189_RE.test(addr)) return;
      var v = nonNegInt(windowMiners[addr]);
      if (v === null) return;
      if (windowBlocks !== null && v > windowBlocks) return;
      if (chainHeight !== null && v > chainHeight) return;
      counts.set(addr, v);
    });
  if (Array.isArray(allTime)) {
    var seenAllTime = {};
    var kept = [];
    allTime.forEach(function (m) {
      if (!m || typeof m !== "object") return;
      if (typeof m.address !== "string" || !SS58_189_RE.test(m.address)) return;
      if (seenAllTime[m.address]) return;
      var v = nonNegInt(m.blocks);
      if (v === null) return; // a garbage count is unknown, never NaN blocks mined
      if (chainHeight !== null && v > chainHeight) return;
      seenAllTime[m.address] = 1;
      kept.push([m.address, v]);
    });
    var sum = kept.reduce(function (a, kv) { return a + kv[1]; }, 0);
    if (chainHeight === null || sum <= chainHeight)
      kept.forEach(function (kv) { counts.set(kv[0], kv[1]); });
  }
  return counts;
}

function shortAddr(addr) {
  if (!addr || addr.length < 16) return addr || "—";
  return addr.slice(0, 8) + "…" + addr.slice(-6);
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

/* ---------- vesting schedule math ----------
 *
 * Exact pallet semantics (verified against Quantus-Network/chain
 * pallets/vesting + mainnet_vesting.rs by the Vesting Desk, v1.28.0):
 * linear vesting, vested = total * elapsed / (end - start), 0 before the
 * cliff, total after the end. Claimed is tracked separately on-chain; the
 * unclaimed-but-vested portion still sits in the genesis vesting-pool
 * account — it is NOT in the beneficiary's account balance. claimable =
 * vested(now) - claimed.
 */
function vestedPlancks(schedule, nowMs) {
  var total = BigInt(schedule.total_plancks);
  var cliff = Number(schedule.cliff_ms);
  var start = Number(schedule.start_ms);
  var end = Number(schedule.end_ms);
  if (!(nowMs >= cliff)) return 0n;
  if (nowMs >= end) return total;
  var elapsed = BigInt(Math.max(0, nowMs - start));
  var span = BigInt(Math.max(1, end - start));
  return (total * elapsed) / span;
}

function scheduleSummary(schedule, nowMs) {
  var total = BigInt(schedule.total_plancks);
  var claimed = BigInt(schedule.claimed_plancks || "0");
  var vested = vestedPlancks(schedule, nowMs);
  var claimable = vested - claimed;
  if (claimable < 0n) claimable = 0n;
  var locked = total - vested;
  if (locked < 0n) locked = 0n;
  return { total: total, claimed: claimed, vested: vested, claimable: claimable, locked: locked,
           endMs: Number(schedule.end_ms), cohort: schedule.cohort || "—" };
}

/* ---------- per-address rollup ---------- */

function rollupAddress(entry, ctx, nowMs) {
  // entry: {address, nick}
  // ctx: {balances: Map(addr -> {free,reserved,frozen}|null),
  //       schedules: Map(addr -> [schedule]), byAddr: Map(addr -> {in,out,count,lastTs}),
  //       minedCounts: Map(addr -> n)}
  // ctx is producer-built (app snapshot/RPC loaders today, anything
  // tomorrow): re-validate at the rollup so a poisoned balance or
  // schedule reads as unknown/dropped here too, never a BigInt throw
  // that bricks every render downstream.
  var bal = ctx.balances ? sanitizeBalance(ctx.balances.get(entry.address)) : null;
  var free = bal ? BigInt(bal.free) : null;
  var rawScheds = (ctx.schedules && ctx.schedules.get(entry.address)) || [];
  var scheds = Array.isArray(rawScheds) ? dedupeScheduleList(rawScheds.map(sanitizeSchedule).filter(Boolean)) : [];
  var locked = 0n, claimable = 0n, vestedTotal = 0n;
  var schedRows = [];
  scheds.forEach(function (s) {
    var sm = scheduleSummary(s, nowMs);
    locked += sm.locked; claimable += sm.claimable; vestedTotal += sm.vested;
    schedRows.push({ id: s.id, cohort: sm.cohort, total: sm.total, claimed: sm.claimed,
                     claimable: sm.claimable, locked: sm.locked, endMs: sm.endMs });
  });
  // Next unlock: nearest schedule end still in the future with locked > 0.
  var nextEnd = null;
  schedRows.forEach(function (r) { if (r.locked > 0n && (!nextEnd || r.endMs < nextEnd)) nextEnd = r.endMs; });
  var act = ctx.byAddr && ctx.byAddr.get(entry.address);
  if (act && (!Array.isArray(act["in"]) || !Array.isArray(act.out))) act = null;
  var minedRaw = ctx.minedCounts ? ctx.minedCounts.get(entry.address) : null;
  var mined = nonNegInt(minedRaw) || 0;
  var controlled = (free == null ? 0n : free) + claimable; // on-chain free + claimable-from-vesting
  return {
    address: entry.address, nick: entry.nick || "",
    free: free, reserved: bal ? BigInt(bal.reserved) : null,
    frozen: bal ? BigInt(bal.frozen) : null,
    balanceKnown: bal !== null,
    schedules: schedRows, locked: locked, claimable: claimable,
    vestedTotal: vestedTotal, nextUnlockMs: nextEnd,
    controlled: controlled,
    txIn: act ? act["in"].length : 0, txOut: act ? act.out.length : 0,
    txCount: act ? act.count : 0, lastTxTs: act ? act.lastTs : null,
    minedBlocks: mined,
  };
}

function rollupPortfolio(vault, ctx, nowMs) {
  var rows = vault.addresses.map(function (e) { return rollupAddress(e, ctx, nowMs); });
  var known = rows.filter(function (r) { return r.balanceKnown; });
  function sum(f) { return rows.reduce(function (a, r) { return a + (r[f] == null ? 0n : r[f]); }, 0n); }
  var totalFree = sum("free"), totalLocked = sum("locked"),
      totalClaimable = sum("claimable"), totalControlled = sum("controlled");
  var shareOfCap = totalControlled * 1000000n / MAX_SUPPLY_PLANCKS; // basis points *100
  var totalTx = rows.reduce(function (a, r) { return a + r.txCount; }, 0);
  var totalMined = rows.reduce(function (a, r) { return a + r.minedBlocks; }, 0);
  var withVesting = rows.filter(function (r) { return r.schedules.length > 0; }).length;
  var nextUnlock = null;
  rows.forEach(function (r) { if (r.nextUnlockMs && (!nextUnlock || r.nextUnlockMs < nextUnlock)) nextUnlock = r.nextUnlockMs; });
  var alloc = rows.map(function (r) { return { address: r.address, nick: r.nick, controlled: r.controlled }; })
                  .sort(function (a, b) { return (b.controlled > a.controlled ? 1 : b.controlled < a.controlled ? -1 : 0); });
  return {
    rows: rows, knownCount: known.length, totalCount: rows.length,
    totalFree: totalFree, totalLocked: totalLocked, totalClaimable: totalClaimable,
    totalControlled: totalControlled, shareOfCap: shareOfCap,
    totalTx: totalTx, totalMined: totalMined, withVesting: withVesting,
    nextUnlockMs: nextUnlock, allocation: alloc,
  };
}

/* ---------- activity feed ---------- */

function portfolioActivity(byAddr, addresses, limit) {
  var seen = {};
  var all = [];
  function key(t) {
    // Id-less rows used to share the single key "undefined", collapsing
    // every one of them into the first — dedupe on the row's own facts.
    return t.id != null && t.id !== "" ? "id:" + t.id
      : "row:" + t.from_id + ">" + t.to_id + "@" + t.block_height + ":" + t.amount;
  }
  function push(t, side, addr) {
    if (!t || typeof t !== "object") return;
    if (validPlancks(t.amount) === null || parseHeight(t.block_height) === null) return; // unrenderable
    var k = key(t);
    if (seen[k]) return;
    seen[k] = 1;
    all.push({ t: t, side: side, addr: addr });
  }
  addresses.forEach(function (addr) {
    var e = byAddr.get(addr);
    if (!e) return;
    (Array.isArray(e["in"]) ? e["in"] : []).forEach(function (t) { push(t, "in", addr); });
    (Array.isArray(e.out) ? e.out : []).forEach(function (t) { push(t, "out", addr); });
  });
  all.sort(function (a, b) { return b.t.block_height - a.t.block_height; });
  return all.slice(0, limit || 25);
}

/* ---------- vault (localStorage) ---------- */

function blankVault() { return { version: 1, addresses: [], createdAt: Date.now() }; }

function normalizeAddress(s) { return String(s == null ? "" : s).trim(); }

function addToVault(vault, address, nick) {
  address = normalizeAddress(address);
  if (!address) throw new Error("address is empty");
  if (vault.addresses.some(function (e) { return e.address === address; }))
    throw new Error("address is already in the vault");
  if (vault.addresses.length >= MAX_ADDRESSES)
    throw new Error("vault is full (" + MAX_ADDRESSES + " addresses)");
  vault.addresses.push({ address: address, nick: String(nick || "").slice(0, 40), addedAt: Date.now() });
  return vault;
}

function removeFromVault(vault, address) {
  vault.addresses = vault.addresses.filter(function (e) { return e.address !== address; });
  return vault;
}

function sanitizeVaultEntries(rows, opts) {
  // One bad entry must not brick (or empty) the whole vault, and a
  // duplicated address must never survive: rollupPortfolio sums per
  // entry, so a duplicate silently double-counted every total.
  // Producer relations: the only writer (addToVault, fed by the app's
  // add form) stores an address that passed full SS58 validation and
  // addedAt = Date.now() at add time. The core enforces the strict
  // SS58-189 shape floor every other sanitizer here uses, plus the
  // app-supplied full validator when given (opts.validateAddress —
  // checksum + prefix + 32-byte key), and holds addedAt to the window
  // a real add can produce: not before the chain existed, not in the
  // future. An out-of-window stamp is replaced with now — the entry is
  // real, only its claimed date is not a producer value.
  var validate = opts && typeof opts.validateAddress === "function" ? opts.validateAddress : null;
  var nowCeil = Date.now() + 5 * 60 * 1000; // producer clock skew, fleet standard
  var seen = {}, out = [];
  if (!Array.isArray(rows)) return out;
  rows.forEach(function (e) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return;
    if (typeof e.address !== "string") return;
    var address = e.address.trim();
    if (!SS58_189_RE.test(address) || seen[address]) return;
    if (validate && !validate(address)) return;
    seen[address] = 1;
    var addedAt = nonNegInt(e.addedAt);
    if (addedAt === null || addedAt < GENESIS_FLOOR_MS || addedAt > nowCeil) addedAt = Date.now();
    out.push({
      address: address,
      nick: typeof e.nick === "string" ? e.nick.slice(0, 40) : "",
      addedAt: addedAt,
    });
  });
  return out.slice(0, MAX_ADDRESSES);
}

function parseVaultJson(text, opts) {
  var v = JSON.parse(text);
  if (!v || typeof v !== "object" || !Array.isArray(v.addresses)) throw new Error("not a Portfolio Desk vault file");
  return { version: 1, addresses: sanitizeVaultEntries(v.addresses, opts) };
}

function csvExport(portfolio) {
  var lines = ["nickname,address,free_qtc,vesting_claimable_qtc,vesting_locked_qtc,controlled_qtc,tx_in,tx_out,mined_blocks,balance_known"];
  portfolio.rows.forEach(function (r) {
    function q(p) { return p == null ? "" : (Number(p) / 1e12).toFixed(6); }
    lines.push([
      JSON.stringify(r.nick || ""), r.address,
      q(r.free), q(r.claimable), q(r.locked), q(r.controlled),
      r.txIn, r.txOut, r.minedBlocks, r.balanceKnown ? "yes" : "no"
    ].join(","));
  });
  return lines.join("\n");
}

/* ---------- exposure ---------- */

var api = {
  PLANCK_PER_QTC: PLANCK_PER_QTC, MAX_SUPPLY_PLANCKS: MAX_SUPPLY_PLANCKS,
  VAULT_KEY: VAULT_KEY, MAX_ADDRESSES: MAX_ADDRESSES,
  parseQtcToPlancks: parseQtcToPlancks, formatQtc: formatQtc,
  shortAddr: shortAddr, formatAge: formatAge,
  vestedPlancks: vestedPlancks, scheduleSummary: scheduleSummary,
  rollupAddress: rollupAddress, rollupPortfolio: rollupPortfolio,
  portfolioActivity: portfolioActivity,
  validPlancks: validPlancks, nonNegInt: nonNegInt, parseHeight: parseHeight,
  parseableTs: parseableTs, sanitizeBalance: sanitizeBalance,
  sanitizeSchedule: sanitizeSchedule, sanitizeSchedules: sanitizeSchedules,
  sanitizeTransfers: sanitizeTransfers, sanitizeTopBalances: sanitizeTopBalances,
  sanitizeMinedCounts: sanitizeMinedCounts, sanitizeVaultEntries: sanitizeVaultEntries,
  blankVault: blankVault, normalizeAddress: normalizeAddress,
  addToVault: addToVault, removeFromVault: removeFromVault,
  parseVaultJson: parseVaultJson, csvExport: csvExport,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.QPORT = api;

})(typeof globalThis !== "undefined" ? globalThis : this);
