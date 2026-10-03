// QTC SafeSend Lab real-browser QA (headless Chromium 152, CDP over Node WebSocket).
// Recipe per AGENTS.md: loopback BLOCKED -> load page via file:// (copy app + assets
// to /tmp first: repo files are root:nogroup 0660). No network egress -> page must
// work fully offline (vendored SHA-256/PBKDF2, local wordlist, no CDN).
// Exercises: checkphrase verifier (derive + poisoning demo), transfer simulator
// (schedule/cancel/execute/validation), call reference, attribution, zero errors.
import { execFile } from "node:child_process";
import { cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";

const SRC = "/home/hatch/workspace/Quantus-Muse-Builder";
const QA = "/tmp/qaroot-safesend";
const PORT = 19341;
const PROFILE = "/tmp/qa-profile-safesend";

rmSync(QA, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(QA, { recursive: true });
cpSync(SRC + "/pages/safesend", QA + "/pages/safesend", { recursive: true });
cpSync(SRC + "/assets", QA + "/assets", { recursive: true });

const chrome = execFile("/opt/meta-chromium/chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
  "--disable-gpu", `--user-data-dir=${PROFILE}`,
  `file://${QA}/pages/safesend/index.html`,
], { stdio: "ignore" });

async function waitForDebugger() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const t = targets.find((x) => x.type === "page" && x.url.startsWith("file:///tmp/qaroot-safesend"));
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
    // fonts.googleapis.com excluded like every other fleet harness: the
    // sandbox has no direct egress, so shared.css's @import fails there
    // (ERR_EMPTY_RESPONSE) while loading fine for real visitors.
    if (e.level === "error" && !/favicon/i.test(e.url || "") && !/fonts\.googleapis\.com/i.test(e.url || ""))
      errors.push("log: " + e.text + (e.url ? " [" + e.url + "]" : ""));
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("cdp timeout " + method)); } }, 30000);
});
const evaluate = async (fn, ...args) => {
  const r = await send("Runtime.evaluate", {
    expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result && r.result.value;
};
const waitFor = async (fn, timeout = 25000, step = 400) => {
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
check("hero h1", await evaluate(() => document.querySelector(".hero h1").textContent.includes("it matters")));
check("4 panels", await evaluate(() => document.querySelectorAll("section.panel").length === 4));
check("verNote mentions 1,171 vectors", await evaluate(() => document.getElementById("verNote").textContent.includes("1,171")));
check("attribution address", await evaluate((a) => document.body.innerHTML.includes(a), KYLE));
check("x link", await evaluate(() => !!document.querySelector('a[href="https://x.com/kshot9000"]')));
check("5 call rows", await evaluate(() => document.querySelectorAll("table.calls tbody tr").length === 5));
// De-pinned (2026-10-03): switcher size derives from the fleet (page dirs);
// the hard-coded 8 dated from a much smaller fleet and failed every run since.
const fleetCount = readdirSync(SRC + "/pages", { withFileTypes: true }).filter((d) => d.isDirectory()).length;
check(`switcher has ${fleetCount} apps`, await evaluate((n) => document.querySelectorAll(".qmb-menu a:not(.hub-link)").length === n, fleetCount));

// verifier: derive Kyle's phrase
await evaluate((a) => { const t = document.getElementById("addrInput"); t.value = a; }, KYLE);
await evaluate(() => document.getElementById("deriveBtn").click());
const got = await waitFor(() => {
  const ws = [...document.querySelectorAll("#wordRow .word")];
  return ws.length === 5 && ws.every((w) => w.textContent.trim().length > 2 && w.textContent !== "—") &&
    !document.getElementById("deriveBtn").disabled;
});
check("derive produces 5 words", got);
const phrase1 = got ? await evaluate(() => [...document.querySelectorAll("#wordRow .word")].map((w) => w.textContent).join("-")) : "";
check("phrase non-trivial", phrase1.split("-").length === 5 && new Set(phrase1.split("-")).size >= 3, phrase1);

// determinism: derive again -> same phrase
await evaluate(() => document.getElementById("deriveBtn").click());
await waitFor(() => !document.getElementById("deriveBtn").disabled);
const phrase2 = await evaluate(() => [...document.querySelectorAll("#wordRow .word")].map((w) => w.textContent).join("-"));
check("derivation deterministic", phrase1 === phrase2, phrase1);

// poisoning demo: one-char tamper -> different phrase
await evaluate(() => document.getElementById("poisonBtn").click());
const pois = await waitFor(() => {
  const ws = [...document.querySelectorAll("#tampWords .word")];
  return ws.length === 5 && ws.every((w) => w.textContent.trim().length > 2);
});
check("poison demo derives", pois);
const phraseP = pois ? await evaluate(() => [...document.querySelectorAll("#tampWords .word")].map((w) => w.textContent).join("-")) : "";
check("tampered phrase differs", phraseP !== phrase1, phraseP);
check("tampered char highlighted", await evaluate(() => !!document.querySelector("#tampAddr .mut")));

// genesis example button fills input
await evaluate(() => document.getElementById("exGenesis").click());
check("genesis example fills", await evaluate(() => document.getElementById("addrInput").value.startsWith("qzka7DZXAT")));

// simulator: validation
await evaluate(() => { document.getElementById("simAddr").value = "qzkTestRecipient123"; document.getElementById("simAmt").value = "100"; document.getElementById("customBlocks").value = "1"; document.getElementById("customBlocks").dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("scheduleBtn").click(); });
check("1-block delay rejected", await evaluate(() => !document.getElementById("simErr").hidden && document.getElementById("simErr").textContent.includes("≥ 2")));

// simulator: schedule 50-block (10 min preset) and cancel mid-window
await evaluate(() => { document.getElementById("customBlocks").value = ""; document.querySelector('.preset[data-blocks="50"]').click(); document.getElementById("scheduleBtn").click(); });
await new Promise((r) => setTimeout(r, 3500));
const cdA = await evaluate(() => document.getElementById("cdNum").textContent);
check("countdown ticking", /^\d/.test(cdA) && cdA !== "50", cdA);
check("scheduled logged", await evaluate(() => document.getElementById("simLog").textContent.includes("SCHEDULED")));
check("rail shows real wall-clock", await evaluate(() => document.getElementById("railDelay").textContent.includes("50 blocks")));
await evaluate(() => document.getElementById("cancelBtn").click());
await new Promise((r) => setTimeout(r, 400));
check("cancel -> CANCELLED", await evaluate(() => document.querySelector('.tl-step[data-s="done"] .lbl').textContent === "Cancelled"));
check("cancel returns full amount", await evaluate(() => document.getElementById("simLog").textContent.includes("full") && document.getElementById("simLog").textContent.includes("No reversal fee")));

// simulator: 4-block custom -> runs to execution
await evaluate(() => document.getElementById("resetBtn").click());
await new Promise((r) => setTimeout(r, 300));
await evaluate(() => { document.getElementById("customBlocks").value = "4"; document.getElementById("customBlocks").dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("scheduleBtn").click(); });
const execd = await waitFor(() => document.querySelector('.tl-step[data-s="done"] .lbl').textContent === "Executed", 20000);
check("4-block window executes", execd);
check("execution logged", await evaluate(() => document.getElementById("simLog").textContent.includes("Scheduler pallet executed")));

// footer copy button
await evaluate(() => document.querySelector("footer .addr").click());
await new Promise((r) => setTimeout(r, 300));
check("copy button feedback", await evaluate(() => document.querySelector("footer .addr").textContent.includes("copied")));

check("zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await send("Page.captureScreenshot", { format: "png" }).then(async (r) => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/qa-safesend.png", Buffer.from(r.data, "base64"));
  console.log("PASS screenshot saved /tmp/qa-safesend.png");
}).catch((e) => console.log("FAIL screenshot " + e.message));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} browser checks passed`);
chrome.kill();
process.exit(failed.length ? 1 : 0);
