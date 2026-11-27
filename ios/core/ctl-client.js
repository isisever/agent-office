// The phone side of the v3.121 controller protocol: pair from a scanned QR URL, then read ctl-view / ctl-event and
// send ctl-hq. Runs in the Bare worklet (crypto-shim, bare hyperswarm) and in Node (dev-run.mjs, app/test). The wire
// and pairing code is app/src/link-wire.js itself: one implementation for the desktop and the phone.
'use strict';
const W = require('../../app/src/link-wire.js');

class CtlClient {
  /**
   * @param {{ Hyperswarm: any, crypto: any, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array }, name?: string,
   *   bootstrap?: any[], paired?: { pub: string, secret: string, name: string } | null, onEvent?: (e: any) => void }} o
   */
  constructor(o) {
    this.o = o;
    this.wire = W.createWire(o.crypto);
    this.pub = W.hex(o.keyPair.publicKey);
    this.name = W.deviceName(o.name, 'iPhone');
    this.paired = o.paired || null;   // { pub, secret, name }: the desktop this phone controls
    this.conn = null;
    this.view = null;
    this.onEvent = o.onEvent || (() => {});
    this.swarm = new o.Hyperswarm({ keyPair: o.keyPair, ...(o.bootstrap ? { bootstrap: o.bootstrap } : {}),
      // only the desktop named by the QR (pairing) or the paired one may connect
      firewall: (remote) => W.hex(remote) !== (this.pairing?.pub || this.paired?.pub) });
    this.swarm.on('connection', (conn) => this.onConnection(conn));
    this.pairing = null;
    this.hqWaits = new Map();
  }
  write(m) { const line = W.encode(m); if (line && this.conn && !this.conn.destroyed) this.conn.write(line); }

  /** Pairs from a scanned `agentoffice://pair?...` URL. Resolves with { pub, secret, name } (store it sealed). */
  pair(url, { ttlMs = W.PAIR_TTL_MS } = {}) {
    const q = W.parsePairUrl(url);
    if (!q) return Promise.reject(new Error('bad-url'));
    this.cancelPair('cancelled');   // a second scan replaces the first
    const { topic, key } = this.wire.pairSecrets(q.code);
    return new Promise((resolve, reject) => {
      const p = { ...q, key, topic, retry: null, timer: null, resolve: (v) => { this.endPair(p); resolve(v); }, reject: (e) => { this.endPair(p); reject(e); } };
      p.timer = setTimeout(() => p.reject(new Error('expired')), ttlMs);
      this.pairing = p;
      const d = this.swarm.join(topic, { server: false, client: true });
      p.retry = setInterval(() => d.refresh().catch(() => {}), 3000);
    });
  }
  /** Stops a pairing attempt: no retry left, the code's topic left. */
  endPair(p) {
    clearTimeout(p.timer);
    clearInterval(p.retry);
    if (this.pairing === p) this.pairing = null;
    this.swarm.leave(p.topic).catch(() => {});
  }
  /** Rejects the pairing in progress, if any (reason: its error message). */
  cancelPair(reason = 'cancelled') { if (this.pairing) this.pairing.reject(new Error(reason)); }
  /** Reconnects to the paired desktop (its pair topic). */
  connect() { if (this.paired) this.swarm.join(this.wire.pairTopic(this.paired.secret), { server: true, client: true }); }

  onConnection(conn) {
    conn.on('error', () => {});
    const remote = W.hex(conn.remotePublicKey);
    const p = this.pairing;
    let paired = this.paired && this.paired.pub === remote && !p;
    const r = new W.LineReader((raw) => {
      if (paired) return this.handle(raw);
      const m = W.validatePair(raw);
      if (!m || !p || this.pairing !== p || m.kind !== 'controller') return conn.destroy();
      const bad = () => { conn.destroy(); p.reject(new Error('bad-proof')); };   // a wrong proof: this code is not that desktop's
      if (m.t === 'pair-hello') {
        if (!this.wire.proofOk(p.key, 'inviter', remote, this.pub, m.proof)) return bad();
        // scanning the QR is this person's yes: prove the code at once
        this.conn = conn;
        this.write({ t: 'pair-hello', name: this.name, proof: this.wire.pairProof(p.key, 'joiner', this.pub, remote), kind: 'controller' });
      } else if (m.t === 'pair-ok') {
        if (!this.wire.proofOk(p.key, 'ok', remote, this.pub, m.proof)) return bad();
        this.paired = { pub: remote, secret: m.secret, name: m.name };
        this.swarm.join(this.wire.pairTopic(m.secret), { server: true, client: true });
        paired = true;
        this.session(conn);
        p.resolve(this.paired);
      }
    });
    conn.on('data', (chunk) => { if (!r.push(chunk)) conn.destroy(); });
    if (paired) this.session(conn);
  }
  session(conn) {
    if (this.conn && this.conn !== conn) this.conn.destroy();
    this.conn = conn;
    this.write({ t: 'hello', v: 2, name: this.name, caps: W.CTL_CAPS });   // 'sess': it reads the HQ session
    const beat = setInterval(() => this.write({ t: 'ping' }), 5000);
    conn.on('close', () => { clearInterval(beat); if (this.conn === conn) this.conn = null; this.onEvent({ t: 'offline' }); });
    this.onEvent({ t: 'online' });
  }
  handle(raw) {
    if (raw?.t === 'sess-items' || raw?.t === 'sess-end') return this.onEvent(raw);   // the HQ session (hqSession)
    const m = W.validateCtl(raw);
    if (!m) return;   // ping and hello are not used here
    if (m.t === 'ctl-view') this.view = m.view;
    if (m.t === 'ctl-hq-status' || m.t === 'ctl-reports') { const w = this.hqWaits.get(m.id); if (w) { this.hqWaits.delete(m.id); w(m); } }
    this.onEvent(m);
  }
  /** Types one HQ turn on the desktop → the ctl-hq-status answer. */
  hq(text, id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`) {
    return new Promise((resolve) => { this.hqWaits.set(id, resolve); this.write({ t: 'ctl-hq', id, text }); });
  }
  reports(limit = 20, id = `r${Date.now().toString(36)}`) {
    return new Promise((resolve) => { this.hqWaits.set(id, resolve); this.write({ t: 'ctl-reports', id, limit }); });
  }
  /** Reads the HQ session: sess-items / sess-end arrive as events. keep() every minute or so; close() ends it. */
  hqSession(id = `s${Date.now().toString(36)}`) {
    this.write({ t: 'sess-open', id, project: 'hq' });
    return { id, keep: () => this.write({ t: 'sess-keep', id }), close: () => this.write({ t: 'sess-close', id }) };
  }
  destroy() { this.cancelPair('destroyed'); return this.swarm.destroy(); }
}

module.exports = { CtlClient };
