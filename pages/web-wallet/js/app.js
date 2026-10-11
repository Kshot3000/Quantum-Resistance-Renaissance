/* QTC Web Wallet — app wiring (ES module, 100% client-side).
 *
 * Views: onboard -> (reveal -> password gate) -> app;  unlock -> app.
 * Secrets live only in module-scope memory while unlocked and are zeroed on lock.
 */
import { hexEncode, hexDecode } from './quantus-crypto.js';
import {
  loadWordlist, generateMnemonic, validateMnemonic, mnemonicToSeed,
  keypairFromSeed, keypairFromMnemonic, keypairFromSecret, schemeInfo, setWordlistForTests,
} from './mnemonic.js';
import { vaultExists, saveVault, openVault, wipeVault, exportVaultFile, importVaultFile } from './keystore.js';
import {
  RpcClient, DEFAULT_RPC, getRuntimeVersion, getLatestHeader,
  getAccountInfo, getNonce, buildUnsignedTransfer, finalizeTransfer, submitExtrinsic,
  parseRecipient,
} from './rpc.js';
import { sanitizeActivityRows } from './rpc-validate.js?v=1.1.0';
import { ml_dsa65, ml_dsa87 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';
import { plancksToQtc, qtcToPlancks, EXISTENTIAL_DEPOSIT, SIGNING_CONTEXT, describeExtrinsicParts } from './scale.js';

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();
const CTX = te.encode(SIGNING_CONTEXT);

const state = {
  kp: null,          // { scheme, publicKey, secretKey, accountId, address }
  mnemonic: null,    // kept in memory only while unlocked (for reveal)
  rpc: null,
  rpcUrl: DEFAULT_RPC,
  unsigned: null,
  lockTimer: null,
};

/* ---------------- background canvas ---------------- */
(() => {
  const cv = $('vaultfield'), ctx = cv.getContext('2d');
  let W, H, parts = [];
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const spawn = () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25,
    r: .8 + Math.random() * 2.4, hue: 265 + Math.random() * 40, tw: Math.random() * 6.28,
  });
  for (let i = 0; i < 80; i++) parts.push(spawn());
  const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tick = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.tw += .02;
      if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10;
      if (p.y < -10) p.y = H + 10; if (p.y > H + 10) p.y = -10;
      const a = .25 + Math.sin(p.tw) * .2;
      ctx.beginPath();
      ctx.fillStyle = `hsla(${p.hue},95%,70%,${a})`;
      ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    if (!REDUCE_MOTION) requestAnimationFrame(tick);
  };
  tick();
})();

/* ---------------- helpers ---------------- */

function show(view) {
  for (const v of ['view-onboard', 'view-unlock', 'view-app']) $(v).hidden = v !== view;
  window.scrollTo({ top: 0 });
}
function err(el, msg) {
  const e = $(el);
  if (!msg) { e.hidden = true; e.textContent = ''; return; }
  e.hidden = false; e.textContent = msg;
}
function zeroBytes(b) { if (b) b.fill(0); }
function copyText(t, btn) {
  navigator.clipboard.writeText(t).then(() => {
    const old = btn.textContent; btn.textContent = '✓ copied';
    setTimeout(() => btn.textContent = old, 1400);
  }).catch(() => {});
}
function shortAddr(a) { return a.length > 18 ? a.slice(0, 10) + '…' + a.slice(-8) : a; }

/* Scrub every per-wallet render back to its initial placeholder. Locking
 * zeroes the in-memory secret key, but the DOM is memory too: without this,
 * the revealed recovery-phrase words, the Security tab's public key/account
 * id, the dashboard address/QR/balances, the send form, and the activity
 * history all stayed rendered behind the unlock screen — and the NEXT
 * wallet unlocked in the same page would inherit them as stale identity. */
function scrubWalletDom() {
  const words = $('sec-words');
  words.innerHTML = ''; words.hidden = true;
  $('btn-reveal-mnemonic').textContent = 'Reveal (asks password)';
  $('sec-pub').textContent = '—';
  $('sec-acct').textContent = '—';
  $('addr').textContent = '';
  $('scheme-name').textContent = '';
  const qr = $('qr'), qctx = qr.getContext('2d');
  qctx.clearRect(0, 0, qr.width, qr.height);
  for (const id of ['bal-total', 'bal-free', 'bal-reserved', 'bal-frozen', 'bal-nonce', 'bal-source'])
    $(id).textContent = '—';
  $('send-to').value = ''; $('send-amount').value = '';
  err('send-to-err'); err('send-amount-err'); err('send-err');
  $('estimate-box').hidden = true;
  $('ext-payload').value = '';
  $('send-result').hidden = true;
  $('res-hash').textContent = '—'; $('res-status').textContent = '—';
  $('activity-list').innerHTML = '<p class="muted">Not loaded yet.</p>';
  err('activity-err');
}

function setConn(state_, label) {
  const pill = $('conn-pill');
  pill.classList.remove('on', 'bad');
  if (state_ === 'on') pill.classList.add('on');
  if (state_ === 'bad') pill.classList.add('bad');
  pill.textContent = '● ' + label;
}

/* ---------------- QR ---------------- */
function drawQR(canvas, text) {
  // vendored low-level generator: qrcode(typeNumber, ecLevel)
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cell = size / n;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#0a0618';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
}

/* ---------------- lock / unlock ---------------- */

function armLockTimer() {
  clearTimeout(state.lockTimer);
  state.lockTimer = setTimeout(() => lock(), 10 * 60 * 1000);
  ['click', 'keydown'].forEach((ev) => addEventListener(ev, armLockTimer, { once: true, passive: true }));
}

function lock() {
  if (state.kp) { zeroBytes(state.kp.secretKey); }
  state.kp = null; state.mnemonic = null; state.unsigned = null;
  if (state.rpc) { state.rpc.close(); state.rpc = null; }
  clearTimeout(state.lockTimer);
  scrubWalletDom();
  $('lock-btn').hidden = true;
  setConn('', 'offline');
  boot();
}

$('lock-btn').addEventListener('click', lock);

async function boot() {
  try { await loadWordlist(); } catch (e) { err('onboard-err', 'Failed to load wordlist: ' + e.message); }
  if (await vaultExists()) { show('view-unlock'); $('unlock-pw').focus(); }
  else show('view-onboard');
}

/* ---------------- onboarding: create ---------------- */

let pendingNew = null; // { mnemonic, scheme, address }

$('btn-create').addEventListener('click', async () => {
  err('onboard-err');
  try {
    const scheme = Number($('new-scheme').value);
    const mnemonic = generateMnemonic();
    const kp = keypairFromMnemonic(mnemonic, '', scheme);
    pendingNew = { mnemonic, scheme, address: kp.address };
    zeroBytes(kp.secretKey);
    const ol = $('reveal-words'); ol.innerHTML = '';
    mnemonic.split(' ').forEach((w) => { const li = document.createElement('li'); li.textContent = w; ol.appendChild(li); });
    $('reveal').hidden = false;
    $('reveal-ack').checked = false; $('btn-reveal-done').disabled = true;
    $('reveal').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
  } catch (e) { err('onboard-err', e.message); }
});

$('reveal-ack').addEventListener('change', (e) => { $('btn-reveal-done').disabled = !e.target.checked; });
$('btn-reveal-copy').addEventListener('click', (e) => pendingNew && copyText(pendingNew.mnemonic, e.target));
$('btn-reveal-done').addEventListener('click', () => {
  if (!pendingNew) return;
  $('reveal').hidden = true;
  $('pwgate').hidden = false;
  $('pwgate').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
  $('pw1').focus();
});

/* ---------------- onboarding: import ---------------- */

document.querySelectorAll('[data-imp]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('[data-imp]').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  const m = t.dataset.imp;
  $('imp-mnemonic-fld').hidden = m !== 'mnemonic';
  $('imp-seed-fld').hidden = m !== 'seed';
  $('imp-secret-fld').hidden = m !== 'secret';
}));

let pendingImport = null; // { kp, mnemonic|null }

$('btn-import').addEventListener('click', async () => {
  err('onboard-err');
  try {
    const m = document.querySelector('[data-imp].active').dataset.imp;
    const scheme = Number($('imp-scheme').value);
    let kp, mnemonic = null;
    if (m === 'mnemonic') {
      const v = validateMnemonic($('imp-mnemonic').value);
      if (!v.ok) throw new Error('Recovery phrase invalid: ' + v.reason);
      mnemonic = $('imp-mnemonic').value.toLowerCase().trim().split(/\s+/).join(' ');
      kp = keypairFromMnemonic(mnemonic, $('imp-passphrase').value, scheme);
    } else if (m === 'seed') {
      const hex = $('imp-seed').value.trim().replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Seed must be 64 hex characters (32 bytes).');
      kp = keypairFromSeed(hexDecode(hex), scheme);
    } else {
      const hex = $('imp-secret').value.trim().replace(/^0x/, '');
      const info = schemeInfo(scheme);
      if (!new RegExp(`^[0-9a-fA-F]{${info.skLen * 2}}$`).test(hex)) throw new Error(`Secret key must be ${info.skLen * 2} hex chars for ${info.name}.`);
      kp = keypairFromSecret(hexDecode(hex), scheme);
    }
    pendingImport = { kp, mnemonic };
    $('pwgate').hidden = false;
    $('pwgate').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
    $('pw1').focus();
    err('onboard-err', '✓ Wallet recognized — address ' + shortAddr(kp.address));
    $('onboard-err').style.cssText = 'background:rgba(94,230,168,.08);border-color:rgba(94,230,168,.4);color:#9df0c8';
  } catch (e) {
    $('onboard-err').style.cssText = '';
    err('onboard-err', e.message);
  }
});

/* ---------------- onboarding: vault file ---------------- */

$('btn-restore-file').addEventListener('click', async () => {
  err('onboard-err');
  const f = $('vault-file').files[0];
  if (!f) { err('onboard-err', 'Choose a vault backup file first.'); return; }
  try {
    await importVaultFile(f);
    show('view-unlock');
  } catch (e) { err('onboard-err', e.message); }
});

/* ---------------- password gate ---------------- */

$('btn-pw-save').addEventListener('click', async () => {
  err('pw-err');
  const p1 = $('pw1').value, p2 = $('pw2').value;
  if (p1.length < 8) { err('pw-err', 'Use at least 8 characters.'); return; }
  if (p1 !== p2) { err('pw-err', 'Passwords do not match.'); return; }
  try {
    let kp, mnemonic;
    if (pendingNew) {
      kp = keypairFromMnemonic(pendingNew.mnemonic, '', pendingNew.scheme);
      mnemonic = pendingNew.mnemonic;
    } else if (pendingImport) {
      ({ kp, mnemonic } = pendingImport);
    } else throw new Error('nothing to save');
    await saveVault({ scheme: kp.scheme, secretKey: kp.secretKey, publicKey: kp.publicKey, mnemonic }, p1);
    // clear password fields + pending material
    $('pw1').value = $('pw2').value = '';
    pendingNew = null; pendingImport = null;
    openApp(kp, mnemonic);
  } catch (e) { err('pw-err', e.message); }
});

/* ---------------- unlock ---------------- */

$('btn-unlock').addEventListener('click', async () => {
  err('unlock-err');
  try {
    const data = await openVault($('unlock-pw').value);
    $('unlock-pw').value = '';
    const kp = keypairFromSecret(data.secretKey, data.scheme);
    zeroBytes(data.secretKey);
    openApp(kp, data.mnemonic);
  } catch (e) { err('unlock-err', e.message); }
});
$('unlock-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-unlock').click(); });

$('btn-forget').addEventListener('click', () => {
  if (!confirm('Delete the encrypted vault from this browser? Your 24 words still recover the wallet.')) return;
  wipeVault();
  boot();
});

/* ---------------- app shell ---------------- */

function openApp(kp, mnemonic) {
  scrubWalletDom(); // a new session never inherits the previous wallet's renders
  state.kp = kp; state.mnemonic = mnemonic || null;
  $('lock-btn').hidden = false;
  show('view-app');
  $('addr').textContent = kp.address;
  $('scheme-name').textContent = schemeInfo(kp.scheme).name;
  drawQR($('qr'), kp.address);
  fillSecurity();
  armLockTimer();
  connectRpc();
}

document.querySelectorAll('#view-app [data-view]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('#view-app [data-view]').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  for (const v of ['dash', 'send', 'activity', 'security']) $('tab-' + v).hidden = v !== t.dataset.view;
  if (t.dataset.view === 'activity') loadActivity();
}));

$('btn-copy-addr').addEventListener('click', (e) => copyText(state.kp.address, e.target));
$('btn-copy-hex').addEventListener('click', (e) => copyText('0x' + hexEncode(state.kp.accountId), e.target));
$('btn-copy-tip').addEventListener('click', (e) => copyText('qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau', e.target));

/* ---------------- RPC ---------------- */

$('rpc-url').value = DEFAULT_RPC;

async function connectRpc() {
  invalidateUnsigned(); // a pinned estimate was quoted by the previous node/era
  const url = $('rpc-url').value.trim() || DEFAULT_RPC;
  state.rpcUrl = url;
  if (state.rpc) state.rpc.close();
  state.rpc = new RpcClient(url);
  const rpc = state.rpc; // pin this attempt: a later Connect supersedes it
  setConn('', 'connecting…');
  err('conn-err');
  try {
    const rt = await getRuntimeVersion(rpc);
    const latest = await getLatestHeader(rpc);
    if (state.rpc !== rpc) return; // superseded while connecting — render nothing
    setConn('on', 'connected');
    $('cf-chain').textContent = rt.specName || 'quantus';
    $('cf-block').textContent = '#' + latest.number.toLocaleString();
    $('cf-runtime').textContent = `spec ${rt.specVersion} · tx v${rt.transactionVersion}`;
    refreshBalance();
  } catch (e) {
    if (state.rpc !== rpc) return; // a superseded attempt must not mark the new node offline
    setConn('bad', 'offline');
    err('conn-err', 'Could not reach the node: ' + e.message + '. Balances and sending need a live RPC — everything else works offline.');
  }
}
$('btn-connect').addEventListener('click', connectRpc);

async function refreshBalance() {
  if (!state.rpc || !state.rpc.connected) return;
  const rpc = state.rpc, kp = state.kp; // pin: a lock/reconnect mid-read voids the render
  try {
    const [info, nonce] = await Promise.all([
      getAccountInfo(rpc, kp.accountId),
      getNonce(rpc, kp.address).catch(() => null),
    ]);
    if (state.rpc !== rpc || state.kp !== kp) return; // stale read — render nothing
    if (!info) {
      $('bal-total').textContent = '0';
      $('bal-free').textContent = '0 QTC';
      $('bal-reserved').textContent = '0 QTC';
      $('bal-frozen').textContent = '0 QTC';
      $('bal-nonce').textContent = nonce ?? '—';
      $('bal-source').textContent = 'chain storage · account not yet on chain';
      return;
    }
    $('bal-total').textContent = plancksToQtc(info.free);
    $('bal-free').textContent = plancksToQtc(info.free) + ' QTC';
    $('bal-reserved').textContent = plancksToQtc(info.reserved) + ' QTC';
    $('bal-frozen').textContent = plancksToQtc(info.frozen) + ' QTC';
    $('bal-nonce').textContent = String(info.nonce);
    $('bal-source').textContent = 'chain storage · live';
  } catch (e) {
    if (state.rpc !== rpc || state.kp !== kp) return; // stale failure — render nothing
    $('bal-source').textContent = 'read failed: ' + e.message;
  }
}
$('btn-refresh').addEventListener('click', refreshBalance);

/* ---------------- send ---------------- */

function validateRecipient() {
  const v = $('send-to').value.trim();
  if (!v) { err('send-to-err'); return null; }
  try {
    const accountId = parseRecipient(v); // checksum + prefix-189 enforced
    err('send-to-err');
    return { address: v, accountId };
  } catch (e) {
    err('send-to-err', 'Invalid Quantus address: ' + e.message);
    return null;
  }
}
/* An estimate pins exactly one transfer (state.unsigned). Editing the
 * recipient or amount afterwards must void it — otherwise Sign & broadcast
 * would send the OLD transfer while the form shows the new values (the
 * review→sign desync fixed in Airgap Desk / Key Forge). Same for Max (which
 * sets the amount programmatically, firing no input event) and for an RPC
 * reconnect (the pinned era/nonce/fee were quoted by the previous node). */
function invalidateUnsigned() {
  if (!state.unsigned) return;
  state.unsigned = null;
  $('estimate-box').hidden = true;
  err('send-err', 'Recipient or amount changed — the estimate was discarded. Build & estimate again to review the new transfer before signing.');
}
$('send-to').addEventListener('input', () => { invalidateUnsigned(); if ($('send-to').value.trim()) validateRecipient(); });
$('send-amount').addEventListener('input', invalidateUnsigned);

$('btn-max').addEventListener('click', async () => {
  // Fill amount = free balance minus a conservative fee guess (refined at estimate).
  const rpc = state.rpc, kp = state.kp, amountAtClick = $('send-amount').value;
  try {
    const info = await getAccountInfo(rpc, kp.accountId);
    // The user typed (or the wallet/node changed) while the balance read was
    // in flight: never overwrite what the amount box holds now.
    if (state.rpc !== rpc || state.kp !== kp || $('send-amount').value !== amountAtClick) {
      err('send-amount-err', 'Amount changed while reading the balance — Max was not applied. Click Max again to fill from the current balance.');
      return;
    }
    if (!info || info.free === 0n) { err('send-amount-err', 'Nothing to send — the wallet is empty.'); return; }
    const guessFee = 5000000000n; // 0.005 QTC headroom; exact fee shown at estimate
    const max = info.free > guessFee + EXISTENTIAL_DEPOSIT ? info.free - guessFee : 0n;
    $('send-amount').value = plancksToQtc(max);
    invalidateUnsigned(); // programmatic set fires no input event
    err('send-amount-err');
  } catch (e) { err('send-amount-err', e.message); }
});

$('btn-estimate').addEventListener('click', async () => {
  err('send-err'); err('send-amount-err');
  $('estimate-box').hidden = true; $('send-result').hidden = true;
  if (!state.rpc || !state.rpc.connected) { err('send-err', 'Connect to a node first (Wallet tab → Connect).'); return; }
  const rcpt = validateRecipient();
  if (!rcpt) return;
  let amount;
  try { amount = qtcToPlancks($('send-amount').value); }
  catch (e) { err('send-amount-err', e.message); return; }
  if (amount <= 0n) { err('send-amount-err', 'Amount must be greater than zero.'); return; }
  const btn = $('btn-estimate'); btn.disabled = true; btn.textContent = 'Building…';
  const toRaw = $('send-to').value, amountRaw = $('send-amount').value;
  const rpc = state.rpc, kp = state.kp; // pin the node + wallet this estimate is for
  try {
    const unsigned = await buildUnsignedTransfer(rpc, {
      fromAddress: kp.address,
      fromAccountId: kp.accountId,
      destAddress: rcpt.address,
      amountPlancks: amount,
    });
    // Fields edited while the node was building: the result no longer
    // matches the form — discard it instead of pinning a stale transfer.
    if ($('send-to').value !== toRaw || $('send-amount').value !== amountRaw || state.rpc !== rpc || state.kp !== kp) {
      state.unsigned = null;
      throw new Error('Recipient or amount changed while building — estimate discarded. Build & estimate again.');
    }
    state.unsigned = unsigned;
    const info = await getAccountInfo(rpc, kp.accountId);
    /* The balance read is a SECOND await after the pin: an edit during it
     * fires invalidateUnsigned() (pin nulled, box hidden, "discarded" error
     * shown) — without this re-check the handler resumed and rendered the
     * OLD estimate anyway, un-hiding a review whose transfer was no longer
     * pinned or signable beside the new form values. Identity-check the
     * pin itself: only discard-explain; never null a NEWER estimate's pin
     * and never render over it. */
    if (state.unsigned !== unsigned || state.rpc !== rpc || state.kp !== kp ||
        $('send-to').value !== toRaw || $('send-amount').value !== amountRaw) {
      throw new Error('Recipient or amount changed while checking the balance — estimate discarded. Build & estimate again to review the new transfer before signing.');
    }
    const free = info ? info.free : 0n;
    const total = amount + (unsigned.fee ?? 0n);
    if (free < total) throw new Error(`Insufficient balance: need ${plancksToQtc(total)} QTC (amount + fee) but have ${plancksToQtc(free)} QTC.`);
    // transfer_keep_alive also requires the SENDER to stay above ED
    if (free - total < EXISTENTIAL_DEPOSIT && free - total !== 0n) {
      // keep_alive only fails if sender would drop below ED *and* stay alive; warn honestly
      $('send-amount-err').hidden = false;
      $('send-amount-err').textContent = `Note: after this transfer you'd hold ${plancksToQtc(free - total)} QTC — below the 0.001 QTC existential deposit. transfer_keep_alive will refuse unless the account is emptied exactly.`;
    }
    $('est-to').textContent = shortAddr(rcpt.address);
    $('est-to').title = rcpt.address;
    $('est-amount').textContent = plancksToQtc(amount) + ' QTC';
    $('est-fee').textContent = unsigned.fee !== null ? plancksToQtc(unsigned.fee) + ' QTC' : 'node did not quote a fee';
    $('est-total').textContent = plancksToQtc(total) + ' QTC';
    $('est-nonce').textContent = String(unsigned.nonce);
    $('est-era').textContent = `mortal · period ${unsigned.period} · phase ${unsigned.phase} · birth #${unsigned.birth}`;
    const parts = describeExtrinsicParts({
      lengthPrefixLen: 1, bodyLen: '(computed at broadcast)',
      sigDesc: `${schemeInfo(kp.scheme).name}: variant byte + ${kp.scheme === 87 ? 4627 : 3309} B sig + ${kp.scheme === 87 ? 2592 : 1952} B pubkey`,
      eraDesc: `mortal(${unsigned.period}, ${unsigned.phase})`,
      nonce: unsigned.nonce, tip: '0',
      destShort: shortAddr(rcpt.address),
      amountDesc: plancksToQtc(amount) + ' QTC (' + amount.toString() + ' plancks)',
    });
    $('ext-parts').innerHTML = parts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    $('ext-payload').value = unsigned.payloadHex;
    $('estimate-box').hidden = false;
    $('estimate-box').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
  } catch (e) {
    err('send-err', e.message);
  } finally {
    btn.disabled = false; btn.textContent = '1 · Build & estimate fee';
  }
});

$('btn-cancel-send').addEventListener('click', () => {
  state.unsigned = null;
  $('estimate-box').hidden = true;
});

let broadcastSeq = 0; // token: only the latest broadcast for the pinned wallet/node may render
$('btn-broadcast').addEventListener('click', async () => {
  err('send-err');
  const unsigned = state.unsigned;
  if (!unsigned) { err('send-err', 'Build the transfer first.'); return; }
  const kp = state.kp, rpc = state.rpc; // pin the wallet + node this broadcast is for
  const seq = ++broadcastSeq;
  const btn = $('btn-broadcast'); btn.disabled = true; btn.textContent = 'Signing & broadcasting…';
  /* The estimate button and form stay live while the submit is in flight,
   * and Lock/Reconnect can happen too. A continuation that lands after a
   * newer estimate was pinned, after Lock (kp nulled / replaced by another
   * wallet), or after a reconnect must render NOTHING: the old code wiped
   * the newer estimate's pin, hid its review box, showed this broadcast's
   * hash as the result, painted its failure over the new estimate — and a
   * failure landing after Lock sat in the DOM behind the unlock screen,
   * waiting in the next session. An edited-away pin (state.unsigned null,
   * no newer estimate) does NOT void the render: the transfer really was
   * submitted and its hash is the truthful result for this same wallet. */
  const stale = () => seq !== broadcastSeq || state.kp !== kp || state.rpc !== rpc ||
    (state.unsigned !== null && state.unsigned !== unsigned);
  try {
    const mod = kp.scheme === 87 ? ml_dsa87 : ml_dsa65;
    const { extrinsicHex, signature, pubkey } = finalizeTransfer(unsigned, {
      scheme: kp.scheme,
      signFn: (payload) => ({
        signature: mod.sign(payload, kp.secretKey, { context: CTX }),
        pubkey: kp.publicKey,
      }),
    });
    // Pre-broadcast self-check: the signature MUST verify under our own public
    // key with the chain's context before it ever touches the network.
    const ok = mod.verify(signature, unsigned.payload, pubkey, { context: CTX });
    if (!ok) throw new Error('local signature self-check failed — refusing to broadcast');
    const hash = await submitExtrinsic(rpc, extrinsicHex);
    if (stale()) return; // superseded while the node answered — discard silently
    state.unsigned = null;
    $('estimate-box').hidden = true;
    $('send-result').hidden = false;
    $('res-hash').textContent = hash;
    $('res-status').textContent = 'accepted by node — watch it confirm in the explorer';
    const ex = $('res-explorer');
    ex.href = EXPLORER;
    ex.textContent = 'Open explorer — paste the hash in “Search the chain”';
    ex.hidden = false;
    refreshBalance();
  } catch (e) {
    if (stale()) return; // a superseded failure must not paint over newer state
    err('send-err', 'Broadcast failed: ' + e.message);
  } finally {
    // Only the latest broadcast owns the button: a superseded finally must
    // not re-enable a newer broadcast's button mid-flight (double submit).
    if (seq === broadcastSeq) { btn.disabled = false; btn.textContent = '2 · Sign & broadcast'; }
  }
});

$('btn-send-again').addEventListener('click', () => {
  $('send-result').hidden = true;
  $('send-to').value = ''; $('send-amount').value = '';
});

/* ---------------- activity (Subsquid) ---------------- */

const SQUID = 'https://sqm.quantus.com/v1/graphql';
const EXPLORER = 'https://explorer.quantus.com';

/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}

/* An indexer row is rendered as money movement, so its RELATIONS are
 * validated before it paints (sanitizeActivityRows in rpc-validate.js):
 * the row must be a transfer of THIS wallet between real SS58-189
 * addresses, at a fleet-valid block height, for an amount inside the
 * 21M QTC supply cap, with a timestamp inside the chain's lifetime;
 * ids are unique, the list respects the query's limit:25 and runs
 * newest-first. Poisoned rows drop alone; a payload failing wholesale
 * is malformed — never a fabricated "no transfers". */

let activitySeq = 0; // token: only the latest load for the CURRENT wallet may render
async function loadActivity() {
  const seq = ++activitySeq;
  const kp = state.kp; // pin the wallet this load is for
  if (!kp) return;
  const list = $('activity-list');
  err('activity-err');
  list.innerHTML = '<p class="muted">Loading…</p>';
  const addr = kp.address;
  /* A load that lands after a newer load started, after Lock (state.kp
   * nulled), or after a different wallet was unlocked (a new kp object)
   * must render nothing: the slower first load would otherwise overwrite
   * the newer load's transfers with its older response, its late failure
   * would wipe a newer success with "Indexer unreachable", and a load
   * finishing after Lock would paint the locked wallet's history into
   * the DOM behind the unlock screen — where it would still be sitting
   * in the next wallet's Activity tab. */
  const stale = () => seq !== activitySeq || state.kp !== kp;
  const query = `query($a:String!){
    transfer(where:{_or:[{from_id:{_eq:$a}},{to_id:{_eq:$a}}]}, order_by:{block_height:desc}, limit:25){
      id from_id to_id amount block_height extrinsic_id timestamp
    }}`;
  try {
    const res = await fetch(SQUID, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { a: addr } }),
      signal: timeoutSignal(10000),
    });
    if (stale()) return; // superseded while the indexer answered — discard silently
    if (!res.ok) throw new Error('indexer HTTP ' + res.status);
    const j = await res.json();
    if (stale()) return; // superseded while the body parsed — discard silently
    if (j && j.errors) throw new Error(j.errors[0] && typeof j.errors[0].message === 'string' ? j.errors[0].message : 'indexer error');
    const rawRows = j && j.data && Array.isArray(j.data.transfer) ? j.data.transfer : null;
    if (!rawRows) throw new Error('indexer returned malformed activity data');
    const rows = sanitizeActivityRows(rawRows, addr, Date.now());
    if (!rows) throw new Error('indexer returned malformed activity data');
    if (rawRows.length && !rows.length) throw new Error('indexer returned malformed activity data');
    if (!rows.length) { list.innerHTML = '<p class="muted">No transfers found for this address.</p>'; return; }
    list.innerHTML = '';
    for (const t of rows) {
      const incoming = t.to_id === addr;
      const div = document.createElement('div');
      div.className = 'tx';
      const whenDate = t.timestamp ? new Date(t.timestamp) : null;
      const when = whenDate && !isNaN(whenDate) ? whenDate.toLocaleString() : 'block #' + Number(t.block_height).toLocaleString();
      div.innerHTML =
        `<div><div class="amt ${incoming ? 'in' : 'out'}">${incoming ? '+' : '−'}${plancksToQtc(BigInt(t.amount))} QTC</div>` +
        `<div class="meta">${incoming ? 'from' : 'to'} ${shortAddr(incoming ? t.from_id : t.to_id)} · ${when}</div></div>` +
        `<a href="${EXPLORER}/blocks/${t.block_height}" target="_blank" rel="noopener">block #${Number(t.block_height).toLocaleString()} ↗</a>`;
      list.appendChild(div);
    }
  } catch (e) {
    if (stale()) return; // a superseded failure must not wipe a newer load's success
    list.innerHTML = '<p class="muted">Not loaded.</p>';
    err('activity-err', 'Indexer unreachable (' + e.message + '). History is unavailable — nothing was fabricated.');
  }
}
$('btn-activity').addEventListener('click', loadActivity);

/* ---------------- security ---------------- */

$('btn-reveal-mnemonic').addEventListener('click', async () => {
  const list = $('sec-words');
  if (!list.hidden) { list.hidden = true; $('btn-reveal-mnemonic').textContent = 'Reveal (asks password)'; return; }
  if (!state.mnemonic) { alert('This wallet was imported without a recovery phrase (seed/secret import). There are no words to show — back up the secret key instead.'); return; }
  const pw = prompt('Enter your vault password to reveal the recovery phrase:');
  if (pw === null) return;
  try {
    await openVault(pw); // password check only
    list.innerHTML = '';
    state.mnemonic.split(' ').forEach((w) => { const li = document.createElement('li'); li.textContent = w; list.appendChild(li); });
    list.hidden = false;
    $('btn-reveal-mnemonic').textContent = 'Hide words';
  } catch { alert('Wrong password.'); }
});

function fillSecurity() {
  if (!state.kp) return;
  $('sec-pub').textContent = '0x' + hexEncode(state.kp.publicKey);
  $('sec-acct').textContent = '0x' + hexEncode(state.kp.accountId);
}
// Refill on EVERY Security-tab open (and in openApp): a { once: true } fill
// pinned the first wallet's keys forever — after Forget + a different wallet,
// the Security tab kept presenting the previous wallet's public key/account id.
document.querySelector('[data-view="security"]').addEventListener('click', fillSecurity);

$('btn-export-vault').addEventListener('click', () => {
  const blob = exportVaultFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'qtc-wallet-vault.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('btn-wipe').addEventListener('click', () => {
  if (!confirm('Wipe the encrypted vault from this browser? Your 24 words still recover the wallet.')) return;
  if (!confirm('Last chance — without the 24 words this is irreversible. Wipe?')) return;
  wipeVault();
  lock();
});

/* ---------------- boot ---------------- */
boot();
