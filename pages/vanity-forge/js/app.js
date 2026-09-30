/* QTC Vanity Forge — app wiring (ES module, 100% client-side).
 *
 * Reuses the verified chain-format stack from Key Forge:
 *   ../../key-forge/js/quantus-crypto.js  (Poseidon2 account-ID + SS58-189)
 *   ../../key-forge/vendor/noble/post-quantum/ml-dsa.js (FIPS-204 keygen)
 * Every keypair is forged locally with the OS CSPRNG; nothing leaves the page.
 */
import {
  LEAD, MAX_PATTERN,
  validatePattern, expectedAttempts, probFoundBy,
  attemptsForQuantile, medianAttempts, expectedSeconds,
  fmtInt, fmtDuration, difficultyLadder, addressMatches,
} from './vanity.js';
import { ml_dsa65, ml_dsa87 } from '../../key-forge/vendor/noble/post-quantum/ml-dsa.js';
import { pubkeyToAddress, hexEncode } from '../../key-forge/js/quantus-crypto.js';

const $ = (id) => document.getElementById(id);
const SCHEMES = {
  65: { mod: ml_dsa65, label: 'ML-DSA-65' },
  87: { mod: ml_dsa87, label: 'ML-DSA-87' },
};
const B58C = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rndB58 = (n) => Array.from({ length: n }, () => B58C[(Math.random() * 58) | 0]).join('');
const BENCH_KEY = 'qvf-bench-v1';
const VAULT_KEY = 'qvf-vault-v1';
const CHUNK = 30; // keygens per UI yield

/* ---------- ember canvas ---------- */
(() => {
  const cv = $('embers'), ctx = cv.getContext('2d');
  let W, H, parts = [];
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const spawn = (init) => ({
    x: Math.random() * W, y: init ? Math.random() * H : H + 12,
    vy: .35 + Math.random() * 1.2, vx: (Math.random() - .5) * .5,
    r: .9 + Math.random() * 2.4, life: 1,
    hue: 18 + Math.random() * 28, // molten golds/oranges
  });
  for (let i = 0; i < 80; i++) parts.push(spawn(true));
  const tick = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx + Math.sin(p.y / 40) * .3; p.y -= p.vy; p.life -= .0028;
      if (p.life <= 0 || p.y < -14) Object.assign(p, spawn(false));
      const a = Math.max(0, p.life) * .6;
      ctx.beginPath();
      ctx.fillStyle = `hsla(${p.hue},95%,60%,${a})`;
      ctx.shadowColor = `hsla(${p.hue},95%,55%,${a})`;
      ctx.shadowBlur = 8;
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    requestAnimationFrame(tick);
  };
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) tick();
})();

/* ---------- state ---------- */
let bench = {};
try { bench = JSON.parse(localStorage.getItem(BENCH_KEY) || '{}'); } catch { bench = {}; }
let vault = [];
try { vault = JSON.parse(localStorage.getItem(VAULT_KEY) || '[]'); } catch { vault = []; }
const saveBench = () => { try { localStorage.setItem(BENCH_KEY, JSON.stringify(bench)); } catch {} };
const saveVault = () => { try { localStorage.setItem(VAULT_KEY, JSON.stringify(vault)); } catch {} };

const grind = {
  running: false, attempts: 0, t0: 0, timer: null,
  cfg: null, rate: 0, stopRequested: false,
};

/* ---------- helpers ---------- */
function currentScheme() {
  return document.querySelector('input[name="scheme"]:checked').value;
}
function currentCase() { return $('caseSens').checked; }
function currentPos() {
  return document.querySelector('input[name="position"]:checked').value;
}
function readConfig() {
  const pos = currentPos();
  const v = validatePattern($('pattern').value, pos);
  if (!v.ok) return { ok: false, error: v.error };
  return {
    ok: true, pattern: v.pattern, leadNote: v.leadNote,
    scheme: currentScheme(), caseSensitive: currentCase(), position: pos,
  };
}
function rateFor(scheme) { return bench[scheme] && bench[scheme] > 0 ? bench[scheme] : null; }
function effectiveRate(scheme) { return rateFor(scheme) || 40; } // pre-bench estimate

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Copied ✓'; btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
  }
}

/* ---------- design panel: live difficulty readout ---------- */
function refreshDesign() {
  const cfg = readConfig();
  const msg = $('patternMsg'), prev = $('preview'), out = $('diffOut');
  if (!cfg.ok) {
    msg.textContent = cfg.error; msg.className = 'msg err';
    prev.innerHTML = '<span class="dim">Fix the pattern to see a preview.</span>';
    out.innerHTML = '<p class="hint">Enter a valid base58 pattern to see the grind math.</p>';
    $('grindBtn').disabled = true;
    return;
  }
  msg.textContent = cfg.leadNote
    ? 'Heads up: the leading "qz" is automatic on every Quantus address — grinding starts after it.'
    : 'Valid base58 pattern.';
  msg.className = 'msg ok';
  const tail = rndB58(10);
  const hl = `<b class="hl">${cfg.pattern}</b>`;
  prev.innerHTML = cfg.position === 'suffix'
    ? `<span class="mono">${LEAD}…${tail}${hl}</span>`
    : `<span class="mono">${LEAD}${hl}${tail}…</span>`;

  const exp = expectedAttempts(cfg.pattern, cfg);
  const rate = rateFor(cfg.scheme);
  const secs = expectedSeconds(exp, rate || 40);
  const q10 = attemptsForQuantile(0.1, exp), q50 = medianAttempts(exp), q90 = attemptsForQuantile(0.9, exp);
  out.innerHTML = `
    <div class="diff-grid">
      <div><div class="dv">${fmtInt(exp)}</div><div class="dl">expected keypairs to grind${cfg.position === 'suffix' ? ' <span class="approx">(suffix: approximate)</span>' : ''}</div></div>
      <div><div class="dv">${fmtDuration(secs)}</div><div class="dl">expected wall-clock ${rate ? `at your measured ${Math.round(rate)}/s` : 'at ~40 keys/s (run the benchmark)'}</div></div>
      <div><div class="dv">${fmtInt(q50)}</div><div class="dl">median grind (50% found by here)</div></div>
    </div>
    <p class="luck-line">Luck percentiles — 10% find one by <b>${fmtInt(q10)}</b> attempts · 90% by <b>${fmtInt(q90)}</b>. Each keypair is an independent draw: past attempts never "use up" bad luck.</p>`;
  $('grindBtn').disabled = false;
  renderLadder();
}

['pattern', 'caseSens'].forEach((id) => $(id).addEventListener('input', refreshDesign));
document.querySelectorAll('input[name="scheme"], input[name="position"]')
  .forEach((el) => el.addEventListener('change', refreshDesign));

/* ---------- difficulty explorer ---------- */
function renderLadder() {
  const scheme = currentScheme();
  const rate = effectiveRate(scheme);
  const rows = difficultyLadder(rate);
  const maxLog = Math.log10(rows[rows.length - 1].seconds || 1);
  $('ladder').innerHTML = rows.map((r) => {
    const w = Math.max(2, (Math.log10(Math.max(r.seconds, 0.01)) / maxLog) * 100);
    return `<tr>
      <td class="mono">${r.chars}</td>
      <td class="mono num">${fmtInt(r.expected)}</td>
      <td class="mono num">${fmtInt(r.median)}</td>
      <td class="mono num">${fmtDuration(r.seconds)}</td>
      <td><div class="lbar"><div style="width:${w.toFixed(1)}%"></div></div></td>
    </tr>`;
  }).join('');
  $('ladderNote').innerHTML =
    `Worst case (hardest pinned first character, <span class="mono">q</span> at ~1-in-24, then 58 per further character) at <b>${rateFor(scheme) ? Math.round(rateFor(scheme)) + ' measured' : '~40 estimated'}</b> keys/s on ${SCHEMES[scheme].label}. ` +
    `Case-insensitive letters grind ~2× faster per letter after the first. The honest read: <b>1–3 characters</b> is a coffee break, ` +
    `<b>4</b> is a long grind on a fast machine, <b>5–6</b> is a datacenter's problem.`;
}

/* ---------- benchmark ---------- */
$('benchBtn').addEventListener('click', async () => {
  const btn = $('benchBtn');
  btn.disabled = true;
  const out = $('benchOut');
  for (const scheme of ['65', '87']) {
    out.innerHTML = `<p class="hint">Benchmarking ${SCHEMES[scheme].label}…</p>`;
    const N = 120;
    let done = 0;
    const t0 = performance.now();
    while (done < N) {
      const n = Math.min(CHUNK, N - done);
      for (let i = 0; i < n; i++) {
        const { publicKey } = SCHEMES[scheme].mod.keygen();
        pubkeyToAddress(publicKey);
      }
      done += n;
      out.innerHTML = `<p class="hint">Benchmarking ${SCHEMES[scheme].label}… ${done}/${N}</p>`;
      await new Promise((r) => setTimeout(r, 0));
    }
    const rate = (N / (performance.now() - t0)) * 1000;
    bench[scheme] = rate;
    saveBench();
    out.innerHTML = `<p class="hint">Benchmarking ${SCHEMES[scheme].label}… done.</p>`;
  }
  saveBench();
  renderBench();
  refreshDesign();
  btn.disabled = false;
});

function renderBench() {
  const r65 = rateFor('65'), r87 = rateFor('87');
  $('benchOut').innerHTML = (r65 || r87)
    ? `<div class="bench-res">
         <div><div class="dv">${r65 ? Math.round(r65) + '/s' : '—'}</div><div class="dl">ML-DSA-65 keypairs + addresses</div></div>
         <div><div class="dv">${r87 ? Math.round(r87) + '/s' : '—'}</div><div class="dl">ML-DSA-87 keypairs + addresses</div></div>
       </div>
       <p class="hint">Saved in this browser — difficulty times and ETAs use your real rate from now on.</p>`
    : '<p class="hint">No benchmark yet. ~2 minutes of number-crunching; the grind math gets honest after.</p>';
  $('stat-rate').textContent = r65 ? `${Math.round(r65)}/s` : '—';
}

/* ---------- grinder ---------- */
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function setGrindUI() {
  $('grindBtn').textContent = grind.running ? '■ Stop the forge' : '▶ Start grinding';
  $('grindBtn').classList.toggle('stop', grind.running);
  $('pattern').disabled = grind.running;
}

$('grindBtn').addEventListener('click', () => {
  if (grind.running) { grind.stopRequested = true; return; }
  const cfg = readConfig();
  if (!cfg.ok) { $('pattern').focus(); return; }
  grind.cfg = cfg;
  grind.running = true; grind.stopRequested = false;
  grind.attempts = 0; grind.t0 = performance.now(); grind.rate = 0;
  setGrindUI();
  $('forgeStatus').textContent = `Grinding ${SCHEMES[cfg.scheme].label} keypairs for "${cfg.pattern}"…`;
  $('forgeStatus').className = 'forge-status live';
  grindLoop();
});

async function grindLoop() {
  const cfg = grind.cfg;
  const S = SCHEMES[cfg.scheme].mod;
  const exp = expectedAttempts(cfg.pattern, cfg);
  const stopFirst = $('stopFirst').checked;
  let lastUi = 0;
  while (!grind.stopRequested) {
    for (let i = 0; i < CHUNK; i++) {
      const { publicKey, secretKey } = S.keygen();
      const address = pubkeyToAddress(publicKey);
      grind.attempts++;
      if (addressMatches(address, cfg.pattern, cfg)) {
        onFound({ address, secretKey, attempts: grind.attempts, ms: performance.now() - grind.t0, cfg });
        if (stopFirst) { grind.stopRequested = true; break; }
      }
    }
    const now = performance.now();
    grind.rate = (grind.attempts / (now - grind.t0)) * 1000;
    if (now - lastUi > 250) { lastUi = now; renderGrindStats(exp); }
    await new Promise((r) => setTimeout(r, 0));
  }
  grind.running = false;
  setGrindUI();
  renderGrindStats(exp);
  $('forgeStatus').textContent = grind.stopRequested && grind.attempts > 0 && !$('foundList').children.length
    ? `Stopped after ${fmtInt(grind.attempts)} attempts — no match yet. The pattern is still loaded; start again any time.`
    : $('forgeStatus').textContent;
  $('forgeStatus').className = 'forge-status';
}

function renderGrindStats(exp) {
  const el = performance.now() - grind.t0;
  const rate = grind.rate || effectiveRate(grind.cfg.scheme);
  const remain = Math.max(0, exp - grind.attempts);
  $('gAttempts').textContent = fmtInt(grind.attempts);
  $('gElapsed').textContent = fmtClock(el);
  $('gRate').textContent = `${Math.round(rate)}/s`;
  $('gEta').textContent = grind.attempts >= exp
    ? 'past expected — luck pending'
    : `~${fmtDuration(remain / rate)} to expected`;
  const luck = probFoundBy(grind.attempts, exp);
  $('luckBar').style.width = `${Math.min(100, luck * 100).toFixed(1)}%`;
  $('luckPct').textContent = `${(luck * 100).toFixed(1)}% likely found by now`;
}

/* ---------- found cards + vault ---------- */
function highlight(address, cfg) {
  const i = cfg.position === 'suffix'
    ? address.toLowerCase().lastIndexOf(cfg.caseSensitive ? cfg.pattern : cfg.pattern.toLowerCase())
    : address.indexOf(LEAD) + LEAD.length;
  const len = cfg.pattern.length;
  return `${address.slice(0, i)}<b class="hl">${address.slice(i, i + len)}</b>${address.slice(i + len)}`;
}

function onFound({ address, secretKey, attempts, ms, cfg }) {
  const store = $('storeSecret').checked;
  const rec = {
    address, scheme: cfg.scheme, pattern: cfg.pattern,
    caseSensitive: cfg.caseSensitive, position: cfg.position,
    attempts, ms: Math.round(ms), date: new Date().toISOString(),
    secretHex: store ? hexEncode(secretKey) : null,
  };
  vault.unshift(rec);
  saveVault();
  renderVault();

  const card = document.createElement('div');
  card.className = 'found-card';
  const secs = hexEncode(secretKey);
  card.innerHTML = `
    <div class="fc-head">⚒ VANITY FOUND <span class="fc-scheme">${SCHEMES[cfg.scheme].label}</span></div>
    <div class="fc-addr mono">${highlight(address, cfg)}</div>
    <div class="fc-meta">pattern "${cfg.pattern}" ${cfg.position} · ${cfg.caseSensitive ? 'case-sensitive' : 'case-insensitive'} · found on attempt <b>${fmtInt(attempts)}</b> after ${fmtClock(ms)}</div>
    <div class="fc-secret" hidden>
      <div class="dl">Secret key (hex) — fund nothing until this is backed up</div>
      <div class="mono secret">${secs}</div>
    </div>
    <div class="fc-actions">
      <button class="btn ghost" data-act="reveal">Reveal secret</button>
      <button class="btn ghost" data-act="copy-addr">Copy address</button>
      <button class="btn ghost" data-act="copy-sec">Copy secret</button>
    </div>`;
  const secBox = card.querySelector('.fc-secret');
  card.addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    if (!act) return;
    if (act === 'reveal') {
      secBox.hidden = !secBox.hidden;
      ev.target.textContent = secBox.hidden ? 'Reveal secret' : 'Hide secret';
    } else if (act === 'copy-addr') copyText(address, ev.target);
    else if (act === 'copy-sec') copyText(secs, ev.target);
  });
  $('foundList').prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('forgeStatus').textContent = `Found it — ${address.slice(0, 14)}… on attempt ${fmtInt(attempts)}.`;
}

function renderVault() {
  const list = $('vaultList');
  if (!vault.length) {
    list.innerHTML = '<p class="hint">Nothing forged yet. Your finds land here with their secret keys (if you allow local storage).</p>';
    return;
  }
  list.innerHTML = '';
  vault.forEach((rec, idx) => {
    const d = document.createElement('div');
    d.className = 'vault-row';
    d.innerHTML = `
      <div class="mono v-addr">${rec.address}</div>
      <div class="v-meta">${SCHEMES[rec.scheme].label} · "${rec.pattern}" · ${fmtInt(rec.attempts)} attempts · ${new Date(rec.date).toLocaleString()}${rec.secretHex ? '' : ' · <span class="warn">secret not stored</span>'}</div>
      <div class="v-actions">
        ${rec.secretHex ? '<button class="btn ghost sm" data-act="sec">Secret</button>' : ''}
        <button class="btn ghost sm" data-act="addr">Copy</button>
        <button class="btn ghost sm danger" data-act="del">Delete</button>
      </div>
      ${rec.secretHex ? `<div class="mono secret v-sec" hidden>${rec.secretHex}</div>` : ''}`;
    d.addEventListener('click', (ev) => {
      const act = ev.target.dataset.act;
      if (!act) return;
      if (act === 'addr') copyText(rec.address, ev.target);
      else if (act === 'sec') {
        const box = d.querySelector('.v-sec');
        box.hidden = !box.hidden;
        ev.target.textContent = box.hidden ? 'Secret' : 'Hide';
      } else if (act === 'del') {
        vault.splice(idx, 1); saveVault(); renderVault();
      }
    });
    list.appendChild(d);
  });
}

$('wipeVault').addEventListener('click', () => {
  if (!vault.length) return;
  if (confirm(`Delete all ${vault.length} vaulted ${vault.length === 1 ? 'address' : 'addresses'} from this browser?`)) {
    vault = []; saveVault(); renderVault();
  }
});
$('exportVault').addEventListener('click', () => {
  if (!vault.length) return;
  const blob = new Blob([JSON.stringify(vault, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'qtc-vanity-vault.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

/* ---------- boot ---------- */
renderBench();
renderVault();
refreshDesign();
