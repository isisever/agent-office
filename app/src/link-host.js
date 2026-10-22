// Device link (contract v3.28): the main-process host. Keeps the key pair and pair secrets encrypted with
// Electron safeStorage (OS keychain), the trust list in userData/link/devices.json, delivers remote commands into
// the owning project's boss tab (queued while it is busy), logs every received command, and bridges to the renderer.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require('./link-core.js');
const H = require('./handoff.js');
const { createLoginRelay } = require('./login-relay.js');

const QUEUE_MAX = 5;                    // waiting commands per project
const QUEUE_TTL_MS = 30 * 60 * 1000;    // a command that waited this long is dropped ('expired')
const SELF = 'self';                    // v3.35 the device of a task dispatched to a project of this machine
const REPORT_POLL_MS = 5000;

/**
 * @param {{ app: any, safeStorage: any, ipcMain: any, send: (ch: string, ...a: any[]) => void,
 *   notify: (title: string, body: string) => void, T: (k: string, v?: any) => string,
 *   projects: () => { id: string, name: string, engine: string }[],
 *   tabState: (projectId: string) => 'ready' | 'busy' | 'starting' | 'gone', type: (projectId: string, text: string, o?: { taskId?: string }) => boolean | void,   // false: not typed
 *   loginOf?: (projectId: string) => 'in' | 'out' | 'unknown', reportsDir?: string,
 *   onReport?: (r: { id: string, machine: string, pub: string, report: any }) => void,
 *   manage?: (op: 'start' | 'wake' | 'sleep' | 'stop', projectId: string) => { ok: boolean, reason?: string } | Promise<{ ok: boolean, reason?: string }>,
 *   loginRelay?: { spawn: (account: any, id: string, devicePub?: string) => any, accounts: () => any[], checkAuth: (account: any) => Promise<{ ok: boolean, email?: string }>, localBusy?: (accountId: string) => boolean },
 *   openExternal?: (url: string) => void,
 *   handoff?: { describe: (projectId: string) => any, release: (projectId: string) => void, lock: (projectId: string, on: boolean) => void,
 *     confirmPush: (project: string, url: string) => Promise<boolean>, confirmKeep: (project: string, device: string) => Promise<boolean>,
 *     target: (dir: string) => { root: string, memoryDir: string, factsFile: string, accountId?: string },
 *     adopt: (o: { dir: string, settings: any, sessionIds: string[], accountId?: string }) => void, pickFolder: (defaultPath: string) => Promise<string | null> } }} d
 */
function setupLink(d) {
  const dir = path.join(d.app.getPath('userData'), 'link');
  const keysFile = path.join(dir, 'keys.bin');
  const devicesFile = path.join(dir, 'devices.json');
  const logFile = path.join(dir, 'commands.log');
  const manageLog = path.join(dir, 'manage.log');   // v3.33 every project action a device asked for
  const handoffLog = path.join(dir, 'handoff.log');
  const ownersFile = path.join(dir, 'owners.json');
  const resultsFile = path.join(dir, 'handoff-results.json');   // the receiver's handoff outcomes (no secrets)
  const targets = new Map();             // incoming handoff id → the folder chosen for it
  const defaults = new Map();            // incoming handoff id → the folder used without asking ('' = the person picks)
  const answered = new Set();            // incoming handoff ids already answered (a second click does nothing)
  let link = null;
  let relay = null;                      // v3.34 login relay host (src/login-relay.js)
  let error = null;
  const queue = new Map();               // projectId → [{ id, device, text, at, reply }]

  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  function keychainOk() {
    if (!d.safeStorage.isEncryptionAvailable()) return false;
    // Linux without a keyring falls back to a hard-coded key: that is plain text in all but name
    try { if (process.platform === 'linux' && d.safeStorage.getSelectedStorageBackend() === 'basic_text') return false; } catch { /* older Electron */ }
    return true;
  }
  function loadKeys() {
    if (!fs.existsSync(keysFile)) {
      const kp = require('hyperdht').keyPair();
      return { publicKey: kp.publicKey, secretKey: kp.secretKey, secrets: {}, fresh: true };
    }
    const k = JSON.parse(d.safeStorage.decryptString(fs.readFileSync(keysFile)));
    return { publicKey: Buffer.from(k.publicKey, 'hex'), secretKey: Buffer.from(k.secretKey, 'hex'), secrets: k.secrets || {} };
  }
  function save({ name, devices, secrets }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keys = { publicKey: link.pub, secretKey: C.hex(link.keyPair.secretKey), secrets };
    fs.writeFileSync(keysFile, d.safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 });
    fs.writeFileSync(devicesFile, JSON.stringify({ name, devices }, null, 2), { mode: 0o600 });
  }

  function start() {
    if (link || error) return link;
    if (!keychainOk()) { error = 'no-keychain'; return null; }
    try {
      const keys = loadKeys();
      const saved = readJson(devicesFile) || {};
      link = new C_Link({ keyPair: { publicKey: keys.publicKey, secretKey: keys.secretKey }, name: saved.name || os.hostname().replace(/\.local$/, ''), devices: saved.devices, secrets: keys.secrets, resultsFile, reportsFile: path.join(dir, 'reports-out.json'), app: typeof d.app.getVersion === 'function' ? d.app.getVersion() : '' });
      link.on('persist', save);
      if (keys.fresh) link.persist();
      link.on('change', push);
      link.on('remote', onRemote);
      link.on('command', onCommand);
      link.on('proj-op', onProjOp);
      link.on('report', ({ device, id, report }) => d.onReport?.({ id, machine: device.name, pub: device.pub, report }));
      link.on('handoff-offer', onHandoffOffer);
      link.on('handoff-refused', ({ device, offer, reason }) => hlog({ dir: 'in', device: device.name, project: offer.name, outcome: `refused:${reason}` }));
      link.on('handoff-failed', ({ offer, reason }) => { targets.delete(offer.id); defaults.delete(offer.id); answered.delete(offer.id); hlog({ dir: 'in', project: offer.name, outcome: `failed:${reason}` }); });
      link.on('handoff-data', (x) => { applyHandoff(x).catch(() => {}); });
      link.on('handoff-late-result', onLateResult);
      link.on('handoff-status', onStatus);
      // v3.34 remote Claude login relay (host side): only when main gave a way to run `claude auth login`
      if (d.loginRelay) {
        relay = createLoginRelay({ ...d.loginRelay, logFile: path.join(dir, 'accounts.log'),
          notice: (device, label) => d.notify(d.T('main.loginRelayTitle'), d.T('main.loginRelayBody', { device, label })) });
        relay.attach(link);
      }
      // a handoff whose outcome is still unknown keeps its project locked across restarts
      for (const v of Object.values(readOwners())) if (v?.owner === 'unknown' && v.projectId) d.handoff?.lock(v.projectId, true);
      if (link.devices.length) link.ensureSwarm();
    } catch (e) {
      console.error('link:', e.message);
      error = 'keys';
      link = null;
    }
    return link;
  }
  const C_Link = require('./link.js').Link;

  const withTargets = (v) => ({ ...v, handoffs: { ...v.handoffs, in: v.handoffs.in.map((x) => ({ ...x, target: targetFor(x.id), answered: answered.has(x.id) })) } });
  function targetFor(id) {
    if (!defaults.has(id)) { const h = link?.handoffsIn.get(id); defaults.set(id, h ? H.defaultTarget(h.offer) || '' : ''); }
    return defaults.get(id);
  }
  const opStatus = new Map();            // v3.33 `${devicePub}/${projectId}` → { op, state: 'sent'|'ok'|'failed', reason?, at } (our asks)
  const view = () => ({ projOps: Object.fromEntries(opStatus), ...(link ? { ...withTargets(link.view()), error: null } : { name: os.hostname(), id: '', pairing: null, devices: [], remotes: [], outgoing: [], handoffs: { out: [], in: [] }, self: { app: '', res: null, catalog: [] }, error: error || 'off' }), owners: ownersView() });
  let pushTimer = null;
  function push() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; d.send('link:changed', view()); }, 100);
  }

  function onRemote(device, snap, prev) {
    const was = new Map((prev?.projects || []).map((p) => [p.id, p.status]));
    for (const p of snap.projects) {
      if (p.status === 'approval' && was.get(p.id) !== 'approval') d.notify(d.T('main.linkApproval', { device: device.name, project: p.name }), p.tool ? d.T('main.notifyPermissionTool', { tool: p.tool }) : '');
    }
  }

  function log(device, project, text, outcome) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(logFile, `${JSON.stringify(C.logEntry(Date.now(), device, project, text, outcome))}\n`); } catch { /* the log is best effort */ }
  }

  // --- project handoff (v3.29)
  function hlog(entry) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(handoffLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* best effort */ }
  }
  /** @returns {Record<string, { owner: string, ownerName: string, project: string, at: number, handoffId?: string, pub?: string, projectId?: string, wipPushed?: boolean, remoteName?: string, wip?: string }>} folder → who owns it ('self' or a device key) */
  const readOwners = () => { const o = readJson(ownersFile); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  /** owner 'unknown': handed to the device ownerName, outcome not known yet (extra: handoffId, pub, projectId, push data). */
  function setOwner(folder, owner, ownerName, project, extra = {}) {
    const o = readOwners();
    if (owner == null) delete o[folder];
    else o[folder] = { owner, ownerName, project, at: Date.now(), ...extra };
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(ownersFile, JSON.stringify(o, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }
  const ownersView = () => Object.entries(readOwners()).filter(([, v]) => v && v.owner && v.owner !== 'self').map(([folder, v]) => ({ dir: folder, project: String(v.project || ''), deviceName: String(v.ownerName || '?'), at: Number(v.at) || 0, unknown: v.owner === 'unknown', online: Boolean(v.pub && link?.conns.has(v.pub)) }));

  /** The receiver's result for a handoff this side had marked unknown (it applied, or not, while we were apart). */
  function onLateResult({ device, id, ok, applied, reason: _reason }) {
    const hit = Object.entries(readOwners()).find(([, v]) => v?.owner === 'unknown' && v.handoffId === id && v.pub === device.pub);
    if (!hit) return;
    const [folder, v] = hit;
    hlog({ dir: 'out', device: device.name, project: v.project, outcome: ok ? `late-done:${applied || ''}` : 'late-failed' });
    if (ok) {
      setOwner(folder, device.pub, device.name, v.project);
      if (v.wipPushed) H.deleteRemoteWip({ top: folder, remoteName: v.remoteName, wip: v.wip });
      if (v.projectId) d.handoff?.release(v.projectId);
    } else {
      setOwner(folder, null);
      if (v.projectId) d.handoff?.lock(v.projectId, false);
    }
    push();
  }

  /** The answer to "Ask again": applied / not-applied resolve it like a late result; unknown leaves it locked. */
  function onStatus({ device, id, status, applied, reason }) {
    if (status === 'applied' || status === 'not-applied') return onLateResult({ device, id, ok: status === 'applied', applied, reason });
    const hit = Object.values(readOwners()).find((v) => v?.owner === 'unknown' && v.handoffId === id && v.pub === device.pub);
    if (hit) { hlog({ dir: 'out', device: device.name, project: hit.project, outcome: 'query:unknown' }); d.notify(d.T('main.handoffStillUnknown', { project: hit.project, device: device.name }), ''); }
  }
  const unknownEntry = (folder) => { const v = readOwners()[folder]; return v?.owner === 'unknown' ? v : null; };
  /** The owners.json folder of a project whose handoff outcome is unknown, or null. */
  function unknownFor(projectId) {
    const hit = Object.entries(readOwners()).find(([, v]) => v?.owner === 'unknown' && v.projectId === projectId);
    return hit ? { dir: hit[0], project: String(hit[1].project || ''), deviceName: String(hit[1].ownerName || '?'), online: Boolean(link?.conns.has(hit[1].pub)) } : null;
  }
  /** "Ask again": re-queries the receiver (ho-query). Returns false when it is offline. */
  function askAgain(folder) {
    const v = unknownEntry(folder);
    if (!v || !link || !v.handoffId || !v.pub) return false;
    const ok = link.queryHandoff(v.pub, v.handoffId);
    hlog({ dir: 'out', device: v.ownerName, project: v.project, outcome: ok ? 'query' : 'query:offline' });
    return ok;
  }
  /** "Keep it here": after a warning that both machines may then own it, unlocks the project here and forgets the handoff. */
  async function keepHere(folder) {
    const v = unknownEntry(folder);
    if (!v || !d.handoff) return false;
    if (!(await d.handoff.confirmKeep(String(v.project || ''), String(v.ownerName || '?')))) return false;
    if (!unknownEntry(folder)) return false;   // resolved meanwhile
    setOwner(folder, null);
    if (v.projectId) d.handoff.lock(v.projectId, false);
    hlog({ dir: 'out', device: v.ownerName, project: v.project, outcome: 'kept-here', handoffId: v.handoffId });
    push();
    return true;
  }

  /** Hands a local project to a paired device. Resolves with the outcome; on success the project leaves this office. */
  async function handOff(pub, projectId) {
    const l = start();
    const dev = l?.devices.find((x) => x.pub === pub);
    if (!l || !dev || !d.handoff) return { ok: false, reason: 'not-allowed' };
    const info = d.handoff.describe(projectId);
    if (!info) return { ok: false, reason: 'unknown-project' };
    const isGit = Boolean(H.gitInfo(info.dir));
    const why = H.refusal({ engine: info.engine, busy: info.busy, git: isGit, subfolder: isGit && !H.isRepoRoot(info.dir), online: l.conns.has(pub) });
    if (why) { hlog({ dir: 'out', device: dev.name, project: info.name, outcome: `refused:${why}` }); return { ok: false, reason: why }; }
    // no prompts (typed or remote) reach the project's tabs from the snapshot until the outcome is known
    d.handoff.lock(projectId, true);
    /** @type {any} */ let r;
    let snap = null;
    let pushed = false;
    try {
      snap = H.snapshotWip(info.dir);
      if (!snap) r = { ok: false, reason: 'not-git' };
      else {
        const code = await H.prepareCode(snap, os.tmpdir(), { confirmPush: (url) => d.handoff.confirmPush(info.name, url) });
        if ('reason' in code) r = { ok: false, reason: code.reason };
        else {
          pushed = code.mode === 'remote';
          const pack = H.packSession({ root: info.root, dir: info.dir, sessionIds: info.sessionIds, memoryDir: info.memoryDir, factsFile: info.factsFile, settings: info.settings });
          hlog({ dir: 'out', device: dev.name, project: info.name, outcome: `offered:${code.mode}`, wip: snap.wip, bytes: pack.length + (code.bundle?.length || 0) });
          const s = snap;
          // just before the data goes: still idle, and nothing changed in the folder since the snapshot
          const beforeSend = () => H.changedSince(s, info.dir) || (d.handoff?.describe(projectId)?.busy ? 'busy' : null);
          r = await l.offerHandoff(pub, { name: info.name, dir: info.dir, git: { mode: code.mode, wip: snap.wip, base: snap.base, root: snap.root, branch: snap.branch, remote: snap.remote } }, { pack, bundle: code.bundle }, { beforeSend });
        }
      }
    } catch (e) { r = { ok: false, reason: String(e.message) === 'too-large' ? 'too-large' : 'bad-data' }; }
    hlog({ dir: 'out', device: dev.name, project: info.name, outcome: r.ok ? `done:${r.applied || ''}` : r.unknown ? `unknown:${r.reason}` : `failed:${r.reason}` });
    if (r.ok) {
      setOwner(info.dir, pub, dev.name, info.name);
      if (pushed && snap) H.deleteRemoteWip(snap);
      d.handoff.release(projectId);
    } else if (r.unknown) {
      // the receiver may have applied it: neither side runs it until its result comes (on the next connection)
      setOwner(info.dir, 'unknown', dev.name, info.name, { handoffId: r.id, pub, projectId, wipPushed: pushed, remoteName: snap?.remoteName || '', wip: snap?.wip || '' });
    } else {
      if (pushed && snap) H.deleteRemoteWip(snap);
      d.handoff.lock(projectId, false);
    }
    push();
    return r;
  }

  function onHandoffOffer({ device, offer }) {
    hlog({ dir: 'in', device: device.name, project: offer.name, outcome: 'offered', mode: offer.git.mode });
    d.notify(d.T('main.handoffOffer', { device: device.name, project: offer.name }), '');
    push();
  }
  /** The person's answer: on accept the folder is the sender's path when free or the same repo, else picked. */
  async function answerHandoff(l, id, accept) {
    const h = l.handoffsIn.get(id);
    if (!h || h.stage !== 'asking' || answered.has(id)) return;
    answered.add(id);
    push();
    if (!accept) { hlog({ dir: 'in', project: h.offer.name, outcome: 'declined' }); l.answerHandoff(id, false); return; }
    // the sender's path is used only when it is free or the same repository; any other folder is the person's choice
    const folder = targetFor(id) || await d.handoff?.pickFolder(h.offer.dir);
    if (!folder || !path.isAbsolute(folder)) { l.answerHandoff(id, false, 'cancelled'); return; }
    targets.set(id, folder);
    l.answerHandoff(id, true);
  }
  async function applyHandoff({ device, offer, parts, done, alive = () => true }) {
    const folder = targets.get(offer.id);
    targets.delete(offer.id);
    defaults.delete(offer.id);
    answered.delete(offer.id);
    let bundleFile = null;
    try {
      const pack = H.parsePack(parts.pack);
      if (!folder || !pack || !d.handoff) return done({ ok: false, reason: 'bad-data' });
      if (parts.bundle) { bundleFile = path.join(os.tmpdir(), `agent-office-handoff-${offer.id}.bundle`); fs.writeFileSync(bundleFile, parts.bundle, { mode: 0o600 }); }
      await H.receiveCode(folder, offer.git, bundleFile);
      const applied = H.restoreWip(folder, offer.git);
      const target = d.handoff.target(folder);   // the account of the project at this folder if there is one
      // the sender gave up meanwhile (it then still owns the project): leave the fetched branch, adopt nothing
      if (!alive() || !link?.handoffsIn.has(offer.id)) {
        hlog({ dir: 'in', device: device.name, project: offer.name, outcome: 'failed:dropped', folder });
        return done({ ok: false, reason: 'cancelled' });
      }
      H.writeSession(pack, { from: offer.dir, to: folder, root: target.root, memoryDir: target.memoryDir, factsFile: target.factsFile });
      d.handoff.adopt({ dir: folder, settings: pack.settings, sessionIds: pack.sessionIds, accountId: target.accountId });
      setOwner(folder, 'self', '', offer.name);
      hlog({ dir: 'in', device: device.name, project: offer.name, outcome: `done:${applied}`, folder });
      if (applied === 'branch-only') d.notify(d.T('main.handoffBranchOnly', { project: offer.name, branch: offer.git.wip }), '');
      done({ ok: true, applied });
    } catch (e) {
      hlog({ dir: 'in', device: device.name, project: offer.name, outcome: 'failed:apply-failed', error: C.cleanLine(e.message, 200) });
      done({ ok: false, reason: 'apply-failed' });
    } finally {
      if (bundleFile) fs.rmSync(bundleFile, { force: true });
      push();
    }
  }

  // Claude Code projects only: their busy state is known (pid file) and their prompt takes a bracketed paste.
  function onCommand({ device, id, project, text, reply, report = false }) {
    const p = d.projects().find((x) => x.id === project);
    const done = (status, reason) => { log(device.name, p?.name || project, text, `${report ? 'task:' : ''}${reason ? `${status}:${reason}` : status}`); reply(status, reason); };
    if (!p) return done('rejected', 'unknown-project');
    if (p.engine !== 'claude') return done('rejected', 'engine');
    if (report && d.loginOf?.(project) === 'out') return done('rejected', 'logged-out');   // v3.35
    const q = queue.get(project) || [];
    if (q.length >= QUEUE_MAX) return done('rejected', 'queue-full');
    q.push({ id, device, text, at: Date.now(), reply, report });
    queue.set(project, q);
    done('queued');
    pump();
  }
  function pump() {
    const now = Date.now();
    for (const [project, q] of queue) {
      while (q.length) {
        const c = q[0];
        if (c.device.pub !== SELF && !link?.devices.some((x) => x.pub === c.device.pub)) { q.shift(); continue; }   // removed meanwhile
        if (now - c.at > QUEUE_TTL_MS) { q.shift(); c.reply('rejected', 'expired'); continue; }
        const s = d.tabState(project);
        if (s === 'gone') { q.shift(); c.reply('rejected', 'not-running'); continue; }
        // 'busy' and 'starting' (no session id or no first prompt yet: the trust dialog may be up, v3.31) wait
        if (s !== 'ready') break;
        q.shift();
        // type() → false: not typed (the project got handoff-locked meanwhile): refused, never 'delivered'
        if (c.report) {
          // v3.35: the plugin reports on the marked task (hooks/reports.ts); its report is owed to the dispatcher
          if (d.type(project, C.markedTask(c.id, c.device.name, c.text), { taskId: c.id }) === false) { c.reply('rejected', 'locked'); break; }
          if (c.device.pub === SELF) localTasks.add(c.id); else link?.expectReport(c.id, c.device.pub);
        } else if (d.type(project, C.markedCommand(c.device.name, c.text)) === false) { c.reply('rejected', 'not-running'); break; }   // v1-safe reason
        c.reply('delivered');
        break;                                     // one per project per tick: the tab is busy after a prompt
      }
      if (!q.length) queue.delete(project);
    }
  }
  // --- v3.33 project actions from a device allowed to manage (proj-op): one at a time, logged, a notice here
  const opQueue = [];
  let opRunning = false;
  function mlog(entry) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.appendFileSync(manageLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
  }
  function onProjOp({ device, id, op, project, reply }) {
    if (opQueue.length >= QUEUE_MAX * 4) { mlog({ device: device.name, op, project, outcome: 'rejected:rate-limited' }); return reply(false, 'rate-limited'); }
    opQueue.push({ device, id, op, project, reply });
    runOps();
  }
  async function runOps() {
    if (opRunning) return;
    opRunning = true;
    try {
      while (opQueue.length) {
        const o = opQueue.shift();
        const p = d.projects().find((x) => x.id === o.project);
        const name = p?.name || o.project;
        // removed meanwhile: dropped, never run, no answer
        if (!link?.devices.some((x) => x.pub === o.device.pub)) { mlog({ device: o.device.name, op: o.op, project: name, outcome: 'dropped:removed' }); continue; }
        /** @type {{ ok: boolean, reason?: string }} */ let r;
        if (!p) r = { ok: false, reason: 'unknown-project' };
        else if (!d.manage) r = { ok: false, reason: 'failed' };
        else {
          try { r = await d.manage(o.op, p.id); } catch { r = { ok: false, reason: 'failed' }; }
          if (!r || typeof r.ok !== 'boolean') r = { ok: false, reason: 'failed' };
        }
        const reason = r.ok ? undefined : (C.PROJ_OP_REASONS.includes(r.reason) ? r.reason : 'failed');
        mlog({ device: o.device.name, op: o.op, project: name, outcome: r.ok ? 'ok' : `rejected:${reason}` });
        if (r.ok) d.notify(d.T('main.projOpNotice', { device: o.device.name, project: name, op: d.T(`machines.op.${o.op}`) }), '');
        o.reply(r.ok, reason);
      }
    } finally { opRunning = false; }
  }
  /** Asks a paired device to start / wake / sleep / stop one of its projects; the outcome shows in the view. */
  async function projOp(pub, projectId, op) {
    const l = link;
    if (!l) return { ok: false, reason: 'offline' };
    const key = `${pub}/${projectId}`;
    opStatus.set(key, { op, state: 'sent', at: Date.now() });
    push();
    const r = await l.sendProjOp(pub, projectId, op);
    if (l.devices.some((x) => x.pub === pub)) opStatus.set(key, { op, state: r.ok ? 'ok' : 'failed', ...(r.reason ? { reason: r.reason } : {}), at: Date.now() });
    else opStatus.delete(key);
    push();
    return r;
  }

  const pumpTimer = setInterval(pump, 1500);
  pumpTimer.unref?.();

  // --- v3.35 one boss: dispatch (office_dispatch) and the reports of dispatched tasks
  const localTasks = new Set();            // ids of tasks dispatched to a project of this machine (until reported)
  const newId = () => require('crypto').randomBytes(8).toString('hex');
  /** A task for a project of this machine: the same queue and checks as a remote one. → { id, status, reason? } */
  /** onStatus(id, status, reason?) hears every status (queued, then delivered or rejected), also the later ones. */
  function dispatchLocal(projectId, text, fromName, onStatus) {
    const s = C.sanitizeCommand(text);
    const id = newId();
    if (!s.ok) return { id, status: 'rejected', reason: s.reason };
    /** @type {any} */ let out = null;   // the latest answer so far ('delivered' may follow 'queued' at once)
    onCommand({ device: { pub: SELF, name: fromName }, id, project: projectId, text: s.text, report: true, reply: (status, reason) => {
      out = { id, status, ...(reason ? { reason } : {}) };
      try { onStatus?.(id, status, reason); } catch { /* the caller's record */ }
    } });
    return out || { id, status: 'queued' };
  }
  /** A task for a project of a paired device (cmd with report, cap 'report'). Offline: refused, nothing queued. */
  function dispatchRemote(pub, projectId, text) {
    const l = link;
    if (!l || !l.devices.some((x) => x.pub === pub)) return { id: '', status: 'rejected', reason: 'unknown-machine' };
    const rec = l.sendCommand(pub, projectId, text, { report: true });
    return { id: rec.id, status: rec.status, ...(rec.reason ? { reason: rec.reason } : {}) };
  }
  /** The reports the plugin wrote (<data dir>/reports/<id>.json): sent to the dispatcher, or handed to main. */
  function scanReports() {
    const rdir = d.reportsDir;
    if (!rdir) return;
    let names = [];
    try { names = fs.readdirSync(rdir).filter((n) => /^[A-Za-z0-9_.:-]{1,64}\.json$/.test(n)); } catch { return; }
    for (const n of names) {
      const f = path.join(rdir, n);
      const id = n.slice(0, -5);
      const report = readJson(f);
      let used = false;
      if (report && localTasks.has(id)) { localTasks.delete(id); d.onReport?.({ id, machine: '', pub: SELF, report: C.cleanReport(report) }); used = true; }
      else if (report && link?.owesReport(id)) used = link.sendReport(id, report);
      let old = false;
      try { old = Date.now() - fs.statSync(f).mtimeMs > 24 * 3600 * 1000; } catch { /* gone */ }
      if (used || old || !report) fs.rmSync(f, { force: true });
    }
  }
  const reportTimer = setInterval(scanReports, REPORT_POLL_MS);
  reportTimer.unref?.();

  const ipc = (ch, fn) => d.ipcMain.handle(ch, async (_e, ...a) => { const l = start(); if (!l) return view(); await fn(l, ...a); return view(); });
  d.ipcMain.handle('link:get', () => { start(); return view(); });
  ipc('link:invite', (l) => l.invite());
  d.ipcMain.handle('link:join', async (_e, code) => {
    const l = start();
    if (!l) return { ok: false, error: error || 'off', view: view() };
    try { await l.join(code); return { ok: true, view: view() }; } catch (e) { return { ok: false, error: String(e.message || e), view: view() }; }
  });
  ipc('link:cancel', (l) => l.cancelPairing());
  ipc('link:setName', (l, name) => l.setName(String(name || '')));
  ipc('link:rename', (l, id, name) => l.rename(String(id), String(name || '')));
  ipc('link:setAllow', (l, id, on) => l.setAllow(String(id), on === true));
  ipc('link:remove', (l, id) => { for (const k of [...opStatus.keys()]) if (k.startsWith(`${id}/`)) opStatus.delete(k); return l.remove(String(id)); });
  ipc('link:projOp', (_l, id, project, op) => { projOp(String(id), String(project), String(op)); });   // v3.33: the outcome comes in a later view
  ipc('link:setAllowHandoff', (l, id, on) => l.setAllowHandoff(String(id), on === true));
  ipc('link:setAllowManage', (l, id, on) => l.setAllowManage(String(id), on === true));       // v3.31
  ipc('link:setAllowAccounts', (l, id, on) => l.setAllowAccounts(String(id), on === true));   // v3.31
  ipc('link:handoffAnswer', (l, id, accept) => answerHandoff(l, String(id), accept === true));
  ipc('link:handoffAsk', (_l, folder) => askAgain(String(folder)));
  ipc('link:handoffKeep', (_l, folder) => keepHere(String(folder)));
  ipc('link:send', (l, id, project, text) => l.sendCommand(String(id), String(project), String(text ?? '')));
  // v3.34 login relay (asking side): start, open the sign-in page here, send the pasted code, cancel
  d.ipcMain.handle('link:loginStart', (_e, id, account) => { const l = start(); return l ? l.startRemoteLogin(String(id), String(account)) : { ok: false, reason: 'offline' }; });
  d.ipcMain.handle('link:loginCode', (_e, id, code) => { const l = start(); return l ? l.sendLoginCode(String(id), String(code ?? '')) : { ok: false, reason: 'offline' }; });
  ipc('link:loginCancel', (l, id) => l.cancelRemoteLogin(String(id)));
  d.ipcMain.handle('link:loginOpen', (_e, id) => {
    const url = start()?.loginUrl(String(id));
    if (!url || !C.loginUrlOk(url)) return false;   // checked again right before it is opened
    d.openExternal?.(url);
    return true;
  });

  // Start at launch only when something is paired: a user who never pairs never touches the DHT.
  if (fs.existsSync(devicesFile)) start();

  return {
    publish(projects, office, attention) { if (link) link.publish(C.snapshotOf(projects, office, attention)); },
    /** v3.32: this machine's resources (C.resOf) and project catalog; the link sends them by capability and opt-in. */
    publishMachine(res, catalog, accounts) { if (link) { link.publishRes(res); link.publishCatalog(catalog); if (accounts) link.publishAccounts(accounts); } },
    pump, dispatchLocal, dispatchRemote, scanReports, projOp,
    /** The Link (tests; null while off). */
    link: () => link,
    /** Paired devices a project can be handed to (online ones first). */
    devices() { const l = start(); return l ? l.devices.map((x) => ({ id: x.pub, name: x.name, online: l.conns.has(x.pub) })) : []; },
    handOff, unknownFor, askAgain, keepHere,
    destroy() { clearInterval(pumpTimer); clearInterval(reportTimer); relay?.destroy(); return link?.destroy(); },
  };
}

module.exports = { setupLink };
