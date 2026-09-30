/* QTC Ledger Desk — ledger-core.js
 * Pure accounting + chain-math core. Environment-agnostic: browser global
 * QTCLedger, Node module.exports. No DOM, no localStorage here.
 *
 * Units:
 *   - QTC amounts: BigInt planck (1 QTC = 10^12 planck).
 *   - USD values: BigInt microdollars (10^6 per USD) to keep gains exact.
 *   - Prices: decimal strings "USD per QTC", parsed to microdollars-per-QTC.
 *
 * Emission model (per Quantus-Network/chain runtime source, verified by the
 * Emission Lab, Sept 30 2026):
 *   R_{n+1} = R_n * (1 - 1/50,000,000), rewards quantized to 0.01 QTC
 *   (the wormhole leaf quantum) by the minting pallet.
 * Mining-income detection anchors the curve at a real indexer-observed
 * reward (0.32 QTC at block 137536, 2026-09-30) and decays it per the
 * verified formula. All modeled rewards are quantized to 0.01 QTC and the
 * UI labels them as modeled estimates.
 */
(function (global) {
"use strict";

var PLANCK = 1000000000000n;      // 10^12 planck per QTC
var QUANTUM = 10000000000n;       // 0.01 QTC leaf quantum, in planck
var EMISSION_DIVISOR = 50000000;
var MICRO = 1000000n;             // microdollars per USD
var LONG_TERM_DAYS = 365;

// ---- Emission model -------------------------------------------------------
var DECAY = 1 - 1 / EMISSION_DIVISOR;
function rewardModelPlancks(height, anchorHeight, anchorRewardPlancks) {
  // Exact-per-model reward at `height`, quantized to the 0.01 QTC leaf
  // quantum. Backward extrapolation uses the same exponential law.
  var r = Number(anchorRewardPlancks) * Math.pow(DECAY, height - anchorHeight);
  var q = Math.round(r / Number(QUANTUM));
  return BigInt(q) * QUANTUM;
}

// ---- Parsing / formatting -------------------------------------------------
function parseQtcToPlanck(s) {
  // Accepts "123", "123.45", "0.000000000001". Returns BigInt planck or null.
  if (s === null || s === undefined) return null;
  var t = String(s).trim().replace(/,/g, "");
  var m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(t);
  if (!m) return null;
  var frac = (m[2] || "");
  while (frac.length < 12) frac += "0";
  return BigInt(m[1]) * PLANCK + BigInt(frac);
}
function formatQtc(planck, digits) {
  var d = (digits === undefined) ? 4 : digits;
  var neg = planck < 0n;
  var a = neg ? -planck : planck;
  var whole = a / PLANCK;
  var frac = a % PLANCK;
  var fs = frac.toString().padStart(12, "0").slice(0, d);
  var ws = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + ws + (d > 0 ? "." + fs : "");
}
function parseUsdPerQtcToMicro(s) {
  // "12.50" -> 12_500_000n microdollars per QTC. Up to 6 decimals. null if bad.
  if (s === null || s === undefined || String(s).trim() === "") return null;
  var t = String(s).trim().replace(/,/g, "").replace(/^\$/, "");
  var m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return null;
  var frac = (m[2] || "");
  while (frac.length < 6) frac += "0";
  return BigInt(m[1]) * MICRO + BigInt(frac);
}
function formatUsd(micro) {
  var neg = micro < 0n;
  var a = neg ? -micro : micro;
  var dollars = a / MICRO;
  var cents = (a % MICRO) / 10000n; // 2 decimals
  return (neg ? "-$" : "$") + dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    "." + cents.toString().padStart(2, "0");
}
function usdValueMicro(qtyPlanck, priceMicroPerQtc) {
  // qty * price / 1e12, exact in microdollars.
  return (qtyPlanck * priceMicroPerQtc) / PLANCK;
}
function dayKey(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" + String(d.getUTCDate()).padStart(2, "0");
}

// ---- Event model ----------------------------------------------------------
// event = { id, dateMs, type, address, qtyPlanck (BigInt|string),
//           priceMicro (BigInt|string|null), feePlanck, note, source, ref,
//           internal (bool), flags: [] }
// types: mining_income | airdrop | buy | sell | transfer_in | transfer_out |
//        gift_in | gift_out | fee
var INFLOW = { mining_income: 1, airdrop: 1, buy: 1, transfer_in: 1, gift_in: 1 };
var OUTFLOW = { sell: 1, transfer_out: 1, gift_out: 1, fee: 1 };
var INCOME_TYPES = { mining_income: 1, airdrop: 1 }; // ordinary income at FMV

function normEvent(e) {
  return {
    id: e.id, dateMs: Number(e.dateMs), type: e.type,
    address: e.address || "", qtyPlanck: BigInt(e.qtyPlanck),
    priceMicro: (e.priceMicro === null || e.priceMicro === undefined) ? null : BigInt(e.priceMicro),
    feePlanck: BigInt(e.feePlanck || 0),
    note: e.note || "", source: e.source || "manual",
    ref: e.ref || "", internal: !!e.internal, flags: e.flags || []
  };
}

// ---- Cost-basis engine ----------------------------------------------------
function methodSort(method, lots) {
  // returns lots in consumption order for the method
  var arr = lots.slice();
  if (method === "FIFO") arr.sort(function (a, b) { return a.dateMs - b.dateMs || (a.seq - b.seq); });
  else if (method === "LIFO") arr.sort(function (a, b) { return b.dateMs - a.dateMs || (b.seq - a.seq); });
  else if (method === "HIFO") arr.sort(function (a, b) {
    if (a.unitCostMicro !== b.unitCostMicro) return a.unitCostMicro > b.unitCostMicro ? -1 : 1;
    return a.dateMs - b.dateMs;
  });
  else throw new Error("unknown method " + method);
  return arr;
}

// Build the lot ledger from events (chronological). Returns:
// { lots: [...remaining], matches: [...], income: [...], errors: [...] }
// match = { disposalId, lotSeq, qtyPlanck, proceedsMicro, basisMicro,
//           gainMicro, heldDays, longTerm }
function runLedger(events, method, priceForEvent) {
  var evs = events.map(normEvent).sort(function (a, b) {
    return a.dateMs - b.dateMs || (a.seqOrder - b.seqOrder);
  });
  var lots = [];      // {seq, qtyPlanck, unitCostMicro, dateMs, sourceId, basisUnknown}
  var matches = [];
  var income = [];    // {eventId, qtyPlanck, usdMicro, priced}
  var errors = [];
  var seq = 0;

  evs.forEach(function (ev) {
    var price = ev.priceMicro !== null ? ev.priceMicro :
      (priceForEvent ? priceForEvent(ev.dateMs) : null);
    if (INFLOW[ev.type]) {
      var unitCost = null, priced = price !== null;
      if (ev.type === "buy" || ev.type === "mining_income" || ev.type === "airdrop") {
        unitCost = price; // buys/mining/airdrop: basis = FMV (price required or flagged)
      } else {
        unitCost = 0n;    // transfer_in / gift_in: carryover/unknown
      }
      lots.push({ seq: seq++, qtyPlanck: ev.qtyPlanck,
        unitCostMicro: unitCost === null ? 0n : unitCost,
        basisUnknown: unitCost === null, priced: priced,
        dateMs: ev.dateMs, sourceId: ev.id, address: ev.address, type: ev.type });
      if (INCOME_TYPES[ev.type]) {
        income.push({ eventId: ev.id, dateMs: ev.dateMs, qtyPlanck: ev.qtyPlanck,
          usdMicro: price !== null ? usdValueMicro(ev.qtyPlanck, price) : null,
          priced: price !== null, type: ev.type });
      }
      if ((ev.type === "buy" || INCOME_TYPES[ev.type]) && price === null) {
        errors.push({ eventId: ev.id, kind: "unpriced",
          msg: ev.type + " on " + dayKey(ev.dateMs) + " has no USD price — add a price-table entry." });
      }
      if (ev.type === "transfer_in" || ev.type === "gift_in") {
        errors.push({ eventId: ev.id, kind: "review-basis",
          msg: ev.type + " on " + dayKey(ev.dateMs) + " booked at zero basis — confirm carryover basis." });
      }
    } else if (OUTFLOW[ev.type]) {
      if (ev.internal) return; // internal move: not a disposal, not an acquisition
      var need = ev.qtyPlanck;
      var ordered = methodSort(method, lots.filter(function (l) { return l.qtyPlanck > 0n; }));
      var isGift = ev.type === "gift_out";
      var dispPrice = isGift ? 0n : price;
      if (!isGift && dispPrice === null) {
        errors.push({ eventId: ev.id, kind: "unpriced",
          msg: ev.type + " on " + dayKey(ev.dateMs) + " has no USD price — gain/loss skipped." });
        return;
      }
      for (var i = 0; i < ordered.length && need > 0n; i++) {
        var lot = ordered[i];
        var take = lot.qtyPlanck < need ? lot.qtyPlanck : need;
        var proceeds = isGift ? 0n : usdValueMicro(take, dispPrice);
        // Gifts carry basis to the recipient: no gain or loss is realized,
        // so the removed basis is tracked separately, not as a loss.
        var basis = isGift ? 0n : usdValueMicro(take, lot.unitCostMicro);
        var basisRemoved = isGift ? usdValueMicro(take, lot.unitCostMicro) : 0n;
        var heldDays = Math.floor((ev.dateMs - lot.dateMs) / 86400000);
        matches.push({ disposalId: ev.id, disposalDateMs: ev.dateMs, lotSeq: lot.seq,
          qtyPlanck: take, proceedsMicro: proceeds, basisMicro: basis,
          basisRemovedMicro: basisRemoved,
          gainMicro: proceeds - basis, heldDays: heldDays,
          longTerm: heldDays > LONG_TERM_DAYS, isGift: isGift,
          basisUnknown: lot.basisUnknown, lotType: lot.type });
        lot.qtyPlanck -= take;
        need -= take;
      }
      if (need > 0n) {
        errors.push({ eventId: ev.id, kind: "shortfall",
          msg: "Disposal of " + formatQtc(ev.qtyPlanck) + " QTC on " + dayKey(ev.dateMs) +
            " exceeds tracked inventory by " + formatQtc(need) + " QTC — missing acquisition events?" });
      }
    } else {
      errors.push({ eventId: ev.id, kind: "unknown-type", msg: "Unknown event type: " + ev.type });
    }
  });

  return { lots: lots, matches: matches, income: income, errors: errors };
}

// ---- Tax-year report -------------------------------------------------------
function taxYearReport(events, method, priceForEvent, year, longTermDays) {
  var lt = (longTermDays === undefined) ? LONG_TERM_DAYS : longTermDays;
  var start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  var res = runLedger(events, method, priceForEvent);
  var incomeRows = res.income.filter(function (r) { return r.dateMs >= start && r.dateMs < end; });
  var disp = res.matches.filter(function (m) { return m.disposalDateMs >= start && m.disposalDateMs < end; });
  var mining = { qty: 0n, usd: 0n, unpricedQty: 0n };
  var other = { qty: 0n, usd: 0n, unpricedQty: 0n };
  incomeRows.forEach(function (r) {
    var b = r.type === "mining_income" ? mining : other;
    b.qty += r.qtyPlanck;
    if (r.priced) b.usd += r.usdMicro; else b.unpricedQty += r.qtyPlanck;
  });
  var st = { proceeds: 0n, basis: 0n, gain: 0n, count: 0 };
  var ltt = { proceeds: 0n, basis: 0n, gain: 0n, count: 0 };
  disp.forEach(function (m) {
    if (m.isGift) return;
    var b = (m.heldDays > lt) ? ltt : st;
    b.proceeds += m.proceedsMicro; b.basis += m.basisMicro;
    b.gain += m.gainMicro; b.count++;
  });
  // End-of-year inventory: lots with qty remaining, valued at EOY price lookup.
  var eoyPrice = priceForEvent ? priceForEvent(end - 1) : null;
  var inv = { qty: 0n, basis: 0n, market: null };
  res.lots.forEach(function (l) {
    if (l.qtyPlanck > 0n) {
      inv.qty += l.qtyPlanck;
      inv.basis += usdValueMicro(l.qtyPlanck, l.unitCostMicro);
    }
  });
  if (eoyPrice !== null && inv.qty > 0n) inv.market = usdValueMicro(inv.qty, eoyPrice);
  var feeEvents = events.map(normEvent).filter(function (e) {
    return e.type === "fee" && e.dateMs >= start && e.dateMs < end;
  });
  var fees = { qty: 0n, usd: 0n, unpricedQty: 0n };
  feeEvents.forEach(function (e) {
    var p = e.priceMicro !== null ? e.priceMicro : (priceForEvent ? priceForEvent(e.dateMs) : null);
    fees.qty += e.qtyPlanck;
    if (p !== null) fees.usd += usdValueMicro(e.qtyPlanck, p); else fees.unpricedQty += e.qtyPlanck;
  });
  return { year: year, method: method, mining: mining, otherIncome: other,
    shortTerm: st, longTerm: ltt, inventory: inv,
    fees: fees, errors: res.errors, matches: disp, incomeRows: incomeRows };
}

// ---- CSV -------------------------------------------------------------------
function eventsToCsv(events) {
  var rows = [["id", "date", "type", "address", "amount_qtc", "price_usd_per_qtc",
    "fee_qtc", "internal", "source", "ref", "note"]];
  events.map(normEvent).forEach(function (e) {
    rows.push([e.id, new Date(e.dateMs).toISOString(), e.type, e.address,
      (Number(e.qtyPlanck) / 1e12).toFixed(12),
      e.priceMicro === null ? "" : (Number(e.priceMicro) / 1e6).toFixed(6),
      (Number(e.feePlanck) / 1e12).toFixed(12),
      e.internal ? "yes" : "no", e.source, e.ref,
      (e.note || "").replace(/[\r\n]+/g, " ")]);
  });
  return rows.map(function (r) {
    return r.map(function (c) { return "\"" + String(c).replace(/"/g, "\"\"") + "\""; }).join(",");
  }).join("\n");
}
function parseCsv(text) {
  // Minimal CSV parser (quoted fields, commas). Returns array of row arrays.
  var rows = [], row = [], cur = "", q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === "\"") {
        if (text[i + 1] === "\"") { cur += "\""; i++; } else q = false;
      } else cur += c;
    } else if (c === "\"") q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(function (r) { return r.length > 1 || r[0] !== ""; });
}

var api = {
  PLANCK: PLANCK, QUANTUM: QUANTUM, EMISSION_DIVISOR: EMISSION_DIVISOR,
  MICRO: MICRO, LONG_TERM_DAYS: LONG_TERM_DAYS,
  rewardModelPlancks: rewardModelPlancks,
  parseQtcToPlanck: parseQtcToPlanck, formatQtc: formatQtc,
  parseUsdPerQtcToMicro: parseUsdPerQtcToMicro, formatUsd: formatUsd,
  usdValueMicro: usdValueMicro, dayKey: dayKey,
  INFLOW: INFLOW, OUTFLOW: OUTFLOW, INCOME_TYPES: INCOME_TYPES,
  normEvent: normEvent, methodSort: methodSort,
  runLedger: runLedger, taxYearReport: taxYearReport,
  eventsToCsv: eventsToCsv, parseCsv: parseCsv
};
global.QTCLedger = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
