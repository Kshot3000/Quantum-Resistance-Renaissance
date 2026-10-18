/* QTC flows snapshot codec — shared by every app that reads data/flows.json
 * (flow-tracer, watchtower, portfolio-desk, ledger-desk).
 * Browser global: QFlows. Node: module.exports.
 *
 * Format v2 (2026-10-02): columnar + dictionary-encoded, LOSSLESS.
 * v1 stored an array of 8-key objects (~344 bytes/row): the JSON key names,
 * and the full 51-char SS58 address on every row, dominated the file. v2
 * stores each distinct address once in `addresses`, each distinct fee once
 * in `fees`, and one compact array per transfer:
 *
 *   { ok: true, meta: { …, format: 2, columns: [...] },
 *     addresses: ["qz…", …], fees: ["0", "803402500", …],
 *     transfers: [[id, amount, fromIdx, toIdx, block_height,
 *                  timestamp, feeIdx, extrinsic_id], …] }
 *
 * Every v1 field survives the round trip exactly (amount stays a planck
 * string for BigInt math; timestamp/extrinsic_id keep null). `ok: true`
 * matches the envelope of every other data/*.json snapshot — its absence
 * in v1 silently broke portfolio-desk, whose snapshot picker requires it.
 *
 * decode() passes v1 payloads (object rows) through untouched, so a stale
 * cached snapshot can never break a consumer mid-deploy.
 *
 * Producer-count caps (2026-10-17, white-hat load boundary): decode() is
 * the FIRST code every consumer runs on this payload — ahead of all four
 * apps' own sanitizers — so an unbounded transfers list was materialized
 * into that many row objects before any validator could refuse it (a
 * crafted 500,000-row file decoded whole, ok:true, in a Node probe).
 * The producer (scripts/fetch-flow-data.mjs) bounds what it can write:
 * the recent window paginates PAGE=1000 at offsets 0..40000 and its page
 * guard throws rather than write past that (a written file therefore
 * holds at most 40 full pages + a partial page = 40,999 recent rows),
 * the all-time list is limit:600, and the merged genesis set is the
 * 22-transfer block-1 allocation — at most 41,621 rows in total. The
 * encoder interns at most 2 addresses and 1 fee per row, so the
 * dictionaries cap at 83,242 / 41,621. decode() checks the RAW lengths
 * against these caps before any row is walked, in BOTH the v2 shape
 * and the v1 pass-through (an over-cap v1 file is not a stale cache,
 * it is the same bomb without the dictionaries). An over-cap payload
 * fails closed as { ok: false, meta, addresses: [], fees: [],
 * transfers: [] }: the money-touching consumers refuse it through
 * their existing ok/meta-restatement gates (ledger-desk aborts the
 * scan, flow-tracer throws its malformed-snapshot error, portfolio's
 * ok-gated picker discards it) and nothing is painted from it anywhere.
 * Truncating to the cap instead would paint a partial flow window as
 * the complete capture.
 */
(function (global) {
"use strict";

var FORMAT = 2;
var COLUMNS = ["id", "amount", "from", "to", "block_height", "timestamp", "fee", "extrinsic_id"];

/* Producer ceilings from scripts/fetch-flow-data.mjs (see header). */
var MAX_RECENT = 40999;   // 40 full pages of 1000 + a partial page; the page guard throws past offset 40000
var MAX_WHALES = 600;     // transfer(limit: 600), all-time largest
var MAX_GENESIS = 22;     // the block-1 genesis allocation merged from data/supply.json
var MAX_TRANSFERS = MAX_RECENT + MAX_WHALES + MAX_GENESIS; // 41,621
var MAX_ADDRESSES = 2 * MAX_TRANSFERS; // the encoder interns at most 2 per row: 83,242
var MAX_FEES = MAX_TRANSFERS;          // the encoder interns at most 1 per row: 41,621

function encode(rows, meta) {
  var addrIdx = new Map(), addresses = [];
  var feeIdx = new Map(), fees = [];
  function intern(map, list, v) {
    var i = map.get(v);
    if (i === undefined) { i = list.length; map.set(v, i); list.push(v); }
    return i;
  }
  var transfers = rows.map(function (r) {
    return [
      String(r.id),
      String(r.amount),
      intern(addrIdx, addresses, String(r.from_id)),
      intern(addrIdx, addresses, String(r.to_id)),
      r.block_height,
      r.timestamp || null,
      intern(feeIdx, fees, String(r.fee == null ? "0" : r.fee)),
      r.extrinsic_id || null,
    ];
  });
  var m = {};
  for (var k in meta) m[k] = meta[k];
  m.format = FORMAT;
  m.columns = COLUMNS.slice();
  return { ok: true, meta: m, addresses: addresses, fees: fees, transfers: transfers };
}

function isV2(json) {
  return !!(json && Array.isArray(json.transfers) && json.transfers.length &&
            Array.isArray(json.transfers[0]) && Array.isArray(json.addresses));
}

function overCapRefusal(json) {
  return { ok: false, meta: json.meta || null, addresses: [], fees: [], transfers: [] };
}

function decode(json) {
  if (!json || !Array.isArray(json.transfers)) return json;
  /* Raw-count producer caps BEFORE any row is walked (both shapes). */
  if (json.transfers.length > MAX_TRANSFERS) return overCapRefusal(json);
  if (Array.isArray(json.addresses) && json.addresses.length > MAX_ADDRESSES) return overCapRefusal(json);
  if (Array.isArray(json.fees) && json.fees.length > MAX_FEES) return overCapRefusal(json);
  if (!isV2(json)) return json; // v1 object rows (or empty): already decoded shape
  var addresses = json.addresses, fees = json.fees || [];
  var transfers = json.transfers.map(function (r) {
    return {
      id: r[0],
      amount: r[1],
      from_id: addresses[r[2]],
      to_id: addresses[r[3]],
      block_height: r[4],
      timestamp: r[5],
      fee: fees[r[6]] != null ? fees[r[6]] : "0",
      extrinsic_id: r[7],
    };
  });
  var out = {};
  for (var k in json) out[k] = json[k];
  out.transfers = transfers;
  return out;
}

var api = { FORMAT: FORMAT, COLUMNS: COLUMNS, encode: encode, decode: decode, isV2: isV2,
  MAX_TRANSFERS: MAX_TRANSFERS, MAX_ADDRESSES: MAX_ADDRESSES, MAX_FEES: MAX_FEES,
  MAX_RECENT: MAX_RECENT, MAX_WHALES: MAX_WHALES, MAX_GENESIS: MAX_GENESIS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.QFlows = api;
})(typeof window !== "undefined" ? window : globalThis);
