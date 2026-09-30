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
  var bal = ctx.balances ? (ctx.balances.get(entry.address) || null) : null;
  var free = bal ? BigInt(bal.free || "0") : null;
  var scheds = (ctx.schedules && ctx.schedules.get(entry.address)) || [];
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
  var mined = ctx.minedCounts ? (ctx.minedCounts.get(entry.address) || 0) : 0;
  var controlled = (free == null ? 0n : free) + claimable; // on-chain free + claimable-from-vesting
  return {
    address: entry.address, nick: entry.nick || "",
    free: free, reserved: bal ? BigInt(bal.reserved || "0") : null,
    frozen: bal ? BigInt(bal.frozen || "0") : null,
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
  addresses.forEach(function (addr) {
    var e = byAddr.get(addr);
    if (!e) return;
    e["in"].forEach(function (t) { if (!seen[t.id]) { seen[t.id] = 1; all.push({ t: t, side: "in", addr: addr }); } });
    e.out.forEach(function (t) { if (!seen[t.id]) { seen[t.id] = 1; all.push({ t: t, side: "out", addr: addr }); } });
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

function parseVaultJson(text) {
  var v = JSON.parse(text);
  if (!v || !Array.isArray(v.addresses)) throw new Error("not a Portfolio Desk vault file");
  v.addresses.forEach(function (e) {
    if (typeof e.address !== "string" || !e.address) throw new Error("vault entry missing address");
  });
  return { version: 1, addresses: v.addresses.slice(0, MAX_ADDRESSES).map(function (e) {
    return { address: e.address, nick: String(e.nick || "").slice(0, 40), addedAt: Number(e.addedAt) || Date.now() };
  }) };
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
  blankVault: blankVault, normalizeAddress: normalizeAddress,
  addToVault: addToVault, removeFromVault: removeFromVault,
  parseVaultJson: parseVaultJson, csvExport: csvExport,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.QPORT = api;

})(typeof globalThis !== "undefined" ? globalThis : this);
