/* QTC CLI Forge — node test suite.
 * Anchored to verified sources:
 *  - Flag map read field-by-field from Quantus-Network/quantus-cli @ 531a932
 *    (cloned 2026-10-01). Every command id below mirrors a real clap command.
 *  - QTC = 12 decimals; SS58 prefix 189 (chain-verified).
 *  - Test address: Kyle's QTC donation address from the hub footer (real SS58-189).
 */
global.window = {};
require("../js/ss58.js");
const F = require("../js/app.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function eq(name, got, want) {
  t(name, got === want, "got " + JSON.stringify(String(got)) + " want " + JSON.stringify(String(want)));
}

const GOOD = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
const BAD = GOOD.slice(0, -1) + (GOOD.slice(-1) === "u" ? "v" : "u");

/* ---- catalog integrity ---- */
eq("catalog problems empty", JSON.stringify(F.catalogProblems()), "[]");
t("command count sane", F.COMMANDS.length >= 55, F.COMMANDS.length);
t("every command has kebab cmd path", F.COMMANDS.every(c => /^[a-z0-9-]+( [a-z0-9-]+)*$/.test(c.cmd)), "");
t("every command has risk+src", F.COMMANDS.every(c => c.risk && c.src), "");
t("every group has commands", F.GROUPS.every(g => F.commandsInGroup(g.id).length > 0), "");
t("search finds multisig", F.searchCommands("multisig").length >= 10, "");
t("search empty returns all", F.searchCommands("").length === F.COMMANDS.length, "");

/* key commands exist with exact clap paths */
["wallet-create", "send", "signing-qr", "batch-send", "reversible-schedule",
 "hs-set", "ms-create", "ms-propose-transfer", "tr-submit", "preimage-create",
 "vesting-claim", "storage-get", "block-analyze", "events", "transfers-query",
 "wh-prove", "near-send", "airdrop-claim", "runtime-update", "call",
 "update-check", "exercise", "scheduler-agenda", "ms-predict"
].forEach(id => t("command exists: " + id, !!F.findCommand(id), ""));

eq("send clap path", F.findCommand("send").cmd, "send");
eq("reversible clap path", F.findCommand("reversible-schedule-delay").cmd, "reversible schedule-transfer-with-delay");
eq("hs-set clap path", F.findCommand("hs-set").cmd, "high-security set");

/* ---- amount math ---- */
eq("plancks 1.5", F.parseQtcToPlancks("1.5"), 1500000000000n);
eq("plancks dust", F.parseQtcToPlancks("0.000000000001"), 1n);
eq("plancks 13 decimals -> null", F.parseQtcToPlancks("1.0000000000001"), null);
eq("plancks zero -> null", F.parseQtcToPlancks("0"), null);
eq("plancks garbage -> null", F.parseQtcToPlancks("abc"), null);
eq("plancks negative -> null", F.parseQtcToPlancks("-1"), null);
eq("plancks empty -> null", F.parseQtcToPlancks(""), null);
eq("roundtrip 2.25", F.plancksToQtcString(2250000000000n), "2.25");
eq("roundtrip whole", F.plancksToQtcString(1000000000000n), "1");
t("valid amount", F.isValidQtcAmount("10.5"), "");
t("invalid amount", !F.isValidQtcAmount("1.2345678901234"), "");

/* ---- uint / hex validators ---- */
t("u32 ok", F.isValidUint("4294967295", 32), "");
t("u32 overflow", !F.isValidUint("4294967296", 32), "");
t("u128 big ok", F.isValidUint("340282366920938463463374607431768211455", 128), "");
t("uint negative", !F.isValidUint("-1", 32), "");
t("hex ok", F.isValidHex("0xdeadBEEF"), "");
t("hex odd -> bad", !F.isValidHex("0xabc"), "");
t("hex 32 bytes ok", F.isValidHex("ab".repeat(32), 32), "");
t("hex 32 bytes wrong len", !F.isValidHex("ab".repeat(31), 32), "");

/* ---- address classification (real SS58 codec) ---- */
let c1 = F.classifyAddressOrName(GOOD);
t("donation address validates as SS58-189", c1.ok && c1.kind === "address", JSON.stringify(c1));
let c2 = F.classifyAddressOrName(BAD);
t("corrupted address rejected", !c2.ok, JSON.stringify(c2));
let c3 = F.classifyAddressOrName("main");
t("wallet name accepted", c3.ok && c3.kind === "wallet-name", JSON.stringify(c3));
let c4 = F.classifyAddressOrName("not a valid name!!");
t("garbage rejected", !c4.ok, JSON.stringify(c4));
let c5 = F.classifyAddressOrName("");
t("empty rejected", !c5.ok, "");

/* ---- serializer ---- */
function build(id, values, globals) {
  return F.buildCommand(F.findCommand(id), values, globals);
}

let r = build("send", { to: GOOD, amount: "1.5", from: "main" });
eq("send problems", r.problems.length, 0);
eq("send exact", r.cmd, "quantus send --to " + GOOD + " --amount 1.5 --from main");
eq("send plancks", r.plancks.amount, "1500000000000");

r = build("send", { to: GOOD, amount: "1.5" });
t("send missing --from flagged", r.problems.some(p => p.field === "from"), JSON.stringify(r.problems));

r = build("send", { to: "bogus!!", amount: "1.5", from: "main" });
t("send bad address flagged", r.problems.some(p => p.field === "to"), JSON.stringify(r.problems));

r = build("wallet-create", { name: "main", scheme: "ml-dsa-65" });
eq("wallet-create exact", r.cmd, "quantus wallet create --name main --scheme ml-dsa-65");

r = build("wallet-create", { name: "main", scheme: "ml-dsa-99" });
t("bad enum flagged", r.problems.some(p => p.field === "scheme"), "");

r = build("update-check", { check: true });
eq("bool bare flag", r.cmd, "quantus update --check");

r = build("preimage-create", { "wasm-file": "/tmp/my runtime.wasm", from: "alice" });
eq("path with space quoted", r.cmd, "quantus preimage create --wasm-file '/tmp/my runtime.wasm' --from alice");

r = build("hs-set", { interceptor: GOOD, "delay-blocks": "100", "delay-seconds": "60", from: "main" });
t("conflict flagged", r.problems.some(p => /mutually exclusive/.test(p.msg)), JSON.stringify(r.problems));

r = build("storage-get", { pallet: "System", name: "Account", "key-type": "accountid" });
t("requires flagged", r.problems.some(p => p.field === "key"), JSON.stringify(r.problems));

r = build("airdrop-pay", { from: "ops", only: "qza1,qza2", "dry-run": true });
t("repeatable emitted twice", (r.cmd.match(/--only/g) || []).length === 2, r.cmd);

r = build("transfers-hash", { address: GOOD, "prefix-len": "4" });
eq("positional bare", r.cmd, "quantus transfers hash-address " + GOOD + " --prefix-len 4");

r = build("balance", { address: GOOD }, { nodeUrl: "wss://rpc.quantus.network", verbose: true, waitForTx: true });
eq("globals", r.cmd, "quantus --verbose --node-url wss://rpc.quantus.network --wait-for-transaction balance --address " + GOOD);

r = build("balance", { address: GOOD }, { nodeUrl: "ws://127.0.0.1:9944" });
t("default node-url omitted", r.cmd.indexOf("--node-url") === -1, r.cmd);

r = build("signing-qr", { from: GOOD });
eq("signing-qr minimal", r.cmd, "quantus signing-qr --from " + GOOD);

r = build("ms-propose-custom", { address: GOOD, pallet: "Balances", call: "transfer_allow_death", args: '["x","1"]', expiry: "100", from: "alice" });
t("json arg valid", r.problems.length === 0, JSON.stringify(r.problems));
r = build("ms-propose-custom", { address: GOOD, pallet: "Balances", call: "x", args: "not json", expiry: "100", from: "alice" });
t("json arg invalid flagged", r.problems.some(p => p.field === "args"), "");

r = build("scheduler-agenda", { range: "80..100" });
eq("range exact", r.cmd, "quantus scheduler agenda --range 80..100");
r = build("scheduler-agenda", { range: "80-100" });
t("bad range flagged", r.problems.some(p => p.field === "range"), "");

r = build("tr-submit", { "preimage-hash": "0x" + "ab".repeat(32), track: "fast-upgrade", from: "alice" });
t("track enum emitted", r.cmd.indexOf("--track fast-upgrade") >= 0, r.cmd);

/* shell quoting edge cases */
eq("quote single-quote", F.shellQuote("o'clock"), "'o'\\''clock'");
eq("quote safe passthrough", F.shellQuote("abc-123_XYZ"), "abc-123_XYZ");
eq("quote empty", F.shellQuote(""), "''");

/* ---- batch file builder ---- */
let b = F.buildBatchFile([{ to: GOOD, amountQtc: "2.5" }, { to: "bob", amountQtc: "0.000000000001" }]);
eq("batch count", b.count, 2);
eq("batch problems", b.problems.length, 0);
let parsed = JSON.parse(b.json);
eq("batch plancks[0]", parsed[0].amount, "2500000000000");
eq("batch plancks[1]", parsed[1].amount, "1");
eq("batch to[1]", parsed[1].to, "bob");

b = F.buildBatchFile([{ to: "bogus!!", amountQtc: "1" }, { to: GOOD, amountQtc: "nope" }]);
eq("batch problems on bad rows", b.problems.length, 2);
eq("batch valid rows only", b.count, 0);

/* ---- recipes ---- */
t("recipes reference real commands (in catalogProblems)", F.catalogProblems().length === 0, "");
F.RECIPES.forEach(rec => {
  rec.steps.forEach((s, i) => {
    if (s.build) {
      const bb = F.buildCommand(F.findCommand(s.build), s.values || {}, { nodeUrl: "ws://127.0.0.1:9944" });
      t("recipe " + rec.id + " step " + i + " builds", bb.cmd.indexOf("quantus " + F.findCommand(s.build).cmd) === 0, bb.cmd);
    } else {
      t("recipe " + rec.id + " step " + i + " has raw cmd", typeof s.cmd === "string" && s.cmd.length > 0, "");
    }
  });
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
