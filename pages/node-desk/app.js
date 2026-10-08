/* QTC Node Operator Desk — app.js */
import {
  BOOTNODES, PORTS, CHAIN_SPECS, PUBLIC_RPC,
  validateInnerHash, validateNodeName, validatePortNumber,
  buildNodeCommand, firewallRules, analyzeLog, syncProgress, fmtEta,
} from "./node-core.js";

const $ = (id) => document.getElementById(id);
const SNAP = "../../data/consensus.json";
let mode = "external";
let networkHead = null;
/* Set when the user types into the Network head field: a probe or
 * snapshot result that lands afterwards must never overwrite a manual
 * entry (the probe can take up to ~10 s — plenty of time to type). */
let netHeadEdited = false;

/* ---------- copy buttons ---------- */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) {
    navigator.clipboard.writeText(b.getAttribute("data-copy")).then(() => {
      const t = b.textContent; b.textContent = "copied ✓"; b.classList.add("done");
      setTimeout(() => { b.textContent = t; b.classList.remove("done"); }, 1400);
    }).catch(() => {});
    return;
  }
  const c = e.target.closest(".copybtn[id]");
  if (c && c.id !== "copyNodeCmd" && c.id !== "copyMinerCmd" && c.id !== "copyFw" && c.id !== "copyBoot") return;
  if (c) {
    const map = { copyNodeCmd: "nodeCmdOut", copyMinerCmd: "minerCmdOut", copyFw: "fwOut", copyBoot: "bootOut" };
    const txt = $(map[c.id]).innerText;
    navigator.clipboard.writeText(txt).then(() => {
      const t = c.textContent; c.textContent = "copied ✓"; c.classList.add("done");
      setTimeout(() => { c.textContent = t; c.classList.remove("done"); }, 1400);
    }).catch(() => {});
  }
});

/* ---------- hero + snapshot ---------- */
/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}
async function loadSnapshot() {
  try {
    const r = await fetch(SNAP, { cache: "no-store", signal: timeoutSignal(9000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const S = await r.json();
    const age = Math.max(0, Math.round((Date.now() - Date.parse(S.fetched_at)) / 60000));
    $("snapPill").textContent = `snapshot · block ${Number(S.head).toLocaleString()} · ${age}m old`;
    $("snapPill").classList.add("live");
    $("heroStats").innerHTML = `
      <div class="hstat"><div class="k">Network head</div><div class="v">${Number(S.head).toLocaleString()}</div><div class="s">via builder snapshot · ${age}m old</div></div>
      <div class="hstat"><div class="k">P2P port</div><div class="v">30333 <small>/tcp</small></div><div class="s">the only public port</div></div>
      <div class="hstat"><div class="k">Block target</div><div class="v">12 <small>s</small></div><div class="s">Homestead-style retarget</div></div>
      <div class="hstat"><div class="k">Freshness gate</div><div class="v">24 <small>h</small></div><div class="s">--max-tip-age before mining</div></div>`;
  } catch (e) {
    $("snapPill").textContent = "snapshot unavailable — protocol constants only";
    $("heroStats").innerHTML = `
      <div class="hstat"><div class="k">P2P port</div><div class="v">30333 <small>/tcp</small></div><div class="s">the only public port</div></div>
      <div class="hstat"><div class="k">Block target</div><div class="v">12 <small>s</small></div><div class="s">Homestead-style retarget</div></div>`;
  }
}

/* ---------- launch lab ---------- */
function readLaunch() {
  return {
    name: $("inName").value, mode,
    innerHash: $("inHash").value,
    minerListenPort: $("inMPort").value,
    chain: $("inChain").value,
    nodeKeyFile: $("inKeyFile").value, basePath: $("inBase").value,
    validator: $("inValidator").checked,
    forceAuthoring: $("inForce").checked,
    experimentalRpc: $("inExpRpc").checked,
    prometheusPort: $("inProm").value || null,
    miner: {
      authTokenFile: $("inAuthFile").value, tlsCertFile: $("inTlsFile").value,
      cpuWorkers: Number($("inCpu").value) || null, gpuDevices: Number($("inGpu").value) || null,
      cuda: $("inCuda").checked, metricsPort: null,
    },
  };
}

function markField(id, res) {
  const f = $(id);
  if (!res) return;
  f.classList.toggle("invalid", !res.ok);
  const e = f.querySelector(".err");
  if (e) e.textContent = res.ok ? "" : res.error;
}

function renderLaunch() {
  const o = readLaunch();
  // live field validation
  markField("f-name", validateNodeName(o.name));
  if (mode !== "fullnode") markField("f-hash", validateInnerHash(o.innerHash));
  else { $("f-hash").classList.remove("invalid"); }
  if (mode === "external") markField("f-mport", validatePortNumber(o.minerListenPort, "Miner listen port"));
  else { $("f-mport").classList.remove("invalid"); }

  const r = buildNodeCommand(o);
  const errBox = $("cmdErrors"), warnBox = $("cmdWarnings");
  if (r.errors.length) {
    errBox.hidden = false;
    errBox.querySelector("ul").innerHTML = r.errors.map(e => `<li>${e}</li>`).join("");
  } else errBox.hidden = true;

  if (r.cmd) {
    $("nodeCmdOut").innerHTML = `<span class="g">$</span> ` + escapeHtml(r.cmd);
  } else {
    $("nodeCmdOut").innerHTML = `<span class="c"># fix the errors above — no command generated</span>`;
  }
  if (r.minerCmd) {
    $("minerTerm").style.display = "";
    $("minerCmdOut").innerHTML = `<span class="g">$</span> ` + escapeHtml(r.minerCmd);
  } else $("minerTerm").style.display = "none";

  if (r.warnings.length) {
    warnBox.hidden = false;
    warnBox.querySelector("ul").innerHTML = r.warnings.map(w => `<li>${w}</li>`).join("");
  } else warnBox.hidden = true;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

$("modeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  mode = b.dataset.mode;
  for (const x of $("modeSeg").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  const mining = mode !== "fullnode";
  $("f-hash").style.opacity = mining ? 1 : 0.45;
  $("f-mport").style.opacity = mode === "external" ? 1 : 0.45;
  renderLaunch();
});
document.querySelectorAll("#sec-launch input, #sec-launch select").forEach(el =>
  el.addEventListener("input", renderLaunch));

/* ---------- ports + firewall ---------- */
function renderPorts() {
  $("portTable").querySelector("tbody").innerHTML = PORTS.map(p => `
    <tr><td class="mono">${p.port}</td><td class="mono">${p.proto}</td><td>${p.service}</td>
    <td class="${p.expose.startsWith("PUBLIC") ? "expose-pub" : "expose-local"}">${p.expose}</td>
    <td class="mono" style="font-size:12px;color:var(--nd-dim)">${p.src}</td></tr>`).join("");
}
function renderFw() {
  try {
    $("fwOut").textContent = firewallRules($("fwTool").value, $("fwP2p").value || 30333);
  } catch (e) { $("fwOut").textContent = "# " + e.message; }
}
$("fwTool").addEventListener("change", renderFw);
$("fwP2p").addEventListener("input", renderFw);

/* ---------- bootnodes ---------- */
function renderBootnodes() {
  $("bootList").innerHTML = BOOTNODES.map((b, i) => `
    <div class="bootnode"><span class="bn">a${i + 1}</span><code title="${b}">${b}</code>
    <button class="copybtn" data-copy="${b}">copy</button></div>`).join("");
  $("bootOut").textContent = "--bootnodes " + BOOTNODES.map(b => `"${b}"`).join(" \\\n  ");
}

/* ---------- sync monitor ---------- */
function probeRpc() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (h) => { if (!done) { done = true; resolve(h); } };
    try {
      const ws = new WebSocket(PUBLIC_RPC);
      const to = setTimeout(() => { try { ws.close(); } catch (e) {} finish(null); }, 9000);
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_getHeader", params: [] }));
      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          const n = parseInt(d.result && d.result.number, 16);
          clearTimeout(to); try { ws.close(); } catch (e) {}
          finish(Number.isFinite(n) ? n : null);
        } catch (e) { clearTimeout(to); finish(null); }
      };
      ws.onerror = () => { clearTimeout(to); finish(null); };
    } catch (e) { finish(null); }
    setTimeout(() => finish(null), 10000);
  });
}

async function initSync() {
  const netInput = $("inNetH");
  /* A manual entry typed while an await below was in flight wins over
   * the late result: keep the field (and the networkHead the input
   * listener already adopted from it), and report the superseded
   * result in the source line instead of silently applying it. A
   * field the user edited back to empty has nothing to protect. */
  const userKept = () => netHeadEdited && netInput.value.trim() !== "";
  const h = await probeRpc();
  if (h) {
    if (userKept()) {
      $("netSrc").innerHTML = `Live probe found head ${h.toLocaleString()} via <code>chain_getHeader</code> — keeping your manual entry ${Number(netInput.value).toLocaleString()}; clear the field and reload to use the probe.`;
    } else {
      networkHead = h;
      netInput.value = h;
      netInput.placeholder = "";
      $("netSrc").innerHTML = `Live from <code>${PUBLIC_RPC}</code> via <code>chain_getHeader</code> — just now.`;
    }
  } else {
    try {
      const r = await fetch(SNAP, { cache: "no-store", signal: timeoutSignal(9000) });
      const S = await r.json();
      const snapHead = Number(S.head);
      const age = Math.max(0, Math.round((Date.now() - Date.parse(S.fetched_at)) / 60000));
      if (userKept()) {
        $("netSrc").innerHTML = `Public RPC unreachable — builder snapshot reports head ${snapHead.toLocaleString()} (${age}m old), but keeping your manual entry ${Number(netInput.value).toLocaleString()}; clear the field and reload to use the snapshot.`;
      } else {
        networkHead = snapHead;
        netInput.value = networkHead;
        $("netSrc").innerHTML = `Public RPC unreachable from this browser — using builder snapshot (block ${networkHead.toLocaleString()}, ${age}m old). You can also type the head manually.`;
      }
    } catch (e) {
      $("netSrc").innerHTML = `Public RPC unreachable and no snapshot — type the network head manually (see the <a href="https://explorer.quantus.com/" target="_blank" rel="noopener">explorer</a>).`;
      if (!userKept()) netInput.placeholder = "e.g. 142417";
    }
  }
  renderSync();
}

function renderSync() {
  const l = $("inLocalH").value, n = networkHead || Number($("inNetH").value) || null;
  if (n && !$("inNetH").value) $("inNetH").value = n;
  const s = (l !== "" && n) ? syncProgress(l, n) : null;
  if (!s) {
    $("syncStat").innerHTML = `— <small>blocks behind</small>`;
    $("syncEta").textContent = "Enter your node's best block to estimate sync progress.";
    $("syncFill").style.width = "0%";
    return;
  }
  $("syncFill").style.width = s.pct.toFixed(2) + "%";
  $("syncStat").innerHTML = `${s.behind.toLocaleString()} <small>blocks behind · ${s.pct.toFixed(2)}% synced</small>`;
  $("syncEta").textContent = s.synced
    ? "Caught up — the log should read Idle. The 24 h freshness gate (--max-tip-age) must still pass before mining starts."
    : `At the 12 s block target, roughly ${fmtEta(s.etaMin)} to catch up (assuming your node keeps pace with the tip).`;
}
$("inLocalH").addEventListener("input", renderSync);
$("inNetH").addEventListener("input", () => { netHeadEdited = true; networkHead = Number($("inNetH").value) || null; renderSync(); });

/* ---------- log forensics ---------- */
function renderLog() {
  const a = analyzeLog($("logInput").value);
  $("logSummary").textContent = a.total === 0
    ? "No input yet."
    : `Scanned ${a.total} line${a.total === 1 ? "" : "s"} — ${a.findings.length} known pattern${a.findings.length === 1 ? "" : "s"} matched.`;
  const sevName = { ok: "ok", info: "info", warn: "warn", error: "error" };
  $("logFindings").innerHTML = a.findings.map(f => `
    <div class="finding">
      <div class="fh"><span class="sev ${f.level}">${sevName[f.level]}</span><h4>${escapeHtml(f.title)}</h4>
      <span class="cnt">×${f.count}</span></div>
      <p>${escapeHtml(f.detail)}</p>
      ${f.fix ? `<p class="fix">${escapeHtml(f.fix)}</p>` : ""}
    </div>`).join("");
}
$("logInput").addEventListener("input", renderLog);

/* ---------- chain specs ---------- */
function renderSpecs() {
  $("specTable").querySelector("tbody").innerHTML = CHAIN_SPECS.map(c => `
    <tr><td class="mono">--chain ${c.id}</td><td class="mono">${c.token}</td>
    <td class="mono">${c.decimals}</td><td class="mono">${c.ss58}</td><td>${c.note}</td></tr>`).join("");
}

/* ---------- init ---------- */
renderPorts(); renderFw(); renderBootnodes(); renderSpecs(); renderLaunch(); renderLog();
loadSnapshot(); initSync();
