/* QTC Reversal Desk — UI wiring. Never signs; all call data is unsigned
 * (paste it into Chain Console / a signer). Reads the same-origin snapshot
 * written by scripts/fetch-reversal-data.mjs. */
(function () {
  "use strict";
  var RC = window.ReversalCore;
  var C = RC.C;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function copyText(text, btn) {
    function done() {
      var t = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = t; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      done();
    }
  }
  function planckToQTC(s) {
    try { return RC.formatQTC(BigInt(s)); } catch (e) { return "—"; }
  }
  function ago(iso) {
    var t = new Date(iso).getTime(), now = Date.now(), d = now - t;
    if (isNaN(t)) return "—";
    if (d < 0) d = 0;
    return RC.formatDuration(d) + " ago";
  }

  /* ============ lifecycle visualizer ============ */
  var STAGES = [
    {
      id: "draft", title: "1 · Sign",
      body: "You sign <code>schedule_transfer</code> (high-security account, uses your configured delay) or <code>schedule_transfer_with_delay</code> (regular account, one-time delay). The delay is validated on-chain: ≥ 2 blocks, or ≥ 12 000 ms for timestamp delays.",
    },
    {
      id: "hold", title: "2 · Hold",
      body: "The full amount is frozen on your account under <code>HoldReason::ScheduledTransfer</code> — not sent anywhere. Funds sit in your balance as a hold until execution or cancellation. The pending transfer is keyed by <code>tx_id = blake2( (from, transfer_call, NextTransactionId) )</code> and counts against your 16-pending cap.",
    },
    {
      id: "wait", title: "3 · Delay",
      body: "The scheduler registers a named task that will dispatch <code>execute_transfer(tx_id)</code> at <code>current_block + delay</code> (or after the timestamp). Nobody can rush it — not you, not the guardian. This window is the whole point: time to notice a mistake or a theft.",
    },
    {
      id: "execute", title: "4a · Execute",
      body: "When the delay elapses, the pallet's own sovereign account (pallet-id <code>rtpallet</code>) dispatches <code>execute_transfer</code>, which releases the hold and performs a <code>transfer_allow_death</code> to the destination. A failing inner transfer (e.g. dest overflow) never freezes funds: the hold is released first and the result is recorded on the <code>TransactionExecuted</code> event.",
    },
    {
      id: "cancel", title: "4b · Cancel",
      body: "Before execution, the transfer can be cancelled — by <strong>you</strong> for one-time schedules (funds return to you, no fee), or by your <strong>guardian</strong> for high-security schedules (1% of the amount is burned as a volume fee; the remaining 99% goes to the guardian, who is expected to return it to you). Cancel rights are frozen at schedule time: a later <code>set_high_security</code> cannot rewrite them.",
    },
  ];
  function renderLifecycle() {
    var wrap = $("lifeStages");
    STAGES.forEach(function (s, i) {
      var b = el("button", "stage" + (i === 0 ? " active" : ""), "<span class='dot'></span>" + s.title);
      b.type = "button";
      b.setAttribute("data-i", i);
      b.addEventListener("click", function () {
        wrap.querySelectorAll(".stage").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        $("lifeBody").innerHTML = "<h3>" + s.title + "</h3><p>" + s.body + "</p>";
      });
      wrap.appendChild(b);
    });
    $("lifeBody").innerHTML = "<h3>" + STAGES[0].title + "</h3><p>" + STAGES[0].body + "</p>";
  }

  /* ============ delay planner ============ */
  function parseQTC(s) {
    var m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(String(s).trim());
    if (!m) return null;
    var frac = (m[2] || "").padEnd(12, "0");
    return BigInt(m[1]) * C.UNIT + BigInt(frac);
  }
  function plannerDelay() {
    var unit = $("plUnit").value;
    var v = parseInt($("plDelay").value, 10);
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: "Enter a positive delay." };
    if (unit === "blocks") return { ok: true, delay: { kind: "blocks", blocks: v } };
    var ms = v * (unit === "days" ? 86400000 : unit === "hours" ? 3600000 : 60000);
    return { ok: true, delay: { kind: "ms", ms: ms } };
  }
  function updatePlanner() {
    var out = $("plOut"), hexBox = $("plHex"), breakdown = $("plBreakdown");
    var dres = RC.ss58Decode($("plDest").value || "");
    var amt = parseQTC($("plAmount").value);
    var dl = plannerDelay();
    if (!dres.ok) {
      out.innerHTML = "<div class='warn'>Destination: " + esc(dres.error || "enter a qz… address") + "</div>";
      hexBox.style.display = "none"; breakdown.innerHTML = "";
      return;
    }
    if (amt === null || amt <= 0n) {
      out.innerHTML = "<div class='warn'>Amount: enter a positive QTC value (up to 12 decimals).</div>";
      hexBox.style.display = "none"; breakdown.innerHTML = "";
      return;
    }
    if (!dl.ok) {
      out.innerHTML = "<div class='warn'>" + esc(dl.error) + "</div>";
      hexBox.style.display = "none"; breakdown.innerHTML = "";
      return;
    }
    var vd = RC.validateDelay(dl.delay);
    var nowH = window.__revHeight || null;
    var rows = [];
    rows.push(["Destination", "<code>" + esc($("plDest").value.trim()) + "</code>"]);
    rows.push(["Amount", "<strong>" + RC.formatQTC(amt) + " QTC</strong> <span class='dim'>(" + amt.toString() + " planck)</span>"]);
    var delayDesc = dl.delay.kind === "blocks"
      ? dl.delay.blocks.toLocaleString() + " blocks ≈ " + RC.formatDuration(RC.blocksToMs(dl.delay.blocks))
      : RC.formatDuration(dl.delay.ms) + " (timestamp delay)";
    rows.push(["Delay", delayDesc + (vd.ok ? "" : " — <span class='bad'>INVALID</span>")]);
    if (!vd.ok) {
      out.innerHTML = "<div class='bad-box'>Delay rejected by on-chain rules: " + esc(vd.error) + "</div>";
      hexBox.style.display = "none"; breakdown.innerHTML = "";
      return;
    }
    if (nowH && dl.delay.kind === "blocks") {
      var ex = RC.executeAtBlock(nowH, dl.delay.blocks);
      rows.push(["Executes at", "block <strong>" + ex.toLocaleString() + "</strong> <span class='dim'>(scheduled at " + nowH.toLocaleString() + " + " + dl.delay.blocks.toLocaleString() + ")</span>"]);
      rows.push(["Wall-clock ETA", "≈ " + RC.formatDuration(RC.blocksToMs(dl.delay.blocks)) + " <span class='dim'>(12 s target block time)</span>"]);
    } else if (dl.delay.kind === "ms") {
      rows.push(["Executes", "after the delay elapses — the scheduler stores a timestamp task (<code>DispatchTime::After</code>), independent of block height."]);
    } else {
      rows.push(["Executes at", "<span class='dim'>live height unknown — connect for an exact block</span>"]);
    }
    rows.push(["Hold", "amount frozen under <code>HoldReason::ScheduledTransfer</code> until execution or cancel"]);
    var hex, callName;
    if ($("plMode").value === "hs") {
      hex = RC.encodeScheduleTransfer(dres.key, amt);
      callName = "ReversibleTransfers::schedule_transfer (pallet 11, call 3)";
      rows.push(["Mode", "high-security account — uses your account's configured delay (the custom delay field is ignored by this call)"]);
    } else {
      hex = RC.encodeScheduleTransferWithDelay(dres.key, amt, dl.delay);
      callName = "ReversibleTransfers::schedule_transfer_with_delay (pallet 11, call 4)";
      rows.push(["Mode", "one-time — regular accounts only; high-security accounts must use <code>schedule_transfer</code>"]);
    }
    out.innerHTML = "<table class='kv'>" + rows.map(function (r) {
      return "<tr><th>" + r[0] + "</th><td>" + r[1] + "</td></tr>";
    }).join("") + "</table>";
    breakdown.innerHTML = "<div class='callname'>" + callName + "</div><div class='field-note'>Unsigned call data — paste the hex into Chain Console or your signer. <code>amount</code> is a plain u128 (16 bytes LE, <em>not</em> compact); <code>dest</code> is <code>MultiAddress::Id</code>.</div>";
    hexBox.style.display = "block";
    $("plHexText").textContent = hex;
    $("plCopy").onclick = function () { copyText(hex, $("plCopy")); };
  }

  /* ============ high-security desk ============ */
  function updateHS() {
    var out = $("hsOut"), hexBox = $("hsHex");
    var sender = ($("hsSender").value || "").trim();
    var guardian = ($("hsGuardian").value || "").trim();
    var sres = sender ? RC.ss58Decode(sender) : null;
    var gres = RC.ss58Decode(guardian);
    var msgs = [];
    if (sender && !sres.ok) msgs.push(["Sender", sres.error]);
    if (!gres.ok) msgs.push(["Guardian", gres.error || "enter the guardian's qz… address"]);
    if (gres.ok && sres && sres.ok) {
      var same = gres.key.every(function (b, i) { return b === sres.key[i]; });
      if (same) msgs.push(["Guardian", "GuardianCannotBeSelf — the guardian must be a different account."]);
    }
    if (msgs.length) {
      out.innerHTML = msgs.map(function (m) {
        return "<div class='warn'><strong>" + m[0] + ":</strong> " + esc(m[1]) + "</div>";
      }).join("");
      hexBox.style.display = "none";
      return;
    }
    var dl = plannerDelayHS();
    var vd = RC.validateDelay(dl);
    if (!vd.ok) {
      out.innerHTML = "<div class='bad-box'>" + esc(vd.error) + "</div>";
      hexBox.style.display = "none";
      return;
    }
    var hex = RC.encodeSetHighSecurity(dl, gres.key);
    var rows = [
      ["Account", sender && sres.ok ? "<code>" + esc(sender) + "</code>" : "<span class='dim'>optional — validated only if filled</span>"],
      ["Guardian", "<code>" + esc(guardian) + "</code>"],
      ["Reversibility delay", dl.kind === "blocks" ? dl.blocks.toLocaleString() + " blocks ≈ " + RC.formatDuration(RC.blocksToMs(dl.blocks)) : RC.formatDuration(dl.ms)],
      ["Effect", "PERMANENT and one-way. The account will only ever be able to <code>schedule_transfer</code>, <code>cancel</code>, and <code>recover_funds</code>. There is no undo."],
      ["Quota", "16 signed extrinsics per rolling 24 h (7 200 blocks), zero tip forced, extrinsics capped at 10 KiB"],
      ["Reversal fee", "1% of the amount is <strong>burned</strong> when a high-security transfer is reversed; the remaining 99% goes to the guardian"],
    ];
    out.innerHTML = "<table class='kv'>" + rows.map(function (r) {
      return "<tr><th>" + r[0] + "</th><td>" + r[1] + "</td></tr>";
    }).join("") + "</table>";
    hexBox.style.display = "block";
    $("hsHexText").textContent = hex;
    $("hsHexNote").innerHTML = "<div class='callname'>ReversibleTransfers::set_high_security (pallet 11, call 0)</div><div class='field-note'>Unsigned call data. Read the one-way warning above twice before submitting this anywhere.</div>";
    $("hsCopy").onclick = function () { copyText(hex, $("hsCopy")); };
  }
  function plannerDelayHS() {
    var unit = $("hsUnit").value;
    var v = parseInt($("hsDelay").value, 10);
    if (!Number.isFinite(v) || v <= 0) return { kind: "blocks", blocks: 0 };
    if (unit === "blocks") return { kind: "blocks", blocks: v };
    return { kind: "ms", ms: v * (unit === "days" ? 86400000 : unit === "hours" ? 3600000 : 60000) };
  }

  /* quota simulator */
  var quotaTxs = [];
  /* The reference height for quota windows and ages is the LIVE snapshot
   * height. It used to fall back to a hard-coded 146270 — the height on the
   * day the desk was built — which went stale by tens of thousands of
   * blocks: with the snapshot slow or down, "Add transaction" fabricated a
   * tx at that ancient height and every age was measured against it. When
   * the live height is unknown, the only honest reference is the newest
   * simulated block itself (ages become relative to it, and the note says
   * so); renderLive re-runs renderQuota the moment the real height lands. */
  function quotaRefHeight() {
    if (window.__revHeight) return { h: window.__revHeight, live: true };
    if (quotaTxs.length) return { h: Math.max.apply(null, quotaTxs), live: false };
    return { h: 0, live: false };
  }
  function renderQuota() {
    var ref = quotaRefHeight();
    var nowH = ref.h;
    var q = RC.quotaCheck(quotaTxs.slice().sort(function (a, b) { return a - b; }), nowH);
    $("qRemain").textContent = q.remaining + " / 16";
    $("qBar").style.width = (q.inWindow / 16 * 100) + "%";
    $("qBar").className = "qfill" + (q.remaining === 0 ? " full" : q.remaining <= 4 ? " low" : "");
    $("qNote").innerHTML = (q.allowed
      ? "Quota has room — the next signed extrinsic will be admitted."
      : "<span class='bad'>Quota exhausted — the next signed extrinsic is rejected until the oldest entry ages past 7 200 blocks.</span>") +
      (ref.live ? "" : " <span class='dim'>Live height unknown — ages are measured against the newest simulated block.</span>");
    var list = $("qList");
    list.innerHTML = "";
    quotaTxs.slice().sort(function (a, b) { return b - a; }).forEach(function (b, i) {
      var row = el("div", "qrow", "<span>tx at block " + b.toLocaleString() + "</span><span class='dim'>" + RC.formatDuration((nowH - b) * 12000) + " old</span>");
      var x = el("button", "xbtn", "×");
      x.type = "button";
      x.addEventListener("click", function () {
        quotaTxs.splice(quotaTxs.indexOf(b), 1);
        renderQuota();
      });
      row.appendChild(x);
      list.appendChild(row);
    });
    if (!quotaTxs.length) list.innerHTML = "<div class='dim'>No simulated transactions yet — add some to watch the rolling window fill.</div>";
  }
  function updateFee() {
    var amt = parseQTC($("feeAmount").value);
    if (amt === null || amt <= 0n) {
      $("feeOut").innerHTML = "<div class='warn'>Enter a positive QTC amount.</div>";
      return;
    }
    var fee = RC.volumeFee(amt), rest = amt - fee;
    $("feeOut").innerHTML = "<table class='kv'>" +
      "<tr><th>Transfer amount</th><td><strong>" + RC.formatQTC(amt) + " QTC</strong></td></tr>" +
      "<tr><th>Burned (1%)</th><td class='bad'>" + RC.formatQTC(fee) + " QTC <span class='dim'>(" + fee.toString() + " planck)</span></td></tr>" +
      "<tr><th>Guardian receives</th><td>" + RC.formatQTC(rest) + " QTC <span class='dim'>(99%, integer floor)</span></td></tr>" +
      "<tr><th>Applies to</th><td>high-security cancellations and <code>recover_funds</code> seizures only — one-time schedules reverse fee-free</td></tr>" +
      "</table>";
  }

  /* ============ live data ============ */
  /* Abort a fetch that never settles: a hung request must fall through to
   * the app's error/fallback path, not strand the page on "Loading…" forever. */
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var ctl = new AbortController();
    setTimeout(function () { ctl.abort(); }, ms);
    return ctl.signal;
  }
  function loadSnapshot() {
    fetch("../../data/reversal.json?v=1.50.2", { cache: "no-store", signal: timeoutSignal(9000) })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(renderLive)
      .catch(function (e) {
        $("snapPill").textContent = "snapshot unavailable";
        $("liveNote").innerHTML = "Could not load the chain snapshot (" + esc(e.message) + "). The planners and encoders above work offline — only the live queue needs the snapshot.";
      });
  }
  function renderLive(snap) {
    if (!snap || !snap.ok) throw new Error("bad snapshot");
    var d = snap.data;
    var h = d.status && d.status.block_height;
    window.__revHeight = h || null;
    $("snapPill").textContent = "snapshot · block " + (h ? h.toLocaleString() : "?") + " · " + ago(snap.fetched_at);
    var t = d.totals;
    var pending = (t.scheduled || 0) - (t.cancelled || 0) - (t.executed || 0);
    $("pScheduled").textContent = t.scheduled == null ? "—" : t.scheduled;
    $("pExecuted").textContent = t.executed == null ? "—" : t.executed;
    $("pCancelled").textContent = t.cancelled == null ? "—" : t.cancelled;
    $("pPending").textContent = pending;
    $("pHS").textContent = t.high_security == null ? "—" : t.high_security;
    $("liveNote").innerHTML = "Snapshot from the public Subsquid indexer (<code>sqm.quantus.com</code>), fetched " + esc(ago(snap.fetched_at)) + ". " +
      "Pending = scheduled − cancelled − executed. The indexer records schedule/cancel/execute events; the exact execute-at block lives in the <code>TransactionScheduled</code> event args, which this snapshot does not carry.";
    renderQueue(d);
    // re-run planner ETA now that we know the height
    updatePlanner();
    // re-base the quota simulator onto the real height: entries added
    // before the snapshot landed were aged against the newest simulated
    // block, which is wrong the moment the true height is known
    renderQuota();
  }
  function txRow(kind, r) {
    var tr = el("tr");
    var cells;
    if (kind === "s") {
      cells = [
        "<code>" + esc(RC.shortHash(r.tx_id)) + "</code>",
        planckToQTC(r.amount) + " QTC",
        "<code>" + esc(RC.shortAddr(r.from_id)) + "</code>",
        "<code>" + esc(RC.shortAddr(r.to_id)) + "</code>",
        esc(ago(r.timestamp)),
      ];
    } else if (kind === "c") {
      cells = [
        "<code>" + esc(RC.shortHash(r.tx_id)) + "</code>",
        "<code>" + esc(RC.shortAddr(r.cancelled_by_id || "?")) + "</code>",
        esc(ago(r.timestamp)),
      ];
    } else {
      cells = [
        "<code>" + esc(RC.shortHash(r.tx_id)) + "</code>",
        esc(r.result || "—"),
        esc(ago(r.timestamp)),
      ];
    }
    tr.innerHTML = cells.map(function (c) { return "<td>" + c + "</td>"; }).join("");
    return tr;
  }
  function renderQueue(d) {
    var st = document.querySelector("#qScheduled tbody");
    st.innerHTML = "";
    if (!d.scheduled.length) st.innerHTML = "<tr><td colspan='5' class='dim'>No scheduled transfers in the snapshot window.</td></tr>";
    d.scheduled.forEach(function (r) { st.appendChild(txRow("s", r)); });
    var ct = document.querySelector("#qCancelled tbody");
    ct.innerHTML = "";
    if (!d.cancelled.length) ct.innerHTML = "<tr><td colspan='3' class='dim'>No cancellations recorded — every scheduled transfer so far ran to execution.</td></tr>";
    d.cancelled.forEach(function (r) { ct.appendChild(txRow("c", r)); });
    var et = document.querySelector("#qExecuted tbody");
    et.innerHTML = "";
    if (!d.executed.length) et.innerHTML = "<tr><td colspan='3' class='dim'>No executions recorded.</td></tr>";
    d.executed.forEach(function (r) { et.appendChild(txRow("e", r)); });
    var ht = document.querySelector("#qHS tbody");
    ht.innerHTML = "";
    if (!d.high_security.length) ht.innerHTML = "<tr><td colspan='4' class='dim'>No high-security enrollments indexed yet — the feature is live on-chain but unused on mainnet so far.</td></tr>";
    d.high_security.forEach(function (r) {
      var tr = el("tr");
      tr.innerHTML = "<td><code>" + esc(RC.shortAddr(r.who_id)) + "</code></td>" +
        "<td><code>" + esc(RC.shortAddr(r.guardian_id)) + "</code></td>" +
        "<td>" + esc(r.delay || "—") + "</td>" +
        "<td>" + esc(ago(r.timestamp)) + "</td>";
      ht.appendChild(tr);
    });
  }

  /* ============ wire up ============ */
  document.addEventListener("DOMContentLoaded", function () {
    renderLifecycle();
    ["plDest", "plAmount", "plDelay", "plUnit", "plMode"].forEach(function (id) {
      $(id).addEventListener("input", updatePlanner);
      $(id).addEventListener("change", updatePlanner);
    });
    ["hsSender", "hsGuardian", "hsDelay", "hsUnit"].forEach(function (id) {
      $(id).addEventListener("input", updateHS);
      $(id).addEventListener("change", updateHS);
    });
    $("qAdd").addEventListener("click", function () {
      var v = parseInt($("qBlock").value, 10);
      if (!Number.isFinite(v)) {
        /* No explicit block: default to the live height — and if that is
         * unknown, refuse rather than fabricate a height (the old code
         * silently used a hard-coded 146270 from build day). */
        if (!window.__revHeight) {
          $("qNote").innerHTML = "<span class='bad'>Enter a block number — the live height is unavailable, so there is no honest default to add at.</span>";
          return;
        }
        v = window.__revHeight;
      }
      quotaTxs.push(v);
      renderQuota();
    });
    $("qClear").addEventListener("click", function () { quotaTxs = []; renderQuota(); });
    $("feeAmount").addEventListener("input", updateFee);
    updatePlanner();
    updateHS();
    renderQuota();
    updateFee();
    loadSnapshot();
  });
})();
