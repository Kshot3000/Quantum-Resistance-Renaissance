/* QTC Web Wallet — encrypted keystore (ES module, 100% client-side).
 *
 * The vault lives in localStorage as a single JSON blob:
 *   { v:1, scheme, salt, iv, iterations, ciphertext }
 * where ciphertext = AES-GCM-256(PBKDF2-HMAC-SHA256(password, salt, 250k) ,
 *                                 JSON { secretKeyHex, publicKeyHex, mnemonic? }).
 *
 * Keys are zeroed from memory on lock. Nothing is ever sent anywhere.
 *
 * The blob is an UNTRUSTED boundary (localStorage can be hand-edited, and a
 * backup file is user-supplied): every read routes through
 * validateVaultBlob BEFORE anything is derived or persisted. The old code
 * checked only `v === 1` and field presence on import — a shaped-but-garbage
 * file (non-hex salt, 2-char iv, unknown scheme) was written straight over
 * the existing vault, destroying it, and a corrupt stored blob then failed
 * AES-GCM and was reported as "wrong password", sending the user hunting
 * for a password that was never wrong. Shape failures now say the vault is
 * corrupted / not a vault file; "wrong password" is reserved for a
 * well-formed blob whose GCM tag does not verify.
 */
import { sha256 } from '../../../assets/vendor/noble/hashes/sha2.js';

const STORE_KEY = 'qtc-web-wallet-vault-v1';
const ITERATIONS = 250000;

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* SHA-256 fingerprint of the password — lets the UI detect a wrong password
 * fast without attempting decryption (still verifies by decrypting). */
export async function passwordFingerprint(password) {
  const h = sha256(new TextEncoder().encode('qtc-wallet|' + password));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function vaultExists() {
  return localStorage.getItem(STORE_KEY) !== null;
}

export async function saveVault({ scheme, secretKey, publicKey, mnemonic }, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const payload = JSON.stringify({
    scheme,
    secretKey: [...secretKey].map((b) => b.toString(16).padStart(2, '0')).join(''),
    publicKey: [...publicKey].map((b) => b.toString(16).padStart(2, '0')).join(''),
    mnemonic: mnemonic || null,
    created: new Date().toISOString(),
  });
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payload));
  const blob = {
    v: 1,
    scheme,
    kdf: 'PBKDF2-HMAC-SHA256',
    iterations: ITERATIONS,
    cipher: 'AES-GCM-256',
    salt: [...salt].map((b) => b.toString(16).padStart(2, '0')).join(''),
    iv: [...iv].map((b) => b.toString(16).padStart(2, '0')).join(''),
    ciphertext: [...new Uint8Array(ct)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(blob));
  return true;
}

const HEX_RE = /^[0-9a-fA-F]+$/;
/* saveVault writes a 16-byte salt and a 12-byte AES-GCM iv, hex-encoded. */
const SALT_HEX_LEN = 32;
const IV_HEX_LEN = 24;
/* The encrypted payload is a few hundred bytes (keys + optional mnemonic);
 * 64 KiB of ciphertext is a generous ceiling that still refuses absurd
 * blobs before they are persisted or fed to the decryptor. */
const MAX_CIPHERTEXT_HEX_LEN = 131072;
/* A vault backup FILE is bounded by that same ciphertext cap: the blob
 * JSON around a max-size ciphertext (salt 32 + iv 24 + field names and
 * punctuation) totals under ~132 KiB, so 256 KiB is ~2x the largest
 * backup saveVault can ever produce. importVaultFile used to
 * `await file.text()` and JSON.parse the WHOLE picked file before
 * validateVaultBlob was consulted — a wrong pick (a log, a disk image)
 * was read and parsed in full, allocating its text and parse tree,
 * before the ciphertext cap finally rejected it. file.size is known
 * before a single byte is read, so the import now asks vaultFileRoom
 * first and refuses over-cap picks unread, with size + cap named. */
export const MAX_VAULT_FILE_BYTES = 256 * 1024;
/* How much room a vault backup file of `size` bytes has: true only for
 * a finite, non-negative number at or under MAX_VAULT_FILE_BYTES.
 * Fail-closed — NaN, negative, infinite, string, and missing sizes all
 * refuse, matching the fleet's other *Room gates. */
export function vaultFileRoom(size) {
  return typeof size === 'number' && Number.isFinite(size) &&
    size >= 0 && size <= MAX_VAULT_FILE_BYTES;
}

export function validateVaultBlob(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob))
    return { ok: false, error: 'not a QTC web-wallet vault file' };
  if (blob.v !== 1)
    return { ok: false, error: 'unsupported vault version' };
  if (blob.scheme !== 65 && blob.scheme !== 87)
    return { ok: false, error: 'vault data is corrupted (unknown signature scheme)' };
  if (blob.kdf !== undefined && blob.kdf !== 'PBKDF2-HMAC-SHA256')
    return { ok: false, error: 'vault data is corrupted (unknown key derivation)' };
  if (blob.cipher !== undefined && blob.cipher !== 'AES-GCM-256')
    return { ok: false, error: 'vault data is corrupted (unknown cipher)' };
  if (blob.iterations !== undefined && blob.iterations !== ITERATIONS)
    return { ok: false, error: 'vault data is corrupted (unexpected iteration count)' };
  if (typeof blob.salt !== 'string' || blob.salt.length !== SALT_HEX_LEN || !HEX_RE.test(blob.salt))
    return { ok: false, error: 'vault data is corrupted (bad salt)' };
  if (typeof blob.iv !== 'string' || blob.iv.length !== IV_HEX_LEN || !HEX_RE.test(blob.iv))
    return { ok: false, error: 'vault data is corrupted (bad iv)' };
  if (typeof blob.ciphertext !== 'string' || blob.ciphertext.length < 2 ||
      blob.ciphertext.length > MAX_CIPHERTEXT_HEX_LEN ||
      blob.ciphertext.length % 2 !== 0 || !HEX_RE.test(blob.ciphertext))
    return { ok: false, error: 'vault data is corrupted (bad ciphertext)' };
  return { ok: true };
}

function parseVaultBlob(raw) {
  let blob;
  try { blob = JSON.parse(raw); }
  catch { throw new Error('not a QTC web-wallet vault file'); }
  const check = validateVaultBlob(blob);
  if (!check.ok) throw new Error(check.error);
  return blob;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_RE.test(hex))
    throw new Error('vault data is corrupted (invalid hex)');
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export async function openVault(password) {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) throw new Error('no vault found');
  const blob = parseVaultBlob(raw);
  const key = await deriveKey(
    password,
    hexToBytes(blob.salt),
  );
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(blob.iv) },
      key,
      hexToBytes(blob.ciphertext),
    );
  } catch {
    throw new Error('wrong password');
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(plain));
    if (!data || typeof data !== 'object') throw new Error('bad payload');
    return {
      scheme: data.scheme,
      secretKey: hexToBytes(data.secretKey),
      publicKey: hexToBytes(data.publicKey),
      mnemonic: data.mnemonic,
      created: data.created,
    };
  } catch {
    throw new Error('vault data is corrupted (unreadable contents)');
  }
}

export function wipeVault() {
  localStorage.removeItem(STORE_KEY);
}

export function exportVaultFile() {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) throw new Error('no vault found');
  return new Blob([raw], { type: 'application/json' });
}

export async function importVaultFile(file) {
  /* Size gate BEFORE reading a byte: every legitimate backup is under
   * the cap by construction (see MAX_VAULT_FILE_BYTES), so an over-cap
   * pick is refused unread and the stored vault is never touched. */
  if (!file || !vaultFileRoom(file.size)) {
    throw new Error('vault file is ' + (file && typeof file.size === 'number' ? file.size : 'an unknown number of') +
      ' bytes — a QTC vault backup is at most ' + MAX_VAULT_FILE_BYTES + ' bytes (256 KiB); the file was not read');
  }
  const text = await file.text();
  /* Validate the WHOLE blob before persisting anything: the import
   * replaces the stored vault, so a shaped-but-garbage file must never
   * be allowed to overwrite a working one. Only the known fields are
   * persisted, so a valid file carrying stray fields is stored clean. */
  const blob = parseVaultBlob(text);
  localStorage.setItem(STORE_KEY, JSON.stringify({
    v: 1,
    scheme: blob.scheme,
    kdf: 'PBKDF2-HMAC-SHA256',
    iterations: ITERATIONS,
    cipher: 'AES-GCM-256',
    salt: blob.salt,
    iv: blob.iv,
    ciphertext: blob.ciphertext,
  }));
}
