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

/* ---------- planck <-> QTC ---------- */

function parseQtcToPlancks(str) {
  // Accepts "1", "1.5", "0.000001", "1,234.5". Returns BigInt plancks. Throws on garbage.
  if (typeof str !== "string") throw new Error("amount must be a string");
  var s = str.trim().replace(/,/g, "");
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
  // A row anchors balance rules, so it must be a string address with a
  // non-negative integer planck count — a negative "balance" (BigInt
  // accepts "-5") would fire balance_below on fiction.
  var m = new Map();
  (whalesTop || []).forEach(function (row) {
    if (!row || typeof row.address !== "string" || !row.address) return;
    var v = validPlancks(row.free_plancks);
    if (v !== null) m.set(row.address, v);
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

function validPlancks(v) {
  // Non-negative integer plancks as BigInt, or null. Strings must be pure
  // digits (BigInt alone accepts "-5" and throws on "12.5"/"1e3").
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

function parseableTs(v) {
  return typeof v === "string" && isFinite(Date.parse(v)) ? v : null;
}

var HASH32_RE = /^0x[0-9a-fA-F]{64}$/;

function sanitizeBlocks(rows) {
  // Only blocks whose height AND timestamp both validate may anchor the
  // head / stall math; hash and reward are kept only when well-formed.
  if (!Array.isArray(rows)) return [];
  var out = [];
  rows.forEach(function (b) {
    if (!b || typeof b !== "object") return;
    var h = parseHeight(b.height);
    var ts = parseableTs(b.timestamp);
    if (h === null || ts === null) return;
    var reward = validPlancks(b.reward);
    out.push({
      height: h, timestamp: ts,
      hash: typeof b.hash === "string" && HASH32_RE.test(b.hash) ? b.hash : null,
      reward: reward !== null ? reward.toString() : null,
    });
  });
  return out;
}

function sanitizeTransfers(rows) {
  // A transfer row anchors rule evaluation and the pulse table: id,
  // from/to, a non-negative integer amount, and an integer block height
  // are core — a row missing any of them is dropped, never repaired into
  // a plausible-looking transfer. A garbage timestamp is recoverable
  // (sorting and ages use block height), so it coerces to null.
  if (!Array.isArray(rows)) return [];
  var out = [];
  rows.forEach(function (t) {
    if (!t || typeof t !== "object") return;
    if (typeof t.id !== "string" || !t.id) return;
    if (typeof t.from_id !== "string" || !t.from_id) return;
    if (typeof t.to_id !== "string" || !t.to_id) return;
    var amt = validPlancks(t.amount);
    if (amt === null) return;
    var h = parseHeight(t.block_height);
    if (h === null) return;
    out.push({
      id: t.id, amount: amt.toString(), from_id: t.from_id, to_id: t.to_id,
      block_height: h, timestamp: parseableTs(t.timestamp),
      extrinsic_id: typeof t.extrinsic_id === "string" ? t.extrinsic_id : null,
    });
  });
  return out;
}

function sanitizeGovernance(data) {
  // Returns { referenda, upgrades, upgradesList } or null when the
  // payload's counts cannot be known. A FAILED governance load must read
  // as UNKNOWN — counting it as 0 resets the chain baselines, and the
  // next good scan then fires false "new referendum" alerts.
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.referenda) || !Array.isArray(data.upgrades)) return null;
  var refs = data.referenda.filter(function (r) { return !!r && typeof r === "object"; }).length;
  var ups = [];
  data.upgrades.forEach(function (u) {
    if (!u || typeof u !== "object") return;
    ups.push({ spec_version: nonNegInt(u.spec_version) });
  });
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

function sanitizeBaselines(raw) {
  var out = { addresses: {}, chain: blankChainBaseline() };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.addresses && typeof raw.addresses === "object" && !Array.isArray(raw.addresses)) {
    Object.keys(raw.addresses).forEach(function (addr) {
      var b = raw.addresses[addr];
      if (!b || typeof b !== "object") return;
      // A poisoned balance coerces to null (unknown): the next scan
      // re-baselines instead of throwing BigInt() on every scan forever.
      var bal = b.balance == null ? null : validPlancks(b.balance);
      out.addresses[addr] = {
        balance: bal !== null ? bal.toString() : null,
        seenIn: sanitizeIdList(b.seenIn),
        seenOut: sanitizeIdList(b.seenOut),
      };
    });
  }
  if (raw.chain && typeof raw.chain === "object" && !Array.isArray(raw.chain)) {
    out.chain = {
      referenda: raw.chain.referenda == null ? null : nonNegInt(raw.chain.referenda),
      upgrades: raw.chain.upgrades == null ? null : nonNegInt(raw.chain.upgrades),
      stallFiredHead: raw.chain.stallFiredHead == null ? null : parseHeight(raw.chain.stallFiredHead),
      seenWhale: sanitizeIdList(raw.chain.seenWhale),
    };
  }
  return out;
}

function sanitizeAlerts(raw) {
  // Stored alerts are rendered and counted: an entry survives only with
  // a string id and a parseable timestamp (its age is displayed). A bad
  // severity is recoverable (coerce to info) and a non-string address is
  // an annotation (coerce to null) — neither may brick the feed.
  if (!Array.isArray(raw)) return [];
  var out = [];
  raw.forEach(function (a) {
    if (!a || typeof a !== "object") return;
    if (typeof a.id !== "string" || !a.id) return;
    if (typeof a.title !== "string" || typeof a.detail !== "string") return;
    var ts = parseableTs(a.ts);
    if (ts === null) return;
    out.push({
      id: a.id,
      ruleId: typeof a.ruleId === "string" ? a.ruleId : null,
      address: typeof a.address === "string" ? a.address : null,
      severity: ["info", "warn", "crit"].indexOf(a.severity) !== -1 ? a.severity : "info",
      title: a.title, detail: a.detail, ts: ts,
      read: a.read === true,
      synthetic: a.synthetic === true ? true : undefined,
    });
  });
  return out;
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
        var need = parseFloat(rule.threshold);
        if (pct >= need) { fired = true; how = pct.toFixed(2) + "% (" + formatQtc(diff) + " QTC)"; }
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
      var mins = parseFloat(rule.threshold);
      if (!(mins > 0)) break;
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
  nonNegInt: nonNegInt,
  validPlancks: validPlancks,
  parseableTs: parseableTs,
  sanitizeBlocks: sanitizeBlocks,
  sanitizeTransfers: sanitizeTransfers,
  sanitizeGovernance: sanitizeGovernance,
  sanitizeBaselines: sanitizeBaselines,
  sanitizeAlerts: sanitizeAlerts,
  advanceAddressBaseline: advanceAddressBaseline,
  blankChainBaseline: blankChainBaseline,
  blankAddressBaseline: blankAddressBaseline,
  evaluateRules: evaluateRules,
  runSelfTest: runSelfTest,
};

global.QWATCH = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})(typeof globalThis !== "undefined" ? globalThis : this);
