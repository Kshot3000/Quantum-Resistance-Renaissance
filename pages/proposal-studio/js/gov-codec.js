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

  /* Hex-input parse bound (white-hat track): hexToBytes used to strip,
   * regex-test and parseInt-loop the WHOLE string before any caller
   * checked a length, and its live callers parse on every keystroke —
   * the Preimage Desk's pd-hex handler and the composer's custom-call
   * path via inspectCall — while inspectCall and sanitizeDrafts bound
   * only the PARSED result (MAX_PROPOSAL checked after the parse). A
   * 20,000,000-char paste built a 10,000,000-byte array in ~905 ms in
   * Node per keystroke, only to be rejected as over the 4 KiB cap.
   * The largest legitimate input is a MAX_PROPOSAL-byte proposal,
   * measured with this codec's own helpers: 8,194 chars plain hex
   * (with 0x) and 12,289 chars byte-spaced. MAX_HEX_INPUT_CHARS =
   * 16,384 admits both with margin while refusing anything larger
   * unparsed. hexInputRoom is the pure fail-closed gate (a
   * non-integer, negative, or non-number count gets no room),
   * mirroring the fleet's Scale Lab / Multisig hex bounds. */
  var MAX_HEX_INPUT_CHARS = 16384;
  function hexInputRoom(chars) {
    if (!Number.isSafeInteger(chars) || chars < 0) return 0;
    return Math.max(0, MAX_HEX_INPUT_CHARS - chars);
  }
  function hexToBytes(h) {
    if (typeof h === "string" && h.length > MAX_HEX_INPUT_CHARS) return null;
    h = String(h).replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) return null;
    var out = new Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  /* Plain-text input bound (white-hat track): the two live text paths
   * — the Preimage Desk's pd-text handler and the composer's remark
   * template — encoded the WHOLE string with utf8() on every keystroke
   * before any length check: pdRender's 4 KiB cap is consulted only on
   * the ENCODED bytes, and the remark path consulted no cap at all (a
   * 20,000,000-char paste encoded in ~1.3 s in Node and tplRemark
   * built a 20,000,006-byte "call" from it in ~15 s). Every character
   * encodes to AT LEAST one UTF-8 byte (TextEncoder: 1–4 bytes per
   * code point, ≥1 per UTF-16 code unit; the fallback encoder below
   * likewise), so a text longer than MAX_PROPOSAL characters is
   * GUARANTEED to encode to more than MAX_PROPOSAL bytes — refusing
   * it on raw length before encoding can never refuse a text that
   * could have fit. Texts at or under the cap still encode (a
   * multibyte text can still exceed 4 KiB of bytes; pdRender's byte
   * check and the remark branch's built-call check cover that).
   * textInputRoom is the pure fail-closed gate, mirroring
   * hexInputRoom. */
  var MAX_TEXT_INPUT_CHARS = MAX_PROPOSAL;
  function textInputRoom(chars) {
    if (!Number.isSafeInteger(chars) || chars < 0) return 0;
    return Math.max(0, MAX_TEXT_INPUT_CHARS - chars);
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
    if (typeof hex === "string" && hex.length > MAX_HEX_INPUT_CHARS)
      return { ok: false, error: "Hex input too long (" + hex.length + " characters) — the cap is " + MAX_HEX_INPUT_CHARS + " characters; refused before parsing." };
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
  /* ---------------- draft vault sanitizer ----------------------------- */
  /* Drafts reach the vault from TWO untrusted sources — localStorage and
   * a user-imported JSON file — and the vault/pack renderers dereference
   * their fields directly (created.slice, checks[i], lifecycle(trackId),
   * hexToBytes(callHex) into the extrinsic builders). A single poisoned
   * entry therefore crashed the Vault tab, and because the import path
   * persisted what it parsed, one bad import crashed every later visit.
   * sanitizeDrafts is the single gate for both load paths:
   *  - plain-object entries only, at most MAX_DRAFTS kept;
   *  - the call must be valid hex of 2..MAX_PROPOSAL bytes (the chain's
   *    own proposal cap — the composer enforces it, the vault must too);
   *  - trackId must name a real track (lifecycle/buildSubmit index it);
   *  - RELATION: when hashOf (bytes -> blake2b-256 hex) is supplied, the
   *    stored hash must equal hashOf(callBytes) — a draft whose hash
   *    disagrees with its call can never be submitted (submit looks the
   *    preimage up by that hash), so the entry is dropped, not repaired;
   *  - ids are deduped (delete/load match on id), string fields are
   *    type-checked and capped, checks becomes exactly 5 booleans.
   * Relations round (2026-10-13): shape alone still admitted values the
   * only producer (dv-save, fed by the composer) could never write —
   *  - callName is a DERIVED field: the composer sets it from the built
   *    template / inspectCall(callHex), so a stored name that disagrees
   *    with the call painted (and loaded into the pack) a false label
   *    for the proposal. It is now always re-derived from the bytes.
   *  - the composer locks track 1 (fast_upgrade) to authorize_upgrade —
   *    the runtime honors the FastUpgrade origin for no other call — so
   *    a track-1 draft carrying any other call can never execute and
   *    is dropped, not repaired.
   *  - created is stamped new Date().toISOString() at save time, so a
   *    stamp before the chain's Sept-2026 launch or in the future is
   *    not a save time; it becomes "" (rendered "date unknown").      */
  var MAX_DRAFTS = 100;
  var CREATED_FLOOR_MS = Date.UTC(2026, 8, 1); // chain launch era (Sept 2026)
  function sanitizeDrafts(raw, hashOf) {
    if (!Array.isArray(raw)) return [];
    var out = [], seenIds = {};
    for (var i = 0; i < raw.length && out.length < MAX_DRAFTS; i++) {
      var x = raw[i];
      if (!x || typeof x !== "object" || Array.isArray(x)) continue;
      if (!Number.isInteger(x.trackId) || x.trackId < 0 || x.trackId >= TRACKS.length) continue;
      if (typeof x.callHex !== "string") continue;
      var bytes = hexToBytes(x.callHex);
      if (!bytes || bytes.length < 2 || bytes.length > MAX_PROPOSAL) continue;
      if (typeof x.hash !== "string") continue;
      var hash = x.hash.replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) continue;
      if (typeof hashOf === "function" && hashOf(bytes) !== hash) continue;
      var id = (typeof x.id === "string" && x.id.length >= 1 && x.id.length <= 64) ? x.id : null;
      if (!id || seenIds[id]) id = "draft-sanitized-" + out.length;
      if (seenIds[id]) continue;
      seenIds[id] = true;
      var insp = inspectCall(x.callHex);
      // Track relation: fast_upgrade (track 1) is honored ONLY by
      // System.authorize_upgrade (pallet 0, call 9) — see the composer
      // lock in app.js and the sources table. Any other call on track 1
      // is a draft that can never execute.
      if (x.trackId === 1 && !(insp.ok && insp.palletIndex === 0 && insp.callIndex === 9)) continue;
      // callName is derived from the call bytes, never stored truth.
      var callName = insp.ok ? insp.palletName + "." + insp.callName : "call";
      var name = (typeof x.name === "string" && x.name.trim()) ? x.name.slice(0, 120) : callName;
      var createdMs = typeof x.created === "string" ? Date.parse(x.created) : NaN;
      var created = (isFinite(createdMs) && createdMs >= CREATED_FLOOR_MS
        && createdMs <= Date.now() + 5 * 60 * 1000)
        ? x.created.slice(0, 40) : "";
      var checks = [];
      for (var k = 0; k < 5; k++) checks.push(Array.isArray(x.checks) ? x.checks[k] === true : false);
      var enactVal = (typeof x.enactVal === "number" && isFinite(x.enactVal)
        && Math.floor(x.enactVal) === x.enactVal && x.enactVal >= 0 && x.enactVal <= 4294967295)
        ? x.enactVal : 0;
      out.push({
        id: id, name: name,
        notes: typeof x.notes === "string" ? x.notes.slice(0, 2000) : "",
        trackId: x.trackId, callHex: bytesToHex(bytes), callName: callName,
        hash: hash, enactKind: x.enactKind === "at" ? "at" : "after",
        enactVal: enactVal, created: created, checks: checks
      });
    }
    return out;
  }

  /* Creation gate for the vault's two write paths (dv-save's unshift and
   * dv-import's concat): sanitizeDrafts enforces MAX_DRAFTS only at LOAD,
   * so an uncapped create persisted an over-cap list whose next load
   * silently evicted the tail — the oldest draft on save, and on import
   * every existing draft past the cap, while the toast claimed them all.
   * Writers ask draftRoom(currentCount) first and refuse / take only what
   * fits. Fail-closed: a non-finite or negative count reads as no room. */
  function draftRoom(currentCount) {
    var n = Math.floor(Number(currentCount));
    if (!isFinite(n) || n < 0) return 0;
    return Math.max(0, MAX_DRAFTS - n);
  }

  /* ---------------- file-pick size gate ------------------------------- */
  /* Both file inputs (the preimage desk's pd-file and the composer's
   * cmp-wasm) used to readAsArrayBuffer the WHOLE picked file and then
   * Array.from-convert it into a plain JS array of numbers before any
   * size check ran — pdRender's 4 KiB cap was consulted only after the
   * conversion, and the wasm path had no cap at all. Array.from on a
   * typed array is quadratic-class in practice (Node: 20 MB -> ~2.5 s
   * and +348 MB heap; 50 MB -> ~8.6 s and +900 MB), so a wrong pick
   * (a log, a disk image) froze or OOM-killed the tab. File.size is
   * known BEFORE a single byte is read, so the handlers ask this gate
   * first and refuse over-cap picks unread, naming the cap.
   * MAX_WASM_BYTES: real Substrate runtime blobs run ~1-5 MiB; 16 MiB
   * is generous headroom that still bounds the read + hash allocation.
   * Fail-closed: a non-number, NaN, negative or non-finite size (or a
   * bad cap) reads as no room — never coerce strings. */
  var MAX_WASM_BYTES = 16 * 1024 * 1024;
  function fileRoom(size, max) {
    if (typeof size !== "number" || typeof max !== "number") return false;
    if (!isFinite(size) || !isFinite(max) || size < 0 || max < 0) return false;
    return size <= max;
  }

  /* ---------------- draft-vault file gate ---------------------------- */
  /* The draft vault's dv-import handler used to readAsText the WHOLE
   * picked file and JSON.parse it before sanitizeDrafts was consulted —
   * yet that sanitizer caps everything it keeps: at most MAX_DRAFTS=100
   * drafts, each with id <= 64 chars, name sliced to 120, notes sliced
   * to 2,000, callHex = hex of a call of at most MAX_PROPOSAL bytes
   * (8,192 hex chars), a 64-char hash and bounded scalars. Measured
   * with this sanitizer: the largest vault the exporter can produce
   * serializes to 1,076,002 bytes with plain maxed fields and
   * 2,166,002 bytes when every free-text char needs JSON's worst
   * 6-byte \uXXXX escaping — so any larger file was guaranteed to be
   * sanitized away only after its full text and parse tree were
   * allocated. File.size is known before a byte is read, so the
   * importer asks this gate first — cap MAX_DRAFT_FILE_BYTES = 4 MiB,
   * ~1.9x the worst-escaping largest vault — and refuses over-cap
   * picks unread with the size and cap named, the current vault
   * untouched; a sizeless file refuses fail-closed too. */
  var MAX_DRAFT_FILE_BYTES = 4 * 1024 * 1024;
  function draftFileRoom(size) { return fileRoom(size, MAX_DRAFT_FILE_BYTES); }

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
    MAX_HEX_INPUT_CHARS: MAX_HEX_INPUT_CHARS, hexInputRoom: hexInputRoom,
    MAX_TEXT_INPUT_CHARS: MAX_TEXT_INPUT_CHARS, textInputRoom: textInputRoom,
    compactU32: compactU32, utf8: utf8, qtc: qtc, blocksToClock: blocksToClock,
    inspectCall: inspectCall, preimageDeposit: preimageDeposit,
    buildNotePreimage: buildNotePreimage, buildUnnotePreimage: buildUnnotePreimage,
    buildSubmit: buildSubmit, buildPlaceDecisionDeposit: buildPlaceDecisionDeposit,
    buildRefundSubmissionDeposit: buildRefundSubmissionDeposit,
    buildRefundDecisionDeposit: buildRefundDecisionDeposit,
    buildCollectiveVote: buildCollectiveVote,
    tplAuthorizeUpgrade: tplAuthorizeUpgrade, tplRemark: tplRemark,
    tplSetTreasuryAccount: tplSetTreasuryAccount, tplAddMember: tplAddMember,
    lifecycle: lifecycle, sanitizeDrafts: sanitizeDrafts, MAX_DRAFTS: MAX_DRAFTS,
    draftRoom: draftRoom, MAX_WASM_BYTES: MAX_WASM_BYTES, fileRoom: fileRoom,
    MAX_DRAFT_FILE_BYTES: MAX_DRAFT_FILE_BYTES, draftFileRoom: draftFileRoom
  };
}));
