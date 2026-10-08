'use strict';
/* QTC Extrinsic Lab — app controller.
 * Decode tab: paste hex -> byte-level autopsy. Verify tab: local ML-DSA
 * signature check. Live tab: finalized-block scanner over WebSocket.
 * Reference tab: searchable verified call table. All decoding is local. */
(function () {
  var D = window.QEL_DECODE, CT = window.QEL_CALLS, E = window.QEL_ENCODE, V = window.QEL_VERIFY;
  var state = { last: null, lastHex: '', ws: null, wsUrl: '', rpcId: 0, rpcPending: {}, liveBlock: null };
  /* Stale-pin tokens: every async RPC path captures the token current at
   * click time; a continuation renders only while its token is still the
   * latest, so a superseded fetch/scan/connect discards itself silently. */
  var ctxSeq = 0, scanSeq = 0, liveSeq = 0;

  /* ---------- tiny utils ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var box = $('qel-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'qel-toasts'; document.body.appendChild(box); }
    var t = document.createElement('div');
    t.className = 'qel-toast'; t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 450); }, 2200);
  }
  function copyText(txt, label) {
    function done() { toast((label || 'Copied') + ' to clipboard'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — select manually'); }
      ta.remove();
    }
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-copy]');
    if (b) copyText(b.getAttribute('data-copy'), b.getAttribute('data-copylabel') || 'Address');
  });

  function qtc(bi) {
    bi = BigInt(bi);
    var neg = bi < 0n, a = neg ? -bi : bi;
    var w = (a / 1000000000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var f = (a % 1000000000000n).toString().padStart(12, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + w + (f ? '.' + f : '');
  }
  function momentIso(ms) {
    try { return new Date(Number(ms)).toISOString(); } catch (e) { return 'invalid'; }
  }
  function shortAddr(a) { return a && a.length > 16 ? a.slice(0, 9) + '…' + a.slice(-6) : a; }
  function hexPreview(hex, n) {
    hex = String(hex);
    return hex.length > (n || 68) ? hex.slice(0, n || 68) + '…(' + (hex.length / 2 - (n || 68) / 2) + ' more bytes)' : hex;
  }

  /* ---------- tabs ---------- */
  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
  });
  function switchTab(name) {
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
  }
  window.QEL_switchTab = switchTab;

  /* ---------- value rendering ---------- */
  var SEG_COLORS = {
    'version': '#5b6b7f', 'signer': '#38bdf8', 'signature': '#b48cff', 'era': '#ffbe3d',
    'nonce': '#4affa0', 'tip': '#fb923c', 'metadata-hash': '#64748b', 'call': '#34d399'
  };

  function renderAccount(acct) {
    if (!acct) return '<span class="warnline">no account</span>';
    var words = acct.checkphrase ? '<span class="words" title="Human checkphrase — 4 words derived from the address">' + esc(acct.checkphrase) + '</span>' : '';
    return '<div class="addrline"><span class="mono">' + esc(acct.ss58 || acct.hex) + '</span>' +
      '<button class="copybtn" data-copy="' + esc(acct.ss58 || acct.hex) + '" data-copylabel="Address">copy</button></div>' +
      '<div class="hexprev">' + esc(acct.hex) + '</div>' + words;
  }

  function renderValue(decoded, arg, depth) {
    depth = depth || 0;
    if (decoded === null || decoded === undefined) return '<span class="warnline">null</span>';
    if (typeof decoded === 'bigint') {
      var big = decoded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      var conv = '';
      if (arg && arg.qtc) conv = ' <span class="conv">= ' + qtc(decoded) + ' QTC</span>';
      if (arg && arg.moment) conv = ' <span class="conv">= ' + esc(momentIso(decoded)) + '</span>';
      return '<span class="big">' + esc(big) + '</span>' + conv;
    }
    if (typeof decoded === 'number') {
      var conv2 = '';
      if (arg && arg.moment) conv2 = ' <span class="conv">= ' + esc(momentIso(BigInt(decoded))) + '</span>';
      return '<span class="big">' + decoded.toLocaleString('en-US') + '</span>' + conv2;
    }
    if (typeof decoded === 'string') return '<span class="mono">' + esc(decoded) + '</span>';
    if (typeof decoded === 'boolean') return '<span class="mono">' + (decoded ? 'true' : 'false') + '</span>';
    var k = decoded.kind;
    if (k === 'account') return renderAccount(decoded);
    if (k === 'multiaddr' || decoded.variantName) {
      if (decoded.account) return '<div class="conv">' + esc(decoded.variantName) + '</div>' + renderAccount(decoded.account);
      return '<span class="mono">' + esc(decoded.variantName || 'multiaddress') + '</span>';
    }
    if (k === 'hash') {
      return '<span class="mono">' + esc(shortAddr(decoded.hex)) + '</span> <button class="copybtn" data-copy="' + esc(decoded.hex) + '" data-copylabel="Hash">copy</button>';
    }
    if (k === 'enum') {
      var flds = (decoded.fields || []).map(function (f) { return renderValue(f.value, null, depth + 1); }).join(', ');
      return '<span class="mono" style="color:var(--violet)">' + esc(decoded.variant) + '</span>' +
        (flds ? '<span class="conv">(' + flds + ')</span>' : '') +
        (decoded.name ? ' <span class="conv">' + esc(decoded.name) + '</span>' : '');
    }
    if (k === 'vec') {
      var items = decoded.items || [];
      var shown = items.slice(0, 25).map(function (it, i) {
        return '<div class="arg" style="margin-bottom:6px"><div class="arg-head"><span class="arg-name">[' + i + ']</span></div><div class="arg-val">' + renderValue(it.value, null, depth + 1) + '</div></div>';
      }).join('');
      return '<div class="conv">vec — ' + decoded.len + ' item' + (decoded.len === 1 ? '' : 's') + '</div>' +
        '<div class="vec-items">' + shown + '</div>' +
        (items.length > 25 ? '<div class="warnline">…and ' + (items.length - 25) + ' more (truncated for display)</div>' : '');
    }
    if (k === 'bytes') {
      var utf = '';
      if (arg && arg.utf8 && decoded.utf8Text) utf = '<div class="conv">utf-8: “' + esc(decoded.utf8Text) + '”</div>';
      return '<div class="conv">' + decoded.len + ' bytes</div>' + utf +
        '<div class="hexprev">' + esc(hexPreview(decoded.hex, 130)) + '</div>';
    }
    if (k === 'callbytes' || k === 'call') {
      var inner = decoded.call || decoded;
      return '<div class="conv">embedded call — ' + (decoded.len != null ? decoded.len + ' bytes, ' : '') + 'decoded below</div>' +
        '<div class="nested">' + renderCall(inner, depth + 1) + '</div>';
    }
    if (k === 'option') {
      return decoded.some == null ? '<span class="conv">None</span>'
        : '<span class="conv">Some(</span>' + renderValue(decoded.some, null, depth + 1) + '<span class="conv">)</span>';
    }
    if (k === 'opaque') {
      return '<div class="opaque-note">⚠ opaque bytes — this shape is not in the verified call table, shown raw (' + (decoded.why || 'no layout') + ')</div>' +
        '<div class="hexprev">' + esc(hexPreview(decoded.hex, 130)) + '</div>';
    }
    return '<span class="mono">' + esc(JSON.stringify(decoded)) + '</span>';
  }

  function renderCall(call, depth) {
    depth = depth || 0;
    var title;
    if (call.unknown) {
      title = '<span class="arg-name" style="color:var(--amber)">' + esc(call.unknown) + '</span>';
    } else {
      title = '<span class="arg-name">' + esc(call.palletName) + '.' + esc(call.callName) + '</span>' +
        '<span class="arg-type">pallet ' + call.palletIndex + ' · call ' + call.callIndex + '</span>' +
        (call.rootOnly ? '<span class="badge root">root only</span>' : '') +
        (call.disabled ? '<span class="badge dis">disabled</span>' : '');
    }
    var args = (call.args || []).map(function (a) {
      var shapeName = a.shape && a.shape.k ? a.shape.k + (a.shape.name ? ':' + a.shape.name : '') : '?';
      return '<div class="arg"><div class="arg-head"><span class="arg-name">' + esc(a.name) + '</span>' +
        '<span class="arg-type">' + esc(shapeName) + '</span>' +
        '<span class="arg-range">bytes ' + a.start + '–' + a.end + '</span></div>' +
        '<div class="arg-val">' + renderValue(a.decoded, a, depth + 1) + '</div></div>';
    }).join('');
    return '<div style="margin-bottom:8px">' + title + '</div>' + (args || '<div class="fineprint">no arguments</div>');
  }

  /* ---------- stale-pin invalidation ----------
   * The autopsy panel and the Verify tab both consume the decoded pin
   * (state.last / state.lastHex). If the hex box diverges from the pin,
   * the panel would describe extrinsic A while the box shows B — and
   * Verify would pronounce A's verdict over B. Any divergence voids
   * both, with an explanation. Programmatic loads (samples, Live-tab
   * autopsy) set the box and decode in the same step, so they never
   * trip this: setting .value fires no input event. */
  function voidVerify(msg) {
    var resBox = $('verify-result'), errBox = $('verify-error');
    if (resBox.hidden) return;
    resBox.hidden = true; resBox.innerHTML = '';
    if (msg) { errBox.hidden = false; errBox.innerHTML = '<b>Verdict cleared.</b> ' + esc(msg); }
  }
  function voidDecode() {
    if (!state.last) return;
    state.last = null; state.lastHex = '';
    $('decode-result').hidden = true;
    var errBox = $('decode-error');
    errBox.hidden = false;
    errBox.innerHTML = '<b>Autopsy cleared.</b> The hex changed after this extrinsic was decoded, so the old autopsy no longer describes what is in the box. Run Autopsy again to decode the current hex.';
    voidVerify('The decoded extrinsic changed, so the verdict no longer applies. Decode the current hex and verify again.');
  }

  /* ---------- decode ---------- */
  function doDecode(hexInput) {
    var errBox = $('decode-error'), resBox = $('decode-result');
    errBox.hidden = true; resBox.hidden = true;
    /* A fresh decode supersedes any verdict earned by the previous one. */
    voidVerify('A new extrinsic was decoded, so the previous verdict no longer applies. Verify again.');
    var hex = (hexInput != null ? hexInput : $('hex-input').value).trim();
    if (!hex) { state.last = null; state.lastHex = ''; errBox.hidden = false; errBox.innerHTML = '<b>No input.</b> Paste an extrinsic hex first — or pick a lab sample.'; return; }
    var d;
    try {
      d = D.decodeExtrinsic(hex);
      d._hex = hex;
    } catch (e) {
      /* A failed decode must not leave the previous pin verifiable. */
      state.last = null; state.lastHex = '';
      errBox.hidden = false;
      errBox.innerHTML = '<b>Could not decode.</b> ' + esc(e.message) +
        '<br><span class="conv">Tip: the input must be the full length-prefixed extrinsic hex (starts with 0x…), not just the call data.</span>';
      return;
    }
    state.last = d; state.lastHex = hex;
    renderSummary(d);
    renderByteMap(d, hex);
    renderAnatomy(d);
    $('call-args').innerHTML = d.call ? renderCall(d.call, 0) : '<div class="fineprint">no call section</div>';
    resBox.hidden = false;
    resBox.scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'start' });
  }

  function stat(label, value, violet) {
    var plain = String(value).replace(/<[^>]*>/g, '');
    var long = plain.length > 22 ? ' long' : '';
    return '<div class="stat"><span class="sv' + (violet ? ' violet' : '') + long + '">' + value + '</span><span class="sl">' + label + '</span></div>';
  }
  function renderSummary(d) {
    var g = $('summary-grid');
    var callName = d.call ? (d.call.palletName || 'pallet ' + d.call.palletIndex) + '.' + (d.call.callName || 'call ' + d.call.callIndex) : '—';
    var signer = d.signer && d.signer.account ? shortAddr(d.signer.account.ss58) : (d.version.signed ? '?' : '— (inherent)');
    var era = d.era ? (d.era.immortal ? 'immortal' : 'mortal ' + d.era.period + '/' + d.era.phase) : '—';
    var html = stat('call', esc(callName)) +
      stat('signer', esc(signer)) +
      stat('nonce', d.nonce != null ? esc(d.nonce.toString()) : '—') +
      stat('tip (QTC)', d.tip != null ? esc(qtc(d.tip)) : '—') +
      stat('era', esc(era)) +
      stat('scheme', d.signature ? esc(d.signature.scheme) : 'unsigned', true) +
      stat('size', esc(((state.lastHex.length - 2) / 2).toLocaleString('en-US')) + ' B');
    if (d.trailing) html += stat('trailing bytes', '<span style="color:var(--amber)">' + d.trailing + ' ⚠</span>');
    g.innerHTML = html;
  }

  function renderByteMap(d, hex) {
    var total = (hex.length - 2) / 2;
    $('bytemap-total').textContent = '— ' + total.toLocaleString('en-US') + ' bytes total';
    var map = $('byte-map'), legend = $('byte-legend');
    map.innerHTML = ''; legend.innerHTML = '';
    (d.sections || []).forEach(function (s, i) {
      var len = s.end - s.start;
      var color = SEG_COLORS[s.label] || '#888';
      var seg = document.createElement('div');
      seg.className = 'bseg';
      seg.style.background = color + '26';
      seg.style.borderColor = color + '66';
      seg.style.flex = Math.max(len, total * 0.012) + ' 1 0';
      seg.title = s.label + ': bytes ' + s.start + '–' + s.end + ' (' + len + ' B)\n' + (s.note || '');
      seg.innerHTML = '<span class="bl" style="color:' + color + '">' + esc(s.label) + '</span>' +
        '<span class="br">' + s.start + '–' + s.end + '</span>';
      seg.addEventListener('click', function () {
        map.querySelectorAll('.bseg').forEach(function (x) { x.classList.remove('sel'); });
        seg.classList.add('sel');
        var row = document.querySelector('.arow[data-sec="' + i + '"]');
        if (row) {
          row.scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'center' });
          row.classList.add('flash');
          setTimeout(function () { row.classList.remove('flash'); }, 1200);
        }
      });
      map.appendChild(seg);
      var li = document.createElement('span');
      li.innerHTML = '<span class="swatch" style="background:' + color + '"></span>' + esc(s.label) + ' (' + len + ' B)';
      legend.appendChild(li);
    });
  }

  function renderAnatomy(d) {
    var box = $('anatomy');
    box.innerHTML = '<div class="anat">' + (d.sections || []).map(function (s, i) {
      var len = s.end - s.start;
      return '<div class="arow" data-sec="' + i + '"><span class="al">' + esc(s.label) + '</span>' +
        '<span class="ar">bytes ' + s.start + '–' + s.end + ' · ' + len + ' B</span>' +
        '<span class="ad">' + esc(s.note || '') + '</span></div>';
    }).join('') + '</div>' +
      (d.trailing ? '<div class="warnline" style="margin-top:8px">⚠ ' + d.trailing + ' trailing byte(s) after the decoded call — the length prefix covers more than the decoder consumed. The extrinsic may use a layout this table does not know.</div>' : '');
  }

  $('decode-btn').addEventListener('click', function () { doDecode(); });
  $('clear-btn').addEventListener('click', function () {
    $('hex-input').value = ''; $('decode-error').hidden = true; $('decode-result').hidden = true;
    state.last = null; state.lastHex = '';
  });
  $('hex-input').addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') doDecode();
  });
  $('hex-input').addEventListener('input', function () {
    if (state.last && this.value.trim() !== state.lastHex) voidDecode();
  });

  /* ---------- lab samples (generated locally, never broadcast) ---------- */
  function rand32(seed) { var b = new Uint8Array(32); for (var i = 0; i < 32; i++) b[i] = (seed * 31 + i * 7) & 255; return b; }
  function buildTransfer(dest32, plancks) {
    return D.concatBytes([Uint8Array.of(2, 3, 0x00), dest32, E.compactEncode(plancks)]);
  }
  function makeSamples() {
    var N = window.QEL_NOBLE;
    var samples = {};
    // 1: signed transfer, ML-DSA-65, immortal
    var kp = N.ml_dsa65.keygen();
    var ctx = new TextEncoder().encode('QUANTUS_EXTRINSIC');
    var genesis = rand32(200);
    samples.transfer = E.encodeExtrinsic({
      callBytes: buildTransfer(rand32(201), 1500000000000n),
      pub32: rand32(202), pubKey: kp.publicKey, sigVariant: 1,
      eraBytes: Uint8Array.of(0), nonce: 7n, tip: 0n, metadataHashMode: 0,
      specVersion: 153, txVersion: 6, genesisHash: genesis, eraBirthHash: genesis,
      signFn: function (m) { return N.ml_dsa65.sign(m, kp.secretKey, { context: ctx }); }
    });
    // 2: batch_all x6 (payload > 256B -> hashed) — proves the blake2 rule live
    var inners = [];
    for (var i = 0; i < 6; i++) inners.push(buildTransfer(rand32(210 + i), BigInt(1000000000000 + i * 1000000000)));
    var batchCall = D.concatBytes([Uint8Array.of(9, 2), E.compactEncode(inners.length)].concat(inners));
    samples.batch = E.encodeExtrinsic({
      callBytes: batchCall,
      pub32: rand32(213), pubKey: kp.publicKey, sigVariant: 1,
      eraBytes: Uint8Array.of(0), nonce: 8n, tip: 500000000n, metadataHashMode: 0,
      specVersion: 153, txVersion: 6, genesisHash: genesis, eraBirthHash: genesis,
      signFn: function (m) { return N.ml_dsa65.sign(m, kp.secretKey, { context: ctx }); }
    });
    // 3: unsigned timestamp inherent
    var now = E.compactEncode(BigInt(Date.now()));
    var body = D.concatBytes([Uint8Array.of(0x04, 1, 0), now]);
    samples.inherent = '0x' + D.bytesToHex(D.concatBytes([E.compactEncode(body.length), body]));
    return samples;
  }
  var sampleCache = null;
  $('sample-sel').addEventListener('change', function () {
    var kind = this.value;
    if (!kind) return;
    if (!window.QEL_NOBLE) { toast('ML-DSA engine still loading — try again in a moment'); this.value = ''; return; }
    try {
      if (!sampleCache) sampleCache = makeSamples();
      $('hex-input').value = sampleCache[kind];
      doDecode(sampleCache[kind]);
      toast('Lab sample loaded (generated locally — never broadcast)');
    } catch (e) {
      toast('Sample generation failed: ' + e.message);
    }
    this.value = '';
  });

  /* ---------- verify tab ---------- */
  function hexTo32(str, label) {
    var s = (str || '').trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error(label + ' must be 32 bytes of hex (0x…64 chars)');
    return D.hexToBytes('0x' + s);
  }
  function doVerify() {
    var errBox = $('verify-error'), resBox = $('verify-result');
    errBox.hidden = true; resBox.hidden = true;
    try {
      if (!window.QEL_NOBLE) throw new Error('ML-DSA engine still loading — wait a moment and retry.');
      if (!state.last) throw new Error('Nothing to verify — decode an extrinsic in the Decode tab first (or load a lab sample).');
      var d = state.last;
      if (!d.version.signed) throw new Error('Unsigned (inherent) extrinsics carry no signature to verify.');
      var ctx = {
        specVersion: parseInt($('v-spec').value.trim(), 10) || 153,
        txVersion: parseInt($('v-tx').value.trim(), 10) || 6,
        genesisHash: $('v-genesis').value.trim() ? hexTo32($('v-genesis').value, 'genesis hash') : null,
        eraBirthHash: $('v-birth').value.trim() ? hexTo32($('v-birth').value, 'era-birth hash') : null
      };
      if (!ctx.genesisHash) throw new Error('Genesis hash is required — use “Fetch context from node” or paste it manually.');
      var blockNum = $('v-block').value.trim() ? parseInt($('v-block').value.trim(), 10) : null;
      if (!d.era.immortal) {
        if (blockNum == null) throw new Error('Mortal-era extrinsic: enter the target block number so the era-birth block can be computed (or fetch context from the node).');
        ctx.eraBirth = V.birthFor(d, blockNum);
        if (!ctx.eraBirthHash) throw new Error('Mortal-era extrinsic: the era-birth block hash (block ' + ctx.eraBirth + ') is required — use “Fetch context from node”.');
      }
      var r = V.verifyExtrinsic(d, ctx);
      resBox.hidden = false;
      resBox.innerHTML =
        '<div class="verdict ' + (r.ok ? 'ok' : 'bad') + '"><h3>' + (r.ok ? '✓ VALID signature' : '✗ INVALID signature') + '</h3>' +
        (r.error ? '<p class="warnline">' + esc(r.error) + '</p>' : '') +
        '<div class="kv"><span class="k">scheme</span><span class="v">' + esc(r.scheme) + ' · context “QUANTUS_EXTRINSIC”</span></div>' +
        '<div class="kv"><span class="k">signing payload</span><span class="v">' + esc(r.payloadLen) + ' bytes' + (r.hashed ? ' → blake2-256 hashed (over 256 B)' : ' (signed directly, ≤ 256 B)') + '</span></div>' +
        '<div class="kv"><span class="k">payload hex</span><span class="v">' + esc(hexPreview(r.payloadHex, 120)) + '</span></div>' +
        '<div class="kv"><span class="k">message verified</span><span class="v">' + esc(hexPreview(r.messageHex, 80)) + '</span></div>' +
        (!r.ok ? '<p class="warnline" style="margin-top:8px">The signature does not match this payload under the embedded public key. The extrinsic was tampered with, signed for a different chain/spec version, or the context is wrong.</p>' : '') +
        '</div>';
      resBox.scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'nearest' });
    } catch (e) {
      errBox.hidden = false;
      errBox.innerHTML = '<b>Cannot verify.</b> ' + esc(e.message);
    }
  }
  $('verify-btn').addEventListener('click', doVerify);
  /* A verdict is a pin on its context: editing any context field after
   * a verdict renders voids it (the payload is rebuilt from these). */
  ['v-spec', 'v-tx', 'v-genesis', 'v-block', 'v-birth'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      voidVerify('The verification context changed after the verdict, so it no longer applies. Verify again.');
    });
  });
  window.addEventListener('qel:crypto-ready', function () {
    var n = $('crypto-note');
    n.textContent = 'ML-DSA engine ready (65 + 87, FIPS-204)';
    n.classList.add('ok');
  });
  if (window.QEL_NOBLE) window.dispatchEvent(new Event('qel:crypto-ready'));

  /* ---------- minimal JSON-RPC over WebSocket ---------- */
  function rpcConnect(url, onOpen, onFail) {
    var ws;
    try { ws = new WebSocket(url); } catch (e) { onFail(e); return null; }
    var opened = false;
    var timer = setTimeout(function () { if (!opened) { try { ws.close(); } catch (e) {} onFail(new Error('connection timed out (10s)')); } }, 10000);
    ws.onopen = function () { opened = true; clearTimeout(timer); onOpen(ws); };
    ws.onerror = function () { if (!opened) { clearTimeout(timer); onFail(new Error('WebSocket error — the endpoint may be unreachable or blocking browser origins')); } };
    ws.onclose = function () { if (!opened) { clearTimeout(timer); onFail(new Error('connection closed before handshake')); } };
    return ws;
  }
  function rpcCall(ws, pending, method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++state.rpcId;
      pending[id] = { resolve: resolve, reject: reject };
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || [] }));
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('RPC timeout: ' + method)); }
      }, 15000);
    });
  }
  function attachRpc(ws, pending) {
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    };
  }
  function setPill(mode, text) {
    var pill = $('conn-pill');
    pill.className = 'pill ' + mode;
    pill.innerHTML = '<span class="dot"></span>' + esc(text);
  }

  /* Fetch runtime context for the Verify tab via a one-shot connection. */
  $('ctx-btn').addEventListener('click', function () {
    var myCtx = ++ctxSeq;
    var errBox = $('verify-error');
    errBox.hidden = true;
    var url = $('rpc-url').value.trim();
    setPill('busy', 'fetching context…');
    rpcConnect(url, function (ws) {
      if (myCtx !== ctxSeq) { try { ws.close(); } catch (e) {} return; }
      var pending = {};
      attachRpc(ws, pending);
      (async function () {
        try {
          var headHash = await rpcCall(ws, pending, 'chain_getFinalizedHead', []);
          var header = await rpcCall(ws, pending, 'chain_getHeader', [headHash]);
          var blockNum = parseInt(header.number, 16);
          var rt = await rpcCall(ws, pending, 'state_getRuntimeVersion', []);
          var genesis = await rpcCall(ws, pending, 'chain_getBlockHash', [0]);
          if (myCtx !== ctxSeq) return;
          $('v-spec').value = rt.specVersion;
          $('v-tx').value = rt.transactionVersion;
          $('v-genesis').value = genesis;
          /* Programmatic writes fire no input event — void any verdict
           * earned under the old context explicitly. */
          voidVerify('Fresh context was fetched from the node, so the previous verdict no longer applies. Verify again.');
          var note = 'spec ' + rt.specVersion + ' · tx v' + rt.transactionVersion + ' · finalized #' + blockNum.toLocaleString('en-US');
          var d = state.last;
          if (d && d.version.signed && !d.era.immortal) {
            var birth = V.birthFor(d, blockNum);
            var birthHash = await rpcCall(ws, pending, 'chain_getBlockHash', [birth]);
            if (myCtx !== ctxSeq) return;
            $('v-birth').value = birthHash;
            $('v-block').value = blockNum;
            note += ' · era-birth #' + birth;
          } else if (d && d.version.signed) {
            $('v-block').value = blockNum;
          }
          toast('Context fetched: ' + note);
        } catch (e) {
          if (myCtx !== ctxSeq) return;
          errBox.hidden = false;
          errBox.innerHTML = '<b>Context fetch failed.</b> ' + esc(e.message);
        } finally {
          try { ws.close(); } catch (e) {}
          /* A superseded fetch never touches the pill — the newer fetch
           * (or the live connection state it restores) owns it. */
          if (myCtx === ctxSeq) setPill(state.ws ? 'up' : 'down', state.ws ? 'node: ' + state.wsUrl : 'node: disconnected');
        }
      })();
    }, function (e) {
      if (myCtx !== ctxSeq) return;
      errBox.hidden = false;
      errBox.innerHTML = '<b>Context fetch failed.</b> ' + esc(e.message) + ' — check the endpoint in the Live blocks tab.';
      setPill(state.ws ? 'up' : 'down', state.ws ? 'node: ' + state.wsUrl : 'node: disconnected');
    });
  });

  /* ---------- live block scanner ---------- */
  function closeLive() {
    scanSeq++; /* invalidate any in-flight scan: it must not render over this */
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    $('live-refresh').disabled = true;
    setPill('down', 'node: disconnected');
  }
  async function scanHead() {
    var myScan = ++scanSeq;
    var ws = state.ws, pending = state.rpcPending;
    var errBox = $('live-error'), list = $('live-list'), meta = $('live-meta');
    errBox.hidden = true;
    list.innerHTML = '<div class="fineprint"><span class="spin"></span>Fetching latest finalized block…</div>';
    try {
      var headHash = await rpcCall(ws, pending, 'chain_getFinalizedHead', []);
      var block = await rpcCall(ws, pending, 'chain_getBlock', [headHash]);
      if (myScan !== scanSeq || state.ws !== ws) return;
      var num = parseInt(block.block.header.number, 16);
      var exts = block.block.extrinsics || [];
      state.liveBlock = { number: num, hash: headHash, count: exts.length };
      meta.innerHTML = 'Finalized block <span class="mono">#' + num.toLocaleString('en-US') + '</span> · <span class="mono">' +
        esc(headHash.slice(0, 18)) + '…</span> · ' + exts.length + ' extrinsic' + (exts.length === 1 ? '' : 's');
      list.innerHTML = '';
      exts.forEach(function (hex, i) {
        var row = document.createElement('div');
        row.className = 'live-row';
        var decoded = null, label, sub;
        try {
          decoded = D.decodeExtrinsic(hex);
          label = decoded.call ? esc((decoded.call.palletName || ('pallet ' + decoded.call.palletIndex)) + '.' + (decoded.call.callName || ('call ' + decoded.call.callIndex))) : '—';
          var signer = decoded.signer && decoded.signer.account ? shortAddr(decoded.signer.account.ss58) : (decoded.version.signed ? '?' : 'inherent');
          sub = esc(signer) + ' · ' + esc(decoded.signature ? decoded.signature.scheme : 'unsigned') + ' · ' + ((hex.length - 2) / 2).toLocaleString('en-US') + ' B';
        } catch (e) {
          label = '<span style="color:var(--amber)">undecodable</span>';
          sub = esc(e.message);
        }
        row.innerHTML = '<span class="live-idx">#' + i + '</span>' +
          '<div><div class="live-call">' + label + '</div><div class="live-sub">' + sub + '</div></div>' +
          '<button class="btn small">Autopsy →</button>';
        row.querySelector('button').addEventListener('click', function () {
          $('hex-input').value = hex;
          switchTab('decode');
          doDecode(hex);
        });
        list.appendChild(row);
      });
      if (!exts.length) list.innerHTML = '<div class="fineprint">Block contains no extrinsics.</div>';
    } catch (e) {
      if (myScan !== scanSeq || state.ws !== ws) return;
      errBox.hidden = false;
      errBox.innerHTML = '<b>Scan failed.</b> ' + esc(e.message);
      list.innerHTML = '';
    }
  }
  $('live-connect').addEventListener('click', function () {
    closeLive();
    var errBox = $('live-error');
    errBox.hidden = true;
    var url = $('rpc-url').value.trim();
    if (!/^wss?:\/\//.test(url)) {
      errBox.hidden = false;
      errBox.innerHTML = '<b>Bad endpoint.</b> Use a ws:// or wss:// URL.';
      return;
    }
    setPill('busy', 'connecting…');
    var myLive = ++liveSeq;
    var ws = rpcConnect(url, function (openWs) {
      if (myLive !== liveSeq) { try { openWs.close(); } catch (e) {} return; }
      state.ws = openWs; state.wsUrl = url; state.rpcPending = {};
      attachRpc(openWs, state.rpcPending);
      openWs.onclose = function () {
        if (state.ws === openWs) {
          state.ws = null; $('live-refresh').disabled = true;
          setPill('down', 'node: disconnected');
        }
      };
      setPill('up', 'node: connected');
      $('live-refresh').disabled = false;
      toast('Connected — scanning latest finalized block');
      scanHead();
    }, function (e) {
      if (myLive !== liveSeq) return;
      errBox.hidden = false;
      errBox.innerHTML = '<b>Connection failed.</b> ' + esc(e.message) +
        '<br><span class="conv">The lab keeps working offline: paste any extrinsic hex into the Decode tab — no node needed.</span>';
      setPill('down', 'node: disconnected');
    });
    if (ws && state.ws === null) { /* handshake pending */ }
  });
  $('live-refresh').addEventListener('click', scanHead);

  /* ---------- call reference ---------- */
  function renderReference(filter) {
    var box = $('ref-table');
    var f = (filter || '').trim().toLowerCase();
    var html = '';
    CT.PALLETS.forEach(function (p) {
      var calls = (p.calls || []).filter(function (c) {
        if (!f) return true;
        return (p.name + ' ' + c.name + ' ' + p.index + ' ' + c.index + ' ' +
          (c.args || []).map(function (a) { return a.name + ' ' + (a.shape && a.shape.k); }).join(' ')).toLowerCase().indexOf(f) >= 0;
      });
      var palletHit = !f || p.name.toLowerCase().indexOf(f) >= 0 || String(p.index) === f;
      if (!calls.length && !palletHit) return;
      var list = palletHit && !f ? p.calls : calls;
      html += '<div class="ref-pallet"><div class="ref-phead"><span class="pi">pallet ' + p.index + '</span>' +
        '<span class="pn">' + esc(p.name) + '</span>' +
        (p.note ? '<span class="pnote">' + esc(p.note) + '</span>' : '') + '</div><div class="ref-calls">';
      if (!list.length) {
        html += '<div class="ref-call"><span class="conv">no dispatchable calls</span></div>';
      } else {
        list.forEach(function (c) {
          var args = (c.args || []).map(function (a) {
            return '<b>' + esc(a.name) + '</b>: ' + esc(a.shape && a.shape.k ? a.shape.k + (a.shape.name ? '(' + a.shape.name + ')' : '') : '?') +
              (a.qtc ? ' · QTC' : '') + (a.moment ? ' · timestamp' : '') + (a.utf8 ? ' · utf8' : '');
          }).join('<br>');
          html += '<div class="ref-call"><span class="ci">' + c.index + '</span><span class="cn">' + esc(c.name) + '</span>' +
            (c.root ? '<span class="badge root">root only</span>' : '') +
            (c.disabled ? '<span class="badge dis">disabled</span>' : '') +
            (args ? '<div class="ref-args">' + args + '</div>' : '<div class="ref-args">no arguments</div>') + '</div>';
        });
      }
      html += '</div></div>';
    });
    box.innerHTML = html || '<div class="fineprint">No pallets match “' + esc(filter) + '”.</div>';
  }
  $('ref-search').addEventListener('input', function () { renderReference(this.value); });

  /* ---------- init ---------- */
  renderReference('');
  var m = CT.CALL_TABLE_META || {};
  var refHint = document.querySelector('#tab-ref .hint');
  if (refHint && m.rev) refHint.innerHTML += ' <span class="conv">(' + CT.PALLETS.length + ' pallets indexed)</span>';
})();
