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

/* ---------- persisted-vault boundary ---------- */
/* The vault loads from localStorage, which any earlier bug, extension, or
 * hand-edited backup can poison. sanitizeVault is the single gate for that
 * load (the backup-import path has its own gate, parseImportPayload):
 *  - plain-object entries only, at most MAX_CONTACTS kept;
 *  - the address must pass the same validation the add form enforces
 *    (SS58 checksum, prefix 189, 32-byte key) — a stored string that is
 *    not a real Quantus address is not a contact, however it got there;
 *  - addresses and ids are deduped (find/delete/edit match on them);
 *    an id outside the safe charset (it is interpolated into HTML
 *    attributes and selectors) is replaced with a generated one;
 *  - string fields are type-checked and capped, trusted is a strict
 *    boolean, addedAt must be a parseable date string;
 *  - checkphrase is shape-checked only (exactly 5 strings) — the phrase
 *    is a DERIVED field of the address, and enforcing that relation
 *    costs a 40k-iteration PBKDF2, so the app re-derives and corrects
 *    mismatches asynchronously at boot (see app.js backfill). */
var MAX_CONTACTS = 500;
function cleanAddedAt(v) {
  return (typeof v === "string" && isFinite(Date.parse(v))) ? v.slice(0, 40) : null;
}
function cleanCheckphrase(v) {
  if (!Array.isArray(v) || v.length !== 5) return null;
  for (var i = 0; i < 5; i++)
    if (typeof v[i] !== "string" || !v[i] || v[i].length > 32) return null;
  return v.slice(0, 5);
}
function sanitizeVault(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [], seenIds = {}, seenAddrs = {};
  for (var i = 0; i < raw.length && out.length < MAX_CONTACTS; i++) {
    var x = raw[i];
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    if (typeof x.label !== "string" || !x.label.trim()) continue;
    if (typeof x.address !== "string") continue;
    var v = validateQuantusAddress(x.address);
    if (!v.ok) continue;
    if (seenAddrs[v.address]) continue;
    seenAddrs[v.address] = true;
    var id = (typeof x.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x.id)) ? x.id : null;
    if (!id || seenIds[id]) id = "vault-sanitized-" + out.length;
    if (seenIds[id]) continue;
    seenIds[id] = true;
    out.push({ id: id, label: x.label.slice(0, 80), address: v.address,
               note: typeof x.note === "string" ? x.note.slice(0, 500) : "",
               trusted: x.trusted === true,
               addedAt: cleanAddedAt(x.addedAt),
               checkphrase: cleanCheckphrase(x.checkphrase) });
  }
  return out;
}
/* Room left in the vault under the load cap sanitizeVault enforces.
 * The Add form is a creation path the load cap alone cannot protect:
 * it pushed with no cap check, so at a full vault the push persisted
 * 501 and the next load silently trimmed the NEW contact — the one
 * whose checkphrase had just been derived (40,000 PBKDF2 iterations)
 * and shown under a "✓ Saved" message. The form asks this gate twice:
 * early, before the derivation (a full vault refuses without burning
 * the KDF), and authoritatively inside the derivation callback,
 * before the push. Fail-closed: a count that is not a finite
 * non-negative number earns no room. */
function contactRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) return 0;
  return Math.max(0, MAX_CONTACTS - n);
}

/* ---------- batch-verify input scan window ---------- */
/* The Batch tab verifies at most MAX_BATCH addresses, but the app used
 * to split/trim/filter the WHOLE textarea value to build the line array
 * it then sliced: a 20,000,000-char paste of 400,000 lines built all
 * 400,000 strings in ~1,231 ms in Node (probe qa-contactvault-batchscan)
 * on every Verify click, all to verify 200 — and the 399,800 dropped
 * lines were never disclosed. batchTextWindow owns the raw text: it
 * scans only the first MAX_BATCH_SCAN_CHARS characters and backs the
 * cut off to the last newline, so no truncated partial line is ever
 * verified. The cap is derived from the largest legitimate batch: a
 * Quantus address is 49 chars, and lines up to 128 chars still earn a
 * verdict (a near-miss or garbage line is reported invalid, not
 * pre-filtered), so a full batch is 200 x (128 + 1 separator) = 25,800
 * chars — the 32,768 window holds it intact, plus ~660 real addresses.
 * parseBatchInput then applies the MAX_BATCH line cap and reports
 * droppedLines (in-window lines past the cap) and skippedChars
 * (characters past the window), both of which the app discloses in the
 * completion line. Non-string input fails closed as empty. */
var MAX_BATCH = 200;
var MAX_BATCH_SCAN_CHARS = 32768;
function batchTextWindow(text) {
  if (typeof text !== "string")
    return { lines: [], totalChars: 0, scannedChars: 0, skippedChars: 0 };
  var totalChars = text.length;
  var scanned = text;
  if (totalChars > MAX_BATCH_SCAN_CHARS) {
    scanned = text.slice(0, MAX_BATCH_SCAN_CHARS);
    var nextCh = text.charAt(MAX_BATCH_SCAN_CHARS);
    var lastCh = scanned.charAt(scanned.length - 1);
    if (nextCh && nextCh !== "\n" && nextCh !== "\r" && lastCh !== "\n" && lastCh !== "\r") {
      var cut = Math.max(scanned.lastIndexOf("\n"), scanned.lastIndexOf("\r"));
      scanned = cut >= 0 ? scanned.slice(0, cut + 1) : "";
    }
  }
  var lines = scanned.split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  return { lines: lines, totalChars: totalChars, scannedChars: scanned.length,
           skippedChars: totalChars - scanned.length };
}
function parseBatchInput(text) {
  var w = batchTextWindow(text);
  var lines = w.lines.slice(0, MAX_BATCH);
  return { lines: lines, droppedLines: w.lines.length - lines.length,
           totalLines: w.lines.length, totalChars: w.totalChars,
           scannedChars: w.scannedChars, skippedChars: w.skippedChars };
}

/* ---------- export / import ---------- */
var EXPORT_APP = "qtc-contact-vault";
var ENC_APP = "qtc-contact-vault-enc";
var EXPORT_VERSION = 1;
var PBKDF2_ITERATIONS = 200000;

function cleanContacts(contacts) {
  if (!Array.isArray(contacts)) return [];
  var out = [];
  contacts.forEach(function (c) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return;
    out.push({ label: String(c.label || ""), address: String(c.address || ""),
               note: String(c.note || ""), trusted: !!c.trusted,
               checkphrase: cleanCheckphrase(c.checkphrase),
               addedAt: cleanAddedAt(c.addedAt) });
  });
  return out;
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
  var excess = 0;
  obj.contacts.forEach(function (c, i) {
    // CAP (white-hat, 2026-10-15): the vault's producer cap is MAX_CONTACTS
    // (sanitizeVault enforces it on load, and an export can only ever hold
    // a vault's contacts) — but this gate kept EVERY valid row, and the app
    // then runs a 40,000-iteration PBKDF2 checkphrase derivation PER kept
    // contact (~2.2s each in Node): a pasted 5,000-contact "backup" meant
    // ~3 hours of derivations and a vault far beyond its own cap, silently
    // trimmed back to the FIRST 500 on the next load. Once the cap is met,
    // stop validating (bounded work) and report the excess ONCE.
    if (contacts.length >= MAX_CONTACTS) { if (!excess) excess = obj.contacts.length - i; return; }
    if (!c || typeof c.address !== "string" || typeof c.label !== "string") {
      errors.push("Row " + (i + 1) + ": missing label/address — skipped.");
      return;
    }
    var v = validateQuantusAddress(c.address);
    if (!v.ok) { errors.push("Row " + (i + 1) + " (" + c.label + "): " + v.message + " — skipped."); return; }
    contacts.push({ label: c.label.slice(0, 80), address: v.address,
                    note: String(c.note || "").slice(0, 500), trusted: !!c.trusted,
                    checkphrase: cleanCheckphrase(c.checkphrase),
                    addedAt: cleanAddedAt(c.addedAt) });
  });
  if (excess > 0)
    errors.push("Backup has " + excess + " more row" + (excess === 1 ? "" : "s") +
      " beyond the vault cap of " + MAX_CONTACTS + " contacts — only the first " +
      MAX_CONTACTS + " valid contacts were imported.");
  return { ok: true, contacts: contacts, errors: errors };
}

/* ---------- backup-import paste length gate ---------- */
/* The Import tab JSON.parse'd the WHOLE pasted backup before any
 * length was consulted: a 20,000,062-char backup-shaped paste built
 * its full parse tree in ~76 ms in Node (probe
 * qa-contactvault-importgate) on every Import click, all to import at
 * most MAX_CONTACTS contacts. The core now owns the parse behind
 * MAX_IMPORT_PASTE_CHARS: parseImportPaste refuses over-cap pastes on
 * length alone via the pure fail-closed importPasteRoom, naming size
 * + cap, before JSON.parse runs. The cap is derived from the largest
 * legitimate pastes measured with the core's own producers: a full
 * 500-contact plain backup pretty-printed is 498,112 chars; with
 * every free-text character at JSON's worst 6-char \\uXXXX escaping
 * it is 2,348,112 chars; and that worst-escape payload inside the
 * PBKDF2/AES-GCM armored form (base64 of the escaped plain) is
 * 3,057,662 chars — so MAX_IMPORT_PASTE_CHARS = 4,194,304 (4 MiB,
 * the fleet's paste/file cap) holds every genuine backup intact and
 * no legitimate input changes outcome. The decrypted inner payload
 * routes through the same gate: it is bounded by construction (its
 * ciphertext rode inside an already-gated paste), and the gate keeps
 * that invariant enforced rather than assumed. Non-string input
 * fails closed as not-text. */
var MAX_IMPORT_PASTE_CHARS = 4 * 1024 * 1024;
function importPasteRoom(chars) {
  return typeof chars === "number" && isFinite(chars) && chars >= 0 && chars <= MAX_IMPORT_PASTE_CHARS;
}
function parseImportPaste(text) {
  if (typeof text !== "string")
    return { ok: false, code: "not-text",
             error: "Backup paste is not text — refused by the import gate (cap " + MAX_IMPORT_PASTE_CHARS.toLocaleString("en-US") + " characters) before parsing." };
  if (!importPasteRoom(text.length))
    return { ok: false, code: "too-long",
             error: "Backup paste too long (" + text.length.toLocaleString("en-US") + " characters) — the cap is " + MAX_IMPORT_PASTE_CHARS.toLocaleString("en-US") + " characters; refused before parsing." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, code: "not-json", error: "Not valid JSON: " + e.message };
  }
}

/* ---------- spoken-checkphrase input length gate ---------- */
/* The spoken-checkphrase handler lowercased and split the WHOLE words
 * box before counting: a 20,000,000-char paste materialized 4,000,000
 * token strings (~829 ms in Node, probe qa-checkphrase-bound) on every
 * Check click, only to be rejected as not-five-words. The core now owns
 * the split behind MAX_CHECKPHRASE_CHARS: parseCheckphraseWords refuses
 * over-cap input on length alone via the pure fail-closed
 * checkphraseInputRoom, naming size + cap, before any copy or split.
 * The cap is derived from the checkphrase wordlist itself (the shipped
 * qp-human-checkphrase list, 2,048 words): its longest word is 14
 * characters ("unquestionable"), so a real five-word phrase is at most
 * 5 x 14 + 4 separators = 74 characters single-spaced. The 256 cap is
 * ~3.5x that, admitting generous dictation formatting — multi-space or
 * newline runs, hyphen/comma/period separators, mixed case, padding —
 * while no legitimate answer changes outcome. Non-string input fails
 * closed as not-text. The word-count verdict itself stays the app's:
 * an in-cap parse returns the words however many there are. */
var MAX_CHECKPHRASE_CHARS = 256;
function checkphraseInputRoom(chars) {
  return typeof chars === "number" && isFinite(chars) && chars >= 0 &&
    Math.floor(chars) === chars && chars <= MAX_CHECKPHRASE_CHARS;
}
function parseCheckphraseWords(text) {
  if (typeof text !== "string")
    return { ok: false, code: "not-text", words: [],
             error: "Spoken words are not text — refused by the checkphrase gate (cap " + MAX_CHECKPHRASE_CHARS.toLocaleString("en-US") + " characters) before splitting." };
  if (!checkphraseInputRoom(text.length))
    return { ok: false, code: "too-long", words: [],
             error: "Spoken words too long (" + text.length.toLocaleString("en-US") + " characters) — the cap is " + MAX_CHECKPHRASE_CHARS.toLocaleString("en-US") + " characters for a five-word checkphrase; refused before splitting." };
  return { ok: true, words: text.toLowerCase().split(/[\s\-_.,;\/]+/).filter(Boolean) };
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

/* ---------- backup-password length gate ---------- */
/* The backup password was utf8-encoded WHOLE and fed into the
 * 200,000-iteration PBKDF2 with no upper bound: encryptBackup checked
 * only the 8-character MINIMUM, decryptBackup checked nothing, and no
 * HTML maxlength guards the fields — a 20,000,000-char paste was encoded
 * in full and run through the KDF on every encrypt/decrypt (probe
 * qa-passwordbound; the mnemonicToSeed hang shape, one field over). A
 * genuine backup password is short (NIST SP 800-63B requires verifiers
 * to accept at least 64 characters; password managers generate at most
 * ~128; a long passphrase runs ~80). The cap is 1,024 — the fleet's
 * mnemonic-input cap, 8x the longest manager password — and derivation for in-cap
 * passwords is byte-identical, so existing encrypted backups decrypt
 * exactly as before. The gate lives in deriveBackupKey, the ONE
 * derivation path both encrypt and decrypt route through, refusing
 * over-cap or non-string input on length alone via the pure fail-closed
 * passwordRoom, naming size + cap, before any encoding. passwordRoom
 * returns the characters of room left (0 when full or when the count is
 * not a finite non-negative integer), mirroring the fleet's room gates. */
var MAX_PASSWORD_CHARS = 1024;
function passwordRoom(chars) {
  if (typeof chars !== "number" || !isFinite(chars) || chars < 0 ||
      Math.floor(chars) !== chars) return 0;
  return Math.max(0, MAX_PASSWORD_CHARS - chars);
}
function assertPasswordBound(password) {
  if (typeof password !== "string")
    throw new Error("Password is not text — refused before key derivation (cap " + MAX_PASSWORD_CHARS.toLocaleString("en-US") + " characters).");
  if (password.length > MAX_PASSWORD_CHARS)
    throw new Error("Password too long (" + password.length.toLocaleString("en-US") + " characters) — the cap is " + MAX_PASSWORD_CHARS.toLocaleString("en-US") + " characters; refused before key derivation.");
}

async function deriveBackupKey(password, salt) {
  assertPasswordBound(password);
  var subtle = getSubtle();
  var keyMat = await subtle.importKey("raw", te().encode(password), "PBKDF2", false, ["deriveKey"]);
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
  sanitizeVault: sanitizeVault, MAX_CONTACTS: MAX_CONTACTS, contactRoom: contactRoom,
  MAX_BATCH: MAX_BATCH, MAX_BATCH_SCAN_CHARS: MAX_BATCH_SCAN_CHARS,
  batchTextWindow: batchTextWindow, parseBatchInput: parseBatchInput,
  cleanAddedAt: cleanAddedAt, cleanCheckphrase: cleanCheckphrase,
  buildExportPayload: buildExportPayload,
  parseImportPayload: parseImportPayload,
  MAX_IMPORT_PASTE_CHARS: MAX_IMPORT_PASTE_CHARS,
  importPasteRoom: importPasteRoom, parseImportPaste: parseImportPaste,
  MAX_CHECKPHRASE_CHARS: MAX_CHECKPHRASE_CHARS,
  checkphraseInputRoom: checkphraseInputRoom, parseCheckphraseWords: parseCheckphraseWords,
  encryptBackup: encryptBackup,
  decryptBackup: decryptBackup,
  MAX_PASSWORD_CHARS: MAX_PASSWORD_CHARS, passwordRoom: passwordRoom,
  b64encode: b64encode, b64decode: b64decode,
  EXPORT_APP: EXPORT_APP, ENC_APP: ENC_APP, EXPORT_VERSION: EXPORT_VERSION,
  PBKDF2_ITERATIONS: PBKDF2_ITERATIONS
};
global.QTC_VAULT_LOGIC = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }

})(typeof globalThis !== "undefined" ? globalThis : this);
