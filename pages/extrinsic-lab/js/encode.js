'use strict';
/* QTC Extrinsic Lab — extrinsic ENCODER (lab samples only).
 * Mirrors QEL_DECODE's wire layout so locally generated sample extrinsics
 * round-trip through the real decoder and verifier. NOT used on pasted hex. */
(function (global) {
  function concat(...arrs) {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  function u8(v) { return Uint8Array.of(v & 0xff); }
  function u32le(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return b;
  }
  function u128le(v) {
    let n = BigInt(v), out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
    return out;
  }
  function compactEncode(v) {
    v = BigInt(v);
    if (v < 64n) return u8(Number(v) << 2);
    if (v < 16384n) { const n = Number(v); return Uint8Array.of((n & 63) << 2 | 1, n >> 6); }
    if (v < 1073741824n) { const n = Number(v); return Uint8Array.of((n & 63) << 2 | 2, (n >> 6) & 0xff, (n >> 14) & 0xff, (n >> 22) & 0xff); }
    const bytes = [];
    let t = v;
    while (t > 0n) { bytes.push(Number(t & 0xffn)); t >>= 8n; }
    return concat(u8(((bytes.length - 4) << 2) | 3), Uint8Array.from(bytes));
  }
  function lenPrefix(bytes) { return concat(compactEncode(bytes.length), bytes); }
  function accountBytes(pub32) { return concat(u8(0), pub32); } // MultiAddress::Id
  function sigEnum(variant, sig) { return concat(u8(variant), sig); }

  /* Signs a SignedPayload (or its blake2-256 digest when >256 bytes) and
   * assembles the full length-prefixed extrinsic hex. */
  function encodeExtrinsic(opts) {
    const { callBytes, pub32, pubKey, sigVariant, signature, eraBytes, nonce, tip,
            metadataHashMode, signFn } = opts;
    let sigPayloadBytes, hashed;
    if (signFn) {
      const built = global.QEL_DECODE.buildSigningPayload(
        { callBytes: callBytes, eraBytes: eraBytes, nonce: BigInt(nonce || 0),
          tip: BigInt(tip || 0), metadataHashMode: metadataHashMode || 0 },
        { specVersion: opts.specVersion || 153, txVersion: opts.txVersion || 6,
          genesisHash: opts.genesisHash, eraBirthHash: opts.eraBirthHash });
      hashed = built.hashed;
      sigPayloadBytes = hashed ? global.QEL_NOBLE.blake2b(built.payload, { dkLen: 32 }) : built.payload;
    }
    const signatureBytes = signature || signFn(sigPayloadBytes);
    // Wire signature section = variant byte || signature || full ML-DSA public key
    // (the chain embeds the whole 1952/2592-byte key inline — hence ~7 KB txs).
    const sigSection = concat(sigEnum(sigVariant, signatureBytes), pubKey);
    const parts = [
      u8(0x84),
      accountBytes(pub32),
      sigSection,
      eraBytes,
      compactEncode(BigInt(nonce || 0)),
      compactEncode(BigInt(tip || 0)),
      u8(metadataHashMode || 0),
      callBytes,
    ];
    const body = concat(...parts);
    return '0x' + Array.from(lenPrefix(body), b => b.toString(16).padStart(2, '0')).join('');
  }

  global.QEL_ENCODE = { concat, u8, u32le, u128le, compactEncode, lenPrefix,
                        accountBytes, sigEnum, encodeExtrinsic };
  if (typeof module !== "undefined" && module.exports) module.exports = global.QEL_ENCODE;
})(typeof globalThis !== "undefined" ? globalThis : this);
