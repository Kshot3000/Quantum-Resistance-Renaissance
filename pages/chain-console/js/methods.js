/* QTC Chain Console — searchable JSON-RPC method reference.
 * Methods are standard Substrate RPC (the Quantus node is Substrate/Polkadot-SDK
 * based); notes flag Quantus-specific behavior observed by this builder's desks.
 * "recipe" links to a one-click recipe id when one exists.
 */

export const METHOD_GROUPS = [
  {
    id: 'system', title: 'system_* — node identity & status',
    methods: [
      { name: 'system_chain', params: [], returns: 'String', note: 'Human-readable chain name. Expect "Quantus".', recipe: null },
      { name: 'system_name', params: [], returns: 'String', note: 'Node implementation name.', recipe: null },
      { name: 'system_version', params: [], returns: 'String', note: 'Node binary version — useful when debugging peer issues.', recipe: null },
      { name: 'system_chainType', params: [], returns: 'String', note: '"Live" on mainnet.', recipe: null },
      { name: 'system_properties', params: [], returns: 'Object', note: 'The chain\'s self-description: ss58Format 189, tokenDecimals 12, tokenSymbol QTC.', recipe: 'properties' },
      { name: 'system_health', params: [], returns: '{isSyncing, peers, shouldHavePeers}', note: 'Fast liveness check. Script it.', recipe: 'health' },
      { name: 'system_peers', params: [], returns: 'Array', note: 'Connected peers with roles and best block.', recipe: 'peers' },
      { name: 'system_syncState', params: [], returns: '{startingBlock, currentBlock, highestBlock}', note: 'Your sync gap at a glance.', recipe: 'sync-state' },
      { name: 'system_localPeerId', params: [], returns: 'String', note: 'This node\'s libp2p identity.', recipe: null },
      { name: 'system_localListenAddresses', params: [], returns: 'Array<String>', note: 'Addresses the node listens on — compare with your firewall map (see the Node Operator Desk).', recipe: null },
      { name: 'system_nodeRoles', params: [], returns: 'Array<String>', note: 'e.g. ["Full"]. Authority roles only appear on validators — Quantus is PoW, so expect Full.', recipe: null },
      { name: 'system_accountNextIndex', params: ['address: SS58 String'], returns: 'u32', note: 'Next valid nonce for the account. Required reading before hand-building any extrinsic.', recipe: 'next-nonce' },
      { name: 'system_addReservedPeer', params: ['peer: String (multiaddr)'], returns: '()', note: 'Pin a peer. Needs an RPC with unsafe methods enabled — public endpoints refuse this.', recipe: null },
      { name: 'system_removeReservedPeer', params: ['peerId: String'], returns: '()', note: 'Unpin a reserved peer. Same unsafe-RPC caveat.', recipe: null },
    ],
  },
  {
    id: 'chain', title: 'chain_* — blocks & finality',
    methods: [
      { name: 'chain_getHeader', params: ['[blockHash: Hex]'], returns: 'Header | null', note: 'Omit the hash for the latest head.', recipe: 'head' },
      { name: 'chain_getBlock', params: ['[blockHash: Hex]'], returns: 'SignedBlock', note: 'Full block including the extrinsics array.', recipe: 'block-by-hash' },
      { name: 'chain_getBlockHash', params: ['[blockNumber: u32]'], returns: 'Hex | null', note: 'Number 0 returns the genesis hash — the chain\'s fingerprint.', recipe: 'hash-by-number' },
      { name: 'chain_getFinalizedHead', params: [], returns: 'Hex', note: 'Irreversible head. Confirmations are counted from here.', recipe: 'finalized' },
      { name: 'chain_subscribeNewHeads', params: [], returns: 'subId → Header', note: 'Live feed of every new head with block times.', recipe: null },
      { name: 'chain_subscribeFinalizedHeads', params: [], returns: 'subId → Header', note: 'Live feed of finality only.', recipe: null },
      { name: 'chain_unsubscribeNewHeads', params: ['subId'], returns: 'bool', note: 'Clean up your subscriptions.', recipe: null },
      { name: 'chain_getRuntimeVersion', params: ['[blockHash: Hex]'], returns: 'RuntimeVersion', note: 'Older alias of state_getRuntimeVersion on some nodes.', recipe: null },
    ],
  },
  {
    id: 'state', title: 'state_* — storage & runtime',
    methods: [
      { name: 'state_getStorage', params: ['key: Hex', '[atHash: Hex]'], returns: 'Hex | null', note: 'Raw storage bytes. null = empty key (e.g. an account that was never funded).', recipe: 'storage-read' },
      { name: 'state_getStorageHash', params: ['key: Hex', '[atHash]'], returns: 'Hex | null', note: 'Hash of the stored value without fetching it.', recipe: null },
      { name: 'state_getStorageSize', params: ['key: Hex', '[atHash]'], returns: 'u64 | null', note: 'Byte size of a storage value.', recipe: null },
      { name: 'state_getMetadata', params: ['[atHash]'], returns: 'Hex (large)', note: 'Full runtime metadata — megabytes. The console fetches it but only reports the size.', recipe: 'metadata-info' },
      { name: 'state_getRuntimeVersion', params: ['[atHash]'], returns: 'RuntimeVersion', note: 'specVersion bumps on runtime upgrades.', recipe: 'runtime-version' },
      { name: 'state_subscribeStorage', params: ['[[keys: Hex]]'], returns: 'subId → StorageChangeSet', note: 'Watch keys change live — point it at an account key to watch a balance move.', recipe: null },
      { name: 'state_unsubscribeStorage', params: ['subId'], returns: 'bool', note: 'Stop a storage watch.', recipe: null },
      { name: 'state_queryStorage', params: ['keys: [Hex]', 'from: Hex', '[to: Hex]'], returns: 'Array<StorageChangeSet>', note: 'Historical changes for keys across a block range.', recipe: null },
      { name: 'state_getKeysPaged', params: ['prefix: Hex', 'count: u32', '[startKey]', '[atHash]'], returns: 'Array<Hex>', note: 'Page through storage keys under a prefix — the honest way to enumerate maps.', recipe: null },
      { name: 'state_call', params: ['method: String', 'data: Hex', '[atHash]'], returns: 'Hex', note: 'Call a runtime API directly. Advanced — needs the runtime API name from metadata.', recipe: null },
    ],
  },
  {
    id: 'author', title: 'author_* — the transaction pool',
    methods: [
      { name: 'author_submitExtrinsic', params: ['extrinsic: Hex'], returns: 'Hex (tx hash)', note: 'Broadcast bytes. Public RPCs often disable or rate-limit this — a rejection is node policy, not a console bug.', recipe: 'submit' },
      { name: 'author_pendingExtrinsics', params: [], returns: 'Array<Hex>', note: 'Everything waiting in the pool. Commonly disabled on public RPCs — the Mempool Desk handles the fallback honestly.', recipe: null },
      { name: 'author_submitAndWatchExtrinsic', params: ['extrinsic: Hex'], returns: 'subId → status events', note: 'Broadcast with lifecycle events (inBlock → finalized). Needs an unsafe-capable RPC.', recipe: null },
      { name: 'author_unwatchExtrinsic', params: ['subId'], returns: 'bool', note: 'Stop watching a submission.', recipe: null },
    ],
  },
  {
    id: 'payment', title: 'payment_* — fee math',
    methods: [
      { name: 'payment_queryInfo', params: ['extrinsic: Hex', '[atHash]'], returns: '{partialFee, weight, class}', note: 'The node prices your exact bytes. partialFee is in planck (10¹² = 1 QTC).', recipe: 'fee-quote' },
      { name: 'payment_queryFeeDetails', params: ['extrinsic: Hex', '[atHash]'], returns: '{inclusionFee: {baseFee, lenFee, adjustedWeightFee}, tip}', note: 'The anatomy of the quote: base + per-byte + per-weight.', recipe: 'fee-details' },
    ],
  },
  {
    id: 'txwatch', title: 'txWatch_* — Quantus pool listener (custom)',
    methods: [
      { name: 'txWatch_watchAddress', params: ['address: SS58 String'], returns: 'subId', note: 'Quantus-specific: pushes txWatch_transfer events the moment a transfer to the address enters the pool. See the Mempool Desk for the full desk.', recipe: null },
      { name: 'txWatch_unwatchAddress', params: ['subId'], returns: 'bool', note: 'Stop an address watch.', recipe: null },
    ],
  },
];

export function allMethods() {
  return METHOD_GROUPS.flatMap((g) => g.methods.map((m) => ({ ...m, group: g.title })));
}
