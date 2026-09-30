/* QTC Web Wallet — encrypted keystore (ES module, 100% client-side).
 *
 * The vault lives in localStorage as a single JSON blob:
 *   { v:1, scheme, salt, iv, iterations, ciphertext }
 * where ciphertext = AES-GCM-256(PBKDF2-HMAC-SHA256(password, salt, 250k) ,
 *                                 JSON { secretKeyHex, publicKeyHex, mnemonic? }).
 *
 * Keys are zeroed from memory on lock. Nothing is ever sent anywhere.
 */
import { sha256 } from '../vendor/noble/hashes/sha2.js';

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

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export async function openVault(password) {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) throw new Error('no vault found');
  const blob = JSON.parse(raw);
  if (blob.v !== 1) throw new Error('unsupported vault version');
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
  const data = JSON.parse(new TextDecoder().decode(plain));
  return {
    scheme: data.scheme,
    secretKey: hexToBytes(data.secretKey),
    publicKey: hexToBytes(data.publicKey),
    mnemonic: data.mnemonic,
    created: data.created,
  };
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
  const text = await file.text();
  const blob = JSON.parse(text);
  if (blob.v !== 1 || !blob.ciphertext || !blob.salt || !blob.iv) {
    throw new Error('not a QTC web-wallet vault file');
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(blob));
}
