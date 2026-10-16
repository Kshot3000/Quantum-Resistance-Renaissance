// QTC Legacy Vault — Node unit tests (shamir.js + plan-logic.js).
// Run: node tests/run-tests.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SHAMIR = require(join(__dirname, "..", "js", "shamir.js"));
const LOGIC = require(join(__dirname, "..", "js", "plan-logic.js"));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); }
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
}
function throwsCode(name, fn, code) {
  try { fn(); ok(name, false, "did not throw"); }
  catch (e) { ok(name, e.code === code, "code=" + e.code); }
}
// deterministic RNG (xorshift32) for reproducible vectors
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return (s >>> 24) & 0xff;
  };
}
const hex = (b) => Buffer.from(b).toString("hex");

// ---------- GF(2^8) field axioms ----------
ok("gfMul identity", SHAMIR.gfMul(0xa5, 1) === 0xa5 && SHAMIR.gfMul(1, 0x3c) === 0x3c);
ok("gfMul zero", SHAMIR.gfMul(0xff, 0) === 0 && SHAMIR.gfMul(0, 0xff) === 0);
let comm = true, assoc = true, distr = true, invOk = true, divOk = true;
const r1 = seededRng(7);
for (let i = 0; i < 300; i++) {
  const a = r1(), b = r1(), c = r1();
  if (SHAMIR.gfMul(a, b) !== SHAMIR.gfMul(b, a)) comm = false;
  if (SHAMIR.gfMul(SHAMIR.gfMul(a, b), c) !== SHAMIR.gfMul(a, SHAMIR.gfMul(b, c))) assoc = false;
  if (SHAMIR.gfMul(a, b ^ c) !== (SHAMIR.gfMul(a, b) ^ SHAMIR.gfMul(a, c))) distr = false;
}
for (let a = 1; a < 256; a++) { // exhaustive inverses
  if (SHAMIR.gfMul(a, SHAMIR.gfInv(a)) !== 1) { invOk = false; break; }
  const b = ((a * 37) % 255) + 1;
  if (SHAMIR.gfDiv(SHAMIR.gfMul(a, b), b) !== a) { divOk = false; break; }
}
ok("gfMul commutativity (300 samples)", comm);
ok("gfMul associativity (300 samples)", assoc);
ok("gfMul distributivity (300 samples)", distr);
ok("gfInv exhaustive: a*inv(a)==1 for all 255", invOk);
ok("gfDiv inverts gfMul exhaustively", divOk);
throwsCode("gfInv(0) throws DIV_ZERO", () => SHAMIR.gfInv(0), "DIV_ZERO");
throwsCode("gfDiv by zero throws", () => SHAMIR.gfDiv(5, 0), "DIV_ZERO");
// AES-known multiplication spot checks: 0x57*0x13=0xfe, 0x57*0x83=0xc1 (FIPS-197 examples)
ok("gfMul matches FIPS-197 examples", SHAMIR.gfMul(0x57, 0x13) === 0xfe && SHAMIR.gfMul(0x57, 0x83) === 0xc1);

// ---------- split validation ----------
const sec = new Uint8Array([1, 2, 3]);
throwsCode("split t<2 rejected", () => SHAMIR.split(sec, 3, 1, seededRng(1)), "BAD_PARAMS");
throwsCode("split t>n rejected", () => SHAMIR.split(sec, 3, 4, seededRng(1)), "BAD_PARAMS");
throwsCode("split n<2 rejected", () => SHAMIR.split(sec, 1, 1, seededRng(1)), "BAD_PARAMS");
throwsCode("split empty secret rejected", () => SHAMIR.split(new Uint8Array(0), 3, 2, seededRng(1)), "BAD_SECRET");
throwsCode("split oversize secret rejected", () => SHAMIR.split(new Uint8Array(513), 3, 2, seededRng(1)), "BAD_SECRET");
throwsCode("splitText empty string rejected", () => SHAMIR.splitText("", 3, 2), "BAD_SECRET");
throwsCode("bad RNG output rejected", () => SHAMIR.split(sec, 3, 2, () => 999), "BAD_RNG");

// ---------- deterministic round-trips ----------
const combos = [[2, 2, 1], [3, 2, 16], [5, 3, 24], [4, 4, 64], [16, 16, 40], [6, 2, 300], [8, 5, 7]];
for (const [n, t, len] of combos) {
  const rng = seededRng(n * 1000 + t * 77 + len);
  const secret = new Uint8Array(len);
  for (let i = 0; i < len; i++) secret[i] = rng();
  const shares = SHAMIR.split(secret, n, t, rng);
  ok(`round-trip n=${n} t=${t} len=${len} (first t)`, hex(SHAMIR.combine(shares.slice(0, t))) === hex(secret));
  // shuffled subset of t shares
  const idx = [...Array(n).keys()];
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() / 256 * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const subset = idx.slice(0, t).map((i) => shares[i]);
  ok(`round-trip n=${n} t=${t} len=${len} (shuffled t)`, hex(SHAMIR.combine(subset)) === hex(secret));
  // format check
  ok(`share format n=${n} t=${t}`, shares.every((s) => new RegExp(`^LV1-${t}of${n}-#\\d+-[0-9a-f]+$`).test(s)));
}
// UTF-8 text round-trip incl. emoji + cyrillic
{
  const txt = "correct horse 🕯 battery staple — ключи";
  const shares = SHAMIR.splitText(txt, 4, 2, seededRng(99));
  ok("splitText/combineText UTF-8 round-trip", SHAMIR.combineText([shares[3], shares[0]]) === txt);
}

// ---------- independent Python vectors ----------
{
  const v = JSON.parse(readFileSync(join(__dirname, "vectors", "shamir-vectors.json"), "utf8"));
  ok("vectors file has 45 entries", v.count === 45 && v.vectors.length === 45);
  let allOk = true, badId = -1;
  for (const vec of v.vectors) {
    const rec = SHAMIR.combine(vec.shares.slice(0, vec.t));
    if (hex(rec) !== vec.secret_hex) { allOk = false; badId = vec.id; break; }
    // also recover from the LAST t shares (different subset)
    const rec2 = SHAMIR.combine(vec.shares.slice(-vec.t));
    if (hex(rec2) !== vec.secret_hex) { allOk = false; badId = vec.id; break; }
  }
  ok("all 45 Python vectors recover (first-t and last-t subsets)", allOk, "bad id=" + badId);
}

// ---------- too few / tampered / malformed ----------
{
  const rng = seededRng(4242);
  const secret = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
  const shares = SHAMIR.split(secret, 5, 3, rng);
  throwsCode("fewer than t shares rejected", () => SHAMIR.combine([shares[0], shares[2]]), "TOO_FEW");
  // same secret split twice -> different shares (fresh randomness per split)
  const shares2 = SHAMIR.split(secret, 5, 3, seededRng(777));
  ok("splits use fresh randomness", shares[0] !== shares2[0]);
  // ...and each split independently recovers
  ok("second split recovers too", hex(SHAMIR.combine(shares2.slice(0, 3))) === hex(secret));
  throwsCode("duplicate share index rejected", () => SHAMIR.combine([shares[0], shares[0], shares[1]]), "DUP_SHARE");
  throwsCode("malformed share rejected", () => SHAMIR.combine(["nope"]), "BAD_SHARE");
  throwsCode("wrong version rejected", () => SHAMIR.combine(["LV9-2of3-#1-aa"]), "BAD_SHARE");
  const other = SHAMIR.split(secret, 5, 4, seededRng(11));
  throwsCode("mixed t rejected", () => SHAMIR.combine([shares[0], shares[1], other[0]]), "MIXED_SHARES");
  // corrupt one hex char in share 1 -> recovery differs (or NOT_TEXT on text path)
  const s = shares[0];
  const pos = s.lastIndexOf("-") + 3;
  const bad = s.slice(0, pos) + (s[pos] === "a" ? "b" : "a") + s.slice(pos + 1);
  const recBad = SHAMIR.combine([bad, shares[1], shares[2]]);
  ok("corrupted share -> different recovery", hex(recBad) !== hex(secret));
  const p = SHAMIR.parseShare(shares[2]);
  ok("parseShare fields", p.t === 3 && p.n === 5 && p.index === 3 && p.bytes.length === 8);
  throwsCode("combine([]) rejected", () => SHAMIR.combine([]), "BAD_SHARE");
}

// ---------- plan-logic ----------
{
  const good = [
    { name: "Ada", relation: "spouse", sharePct: "60", contact: "555-0100", notes: "" },
    { name: "Bo", relation: "child", sharePct: "40", contact: "", notes: "via Ada" },
  ];
  const v = LOGIC.validateBeneficiaries(good);
  ok("beneficiaries valid", v.errors.length === 0 && v.totalPct === 100, JSON.stringify(v.errors));
  const over = LOGIC.validateBeneficiaries([...good, { name: "Cy", sharePct: "10", contact: "x" }]);
  ok("over-100% rejected", over.errors.some((e) => /over 100/.test(e)));
  const under = LOGIC.validateBeneficiaries([{ name: "Ada", sharePct: "60", contact: "x" }]);
  ok("under-100% warns", under.errors.length === 0 && under.warnings.some((w) => /unassigned/.test(w)));
  ok("empty beneficiaries error", LOGIC.validateBeneficiaries([]).errors.length > 0);
  ok("duplicate name rejected", LOGIC.validateBeneficiaries([{ name: "Ada", sharePct: "50", contact: "x" }, { name: "ada", sharePct: "50", contact: "y" }]).errors.some((e) => /duplicate/i.test(e)));
  ok("bad pct rejected", LOGIC.validateBeneficiaries([{ name: "Ada", sharePct: "abc", contact: "x" }]).errors.length > 0);
  const hv = LOGIC.validateHoldings([{ item: "Share #1", location: "", access: "" }]);
  ok("holding without location warns", hv.warnings.length === 2 && hv.errors.length === 0);
  ok("holding without item errors", LOGIC.validateHoldings([{ item: "", location: "safe", access: "key" }]).errors.length > 0);

  const full = LOGIC.readinessScore(LOGIC.CHECKLIST.map((c) => c.id));
  ok("readiness full = 100% Vault-grade", full.pct === 100 && full.band === "Vault-grade" && full.got === full.max);
  const none = LOGIC.readinessScore([]);
  ok("readiness empty = 0% Exposed", none.pct === 0 && none.band === "Exposed");
  const mid = LOGIC.readinessScore(["backup", "split", "tested"]); // 3+3+3=9 of 17
  ok("readiness partial math", mid.got === 9 && mid.max === 17 && mid.pct === 53 && mid.band === "Fragile", JSON.stringify(mid));

  const evil = {
    owner: 'Eve <script>alert(1)</script>',
    date: "2026-09-30",
    beneficiaries: [{ name: 'Mallory <img src=x onerror=alert(2)>', relation: "heir", sharePct: "100", contact: "<b>555</b>", notes: "" }],
    holdings: [{ item: 'Share #1 "quoted"', location: "safe <>&", access: "" }],
    deadman: "call <me>",
    extraNotes: "",
  };
  const letter = LOGIC.buildLetter(evil);
  ok("letter escapes script tags", !letter.includes("<script>") && letter.includes("&lt;script&gt;"));
  ok("letter escapes img handler", letter.includes("&lt;img"));
  ok("letter escapes quotes/amps", letter.includes("&quot;quoted&quot;") && letter.includes("&lt;&gt;&amp;"));
  ok("letter has dead-man section", letter.includes("dead-man arrangement") && letter.includes("call &lt;me&gt;"));
  const emptyLetter = LOGIC.buildLetter({});
  ok("empty plan letter shows placeholders", emptyLetter.includes("[Your full legal name]") && emptyLetter.includes("No beneficiaries recorded yet"));
  ok("esc() handles nulls", LOGIC.esc(null) === "" && LOGIC.esc(undefined) === "");
}

// ---------- untrusted-plan boundary (localStorage + imported JSON) ----------
{
  // validators and the letter builder must never throw on poisoned entries
  let threw = false;
  try {
    LOGIC.validateBeneficiaries([null, "x", 42, [], { name: 123, sharePct: {}, contact: [] }]);
    LOGIC.validateHoldings([null, "x", { item: 7, location: {}, access: null }]);
    LOGIC.buildLetter({ owner: 123, date: {}, deadman: [], extraNotes: 9, beneficiaries: [null, { sharePct: [] }], holdings: [null, { item: 5 }] });
    LOGIC.buildLetter(null);
    LOGIC.buildLetter("nope");
  } catch (e) { threw = true; }
  ok("validators + letter survive poisoned entries without throwing", !threw);
  ok("null beneficiary reports errors instead of crashing",
    LOGIC.validateBeneficiaries([null]).errors.length > 0);
  ok("numeric owner falls back to the letter placeholder",
    LOGIC.buildLetter({ owner: 123, beneficiaries: [], holdings: [] }).includes("[Your full legal name]"));

  // sanitizePlan: shape, typing, caps
  const clean = LOGIC.sanitizePlan({
    beneficiaries: [
      { name: "Ada", relation: "daughter", sharePct: 60, contact: "a@x", notes: "n" },
      null, "junk", [1],
      { name: 42, relation: {}, sharePct: "40", contact: [], notes: null },
    ],
    holdings: [{ item: "Share #1", location: "safe", access: "key" }, null, { item: 9 }],
    deadmanChoice: "lawyer", deadmanText: 123, checks: ["backup", "bogus", "backup", 7, "tested"],
    owner: "Kyle", extra: { nope: true },
  });
  ok("sanitizePlan drops non-object beneficiary entries", clean.beneficiaries.length === 2);
  ok("sanitizePlan keeps good fields verbatim",
    clean.beneficiaries[0].name === "Ada" && clean.beneficiaries[0].sharePct === "60" && clean.beneficiaries[0].contact === "a@x");
  ok("sanitizePlan blanks non-string fields",
    clean.beneficiaries[1].name === "" && clean.beneficiaries[1].contact === "" && clean.beneficiaries[1].sharePct === "40");
  ok("sanitizePlan drops non-object holdings and blanks numeric item",
    clean.holdings.length === 2 && clean.holdings[1].item === "");
  ok("sanitizePlan keeps only known checklist ids, deduped",
    JSON.stringify(clean.checks) === JSON.stringify(["backup", "tested"]));
  ok("sanitizePlan keeps every real CHECKLIST id",
    LOGIC.sanitizePlan({ checks: LOGIC.CHECKLIST.map((c) => c.id) }).checks.length === LOGIC.CHECKLIST.length);
  ok("sanitizePlan blanks non-string scalars",
    clean.deadmanText === "" && clean.extra === "" && clean.owner === "Kyle" && clean.deadmanChoice === "lawyer");
  ok("sanitizePlan(null) is the empty plan",
    JSON.stringify(LOGIC.sanitizePlan(null)) === JSON.stringify(LOGIC.sanitizePlan({})));
  ok("sanitizePlan caps beneficiary count",
    LOGIC.sanitizePlan({ beneficiaries: Array.from({ length: 500 }, () => ({ name: "x" })) }).beneficiaries.length === 100);
  // a sanitized plan always validates and letters without throwing
  let threw2 = false;
  try {
    LOGIC.validateBeneficiaries(clean.beneficiaries);
    LOGIC.validateHoldings(clean.holdings);
    LOGIC.buildLetter({ owner: clean.owner, beneficiaries: clean.beneficiaries, holdings: clean.holdings, deadman: clean.deadmanText, extraNotes: clean.extra });
  } catch (e) { threw2 = true; }
  ok("sanitized plan flows through validate + letter cleanly", !threw2);
}

{
  // sanitizePlan producer relations (round 2): sharePct is written only
  // from the form's <input type="number">, whose .value is "" or an HTML
  // float-grammar string; deadmanChoice only from the four radios.
  const pct = (v) => LOGIC.sanitizePlan({ beneficiaries: [{ name: "A", sharePct: v }] }).beneficiaries[0].sharePct;
  ok("relations: producer share strings survive verbatim",
    pct("60") === "60" && pct("33.5") === "33.5" && pct(".5") === ".5" && pct("5.") === "5." && pct("1e2") === "1e2" && pct("") === "");
  ok("relations: finite number share coerces to its float string", pct(60) === "60" && pct(0.5) === "0.5");
  ok("relations: non-float share strings fall to '' (unassigned)",
    ["abc", "1.2.3", " 50", "50%", "0x10", "+50", "1e", "-", "NaN", "Infinity", "1,5"].every((v) => pct(v) === ""));
  ok("relations: non-finite / non-scalar shares fall to ''",
    pct(NaN) === "" && pct(Infinity) === "" && pct({}) === "" && pct([]) === "" && pct(null) === "");
  const dm = (v) => LOGIC.sanitizePlan({ deadmanChoice: v }).deadmanChoice;
  ok("relations: the four radio dead-man choices survive",
    ["trusted", "lawyer", "checkin", "shares"].every((v) => dm(v) === v) && dm("") === "");
  ok("relations: non-radio dead-man choices fall to ''",
    ["bogus", "LAWYER", " trusted", 42, null, {}].every((v) => dm(v) === ""));
}

{
  // creation gates: sanitizePlan caps both lists at load, so the Add
  // buttons must refuse at the same cap instead of persisting a row the
  // next load silently trims. Exact arithmetic, fail-closed.
  ok("caps exported as 100", LOGIC.MAX_BENEFICIARIES === 100 && LOGIC.MAX_HOLDINGS === 100);
  ok("beneficiaryRoom arithmetic",
    LOGIC.beneficiaryRoom(0) === 100 && LOGIC.beneficiaryRoom(99) === 1 && LOGIC.beneficiaryRoom(100) === 0);
  ok("holdingRoom arithmetic",
    LOGIC.holdingRoom(0) === 100 && LOGIC.holdingRoom(99) === 1 && LOGIC.holdingRoom(100) === 0);
  ok("rooms never go negative", LOGIC.beneficiaryRoom(5000) === 0 && LOGIC.holdingRoom(5000) === 0);
  ok("rooms fail closed on a bad count",
    LOGIC.beneficiaryRoom(NaN) === 0 && LOGIC.beneficiaryRoom("x") === 0 && LOGIC.beneficiaryRoom(-3) === 0 &&
    LOGIC.holdingRoom(NaN) === 0 && LOGIC.holdingRoom(undefined) === 0 && LOGIC.holdingRoom(-3) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:\n" + failures.join("\n")); process.exit(1); }
