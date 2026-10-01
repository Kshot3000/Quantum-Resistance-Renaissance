'use strict';
/* QTC SCALE Lab — UI controller. All codec work is local (window.QSL_CODEC,
 * window.QSL_CRYPTO, window.QSL_TWOX). No network calls anywhere. */
(function () {
  var CC = window.QSL_CODEC, CR = window.QSL_CRYPTO, TX = window.QSL_TWOX;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var box = document.querySelector('.qsl-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'qsl-toasts'; document.body.appendChild(box); }
    var t = document.createElement('div'); t.className = 'qsl-toast'; t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 450); }, 2200);
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-copy]');
    if (!b) return;
    var txt = b.getAttribute('data-copy');
    function done() { toast('Copied to clipboard'); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, done);
    else done();
  });

  /* ---------- tabs ---------- */
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabBtns.forEach(function (x) { x.classList.remove('active'); });
      btn.classList.add('active');
      Array.prototype.forEach.call(document.querySelectorAll('.tabpane'), function (p) { p.classList.remove('active'); });
      $('pane-' + btn.getAttribute('data-tab')).classList.add('active');
    });
  });

  /* ---------- byte map ---------- */
  var PALETTE = ['#4ade80', '#7cc4ff', '#fbbf24', '#f472b6', '#a78bfa', '#34d399', '#fb923c', '#22d3ee'];
  function renderByteMap(mapEl, legendEl, bytes, spans) {
    mapEl.innerHTML = ''; if (legendEl) legendEl.innerHTML = '';
    if (!bytes || !bytes.length) return;
    var colorOf = {};
    (spans || []).forEach(function (sp, i) { if (!(sp.label in colorOf)) colorOf[sp.label] = PALETTE[i % PALETTE.length]; });
    bytes.forEach(function (b, i) {
      var cell = document.createElement('span');
      cell.className = 'byte';
      var owners = (spans || []).filter(function (sp) { return i >= sp.start && i < sp.end; });
      cell.innerHTML = ('0' + b.toString(16)).slice(-2) + '<span class="idx">' + i + '</span>';
      if (owners.length) cell.style.borderLeft = '3px solid ' + (colorOf[owners[0].label] || '#4ade80');
      cell.addEventListener('click', function () {
        Array.prototype.forEach.call(mapEl.children, function (x) { x.classList.remove('sel'); });
        cell.classList.add('sel');
        legendEl.innerHTML = owners.length
          ? owners.map(function (o) { return '<span class="sw" style="background:' + colorOf[o.label] + '"></span>byte ' + i + ' → ' + esc(o.label); }).join('<br>')
          : 'byte ' + i + ' → (no field owns this byte)';
      });
      mapEl.appendChild(cell);
    });
    var seen = {};
    if (legendEl) {
      var items = (spans || []).filter(function (sp) { if (seen[sp.label]) return false; seen[sp.label] = 1; return true; });
      legendEl.innerHTML = items.map(function (sp) {
        return '<span class="sw" style="background:' + colorOf[sp.label] + '"></span>' + esc(sp.label) +
               ' <span style="color:var(--faint)">[' + sp.start + '–' + sp.end + ')</span>';
      }).join(' &nbsp; ');
    }
  }

  function parseIntBig(s) {
    s = String(s).trim();
    if (!s) throw new Error('empty integer');
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (/^-?[0-9]+$/.test(s)) return BigInt(s);
    throw new Error('not an integer: ' + s);
  }
  function verdict(el, kind, title, sub) {
    el.className = 'verdict show ' + kind;
    el.querySelector('.v-title').textContent = title;
    el.querySelector('.v-sub').textContent = sub || '';
  }

  /* ================= COMPACT LAB ================= */
  $('ce-go').addEventListener('click', function () {
    try {
      var v = parseIntBig($('ce-in').value);
      var bytes = CC.compactEncode(v);
      var d = CC.compactDecode(bytes, 0, true);
      var bits = v === 0n ? 1 : v.toString(2).length;
      $('ce-out').innerHTML =
        '<span class="k">hex</span> <span class="v">0x' + CC.hexOf(bytes) + '</span> ' +
        '<button class="chip" data-copy="0x' + CC.hexOf(bytes) + '">copy</button><br>' +
        '<span class="k">mode</span> <span class="b">' + d.modeName + '</span> <span class="k">· bytes</span> ' + bytes.length +
        ' <span class="k">· bits</span> ' + bits;
      renderByteMap($('ce-map'), $('ce-legend'), bytes,
        [{ start: 0, end: 1, label: 'mode tag (low 2 bits)' }, { start: 1, end: bytes.length, label: 'value bits (LE)' }].filter(function (s) { return s.end > s.start; }));
    } catch (e) { $('ce-out').innerHTML = '<span class="e">Error: ' + esc(e.message) + '</span>'; $('ce-map').innerHTML = ''; $('ce-legend').innerHTML = ''; }
  });
  $('ce-max').addEventListener('click', function () {
    $('ce-in').value = ((1n << 128n) - 1n).toString();
    $('ce-go').click();
  });
  function decodeCompactUI() {
    var bytes = CC.fromHex($('cd-in').value);
    if (!bytes) { $('cd-out').innerHTML = '<span class="e">Error: not valid hex</span>'; return; }
    var strict = $('cd-strict').checked;
    try {
      var d = CC.compactDecode(bytes, 0, strict);
      $('cd-out').innerHTML =
        '<span class="k">value</span> <span class="v">' + d.value.toString() + '</span><br>' +
        '<span class="k">mode</span> <span class="b">' + d.modeName + '</span> <span class="k">· consumed</span> ' + d.bytesRead + ' of ' + bytes.length + ' bytes' +
        (bytes.length > d.bytesRead ? ' <span class="w">· ' + (bytes.length - d.bytesRead) + ' trailing byte(s) ignored</span>' : '');
      renderByteMap($('cd-map'), null, bytes.slice(0, d.bytesRead),
        [{ start: 0, end: 1, label: 'mode tag (low 2 bits)' }, { start: 1, end: d.bytesRead, label: 'value bits (LE)' }].filter(function (s) { return s.end > s.start; }));
      if (d.canonical) verdict($('cd-verdict'), 'ok', 'CANONICAL ✓', 'This is the single valid encoding of ' + d.value.toString() + '.');
      else verdict($('cd-verdict'), 'warnv', 'NON-CANONICAL ⚠',
        (strict ? 'Strict mode would reject this — shown for diagnosis. ' : '') + 'Canonical form: ' + d.canonicalHex);
      if (strict && !d.canonical) { /* unreachable: strict throws */ }
    } catch (e) {
      $('cd-out').innerHTML = '<span class="e">Decode failed</span>';
      verdict($('cd-verdict'), /non-canonical/.test(e.message) ? 'warnv' : 'bad',
        /non-canonical/.test(e.message) ? 'REJECTED — NON-CANONICAL ⚠' : 'REJECTED ✗', e.message);
    }
  }
  $('cd-go').addEventListener('click', decodeCompactUI);
  $('cd-strict').addEventListener('change', decodeCompactUI);
  Array.prototype.forEach.call(document.querySelectorAll('#notorious .chip'), function (chip) {
    chip.addEventListener('click', function () {
      document.querySelector('[data-tab="compact"]').click();
      $('cd-in').value = chip.getAttribute('data-hex');
      decodeCompactUI();
    });
  });

  /* ================= TYPE WORKBENCH ================= */
  var TYPES = [
    ['bool', 'bool'], ['u8', 'u8'], ['u16', 'u16'], ['u32', 'u32'], ['u64', 'u64'], ['u128', 'u128'],
    ['i8', 'i8'], ['i16', 'i16'], ['i32', 'i32'], ['i64', 'i64'], ['i128', 'i128'],
    ['compact', 'Compact'], ['balance', 'Balance (u128 plancks)'], ['str', 'String (UTF-8)'],
    ['bytes', 'Bytes (hex)'], ['accountid', 'AccountId32 (hex)'],
    ['option_u8', 'Option<u8>'], ['vec_u8', 'Vec<u8> (hex)']
  ];
  function shapeOf(t) {
    if (t === 'option_u8') return { k: 'option', inner: { k: 'u8' } };
    if (t === 'vec_u8') return { k: 'vec', inner: { k: 'u8' } };
    if (t === 'balance') return { k: 'balance' };
    return { k: t };
  }
  function parseValue(t, s) {
    s = String(s).trim();
    if (['u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128', 'compact', 'balance'].indexOf(t) >= 0) {
      if (s === '') throw new Error('empty integer');
      return parseIntBig(s);
    }
    if (t === 'bool') {
      if (/^(true|1)$/i.test(s)) return true;
      if (/^(false|0)$/i.test(s)) return false;
      throw new Error('bool needs true/false');
    }
    if (t === 'str') return s;
    if (t === 'bytes' || t === 'accountid' || t === 'vec_u8') {
      var b = CC.fromHex(s);
      if (!b) throw new Error('not valid hex');
      return b;
    }
    if (t === 'option_u8') {
      if (s === '' || /^none$/i.test(s)) return null;
      var n = Number(s);
      if (!/^\d+$/.test(s) || n > 255) throw new Error('Option<u8> needs 0–255 or empty');
      return n;
    }
    throw new Error('unknown type');
  }
  function schemaRows() {
    return Array.prototype.map.call(document.querySelectorAll('#tb-rows .schema-row'), function (row) {
      return {
        name: row.querySelector('.f-name').value.trim() || 'field',
        type: row.querySelector('.f-type').value
      };
    });
  }
  function addSchemaRow(name, type) {
    var div = document.createElement('div');
    div.className = 'schema-row';
    var nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'f-name'; nameIn.value = name || 'field'; nameIn.style.maxWidth = '180px';
    var sel = document.createElement('select');
    sel.className = 'f-type'; sel.style.maxWidth = '260px';
    TYPES.forEach(function (tp) {
      var o = document.createElement('option'); o.value = tp[0]; o.textContent = tp[1];
      if (tp[0] === type) o.selected = true;
      sel.appendChild(o);
    });
    var rm = document.createElement('button');
    rm.className = 'btn ghost rm'; rm.textContent = '✕';
    rm.addEventListener('click', function () { div.remove(); renderValueInputs(); });
    div.appendChild(nameIn); div.appendChild(sel); div.appendChild(rm);
    $('tb-rows').appendChild(div);
    nameIn.addEventListener('input', renderValueInputs);
    sel.addEventListener('change', renderValueInputs);
    renderValueInputs();
  }
  function renderValueInputs() {
    var box = $('tb-values'); box.innerHTML = '';
    schemaRows().forEach(function (f) {
      var lab = document.createElement('label');
      lab.className = 'f'; lab.textContent = f.name + ' : ' + f.type;
      var inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'v-in'; inp.setAttribute('data-type', f.type);
      inp.spellcheck = false; inp.autocomplete = 'off';
      if (f.type === 'balance') inp.placeholder = 'plancks, e.g. 1500000000000 (= 1.5 QTC)';
      if (f.type === 'accountid') inp.placeholder = '64 hex chars';
      box.appendChild(lab); box.appendChild(inp);
    });
  }
  function currentSchema() {
    var rows = schemaRows();
    if (!rows.length) throw new Error('add at least one field');
    return { k: 'struct', fields: rows.map(function (f) { return { name: f.name, shape: shapeOf(f.type) }; }) };
  }
  $('tb-add').addEventListener('click', function () { addSchemaRow('field' + ($('tb-rows').children.length + 1), 'u8'); });
  $('tb-clear').addEventListener('click', function () { $('tb-rows').innerHTML = ''; renderValueInputs(); });
  $('tb-preset-transfer').addEventListener('click', function () {
    $('tb-rows').innerHTML = ''; renderValueInputs();
    addSchemaRow('dest', 'accountid'); addSchemaRow('value', 'balance');
  });
  $('tb-preset-vec').addEventListener('click', function () {
    $('tb-rows').innerHTML = ''; renderValueInputs();
    addSchemaRow('data', 'vec_u8');
  });
  $('tb-preset-opt').addEventListener('click', function () {
    $('tb-rows').innerHTML = ''; renderValueInputs();
    addSchemaRow('maybe_amount', 'option_u8');
  });
  $('tb-encode').addEventListener('click', function () {
    try {
      var schema = currentSchema();
      var rows = schemaRows();
      var inputs = document.querySelectorAll('#tb-values .v-in');
      var value = {};
      rows.forEach(function (f, i) { value[f.name] = parseValue(f.type, inputs[i].value); });
      var e = CC.encode(schema, value);
      $('tb-enc-out').innerHTML =
        '<span class="k">hex</span> <span class="v">0x' + CC.hexOf(e.bytes) + '</span> ' +
        '<button class="chip" data-copy="0x' + CC.hexOf(e.bytes) + '">copy</button><br>' +
        '<span class="k">bytes</span> ' + e.bytes.length + ' <span class="k">· fields</span> ' + rows.length;
      renderByteMap($('tb-enc-map'), $('tb-enc-legend'), e.bytes, e.spans);
      $('tb-dec-in').value = '0x' + CC.hexOf(e.bytes);
    } catch (err) {
      $('tb-enc-out').innerHTML = '<span class="e">Encode failed: ' + esc(err.message) + '</span>';
    }
  });
  $('tb-decode').addEventListener('click', function () {
    try {
      var schema = currentSchema();
      var bytes = CC.fromHex($('tb-dec-in').value);
      if (!bytes) throw new Error('not valid hex');
      var strict = $('tb-strict').checked;
      var d = CC.decode(schema, bytes, strict);
      var rows = schemaRows();
      var lines = rows.map(function (f) {
        var v = d.value[f.name];
        var extra = (f.type === 'balance') ? ' <span class="b">(' + CC.qtcOf(v) + ')</span>' : '';
        return '<span class="k">' + esc(f.name) + '</span> = <span class="v">' + esc(CC.prettyValue(v)) + '</span>' + extra;
      });
      $('tb-dec-out').innerHTML = lines.join('<br>') +
        (d.trailing ? '<br><span class="w">' + d.trailing + ' trailing byte(s) after struct</span>' : '');
      renderByteMap($('tb-dec-map'), $('tb-dec-legend'), bytes, d.spans);
    } catch (err) {
      $('tb-dec-out').innerHTML = '<span class="e">Decode failed: ' + esc(err.message) + '</span>';
    }
  });
  addSchemaRow('dest', 'accountid');
  addSchemaRow('value', 'balance');

  /* ================= ADDRESS CODER ================= */
  $('ad-enc-go').addEventListener('click', function () {
    try {
      var pub = CC.fromHex($('ad-pub').value);
      if (!pub || pub.length !== 32) throw new Error('need exactly 32 bytes (64 hex chars), got ' + (pub ? pub.length : 0));
      var addr = CR.ss58Encode(pub, CR.QUANTUS_PREFIX);
      $('ad-enc-out').innerHTML =
        '<span class="k">SS58 (prefix 189)</span><br><span class="v" style="font-size:15px">' + esc(addr) + '</span> ' +
        '<button class="chip" data-copy="' + esc(addr) + '">copy</button>';
      $('ad-enc-diagram').innerHTML =
        '<span class="seg b">6f 40<span style="display:block;font-size:10px">prefix 189</span></span><span class="op">‖</span>' +
        '<span class="seg g">' + esc(CC.hexOf(pub).slice(0, 16)) + '…<span style="display:block;font-size:10px">32-byte pubkey</span></span><span class="op">‖</span>' +
        '<span class="seg a">' + esc(CC.hexOf(CR.blake2b([0x6f, 0x40].concat(pub), 64)).slice(0, 4)) + '<span style="display:block;font-size:10px">blake2b checksum</span></span>' +
        '<div style="margin-top:6px">base58 → <span style="color:var(--grn)">' + esc(addr) + '</span></div>';
    } catch (e) { $('ad-enc-out').innerHTML = '<span class="e">Error: ' + esc(e.message) + '</span>'; $('ad-enc-diagram').innerHTML = ''; }
  });
  $('ad-dec-go').addEventListener('click', function () {
    var addr = $('ad-addr').value.trim();
    var d = CR.ss58Decode(addr);
    if (!d.ok) {
      $('ad-dec-out').innerHTML = '<span class="e">Invalid address</span>';
      verdict($('ad-verdict'), 'bad', 'INVALID ✗', d.error);
      return;
    }
    var prefixNote = d.prefix === 189 ? 'Quantus (189) ✓' : 'NOT Quantus — prefix ' + d.prefix + ' ⚠';
    $('ad-dec-out').innerHTML =
      '<span class="k">prefix</span> <span class="' + (d.prefix === 189 ? 'v' : 'w') + '">' + d.prefix + '</span> <span class="k">(' + esc(prefixNote) + ')</span><br>' +
      '<span class="k">key bytes</span> <span class="v">' + d.key.length + '</span>' + (d.key.length === 32 ? '' : ' <span class="w">⚠ expected 32</span>') + '<br>' +
      '<span class="k">pubkey hex</span> <span class="b">0x' + CC.hexOf(d.key) + '</span>';
    if (d.prefix === 189 && d.key.length === 32) verdict($('ad-verdict'), 'ok', 'VALID ✓', 'Checksum verifies. Canonical re-encode: ' + CR.ss58Encode(d.key, 189));
    else verdict($('ad-verdict'), 'warnv', 'CHECKSUM OK, PREFIX/KEY UNUSUAL ⚠', 'The checksum is valid, but this is not a standard Quantus AccountId32 address.');
  });

  /* ================= STORAGE KEYS ================= */
  $('sk-go').addEventListener('click', function () {
    try {
      var pallet = $('sk-pallet').value.trim(), item = $('sk-item').value.trim();
      if (!pallet || !item) throw new Error('pallet and item are required');
      var key = TX.storageKeyPlain(pallet, item);
      $('sk-out').innerHTML =
        '<span class="k">key</span> <span class="v">0x' + CC.hexOf(key) + '</span> ' +
        '<button class="chip" data-copy="0x' + CC.hexOf(key) + '">copy</button>';
      $('sk-diagram').innerHTML =
        '<span class="seg g">' + esc(CC.hexOf(key).slice(0, 32)) + '<span style="display:block;font-size:10px">twox_128("' + esc(pallet) + '")</span></span><span class="op">‖</span>' +
        '<span class="seg b">' + esc(CC.hexOf(key).slice(32)) + '<span style="display:block;font-size:10px">twox_128("' + esc(item) + '")</span></span>';
    } catch (e) { $('sk-out').innerHTML = '<span class="e">Error: ' + esc(e.message) + '</span>'; $('sk-diagram').innerHTML = ''; }
  });
  $('skm-go').addEventListener('click', function () {
    try {
      var pallet = $('sk-pallet').value.trim(), item = $('sk-item').value.trim();
      var kb = CC.fromHex($('skm-key').value);
      if (!pallet || !item) throw new Error('set pallet + item on the left card first');
      if (!kb || !kb.length) throw new Error('map key bytes required (hex)');
      var hasher = $('skm-hasher').value;
      var key = TX.storageKeyMap(pallet, item, kb, hasher);
      var hname = { blake2_128concat: 'Blake2_128Concat', twox64concat: 'Twox64Concat', identity: 'Identity' }[hasher];
      $('skm-out').innerHTML =
        '<span class="k">key (' + key.length + ' bytes)</span> <span class="v">0x' + CC.hexOf(key) + '</span> ' +
        '<button class="chip" data-copy="0x' + CC.hexOf(key) + '">copy</button><br>' +
        '<span class="k">layout</span> <span class="b">32B plain</span> <span class="k">‖</span> <span class="b">' + hname + '(' + kb.length + 'B key)</span>';
    } catch (e) { $('skm-out').innerHTML = '<span class="e">Error: ' + esc(e.message) + '</span>'; }
  });

  /* ================= VECTOR VAULT ================= */
  var VECTORS = [
    ['compact(0)', function () { return CC.hexOf(CC.compactEncode(0n)); }, '00'],
    ['compact(42)', function () { return CC.hexOf(CC.compactEncode(42n)); }, 'a8'],
    ['compact(64)', function () { return CC.hexOf(CC.compactEncode(64n)); }, '0101'],
    ['compact(16383)', function () { return CC.hexOf(CC.compactEncode(16383n)); }, 'fdff'],
    ['compact(16384)', function () { return CC.hexOf(CC.compactEncode(16384n)); }, '02000100'],
    ['compact(2³⁰−1)', function () { return CC.hexOf(CC.compactEncode(1073741823n)); }, 'feffffff'],
    ['compact(2³⁰)', function () { return CC.hexOf(CC.compactEncode(1073741824n)); }, '0300000040'],
    ['compact(2⁶⁴−1)', function () { return CC.hexOf(CC.compactEncode((1n << 64n) - 1n)); }, '13ffffffffffffffff'],
    ['u16 0x1234', function () { return CC.hexOf(CC.intEncode('u16', 0x1234)); }, '3412'],
    ['i8 −1', function () { return CC.hexOf(CC.intEncode('i8', -1)); }, 'ff'],
    ['bool true', function () { return CC.hexOf(CC.encode({ k: 'bool' }, true).bytes); }, '01'],
    ['Option<u8>::None', function () { return CC.hexOf(CC.encode({ k: 'option', inner: { k: 'u8' } }, null).bytes); }, '00'],
    ['Option<u8>::Some(42)', function () { return CC.hexOf(CC.encode({ k: 'option', inner: { k: 'u8' } }, 42).bytes); }, '012a'],
    ['Vec<u8> [1,2,3]', function () { return CC.hexOf(CC.encode({ k: 'vec', inner: { k: 'u8' } }, [1, 2, 3]).bytes); }, '0c010203'],
    ['String "hello"', function () { return CC.hexOf(CC.encode({ k: 'str' }, 'hello').bytes); }, '1468656c6c6f'],
    ['tuple (3, true)', function () { return CC.hexOf(CC.encode({ k: 'tuple', items: [{ k: 'u8' }, { k: 'bool' }] }, [3, true]).bytes); }, '0301'],
    ['1 QTC in plancks', function () { return CC.hexOf(CC.encode({ k: 'balance' }, 1000000000000n).bytes); }, '0010a5d4e8' + '00'.repeat(11)],
    ['twox_128("System")', function () {
      var te = new TextEncoder();
      return TX.twox128hex(Array.prototype.slice.call(te.encode('System')));
    }, '26aa394eea5630e07c48ae0c9558cef7'],
    ['SS58 round-trip (prefix 189)', function () {
      var key = []; for (var i = 0; i < 32; i++) key.push(i);
      var addr = CR.ss58Encode(key, 189);
      var d = CR.ss58Decode(addr);
      return (d.ok && d.prefix === 189 && CC.hexOf(d.key) === CC.hexOf(key)) ? 'round-trip-ok' : 'BROKEN';
    }, 'round-trip-ok'],
    ['strict rejects bloated mode-2', function () {
      try { CC.compactDecode(CC.fromHex('92010000'), 0, true); return 'NOT-REJECTED'; }
      catch (e) { return /non-canonical/.test(e.message) ? 'rejected' : 'WRONG-ERROR'; }
    }, 'rejected']
  ];
  var vvTable = $('vv-table');
  VECTORS.forEach(function (vc, i) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td class="vv-res" style="font-size:16px;color:var(--faint)">○</td><td>' + esc(vc[0]) + '</td><td class="hex">0x' + esc(vc[2]) + '</td>';
    tr.id = 'vv-' + i;
    vvTable.appendChild(tr);
  });
  $('vv-run').addEventListener('click', function () {
    var ok = 0;
    VECTORS.forEach(function (vc, i) {
      var cell = document.querySelector('#vv-' + i + ' .vv-res');
      try {
        var got = vc[1]();
        if (got === vc[2]) { cell.textContent = '✓'; cell.style.color = 'var(--grn)'; ok++; }
        else { cell.textContent = '✗'; cell.style.color = 'var(--red)'; cell.title = 'got ' + got; }
      } catch (e) { cell.textContent = '✗'; cell.style.color = 'var(--red)'; cell.title = e.message; }
    });
    $('vv-summary').textContent = ok + '/' + VECTORS.length + ' vectors green';
    $('vv-summary').style.color = ok === VECTORS.length ? 'var(--grn)' : 'var(--red)';
  });

  /* auto-run the compact encode demo once so the first tab isn't empty */
  $('ce-go').click();
})();
