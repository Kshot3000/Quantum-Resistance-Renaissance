/* QTC Pay Desk — node test suite.
 * Anchored to verified sources:
 *  - QTC = 12 decimals (1 QTC = 10^12 plancks), SS58 prefix 189: upstream
 *    Quantus-Network chain crates, verified byte-for-byte in the Web Wallet
 *    (2026-09-30); block rewards 0.30-0.32 QTC in data/live.json (2026-09-30).
 *  - Test addresses: repo data/whales.json (real on-chain genesis account)
 *    and Kyle's own donation address from the hub footer (SS58-189).
 */
const P = require("../js/app.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function eq(name, got, want) {
  t(name, got === want, "got " + JSON.stringify(String(got)) + " want " + JSON.stringify(String(want)));
}

/* ---- USD -> cents ---- */
eq("cents 12.50", P.parseUsdToCents("12.50"), 1250n);
eq("cents 1,234.56", P.parseUsdToCents("1,234.56"), 123456n);
eq("cents .5", P.parseUsdToCents(".5"), 50n);
eq("cents 12 (no decimals)", P.parseUsdToCents("12"), 1200n);
eq("cents empty -> null", P.parseUsdToCents(""), null);
eq("cents garbage -> null", P.parseUsdToCents("abc"), null);
eq("cents negative sign -> null", P.parseUsdToCents("-5"), null);
eq("cents $ sign stripped", P.parseUsdToCents("$7.25"), 725n);
eq("cents 1.005 rounds half-up (was truncated to 100)", P.parseUsdToCents("1.005"), 101n);
eq("cents 1.999 rounds to 200", P.parseUsdToCents("1.999"), 200n);
eq("cents 1.994 stays 199", P.parseUsdToCents("1.994"), 199n);

/* ---- QTC -> plancks ---- */
eq("plancks 1 QTC", P.parseQtcToPlancks("1"), 1000000000000n);
eq("plancks 1 dust", P.parseQtcToPlancks("0.000000000001"), 1n);
eq("plancks 13th digit 4 -> no round", P.parseQtcToPlancks("1.0000000000004"), 1000000000000n);
eq("plancks 13th digit 5 -> rounds up", P.parseQtcToPlancks("1.0000000000005"), 1000000000001n);
eq("plancks empty -> null", P.parseQtcToPlancks(""), null);
eq("plancks garbage -> null", P.parseQtcToPlancks("nope"), null);

/* ---- plancks -> QTC string (round trip) ---- */
eq("qtc string 1", P.plancksToQtcString(1000000000000n), "1");
eq("qtc string trims zeros", P.plancksToQtcString(1500000000000n), "1.5");
eq("qtc string dust", P.plancksToQtcString(1n), "0.000000000001");
eq("round trip 2.75", P.plancksToQtcString(P.parseQtcToPlancks("2.75")), "2.75");
eq("round trip 0.1 exact", P.parseQtcToPlancks(P.plancksToQtcString(100000000000n)), 100000000000n);

/* ---- USD formatting ---- */
eq("fmt 1250", P.fmtUsd(1250n), "$12.50");
eq("fmt thousands", P.fmtUsd(1234567n), "$12,345.67");
eq("fmt negative", P.fmtUsd(-500n), "-$5.00");
eq("fmt zero", P.fmtUsd(0n), "$0.00");

/* ---- cents -> QTC at rate ---- */
eq("$12.50 @ $12.50/QTC = 1 QTC", P.centsToQtcString(1250n, "12.50"), "1");
eq("$1 @ $2.50/QTC = 0.4 QTC", P.centsToQtcString(100n, "2.50"), "0.4");
eq("zero rate -> null", P.centsToQtcString(100n, "0"), null);
eq("bad rate -> null", P.centsToQtcString(100n, "xyz"), null);
t("no float dust on 0.1-ish amounts", P.parseQtcToPlancks(P.centsToQtcString(33n, "1.00")) === 330000000000n);
/* Exactness regression (2026-10-07): the float path disagreed with exact
 * rational arithmetic in 8,965/16,048 swept cases, worst 2,228 plancks. */
eq("exact: $1,234,567.89 @ $0.37", P.centsToQtcString(123456789n, "0.37"), "3336669.972972972973");
eq("exact: worst swept case @ $0.008912", P.centsToQtcString(18350321n, "0.008912"), "20590575.628366247756");
eq("rate as JS number", P.centsToQtcString(100n, 2.5), "0.4");
eq("rate in exponent form", P.centsToQtcString(100n, "1e-3"), "1000");
(function () {
  // Sweep against an independent in-test BigInt rational reference.
  function ref(cents, rate) {
    const m = /^(\d*)(?:\.(\d*))?$/.exec(rate);
    const frac = m[2] || "";
    const R = BigInt((m[1] || "0") + frac);
    const num = cents * 10n ** 12n * 10n ** BigInt(frac.length), den = 100n * R;
    let q = num / den; if ((num % den) * 2n >= den) q += 1n;
    return P.plancksToQtcString(q);
  }
  const rates = ["0.37", "2.50", "0.0314", "1.00", "12.50", "0.008912", "3.14159", "0.99"];
  let bad = 0, n = 0;
  for (const r of rates) for (let c = 1n; c < 20000000n; c += 9973n) { n++; if (P.centsToQtcString(c, r) !== ref(c, r)) bad++; }
  t("exact sweep " + n + " cases, 0 mismatches", bad === 0, bad + " mismatches");
})();

/* ---- invoice IDs ---- */
t("invoice id format", /^INV-\d{8}-\d{6}-[0-9A-Z]{3}$/.test(P.makeInvoiceId(Date.UTC(2026, 9, 1, 4, 5, 6))));
t("invoice id carries timestamp", P.makeInvoiceId(Date.UTC(2026, 9, 1, 4, 5, 6)).indexOf("INV-20261001-040506-") === 0);
(function () {
  // Realistic: a few invoices per second, clock stamp separates batches.
  const seen = new Set();
  for (let i = 0; i < 600; i++) seen.add(P.makeInvoiceId(Date.now() + Math.floor(i / 5) * 1000));
  t("invoice ids unique (600 draws, 5/sec)", seen.size === 600, seen.size);
})();

/* ---- invoice totals ---- */
(function () {
  const items = [
    { qty: 2, unitCents: 1250n },
    { qty: 1, unitCents: 999n },
  ];
  const r = P.invoiceTotals(items, 0n, 0);
  eq("subtotal 2x12.50 + 9.99", r.sub, 3499n);
  eq("no discount", r.disc, 0n);
  eq("no tax", r.tax, 0n);
  eq("total", r.total, 3499n);

  const r2 = P.invoiceTotals(items, 500n, 8);
  eq("discount applied", r2.disc, 500n);
  eq("tax on taxable", r2.tax, (2999n * 800n) / 10000n);
  eq("total with tax+discount", r2.total, 2999n + (2999n * 800n) / 10000n);

  const big = [{ qty: 1, unitCents: 100000n }];
  eq("tax 8.875% exact (was snapped to 8.88%)", P.invoiceTotals(big, 0n, "8.875").tax, 8875n);
  eq("tax 2.675% exact (was snapped to 2.67%)", P.invoiceTotals(big, 0n, "2.675").tax, 2675n);
  eq("tax as JS number still works", P.invoiceTotals(big, 0n, 8.875).tax, 8875n);

  const r3 = P.invoiceTotals(items, 99999n, 0);
  t("discount capped at subtotal", r3.total === 0n && r3.disc === 3499n);

  const r4 = P.invoiceTotals([], 0n, 0);
  t("empty items -> zero", r4.total === 0n && r4.sub === 0n);
})();

/* ---- countdown ---- */
eq("countdown 90s", P.fmtCountdown(90000), "1m 30s");
eq("countdown 45s", P.fmtCountdown(45000), "45s");
eq("countdown 1h+", P.fmtCountdown(3661000), "1h 01m 01s");
eq("countdown expired", P.fmtCountdown(0), "expired");
eq("countdown negative", P.fmtCountdown(-5), "expired");

/* ---- CSV escaping ---- */
eq("csv plain", P.csvEscape("abc"), "abc");
eq("csv comma", P.csvEscape("a,b"), '"a,b"');
eq("csv quotes doubled", P.csvEscape('a"b'), '"a""b"');

/* ---- tip snippet ---- */
(function () {
  const addr = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
  const s = P.tipSnippet(addr, "Tip QTC", "dark");
  t("snippet carries address", s.includes(addr));
  t("snippet carries label", s.includes("Tip QTC"));
  t("snippet has dark class", s.includes("qtip-dark"));
  t("snippet escapes label", !P.tipSnippet(addr, "<script>", "dark").includes("<script>"));
  const s2 = P.tipSnippet(addr, "Donate", "minimal");
  t("minimal class", s2.includes("qtip-minimal"));
})();

/* ---- constants ---- */
eq("plancks per QTC", P.PLANCKS_PER_QTC, 1000000000000n);

console.log("pay-desk tests: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
