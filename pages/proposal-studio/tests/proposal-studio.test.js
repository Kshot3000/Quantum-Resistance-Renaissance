/* QTC Proposal Studio — node test suite.
 * Every expectation is anchored to a verified source:
 *  - referendum #0's real indexer args (block 95606): note_preimage bytes,
 *    blake2b preimage hash, submit args (Origins>FastUpgrade, Lookup, After(0))
 *  - Quantus-Network/chain @ 482c5b9 (definitions.rs, configs/mod.rs,
 *    runtime/src/lib.rs, pallets/*)
 *  - Quantus-Network/quantus-apps metadata-generated Dart codecs
 *    (OriginCaller variants system=0x00/Origins=0x17, Bounded Lookup=0x02,
 *     DispatchTime At=0x00/After=0x01)
 */
const C = require("../js/gov-codec.js");
const CR = require("../js/vendor/scale-crypto.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function eq(name, got, want) {
  t(name, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}

// --- blake2b sanity: referendum #0's preimage hash is blake2b-256 of its bytes
const ref0bytes = CR.fromHex(C.REF0.noteBytes);
const h = CR.toHex(Array.from(CR.blake2b(new Uint8Array(ref0bytes), 32)));
eq("blake2b-256(#0 call bytes) = on-chain preimage hash", h, C.REF0.preimageHash);

// --- preimage economics: 34-byte call => 0.01 + 35*0.00001 = 0.01035 QTC
eq("preimage deposit 34B (plancks)", C.preimageDeposit(34).toString(), "10350000000");
eq("preimage deposit 34B (QTC)", C.qtc(C.preimageDeposit(34)), "0.01035");
eq("preimage deposit 4096B", C.qtc(C.preimageDeposit(4096)), "0.05097");
eq("submission deposit", C.qtc(C.SUBMISSION_DEPOSIT), "0.1");

// --- note_preimage encoding: 0700 ++ compact(34)=0x88 ++ bytes
const np = C.buildNotePreimage(ref0bytes);
eq("note_preimage hex", np.hex, "0700" + "88" + C.REF0.noteBytes);
eq("note_preimage sections", np.sections.length, 3);

// --- submit reconstruction: must equal the independently derived #0 bytes
const sub = C.buildSubmit(1, CR.fromHex(C.REF0.preimageHash), 34, { kind: "after", value: 0 });
eq("submit(#0) == reconstructed on-chain call", sub.hex, C.REF0.submitHex);
eq("submit origin bytes (FastUpgrade)", sub.hex.slice(4, 8), "1700");
eq("submit bounded discriminant (Lookup=0x02)", sub.hex.slice(8, 10), "02");
eq("submit enactment (After(0))", sub.hex.slice(-10), "01" + "00000000");

// --- Root origin encoding
const subRoot = C.buildSubmit(0, new Array(32).fill(0), 2, { kind: "at", value: 8000 });
eq("submit origin bytes (Root)", subRoot.hex.slice(4, 8), "0000");
eq("submit enactment At(8000)", subRoot.hex.slice(-10), "00" + "401f0000");

// --- place_decision_deposit / refunds / vote
eq("place_decision_deposit(0)", C.buildPlaceDecisionDeposit(0).hex, "0e01" + "00000000");
eq("place_decision_deposit(7)", C.buildPlaceDecisionDeposit(7).hex, "0e01" + "07000000");
eq("refund_submission_deposit(3)", C.buildRefundSubmissionDeposit(3).hex, "0e07" + "03000000");
eq("refund_decision_deposit(3)", C.buildRefundDecisionDeposit(3).hex, "0e02" + "03000000");
eq("collective vote aye", C.buildCollectiveVote(0, true).hex, "0d04" + "00000000" + "01");
eq("collective vote nay", C.buildCollectiveVote(12, false).hex, "0d04" + "0c000000" + "00");
eq("unnote_preimage", C.buildUnnotePreimage(CR.fromHex(C.REF0.preimageHash)).hex,
   "0701" + C.REF0.preimageHash);

// --- templates
eq("authorize_upgrade == #0 proposal bytes",
   C.tplAuthorizeUpgrade(CR.fromHex("78389c85e3698b7e24cf292907f2eec0657297fd8a4d82669cf357974f15ec56")).hex,
   C.REF0.noteBytes);
const rk = C.tplRemark("hello");
eq("remark('hello')", rk.hex, "0000" + "14" + "68656c6c6f"); // compact(5)=0x14
const zero32 = new Array(32).fill(0);
eq("set_treasury_account prefix", C.tplSetTreasuryAccount(zero32).hex.slice(0, 4), "0f00");
eq("set_treasury_account len", C.tplSetTreasuryAccount(zero32).hex.length, 68);
eq("add_member encoding", C.tplAddMember(zero32).hex, "0d00" + "00" + "00".repeat(32));

// --- compact edge cases (canonical SCALE)
eq("compact(0)", C.bytesToHex(C.compactU32(0)), "00");
eq("compact(63)", C.bytesToHex(C.compactU32(63)), "fc");
eq("compact(64)", C.bytesToHex(C.compactU32(64)), "0101");
eq("compact(16383)", C.bytesToHex(C.compactU32(16383)), "fdff");

// --- track constants (definitions.rs)
const t0 = C.TRACKS[0], t1 = C.TRACKS[1];
eq("track0 prepare blocks", t0.prepare, 600);
eq("track0 decision/confirm/minEnactment", [t0.decision, t0.confirm, t0.minEnactment].join(","), "7200,7200,7200");
eq("track0 curves", t0.approval + "/" + t0.support, "61/60");
eq("track1 prepare", t1.prepare, 50);
eq("track1 confirm/minEnactment", [t1.confirm, t1.minEnactment].join(","), "50,50");
eq("track1 curves", t1.approval + "/" + t1.support, "80/80");
eq("track1 origin bytes", t1.originBytes, "1700");
eq("both decision deposits 0.1 QTC", C.qtc(t0.decisionDeposit) + "/" + C.qtc(t1.decisionDeposit), "0.1/0.1");

// --- caps (configs/mod.rs)
eq("caps", [C.CAPS.maxActive, C.CAPS.maxPerAccount, C.CAPS.maxQueued, C.CAPS.undecidingTimeout].join(","), "128,8,100,324000");
eq("max proposal bytes", C.MAX_PROPOSAL, 4096);
eq("member bounds", C.MIN_MEMBERS + "/" + C.MAX_MEMBERS, "5/13");

// --- proposal inspection
const insp = C.inspectCall(C.REF0.noteBytes);
eq("inspect #0 ok", insp.ok, true);
eq("inspect #0 pallet/call", insp.palletName + "." + insp.callName, "System.authorize_upgrade");
t("inspect rejects >4KiB", !C.inspectCall("00".repeat(4097)).ok);
t("inspect accepts exactly 4KiB", C.inspectCall("00".repeat(4096)).ok);
t("inspect rejects bad hex", !C.inspectCall("zz").ok);
const insp2 = C.inspectCall("0500" + "00".repeat(10));
eq("inspect unknown pallet label", insp2.palletName, "pallet 5 (not in the studio's verified table)");
eq("inspect unknown call known=false", insp2.known, false);

// --- lifecycle model
const lc = C.lifecycle(1);
eq("lifecycle steps", lc.length, 5);
t("lifecycle mentions decision deposit", lc[2].detail.includes("0.1"));
t("lifecycle step1 mentions preimage-first rule", lc[0].detail.includes("MUST exist"));

// --- clock helper
eq("600 blocks ~ 2h", C.blocksToClock(600), "2h");
eq("50 blocks ~ 10m", C.blocksToClock(50), "10m");
eq("7200 blocks ~ 24h", C.blocksToClock(7200), "24h");

console.log(pass + "/" + (pass + fail) + " proposal-studio tests green");
process.exit(fail ? 1 : 0);
