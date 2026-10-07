/* QTC Chain Console — logic tests. Run: node tests/run-tests.mjs */
import {
  validateEndpoint, buildRequest, parseParamsJson, explainError,
  isHex, normalizeHex, shortHex, formatMs,
  parseAddressInput, accountStorageKeyHex, buildMapKeyHex, decodeBalanceStorage,
  summarizeHeader, summarizeBlock, summarizePeers, summarizeHealth, summarizeRuntimeVersion,
  RECIPE_BUILDERS, historyEntry, loadHistory, saveHistory, formatPartialFeeQtc,
} from '../js/core.js';
import { ConsoleRpc } from '../js/rpc-client.js';
import { ss58Encode, hexEncode } from '../js/lib/quantus-crypto.js';
import { RECIPES } from '../js/recipes.js';
import { allMethods } from '../js/methods.js';

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

/* deterministic test address: 32 bytes 0x01.., prefix 189 */
const ACCT = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
const ADDR = ss58Encode(ACCT, 189);
const ADDR42 = ss58Encode(ACCT, 42);

/* ---- endpoints ---- */
t('endpoint: wss ok', validateEndpoint('wss://rpc.quantus.network').ok);
t('endpoint: ws ok', validateEndpoint('ws://127.0.0.1:9944').ok);
t('endpoint: http rejected', !validateEndpoint('https://example.com').ok);
t('endpoint: empty rejected', !validateEndpoint('').ok);
t('endpoint: garbage rejected', !validateEndpoint('not a url').ok);

/* ---- request building ---- */
{
  const r = JSON.parse(buildRequest('system_chain', [], 7));
  t('request: envelope', r.jsonrpc === '2.0' && r.id === 7 && r.method === 'system_chain' && Array.isArray(r.params));
}
{
  const p = parseParamsJson('["0xabc", 1]');
  t('params: valid', p.ok && p.params.length === 2);
  t('params: empty -> []', parseParamsJson('').ok && parseParamsJson('  ').params.length === 0);
  t('params: non-array rejected', !parseParamsJson('{"a":1}').ok);
  t('params: bad json rejected', !parseParamsJson('[1,').ok);
}

/* ---- error explainer ---- */
t('explain: timeout', explainError(new Error('RPC x timed out')).title === 'Request timed out');
t('explain: unreachable', explainError(new Error('could not reach wss://x')).title === 'Could not reach the endpoint');
t('explain: -32601', explainError(new Error('{-32601: Method not found}')).title === 'Method not found');
t('explain: -32602', explainError(new Error('code -32602 bad')).title === 'Invalid params');
t('explain: fallback', explainError(new Error('weird')).title === 'Call failed');

/* ---- hex helpers ---- */
t('isHex', isHex('0xab12') && !isHex('xyz') && !isHex('ab12'));
t('normalizeHex adds 0x', normalizeHex('AB12') === '0xab12');
t('shortHex folds', shortHex('0x' + 'ab'.repeat(40), 8).includes('…'));
t('shortHex keeps short', shortHex('0xab', 8) === '0xab');
t('formatMs', formatMs(500) === '500 ms' && formatMs(1500) === '1.50 s');

/* ---- addresses ---- */
{
  const p = parseAddressInput(ADDR);
  t('address: valid 189', p.ok && p.prefix === 189);
  t('address: wrong prefix rejected', !parseAddressInput(ADDR42).ok && /189/.test(parseAddressInput(ADDR42).error));
  t('address: garbage rejected', !parseAddressInput('hello').ok);
  t('address: empty rejected', !parseAddressInput('').ok);
}
{
  const k = accountStorageKeyHex(ADDR);
  // Canonical Substrate twox_128("System") — verified 2026-09-30 against
  // sp-crypto-hashing 0.1.0 (chain's sp-core 39.0.0), Quantus frame-support
  // hash.rs, and @polkadot/util-crypto.
  t('storage key: canonical prefix', k.ok && k.keyHex.startsWith('0x26aa394eea5630e07c48ae0c9558cef7'));
  t('storage key: 80 bytes', k.ok && k.keyHex.length === 2 + 160);
  t('storage key: bad addr', !accountStorageKeyHex('nope').ok);
}
{
  const k = buildMapKeyHex('System', 'Account', ADDR);
  t('map key: canonical prefix', k.ok && k.keyHex.startsWith('0x26aa394eea5630e07c48ae0c9558cef7'));
  t('map key: 80 bytes', k.ok && k.keyHex.length === 162);
  t('map key: bad pallet', !buildMapKeyHex('!!!', 'Account', ADDR).ok);
  t('map key: bad addr', !buildMapKeyHex('System', 'Account', 'nope').ok);
}

/* ---- balance decode: hand-built AccountInfo ---- */
{
  const buf = new ArrayBuffer(4 + 4 + 4 + 4 + 16 * 3 + 4);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, 5, true); o += 4;          // nonce
  dv.setUint32(o, 0, true); o += 4;          // consumers
  dv.setUint32(o, 1, true); o += 4;          // providers
  dv.setUint32(o, 0, true); o += 4;          // sufficients
  const u128 = (v) => { dv.setBigUint64(o, v & 0xffffffffffffffffn, true); dv.setBigUint64(o + 8, v >> 64n, true); o += 16; };
  u128(2n * 10n ** 12n); u128(0n); u128(5n * 10n ** 11n); // free 2 QTC, reserved 0, frozen 0.5 QTC
  dv.setUint32(o, 0, true);
  const hex = '0x' + hexEncode(new Uint8Array(buf));
  const d = decodeBalanceStorage(hex);
  t('balance: decode ok', d.ok && d.free === 2n * 10n ** 12n);
  t('balance: qtc strings', d.freeQtc === '2' && d.frozenQtc === '0.5');
  t('balance: total', d.totalQtc === '2.5');
  t('balance: bad hex', !decodeBalanceStorage('0xzz').ok);
  t('balance: truncated', !decodeBalanceStorage('0x0102').ok);
}

/* ---- summarizers ---- */
t('summarizeHeader', summarizeHeader({ number: 42, parentHash: '0x1', stateRoot: '0x2', extrinsicsRoot: '0x3' }).number === 42);
t('summarizeHeader null-safe', summarizeHeader(null) === null);
{
  const b = summarizeBlock({ header: { number: 7 }, extrinsics: ['0x' + 'aa'.repeat(10), '0x' + 'bb'.repeat(20)] });
  t('summarizeBlock', b.extrinsicCount === 2 && b.totalBytes === 30);
}
{
  const p = summarizePeers([{ peerId: 'Qm1', roles: 'FULL', bestNumber: 9, bestHash: '0xabc' }]);
  t('summarizePeers', p.length === 1 && p[0].bestNumber === 9);
}
t('summarizeHealth', summarizeHealth({ isSyncing: false, peers: 3, shouldHavePeers: true }).peers === 3);
t('summarizeRuntime', summarizeRuntimeVersion({ specName: 'quantus', specVersion: 100 }).specVersion === 100);

/* ---- recipe builders ---- */
{
  const b = RECIPE_BUILDERS['chain_getBlockHash'];
  t('recipe block#: ok', b({ number: '123' }).ok && b({ number: '123' }).params[0] === 123);
  t('recipe block#: bad', !b({ number: '-1' }).ok && !b({ number: 'x' }).ok);
}
{
  const b = RECIPE_BUILDERS['chain_getHeader'];
  t('recipe header: blank ok', b({ hash: '' }).params.length === 0);
  t('recipe header: hash ok', b({ hash: '0xab' }).params[0] === '0xab');
  t('recipe header: bad hex', !b({ hash: 'zzz' }).ok);
}
{
  const b = RECIPE_BUILDERS['system_accountNextIndex'];
  t('recipe nonce: ok', b({ address: ADDR }).ok);
  t('recipe nonce: bad addr', !b({ address: 'bad' }).ok);
}
{
  const b = RECIPE_BUILDERS['state_getStorage'];
  t('recipe storage: key only', b({ key: '0xab', atHash: '' }).params.length === 1);
  t('recipe storage: with hash', b({ key: '0xab', atHash: '0xcd' }).params.length === 2);
  t('recipe storage: bad key', !b({ key: 'zzz', atHash: '' }).ok);
}
{
  const b = RECIPE_BUILDERS['author_submitExtrinsic'];
  t('recipe submit: ok', b({ extrinsic: '0x' + 'ab'.repeat(100) }).ok);
  t('recipe submit: too short', !b({ extrinsic: '0xab' }).ok);
}
{
  const b = RECIPE_BUILDERS['balance'];
  const r = b({ address: ADDR });
  t('recipe balance: canonical key', r.ok && r.params[0].startsWith('0x26aa394eea5630e07c48ae0c9558cef7'));
  t('recipe balance: bad addr', !b({ address: 'bad' }).ok);
}

/* ---- recipes + methods catalogs ---- */
t('recipes: 17 entries', RECIPES.length === 17);
t('recipes: unique ids', new Set(RECIPES.map((r) => r.id)).size === RECIPES.length);
t('recipes: all have builders', RECIPES.every((r) => typeof r.build === 'function'));
t('recipes: gated broadcast', RECIPES.find((r) => r.id === 'submit').gated === true);
{
  const ms = allMethods();
  t('methods: >= 40', ms.length >= 40);
  t('methods: unique names', new Set(ms.map((m) => m.name)).size === ms.length);
  t('methods: recipe links valid', ms.filter((m) => m.recipe).every((m) => RECIPES.some((r) => r.id === m.recipe)));
}

/* ---- history ---- */
{
  const store = { d: {}, getItem(k) { return this.d[k] || null; }, setItem(k, v) { this.d[k] = v; } };
  const e = historyEntry('system_chain', [], 12.4, true);
  t('history entry', e.ok && e.ms === 12 && e.method === 'system_chain');
  saveHistory(store, [e]);
  const back = loadHistory(store);
  t('history round-trip', back.length === 1 && back[0].method === 'system_chain');
}
{
  // Re-run must be able to restore the EXACT params, not just the method:
  // before this fix historyEntry dropped params entirely, so the history
  // re-run button silently executed the method with whatever stale params
  // were sitting in the Custom tab's textarea.
  const store = { d: {}, getItem(k) { return this.d[k] || null; }, setItem(k, v) { this.d[k] = v; } };
  const params = ['0x26aa394eea5630e07c48ae0c9558cef7', 42];
  const e = historyEntry('state_getStorage', params, 9, true);
  t('history: params preserved', Array.isArray(e.params) && e.params.length === 2 && e.params[0] === params[0] && e.params[1] === 42);
  saveHistory(store, [e]);
  const back = loadHistory(store);
  t('history: params round-trip', back.length === 1 && JSON.stringify(back[0].params) === JSON.stringify(params));
  // Oversized params (multi-KB extrinsic blobs) must be marked non-rerunnable
  // (params === null), never stored truncated — truncated JSON would re-run wrong.
  const big = historyEntry('payment_queryInfo', ['0x' + 'ab'.repeat(6000)], 9, true);
  t('history: oversized params -> null', big.params === null);
  const exact = historyEntry('system_chain', [], 1, true);
  t('history: empty params rerunnable', Array.isArray(exact.params) && exact.params.length === 0);
}

/* ---- fee formatting (payment_queryInfo summarizer) ---- */
t('fee: zero is "0" not "0."', formatPartialFeeQtc('0') === '0');
t('fee: whole QTC is "1" not "1."', formatPartialFeeQtc('1000000000000') === '1');
t('fee: 2.5 QTC', formatPartialFeeQtc('2500000000000') === '2.5');
t('fee: sub-millli exact', formatPartialFeeQtc('1000000000') === '0.001');
t('fee: 1 planck exact', formatPartialFeeQtc('1') === '0.000000000001');
t('fee: numeric input', formatPartialFeeQtc(1500000000000) === '1.5');
t('fee: missing -> dash', formatPartialFeeQtc(null) === '—' && formatPartialFeeQtc(undefined) === '—' && formatPartialFeeQtc('') === '—');
t('fee: garbage -> dash', formatPartialFeeQtc('not-a-number') === '—');

/* ---- rpc-client with mock WebSocket ---- */
class MockWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.handlers = {}; this.sent = [];
    this.OPEN = 1;
  }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, data) { (this.handlers[ev] || []).forEach((f) => f(data)); }
  open() { this.readyState = 1; this.emit('open'); }
  send(s) {
    this.sent.push(s);
    const req = JSON.parse(s);
    setTimeout(() => {
      if (req.method === 'nope') {
        this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }) });
      } else if (req.method === 'sub_newHeads') {
        const subId = 'sub-1';
        this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: subId }) });
        setTimeout(() => this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'chain_subscribeNewHeads', params: { subscription: subId, result: { number: '0x2a' } } }) }), 5);
      } else {
        this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 'ok-' + req.method }) });
      }
    }, 5);
  }
  close() { this.readyState = 3; this.emit('close'); }
}

const mocks = [];
const factory = (u) => { const m = new MockWS(u); mocks.push(m); setTimeout(() => m.open(), 5); return m; };

{
  const rpc = new ConsoleRpc('wss://x', { wsFactory: factory, requestTimeoutMs: 2000, connectTimeoutMs: 2000 });
  t('rpc: starts disconnected', !rpc.connected);
  await rpc.connect();
  t('rpc: connected', rpc.connected);
  const r = await rpc.call('system_chain');
  t('rpc: call round-trip', r === 'ok-system_chain');
  let err = null;
  try { await rpc.call('nope'); } catch (e) { err = e; }
  t('rpc: error propagates', err && /Method not found/.test(err.message));
  const seen = [];
  const subId = await rpc.subscribe('sub_newHeads', [], (n) => seen.push(n));
  t('rpc: subscribe id', subId === 'sub-1');
  await new Promise((r2) => setTimeout(r2, 30));
  t('rpc: notification routed', seen.length === 1 && seen[0].number === '0x2a');
  await rpc.unsubscribe('unsub', subId);
  t('rpc: unsubscribe clears', rpc.subscriptions.size === 0);
  rpc.close();
  t('rpc: closed', !rpc.connected);
}
{
  // connect failure: factory throws
  const rpc = new ConsoleRpc('wss://x', { wsFactory: () => { throw new Error('nope'); }, connectTimeoutMs: 500 });
  let err = null;
  try { await rpc.connect(); } catch (e) { err = e; }
  t('rpc: factory throw -> rejected', !!err);
}
{
  // timeout: never responds
  const hanging = (u) => { const m = new MockWS(u); setTimeout(() => m.open(), 5); const orig = m.send.bind(m); m.send = (s) => { m.sent.push(s); }; return m; };
  const rpc = new ConsoleRpc('wss://x', { wsFactory: hanging, requestTimeoutMs: 100, connectTimeoutMs: 1000 });
  await rpc.connect();
  let err = null;
  try { await rpc.call('system_chain'); } catch (e) { err = e; }
  t('rpc: call timeout', err && /timed out/.test(err.message));
  rpc.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
