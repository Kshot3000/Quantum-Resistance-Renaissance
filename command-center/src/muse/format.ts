import { blake2b } from "@noble/hashes/blake2.js";

export const PLANCK = 10n ** 12n;
export const CAP_QTC = 21_000_000;
export const CAP_PLANCKS = 21_000_000n * PLANCK;
export const EMISSION_DIV = 50_000_000n;
export const TARGET_BLOCK_S = 12;
export const SS58_PREFIX = 189;
export const LENGTH_FEE_PER_BYTE = 100_000n;
export const PK_87 = 2592;
export const SIG_87 = 4627;
export const PK_65 = 1952;
export const SIG_65 = 3309;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function rewardPlancks(supplyPlancks: bigint): bigint {
  if (supplyPlancks >= CAP_PLANCKS) return 0n;
  return (CAP_PLANCKS - supplyPlancks) / EMISSION_DIV;
}

export function plancksToNumber(p: bigint): number {
  return Number(p) / 1e12;
}

export function formatQtc(plancks: bigint, digits = 4): string {
  const neg = plancks < 0n;
  const v = neg ? -plancks : plancks;
  const whole = v / PLANCK;
  const frac = v % PLANCK;
  const fracStr = frac.toString().padStart(12, "0").slice(0, digits).replace(/0+$/, "");
  const body = fracStr ? `${whole.toLocaleString("en-US")}.${fracStr}` : whole.toLocaleString("en-US");
  return neg ? `−${body}` : body;
}

export function formatNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function shortAddr(addr: string, head = 8, tail = 6): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function monogram(title: string): string {
  const words = title
    .replace(/^QTC\s+/i, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const a = words[0]?.[0] ?? "Q";
  const b = words[1]?.[0] ?? "";
  return (a + b).toUpperCase();
}

export function parseHashrate(value: number, unit: string): number {
  const exp: Record<string, number> = { "H/s": 0, "kH/s": 3, "MH/s": 6, "GH/s": 9, "TH/s": 12, "PH/s": 15 };
  const e = exp[unit] ?? 0;
  return value * 10 ** e;
}

export function formatHashrate(hs: number): string {
  if (!Number.isFinite(hs) || hs <= 0) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
  let i = 0;
  let v = hs;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${formatNum(v, v >= 100 ? 1 : 2)} ${units[i]}`;
}

/** pallet_qpow::calculate_difficulty — integer exact. */
export function calculateDifficulty(parent: bigint, blockTimeMs: bigint, targetMs = 12_000n) {
  const minRetarget = 500n;
  const bt = blockTimeMs > minRetarget ? blockTimeMs : minRetarget;
  let divisor = (targetMs * 10n) / 12n;
  if (divisor < 1n) divisor = 1n;
  const timeFactor = bt / divisor;
  let adj = 1n - timeFactor;
  if (adj < -99n) adj = -99n;
  const inc = parent / 2048n;
  let next = adj >= 0n ? parent + inc * adj : parent - inc * -adj;
  const minDiff = 131072n;
  if (next < minDiff) next = minDiff;
  return { difficulty: next, adjustment: adj, increment: inc, timeFactor };
}

export type Ss58Result =
  | { ok: true; prefix: number; pubkey: string; checksumOk: boolean }
  | { ok: false; error: string };

function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros += 1;
  }
  const body = hex ? Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))) : new Uint8Array();
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    const r = n % 58n;
    n /= 58n;
    s = B58[Number(r)] + s;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s || "1";
}

function checksum2(body: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("SS58PRE");
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  return blake2b(msg, { dkLen: 64 }).slice(0, 2);
}

export function decodeSs58(address: string): Ss58Result {
  const raw = address.trim();
  if (!raw) return { ok: false, error: "Paste an address." };
  const data = b58decode(raw);
  if (!data || data.length < 3) return { ok: false, error: "Not valid base58." };
  const two = (data[0]! & 0b0100_0000) !== 0;
  if (two) {
    if (data.length !== 36) return { ok: false, error: `Expected 36 bytes for a 32-byte account, got ${data.length}.` };
    const prefix = ((data[0]! & 0b0011_1111) << 2) | (data[1]! >> 6) | ((data[1]! & 0b0011_1111) << 8);
    const body = data.slice(0, 34);
    const given = data.slice(34);
    const expect = checksum2(body);
    const pubkey = [...data.slice(2, 34)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { ok: true, prefix, pubkey, checksumOk: given[0] === expect[0] && given[1] === expect[1] };
  }
  if (data.length !== 35) return { ok: false, error: `Expected 35 bytes for a 32-byte account, got ${data.length}.` };
  const prefix = data[0]!;
  const body = data.slice(0, 33);
  const given = data.slice(33);
  const expect = checksum2(body);
  const pubkey = [...data.slice(1, 33)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ok: true, prefix, pubkey, checksumOk: given[0] === expect[0] && given[1] === expect[1] };
}

export function encodeSs58(pubkeyHex: string, prefix = SS58_PREFIX): { ok: true; address: string } | { ok: false; error: string } {
  const hex = pubkeyHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { ok: false, error: "Public key must be 32 bytes (64 hex characters)." };
  const pub = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  let body: Uint8Array;
  if (prefix < 64) {
    body = new Uint8Array(33);
    body[0] = prefix;
    body.set(pub, 1);
  } else {
    body = new Uint8Array(34);
    body[0] = ((prefix & 0b1111_1100) >> 2) | 0b0100_0000;
    body[1] = (prefix >> 8) | ((prefix & 0b11) << 6);
    body.set(pub, 2);
  }
  const sum = checksum2(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  full.set(sum, body.length);
  return { ok: true, address: b58encode(full) };
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n]!;
}

export function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

export function sharedSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/** SCALE compact integer, canonical only. */
export function encodeCompact(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("compact is unsigned");
  if (n < 64n) return Uint8Array.of(Number(n) << 2);
  if (n < 16384n) {
    const v = Number(n << 2n) | 0x01;
    return Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
  }
  if (n < 1n << 30n) {
    const v = Number(n << 2n) | 0x02;
    const out = new Uint8Array(4);
    const x = v >>> 0;
    out[0] = x & 0xff;
    out[1] = (x >> 8) & 0xff;
    out[2] = (x >> 16) & 0xff;
    out[3] = (x >> 24) & 0xff;
    return out;
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const len = hex.length / 2;
  if (len > 4 + 63) throw new Error("value too wide");
  const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  // little-endian payload
  const le = Uint8Array.from(bytes).reverse();
  const head = ((le.length - 4) << 2) | 0x03;
  const out = new Uint8Array(1 + le.length);
  out[0] = head;
  out.set(le, 1);
  return out;
}

export function decodeCompact(bytes: Uint8Array): { ok: true; value: bigint; used: number } | { ok: false; error: string } {
  if (!bytes.length) return { ok: false, error: "Empty." };
  const mode = bytes[0]! & 0x03;
  if (mode === 0) {
    return { ok: true, value: BigInt(bytes[0]! >> 2), used: 1 };
  }
  if (mode === 1) {
    if (bytes.length < 2) return { ok: false, error: "Truncated two-byte compact." };
    const v = bytes[0]! | (bytes[1]! << 8);
    const value = BigInt(v >> 2);
    if (value < 64n) return { ok: false, error: "Non-canonical: fits in one byte." };
    return { ok: true, value, used: 2 };
  }
  if (mode === 2) {
    if (bytes.length < 4) return { ok: false, error: "Truncated four-byte compact." };
    const v = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
    const value = BigInt(v >>> 2);
    if (value < 16384n) return { ok: false, error: "Non-canonical: fits in fewer bytes." };
    return { ok: true, value, used: 4 };
  }
  const len = (bytes[0]! >> 2) + 4;
  if (bytes.length < 1 + len) return { ok: false, error: "Truncated big compact." };
  let value = 0n;
  for (let i = 0; i < len; i++) value |= BigInt(bytes[1 + i]!) << BigInt(8 * i);
  if (value < 1n << 30n) return { ok: false, error: "Non-canonical: fits in four bytes." };
  return { ok: true, value, used: 1 + len };
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GF = 0x11b;
function gfMul(a: number, b: number): number {
  let p = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    x <<= 1;
    if (x & 0x100) x ^= GF;
    y >>= 1;
  }
  return p & 0xff;
}

function gfDiv(a: number, b: number): number {
  if (!b) throw new Error("divide by zero");
  // brute inverse
  let inv = 1;
  for (let i = 1; i < 256; i++) {
    if (gfMul(b, i) === 1) {
      inv = i;
      break;
    }
  }
  return gfMul(a, inv);
}

export type Share = { x: number; hex: string };

export function shamirSplit(secret: Uint8Array, threshold: number, shares: number): Share[] {
  if (threshold < 2 || shares < threshold || shares > 255) throw new Error("threshold 2–255, shares ≥ threshold");
  const out: Share[] = [];
  const coeffs: number[][] = [];
  for (let i = 0; i < secret.length; i++) {
    const c = [secret[i]!];
    const rnd = crypto.getRandomValues(new Uint8Array(threshold - 1));
    for (const r of rnd) c.push(r);
    coeffs.push(c);
  }
  for (let x = 1; x <= shares; x++) {
    const y = new Uint8Array(secret.length);
    for (let b = 0; b < secret.length; b++) {
      let acc = 0;
      let xp = 1;
      for (const c of coeffs[b]!) {
        acc ^= gfMul(c, xp);
        xp = gfMul(xp, x);
      }
      y[b] = acc;
    }
    out.push({ x, hex: toHex(y) });
  }
  return out;
}

export function shamirCombine(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error("need at least two shares");
  const xs = shares.map((s) => s.x);
  if (new Set(xs).size !== xs.length) throw new Error("duplicate share index");
  const len = shares[0]!.hex.length / 2;
  const ys = shares.map((s) => {
    if (!/^[0-9a-fA-F]+$/.test(s.hex) || s.hex.length !== len * 2) throw new Error("share length mismatch");
    return Uint8Array.from(s.hex.match(/../g)!.map((h) => parseInt(h, 16)));
  });
  const secret = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gfMul(num, xs[j]!);
        den = gfMul(den, xs[i]! ^ xs[j]!);
      }
      acc ^= gfMul(ys[i]![b]!, gfDiv(num, den));
    }
    secret[b] = acc;
  }
  return secret;
}

export function proposalFeePlancks(signers: number): bigint {
  const base = 50_000_000_000n; // 0.05 QTC
  const extra = (base * BigInt(signers) * 10_000n) / 1_000_000n;
  return base + extra;
}

export function multisigBudget(signers: number) {
  const create = 30_000_000_000n;
  const proposal = proposalFeePlancks(signers);
  const deposit = 10_000_000_000n;
  return { create, proposal, deposit, total: create + proposal + deposit };
}

export function selfCheck(): string[] {
  const fails: string[] = [];
  const d0 = calculateDifficulty(2_048_000n, 12_000n);
  if (d0.difficulty !== 2_048_000n) fails.push("diff flat");
  const d1 = calculateDifficulty(2_048_000n, 9_000n);
  if (d1.difficulty !== 2_049_000n) fails.push("diff up");
  const d2 = calculateDifficulty(2_048_000n, 25_000n);
  if (d2.difficulty !== 2_047_000n) fails.push("diff down");
  const d3 = calculateDifficulty(2_048_000n, 1_000_000n);
  if (d3.difficulty !== 1_949_000n) fails.push("diff cap");
  const c = encodeCompact(63n);
  const back = decodeCompact(c);
  if (!back.ok || back.value !== 63n) fails.push("compact 63");
  const c2 = encodeCompact(64n);
  const back2 = decodeCompact(c2);
  if (!back2.ok || back2.value !== 64n) fails.push("compact 64");
  const non = decodeCompact(Uint8Array.of((64 << 2) | 0)); // canonical would be mode 1; this is mode 0 of value 64 which can't fit
  if (non.ok && non.value === 64n && non.used === 1) fails.push("compact should not encode 64 in one byte");
  return fails;
}
