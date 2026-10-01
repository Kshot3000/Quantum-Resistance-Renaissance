/* (header comment preserved above) */
(function (global) {
"use strict";
/* QTC Extrinsic Lab — verified runtime call table.
 *
 * Every entry was read from Quantus-Network/chain source (fresh clone, rev 482c5b9,
 * extracted 2026-09-30) — NOT from memory or from upstream polkadot-sdk defaults,
 * because Quantus ships custom pallet forks whose call indices differ from upstream.
 *
 * Sources:
 *   runtime/src/lib.rs                    — pallet index map (construct_runtime)
 *   pallets/{balances,utility,reversible-transfers,multisig,vesting,preimage,
 *     scheduler,ranked-collective,referenda,treasury,wormhole,zk-tree,
 *     timestamp,frame-system,qpow,mining-rewards,transaction-payment}/src/lib.rs
 *   primitives/scheduler/src/lib.rs        — BlockNumberOrTimestamp, DispatchTime codecs
 *   runtime/src/governance/definitions.rs  — TrackId = u16
 *   substrate/frame/support/procedural     — auto call-index rule for wormhole
 *     (no #[pallet::call_index] => last assigned index + 1; explicit indices also
 *      advance the counter — verified in polkadot-sdk parse/call.rs)
 *
 * Arg shape DSL (see decode.js):
 *   {k:'u8'|'u16'|'u32'|'u64'|'u128'|'bool'}            fixed-width LE integer / bool
 *   {k:'compact', of:'u32'|'u64'|'u128'}                SCALE compact integer
 *   {k:'accountId'}                                    32 bytes -> SS58-189 + checkphrase
 *   {k:'hash'}                                         32 bytes, hex
 *   {k:'multiaddr'}                                    MultiAddress<AccountId,()>: variant byte
 *                                                      0x00 Id(32B) | 0x01 Index(compact u32)
 *                                                      0x02 Raw(vec) | 0x03 Address32(32B)
 *                                                      0x04 Address20(20B)
 *   {k:'bytes'}                                        compact Vec<u8>
 *   {k:'vec', of:shape}                                compact Vec<T>
 *   {k:'option', of:shape}                             Option<T>
 *   {k:'callbytes'}                                    BoundedVec<u8> holding an encoded RuntimeCall
 *   {k:'call'}                                         inline encoded RuntimeCall (recursive)
 *   {k:'enum', name, variants:[{name, fields:[shapes]}]} codec enum (variant byte)
 *   {k:'opaque', why}                                  shown as raw hex with an honest note
 *
 * Conventions: amount-ish u128/compact-u128 fields named value/amount/total render
 * with a QTC conversion in the UI (12 decimals). Moment = u64 ms.
 */
var CALL_TABLE_META = {
  source: 'Quantus-Network/chain',
  rev: '482c5b9',
  extracted: '2026-09-30',
  specVersion: 153,   // state_getRuntimeVersion at extraction time (dev-hub, same rev)
  txVersion: 6,
};

const U8 = { k: 'u8' }, U16 = { k: 'u16' }, U32 = { k: 'u32' }, U64 = { k: 'u64' },
      U128 = { k: 'u128' }, BOOL = { k: 'bool' };
const CU32 = { k: 'compact', of: 'u32' }, CU64 = { k: 'compact', of: 'u64' },
      CU128 = { k: 'compact', of: 'u128' };
const ACCOUNT = { k: 'accountId' }, HASH = { k: 'hash' }, MADDR = { k: 'multiaddr' },
      BYTES = { k: 'bytes' }, CALLB = { k: 'callbytes' }, CALL = { k: 'call' };

/* BlockNumberOrTimestamp<BlockNumber=u32, Moment=u64> — primitives/scheduler/src/lib.rs */
const BNOT = {
  k: 'enum', name: 'BlockNumberOrTimestamp',
  variants: [
    { name: 'BlockNumber', fields: [U32] },
    { name: 'Timestamp', fields: [U64] },
  ],
};
/* DispatchTime<BlockNumber, Moment> — primitives/scheduler/src/lib.rs */
const DTIME = {
  k: 'enum', name: 'DispatchTime',
  variants: [
    { name: 'At', fields: [U32] },
    { name: 'After', fields: [BNOT] },
  ],
};

var PALLETS = [
  {
    index: 0, name: 'System', note: 'Core block/execution state.',
    calls: [
      { index: 0, name: 'remark', args: [{ name: 'remark', shape: BYTES, utf8: true }] },
      { index: 1, name: 'set_heap_pages', root: true, args: [{ name: 'pages', shape: U64 }] },
      { index: 2, name: 'set_code', root: true, args: [{ name: 'code', shape: BYTES }] },
      { index: 3, name: 'set_code_without_checks', root: true, args: [{ name: 'code', shape: BYTES }] },
      { index: 4, name: 'set_storage', root: true, args: [{ name: 'items', shape: { k: 'opaque', why: 'Vec<(Key, Value)> — storage keys are raw bytes; decoded generically as hex pairs' } }] },
      { index: 5, name: 'kill_storage', root: true, args: [{ name: 'keys', shape: BYTES }] },
      { index: 6, name: 'kill_prefix', root: true, args: [{ name: 'prefix', shape: BYTES }, { name: 'subkeys', shape: U32 }] },
      { index: 7, name: 'remark_with_event', args: [{ name: 'remark', shape: BYTES, utf8: true }] },
      { index: 8, name: 'do_task', args: [{ name: 'task', shape: { k: 'opaque', why: 'RuntimeTask is a runtime-generated enum; decoded as raw bytes' } }] },
      { index: 9, name: 'authorize_upgrade', args: [{ name: 'code_hash', shape: HASH }] },
      { index: 10, name: 'authorize_upgrade_without_checks', args: [{ name: 'code_hash', shape: HASH }] },
      { index: 11, name: 'apply_authorized_upgrade', args: [{ name: 'code', shape: BYTES }] },
    ],
  },
  {
    index: 1, name: 'Timestamp', note: 'Block timestamp — set by the block author (inherent).',
    calls: [
      { index: 0, name: 'set', args: [{ name: 'now', shape: CU64, moment: true }] },
    ],
  },
  {
    index: 2, name: 'Balances', note: 'QTC balances. Quantus fork: custom call set (transfer_all @ 4, burn @ 10).',
    calls: [
      { index: 0, name: 'transfer_allow_death', args: [{ name: 'dest', shape: MADDR }, { name: 'value', shape: CU128, qtc: true }] },
      { index: 3, name: 'transfer_keep_alive', args: [{ name: 'dest', shape: MADDR }, { name: 'value', shape: CU128, qtc: true }] },
      { index: 4, name: 'transfer_all', args: [{ name: 'dest', shape: MADDR }, { name: 'keep_alive', shape: BOOL }] },
      { index: 10, name: 'burn', args: [{ name: 'value', shape: CU128, qtc: true }, { name: 'keep_alive', shape: BOOL }] },
    ],
  },
  { index: 3, name: 'TransactionPayment', note: 'Fee engine — no user dispatchables.', calls: [] },
  { index: 5, name: 'QPoW', note: 'Proof-of-work consensus — mining API only, no user dispatchables.', calls: [] },
  { index: 6, name: 'MiningRewards', note: 'Emission engine — no user dispatchables.', calls: [] },
  {
    index: 7, name: 'Preimage', note: 'On-chain preimage store.',
    calls: [
      { index: 0, name: 'note_preimage', args: [{ name: 'bytes', shape: BYTES }] },
      { index: 1, name: 'unnote_preimage', args: [{ name: 'hash', shape: HASH }] },
      { index: 2, name: 'request_preimage', args: [{ name: 'hash', shape: HASH }] },
      { index: 3, name: 'unrequest_preimage', args: [{ name: 'hash', shape: HASH }] },
      { index: 4, name: 'ensure_updated', args: [{ name: 'hashes', shape: { k: 'vec', of: HASH } }] },
    ],
  },
  {
    index: 8, name: 'Scheduler', note: 'Restricted: extrinsics disabled for users by the runtime (used internally for reversible transfers and governance).',
    calls: [
      { index: 0, name: 'schedule', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 1, name: 'cancel', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 2, name: 'schedule_named', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 3, name: 'cancel_named', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 4, name: 'schedule_after', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 5, name: 'schedule_named_after', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 6, name: 'set_retry', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 7, name: 'set_retry_named', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 8, name: 'cancel_retry', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
      { index: 9, name: 'cancel_retry_named', disabled: true, args: [{ name: 'args', shape: { k: 'opaque', why: 'user-disabled; shown as raw bytes' } }] },
    ],
  },
  {
    index: 9, name: 'Utility', note: 'Quantus fork exposes only batch_all (atomic batch).',
    calls: [
      { index: 2, name: 'batch_all', args: [{ name: 'calls', shape: { k: 'vec', of: CALL } }] },
    ],
  },
  {
    index: 11, name: 'ReversibleTransfers', note: 'SafeSend: reversible QTC payments. Note: amount is a plain u128 here (NOT compact — verified in source). Indices 5–6 were asset calls, removed.',
    calls: [
      { index: 0, name: 'set_high_security', args: [{ name: 'delay', shape: BNOT }, { name: 'guardian', shape: ACCOUNT }] },
      { index: 1, name: 'cancel', args: [{ name: 'tx_id', shape: HASH }] },
      { index: 2, name: 'execute_transfer', args: [{ name: 'tx_id', shape: HASH }] },
      { index: 3, name: 'schedule_transfer', args: [{ name: 'dest', shape: MADDR }, { name: 'amount', shape: U128, qtc: true }] },
      { index: 4, name: 'schedule_transfer_with_delay', args: [{ name: 'dest', shape: MADDR }, { name: 'amount', shape: U128, qtc: true }, { name: 'delay', shape: BNOT }] },
      { index: 7, name: 'recover_funds', args: [{ name: 'account', shape: ACCOUNT }] },
    ],
  },
  {
    index: 13, name: 'TechCollective', note: 'Ranked collective — the technical committee lane.',
    calls: [
      { index: 0, name: 'add_member', args: [{ name: 'who', shape: MADDR }] },
      { index: 1, name: 'promote_member', args: [{ name: 'who', shape: MADDR }] },
      { index: 2, name: 'demote_member', args: [{ name: 'who', shape: MADDR }] },
      { index: 3, name: 'remove_member', args: [{ name: 'who', shape: MADDR }, { name: 'min_rank', shape: U16 }] },
      { index: 4, name: 'vote', args: [{ name: 'poll', shape: U32 }, { name: 'aye', shape: BOOL }] },
      { index: 5, name: 'cleanup_poll', args: [{ name: 'poll_index', shape: U32 }, { name: 'max', shape: U32 }] },
      { index: 6, name: 'exchange_member', args: [{ name: 'who', shape: MADDR }, { name: 'new_who', shape: MADDR }] },
    ],
  },
  {
    index: 14, name: 'TechReferenda', note: 'Governance referenda for the tech tracks.',
    calls: [
      { index: 0, name: 'submit', args: [{ name: 'proposal_origin', shape: { k: 'opaque', why: 'Box<OriginCaller>: runtime-generated origin enum; decoded as raw bytes' } }, { name: 'proposal', shape: CALLB }, { name: 'enactment_moment', shape: DTIME }] },
      { index: 1, name: 'place_decision_deposit', args: [{ name: 'index', shape: U32 }] },
      { index: 2, name: 'refund_decision_deposit', args: [{ name: 'index', shape: U32 }] },
      { index: 3, name: 'cancel', args: [{ name: 'index', shape: U32 }] },
      { index: 4, name: 'kill', args: [{ name: 'index', shape: U32 }] },
      { index: 5, name: 'nudge_referendum', args: [{ name: 'index', shape: U32 }] },
      { index: 6, name: 'one_fewer_deciding', args: [{ name: 'track', shape: U16 }] },
      { index: 7, name: 'refund_submission_deposit', args: [{ name: 'index', shape: U32 }] },
      { index: 8, name: 'set_metadata', args: [{ name: 'index', shape: U32 }, { name: 'maybe_hash', shape: { k: 'option', of: HASH } }] },
    ],
  },
  {
    index: 15, name: 'TreasuryPallet', note: 'On-chain treasury (currently a single config call).',
    calls: [
      { index: 0, name: 'set_treasury_account', args: [{ name: 'account', shape: ACCOUNT }] },
    ],
  },
  {
    index: 19, name: 'Multisig', note: 'Custom Quantus multisig pallet (NOT upstream pallet-multisig): create_multisig first derives the address.',
    calls: [
      { index: 0, name: 'create_multisig', args: [{ name: 'signers', shape: { k: 'vec', of: ACCOUNT } }, { name: 'threshold', shape: U32 }, { name: 'nonce', shape: U64 }] },
      { index: 1, name: 'propose', args: [{ name: 'multisig_address', shape: ACCOUNT }, { name: 'call', shape: CALLB }, { name: 'expiry', shape: U32 }] },
      { index: 2, name: 'approve', args: [{ name: 'multisig_address', shape: ACCOUNT }, { name: 'proposal_id', shape: U32 }, { name: 'call', shape: CALLB }] },
      { index: 3, name: 'cancel', args: [{ name: 'multisig_address', shape: ACCOUNT }, { name: 'proposal_id', shape: U32 }] },
      { index: 4, name: 'remove_expired', args: [{ name: 'multisig_address', shape: ACCOUNT }, { name: 'proposal_id', shape: U32 }] },
      { index: 5, name: 'claim_deposits', args: [{ name: 'multisig_address', shape: ACCOUNT }] },
      { index: 6, name: 'execute', args: [{ name: 'multisig_address', shape: ACCOUNT }, { name: 'proposal_id', shape: U32 }, { name: 'call', shape: CALL }] },
    ],
  },
  {
    index: 20, name: 'Wormhole', note: 'Bridge-exit verification. from_public_batch / record_transfer are internal helpers, not dispatchables (verified in source).',
    calls: [
      { index: 2, name: 'verify_private_batch', args: [{ name: 'proof_bytes', shape: BYTES }] },
      { index: 3, name: 'verify_public_batch', args: [{ name: 'proof_bytes', shape: BYTES }] },
    ],
  },
  { index: 21, name: 'ZkTree', note: 'ZK-tree pallet — no user dispatchables found in source.', calls: [] },
  {
    index: 22, name: 'Vesting', note: 'Custom Quantus vesting pallet: claim by schedule_id.',
    calls: [
      { index: 0, name: 'claim', args: [{ name: 'schedule_id', shape: U64 }] },
      { index: 1, name: 'create_schedule', args: [{ name: 'beneficiary', shape: ACCOUNT }, { name: 'start', shape: U64, moment: true }, { name: 'cliff', shape: U64, moment: true }, { name: 'end', shape: U64, moment: true }, { name: 'total', shape: U128, qtc: true }] },
      { index: 2, name: 'end_schedule', args: [{ name: 'schedule_id', shape: U64 }] },
      { index: 3, name: 'retarget_schedule', args: [{ name: 'schedule_id', shape: U64 }, { name: 'new_beneficiary', shape: ACCOUNT }] },
    ],
  },
  { index: 23, name: 'Origins', note: 'Custom governance origins — no calls, no storage.', calls: [] },
];

function lookupCall(palletIndex, callIndex) {
  const p = PALLETS.find((x) => x.index === palletIndex);
  if (!p) return { pallet: null, call: null };
  const c = p.calls.find((x) => x.index === callIndex);
  return { pallet: p, call: c || null };
}

global.QEL_CALLS = {
  CALL_TABLE_META: CALL_TABLE_META,
  PALLETS: PALLETS,
  lookupCall: lookupCall
};
if (typeof module !== "undefined" && module.exports) module.exports = global.QEL_CALLS;
})(typeof globalThis !== "undefined" ? globalThis : this);
