/* Helpers for the live check: keypair + transfer assembly using the wallet's
 * own modules (so the live probe exercises the real code paths). */
import { ml_dsa65 } from '../vendor/noble/post-quantum/ml-dsa.js';
import { keypairFromSeed } from '../js/mnemonic.js';
import { hexEncode, hexDecode } from '../js/quantus-crypto.js';
import {
  RpcClient, getRuntimeVersion, getGenesisHash, getLatestHeader,
  getEraBirthHash, getNonce, parseRecipient, finalizeTransfer,
} from '../js/rpc.js';
import {
  buildTransferCall, buildSigningPayload, buildExtrinsic,
  SIGNING_CONTEXT, compactEncode,
} from '../js/scale.js';

export function hexEncodeShim(b) { return hexEncode(b); }

const RPC_URL = 'wss://rpc.quantus.network';

export function freshKeypair() {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const kp = keypairFromSeed(seed, 65);
  seed.fill(0);
  return kp;
}

export async function buildFor(kp, destAddress, amountPlancks) {
  const rpc = new RpcClient(RPC_URL);
  await rpc.connect();
  try {
    const destAccountId = parseRecipient(destAddress);
    const call = buildTransferCall(destAccountId, amountPlancks);
    const [rt, genesisHash, latest, nonce] = await Promise.all([
      getRuntimeVersion(rpc),
      getGenesisHash(rpc),
      getLatestHeader(rpc),
      getNonce(rpc, kp.address),
    ]);
    const { era, birth, birthHash } = await getEraBirthHash(rpc, latest.number);
    const payload = buildSigningPayload({
      call, era, nonce, tip: 0n,
      specVersion: Number(rt.specVersion), txVersion: Number(rt.transactionVersion),
      genesisHash: hexDecode(genesisHash.slice(2)), eraBirthHash: hexDecode(birthHash.slice(2)),
    });
    const sigLen = 1 + 3309 + 1952;
    const placeholder = buildExtrinsic({
      accountId: kp.accountId, signatureWire: new Uint8Array(sigLen),
      era, nonce, tip: 0n, call,
    });
    return {
      rpc, call, era, nonce, tip: 0n, payload, latest,
      fromAccountId: kp.accountId,
      placeholderHex: '0x' + hexEncode(placeholder),
    };
  } catch (e) { rpc.close(); throw e; }
}

export function signAndAssemble(kp, unsigned) {
  const ctx = new TextEncoder().encode(SIGNING_CONTEXT);
  const { extrinsic, extrinsicHex, signature, pubkey } = finalizeTransfer(unsigned, {
    scheme: 65,
    signFn: (payload) => ({
      signature: ml_dsa65.sign(payload, kp.secretKey, { context: ctx }),
      pubkey: kp.publicKey,
    }),
  });
  // pre-submit self-check, same as the UI does
  if (!ml_dsa65.verify(signature, unsigned.payload, pubkey, { context: ctx })) {
    throw new Error('local signature self-check failed');
  }
  unsigned.rpc.close();
  return { extrinsic, extrinsicHex };
}
