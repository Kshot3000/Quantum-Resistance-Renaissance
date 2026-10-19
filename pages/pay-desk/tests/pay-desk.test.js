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
/* Formula injection (2026-10-15): a reference cell a spreadsheet would
 * evaluate is quote-guarded; producer cells (ids, amounts, addresses,
 * statuses) can never start with a formula starter and stay untouched. */
eq("csv formula = guarded", P.csvEscape("=2+5+cmd|' /C calc'!A0"), "'=2+5+cmd|' /C calc'!A0");
eq("csv formula + guarded", P.csvEscape("+2+2"), "'+2+2");
eq("csv formula - guarded", P.csvEscape("-2+2"), "'-2+2");
eq("csv formula @ guarded", P.csvEscape("@SUM(1+1)"), "'@SUM(1+1)");
eq("csv formula space-led guarded", P.csvEscape(" =cmd"), "' =cmd");
eq("csv formula tab-led guarded", P.csvEscape("\t@x"), "'\t@x");
eq("csv guard leaves mid-string = alone", P.csvEscape("a=b"), "a=b");
eq("csv guard leaves invoice id alone", P.csvEscape("INV-20261015-041900-ABC"), "INV-20261015-041900-ABC");
eq("csv guard leaves zero alone", P.csvEscape("0"), "0");
eq("csv guardText exported", P.csvGuardText("=x"), "'=x");

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

/* ---- service fee split (2026-10-11, profit route) ---- */
(function () {
  const one = 1000000000000n; // 1 QTC in plancks
  let s = P.splitServiceFee(one, 50);
  eq("fee 0.5% of 1 QTC", s.feePlancks, 5000000000n);
  eq("merchant leg 0.5%", s.merchantPlancks, 995000000000n);
  t("legs sum exactly to total", s.feePlancks + s.merchantPlancks === one);
  s = P.splitServiceFee(one, 0);
  t("no fee -> merchant gets all", s.feePlancks === 0n && s.merchantPlancks === one && s.feeBps === 0);
  s = P.splitServiceFee(one, 25);
  eq("fee 0.25% of 1 QTC", s.feePlancks, 2500000000n);
  s = P.splitServiceFee(one, 100);
  eq("fee 1% of 1 QTC", s.feePlancks, 10000000000n);
  s = P.splitServiceFee(one, 500);
  t("bps capped at the 1% code maximum", s.feeBps === 100 && s.feePlancks === 10000000000n);
  s = P.splitServiceFee(one, -50);
  t("negative bps -> no fee", s.feeBps === 0 && s.feePlancks === 0n);
  s = P.splitServiceFee(3n, 50); // fee = floor(3 * 50 / 10000) = 0
  t("fee floors, never rounds past the quoted %", s.feePlancks === 0n && s.merchantPlancks === 3n);
  s = P.splitServiceFee(19999n, 50); // floor(19999*50/10000) = 99
  t("fee floor exact on odd plancks", s.feePlancks === 99n && s.feePlancks + s.merchantPlancks === 19999n);
  s = P.splitServiceFee(0n, 50);
  t("zero total -> zero legs", s.feePlancks === 0n && s.merchantPlancks === 0n);
  // Sweep: legs always sum, fee never exceeds the quoted percentage.
  let bad = 0;
  for (let total = 1n; total < 5000000000000n; total += 123456789n) {
    for (const bps of [25, 50, 100]) {
      const r = P.splitServiceFee(total, bps);
      if (r.feePlancks + r.merchantPlancks !== total) bad++;
      if (r.feePlancks * 10000n > total * BigInt(bps)) bad++;
      if (r.merchantPlancks < 0n) bad++;
    }
  }
  t("split sweep: exact sums, fee never over quote", bad === 0, bad + " bad");
  eq("fee label 50", P.feeBpsLabel(50), "0.5%");
  eq("fee label 25", P.feeBpsLabel(25), "0.25%");
  eq("fee label 100", P.feeBpsLabel(100), "1%");
  eq("fee label 0", P.feeBpsLabel(0), "0%");
  eq("fee label Infinity -> 0% (Batch 199)", P.feeBpsLabel(Infinity), "0%");
  eq("fee label -Infinity -> 0% (Batch 199)", P.feeBpsLabel(-Infinity), "0%");
  eq("fee label NaN -> 0% (Batch 199)", P.feeBpsLabel(NaN), "0%");
  eq("service fee address is Kyle's QTC address", P.SERVICE_FEE_ADDRESS, "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau");
  eq("service fee cap", P.SERVICE_FEE_MAX_BPS, 100);
})();

/* ---- persisted register boundary (2026-10-12) ----
 * The register loads from localStorage, an untrusted source. Only
 * entries whose derived fields recompute exactly may survive: qtc from
 * (usdCents, rate), the fee split from (plancks, bps), and the fee
 * address, which may only ever be SERVICE_FEE_ADDRESS — a stored entry
 * pointing the fee at another address is the redirection attack this
 * boundary exists to stop. Pre-fee-era invoices (no fee fields at all)
 * normalize to fee-less instead of dropping. */
(function () {
  global.window = global.window || {};
  require("../js/ss58.js");
  const SS58 = global.window.QTC_SS58;
  const valid = (a) => { const d = SS58.ss58Decode(a); return d.ok && d.prefix === 189 && d.key.length === 32; };
  const KYLE = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
  const OTHER = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7";
  const CREATED = Date.UTC(2026, 9, 1, 4, 5, 6); // == the INV-20261001-040506 id stamp below (id is derived from created)
  const good = (over) => Object.assign({
    id: "INV-20261001-040506-ABC", ref: "good", address: KYLE,
    usdCents: "1250", qtc: "1", plancks: "1000000000000",
    serviceFeeBps: 50, serviceFeeQtc: "0.005", serviceFeePlancks: "5000000000",
    serviceFeeAddress: KYLE, merchantQtc: "0.995", merchantPlancks: "995000000000",
    rate: "12.50", rateTs: CREATED, created: CREATED, expiresAt: CREATED + 1800000,
    status: "pending",
  }, over || {});
  const S = (raw) => P.sanitizeRegister(raw, valid);

  t("non-array -> empty", Array.isArray(S({ a: 1 })) && S({ a: 1 }).length === 0 && S(null).length === 0 && S("x").length === 0);
  eq("good invoice survives", S([good()]).length, 1);
  eq("non-objects dropped", S([null, 42, "x", [1], good()]).length, 1);
  eq("garbage usdCents dropped (BigInt crash)", S([good({ usdCents: "abc" })]).length, 0);
  eq("numeric usdCents dropped (creation writes strings)", S([good({ usdCents: 1250 })]).length, 0);
  eq("zero plancks dropped", S([good({ plancks: "0" })]).length, 0);
  eq("fee redirection dropped", S([good({ serviceFeeAddress: OTHER })]).length, 0);
  eq("split mismatch dropped", S([good({ serviceFeePlancks: "999", serviceFeeQtc: "0.000000000999" })]).length, 0);
  eq("merchant mismatch dropped", S([good({ merchantPlancks: "1" })]).length, 0);
  eq("bps over the code cap dropped", S([good({ serviceFeeBps: 5000, serviceFeeQtc: "0.5", serviceFeePlancks: "500000000000", merchantQtc: "0.5", merchantPlancks: "500000000000" })]).length, 0);
  eq("fractional bps dropped", S([good({ serviceFeeBps: 50.5 })]).length, 0);
  eq("qtc/rate relation mismatch dropped", S([good({ qtc: "2", plancks: "2000000000000", serviceFeePlancks: "10000000000", serviceFeeQtc: "0.01", merchantPlancks: "1990000000000", merchantQtc: "1.99" })]).length, 0);
  eq("bad address dropped", S([good({ address: "not-an-address" })]).length, 0);
  eq("wrong-prefix address dropped", S([good({ address: SS58.ss58Encode(new Array(32).fill(7), 42) })]).length, 0);
  eq("short-key address dropped", S([good({ address: SS58.ss58Encode(new Array(20).fill(7), 189) })]).length, 0);
  eq("reserved-form address dropped (0xBD fake 189)", S([good({ address: "KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC" })]).length, 0);
  t("ss58 codec rejects reserved forms directly", SS58.ss58Decode("KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC").kind === "format" && SS58.ss58Decode("LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ").kind === "format");
  eq("garbage created dropped (toISOString crash)", S([good({ created: "garbage" })]).length, 0);
  eq("unknown status dropped", S([good({ status: "evil-status" })]).length, 0);
  eq("duplicate ids deduped", S([good(), good({ ref: "dupe" })]).length, 1);
  eq("bad id charset dropped", S([good({ id: 'x"><svg>' })]).length, 0);
  (function () {
    const LEGACY_CREATED = Date.UTC(2026, 8, 30, 12, 0, 0); // == INV-20260930-120000
    const legacy = {
      id: "INV-20260930-120000-XYZ", ref: "legacy", address: OTHER,
      usdCents: "2500", qtc: "2", plancks: "2000000000000",
      rate: "12.50", rateTs: LEGACY_CREATED, created: LEGACY_CREATED, expiresAt: LEGACY_CREATED + 1800000, status: "paid",
    };
    const out = S([legacy]);
    eq("legacy invoice survives", out.length, 1);
    t("legacy normalized fee-less", out.length === 1 && out[0].serviceFeeBps === 0 && out[0].serviceFeePlancks === "0" && out[0].serviceFeeAddress === "" && out[0].merchantPlancks === "2000000000000");
    const noFee = S([good({ serviceFeeBps: 0, serviceFeeQtc: "0", serviceFeePlancks: "0", serviceFeeAddress: "", merchantQtc: "1", merchantPlancks: "1000000000000" })]);
    eq("explicit no-fee invoice survives", noFee.length, 1);
    const capped = [];
    for (let i = 0; i < 600; i++) capped.push(good({ id: "INV-20261001-040506-" + String(i).padStart(3, "0") }));
    eq("register capped at 500", S(capped).length, 500);
    const shaped = P.sanitizeRegister([good({ address: "not-an-address" })], null);
    eq("no-validator fallback still rejects malformed address shape", shaped.length, 0);
    const shapedOk = P.sanitizeRegister([good()], null);
    eq("no-validator fallback keeps well-shaped entries", shapedOk.length, 1);
    const refCap = S([good({ ref: "x".repeat(500) })]);
    t("ref capped at 120 chars", refCap.length === 1 && refCap[0].ref.length === 120);
    const badExpiry = S([good({ expiresAt: "never" })]);
    t("bad expiresAt clamps to created (already expired, never live)", badExpiry.length === 1 && badExpiry[0].expiresAt === CREATED);
  })();
})();

/* ---- register time/id relations (2026-10-13) ----
 * createInvoice stamps created = Date.now() and derives the id from
 * that same instant (makeInvoiceId), sets expiresAt to created plus
 * one of the expiry select's offsets (15/30/60/1440 min), and copies
 * rateTs from the rate saved BEFORE the invoice existed. The 2026-10-12
 * boundary recomputed the money relations but let any positive created
 * through: a 2020/2999 invoice painted and CSV-exported as fact, an id
 * could disagree with its own created, a 7-day "expiry" no producer
 * writes stayed live, and a future rateTs painted a quote time after
 * the invoice it priced. */
(function () {
  global.window = global.window || {};
  require("../js/ss58.js");
  const SS58 = global.window.QTC_SS58;
  const valid = (a) => { const d = SS58.ss58Decode(a); return d.ok && d.prefix === 189 && d.key.length === 32; };
  const KYLE = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
  const CREATED = Date.UTC(2026, 9, 1, 4, 5, 6);
  const NOW = Date.UTC(2026, 9, 13, 17, 0, 0);
  const good = (over) => Object.assign({
    id: "INV-20261001-040506-ABC", ref: "good", address: KYLE,
    usdCents: "1250", qtc: "1", plancks: "1000000000000",
    serviceFeeBps: 50, serviceFeeQtc: "0.005", serviceFeePlancks: "5000000000",
    serviceFeeAddress: KYLE, merchantQtc: "0.995", merchantPlancks: "995000000000",
    rate: "12.50", rateTs: CREATED, created: CREATED, expiresAt: CREATED + 1800000,
    status: "pending",
  }, over || {});
  const S = (raw) => P.sanitizeRegister(raw, valid, NOW);

  eq("relations: well-formed invoice kept", S([good()]).length, 1);
  eq("relations: created in 2020 dropped", S([good({ created: Date.UTC(2020, 0, 1), id: "INV-20200101-000000-ABC", rateTs: Date.UTC(2020, 0, 1), expiresAt: Date.UTC(2020, 0, 1) + 1800000 })]).length, 0);
  eq("relations: created in 2999 dropped", S([good({ created: Date.UTC(2999, 0, 1), id: "INV-29990101-000000-ABC", expiresAt: Date.UTC(2999, 0, 1) + 1800000 })]).length, 0);
  eq("relations: id date disagreeing with created dropped", S([good({ id: "INV-20261002-040506-ABC" })]).length, 0);
  eq("relations: id clock disagreeing with created dropped", S([good({ id: "INV-20261001-040507-ABC" })]).length, 0);
  eq("relations: non-producer id format dropped", S([good({ id: "invoice-20261001" })]).length, 0);
  eq("relations: lowercase id suffix dropped", S([good({ id: "INV-20261001-040506-abc" })]).length, 0);
  (function () {
    const o17 = S([good({ expiresAt: CREATED + 17 * 60000 })]);
    t("relations: 17-minute expiry coerced to created", o17.length === 1 && o17[0].expiresAt === CREATED);
    const o7d = S([good({ expiresAt: CREATED + 7 * 86400000 })]);
    t("relations: 7-day expiry coerced to created", o7d.length === 1 && o7d[0].expiresAt === CREATED);
    const o24 = S([good({ expiresAt: CREATED + 86400000 })]);
    t("relations: 24h producer expiry kept verbatim", o24.length === 1 && o24[0].expiresAt === CREATED + 86400000);
    const oRate = S([good({ rateTs: CREATED + 86400000 })]);
    t("relations: rateTs after created falls back to created", oRate.length === 1 && oRate[0].rateTs === CREATED);
    const oRateOld = S([good({ rateTs: Date.UTC(2020, 0, 1) })]);
    t("relations: rateTs in 2020 falls back to created", oRateOld.length === 1 && oRateOld[0].rateTs === CREATED);
    const oRateOk = S([good({ rateTs: CREATED - 3600000 })]);
    t("relations: rateTs an hour before the invoice kept verbatim", oRateOk.length === 1 && oRateOk[0].rateTs === CREATED - 3600000);
  })();
  (function () {
    global.localStorage = {
      _v: null,
      getItem() { return this._v; }, setItem(k, v) { this._v = v; }, removeItem() { this._v = null; },
    };
    global.localStorage._v = JSON.stringify({ usdPerQtc: "12.50", ts: Date.UTC(2999, 0, 1) });
    eq("relations: stored rate from 2999 rejected", P.loadRate(NOW), null);
    global.localStorage._v = JSON.stringify({ usdPerQtc: "12.50", ts: Date.UTC(2020, 0, 1) });
    eq("relations: stored rate from 2020 rejected", P.loadRate(NOW), null);
    global.localStorage._v = JSON.stringify({ usdPerQtc: "12.50", ts: NOW - 60000 });
    const r = P.loadRate(NOW);
    t("relations: stored rate from a minute ago kept", !!r && r.ts === NOW - 60000 && r.usdPerQtc === "12.50");
    delete global.localStorage;
  })();
})();

/* ---- stored-rate grammar + decimal-parser exponent bound ----
 * The only writer of a stored rate is the rate-save handler: it trims
 * the rate input, requires /^\d+(\.\d+)?$/, and saveRate stores that
 * STRING verbatim; createInvoice copies it into inv.rate verbatim.
 * loadRate and sanitizeRegister used to String()-coerce whatever they
 * found, so a numeric rate, ".5", or "1e-3" survived — and the exponent
 * form reached parseDecimalRational's exponent branch, which computed
 * 10n ** exponent unbounded: the 11-char stored "1e100000000" hung
 * loadRate (state init, before any UI) on every load. The parser now
 * bounds |exponent| and |scale| at 1000 (a JS number stringifies with
 * at most e308 / 5e-324, so nothing real is lost), and both stored-rate
 * reads hold the value to the producer's string grammar. */
(function () {
  eq("parser: 1e100000000 refused, not computed", P.parseDecimalRational("1e100000000"), null);
  eq("parser: 1e-100000000 refused, not computed", P.parseDecimalRational("1e-100000000"), null);
  eq("parser: poison rate through centsToQtcString refused", P.centsToQtcString(100n, "1e100000000"), null);
  t("parser: 5000-digit fraction refused", P.parseDecimalRational("0." + "0".repeat(5000) + "1") === null);
  t("parser: smallest JS-number exponent 5e-324 still parses", P.parseDecimalRational("5e-324") !== null);

  global.window = global.window || {};
  require("../js/ss58.js");
  const SS58 = global.window.QTC_SS58;
  const valid = (a) => { const d = SS58.ss58Decode(a); return d.ok && d.prefix === 189 && d.key.length === 32; };
  const KYLE = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
  const CREATED = Date.UTC(2026, 9, 1, 4, 5, 6);
  const NOW = Date.UTC(2026, 9, 13, 17, 0, 0);
  global.localStorage = {
    _v: null,
    getItem() { return this._v; }, setItem(k, v) { this._v = v; }, removeItem() { this._v = null; },
  };
  const setRate = (usdPerQtc) => { global.localStorage._v = JSON.stringify({ usdPerQtc, ts: NOW - 60000 }); };
  setRate(12.5);
  eq("rate grammar: numeric stored rate rejected", P.loadRate(NOW), null);
  setRate(".5");
  eq("rate grammar: leading-dot stored rate rejected", P.loadRate(NOW), null);
  setRate("1e-3");
  eq("rate grammar: exponent stored rate rejected", P.loadRate(NOW), null);
  setRate(" 12.50 ");
  eq("rate grammar: padded stored rate rejected", P.loadRate(NOW), null);
  setRate("12.50");
  t("rate grammar: producer string kept verbatim", (() => { const r = P.loadRate(NOW); return !!r && r.usdPerQtc === "12.50"; })());
  delete global.localStorage;

  const good = (over) => Object.assign({
    id: "INV-20261001-040506-ABC", ref: "good", address: KYLE,
    usdCents: "1250", qtc: "1", plancks: "1000000000000",
    serviceFeeBps: 50, serviceFeeQtc: "0.005", serviceFeePlancks: "5000000000",
    serviceFeeAddress: KYLE, merchantQtc: "0.995", merchantPlancks: "995000000000",
    rate: "12.50", rateTs: CREATED, created: CREATED, expiresAt: CREATED + 1800000,
    status: "pending",
  }, over || {});
  const S = (raw) => P.sanitizeRegister(raw, valid, NOW);
  eq("rate grammar: register exponent rate dropped (relation otherwise exact)", S([good({ rate: "1.25e1" })]).length, 0);
  eq("rate grammar: register numeric rate dropped", S([good({ rate: 12.5 })]).length, 0);
  eq("rate grammar: register exponent bomb dropped", S([good({ rate: "1e100000000" })]).length, 0);
})();

/* ---- register creation cap (2026-10-15, white-hat track) ----
 * sanitizeRegister caps the register at REGISTER_CAP=500 at load
 * (first-wins; the register is newest-first), but createInvoice
 * unshifted with no cap check: at a full register the unshift persisted
 * 501 and the next load silently evicted the OLDEST invoice.
 * createInvoice now asks registerRoom first and refuses with the cap
 * named. The gate's arithmetic is exact and fail-closed. */
eq("register cap is 500", P.REGISTER_CAP, 500);
eq("registerRoom(0) === 500", P.registerRoom(0), 500);
eq("registerRoom(499) === 1", P.registerRoom(499), 1);
eq("registerRoom(500) === 0", P.registerRoom(500), 0);
eq("registerRoom(5000) === 0 (never negative)", P.registerRoom(5000), 0);
t("registerRoom(non-finite) === 0 (fail-closed)", P.registerRoom(NaN) === 0 && P.registerRoom("x") === 0 && P.registerRoom(undefined) === 0);
eq("registerRoom(-3) === 0 (fail-closed)", P.registerRoom(-3), 0);
eq("registerRoom(499.9) === 1 (floor)", P.registerRoom(499.9), 1);

/* ---- constants ---- */
eq("plancks per QTC", P.PLANCKS_PER_QTC, 1000000000000n);

/* ---- Batch 194: amount-input length bound (both parsers; the rational
 * rate parser already capped at 512, these two BigInt'd whole) ---- */
eq("amountbound qtc: genuine", P.parseQtcToPlancks("1.5"), 1500000000000n);
eq("amountbound qtc: 600 digits -> null", P.parseQtcToPlancks("9".repeat(600)), null);
eq("amountbound qtc: long-but-tiny -> null by gate", P.parseQtcToPlancks("0".repeat(600) + "1.5"), null);
eq("amountbound qtc: 2M digits -> null", P.parseQtcToPlancks("9".repeat(2000000)), null);
t("amountbound qtc: at-cap parses", typeof P.parseQtcToPlancks("9".repeat(512)) === "bigint");
eq("amountbound usd: genuine", P.parseUsdToCents("12.50"), 1250n);
eq("amountbound usd: 600 digits -> null", P.parseUsdToCents("9".repeat(600)), null);
eq("amountbound usd: long-but-tiny -> null by gate", P.parseUsdToCents("0".repeat(600) + "1.5"), null);
eq("amountbound usd: 2M digits -> null", P.parseUsdToCents("9".repeat(2000000)), null);

console.log("pay-desk tests: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
