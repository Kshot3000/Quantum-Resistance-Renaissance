/* QTC Web Wallet — Substrate JSON-RPC client + chain queries (ES module).
 *
 * Connects to any Substrate WebSocket RPC (default: the upstream-documented
 * mainnet node wss://rpc.quantus.network, also used by the Mempool Desk).
 * All queries are read-only except author_submitExtrinsic, which only fires
 * after the user explicitly confirms a signed transfer.
 */
import { hexEncode, hexDecode } from './quantus-crypto.js';
import { ss58Decode } from './quantus-crypto.js';
import { SYSTEM_ACCOUNT_KEY } from './xxhash.js?v=1.39.0';
import { decodeAccountInfo, eraBirth, encodeMortalEra, buildTransferCall, buildSigningPayload, buildExtrinsic, DILITHIUM65_VARIANT, DILITHIUM87_VARIANT } from './scale.js';
import { parseBlockNumber, isHash32, parseVersionNumber, parseNonce, parseFeeField, validStorageHex } from './rpc-validate.js?v=1.1.0';

export const DEFAULT_RPC = 'wss://rpc.quantus.network';
export const QUANTUS_PREFIX = 189;

/* Strict recipient parse: valid SS58 checksum AND Quantus prefix 189. */
export function parseRecipient(address) {
  const { prefix, accountId } = ss58Decode(address);
  if (prefix !== QUANTUS_PREFIX) {
    throw new Error(`wrong network prefix ${prefix} — Quantus addresses use prefix 189`);
  }
  return accountId;
}

export class RpcClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect(timeoutMs = 15000) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this._ready();
    }
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('connection timed out')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; this._wire(ws); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('could not reach ' + this.url)); };
    });
  }

  _ready() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connection timed out')), 15000);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
    });
  }

  _wire(ws) {
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // A raw "null" / array / scalar frame is not an RPC response: ignore
      // it instead of throwing on msg.id inside the socket handler.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          const m = typeof msg.error === 'string' ? msg.error
            : (msg.error && typeof msg.error.message === 'string' ? msg.error.message : 'RPC error');
          reject(new Error(m));
        }
        else resolve(msg.result);
      }
    };
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'));
      this.pending.clear();
      this.ws = null;
    };
  }

  async call(method, params = [], timeoutMs = 20000) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() { try { this.ws && this.ws.close(); } catch {} this.ws = null; }
  get connected() { return !!(this.ws && this.ws.readyState === WebSocket.OPEN); }
}

/* ---- chain queries ----
 * Every answer is validated at this boundary (js/rpc-validate.js) before
 * it can anchor a balance, a signing payload, or a chain fact. A malformed
 * answer throws an honest "node returned a malformed …" error. */

export async function getRuntimeVersion(rpc) {
  const rt = await rpc.call('state_getRuntimeVersion');
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) throw new Error('node returned a malformed runtime version');
  const specVersion = parseVersionNumber(rt.specVersion);
  const transactionVersion = parseVersionNumber(rt.transactionVersion);
  if (specVersion === null || transactionVersion === null || typeof rt.specName !== 'string' || !rt.specName) {
    throw new Error('node returned a malformed runtime version');
  }
  return { specName: rt.specName, specVersion, transactionVersion };
}

export async function getGenesisHash(rpc) {
  const hash = await rpc.call('chain_getBlockHash', [0]);
  if (!isHash32(hash)) throw new Error('node returned a malformed genesis hash');
  return hash;
}

export async function getLatestHeader(rpc) {
  const hash = await rpc.call('chain_getBlockHash');
  if (!isHash32(hash)) throw new Error('node returned a malformed latest block hash');
  const header = await rpc.call('chain_getHeader', [hash]);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('node returned a malformed latest header');
  const number = parseBlockNumber(header.number);
  if (number === null) throw new Error('node returned a malformed latest header');
  return { hash, number };
}

export async function getEraBirthHash(rpc, currentNumber, period = 64) {
  const phase = currentNumber % period;
  const birth = eraBirth(currentNumber, period, phase);
  const hash = await rpc.call('chain_getBlockHash', [birth]);
  if (!isHash32(hash)) throw new Error('node returned a malformed era-birth block hash');
  return { era: encodeMortalEra(period, phase), birth, birthHash: hash, period, phase };
}

/* Balance via System.Account storage (Twox64Concat key built locally).
 * A null answer means the account is not on chain yet — a real state,
 * distinct from a malformed answer, which is an error. The blob must be
 * hex of exactly the frame_system AccountInfo length (68 bytes): a
 * shorter blob would make the decoder read out of bounds, a longer one
 * is a different struct than the one the balance render claims to show. */
export async function getAccountInfo(rpc, accountId) {
  const key = SYSTEM_ACCOUNT_KEY(accountId);
  const hex = '0x' + hexEncode(key);
  const res = await rpc.call('state_getStorage', [hex]);
  if (res === null || res === undefined) return null;
  if (!validStorageHex(res)) throw new Error('node returned a malformed account storage blob');
  const bytes = hexDecode(res.slice(2));
  if (bytes.length !== 68) throw new Error('node returned a malformed account storage blob');
  return decodeAccountInfo(bytes);
}

export async function getNonce(rpc, ss58Address) {
  const n = parseNonce(await rpc.call('system_accountNextIndex', [ss58Address]));
  if (n === null) throw new Error('node returned a malformed nonce');
  return n;
}

/* ---- transfer construction ---- */

/* Full extrinsic assembly + fee estimate for a transfer. Returns everything the
 * confirmation screen needs; nothing is signed here. */
export async function buildUnsignedTransfer(rpc, { fromAddress, fromAccountId, destAddress, amountPlancks, tipPlancks = 0n }) {
  const destAccountId = parseRecipient(destAddress);
  const call = buildTransferCall(destAccountId, amountPlancks);
  const [rt, genesisHash, latest, nonce] = await Promise.all([
    getRuntimeVersion(rpc),
    getGenesisHash(rpc),
    getLatestHeader(rpc),
    getNonce(rpc, fromAddress),
  ]);
  const { era, birth, birthHash, period, phase } = await getEraBirthHash(rpc, latest.number);
  const specVersion = rt.specVersion; // already validated u32 by getRuntimeVersion
  const txVersion = rt.transactionVersion;
  const genesisBytes = hexDecode(genesisHash.slice(2));
  const birthBytes = hexDecode(birthHash.slice(2));
  const payload = buildSigningPayload({
    call, era, nonce, tip: tipPlancks, specVersion, txVersion,
    genesisHash: genesisBytes, eraBirthHash: birthBytes,
  });
  // Fee estimate: build a length-accurate placeholder extrinsic (zero signature
  // is NOT length-accurate — ML-DSA sigs are fixed size, so pad exactly).
  const sigLen = 1 + 3309 + 1952; // ML-DSA-65 wire length
  const placeholder = buildExtrinsic({
    accountId: fromAccountId, signatureWire: new Uint8Array(sigLen),
    era, nonce, tip: tipPlancks, call,
  });
  let fee = null;
  try {
    const details = await rpc.call('payment_queryFeeDetails', ['0x' + hexEncode(placeholder), latest.hash]);
    const inc = details && typeof details === 'object' ? details.inclusionFee : null;
    const base = inc ? parseFeeField(inc.baseFee) : null;
    const len = inc ? parseFeeField(inc.lenFee) : null;
    const adj = inc ? parseFeeField(inc.adjustedWeightFee) : null;
    // Any malformed field (negative, fractional, object) voids the whole
    // quote — "node did not quote a fee" — never a coerced figure.
    fee = (base === null || len === null || adj === null) ? null : base + len + adj;
  } catch { fee = null; }
  return {
    call, era, nonce, tip: tipPlancks, specVersion, txVersion,
    genesisHash, birthHash, birth, period, phase, latest,
    payload, fee, destAccountId, fromAccountId,
    payloadHex: '0x' + hexEncode(payload),
  };
}

/* Sign the payload (ML-DSA, QUANTUS_EXTRINSIC context) and assemble the final
 * extrinsic bytes. signFn: (payloadBytes) -> signatureBytes. */
export function finalizeTransfer(unsigned, { signFn, scheme }) {
  const sig = signFn(unsigned.payload);
  const variant = scheme === 87 ? DILITHIUM87_VARIANT : DILITHIUM65_VARIANT;
  const pubLen = scheme === 87 ? 2592 : 1952;
  if (sig.pubkey.length !== pubLen) throw new Error('public key length mismatch');
  const signatureWire = new Uint8Array(1 + sig.signature.length + sig.pubkey.length);
  signatureWire[0] = variant;
  signatureWire.set(sig.signature, 1);
  signatureWire.set(sig.pubkey, 1 + sig.signature.length);
  const extrinsic = buildExtrinsic({
    accountId: unsigned.fromAccountId,
    signatureWire,
    era: unsigned.era,
    nonce: unsigned.nonce,
    tip: unsigned.tip,
    call: unsigned.call,
  });
  return { extrinsic, extrinsicHex: '0x' + hexEncode(extrinsic), signature: sig.signature, pubkey: sig.pubkey };
}

export async function submitExtrinsic(rpc, extrinsicHex) {
  const hash = await rpc.call('author_submitExtrinsic', [extrinsicHex]);
  // Only a real 32-byte hash may be presented to the user as their
  // transaction hash. Anything else means the broadcast is unconfirmed —
  // the extrinsic may or may not have landed, so say exactly that.
  if (!isHash32(hash)) throw new Error('node returned a malformed transaction hash — the broadcast is unconfirmed; check the explorer before retrying');
  return hash;
}
