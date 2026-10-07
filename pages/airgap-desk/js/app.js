/* QTC Airgap Desk — UI wiring (ES module, 100% client-side).
 *
 * Two roles in one page: the HOT desk (online: issues chain tickets, verifies
 * and broadcasts) and the COLD desk (offline: imports tickets, builds and
 * signs transfers, exports chunked packages). All protocol logic lives in
 * ./airgap.js; this file only wires DOM <-> protocol <-> node RPC.
 */
import {
  makeTicket, encodeTicket, decodeTicket, encodeChunks, decodeChunks,
  decodeForVerify, reverifySigned, buildColdPayload, buildColdExtrinsic,
  DEFAULT_ERA_PERIOD,
} from './airgap.js';
import { drawQR, decodeQRImage, mountChunkStepper, startCameraScan } from './qr.js';
import {
  RpcClient, getRuntimeVersion, getGenesisHash, getLatestHeader, getEraBirthHash,
  getAccountInfo, getNonce, submitExtrinsic,
} from './lib/rpc.js';
import { ml_dsa65, ml_dsa87 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';
import { keypairFromMnemonic, keypairFromSeed, validateMnemonic, loadWordlist } from './lib/mnemonic.js';
import { ss58Decode, hexEncode } from './lib/quantus-crypto.js';
import {
  encodeMortalEra, qtcToPlancks, plancksToQtc, EXISTENTIAL_DEPOSIT,
} from './lib/scale.js';

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();
const EXPLORER = 'https://explorer.quantus.com';
const DONATE = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';

const hot = { rpc: null, rpcUrl: '', ticket: null, ticketStr: '', verified: null, extrinsicHex: '' };
const cold = { ticket: null, ticketStr: '', cpWords: null, chunks: [], extrinsicHex: '', reviewed: null };

/* ---------------- background ---------------- */
(() => {
  const cv = $('frostfield'), ctx = cv.getContext('2d');
  let W, H, parts = [];
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const spawn = () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - .5) * .18, vy: .08 + Math.random() * .3,
    r: .7 + Math.random() * 2.1, hue: 190 + Math.random() * 45, tw: Math.random() * 6.28,
  });
  for (let i = 0; i < 70; i++) parts.push(spawn());
  const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tick = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.tw += .015;
      if (p.y > H + 10) { p.y = -10; p.x = Math.random() * W; }
      if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10;
      const a = .12 + Math.sin(p.tw) * .1;
      ctx.beginPath();
      ctx.fillStyle = `hsla(${p.hue},90%,75%,${a})`;
      ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    if (!REDUCE_MOTION) requestAnimationFrame(tick);
  };
  tick();
})();

/* ---------------- helpers ---------------- */
function err(id, msg) {
  const e = $(id);
  if (!msg) { e.hidden = true; e.textContent = ''; return; }
  e.hidden = false; e.textContent = msg;
}
function shortAddr(a) { return a.length > 20 ? a.slice(0, 11) + '…' + a.slice(-8) : a; }
function shortHex(h) { return h.length > 20 ? h.slice(0, 10) + '…' + h.slice(-8) : h; }
function copyText(t, btn) {
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = '✓ copied'; setTimeout(() => btn.textContent = o, 1400); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done).catch(done);
  else done();
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function setConn(state_, label) {
  const pill = $('conn-pill');
  pill.classList.remove('on', 'bad');
  if (state_ === 'on') pill.classList.add('on');
  if (state_ === 'bad') pill.classList.add('bad');
  pill.textContent = '● ' + label;
}
function kvHTML(rows) {
  return rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}
document.querySelectorAll('[data-copy]').forEach((b) =>
  b.addEventListener('click', () => copyText(b.getAttribute('data-copy'), b)));

/* ---------------- role tabs ---------------- */
document.querySelectorAll('[data-role]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('[data-role]').forEach((x) => {
    x.classList.remove('active'); x.setAttribute('aria-selected', 'false');
  });
  t.classList.add('active'); t.setAttribute('aria-selected', 'true');
  const hot_ = t.dataset.role === 'hot';
  $('role-hot').hidden = !hot_;
  $('role-cold').hidden = hot_;
  window.scrollTo({ top: 0 });
}));

/* ================================================================
 * HOT DESK — issue chain ticket
 * ================================================================ */
$('rpc-url').value = 'wss://rpc.quantus.network';

$('btn-issue').addEventListener('click', async () => {
  err('issue-err');
  $('ticket-out').hidden = true;
  const addr = $('ticket-addr').value.trim();
  try {
    const { prefix } = ss58Decode(addr);
    if (prefix !== 189) throw new Error(`wrong network prefix ${prefix} — Quantus addresses use prefix 189`);
  } catch (e) { err('issue-err', 'Invalid sender address: ' + e.message); return; }

  const url = $('rpc-url').value.trim() || 'wss://rpc.quantus.network';
  const btn = $('btn-issue'); btn.disabled = true; btn.textContent = 'Reading chain…';
  try {
    if (hot.rpc) hot.rpc.close();
    const rpc = new RpcClient(url);
    setConn('', 'connecting…');
    const [rt, genesis, latest, nonce] = await Promise.all([
      getRuntimeVersion(rpc), getGenesisHash(rpc), getLatestHeader(rpc), getNonce(rpc, addr),
    ]);
    const eraInfo = await getEraBirthHash(rpc, latest.number, DEFAULT_ERA_PERIOD);
    hot.rpc = rpc; hot.rpcUrl = url;
    setConn('on', 'connected');
    const ticket = makeTicket({
      addr, nonce,
      genesis, spec: Number(rt.specVersion), txv: Number(rt.transactionVersion),
      head: latest.number, headHash: latest.hash,
      era: { period: eraInfo.period, phase: eraInfo.phase, birth: eraInfo.birth, birthHash: eraInfo.birthHash },
    });
    hot.ticket = ticket;
    hot.ticketStr = encodeTicket(ticket);
    $('ticket-summary').innerHTML = kvHTML([
      ['Sender', shortAddr(addr)],
      ['Next nonce', String(nonce)],
      ['Head', '#' + latest.number.toLocaleString()],
      ['Genesis', shortHex(genesis)],
      ['Runtime', `spec ${rt.specVersion} · tx v${rt.transactionVersion}`],
      ['Era window', `mortal · period ${eraInfo.period} · birth #${eraInfo.birth.toLocaleString()}`],
      ['Issued', new Date(ticket.issued).toLocaleString()],
    ]);
    $('ticket-text').value = hot.ticketStr;
    drawQR($('ticket-qr'), hot.ticketStr);
    $('ticket-out').hidden = false;
    $('ticket-out').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
  } catch (e) {
    setConn('bad', 'offline');
    err('issue-err', 'Could not issue a ticket: ' + e.message + '. A ticket needs a live node — nothing was fabricated.');
  } finally {
    btn.disabled = false; btn.textContent = 'Issue ticket';
  }
});

$('btn-ticket-copy').addEventListener('click', (e) => copyText(hot.ticketStr, e.target));
$('btn-ticket-download').addEventListener('click', () => download('qtc-ticket.qtcticket', hot.ticketStr));

/* ================================================================
 * HOT DESK — receive, verify, broadcast
 * ================================================================ */
let pkgCam = null;
const pkgChunkTexts = new Set();

function pkgProgress() {
  const el = $('pkg-progress');
  if (!pkgChunkTexts.size) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${pkgChunkTexts.size} chunk text(s) collected — press "Assemble & verify" when done.`;
}

async function ingestFiles(fileList, onChunkText) {
  const texts = [];
  for (const f of fileList) {
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) {
      texts.push(await decodeQRImage(f)); // throws if no QR found
    } else {
      texts.push(await f.text());
    }
  }
  for (const t of texts) {
    for (const line of t.split(/\s+/)) {
      const s = line.trim();
      if (/^QAGX:/.test(s) || /^QAGT1:/.test(s) || /^0x[0-9a-fA-F]+$/.test(s)) onChunkText(s);
    }
  }
}

$('pkg-file').addEventListener('change', async (e) => {
  err('receive-err');
  try { await ingestFiles(e.target.files, (s) => pkgChunkTexts.add(s)); pkgProgress(); }
  catch (ex) { err('receive-err', ex.message); }
  e.target.value = '';
});

$('btn-pkg-camera').addEventListener('click', async () => {
  err('receive-err');
  try {
    $('pkg-video').hidden = false;
    $('btn-pkg-camera').hidden = true;
    $('btn-pkg-camera-stop').hidden = false;
    pkgCam = await startCameraScan($('pkg-video'), (text) => {
      if (/^QAGX:/.test(text)) { pkgChunkTexts.add(text); pkgProgress(); }
    });
  } catch (e) {
    $('pkg-video').hidden = true;
    $('btn-pkg-camera').hidden = false;
    $('btn-pkg-camera-stop').hidden = true;
    err('receive-err', e.message);
  }
});
$('btn-pkg-camera-stop').addEventListener('click', () => {
  if (pkgCam) { pkgCam.stop(); pkgCam = null; }
  $('pkg-video').hidden = true;
  $('btn-pkg-camera').hidden = false;
  $('btn-pkg-camera-stop').hidden = true;
});

function collectPackageLines() {
  const lines = [];
  for (const s of pkgChunkTexts) lines.push(s);
  const pasted = $('pkg-paste').value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of pasted) if (!lines.includes(s)) lines.push(s);
  return lines;
}

$('btn-pkg-paste').addEventListener('click', () => {
  err('receive-err'); err('broadcast-err');
  $('verify-out').hidden = true; $('broadcast-result').hidden = true;
  hot.verified = null; hot.extrinsicHex = '';
  try {
    const lines = collectPackageLines();
    if (!lines.length) throw new Error('nothing to assemble — paste, upload, or scan the signed package first');
    let hex;
    if (lines.some((l) => /^QAGX:/.test(l))) {
      const chunkLines = lines.filter((l) => /^QAGX:/.test(l));
      hex = decodeChunks(chunkLines).hex;
    } else if (lines.length === 1 && /^0x[0-9a-fA-F]+$/.test(lines[0])) {
      hex = lines[0];
    } else throw new Error('unrecognized package format — expected QAGX: chunk lines or one 0x… extrinsic');
    hot.extrinsicHex = hex;
    verifyPackage();
  } catch (e) { err('receive-err', e.message); }
});

function activeTicket() {
  const pasted = $('verify-ticket').value.trim();
  const str = pasted || hot.ticketStr;
  if (!str) throw new Error('no ticket available — paste the QAGT1: ticket this package was built against');
  return decodeTicket(str);
}

function verifyPackage() {
  const ticket = activeTicket();
  const decoded = decodeForVerify(hot.extrinsicHex);
  if (decoded.address !== ticket.addr)
    throw new Error('package sender does not match the ticket sender — refusing to verify');
  const mod = decoded.scheme === 87 ? ml_dsa87 : ml_dsa65;
  const { ok, payloadHex } = reverifySigned({ ticket, decoded, mlDsa: mod });
  hot.verified = { decoded, ok, payloadHex, ticket };

  const badge = $('sig-badge');
  badge.className = 'sigbadge ' + (ok ? 'ok' : 'bad');
  badge.innerHTML = ok
    ? `<span>✅ SIGNATURE VALID<span class="sub">Verified locally against the ticket's genesis, runtime, era and nonce — byte-identical to what the chain will check.</span></span>`
    : `<span>⛔ SIGNATURE INVALID<span class="sub">The package was tampered with or built against a different ticket. Do NOT broadcast.</span></span>`;

  const d = decoded;
  $('verify-summary').innerHTML = kvHTML([
    ['From', shortAddr(d.address)],
    ['To', shortAddr(d.call.destAddress)],
    ['Amount', `<span class="big">${plancksToQtc(d.call.amountPlancks)} QTC</span>`],
    ['Nonce', String(d.nonce)],
    ['Era', d.era.immortal ? 'immortal' : `mortal · period ${d.era.period} · phase ${d.era.phase}`],
    ['Tip', plancksToQtc(d.tip) + ' QTC'],
    ['Scheme', d.scheme === 87 ? 'ML-DSA-87' : 'ML-DSA-65'],
    ['Call', `Balances.transfer_keep_alive (2/3)`],
    ['Extrinsic', `${(hot.extrinsicHex.length / 2 - 1).toLocaleString()} bytes`],
  ]);
  $('btn-broadcast').disabled = !ok;
  $('fee-quote').hidden = true;
  $('verify-out').hidden = false;
  $('verify-out').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
}

$('btn-reverify').addEventListener('click', () => {
  err('receive-err');
  try { verifyPackage(); }
  catch (e) { err('receive-err', e.message); }
});

$('btn-quote-fee').addEventListener('click', async () => {
  err('broadcast-err');
  const v = hot.verified;
  if (!v || !v.ok) { err('broadcast-err', 'Verify a valid package first.'); return; }
  const btn = $('btn-quote-fee'); btn.disabled = true; btn.textContent = 'Quoting…';
  try {
    const url = $('rpc-url').value.trim() || 'wss://rpc.quantus.network';
    if (!hot.rpc || !hot.rpc.connected || hot.rpcUrl !== url) {
      if (hot.rpc) hot.rpc.close();
      hot.rpc = new RpcClient(url); hot.rpcUrl = url;
    }
    setConn('', 'connecting…');
    const latest = await getLatestHeader(hot.rpc);
    setConn('on', 'connected');
    const details = await hot.rpc.call('payment_queryFeeDetails', [hot.extrinsicHex, latest.hash]);
    const f = details.inclusionFee;
    const fee = BigInt(f.baseFee) + BigInt(f.lenFee) + BigInt(f.adjustedWeightFee);
    const info = await getAccountInfo(hot.rpc, v.decoded.accountId);
    const free = info ? info.free : 0n;
    const total = v.decoded.call.amountPlancks + fee;
    let warn = '';
    if (info && free < total)
      warn = ` ⚠️ Sender holds ${plancksToQtc(free)} QTC — not enough for amount + fee (${plancksToQtc(total)} QTC). Broadcast would fail.`;
    else if (info && free - total < EXISTENTIAL_DEPOSIT && free !== total)
      warn = ` ⚠️ After this transfer the sender would hold ${plancksToQtc(free - total)} QTC — below the 0.001 QTC existential deposit; transfer_keep_alive will refuse.`;
    // era freshness
    const era = v.decoded.era;
    let eraNote = '';
    if (!era.immortal) {
      const birthBlock = v.ticket.era.birth;
      const remaining = birthBlock + era.period - latest.number;
      eraNote = remaining > 0
        ? ` Era valid for ~${remaining} more blocks.`
        : ` ⛔ Era EXPIRED at head #${latest.number.toLocaleString()} — re-issue the ticket and re-sign.`;
      if (remaining <= 0) $('btn-broadcast').disabled = true;
    }
    // nonce freshness
    let nonceNote = '';
    try {
      const live = await getNonce(hot.rpc, v.decoded.address);
      if (BigInt(live) !== v.decoded.nonce) {
        nonceNote = ` ⛔ Nonce STALE — chain says ${live}, package says ${v.decoded.nonce}. Re-issue the ticket and re-sign.`;
        $('btn-broadcast').disabled = true;
      } else nonceNote = ' Nonce fresh.';
    } catch { nonceNote = ' (nonce freshness check failed — node unreachable for accountNextIndex)'; }
    const fq = $('fee-quote');
    fq.hidden = false;
    fq.innerHTML = `⛽ Node-quoted fee: <strong>${plancksToQtc(fee)} QTC</strong> (exact, quoted just now at head #${latest.number.toLocaleString()}).${warn}${eraNote}${nonceNote}`;
  } catch (e) {
    setConn('bad', 'offline');
    err('broadcast-err', 'Fee quote failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Quote exact fee from node';
  }
});

$('btn-broadcast').addEventListener('click', async () => {
  err('broadcast-err');
  const v = hot.verified;
  if (!v || !v.ok) return;
  const btn = $('btn-broadcast'); btn.disabled = true; btn.textContent = 'Broadcasting…';
  try {
    const hash = await submitExtrinsic(hot.rpc, hot.extrinsicHex);
    $('broadcast-result').hidden = false;
    $('res-hash').textContent = hash;
    const ex = $('res-explorer');
    ex.href = EXPLORER;
    ex.textContent = 'Open explorer — paste the hash in “Search the chain”';
    ex.hidden = false;
    $('broadcast-result').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
    btn.textContent = 'Broadcast ✓';
  } catch (e) {
    err('broadcast-err', 'Broadcast failed: ' + e.message);
    btn.disabled = false; btn.textContent = 'Broadcast to chain';
  }
});

/* ================================================================
 * COLD DESK — import ticket
 * ================================================================ */
let coldCam = null;

function renderColdTicket() {
  const t = cold.ticket;
  $('cold-ticket-summary').innerHTML = kvHTML([
    ['Sender', shortAddr(t.addr)],
    ['Next nonce', String(t.nonce)],
    ['Head', '#' + t.head.toLocaleString()],
    ['Genesis', shortHex(t.genesis)],
    ['Runtime', `spec ${t.spec} · tx v${t.txv}`],
    ['Era window', `period ${t.era.period} · phase ${t.era.phase} · birth #${t.era.birth.toLocaleString()}`],
    ['Issued', new Date(t.issued).toLocaleString()],
  ]);
  $('cold-nonce').value = String(t.nonce);
  $('cold-ticket-out').hidden = false;
}

function importTicketString(s) {
  err('cold-ticket-err');
  try {
    const t = decodeTicket(s);
    cold.ticket = t; cold.ticketStr = s.trim();
    renderColdTicket();
  } catch (e) { err('cold-ticket-err', e.message); }
}

$('btn-cold-ticket').addEventListener('click', () => importTicketString($('cold-ticket-paste').value));

$('cold-ticket-file').addEventListener('change', async (e) => {
  err('cold-ticket-err');
  try {
    const f = e.target.files[0];
    if (!f) return;
    let text;
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) text = await decodeQRImage(f);
    else text = await f.text();
    const m = text.match(/QAGT1:[A-Za-z0-9\-_]+/);
    if (!m) throw new Error('no chain ticket found in that file');
    $('cold-ticket-paste').value = m[0];
    importTicketString(m[0]);
  } catch (ex) { err('cold-ticket-err', ex.message); }
  e.target.value = '';
});

$('btn-cold-camera').addEventListener('click', async () => {
  err('cold-ticket-err');
  try {
    $('cold-video').hidden = false;
    $('btn-cold-camera').hidden = true;
    $('btn-cold-camera-stop').hidden = false;
    coldCam = await startCameraScan($('cold-video'), (text) => {
      if (/^QAGT1:/.test(text)) {
        $('cold-ticket-paste').value = text;
        importTicketString(text);
        $('btn-cold-camera-stop').click();
      }
    });
  } catch (e) {
    $('cold-video').hidden = true;
    $('btn-cold-camera').hidden = false;
    $('btn-cold-camera-stop').hidden = true;
    err('cold-ticket-err', e.message);
  }
});
$('btn-cold-camera-stop').addEventListener('click', () => {
  if (coldCam) { coldCam.stop(); coldCam = null; }
  $('cold-video').hidden = true;
  $('btn-cold-camera').hidden = false;
  $('btn-cold-camera-stop').hidden = true;
});

/* ================================================================
 * COLD DESK — build + sign
 * ================================================================ */
document.querySelectorAll('[data-ck]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('[data-ck]').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  const m = t.dataset.ck;
  $('ck-mnemonic-fld').hidden = m !== 'mnemonic';
  $('ck-seed-fld').hidden = m !== 'seed';
}));

let cpTimer = null;
$('cold-dest').addEventListener('input', () => {
  err('cold-dest-err');
  $('cp-box').hidden = true; cold.cpWords = null; cold.reviewed = null;
  clearTimeout(cpTimer);
  const v = $('cold-dest').value.trim();
  if (!v) return;
  cpTimer = setTimeout(async () => {
    try {
      const { prefix } = ss58Decode(v);
      if (prefix !== 189) throw new Error(`wrong network prefix ${prefix} — need 189`);
      $('cp-hint').textContent = 'computing checkphrase…';
      $('cp-box').hidden = false;
      const words = await window.QTC_CHECK.addressToChecksumAsync(v, window.QTC_WORDLIST);
      cold.cpWords = words;
      $('cp-words').innerHTML = words.map((w) => `<span>${w}</span>`).join('');
      $('cp-hint').textContent = 'Now type them back, in order, to arm signing.';
      $('cp-answer').value = '';
    } catch (e) {
      $('cp-box').hidden = true; cold.cpWords = null;
      err('cold-dest-err', 'Invalid destination: ' + e.message);
    }
  }, 450);
});

function readColdKey(scheme) {
  const m = document.querySelector('[data-ck].active').dataset.ck;
  if (m === 'mnemonic') {
    const v = validateMnemonic($('cold-mnemonic').value);
    if (!v.ok) throw new Error('recovery phrase invalid: ' + v.reason);
    return { kp: keypairFromMnemonic($('cold-mnemonic').value.toLowerCase().trim().split(/\s+/).join(' '), '', scheme), mnemonic: true };
  }
  const hex = $('cold-seed').value.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('seed must be 64 hex characters (32 bytes)');
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return { kp: keypairFromSeed(seed, scheme), mnemonic: false };
}

$('btn-cold-review').addEventListener('click', () => {
  err('cold-build-err');
  $('cold-review').hidden = true;
  try {
    if (!cold.ticket) throw new Error('import a chain ticket first (step 1)');
    const dest = $('cold-dest').value.trim();
    const { prefix, accountId: destAccountId } = ss58Decode(dest);
    if (prefix !== 189) throw new Error('destination has wrong network prefix');
    if (!cold.cpWords) throw new Error('wait for the checkphrase to compute');
    const answer = $('cp-answer').value.toLowerCase().trim().split(/\s+/);
    if (answer.join(' ') !== cold.cpWords.join(' '))
      throw new Error('checkphrase mismatch — re-read the five words from the destination address');
    const amount = qtcToPlancks($('cold-amount').value);
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    const nonceRaw = $('cold-nonce').value.trim();
    if (!/^\d+$/.test(nonceRaw)) throw new Error('nonce must be a non-negative integer');
    const nonce = Number(nonceRaw);
    if (nonce !== cold.ticket.nonce)
      throw new Error(`nonce ${nonce} differs from the ticket's ${cold.ticket.nonce} — only override it if you know the chain moved on`);
    const scheme = Number($('cold-scheme').value);
    // exact byte length of the final extrinsic (signature length is scheme-fixed)
    const sigLen = scheme === 87 ? 4627 : 3309;
    const wireLen = 1 + sigLen + (scheme === 87 ? 2592 : 1952);
    $('cold-review-summary').innerHTML = kvHTML([
      ['From', shortAddr(cold.ticket.addr)],
      ['To', shortAddr(dest)],
      ['Amount', `<span class="big">${$('cold-amount').value.trim()} QTC</span>`],
      ['Nonce', String(nonce)],
      ['Scheme', scheme === 87 ? 'ML-DSA-87' : 'ML-DSA-65'],
      ['Signature wire', `${wireLen.toLocaleString()} bytes (fixed for the scheme)`],
      ['Checkphrase', '✓ read back correctly'],
    ]);
    // pin exactly what was reviewed — signing re-validates against this
    cold.reviewed = { dest, amount: $('cold-amount').value.trim(), nonce: nonceRaw };
    $('cold-review').hidden = false;
    $('cold-review').scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
  } catch (e) { err('cold-build-err', e.message); }
});

$('btn-cold-sign').addEventListener('click', async () => {
  err('cold-err');
  const btn = $('btn-cold-sign'); btn.disabled = true; btn.textContent = 'Signing…';
  let kp = null;
  try {
    const scheme = Number($('cold-scheme').value);
    ({ kp } = readColdKey(scheme));
    // the key MUST match the ticket's sender — otherwise the signature is useless
    if (kp.address !== cold.ticket.addr) {
      throw new Error('this key derives to ' + shortAddr(kp.address) + ' — but the ticket is for ' + shortAddr(cold.ticket.addr) + '. Wrong key, refusing to sign.');
    }
    const dest = $('cold-dest').value.trim();
    // sign EXACTLY what was reviewed: re-validate the live fields against the
    // reviewed snapshot — a dest/amount/nonce edited (or pasted over) after
    // review must never be signed on the strength of the old checkphrase.
    if (!cold.reviewed) throw new Error('review the transfer first — signing is pinned to the reviewed destination, amount and nonce');
    if (dest !== cold.reviewed.dest || $('cold-amount').value.trim() !== cold.reviewed.amount || $('cold-nonce').value.trim() !== cold.reviewed.nonce)
      throw new Error('destination, amount or nonce changed since review — review again before signing');
    const { prefix: destPrefix, accountId: destAccountId } = ss58Decode(dest);
    if (destPrefix !== 189) throw new Error('destination has wrong network prefix');
    const amount = qtcToPlancks($('cold-amount').value);
    const nonce = Number($('cold-nonce').value.trim());
    const era = encodeMortalEra(cold.ticket.era.period, cold.ticket.era.phase);
    const mod = scheme === 87 ? ml_dsa87 : ml_dsa65;
    const payload = buildColdPayload({
      ticket: cold.ticket, destAccountId, amountPlancks: amount, era, nonce,
    });
    const t0 = performance.now();
    const sig = mod.sign(payload, kp.secretKey, { context: te.encode('QUANTUS_EXTRINSIC') });
    const ms = Math.round(performance.now() - t0);
    const built = buildColdExtrinsic({
      ticket: cold.ticket, senderAccountId: kp.accountId, destAccountId,
      amountPlancks: amount, era, nonce, scheme,
      signResult: { signature: sig, pubkey: kp.publicKey },
    });
    // local self-check before export: never hand the hot side a bad package
    if (!mod.verify(sig, payload, kp.publicKey, { context: te.encode('QUANTUS_EXTRINSIC') }))
      throw new Error('local signature self-check failed — nothing was exported');
    cold.extrinsicHex = built.extrinsicHex;
    cold.reviewed = null; // a review authorizes exactly one signature
    const session = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    cold.chunks = encodeChunks(session, built.extrinsicHex, 800);
    $('stepper-mount').innerHTML = '';
    mountChunkStepper($('stepper-mount'), cold.chunks);
    $('pkg-hex').value = cold.chunks.join('\n');
    $('btn-pkg-copy').disabled = false;
    $('btn-pkg-download').disabled = false;
    $('cold-wipe-note').hidden = false;
    $('cold-wipe-note').textContent = `🔒 Signed in ${ms} ms — signing key wiped from memory.`;
    err('cold-err');
  } catch (e) {
    err('cold-err', e.message);
  } finally {
    if (kp && kp.secretKey) kp.secretKey.fill(0);
    kp = null;
    $('cold-mnemonic').value = '';
    $('cold-seed').value = '';
    btn.disabled = false; btn.textContent = 'Sign offline';
  }
});

$('btn-pkg-copy').addEventListener('click', (e) => copyText(cold.chunks.join('\n'), e.target));
$('btn-pkg-download').addEventListener('click', () => download('qtc-signed.qagx', cold.chunks.join('\n')));

/* ---------------- boot ---------------- */
loadWordlist().catch(() => {});
