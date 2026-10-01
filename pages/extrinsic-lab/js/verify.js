/* QTC Extrinsic Lab — local ML-DSA signature verification.
 * Re-derives the exact SignedPayload the runtime checks and verifies the
 * extrinsic's signature against it with the chain's FIPS-204 context string
 * "QUANTUS_EXTRINSIC" — the same self-check the web wallet runs before broadcast
 * (pages/web-wallet/js/app.js). Needs global.QEL_NOBLE = { ml_dsa65, ml_dsa87, blake2b }
 * (set by the module bridge in index.html) and global.QEL_DECODE.
 */
(function (global) {
"use strict";

var SIGNING_CONTEXT = 'QUANTUS_EXTRINSIC';

function te() { return new TextEncoder().encode(SIGNING_CONTEXT); }

/* parts: decoded extrinsic (QEL_DECODE.decodeExtrinsic output)
 * ctx: { specVersion, txVersion, genesisHash: Uint8Array(32), eraBirthHash: Uint8Array(32),
 *        atBlock } — atBlock is the block number the extrinsic claims to target
 *        (used to compute the mortal-era birth block; for immortal eras it is unused).
 * Returns { ok, payloadHex, hashed, scheme, details } or throws with a clear reason. */
function verifyExtrinsic(parts, ctx) {
  var N = global.QEL_NOBLE;
  if (!N) throw new Error('crypto engine not loaded yet');
  if (!parts.version.signed) throw new Error('unsigned (inherent) extrinsics carry no signature to verify');
  var sig = parts.signature;

  // Re-slice the raw call + era bytes from the original hex for byte-exactness.
  var raw = global.QEL_DECODE.hexToBytes(parts._hex);
  var callSec = null, eraSec = null;
  for (var i = 0; i < parts.sections.length; i++) {
    if (parts.sections[i].label === 'call') callSec = parts.sections[i];
    if (parts.sections[i].label === 'era') eraSec = parts.sections[i];
  }
  var callBytes = raw.subarray(callSec.start, callSec.end);
  var eraBytes = raw.subarray(eraSec.start, eraSec.end);

  // CheckEra rule: an immortal era's birth block IS the genesis block.
  var eraBirthHash = ctx.eraBirthHash;
  if (parts.era.immortal && !eraBirthHash) eraBirthHash = ctx.genesisHash;
  if (!parts.era.immortal && ctx.eraBirth == null) {
    throw new Error('mortal era needs the birth block hash — provide the target block number');
  }
  if (!eraBirthHash) throw new Error('era-birth block hash is required (defaults to genesis for immortal eras)');

  var built = global.QEL_DECODE.buildSigningPayload(
    { callBytes: callBytes, eraBytes: eraBytes, nonce: parts.nonce, tip: parts.tip, metadataHashMode: parts.metadataHashMode },
    { specVersion: ctx.specVersion, txVersion: ctx.txVersion, genesisHash: ctx.genesisHash, eraBirthHash: eraBirthHash }
  );
  var message = built.hashed ? N.blake2b(built.payload, { dkLen: 32 }) : built.payload;

  var mod = sig.scheme === 'ML-DSA-87' ? N.ml_dsa87 : N.ml_dsa65;
  var ok = false, err = null;
  try {
    ok = mod.verify(
      global.QEL_DECODE.hexToBytes(sig.sigHex),
      message,
      global.QEL_DECODE.hexToBytes(sig.pubHex),
      { context: te() }
    );
  } catch (e) { err = e.message; }

  return {
    ok: ok, error: err,
    scheme: sig.scheme,
    payloadHex: '0x' + global.QEL_DECODE.bytesToHex(built.payload),
    payloadLen: built.payload.length,
    hashed: built.hashed,
    messageHex: '0x' + global.QEL_DECODE.bytesToHex(message),
  };
}

/* Compute the mortal-era birth block for the *target* block number. */
function birthFor(parts, atBlock) {
  if (parts.era.immortal) return null;
  return global.QEL_DECODE.eraBirth(atBlock, parts.era.period, parts.era.phase);
}

var api = { verifyExtrinsic: verifyExtrinsic, birthFor: birthFor, SIGNING_CONTEXT: SIGNING_CONTEXT };
global.QEL_VERIFY = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
