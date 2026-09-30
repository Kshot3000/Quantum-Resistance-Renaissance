/* QTC Contact Vault — pure logic (no DOM).
 * Environment-agnostic: browser global QTC_VAULT_LOGIC, Node module.exports.
 * Depends on: QSS58 (js/ss58.js, loaded before this in the browser).
 * Crypto (WebCrypto) via globalThis.crypto — present in modern browsers and Node 18+.
 */
(function (global) {
"use strict";

var SS58 = null;
if (global.QSS58) SS58 = global.QSS58;
else if (typeof require !== "undefined") { try { SS58 = require("./ss58.js"); } catch (e) { SS58 = null; } }

var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/* ---------- address validation (Quantus SS58, prefix 189) ---------- */
function validateQuantusAddress(addr) {
  var a = String(addr == null ? "" : addr).trim();
  if (!a) return { ok: false, kind: "empty", message: "Paste an address first." };
  if (!SS58) return { ok: false, kind: "codec", message: "SS58 codec not loaded." };
  var d = SS58.ss58Decode(a);
  if (!d.ok) return { ok: false, kind: d.kind, message: d.error };
  if (d.prefix !== 189)
    return { ok: false, kind: "prefix",
      message: "Valid SS58 checksum, but the network prefix is " + d.prefix +
        ", not Quantus's 189. This address belongs to a different Substrate chain — do not send QTC to it." };
  if (!d.key || d.key.length !== 32)
    return { ok: false, kind: "keylen",
      message: "Valid checksum, but the payload is " + (d.key ? d.key.length : 0) +
        " bytes — Quantus addresses carry a 32-byte account key." };
  return { ok: true, kind: "ok", address: a, keyHex: SS58.toHex(d.key) };
}

/* ---------- similarity ---------- */
function levenshtein(a, b) {
  a = String(a); b = String(b);
  var m = a.length, n = b.length, i, j;
  if (m === 0) return n;
  if (n === 0) return m;
  var prev = new Array(n + 1), cur = new Array(n + 1);
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    var t = prev; prev = cur; cur = t;
  }
  return prev[n];
}
function sharedPrefixLen(a, b) {
  a = String(a); b = String(b);
  var i = 0, n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function sharedSuffixLen(a, b) {
  a = String(a); b = String(b);
  var i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
/* Best vault match for a pasted address: most shared affix characters,
 * tie-broken by smallest Levenshtein distance. */
function closestContact(addr, contacts) {
  var best = null, bi = -1;
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i];
    var score = sharedPrefixLen(addr, c.address) + sharedSuffixLen(addr, c.address);
    var dist = levenshtein(addr, c.address);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) {
      best = { contact: c, index: i, score: score, dist: dist,
               prefix: sharedPrefixLen(addr, c.address),
               suffix: sharedSuffixLen(addr, c.address) };
    }
  }
  return best;
}

/* ---------- lookalike mutation (string only — no keygen) ---------- */
/* Deterministically flips one middle character to a different base58 char.
 * Used for the one-character avalanche demo. */
function mutateMiddleChar(addr) {
  var a = String(addr);
  var idx = Math.floor(a.length / 2);
  var pos = B58.indexOf(a[idx]);
  var next = pos < 0 ? "1" : B58[(pos + 1) % B58.length];
  return { mutated: a.slice(0, idx) + next + a.slice(idx + 1), index: idx,
           from: a[idx], to: next };
}

/* ---------- export / import ---------- */
var EXPORT_APP = "qtc-contact-vault";
var ENC_APP = "qtc-contact-vault-enc";
var EXPORT_VERSION = 1;
var PBKDF2_ITERATIONS = 200000;

function cleanContacts(contacts) {
  return (contacts || []).map(function (c) {
    return { label: String(c.label || ""), address: String(c.address || ""),
             note: String(c.note || ""), trusted: !!c.trusted,
             checkphrase: Array.isArray(c.checkphrase) ? c.checkphrase.slice(0, 5) : null,
             addedAt: c.addedAt || null };
  });
}
function buildExportPayload(contacts) {
  return { app: EXPORT_APP, version: EXPORT_VERSION,
           exportedAt: new Date().toISOString(),
           contacts: cleanContacts(contacts) };
}
/* Validate a parsed plain-JSON import. Returns {ok, contacts, errors[]}.
 * Address validity (checksum + prefix) is checked here; checkphrase
 * re-derivation happens in the app/tests via the `recompute` callback. */
function parseImportPayload(obj) {
  var errors = [];
  if (!obj || typeof obj !== "object")
    return { ok: false, contacts: [], errors: ["Not a JSON object."] };
  if (obj.app !== EXPORT_APP || obj.version !== EXPORT_VERSION)
    return { ok: false, contacts: [],
             errors: ["Not a Contact Vault backup (app=" + obj.app + ", version=" + obj.version + ")."] };
  if (!Array.isArray(obj.contacts))
    return { ok: false, contacts: [], errors: ["Backup has no contacts array."] };
  var contacts = [];
  obj.contacts.forEach(function (c, i) {
    if (!c || typeof c.address !== "string" || typeof c.label !== "string") {
      errors.push("Row " + (i + 1) + ": missing label/address — skipped.");
      return;
    }
    var v = validateQuantusAddress(c.address);
    if (!v.ok) { errors.push("Row " + (i + 1) + " (" + c.label + "): " + v.message + " — skipped."); return; }
    contacts.push({ label: c.label.slice(0, 80), address: v.address,
                    note: String(c.note || "").slice(0, 500), trusted: !!c.trusted,
                    checkphrase: Array.isArray(c.checkphrase) && c.checkphrase.length === 5
                      ? c.checkphrase.map(String) : null,
                    addedAt: c.addedAt || null });
  });
  return { ok: true, contacts: contacts, errors: errors };
}

/* ---------- base64 helpers (browser + Node) ---------- */
function b64encode(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  var s = "", i;
  for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(String(b64), "base64"));
  var s = atob(String(b64)), out = new Uint8Array(s.length), i;
  for (i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function getSubtle() {
  var c = (typeof globalThis !== "undefined" && globalThis.crypto) || global.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto is not available in this environment.");
  return c.subtle;
}
function getRandomValues(u8) {
  var c = (typeof globalThis !== "undefined" && globalThis.crypto) || global.crypto;
  if (!c || !c.getRandomValues) throw new Error("Secure randomness is not available.");
  return c.getRandomValues(u8);
}
function te() { return new TextEncoder(); }
function td() { return new TextDecoder(); }

async function deriveBackupKey(password, salt) {
  var subtle = getSubtle();
  var keyMat = await subtle.importKey("raw", te().encode(String(password)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMat, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/* Encrypt a JSON string with a password. Returns the armored backup object. */
async function encryptBackup(password, plaintext) {
  if (!password || String(password).length < 8)
    throw new Error("Password must be at least 8 characters.");
  var salt = getRandomValues(new Uint8Array(16));
  var iv = getRandomValues(new Uint8Array(12));
  var key = await deriveBackupKey(password, salt);
  var ct = await getSubtle().encrypt({ name: "AES-GCM", iv: iv }, key, te().encode(String(plaintext)));
  return { app: ENC_APP, version: EXPORT_VERSION, kdf: "PBKDF2-SHA256",
           iterations: PBKDF2_ITERATIONS, salt: b64encode(salt), iv: b64encode(iv),
           data: b64encode(new Uint8Array(ct)) };
}
/* Decrypt an armored backup object. Throws on wrong password / tampering. */
async function decryptBackup(password, payload) {
  if (!payload || payload.app !== ENC_APP || payload.version !== EXPORT_VERSION)
    throw new Error("Not an encrypted Contact Vault backup.");
  var key = await deriveBackupKey(password, b64decode(payload.salt));
  var pt;
  try {
    pt = await getSubtle().decrypt({ name: "AES-GCM", iv: b64decode(payload.iv) },
                                   key, b64decode(payload.data));
  } catch (e) {
    throw new Error("Decryption failed — wrong password or corrupted backup.");
  }
  return td().decode(pt);
}

var api = {
  B58: B58,
  validateQuantusAddress: validateQuantusAddress,
  levenshtein: levenshtein,
  sharedPrefixLen: sharedPrefixLen,
  sharedSuffixLen: sharedSuffixLen,
  closestContact: closestContact,
  mutateMiddleChar: mutateMiddleChar,
  buildExportPayload: buildExportPayload,
  parseImportPayload: parseImportPayload,
  encryptBackup: encryptBackup,
  decryptBackup: decryptBackup,
  b64encode: b64encode, b64decode: b64decode,
  EXPORT_APP: EXPORT_APP, ENC_APP: ENC_APP, EXPORT_VERSION: EXPORT_VERSION,
  PBKDF2_ITERATIONS: PBKDF2_ITERATIONS
};
global.QTC_VAULT_LOGIC = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }

})(typeof globalThis !== "undefined" ? globalThis : this);
