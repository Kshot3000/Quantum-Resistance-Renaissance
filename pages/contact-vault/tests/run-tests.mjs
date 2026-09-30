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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
