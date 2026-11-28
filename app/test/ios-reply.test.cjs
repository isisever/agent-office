// A phone's reply path after ctl-send (v0.22.56): a send always goes to the project's main tab, which may only be started by it.
// The host follows the main session across a new session file, a reader on an older sid never does, and a stopped project has
// no session (refused 'no-session') until its transcript exists. Project "video atölyesi" (hex id, non-ASCII name) is the case.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/link-core.js');
const { Link } = require('../src/link.js');
const PA = C.hex(Buffer.alloc(32, 1));
const ID = '7a5e8f7aea35';
const line = (o) => `${JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', ...o })}\n`;
const turn = (u, a) => line({ type: 'user', uuid: `u-${u}`, message: { content: u } }) + line({ type: 'assistant', uuid: `a-${a}`, message: { content: [{ type: 'text', text: a }] } });

test('after ctl-send starts a stopped project the phone re-opens and gets the reply from the new session; an old sid stays behind', async (t) => {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-reply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldFile = path.join(dir, 'old.jsonl');
  const newFile = path.join(dir, 'new.jsonl');
  fs.writeFileSync(oldFile, turn('first', 'old answer'));
  let captured = null;
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; });
  const handlers = new Map();
  const notices = [];
  // stopped project: no main session yet; "old" is an earlier session the phone could have picked from the list
  const sessions = { [ID]: { reason: 'no-session' }, [`${ID}/old`]: { file: oldFile } };
  const host = setupLink({
    app: { getPath: () => dir, getVersion: () => '0.23.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, send: () => {}, notify: (title) => notices.push(title), T: (k, v) => `${k}:${v ? JSON.stringify(v) : ''}`, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => [{ id: 'p1', name: 'shop', engine: 'claude' }, { id: '7a5e8f7aea35', name: 'video atölyesi', engine: 'claude' }], tabState: () => 'ready', type: () => {},
    sessionOf: (id, sid) => (sid ? sessions[`${id}/${sid}`] : sessions[id]),
  });
  t.after(() => host.destroy());
  host.devices();
  const link = captured;
  const pushed = [];
  link.sessPush = (key, items, o) => { pushed.push({ key, items, o }); return true; };
  const refused = [];
  const open = (key, sid) => link.emit('sess-open', { key, device: { pub: PA, name: 'iPhone' }, id: key, project: ID, sid, refuse: (why) => refused.push([key, why]) });
  open('main1');   // the phone opened the project before the send: nothing to read yet, the phone retries (scheduleReopen)
  open('old1', 'old');
  assert.deepEqual(refused, [['main1', 'no-session']]);
  assert.equal(pushed.filter((p) => p.key === 'old1').length, 1);
  // ctl-send starts the main tab: its new session file appears with the reply
  fs.writeFileSync(newFile, turn('hello', 'the reply'));
  sessions[ID] = { file: newFile };
  open('main2');   // the phone re-opens after the 'queued' ack
  const reply = pushed.filter((p) => p.key === 'main2').flatMap((p) => p.items.map((x) => x.text));
  assert.deepEqual(reply, ['hello', 'the reply']);
  // an open on the old sid never carries the new session: nothing for it after the reply was written
  const before = pushed.filter((p) => p.key === 'old1').length;
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(pushed.filter((p) => p.key === 'old1').length, before);
  // the main reader follows the main tab when it moves to yet another session file (a resume that forks)
  const next = path.join(dir, 'next.jsonl');
  fs.writeFileSync(next, turn('again', 'second reply'));
  sessions[ID] = { file: next };
  await new Promise((r) => setTimeout(r, 1300));
  const follow = pushed.filter((p) => p.key === 'main2').flatMap((p) => p.items.map((x) => x.text));
  assert.ok(follow.includes('second reply'));
  assert.equal(notices.length, 1);   // one notice, not one per re-open
});

test('ctl-send acks: queued when the host accepts, the reason when it refuses (stopped project, no window)', () => {
  const { EventEmitter } = require('events');
  const pub = 'cc'.repeat(32);
  const l = Object.create(Link.prototype);
  EventEmitter.call(l);
  const dev = { pub, name: 'Phone', kind: 'controller', own: false, ctl: true };
  Object.assign(l, { devices: [dev], secrets: { [pub]: 'ee'.repeat(32) }, peers: new Map(), sessOut: new Map(), sessOpens: new Map(), ctlConns: new Map(), ctlSeq: 0,
    now: () => 1000, ctlHq: 'idle', name: 'Desk', limiter: new C.RateLimiter({ now: () => 1000 }), queryLimiter: new C.RateLimiter({ burst: 16, everyMs: 2000, now: () => 1000 }),
    snap: { projects: [{ id: ID, name: 'video atölyesi', engine: 'claude', status: 'idle', working: 0, attention: null }], workers: [], delivered: 0 } });
  l.sealed = () => l.devices;
  const sent = [];
  l.write = (conn, m) => sent.push(m);
  l.emit = EventEmitter.prototype.emit.bind(l);
  l.on = EventEmitter.prototype.on.bind(l);
  l.listenerCount = EventEmitter.prototype.listenerCount.bind(l);
  const conn = { destroyed: false, destroy() { this.destroyed = true; } };
  l.handleCtl(conn, dev, { t: 'hello', v: 2, caps: ['ctl', 'sess', 'ctl2'] });
  sent.length = 0;
  for (const r of ['ok', 'not-running', 'locked', 'engine', 'weird']) {
    l.once('ctl-op', ({ reply }) => reply(r));
    l.handleCtl(conn, dev, { t: 'ctl-send', id: `a-${r}`, project: ID, text: 'hello' });
  }
  const acks = sent.filter((m) => m.t === 'ctl-ack');
  assert.deepEqual(acks.map((m) => [m.status, m.reason]), [['queued', undefined], ['rejected', 'not-running'], ['rejected', 'locked'], ['rejected', 'engine'], ['rejected', 'failed']]);
});

test('main.js ctlOp starts or resumes a stopped project with the message; Swift follows the main session after a send', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /if \(!t && win && isLoaded && !handoffLocked\(id\) && String\(text \|\| ''\)\.trim\(\)\) \{[^}]*startPty\(id, \{ resume: true, prompt: text, forcePrompt: true \}\)/);
  const root = path.join(__dirname, '..', '..', 'ios', 'AgentOfficeRemote');
  const sw = fs.readFileSync(path.join(root, 'Sessions.swift'), 'utf8');
  assert.match(sw, /followMain = true; link\.watch\(projectId, sid: nil\)/);
  const wm = fs.readFileSync(path.join(root, 'WorkletModel.swift'), 'utf8');
  assert.match(wm, /status == "queued", wanted\[a\.project\] != nil/);
});
