/* QTC Web Wallet — LIVE end-to-end checks against the real Quantus node.
 * Run: node tests/live-rpc-check.mjs   (needs network)
 *
 * 1. Connects to wss://rpc.quantus.network, reads runtime/genesis/head.
 * 2. Storage-key validation: takes the most recent transfer sender from the
 *    Subsquid indexer, computes System.Account via the wallet's own xxhash,
 *    decodes it, and cross-checks `free` against the indexer's account_by_pk.
 * 3. Format/signature validation: builds a FULLY SIGNED transfer_keep_alive
 *    extrinsic from a throwaway unfunded keypair and submits it. The node must
 *    reject it for lack of funds (InvalidTransaction::Payment family) — any
 *    signature/format/era/nonce error instead means our wire format is wrong.
 *    Nothing is ever broadcast from a funded account here.
 */
import { RpcClient, getRuntimeVersion, getGenesisHash, getLatestHeader, getAccountInfo } from '../js/rpc.js';

const RPC_URL = 'wss://rpc.quantus.network';
const SQUID = 'https://sqm.quantus.com/v1/graphql';

const results = [];
const ok = (name, detail) => { results.push(['PASS', name, detail]); console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); };
const fail = (name, detail) => { results.push(['FAIL', name, detail]); console.log(`  ✖ ${name}${detail ? ' — ' + detail : ''}`); };

console.log('== QTC Web Wallet live RPC check ==');
const rpc = new RpcClient(RPC_URL);
try {
  await rpc.connect();
  ok('websocket connect', RPC_URL);
} catch (e) { fail('websocket connect', e.message); process.exit(1); }

try {
  const rt = await getRuntimeVersion(rpc);
  ok('state_getRuntimeVersion', `specName=${rt.specName} spec=${rt.specVersion} txV=${rt.transactionVersion}`);
  const genesis = await getGenesisHash(rpc);
  ok('chain_getBlockHash(0)', genesis.slice(0, 18) + '…');
  const latest = await getLatestHeader(rpc);
  ok('chain_getHeader', `#${latest.number}`);
} catch (e) { fail('chain facts', e.message); }

// --- storage key cross-check ---
try {
  const q = `{ transfer(limit:1, order_by:{block_height:desc}) { from_id to_id amount block_height } }`;
  const r = await fetch(SQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  const t = j.data.transfer[0];
  const { parseRecipient } = await import('../js/rpc.js');
  const { SYSTEM_ACCOUNT_KEY } = await import('../js/xxhash.js');
  const { hexEncode, hexDecode } = await import('../js/quantus-crypto.js');
  const accountId = parseRecipient(t.from_id);
  const info = await getAccountInfo(rpc, accountId);
  if (!info) throw new Error('storage returned null for a known sender — xxhash key wrong?');
  // cross-check with indexer
  const q2 = `{ account_by_pk(id:"${t.from_id}") { free } }`;
  const r2 = await fetch(SQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q2 }) });
  const freeIdx = BigInt((await r2.json()).data.account_by_pk.free);
  const match = info.free === freeIdx ? 'matches indexer' : `MISMATCH rpc=${info.free} indexer=${freeIdx}`;
  ok('System.Account storage key (own xxhash)', `${t.from_id.slice(0, 12)}… free=${info.free} (${match})`);
  if (info.free !== freeIdx) fail('balance cross-check', `rpc ${info.free} vs indexer ${freeIdx}`);
} catch (e) { fail('storage key cross-check', e.message); }

console.log('\n-- signed-extrinsic submission probe (throwaway unfunded key) --');
try {
  const helpers = await import('./live-helpers.mjs');
  const kp = helpers.freshKeypair();
  console.log(`  throwaway address: ${kp.address}`);
  const dest = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau'; // Kyle's QTC donation address (burn-safe: we hold no funds to send)
  const unsigned = await helpers.buildFor(kp, dest, 1000000000000n);
  console.log(`  payload ${unsigned.payload.length} bytes (< 256, signed raw)`);
  // 1) fee query decodes our extrinsic on the node
  let feeOk = false;
  try {
    const fee = await rpc.call('payment_queryFeeDetails', [unsigned.placeholderHex, unsigned.latest.hash]);
    feeOk = true;
    ok('payment_queryFeeDetails decodes our extrinsic', `inclusion=${fee.inclusionFee.baseFee}+${fee.inclusionFee.lenFee}+${fee.inclusionFee.adjustedWeightFee}`);
  } catch (e) { fail('payment_queryFeeDetails', e.message); }
  // 2) submit the real signed extrinsic; expect funds-related rejection ONLY
  const signed = helpers.signAndAssemble(kp, unsigned);
  console.log(`  extrinsic ${signed.extrinsic.length} bytes`);
  try {
    const hash = await rpc.call('author_submitExtrinsic', [signed.extrinsicHex]);
    fail('submit rejected as expected', 'node ACCEPTED an unfunded extrinsic?! hash=' + hash);
  } catch (e) {
    const msg = e.message;
    const fundsErr = /fee|fund|balance|payment|1010|1012/i.test(msg);
    const formatErr = /badproof|badsignature|badsigner|stale|ancient|birth|era|nonce.*mismatch|1014|1002/i.test(msg);
    console.log(`  node said: ${msg.slice(0, 160)}`);
    if (fundsErr && !formatErr) ok('node rejected for funds only (signature+format accepted)', 'proves wire format valid');
    else fail('submit rejection reason', msg.slice(0, 200));
  }
} catch (e) { fail('submission probe', e.message); }

rpc.close();
const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n== ${results.length - fails}/${results.length} live checks passed ==`);
process.exit(fails ? 1 : 0);
