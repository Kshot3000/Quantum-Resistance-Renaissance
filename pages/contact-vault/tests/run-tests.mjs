/* QTC Contact Vault — Node test harness. Run: node tests/run-tests.mjs
 * 1. SHA-256 sanity (FIPS 180-4 vector).
 * 2. ALL 1,171 upstream checkphrase vectors vs js/checkphrase-core.js (worker-thread fan-out).
 * 3. SS58 validation cases (valid / wrong prefix / bad checksum / bad char / empty / bad key length).
 * 4. Similarity math (Levenshtein, shared prefix/suffix, closest-contact).
 * 5. Export/import round-trip: plain JSON + WebCrypto AES-GCM encrypted backup,
 *    wrong-password and tamper rejection, short-password rejection.
 * 6. Lookalike mutation: single-char change, prefix/suffix preserved, checkphrase avalanches, deterministic.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = require(join(root, "js", "checkphrase-core.js"));
const WORDS = require(join(root, "js", "wordlist.js"));
const SS58 = require(join(root, "js", "ss58.js"));
globalThis.QSS58 = SS58; // exercise the browser-global path in vault-logic.js
const LOGIC = require(join(root, "js", "vault-logic.js"));

/* ---------- worker entry: validate one chunk of vectors ---------- */
if (!isMainThread) {
  const failures = [];
  for (const tc of workerData.cases) {
    let got;
    try { got = CHECK.addressToChecksum(tc.address, WORDS); }
    catch (e) { failures.push({ address: tc.address, error: String(e) }); continue; }
    if (JSON.stringify(got) !== JSON.stringify(tc.expected))
      failures.push({ address: tc.address, expected: tc.expected, got });
  }
  parentPort.postMessage({ count: workerData.cases.length, failures });
  setTimeout(() => process.exit(0), 250); // let the message flush before exiting
}

/* ---------- main thread ---------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : extra); }
}
function hex(u8) { return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join(""); }

/* 1. SHA-256 sanity */
const abc = new TextEncoder().encode("abc");
ok("sha256('abc')",
  hex(CHECK.sha256Bytes(abc)) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

/* 2. upstream vectors — all 1,171, 4 workers */
ok("wordlist length 2048", WORDS.length === 2048);
const vectors = JSON.parse(readFileSync(join(root, "tests", "vectors", "checksums.json"), "utf8"));
ok("vector file version", vectors.version === "1.0");
const cases = vectors.testCases;
ok("vector count 1171", cases.length === 1171);
const t0 = Date.now();
const NWORKERS = 4;
const chunks = [];
for (let i = 0; i < NWORKERS; i++)
  chunks.push(cases.slice(Math.floor((i * cases.length) / NWORKERS), Math.floor(((i + 1) * cases.length) / NWORKERS)));
const results = await Promise.all(chunks.map((c) => new Promise((res, rej) => {
  const w = new Worker(new URL(import.meta.url), { workerData: { cases: c } });
  w.on("message", res);
  w.on("error", rej);
  w.on("exit", (code) => { if (code !== 0) rej(new Error("worker exit " + code)); });
})));
let vecTotal = 0, vecFailures = [];
for (const r of results) { vecTotal += r.count; vecFailures = vecFailures.concat(r.failures); }
console.log(`checkphrase vectors: ${vecTotal - vecFailures.length}/${vecTotal} pass (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
for (const f of vecFailures.slice(0, 5))
  console.log("VECTOR FAIL:", f.address, "expected", JSON.stringify(f.expected), "got", JSON.stringify(f.got), f.error || "");
ok("all 1171 upstream vectors", vecFailures.length === 0 && vecTotal === 1171);

const KYLE = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
ok("Kyle addr checkphrase", CHECK.addressToChecksum(KYLE, WORDS).join("-") === "exit-until-obtain-enchant-toddler");
ok("poisoned address differs", JSON.stringify(
  CHECK.addressToChecksum("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", WORDS)) !== JSON.stringify(
  CHECK.addressToChecksum("1A1zP1eP5QGefi2DMPTfTL5SLmv7DixfNa", WORDS)));
ok("deterministic", JSON.stringify(CHECK.addressToChecksum(KYLE, WORDS)) === JSON.stringify(CHECK.addressToChecksum(KYLE, WORDS)));

/* 3. SS58 validation */
{
  const v = LOGIC.validateQuantusAddress(KYLE);
  ok("valid qz address", v.ok && v.kind === "ok" && v.keyHex.length === 64, JSON.stringify(v).slice(0, 120));
  ok("empty rejected", LOGIC.validateQuantusAddress("   ").kind === "empty");
  const badB58 = LOGIC.validateQuantusAddress("qz0" + KYLE.slice(2));
  ok("bad base58 char rejected", !badB58.ok && badB58.kind === "base58", badB58.message);
  const flipped = KYLE.slice(0, -1) + (KYLE.endsWith("u") ? "v" : "u");
  const badSum = LOGIC.validateQuantusAddress(flipped);
  ok("bad checksum rejected", !badSum.ok && badSum.kind === "checksum", badSum.message);
  // wrong network: valid checksum, prefix 0
  const other = SS58.ss58Encode(new Array(32).fill(7), 0);
  const wp = LOGIC.validateQuantusAddress(other);
  ok("wrong prefix rejected", !wp.ok && wp.kind === "prefix" && /not Quantus's 189/.test(wp.message), wp.message);
  // wrong key length: valid checksum, prefix 189, 20-byte payload
  const short = SS58.ss58Encode(new Array(20).fill(9), 189);
  const kl = LOGIC.validateQuantusAddress(short);
  ok("bad key length rejected", !kl.ok && kl.kind === "keylen", kl.message);
  // too short to decode at all
  const tiny = LOGIC.validateQuantusAddress("qz");
  ok("too-short rejected", !tiny.ok, tiny.message);
}

/* 4. similarity */
{
  ok("levenshtein kitten/sitting = 3", LOGIC.levenshtein("kitten", "sitting") === 3);
  ok("levenshtein empty", LOGIC.levenshtein("", "abc") === 3 && LOGIC.levenshtein("abc", "") === 3);
  ok("levenshtein identical = 0", LOGIC.levenshtein(KYLE, KYLE) === 0);
  ok("shared prefix", LOGIC.sharedPrefixLen("qzabcdef", "qzabcXef") === 5);
  ok("shared suffix", LOGIC.sharedSuffixLen("abcdefqz", "XXcdefqz") === 6);
  ok("no shared affix", LOGIC.sharedPrefixLen("abc", "xyz") === 0 && LOGIC.sharedSuffixLen("abc", "xyz") === 0);
  const contacts = [
    { label: "Far", address: "qzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    { label: "Near", address: KYLE },
  ];
  const probe = KYLE.slice(0, 10) + "ZZZZ" + KYLE.slice(14);
  const best = LOGIC.closestContact(probe, contacts);
  ok("closestContact picks nearest", best && best.contact.label === "Near", best && best.contact.label);
  ok("closestContact no contacts", LOGIC.closestContact(probe, []) === null);
}

/* 5. export / import */
{
  const contacts = [
    { label: "Kyle", address: KYLE, note: "builder", trusted: true,
      checkphrase: ["exit", "until", "obtain", "enchant", "toddler"], addedAt: "2026-09-30T00:00:00.000Z" },
  ];
  const payload = LOGIC.buildExportPayload(contacts);
  ok("export app tag", payload.app === "qtc-contact-vault" && payload.version === 1);
  ok("export strips extras", Object.keys(payload.contacts[0]).sort().join(",") ===
    "addedAt,address,checkphrase,label,note,trusted");
  const round = LOGIC.parseImportPayload(JSON.parse(JSON.stringify(payload)));
  ok("plain import ok", round.ok && round.contacts.length === 1 && round.errors.length === 0,
    JSON.stringify(round.errors));
  ok("import keeps label", round.contacts[0].label === "Kyle" && round.contacts[0].trusted === true);
  const badApp = LOGIC.parseImportPayload({ app: "nope", version: 1, contacts: [] });
  ok("bad app tag rejected", !badApp.ok);
  const withBad = LOGIC.parseImportPayload({ app: "qtc-contact-vault", version: 1,
    contacts: [{ label: "Good", address: KYLE }, { label: "Bad", address: "not-an-address" }, { label: "NoAddr" }] });
  ok("bad rows skipped with errors", withBad.ok && withBad.contacts.length === 1 && withBad.errors.length === 2,
    JSON.stringify(withBad.errors));
  // Import cap: a backup can only ever hold a vault's contacts (<= MAX_CONTACTS),
  // and the app derives a 40k-iteration PBKDF2 checkphrase per imported contact —
  // an oversized pasted backup must be capped here, with one truncation notice.
  const genAddr = (i) => SS58.ss58Encode(Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 255 : j)), 189);
  const mkBackup = (n) => ({ app: "qtc-contact-vault", version: 1,
    contacts: Array.from({ length: n }, (_, i) => ({ label: "C" + i, address: genAddr(i + 1) })) });
  const cappedImp = LOGIC.parseImportPayload(mkBackup(LOGIC.MAX_CONTACTS + 100));
  ok("import caps contacts at MAX_CONTACTS with one truncation notice",
    cappedImp.ok && cappedImp.contacts.length === LOGIC.MAX_CONTACTS &&
    cappedImp.contacts[LOGIC.MAX_CONTACTS - 1].label === "C" + (LOGIC.MAX_CONTACTS - 1) &&
    cappedImp.errors.length === 1 && /only the first/.test(cappedImp.errors[0]),
    JSON.stringify(cappedImp.errors).slice(0, 160) + " kept=" + cappedImp.contacts.length);
  const exactImp = LOGIC.parseImportPayload(mkBackup(LOGIC.MAX_CONTACTS));
  ok("import at exactly MAX_CONTACTS carries no truncation notice",
    exactImp.contacts.length === LOGIC.MAX_CONTACTS && exactImp.errors.length === 0,
    JSON.stringify(exactImp.errors));
}

/* 6. encrypted backup (WebCrypto) */
{
  const plain = JSON.stringify(LOGIC.buildExportPayload(
    [{ label: "Kyle", address: KYLE, note: "", trusted: false, checkphrase: null, addedAt: null }]));
  const pw = "correct horse battery staple";
  const armored = await LOGIC.encryptBackup(pw, plain);
  ok("armored app tag", armored.app === "qtc-contact-vault-enc" && armored.iterations === 200000);
  ok("salt/iv/data are base64", [armored.salt, armored.iv, armored.data].every((s) => /^[A-Za-z0-9+/=]+$/.test(s)));
  ok("salt != iv != data", new Set([armored.salt, armored.iv, armored.data]).size === 3);
  const back = await LOGIC.decryptBackup(pw, JSON.parse(JSON.stringify(armored)));
  ok("encrypted round-trip", back === plain);
  let wrongPw = false;
  try { await LOGIC.decryptBackup("wrong password here", armored); } catch (e) { wrongPw = /wrong password/i.test(e.message); }
  ok("wrong password rejected", wrongPw);
  const tampered = JSON.parse(JSON.stringify(armored));
  tampered.data = tampered.data.slice(0, -4) + "AAAA";
  let tamper = false;
  try { await LOGIC.decryptBackup(pw, tampered); } catch (e) { tamper = true; }
  ok("tampered ciphertext rejected", tamper);
  let shortPw = false;
  try { await LOGIC.encryptBackup("short", plain); } catch (e) { shortPw = /at least 8/.test(e.message); }
  ok("short password rejected", shortPw);
  // two encryptions of the same plaintext differ (random salt/iv)
  const armored2 = await LOGIC.encryptBackup(pw, plain);
  ok("randomized encryption", armored2.data !== armored.data && armored2.salt !== armored.salt);
}

/* 7. lookalike mutation */
{
  const m1 = LOGIC.mutateMiddleChar(KYLE);
  const m2 = LOGIC.mutateMiddleChar(KYLE);
  ok("mutation deterministic", m1.mutated === m2.mutated && m1.index === m2.index);
  ok("mutation single char", m1.mutated.length === KYLE.length &&
    m1.mutated.slice(0, m1.index) === KYLE.slice(0, m1.index) &&
    m1.mutated.slice(m1.index + 1) === KYLE.slice(m1.index + 1) &&
    m1.mutated[m1.index] !== KYLE[m1.index]);
  ok("mutation prefix/suffix preserved", m1.mutated.startsWith("qznY8n") && m1.mutated.endsWith("8kbau"));
  const wReal = CHECK.addressToChecksum(KYLE, WORDS);
  const wMut = CHECK.addressToChecksum(m1.mutated, WORDS);
  const diffN = wReal.filter((w, i) => w !== wMut[i]).length;
  ok("one-char avalanche (" + diffN + "/5 words differ)", diffN >= 4, wMut.join("-"));
}

/* 8. persisted-vault boundary (sanitizeVault) + import/export field hygiene */
{
  const ADDR2 = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7";
  const ISO = "2026-10-01T00:00:00.000Z";
  const PHRASE = ["exit", "until", "obtain", "enchant", "toddler"];
  const good = { id: "good1", label: "Kyle", address: KYLE, note: "builder",
                 trusted: true, addedAt: ISO, checkphrase: PHRASE };
  ok("sanitizeVault non-array -> []",
    Array.isArray(LOGIC.sanitizeVault(null)) && LOGIC.sanitizeVault({ a: 1 }).length === 0 &&
    LOGIC.sanitizeVault("x").length === 0);
  const poison = [
    null, 42, "x", [1, 2],
    { id: "numaddr", label: "Num Addr", address: 12345, addedAt: ISO, checkphrase: null },
    { id: "fakeaddr", label: "Fake Addr", address: "not-an-address", addedAt: ISO, checkphrase: null },
    { id: "wrongprefix", label: "Wrong Prefix", address: SS58.ss58Encode(new Array(32).fill(7), 0), addedAt: ISO, checkphrase: null },
    { id: "nolabel", address: KYLE, addedAt: ISO, checkphrase: null },
    { id: "numlabel", label: 42, address: KYLE, addedAt: ISO, checkphrase: null },
    good,
    { id: "good1", label: "Dupe Id", address: ADDR2, addedAt: ISO, checkphrase: null },
    { id: "dupeaddr", label: "Dupe Addr", address: KYLE, addedAt: ISO, checkphrase: null },
    { id: 'evil"><svg onload="x">', label: "Evil Id",
      address: "qzjpLEi51md3q9FpECBTxRuLQsP31N5NmT9CF3ovVXY2RVKWE", note: 42,
      trusted: "yes", addedAt: 12345, checkphrase: "exit-until" },
  ];
  const clean = LOGIC.sanitizeVault(poison);
  ok("sanitizeVault keeps only the survivable entries", clean.length === 3,
    JSON.stringify(clean.map((c) => c.label)));
  const keptGood = clean.find((c) => c.label === "Kyle");
  ok("sanitizeVault keeps the good entry intact",
    !!keptGood && keptGood.id === "good1" && keptGood.trusted === true &&
    keptGood.addedAt === ISO && JSON.stringify(keptGood.checkphrase) === JSON.stringify(PHRASE));
  const dupeId = clean.find((c) => c.label === "Dupe Id");
  ok("sanitizeVault reassigns a duplicated id instead of colliding",
    !!dupeId && dupeId.id !== "good1" && /^vault-sanitized-\d+$/.test(dupeId.id), dupeId && dupeId.id);
  const evil = clean.find((c) => c.label === "Evil Id");
  ok("sanitizeVault neutralizes an injection-shaped id",
    !!evil && /^[A-Za-z0-9_-]{1,64}$/.test(evil.id), evil && evil.id);
  ok("sanitizeVault field hygiene (note/trusted/addedAt/checkphrase)",
    !!evil && evil.note === "" && evil.trusted === false && evil.addedAt === null && evil.checkphrase === null,
    JSON.stringify(evil));
  ok("sanitizeVault checkphrase shape (4 words / object words -> null)",
    LOGIC.sanitizeVault([{ id: "a", label: "A", address: KYLE, checkphrase: ["a", "b", "c", "d"] }])[0].checkphrase === null &&
    LOGIC.sanitizeVault([{ id: "a", label: "A", address: KYLE, checkphrase: [{}, {}, {}, {}, {}] }])[0].checkphrase === null);
  ok("sanitizeVault caps the label at 80 and the vault at MAX_CONTACTS",
    LOGIC.sanitizeVault([{ id: "a", label: "L".repeat(200), address: KYLE }])[0].label.length === 80 &&
    LOGIC.sanitizeVault(Array.from({ length: 600 }, (_, i) => ({
      id: "c" + i, label: "C" + i,
      address: SS58.ss58Encode(Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 255 : j)), 189),
    }))).length === LOGIC.MAX_CONTACTS);
  // import-path hygiene: a poisoned addedAt / checkphrase must not lose the
  // contact or persist in a shape the renderers cannot read.
  const imp = LOGIC.parseImportPayload({ app: "qtc-contact-vault", version: 1, contacts: [
    { label: "Three", address: ADDR2, note: "n", trusted: true, addedAt: 12345, checkphrase: [{}, {}, {}, {}, {}] },
  ] });
  ok("import keeps the contact but nulls a numeric addedAt and object checkphrase",
    imp.ok && imp.contacts.length === 1 && imp.contacts[0].addedAt === null && imp.contacts[0].checkphrase === null,
    JSON.stringify(imp.contacts));
  const imp2 = LOGIC.parseImportPayload({ app: "qtc-contact-vault", version: 1, contacts: [
    { label: "Three", address: ADDR2, addedAt: ISO, checkphrase: PHRASE },
  ] });
  ok("import keeps a valid addedAt and checkphrase",
    imp2.contacts.length === 1 && imp2.contacts[0].addedAt === ISO &&
    JSON.stringify(imp2.contacts[0].checkphrase) === JSON.stringify(PHRASE));
  // export-path hygiene: cleanContacts drops non-objects and unshapeable fields.
  const exp = LOGIC.buildExportPayload([null, 42,
    { label: "Kyle", address: KYLE, note: "", trusted: false, checkphrase: "nope", addedAt: 12345 }]);
  ok("export drops non-object rows and unshapeable fields",
    exp.contacts.length === 1 && exp.contacts[0].checkphrase === null && exp.contacts[0].addedAt === null,
    JSON.stringify(exp.contacts));
}

/* 9. add-path creation gate (contactRoom): the Add form is a creation
 * path the load cap alone cannot protect — it must ask for room before
 * deriving/pushing, with exact fail-closed arithmetic. */
ok("contactRoom exact arithmetic",
  LOGIC.contactRoom(0) === 500 && LOGIC.contactRoom(499) === 1 &&
  LOGIC.contactRoom(500) === 0 && LOGIC.contactRoom(5000) === 0 &&
  LOGIC.contactRoom(499.9) === 1);
ok("contactRoom fail-closed on a bad count",
  LOGIC.contactRoom(NaN) === 0 && LOGIC.contactRoom("x") === 0 &&
  LOGIC.contactRoom(undefined) === 0 && LOGIC.contactRoom(-3) === 0);

/* 10. batch-verify scan window (batchTextWindow / parseBatchInput): the
 * handler verifies at most MAX_BATCH addresses, but it used to split the
 * WHOLE paste first — a 20,000,000-char / 400,000-line paste built all
 * 400,000 strings in ~1,231 ms in Node (probe qa-contactvault-batchscan)
 * to verify 200, and dropped lines were never disclosed. The core now
 * windows the raw text at MAX_BATCH_SCAN_CHARS with cut-back to the last
 * newline, caps the lines, and reports droppedLines + skippedChars. */
ok("batch caps exported (MAX_BATCH 200, MAX_BATCH_SCAN_CHARS 32768)",
  LOGIC.MAX_BATCH === 200 && LOGIC.MAX_BATCH_SCAN_CHARS === 32768);
ok("batchTextWindow small paste scans fully",
  (() => { const w = LOGIC.batchTextWindow(KYLE + "\n" + KYLE);
    return w.lines.length === 2 && w.skippedChars === 0 && w.scannedChars === w.totalChars; })());
ok("batchTextWindow at exactly the cap scans all, skips 0",
  (() => { const w = LOGIC.batchTextWindow("a".repeat(32768));
    return w.scannedChars === 32768 && w.skippedChars === 0; })());
ok("batchTextWindow at cap+1 with no newline scans empty, skips all (no partial line)",
  (() => { const w = LOGIC.batchTextWindow("a".repeat(32769));
    return w.scannedChars === 0 && w.skippedChars === 32769 && w.lines.length === 0; })());
ok("batchTextWindow fail-closed on non-strings",
  [null, undefined, 42, NaN, {}, []].every((v) => {
    const w = LOGIC.batchTextWindow(v);
    return w.lines.length === 0 && w.skippedChars === 0 && w.totalChars === 0;
  }));
ok("parseBatchInput small paste semantics unchanged (trim, blanks dropped)",
  (() => { const r = LOGIC.parseBatchInput(KYLE + "\n  " + KYLE + "  \n\nnot-an-address\n");
    return r.lines.length === 3 && r.lines[2] === "not-an-address" &&
      r.skippedChars === 0 && r.droppedLines === 0; })());
ok("parseBatchInput 300 in-window lines -> 200 kept, 100 dropped, 0 skipped",
  (() => { const r = LOGIC.parseBatchInput((KYLE + "\n").repeat(300));
    return r.lines.length === 200 && r.droppedLines === 100 && r.skippedChars === 0; })());
ok("parseBatchInput 200 max-length 128-char lines scan fully",
  (() => { const r = LOGIC.parseBatchInput(("x".repeat(128) + "\n").repeat(200));
    return r.skippedChars === 0 && r.lines.length === 200 && r.droppedLines === 0; })());
ok("parseBatchInput giant paste windows to 200 complete lines with the tail skipped",
  (() => { const r = LOGIC.parseBatchInput((KYLE + "\n").repeat(400000));
    return r.lines.length === 200 && r.skippedChars > 19000000 &&
      r.lines.every((l) => l === KYLE); })());
ok("parseBatchInput straddling line dropped whole, never truncated",
  (() => { const r = LOGIC.parseBatchInput((KYLE + "\n").repeat(655) + "z".repeat(100) + "\n" + KYLE);
    return r.lines.every((l) => l === KYLE) && r.skippedChars > 0; })());
ok("parseBatchInput single over-window line scans as empty, all chars skipped",
  (() => { const r = LOGIC.parseBatchInput("q".repeat(100000));
    return r.lines.length === 0 && r.skippedChars === 100000; })());
ok("parseBatchInput fail-closed on non-strings",
  [null, undefined, 42, NaN, {}, []].every((v) => {
    const r = LOGIC.parseBatchInput(v);
    return r.lines.length === 0 && r.skippedChars === 0 && r.droppedLines === 0;
  }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
