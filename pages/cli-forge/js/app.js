/* QTC CLI Forge — the command builder for the real `quantus` CLI.
 *
 * Flag map verified field-by-field against Quantus-Network/quantus-cli
 * @ 531a932 (cloned 2026-10-01). Ground truth is always
 * `quantus <command> --help` — the CLI evolves; this forge is stamped
 * with the revision it was read from.
 *
 * Pure layer (catalog + validators + serializer) is node-testable and
 * exposed via module.exports. The DOM layer only runs in the browser.
 */
(function () {
"use strict";

var SOURCE = {
  repo: "https://github.com/Quantus-Network/quantus-cli",
  rev: "531a932",
  verified: "2026-10-01",
  binary: "quantus", // `cargo install quantus-cli` installs the `quantus` binary
};

var PLANCKS_PER_QTC = 1000000000000n; // 12 decimals, chain-verified

/* ------------------------------------------------------------------ */
/* Field kinds                                                         */
/* ------------------------------------------------------------------ */
// string: free text            address: SS58-189 (or wallet name, see below)
// amount:  QTC decimal string  uint: unsigned integer (bits given in u)
// hex:     hex with optional 0x path: filesystem path
// enum:    one of values       bool: bare flag
// csv:     comma-separated list repeat: repeatable --flag value
// json:    JSON text           range: "from..to"
// positional: bare positional arg (no --flag)

function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }

/* ---------------- amount math (exact, BigInt) ---------------- */
function parseQtcToPlancks(s) {
  s = trim(s).replace(/,/g, "");
  var m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(s);
  if (!m || /^0+$/.test(m[1]) && (!m[2] || /^0+$/.test(m[2]))) {
    if (!m) return null;
  }
  if (!m) return null;
  var whole = BigInt(m[1]);
  var frac = m[2] || "";
  while (frac.length < 12) frac += "0";
  var p = whole * PLANCKS_PER_QTC + BigInt(frac);
  return p > 0n ? p : null;
}

function plancksToQtcString(p) {
  p = BigInt(p);
  var w = p / PLANCKS_PER_QTC, f = p % PLANCKS_PER_QTC;
  if (f === 0n) return w.toString();
  var fs = f.toString();
  while (fs.length < 12) fs = "0" + fs;
  fs = fs.replace(/0+$/, "");
  return w.toString() + "." + fs;
}

/* ---------------- SS58-189 address validation ---------------- */
function ss58() {
  if (typeof window !== "undefined" && window.QTC_SS58) return window.QTC_SS58;
  return null;
}

// Returns {ok:true, kind:"address"} | {ok:true, kind:"wallet-name"} | {ok:false, why}
function classifyAddressOrName(raw) {
  var v = trim(raw);
  if (!v) return { ok: false, why: "empty" };
  if (/^qz/i.test(v)) {
    var c = ss58();
    if (!c || !c.ss58Decode) return { ok: true, kind: "address", note: "checksum check unavailable (codec not loaded)" };
    var dec = c.ss58Decode(v);
    if (dec && dec.ok && dec.prefix === 189 && dec.key && dec.key.length === 32)
      return { ok: true, kind: "address" };
    return { ok: false, why: (dec && dec.error) || "bad SS58-189 checksum or prefix" };
  }
  // The CLI resolves wallet names for most address fields (resolve_address).
  if (/^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/.test(v)) return { ok: true, kind: "wallet-name" };
  return { ok: false, why: "not a qz… address or a valid wallet name" };
}

function isValidQtcAmount(raw) {
  return parseQtcToPlancks(raw) !== null;
}

function isValidUint(raw, bits) {
  var v = trim(raw);
  if (!/^\d+$/.test(v)) return false;
  try {
    var n = BigInt(v);
    return n >= 0n && n < (1n << BigInt(bits));
  } catch (e) { return false; }
}

function isValidHex(raw, bytes) {
  var v = trim(raw).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(v) || v.length % 2 !== 0) return false;
  if (bytes && v.length !== bytes * 2) return false;
  return true;
}

/* Validate one field value. Returns null when OK, else an error string. */
function validateField(field, raw) {
  var v = trim(raw);
  if (field.kind === "bool") return null;
  if (!v) return field.req ? "required" : null;
  switch (field.kind) {
    case "address": {
      var c = classifyAddressOrName(v);
      return c.ok ? null : c.why;
    }
    case "address-strict": {
      if (!/^qz/i.test(v)) return "must be an SS58 qz… address (no wallet names here)";
      var c2 = classifyAddressOrName(v);
      return c2.ok && c2.kind === "address" ? null : (c2.why || "bad address");
    }
    case "amount":
      return isValidQtcAmount(v) ? null : "QTC amount like 10, 1.5, 0.000001 (≤12 decimals, > 0)";
    case "uint":
      return isValidUint(v, field.u || 32) ? null : ("unsigned integer, 0 – 2^" + (field.u || 32) + "−1");
    case "hex":
      return isValidHex(v, field.bytes) ? null : ("hex" + (field.bytes ? " (" + field.bytes + " bytes)" : ""));
    case "enum":
      return field.values.indexOf(v) >= 0 ? null : ("one of: " + field.values.join(", "));
    case "json":
      try { JSON.parse(v); return null; } catch (e) { return "must be valid JSON"; }
    case "range":
      return /^\d+\.\.\d+$/.test(v) ? null : 'range like "80..100"';
    case "path":
    case "string":
    case "csv":
    case "positional":
      return null;
    default:
      return null;
  }
}

/* ---------------- shell quoting ---------------- */
function shellQuote(s) {
  s = String(s);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/* ---------------- command serializer ---------------- */
// values: {fieldName: rawString, boolName: true/false}
// globals: {nodeUrl, verbose, finalizedTx, waitForTx, coldRequestOut, coldResponseIn, cameraIndex}
// Returns {cmd, problems:[{field, msg}], plancks:{field: planckString}}
function buildCommand(cmd, values, globals) {
  values = values || {};
  globals = globals || {};
  var problems = [];
  var plancks = {};
  var parts = [SOURCE.binary];

  // global flags first (clap: globals may appear anywhere; forge puts them up front)
  if (globals.verbose) parts.push("--verbose");
  var nu = trim(globals.nodeUrl || "");
  if (nu && nu !== "ws://127.0.0.1:9944") parts.push("--node-url", shellQuote(nu));
  if (globals.finalizedTx) parts.push("--finalized-tx");
  if (globals.waitForTx) parts.push("--wait-for-transaction");
  if (trim(globals.coldRequestOut || "")) parts.push("--cold-request-out", shellQuote(trim(globals.coldRequestOut)));
  if (trim(globals.coldResponseIn || "")) parts.push("--cold-response-in", shellQuote(trim(globals.coldResponseIn)));
  if (globals.cameraIndex !== undefined && String(globals.cameraIndex) !== "0" && trim(String(globals.cameraIndex)) !== "")
    parts.push("--camera-index", String(parseInt(globals.cameraIndex, 10)));

  var path = cmd.cmd.split(" ");
  for (var i = 0; i < path.length; i++) parts.push(path[i]);

  var seen = {};
  cmd.fields.forEach(function (f) {
    var raw = values[f.f];
    var v = trim(raw == null ? "" : raw);
    if (f.kind === "bool") {
      if (raw === true || v === "true" || v === "1") parts.push("--" + f.f);
      return;
    }
    if (f.kind === "repeat" || f.repeat) {
      var items = v.split(",").map(trim).filter(Boolean);
      items.forEach(function (it) { parts.push("--" + f.f, shellQuote(it)); });
      if (f.req && !items.length) problems.push({ field: f.f, msg: "required (repeatable)" });
      return;
    }
    if (!v) {
      if (f.req) problems.push({ field: f.f, msg: "required" });
      return;
    }
    var err = validateField(f, v);
    if (err) problems.push({ field: f.f, msg: err });
    if (f.kind === "amount") {
      var p = parseQtcToPlancks(v);
      if (p !== null) plancks[f.f] = p.toString();
    }
    if (f.kind === "positional") parts.push(shellQuote(v));
    else parts.push("--" + f.f, shellQuote(v));
    seen[f.f] = true;
  });

  // conflict pairs
  (cmd.conflicts || []).forEach(function (pair) {
    var a = trim(values[pair[0]] || ""), b = trim(values[pair[1]] || "");
    var aOn = cmdFieldIsBool(cmd, pair[0]) ? (a === "true" || values[pair[0]] === true) : !!a;
    var bOn = cmdFieldIsBool(cmd, pair[1]) ? (b === "true" || values[pair[1]] === true) : !!b;
    if (aOn && bOn) problems.push({ field: pair[0] + "/" + pair[1], msg: "mutually exclusive — pick one" });
  });
  // requires
  (cmd.requires || []).forEach(function (r) {
    var need = trim(values[r.need] || ""), have = trim(values[r.have] || "");
    if (need && !have) problems.push({ field: r.have, msg: "required when --" + r.need + " is set" });
  });

  return { cmd: parts.join(" "), problems: problems, plancks: plancks };
}

function cmdFieldIsBool(cmd, name) {
  for (var i = 0; i < cmd.fields.length; i++)
    if (cmd.fields[i].f === name) return cmd.fields[i].kind === "bool";
  return false;
}

function findCommand(id) {
  for (var i = 0; i < COMMANDS.length; i++) if (COMMANDS[i].id === id) return COMMANDS[i];
  return null;
}

function commandsInGroup(gid) {
  return COMMANDS.filter(function (c) { return c.group === gid; });
}

/* ---------------- groups ---------------- */
var GROUPS = [
  { id: "wallets",   name: "Wallets",            icon: "🔑", blurb: "Create, import, inspect, and delete quantum-safe wallets." },
  { id: "payments",  name: "Payments",           icon: "💸", blurb: "Send QTC, batch payouts, reversible transfers, high-security accounts." },
  { id: "multisig",  name: "Multisig",           icon: "🔐", blurb: "k-of-n shared custody on the custom multisig pallet." },
  { id: "govern",    name: "Governance",         icon: "🏛", blurb: "Tech collective, tech referenda, preimages, treasury." },
  { id: "vesting",   name: "Vesting",            icon: "⏳", blurb: "Vesting schedules: inspect, claim, create, retarget." },
  { id: "chaindata", name: "Chain data",         icon: "🔎", blurb: "Read-only: storage, blocks, events, transfers, scheduler." },
  { id: "wormhole",  name: "Wormhole privacy",   icon: "🕳", blurb: "Private transfers: proofs, aggregation, exits, nullifiers." },
  { id: "near",      name: "NEAR bridge",        icon: "🌉", blurb: "ML-DSA-65 keys controlling NEAR accounts and Sputnik DAOs." },
  { id: "airdrop",   name: "Airdrop",            icon: "🪂", blurb: "Testnet reward claims and admin payouts." },
  { id: "runtime",   name: "Runtime & upgrades", icon: "⚙️", blurb: "Runtime upgrades and the generic any-pallet call." },
  { id: "maint",     name: "Maintenance",        icon: "🧰", blurb: "Version, updates, compatibility, dev wallets, exercise suite." },
];

var PW_NOTE = "Password entry: the CLI rejects --password on argv. Authenticate with the interactive prompt, --password-file (owner-only file), or the QUANTUS_WALLET_PASSWORD / QUANTUS_WALLET_PASSWORD_<NAME> environment variables (src/wallet/password.rs).";

/* risk: read | key | spend | govern | admin */
var COMMANDS = [

/* ============================ WALLETS ============================ */
{ id: "wallet-create", group: "wallets", cmd: "wallet create", title: "Create wallet",
  desc: "Generate a new quantum-safe wallet (ML-DSA-65 by default) with HD derivation. The mnemonic is shown once — write it down before it scrolls away.",
  risk: "key", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", req: true, help: "Wallet name (used as --from / --wallet elsewhere)." },
    { f: "scheme", kind: "enum", values: ["ml-dsa-65", "ml-dsa-87"], def: "ml-dsa-65", help: "Dilithium scheme. Default ml-dsa-65; ml-dsa-87 for the larger parameter set." },
    { f: "derivation-path", kind: "string", help: "HD path. Defaults: ML-DSA-65 → m/44'/189189'/0'/0'/1', ML-DSA-87 → m/44'/189189'/0'/0'/0'." },
    { f: "no-derivation", kind: "bool", help: "Disable HD derivation; use the master seed directly (like quantus-node --no-derivation)." },
    { f: "password-file", kind: "path", help: "Read the encryption password from an owner-only file (recommended for scripts)." },
    { f: "allow-empty-password", kind: "bool", danger: true, help: "Development only: encrypt with an empty password." },
  ],
  notes: [PW_NOTE, "Scheme default is ml-dsa-65 (DilithiumScheme::MlDsa65, src/wallet/keystore.rs)."] },

{ id: "wallet-view", group: "wallets", cmd: "wallet view", title: "View wallet",
  desc: "Show a wallet's address, scheme, and derivation info. No secrets are printed.",
  risk: "read", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", help: "Wallet name to view." },
    { f: "all", kind: "bool", help: "Show all wallets when --name is omitted." },
  ] },

{ id: "wallet-export", group: "wallets", cmd: "wallet export", title: "Export wallet",
  desc: "Export a wallet's mnemonic or private key. Writes to an owner-only file with --output instead of printing — prefer the file.",
  risk: "key", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", req: true, help: "Wallet name to export." },
    { f: "format", kind: "enum", values: ["mnemonic", "private-key"], def: "mnemonic", help: "Export format." },
    { f: "output", kind: "path", help: "Write the mnemonic to this file (created owner-only) instead of printing it." },
  ],
  notes: [PW_NOTE, "Anyone holding the export controls the funds. Never paste it into chat, logs, or a form."] },

{ id: "wallet-import", group: "wallets", cmd: "wallet import", title: "Import wallet (mnemonic)",
  desc: "Import a wallet from a mnemonic phrase. The phrase is read from a hidden prompt or --mnemonic-file — never on argv.",
  risk: "key", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", req: true, help: "Name for the imported wallet." },
    { f: "mnemonic-file", kind: "path", help: "Read the mnemonic from an owner-only file instead of the hidden prompt." },
    { f: "scheme", kind: "enum", values: ["ml-dsa-65", "ml-dsa-87"], def: "ml-dsa-65", help: "Scheme the mnemonic was generated for." },
    { f: "derivation-path", kind: "string", help: "Override the HD derivation path." },
    { f: "no-derivation", kind: "bool", help: "Use the master seed directly, no HD derivation." },
    { f: "password-file", kind: "path", help: "Read the encryption password from an owner-only file." },
    { f: "allow-empty-password", kind: "bool", danger: true, help: "Development only." },
  ],
  notes: [PW_NOTE] },

{ id: "wallet-import-cold", group: "wallets", cmd: "wallet import-cold", title: "Import cold wallet (watch-only)",
  desc: "Pair a Keystone device or the Quantus cold wallet app as watch-only: only the address is stored; spends are signed by scanning QR codes.",
  risk: "read", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", req: true, help: "Name for the watch-only wallet." },
    { f: "address", kind: "address-strict", help: "SS58 qz… address. Omit to scan the device's address QR with the camera." },
    { f: "camera-index", kind: "uint", u: 32, def: "0", help: "Camera device index for QR scanning." },
  ],
  notes: ["Combine with the global --cold-request-out / --cold-response-in flags and `signing-qr` for the full air-gapped flow."] },

{ id: "wallet-from-seed", group: "wallets", cmd: "wallet from-seed", title: "Create wallet from 32-byte seed",
  desc: "Create a wallet directly from a 32-byte seed. Advanced; prefer `wallet create` / `wallet import` for normal use.",
  risk: "key", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", req: true, help: "Wallet name." },
    { f: "scheme", kind: "enum", values: ["ml-dsa-65", "ml-dsa-87"], def: "ml-dsa-65", help: "Dilithium scheme." },
    { f: "password-file", kind: "path", help: "Read the encryption password from an owner-only file." },
    { f: "allow-empty-password", kind: "bool", danger: true, help: "Development only." },
  ],
  notes: [PW_NOTE, "The CLI reads the seed securely (not on argv)."] },

{ id: "wallet-list", group: "wallets", cmd: "wallet list", title: "List wallets",
  desc: "List all wallets in the local keystore.", risk: "read", src: "src/cli/wallet.rs", fields: [] },

{ id: "wallet-delete", group: "wallets", cmd: "wallet delete", title: "Delete wallet",
  desc: "Delete a wallet from the keystore. This only removes local key material — on-chain funds are unaffected, but without a backup the wallet is unrecoverable.",
  risk: "admin", src: "src/cli/wallet.rs",
  fields: [
    { f: "name", kind: "string", req: true, help: "Wallet name to delete." },
    { f: "force", kind: "bool", danger: true, help: "Skip the confirmation prompt." },
  ],
  notes: ["Export the mnemonic first (`wallet export --output`) unless you are certain you have a backup."] },

{ id: "wallet-nonce", group: "wallets", cmd: "wallet nonce", title: "Account nonce",
  desc: "Read an account's next transaction nonce (transaction count) from System::Account.",
  risk: "read", src: "src/cli/wallet.rs",
  fields: [
    { f: "address", kind: "address", help: "SS58 address to query. Optional — uses the wallet's address when omitted." },
    { f: "wallet", kind: "string", req: true, help: "Wallet name (used for the address when --address is omitted)." },
  ] },

{ id: "signing-qr", group: "wallets", cmd: "signing-qr", title: "Cold-signing QR",
  desc: "Print the QR a cold wallet scans to sign a call for an account, then stop. Builds a sample transfer (default 1.5 QTC to self) or signs arbitrary --call-data.",
  risk: "key", src: "src/cli/mod.rs",
  fields: [
    { f: "from", kind: "address", req: true, help: "Address (or wallet name) of the account that must sign." },
    { f: "to", kind: "address", help: "Recipient of the sample transfer (defaults to the signer itself)." },
    { f: "amount", kind: "amount", def: "1.5", help: "Amount for the sample transfer." },
    { f: "call-data", kind: "hex", help: "Hex-encoded call to sign instead of the sample transfer." },
    { f: "tip", kind: "amount", help: "Optional tip to prioritize the transaction." },
    { f: "nonce", kind: "uint", u: 32, help: "Manual nonce override (defaults to the account's next nonce on chain)." },
  ],
  notes: ["Pair with `wallet import-cold` and the global --cold-request-out / --cold-response-in flags for the full air-gapped round-trip."] },

/* ============================ PAYMENTS ============================ */
{ id: "send", group: "payments", cmd: "send", title: "Send QTC",
  desc: "Send QTC to an SS58 address. The CLI parses decimal amounts (\"10.5\") exactly and manages nonces automatically.",
  risk: "spend", src: "src/cli/send.rs + src/cli/mod.rs",
  fields: [
    { f: "to", kind: "address", req: true, help: "Recipient's SS58 qz… address." },
    { f: "amount", kind: "amount", req: true, help: "Amount in QTC, e.g. \"10\", \"10.5\", \"0.0001\"." },
    { f: "from", kind: "string", req: true, help: "Wallet name to send from." },
    { f: "tip", kind: "amount", help: "Optional tip to prioritize inclusion, e.g. \"0.5\"." },
    { f: "nonce", kind: "uint", u: 32, danger: true, help: "Manual nonce override — must be the exact next nonce; use with caution." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file (for scripting)." },
  ],
  notes: [PW_NOTE, "Global --wait-for-transaction waits for inclusion in a best block; --finalized-tx waits for finalization (slow on PoW — the CLI warns you)."] },

{ id: "balance", group: "payments", cmd: "balance", title: "Query balance",
  desc: "Query an account's QTC balance by SS58 address. Read-only.",
  risk: "read", src: "src/cli/mod.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "Account address (SS58 qz… format)." },
  ] },

{ id: "multisend", group: "payments", cmd: "multisend", title: "Multisend (random split)",
  desc: "Distribute a total amount across many recipients with randomized per-recipient amounts between --min and --max. Useful for testing.",
  risk: "spend", src: "src/cli/mod.rs",
  fields: [
    { f: "from", kind: "string", req: true, help: "Wallet name to send from." },
    { f: "addresses", kind: "csv", help: "Comma-separated recipient addresses (or use --addresses-file)." },
    { f: "addresses-file", kind: "path", help: "File with a JSON array of addresses (conflicts with --addresses)." },
    { f: "total", kind: "amount", req: true, help: "Total QTC distributed across all recipients." },
    { f: "min", kind: "amount", req: true, help: "Minimum QTC per recipient." },
    { f: "max", kind: "amount", req: true, help: "Maximum QTC per recipient." },
    { f: "tip", kind: "amount", help: "Optional tip per transaction." },
    { f: "yes", kind: "bool", help: "Skip the confirmation prompt (for scripting)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  conflicts: [["addresses", "addresses-file"]],
  notes: [PW_NOTE, "Randomization is for load-testing distribution, not privacy."] },

{ id: "batch-send", group: "payments", cmd: "batch send", title: "Batch send",
  desc: "Send to many recipients inside one atomic batch transaction (Utility::batch_all semantics via the CLI's batcher). Provide a batch file, or generate test transfers with --count.",
  risk: "spend", src: "src/cli/batch.rs",
  fields: [
    { f: "from", kind: "string", req: true, help: "Wallet name to send from." },
    { f: "batch-file", kind: "path", help: "JSON batch file: [{\"to\": \"address\", \"amount\": \"1000\"}, …] — amounts are raw planck integers. Build one in the Batch file builder below." },
    { f: "count", kind: "uint", u: 32, help: "Generate N identical test transfers (requires --to and --amount)." },
    { f: "to", kind: "address", help: "Recipient for generated transfers (required with --count)." },
    { f: "amount", kind: "amount", help: "Amount per generated transfer (required with --count)." },
    { f: "tip", kind: "amount", help: "Optional tip to prioritize the transaction." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "`batch config --limits` shows the connected chain's batch limits; `--info` shows recommendations."] },

{ id: "batch-config", group: "payments", cmd: "batch config", title: "Batch config & limits",
  desc: "Show the connected chain's batch transfer limits and the CLI's batching recommendations. Read-only.",
  risk: "read", src: "src/cli/batch.rs",
  fields: [
    { f: "limits", kind: "bool", help: "Show current batch transfer limits for the connected chain." },
    { f: "info", kind: "bool", help: "Show batch transfer configuration and recommendations." },
  ] },

{ id: "reversible-schedule", group: "payments", cmd: "reversible schedule-transfer", title: "Reversible transfer",
  desc: "Schedule a SafeSend transfer with the default delay: the recipient claims it after the delay, or you recover the funds if they never do.",
  risk: "spend", src: "src/cli/reversible.rs",
  fields: [
    { f: "to", kind: "address", req: true, help: "Recipient's SS58 address." },
    { f: "amount", kind: "amount", req: true, help: "Amount in QTC." },
    { f: "from", kind: "string", req: true, help: "Wallet name to send from." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Under the hood: ReversibleTransfers::schedule_transfer (pallet 11)."] },

{ id: "reversible-schedule-delay", group: "payments", cmd: "reversible schedule-transfer-with-delay", title: "Reversible transfer (custom delay)",
  desc: "Schedule a reversible transfer with an explicit delay, in seconds (default) or blocks with --unit-blocks.",
  risk: "spend", src: "src/cli/reversible.rs",
  fields: [
    { f: "to", kind: "address", req: true, help: "Recipient's SS58 address." },
    { f: "amount", kind: "amount", req: true, help: "Amount in QTC." },
    { f: "delay", kind: "uint", u: 64, req: true, help: "Delay in seconds, or blocks with --unit-blocks." },
    { f: "unit-blocks", kind: "bool", help: "Interpret --delay as blocks instead of seconds." },
    { f: "from", kind: "string", req: true, help: "Wallet name to send from." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "reversible-cancel", group: "payments", cmd: "reversible cancel", title: "Cancel reversible transfer",
  desc: "Cancel a pending reversible transfer by its transaction ID (hex hash) and recover the funds.",
  risk: "spend", src: "src/cli/reversible.rs",
  fields: [
    { f: "tx-id", kind: "hex", req: true, help: "Transaction ID to cancel (hex hash)." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "reversible-list", group: "payments", cmd: "reversible list-pending", title: "List pending reversible transfers",
  desc: "List all pending reversible transfers for an account — find the tx IDs you need for cancel/execute.",
  risk: "read", src: "src/cli/reversible.rs",
  fields: [
    { f: "address", kind: "address", help: "Account address to query (uses the wallet's address when omitted)." },
    { f: "from", kind: "string", help: "Wallet name (used for the address when --address is omitted)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ] },

{ id: "hs-status", group: "payments", cmd: "high-security status", title: "High-security status",
  desc: "Check whether an account has high-security (reversibility guard) enabled, and its interceptor/delay.",
  risk: "read", src: "src/cli/high_security.rs",
  fields: [
    { f: "account", kind: "address", req: true, help: "Account address (SS58) or wallet name." },
  ] },

{ id: "hs-set", group: "payments", cmd: "high-security set", title: "Enable high-security",
  desc: "Put an account under high-security: outgoing transfers go through a delay during which the interceptor (guardian) account can act. One of --delay-blocks / --delay-seconds.",
  risk: "spend", src: "src/cli/high_security.rs",
  fields: [
    { f: "interceptor", kind: "address", req: true, help: "Guardian/interceptor account (SS58 or wallet name)." },
    { f: "delay-blocks", kind: "uint", u: 32, help: "Delay in blocks (mutually exclusive with --delay-seconds)." },
    { f: "delay-seconds", kind: "uint", u: 64, help: "Delay in seconds (mutually exclusive with --delay-blocks)." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  conflicts: [["delay-blocks", "delay-seconds"]],
  notes: [PW_NOTE, "On-chain this routes through the high-security account settings (see the SafeSend Lab). Choose the interceptor carefully — it gains power over your outgoing transfers during the delay."] },

{ id: "hs-entrusted", group: "payments", cmd: "high-security entrusted", title: "Accounts you guard",
  desc: "Show all accounts for which this account acts as high-security guardian (interceptor).",
  risk: "read", src: "src/cli/high_security.rs",
  fields: [
    { f: "from", kind: "string", req: true, help: "Guardian account address (SS58) or wallet name." },
  ] },

/* ============================ MULTISIG ============================ */
{ id: "ms-predict", group: "multisig", cmd: "multisig predict-address", title: "Predict multisig address",
  desc: "Compute the multisig address deterministically before creating it: blake2b-256(pallet_id ‖ sorted signers ‖ threshold ‖ nonce). No signing, no fees.",
  risk: "read", src: "src/cli/multisig.rs",
  fields: [
    { f: "signers", kind: "csv", req: true, help: "Comma-separated signer addresses (SS58) or wallet names." },
    { f: "threshold", kind: "uint", u: 32, req: true, help: "Approvals required to execute." },
    { f: "nonce", kind: "uint", u: 64, def: "0", help: "Nonce for deterministic generation (lets you create several multisigs with the same signers)." },
  ],
  notes: ["Matches the pallet-19 address derivation cross-checked in the MultiSig Vault."] },

{ id: "ms-create", group: "multisig", cmd: "multisig create", title: "Create multisig",
  desc: "Create a new k-of-n multisig account on chain. Costs the 0.03 QTC creation burn plus per-signer proposal fees (see the MultiSig Vault for the exact fee math).",
  risk: "spend", src: "src/cli/multisig.rs",
  fields: [
    { f: "signers", kind: "csv", req: true, help: "Comma-separated signer addresses (SS58) or wallet names, e.g. \"alice,bob,charlie\"." },
    { f: "threshold", kind: "uint", u: 32, req: true, help: "Approvals required to execute transactions." },
    { f: "nonce", kind: "uint", u: 64, def: "0", help: "Nonce for deterministic address generation." },
    { f: "from", kind: "string", req: true, help: "Wallet name paying for creation (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Example from the CLI source: quantus multisig create --signers \"alice,bob,charlie\" --threshold 2 --from alice"] },

{ id: "ms-propose-transfer", group: "multisig", cmd: "multisig propose transfer", title: "Propose transfer",
  desc: "Propose a simple QTC transfer from the multisig. Other signers approve with `multisig approve`; anyone (a signer) executes once the threshold is reached.",
  risk: "spend", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address (SS58)." },
    { f: "to", kind: "address", req: true, help: "Recipient address (SS58) or wallet name." },
    { f: "amount", kind: "amount", req: true, help: "Amount in QTC (\"10\", \"10.5\", or raw base units)." },
    { f: "expiry", kind: "uint", u: 32, help: "Expiry block number. Omitted → defaults to head + ~2h." },
    { f: "from", kind: "string", req: true, help: "Proposer wallet name (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "ms-propose-custom", group: "multisig", cmd: "multisig propose custom", title: "Propose custom call",
  desc: "Propose an arbitrary pallet call from the multisig — full flexibility, with the call resolved against live chain metadata.",
  risk: "govern", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address (SS58)." },
    { f: "pallet", kind: "string", req: true, help: "Pallet name, e.g. \"Balances\"." },
    { f: "call", kind: "string", req: true, help: "Call name, e.g. \"transfer_allow_death\"." },
    { f: "args", kind: "json", help: "Arguments as a JSON array, e.g. '[\"5GrwvaEF…\", \"1000000000000\"]'." },
    { f: "expiry", kind: "uint", u: 32, req: true, help: "Expiry block number for this proposal." },
    { f: "from", kind: "string", req: true, help: "Proposer wallet name (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "The CLI type-checks the call against the connected node's metadata before proposing."] },

{ id: "ms-propose-hs", group: "multisig", cmd: "multisig propose high-security", title: "Propose high-security enable",
  desc: "Propose enabling high-security (reversibility guard) for the multisig, with a guardian interceptor and delay.",
  risk: "govern", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address (SS58)." },
    { f: "interceptor", kind: "address", req: true, help: "Guardian/interceptor account (SS58 or wallet name)." },
    { f: "delay-blocks", kind: "uint", u: 32, help: "Delay in blocks (mutually exclusive with --delay-seconds)." },
    { f: "delay-seconds", kind: "uint", u: 64, help: "Delay in seconds (mutually exclusive with --delay-blocks)." },
    { f: "expiry", kind: "uint", u: 32, req: true, help: "Expiry block number for this proposal." },
    { f: "from", kind: "string", req: true, help: "Proposer wallet name (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  conflicts: [["delay-blocks", "delay-seconds"]],
  notes: [PW_NOTE] },

{ id: "ms-approve", group: "multisig", cmd: "multisig approve", title: "Approve proposal",
  desc: "Approve a pending multisig proposal as one of the signers.", risk: "spend",
  src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
    { f: "proposal-id", kind: "uint", u: 32, req: true, help: "Proposal ID (u32 nonce)." },
    { f: "from", kind: "string", req: true, help: "Approver wallet name (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "ms-execute", group: "multisig", cmd: "multisig execute", title: "Execute proposal",
  desc: "Execute an approved proposal once it has reached the threshold. Any signer can trigger execution.",
  risk: "spend", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
    { f: "proposal-id", kind: "uint", u: 32, req: true, help: "Proposal ID (u32 nonce) to execute." },
    { f: "from", kind: "string", req: true, help: "Wallet name (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "ms-cancel", group: "multisig", cmd: "multisig cancel", title: "Cancel proposal",
  desc: "Cancel a proposed transaction. Only the proposer can cancel.", risk: "spend",
  src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
    { f: "proposal-id", kind: "uint", u: 32, req: true, help: "Proposal ID (u32 nonce) to cancel." },
    { f: "from", kind: "string", req: true, help: "Wallet name (must be the proposer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "ms-remove-expired", group: "multisig", cmd: "multisig remove-expired", title: "Remove expired proposal",
  desc: "Remove a proposal that has passed its expiry block, cleaning up chain state.",
  risk: "spend", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
    { f: "proposal-id", kind: "uint", u: 32, req: true, help: "Proposal ID (u32 nonce) to remove." },
    { f: "from", kind: "string", req: true, help: "Wallet name (must be a signer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "ms-claim-deposits", group: "multisig", cmd: "multisig claim-deposits", title: "Claim deposits",
  desc: "Claim all deposits from removable proposals in one batch operation.",
  risk: "spend", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
    { f: "from", kind: "string", req: true, help: "Wallet name (must be the proposer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "ms-info", group: "multisig", cmd: "multisig info", title: "Multisig info",
  desc: "Query multisig account info — signers, threshold — or a specific proposal with --proposal-id.",
  risk: "read", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
    { f: "proposal-id", kind: "uint", u: 32, help: "Query a specific proposal by ID instead of the account." },
  ] },

{ id: "ms-list-proposals", group: "multisig", cmd: "multisig list-proposals", title: "List proposals",
  desc: "List all proposals for a multisig account.", risk: "read", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
  ] },

{ id: "ms-hs-status", group: "multisig", cmd: "multisig high-security status", title: "Multisig high-security status",
  desc: "Check whether a multisig account has high-security enabled. Query only.",
  risk: "read", src: "src/cli/multisig.rs",
  fields: [
    { f: "address", kind: "address-strict", req: true, help: "The multisig account address." },
  ] },

/* ============================ GOVERNANCE ============================ */
{ id: "tc-add-member", group: "govern", cmd: "tech-collective add-member", title: "Add collective member",
  desc: "Add a member to the Tech Collective (ranked collective). Requires root or collective permissions.",
  risk: "govern", src: "src/cli/tech_collective.rs",
  fields: [
    { f: "who", kind: "address", req: true, help: "Address of the member to add." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (must have root or collective permissions)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "tc-remove-member", group: "govern", cmd: "tech-collective remove-member", title: "Remove collective member",
  desc: "Remove a member from the Tech Collective. Requires root permissions; --min-rank must be the member's rank or greater.",
  risk: "govern", src: "src/cli/tech_collective.rs",
  fields: [
    { f: "who", kind: "address", req: true, help: "Address of the member to remove." },
    { f: "min-rank", kind: "uint", u: 16, req: true, help: "Minimum rank required for removal (the member's rank or greater)." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (must have root permissions)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "tc-vote", group: "govern", cmd: "tech-collective vote", title: "Vote on tech referendum",
  desc: "Vote aye or nay on a tech referendum as a collective member.",
  risk: "govern", src: "src/cli/tech_collective.rs",
  fields: [
    { f: "referendum-index", kind: "uint", u: 32, req: true, help: "Referendum index to vote on." },
    { f: "vote", kind: "enum", values: ["aye", "nay"], req: true, help: "Vote choice." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (must be a collective member)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Tracks: tech_collective_members needs 61% support / 60% approval; fast_upgrade needs 80% / 80% (see the Governance Tracker)."] },

{ id: "tc-list-members", group: "govern", cmd: "tech-collective list-members", title: "List collective members",
  desc: "List all Tech Collective members. Read-only.", risk: "read", src: "src/cli/tech_collective.rs", fields: [] },

{ id: "tc-is-member", group: "govern", cmd: "tech-collective is-member", title: "Check membership",
  desc: "Check whether an address is a member of the Tech Collective.", risk: "read",
  src: "src/cli/tech_collective.rs",
  fields: [ { f: "address", kind: "address", req: true, help: "Address to check." } ] },

{ id: "tc-list-referenda", group: "govern", cmd: "tech-collective list-referenda", title: "List active tech referenda",
  desc: "List active Tech Referenda. Read-only.", risk: "read", src: "src/cli/tech_collective.rs", fields: [] },

{ id: "tc-get-referendum", group: "govern", cmd: "tech-collective get-referendum", title: "Get tech referendum",
  desc: "Get details of a specific Tech Referendum.", risk: "read", src: "src/cli/tech_collective.rs",
  fields: [ { f: "index", kind: "uint", u: 32, req: true, help: "Referendum index." } ] },

{ id: "tr-submit", group: "govern", cmd: "tech-referenda submit", title: "Submit runtime-upgrade referendum",
  desc: "Submit an authorize_upgrade proposal using a preimage already stored on chain. The proposer must be a Tech Collective member.",
  risk: "govern", src: "src/cli/tech_referenda.rs",
  fields: [
    { f: "preimage-hash", kind: "hex", req: true, help: "Hash of the on-chain preimage (hex, with or without 0x)." },
    { f: "track", kind: "enum", values: ["fast-upgrade", "root"], def: "fast-upgrade", help: "Governance track. fast-upgrade: Origins::FastUpgrade (80%/80%, ~30 min). root: system::Root (61%/60%, ~2 days)." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (must be a Tech Collective member)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Pairs with `preimage create` / `preimage note`, or use `tech-referenda submit-with-preimage` for the one-shot flow."] },

{ id: "tr-submit-preimage", group: "govern", cmd: "tech-referenda submit-with-preimage", title: "Submit upgrade (one-shot)",
  desc: "Hash a runtime WASM, note its authorize_upgrade preimage, and submit the referendum — the whole upgrade-proposal flow in one command.",
  risk: "govern", src: "src/cli/tech_referenda.rs",
  fields: [
    { f: "wasm-file", kind: "path", req: true, help: "Path to the compiled runtime WASM file to propose." },
    { f: "track", kind: "enum", values: ["fast-upgrade", "root"], def: "fast-upgrade", help: "Governance track." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (must be a Tech Collective member)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "The WASM is hashed locally; only the hash + preimage go on chain. This is how referendum #0-style upgrades are proposed."] },

{ id: "tr-list", group: "govern", cmd: "tech-referenda list", title: "List tech referenda",
  desc: "List all Tech Referenda proposals with their current status.", risk: "read",
  src: "src/cli/tech_referenda.rs", fields: [] },

{ id: "tr-get", group: "govern", cmd: "tech-referenda get", title: "Get referendum",
  desc: "Show full details of a Tech Referendum (raw on-chain data).", risk: "read",
  src: "src/cli/tech_referenda.rs",
  fields: [ { f: "index", kind: "uint", u: 32, req: true, help: "Referendum index (shown in list output)." } ] },

{ id: "tr-status", group: "govern", cmd: "tech-referenda status", title: "Referendum status",
  desc: "Check a referendum's phase, tally, timings, and enactment estimates.", risk: "read",
  src: "src/cli/tech_referenda.rs",
  fields: [ { f: "index", kind: "uint", u: 32, req: true, help: "Referendum index." } ] },

{ id: "tr-deposit", group: "govern", cmd: "tech-referenda place-decision-deposit", title: "Place decision deposit",
  desc: "Place the decision deposit to move a referendum from Preparing to Deciding. Required before voting can begin; anyone can place it, and it is refundable after the referendum ends.",
  risk: "spend", src: "src/cli/tech_referenda.rs",
  fields: [
    { f: "index", kind: "uint", u: 32, req: true, help: "Referendum index." },
    { f: "from", kind: "string", req: true, help: "Wallet name paying the deposit (anyone, not just the proposer)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "tr-refund-sub", group: "govern", cmd: "tech-referenda refund-submission-deposit", title: "Refund submission deposit",
  desc: "Refund the submission deposit after a referendum has completed (approved, rejected, or timed out).",
  risk: "spend", src: "src/cli/tech_referenda.rs",
  fields: [
    { f: "index", kind: "uint", u: 32, req: true, help: "Referendum index." },
    { f: "from", kind: "string", req: true, help: "Wallet name signing the refund." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "tr-refund-dec", group: "govern", cmd: "tech-referenda refund-decision-deposit", title: "Refund decision deposit",
  desc: "Refund the decision deposit after a referendum has completed.", risk: "spend",
  src: "src/cli/tech_referenda.rs",
  fields: [
    { f: "index", kind: "uint", u: 32, req: true, help: "Referendum index." },
    { f: "from", kind: "string", req: true, help: "Wallet name signing the refund." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "tr-config", group: "govern", cmd: "tech-referenda config", title: "Referenda config",
  desc: "Show the on-chain Tech Referenda configuration: tracks, periods, deposits.", risk: "read",
  src: "src/cli/tech_referenda.rs", fields: [] },

{ id: "preimage-status", group: "govern", cmd: "preimage status", title: "Preimage status",
  desc: "Check whether a preimage hash exists on chain and get its status (length / request count).",
  risk: "read", src: "src/cli/preimage.rs",
  fields: [ { f: "hash", kind: "hex", req: true, help: "Preimage hash (hex)." } ] },

{ id: "preimage-get", group: "govern", cmd: "preimage get", title: "Get preimage",
  desc: "Fetch preimage content by hash. The chain needs the length to retrieve it.",
  risk: "read", src: "src/cli/preimage.rs",
  fields: [
    { f: "hash", kind: "hex", req: true, help: "Preimage hash (hex)." },
    { f: "len", kind: "uint", u: 32, req: true, help: "Preimage length in bytes (required for retrieval)." },
  ] },

{ id: "preimage-list", group: "govern", cmd: "preimage list", title: "List preimages",
  desc: "List all preimages on chain.", risk: "read", src: "src/cli/preimage.rs", fields: [] },

{ id: "preimage-request", group: "govern", cmd: "preimage request", title: "Request preimage",
  desc: "Request a preimage (no deposit required) — signals that someone should note it.",
  risk: "spend", src: "src/cli/preimage.rs",
  fields: [
    { f: "hash", kind: "hex", req: true, help: "Preimage hash (hex)." },
    { f: "from", kind: "string", req: true, help: "Wallet used for the request." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "preimage-note", group: "govern", cmd: "preimage note", title: "Note preimage",
  desc: "Note a preimage on chain (requires a deposit, refundable on unnote). Takes the preimage content as hex.",
  risk: "spend", src: "src/cli/preimage.rs",
  fields: [
    { f: "content", kind: "hex", req: true, help: "Preimage content (hex)." },
    { f: "from", kind: "string", req: true, help: "Wallet used for the note." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "preimage-create", group: "govern", cmd: "preimage create", title: "Preimage from WASM",
  desc: "Create a System::authorize_upgrade preimage directly from a runtime WASM file — the first step of a manual upgrade proposal.",
  risk: "spend", src: "src/cli/preimage.rs",
  fields: [
    { f: "wasm-file", kind: "path", req: true, help: "WASM file path." },
    { f: "from", kind: "string", req: true, help: "Wallet used for the preimage." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "treasury-info", group: "govern", cmd: "treasury info", title: "Treasury info",
  desc: "Show the chain Treasury account and its balance. The treasury receives a portion of mining rewards.",
  risk: "read", src: "src/cli/treasury.rs", fields: [] },

/* ============================ VESTING ============================ */
{ id: "vesting-info", group: "vesting", cmd: "vesting info", title: "Vesting info",
  desc: "Show vesting pallet constants, launch status, and the next schedule id.", risk: "read",
  src: "src/cli/vesting.rs", fields: [] },

{ id: "vesting-list", group: "vesting", cmd: "vesting list", title: "List vesting schedules",
  desc: "List all vesting schedules, optionally filtered by beneficiary.", risk: "read",
  src: "src/cli/vesting.rs",
  fields: [ { f: "beneficiary", kind: "address", help: "Only show schedules for this beneficiary (address or wallet name)." } ] },

{ id: "vesting-show", group: "vesting", cmd: "vesting show", title: "Show vesting schedule",
  desc: "Show a single vesting schedule by id.", risk: "read", src: "src/cli/vesting.rs",
  fields: [ { f: "schedule-id", kind: "uint", u: 64, req: true, help: "Schedule id." } ] },

{ id: "vesting-claim", group: "vesting", cmd: "vesting claim", title: "Claim vested payout",
  desc: "Claim the currently vested payout of a schedule. Permissionless — anyone can trigger it, and the payout goes to the beneficiary.",
  risk: "spend", src: "src/cli/vesting.rs",
  fields: [
    { f: "schedule-id", kind: "uint", u: 64, req: true, help: "Schedule id." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (any funded account)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "See the Vesting Desk for claimable-now math on the pallet's exact linear formula."] },

{ id: "vesting-create", group: "vesting", cmd: "vesting create-schedule", title: "Create vesting schedule",
  desc: "Create a schedule, moving the total from the treasury into the vesting pot. Requires the treasury origin — sign with the treasury account, or use --call-data-only to route the call through a multisig proposal.",
  risk: "govern", src: "src/cli/vesting.rs",
  fields: [
    { f: "beneficiary", kind: "address", req: true, help: "Beneficiary address or wallet name." },
    { f: "start", kind: "string", req: true, help: "Vesting start: unix ms, \"now\", or \"+<seconds>\" relative to now." },
    { f: "cliff", kind: "string", help: "Cliff: unix ms, \"now\", or \"+<seconds>\" (defaults to the start moment)." },
    { f: "end", kind: "string", req: true, help: "Vesting end: unix ms, \"now\", or \"+<seconds>\"." },
    { f: "total", kind: "amount", req: true, help: "Total amount to vest, e.g. \"1000\", \"10.5\"." },
    { f: "from", kind: "string", help: "Wallet name to sign with (must be the treasury account unless printing call data)." },
    { f: "call-data-only", kind: "bool", help: "Print the hex call data instead of submitting (for multisig proposals)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "vesting-end", group: "vesting", cmd: "vesting end-schedule", title: "End vesting schedule",
  desc: "End a schedule early: the unpaid vested part goes to the beneficiary, the rest returns to the treasury. Requires the treasury origin.",
  risk: "govern", src: "src/cli/vesting.rs",
  fields: [
    { f: "schedule-id", kind: "uint", u: 64, req: true, help: "Schedule id." },
    { f: "from", kind: "string", help: "Wallet name to sign with (must be the treasury account unless printing call data)." },
    { f: "call-data-only", kind: "bool", help: "Print the hex call data instead of submitting (for multisig proposals)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "vesting-retarget", group: "vesting", cmd: "vesting retarget", title: "Retarget vesting schedule",
  desc: "Change a schedule's beneficiary after settling any currently claimable payout. Requires the treasury origin.",
  risk: "govern", src: "src/cli/vesting.rs",
  fields: [
    { f: "schedule-id", kind: "uint", u: 64, req: true, help: "Schedule id." },
    { f: "new-beneficiary", kind: "address", req: true, help: "New beneficiary address or wallet name." },
    { f: "from", kind: "string", help: "Wallet name to sign with (must be the treasury account unless printing call data)." },
    { f: "call-data-only", kind: "bool", help: "Print the hex call data instead of submitting (for multisig proposals)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

/* ============================ CHAIN DATA ============================ */
{ id: "storage-get", group: "chaindata", cmd: "storage get", title: "Read storage",
  desc: "Read a raw storage value from a pallet (printed as hex), optionally at a historic block or decoded as a known type. With no --key it counts the map entries.",
  risk: "read", src: "src/cli/storage.rs",
  fields: [
    { f: "pallet", kind: "string", help: "Pallet name, e.g. \"System\". (Required unless --storage-key.)" },
    { f: "name", kind: "string", help: "Storage item name, e.g. \"Account\". (Required unless --storage-key.)" },
    { f: "key", kind: "string", help: "Storage key parameter, e.g. an AccountId for System::Account." },
    { f: "key-type", kind: "enum", values: ["accountid", "u64", "u32", "h256"], help: "Type of the key component. (Required with --key.)" },
    { f: "block", kind: "string", help: "Block number or hash to query at (default: latest)." },
    { f: "decode-as", kind: "string", help: "Decode the value as a type, e.g. \"u64\", \"accountid\", \"accountinfo\"." },
    { f: "count", kind: "bool", help: "Force counting all entries even when --key is given (debugging)." },
    { f: "storage-key", kind: "hex", help: "The full final hex storage key (as returned by iterate). Conflicts with pallet/name/key/count." },
  ],
  conflicts: [["key", "storage-key"], ["storage-key", "count"]],
  requires: [{ need: "key-type", have: "key" }],
  notes: ["Example: quantus storage get --pallet System --name Account --key <qz…> --key-type accountid --decode-as accountinfo"] },

{ id: "storage-list", group: "chaindata", cmd: "storage list", title: "List pallet storage",
  desc: "List all storage items of a pallet with their metadata.", risk: "read",
  src: "src/cli/storage.rs",
  fields: [
    { f: "pallet", kind: "string", req: true, help: "Pallet name, e.g. \"System\"." },
    { f: "names-only", kind: "bool", help: "Show only storage item names (no documentation)." },
  ] },

{ id: "storage-pallets", group: "chaindata", cmd: "storage list-pallets", title: "List pallets with storage",
  desc: "List every pallet that has storage items, optionally with per-pallet counts.",
  risk: "read", src: "src/cli/storage.rs",
  fields: [ { f: "with-counts", kind: "bool", help: "Show counts of storage items per pallet." } ] },

{ id: "storage-stats", group: "chaindata", cmd: "storage stats", title: "Storage statistics",
  desc: "Show storage usage statistics, for one pallet or all.", risk: "read",
  src: "src/cli/storage.rs",
  fields: [
    { f: "pallet", kind: "string", help: "Pallet name (optional — shows all when omitted)." },
    { f: "detailed", kind: "bool", help: "Show detailed statistics." },
  ] },

{ id: "storage-iterate", group: "chaindata", cmd: "storage iterate", title: "Iterate storage map",
  desc: "Walk a storage map's entries — the explorer's way into maps like System::Account. Use 0 as the limit to just count.",
  risk: "read", src: "src/cli/storage.rs",
  fields: [
    { f: "pallet", kind: "string", req: true, help: "Pallet name, e.g. \"System\"." },
    { f: "name", kind: "string", req: true, help: "Storage item name, e.g. \"Account\"." },
    { f: "limit", kind: "uint", u: 32, def: "10", help: "Max entries to show (0 = just count)." },
    { f: "decode-as", kind: "string", help: "Attempt to decode values as a type." },
    { f: "block", kind: "string", help: "Block number or hash (default: latest)." },
  ] },

{ id: "block-analyze", group: "chaindata", cmd: "block analyze", title: "Analyze block",
  desc: "Deep-dive a block: extrinsics, events, storage stats. Defaults to summary; add flags for detail.",
  risk: "read", src: "src/cli/block.rs",
  fields: [
    { f: "number", kind: "uint", u: 32, help: "Block number to analyze." },
    { f: "hash", kind: "hex", help: "Block hash to analyze (alternative to --number)." },
    { f: "latest", kind: "bool", help: "Analyze the latest block." },
    { f: "storage", kind: "bool", help: "Show storage statistics for this block." },
    { f: "extrinsics", kind: "bool", help: "Show detailed extrinsic information." },
    { f: "extrinsics-details", kind: "bool", help: "Show detailed info for ALL extrinsics (not just the first 3)." },
    { f: "events", kind: "bool", help: "Show events from this block." },
    { f: "all", kind: "bool", help: "Show all available information." },
  ] },

{ id: "block-list", group: "chaindata", cmd: "block list", title: "List blocks",
  desc: "List blocks in a number range with summary info.", risk: "read", src: "src/cli/block.rs",
  fields: [
    { f: "start", kind: "uint", u: 32, req: true, help: "Start block number." },
    { f: "end", kind: "uint", u: 32, req: true, help: "End block number." },
  ] },

{ id: "events", group: "chaindata", cmd: "events", title: "Query events",
  desc: "Query and decode events from a block — by number, hash, latest, or finalized — optionally filtered by pallet.",
  risk: "read", src: "src/cli/events.rs",
  fields: [
    { f: "block", kind: "uint", u: 32, help: "Block number to query events from." },
    { f: "block-hash", kind: "hex", help: "Block hash to query events from." },
    { f: "latest", kind: "bool", help: "Query events from the latest block." },
    { f: "finalized", kind: "bool", help: "Query events from the finalized block." },
    { f: "pallet", kind: "string", help: "Filter events by pallet name, e.g. \"Balances\"." },
    { f: "raw", kind: "bool", help: "Show raw event data." },
    { f: "no-decode", kind: "bool", help: "Disable event decoding (decoding is on by default)." },
  ] },

{ id: "transfers-query", group: "chaindata", cmd: "transfers query", title: "Query transfers (private)",
  desc: "Query transfers for your wallet addresses through the Subsquid indexer using privacy-preserving hash-prefix queries: the indexer only ever sees a short prefix of each address hash.",
  risk: "read", src: "src/cli/transfers.rs",
  fields: [
    { f: "subsquid-url", kind: "string", def: "https://sub2.quantus.com/v1/graphql", help: "Subsquid indexer URL." },
    { f: "prefix-len", kind: "uint", u: 32, def: "4", help: "Hash prefix length in hex chars (1–64). Shorter = more privacy, more noise." },
    { f: "after-block", kind: "uint", u: 32, help: "Only transfers after this block." },
    { f: "before-block", kind: "uint", u: 32, help: "Only transfers before this block." },
    { f: "min-amount", kind: "uint", u: 128, help: "Minimum transfer amount in plancks." },
    { f: "limit", kind: "uint", u: 32, def: "100", help: "Max results (default 100, max 1000)." },
    { f: "wallet", kind: "string", help: "Query one wallet (default: all local wallets)." },
    { f: "json", kind: "bool", help: "Show raw transfer data as JSON." },
  ],
  notes: ["Default prefix length 4 covers 1/65536 of the address space per prefix."] },

{ id: "transfers-hash", group: "chaindata", cmd: "transfers hash-address", title: "Hash an address",
  desc: "Compute the hash prefix for an address — debugging helper for the privacy-preserving transfer queries.",
  risk: "read", src: "src/cli/transfers.rs",
  fields: [
    { f: "address", kind: "positional", req: true, help: "The address to hash (SS58, positional argument)." },
    { f: "prefix-len", kind: "uint", u: 32, def: "4", help: "Prefix length to display." },
  ] },

{ id: "scheduler-timestamp", group: "chaindata", cmd: "scheduler get-last-processed-timestamp", title: "Scheduler timestamp",
  desc: "Read the scheduler's last processed timestamp. Read-only.", risk: "read",
  src: "src/cli/scheduler.rs", fields: [] },

{ id: "scheduler-agenda", group: "chaindata", cmd: "scheduler agenda", title: "Scheduler agenda",
  desc: "List Scheduler::Agenda entries over a block range — see what the chain has scheduled (used internally for reversible transfers and governance).",
  risk: "read", src: "src/cli/scheduler.rs",
  fields: [ { f: "range", kind: "range", req: true, help: "Inclusive range, e.g. \"80..100\"." } ] },

{ id: "system", group: "chaindata", cmd: "system", title: "System info",
  desc: "Query node system information: runtime version, metadata statistics, or the exposed JSON-RPC methods.",
  risk: "read", src: "src/cli/system.rs",
  fields: [
    { f: "runtime", kind: "bool", help: "Show runtime version information." },
    { f: "metadata", kind: "bool", help: "Show metadata statistics." },
    { f: "rpc-methods", kind: "bool", help: "Show available JSON-RPC methods exposed by the node." },
  ] },

{ id: "metadata", group: "chaindata", cmd: "metadata", title: "Explore metadata",
  desc: "Explore the chain's metadata: pallets, calls, storage. The same metadata the generic `call` command type-checks against.",
  risk: "read", src: "src/cli/mod.rs",
  fields: [
    { f: "stats-only", kind: "bool", help: "Show only metadata statistics." },
    { f: "pallet", kind: "string", help: "Filter to one pallet name." },
  ] },

/* ============================ WORMHOLE ============================ */
{ id: "wh-address", group: "wormhole", cmd: "wormhole address", title: "Derive wormhole address",
  desc: "Derive the unspendable wormhole address from a 32-byte hex secret file. The secret file must be chmod 600, like --password-file.",
  risk: "key", src: "src/cli/wormhole.rs",
  fields: [
    { f: "secret-file", kind: "path", req: true, help: "File with the 32-byte hex secret (owner-only permissions)." },
  ],
  notes: ["Wormhole moves are the privacy path: fund the unspendable address, then prove and exit to a fresh account."] },

{ id: "wh-prove", group: "wormhole", cmd: "wormhole prove", title: "Generate wormhole proof",
  desc: "Generate a ZK wormhole proof from an existing transfer, against a block hash, for later on-chain verification and exit.",
  risk: "key", src: "src/cli/wormhole.rs",
  fields: [
    { f: "secret-file", kind: "path", req: true, help: "File with the 32-byte hex secret used for the transfer." },
    { f: "amount", kind: "uint", u: 128, req: true, help: "Funding amount that was transferred (plancks)." },
    { f: "exit-account", kind: "address", req: true, help: "Exit account where funds will be withdrawn (hex or SS58)." },
    { f: "block", kind: "hex", req: true, help: "Block hash to generate the proof against (hex)." },
    { f: "transfer-count", kind: "uint", u: 64, req: true, help: "Transfer count from the transfer event." },
    { f: "leaf-index", kind: "uint", u: 64, req: true, help: "ZK trie leaf index from the transfer event (for Merkle proof lookup)." },
    { f: "funding-account", kind: "address", req: true, help: "Funding account, the sender of the transfer (hex or SS58)." },
    { f: "output", kind: "path", def: "proof.hex", help: "Output file for the proof." },
  ] },

{ id: "wh-aggregate", group: "wormhole", cmd: "wormhole aggregate", title: "Aggregate proofs",
  desc: "Aggregate multiple wormhole leaf proofs into a single proof for cheaper on-chain verification.",
  risk: "read", src: "src/cli/wormhole.rs",
  fields: [
    { f: "proofs", kind: "repeat", req: true, help: "Input proof files, hex-encoded. Repeat --proofs for each file." },
    { f: "output", kind: "path", def: "aggregated_proof.hex", help: "Output file for the aggregated proof." },
  ] },

{ id: "wh-verify", group: "wormhole", cmd: "wormhole verify-aggregated", title: "Verify aggregated proof",
  desc: "Verify an aggregated wormhole proof on chain (the exit step).", risk: "spend",
  src: "src/cli/wormhole.rs",
  fields: [
    { f: "proof", kind: "path", def: "aggregated_proof.hex", help: "Path to the aggregated proof file (hex-encoded)." },
  ],
  notes: ["A 4 bps volume fee applies to the wormhole exit flow (see the Fee & Throughput Lab)."] },

{ id: "wh-agg-public", group: "wormhole", cmd: "wormhole aggregate-public", title: "Aggregate public batch",
  desc: "Aggregate private-batch proofs into a public batch (delegated, non-private aggregation). The aggregator address earns a rebate from the burn portion of the volume fee when the proof verifies on chain.",
  risk: "read", src: "src/cli/wormhole.rs",
  fields: [
    { f: "proofs", kind: "repeat", req: true, help: "Input private-batch proof files from `wormhole aggregate`. Repeat --proofs per file." },
    { f: "aggregator", kind: "address", req: true, help: "Aggregator address receiving the fee rebate (hex or SS58)." },
    { f: "output", kind: "path", def: "public_batch_proof.hex", help: "Output file for the public-batch proof." },
  ] },

{ id: "wh-verify-public", group: "wormhole", cmd: "wormhole verify-public-batch", title: "Verify public batch",
  desc: "Verify a public-batch wormhole proof on chain.", risk: "spend", src: "src/cli/wormhole.rs",
  fields: [
    { f: "proof", kind: "path", def: "public_batch_proof.hex", help: "Path to the public-batch proof file (hex-encoded)." },
  ] },

{ id: "wh-prepare", group: "wormhole", cmd: "wormhole prepare-public-batches", title: "Prepare public batches",
  desc: "Prepare N independent public-batch proofs without verifying on chain: fund wormhole addresses → leaf prove → private aggregate → public aggregate. For later firehose submit (e.g. stress-test packing).",
  risk: "spend", src: "src/cli/wormhole.rs",
  fields: [
    { f: "count", kind: "uint", u: 32, def: "10", help: "How many independent public-batch proofs to prepare." },
    { f: "amount", kind: "string", def: "1.0", help: "Amount deposited per batch (DEV units per CLI help), partitioned across --num-proofs." },
    { f: "num-proofs", kind: "uint", u: 32, def: "1", help: "Leaf proofs per private batch (padded to circuit size)." },
    { f: "wallet", kind: "string", req: true, help: "Wallet name (must have a mnemonic for HD wormhole derivation)." },
    { f: "output-dir", kind: "path", def: "/tmp/wormhole_public_batches", help: "Output directory. Must not already contain public_batch_*.hex or batch_* artifacts." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Amounts in wormhole batching commands are labeled DEV in the CLI help (dev-token units)."] },

{ id: "wh-parse", group: "wormhole", cmd: "wormhole parse-proof", title: "Parse proof file",
  desc: "Parse and display the contents of a proof file — for debugging. Can also verify the proof cryptographically (locally, not on chain).",
  risk: "read", src: "src/cli/wormhole.rs",
  fields: [
    { f: "proof", kind: "path", req: true, help: "Path to the proof file (hex-encoded)." },
    { f: "aggregated", kind: "bool", help: "Parse as an aggregated proof (default: leaf proof)." },
    { f: "public-batch", kind: "bool", help: "Parse as a public-batch proof." },
    { f: "verify", kind: "bool", help: "Verify the proof cryptographically (local verification, not on chain)." },
  ],
  conflicts: [["aggregated", "public-batch"]] },

{ id: "wh-multiround", group: "wormhole", cmd: "wormhole multiround", title: "Multi-round wormhole test",
  desc: "Run a multi-round wormhole test: wallet → wormhole → … → wallet. Testing utility with dry-run support.",
  risk: "spend", src: "src/cli/wormhole.rs",
  fields: [
    { f: "num-proofs", kind: "uint", u: 32, def: "2", help: "Proofs per round (default 2, max 8)." },
    { f: "rounds", kind: "uint", u: 32, def: "2", help: "Number of rounds." },
    { f: "amount", kind: "string", def: "100", help: "Total amount in DEV (per CLI help) partitioned across all proofs." },
    { f: "wallet", kind: "string", req: true, help: "Wallet name used for funding and final exit." },
    { f: "keep-files", kind: "bool", help: "Keep proof files after completion." },
    { f: "output-dir", kind: "path", def: "/tmp/wormhole_multiround", help: "Output directory for proof files." },
    { f: "dry-run", kind: "bool", help: "Show what would be done without executing." },
    { f: "public", kind: "bool", help: "Route each round through a public batch; the wallet earns the aggregator fee rebate." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "wh-dissolve", group: "wormhole", cmd: "wormhole dissolve", title: "Dissolve deposit",
  desc: "Dissolve a large wormhole deposit into many small outputs for better privacy: each layer splits outputs in two until all are below the target size — moving funds from a low-privacy large bucket into the high-privacy small bucket.",
  risk: "spend", src: "src/cli/wormhole.rs",
  fields: [
    { f: "amount", kind: "string", req: true, help: "Amount in DEV (per CLI help) to dissolve." },
    { f: "target-size", kind: "string", def: "1.0", help: "Target output size in DEV; splitting stops when all outputs are below this." },
    { f: "wallet", kind: "string", req: true, help: "Wallet name used for funding." },
    { f: "keep-files", kind: "bool", help: "Keep proof files after completion." },
    { f: "output-dir", kind: "path", def: "/tmp/wormhole_dissolve", help: "Output directory for proof files." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "wh-collect", group: "wormhole", cmd: "wormhole collect-rewards", title: "Collect wormhole rewards",
  desc: "Collect miner rewards from a wormhole address: queries Subsquid for pending transfers to your wormhole address, generates ZK proofs, and submits the withdrawal — mirroring the miner app's withdrawal flow.",
  risk: "spend", src: "src/cli/wormhole.rs",
  fields: [
    { f: "wallet", kind: "string", help: "Wallet name (HD derivation of wormhole secret and exit address). One of --wallet / --mnemonic-file / --secret-file." },
    { f: "mnemonic-file", kind: "path", help: "File with a mnemonic for HD derivation (chmod 600; never on argv)." },
    { f: "secret-file", kind: "path", help: "File with the direct wormhole secret (32-byte hex; chmod 600)." },
    { f: "amount", kind: "string", help: "Amount in DEV to withdraw (default: all available)." },
    { f: "destination", kind: "address", help: "Destination address (required with --mnemonic-file or --secret-file)." },
    { f: "subsquid-url", kind: "string", def: "https://sub2.quantus.com/v1/graphql", help: "Subsquid indexer URL." },
    { f: "wormhole-index", kind: "uint", u: 32, def: "0", help: "Wormhole address index for HD derivation." },
    { f: "dry-run", kind: "bool", help: "Show available transfers without withdrawing." },
    { f: "at-block", kind: "uint", u: 32, help: "Specific block number for proofs (default: latest)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file (with --wallet)." },
  ],
  notes: [PW_NOTE] },

{ id: "wh-nullifier", group: "wormhole", cmd: "wormhole check-nullifier", title: "Check nullifier spent",
  desc: "Check whether nullifiers have been spent (consumed by a withdrawal): computes nullifiers from a secret or wallet and checks Subsquid — spent means the transfer was already withdrawn.",
  risk: "read", src: "src/cli/wormhole.rs",
  fields: [
    { f: "secret-file", kind: "path", help: "File with the 32-byte hex wormhole secret (chmod 600). One of --secret-file / --wallet." },
    { f: "wallet", kind: "string", help: "Wallet name (HD derivation of the wormhole secret). One of --secret-file / --wallet." },
    { f: "transfer-counts", kind: "string", req: true, help: "Transfer count(s) to check — a number or range like \"0-10\"." },
    { f: "wormhole-index", kind: "uint", u: 32, def: "0", help: "Wormhole address index for HD derivation (with --wallet)." },
    { f: "subsquid-url", kind: "string", def: "https://sub2.quantus.com/v1/graphql", help: "Subsquid indexer URL." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file (with --wallet)." },
  ],
  notes: [PW_NOTE] },

/* ============================ NEAR ============================ */
{ id: "near-showkey", group: "near", cmd: "near show-key", title: "Show NEAR key forms",
  desc: "Show the wallet's ML-DSA-65 key in NEAR text forms. The wallet must be ML-DSA-65.",
  risk: "key", src: "src/cli/near.rs",
  fields: [
    { f: "wallet", kind: "string", req: true, help: "Quantus wallet (must be ML-DSA-65)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "near-create", group: "near", cmd: "near create-account", title: "Create NEAR sub-account",
  desc: "Create a NEAR sub-account whose only access key is the wallet's ML-DSA-65 key. The parent signs creation and holds no key on the new account.",
  risk: "spend", src: "src/cli/near.rs",
  fields: [
    { f: "new-account", kind: "string", req: true, help: "New account id — must be a sub-account of the parent (e.g. vault.alice.testnet)." },
    { f: "wallet", kind: "string", req: true, help: "Quantus wallet whose ML-DSA-65 key controls the new account." },
    { f: "parent-credentials", kind: "path", req: true, help: "near-cli credentials JSON for the parent (~/.near-credentials/<network>/<parent>.json)." },
    { f: "deposit", kind: "string", def: "0.1", help: "Initial balance for the new account, in NEAR." },
    { f: "network", kind: "enum", values: ["testnet", "mainnet"], def: "testnet", help: "NEAR network." },
    { f: "rpc-url", kind: "string", help: "Custom NEAR RPC URL (overrides --network)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "near-keys", group: "near", cmd: "near keys", title: "List NEAR access keys",
  desc: "List a NEAR account's access keys as stored on chain, marking keys that belong to the given Quantus wallet.",
  risk: "read", src: "src/cli/near.rs",
  fields: [
    { f: "account", kind: "string", req: true, help: "NEAR account id to inspect." },
    { f: "wallet", kind: "string", help: "Mark keys belonging to this Quantus wallet." },
    { f: "network", kind: "enum", values: ["testnet", "mainnet"], def: "testnet", help: "NEAR network." },
    { f: "rpc-url", kind: "string", help: "Custom NEAR RPC URL (overrides --network)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "near-send", group: "near", cmd: "near send", title: "Send NEAR",
  desc: "Transfer NEAR from an account controlled by the wallet's ML-DSA-65 key.",
  risk: "spend", src: "src/cli/near.rs",
  fields: [
    { f: "wallet", kind: "string", req: true, help: "Quantus wallet holding the account's ML-DSA-65 key." },
    { f: "account", kind: "string", req: true, help: "NEAR account to send from." },
    { f: "to", kind: "string", req: true, help: "Recipient NEAR account id." },
    { f: "amount", kind: "string", req: true, help: "Amount in NEAR, e.g. \"1.5\"." },
    { f: "network", kind: "enum", values: ["testnet", "mainnet"], def: "testnet", help: "NEAR network." },
    { f: "rpc-url", kind: "string", help: "Custom NEAR RPC URL (overrides --network)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "near-dao-propose", group: "near", cmd: "near dao propose-transfer", title: "DAO: propose transfer",
  desc: "Propose a NEAR transfer from a Sputnik DAO treasury (calls add_proposal) as a member account controlled by the wallet.",
  risk: "spend", src: "src/cli/near.rs",
  fields: [
    { f: "dao", kind: "string", req: true, help: "Sputnik DAO contract account id." },
    { f: "account", kind: "string", req: true, help: "Member account the wallet controls." },
    { f: "wallet", kind: "string", req: true, help: "Quantus wallet holding the member account's ML-DSA-65 key." },
    { f: "receiver", kind: "string", req: true, help: "Transfer recipient." },
    { f: "amount", kind: "string", req: true, help: "Amount in NEAR." },
    { f: "description", kind: "string", def: "Proposed via quantus-cli", help: "Proposal description shown to voters." },
    { f: "bond", kind: "string", help: "Proposal bond in NEAR (default: the exact bond from the DAO policy)." },
    { f: "network", kind: "enum", values: ["testnet", "mainnet"], def: "testnet", help: "NEAR network." },
    { f: "rpc-url", kind: "string", help: "Custom NEAR RPC URL (overrides --network)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "near-dao-vote", group: "near", cmd: "near dao vote", title: "DAO: vote",
  desc: "Vote on a Sputnik DAO proposal (calls act_proposal). An approving vote that meets the threshold also executes the proposal.",
  risk: "spend", src: "src/cli/near.rs",
  fields: [
    { f: "dao", kind: "string", req: true, help: "Sputnik DAO contract account id." },
    { f: "account", kind: "string", req: true, help: "Member account the wallet controls." },
    { f: "wallet", kind: "string", req: true, help: "Quantus wallet holding the member account's ML-DSA-65 key." },
    { f: "id", kind: "uint", u: 64, req: true, help: "Proposal id." },
    { f: "vote", kind: "enum", values: ["approve", "reject", "remove"], req: true, help: "Vote action." },
    { f: "network", kind: "enum", values: ["testnet", "mainnet"], def: "testnet", help: "NEAR network." },
    { f: "rpc-url", kind: "string", help: "Custom NEAR RPC URL (overrides --network)." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "near-dao-proposal", group: "near", cmd: "near dao proposal", title: "DAO: show proposal",
  desc: "Show a Sputnik DAO proposal's state (view call — no wallet needed).", risk: "read",
  src: "src/cli/near.rs",
  fields: [
    { f: "dao", kind: "string", req: true, help: "Sputnik DAO contract account id." },
    { f: "id", kind: "uint", u: 64, req: true, help: "Proposal id." },
    { f: "network", kind: "enum", values: ["testnet", "mainnet"], def: "testnet", help: "NEAR network." },
    { f: "rpc-url", kind: "string", help: "Custom NEAR RPC URL (overrides --network)." },
  ] },

/* ============================ AIRDROP ============================ */
{ id: "airdrop-check", group: "airdrop", cmd: "airdrop check", title: "Check airdrop rewards",
  desc: "Show testnet snapshot rows owned by this wallet or wormhole secret — find and scan rewards across every historical key-derivation scheme.",
  risk: "read", src: "src/cli/airdrop.rs",
  fields: [
    { f: "server", kind: "string", def: "http://127.0.0.1:8080", help: "Claim server base URL (default: local claim server)." },
    { f: "wallet", kind: "string", help: "Hot wallet used to derive Dilithium (and HD wormhole) addresses." },
    { f: "wormhole-secret-file", kind: "path", help: "File with a 32-byte hex wormhole secret (chmod 600)." },
    { f: "wormhole-secret-prompt", kind: "bool", help: "Paste a 32-byte hex wormhole secret at a hidden prompt (never on argv)." },
    { f: "wormhole-index", kind: "uint", u: 32, help: "HD wormhole address index (default: scan indexes 0..=16)." },
    { f: "scan-accounts", kind: "uint", u: 32, def: "8", help: "Highest Dilithium account index scanned per historical keygen family." },
    { f: "scan-rounds", kind: "uint", u: 32, def: "8", help: "Highest wormhole branch/round component scanned." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Historical key families scanned: Dilithium, DilithiumHistorical keygens, and wormhole secrets — see src/cli/airdrop.rs."] },

{ id: "airdrop-claim", group: "airdrop", cmd: "airdrop claim", title: "Claim airdrop rewards",
  desc: "Prove ownership and submit testnet reward claims. Amounts come from the snapshot. Use --dry-run first to review without POSTing.",
  risk: "spend", src: "src/cli/airdrop.rs",
  fields: [
    { f: "server", kind: "string", def: "http://127.0.0.1:8080", help: "Claim server base URL." },
    { f: "wallet", kind: "string", help: "Hot wallet that signs Dilithium claims and/or derives HD wormhole secrets." },
    { f: "to", kind: "address", help: "Destination for the payout (wallet name or SS58; defaults to --wallet)." },
    { f: "wormhole-secret-file", kind: "path", help: "File with a 32-byte hex wormhole secret (chmod 600)." },
    { f: "wormhole-secret-prompt", kind: "bool", help: "Paste a 32-byte hex wormhole secret at a hidden prompt." },
    { f: "wormhole-index", kind: "uint", u: 32, help: "HD wormhole address index." },
    { f: "scan-accounts", kind: "uint", u: 32, def: "8", help: "Highest Dilithium account index scanned per keygen family." },
    { f: "scan-rounds", kind: "uint", u: 32, def: "8", help: "Highest wormhole branch/round component scanned." },
    { f: "dry-run", kind: "bool", help: "Print matches and signed/proved payloads without POSTing." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE] },

{ id: "airdrop-pay", group: "airdrop", cmd: "airdrop pay", title: "Pay airdrop rewards (admin)",
  desc: "Pay recorded (claimed but unpaid) rewards with batch transfers and mark them paid on the claim server. Requires the server admin token. Start with --dry-run and --limit 1.",
  risk: "admin", src: "src/cli/airdrop.rs",
  fields: [
    { f: "server", kind: "string", def: "http://127.0.0.1:8080", help: "Claim server base URL." },
    { f: "from", kind: "string", req: true, help: "Wallet that funds the payouts (hot or cold)." },
    { f: "admin-token-file", kind: "path", help: "File with the claim server admin token (chmod 600; falls back to QUANTUS_AIRDROP_ADMIN_TOKEN)." },
    { f: "only", kind: "repeat", help: "Pay only this rewarded address. Repeat --only per address." },
    { f: "limit", kind: "uint", u: 32, help: "Pay at most this many claims this run (e.g. 1 to test end-to-end first)." },
    { f: "batch-size", kind: "uint", u: 32, help: "Max transfers per batch extrinsic (default: the chain's safe batch limit)." },
    { f: "tip", kind: "amount", help: "Optional tip per batch to prioritize inclusion." },
    { f: "yes", kind: "bool", help: "Skip the interactive review confirmation." },
    { f: "dry-run", kind: "bool", help: "Show the payout plan without submitting or marking anything paid." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "The admin token is never accepted on argv: use --admin-token-file or QUANTUS_AIRDROP_ADMIN_TOKEN."] },

/* ============================ RUNTIME & UPGRADES ============================ */
{ id: "runtime-update", group: "runtime", cmd: "runtime update", title: "Propose runtime upgrade",
  desc: "Propose a version-checked runtime upgrade via System::authorize_upgrade on the chosen governance track. For the full preimage→submit→deposit flow, prefer the tech-referenda commands.",
  risk: "govern", src: "src/cli/runtime.rs",
  fields: [
    { f: "wasm-file", kind: "path", req: true, help: "Path to the runtime WASM file." },
    { f: "track", kind: "enum", values: ["fast-upgrade", "root"], def: "fast-upgrade", help: "Governance track: fast-upgrade (80%/80%, ~30 min) or root (61%/60%, ~2 days)." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (must be allowed to submit Tech Referenda)." },
    { f: "force", kind: "bool", danger: true, help: "Force the update without confirmation." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "The CLI version-checks the WASM against the running runtime before proposing."] },

{ id: "runtime-apply", group: "runtime", cmd: "runtime apply", title: "Apply authorized upgrade",
  desc: "Apply the exact WASM after its authorization referendum has enacted. Any funded wallet can submit the application.",
  risk: "govern", src: "src/cli/runtime.rs",
  fields: [
    { f: "wasm-file", kind: "path", req: true, help: "Path to the runtime WASM file whose hash was authorized." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with (any funded wallet)." },
    { f: "force", kind: "bool", danger: true, help: "Apply without confirmation." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "The WASM hash must match the authorized hash exactly — compare first with `runtime compare`."] },

{ id: "runtime-compare", group: "runtime", cmd: "runtime compare", title: "Compare runtime WASM",
  desc: "Compare a local WASM file against the currently running on-chain runtime.", risk: "read",
  src: "src/cli/runtime.rs",
  fields: [ { f: "wasm-file", kind: "path", req: true, help: "Path to the runtime WASM file to compare." } ] },

{ id: "call", group: "runtime", cmd: "call", title: "Generic pallet call",
  desc: "Call ANY pallet function: the CLI resolves the call against live chain metadata and type-checks the JSON arguments. The escape hatch for everything without a dedicated command.",
  risk: "spend", src: "src/cli/generic_call.rs + src/cli/mod.rs",
  fields: [
    { f: "pallet", kind: "string", req: true, help: "Pallet name, e.g. \"Balances\"." },
    { f: "call", kind: "string", req: true, help: "Call/function name, e.g. \"transfer_allow_death\"." },
    { f: "args", kind: "json", help: "Arguments as a JSON array, e.g. '[\"5GrwvaEF…\", \"1000000000000\"]'." },
    { f: "from", kind: "string", req: true, help: "Wallet name to sign with." },
    { f: "tip", kind: "amount", help: "Optional tip to prioritize the transaction." },
    { f: "offline", kind: "bool", help: "Build the extrinsic offline without submitting." },
    { f: "call-data-only", kind: "bool", help: "Output the call as hex-encoded data only." },
    { f: "password-file", kind: "path", help: "Read the wallet password from an owner-only file." },
  ],
  notes: [PW_NOTE, "Use the Extrinsic Lab to decode what a call will do before you sign it; use `metadata --pallet <name>` to discover calls."] },

/* ============================ MAINTENANCE ============================ */
{ id: "version", group: "maint", cmd: "version", title: "CLI version",
  desc: "Show the CLI version.", risk: "read", src: "src/cli/mod.rs", fields: [] },

{ id: "update-check", group: "maint", cmd: "update", title: "Update CLI",
  desc: "Check for or install CLI updates. `quantus update` downloads the prebuilt binary for your platform from the GitHub releases and replaces the running executable.",
  risk: "admin", src: "src/cli/update.rs + src/cli/mod.rs",
  fields: [
    { f: "check", kind: "bool", help: "Only check whether a newer version is available (don't install)." },
    { f: "yes", kind: "bool", help: "Skip the confirmation prompt (useful in scripts)." },
    { f: "version", kind: "string", help: "Install a specific version instead of the latest, e.g. \"1.5.0\"." },
  ],
  notes: ["The CLI also checks GitHub for newer releases in the background (non-blocking, best-effort; result cached for a few hours). Set QUANTUS_NO_UPDATE_CHECK to any value to disable the notice. If the binary lives in a protected location, re-run with elevated privileges."] },

{ id: "compat", group: "maint", cmd: "compatibility-check", title: "Compatibility check",
  desc: "Check the CLI's compatibility with the connected node.", risk: "read",
  src: "src/cli/mod.rs", fields: [] },

{ id: "dev-wallets", group: "maint", cmd: "developer create-test-wallets", title: "Create dev test wallets",
  desc: "Create the standard test wallets (crystal_alice, crystal_bob, crystal_charlie) for development against a --dev node.",
  risk: "key", src: "src/cli/mod.rs",
  fields: [],
  notes: ["Development only — these are well-known test keys with no security. Never fund them on mainnet."] },

{ id: "exercise", group: "maint", cmd: "exercise", title: "Exercise suite",
  desc: "Run the chain exercise suite against a live node: scripted scenarios across pallets, with fuzzing. Defaults to all phases except upgrade.",
  risk: "admin", src: "src/cli/exercise/mod.rs",
  fields: [
    { f: "phases", kind: "csv", help: "Phases to run, comma-separated (default: all except upgrade; pass --upgrade-wasm to enable it)." },
    { f: "skip", kind: "csv", help: "Phases to skip, comma-separated." },
    { f: "fuzz-iterations", kind: "uint", u: 32, def: "25", help: "Fuzz iterations per phase." },
    { f: "seed", kind: "uint", u: 64, help: "Reproducible fuzz seed (default: random)." },
    { f: "upgrade-wasm", kind: "path", help: "Candidate runtime WASM; enables the upgrade phase (fast-governance node only)." },
    { f: "self-upgrade", kind: "bool", danger: true, help: "Self-upgrade smoke test: re-install the current on-chain runtime. Conflicts with --upgrade-wasm." },
    { f: "upgrade-timeout-secs", kind: "uint", u: 64, def: "900", help: "Upgrade phase timeout." },
    { f: "ephemeral-accounts", kind: "uint", u: 32, def: "4", help: "Ephemeral test accounts." },
    { f: "root-account", kind: "string", help: "Wallet name funding the exercise (default: built-in crystal_alice dev account, genesis-funded on --dev nodes)." },
  ],
  conflicts: [["upgrade-wasm", "self-upgrade"]],
  notes: ["The governance and upgrade phases sign with the dev genesis accounts — skip them on chains where those are unfunded."] },

];

/* ---------------- recipes (hand-written, verified against the catalog) ---------------- */
var RECIPES = [
{ id: "first-run", title: "First run: install → wallet → balance",
  desc: "From zero to your first address. The install step runs outside the forge — everything after it is built from the catalog above.",
  steps: [
    { label: "Install the CLI", cmd: "cargo install quantus-cli", note: "Installs the `quantus` binary (per the CLI README). Or build from source: git clone https://github.com/Quantus-Network/quantus-cli && cargo build --release." },
    { label: "Check for updates", build: "update-check", values: { check: true }, note: "No install — just reports whether a newer release exists." },
    { label: "Create your wallet", build: "wallet-create", values: { name: "main", scheme: "ml-dsa-65" }, note: "Write down the mnemonic. It is shown once." },
    { label: "See your address", build: "wallet-view", values: { name: "main" }, note: "No secrets printed." },
    { label: "Check the balance", build: "balance", values: { address: "<paste-your-qz-address>" }, note: "Fund the address first (mining, faucet, or a transfer)." },
  ] },
{ id: "send-verify", title: "Send QTC and verify it landed",
  desc: "The basic payment round-trip, with on-chain verification via events.",
  steps: [
    { label: "Send", build: "send", values: { to: "<recipient-qz-address>", amount: "1.5", from: "main" }, note: "Add --wait-for-transaction (global) to block until inclusion." },
    { label: "Confirm the balance moved", build: "balance", values: { address: "<recipient-qz-address>" } },
    { label: "See the transfer event", build: "events", values: { latest: true, pallet: "Balances" }, note: "Decoding is on by default; add --raw for raw bytes." },
  ] },
{ id: "reversible-roundtrip", title: "Reversible payment round-trip",
  desc: "SafeSend: schedule with a delay, watch it pending, then let it execute — or cancel and recover.",
  steps: [
    { label: "Schedule with a custom delay", build: "reversible-schedule-delay", values: { to: "<recipient-qz-address>", amount: "10", delay: "3600", from: "main" }, note: "3600 seconds = 1 hour. Use --unit-blocks for block-based delays." },
    { label: "Watch it pending", build: "reversible-list", values: { from: "main" }, note: "Find the transaction ID here." },
    { label: "Changed your mind? Cancel", build: "reversible-cancel", values: { "tx-id": "<tx-id-hex>", from: "main" }, note: "Only before the delay elapses and the recipient claims." },
  ] },
{ id: "multisig-roundtrip", title: "Multisig vault round-trip",
  desc: "Predict the address, create the vault, propose a transfer, collect approvals, execute.",
  steps: [
    { label: "Predict the address first", build: "ms-predict", values: { signers: "alice,bob,charlie", threshold: "2" }, note: "Free, offline, deterministic." },
    { label: "Create the multisig", build: "ms-create", values: { signers: "alice,bob,charlie", threshold: "2", from: "alice" }, note: "Costs the 0.03 QTC creation burn." },
    { label: "Propose a transfer", build: "ms-propose-transfer", values: { address: "<multisig-qz-address>", to: "<recipient>", amount: "5", from: "alice" } },
    { label: "Second signer approves", build: "ms-approve", values: { address: "<multisig-qz-address>", "proposal-id": "0", from: "bob" }, note: "Proposal IDs are u32 nonces; list them with multisig list-proposals." },
    { label: "Execute at threshold", build: "ms-execute", values: { address: "<multisig-qz-address>", "proposal-id": "0", from: "bob" } },
  ] },
{ id: "gov-upgrade", title: "Governance: runtime-upgrade proposal",
  desc: "The full upgrade path: preimage from WASM, one-shot submit, decision deposit, vote.",
  steps: [
    { label: "Create the authorize_upgrade preimage", build: "preimage-create", values: { "wasm-file": "./runtime.wasm", from: "alice" }, note: "Note the preimage hash from the output." },
    { label: "Submit the referendum", build: "tr-submit", values: { "preimage-hash": "<preimage-hash-hex>", track: "fast-upgrade", from: "alice" }, note: "fast-upgrade: 80%/80%, ~30 min. You must be a Tech Collective member." },
    { label: "Place the decision deposit", build: "tr-deposit", values: { index: "0", from: "alice" }, note: "Required before voting begins; refundable afterwards." },
    { label: "Vote aye", build: "tc-vote", values: { "referendum-index": "0", vote: "aye", from: "alice" } },
    { label: "Watch the status", build: "tr-status", values: { index: "0" } },
  ] },
{ id: "cold-sign", title: "Cold-wallet (QR) signing flow",
  desc: "Air-gapped signing with a Keystone device or the Quantus cold wallet app.",
  steps: [
    { label: "Pair the cold wallet watch-only", build: "wallet-import-cold", values: { name: "vault", address: "<cold-qz-address>" }, note: "Only the address is stored — nothing to steal." },
    { label: "Print the sign-request QR", build: "signing-qr", values: { from: "vault", to: "<recipient>", amount: "2" }, note: "Or pass --call-data with arbitrary hex to sign any call." },
    { label: "Scan & sign on the device", cmd: "(on the cold device: scan the QR, verify the call, sign)", note: "The device enforces its own genesis-hash allowlist." },
    { label: "Feed the signature back", cmd: "quantus --cold-response-in ./sig.ur send --to <recipient> --amount 2 --from vault", note: "Global cold-wallet flags: --cold-request-out writes the request UR to a file; --cold-response-in reads the signature UR (or \"-\" for stdin); --camera-index picks the camera." },
  ] },
{ id: "batch-payout", title: "Batch payout from a file",
  desc: "Pay many recipients atomically. Build the file in the Batch file builder below, check chain limits, then send.",
  steps: [
    { label: "Check chain batch limits", build: "batch-config", values: { limits: true } },
    { label: "Send the batch", build: "batch-send", values: { from: "main", "batch-file": "./payouts.json" }, note: "Amounts in the file are raw planck integers (\"1000\" = 1000 plancks)." },
  ] },
];

/* ---------------- batch file builder (pure) ---------------- */
// rows: [{to, amountQtc}]. Emits the CLI's documented batch-file format:
// [{"to": "address", "amount": "<plancks integer string>"}, ...]
function buildBatchFile(rows) {
  var out = [], problems = [];
  rows.forEach(function (r, i) {
    var to = trim(r.to), amt = trim(r.amountQtc);
    var c = classifyAddressOrName(to);
    if (!to || !c.ok) problems.push({ row: i, field: "to", msg: "bad address" });
    var p = parseQtcToPlancks(amt);
    if (p === null) problems.push({ row: i, field: "amountQtc", msg: "bad QTC amount" });
    if (to && c.ok && p !== null) out.push({ to: to, amount: p.toString() });
  });
  return { json: JSON.stringify(out, null, 2), problems: problems, count: out.length };
}

/* ---------------- global options ---------------- */
var GLOBALS = [
  { f: "nodeUrl", label: "Node URL", kind: "string", def: "ws://127.0.0.1:9944",
    help: "Node endpoint. Default is a local node; use wss://rpc.quantus.network for the upstream-documented public mainnet RPC." },
  { f: "verbose", label: "Verbose", kind: "bool", help: "Every command supports --verbose for detailed debugging output." },
  { f: "waitForTx", label: "Wait for inclusion", kind: "bool", help: "--wait-for-transaction: wait until the tx is included in a best block." },
  { f: "finalizedTx", label: "Wait for finality", kind: "bool", danger: true, help: "--finalized-tx: wait for finalization. The CLI warns this may take a while on the PoW chain." },
  { f: "coldRequestOut", label: "Cold request out", kind: "string", help: "--cold-request-out: also write the cold-wallet sign-request UR parts to this file." },
  { f: "coldResponseIn", label: "Cold response in", kind: "string", help: "--cold-response-in: read the signature-response UR parts from this file (or \"-\" for stdin) instead of scanning with the camera." },
  { f: "cameraIndex", label: "Camera index", kind: "uint", u: 32, def: "0", help: "--camera-index: camera device index for cold-wallet QR scanning." },
];

function groupById(gid) {
  for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === gid) return GROUPS[i];
  return null;
}

function searchCommands(q) {
  q = trim(q).toLowerCase();
  if (!q) return COMMANDS.slice();
  return COMMANDS.filter(function (c) {
    var hay = (c.cmd + " " + c.title + " " + c.desc + " " + c.fields.map(function (f) { return f.f; }).join(" ")).toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

/* catalog integrity (used by tests + UI) */
function catalogProblems() {
  var bad = [];
  var ids = {};
  COMMANDS.forEach(function (c) {
    if (!c.id || ids[c.id]) bad.push("duplicate/missing id: " + c.id);
    ids[c.id] = true;
    if (!c.cmd) bad.push(c.id + ": missing cmd path");
    if (!groupById(c.group)) bad.push(c.id + ": unknown group " + c.group);
    if (!c.title || !c.desc) bad.push(c.id + ": missing title/desc");
    if (!c.src) bad.push(c.id + ": missing source ref");
    if (!c.risk) bad.push(c.id + ": missing risk");
    (c.fields || []).forEach(function (f) {
      if (!f.f || !f.kind) bad.push(c.id + ": field missing name/kind");
      else if (["bool","string","uint","address","address-strict","amount","hex","enum","json","csv","range","positional","repeat","path"].indexOf(f.kind) < 0)
        bad.push(c.id + ": unknown field kind " + f.kind);
    });
  });
  RECIPES.forEach(function (r) {
    (r.steps || []).forEach(function (s, i) {
      if (s.build && !findCommand(s.build)) bad.push("recipe " + r.id + " step " + i + ": unknown command " + s.build);
    });
  });
  return bad;
}

/* ============================ DOM layer (browser only) ============================ */
function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

var state = { cmdId: "send", values: {}, globals: { nodeUrl: "ws://127.0.0.1:9944" }, batchRows: [{ to: "", amountQtc: "" }] };

var RISK_LABEL = { read: "read-only", key: "handles keys", spend: "moves funds", govern: "governance", admin: "dangerous" };

function riskBadge(risk) {
  return '<span class="risk risk-' + esc(risk) + '">' + esc(RISK_LABEL[risk] || risk) + "</span>";
}

function fieldInput(f, val) {
  var v = val == null ? "" : val;
  var dis = f.def ? ' <span class="def">default: ' + esc(f.def) + "</span>" : "";
  var danger = f.danger ? ' <span class="danger-tag">careful</span>' : "";
  var html = '<label class="fld" data-field="' + esc(f.f) + '">';
  html += '<span class="fld-name"><code>--' + esc(f.f) + "</code>" + dis + danger + "</span>";
  if (f.kind === "bool") {
    html += '<span class="check"><input type="checkbox" data-inp ' + (v === true || v === "true" ? "checked" : "") + '> <span>enable</span></span>';
  } else if (f.kind === "enum") {
    html += '<select data-inp><option value="">—</option>' + f.values.map(function (x) {
      return '<option value="' + esc(x) + '"' + (v === x ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("") + "</select>";
  } else if (f.kind === "positional") {
    html += '<input type="text" data-inp value="' + esc(v) + '" placeholder="positional argument" spellcheck="false">';
  } else {
    var ph = f.kind === "amount" ? "e.g. 1.5" : (f.kind === "address" || f.kind === "address-strict" ? "qz…" : "");
    html += '<input type="text" data-inp value="' + esc(v) + '" placeholder="' + esc(ph) + '" spellcheck="false" autocomplete="off">';
  }
  html += '<span class="fld-help">' + esc(f.help || "") + "</span>";
  html += '<span class="fld-err" hidden></span>';
  html += '<span class="fld-hint" hidden></span>';
  html += "</label>";
  return html;
}

function renderTree(filter) {
  var box = document.getElementById("cmd-tree");
  box.innerHTML = "";
  var list = searchCommands(filter);
  GROUPS.forEach(function (g) {
    var items = list.filter(function (c) { return c.group === g.id; });
    if (!items.length) return;
    var det = el("details", "grp", "");
    det.open = true;
    det.innerHTML = '<summary><span class="g-ico">' + g.icon + "</span> " + esc(g.name) +
      ' <span class="g-n">' + items.length + "</span></summary>";
    var ul = el("div", "cmds");
    items.forEach(function (c) {
      var b = el("button", "cmd-item" + (c.id === state.cmdId ? " active" : ""),
        "<span class=\"ci-t\">" + esc(c.title) + "</span><span class=\"ci-c\">" + esc(c.cmd) + "</span>");
      b.type = "button";
      b.onclick = function () { selectCommand(c.id); };
      ul.appendChild(b);
    });
    det.appendChild(ul);
    box.appendChild(det);
  });
  var n = document.getElementById("cmd-count");
  if (n) n.textContent = list.length + " / " + COMMANDS.length + " commands";
}

function selectCommand(id) {
  var c = findCommand(id);
  if (!c) return;
  state.cmdId = id;
  // keep values for fields the new command also has
  renderTree(document.getElementById("cmd-search").value);
  renderBuilder();
  document.getElementById("builder").scrollIntoView({ behavior: "smooth", block: "start" });
}

function currentValues() {
  var vals = {};
  document.querySelectorAll("#cmd-form .fld").forEach(function (lab) {
    var f = lab.getAttribute("data-field");
    var inp = lab.querySelector("[data-inp]");
    vals[f] = inp.type === "checkbox" ? inp.checked : inp.value;
  });
  return vals;
}

function currentGlobals() {
  var g = {};
  document.querySelectorAll("#global-form [data-g]").forEach(function (inp) {
    var k = inp.getAttribute("data-g");
    g[k] = inp.type === "checkbox" ? inp.checked : inp.value;
  });
  return g;
}

function renderBuilder() {
  var c = findCommand(state.cmdId);
  var box = document.getElementById("builder");
  var html = "";
  html += '<div class="b-head"><div><div class="crumb">' + esc(groupById(c.group).name) + "</div>";
  html += "<h2>" + esc(c.title) + " " + riskBadge(c.risk) + "</h2>";
  html += '<p class="b-desc">' + esc(c.desc) + "</p>";
  html += '<p class="b-src">Flag map: <code>' + esc(c.src) + "</code> @ " + esc(SOURCE.rev) + "</p></div></div>";

  html += '<div id="cmd-form" class="form">';
  if (!c.fields.length) html += '<p class="no-fields">No flags — this command runs as-is (plus global options).</p>';
  c.fields.forEach(function (f) { html += fieldInput(f, state.values[f.f]); });
  html += "</div>";

  if ((c.notes || []).length) {
    html += '<div class="notes"><h3>Notes</h3><ul>' +
      c.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul></div>";
  }

  if (c.id === "batch-send") html += '<div id="batch-panel"></div>';

  html += '<div class="preview-wrap"><div class="preview-bar"><span>Command preview</span>' +
    '<span class="prev-actions"><button id="btn-copy" class="btn small">Copy</button>' +
    '<button id="btn-sh" class="btn small ghost">Download .sh</button></span></div>' +
    '<pre id="preview" class="terminal" aria-live="polite"></pre>' +
    '<div id="prev-problems" class="problems" hidden></div>' +
    '<div id="prev-plancks" class="plancks" hidden></div></div>';

  box.innerHTML = html;
  box.querySelectorAll("#cmd-form [data-inp]").forEach(function (inp) {
    inp.addEventListener("input", refreshPreview);
    inp.addEventListener("change", refreshPreview);
  });
  document.getElementById("btn-copy").onclick = copyPreview;
  document.getElementById("btn-sh").onclick = downloadSh;
  if (c.id === "batch-send") renderBatchPanel();
  refreshPreview();
}

function highlightPreview(text) {
  // minimal shell highlighting: binary, flags, quoted strings
  var out = esc(text);
  out = out.replace(/^quantus/, '<span class="tk-bin">quantus</span>');
  out = out.replace(/(--)([a-z0-9-]+)/g, '<span class="tk-flag">$1$2</span>');
  out = out.replace(/(&#x27;.*?&#x27;|&quot;.*?&quot;)/g, '<span class="tk-str">$1</span>');
  return out;
}

function refreshPreview() {
  var c = findCommand(state.cmdId);
  state.values = currentValues();
  state.globals = currentGlobals();
  var r = buildCommand(c, state.values, state.globals);

  // inline field errors + hints
  document.querySelectorAll("#cmd-form .fld").forEach(function (lab) {
    var f = lab.getAttribute("data-field");
    var def = null;
    c.fields.forEach(function (x) { if (x.f === f) def = x; });
    var errEl = lab.querySelector(".fld-err"), hintEl = lab.querySelector(".fld-hint");
    errEl.hidden = true; hintEl.hidden = true;
    if (!def) return;
    var probs = r.problems.filter(function (p) { return p.field === f; });
    if (probs.length) { errEl.textContent = "⚠ " + probs[0].msg; errEl.hidden = false; }
    var v = trim(state.values[f] || "");
    if (!probs.length && v && (def.kind === "address") ) {
      var cl = classifyAddressOrName(v);
      if (cl.ok && cl.kind === "wallet-name") { hintEl.textContent = "treated as a wallet name (the CLI resolves it)"; hintEl.hidden = false; }
    }
    if (!probs.length && v && def.kind === "amount" && r.plancks[f]) {
      hintEl.textContent = "= " + r.plancks[f] + " plancks (" + plancksToQtcString(BigInt(r.plancks[f])) + " QTC)"; hintEl.hidden = false;
    }
  });

  var prev = document.getElementById("preview");
  prev.innerHTML = highlightPreview(r.cmd);
  var pb = document.getElementById("prev-problems");
  if (r.problems.length) {
    pb.hidden = false;
    pb.innerHTML = "<strong>Fix before running:</strong><ul>" +
      r.problems.map(function (p) { return "<li><code>" + esc(p.field) + "</code> — " + esc(p.msg) + "</li>"; }).join("") + "</ul>";
  } else { pb.hidden = true; pb.innerHTML = ""; }
  var pk = document.getElementById("prev-plancks");
  var keys = Object.keys(r.plancks);
  if (keys.length) {
    pk.hidden = false;
    pk.innerHTML = keys.map(function (k) {
      return "<span><code>--" + esc(k) + "</code> → <b>" + esc(r.plancks[k]) + "</b> plancks</span>";
    }).join(" · ");
  } else pk.hidden = true;
  var cp = document.getElementById("btn-copy");
  cp.disabled = r.problems.length > 0;
  cp.title = r.problems.length ? "Fill the required fields first" : "Copy to clipboard";
}

function copyText(t, btn) {
  function done(ok) {
    var old = btn.textContent;
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(function () { btn.textContent = old; }, 1400);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(false); });
  } else {
    var ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { done(document.execCommand("copy")); } catch (e) { done(false); }
    document.body.removeChild(ta);
  }
}

function copyPreview() {
  var c = findCommand(state.cmdId);
  var r = buildCommand(c, currentValues(), currentGlobals());
  if (r.problems.length) return;
  copyText(r.cmd, document.getElementById("btn-copy"));
}

function downloadFile(name, text, btn) {
  var blob = new Blob([text], { type: "text/plain" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  if (btn) { var old = btn.textContent; btn.textContent = "Saved ✓"; setTimeout(function () { btn.textContent = old; }, 1400); }
}

function downloadSh() {
  var c = findCommand(state.cmdId);
  var r = buildCommand(c, currentValues(), currentGlobals());
  if (r.problems.length) return;
  downloadFile("quantus-" + c.id + ".sh",
    "#!/usr/bin/env bash\n# Built with the QTC CLI Forge — " + SOURCE.repo + " @ " + SOURCE.rev + "\nset -euo pipefail\n\n" + r.cmd + "\n",
    document.getElementById("btn-sh"));
}

/* ---------------- batch file builder (DOM) ---------------- */
function renderBatchPanel() {
  var p = document.getElementById("batch-panel");
  p.innerHTML = '<h3>Batch file builder</h3><p class="muted">Add rows — the forge converts QTC decimals to exact planck integers and emits the JSON <code>batch send --batch-file</code> expects.</p>' +
    '<div id="batch-rows"></div>' +
    '<div class="row-actions"><button id="batch-add" class="btn small ghost" type="button">+ Add row</button>' +
    '<button id="batch-dl" class="btn small" type="button">Download payouts.json</button></div>' +
    '<pre id="batch-preview" class="terminal small"></pre><div id="batch-problems" class="problems" hidden></div>';
  var rowsBox = p.querySelector("#batch-rows");
  function draw() {
    rowsBox.innerHTML = "";
    state.batchRows.forEach(function (row, i) {
      var d = el("div", "batch-row");
      d.innerHTML = '<input type="text" data-bto placeholder="qz… address" value="' + esc(row.to) + '" spellcheck="false">' +
        '<input type="text" data-bamt placeholder="QTC e.g. 1.5" value="' + esc(row.amountQtc) + '" spellcheck="false">' +
        '<button class="btn small ghost" data-brm type="button">✕</button>';
      d.querySelector("[data-bto]").addEventListener("input", function (e) { row.to = e.target.value; upd(); });
      d.querySelector("[data-bamt]").addEventListener("input", function (e) { row.amountQtc = e.target.value; upd(); });
      d.querySelector("[data-brm]").onclick = function () { state.batchRows.splice(i, 1); if (!state.batchRows.length) state.batchRows.push({ to: "", amountQtc: "" }); draw(); upd(); };
      rowsBox.appendChild(d);
    });
  }
  function upd() {
    var r = buildBatchFile(state.batchRows);
    p.querySelector("#batch-preview").textContent = r.json;
    var pb = p.querySelector("#batch-problems");
    if (r.problems.length) {
      pb.hidden = false;
      pb.innerHTML = "<ul>" + r.problems.map(function (x) { return "<li>row " + (x.row + 1) + " <code>" + esc(x.field) + "</code> — " + esc(x.msg) + "</li>"; }).join("") + "</ul>";
    } else { pb.hidden = true; pb.innerHTML = ""; }
    p.querySelector("#batch-dl").disabled = r.problems.length > 0 || r.count === 0;
  }
  p.querySelector("#batch-add").onclick = function () { state.batchRows.push({ to: "", amountQtc: "" }); draw(); upd(); };
  p.querySelector("#batch-dl").onclick = function () {
    var r = buildBatchFile(state.batchRows);
    if (!r.problems.length && r.count) downloadFile("payouts.json", r.json + "\n", p.querySelector("#batch-dl"));
  };
  draw(); upd();
}

/* ---------------- recipes (DOM) ---------------- */
function renderRecipes() {
  var box = document.getElementById("recipes");
  RECIPES.forEach(function (r) {
    var card = el("details", "recipe");
    var sum = el("summary", "", "<strong>" + esc(r.title) + "</strong><span class=\"r-steps\">" + r.steps.length + " steps</span>");
    card.appendChild(sum);
    var body = el("div", "r-body", "<p class=\"muted\">" + esc(r.desc) + "</p>");
    r.steps.forEach(function (s, i) {
      var cmdText = s.cmd;
      if (!cmdText && s.build) {
        var c = findCommand(s.build);
        var b = buildCommand(c, s.values || {}, { nodeUrl: "ws://127.0.0.1:9944" });
        cmdText = b.cmd;
      }
      var st = el("div", "r-step");
      st.innerHTML = '<div class="r-label"><span class="r-num">' + (i + 1) + "</span> " + esc(s.label) + "</div>" +
        '<pre class="terminal small">' + esc(cmdText) + "</pre>" +
        (s.note ? '<p class="r-note">' + esc(s.note) + "</p>" : "") +
        '<button class="btn small ghost r-copy" type="button">Copy step</button>';
      (function (t, btn) { btn.onclick = function () { copyText(t, btn); }; })(cmdText, st.querySelector(".r-copy"));
      body.appendChild(st);
    });
    var dl = el("button", "btn small", "Download recipe as .sh");
    dl.type = "button";
    (function (rec, btn) {
      btn.onclick = function () {
        var lines = ["#!/usr/bin/env bash", "# " + rec.title + " — QTC CLI Forge (" + SOURCE.repo + " @ " + SOURCE.rev + ")", "set -euo pipefail", ""];
        rec.steps.forEach(function (s) {
          var t = s.cmd;
          if (!t && s.build) t = buildCommand(findCommand(s.build), s.values || {}, { nodeUrl: "ws://127.0.0.1:9944" }).cmd;
          lines.push("# " + s.label);
          if (s.note) lines.push("# " + s.note);
          lines.push(t, "");
        });
        downloadFile("quantus-recipe-" + rec.id + ".sh", lines.join("\n"), btn);
      };
    })(r, dl);
    body.appendChild(dl);
    card.appendChild(body);
    box.appendChild(card);
  });
}

/* ---------------- globals form ---------------- */
function renderGlobals() {
  var box = document.getElementById("global-form");
  var html = "";
  GLOBALS.forEach(function (g) {
    if (g.kind === "bool") {
      html += '<label class="gfld"><span class="check"><input type="checkbox" data-g="' + g.f + '"> <code>' + esc(g.label) + "</code></span>" +
        '<span class="fld-help">' + esc(g.help) + "</span></label>";
    } else {
      var v = g.f === "nodeUrl" ? state.globals.nodeUrl : "";
      html += '<label class="gfld"><span class="fld-name"><code>' + esc(g.label) + "</code>" +
        (g.def ? ' <span class="def">default: ' + esc(g.def) + "</span>" : "") +
        (g.danger ? ' <span class="danger-tag">careful</span>' : "") + "</span>" +
        '<input type="text" data-g="' + g.f + '" value="' + esc(v) + '" spellcheck="false" autocomplete="off">' +
        '<span class="fld-help">' + esc(g.help) + "</span></label>";
    }
  });
  box.innerHTML = html;
  box.querySelectorAll("[data-g]").forEach(function (inp) {
    inp.addEventListener("input", refreshPreview);
    inp.addEventListener("change", refreshPreview);
  });
}

/* ---------------- init ---------------- */
function init() {
  var search = document.getElementById("cmd-search");
  search.addEventListener("input", function () { renderTree(search.value); });
  renderTree("");
  renderGlobals();
  renderBuilder();
  renderRecipes();
  var bad = catalogProblems();
  if (bad.length && window.console) console.error("catalog problems:", bad);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SOURCE: SOURCE,
    GROUPS: GROUPS,
    COMMANDS: COMMANDS,
    RECIPES: RECIPES,
    GLOBALS: GLOBALS,
    findCommand: findCommand,
    commandsInGroup: commandsInGroup,
    groupById: groupById,
    searchCommands: searchCommands,
    catalogProblems: catalogProblems,
    buildCommand: buildCommand,
    buildBatchFile: buildBatchFile,
    validateField: validateField,
    classifyAddressOrName: classifyAddressOrName,
    parseQtcToPlancks: parseQtcToPlancks,
    plancksToQtcString: plancksToQtcString,
    isValidQtcAmount: isValidQtcAmount,
    isValidUint: isValidUint,
    isValidHex: isValidHex,
    shellQuote: shellQuote,
    PLANCKS_PER_QTC: PLANCKS_PER_QTC,
  };
} else {
  document.addEventListener("DOMContentLoaded", init);
}
})();
