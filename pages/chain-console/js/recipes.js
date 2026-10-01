/* QTC Chain Console — one-click recipe catalog.
 * Each recipe is a single JSON-RPC method plus a form schema, an honest
 * "what this proves" note, and a result summarizer key understood by app.js.
 */
import { RECIPE_BUILDERS } from './core.js';

export const RECIPE_CATEGORIES = [
  { id: 'chain', title: 'Chain', blurb: 'Blocks, headers, finality.' },
  { id: 'accounts', title: 'Accounts & storage', blurb: 'Balances, nonces, raw state.' },
  { id: 'runtime', title: 'Runtime', blurb: 'Upgrades, properties, metadata.' },
  { id: 'node', title: 'Node', blurb: 'Health, peers, sync.' },
  { id: 'fees', title: 'Fees', blurb: 'Node-quoted fee math.' },
  { id: 'broadcast', title: 'Broadcast', blurb: 'Submit a signed extrinsic — gated.' },
];

/* summarize: key into app.js SUMMARIZERS; 'raw' shows plain JSON. */
export const RECIPES = [
  {
    id: 'head', cat: 'chain', method: 'chain_getHeader',
    title: 'Latest head', tag: 'chain_getHeader',
    proves: 'The newest block the node knows. Compare with the explorer to confirm you are on the canonical chain.',
    fields: [{ key: 'hash', label: 'Block hash (optional — blank = latest)', placeholder: '0x…', mono: true }],
    build: RECIPE_BUILDERS['chain_getHeader'], summarize: 'header',
  },
  {
    id: 'hash-by-number', cat: 'chain', method: 'chain_getBlockHash',
    title: 'Block hash by number', tag: 'chain_getBlockHash',
    proves: 'Canonical hash at a height. The genesis hash (number 0) is the chain\'s fingerprint — it must match everywhere.',
    fields: [{ key: 'number', label: 'Block number', placeholder: '0', inputmode: 'numeric' }],
    build: RECIPE_BUILDERS['chain_getBlockHash'], summarize: 'hash',
  },
  {
    id: 'block-by-hash', cat: 'chain', method: 'chain_getBlock',
    title: 'Full block by hash', tag: 'chain_getBlock',
    proves: 'Every extrinsic in a block. Quantus aggregates transfers, so one entry here can settle many payments.',
    fields: [{ key: 'hash', label: 'Block hash', placeholder: '0x…', mono: true, required: true }],
    build: RECIPE_BUILDERS['chain_getBlock'], summarize: 'block',
  },
  {
    id: 'finalized', cat: 'chain', method: 'chain_getFinalizedHead',
    title: 'Finalized head', tag: 'chain_getFinalizedHead',
    proves: 'The last block the network irreversibly agreed on. Anything behind it cannot be reorged away.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'hash',
  },
  {
    id: 'balance', cat: 'accounts', method: 'state_getStorage',
    title: 'Balance inspector', tag: 'state_getStorage',
    proves: 'Reads System.Account straight from chain state and decodes it locally — the same bytes your wallet reads.',
    fields: [{ key: 'address', label: 'SS58 address (prefix 189)', placeholder: 'qz…', mono: true, required: true }],
    build: RECIPE_BUILDERS['balance'], summarize: 'balance',
  },
  {
    id: 'next-nonce', cat: 'accounts', method: 'system_accountNextIndex',
    title: 'Next nonce', tag: 'system_accountNextIndex',
    proves: 'The nonce the next transaction from this account must use. Stale nonce = rejected transaction.',
    fields: [{ key: 'address', label: 'SS58 address (prefix 189)', placeholder: 'qz…', mono: true, required: true }],
    build: RECIPE_BUILDERS['system_accountNextIndex'], summarize: 'nonce',
  },
  {
    id: 'storage-read', cat: 'accounts', method: 'state_getStorage',
    title: 'Raw storage read', tag: 'state_getStorage',
    proves: 'Any storage key, verbatim. Use the key builder for map keys, or paste a key you copied from the explorer.',
    fields: [
      { key: 'key', label: 'Storage key (0x hex)', placeholder: '0x26aa394eea5630e07c48ae0c9558cef7…', mono: true, required: true },
      { key: 'atHash', label: 'At block hash (optional — blank = latest)', placeholder: '0x…', mono: true },
    ],
    build: RECIPE_BUILDERS['state_getStorage'], summarize: 'storage',
  },
  {
    id: 'runtime-version', cat: 'runtime', method: 'state_getRuntimeVersion',
    title: 'Runtime version', tag: 'state_getRuntimeVersion',
    proves: 'specVersion bumps on every runtime upgrade — governance can upgrade the chain without restarting nodes.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'runtime',
  },
  {
    id: 'properties', cat: 'runtime', method: 'system_properties',
    title: 'Chain properties', tag: 'system_properties',
    proves: 'The chain\'s own claim about itself: SS58 prefix 189, 12 decimals, QTC symbol. Trust, then verify.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'properties',
  },
  {
    id: 'metadata-info', cat: 'runtime', method: 'state_getMetadata',
    title: 'Metadata size check', tag: 'state_getMetadata',
    proves: 'Fetches the full runtime metadata but only shows its size — decoding megabytes of metadata belongs in Polkadot-JS, not a browser console.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'metadata',
  },
  {
    id: 'health', cat: 'node', method: 'system_health',
    title: 'Node health', tag: 'system_health',
    proves: 'Is the node syncing, and does it have peers? isSyncing=true with 0 peers means check your firewall.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'health',
  },
  {
    id: 'peers', cat: 'node', method: 'system_peers',
    title: 'Peer table', tag: 'system_peers',
    proves: 'Who this node talks to and how far ahead they are. A peer far ahead of you is a sync target.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'peers',
  },
  {
    id: 'sync-state', cat: 'node', method: 'system_syncState',
    title: 'Sync state', tag: 'system_syncState',
    proves: 'currentBlock → highestBlock is your sync gap. startingBlock anchors the session.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'sync',
  },
  {
    id: 'node-id', cat: 'node', method: 'multi',
    title: 'Node identity (5 calls)', tag: 'system_*',
    proves: 'Fires system_chain, system_name, system_version, system_chainType and system_nodeRoles in parallel — the node\'s ID card.',
    fields: [], build: () => ({ ok: true, params: [] }), summarize: 'nodeid', custom: 'nodeid',
  },
  {
    id: 'fee-quote', cat: 'fees', method: 'payment_queryInfo',
    title: 'Fee quote', tag: 'payment_queryInfo',
    proves: 'The node prices your exact extrinsic bytes. Paste one built by the Airgap Desk to see its real cost.',
    fields: [{ key: 'extrinsic', label: 'Unsigned or signed extrinsic hex', placeholder: '0x…', mono: true, required: true, textarea: true }],
    build: RECIPE_BUILDERS['payment_queryInfo'], summarize: 'fee',
  },
  {
    id: 'fee-details', cat: 'fees', method: 'payment_queryFeeDetails',
    title: 'Fee breakdown', tag: 'payment_queryFeeDetails',
    proves: 'Splits the quote into inclusion fee vs tip — the anatomy of what you pay per byte and per weight.',
    fields: [{ key: 'extrinsic', label: 'Unsigned or signed extrinsic hex', placeholder: '0x…', mono: true, required: true, textarea: true }],
    build: RECIPE_BUILDERS['payment_queryFeeDetails'], summarize: 'feedetails',
  },
  {
    id: 'submit', cat: 'broadcast', method: 'author_submitExtrinsic',
    title: 'Submit signed extrinsic', tag: 'author_submitExtrinsic',
    proves: 'Broadcasts bytes to the network. Two-step confirm, and the console never asks for a key — it only moves bytes you already signed.',
    fields: [{ key: 'extrinsic', label: 'Signed extrinsic hex (from the Airgap Desk)', placeholder: '0x…', mono: true, required: true, textarea: true }],
    build: RECIPE_BUILDERS['author_submitExtrinsic'], summarize: 'submit', custom: 'submit', gated: true,
    gateNote: 'This is the one write call in the console. Public RPCs often reject it — that is a node policy, not a bug. Produce the signed hex in the Airgap Desk.',
  },
];

export function getRecipe(id) { return RECIPES.find((r) => r.id === id); }
