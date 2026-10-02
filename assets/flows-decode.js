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
 */
(function (global) {
"use strict";

var FORMAT = 2;
var COLUMNS = ["id", "amount", "from", "to", "block_height", "timestamp", "fee", "extrinsic_id"];

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

function decode(json) {
  if (!json || !Array.isArray(json.transfers)) return json;
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

var api = { FORMAT: FORMAT, COLUMNS: COLUMNS, encode: encode, decode: decode, isV2: isV2 };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.QFlows = api;
})(typeof window !== "undefined" ? window : globalThis);
