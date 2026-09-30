/* QTC Legacy Vault — plan logic (no DOM).
 * Beneficiary plan validation, readiness scoring, and the printable
 * inheritance letter generator. Everything user-supplied is HTML-escaped.
 * Works in browsers (window.QTC_LEGACY_LOGIC) and Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QTC_LEGACY_LOGIC = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- beneficiaries ----------
  // beneficiary: { name, relation, sharePct, contact, notes }
  function validateBeneficiaries(list) {
    const errors = [];
    const warnings = [];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push("Add at least one beneficiary.");
      return { errors, warnings };
    }
    let total = 0;
    const seen = new Set();
    list.forEach((b, i) => {
      const tag = `Beneficiary ${i + 1}`;
      const name = (b.name || "").trim();
      if (!name) errors.push(`${tag}: name is required.`);
      else {
        const key = name.toLowerCase();
        if (seen.has(key)) errors.push(`${tag}: duplicate name "${b.name}".`);
        seen.add(key);
      }
      const pct = Number(b.sharePct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        errors.push(`${tag}: share must be a number from 0 to 100.`);
      } else {
        total += pct;
      }
      if (!(b.contact || "").trim() && !(b.notes || "").trim()) {
        warnings.push(`${tag || name}: no contact or notes — how will they be reached?`);
      }
    });
    if (errors.length === 0) {
      if (total > 100) errors.push(`Shares add up to ${total}% — over 100%.`);
      else if (total < 100) {
        warnings.push(`Shares add up to ${total}% — the remaining ${100 - total}% is unassigned.`);
      }
    }
    return { errors, warnings, totalPct: total };
  }

  // ---------- holdings register ----------
  // holding: { item, location, access }
  function validateHoldings(list) {
    const errors = [];
    const warnings = [];
    (list || []).forEach((h, i) => {
      const tag = `Holding ${i + 1}`;
      if (!(h.item || "").trim() && !(h.location || "").trim() && !(h.access || "").trim()) return;
      if (!(h.item || "").trim()) errors.push(`${tag}: describe the item.`);
      if (!(h.location || "").trim()) warnings.push(`${tag}: no storage location recorded.`);
      if (!(h.access || "").trim()) warnings.push(`${tag}: no access instructions recorded.`);
    });
    return { errors, warnings };
  }

  // ---------- readiness checklist ----------
  const CHECKLIST = [
    { id: "backup", label: "Seed / secret backed up on a durable medium (steel, not just paper)", weight: 3 },
    { id: "copies", label: "Backup exists in at least two physically separate locations", weight: 2 },
    { id: "split", label: "No single location holds the full secret (split, multisig, or equivalent)", weight: 3 },
    { id: "heirs", label: "At least one trusted person knows the plan exists and where to start", weight: 2 },
    { id: "letter", label: "Written instructions exist that a non-crypto person can follow", weight: 2 },
    { id: "checkphrase", label: "Receiving addresses verified by checkphrase (no poisoned addresses)", weight: 1 },
    { id: "tested", label: "Recovery path tested end-to-end at least once (on a small amount)", weight: 3 },
    { id: "review", label: "Plan reviewed within the last 12 months", weight: 1 },
  ];

  function readinessScore(checkedIds) {
    const set = new Set(checkedIds || []);
    let got = 0, max = 0;
    for (const c of CHECKLIST) {
      max += c.weight;
      if (set.has(c.id)) got += c.weight;
    }
    const pct = max === 0 ? 0 : Math.round((got / max) * 100);
    let band;
    if (pct >= 85) band = "Vault-grade";
    else if (pct >= 60) band = "Solid";
    else if (pct >= 35) band = "Fragile";
    else band = "Exposed";
    return { got, max, pct, band };
  }

  // ---------- inheritance letter ----------
  // plan: { owner, date, beneficiaries, holdings, deadman, extraNotes }
  function buildLetter(plan) {
    const p = plan || {};
    const owner = (p.owner || "").trim() || "[Your full legal name]";
    const date = (p.date || "").trim() || new Date().toISOString().slice(0, 10);
    const beneficiaries = Array.isArray(p.beneficiaries) ? p.beneficiaries : [];
    const holdings = Array.isArray(p.holdings) ? p.holdings : [];
    const deadman = (p.deadman || "").trim();
    const extra = (p.extraNotes || "").trim();

    const benRows = beneficiaries.length
      ? beneficiaries.map((b, i) => {
          const pct = Number(b.sharePct);
          return `<tr><td>${i + 1}</td><td>${esc(b.name) || "—"}</td>` +
            `<td>${esc(b.relation) || "—"}</td>` +
            `<td>${Number.isFinite(pct) ? esc(String(pct)) + "%" : "—"}</td>` +
            `<td>${esc(b.contact) || "—"}</td></tr>`;
        }).join("")
      : `<tr><td colspan="5" class="empty">No beneficiaries recorded yet — add them in the Plan tab.</td></tr>`;

    const holdRows = holdings.filter((h) => (h.item || "").trim()).length
      ? holdings.filter((h) => (h.item || "").trim()).map((h, i) =>
          `<tr><td>${i + 1}</td><td>${esc(h.item)}</td>` +
          `<td>${esc(h.location) || "—"}</td><td>${esc(h.access) || "—"}</td></tr>`
        ).join("")
      : `<tr><td colspan="4" class="empty">No holdings recorded yet — add them in the Plan tab.</td></tr>`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Inheritance letter — ${esc(owner)}</title>
<style>
 body{font-family:Georgia,'Times New Roman',serif;color:#111;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.65}
 h1{font-size:26px;border-bottom:3px double #8a6a2f;padding-bottom:12px}
 h2{font-size:18px;margin-top:32px;color:#5c4416}
 table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
 th,td{border:1px solid #999;padding:8px 10px;text-align:left;vertical-align:top}
 th{background:#f3ead6}
 .empty{color:#666;font-style:italic}
 .warn{background:#fdf6e3;border:1px solid #c9a227;padding:12px 16px;margin:24px 0;font-size:14px}
 .sig{margin-top:48px;display:flex;gap:48px}
 .sig div{flex:1;border-top:1px solid #333;padding-top:8px;font-size:13px}
 @media print{body{margin:0}}
</style></head><body>
<h1>Letter of instruction — digital assets</h1>
<p><strong>Prepared by:</strong> ${esc(owner)}<br>
<strong>Date:</strong> ${esc(date)}</p>
<p>If you are reading this, I am incapacitated or deceased. This letter explains how to
recover my Quantus (QTC) holdings and distribute them according to the table below.
<strong>Do not share this letter, photograph it, or store it digitally.</strong> Work
through it in order, and ask a trusted technically-competent person for help before
moving any funds.</p>
<h2>1. Where things are</h2>
<table><tr><th>#</th><th>Item</th><th>Location</th><th>How to access</th></tr>${holdRows}</table>
<h2>2. Who receives what</h2>
<table><tr><th>#</th><th>Name</th><th>Relationship</th><th>Share</th><th>Contact</th></tr>${benRows}</table>
${deadman ? `<h2>3. If I go quiet (dead-man arrangement)</h2><p>${esc(deadman)}</p>` : ""}
${extra ? `<h2>${deadman ? "4" : "3"}. Additional notes</h2><p>${esc(extra)}</p>` : ""}
<div class="warn"><strong>Before moving anything:</strong> verify every receiving address
with its five-word human checkphrase (see the Quantus SafeSend Lab). One wrong character
sends funds somewhere unrecoverable. Move a tiny test amount first, confirm it arrives,
then move the rest.</div>
<div class="sig"><div>Signature<br><br>___________________________</div>
<div>Date<br><br>___________________________</div></div>
</body></html>`;
  }

  return { esc, validateBeneficiaries, validateHoldings, CHECKLIST, readinessScore, buildLetter };
});
