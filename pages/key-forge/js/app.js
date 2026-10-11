/* QTC Quantum Key Forge — app wiring (ES module, 100% client-side). */
import {
  ss58Decode, ss58Encode, accountIdFromPubkey, pubkeyToAddress,
  hexEncode, hexDecode, QUANTUS_SS58_PREFIX,
} from './quantus-crypto.js';
import { ml_dsa65, ml_dsa87 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();

const SCHEMES = {
  65: { mod: ml_dsa65, label: 'ML-DSA-65', pkLen: 1952, skLen: 4032, sigLen: 3309 },
  87: { mod: ml_dsa87, label: 'ML-DSA-87', pkLen: 2592, skLen: 4896, sigLen: 4627 },
};
let scheme = '65';
let currentKey = null; // { publicKey, secretKey, address, accountId, scheme } — scheme is
// pinned at forge time: sign/download MUST use the forged key's own scheme, never the
// picker's current selection (switching cards after forging must not desync them).
let secretRevealed = false;

/* ---------- background forge-field canvas ---------- */
(() => {
  const cv = $('forgefield'), ctx = cv.getContext('2d');
  let W, H, parts = [];
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const spawn = () => ({
    x: Math.random() * W, y: H + 10,
    vy: .3 + Math.random() * 1.1, vx: (Math.random() - .5) * .4,
    r: .8 + Math.random() * 2.2, life: 1,
    hue: Math.random() < .7 ? 275 + Math.random() * 25 : 20 + Math.random() * 20,
  });
  for (let i = 0; i < 70; i++) { const p = spawn(); p.y = Math.random() * H; parts.push(p); }
  const tick = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y -= p.vy; p.life -= .0022;
      if (p.life <= 0 || p.y < -12) Object.assign(p, spawn());
      ctx.beginPath();
      ctx.fillStyle = `hsla(${p.hue},90%,68%,${Math.max(0, p.life) * .55})`;
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fill();
    }
    requestAnimationFrame(tick);
  };
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) tick();
})();

/* ---------- helpers ---------- */
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
function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
document.querySelectorAll('[data-copy]').forEach((b) =>
  b.addEventListener('click', () => copyText(b.dataset.copy, b)));
document.querySelectorAll('[data-copytarget]').forEach((b) =>
  b.addEventListener('click', () => copyText($(b.dataset.copytarget).dataset.full || $(b.dataset.copytarget).textContent, b)));

/* section nav active state */
const sns = [...document.querySelectorAll('.lab-nav .sn')];
sns.forEach((a) => a.addEventListener('click', () => {
  sns.forEach((x) => x.classList.remove('active'));
  a.classList.add('active');
}));

/* scheme picker */
document.querySelectorAll('.scheme-card').forEach((c) => c.addEventListener('click', () => {
  document.querySelectorAll('.scheme-card').forEach((x) => {
    x.classList.remove('selected'); x.setAttribute('aria-checked', 'false');
  });
  c.classList.add('selected'); c.setAttribute('aria-checked', 'true');
  scheme = c.dataset.scheme;
}));

/* ---------- forge ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setStep(i, cls) {
  document.querySelectorAll('.fstep').forEach((el) => {
    const s = +el.dataset.step;
    el.classList.toggle('doing', cls === 'doing' && s === i);
    el.classList.toggle('done', s < i || (cls === 'done' && s <= i));
  });
}
function renderQr(el, text, size) {
  // qrcode-generator UMD global
  const qr = qrcode(0, 'M');
  qr.addData(text); qr.make();
  el.innerHTML = qr.createImgTag(size, 0);
}
async function forge() {
  // Pin the scheme at click time: the picker cards stay clickable during the
  // ~1s forge, and currentKey below must describe the key actually generated —
  // reading the live `scheme` there would relabel a 65 key as 87 (or vice
  // versa), making sign throw on the secret-key length and mislabeling the
  // secret backup's scheme field.
  const pinnedScheme = scheme;
  const S = SCHEMES[pinnedScheme];
  // A new keypair strands any signature the previous key made: the sign
  // panel must not present the old key's signature under the new key.
  voidSign('a new keypair was forged, so that signature (made by the previous key) no longer applies.');
  $('forgeIdle').hidden = true;
  $('forgeResult').hidden = true;
  $('forgeBusy').hidden = false;
  setStep(0, 'doing');
  await sleep(320); setStep(1, 'doing');
  await sleep(60); // let the UI paint before the heavy keygen
  const t0 = performance.now();
  const { publicKey, secretKey } = S.mod.keygen();
  const keygenMs = Math.round(performance.now() - t0);
  setStep(2, 'doing');
  await sleep(120);
  const accountId = accountIdFromPubkey(publicKey);
  const address = pubkeyToAddress(publicKey);
  setStep(3, 'doing');
  await sleep(120);
  setStep(4, 'done');
  await sleep(260);

  currentKey = { publicKey, secretKey, address, accountId, scheme: pinnedScheme };
  secretRevealed = false;

  $('resAddress').textContent = address;
  $('resScheme').textContent = `${S.label} · forged in ${keygenMs} ms`;
  $('resAccountId').textContent = hexEncode(accountId);
  $('resAccountId').dataset.full = hexEncode(accountId);
  $('resPkLen').textContent = publicKey.length;
  $('resSkLen').textContent = secretKey.length;
  const pkHex = hexEncode(publicKey);
  $('resPubkey').textContent = pkHex.slice(0, 96) + '…';
  $('resPubkey').dataset.full = pkHex;
  $('resSecretMasked').textContent = '•'.repeat(32);
  $('revealSecret').textContent = 'Reveal';
  $('copySecret').disabled = true;
  renderQr($('qrBox'), address, 5);

  // paper card
  $('pcScheme').textContent = S.label;
  $('pcAddr').textContent = address;
  $('pcDate').textContent = new Date().toISOString().slice(0, 10);
  renderQr($('pcQr'), address, 6);
  $('printBtn').disabled = false;

  $('signBtn').disabled = false;
  $('signNeedKey').textContent = `Signing with your forged ${S.label} key. Signatures are ${S.sigLen.toLocaleString()} bytes.`;

  $('forgeBusy').hidden = true;
  $('forgeResult').hidden = false;
  $('forgeResult').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'nearest' });
}
$('forgeBtn').addEventListener('click', forge);
$('forgeAgain').addEventListener('click', forge);
$('copyAddr').addEventListener('click', (e) => copyText($('resAddress').textContent, e.target));
$('copyPubkey').addEventListener('click', (e) => copyText($('resPubkey').dataset.full, e.target));
$('dlPubkey').addEventListener('click', () => {
  if (!currentKey) return;
  const S = SCHEMES[currentKey.scheme];
  download(`quantus-${S.label.toLowerCase()}-pubkey.txt`,
    `Quantus ${S.label} public key\naddress: ${currentKey.address}\naccount id: ${hexEncode(currentKey.accountId)}\n\n${$('resPubkey').dataset.full}\n`);
});
$('revealSecret').addEventListener('click', (e) => {
  secretRevealed = !secretRevealed;
  $('resSecretMasked').textContent = secretRevealed ? hexEncode(currentKey.secretKey).slice(0, 128) + '…' : '•'.repeat(32);
  e.target.textContent = secretRevealed ? 'Hide' : 'Reveal';
  $('copySecret').disabled = !secretRevealed;
});
$('copySecret').addEventListener('click', (e) => {
  if (!secretRevealed) return;
  copyText(hexEncode(currentKey.secretKey), e.target);
});
$('dlSecret').addEventListener('click', () => {
  if (!currentKey) return;
  const S = SCHEMES[currentKey.scheme];
  download(`quantus-${S.label.toLowerCase()}-secret-backup.json`, JSON.stringify({
    warning: 'RAW SECRET KEY MATERIAL. Anyone with this file controls the address. Store encrypted, offline, in two places.',
    scheme: S.label,
    address: currentKey.address,
    account_id_hex: hexEncode(currentKey.accountId),
    public_key_hex: hexEncode(currentKey.publicKey),
    secret_key_hex: hexEncode(currentKey.secretKey),
    forged_at: new Date().toISOString(),
    forged_by: 'QTC Quantum Key Forge (kshot9000 Quantum Resistance Renaissance)',
  }, null, 2), 'application/json');
});

/* ---------- verdict staleness ----------
 * Every rendered verdict below is a function of specific inputs: the
 * inspector verdict of the address in the box, the hex verdict of the
 * account-ID hex, the sign panel of (forged key, message), and the
 * verify verdict of (public key, message, signature). Editing any
 * determinant after a verdict renders must void it — otherwise a
 * "Valid Quantus address" badge stays up over a replaced garbage
 * address, and a "Signed & verified" panel stays up after the message
 * is edited or a NEW key is forged (that signature was the old key's).
 * Voiding replaces the panel with a cleared note naming what changed;
 * each void is a no-op when its panel holds no verdict. Programmatic
 * fills fire no input events, so they void EXPLICITLY: forge() voids
 * the sign panel, and useForgedPk voids the verify panel. */
let inspRendered = false, hexRendered = false, signRendered = false, verifyRendered = false;
function voidInsp(what) {
  if (!inspRendered) return;
  inspRendered = false;
  $('inspResult').innerHTML = `<p class="hint">Inspection cleared — ${what} Inspect again for the current input.</p>`;
}
function voidHex(what) {
  if (!hexRendered) return;
  hexRendered = false;
  $('hexResult').innerHTML = `<p class="hint">Result cleared — ${what} Encode again for the current input.</p>`;
}
function voidSign(what) {
  if (!signRendered) return;
  signRendered = false;
  $('signResult').innerHTML = `<p class="hint">Signature cleared — ${what} Sign again for the current key and message.</p>`;
}
function voidVerify(what) {
  if (!verifyRendered) return;
  verifyRendered = false;
  $('verifyResult').innerHTML = `<p class="hint">Verdict cleared — ${what} Verify again for the current inputs.</p>`;
}
$('inspAddr').addEventListener('input', () => voidInsp('the address changed after this inspection, so it no longer describes the current input.'));
$('inspHex').addEventListener('input', () => voidHex('the account ID changed after this result, so it no longer describes the current input.'));
$('signMsg').addEventListener('input', () => voidSign('the message changed after this signature was made, so it no longer describes the current message.'));
$('verPubkey').addEventListener('input', () => voidVerify('the public key changed after this verdict, so it no longer describes the current inputs.'));
$('verMsg').addEventListener('input', () => voidVerify('the message changed after this verdict, so it no longer describes the current inputs.'));
$('verSig').addEventListener('input', () => voidVerify('the signature changed after this verdict, so it no longer describes the current inputs.'));

/* ---------- inspector ---------- */
function inspHtml(rows, okBadge, badgeText) {
  return `<span class="badge ${okBadge ? 'ok' : 'bad'}">${badgeText}</span>` +
    rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}
$('inspBtn').addEventListener('click', () => {
  const box = $('inspResult');
  const input = $('inspAddr').value.trim();
  if (!input) { box.innerHTML = '<p class="hint">Paste an address first.</p>'; inspRendered = false; return; }
  try {
    const { prefix, accountId } = ss58Decode(input);
    const canon = ss58Encode(accountId, prefix);
    box.innerHTML = inspHtml([
      ['Prefix', `${prefix}${prefix === QUANTUS_SS58_PREFIX ? ' · Quantus mainnet ✓' : ' · ⚠ not Quantus (189)'}`],
      ['Account ID', hexEncode(accountId)],
      ['Checksum', 'valid ✓'],
      ['Canonical form', canon === input ? 'exact match ✓' : `note: canonical is <span style="word-break:break-all">${canon}</span>`],
    ], true, prefix === QUANTUS_SS58_PREFIX ? 'Valid Quantus address' : 'Valid SS58, foreign prefix');
  } catch (err) {
    box.innerHTML = inspHtml([['Error', err.message]], false, 'Invalid address');
  }
  inspRendered = true;
});
$('inspKyle').addEventListener('click', () => {
  $('inspAddr').value = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';
  $('inspBtn').click();
});
$('hexBtn').addEventListener('click', () => {
  const box = $('hexResult');
  try {
    const bytes = hexDecode($('inspHex').value);
    if (bytes.length !== 32) throw new Error(`Account ID must be 32 bytes, got ${bytes.length}`);
    const addr = ss58Encode(bytes, QUANTUS_SS58_PREFIX);
    box.innerHTML = inspHtml([['Address', `<span style="word-break:break-all">${addr}</span>`]], true, 'Encoded');
  } catch (err) {
    box.innerHTML = inspHtml([['Error', err.message]], false, 'Invalid input');
  }
  hexRendered = true;
});

/* ---------- sign & verify ---------- */
$('signBtn').addEventListener('click', async () => {
  const box = $('signResult');
  if (!currentKey) return;
  const S = SCHEMES[currentKey.scheme];
  const msg = te.encode($('signMsg').value);
  if (!msg.length) { box.innerHTML = '<p class="hint">Type a message first.</p>'; signRendered = false; return; }
  box.innerHTML = '<p class="hint">Signing…</p>';
  await sleep(30);
  let sig;
  try {
    sig = S.mod.sign(msg, currentKey.secretKey);
  } catch (err) {
    box.innerHTML = inspHtml([['Error', err.message]], false, 'Cannot sign');
    signRendered = true;
    return;
  }
  const sigHex = hexEncode(sig);
  const okNow = S.mod.verify(sig, msg, currentKey.publicKey);
  box.innerHTML = inspHtml([
    ['Signature bytes', `${sig.length.toLocaleString()} (${S.label})`],
    ['Self-verify', okNow ? 'valid ✓' : 'FAILED ✗'],
    ['Signature hex', `<span style="word-break:break-all">${sigHex.slice(0, 160)}…</span>`],
  ], okNow, okNow ? 'Signed & verified' : 'Signature invalid');
  const row = document.createElement('div');
  row.className = 'btn-row';
  const cb = document.createElement('button');
  cb.className = 'btn mini'; cb.textContent = 'Copy signature hex';
  cb.addEventListener('click', () => copyText(sigHex, cb));
  const db = document.createElement('button');
  db.className = 'btn mini'; db.textContent = 'Download .sig';
  db.addEventListener('click', () => download('quantus-signature.hex', sigHex));
  row.append(cb, db); box.appendChild(row);
  signRendered = true;
});
$('useForgedPk').addEventListener('click', () => {
  if (!currentKey) { $('verifyResult').innerHTML = '<p class="hint">Forge a keypair first.</p>'; verifyRendered = false; return; }
  $('verPubkey').value = hexEncode(currentKey.publicKey);
  // Programmatic fill fires no input event — void the stale verdict here.
  voidVerify('the public key was replaced with the forged key, so that verdict no longer describes the current inputs.');
});
$('verifyBtn').addEventListener('click', async () => {
  const box = $('verifyResult');
  try {
    const pk = hexDecode($('verPubkey').value);
    const entry = Object.values(SCHEMES).find((s) => s.pkLen === pk.length);
    if (!entry) throw new Error(`Public key must be ${SCHEMES[65].pkLen} (ML-DSA-65) or ${SCHEMES[87].pkLen} (ML-DSA-87) bytes; got ${pk.length}`);
    const sig = hexDecode($('verSig').value);
    if (sig.length !== entry.sigLen) throw new Error(`Signature must be ${entry.sigLen} bytes for ${entry.label}; got ${sig.length}`);
    const msg = te.encode($('verMsg').value);
    if (!msg.length) throw new Error('Enter the message that was signed.');
    box.innerHTML = '<p class="hint">Verifying…</p>';
    await sleep(30);
    const valid = entry.mod.verify(sig, msg, pk);
    const addr = pubkeyToAddress(pk);
    box.innerHTML = inspHtml([
      ['Scheme detected', entry.label],
      ['Result', valid ? 'VALID ✓ — this signature was made by the holder of the public key' : 'INVALID ✗ — wrong key, wrong message, or tampered signature'],
      ['Signer address', `<span style="word-break:break-all">${addr}</span>`],
    ], valid, valid ? 'Signature valid' : 'Signature invalid');
  } catch (err) {
    box.innerHTML = inspHtml([['Error', err.message]], false, 'Cannot verify');
  }
  verifyRendered = true;
});

/* ---------- paper card ---------- */
$('printBtn').addEventListener('click', () => window.print());
