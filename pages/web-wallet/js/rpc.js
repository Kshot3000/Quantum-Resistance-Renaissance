/* QTC Web Wallet — Substrate JSON-RPC client + chain queries (ES module).
 *
 * Connects to any Substrate WebSocket RPC (default: the upstream-documented
 * mainnet node wss://rpc.quantus.network, also used by the Mempool Desk).
 * All queries are read-only except author_submitExtrinsic, which only fires
 * after the user explicitly confirms a signed transfer.
 */
import { hexEncode, hexDecode } from './quantus-crypto.js';
import { ss58Decode } from './quantus-crypto.js';
import { SYSTEM_ACCOUNT_KEY } from './xxhash.js';
import { decodeAccountInfo, eraBirth, encodeMortalEra, buildTransferCall, buildSigningPayload, buildExtrinsic, DILITHIUM65_VARIANT, DILITHIUM87_VARIANT } from './scale.js';

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
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
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

/* ---- chain queries ---- */

export async function getRuntimeVersion(rpc) {
  return rpc.call('state_getRuntimeVersion');
}

export async function getGenesisHash(rpc) {
  return rpc.call('chain_getBlockHash', [0]);
}

export async function getLatestHeader(rpc) {
  const hash = await rpc.call('chain_getBlockHash');
  const header = await rpc.call('chain_getHeader', [hash]);
  return { hash, number: parseInt(header.number, 16) };
}

export async function getEraBirthHash(rpc, currentNumber, period = 64) {
  const phase = currentNumber % period;
  const birth = eraBirth(currentNumber, period, phase);
  const hash = await rpc.call('chain_getBlockHash', [birth]);
  return { era: encodeMortalEra(period, phase), birth, birthHash: hash, period, phase };
}

/* Balance via System.Account storage (Twox64Concat key built locally). */
export async function getAccountInfo(rpc, accountId) {
  const key = SYSTEM_ACCOUNT_KEY(accountId);
  const hex = '0x' + hexEncode(key);
  const res = await rpc.call('state_getStorage', [hex]);
  if (!res) return null;
  return decodeAccountInfo(hexDecode(res.startsWith('0x') ? res.slice(2) : res));
}

export async function getNonce(rpc, ss58Address) {
  const n = await rpc.call('system_accountNextIndex', [ss58Address]);
  return Number(n);
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
  const specVersion = Number(rt.specVersion);
  const txVersion = Number(rt.transactionVersion);
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
    fee = BigInt(details.inclusionFee.baseFee) + BigInt(details.inclusionFee.lenFee) + BigInt(details.inclusionFee.adjustedWeightFee);
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
  return rpc.call('author_submitExtrinsic', [extrinsicHex]);
}
