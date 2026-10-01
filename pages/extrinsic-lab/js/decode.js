/* QTC Extrinsic Lab — pure SCALE extrinsic decoder.
 * Decodes any Quantus extrinsic (signed or unsigned/inherent) into a byte-ranged
 * anatomy using the verified call table (QEL_CALLS). No network, no guessing:
 * unknown pallet/call indices decode as honestly-labeled raw bytes.
 *
 * Wire facts (verified, see pages/web-wallet/js/scale.js header):
 *   extrinsic = compact(len) ++ 0x84 ++ MultiAddress ++ SignatureEnum ++
 *               Era ++ compact(nonce) ++ compact(tip) ++ u8(metadataHashMode) ++ Call
 *   SignatureEnum: 0x00 = Dilithium87 [4627 sig || 2592 pub], 0x01 = Dilithium65 [3309 || 1952]
 *   Era: 0x00 immortal; else u16 LE mortal (period = 2 << (enc & 15))
 *   Call = u8(pallet) ++ u8(call) ++ args per QEL_CALLS shapes
 */
(function (global) {
"use strict";

var CT = function () { return global.QEL_CALLS; };

/* ---------------- bytes ---------------- */
function hexToBytes(hex) {
  var h = String(hex).trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new Error('not valid hex');
  var out = new Uint8Array(h.length / 2);
  for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  var s = '';
  for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}
function concatBytes(parts) {
  var total = 0, i;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total), o = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
  return out;
}

function Reader(bytes) { this.b = bytes; this.o = 0; }
Reader.prototype.left = function () { return this.b.length - this.o; };
Reader.prototype.u8 = function () {
  if (this.o >= this.b.length) throw new Error('unexpected end of input');
  return this.b[this.o++];
};
Reader.prototype.take = function (n) {
  if (this.o + n > this.b.length) throw new Error('unexpected end of input (need ' + n + ' bytes)');
  var s = this.b.subarray(this.o, this.o + n); this.o += n; return s;
};
Reader.prototype.u16le = function () { var b = this.take(2); return b[0] | (b[1] << 8); };
Reader.prototype.u32le = function () {
  var b = this.take(4);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
};
Reader.prototype.u64le = function () {
  var b = this.take(8), v = 0n;
  for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
};
Reader.prototype.u128le = function () {
  var b = this.take(16), v = 0n;
  for (var i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
};
Reader.prototype.compact = function () {
  var first = this.u8(), mode = first & 3;
  if (mode === 0) return BigInt(first >> 2);
  if (mode === 1) return BigInt(((first | (this.u8() << 8)) >> 2));
  if (mode === 2) { var w = (first | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0; return BigInt(w >>> 2); }
  var len = (first >> 2) + 4, b = this.take(len), v = 0n;
  for (var i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
};

/* ---------------- display helpers ---------------- */
var PLANCKS_PER_QTC = 1000000000000n;
function plancksToQtc(p) {
  var whole = p / PLANCKS_PER_QTC;
  var frac = (p % PLANCKS_PER_QTC).toString().padStart(12, '0').replace(/0+$/, '');
  return whole.toString() + (frac ? '.' + frac : '');
}
function ss58Of(bytes32) {
  try {
    if (global.QSS58) return global.QSS58.ss58Encode(Array.prototype.slice.call(bytes32), 189);
  } catch (e) {}
  return null;
}
function checkphraseOf(ss58) {
  try {
    if (global.QTC_CHECK && global.QTC_WORDLIST) {
      var w = global.QTC_CHECK.addressToChecksum(ss58, global.QTC_WORDLIST);
      return Array.isArray(w) ? w.join(' ') : String(w);
    }
  } catch (e) {}
  return null;
}
function accountDisplay(bytes32) {
  var ss58 = ss58Of(bytes32);
  return { kind: 'account', hex: '0x' + bytesToHex(bytes32), ss58: ss58, checkphrase: ss58 ? checkphraseOf(ss58) : null };
}
function utf8Try(bytes) {
  try {
    var s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/^[\x20-\x7e\s]*$/.test(s) && s.length) return s;
  } catch (e) {}
  return null;
}

/* ---------------- shape decoding ----------------
 * Returns { value, start, end } where value is a display object. */
function decodeShape(r, shape, depth) {
  depth = depth || 0;
  if (depth > 12) throw new Error('max decode depth exceeded');
  var start = r.o, v, i, n, arr, fld;
  switch (shape.k) {
    case 'u8': v = r.u8(); break;
    case 'u16': v = r.u16le(); break;
    case 'u32': v = r.u32le(); break;
    case 'u64': v = r.u64le(); break;
    case 'u128': v = r.u128le(); break;
    case 'bool': v = !!r.u8(); break;
    case 'compact': v = r.compact(); break;
    case 'accountId': v = accountDisplay(r.take(32)); break;
    case 'hash': v = { kind: 'hash', hex: '0x' + bytesToHex(r.take(32)) }; break;
    case 'multiaddr': v = decodeMultiAddress(r); break;
    case 'bytes': {
      n = Number(r.compact()); v = { kind: 'bytes', hex: '0x' + bytesToHex(r.take(n)), len: n };
      break;
    }
    case 'vec': {
      n = Number(r.compact()); arr = [];
      for (i = 0; i < n; i++) arr.push(decodeShape(r, shape.of, depth + 1));
      v = { kind: 'vec', len: n, items: arr };
      break;
    }
    case 'option': {
      var some = r.u8();
      if (some > 1) throw new Error('bad Option discriminant');
      v = some ? { kind: 'option', some: decodeShape(r, shape.of, depth + 1).value } : { kind: 'option', some: null };
      break;
    }
    case 'enum': {
      var vi = r.u8();
      var variant = null;
      for (i = 0; i < shape.variants.length; i++) if (shape.variants[i].index === vi || i === vi && shape.variants[i].index === undefined) { variant = shape.variants[i]; break; }
      if (!variant && shape.variants[vi]) variant = shape.variants[vi];
      if (!variant) throw new Error('unknown ' + shape.name + ' variant ' + vi);
      fld = [];
      for (i = 0; i < variant.fields.length; i++) fld.push(decodeShape(r, variant.fields[i], depth + 1));
      v = { kind: 'enum', name: shape.name, variant: variant.name, variantIndex: vi, fields: fld };
      break;
    }
    case 'callbytes': {
      n = Number(r.compact());
      var cb = r.take(n);
      var inner = decodeCallBytes(cb);
      v = { kind: 'callbytes', len: n, call: inner };
      break;
    }
    case 'call': {
      v = { kind: 'call', call: decodeCall(r, depth + 1) };
      break;
    }
    case 'opaque': {
      var on = r.left();
      v = { kind: 'opaque', why: shape.why, hex: '0x' + bytesToHex(r.take(on)), consumed: on };
      break;
    }
    default: throw new Error('unknown shape kind ' + shape.k);
  }
  return { value: v, start: start, end: r.o };
}

function decodeMultiAddress(r) {
  var start = r.o, variant = r.u8(), out = { kind: 'multiaddr', variant: variant, start: start };
  if (variant === 0) { out.variantName = 'Id'; out.account = accountDisplay(r.take(32)); }
  else if (variant === 1) { out.variantName = 'Index'; out.index = r.compact(); }
  else if (variant === 2) { var n = Number(r.compact()); out.variantName = 'Raw'; out.raw = '0x' + bytesToHex(r.take(n)); }
  else if (variant === 3) { out.variantName = 'Address32'; out.account = accountDisplay(r.take(32)); }
  else if (variant === 4) { out.variantName = 'Address20'; out.raw20 = '0x' + bytesToHex(r.take(20)); }
  else throw new Error('unknown MultiAddress variant ' + variant);
  out.end = r.o;
  return out;
}

/* Signature enum: 0x00 Dilithium87 [4627||2592], 0x01 Dilithium65 [3309||1952] */
var SIG_SIZES = { 0: { name: 'ML-DSA-87', sig: 4627, pub: 2592 }, 1: { name: 'ML-DSA-65', sig: 3309, pub: 1952 } };
function decodeSignature(r) {
  var start = r.o, variant = r.u8(), spec = SIG_SIZES[variant];
  if (!spec) throw new Error('unknown signature scheme variant ' + variant + ' (expected 0=ML-DSA-87, 1=ML-DSA-65)');
  var sig = r.take(spec.sig), pub = r.take(spec.pub);
  return { start: start, end: r.o, variant: variant, scheme: spec.name, sigHex: bytesToHex(sig), pubHex: bytesToHex(pub), account: accountDisplay(pub) };
}

function decodeEra(r) {
  var start = r.o, first = r.u8();
  if (first === 0) return { start: start, end: r.o, immortal: true };
  var second = r.u8();
  var enc = first | (second << 8);
  var period = 2 << (enc & 15);
  var quantize = Math.max(period >> 12, 1);
  var phase = (enc >> 4) * quantize;
  if (period < 4 || phase >= period) throw new Error('invalid mortal era encoding');
  return { start: start, end: r.o, immortal: false, period: period, phase: phase, quantize: quantize };
}
function eraBirth(current, period, phase) {
  var c = Math.max(current, phase);
  return Math.floor((c - phase) / period) * period + phase;
}

/* Decode a RuntimeCall from a reader positioned at pallet index byte. */
function decodeCall(r, depth) {
  var start = r.o;
  var pi = r.u8(), ci = r.u8();
  var hit = CT().lookupCall(pi, ci);
  var res = { start: start, palletIndex: pi, callIndex: ci, args: [], depth: depth || 0 };
  if (!hit.pallet) {
    res.unknown = 'pallet index ' + pi + ' is not in the runtime (checked against Quantus-Network/chain rev ' + CT().CALL_TABLE_META.rev + ')';
    res.raw = '0x' + bytesToHex(r.take(r.left()));
    res.end = r.o;
    return res;
  }
  res.palletName = hit.pallet.name;
  if (!hit.call) {
    res.unknown = 'call index ' + ci + ' is not a known dispatchable of ' + hit.pallet.name;
    res.raw = '0x' + bytesToHex(r.take(r.left()));
    res.end = r.o;
    return res;
  }
  res.callName = hit.call.name;
  res.rootOnly = !!hit.call.root;
  res.disabled = !!hit.call.disabled;
  for (var i = 0; i < hit.call.args.length; i++) {
    var a = hit.call.args[i], as = r.o;
    var d = decodeShape(r, a.shape, (depth || 0) + 1);
    res.args.push({ name: a.name, shape: a.shape, qtc: !!a.qtc, moment: !!a.moment, utf8: !!a.utf8, decoded: d.value, start: as, end: d.end });
  }
  res.end = r.o;
  return res;
}
function decodeCallBytes(bytes) {
  var r = new Reader(bytes);
  var c = decodeCall(r, 0);
  if (r.left() > 0) c.trailing = { bytes: r.left(), hex: '0x' + bytesToHex(r.take(r.left())) };
  return c;
}

/* ---------------- top-level extrinsic ---------------- */
function decodeExtrinsic(hexInput) {
  var bytes = hexToBytes(hexInput);
  var r = new Reader(bytes);
  var sections = [];
  function section(label, start, end, detail) { sections.push({ label: label, start: start, end: end, detail: detail || '' }); }

  var ls = r.o, len = Number(r.compact()), le = r.o;
  var bodyLen = bytes.length - le;
  var out = { totalBytes: bytes.length, lengthPrefix: len, lengthPrefixBytes: le - ls, lengthOk: len === bodyLen };

  var vs = r.o, version = r.u8();
  var signed = (version & 0x80) !== 0, vnum = version & 0x7f;
  out.version = { byte: version, signed: signed, format: vnum };
  section('version', vs, r.o, '0x' + version.toString(16) + ' — ' + (signed ? 'signed' : 'unsigned') + ', format v' + vnum);
  if (vnum !== 4) throw new Error('unsupported extrinsic format v' + vnum + ' (expected v4)');

  if (!signed) {
    // Inherent / unsigned: version ++ call
    var cs = r.o, call = decodeCall(r, 0);
    out.call = call;
    section('call', cs, r.o, (call.palletName || '?') + '.' + (call.callName || '?'));
    out.sections = sections;
    out.consumed = r.o;
    out.trailing = bytes.length - r.o;
    return out;
  }

  var ss = r.o, signer = decodeMultiAddress(r);
  out.signer = signer;
  section('signer', ss, r.o, signer.variantName + (signer.account && signer.account.ss58 ? ' ' + signer.account.ss58 : ''));

  var gs = r.o, sig = decodeSignature(r);
  out.signature = sig;
  section('signature', gs, r.o, sig.scheme + ' — ' + sig.sigHex.length / 2 + 'B sig + ' + sig.pubHex.length / 2 + 'B pubkey');

  var es = r.o, era = decodeEra(r);
  out.era = era;
  section('era', es, r.o, era.immortal ? 'immortal' : 'mortal: period ' + era.period + ', phase ' + era.phase);

  var ns = r.o, nonce = r.compact();
  out.nonce = nonce;
  section('nonce', ns, r.o, 'compact ' + nonce.toString());

  var ts = r.o, tip = r.compact();
  out.tip = tip;
  section('tip', ts, r.o, tip.toString() + ' plancks' + (tip > 0n ? ' (' + plancksToQtc(tip) + ' QTC)' : ''));

  var ms = r.o, mhash = r.u8();
  out.metadataHashMode = mhash;
  section('metadata-hash', ms, r.o, mhash === 0 ? '0x00 — CheckMetadataHash disabled' : '0x' + mhash.toString(16) + ' (non-standard)');

  var cs2 = r.o, call2 = decodeCall(r, 0);
  out.call = call2;
  section('call', cs2, r.o, (call2.palletName || 'pallet ' + call2.palletIndex) + '.' + (call2.callName || 'call ' + call2.callIndex));

  out.sections = sections;
  out.consumed = r.o;
  out.trailing = bytes.length - r.o;
  return out;
}

/* Rebuild the exact SignedPayload bytes the runtime verifies.
 * Mirrors pages/web-wallet/js/scale.js buildSigningPayload (verified Sept 30 2026):
 *   payload = call ++ era ++ compact(nonce) ++ compact(tip) ++ u8(metadataHashMode) ++
 *             u32(specVersion) ++ u32(txVersion) ++ genesisHash ++ eraBirthHash
 *   hashed with blake2-256 iff encoded length > 256. */
function buildSigningPayload(parts, ctx) {
  // parts: { callBytes, eraBytes, nonce, tip, metadataHashMode }
  // ctx: { specVersion, txVersion, genesisHash (32B), eraBirthHash (32B) }
  function u32le(n) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n), true); return b; }
  function compactEncode(v) {
    v = BigInt(v);
    if (v < 64n) return Uint8Array.of(Number(v) << 2);
    if (v < 16384n) { var x = Number(v << 2n) | 1; return Uint8Array.of(x & 255, (x >> 8) & 255); }
    if (v < 1073741824n) { var y = (v << 2n) | 2n; var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(y), true); return b; }
    var bytes = [], t = v;
    while (t > 0n) { bytes.push(Number(t & 255n)); t >>= 8n; }
    return concatBytes([Uint8Array.of(3 | ((bytes.length - 4) << 2)), Uint8Array.from(bytes)]);
  }
  var payload = concatBytes([
    parts.callBytes, parts.eraBytes,
    compactEncode(parts.nonce), compactEncode(parts.tip),
    Uint8Array.of(parts.metadataHashMode),
    u32le(ctx.specVersion), u32le(ctx.txVersion),
    ctx.genesisHash, ctx.eraBirthHash,
  ]);
  var hashed = payload.length > 256;
  return { payload: payload, hashed: hashed };
}

var api = {
  hexToBytes: hexToBytes, bytesToHex: bytesToHex, concatBytes: concatBytes,
  Reader: Reader, plancksToQtc: plancksToQtc, ss58Of: ss58Of, checkphraseOf: checkphraseOf,
  decodeExtrinsic: decodeExtrinsic, decodeCall: decodeCall, decodeCallBytes: decodeCallBytes,
  decodeEra: decodeEra, eraBirth: eraBirth, decodeMultiAddress: decodeMultiAddress,
  decodeSignature: decodeSignature, buildSigningPayload: buildSigningPayload,
  SIG_SIZES: SIG_SIZES,
};
global.QEL_DECODE = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
