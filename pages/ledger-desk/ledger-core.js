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
/* Amount-input length bound (white-hat): the parsers below (and the
 * stored-state toBigIntOrNull) regex-admit an unbounded digit string
 * and BigInt() it whole — BigInt decimal conversion is superlinear
 * (20M digits ~7.1 s measured), so an over-long form entry, or a
 * poisoned stored row at load, froze the desk. Cap 512 chars (the
 * fleet amount cap; genuine amounts are <= 21 chars, plancks <= 20,
 * timestamps <= 13), refused on length alone in the null convention. */
var MAX_AMOUNT_CHARS = 512;
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
  if (t.length > MAX_AMOUNT_CHARS) return null;
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
  if (t.length > MAX_AMOUNT_CHARS) return null;
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
      // An internal move is neither an acquisition nor income: the QTC
      // was already in a lot and stays in one. The scan's both-mine
      // detection emits exactly ONE event for such a transfer — a
      // transfer_in flagged internal (app.js) — so honoring the flag
      // only on outflows (below) minted a phantom zero-basis lot here:
      // inventory doubled, and a later sale matched the phantom at $0
      // basis, booking the full proceeds as a gain that never happened.
      if (ev.internal) return;
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
/* Spreadsheet formula injection (white-hat round, 2026-10-15): a CSV cell
 * whose parsed value begins — after any leading spaces/tabs, which Excel /
 * Sheets / LibreOffice skip — with =, +, - or @ (or begins with a tab/CR)
 * is EVALUATED as a formula/DDE when the file is opened, and the quoting
 * below does not prevent it (quotes are file syntax, stripped before the
 * value reaches the cell). The free-text columns here (id, source, ref,
 * note) are exactly the fields a shared ledger file or a CSV import from
 * someone else can poison: a note like "=2+5+cmd|' /C calc'!A0" would run
 * on the machine of whoever opens the export. Guard TEXT cells by
 * prefixing a single quote — spreadsheet apps render the text without the
 * quote and never evaluate it. Producer numeric cells are NOT guarded:
 * they are formatted from BigInts by this file, and a genuine negative
 * figure must stay a number. csvUnguardText is the exact inverse, applied
 * by the CSV importer so an exported file round-trips byte-identically
 * (the round-trip dedupe keys on id/ref depend on it). */
function csvGuardText(s) {
  var t = String(s == null ? "" : s);
  return /^[ \t]*[=+@-]/.test(t) || /^[\t\r]/.test(t) ? "'" + t : t;
}
function csvUnguardText(s) {
  var t = String(s == null ? "" : s);
  if (t.charAt(0) !== "'") return t;
  var rest = t.slice(1);
  return /^[ \t]*[=+@-]/.test(rest) || /^[\t\r]/.test(rest) ? rest : t;
}
function eventsToCsv(events) {
  var rows = [["id", "date", "type", "address", "amount_qtc", "price_usd_per_qtc",
    "fee_qtc", "internal", "source", "ref", "note"]];
  events.map(normEvent).forEach(function (e) {
    rows.push([csvGuardText(e.id), new Date(e.dateMs).toISOString(), e.type, e.address,
      (Number(e.qtyPlanck) / 1e12).toFixed(12),
      e.priceMicro === null ? "" : (Number(e.priceMicro) / 1e6).toFixed(6),
      (Number(e.feePlanck) / 1e12).toFixed(12),
      e.internal ? "yes" : "no", csvGuardText(e.source), csvGuardText(e.ref),
      csvGuardText((e.note || "").replace(/[\r\n]+/g, " "))]);
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

// ---- Stored-state boundary -------------------------------------------------
// localStorage is user-writable (devtools, a hand-edited vault export, an
// older buggy build): nothing read back from it may reach the BigInt
// constructors in normEvent/priceLookup unchecked. One poisoned row used to
// either abort the JSON reviver (silently resetting the ENTIRE vault) or
// throw inside every render (bricking the app until site data was cleared
// by hand) — and the poison re-saved itself on every save(). sanitizeState
// is the single gate: valid rows survive verbatim, poisoned rows are
// dropped, borderline fields are coerced to their honest neutral value
// (bad fee -> 0, bad price -> unpriced, bad method -> FIFO).
function toBigIntOrNull(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === "string") {
    var t = v.trim();
    if (t.indexOf("bigint:") === 0) t = t.slice(7); // save() encoding
    if (t.length > MAX_AMOUNT_CHARS) return null; // length bound before BigInt (see MAX_AMOUNT_CHARS)
    return /^-?\d+$/.test(t) ? BigInt(t) : null;
  }
  return null;
}
// Round 3 (2026-10-13): validate RELATIONS at the stored-state boundary,
// not just shapes — the same relations the app's own forms enforce. Round 1
// kept any non-empty string as a vault address: the add form requires an
// SS58 decode with a valid checksum, prefix 189, and a 32-byte key, and it
// refuses duplicates, so a bad-checksum, another chain's, short-key, or
// duplicated stored address was painted as a watched Quantus wallet and
// scanned as one. The stored checkphrase is a DERIVED field: anything that
// is not exactly 5 strings is not a checkphrase and is dropped to [] (the
// app re-derives the true words at boot and replaces a mismatched set).
// Event ids are match keys (delete-by-id, CSV round-trip dedupe), so
// duplicates are dropped — first occurrence wins; quantities and fees are
// bounded by the chain's 21M QTC supply (MAX_SUPPLY_PLANCKS); a non-empty
// event address must pass the same address validator as the vault (the
// event form only ever offers vault addresses or "external"). Price days
// must be REAL calendar dates (2026-02-31 matched the old regex and sorted
// as a price day) and are deduped keeping the last row, which is the row
// priceLookup's last-wins scan would have used. Lists are capped so a
// poisoned store cannot make every render walk an unbounded ledger.
// opts.validateAddress(addr) -> bool is supplied by the app (full SS58
// checksum decode); without it the core falls back to the strict SS58-189
// shape (isSs58_189), the same shape the snapshot validators use.
var MAX_VAULT_ADDRESSES = 500;
var MAX_LEDGER_EVENTS = 10000;
var MAX_PRICE_DAYS = 3660;
/* How many more events fit under MAX_LEDGER_EVENTS. Every path that
 * CREATES events — the manual form, the scan's add-selected, and the CSV
 * importer — must hold itself to this room, not just the load-time
 * sanitizer: a cap enforced only in sanitizeState is a silent data-loss
 * rule (the CSV importer pushed a 12,000-row file to 12,000 in-session
 * events — every render walks the ledger — and the next load trimmed it
 * back to the first 10,000 without a word, after the import alert had
 * claimed all 12,000). Same pattern as the Contact Vault import cap. */
function eventRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) n = 0;
  return Math.max(0, MAX_LEDGER_EVENTS - n);
}
/* How many more addresses fit under MAX_VAULT_ADDRESSES. The add-address
 * flow — the only path that CREATES addresses — must hold itself to this
 * room, not just the load-time sanitizer: a cap enforced only in
 * sanitizeState is a silent data-loss rule (the confirm handler pushed a
 * 501st address, save() persisted it, and the next load trimmed it away
 * — the address whose checkphrase the user had just read back and
 * confirmed, gone under a "✓ added to vault" message; and every stored
 * address costs a 40,000-round PBKDF2 derivation in the boot checkphrase
 * verify, so an unbounded vault is a boot-time herd too). */
function addressRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) n = 0;
  return Math.max(0, MAX_VAULT_ADDRESSES - n);
}
/* How many more DISTINCT days fit under MAX_PRICE_DAYS. The price form
 * — the only path that CREATES price days — must hold itself to this
 * room, not just the load-time sanitizer: a cap enforced only in
 * sanitizeState is a silent data-loss rule (the form filtered out the
 * same day, pushed a brand-new day as row 3,661, save() persisted it,
 * and the next load trimmed exactly that NEW price — the one the user
 * had just typed — while the form cleared as if it had been kept).
 * Replacing an existing day never consumes room: it does not grow the
 * table, so the form gates on NEW days only. */
function priceRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) n = 0;
  return Math.max(0, MAX_PRICE_DAYS - n);
}
/* CSV file gate (white-hat, 2026-10-16): importEventsCsv read the
 * WHOLE picked file with readAsText and parseCsv walked it
 * char-by-char building every row before eventRoom was consulted —
 * yet the importer can keep at most MAX_LEDGER_EVENTS events and
 * every kept field is capped (note 500 at import; source 64 / ref
 * 128 at sanitizeState; address 49; qty/fee within the 21M supply;
 * desk-minted ids ~16 chars, 128 allowed generously here). Measured
 * with this file's own exporter, the largest CSV the desk can
 * produce is 10,040,104 bytes with plain maxed fields and
 * 18,240,104 bytes when every text char is a quote (CSV
 * quote-doubling) — any larger file is guaranteed-capped-away only
 * after its full text and row tree were allocated (parseCsv of a
 * 26.1 MB / 60,001-row CSV takes ~3.6 s of synchronous work in
 * Node). File.size is known before a byte is read, so the importer
 * asks this fail-closed gate first: cap 32 MiB, ~1.8x the
 * worst-escaping largest export. */
var MAX_CSV_FILE_BYTES = 32 * 1024 * 1024;
function csvFileRoom(size) {
  return typeof size === "number" && isFinite(size) && size >= 0 && size <= MAX_CSV_FILE_BYTES;
}
function sanitizeState(raw, opts) {
  var clean = { addresses: [], events: [], prices: [], method: "FIFO" };
  if (!raw || typeof raw !== "object") return clean;
  var validateAddress = (opts && typeof opts.validateAddress === "function")
    ? opts.validateAddress : null;
  function addrOk(a) {
    if (typeof a !== "string" || !a) return false;
    if (validateAddress) { try { return !!validateAddress(a); } catch (e) { return false; } }
    return isSs58_189(a);
  }
  if (Array.isArray(raw.addresses)) {
    var seenAddr = {};
    raw.addresses.forEach(function (a) {
      if (clean.addresses.length >= MAX_VAULT_ADDRESSES) return;
      if (!a || typeof a !== "object" || Array.isArray(a)) return;
      if (!addrOk(a.address) || seenAddr[a.address]) return;
      seenAddr[a.address] = 1;
      // The checkphrase shape is exactly 5 words; a 3-word (or 6-word, or
      // non-string-bearing) stored set is not a checkphrase for anything.
      var words = (Array.isArray(a.words) && a.words.length === 5 &&
        a.words.every(function (w) { return typeof w === "string" && !!w; }))
        ? a.words.slice() : [];
      clean.addresses.push({
        address: a.address,
        label: typeof a.label === "string" ? a.label.slice(0, 80) : "",
        words: words,
        addedAt: (typeof a.addedAt === "number" && isFinite(a.addedAt) && a.addedAt >= 0) ? a.addedAt : 0
      });
    });
  }
  if (Array.isArray(raw.events)) {
    var seenId = {};
    raw.events.forEach(function (e, i) {
      if (clean.events.length >= MAX_LEDGER_EVENTS) return;
      if (!e || typeof e !== "object") return;
      if (!INFLOW[e.type] && !OUTFLOW[e.type]) return; // unknown type: engine would only flag it
      var dateMs = Number(e.dateMs);
      if (!isFinite(dateMs)) return;
      var qty = toBigIntOrNull(e.qtyPlanck);
      // An event without a real quantity is not an event — and no event
      // can move more QTC than exists: the supply is capped at 21M.
      if (qty === null || qty <= 0n || qty > MAX_SUPPLY_PLANCKS) return;
      var fee = toBigIntOrNull(e.feePlanck);
      if (fee === null || fee < 0n || fee > MAX_SUPPLY_PLANCKS) fee = 0n;
      var price = null;
      if (e.priceMicro !== null && e.priceMicro !== undefined) {
        price = toBigIntOrNull(e.priceMicro);
        if (price === null || price < 0n) price = null; // unpriced beats poisoned
      }
      var evAddr = typeof e.address === "string" ? e.address : "";
      if (evAddr && !addrOk(evAddr)) return; // unattributable: not a Quantus address
      var hasId = typeof e.id === "string" && !!e.id;
      if (hasId && seenId[e.id]) return; // duplicate match key: drop, first wins
      var id = hasId ? e.id : "ev-restored-" + i;
      while (seenId[id]) id += "-r"; // restored ids must not collide either
      seenId[id] = 1;
      clean.events.push({
        id: id,
        dateMs: dateMs, type: e.type,
        address: evAddr,
        qtyPlanck: qty, priceMicro: price, feePlanck: fee,
        note: typeof e.note === "string" ? e.note.slice(0, 500) : "",
        source: typeof e.source === "string" ? e.source.slice(0, 64) : "manual",
        ref: typeof e.ref === "string" ? e.ref.slice(0, 128) : "",
        internal: !!e.internal,
        flags: Array.isArray(e.flags) ? e.flags.filter(function (f) { return typeof f === "string"; }).slice(0, 16).map(function (f) { return f.slice(0, 32); }) : []
      });
    });
  }
  if (Array.isArray(raw.prices)) {
    var pricePos = {};
    raw.prices.forEach(function (p) {
      if (!p || typeof p !== "object" || typeof p.day !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) return;
      // Real calendar dates only: the regex alone admits 2026-02-31 and
      // 2026-99-99, which then sort and price-lookup as genuine days.
      var dt = new Date(p.day + "T00:00:00Z");
      if (!isFinite(dt.getTime()) || dt.toISOString().slice(0, 10) !== p.day) return;
      var micro = toBigIntOrNull(p.micro);
      if (micro === null || micro < 0n) return;
      if (Object.prototype.hasOwnProperty.call(pricePos, p.day)) {
        // Duplicate day: priceLookup scans in order and the LAST row wins,
        // so the last row is the one that was actually in effect — keep it.
        clean.prices[pricePos[p.day]] = { day: p.day, micro: micro };
        return;
      }
      if (clean.prices.length >= MAX_PRICE_DAYS) return;
      pricePos[p.day] = clean.prices.length;
      clean.prices.push({ day: p.day, micro: micro });
    });
  }
  if (raw.method === "FIFO" || raw.method === "LIFO" || raw.method === "HIFO") clean.method = raw.method;
  return clean;
}

// ---- Snapshot-boundary relations (round 2) --------------------------------
// Round 1 checked each snapshot field's shape alone. These validators check
// RELATIONS between fields and between snapshots, verified against live
// indexer data (head ~205,505, 2026-10-11): the miners buckets tile the
// window contiguously with span-exact block counts, per-bucket miner counts
// sum to the bucket span, window_miners restates the bucket sums exactly,
// all_time covers the window for every shared address, the live status
// height equals blocks[0], flows meta restates its payload's count and
// head, and every height/amount sits inside the chain's own bounds
// (heights 1..10,000,000 fleet bound; amounts within the 21M QTC cap).
// Core corruption fails the scan honestly; only row-level poison drops a
// row. Cross-snapshot heads may drift by capture skew (the refresh writes
// the files seconds apart), never by a generation.
var MAX_CHAIN_HEIGHT = 10000000;
var MAX_SUPPLY_PLANCKS = 21000000n * PLANCK;
var GENESIS_FLOOR_MS = Date.UTC(2026, 8, 1); // chain lifetime floor (fleet)
var HEAD_SKEW_BLOCKS = 1000;
// The miners snapshot's producer caps (scripts/fetch-miner-data.mjs): the
// window is always WINDOW_BLOCKS = 15,000 blocks sliced into BUCKET_SIZE
// = 500 buckets, so a producer file carries at most ceil(15000 / 500) =
// 30 buckets. validateMiners held the buckets to every tiling relation
// but to no count — a crafted file tiling a 200,000-block "window" with
// 200,000 one-block buckets satisfied every relation and was walked
// whole (span check + Object.keys per bucket) before the scan inferred
// a single row. Both RAW values are now checked before the bucket loop;
// an over-cap payload is not producer data and fails the scan honestly,
// like any other core corruption.
// Round 2 of the miners caps (2026-10-18): the per-bucket MINER MAPS and
// window_miners itself. validCount accepts 0, so a bucket's counts can
// sum honestly to its span while the map carries 500,000 zero-count
// keys — walked key-by-key before the span relation could reject
// (566.9 ms in Node) — and a 501-key zero-padded bucket over a 500 span
// was ACCEPTED whole, its window_miners restating the padded sums
// exactly. The producer emits only counts >= 1 (one author per block),
// so a bucket holds at most BUCKET_SIZE = 500 keys and window_miners at
// most WINDOW_BLOCKS = 15,000; both RAW counts are now checked before
// their walks. (Portfolio Desk's sanitizeMinedCounts and the Mining
// Observatory's sanitizeMiners close the same walks in their shapes —
// Batch 181.)
var MAX_MINERS_WINDOW_BLOCKS = 15000; // producer WINDOW_BLOCKS in scripts/fetch-miner-data.mjs
var MAX_MINERS_BUCKETS = 30;          // producer ceil(WINDOW_BLOCKS / BUCKET_SIZE)
var MAX_MINERS_BUCKET_KEYS = 500;     // producer BUCKET_SIZE: one author per block, counts >= 1

function validChainHeight(v) {
  var n;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) return null;
    n = v;
  } else if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v.trim())) {
    n = Number(v.trim());
    if (!Number.isSafeInteger(n)) return null;
  } else return null;
  return (n >= 1 && n <= MAX_CHAIN_HEIGHT) ? n : null;
}
function validCount(v) {
  // An integer >= 0 (number, or canonical integer string); 2.5, "abc", -1,
  // "" and booleans are poison, never a coerced count.
  if (typeof v === "number") return (Number.isSafeInteger(v) && v >= 0) ? v : null;
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v.trim())) {
    var n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}
function validChainTimeMs(ms, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  return typeof ms === "number" && isFinite(ms) &&
    ms >= GENESIS_FLOOR_MS && ms <= now + 3600000;
}
function isSs58_189(a) {
  // Strict indexer shape: qz + 47 base58 chars (49 total), fleet pattern.
  return typeof a === "string" && /^qz[1-9A-HJ-NP-Za-km-z]{47}$/.test(a);
}
function isPlainObject(o) {
  return !!o && typeof o === "object" && !Array.isArray(o);
}

// The live snapshot's head is the scan's anchor: its status height must
// restate blocks[0] exactly, both fleet-bounded, and the head timestamp
// must sit inside the chain's lifetime. Returns the head height or null.
function validateLiveHead(live, nowMs) {
  if (!live || live.ok !== true || !isPlainObject(live.data)) return null;
  var blocks = live.data.blocks;
  if (!Array.isArray(blocks) || !blocks.length || !isPlainObject(blocks[0])) return null;
  var head = validChainHeight(blocks[0].height);
  if (head === null) return null;
  if (!isPlainObject(live.data.status) ||
      validChainHeight(live.data.status.block_height) !== head) return null;
  var ts = Date.parse(blocks[0].timestamp);
  if (!validChainTimeMs(ts, nowMs)) return null;
  return head;
}

// The miners snapshot is internally one claim about the window: buckets
// tile [window.start_height, window.end_height] contiguously, each
// bucket's `blocks` restates its span and the sum of its miner counts,
// window_miners restates the per-address bucket sums exactly, the window
// ends at the snapshot's own chain_height within capture skew of the live
// head, and all_time covers the window for every shared address (the
// pre-window split all - window is meaningless otherwise — and a MISSING
// window_miners used to read as 0, double-counting every window block in
// the pre-window aggregate). Returns the validated window or null.
function validateMiners(miners, liveHead) {
  if (!miners || miners.ok !== true) return null;
  var chainHeight = validChainHeight(miners.chain_height);
  if (chainHeight === null) return null;
  if (typeof liveHead === "number" &&
      Math.abs(chainHeight - liveHead) > HEAD_SKEW_BLOCKS) return null;
  var win = miners.window;
  if (!isPlainObject(win)) return null;
  var startH = validChainHeight(win.start_height);
  var endH = validChainHeight(win.end_height);
  if (startH === null || endH === null || startH > endH) return null;
  if (endH !== chainHeight) return null;
  var blockCount = validCount(win.block_count);
  if (blockCount === null || blockCount !== endH - startH + 1) return null;
  if (blockCount > MAX_MINERS_WINDOW_BLOCKS) return null; // producer window cap, before the bucket walk
  var blockS = Number(win.observed_block_time_s);
  if (!isFinite(blockS) || blockS <= 0 || blockS > 3600) return null;
  var buckets = miners.buckets;
  if (!Array.isArray(buckets) || !buckets.length) return null;
  if (buckets.length > MAX_MINERS_BUCKETS) return null; // producer bucket-count cap, before the bucket walk
  var sums = {};
  for (var i = 0; i < buckets.length; i++) {
    var b = buckets[i];
    if (!isPlainObject(b)) return null;
    var bs = validChainHeight(b.start), be = validChainHeight(b.end);
    if (bs === null || be === null || bs > be) return null;
    if (i === 0 && bs !== startH) return null;
    if (i > 0 && bs !== validChainHeight(buckets[i - 1].end) + 1) return null;
    if (i === buckets.length - 1 && be !== endH) return null;
    var span = validCount(b.blocks);
    if (span === null || span !== be - bs + 1) return null;
    if (!isPlainObject(b.miners)) return null;
    var sum = 0;
    // Producer key-count cap, counted with an early exit at the
    // cap + 1: an over-cap map is refused with no per-key validation
    // walk (566.9 ms pre-fix; the residual ~160-180 ms is the
    // runtime's key-enumeration snapshot, identical for Object.keys
    // and for-in on a dictionary-mode object in this Node build).
    var bkeyCount = 0;
    for (var bk in b.miners) {
      if (Object.prototype.hasOwnProperty.call(b.miners, bk)) {
        bkeyCount++;
        if (bkeyCount > MAX_MINERS_BUCKET_KEYS) return null;
      }
    }
    var addrs = Object.keys(b.miners);
    for (var j = 0; j < addrs.length; j++) {
      var c = validCount(b.miners[addrs[j]]);
      if (c === null) return null;
      sum += c;
      sums[addrs[j]] = (sums[addrs[j]] || 0) + c;
    }
    if (sum !== span) return null;
  }
  if (!isPlainObject(miners.window_miners)) return null;
  // Producer key-count cap, early-exit counted like the bucket maps.
  var wmCount = 0;
  for (var wmk in miners.window_miners) {
    if (Object.prototype.hasOwnProperty.call(miners.window_miners, wmk)) {
      wmCount++;
      if (wmCount > MAX_MINERS_WINDOW_BLOCKS) return null;
    }
  }
  var wmKeys = Object.keys(miners.window_miners);
  var total = 0;
  for (var k = 0; k < wmKeys.length; k++) {
    var wv = validCount(miners.window_miners[wmKeys[k]]);
    if (wv === null || sums[wmKeys[k]] !== wv) return null;
    total += wv;
  }
  if (Object.keys(sums).length !== wmKeys.length || total !== blockCount) return null;
  if (miners.all_time !== undefined && miners.all_time !== null) {
    if (!Array.isArray(miners.all_time)) return null;
    var seen = {};
    for (var a = 0; a < miners.all_time.length; a++) {
      var row = miners.all_time[a];
      if (!isPlainObject(row) || !isSs58_189(row.address)) return null;
      var ab = validCount(row.blocks);
      if (ab === null || ab < 1) return null;
      if (seen[row.address]) return null;
      seen[row.address] = 1;
      var wmv = miners.window_miners[row.address];
      if (wmv !== undefined && ab < validCount(wmv)) return null;
    }
  }
  return { startHeight: startH, endHeight: endH, chainHeight: chainHeight, blockTimeS: blockS };
}

// The flows envelope: when meta is present (format v2) ok is required
// and the meta's transfer count must restate the payload length and its
// chain height must be a real height within capture skew of the live
// head. A v1 payload (no meta, no ok \u2014 the pre-v2 envelope) has
// nothing to restate and passes on shape alone: flows-decode guarantees
// stale cached v1 snapshots keep working mid-deploy.
function validateFlowsMeta(flows, liveHead) {
  if (!flows || !Array.isArray(flows.transfers)) return false;
  var meta = flows.meta;
  if (meta === undefined || meta === null) return true;
  if (flows.ok !== true || !isPlainObject(meta)) return false;
  if (meta.transfers !== undefined && validCount(meta.transfers) !== flows.transfers.length) return false;
  if (meta.chain_height !== undefined) {
    var mh = validChainHeight(meta.chain_height);
    if (mh === null) return false;
    if (typeof liveHead === "number" && Math.abs(mh - liveHead) > HEAD_SKEW_BLOCKS) return false;
  }
  return true;
}

var api = {
  PLANCK: PLANCK, QUANTUM: QUANTUM, EMISSION_DIVISOR: EMISSION_DIVISOR,
  MICRO: MICRO, LONG_TERM_DAYS: LONG_TERM_DAYS,
  MAX_CHAIN_HEIGHT: MAX_CHAIN_HEIGHT, MAX_SUPPLY_PLANCKS: MAX_SUPPLY_PLANCKS,
  GENESIS_FLOOR_MS: GENESIS_FLOOR_MS, HEAD_SKEW_BLOCKS: HEAD_SKEW_BLOCKS,
  MAX_MINERS_WINDOW_BLOCKS: MAX_MINERS_WINDOW_BLOCKS, MAX_MINERS_BUCKETS: MAX_MINERS_BUCKETS,
  MAX_MINERS_BUCKET_KEYS: MAX_MINERS_BUCKET_KEYS,
  validChainHeight: validChainHeight, validCount: validCount,
  validChainTimeMs: validChainTimeMs, isSs58_189: isSs58_189,
  validateLiveHead: validateLiveHead, validateMiners: validateMiners,
  validateFlowsMeta: validateFlowsMeta,
  toBigIntOrNull: toBigIntOrNull, sanitizeState: sanitizeState,
  MAX_VAULT_ADDRESSES: MAX_VAULT_ADDRESSES, MAX_LEDGER_EVENTS: MAX_LEDGER_EVENTS,
  MAX_PRICE_DAYS: MAX_PRICE_DAYS, eventRoom: eventRoom, addressRoom: addressRoom, priceRoom: priceRoom,
  MAX_CSV_FILE_BYTES: MAX_CSV_FILE_BYTES, csvFileRoom: csvFileRoom,
  rewardModelPlancks: rewardModelPlancks,
  parseQtcToPlanck: parseQtcToPlanck, formatQtc: formatQtc, MAX_AMOUNT_CHARS: MAX_AMOUNT_CHARS,
  parseUsdPerQtcToMicro: parseUsdPerQtcToMicro, formatUsd: formatUsd,
  usdValueMicro: usdValueMicro, dayKey: dayKey,
  INFLOW: INFLOW, OUTFLOW: OUTFLOW, INCOME_TYPES: INCOME_TYPES,
  normEvent: normEvent, methodSort: methodSort,
  runLedger: runLedger, taxYearReport: taxYearReport,
  eventsToCsv: eventsToCsv, parseCsv: parseCsv,
  csvGuardText: csvGuardText, csvUnguardText: csvUnguardText
};
global.QTCLedger = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
