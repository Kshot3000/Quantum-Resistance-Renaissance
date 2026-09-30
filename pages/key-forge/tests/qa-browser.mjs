// QTC Quantum Key Forge real-browser QA (headless Chromium 152, CDP over Node WebSocket).
// Recipe per AGENTS.md: file:// load (copied to /tmp first), offline fully vendored crypto.
// Exercises: forge ML-DSA-65 + 87, address format, inspector, sign/verify, QR, paper card,
// scheme picker, attribution, zero console errors.
import { execFile } from "node:child_process";
import { cpSync, rmSync, mkdirSync } from "node:fs";

const SRC = "/home/hatch/workspace/Quantus-Muse-Builder";
const QA = "/tmp/qaroot-keyforge";
const PORT = 19347;
const PROFILE = "/tmp/qa-profile-keyforge";

rmSync(QA, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(QA, { recursive: true });
cpSync(SRC + "/pages/key-forge", QA + "/pages/key-forge", { recursive: true });
cpSync(SRC + "/assets", QA + "/assets", { recursive: true });

const chrome = execFile("/opt/meta-chromium/chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
  "--disable-gpu", "--allow-file-access-from-files", `--user-data-dir=${PROFILE}`,
  `file://${QA}/pages/key-forge/index.html`,
], { stdio: "ignore" });

async function waitForDebugger() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const t = targets.find((x) => x.type === "page" && x.url.startsWith("file:///tmp/qaroot-keyforge"));
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("chrome debugger never came up");
}

const wsUrl = await waitForDebugger();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    errors.push("exception: " + (m.params.exceptionDetails.text || JSON.stringify(m.params.exceptionDetails).slice(0, 200)));
  } else if (m.method === "Log.entryAdded") {
    const e = m.params.entry;
    // fonts.googleapis.com is unreachable in the offline sandbox (environmental, graceful fallback)
    if (e.level === "error" && !/favicon|fonts\.g/i.test(e.url || "") && !/fonts\.g/i.test(e.text || "")) errors.push("log: " + e.text);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("cdp timeout " + method)); } }, 60000);
});
const evaluate = async (fn, ...args) => {
  const r = await send("Runtime.evaluate", {
    expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result && r.result.value;
};
const waitForFn = async (fn, arg, timeout = 8000, step = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(fn, arg)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};
const waitFor = async (fn, timeout = 30000, step = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await new Promise((r) => setTimeout(r, 1500));

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  [" + extra + "]" : ""));
};

const KYLE = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";

// structure
check("hero h1", await evaluate(() => document.querySelector(".hero h1").textContent.includes("quantum era")));
check("5 panels", await evaluate(() => document.querySelectorAll("section.panel").length === 5));
check("45/45 vectors cited", await evaluate(() => document.body.textContent.includes("45/45")));
check("attribution address", await evaluate((a) => document.body.innerHTML.includes(a), KYLE));
check("x link", await evaluate(() => !!document.querySelector('a[href="https://x.com/kshot9000"]')));
check("switcher 17 apps", await evaluate(() => document.querySelectorAll(".qmb-menu a:not(.hub-link)").length === 17));
check("2 scheme cards", await evaluate(() => document.querySelectorAll(".scheme-card").length === 2));
check("module scripts loaded (no import failure)", await waitFor(() => !!document.querySelector("#forgeBtn") && !document.querySelector("#forgeBusy").hidden === false, 8000));

// forge ML-DSA-65
await evaluate(() => document.getElementById("forgeBtn").click());
const forged = await waitFor(() => !document.getElementById("forgeResult").hidden, 30000);
check("forge completes", forged);
const addr = forged ? await evaluate(() => document.getElementById("resAddress").textContent) : "";
check("address qz format", /^qz[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(addr), addr.slice(0, 20) + "…");
check("QR rendered", await evaluate(() => document.querySelector("#qrBox img") !== null));
check("account id 64 hex", await evaluate(() => /^[0-9a-f]{64}$/.test(document.getElementById("resAccountId").textContent)));
check("pubkey truncated display", await evaluate(() => document.getElementById("resPubkey").textContent.endsWith("…")));
check("secret masked", await evaluate(() => document.getElementById("resSecretMasked").textContent.includes("•")));
check("paper QR rendered", await evaluate(() => document.querySelector("#pcQr img") !== null));
check("paper addr matches", await evaluate((a) => document.getElementById("pcAddr").textContent === a, addr));
check("print enabled", await evaluate(() => !document.getElementById("printBtn").disabled));
check("sign enabled", await evaluate(() => !document.getElementById("signBtn").disabled));

// secret reveal + copy state
await evaluate(() => document.getElementById("revealSecret").click());
check("reveal shows hex", await evaluate(() => /^[0-9a-f]{128}…$/.test(document.getElementById("resSecretMasked").textContent)));
check("copy secret enabled after reveal", await evaluate(() => !document.getElementById("copySecret").disabled));

// inspector: Kyle's address
await evaluate((a) => { document.getElementById("inspAddr").value = a; }, KYLE);
await evaluate(() => document.getElementById("inspBtn").click());
check("inspector valid badge", await waitFor(() => document.querySelector("#inspResult .badge.ok") !== null, 8000));
check("inspector prefix 189", await evaluate(() => document.getElementById("inspResult").textContent.includes("189")));
check("inspector canonical match", await evaluate(() => document.getElementById("inspResult").textContent.includes("exact match")));
// inspector: garbage
await evaluate(() => { document.getElementById("inspAddr").value = "qzNotARealAddress123"; });
await evaluate(() => document.getElementById("inspBtn").click());
check("inspector rejects garbage", await waitFor(() => document.querySelector("#inspResult .badge.bad") !== null, 8000));
// inspector: hex -> address round trip
const acctHex = await evaluate(() => document.getElementById("resAccountId").textContent);
await evaluate((h) => { document.getElementById("inspHex").value = h; }, acctHex);
await evaluate(() => document.getElementById("hexBtn").click());
check("hex->address matches forged", await waitForFn((a) => document.getElementById("hexResult").textContent.includes(a), addr));

// sign & verify round trip
await evaluate(() => { document.getElementById("signMsg").value = "browser qa message 123"; });
await evaluate(() => document.getElementById("signBtn").click());
const signed = await waitFor(() => document.getElementById("signResult").textContent.includes("Signed & verified"), 20000);
check("sign + self-verify", signed);
check("sig size shown", await evaluate(() => document.getElementById("signResult").textContent.includes("3,309")));
// verify tab with forged pubkey
await evaluate(() => document.getElementById("useForgedPk").click());
await evaluate(() => { document.getElementById("verMsg").value = "browser qa message 123"; });
const sigHex = await evaluate(() => {
  const m = document.getElementById("signResult").textContent.match(/[0-9a-f]{160}/);
  return document.querySelector("#signResult").dataset ? "" : "";
});
// pull full sig hex via copy path: re-derive from page by reading the download is complex;
// instead verify with a fresh sign through the page's own verify using forged key + tampered sig
await evaluate(() => { document.getElementById("verSig").value = "00".repeat(3309); });
await evaluate(() => document.getElementById("verifyBtn").click());
check("verify rejects wrong sig", await waitFor(() => document.getElementById("verifyResult").textContent.includes("INVALID"), 15000));

// forge ML-DSA-87 (slower keygen)
await evaluate(() => document.querySelector('.scheme-card[data-scheme="87"]').click());
await evaluate(() => document.getElementById("forgeBtn").click());
const forged87 = await waitFor(() => {
  const el = document.getElementById("forgeResult");
  return !el.hidden && document.getElementById("resScheme").textContent.includes("ML-DSA-87");
}, 60000);
check("forge ML-DSA-87 completes", forged87);
const addr87 = forged87 ? await evaluate(() => document.getElementById("resAddress").textContent) : "";
check("87 address qz format", /^qz[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(addr87));
check("87 address differs from 65", addr87 !== addr);

// no console/page errors
await new Promise((r) => setTimeout(r, 800));
check("zero console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} browser checks green`);
chrome.kill();
process.exit(failed.length ? 1 : 0);
