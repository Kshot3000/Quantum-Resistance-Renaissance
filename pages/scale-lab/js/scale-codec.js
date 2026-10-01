/* QTC SCALE Lab — the SCALE codec (classic script, UMD as window.QSL_CODEC).
 *
 * Implements the Substrate SCALE codec for the types Quantus developers touch
 * every day: canonical compact-integer encoding (all four modes), fixed-width
 * integers (signed/unsigned), bool, Option, Vec, arrays, tuples, structs,
 * C-like and payload enums, AccountId32 and UTF-8 strings.
 *
 * Canonicality: SCALE compact integers have exactly one valid encoding per
 * value. This module ENCODEs canonically (smallest mode, minimal bytes) and
 * can DECODE strictly — rejecting non-canonical encodings (e.g. a mode-2
 * encoding of a value that fits in mode 1). Strict decoding is what caught a
 * real mode-2 over-read bug in this builder's own extrinsic decoder
 * (2026-09-30): always decode strictly when you verify someone else's bytes.
 *
 * Pure functions only — no DOM, no network. All values that can exceed
 * Number.MAX_SAFE_INTEGER are BigInt.
 */
(function () {
  "use strict";

  var PLANCKS_PER_QTC = 1000000000000n;

  /* ---------- byte helpers ---------- */
  function concat(arrays) {
    var n = 0, i, a;
    for (i = 0; i < arrays.length; i++) n += arrays[i].length;
    var out = new Array(n), o = 0;
    for (i = 0; i < arrays.length; i++) { a = arrays[i]; for (var j = 0; j < a.length; j++) out[o++] = a[j] & 0xff; }
    return out;
  }
  function hexOf(bytes) {
    return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
  }
  function fromHex(s) {
    s = String(s).replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(s) || s.length % 2 !== 0) return null;
    var out = [];
    for (var i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }

  function CodecError(msg, offset) {
    this.name = "CodecError"; this.message = msg; this.offset = (offset === undefined ? -1 : offset);
  }
  CodecError.prototype = Object.create(Error.prototype);

  /* ---------- compact integers (canonical) ---------- */
  var COMPACT_MAX = (1n << 536n) - 1n; // mode 3 covers up to 2^536 - 1
  function compactEncode(v) {
    v = BigInt(v);
    if (v < 0n) throw new CodecError("compact cannot encode negative values");
    if (v > COMPACT_MAX) throw new CodecError("compact value exceeds 2^536 - 1");
    if (v < 64n) return [Number(v << 2n)];                                   // mode 0
    if (v < 16384n) { var w = Number((v << 2n) | 1n); return [w & 0xff, (w >> 8) & 0xff]; } // mode 1
    if (v < 1073741824n) {                                                   // mode 2
      var w2 = Number((v << 2n) | 2n);
      return [w2 & 0xff, (w2 >> 8) & 0xff, (w2 >> 16) & 0xff, (w2 >> 24) & 0xff];
    }
    var nbytes = 0, t = v;                                                   // mode 3
    while (t > 0n) { nbytes++; t >>= 8n; }
    nbytes = Math.max(nbytes, 4);
    var out = [((nbytes - 4) << 2) | 3];
    for (var i = 0; i < nbytes; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
    return out;
  }
  function compactModeName(m) { return ["single-byte", "two-byte", "four-byte", "big-integer"][m]; }
  /* Decode. strict=true rejects non-canonical encodings (re-encode check). */
  function compactDecode(bytes, offset, strict) {
    offset = offset || 0;
    if (offset >= bytes.length) throw new CodecError("unexpected end of input", offset);
    var first = bytes[offset], mode = first & 3, v, len;
    if (mode === 0) { v = BigInt(first >> 2); len = 1; }
    else if (mode === 1) {
      if (offset + 2 > bytes.length) throw new CodecError("truncated two-byte compact", offset);
      v = BigInt(((first | (bytes[offset + 1] << 8)) >> 2)); len = 2;
    } else if (mode === 2) {
      if (offset + 4 > bytes.length) throw new CodecError("truncated four-byte compact", offset);
      var w = (first | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
      v = BigInt(w >>> 2); len = 4;
    } else {
      var nbytes = (first >> 2) + 4;
      if (offset + 1 + nbytes > bytes.length) throw new CodecError("truncated big-integer compact", offset);
      v = 0n;
      for (var i = nbytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + 1 + i]);
      len = 1 + nbytes;
    }
    var canonical = hexOf(compactEncode(v)) === hexOf(bytes.slice(offset, offset + len));
    if (strict && !canonical)
      throw new CodecError("non-canonical compact encoding (canonical form: 0x" + hexOf(compactEncode(v)) + ")", offset);
    return { value: v, bytesRead: len, mode: mode, modeName: compactModeName(mode), canonical: canonical,
             canonicalHex: "0x" + hexOf(compactEncode(v)) };
  }

  /* ---------- fixed-width integers ---------- */
  var INT_SIZES = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32,
                    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16, i256: 32 };
  function intEncode(kind, v) {
    var size = INT_SIZES[kind];
    if (!size) throw new CodecError("unknown int type " + kind);
    v = BigInt(v);
    var signed = kind[0] === "i", bits = BigInt(size * 8);
    var min = signed ? -(1n << (bits - 1n)) : 0n, max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    if (v < min || v > max) throw new CodecError(kind + " out of range");
    var u = signed && v < 0n ? (1n << bits) + v : v;
    var out = [];
    for (var i = 0; i < size; i++) out.push(Number((u >> BigInt(8 * i)) & 0xffn));
    return out;
  }
  function intDecode(kind, bytes, offset) {
    var size = INT_SIZES[kind];
    if (!size) throw new CodecError("unknown int type " + kind);
    offset = offset || 0;
    if (offset + size > bytes.length) throw new CodecError("truncated " + kind, offset);
    var u = 0n;
    for (var i = size - 1; i >= 0; i--) u = (u << 8n) | BigInt(bytes[offset + i]);
    if (kind[0] === "i") {
      var bits = BigInt(size * 8);
      if (u >= (1n << (bits - 1n))) u -= (1n << bits);
    }
    return { value: u, bytesRead: size };
  }

  /* ---------- schema-driven encode / decode ---------- */
  function enc(shape, value, spans, label, base) {
    var start = base, out, i, r;
    function span(l, b, e) { spans.push({ start: b, end: e, label: l }); }
    switch (shape.k) {
      case "bool":
        if (typeof value !== "boolean") throw new CodecError("bool needs true/false");
        out = [value ? 1 : 0]; span(label + " (bool)", start, start + 1); return { bytes: out, end: start + 1 };
      case "compact":
        out = compactEncode(value); span(label + " (compact)", start, start + out.length); return { bytes: out, end: start + out.length };
      case "u8": case "u16": case "u32": case "u64": case "u128": case "u256":
      case "i8": case "i16": case "i32": case "i64": case "i128": case "i256":
        out = intEncode(shape.k, value); span(label + " (" + shape.k + ")", start, start + out.length); return { bytes: out, end: start + out.length };
      case "balance":
        out = intEncode("u128", value); span(label + " (Balance u128)", start, start + out.length); return { bytes: out, end: start + out.length };
      case "accountid": {
        var acc = toByteArray(value, 32, "AccountId32 needs 32 bytes");
        span(label + " (AccountId32)", start, start + 32); return { bytes: acc, end: start + 32 };
      }
      case "bytes": case "str": {
        var raw = shape.k === "str" ? utf8Bytes(String(value)) : toByteArray(value, null, "bytes need a byte array");
        var pre = compactEncode(raw.length);
        out = pre.concat(raw);
        span(label + " (len " + raw.length + ")", start, start + pre.length);
        span(label + (shape.k === "str" ? " (utf8)" : " (bytes)"), start + pre.length, start + out.length);
        return { bytes: out, end: start + out.length };
      }
      case "option":
        if (value === null || value === undefined) { span(label + " (None)", start, start + 1); return { bytes: [0], end: start + 1 }; }
        r = enc(shape.inner, value, spans, label + ".Some", start + 1);
        span(label + " (Some)", start, start + 1);
        return { bytes: [1].concat(r.bytes), end: r.end };
      case "vec": {
        if (!Array.isArray(value)) throw new CodecError("Vec needs an array");
        var parts = [compactEncode(value.length)], cur = start + parts[0].length;
        span(label + " (len " + value.length + ")", start, cur);
        for (i = 0; i < value.length; i++) { r = enc(shape.inner, value[i], spans, label + "[" + i + "]", cur); parts.push(r.bytes); cur = r.end; }
        return { bytes: concat(parts), end: cur };
      }
      case "array": {
        if (!Array.isArray(value) || value.length !== shape.len) throw new CodecError("[" + shape.k + "; " + shape.len + "] needs exactly " + shape.len + " items");
        var ap = [], ac = start;
        for (i = 0; i < shape.len; i++) { r = enc(shape.inner, value[i], spans, label + "[" + i + "]", ac); ap.push(r.bytes); ac = r.end; }
        return { bytes: concat(ap), end: ac };
      }
      case "tuple": {
        if (!Array.isArray(value) || value.length !== shape.items.length) throw new CodecError("tuple arity mismatch");
        var tp = [], tc = start;
        for (i = 0; i < shape.items.length; i++) { r = enc(shape.items[i], value[i], spans, label + "." + i, tc); tp.push(r.bytes); tc = r.end; }
        return { bytes: concat(tp), end: tc };
      }
      case "struct": {
        var sp = [], sc = start;
        for (i = 0; i < shape.fields.length; i++) {
          var f = shape.fields[i];
          if (!(f.name in Object(value))) throw new CodecError("struct missing field '" + f.name + "'");
          r = enc(f.shape, value[f.name], spans, label + "." + f.name, sc); sp.push(r.bytes); sc = r.end;
        }
        return { bytes: concat(sp), end: sc };
      }
      case "enum": {
        var idx = typeof value === "object" && value !== null ? value.variant : value;
        if (typeof idx === "string") idx = shape.variants.findIndex(function (x) { return x.name === idx; });
        if (idx < 0 || idx >= shape.variants.length) throw new CodecError("enum variant out of range");
        var vr = shape.variants[idx];
        span(label + " (variant " + vr.name + ")", start, start + 1);
        var pay = (typeof value === "object" && value !== null) ? value.value : undefined;
        if (!vr.shape) return { bytes: [idx], end: start + 1 };
        r = enc(vr.shape, pay, spans, label + "." + vr.name, start + 1);
        return { bytes: [idx].concat(r.bytes), end: r.end };
      }
      default: throw new CodecError("unknown shape kind " + shape.k);
    }
  }

  function toByteArray(value, wantLen, msg) {
    var arr;
    if (typeof value === "string") { arr = fromHex(value); if (!arr) throw new CodecError(msg || "bad hex"); }
    else if (Array.isArray(value)) arr = value.slice();
    else throw new CodecError(msg || "bad bytes");
    if (wantLen !== null && arr.length !== wantLen) throw new CodecError((msg || "bad length") + " — got " + arr.length + ", want " + wantLen);
    return arr;
  }
  function utf8Bytes(s) {
    if (typeof TextEncoder !== "undefined") return Array.prototype.slice.call(new TextEncoder().encode(s));
    var out = [];
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out.push(c & 0xff); }
    return out;
  }
  function utf8Decode(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); }
    catch (e) { return null; }
  }

  function dec(shape, bytes, offset, spans, label, strict) {
    offset = offset || 0;
    var start = offset, v, i, r, parts;
    function span(l, b, e) { spans.push({ start: b, end: e, label: l }); }
    switch (shape.k) {
      case "bool":
        if (offset >= bytes.length) throw new CodecError("truncated bool", offset);
        if (strict && bytes[offset] !== 0 && bytes[offset] !== 1) throw new CodecError("bool must be 0x00 or 0x01", offset);
        v = bytes[offset] !== 0; span(label + " (bool)", start, start + 1); return { value: v, end: start + 1 };
      case "compact": {
        var c = compactDecode(bytes, offset, strict);
        span(label + " (compact/" + c.modeName + ")", start, start + c.bytesRead);
        return { value: c.value, end: start + c.bytesRead, info: c };
      }
      case "u8": case "u16": case "u32": case "u64": case "u128": case "u256":
      case "i8": case "i16": case "i32": case "i64": case "i128": case "i256":
      case "balance": {
        var kind = shape.k === "balance" ? "u128" : shape.k;
        r = intDecode(kind, bytes, offset);
        span(label + " (" + shape.k + ")", start, start + r.bytesRead);
        return { value: r.value, end: start + r.bytesRead };
      }
      case "accountid":
        if (offset + 32 > bytes.length) throw new CodecError("truncated AccountId32", offset);
        v = bytes.slice(offset, offset + 32);
        span(label + " (AccountId32)", start, start + 32); return { value: v, end: start + 32 };
      case "bytes": case "str": {
        var c2 = compactDecode(bytes, offset, !!strict);
        var blen = Number(c2.value);
        if (offset + c2.bytesRead + blen > bytes.length) throw new CodecError("truncated " + shape.k + " body", offset);
        var body = bytes.slice(offset + c2.bytesRead, offset + c2.bytesRead + blen);
        span(label + " (len " + blen + ")", start, start + c2.bytesRead);
        span(label + (shape.k === "str" ? " (utf8)" : " (bytes)"), start + c2.bytesRead, start + c2.bytesRead + blen);
        if (shape.k === "str") { var s = utf8Decode(body); if (s === null) throw new CodecError("invalid UTF-8", offset); return { value: s, end: start + c2.bytesRead + blen }; }
        return { value: body, end: start + c2.bytesRead + blen };
      }
      case "option":
        if (offset >= bytes.length) throw new CodecError("truncated Option tag", offset);
        if (bytes[offset] === 0) { span(label + " (None)", start, start + 1); return { value: null, end: start + 1 }; }
        if (bytes[offset] !== 1) throw new CodecError("Option tag must be 0x00 or 0x01", offset);
        span(label + " (Some)", start, start + 1);
        r = dec(shape.inner, bytes, offset + 1, spans, label + ".Some", strict);
        return { value: r.value, end: r.end };
      case "vec": {
        var c3 = compactDecode(bytes, offset, !!strict);
        var n = Number(c3.value);
        if (n > 100000) throw new CodecError("Vec length absurd (" + n + ") — refusing", offset);
        var cur = offset + c3.bytesRead;
        span(label + " (len " + n + ")", start, cur);
        var items = [];
        for (i = 0; i < n; i++) { r = dec(shape.inner, bytes, cur, spans, label + "[" + i + "]", strict); items.push(r.value); cur = r.end; }
        return { value: items, end: cur };
      }
      case "array": {
        var av = [], ac = offset;
        for (i = 0; i < shape.len; i++) { r = dec(shape.inner, bytes, ac, spans, label + "[" + i + "]", strict); av.push(r.value); ac = r.end; }
        return { value: av, end: ac };
      }
      case "tuple": {
        var tv = [], tc = offset;
        for (i = 0; i < shape.items.length; i++) { r = dec(shape.items[i], bytes, tc, spans, label + "." + i, strict); tv.push(r.value); tc = r.end; }
        return { value: tv, end: tc };
      }
      case "struct": {
        var sv = {}, sc = offset;
        for (i = 0; i < shape.fields.length; i++) { r = dec(shape.fields[i].shape, bytes, sc, spans, label + "." + shape.fields[i].name, strict); sv[shape.fields[i].name] = r.value; sc = r.end; }
        return { value: sv, end: sc };
      }
      case "enum": {
        if (offset >= bytes.length) throw new CodecError("truncated enum discriminant", offset);
        var d = bytes[offset];
        if (d >= shape.variants.length) throw new CodecError("enum discriminant " + d + " out of range", offset);
        var vr = shape.variants[d];
        span(label + " (variant " + vr.name + ")", start, start + 1);
        if (!vr.shape) return { value: { variant: d, name: vr.name, value: null }, end: start + 1 };
        r = dec(vr.shape, bytes, offset + 1, spans, label + "." + vr.name, strict);
        return { value: { variant: d, name: vr.name, value: r.value }, end: r.end };
      }
      default: throw new CodecError("unknown shape kind " + shape.k);
    }
  }

  function encode(shape, value) {
    var spans = [];
    var r = enc(shape, value, spans, "root", 0);
    return { bytes: r.bytes, hex: "0x" + hexOf(r.bytes), spans: spans };
  }
  function decode(shape, bytes, strict) {
    var spans = [];
    var r = dec(shape, bytes, 0, spans, "root", strict);
    return { value: r.value, end: r.end, trailing: bytes.length - r.end, spans: spans };
  }

  /* ---------- display ---------- */
  function qtcOf(plancks) {
    plancks = BigInt(plancks);
    var neg = plancks < 0n;
    if (neg) plancks = -plancks;
    var whole = plancks / PLANCKS_PER_QTC;
    var frac = (plancks % PLANCKS_PER_QTC).toString().padStart(12, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "") + " QTC";
  }
  function prettyValue(v) {
    if (typeof v === "bigint") return v.toString();
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === "number") return "0x" + hexOf(v);
      return "[" + v.map(prettyValue).join(", ") + "]";
    }
    if (typeof v === "object") {
      if ("variant" in v) return v.name + (v.value === null ? "" : "(" + prettyValue(v.value) + ")");
      var ks = Object.keys(v);
      return "{ " + ks.map(function (k) { return k + ": " + prettyValue(v[k]); }).join(", ") + " }";
    }
    return String(v);
  }

  var api = {
    concat: concat, hexOf: hexOf, fromHex: fromHex, CodecError: CodecError,
    compactEncode: compactEncode, compactDecode: compactDecode,
    intEncode: intEncode, intDecode: intDecode,
    encode: encode, decode: decode,
    qtcOf: qtcOf, prettyValue: prettyValue,
    PLANCKS_PER_QTC: PLANCKS_PER_QTC
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.QSL_CODEC = api;
})();
