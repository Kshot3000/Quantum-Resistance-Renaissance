/* QTC Airgap Desk — QR encode/decode helpers.
 *
 * Encoding: vendored low-level generator (window.qrcode, same one the Web
 * Wallet uses). Decoding: vendored jsQR 1.4.0 (Apache-2.0, (c) LazarSoft-style
 * attribution in vendor/jsqr.LICENSE) over uploaded image files or an
 * optional camera stream. Everything stays on-device.
 *
 * jsQR is 251 KB — by far the heaviest asset in the fleet — and only the
 * minority of visitors who scan or upload a QR ever need it, so it is NOT
 * loaded with the page. ensureJsQR() injects it on first decode/camera use
 * and caches the in-flight load; every other flow (ticket issue, cold
 * signing, chunk export, paste/upload-as-text) pays zero decoder bytes.
 */

let jsqrPromise = null;

/* Load the vendored jsQR decoder on demand. Resolves once window.jsQR is
 * available; rejects with a human message (and clears the cache so a later
 * attempt can retry) when the script cannot be fetched or is malformed. */
export function ensureJsQR() {
  if (typeof window.jsQR === 'function') return Promise.resolve();
  if (jsqrPromise) return jsqrPromise;
  jsqrPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // Resolved against the page URL: the Airgap Desk page is the only
    // consumer of this module and sits directly above js/vendor/.
    s.src = 'js/vendor/jsqr.js?v=1.35.0';
    s.onload = () => {
      if (typeof window.jsQR === 'function') resolve();
      else { jsqrPromise = null; reject(new Error('QR decoder loaded but is unavailable — reload the page and try again')); }
    };
    s.onerror = () => {
      jsqrPromise = null;
      reject(new Error('QR decoder failed to load — check your connection, or use paste / text upload instead'));
    };
    document.head.appendChild(s);
  });
  return jsqrPromise;
}

/* Draw `text` into `canvas` (square). Throws if the payload exceeds QR
 * capacity at the chosen error-correction level. */
export function drawQR(canvas, text, { ecLevel = 'M', dark = '#0a0618', light = '#ffffff' } = {}) {
  if (typeof window.qrcode !== 'function') throw new Error('QR encoder not loaded');
  const qr = window.qrcode(0, ecLevel); // 0 = auto version
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cell = size / n;
  ctx.fillStyle = light; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = dark;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
}

/* Decode the first QR found in an image File/Blob. Returns the payload text. */
export async function decodeQRImage(file) {
  await ensureJsQR();
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!res || !res.data) throw new Error('no QR code found in that image');
  return res.data;
}

/* Decode a QR from a <video> frame (camera scanning). Returns text or null. */
export function decodeVideoFrame(video) {
  if (typeof window.jsQR !== 'function') throw new Error('QR decoder not loaded');
  if (!video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return res && res.data ? res.data : null;
}

/* Chunk stepper: shows one chunk QR at a time with prev/next + auto-advance.
 * mount(el, chunks): renders controls into el. Returns { stop() }. */
export function mountChunkStepper(el, chunks, { autoMs = 1200 } = {}) {
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stepper';
  const canvas = document.createElement('canvas');
  canvas.width = 264; canvas.height = 264;
  canvas.className = 'qr-big';
  const meta = document.createElement('div');
  meta.className = 'stepper-meta';
  const ctrls = document.createElement('div');
  ctrls.className = 'stepper-ctrls';
  const prev = document.createElement('button'); prev.className = 'btn ghost small'; prev.textContent = '◀ Prev';
  const next = document.createElement('button'); next.className = 'btn ghost small'; next.textContent = 'Next ▶';
  const auto = document.createElement('button'); auto.className = 'btn ghost small'; auto.textContent = '▶ Auto-advance';
  const dots = document.createElement('div'); dots.className = 'stepper-dots';
  ctrls.append(prev, next, auto);
  wrap.append(canvas, meta, dots, ctrls);
  el.appendChild(wrap);

  let i = 0, timer = null;
  const render = () => {
    drawQR(canvas, chunks[i]);
    meta.textContent = `Chunk ${i + 1} of ${chunks.length} — scan in order, left to right`;
    dots.innerHTML = '';
    chunks.forEach((_, k) => {
      const d = document.createElement('button');
      d.className = 'dot' + (k === i ? ' on' : '');
      d.setAttribute('aria-label', 'chunk ' + (k + 1));
      d.addEventListener('click', () => { stopAuto(); i = k; render(); });
      dots.appendChild(d);
    });
  };
  const stopAuto = () => { if (timer) { clearInterval(timer); timer = null; auto.textContent = '▶ Auto-advance'; } };
  prev.addEventListener('click', () => { stopAuto(); i = (i - 1 + chunks.length) % chunks.length; render(); });
  next.addEventListener('click', () => { stopAuto(); i = (i + 1) % chunks.length; render(); });
  auto.addEventListener('click', () => {
    if (timer) { stopAuto(); return; }
    auto.textContent = '⏸ Pause';
    timer = setInterval(() => { i = (i + 1) % chunks.length; render(); }, autoMs);
  });
  render();
  return { stop: stopAuto };
}

/* Live camera scanner: attaches getUserMedia to `video`, decodes frames, and
 * calls onText(text) for each NEW payload seen. Returns { stop() }.
 * Rejects with a human message if the camera is unavailable. */
export async function startCameraScan(video, onText) {
  await ensureJsQR();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw new Error('camera API unavailable in this browser/context');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    throw new Error('camera denied or unavailable (' + (e.name || 'error') + ') — use image upload or paste instead');
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const seen = new Set();
  let alive = true, busy = false;
  const tick = async () => {
    if (!alive) return;
    if (!busy && video.videoWidth) {
      busy = true;
      try {
        const t = decodeVideoFrame(video);
        if (t && !seen.has(t)) { seen.add(t); onText(t); }
      } catch { /* keep scanning */ }
      busy = false;
    }
    if (alive) setTimeout(tick, 400);
  };
  tick();
  return {
    stop() {
      alive = false;
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch {}
      video.srcObject = null;
    },
  };
}
