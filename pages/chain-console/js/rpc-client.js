/* QTC Chain Console — Substrate WebSocket JSON-RPC client with subscriptions.
 * Browser + Node friendly: takes a WebSocket factory so tests and the QA
 * harness can inject a mock.
 */
import { buildRequest } from './core.js';

export class ConsoleRpc {
  constructor(url, { wsFactory = null, requestTimeoutMs = 20000, connectTimeoutMs = 15000 } = {}) {
    this.url = url;
    this.wsFactory = wsFactory || ((u) => new WebSocket(u));
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();        // id -> {resolve,reject,timer}
    this.subscriptions = new Map();  // subId -> {onData, method}
    this.onStatus = null;            // (status:'open'|'closed'|'error') => void
    this.onNotification = null;      // (subId, result) => void  (also routed per-subscription)
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === 1);
  }

  connect() {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) return this._ready();
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = this.wsFactory(this.url); }
      catch (e) { reject(new Error('could not reach ' + this.url)); return; }
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('connection timed out'));
      }, this.connectTimeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        this.ws = ws;
        this._wire(ws);
        this._emitStatus('open');
        resolve();
      };
      const onErr = () => {
        clearTimeout(timer);
        this._emitStatus('error');
        reject(new Error('could not reach ' + this.url));
      };
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onErr, { once: true });
      } else {
        ws.onopen = onOpen;
        ws.onerror = onErr;
      }
    });
  }

  _ready() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connection timed out')), this.connectTimeoutMs);
      const ws = this.ws;
      const done = (ok) => {
        clearTimeout(t);
        ok ? resolve() : reject(new Error('connection closed'));
      };
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', () => done(true), { once: true });
        ws.addEventListener('close', () => done(false), { once: true });
      } else {
        ws.onopen = () => done(true);
        ws.onclose = () => done(false);
      }
    });
  }

  _wire(ws) {
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.data); }
      catch { return; }
      // Subscription notification: { jsonrpc, method, params: { subscription, result } }
      if (msg.method && msg.params && msg.params.subscription !== undefined) {
        const sub = this.subscriptions.get(msg.params.subscription);
        if (sub && sub.onData) { try { sub.onData(msg.params.result); } catch {} }
        if (this.onNotification) { try { this.onNotification(msg.params.subscription, msg.params.result); } catch {} }
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    const onClose = () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('connection closed'));
      }
      this.pending.clear();
      this.subscriptions.clear();
      this.ws = null;
      this._emitStatus('closed');
    };
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', (ev) => onMessage(ev.data));
      ws.addEventListener('close', onClose, { once: true });
    } else {
      ws.onmessage = (ev) => onMessage(ev.data);
      ws.onclose = onClose;
    }
  }

  _emitStatus(s) { if (this.onStatus) { try { this.onStatus(s); } catch {} } }

  async call(method, params = []) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(buildRequest(method, params, id));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /* Subscribe: resolves with the subscription id; notifications flow to onData. */
  async subscribe(subscribeMethod, params, onData) {
    const subId = await this.call(subscribeMethod, params);
    if (typeof subId !== 'string') throw new Error(`expected a subscription id string from ${subscribeMethod}`);
    this.subscriptions.set(subId, { onData, method: subscribeMethod });
    return subId;
  }

  async unsubscribe(unsubscribeMethod, subId) {
    try { await this.call(unsubscribeMethod, [subId]); } catch {}
    this.subscriptions.delete(subId);
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }
}
