/* QTC Proposal Studio — gov-codec.js
 * Pure governance encoding logic for the Quantus tech-collective lane.
 * No DOM. Every constant below was read from Quantus-Network/chain @ 482c5b9
 * (main, 2026-09-30) and every byte layout was cross-checked against the
 * metadata-generated Dart codecs in Quantus-Network/quantus-apps
 * (quantus_sdk/lib/generated/bell/...) plus referendum #0's real on-chain
 * submit arguments (block 95606, indexer snapshot).
 *
 * Key verified byte facts:
 *  - OriginCaller has exactly 2 variants, discriminated by PALLET INDEX:
 *      system = 0x00, Origins = 0x17 (23). RawOrigin: Root = 0x00.
 *      Custom Origin: FastUpgrade = 0x00.
 *    => Root proposal_origin = 0x0000, FastUpgrade = 0x1700.
 *  - BoundedCallOf: Lookup = 0x02, then hash[32], then len u32 LE.
 *  - DispatchTime: At = 0x00, After = 0x01, then BlockNumber u32 LE.
 *  - Preimage.note_preimage = pallet 7 call 0; TechReferenda = pallet 14
 *    (submit = 0, place_decision_deposit = 1, refund_decision_deposit = 2,
 *     refund_submission_deposit = 7); TechCollective = pallet 13 (vote = 4,
 *     add_member = 0 with MultiAddress::Id arg); System = pallet 0
 *    (remark = 0, authorize_upgrade = 9); TreasuryPallet = pallet 15
 *    (set_treasury_account = 0).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.QPS_CODEC = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var UNIT = 1000000000000n; // 1 QTC in plancks (runtime/src/lib.rs)

  /* ------------------------------------------------------------------ */
  /* Verified chain constants                                            */
  /* ------------------------------------------------------------------ */

  // runtime/src/governance/definitions.rs — TechCollectiveTracksInfo.
  // Block windows assume the 12s target block time
  // (TARGET_BLOCK_TIME_MS, runtime/src/lib.rs): MINUTES = 5 blocks.
  var TRACKS = [
    {
      id: 0, key: "tech_collective_members", label: "Tech Collective",
      originName: "Root", originBytes: "0000",
      blurb: "The deliberative lane: any Root-dispatched call — runtime upgrades, membership changes, treasury account updates, remarks.",
      prepare: 600, decision: 7200, confirm: 7200, minEnactment: 7200,
      approval: 61, support: 60, decisionDeposit: 100000000000n, maxDeciding: 1,
      whoVotes: "Tech-collective members (rank 0, flat) via TechCollective.vote"
    },
    {
      id: 1, key: "fast_upgrade", label: "Fast Upgrade",
      originName: "FastUpgrade", originBytes: "1700",
      blurb: "The emergency lane: 10-minute confirm and 10-minute enactment — but the origin is honored ONLY by system.authorize_upgrade. Never arbitrary Root calls.",
      prepare: 50, decision: 7200, confirm: 50, minEnactment: 50,
      approval: 80, support: 80, decisionDeposit: 100000000000n, maxDeciding: 1,
      whoVotes: "Tech-collective members (rank 0, flat) via TechCollective.vote"
    }
  ];

  var SUBMISSION_DEPOSIT = 100000000000n;      // scale_fee(UNIT) = 0.1 QTC (configs/mod.rs)
  var PREIMAGE_BASE = 10000000000n;            // scale_fee(UNIT/10) = 0.01 QTC
  var PREIMAGE_PER_BYTE = 10000000n;          // scale_fee(UNIT/10_000) = 0.00001 QTC
  var MAX_PROPOSAL = 4096;                    // MaxReferendaProposalSize: 4 KiB
  var CAPS = { maxActive: 128, maxPerAccount: 8, maxQueued: 100, undecidingTimeout: 324000 }; // 45d @12s
  var MIN_MEMBERS = 5, MAX_MEMBERS = 13;      // genesis_config_presets / configs
  var LENGTH_FEE_PER_BYTE = 100000n;          // length fee, runtime polynomial (see Fee & Throughput Lab)

  // Referendum #0 (fast_upgrade, block 95606) — real on-chain worked example.
  var REF0 = {
    noteBytes: "000978389c85e3698b7e24cf292907f2eec0657297fd8a4d82669cf357974f15ec56",
    preimageHash: "b3de57a77b5ccde4cd2c6ac001333b3ac7abc0c10924d892f57d3017adee7524",
    // Reconstructed submit call: 0e00 | 1700 | 02 | hash | 22000000 | 01 | 00000000
    submitHex: "0e00" + "1700" + "02" + "b3de57a77b5ccde4cd2c6ac001333b3ac7abc0c10924d892f57d3017adee7524" + "22000000" + "01" + "00000000"
  };

  /* ------------------------------------------------------------------ */
  /* Byte helpers                                                        */
  /* ------------------------------------------------------------------ */

  function hexToBytes(h) {
    h = String(h).replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) return null;
    var out = new Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(b) {
    var s = "";
    for (var i = 0; i < b.length; i++) s += ("0" + b[i].toString(16)).slice(-2);
    return s;
  }
  function u32le(n) {
    n = n >>> 0;
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }
  // SCALE compact encoding for u32-range values.
  function compactU32(n) {
    if (n < 64) return [n << 2];
    if (n < 16384) { var v = (n << 2) | 1; return [v & 0xff, (v >> 8) & 0xff]; }
    if (n < 1073741824) {
      var w = (n << 2) | 2;
      return [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >>> 24) & 0xff];
    }
    var bytes = [], x = n;
    while (x > 0) { bytes.push(x & 0xff); x = Math.floor(x / 256); }
    return [((bytes.length - 4) << 2) | 3].concat(bytes);
  }
  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(s));
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return out;
  }
  function qtc(plancks) {
    var neg = plancks < 0n;
    var v = neg ? -plancks : plancks;
    var whole = v / UNIT, frac = v % UNIT;
    var fs = frac.toString().padStart(12, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + whole.toString() + (fs ? "." + fs : "");
  }

  /* ------------------------------------------------------------------ */
  /* Proposal validation                                                 */
  /* ------------------------------------------------------------------ */

  var CALL_TABLE = {
    0:  { name: "System", calls: { 0: "remark", 9: "authorize_upgrade", 10: "authorize_upgrade_without_checks", 11: "apply_authorized_upgrade" } },
    7:  { name: "Preimage", calls: { 0: "note_preimage", 1: "unnote_preimage", 2: "request_preimage", 3: "unrequest_preimage" } },
    13: { name: "TechCollective", calls: { 0: "add_member", 4: "vote", 5: "cleanup_poll" } },
    14: { name: "TechReferenda", calls: { 0: "submit", 1: "place_decision_deposit", 2: "refund_decision_deposit", 7: "refund_submission_deposit", 8: "set_metadata" } },
    15: { name: "TreasuryPallet", calls: { 0: "set_treasury_account" } }
  };

  function inspectCall(hex) {
    var b = hexToBytes(hex);
    if (!b) return { ok: false, error: "Not valid hex." };
    if (b.length === 0) return { ok: false, error: "Empty call." };
    if (b.length > MAX_PROPOSAL)
      return { ok: false, error: "Proposal is " + b.length + " bytes — over the 4 KiB (4096 byte) on-chain cap." };
    if (b.length < 2) return { ok: false, error: "A call needs at least a pallet byte and a call byte." };
    var pallet = CALL_TABLE[b[0]], callName = null;
    if (pallet && pallet.calls[b[1]] !== undefined) callName = pallet.calls[b[1]];
    return {
      ok: true, bytes: b, length: b.length,
      palletIndex: b[0], callIndex: b[1],
      palletName: pallet ? pallet.name : "pallet " + b[0] + " (not in the studio's verified table)",
      callName: callName || ("call " + b[1]),
      known: !!callName
    };
  }

  /* ------------------------------------------------------------------ */
  /* Preimage economics                                                  */
  /* ------------------------------------------------------------------ */

  // definitions.rs preimage_amount: base + per_byte * (size + count).
  // For note_preimage the footprint is one entry, so count = 1.
  function preimageDeposit(callLen) {
    return PREIMAGE_BASE + PREIMAGE_PER_BYTE * BigInt(callLen + 1);
  }

  /* ------------------------------------------------------------------ */
  /* Extrinsic builders — return { hex, sections } where sections is an  */
  /* ordered list of { label, bytes } for the byte-anatomy view.        */
  /* ------------------------------------------------------------------ */

  function buildNotePreimage(callBytes) {
    var len = compactU32(callBytes.length);
    var bytes = [0x07, 0x00].concat(len, callBytes);
    return {
      hex: bytesToHex(bytes),
      sections: [
        { label: "Preimage.note_preimage — pallet 7, call 0", bytes: [0x07, 0x00] },
        { label: "compact(len) = " + callBytes.length + " bytes", bytes: len },
        { label: "proposal call bytes (" + callBytes.length + " B)", bytes: callBytes }
      ]
    };
  }
  function buildUnnotePreimage(hashBytes) {
    var bytes = [0x07, 0x01].concat(hashBytes);
    return {
      hex: bytesToHex(bytes),
      sections: [
        { label: "Preimage.unnote_preimage — pallet 7, call 1", bytes: [0x07, 0x01] },
        { label: "preimage hash (blake2b-256 of the call)", bytes: hashBytes }
      ]
    };
  }
  // enact = { kind: 'after'|'at', value: blockCount }
  function buildSubmit(trackId, hashBytes, callLen, enact) {
    var track = TRACKS[trackId];
    var originBytes = hexToBytes(track.originBytes);
    var disc = enact.kind === "at" ? 0x00 : 0x01;
    var bytes = [0x0e, 0x00]
      .concat(originBytes)
      .concat([0x02], hashBytes, u32le(callLen))
      .concat([disc], u32le(enact.value));
    return {
      hex: bytesToHex(bytes),
      sections: [
        { label: "TechReferenda.submit — pallet 14, call 0", bytes: [0x0e, 0x00] },
        { label: "proposal_origin: " + track.originName + " (OriginCaller variant " + (trackId === 0 ? "0x00 system" : "0x17 Origins") + ")", bytes: originBytes },
        { label: "proposal: Bounded::Lookup (0x02)", bytes: [0x02] },
        { label: "preimage hash (blake2b-256)", bytes: hashBytes },
        { label: "proposal length u32 LE = " + callLen, bytes: u32le(callLen) },
        { label: "enactment_moment: DispatchTime::" + (enact.kind === "at" ? "At" : "After") + " (0x" + disc.toString(16).padStart(2, "0") + ")", bytes: [disc] },
        { label: (enact.kind === "at" ? "block number" : "blocks after approval") + " u32 LE = " + enact.value, bytes: u32le(enact.value) }
      ]
    };
  }
  function buildPlaceDecisionDeposit(index) {
    var bytes = [0x0e, 0x01].concat(u32le(index));
    return {
      hex: bytesToHex(bytes),
      sections: [
        { label: "TechReferenda.place_decision_deposit — pallet 14, call 1", bytes: [0x0e, 0x01] },
        { label: "referendum index u32 LE = " + index, bytes: u32le(index) }
      ]
    };
  }
  function buildRefundSubmissionDeposit(index) {
    var bytes = [0x0e, 0x07].concat(u32le(index));
    return { hex: bytesToHex(bytes), sections: [
      { label: "TechReferenda.refund_submission_deposit — pallet 14, call 7", bytes: [0x0e, 0x07] },
      { label: "referendum index u32 LE = " + index, bytes: u32le(index) } ] };
  }
  function buildRefundDecisionDeposit(index) {
    var bytes = [0x0e, 0x02].concat(u32le(index));
    return { hex: bytesToHex(bytes), sections: [
      { label: "TechReferenda.refund_decision_deposit — pallet 14, call 2", bytes: [0x0e, 0x02] },
      { label: "referendum index u32 LE = " + index, bytes: u32le(index) } ] };
  }
  function buildCollectiveVote(poll, aye) {
    var bytes = [0x0d, 0x04].concat(u32le(poll), [aye ? 1 : 0]);
    return { hex: bytesToHex(bytes), sections: [
      { label: "TechCollective.vote — pallet 13, call 4", bytes: [0x0d, 0x04] },
      { label: "poll (referendum index) u32 LE = " + poll, bytes: u32le(poll) },
      { label: "aye bool = " + (aye ? "true (0x01)" : "false (0x00)"), bytes: [aye ? 1 : 0] } ] };
  }

  /* ---------------- proposal templates (the call bytes) --------------- */

  function tplAuthorizeUpgrade(hashBytes) {
    var bytes = [0x00, 0x09].concat(hashBytes);
    return { hex: bytesToHex(bytes), bytes: bytes, name: "System.authorize_upgrade",
             sections: [
               { label: "System.authorize_upgrade — pallet 0, call 9", bytes: [0x00, 0x09] },
               { label: "code_hash: H256 (blake2b-256 of the runtime wasm)", bytes: hashBytes }
             ] };
  }
  function tplRemark(text) {
    var tb = utf8(text);
    var bytes = [0x00, 0x00].concat(compactU32(tb.length), tb);
    return { hex: bytesToHex(bytes), bytes: bytes, name: "System.remark",
             sections: [
               { label: "System.remark — pallet 0, call 0", bytes: [0x00, 0x00] },
               { label: "compact(len) = " + tb.length, bytes: compactU32(tb.length) },
               { label: "utf-8 remark bytes", bytes: tb } ] };
  }
  function tplSetTreasuryAccount(pubkey32) {
    var bytes = [0x0f, 0x00].concat(pubkey32);
    return { hex: bytesToHex(bytes), bytes: bytes, name: "TreasuryPallet.set_treasury_account",
             sections: [
               { label: "TreasuryPallet.set_treasury_account — pallet 15, call 0", bytes: [0x0f, 0x00] },
               { label: "account: AccountId32 (32 raw bytes)", bytes: pubkey32 } ] };
  }
  function tplAddMember(pubkey32) {
    var bytes = [0x0d, 0x00, 0x00].concat(pubkey32);
    return { hex: bytesToHex(bytes), bytes: bytes, name: "TechCollective.add_member",
             sections: [
               { label: "TechCollective.add_member — pallet 13, call 0", bytes: [0x0d, 0x00] },
               { label: "who: MultiAddress::Id (0x00) + AccountId32", bytes: [0x00].concat(pubkey32) } ] };
  }

  /* ---------------- lifecycle model ------------------------------------ */

  function lifecycle(trackId) {
    var t = TRACKS[trackId];
    return [
      { n: 1, title: "Note the preimage", detail: "Preimage.note_preimage with the exact call bytes. Deposit: " + qtc(PREIMAGE_BASE) + " + " + qtc(PREIMAGE_PER_BYTE) + "/byte. The preimage MUST exist on-chain before submit (the chain rejects otherwise)." },
      { n: 2, title: "Submit", detail: "TechReferenda.submit as a signed collective member. Submission deposit: " + qtc(SUBMISSION_DEPOSIT) + " QTC (reserved, refundable after conclusion)." },
      { n: 3, title: "Place the decision deposit", detail: "TechReferenda.place_decision_deposit. Another " + qtc(t.decisionDeposit) + " QTC moves the referendum into the deciding queue. Prepare period: " + t.prepare + " blocks (~" + blocksToClock(t.prepare) + ")." },
      { n: 4, title: "Deciding", detail: "Members vote via TechCollective.vote. Needs ≥" + t.approval + "% approval and ≥" + t.support + "% support (flat curves — no decay). Confirm period: " + t.confirm + " blocks (~" + blocksToClock(t.confirm) + ")." },
      { n: 5, title: "Enactment", detail: "On approval the scheduler dispatches the proposal no earlier than " + t.minEnactment + " blocks (~" + blocksToClock(t.minEnactment) + ") after approval. Cancel/kill is Root-only; slashed deposits are burned." }
    ];
  }
  function blocksToClock(b) {
    var s = b * 12;
    if (s < 90) return s + "s";
    var m = Math.round(s / 60);
    if (m < 90) return m + "m";
    var h = Math.round(m / 60);
    if (h < 48) return h + "h";
    return Math.round(h / 24) + "d";
  }

  return {
    UNIT: UNIT, TRACKS: TRACKS, SUBMISSION_DEPOSIT: SUBMISSION_DEPOSIT,
    PREIMAGE_BASE: PREIMAGE_BASE, PREIMAGE_PER_BYTE: PREIMAGE_PER_BYTE,
    MAX_PROPOSAL: MAX_PROPOSAL, CAPS: CAPS,
    MIN_MEMBERS: MIN_MEMBERS, MAX_MEMBERS: MAX_MEMBERS,
    LENGTH_FEE_PER_BYTE: LENGTH_FEE_PER_BYTE, REF0: REF0,
    hexToBytes: hexToBytes, bytesToHex: bytesToHex, u32le: u32le,
    compactU32: compactU32, utf8: utf8, qtc: qtc, blocksToClock: blocksToClock,
    inspectCall: inspectCall, preimageDeposit: preimageDeposit,
    buildNotePreimage: buildNotePreimage, buildUnnotePreimage: buildUnnotePreimage,
    buildSubmit: buildSubmit, buildPlaceDecisionDeposit: buildPlaceDecisionDeposit,
    buildRefundSubmissionDeposit: buildRefundSubmissionDeposit,
    buildRefundDecisionDeposit: buildRefundDecisionDeposit,
    buildCollectiveVote: buildCollectiveVote,
    tplAuthorizeUpgrade: tplAuthorizeUpgrade, tplRemark: tplRemark,
    tplSetTreasuryAccount: tplSetTreasuryAccount, tplAddMember: tplAddMember,
    lifecycle: lifecycle
  };
}));
