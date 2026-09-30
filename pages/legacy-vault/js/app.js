/* QTC Legacy Vault — UI wiring. Requires QTC_SHAMIR + QTC_LEGACY_LOGIC. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SHAMIR = window.QTC_SHAMIR;
  const LOGIC = window.QTC_LEGACY_LOGIC;
  const LS_KEY = "qlv-plan-v1";

  // ---------- ember canvas ----------
  (function embers() {
    const c = $("embers");
    if (!c) return;
    const x = c.getContext("2d");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W, H, parts = [];
    function size() {
      W = c.width = window.innerWidth; H = c.height = window.innerHeight;
    }
    size(); window.addEventListener("resize", size);
    const N = reduced ? 0 : 70;
    for (let i = 0; i < N; i++) parts.push({
      x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
      r: 0.6 + Math.random() * 2.2, s: 0.15 + Math.random() * 0.5,
      drift: (Math.random() - 0.5) * 0.3, a: 0.15 + Math.random() * 0.5,
      hue: 30 + Math.random() * 15,
    });
    (function tick() {
      x.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.y -= p.s; p.x += p.drift;
        if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
        x.beginPath();
        x.fillStyle = `hsla(${p.hue},80%,60%,${p.a * 0.5})`;
        x.arc(p.x, p.y, p.r, 0, 7);
        x.fill();
      }
      if (!reduced) requestAnimationFrame(tick);
    })();
  })();

  // ---------- tabs ----------
  document.querySelectorAll(".tabnav button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabnav button").forEach((o) => o.classList.remove("active"));
      document.querySelectorAll(".tabpage").forEach((p) => p.classList.remove("active"));
      b.classList.add("active");
      $("tab-" + b.dataset.tab).classList.add("active");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  // ---------- copy buttons ----------
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const v = btn.getAttribute("data-copy");
      try { await navigator.clipboard.writeText(v); }
      catch (e) {
        const ta = document.createElement("textarea");
        ta.value = v; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
      }
      const tag = btn.parentElement.querySelector(".copied");
      if (tag) { tag.hidden = false; setTimeout(() => (tag.hidden = true), 1800); }
    });
  });
  function copyText(v, btn) {
    const done = () => { const t = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = t), 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done);
    else {
      const ta = document.createElement("textarea"); ta.value = v;
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove(); done();
    }
  }

  // ================= SHAMIR LAB =================
  const shN = $("sh-n"), shT = $("sh-t"), shHint = $("sh-hint");
  function syncT() {
    const n = parseInt(shN.value, 10);
    [...shT.options].forEach((o) => { o.disabled = parseInt(o.value, 10) > n; });
    if (parseInt(shT.value, 10) > n) shT.value = String(n);
    shHint.innerHTML = `Splitting into <strong>${n}</strong> shares — any <strong>${shT.value}</strong> of them recover the secret.`;
  }
  shN.addEventListener("change", syncT); shT.addEventListener("change", syncT); syncT();

  let lastShares = [];
  $("sh-split").addEventListener("click", () => {
    const secret = $("sh-secret").value;
    const out = $("sh-out");
    out.innerHTML = "";
    try {
      lastShares = SHAMIR.splitText(secret, parseInt(shN.value, 10), parseInt(shT.value, 10));
    } catch (e) {
      out.innerHTML = `<div class="msg err">${LOGIC.esc(e.message)}</div>`;
      $("sh-actions").hidden = true;
      return;
    }
    lastShares.forEach((s, i) => {
      const p = SHAMIR.parseShare(s);
      const d = document.createElement("div");
      d.className = "share-card";
      const head = document.createElement("div"); head.className = "sh-head";
      const strong = document.createElement("strong");
      strong.textContent = `Share ${p.index} of ${p.n} (threshold ${p.t})`;
      const cb = document.createElement("button"); cb.className = "btn ghost"; cb.textContent = "Copy";
      cb.addEventListener("click", () => copyText(s, cb));
      head.appendChild(strong); head.appendChild(cb);
      const code = document.createElement("code"); code.textContent = s;
      d.appendChild(head); d.appendChild(code);
      out.appendChild(d);
    });
    $("sh-actions").hidden = false;
  });

  $("sh-copyall").addEventListener("click", (e) => copyText(lastShares.join("\n"), e.target));
  $("sh-wipe").addEventListener("click", () => {
    $("sh-secret").value = ""; $("sh-out").innerHTML = "";
    $("sh-recovered").hidden = true; lastShares = [];
    $("sh-actions").hidden = true;
  });
  $("sh-print").addEventListener("click", () => {
    if (!lastShares.length) return;
    const cards = lastShares.map((s) => {
      const p = SHAMIR.parseShare(s);
      return `<div class="share-card"><strong>Legacy Vault — share ${p.index} of ${p.n} (need ${p.t} to recover)</strong>` +
        `<div class="cut"></div><code>${LOGIC.esc(s)}</code>` +
        `<p>Store this card alone, sealed, somewhere physically separate from the other shares. Never photograph it.</p></div>`;
    }).join('<div class="cut"></div>');
    showPrint(`<h1>Legacy Vault — secret shares</h1>
      <p>Generated ${new Date().toISOString().slice(0, 10)}. Any ${SHAMIR.parseShare(lastShares[0]).t} of these ${lastShares.length} shares recover the secret. Guard each card like a key.</p>
      <div class="cut"></div>${cards}
      <div class="warn"><strong>After printing:</strong> wipe the secret from the Shamir Lab tab, shred misprints, clear your clipboard.</div>`);
    window.print();
  });

  $("sh-combine").addEventListener("click", () => {
    const lines = $("sh-combine-in").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const box = $("sh-recovered");
    try {
      const rec = SHAMIR.combineText(lines);
      $("sh-recovered-text").textContent = rec;
      box.hidden = false;
    } catch (e) {
      box.hidden = false;
      $("sh-recovered-text").textContent = "Could not recover: " + e.message;
    }
  });
  $("sh-copyrec").addEventListener("click", (e) => copyText($("sh-recovered-text").textContent, e.target));
  $("sh-tamper").addEventListener("click", () => {
    if (!lastShares.length) {
      $("sh-combine-in").value = "";
      alert("Split a secret first — the demo corrupts one of your fresh shares.");
      return;
    }
    const s = lastShares[0];
    const pos = s.lastIndexOf("-") + 3; // flip a hex char inside the payload
    const ch = s[pos] === "a" ? "b" : "a";
    const bad = s.slice(0, pos) + ch + s.slice(pos + 1);
    $("sh-combine-in").value = [bad, ...lastShares.slice(1, SHAMIR.parseShare(s).t)].join("\n");
    $("sh-combine").click();
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "One character was flipped in share #1 before recovery. Compare with the original secret above — this is why shares must be stored where they can't be silently altered.";
    $("sh-recovered").appendChild(note);
  });

  // ================= PLAN =================
  let plan = loadPlan();
  function loadPlan() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      return {
        beneficiaries: Array.isArray(p.beneficiaries) ? p.beneficiaries : [],
        holdings: Array.isArray(p.holdings) ? p.holdings : [],
        deadmanChoice: p.deadmanChoice || "",
        deadmanText: p.deadmanText || "",
        checks: Array.isArray(p.checks) ? p.checks : [],
        owner: p.owner || "",
        extra: p.extra || "",
      };
    } catch (e) { return { beneficiaries: [], holdings: [], deadmanChoice: "", deadmanText: "", checks: [], owner: "", extra: "" }; }
  }
  function savePlan() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(plan)); } catch (e) {}
  }

  const DEADMAN_LABELS = {
    trusted: "Trusted person + sealed instructions",
    lawyer: "Lawyer-held letter",
    checkin: "Periodic check-in",
    shares: "Distributed shares",
  };

  function renderBens() {
    const tb = $("ben-body"); tb.innerHTML = "";
    plan.beneficiaries.forEach((b, i) => {
      const tr = document.createElement("tr");
      const fields = [
        ["name", "text", "Full name"], ["relation", "text", "e.g. spouse"],
        ["sharePct", "number", "%"], ["contact", "text", "Phone / email"], ["notes", "text", "Notes"],
      ];
      fields.forEach(([k, type, ph]) => {
        const td = document.createElement("td");
        if (k === "sharePct") td.className = "num";
        const inp = document.createElement("input");
        inp.type = type; inp.placeholder = ph; inp.value = b[k] || "";
        if (type === "number") { inp.min = "0"; inp.max = "100"; inp.step = "any"; }
        inp.setAttribute("aria-label", `${ph} for beneficiary ${i + 1}`);
        inp.addEventListener("input", () => { plan.beneficiaries[i][k] = inp.value; savePlan(); validatePlan(); });
        td.appendChild(inp); tr.appendChild(td);
      });
      const td = document.createElement("td");
      const del = document.createElement("button");
      del.className = "rowdel"; del.textContent = "✕"; del.setAttribute("aria-label", `Remove beneficiary ${i + 1}`);
      del.addEventListener("click", () => { plan.beneficiaries.splice(i, 1); savePlan(); renderBens(); validatePlan(); });
      td.appendChild(del); tr.appendChild(td);
      tb.appendChild(tr);
    });
  }
  $("ben-add").addEventListener("click", () => {
    plan.beneficiaries.push({ name: "", relation: "", sharePct: "", contact: "", notes: "" });
    savePlan(); renderBens(); validatePlan();
  });

  function renderHoldings() {
    const tb = $("hold-body"); tb.innerHTML = "";
    plan.holdings.forEach((h, i) => {
      const tr = document.createElement("tr");
      [["item", "e.g. Share #1 of seed"], ["location", "e.g. bank box #412"], ["access", "e.g. box key with lawyer"]].forEach(([k, ph]) => {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.type = "text"; inp.placeholder = ph; inp.value = h[k] || "";
        inp.setAttribute("aria-label", `${ph} for holding ${i + 1}`);
        inp.addEventListener("input", () => { plan.holdings[i][k] = inp.value; savePlan(); validatePlan(); });
        td.appendChild(inp); tr.appendChild(td);
      });
      const td = document.createElement("td");
      const del = document.createElement("button");
      del.className = "rowdel"; del.textContent = "✕"; del.setAttribute("aria-label", `Remove holding ${i + 1}`);
      del.addEventListener("click", () => { plan.holdings.splice(i, 1); savePlan(); renderHoldings(); validatePlan(); });
      td.appendChild(del); tr.appendChild(td);
      tb.appendChild(tr);
    });
  }
  $("hold-add").addEventListener("click", () => {
    plan.holdings.push({ item: "", location: "", access: "" });
    savePlan(); renderHoldings(); validatePlan();
  });

  function validatePlan() {
    const bv = LOGIC.validateBeneficiaries(plan.beneficiaries);
    const hv = LOGIC.validateHoldings(plan.holdings);
    const errs = [...bv.errors, ...hv.errors];
    const warns = [...bv.warnings, ...hv.warnings];
    const bm = $("ben-msg"), hm = $("hold-msg");
    if (errs.length) {
      bm.className = "msg err"; bm.textContent = errs[0];
    } else if (bv.warnings.length) {
      bm.className = "msg warn"; bm.textContent = bv.warnings[0];
    } else if (plan.beneficiaries.length) {
      bm.className = "msg ok"; bm.textContent = `✓ ${plan.beneficiaries.length} ${plan.beneficiaries.length === 1 ? "beneficiary" : "beneficiaries"} · shares total ${bv.totalPct}%`;
    } else { bm.className = "msg"; bm.textContent = ""; }
    if (hv.errors.length) { hm.className = "msg err"; hm.textContent = hv.errors[0]; }
    else if (hv.warnings.length) { hm.className = "msg warn"; hm.textContent = hv.warnings[0]; }
    else { hm.className = "msg"; hm.textContent = ""; }
  }

  // dead-man radios
  document.querySelectorAll('#deadman-radios input[name="deadman"]').forEach((r) => {
    r.addEventListener("change", () => { plan.deadmanChoice = r.value; savePlan(); });
  });
  $("deadman-text").addEventListener("input", (e) => { plan.deadmanText = e.target.value; savePlan(); });

  // checklist + score
  function renderChecks() {
    const box = $("checklist"); box.innerHTML = "";
    LOGIC.CHECKLIST.forEach((c) => {
      const lab = document.createElement("label");
      const inp = document.createElement("input");
      inp.type = "checkbox"; inp.checked = plan.checks.includes(c.id);
      inp.addEventListener("change", () => {
        plan.checks = inp.checked ? [...plan.checks, c.id] : plan.checks.filter((x) => x !== c.id);
        savePlan(); renderScore();
      });
      const sp = document.createElement("span"); sp.textContent = c.label;
      const w = document.createElement("span"); w.className = "w"; w.textContent = `×${c.weight}`;
      lab.appendChild(inp); lab.appendChild(sp); lab.appendChild(w);
      box.appendChild(lab);
    });
    renderScore();
  }
  function renderScore() {
    const s = LOGIC.readinessScore(plan.checks);
    $("score-fill").style.width = s.pct + "%";
    $("score-pct").textContent = s.pct + "%";
    $("score-band").textContent = s.band;
  }

  $("owner-name").addEventListener("input", (e) => { plan.owner = e.target.value; savePlan(); });
  $("extra-notes").addEventListener("input", (e) => { plan.extra = e.target.value; savePlan(); });

  $("plan-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "qtc-legacy-plan.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("plan-import-btn").addEventListener("click", () => $("plan-import").click());
  $("plan-import").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = JSON.parse(r.result);
        plan = {
          beneficiaries: Array.isArray(p.beneficiaries) ? p.beneficiaries : [],
          holdings: Array.isArray(p.holdings) ? p.holdings : [],
          deadmanChoice: p.deadmanChoice || "",
          deadmanText: p.deadmanText || "",
          checks: Array.isArray(p.checks) ? p.checks : [],
          owner: p.owner || "",
          extra: p.extra || "",
        };
        savePlan(); hydratePlan(); validatePlan();
      } catch (err) { alert("Could not read that file: " + err.message); }
    };
    r.readAsText(f);
    e.target.value = "";
  });

  function hydratePlan() {
    renderBens(); renderHoldings(); renderChecks();
    $("owner-name").value = plan.owner || "";
    $("extra-notes").value = plan.extra || "";
    $("deadman-text").value = plan.deadmanText || "";
    document.querySelectorAll('#deadman-radios input[name="deadman"]').forEach((r) => {
      r.checked = r.value === plan.deadmanChoice;
    });
  }
  hydratePlan(); validatePlan();

  // ================= LETTER =================
  function planForLetter() {
    const label = DEADMAN_LABELS[plan.deadmanChoice] || "";
    const dm = [label, plan.deadmanText.trim()].filter(Boolean).join(" — ");
    return {
      owner: plan.owner, date: new Date().toISOString().slice(0, 10),
      beneficiaries: plan.beneficiaries, holdings: plan.holdings,
      deadman: dm, extraNotes: plan.extra,
    };
  }
  let letterDoc = "";
  $("letter-gen").addEventListener("click", () => {
    letterDoc = LOGIC.buildLetter(planForLetter());
    const doc = new DOMParser().parseFromString(letterDoc, "text/html");
    $("letter-preview").innerHTML = doc.body.innerHTML;
    $("letter-print").disabled = false;
  });
  function showPrint(html) { $("print-sheet").innerHTML = html; }
  window.__qlvShowPrint = showPrint; // QA hook
  $("letter-print").addEventListener("click", () => {
    if (!letterDoc) return;
    const doc = new DOMParser().parseFromString(letterDoc, "text/html");
    showPrint(doc.body.innerHTML);
    window.print();
  });
})();
