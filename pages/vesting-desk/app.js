/* QTC Vesting Desk — app logic. All money math via VestingCore (BigInt plancks). */
(function () {
  "use strict";
  const VC = window.VestingCore;
  const $ = (id) => document.getElementById(id);
  const Q = VC.PLANCKS_PER_QTC;
  const LIVE_QUERY = `query { schedules: vesting_schedule(limit: 64, order_by: {id: asc}) { id beneficiary total claimed cliff start end last_claim_at block_height } }`;

  let DATA = null;       // { schedules, by_cohort, fetched_at_ms, block_height, live }
  let CHART_MODE = "cumulative";

  /* ---------------- data ---------------- */
  async function loadData() {
    // Live attempt first (works from explorer.quantus.com / quantus.com origins;
    // fails on GitHub Pages CORS and in offline sandboxes -> snapshot fallback).
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch("https://sqm.quantus.com/v1/graphql", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: LIVE_QUERY }), signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (json.errors) throw new Error("graphql");
      const nowMs = String(Date.now());
      DATA = normalizeLive(json.data.schedules, nowMs);
      DATA.live = true;
    } catch (e) {
      const res = await fetch("../../data/vesting.json");
      if (!res.ok) throw new Error("snapshot fetch failed: " + res.status);
      DATA = await res.json();
      DATA.live = false;
    }
    // Enrich every schedule with pallet-exact vested/claimable at DATA time.
    const now = BigInt(DATA.fetched_at_ms);
    for (const s of DATA.schedules) {
      const vested = VC.vestedAmount(BigInt(s.total_plancks), BigInt(s.cliff_ms),
        BigInt(s.start_ms), BigInt(s.end_ms), now);
      s.vested_now = vested.toString();
      s.claimable_now = VC.claimableEstimate(
        BigInt(s.total_plancks), BigInt(s.claimed_plancks), vested).toString();
    }
  }

  function normalizeLive(rows, nowMs) {
    const schedules = rows.map((s) => ({
      id: Number(s.id), beneficiary: s.beneficiary,
      cohort: VC.cohortOf(s.start, s.end),
      total_plancks: String(s.total), claimed_plancks: String(s.claimed),
      cliff_ms: String(s.cliff), start_ms: String(s.start), end_ms: String(s.end),
      last_claim_at_ms: s.last_claim_at == null ? null : String(s.last_claim_at),
    }));
    const by_cohort = {};
    for (const s of schedules) {
      const b = by_cohort[s.cohort] || (by_cohort[s.cohort] = {
        label: "", schedules: 0, total_plancks: "0", claimed_plancks: "0", vested_plancks: "0" });
      b.schedules += 1;
      b.total_plancks = (BigInt(b.total_plancks) + BigInt(s.total_plancks)).toString();
      b.claimed_plancks = (BigInt(b.claimed_plancks) + BigInt(s.claimed_plancks)).toString();
    }
    return {
      ok: true, source: "https://sqm.quantus.com/v1/graphql (live)",
      fetched_at: new Date(Number(nowMs)).toISOString(), fetched_at_ms: nowMs,
      block_height: null, schedules, by_cohort, live: true,
    };
  }

  /* ---------------- hero badge + now panel ---------------- */
  function renderNow() {
    const badge = $("snap-badge");
    const dt = new Date(DATA.fetched_at);
    badge.textContent = DATA.live
      ? "live indexer · " + dt.toUTCString()
      : "snapshot · " + dt.toUTCString().slice(0, 22) + (DATA.block_height != null ? " · block " + DATA.block_height.toLocaleString("en-US") : "");
    if (DATA.live) $("live-badge").hidden = false;

    let vested = 0n, claimed = 0n, claimable = 0n, total = 0n;
    for (const s of DATA.schedules) {
      total += BigInt(s.total_plancks);
      vested += BigInt(s.vested_now);
      claimed += BigInt(s.claimed_plancks);
      claimable += BigInt(s.claimable_now);
    }
    const unclaimed = vested - claimed;
    $("st-vested").textContent = VC.fmtQTC0(vested) + " QTC";
    $("st-vested-sub").textContent = pct(vested, total) + " of the 5,669,940 QTC vesting pool";
    $("st-claimed").textContent = VC.fmtQTC(claimed) + " QTC";
    $("st-unclaimed").textContent = VC.fmtQTC(claimable) + " QTC";
    $("st-locked").textContent = VC.fmtQTC0(total - vested) + " QTC";
    // tooltip-grade honesty: unclaimed includes sub-25-QTC remainders the chain won't pay yet
    $("st-unclaimed").title = "Vested but unclaimed (all): " + VC.fmtQTC(unclaimed) + " QTC — estimate shows the 25-QTC-aligned payable part";

    tickCountdowns();
    setInterval(tickCountdowns, 60000);
  }

  function pct(a, b) {
    if (b === 0n) return "0%";
    return (Number((a * 10000n) / b) / 100).toFixed(2) + "%";
  }

  function tickCountdowns() {
    const now = Date.now();
    $("cd-grant").textContent = countdownTo(VC.GRANT_START_MS, now);
    $("cd-intents").textContent = countdownTo(VC.INTENTS_END_MS, now);
    $("cd-end").textContent = countdownTo(VC.GRANT_END_MS, now);
  }
  function countdownTo(targetMs, nowMs) {
    const diff = Number(BigInt(targetMs) - BigInt(nowMs));
    if (diff <= 0) return "reached";
    return VC.countdown(diff);
  }

  /* ---------------- cohorts ---------------- */
  const COHORT_META = {
    grant: { tag: "COHORT A · 46 SCHEDULES", title: "Genesis grants", cls: "grant" },
    intents: { tag: "COHORT B · ID 45", title: "Intents grant", cls: "intents" },
    liquidity: { tag: "COHORT C · ID 46", title: "Treasury initial liquidity", cls: "liquidity" },
  };
  function renderCohorts() {
    const grid = $("cohort-grid");
    grid.innerHTML = "";
    const now = BigInt(DATA.fetched_at_ms);
    for (const key of ["grant", "intents", "liquidity"]) {
      const b = DATA.by_cohort[key];
      if (!b) continue;
      const rows = DATA.schedules.filter((s) => s.cohort === key);
      let vested = 0n, claimable = 0n;
      for (const s of rows) {
        vested += VC.vestedAmount(BigInt(s.total_plancks), BigInt(s.cliff_ms),
          BigInt(s.start_ms), BigInt(s.end_ms), now);
        claimable += VC.claimableEstimate(BigInt(s.total_plancks),
          BigInt(s.claimed_plancks), VC.vestedAmount(BigInt(s.total_plancks),
            BigInt(s.cliff_ms), BigInt(s.start_ms), BigInt(s.end_ms), now));
      }
      const total = BigInt(b.total_plancks);
      const meta = COHORT_META[key];
      const card = document.createElement("div");
      card.className = "cohort";
      card.innerHTML =
        '<div class="cohort-id">' + meta.tag + '</div>' +
        "<h3>" + meta.title + "</h3>" +
        '<div class="big">' + VC.fmtQTC0(total) + ' QTC</div>' +
        '<div class="dates">' + VC.fmtDate(BigInt(rows[0].start_ms)) + " &rarr; " + VC.fmtDate(BigInt(rows[0].end_ms)) + "</div>" +
        '<div class="pbar" role="img" aria-label="' + pct(vested, total) + ' vested"><i style="width:' + pct(vested, total) + '"></i></div>' +
        '<div class="prow"><span>' + pct(vested, total) + ' vested</span><span>' + VC.fmtQTC0(vested) + ' / ' + VC.fmtQTC0(total) + '</span></div>' +
        '<div class="prow"><span>claimed</span><span>' + VC.fmtQTC(BigInt(b.claimed_plancks)) + ' QTC</span></div>' +
        '<div class="prow"><span>claimable now (est.)</span><span>' + VC.fmtQTC(claimable) + ' QTC</span></div>' +
        '<div class="note">' + cohortNote(key) + "</div>";
      grid.appendChild(card);
    }
  }
  function cohortNote(key) {
    if (key === "grant") return "1-year lockup from TGE (Sep 9, 2026), then linear vesting over 3 years. cliff == start, so there is no cliff-day lump — the first QTC accrues on Sep 9, 2027 itself.";
    if (key === "intents") return "The NEAR Intents grant vests from TGE over 365 days. At snapshot time ~2,441 QTC had vested and the beneficiary had claimed nothing yet.";
    return "Treasury market-making allocation, fully vested since Sep 25, 2026. 171,475 of 210,000 QTC claimed at snapshot time — 38,525 QTC vested but unclaimed. On-chain curiosity: this schedule's beneficiary address also holds grant schedule #47 (502,438 QTC) — the treasury wears two hats.";
  }

  /* ---------------- chart ---------------- */
  function renderChart() {
    const canvas = $("unlock-chart");
    const pts = VC.monthlyCurve(DATA.schedules, Date.now());
    drawChart(canvas, pts);
    const legend = $("chart-legend");
    if (CHART_MODE === "cumulative") {
      legend.innerHTML = '<span><i class="legend-swatch" style="background:#f5c453"></i>Aggregate vested supply (QTC)</span>' +
        '<span><i class="legend-swatch" style="background:#7fb3f5"></i>Grant cliff ends (Sep 2027)</span>' +
        '<span><i class="legend-swatch" style="background:#5d6680"></i>Today</span>';
    } else {
      legend.innerHTML = '<span><i class="legend-swatch" style="background:#c99a2e"></i>Newly unlocked per month (QTC)</span>' +
        '<span><i class="legend-swatch" style="background:#5d6680"></i>Today</span>';
    }
  }

  function drawChart(canvas, pts) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const padL = 64, padR = 14, padT = 14, padB = 30;
    const iw = w - padL - padR, ih = h - padT - padB;
    const vals = pts.map((p) => CHART_MODE === "cumulative" ? p.vested : p.inflow);
    let max = 0n;
    for (const v of vals) if (v > max) max = v;
    if (max === 0n) max = 1n;
    const x = (i) => padL + (iw * i) / (pts.length - 1);
    const y = (v) => padT + ih - (ih * Number((v * 1000000n) / max)) / 1000000;

    // gridlines + y labels (QTC, compact)
    ctx.font = "11px system-ui"; ctx.fillStyle = "#5d6680"; ctx.textAlign = "right";
    for (let g = 0; g <= 4; g++) {
      const v = (max * BigInt(g)) / 4n;
      const yy = y(v);
      ctx.strokeStyle = "rgba(35,43,66,.7)";
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(compactQTC(v), padL - 8, yy + 4);
    }
    // x labels every 6 months
    ctx.textAlign = "center";
    const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (let i = 0; i < pts.length; i += 6) {
      const d = new Date(pts[i].monthMs);
      ctx.fillText(MN[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2), x(i), h - 10);
    }

    if (CHART_MODE === "cumulative") {
      const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
      grad.addColorStop(0, "rgba(245,196,83,.55)");
      grad.addColorStop(1, "rgba(245,196,83,.04)");
      ctx.beginPath();
      pts.forEach((p, i) => { const xx = x(i), yy = y(p.vested); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
      ctx.strokeStyle = "#f5c453"; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(x(pts.length - 1), h - padB); ctx.lineTo(x(0), h - padB); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      // cliff marker: grants start Sep 2027
      const gi = pts.findIndex((p) => p.monthMs >= Number(VC.GRANT_START_MS));
      if (gi > 0) {
        ctx.strokeStyle = "rgba(127,179,245,.55)"; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x(gi), padT); ctx.lineTo(x(gi), h - padB); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#7fb3f5"; ctx.textAlign = "left";
        ctx.fillText("grant cliff ends", x(gi) + 6, padT + 14);
      }
    } else {
      const bw = Math.max(2, (iw / pts.length) * 0.7);
      pts.forEach((p, i) => {
        const xx = x(i) - bw / 2, yy = y(p.inflow);
        const grad = ctx.createLinearGradient(0, yy, 0, h - padB);
        grad.addColorStop(0, "#f5c453"); grad.addColorStop(1, "#8a6a1f");
        ctx.fillStyle = grad;
        ctx.fillRect(xx, yy, bw, Math.max(1, h - padB - yy));
      });
    }
    // "you are here"
    const nowMs = Date.now();
    let ni = pts.findIndex((p) => p.monthMs >= nowMs);
    if (ni < 0) ni = pts.length - 1;
    ctx.strokeStyle = "rgba(232,236,245,.6)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(ni), padT); ctx.lineTo(x(ni), h - padB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#e8ecf5"; ctx.textAlign = ni > pts.length - 4 ? "right" : "left";
    ctx.fillText("today", x(ni) + (ni > pts.length - 4 ? -6 : 6), padT + 14);
    canvas.dataset.rendered = "1";
  }

  function compactQTC(plancks) {
    const q = Number(BigInt(plancks) / Q);
    if (q >= 1000000) return (q / 1000000).toFixed(1) + "M";
    if (q >= 1000) return (q / 1000).toFixed(0) + "k";
    return String(q);
  }

  /* ---------------- schedule table ---------------- */
  function filteredSchedules() {
    const q = $("sched-search").value.trim().toLowerCase();
    const cf = $("sched-cohort").value;
    const onlyUn = $("sched-unclaimed").checked;
    const sort = $("sched-sort").value;
    let rows = DATA.schedules.filter((s) => {
      if (cf !== "all" && s.cohort !== cf) return false;
      if (q && !(String(s.id).includes(q) || s.beneficiary.toLowerCase().includes(q))) return false;
      if (onlyUn && BigInt(s.claimable_now) <= 0n) return false;
      return true;
    });
    const key = {
      "total-desc": (a, b) => cmp(BigInt(b.total_plancks), BigInt(a.total_plancks)),
      "total-asc": (a, b) => cmp(BigInt(a.total_plancks), BigInt(b.total_plancks)),
      "progress-desc": (a, b) => cmp(BigInt(b.vested_now) * BigInt(a.total_plancks), BigInt(a.vested_now) * BigInt(b.total_plancks)),
      "claimable-desc": (a, b) => cmp(BigInt(b.claimable_now), BigInt(a.claimable_now)),
      "id-asc": (a, b) => a.id - b.id,
    }[sort];
    rows.sort(key);
    return rows;
  }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function renderTable() {
    const rows = filteredSchedules();
    const body = $("sched-body");
    body.innerHTML = "";
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">no schedules match</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of rows) {
      const total = BigInt(s.total_plancks), vested = BigInt(s.vested_now);
      const pc = total === 0n ? 0 : Number((vested * 10000n) / total) / 100;
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.setAttribute("data-id", String(s.id));
      const claimable = BigInt(s.claimable_now);
      tr.innerHTML =
        "<td>" + s.id + "</td>" +
        '<td class="addr" title="' + esc(s.beneficiary) + '">' + esc(shortAddr(s.beneficiary)) + "</td>" +
        '<td><span class="cohort-tag ' + s.cohort + '">' + cohortLabel(s.cohort) + "</span></td>" +
        '<td class="num">' + VC.fmtQTC0(total) + "</td>" +
        '<td class="num">' + VC.fmtQTC(vested) + "</td>" +
        '<td class="num">' + VC.fmtQTC(BigInt(s.claimed_plancks)) + "</td>" +
        '<td class="num">' + (claimable > 0n ? '<span class="claim-hi">' + VC.fmtQTC(claimable) + "</span>" : "—") + "</td>" +
        '<td class="num">' + pc.toFixed(1) + "%</td>";
      tr.addEventListener("click", () => showDetail(s.id));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") showDetail(s.id); });
      frag.appendChild(tr);
    }
    body.appendChild(frag);
  }
  function cohortLabel(c) {
    return c === "grant" ? "Grants" : c === "intents" ? "Intents" : c === "liquidity" ? "Liquidity" : c;
  }
  function shortAddr(a) { return a.slice(0, 10) + "…" + a.slice(-8); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function showDetail(id) {
    const s = DATA.schedules.find((x) => x.id === id);
    if (!s) return;
    const total = BigInt(s.total_plancks), vested = BigInt(s.vested_now),
      claimed = BigInt(s.claimed_plancks), claimable = BigInt(s.claimable_now);
    const locked = total - vested;
    const pc = total === 0n ? 0 : Number((vested * 10000n) / total) / 100;
    // forward 12-month unlock calendar
    const nowM = VC.monthStart(Date.now());
    let cal = "";
    let prev = VC.vestedAmount(total, BigInt(s.cliff_ms), BigInt(s.start_ms), BigInt(s.end_ms), BigInt(nowM));
    for (let i = 1; i <= 12; i++) {
      const m = VC.addMonths(nowM, i);
      const v = VC.vestedAmount(total, BigInt(s.cliff_ms), BigInt(s.start_ms), BigInt(s.end_ms), BigInt(m));
      const d = new Date(m);
      const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      cal += '<div class="mini-month"><div class="mm">' + MN[d.getUTCMonth()] + " " + d.getUTCFullYear() +
        '</div><div class="mv">+' + VC.fmtQTC(v - prev) + ' QTC</div><div class="mm">vested ' + VC.fmtQTC(v) + "</div></div>";
      prev = v;
    }
    const lastClaim = s.last_claim_at_ms == null ? "never" : new Date(Number(s.last_claim_at_ms)).toUTCString().slice(0, 22);
    $("sched-detail").hidden = false;
    $("sched-detail").innerHTML =
      '<button class="detail-close" id="detail-close">close ✕</button>' +
      "<h3>Schedule #" + s.id + " — " + cohortLabel(s.cohort) + "</h3>" +
      '<div class="addr-full">' + esc(s.beneficiary) + "</div>" +
      '<div class="detail-grid">' +
      cell("Total grant", VC.fmtQTC0(total) + " QTC", "") +
      cell("Vested now", VC.fmtQTC(vested) + " QTC", "") +
      cell("Claimed", VC.fmtQTC(claimed) + " QTC", "") +
      cell("Claimable now (est.)", claimable > 0n ? VC.fmtQTC(claimable) + " QTC" : "—", "hi") +
      cell("Still locked", VC.fmtQTC0(locked) + " QTC", "") +
      cell("Last claim", lastClaim, "") +
      "</div>" +
      '<div class="pbar" role="img" aria-label="' + pc.toFixed(1) + '% vested"><i style="width:' + pc.toFixed(1) + '%"></i></div>' +
      '<div class="prow"><span>' + pc.toFixed(1) + '% vested</span><span>' + VC.fmtDate(BigInt(s.start_ms)) + " → " + VC.fmtDate(BigInt(s.end_ms)) + "</span></div>" +
      "<h3 style='margin-top:16px;font-size:15px'>Next 12 months of unlocks</h3>" +
      '<div class="mini-cal">' + cal + "</div>" +
      '<div class="claim-box"><strong style="color:#e8ecf5">How to claim:</strong> ' +
      "call <code>Vesting.claim(" + s.id + ")</code> (pallet 22, call 0) from any funded account — the claim is permissionless and the payout goes to the beneficiary above. " +
      "Non-final payouts land in 25-QTC chunks; at most one claim per day per schedule. " +
      "Estimates use this page's chain time; the chain decides at the claim block's timestamp.</div>";
    $("detail-close").addEventListener("click", () => { $("sched-detail").hidden = true; });
    $("sched-detail").scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "nearest" });
  }
  function cell(label, value, cls) {
    return '<div class="detail-cell"><div class="dl">' + label + '</div><div class="dv ' + cls + '">' + value + "</div></div>";
  }

  /* ---------------- lookup ---------------- */
  function doLookup() {
    const input = $("lookup-addr"), msg = $("lookup-msg"), out = $("lookup-results");
    const addr = input.value.trim();
    out.innerHTML = "";
    if (!addr) { msg.className = "lookup-msg err"; msg.textContent = "Paste a qz… address first."; return; }
    let dec;
    try { dec = window.QSS58.ss58Decode(addr); }
    catch (e) { dec = { ok: false, error: "Could not decode: " + e.message }; }
    if (!dec.ok) {
      msg.className = "lookup-msg err";
      msg.textContent = "Invalid address — " + (dec.error || "decode failed");
      input.classList.add("bad");
      return;
    }
    if (dec.prefix !== 189 || dec.key.length !== 32) {
      msg.className = "lookup-msg err";
      msg.textContent = "Valid SS58 checksum, but this is not a Quantus (prefix 189) account address.";
      input.classList.add("bad");
      return;
    }
    input.classList.remove("bad");
    const hits = DATA.schedules.filter((s) => s.beneficiary === addr);
    if (!hits.length) {
      msg.className = "lookup-msg ok";
      msg.textContent = "✓ Valid Quantus address — no vesting schedules found for it in the 48-schedule genesis set.";
      return;
    }
    msg.className = "lookup-msg ok";
    msg.textContent = "✓ Valid Quantus address — " + hits.length + " schedule" + (hits.length > 1 ? "s" : "") + " found.";
    for (const s of hits) showDetailInto(s.id, out);
  }
  function showDetailInto(id, container) {
    const tmp = document.createElement("div");
    const orig = $("sched-detail");
    // reuse showDetail by temporarily swapping target
    const s = DATA.schedules.find((x) => x.id === id);
    const total = BigInt(s.total_plancks), vested = BigInt(s.vested_now),
      claimed = BigInt(s.claimed_plancks), claimable = BigInt(s.claimable_now);
    const locked = total - vested;
    const pc = total === 0n ? 0 : Number((vested * 10000n) / total) / 100;
    const d = document.createElement("div");
    d.className = "detail";
    d.innerHTML =
      "<h3>Schedule #" + s.id + " — " + cohortLabel(s.cohort) + "</h3>" +
      '<div class="detail-grid">' +
      cell("Total grant", VC.fmtQTC0(total) + " QTC", "") +
      cell("Vested now", VC.fmtQTC(vested) + " QTC", "") +
      cell("Claimed", VC.fmtQTC(claimed) + " QTC", "") +
      cell("Claimable now (est.)", claimable > 0n ? VC.fmtQTC(claimable) + " QTC" : "—", "hi") +
      cell("Still locked", VC.fmtQTC0(locked) + " QTC", "") +
      cell("Unlocks", VC.fmtDate(BigInt(s.start_ms)) + " → " + VC.fmtDate(BigInt(s.end_ms)), "") +
      "</div>" +
      '<div class="pbar"><i style="width:' + pc.toFixed(1) + '%"></i></div>' +
      '<div class="prow"><span>' + pc.toFixed(1) + '% vested</span><span>' +
      (claimable > 0n ? 'call <code style="color:#f5c453">Vesting.claim(' + s.id + ')</code> (pallet 22, call 0) — permissionless' : "nothing claimable yet") +
      "</span></div>";
    container.appendChild(d);
  }

  /* ---------------- background ticks ---------------- */
  function tickRain() {
    const c = $("tick-rain");
    const ctx = c.getContext("2d");
    let w, h, ticks;
    function size() {
      w = c.width = window.innerWidth; h = c.height = window.innerHeight;
      ticks = Array.from({ length: Math.min(48, w / 28) }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        s: 0.2 + Math.random() * 0.7, l: 6 + Math.random() * 14,
      }));
    }
    size();
    window.addEventListener("resize", size);
    var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (function frame() {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(245,196,83,.10)";
      ctx.lineWidth = 1;
      for (const t of ticks) {
        ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(t.x, t.y + t.l); ctx.stroke();
        t.y += t.s;
        if (t.y > h + 20) { t.y = -20; t.x = Math.random() * w; }
      }
      if (!REDUCE_MOTION) requestAnimationFrame(frame);
    })();
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    try {
      await loadData();
    } catch (e) {
      $("snap-badge").textContent = "data unavailable — " + e.message;
      $("sched-body").innerHTML = '<tr><td colspan="8" class="empty">could not load vesting data</td></tr>';
      return;
    }
    renderNow();
    renderCohorts();
    renderChart();
    renderTable();
    document.querySelectorAll(".chart-tab").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".chart-tab").forEach((x) => {
          x.classList.remove("active"); x.setAttribute("aria-selected", "false");
        });
        b.classList.add("active"); b.setAttribute("aria-selected", "true");
        CHART_MODE = b.dataset.mode;
        renderChart();
      });
    });
    for (const id of ["sched-search", "sched-cohort", "sched-sort", "sched-unclaimed"]) {
      $(id).addEventListener("input", renderTable);
      $(id).addEventListener("change", renderTable);
    }
    $("lookup-btn").addEventListener("click", doLookup);
    $("lookup-addr").addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(); });
    let rto;
    window.addEventListener("resize", () => { clearTimeout(rto); rto = setTimeout(renderChart, 200); });
    const copy = $("donate-copy");
    if (copy) copy.addEventListener("click", () => {
      const a = $("donate-addr").textContent.trim();
      if (navigator.clipboard) navigator.clipboard.writeText(a).then(() => {
        copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy"), 1500);
      });
    });
    tickRain();
    window.__vestingDeskReady = true;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
