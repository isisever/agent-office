// Device link (contract v3.28, v3.31/v3.32 capabilities and machine data): Hyperswarm networking between this user's Agent Offices. No Electron: main.js
// gives it the key pair, the trust list and callbacks; tests run two of these on a local DHT testnet.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('./link-core.js');

const OWED_MS = 4 * 3600 * 1000 + 30 * 60 * 1000;
// v3.48 dispatcher task records: an offline device's task waits in the outbox this long (then 'expired')
const OUTBOX_TTL_MS = 24 * 3600 * 1000;
const TASK_REC = ['held', 'sent', 'queued', 'delivered', 'running', 'needs-approval', 'unknown', 'reported', 'rejected', 'expired', 'lost'];
const TASK_DONE = new Set(['reported', 'rejected', 'expired', 'lost']);
const SEEN_OPEN = ['queued', 'delivered', 'running', 'needs-approval'];   // tasks-seen entries never evicted while young
const SEEN_PER_DEVICE = 200;

class Link extends EventEmitter {
  /**
   * @param {{ keyPair: { publicKey: Buffer, secretKey: Buffer }, name: string, devices?: C.Device[], secrets?: Record<string, string>,
   *   bootstrap?: any[], now?: () => number, swarmFactory?: (opts: any) => any, heartbeatMs?: number,
   *   handoffAskMs?: number, handoffIdleMs?: number, resultsFile?: string | null, reportsFile?: string | null, tasksFile?: string | null, seenFile?: string | null, outboxTtlMs?: number, app?: string, projOpMs?: number, loginTimeoutMs?: number, log?: (...a: any[]) => void }} o
   */
  constructor(o) {
    super();
    this.keyPair = o.keyPair;
    this.pub = C.hex(o.keyPair.publicKey);
    this.name = C.deviceName(o.name);
    this.devices = C.normalizeDevices(o.devices);
    this.secrets = { ...(o.secrets || {}) };
    this.bootstrap = o.bootstrap;
    this.now = o.now || Date.now;
    this.heartbeatMs = o.heartbeatMs || C.HEARTBEAT_MS;
    this.swarmFactory = o.swarmFactory || ((opts) => new (require('hyperswarm'))(opts));
    this.swarm = null;
    this.conns = new Map();      // device pub → conn (trusted sessions)
    this.remotes = new Map();    // device pub → { snap, at }
    this.pairing = null;         // { role, code, key, topic, expiresAt, timer, resolve?, reject? }
    this.limiter = new C.RateLimiter({ now: this.now });
    this.outgoing = [];          // commands this device sent: { id, pub, project, projectName, firstLine, status, reason?, at }
    this.snap = null;            // what we publish
    this.snapJson = '';
    this.sentJson = new Map();   // pub → last snapshot json sent to it
    this.seq = 0;
    this.pubTimer = null;
    this.lastPub = 0;
    this.handoffsOut = new Map(); // v3.29 projects this device hands off: id → record
    this.handoffsIn = new Map();  // projects offered to this device: id → record
    this.handoffAskMs = o.handoffAskMs || 10 * 60 * 1000;   // an offer nobody answers is dropped after this
    this.handoffIdleMs = o.handoffIdleMs || 2 * 60 * 1000;  // an accepted transfer with no chunk for this long is dropped
    // v3.29 the receiver's record of each handoff it applied (or tried to): id → { pub, status, applied?, reason?, sent, at }.
    // Kept in resultsFile (userData/link/handoff-results.json, no secrets) so a result survives a restart: one not yet
    // delivered is sent when the sender is back, and the sender can ask again (ho-query) at any time.
    this.resultsFile = o.resultsFile || null;
    this.results = this.loadResults();
    // v3.31/v3.32: what each connected peer said in its hello, and the machine data exchanged by capability
    this.appVersion = /^[0-9A-Za-z.+-]{1,20}$/.test(String(o.app || '')) ? String(o.app) : '';
    this.peers = new Map();       // pub → { v, app, caps: string[] } (from its hello on this connection)
    this.res = null;              // this machine's resources (publishRes)
    this.catalog = null;          // this machine's project catalog (publishCatalog)
    this.sentRes = new Map();     // pub → json of the res last sent
    this.sentCatalog = new Map(); // pub → json of the catalog last sent ('off' after a "not shared any more")
    this.peerRes = new Map();     // pub → res received
    this.peerCatalog = new Map(); // pub → catalog received
    // v3.34 login relay (cap 'accounts'): this machine's account list, what peers allowed us to see, our relays there
    this.accounts = null;         // [{ id, label, state, email? }] (publishAccounts)
    this.sentAccounts = new Map(); // pub → json last sent ('off' after a "not shared any more")
    this.peerAccounts = new Map(); // pub → accounts received
    this.loginsOut = new Map();   // id → { id, pub, account, status: starting|waiting|sent|ok|failed, url?, prompt?, reason?, email?, at, timer }
    this.loginTimeoutMs = o.loginTimeoutMs || C.LOGIN_TIMEOUT_MS + 30000;   // the host side times out first
    // v3.35 reports of dispatched tasks this device ran: id → { pub, report: null (still running) | Report, sent, at }.
    // Kept in reportsFile (userData/link/reports-out.json, 0600, newest 50) so one not yet delivered is sent on reconnect.
    this.reportsFile = o.reportsFile || null;
    this.reportsOut = this.loadReports();
    // v3.33 project actions we asked a device for (proj-op): id → { pub, resolve, timer }
    this.projOps = new Map();
    this.projOpMs = o.projOpMs || 12000;
    // v3.48 dispatcher: every task (report) sent to a device, and the offline outbox (status 'held'), in tasksFile
    // (userData/link/tasks-out.json, 0600). The redacted task text stays only until the runner says it was typed, so a
    // held task can be sent on the device's next hello and one a restarted runner lost can be sent again.
    this.tasksFile = o.tasksFile || null;
    this.outboxTtlMs = o.outboxTtlMs || OUTBOX_TTL_MS;
    this.tasks = this.loadTasks();
    this.sendLimiter = new C.RateLimiter({ now: this.now });   // outbox sends stay under the receiver's limit
    // v3.48 runner: the tasks devices sent here (id → { pub, project, state, reason?, why?, at }) in seenFile
    // (userData/link/tasks-seen.json, 0600, newest 200): a repeat is answered with its status, never typed twice
    this.seenFile = o.seenFile || null;
    this.seen = this.loadSeen();
    this.statusSent = new Map();   // id → { sig, at } of the last task-status sent (at most one per 5 s per task)
    // v3.48 incoming task-status / task-query are limited per device (a resync answers ≤300 open tasks at once)
    this.statusLimiter = new C.RateLimiter({ burst: 400, everyMs: 50, now: this.now });
    this.queryLimiter = new C.RateLimiter({ burst: 16, everyMs: 2000, now: this.now });
    this.log = o.log || ((...a) => console.warn('[link]', ...a));
    this.destroyed = false;
  }

  // --- swarm

  ensureSwarm() {
    if (this.swarm || this.destroyed) return this.swarm;
    this.swarm = this.swarmFactory({
      keyPair: this.keyPair,
      ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}),
      // true = refuse: only trusted keys, plus anyone while a pairing code is open (they still need the code's proof)
      firewall: (remotePub) => !(C.trusted(this.devices, this.secrets, remotePub) || this.pairing),
    });
    this.swarm.on('connection', (conn) => this.onConnection(conn));
    for (const d of this.devices) if (this.secrets[d.pub]) this.swarm.join(C.pairTopic(this.secrets[d.pub]), { server: true, client: true });
    return this.swarm;
  }
  async maybeStopSwarm() {
    if (!this.swarm || this.devices.length || this.pairing) return;
    const s = this.swarm;
    this.swarm = null;
    await s.destroy().catch(() => {});
  }

  onConnection(conn) {
    conn.on('error', () => {});
    const remote = C.hex(conn.remotePublicKey);
    const device = C.trusted(this.devices, this.secrets, remote);
    if (device) return this.session(conn, device, null);
    if (this.pairing) return this.pairSession(conn, remote);
    conn.destroy();
  }

  /** Reads lines from a connection; `handle` gets each JSON value. Oversized frames close it. */
  reader(conn, handle) {
    const r = new C.LineReader(handle);
    conn.on('data', (chunk) => { if (!r.push(chunk)) conn.destroy(); });
  }
  write(conn, m) {
    const line = C.encode(m);
    if (line && conn && !conn.destroyed) conn.write(line);
  }

  // --- pairing

  /** Shows a one-time code (this device invites). Resolves at once; 'paired' fires when the other side joins. */
  async invite() {
    await this.cancelPairing();
    const code = C.makeCode();
    const d = this.startPairing('inviter', code);
    await d.flushed().catch(() => {});   // announced on the DHT before the code is shown
    return { code, expiresAt: this.pairing?.expiresAt || 0 };
  }
  /** Enters a code shown on the other device. Resolves with the new device, rejects on a bad code or timeout. */
  join(text) {
    const code = C.normalizeCode(text);
    if (!code) return Promise.reject(new Error('bad-code'));
    return this.cancelPairing().then(() => new Promise((resolve, reject) => this.startPairing('joiner', code, resolve, reject)));
  }
  startPairing(role, code, resolve, reject) {
    const { topic, key } = C.pairSecrets(code);
    const expiresAt = this.now() + C.PAIR_TTL_MS;
    const timer = setTimeout(() => this.cancelPairing(new Error('expired')), C.PAIR_TTL_MS);
    timer.unref?.();
    // the joiner looks the topic up again every few seconds: the inviter may announce after its first lookup
    const retry = role === 'joiner' ? setInterval(() => discovery.refresh().catch(() => {}), 3000) : null;
    retry?.unref?.();
    this.pairing = { role, code, key, topic, expiresAt, timer, retry, resolve, reject };
    const discovery = this.ensureSwarm().join(topic, { server: role === 'inviter', client: role === 'joiner' });
    this.emit('change');
    return discovery;
  }
  async cancelPairing(err) {
    const p = this.pairing;
    if (!p) return;
    this.pairing = null;
    clearTimeout(p.timer);
    clearInterval(p.retry);
    p.reject?.(err || new Error('cancelled'));
    await this.swarm?.leave(p.topic).catch(() => {});
    this.emit('change');
    await this.maybeStopSwarm();
  }

  pairSession(conn, remote) {
    const p = this.pairing;
    let done = false;
    const fail = () => { if (!done) conn.destroy(); };
    const t = setTimeout(fail, 20000);
    t.unref?.();
    this.write(conn, { t: 'pair-hello', name: this.name, proof: C.pairProof(p.key, p.role, this.pub, remote) });
    let device = null;
    this.reader(conn, (raw) => {
      if (device) return this.handle(conn, device, raw);    // the same stream carries the session once paired
      const m = C.validatePair(raw);
      if (!m || this.pairing !== p) return fail();
      if (m.t === 'pair-hello') {
        const theirs = p.role === 'inviter' ? 'joiner' : 'inviter';
        if (!C.proofOk(p.key, theirs, remote, this.pub, m.proof)) return fail();
        if (p.role !== 'inviter') return;                     // the joiner waits for pair-ok
        const secret = crypto.randomBytes(32).toString('hex');
        device = this.addDevice(remote, m.name, secret);
        this.write(conn, { t: 'pair-ok', name: this.name, secret, proof: C.pairProof(p.key, 'ok', this.pub, remote) });
      } else if (m.t === 'pair-ok' && p.role === 'joiner') {
        if (!C.proofOk(p.key, 'ok', remote, this.pub, m.proof)) return fail();
        device = this.addDevice(remote, m.name, m.secret);
      } else return fail();
      done = true;
      clearTimeout(t);
      const resolve = p.resolve;
      this.pairing = null;
      clearTimeout(p.timer);
      clearInterval(p.retry);
      this.swarm?.leave(p.topic).catch(() => {});
      resolve?.(device);
      this.session(conn, device, 'paired');
    });
    conn.on('close', () => clearTimeout(t));
  }

  addDevice(pub, name, secret) {
    const device = { pub, name: C.deviceName(name), addedAt: this.now(), allowCommands: false, allowHandoff: false, allowManage: false, allowAccounts: false };   // all OFF by default
    this.devices = [...this.devices.filter((d) => d.pub !== pub), device];
    this.secrets[pub] = secret;
    this.swarm?.join(C.pairTopic(secret), { server: true, client: true });
    this.persist();
    this.emit('paired', device);
    return device;
  }

  // --- trusted sessions

  session(conn, device, _why) {
    const old = this.conns.get(device.pub);
    if (old && old !== conn) old.destroy();
    this.conns.set(device.pub, conn);
    this.sentJson.delete(device.pub);
    this.forgetPeer(device.pub);   // a new connection: no capability is known until its hello
    this.dropLogins(device.pub);   // a relay does not survive its connection (either side)
    let invalid = 0;
    if (_why !== 'paired') this.reader(conn, (raw) => this.handle(conn, device, raw, () => { if (++invalid > 20) conn.destroy(); }));
    // heartbeat: ping every heartbeatMs; no data at all for HEARTBEAT_MISSES of them = the peer is gone
    const beat = setInterval(() => this.write(conn, { t: 'ping' }), this.heartbeatMs);
    beat.unref?.();
    const silence = setTimeout(() => conn.destroy(), this.heartbeatMs * C.HEARTBEAT_MISSES);
    silence.unref?.();
    conn.on('data', () => silence.refresh());
    conn.on('close', () => {
      clearInterval(beat);
      clearTimeout(silence);
      if (this.conns.get(device.pub) !== conn) return;
      this.conns.delete(device.pub);
      this.remotes.delete(device.pub);
      const seenCheck = this.peerHas(device.pub, 'task-status');   // before the peer is forgotten
      this.forgetPeer(device.pub);
      this.dropLogins(device.pub);
      for (const [id, o] of [...this.projOps]) if (o.pub === device.pub) this.endProjOp(id, { ok: false, reason: 'offline' });
      // its answers came on this connection: a command still sent or queued will never hear its outcome
      // (a task's record is the same object: the tasks-out rules below decide it)
      for (const o of this.outgoing) if (o.pub === device.pub && !this.tasks.has(o.id) && (o.status === 'sent' || o.status === 'queued')) o.status = 'unknown';
      // v3.48 a task sent but never confirmed goes back to the outbox; the others are asked about on the next hello
      // An older runner (no cap task-status) has no repeat check and may type it meanwhile: what reached it is never
      // sent again (unknown → lost on the next hello)
      for (const r of this.tasks.values()) if (r.pub === device.pub && (r.status === 'sent' || r.status === 'queued')) {
        if (!seenCheck) { r.status = 'unknown'; delete r.text; } else Object.assign(r, r.status === 'sent' && r.text ? { status: 'held', reason: 'offline' } : { status: 'unknown' });
      }
      this.saveTasks();
      for (const h of this.handoffsOut.values()) if (h.pub === device.pub) h.finish?.({ ok: false, reason: 'offline' });
      // an offer or transfer dies with the connection; one being applied finishes and reports on the next connection
      for (const h of [...this.handoffsIn.values()]) if (h.pub === device.pub && h.stage !== 'applying') this.dropIn(h, 'offline', false);
      this.emit('change');
    });
    this.write(conn, this.helloMsg());
    let sent = false;
    for (const [id, r] of this.results) if (r.pub === device.pub && !r.sent && (r.status === 'applied' || r.status === 'not-applied')) {
      this.write(conn, this.resultMsg(id, r));
      r.sent = sent = true;
    }
    if (sent) this.saveResults();
    this.flushTo(device.pub, conn);
    this.emit('change');
  }

  handle(conn, device, raw, onInvalid = () => {}) {
    const d = C.trusted(this.devices, this.secrets, device.pub);   // checked on every message: removal revokes at once
    if (!d) return conn.destroy();
    const m = C.validateMessage(raw);
    if (!m) return onInvalid();
    if (m.t === 'hello') {
      // the local name wins; the remote name is only a default at pairing. Its caps decide what it is sent (v3.31).
      this.peers.set(d.pub, { v: m.v, app: m.app || '', caps: m.caps || [] });
      this.flushRes(d.pub, conn);
      this.flushCatalog(d.pub, conn);
      this.flushReports(d.pub, conn);
      this.flushAccounts(d.pub, conn);
      this.resync(d.pub, conn);
      this.pumpOutbox();
      this.emit('change');
    } else if (m.t === 'res') {
      this.peerRes.set(d.pub, m.res);
      this.emit('change');
    } else if (m.t === 'catalog') {
      if (m.catalog.shared) this.peerCatalog.set(d.pub, m.catalog.projects); else this.peerCatalog.delete(d.pub);
      this.emit('change');
    } else if (m.t === 'state') {
      const prev = this.remotes.get(d.pub)?.snap || null;
      this.remotes.set(d.pub, { snap: m.snap, at: this.now() });
      this.emit('remote', d, m.snap, prev);
      this.emit('change');
    } else if (m.t === 'cmd') {
      this.receiveCommand(conn, d, m);
    } else if (m.t === 'proj-op') {
      this.receiveProjOp(conn, d, m);
    } else if (m.t === 'proj-op-status') {
      const o = this.projOps.get(m.id);
      if (o && o.pub === d.pub) this.endProjOp(m.id, { ok: m.ok, ...(m.reason ? { reason: m.reason } : {}) });
    } else if (m.t === 'cmd-status') {
      const o = this.outgoing.find((x) => x.id === m.id && x.pub === d.pub);
      const r = this.tasks.get(m.id);
      if (o && o !== r) { o.status = m.status; o.reason = m.reason; }
      if (r && r.pub === d.pub && !TASK_DONE.has(r.status)) {
        // the receiver's limit refused an outbox send: back to the outbox, tried again later (paced)
        if (m.status === 'rejected' && m.reason === 'rate-limited' && r.text && r.held) Object.assign(r, { status: 'held', reason: 'paced' });
        else { r.status = m.status; if (m.reason) r.reason = m.reason; else delete r.reason; if (m.status !== 'queued') delete r.text; }
        this.saveTasks();
      }
      if (o || r) this.emit('change');
    } else if (m.t === 'task-status') {
      if (this.statusLimiter.take(d.pub)) this.onTaskStatus(d, m);
    } else if (m.t === 'task-query') {
      if (this.peerHas(d.pub, 'task-status') && this.queryLimiter.take(d.pub)) for (const id of m.ids) this.write(conn, this.statusMsg(id, d.pub));
    } else if (m.t === 'task-cancel') {
      const s = this.seen.get(m.id);
      if (!this.peerHas(d.pub, 'task-status') || !s || s.pub !== d.pub) { if (this.peerHas(d.pub, 'task-status')) this.write(conn, this.statusMsg(m.id, d.pub)); }
      else this.emit('task-cancel', { device: d, id: m.id, project: s.project, answer: () => { const c = this.conns.get(d.pub); if (c) this.write(c, this.statusMsg(m.id, d.pub)); } });
    } else if (m.t === 'cmd-report') {
      // v3.35 the report of a task we dispatched there; the host keeps only ids it dispatched
      const o = this.outgoing.find((x) => x.id === m.id && x.pub === d.pub);
      if (o) { o.status = 'reported'; }
      const tr = this.tasks.get(m.id);
      if (tr && tr.pub === d.pub && tr.status !== 'reported') { tr.status = 'reported'; delete tr.reason; delete tr.text; delete tr.why; this.saveTasks(); }
      const { t: _t, id, ...report } = m;
      // acknowledged every time (the sender resends until it hears this); a repeat is dropped by the host (main)
      if (this.peerHas(d.pub, 'report')) this.write(conn, { t: 'cmd-report-ack', id });
      this.emit('report', { device: d, id, report });
      this.emit('change');
    } else if (m.t === 'cmd-report-ack') {
      // v3.35 the dispatcher has the report: it is no longer resent
      const r = this.reportsOut.get(m.id);
      if (r && r.pub === d.pub && r.report && !r.sent) { r.sent = true; this.saveReports(); }
    } else if (m.t.startsWith('acct-') || m.t.startsWith('login-')) {
      this.handleLogin(conn, d, m);
    } else if (m.t === 'ho-offer') {
      this.receiveOffer(conn, d, m);
    } else if (m.t === 'ho-chunk') {
      this.receiveChunk(d, m);
    } else if (m.t === 'ho-answer' || m.t === 'ho-result') {
      const h = this.handoffsOut.get(m.id);
      const hin = m.t === 'ho-result' ? this.handoffsIn.get(m.id) : null;
      if (h && h.pub === d.pub && !h.done) (m.t === 'ho-answer' ? h.onAnswer : h.onResult)?.(m);
      else if (hin && hin.pub === d.pub) {
        // the sender gave up (timeout, changed): drop the offer; one being applied must not be adopted any more
        if (hin.stage === 'applying') hin.cancelled = true;
        else this.dropIn(hin, m.reason || 'cancelled', false);
      } else if (m.t === 'ho-result' && (!h || h.pub === d.pub)) this.emit('handoff-late-result', { device: d, id: m.id, ok: m.ok, applied: m.applied, reason: m.reason });
    } else if (m.t === 'ho-query') {
      this.write(conn, { t: 'ho-status', id: m.id, ...this.statusOf(d.pub, m.id) });
    } else if (m.t === 'ho-status') {
      this.emit('handoff-status', { device: d, id: m.id, status: m.status, applied: m.applied, reason: m.reason });
    }
  }

  // --- persisted handoff results (receiver) and the sender's "ask again"

  loadResults() {
    const out = new Map();
    if (!this.resultsFile) return out;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.resultsFile, 'utf8')); } catch { return out; }
    for (const [id, r] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!r || typeof r !== 'object' || typeof r.pub !== 'string') continue;
      // an apply cut off by a restart: what landed on disk is not known
      const status = r.status === 'applying' ? 'unknown' : r.status;
      if (['applied', 'not-applied', 'unknown'].includes(status)) out.set(id, { pub: r.pub, status, applied: r.applied, reason: r.reason, sent: r.sent === true, at: Number(r.at) || 0 });
    }
    return out;
  }
  saveResults() {
    if (!this.resultsFile) return;
    const keep = [...this.results].sort((x, y) => y[1].at - x[1].at).slice(0, 50);   // the newest 50 are plenty
    this.results = new Map(keep);
    try {
      fs.mkdirSync(path.dirname(this.resultsFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.resultsFile, JSON.stringify(Object.fromEntries(keep), null, 2), { mode: 0o600 });
    } catch { /* best effort */ }
  }
  setResult(id, pub, status, extra = {}) {
    this.results.set(id, { pub, status, sent: false, at: this.now(), ...extra });
    this.saveResults();
  }
  resultMsg(id, r) {
    return { t: 'ho-result', id, ok: r.status === 'applied', ...(r.reason ? { reason: r.reason } : {}), ...(r.applied ? { applied: r.applied } : {}) };
  }
  /** The answer to ho-query: from the record, else still applying = unknown, else it never got that far = not-applied. */
  statusOf(pub, id) {
    const r = this.results.get(id);
    if (r && r.pub === pub) return { status: r.status, ...(r.applied ? { applied: r.applied } : {}), ...(r.reason ? { reason: r.reason } : {}) };
    const h = this.handoffsIn.get(id);
    if (h && h.pub === pub && h.stage === 'applying') return { status: 'unknown' };
    return { status: 'not-applied' };
  }
  /** Sender: asks a device again for the outcome of a handoff ('handoff-status' answers). False when it is offline. */
  queryHandoff(pub, id) {
    const conn = this.conns.get(pub);
    if (!conn || conn.destroyed || !C.validateMessage({ t: 'ho-query', id })) return false;
    this.write(conn, { t: 'ho-query', id });
    return true;
  }

  // --- project handoff (v3.29): offer → answer → chunks (pack, then bundle) → result

  /**
   * Offers a project to a paired device and, once accepted, sends its data. Resolves with the receiver's result.
   * A failure decided here (timeout, beforeSend) is also told to the receiver so it drops the offer. A failure after
   * all data was sent (timeout or connection lost while the receiver applies) is `unknown: true` with the id: the
   * receiver may still apply it and reports through 'handoff-late-result'.
   * @param {string} pub @param {{ name: string, dir: string, git: any }} offer @param {{ pack: Buffer, bundle?: Buffer | null }} parts
   * @param {{ answerMs?: number, resultMs?: number, beforeSend?: () => Promise<string | null> | string | null }} [o]
   * @returns {Promise<{ ok: boolean, reason?: string, applied?: string, unknown?: boolean, id?: string }>}
   */
  offerHandoff(pub, offer, parts, { answerMs = 10 * 60 * 1000, resultMs = 60 * 60 * 1000, beforeSend } = {}) {
    const conn = this.conns.get(pub);
    if (!conn) return Promise.resolve({ ok: false, reason: 'offline' });
    const id = crypto.randomBytes(8).toString('hex');
    const sum = (b) => (b ? { size: b.length, sha: crypto.createHash('sha256').update(b).digest('hex') } : null);
    const h = { id, pub, name: C.cleanLine(offer.name, 60), stage: 'asking', sent: 0, total: parts.pack.length + (parts.bundle?.length || 0), at: this.now() };
    this.handoffsOut.set(id, h);
    return new Promise((resolve) => {
      let timer = setTimeout(() => h.finish({ ok: false, reason: 'timeout' }), answerMs);
      h.finish = (r, fromPeer = false) => {
        if (h.done) return;
        h.done = true;
        clearTimeout(timer);
        if (!r.ok && !fromPeer) {
          if (!conn.destroyed) this.write(conn, { t: 'ho-result', id, ok: false, reason: r.reason });
          if (h.stage === 'applying') r = { ...r, unknown: true, id };
        }
        Object.assign(h, { stage: r.ok ? 'done' : r.unknown ? 'unknown' : 'failed', reason: r.reason, applied: r.applied });
        this.emit('change');
        resolve(r);
      };
      h.onAnswer = async (m) => {
        if (!m.ok) return h.finish({ ok: false, reason: m.reason || 'declined' }, true);
        if (h.stage !== 'asking') return;
        clearTimeout(timer);
        timer = setTimeout(() => h.finish({ ok: false, reason: 'timeout' }), resultMs);
        h.stage = 'sending';
        this.emit('change');
        try {
          const why = beforeSend ? await beforeSend() : null;
          if (why) return h.finish({ ok: false, reason: why });
          await this.stream(conn, h, 'pack', parts.pack);
          if (parts.bundle) await this.stream(conn, h, 'bundle', parts.bundle);
          if (!h.done) { h.stage = 'applying'; this.emit('change'); }
        } catch { h.finish({ ok: false, reason: 'offline' }); }
      };
      h.onResult = (m) => h.finish({ ok: m.ok, ...(m.reason ? { reason: m.reason } : {}), ...(m.applied ? { applied: m.applied } : {}) }, true);
      this.write(conn, { t: 'ho-offer', id, name: offer.name, dir: offer.dir, engine: 'claude', git: offer.git, pack: sum(parts.pack), bundle: sum(parts.bundle) });
      this.emit('change');
    });
  }
  async stream(conn, h, part, buf) {
    let last = 0;
    for (let off = 0, seq = 0; off < buf.length; off += C.CHUNK, seq++) {
      if (conn.destroyed || h.done) throw new Error('closed');
      const line = C.encode({ t: 'ho-chunk', id: h.id, part, seq, data: buf.subarray(off, off + C.CHUNK).toString('base64') });
      if (!conn.write(line)) await new Promise((r) => { const go = () => { conn.off('drain', go); conn.off('close', go); r(); }; conn.on('drain', go); conn.on('close', go); });
      h.sent += Math.min(C.CHUNK, buf.length - off);
      if (this.now() - last > 250) { last = this.now(); this.emit('change'); }
    }
  }

  receiveOffer(conn, d, m) {
    const answer = (ok, reason) => this.write(conn, { t: 'ho-answer', id: m.id, ok, ...(reason ? { reason } : {}) });
    if (!C.mayHandoff(this.devices, this.secrets, d.pub)) { this.emit('handoff-refused', { device: d, offer: m, reason: 'not-allowed' }); return answer(false, 'not-allowed'); }
    if (this.handoffsIn.size) return answer(false, 'in-progress');
    const h = { id: m.id, pub: d.pub, conn, offer: m, stage: 'asking', parts: { pack: [], bundle: [] }, bytes: { pack: 0, bundle: 0 }, seq: { pack: 0, bundle: 0 }, at: this.now() };
    this.handoffsIn.set(m.id, h);
    h.timer = setTimeout(() => { if (this.handoffsIn.get(m.id) === h && h.stage === 'asking') { answer(false, 'timeout'); this.dropIn(h, 'timeout', false); } }, this.handoffAskMs);
    h.timer.unref?.();
    this.emit('handoff-offer', { device: d, offer: m });
    this.emit('change');
  }
  /** The person's answer to an offer. Returns false when there is no such open offer. */
  answerHandoff(id, accept, reason = 'declined') {
    const h = this.handoffsIn.get(id);
    if (!h || h.stage !== 'asking') return false;
    clearTimeout(h.timer);
    if (!accept) { this.write(h.conn, { t: 'ho-answer', id, ok: false, reason }); this.handoffsIn.delete(id); }
    else {
      h.stage = 'receiving';
      h.timer = setTimeout(() => { if (this.handoffsIn.get(id) === h && h.stage === 'receiving') this.dropIn(h, 'timeout'); }, this.handoffIdleMs);
      h.timer.unref?.();
      this.write(h.conn, { t: 'ho-answer', id, ok: true });
    }
    this.emit('change');
    return true;
  }
  dropIn(h, reason, tell = true) {
    clearTimeout(h.timer);
    if (tell) this.write(h.conn, { t: 'ho-result', id: h.id, ok: false, reason });
    this.handoffsIn.delete(h.id);
    this.emit('handoff-failed', { offer: h.offer, reason });
    this.emit('change');
  }
  receiveChunk(d, m) {
    const h = this.handoffsIn.get(m.id);
    if (!h || h.pub !== d.pub || h.stage !== 'receiving') return;
    const want = h.offer[m.part];
    if (!want || m.seq !== h.seq[m.part] || (m.part === 'bundle' && h.bytes.pack < h.offer.pack.size)) return this.dropIn(h, 'bad-data');
    const buf = Buffer.from(m.data, 'base64');
    if (h.bytes[m.part] + buf.length > want.size) return this.dropIn(h, 'too-large');
    h.timer?.refresh?.();
    h.parts[m.part].push(buf);
    h.bytes[m.part] += buf.length;
    h.seq[m.part]++;
    if (h.bytes.pack < h.offer.pack.size || (h.offer.bundle && h.bytes.bundle < h.offer.bundle.size)) return;
    const parts = { pack: Buffer.concat(h.parts.pack), bundle: h.offer.bundle ? Buffer.concat(h.parts.bundle) : null };
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    if (sha(parts.pack) !== h.offer.pack.sha || (parts.bundle && sha(parts.bundle) !== h.offer.bundle.sha)) return this.dropIn(h, 'checksum');
    clearTimeout(h.timer);
    h.stage = 'applying';
    h.parts = null;
    this.setResult(h.id, h.pub, 'applying');   // a restart from here on answers ho-query with 'unknown'
    this.emit('change');
    const done = (/** @type {{ ok: boolean, reason?: string, applied?: string }} */ r) => {
      if (this.handoffsIn.get(h.id) !== h) return;
      const msg = { t: 'ho-result', id: h.id, ok: r.ok === true, ...(r.reason ? { reason: r.reason } : {}), ...(r.applied ? { applied: r.applied } : {}) };
      const conn = this.conns.get(h.pub);
      const live = Boolean(conn && !conn.destroyed);
      if (live) this.write(conn, msg);
      // kept on disk: sent when the sender is back (also after a restart) and the answer to its ho-query
      this.setResult(h.id, h.pub, msg.ok ? 'applied' : 'not-applied', { ...(msg.reason ? { reason: msg.reason } : {}), ...(msg.applied ? { applied: msg.applied } : {}) });
      if (live) { this.results.get(h.id).sent = true; this.saveResults(); }
      this.handoffsIn.delete(h.id);
      this.emit('change');
    };
    // alive() turns false when the sender gave up meanwhile: the receiver must then not adopt the project
    const alive = () => this.handoffsIn.get(h.id) === h && !h.cancelled;
    this.emit('handoff-data', { device: d, offer: h.offer, parts, done, alive });
  }

  receiveCommand(conn, d, m) {
    const task = m.report === true && this.peerHas(d.pub, 'report');
    // v3.48 the answer goes on the device's current connection; a task's status is kept (seen) for task-query
    const send = (status, reason) => {
      const c = this.conns.get(d.pub) || conn;
      if (!c.destroyed) this.write(c, { t: 'cmd-status', id: m.id, status, ...(reason ? { reason } : {}) });
    };
    const reply = (status, reason) => {
      if (task) this.noteTask(m.id, d.pub, m.project, status, reason);
      send(status, reason);
    };
    // v3.48 a refusal before acceptance (not allowed, rate limited, bad text) is never kept: the same id may come again
    if (!C.mayCommand(this.devices, this.secrets, d.pub)) return send('rejected', 'not-allowed');
    // v3.48 idempotent: a task id this device already sent (outbox resend, resync) is answered, never typed twice. A
    // report still owed for it (reports-out, saved before 'delivered') means it was typed, even if tasks-seen was not saved.
    const st = this.seenState(m.id, d.pub);
    if (st) {
      if (this.peerHas(d.pub, 'task-status')) return this.write(conn, this.statusMsg(m.id, d.pub));
      return this.write(conn, { t: 'cmd-status', id: m.id, status: st.state === 'queued' ? 'queued' : st.state === 'rejected' ? 'rejected' : 'delivered', ...(st.state === 'rejected' && st.reason ? { reason: st.reason } : {}) });
    }
    if (!this.limiter.take(d.pub)) return send('rejected', 'rate-limited');
    const s = C.sanitizeCommand(m.text);
    if (!s.ok) return send('rejected', s.reason);
    // main decides (project, engine, busy tab) and answers through reply()
    this.emit('command', { device: d, id: m.id, project: m.project, text: s.text, reply, report: task, ...(m.ttl && this.peerHas(d.pub, 'task-status') ? { ttl: m.ttl } : {}) });
  }

  // --- v3.33 project actions (start / wake / sleep / stop a project's boss tab on another device)

  /** A device asks us to act on one of our projects: allowed to manage, rate limited (shared with commands); main acts. */
  receiveProjOp(conn, d, m) {
    if (!this.peerHas(d.pub, 'manage')) return;   // it never said it understands the answer (amendment 1)
    // the answer goes only while it is still trusted: a removed device hears nothing
    const reply = (ok, reason) => { if (C.trusted(this.devices, this.secrets, d.pub) && !conn.destroyed) this.write(conn, { t: 'proj-op-status', id: m.id, ok, ...(reason && !ok ? { reason } : {}) }); };
    if (!C.mayManage(this.devices, this.secrets, d.pub)) return reply(false, 'not-allowed');
    if (!this.limiter.take(d.pub)) return reply(false, 'rate-limited');
    this.emit('proj-op', { device: d, id: m.id, op: m.op, project: m.project, reply });
  }
  /** Asks a device to start / wake / sleep / stop one of its projects. → Promise<{ ok, reason? }> (never rejects). */
  sendProjOp(pub, project, op) {
    const conn = this.conns.get(pub);
    if (!C.PROJ_OPS.includes(op) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(project))) return Promise.resolve({ ok: false, reason: 'failed' });
    if (!C.trusted(this.devices, this.secrets, pub)) return Promise.resolve({ ok: false, reason: 'removed' });
    if (!conn) return Promise.resolve({ ok: false, reason: 'offline' });
    if (!this.peerHas(pub, 'manage')) return Promise.resolve({ ok: false, reason: 'no-manage' });
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.endProjOp(id, { ok: false, reason: 'timeout' }), this.projOpMs);
      timer.unref?.();
      this.projOps.set(id, { pub, resolve, timer });
      this.write(conn, { t: 'proj-op', id, op, project });
    });
  }
  endProjOp(id, result) {
    const o = this.projOps.get(id);
    if (!o) return;
    this.projOps.delete(id);
    clearTimeout(o.timer);
    o.resolve(result);
  }

  /** Sends a prompt to a remote project's boss tab. Returns the command's local record. */
  /** v3.48 o.hold: a task (report) for a device that is offline is kept in the outbox and sent on its next hello; o.ttl: its queue wait there. */
  sendCommand(pub, project, text, { report = false, ttl = 0, hold = false, projectName = '' } = {}) {
    const conn = this.conns.get(pub);
    const s = C.sanitizeCommand(text);
    const snap = this.remotes.get(pub)?.snap;
    const rec = { id: crypto.randomBytes(8).toString('hex'), pub, project, projectName: C.cleanLine(snap?.projects.find((p) => p.id === project)?.name || projectName || project, 60), firstLine: C.cleanLine(String(text).split('\n')[0], 80), status: 'sent', at: this.now() };
    if (!s.ok) Object.assign(rec, { status: 'rejected', reason: s.reason });
    else if (!conn && report && hold && C.trusted(this.devices, this.secrets, pub)) Object.assign(rec, { status: 'held', reason: 'offline', held: true });
    else if (!conn) Object.assign(rec, { status: 'rejected', reason: report ? 'offline' : 'not-running' });
    else if (report && !this.peerHas(pub, 'report')) Object.assign(rec, { status: 'rejected', reason: 'no-report' });
    if (report) {
      rec.report = true;
      if (rec.status !== 'rejected') Object.assign(rec, { text: s.text, expiresAt: rec.at + this.outboxTtlMs, ...(ttl > 0 ? { ttl: Math.min(ttl, C.TASK_TTL_MAX) } : {}) });
      this.tasks.set(rec.id, rec);
      this.saveTasks();
    }
    if (rec.status === 'sent') this.writeCmd(conn, rec, s.text);
    this.outgoing = [rec, ...this.outgoing].slice(0, 20);
    this.emit('change');
    return rec;
  }

  writeCmd(conn, rec, text) {
    this.write(conn, { t: 'cmd', id: rec.id, project: rec.project, text, ...(rec.report ? { report: true } : {}), ...(rec.ttl && this.peerHas(rec.pub, 'task-status') ? { ttl: rec.ttl } : {}) });
  }

  // --- v3.48 dispatcher: sent-task records, offline outbox, resync, cancel

  loadTasks() {
    const out = new Map();
    let raw = null;
    try { raw = this.tasksFile && JSON.parse(fs.readFileSync(this.tasksFile, 'utf8')); } catch { return out; }
    for (const r of Array.isArray(raw) ? raw : []) {
      if (!r || !C.isHex(r.pub, 32) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(r.id)) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(r.project)) || !TASK_REC.includes(r.status)) continue;
      const rec = { id: r.id, pub: r.pub, project: r.project, projectName: C.cleanLine(r.projectName, 60) || r.project, firstLine: C.cleanLine(r.firstLine, 80), status: r.status, at: Number(r.at) || 0, report: true,
        expiresAt: Number(r.expiresAt) || 0, ...(r.reason ? { reason: C.cleanLine(r.reason, 40) } : {}), ...(Number(r.ttl) > 0 ? { ttl: Math.min(Number(r.ttl), C.TASK_TTL_MAX) } : {}),
        ...(r.held ? { held: true } : {}), ...(typeof r.text === 'string' && C.sanitizeCommand(r.text).ok ? { text: C.sanitizeCommand(r.text).text } : {}) };
      // a restart: what was sent or queued is asked about again on the next hello
      // (it reached the wire: an older runner may have typed it, so resync decides: task-query, or lost for an old peer)
      if (rec.status === 'sent' || rec.status === 'queued') rec.status = 'unknown';
      out.set(rec.id, rec);
    }
    return out;
  }
  saveTasks() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const now = this.now();
    const all = [...this.tasks.values()].sort((x, y) => y.at - x.at);
    const keep = all.filter((r) => !TASK_DONE.has(r.status) || now - r.at < 7 * 24 * 3600 * 1000).slice(0, 300);
    this.tasks = new Map(keep.map((r) => [r.id, r]));
    if (!this.tasksFile) return;
    try {
      fs.mkdirSync(path.dirname(this.tasksFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${this.tasksFile}.tmp`, JSON.stringify(keep.map(({ why: _w, ...r }) => r)), { mode: 0o600 });
      fs.renameSync(`${this.tasksFile}.tmp`, this.tasksFile);
    } catch { /* best effort */ }
  }
  /** A sent task's record (status, why it waits), or null. */
  sentTask(id) { return this.tasks.get(id) || null; }
  /** Sends what waits in the outbox to devices that said hello (oldest first, paced); expires what waited too long. */
  pumpOutbox() {
    const now = this.now();
    let changed = false;
    for (const r of [...this.tasks.values()].sort((x, y) => x.at - y.at)) {
      if (r.status !== 'held' && r.status !== 'unknown') continue;
      if (r.expiresAt && now > r.expiresAt) { r.status = 'expired'; delete r.text; changed = true; continue; }   // outbox TTL
      if (r.status !== 'held') continue;
      if (!C.trusted(this.devices, this.secrets, r.pub)) { Object.assign(r, { status: 'rejected', reason: 'removed' }); delete r.text; changed = true; continue; }
      const conn = this.conns.get(r.pub);
      if (!conn || !this.peers.has(r.pub)) continue;   // no hello yet on this connection
      if (!this.peerHas(r.pub, 'report')) { Object.assign(r, { status: 'rejected', reason: 'no-report' }); delete r.text; changed = true; continue; }
      if (!r.text) { Object.assign(r, { status: 'lost' }); changed = true; continue; }
      if (!this.sendLimiter.take(r.pub)) { if (r.reason !== 'paced') { r.reason = 'paced'; changed = true; } continue; }
      Object.assign(r, { status: 'sent', held: true });
      delete r.reason;
      this.writeCmd(conn, r, r.text);
      changed = true;
    }
    if (changed) { this.saveTasks(); this.emit('change'); }
  }
  /** On a device's hello: asks about every open task sent there (cap task-status); an older peer: unknown → lost. */
  resync(pub, conn) {
    const open = [...this.tasks.values()].filter((r) => r.pub === pub && ['sent', 'queued', 'delivered', 'running', 'needs-approval', 'unknown'].includes(r.status));
    if (!this.peerHas(pub, 'task-status')) {
      let changed = false;
      // no repeat check there: a task that reached it may have been typed meanwhile, so it is never sent again
      for (const r of open) if (r.status === 'unknown') { Object.assign(r, { status: 'lost', reason: 'unknown' }); delete r.text; changed = true; }
      if (changed) this.saveTasks();
      return;
    }
    for (let i = 0; i < open.length; i += 50) this.write(conn, { t: 'task-query', ids: open.slice(i, i + 50).map((r) => r.id) });
  }
  onTaskStatus(d, m) {
    const r = this.tasks.get(m.id);
    if (!r || r.pub !== d.pub || TASK_DONE.has(r.status) || !this.peerHas(d.pub, 'task-status')) return;
    if (m.state === 'unknown') {
      // the runner never saw it, or lost its queue in a restart: sent again while the text is still here, else lost
      if (r.text && r.expiresAt > this.now()) { Object.assign(r, { status: 'held', reason: 'resend' }); this.saveTasks(); this.pumpOutbox(); } else { Object.assign(r, { status: 'lost', reason: 'unknown' }); delete r.text; }
    } else if (m.state === 'reported') {
      if (r.status !== 'reported') { r.status = 'delivered'; delete r.text; }   // its cmd-report comes on this connection
    } else {
      r.status = m.state;
      if (m.reason) r.reason = m.reason; else delete r.reason;
      if (m.why) r.why = { state: m.why.state, pos: m.why.pos, len: m.why.len, expiresAt: this.now() + m.why.expiresIn }; else delete r.why;
      if (m.state !== 'queued') delete r.text;
    }
    this.saveTasksSoon();
  }
  /** v3.48 a burst of task-status (a resync) is one write of tasks-out and one 'change'. */
  saveTasksSoon() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flushTasks(), 250);
      this.saveTimer.unref?.();
    }
    if (!this.changeSoon) { this.changeSoon = true; setImmediate(() => { this.changeSoon = false; if (!this.destroyed) this.emit('change'); }); }
  }
  flushTasks() { if (this.saveTimer) this.saveTasks(); }
  /** Cancel of a task this device sent: a held one ends here; a queued one there is asked to leave its queue (cap task-status). */
  cancelTask(id) {
    const r = this.tasks.get(id);
    if (!r) return { ok: false, reason: 'unknown' };
    if (r.status === 'held') { Object.assign(r, { status: 'rejected', reason: 'cancelled' }); delete r.text; this.saveTasks(); this.emit('change'); return { ok: true }; }
    if (r.status !== 'sent' && r.status !== 'queued') return { ok: false, reason: 'not-queued' };
    const conn = this.conns.get(r.pub);
    if (!conn) return { ok: false, reason: 'offline' };
    if (!this.peerHas(r.pub, 'task-status')) return { ok: false, reason: 'no-cap' };
    this.write(conn, { t: 'task-cancel', id });
    return { ok: true, pending: true };
  }

  // --- v3.48 runner: the status of tasks devices sent here

  loadSeen() {
    const out = new Map();
    let raw = null;
    try { raw = this.seenFile && JSON.parse(fs.readFileSync(this.seenFile, 'utf8')); } catch { return out; }
    for (const [id, s] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      // the queue is memory only: a task still queued at the restart is forgotten, so the dispatcher sends it again
      if (s && C.isHex(s.pub, 32) && C.TASK_STATES.includes(s.state) && s.state !== 'queued' && /^[A-Za-z0-9_.:-]{1,64}$/.test(id)) out.set(id, { pub: s.pub, project: String(s.project || ''), state: s.state, at: Number(s.at) || 0, ...(s.reason && C.REASONS.includes(s.reason) ? { reason: s.reason } : {}) });
    }
    return out;
  }
  saveSeen() {
    // newest 200 per device; a task still queued or typed (owes its report) is never evicted while young, so another
    // device's traffic can never push it out (a repeat of it would be typed again)
    const per = new Map();
    const keep = [...this.seen].sort((x, y) => y[1].at - x[1].at).filter(([, s]) => {
      const n = per.get(s.pub) || 0;
      const open = SEEN_OPEN.includes(s.state) && this.now() - s.at < OWED_MS;
      if (!open && n >= SEEN_PER_DEVICE) return false;
      per.set(s.pub, n + 1);
      return true;
    });
    this.seen = new Map(keep);
    if (!this.seenFile) return;
    try {
      fs.mkdirSync(path.dirname(this.seenFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${this.seenFile}.tmp`, JSON.stringify(Object.fromEntries(keep.map(([id, s]) => [id, { pub: s.pub, project: s.project, state: s.state, at: s.at, ...(s.reason ? { reason: s.reason } : {}) }]))), { mode: 0o600 });
      fs.renameSync(`${this.seenFile}.tmp`, this.seenFile);
    } catch (e) { this.log('tasks-seen not saved:', e?.code || e?.message || e); }
  }
  noteTask(id, pub, project, status, reason) {
    const prev = this.seen.get(id);
    const state = status === 'queued' || status === 'delivered' || status === 'rejected' ? status : prev?.state || 'delivered';
    this.seen.set(id, { pub, project, state, at: prev?.at || this.now(), ...(reason ? { reason } : {}) });
    this.saveSeen();
  }
  /** What this runner knows of a task that device sent: tasks-seen, or a report owed / kept for it (it was typed). */
  seenState(id, pub) {
    const s = this.seen.get(id);
    const own = s && s.pub === pub ? s : null;
    const owed = this.reportsOut.get(id);
    if (owed && owed.pub === pub && (!own || own.state === 'queued' || own.state === 'unknown')) return { pub, state: owed.report ? 'reported' : 'delivered' };
    return own;
  }
  statusMsg(id, pub) {
    const s = this.seenState(id, pub);
    if (!s) return { t: 'task-status', id, state: 'unknown' };
    const why = s.state === 'queued' && s.why ? { why: { state: s.why.state, pos: s.why.pos, len: s.why.len, expiresIn: Math.max(0, Math.min(C.TASK_TTL_MAX, Math.round(s.why.expiresAt - this.now()))) } } : {};
    return { t: 'task-status', id, state: s.state, ...(s.reason && s.state === 'rejected' ? { reason: s.reason } : {}), ...why };
  }
  /** The host tells a task's live state here (queued + why, delivered, running, needs-approval): sent to its device on change (≤1 per 5 s). */
  taskState(id, state, why = null) {
    const s = this.seen.get(id);
    if (!s || !C.TASK_STATES.includes(state) || s.state === 'reported' || s.state === 'rejected') return;
    const persist = s.state !== state;
    s.state = state;
    if (why) s.why = { ...why, expiresAt: this.now() + why.expiresIn }; else delete s.why;
    if (persist) this.saveSeen();
    const conn = this.conns.get(s.pub);
    if (!conn || !this.peerHas(s.pub, 'task-status')) return;
    const sig = JSON.stringify([state, why && [why.state, why.pos, why.len]]);
    const last = this.statusSent.get(id);
    if (last && last.sig === sig && last.conn === conn) return;
    if (last && !persist && last.conn === conn && this.now() - last.at < 5000) return;
    this.statusSent.set(id, { sig, at: this.now(), conn });
    this.write(conn, this.statusMsg(id, s.pub));
  }
  /** Open tasks devices sent here that were typed and still owe a report → [{ id, project }] (the host derives running/needs-approval). */
  typedTasks() { return [...this.seen].filter(([, s]) => ['delivered', 'running', 'needs-approval'].includes(s.state) && this.now() - s.at < OWED_MS).map(([id, s]) => ({ id, project: s.project })); }

  // --- v3.35 reports of dispatched tasks (this device ran them)

  loadReports() {
    const out = new Map();
    let raw = null;
    try { raw = this.reportsFile && JSON.parse(fs.readFileSync(this.reportsFile, 'utf8')); } catch { return out; }
    for (const [id, r] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (r && typeof r.pub === 'string' && (r.report === null || C.cleanReport(r.report, true))) out.set(id, { pub: r.pub, report: r.report && C.cleanReport(r.report, true), sent: r.sent === true, at: Number(r.at) || 0, ...(typeof r.project === 'string' ? { project: r.project } : {}) });
    }
    return out;
  }
  saveReports() {
    const keep = [...this.reportsOut].sort((x, y) => y[1].at - x[1].at).slice(0, 50);
    this.reportsOut = new Map(keep);
    if (!this.reportsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.reportsFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.reportsFile, JSON.stringify(Object.fromEntries(keep.map(([id, r]) => [id, { pub: r.pub, report: r.report, sent: r.sent, at: r.at, ...(r.project ? { project: r.project } : {}) }]))), { mode: 0o600 });
    } catch (e) { this.log('reports-out not saved:', e?.code || e?.message || e); }
  }
  /** A task from that device was typed with report: its report is owed to it. */
  expectReport(id, pub, project = '') { this.reportsOut.set(id, { pub, report: null, sent: false, at: this.now(), ...(project ? { project } : {}) }); this.saveReports(); }
  /** The task was refused after expectReport (not typed): nothing is owed. */
  dropReport(id) { const r = this.reportsOut.get(id); if (r && r.report === null) { this.reportsOut.delete(id); this.saveReports(); } }
  owesReport(id) { const r = this.reportsOut.get(id); return Boolean(r && r.report === null); }
  /** v3.46 depth 1: a task from a paired device was typed into this project and its report is still owed. */
  /** A device task still owes a report for this project only while young: the 4 h queue TTL + 30 min slack (reports-out persists, a lost one must not refuse 'depth' forever). */
  owesReportFor(project) { return [...this.reportsOut.values()].some((r) => r.report === null && r.project === project && this.now() - r.at < OWED_MS); }
  /** The report of a task that device dispatched: sent now when it is connected, else on its next hello. */
  sendReport(id, report) {
    const r = this.reportsOut.get(id);
    const clean = C.cleanReport(report, true);   // v3.48 kept with the larger limits; each peer gets what its caps allow (flushReports)
    if (!r || r.report || !clean || !C.trusted(this.devices, this.secrets, r.pub)) return false;
    const s = this.seen.get(id);
    if (s && s.pub === r.pub) { s.state = 'reported'; delete s.why; this.saveSeen(); }
    Object.assign(r, { report: clean, at: this.now() });
    const conn = this.conns.get(r.pub);
    if (conn) this.flushReports(r.pub, conn);
    this.saveReports();
    return true;
  }
  flushReports(pub, conn) {
    if (!this.peerHas(pub, 'report') || !C.trusted(this.devices, this.secrets, pub)) return;
    // `sent` turns true only on the dispatcher's cmd-report-ack: until then each new connection (hello) resends it
    for (const [id, r] of this.reportsOut) if (r.pub === pub && r.report && !r.sent && r.wroteOn !== conn && !conn.destroyed) {
      const fit = C.fitReport(r.report, this.peerHas(pub, 'report2'), id);
      if (fit) this.write(conn, { t: 'cmd-report', id, ...fit });
      r.wroteOn = conn;   // not persisted: once per connection
    }
  }

  // --- the published snapshot: at most once a second, only when it changed

  publish(snap) {
    const json = JSON.stringify(snap);
    if (json === this.snapJson) return;
    this.snap = snap;
    this.snapJson = json;
    const wait = Math.max(0, 1000 - (this.now() - this.lastPub));
    if (this.pubTimer) return;
    this.pubTimer = setTimeout(() => {
      this.pubTimer = null;
      this.lastPub = this.now();
      for (const [pub, conn] of this.conns) this.flushTo(pub, conn);
    }, wait);
    this.pubTimer.unref?.();
  }
  flushTo(pub, conn) {
    if (!this.snap || this.sentJson.get(pub) === this.snapJson) return;
    this.sentJson.set(pub, this.snapJson);
    this.write(conn, { t: 'state', seq: ++this.seq, snap: C.snapshotFor(this.snap, C.mayManage(this.devices, this.secrets, pub)) });
  }

  // --- v3.31 capabilities, v3.32 machine resources and catalog

  helloMsg() { return { t: 'hello', v: C.PROTOCOL, name: this.name, ...(this.appVersion ? { app: this.appVersion } : {}), caps: C.OUR_CAPS }; }
  /** Did this peer's hello (on the current connection) name the capability? A v1 peer names none. */
  peerHas(pub, cap) { return Boolean(this.peers.get(pub)?.caps.includes(cap)); }
  forgetPeer(pub) {
    for (const m of [this.peers, this.sentRes, this.sentCatalog, this.peerRes, this.peerCatalog, this.sentAccounts, this.peerAccounts]) m.delete(pub);
  }
  /** This machine's resources: sent to peers with 'res' when it changed enough (C.resChanged). */
  publishRes(res) {
    if (!res || !C.resChanged(this.res, res)) return;
    this.res = res;
    for (const [pub, conn] of this.conns) this.flushRes(pub, conn);
  }
  flushRes(pub, conn) {
    if (!this.res || !this.peerHas(pub, 'res')) return;
    const json = JSON.stringify(this.res);
    if (this.sentRes.get(pub) === json) return;
    this.sentRes.set(pub, json);
    this.write(conn, { t: 'res', res: this.res });
  }
  /** This machine's project catalog (display only): sent only to peers with 'catalog' that we allow to manage. */
  publishCatalog(catalog) {
    const clean = C.cleanCatalog(catalog);
    if (!clean) return;
    this.catalog = clean.projects;
    for (const [pub, conn] of this.conns) this.flushCatalog(pub, conn);
  }
  flushCatalog(pub, conn) {
    if (!this.peerHas(pub, 'catalog')) return;
    if (!C.mayManage(this.devices, this.secrets, pub)) {
      // it was shared on this connection: tell it to forget (an empty message, no data)
      if (this.sentCatalog.has(pub) && this.sentCatalog.get(pub) !== 'off') { this.sentCatalog.set(pub, 'off'); this.write(conn, { t: 'catalog', catalog: { projects: [], shared: false } }); }
      return;
    }
    if (!this.catalog) return;
    const json = JSON.stringify(this.catalog);
    if (this.sentCatalog.get(pub) === json) return;
    this.sentCatalog.set(pub, json);
    this.write(conn, { t: 'catalog', catalog: { projects: this.catalog } });
  }

  // --- v3.34 remote Claude login relay (cap 'accounts'; the host side needs allowAccounts for the asking device)

  /** This machine's accounts (labels, state, email only): sent to 'accounts' peers we allow account sign-in. */
  publishAccounts(list) {
    const clean = C.cleanAccounts(list);
    if (!clean) return;
    this.accounts = clean;
    for (const [pub, conn] of this.conns) this.flushAccounts(pub, conn);
  }
  flushAccounts(pub, conn) {
    if (!this.peerHas(pub, 'accounts')) return;
    if (!C.mayAccounts(this.devices, this.secrets, pub)) {
      if (this.sentAccounts.has(pub) && this.sentAccounts.get(pub) !== 'off') { this.sentAccounts.set(pub, 'off'); this.write(conn, { t: 'acct-view', accounts: [], shared: false }); }
      return;
    }
    if (!this.accounts) return;
    const json = JSON.stringify(this.accounts);
    if (this.sentAccounts.get(pub) === json) return;
    this.sentAccounts.set(pub, json);
    this.write(conn, { t: 'acct-view', accounts: this.accounts });
  }
  /** A: ask that machine to run `claude auth login` for one of its accounts. One relay per device. */
  startRemoteLogin(pub, account) {
    const conn = this.conns.get(pub);
    if (!conn) return { ok: false, reason: 'offline' };
    if (!this.peerHas(pub, 'accounts')) return { ok: false, reason: 'not-supported' };
    if (typeof account !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(account)) return { ok: false, reason: 'unknown-account' };
    for (const r of this.loginsOut.values()) if (r.pub === pub && !['ok', 'failed'].includes(r.status)) return { ok: false, reason: 'busy' };
    const id = crypto.randomBytes(8).toString('hex');
    const rec = { id, pub, account, status: 'starting', at: this.now(), timer: null };
    rec.timer = setTimeout(() => { this.write(this.conns.get(pub), { t: 'login-cancel', id }); this.endLogin(rec, false, { reason: 'timeout' }); }, this.loginTimeoutMs);
    rec.timer.unref?.();
    this.loginsOut.set(id, rec);
    for (const [k, r] of [...this.loginsOut]) if (this.loginsOut.size > 10 && ['ok', 'failed'].includes(r.status)) this.loginsOut.delete(k);
    this.write(conn, { t: 'login-start', id, account });
    this.emit('change');
    return { ok: true, id };
  }
  /** A: the sign-in URL to open in this machine's browser (checked again here). */
  loginUrl(id) {
    const r = this.loginsOut.get(id);
    return r && r.status === 'waiting' && C.loginUrlOk(r.url) ? r.url : null;
  }
  /** A: the code the person pasted goes to the host once; it is not kept. */
  sendLoginCode(id, code) {
    const r = this.loginsOut.get(id);
    const c = String(code ?? '').trim();
    if (!r || r.status !== 'waiting') return { ok: false, reason: 'not-waiting' };
    if (!C.loginCodeOk(c)) return { ok: false, reason: 'bad-code' };
    const conn = this.conns.get(r.pub);
    if (!conn) return { ok: false, reason: 'offline' };
    this.write(conn, { t: 'login-code', id, code: c });
    r.status = 'sent';
    this.emit('change');
    return { ok: true };
  }
  cancelRemoteLogin(id) {
    const r = this.loginsOut.get(id);
    if (!r || ['ok', 'failed'].includes(r.status)) return;
    this.write(this.conns.get(r.pub), { t: 'login-cancel', id });
    this.endLogin(r, false, { reason: 'cancelled' });
  }
  endLogin(r, ok, extra = {}) {
    if (['ok', 'failed'].includes(r.status)) return;
    clearTimeout(r.timer);
    r.status = ok ? 'ok' : 'failed';
    delete r.url;   // the URL is not needed any more
    Object.assign(r, extra);
    this.emit('login-result', { id: r.id, pub: r.pub, ok, ...extra });
    this.emit('change');
  }
  /** The connection to that device ended or was replaced, or it was removed: relays both ways end. */
  dropLogins(pub) {
    for (const r of this.loginsOut.values()) if (r.pub === pub) this.endLogin(r, false, { reason: 'offline' });
    this.emit('login-cancel', { device: { pub }, id: null });
  }
  handleLogin(conn, d, m) {
    if (!this.peerHas(d.pub, 'accounts')) return;   // never expected from a peer without the capability
    if (m.t === 'acct-view') {
      if (m.shared) this.peerAccounts.set(d.pub, m.accounts); else this.peerAccounts.delete(d.pub);
      this.emit('change');
    } else if (m.t === 'login-start') {
      if (!C.mayAccounts(this.devices, this.secrets, d.pub)) return this.write(conn, { t: 'login-result', id: m.id, ok: false, reason: 'not-allowed' });
      const reply = (msg) => { const c = this.conns.get(d.pub); if (c === conn) this.write(c, { ...msg, id: m.id }); };
      if (!this.limiter.take(d.pub)) return reply({ t: 'login-result', ok: false, reason: 'rate-limited' });
      if (!this.listenerCount('login-start')) return reply({ t: 'login-result', ok: false, reason: 'not-supported' });
      this.emit('login-start', { device: d, id: m.id, account: m.account, reply });
    } else if (m.t === 'login-code' || m.t === 'login-cancel') {
      if (!C.mayAccounts(this.devices, this.secrets, d.pub)) return;
      this.emit(m.t, { device: d, id: m.id, ...(m.t === 'login-code' ? { code: m.code } : {}) });
    } else if (m.t === 'login-url') {
      const r = this.loginsOut.get(m.id);
      if (!r || r.pub !== d.pub || r.status !== 'starting') return;
      if (!C.loginUrlOk(m.url)) { this.write(conn, { t: 'login-cancel', id: m.id }); return this.endLogin(r, false, { reason: 'bad-url' }); }
      Object.assign(r, { status: 'waiting', url: m.url, prompt: m.prompt });
      this.emit('change');
    } else if (m.t === 'login-result') {
      const r = this.loginsOut.get(m.id);
      if (r && r.pub === d.pub) this.endLogin(r, m.ok, { ...(m.email ? { email: m.email } : {}), ...(m.reason ? { reason: m.reason } : {}) });
    }
  }

  // --- the trust list

  rename(pub, name) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, name: C.deviceName(name, d.name) } : d)); this.persist(); this.emit('change'); }
  setAllow(pub, on) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowCommands: on === true } : d)); this.persist(); this.emit('change'); }
  setAllowHandoff(pub, on) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowHandoff: on === true } : d)); this.persist(); this.emit('change'); }
  /** v3.31 "Allow managing projects": the catalog goes to that device (and stops at once when turned off). */
  setAllowManage(pub, on) {
    this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowManage: on === true } : d));
    this.persist();
    const conn = this.conns.get(pub);
    if (conn) this.flushCatalog(pub, conn);
    this.emit('change');
  }
  /** v3.31 "Allow account sign-in": v3.34 the account list goes to that device and it may start a login relay here. */
  setAllowAccounts(pub, on) {
    this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowAccounts: on === true } : d));
    this.persist();
    const conn = this.conns.get(pub);
    if (conn) this.flushAccounts(pub, conn);
    if (on !== true) this.emit('login-cancel', { device: { pub }, id: null });   // a relay it started here stops
    this.emit('change');
  }
  setName(name) {
    this.name = C.deviceName(name, this.name);
    for (const conn of this.conns.values()) this.write(conn, this.helloMsg());
    this.persist(); this.emit('change');
  }
  async remove(pub) {
    const secret = this.secrets[pub];
    this.devices = this.devices.filter((d) => d.pub !== pub);
    delete this.secrets[pub];
    this.conns.get(pub)?.destroy();
    this.conns.delete(pub);
    this.remotes.delete(pub);
    this.forgetPeer(pub);
    this.dropLogins(pub);
    for (const [id, r] of this.reportsOut) if (r.pub === pub) this.reportsOut.delete(id);   // its reports go with it
    for (const [id, o] of this.projOps) if (o.pub === pub) this.endProjOp(id, { ok: false, reason: 'removed' });   // v3.33
    this.saveReports();
    this.persist();
    this.emit('change');
    if (secret) await this.swarm?.leave(C.pairTopic(secret)).catch(() => {});
    await this.maybeStopSwarm();
  }

  persist() { this.emit('persist', { name: this.name, devices: this.devices, secrets: { ...this.secrets } }); }

  /** What the renderer sees. No keys or secrets. */
  view() {
    return {
      name: this.name, id: this.pub.slice(0, 8),
      pairing: this.pairing ? { role: this.pairing.role, code: this.pairing.role === 'inviter' ? this.pairing.code : null, expiresAt: this.pairing.expiresAt } : null,
      devices: this.devices.map((d) => {
        const peer = this.peers.get(d.pub);
        return { id: d.pub, name: d.name, addedAt: d.addedAt, allowCommands: d.allowCommands, allowHandoff: d.allowHandoff, allowManage: d.allowManage, allowAccounts: d.allowAccounts, online: this.conns.has(d.pub),
          // v3.31/v3.32: null = no hello yet; v 1 = an older Agent Office there (no caps)
          v: peer ? peer.v : null, app: peer?.app || '', caps: peer?.caps || [], res: this.peerRes.get(d.pub) || null, catalog: this.peerCatalog.get(d.pub) || null, accounts: this.peerAccounts.get(d.pub) || null };
      }),
      self: { app: this.appVersion, res: this.res, catalog: this.catalog || [] },
      // v3.34 our login relays on other machines: no URL or code, only the sign-in page's host
      logins: [...this.loginsOut.values()].slice(-5).map((r) => ({ id: r.id, device: r.pub, deviceName: this.devices.find((d) => d.pub === r.pub)?.name || '?', account: r.account,
        status: r.status, ...(r.url ? { host: new URL(r.url).hostname } : {}), ...(r.prompt ? { prompt: r.prompt } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.email ? { email: r.email } : {}), at: r.at })),
      remotes: [...this.remotes].map(([pub, r]) => ({ device: pub, name: this.devices.find((d) => d.pub === pub)?.name || '?', at: r.at, ...r.snap })),
      outgoing: this.outgoing.map((o) => ({ ...o, deviceName: this.devices.find((d) => d.pub === o.pub)?.name || '?' })),
      handoffs: {
        out: [...this.handoffsOut.values()].slice(-5).map((h) => ({ id: h.id, device: h.pub, deviceName: this.devices.find((d) => d.pub === h.pub)?.name || '?', name: h.name, stage: h.stage, sent: h.sent, total: h.total, ...(h.reason ? { reason: h.reason } : {}), ...(h.applied ? { applied: h.applied } : {}), at: h.at })),
        in: [...this.handoffsIn.values()].map((h) => ({ id: h.id, device: h.pub, deviceName: this.devices.find((d) => d.pub === h.pub)?.name || '?', name: h.offer.name, dir: h.offer.dir, stage: h.stage, got: h.bytes.pack + h.bytes.bundle, total: h.offer.pack.size + (h.offer.bundle?.size || 0), at: h.at })),
      },
    };
  }

  async destroy() {
    this.destroyed = true;
    this.flushTasks();
    clearTimeout(this.pubTimer);
    for (const id of [...this.projOps.keys()]) this.endProjOp(id, { ok: false, reason: 'offline' });
    if (this.pairing) { clearTimeout(this.pairing.timer); clearInterval(this.pairing.retry); this.pairing.reject?.(new Error('cancelled')); this.pairing = null; }
    const s = this.swarm;
    this.swarm = null;
    if (s) await s.destroy().catch(() => {});
  }
}

module.exports = { Link };
