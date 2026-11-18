// HQ Phase 2 (contract v3.48): the link protocol for remote HQ tasks. Two src/link.js instances talk over an in-memory
// pipe with a fake clock: live task-status, resync after a restart on either side, the offline outbox (deliver, expire,
// cancel), remote Cancel, an older peer without the new caps, and report truncation.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('../src/link-core.js');
const { Link } = require('../src/link.js');
const HQ = require('../src/hq.js');

const OLD_CAPS = ['res', 'catalog', 'report', 'manage', 'accounts'];   // a v3.47 peer
const kp = (n) => ({ publicKey: Buffer.alloc(32, n), secretKey: Buffer.alloc(64, n) });
const PA = C.hex(kp(1).publicKey);
const PB = C.hex(kp(2).publicKey);
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const swarmFactory = () => ({ join: () => ({ flushed: async () => {}, refresh: async () => {} }), on: () => {}, leave: async () => {}, destroy: async () => {} });

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hqp2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: 1e9 };
  const links = [];
  const make = (who, { caps = null } = {}) => {
    const me = who === 'A' ? 1 : 2;
    const other = who === 'A' ? PB : PA;
    const l = new Link({ keyPair: kp(me), name: who === 'A' ? 'Studio' : 'Laptop', swarmFactory, now: () => clock.now, heartbeatMs: 60000,
      reportsFile: path.join(dir, who, 'reports-out.json'), tasksFile: path.join(dir, who, 'tasks-out.json'), seenFile: path.join(dir, who, 'tasks-seen.json') });
    l.devices = [{ pub: other, name: who === 'A' ? 'Laptop' : 'Studio', addedAt: 0, allowCommands: true, allowHandoff: false, allowManage: false, allowAccounts: false }];
    l.secrets = { [other]: 'ab'.repeat(32) };
    if (caps) l.helloMsg = () => ({ t: 'hello', v: 2, name: l.name, caps });
    l.wire = [];   // every message this link wrote
    const w = l.write.bind(l);
    l.write = (conn, m) => { l.wire.push(m); return w(conn, m); };
    links.push(l);
    t.after(() => l.destroy());
    return l;
  };
  /** Connects two links: both sessions start, then the hellos cross (delivery is async, like a socket). */
  const connect = async (a, b) => {
    const x = new EventEmitter(); const y = new EventEmitter();
    for (const [p, q] of [[x, y], [y, x]]) {
      p.destroyed = false;
      p.write = (line) => { if (!p.destroyed) setImmediate(() => { if (!q.destroyed) q.emit('data', Buffer.from(line)); }); return true; };
      p.destroy = () => { if (p.destroyed) return; p.destroyed = q.destroyed = true; p.emit('close'); q.emit('close'); };
    }
    a.session(x, a.devices[0], 'test');
    b.session(y, b.devices[0], 'test');
    await flush();
    return () => { x.destroy(); };
  };
  return { dir, clock, make, connect };
}
/** The runner's host (link-host's part): queues each command and answers like pump() would. */
function runner(b) {
  const got = [];
  b.on('command', (c) => { got.push(c); c.reply('queued'); });
  return got;
}
const WHY = { state: 'busy', pos: 2, len: 3, expiresIn: 3600 * 1000 };

test('v3.48 caps and messages: task-status / task-query / task-cancel / cmd.ttl / report2 validated', () => {
  assert.ok(C.OUR_CAPS.includes('task-status') && C.OUR_CAPS.includes('report2') && C.CAPS.includes('task-status'));
  assert.deepEqual(C.validateMessage({ t: 'task-status', id: 'a1', state: 'queued', why: { ...WHY, extra: 1 } }), { t: 'task-status', id: 'a1', state: 'queued', why: WHY });
  assert.deepEqual(C.validateMessage({ t: 'task-status', id: 'a1', state: 'running', why: WHY }), { t: 'task-status', id: 'a1', state: 'running' });   // why only for queued
  assert.equal(C.validateMessage({ t: 'task-status', id: 'a1', state: 'approved' }), null);
  assert.equal(C.validateMessage({ t: 'task-status', id: 'a1', state: 'rejected', reason: 'because' }), null);
  assert.equal(C.validateMessage({ t: 'task-query', ids: [] }), null);
  assert.equal(C.validateMessage({ t: 'task-query', ids: new Array(51).fill('a') }), null);
  assert.deepEqual(C.validateMessage({ t: 'task-query', ids: ['a', 'a', 'b'] }), { t: 'task-query', ids: ['a', 'b'] });
  assert.equal(C.validateMessage({ t: 'task-cancel', id: '../x' }), null);
  assert.equal(C.validateMessage({ t: 'cmd', id: 'c', project: 'p', text: 'hi', ttl: 5 * 3600 * 1000 }).ttl, undefined);   // over 4 h: dropped
  assert.equal(C.validateMessage({ t: 'cmd', id: 'c', project: 'p', text: 'hi', ttl: 4 * 3600 * 1000 }).ttl, 4 * 3600 * 1000);
});

test('v3.48 report2: larger cap with a marker, PR/artifact/transcript fields cleaned, one frame always fits', () => {
  const long = 'é'.repeat(100000);
  const fit = C.fitReport({ summary: long, commits: [], prs: ['https://github.com/a/b/pull/1', 'http://evil/x', 'javascript:alert(1)'], artifacts: ['out.png', '../etc/passwd', 'a/b'], transcriptRef: '/Users/x/t.jsonl' }, true, 'id1');
  assert.ok(Buffer.byteLength(JSON.stringify({ t: 'cmd-report', id: 'id1', ...fit })) <= C.MAX_FRAME);
  assert.ok(fit.summary.endsWith(C.TRUNC_MARK) && fit.truncated === true);
  assert.deepEqual(fit.prs, ['https://github.com/a/b/pull/1']);
  assert.deepEqual(fit.artifacts, ['out.png']);
  assert.equal(fit.transcriptRef, undefined);
  const v2 = C.cleanReport({ summary: 'x'.repeat(30000), commits: new Array(40).fill({ hash: 'abcd1234', subject: 's' }), transcriptRef: '0b5e7c1d-1111-2222-3333-444455556666' }, true);
  assert.equal(v2.summary.length, 30000);   // over the old 16 KB, under 40 KB: whole
  assert.equal(v2.commits.length, C.REPORT2_COMMITS);
  assert.equal(v2.transcriptRef, '0b5e7c1d-1111-2222-3333-444455556666');
  const v1 = C.fitReport(v2, false);
  assert.ok(v1.summary.length <= C.REPORT_MAX && v1.summary.endsWith(C.TRUNC_MARK) && v1.truncated);
  assert.equal(v1.commits.length, 12);
  assert.equal(v1.transcriptRef, undefined);   // an older dispatcher gets the v3.35 shape only
  assert.equal(C.cleanReport({ summary: 'short', commits: [] }, true).truncated, undefined);
});

test('v3.48 live status: queued with why, delivered, running, needs-approval (only shown), reported with report2 fields', async (t) => {
  const { clock, make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'fix the login bug', { report: true, ttl: HQ.HQ_TTL_MS });
  await flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].ttl, HQ.HQ_TTL_MS);   // the 4 h wait reaches the runner (cap task-status)
  assert.equal(a.sentTask(rec.id).status, 'queued');
  b.taskState(rec.id, 'queued', WHY);
  await flush();
  const r = a.sentTask(rec.id);
  assert.deepEqual({ state: r.why.state, pos: r.why.pos, len: r.why.len }, { state: 'busy', pos: 2, len: 3 });
  assert.equal(r.why.expiresAt, clock.now + WHY.expiresIn);
  // throttle: the same why is not resent; a new position within 5 s waits; after 5 s it goes
  const n = () => b.wire.filter((m) => m.t === 'task-status').length;
  const before = n();
  b.taskState(rec.id, 'queued', WHY);
  b.taskState(rec.id, 'queued', { ...WHY, pos: 1 });
  assert.equal(n(), before);
  clock.now += 5001;
  b.taskState(rec.id, 'queued', { ...WHY, pos: 1 });
  assert.equal(n(), before + 1);
  got[0].reply('delivered');
  b.taskState(rec.id, 'running');
  await flush();
  assert.equal(a.sentTask(rec.id).status, 'running');
  assert.equal(a.sentTask(rec.id).text, undefined);   // the task text is gone from the dispatcher's disk once typed
  b.taskState(rec.id, 'needs-approval');
  await flush();
  assert.equal(a.sentTask(rec.id).status, 'needs-approval');
  assert.deepEqual(HQ.boardOfRemote(a.sentTask(rec.id)), { status: 'needs-approval' });
  // nothing on the wire can answer a prompt there: the dispatcher only ever sent hello/cmd/acks, the runner only statuses
  assert.deepEqual([...new Set(a.wire.map((m) => m.t))].sort(), ['cmd', 'hello']);
  const reports = [];
  a.on('report', (x) => reports.push(x));
  b.expectReport(rec.id, PA, 'p1');
  b.sendReport(rec.id, { ok: true, partial: false, summary: 'done https://github.com/o/r/pull/7', commits: [], at: 1, prs: ['https://github.com/o/r/pull/7'], transcriptRef: 'abcdef12-0000' });
  await flush();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].report.prs, ['https://github.com/o/r/pull/7']);
  assert.equal(reports[0].report.transcriptRef, 'abcdef12-0000');
  assert.equal(a.sentTask(rec.id).status, 'reported');
  const board = HQ.applyReport(HQ.addTask(HQ.emptyBoard(), { id: rec.id, request: 'r', status: 'running', pub: PB }, 1), rec.id, reports[0].report);
  assert.deepEqual(board.tasks[0].prs, ['https://github.com/o/r/pull/7']);
  assert.equal(board.tasks[0].transcript, 'abcdef12-0000');
});

test('v3.48 resync: the dispatcher restarts (records persist), asks on hello and gets the real status', async (t) => {
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  const drop = await connect(a, b);
  const r1 = a.sendCommand(PB, 'p1', 'one', { report: true });
  const r2 = a.sendCommand(PB, 'p1', 'two', { report: true });
  await flush();
  got[0].reply('delivered');
  b.taskState(r1.id, 'running');
  await flush();
  drop();
  await flush();
  assert.equal(a.sentTask(r2.id).status, 'unknown');   // its answers came on the closed connection
  await a.destroy();
  const a2 = make('A');   // restart: the records come back from tasks-out.json (0600)
  assert.equal((fs.statSync(a2.tasksFile).mode & 0o777).toString(8), '600');
  assert.equal(a2.sentTask(r1.id).status, 'running');
  assert.equal(a2.sentTask(r2.id).status, 'unknown');
  assert.equal(HQ.remoteOpen(a2.sentTask(r2.id)), true);   // the board keeps the card open (no lost-on-restart)
  b.taskState(r2.id, 'queued', WHY);
  await connect(a2, b);
  assert.deepEqual(a2.wire.find((m) => m.t === 'task-query').ids.sort(), [r1.id, r2.id].sort());
  assert.equal(a2.sentTask(r1.id).status, 'running');
  assert.equal(a2.sentTask(r2.id).status, 'queued');
  assert.equal(a2.sentTask(r2.id).why.state, 'busy');
  assert.equal(got.length, 2);   // nothing typed twice
});

test('v3.48 resync: the runner restarts (its queue is gone), the task is sent again once and never typed twice', async (t) => {
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  const drop = await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'queued then lost', { report: true });
  const done = a.sendCommand(PB, 'p1', 'typed', { report: true });
  await flush();
  got[1].reply('delivered');
  await flush();
  drop();
  await b.destroy();
  const b2 = make('B');
  const got2 = runner(b2);
  assert.equal(b2.seen.has(rec.id), false);   // queued at the restart: forgotten (memory-only queue)
  assert.equal(b2.seen.get(done.id).state, 'delivered');
  await connect(a, b2);
  await flush();
  assert.deepEqual(got2.map((c) => c.id), [rec.id]);   // 'unknown' → resent from the dispatcher's kept text
  assert.equal(a.sentTask(rec.id).status, 'queued');
  assert.equal(a.sentTask(done.id).status, 'delivered');
  // a repeat of the same id (a second resend) is answered with its status, not typed
  a.writeCmd(a.conns.get(PB), a.sentTask(rec.id), 'queued then lost');
  await flush();
  assert.equal(got2.length, 1);
  assert.ok(b2.wire.some((m) => m.t === 'task-status' && m.id === rec.id && m.state === 'queued'));
});

test('v3.48 outbox: held while offline, sent once on hello (paced), expires after its TTL, Cancel works', async (t) => {
  const { clock, make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  const held = [1, 2, 3, 4].map((i) => a.sendCommand(PB, 'p1', `task ${i}`, { report: true, hold: true, projectName: 'shop', ttl: HQ.HQ_TTL_MS }));
  for (const r of held) assert.equal(a.sentTask(r.id).status, 'held');
  assert.deepEqual(HQ.boardOfRemote(a.sentTask(held[0].id)), { status: 'queued', reason: 'offline' });
  assert.equal(a.sentTask(held[0].id).projectName, 'shop');
  const cancelled = a.sendCommand(PB, 'p1', 'never mind', { report: true, hold: true });
  assert.deepEqual(a.cancelTask(cancelled.id), { ok: true });
  assert.deepEqual(HQ.boardOfRemote(a.sentTask(cancelled.id)), { status: 'rejected', reason: 'cancelled' });
  // without hold an offline device is still refused (Phase 1 behaviour for project bosses)
  assert.equal(a.sendCommand(PB, 'p1', 'x', { report: true }).status, 'rejected');
  // expiry: another held task waits past the outbox TTL
  const old = a.sendCommand(PB, 'p1', 'too old', { report: true, hold: true });
  a.sentTask(old.id).expiresAt = clock.now - 1;
  a.pumpOutbox();
  assert.equal(a.sentTask(old.id).status, 'expired');
  assert.equal(a.sentTask(old.id).text, undefined);
  await connect(a, b);
  assert.deepEqual(got.map((c) => c.text), ['task 1', 'task 2', 'task 3']);   // burst 3, oldest first
  assert.equal(a.sentTask(held[3].id).status, 'held');
  clock.now += 10001;
  a.pumpOutbox();
  await flush();
  assert.deepEqual(got.map((c) => c.text), ['task 1', 'task 2', 'task 3', 'task 4']);
  assert.ok(got.every((c) => c.ttl === HQ.HQ_TTL_MS));
  assert.equal(got.filter((c) => c.text === 'never mind' || c.text === 'too old').length, 0);
  a.pumpOutbox();
  await flush();
  assert.equal(got.length, 4);   // each exactly once
});

test('v3.48 remote Cancel: a task queued there leaves its queue; a typed one cannot be cancelled', async (t) => {
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  b.on('task-cancel', ({ id, answer }) => { const c = got.find((x) => x.id === id); if (c && !c.done) { c.done = true; c.reply('rejected', 'cancelled'); } else answer(); });
  await connect(a, b);
  const r1 = a.sendCommand(PB, 'p1', 'queued', { report: true });
  const r2 = a.sendCommand(PB, 'p1', 'typed', { report: true });
  await flush();
  got[1].done = true;
  got[1].reply('delivered');
  await flush();
  assert.deepEqual(a.cancelTask(r1.id), { ok: true, pending: true });
  await flush();
  assert.deepEqual(HQ.boardOfRemote(a.sentTask(r1.id)), { status: 'rejected', reason: 'cancelled' });
  assert.deepEqual(a.cancelTask(r2.id), { ok: false, reason: 'not-queued' });
});

test('v3.48 old peer: no new caps → plain v3.35 cmd, no task-query, no remote cancel, v1-shaped reports', async (t) => {
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B', { caps: OLD_CAPS });
  const got = runner(b);
  const drop = await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'old peer task', { report: true, ttl: HQ.HQ_TTL_MS });
  await flush();
  const cmd = a.wire.find((m) => m.t === 'cmd');
  assert.equal(cmd.ttl, undefined);
  assert.equal(got[0].ttl, undefined);
  assert.equal(a.sentTask(rec.id).status, 'queued');
  assert.deepEqual(a.cancelTask(rec.id), { ok: false, reason: 'no-cap' });
  got[0].reply('delivered');
  await flush();
  drop();
  await flush();
  await connect(a, b);
  assert.equal(a.wire.filter((m) => m.t === 'task-query').length, 0);
  assert.equal(a.sentTask(rec.id).status, 'delivered');   // its report may still come (reports-out persists there)
  assert.equal(b.wire.filter((m) => m.t === 'task-status').length, 0);
  // the other direction: a v3.48 runner reporting to an older dispatcher sends the v3.35 shape, cut with the marker
  const { make: make2, connect: connect2 } = world(t);
  const oldA = make2('A', { caps: OLD_CAPS }); const newB = make2('B');
  runner(newB);
  await connect2(oldA, newB);
  newB.expectReport('t1', PA, 'p1');
  newB.sendReport('t1', { ok: true, partial: false, summary: 'z'.repeat(30000), commits: [], at: 1, prs: ['https://github.com/o/r/pull/1'] });
  const sent = newB.wire.find((m) => m.t === 'cmd-report');
  assert.ok(sent.summary.length <= C.REPORT_MAX && sent.summary.endsWith(C.TRUNC_MARK));
  assert.equal(sent.prs, undefined);
});

test('v3.48 wiring: HQ holds offline dispatches, Cancel reaches remote cards, restart keeps remote rows, test.yml runs this file', () => {
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'app', 'main.js'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'app', 'src', 'link-host.js'), 'utf8');
  assert.match(main, /officeDispatch\(HQ\.HQ_ID, \{ machine: pub, project: pid, task \}, \{ hold: true, ttl: HQ\.HQ_TTL_MS, revive: true \}\)/);
  assert.match(main, /linkHost\?\.cancelRemote\(id\)/);
  assert.match(main, /HQ\.remoteOpen\(linkHost\?\.remoteTask\(t\.id\)\)/);
  assert.match(host, /link\.on\('task-cancel', onTaskCancel\)/);
  assert.match(host, /attentionOf\?\.\(t\.project\) === 'permission' \? 'needs-approval'/);
  assert.match(fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8'), /app\/test\/hq-link\.test\.cjs/);
});

// --- Phase 2 review fixes

test('v3.48 review 1: an old runner (no repeat check) never gets a task twice after a drop or a dispatcher restart', async (t) => {
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B', { caps: OLD_CAPS });
  // a real v3.47 runner: no tasks-seen, every cmd it hears is a new command (it may type it while we are apart)
  const typed = [];
  b.receiveCommand = (conn, d, m) => { typed.push(m.id); b.write(conn, { t: 'cmd-status', id: m.id, status: 'queued' }); };
  let drop = await connect(a, b);
  const q = a.sendCommand(PB, 'p1', 'queued there', { report: true });
  await flush();
  assert.equal(a.sentTask(q.id).status, 'queued');
  b.receiveCommand = (conn, d, m) => { typed.push(m.id); };   // this one hears nothing back: stays 'sent'
  const s = a.sendCommand(PB, 'p1', 'sent, no answer', { report: true });
  await flush();
  assert.equal(a.sentTask(s.id).status, 'sent');
  drop();
  await flush();
  assert.equal(a.sentTask(s.id).text, undefined);   // not kept for a resend
  drop = await connect(a, b);
  await flush();
  assert.deepEqual(typed, [q.id, s.id]);   // each exactly once
  for (const id of [q.id, s.id]) assert.deepEqual(HQ.boardOfRemote(a.sentTask(id)), { status: 'lost', reason: 'unknown' });
  // the dispatcher restarts while a task is out there: still never sent again
  const r = a.sendCommand(PB, 'p1', 'out at the restart', { report: true });
  await flush();
  drop();
  await a.destroy();
  const a2 = make('A');
  await connect(a2, b);
  await flush();
  assert.equal(typed.filter((x) => x === r.id).length, 1);
  assert.equal(a2.sentTask(r.id).status, 'lost');
});

test('v3.48 review 2: a send refused as rate-limited is not remembered there; the paced retry is typed', async (t) => {
  const { clock, make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  const rec = a.sendCommand(PB, 'p1', 'retry me', { report: true, hold: true });
  for (let i = 0; i < 3; i++) b.limiter.take(PA);   // its limit is used up
  await connect(a, b);
  await flush();
  assert.equal(got.length, 0);
  assert.deepEqual([a.sentTask(rec.id).status, a.sentTask(rec.id).reason], ['held', 'paced']);
  assert.equal(b.seen.has(rec.id), false);
  clock.now += 10001;
  a.pumpOutbox();
  await flush();
  assert.deepEqual(got.map((c) => c.id), [rec.id]);
  assert.equal(a.sentTask(rec.id).status, 'queued');
});

test('v3.48 review 3: 200+ refused commands from another device never evict a queued task; entries bounded per device', async (t) => {
  const { clock, make, connect } = world(t);
  const a = make('A'); const b = make('B');
  runner(b);
  await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'keep me', { report: true });
  await flush();
  assert.equal(b.seen.get(rec.id).state, 'queued');
  const PC = 'cc'.repeat(32);
  b.devices = [...b.devices, { ...b.devices[0], pub: PC, name: 'Junk' }];
  b.secrets[PC] = 'cd'.repeat(32);
  b.peers.set(PC, { v: 2, app: '', caps: ['report', 'task-status'] });
  b.limiter = { take: () => true };
  b.removeAllListeners('command');
  b.on('command', (c) => c.reply('rejected', 'unknown-project'));   // refused by main after acceptance: recorded
  const fake = { destroyed: false, write: () => true };
  for (let i = 0; i < 250; i++) { clock.now += 1; b.receiveCommand(fake, b.devices[1], { t: 'cmd', id: `junk${i}`, project: 'x', text: 'junk', report: true }); }
  assert.equal(b.seen.get(rec.id)?.state, 'queued');
  assert.equal([...b.seen.values()].filter((s) => s.pub === PC).length, 200);
  // refusals before acceptance are not recorded at all
  b.limiter = { take: () => false };
  b.receiveCommand(fake, b.devices[1], { t: 'cmd', id: 'limited', project: 'x', text: 'x', report: true });
  b.devices[1].allowCommands = false;
  b.receiveCommand(fake, b.devices[1], { t: 'cmd', id: 'off', project: 'x', text: 'x', report: true });
  assert.equal(b.seen.has('limited') || b.seen.has('off'), false);
});

test('v3.48 review 4: typed, then a crash before tasks-seen was saved → delivered from reports-out, never typed again; save failures logged', async (t) => {
  const { dir, make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const typed = [];
  // link-host order: type → expectReport (reports-out saved) → reply('delivered'); the crash comes before the reply
  b.on('command', (c) => { typed.push(c.id); b.expectReport(c.id, c.device.pub, c.project); });
  const drop = await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'typed then crash', { report: true });
  await flush();
  assert.equal(b.seen.has(rec.id), false);
  drop();
  await b.destroy();
  const b2 = make('B');
  b2.on('command', (c) => typed.push(c.id));
  assert.deepEqual(b2.statusMsg(rec.id, PA), { t: 'task-status', id: rec.id, state: 'delivered' });
  await connect(a, b2);
  await flush();
  assert.deepEqual(typed, [rec.id]);
  assert.equal(a.sentTask(rec.id).status, 'delivered');
  a.writeCmd(a.conns.get(PB), a.sentTask(rec.id), 'typed then crash');   // a repeat of the id
  await flush();
  assert.deepEqual(typed, [rec.id]);
  const logs = [];
  b2.log = (...x) => logs.push(x.join(' '));
  fs.writeFileSync(path.join(dir, 'plain'), '');
  b2.seenFile = path.join(dir, 'plain', 'tasks-seen.json');
  b2.saveSeen();
  assert.match(logs[0] || '', /tasks-seen not saved/);
});

test('v3.48 review 7: task-status / task-query floods are limited per device; a status burst is one tasks-out write', async (t) => {
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B');
  runner(b);
  await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'x', { report: true });
  await flush();
  let writes = 0; let handled = 0; let changes = 0;
  const save = a.saveTasks.bind(a); a.saveTasks = () => { writes++; save(); };
  const on = a.onTaskStatus.bind(a); a.onTaskStatus = (...x) => { handled++; on(...x); };
  a.on('change', () => changes++);
  const conn = b.conns.get(PA);
  for (let i = 0; i < 1000; i++) b.write(conn, { t: 'task-status', id: rec.id, state: 'queued', why: WHY });
  await flush();
  assert.equal(handled, 400);   // the per-device burst; the rest dropped
  assert.equal(writes, 0);      // coalesced
  assert.ok(changes <= 2, `changes ${changes}`);
  a.flushTasks();
  assert.equal(writes, 1);
  const before = a.wire.filter((m) => m.t === 'task-status').length;
  for (let i = 0; i < 100; i++) b.write(conn, { t: 'task-query', ids: [rec.id] });
  await flush();
  assert.equal(a.wire.filter((m) => m.t === 'task-status').length - before, 16);
});

test('v3.48 review: remote report task: type() false or throwing leaves no reports-out entry (rejected locked); expectation is saved before typing', (t) => {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hqord-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let mode = 'ok'; let during = null; let captured = null;
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; });
  const host = setupLink({
    app: { getPath: () => dir, getVersion: () => '0.21.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: () => {} }, send: () => {}, notify: () => {}, T: (k) => k, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => [{ id: 'p1', name: 'pii', engine: 'claude' }], tabState: () => 'ready',
    type: () => { during = captured.owesReport('t-ok'); if (mode === 'false') return false; if (mode === 'throw') throw new Error('x'); },
  });
  t.after(() => host.destroy());
  host.devices();   // starts the link
  const link = captured;
  link.devices = [{ pub: PA, name: 'Studio', addedAt: 0, allowCommands: true, allowHandoff: false, allowManage: false, allowAccounts: false }];
  const dev = { pub: PA, name: 'Studio' };
  const go = (id) => { const r = []; link.emit('command', { device: dev, id, project: 'p1', text: 'x', report: true, reply: (s, why) => r.push([s, why]) }); host.pump(); return r.filter((x) => x[0] !== 'queued'); };
  assert.deepEqual(go('t-ok'), [['delivered', undefined]]);
  assert.equal(during, true);
  assert.equal(link.owesReport('t-ok'), true);
  for (const m of ['false', 'throw']) {
    mode = m;
    assert.deepEqual(go(`t-${m}`), [['rejected', 'locked']]);
    assert.equal(link.reportsOut.has(`t-${m}`), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'link', 'reports-out.json'), 'utf8'))[`t-${m}`], undefined);
  }
});

test('v3.71/v3.72: a project that answers or skips its permission prompts refuses another device (not-allowed, never queued or typed); local tasks still run', (t) => {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hqskip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let on = false; let tab = 'ready'; let captured = null;
  const typed = [];
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; });
  const host = setupLink({
    app: { getPath: () => dir, getVersion: () => '0.21.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: () => {} }, send: () => {}, notify: () => {}, T: (k) => k, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => [{ id: 'p1', name: 'pii', engine: 'claude' }], tabState: () => tab,
    type: (id, text) => { typed.push(text); },
    answersPrompts: (id) => id === 'p1' && on,   // main.js: Skip permissions or Auto-approve
  });
  t.after(() => host.destroy());
  host.devices();   // starts the link
  const link = captured;
  link.devices = [{ pub: PA, name: 'Studio', addedAt: 0, allowCommands: true, allowHandoff: false, allowManage: false, allowAccounts: false }];
  const dev = { pub: PA, name: 'Studio' };
  const send = (id, report) => { const r = []; link.emit('command', { device: dev, id, project: 'p1', text: `remote ${id}`, report, reply: (s, why) => r.push([s, why]) }); host.pump(); return r; };

  // both switches off: a device's command and task are taken as before
  assert.deepEqual(send('c-off', false), [['queued', undefined], ['delivered', undefined]]);
  assert.deepEqual(send('t-off', true), [['queued', undefined], ['delivered', undefined]]);
  assert.equal(typed.length, 2);

  // either switch on: refused with the existing reason, with or without a report, and nothing waits in the queue
  on = true;
  assert.deepEqual(send('c-on', false), [['rejected', 'not-allowed']]);
  assert.deepEqual(send('t-on', true), [['rejected', 'not-allowed']]);
  assert.equal(link.owesReport('t-on'), false);
  assert.equal(host.remoteTaskOpen('p1'), Boolean(link.owesReportFor?.('p1')));   // only the earlier typed task, nothing queued

  // this machine's own task (HQ, a routine, a local boss) still runs there
  const local = [];
  const mine = host.dispatchLocal('p1', 'local task', 'HQ', (id, s, why) => local.push([s, why]));
  host.pump();
  assert.equal(mine.status, 'delivered');
  assert.deepEqual(local.map((x) => x[0]), ['queued', 'delivered']);
  assert.equal(typed.length, 3);
  assert.match(typed[2], /local task/);

  // the refused commands were never queued: nothing of theirs is typed once the switch is off again
  on = false;
  host.pump();
  assert.equal(typed.length, 3);

  // the switch is turned on while a device's task still waits for a busy tab: refused at typing time, never typed
  tab = 'busy';
  const late = send('t-late', true);
  assert.deepEqual(late, [['queued', undefined]]);
  on = true; tab = 'ready';
  host.pump();
  assert.deepEqual(late, [['queued', undefined], ['rejected', 'not-allowed']]);
  assert.equal(link.owesReport('t-late'), false);
  on = false;
  host.pump();
  assert.equal(typed.length, 3);
  assert.equal(typed.some((x) => /remote (c-on|t-on|t-late)/.test(x)), false);
});

test('v3.48 review: host restarted after expectReport but before the reply: the task is not typed again on resync', async (t) => {
  const { dir, make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const typed = [];
  b.on('command', (c) => { b.expectReport(c.id, c.device.pub, c.project); typed.push(c.id); });   // no reply: the host died here
  const drop = await connect(a, b);
  const rec = a.sendCommand(PB, 'p1', 'once', { report: true });
  await flush();
  drop(); await b.destroy();
  const b2 = make('B');
  b2.on('command', (c) => typed.push(c.id));
  await connect(a, b2);
  await flush();
  assert.deepEqual(typed, [rec.id]);
  assert.equal(a.sentTask(rec.id).status, 'delivered');
  assert.ok(dir);
});

test('v3.97: "This is my own computer" lets a device\'s task into a project that answers or skips its prompts; off, removed or untrusted again it is refused as before', async (t) => {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-trusted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let on = true; let tab = 'ready'; let captured = null; let answer = false; let asked = 0;
  const typed = [];
  const handlers = {};
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; });
  const host = setupLink({
    app: { getPath: () => dir, getVersion: () => '0.21.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, send: () => {}, notify: () => {}, T: (k) => k, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => [{ id: 'p1', name: 'pii', engine: 'claude' }], tabState: () => tab,
    type: (id, text) => { typed.push(text); },
    answersPrompts: (id) => id === 'p1' && on,
    confirmTrusted: async () => { asked++; return answer; },
  });
  t.after(() => host.destroy());
  host.devices();   // starts the link
  const link = captured;
  const SECRET = 'cd'.repeat(32);
  link.devices = C.normalizeDevices([{ pub: PA, name: 'Studio', addedAt: 5, allowCommands: true }]);
  link.secrets[PA] = SECRET;
  const dev = { pub: PA, name: 'Studio' };
  const send = (id) => { const r = []; link.emit('command', { device: dev, id, project: 'p1', text: `remote ${id}`, report: true, reply: (s, why) => r.push([s, why]) }); host.pump(); return r; };
  const logged = () => fs.readFileSync(path.join(dir, 'link', 'commands.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).outcome);
  const trustedNow = () => link.devices.find((x) => x.pub === PA)?.trusted;
  const setTrusted = (v) => handlers['link:setTrusted'](null, PA, v);

  // off (the default): today's refusal and reason, at arrival
  assert.equal(trustedNow(), false);
  assert.deepEqual(send('t-off'), [['rejected', 'not-allowed']]);
  assert.deepEqual(logged(), ['task:rejected:not-allowed']);
  // ... and at typing time (the project's switch came on while the task waited)
  on = false; tab = 'busy';
  const waiting = send('t-pump-off');
  assert.deepEqual(waiting, [['queued', undefined]]);
  on = true; tab = 'ready';
  host.pump();
  assert.deepEqual(waiting, [['queued', undefined], ['rejected', 'not-allowed']]);
  assert.equal(typed.length, 0);

  // the only setter is this machine's IPC handler, and it turns on only after the dialog here said yes
  await setTrusted(true);
  assert.equal(asked, 1);
  assert.equal(trustedNow(), false);                // the person cancelled
  answer = true;
  await setTrusted('yes');                           // not a boolean true: read as off, no dialog
  assert.equal(asked, 1);
  assert.equal(trustedNow(), false);
  await handlers['link:setTrusted'](null, PB, true); // not a paired device
  assert.equal(asked, 1);
  await setTrusted(true);
  assert.equal(asked, 2);
  assert.equal(trustedNow(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'link', 'devices.json'), 'utf8')).devices[0].trusted, true);   // stored next to allowCommands

  // on: taken at arrival and typed, with the remote-task marker; both steps are marked in commands.log
  assert.deepEqual(send('t-on'), [['queued', undefined], ['delivered', undefined]]);
  assert.equal(typed.length, 1);
  assert.match(typed[0], /^\[Agent Office: remote task #t-on from "Studio"\] remote t-on$/);
  assert.deepEqual(logged().slice(-2), ['task:queued:trusted-unattended', 'task:delivered:trusted-unattended']);
  // a project that asks is logged as before (no marker)
  on = false;
  assert.deepEqual(send('t-asks'), [['queued', undefined], ['delivered', undefined]]);
  assert.deepEqual(logged().slice(-1), ['task:queued']);
  // queued while the project asked, typed after its switch came on: taken at typing time too
  tab = 'busy';
  const late = send('t-late');
  on = true; tab = 'ready';
  host.pump();
  assert.deepEqual(late, [['queued', undefined], ['delivered', undefined]]);
  assert.deepEqual(logged().slice(-2), ['task:queued', 'task:delivered:trusted-unattended']);
  assert.equal(typed.length, 3);

  // turned off while a task waits: the pump refuses it, nothing is typed (turning off asks nothing)
  tab = 'busy';
  const held = send('t-held');
  assert.deepEqual(held, [['queued', undefined]]);
  await setTrusted(false);
  assert.equal(asked, 2);
  assert.equal(trustedNow(), false);
  tab = 'ready';
  host.pump();
  assert.deepEqual(held, [['queued', undefined], ['rejected', 'not-allowed']]);
  assert.equal(typed.length, 3);

  // trusted but "Allow commands" off: not enough (the link refuses such a device's cmd before the queue anyway)
  await setTrusted(true);
  link.setAllow(PA, false);
  assert.equal(trustedNow(), true);
  assert.deepEqual(send('t-nocmd'), [['rejected', 'not-allowed']]);
  link.setAllow(PA, true);
  assert.deepEqual(send('t-again'), [['queued', undefined], ['delivered', undefined]]);

  // removing the device clears it; pairing it again starts untrusted
  await setTrusted(true);
  assert.equal(trustedNow(), true);
  await link.remove(PA);
  assert.equal(link.devices.some((x) => x.pub === PA), false);
  link.addDevice(PA, 'Studio', SECRET);
  assert.equal(trustedNow(), false);
  link.setAllow(PA, true);
  assert.deepEqual(send('t-repaired'), [['rejected', 'not-allowed']]);
});

test('v3.97: the flag in devices.json counts only with the device key in the sealed set of the encrypted keys file', async (t) => {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sealed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realOn = Link.prototype.on; const realSwarm = Link.prototype.ensureSwarm;
  let captured = null;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  Link.prototype.ensureSwarm = function () {};   // a restart with paired devices must not open the network here
  t.after(() => { Link.prototype.on = realOn; Link.prototype.ensureSwarm = realSwarm; });
  // a fake keychain: what it "encrypts" cannot be produced or changed without it (a bad blob throws, like the real one)
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
    encryptString: (s) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => { const x = b.toString(); if (!x.startsWith('sealed:')) throw new Error('bad blob'); return Buffer.from(x.slice(7), 'base64').toString(); } };
  const devicesFile = path.join(dir, 'link', 'devices.json');
  const keysFile = path.join(dir, 'link', 'keys.bin');
  const sealed = () => JSON.parse(safeStorage.decryptString(fs.readFileSync(keysFile))).trusted;
  const editDevices = (fn) => { const j = JSON.parse(fs.readFileSync(devicesFile, 'utf8')); fn(j.devices); fs.writeFileSync(devicesFile, JSON.stringify(j)); };
  const boot = async (keychain = safeStorage) => {
    captured = null;
    const handlers = {}; const typed = [];
    const host = setupLink({
      app: { getPath: () => dir, getVersion: () => '0.21.0' }, safeStorage: keychain,
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, send: () => {}, notify: () => {}, T: (k) => k, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
      projects: () => [{ id: 'p1', name: 'pii', engine: 'claude' }], tabState: () => 'ready',
      type: (id, text) => { typed.push(text); }, answersPrompts: () => true, confirmTrusted: async () => true,
    });
    const view = await handlers['link:get']();
    const link = captured;
    const send = (id, pub) => { const r = []; link.emit('command', { device: { pub, name: 'x' }, id, project: 'p1', text: id, report: true, reply: (st, why) => r.push([st, why]) }); host.pump(); return r; };
    return { host, handlers, link, view, send, typed, stop: async () => { await host.destroy(); } };
  };

  // first run: two devices with "Allow commands" on, only A is marked as the person's own computer (through the handler)
  let w = await boot();
  w.link.addDevice(PA, 'Studio', 'cd'.repeat(32));
  w.link.addDevice(PB, 'Laptop', 'ef'.repeat(32));
  w.link.setAllow(PA, true); w.link.setAllow(PB, true);
  await w.handlers['link:setTrusted'](null, PA, true);
  assert.deepEqual(sealed(), [PA]);                                  // both stores carry it
  assert.equal(JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices[0].trusted, true);
  assert.equal(fs.readFileSync(keysFile, 'utf8').includes(PA), false);   // not readable from outside the keychain
  await w.stop();

  // devices.json is edited by something else: B now says trusted there, the sealed set does not
  editDevices((list) => { list[1].trusted = true; });
  w = await boot();
  assert.deepEqual(w.view.devices.map((x) => [x.name, x.trusted]), [['Studio', true], ['Laptop', false]]);   // B's toggle reads off
  assert.deepEqual(w.send('b1', PB), [['rejected', 'not-allowed']]);
  assert.deepEqual(w.send('a1', PA), [['queued', undefined], ['delivered', undefined]]);   // both stores agree: honoured
  assert.equal(w.typed.length, 1);
  w.link.setName('Desk');                                            // the next save writes what is honoured, not what the file claimed
  assert.equal(JSON.parse(fs.readFileSync(devicesFile, 'utf8')).devices[1].trusted, false);
  assert.deepEqual(sealed(), [PA]);
  // off clears both; so does removing the device
  await w.handlers['link:setTrusted'](null, PA, false);
  assert.deepEqual(sealed(), []);
  await w.handlers['link:setTrusted'](null, PA, true);
  assert.deepEqual(sealed(), [PA]);
  await w.handlers['link:remove'](null, PA);
  w.link.persist();
  assert.deepEqual(sealed(), []);
  // "Allow commands" off: the handler does not turn the flag on
  w.link.setAllow(PB, false);
  await w.handlers['link:setTrusted'](null, PB, true);
  assert.equal(w.link.devices.find((x) => x.pub === PB).trusted, false);
  await w.stop();

  // a keys file from before the sealed set (no `trusted` in it), or with a malformed one: every flag reads off
  for (const bad of [undefined, 'all', { [PB]: true }, [PB.slice(2)]]) {
    const k = JSON.parse(safeStorage.decryptString(fs.readFileSync(keysFile)));
    if (bad === undefined) delete k.trusted; else k.trusted = bad;
    fs.writeFileSync(keysFile, safeStorage.encryptString(JSON.stringify(k)));
    editDevices((list) => { list[0].allowCommands = true; list[0].trusted = true; });
    w = await boot();
    assert.equal(w.view.devices[0].trusted, false, JSON.stringify(bad));
    assert.deepEqual(w.send('b2', PB), [['rejected', 'not-allowed']]);
    await w.stop();
  }

  // the keys file replaced by something the keychain did not write (here: a plain JSON that names B): the link stays off
  fs.writeFileSync(keysFile, JSON.stringify({ trusted: [PB], secrets: { [PB]: 'ef'.repeat(32) } }));
  w = await boot();
  assert.equal(w.link, null);
  assert.equal(w.view.error, 'keys');
  assert.deepEqual(w.view.devices, []);
  await w.handlers['link:setTrusted'](null, PB, true);
  assert.equal(JSON.parse(fs.readFileSync(keysFile, 'utf8')).trusted[0], PB);   // untouched: nothing was written over it
  await w.stop();

  // no keychain: the link does not start, so no device and no flag exists for this run
  w = await boot({ ...safeStorage, isEncryptionAvailable: () => false });
  assert.equal(w.link, null);
  assert.equal(w.view.error, 'no-keychain');
  assert.deepEqual(w.view.devices, []);
  await w.stop();

  // the pure rule
  const list = [{ pub: PA, name: 'A', trusted: true }, { pub: PB, name: 'B', trusted: true }];
  assert.deepEqual(C.sealTrusted(list, [PA]).map((x) => x.trusted), [true, false]);
  assert.deepEqual(C.sealTrusted(list, null).map((x) => x.trusted), [false, false]);
  assert.deepEqual(C.sealTrusted([{ pub: PA, name: 'A' }], [PA]).map((x) => x.trusted), [false]);   // sealed alone turns nothing on
  assert.deepEqual(C.trustedKeys(C.normalizeDevices(list)), [PA, PB]);
});

test('v3.97: nothing but the link:setTrusted IPC handler sets the flag', () => {
  const root = path.join(__dirname, '..');
  const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const calls = (s) => (s.match(/\.setTrusted\(/g) || []).length;
  // every script under src/ (all folders) and main.js
  const walk = (rel) => fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : /\.(js|mjs|cjs|ts)$/.test(e.name) ? [`${rel}/${e.name}`] : []));
  const files = ['main.js', ...walk('src')];
  assert.ok(files.includes('src/link.js') && files.some((f) => f.split('/').length > 2), 'the scan reaches the sub-folders');
  for (const f of files) {
    if (f !== 'src/link-host.js') assert.equal(calls(src(f)), 0, f);
    // no literal write of the flag anywhere: it only ever comes from `on === true` (the setter), `d.trusted === true`
    // (normalising / the view) or `false` (pairing, the sealed-set check)
    assert.equal(/\btrusted['"]?\s*[:=]\s*true\b/.test(src(f)), false, `${f} writes trusted: true`);
  }
  // link-host.js: only inside the handler (off, and on after the dialog)
  const host = src('src/link-host.js');
  assert.equal(calls(host), 2);
  const handler = host.slice(host.indexOf("ipc('link:setTrusted'"), host.indexOf("ipc('link:remove'"));
  assert.equal(calls(handler), 2);
  assert.match(handler, /d\.confirmTrusted/);
  // the device link has one writer of the field besides pairing (off) and loading the list
  assert.equal((src('src/link.js').match(/trusted: on === true/g) || []).length, 1);
  // the sealed set: written from the device list on every save, checked where the list is loaded
  assert.match(host, /secrets, trusted: C\.trustedKeys\(devices\) \}/);
  assert.match(host, /devices: C\.sealTrusted\(saved\.devices, keys\.trusted\)/);
});

// --- v3.99 a task from a paired machine may start a stopped project (cmd.revive, cap 'revive')
test('v3.99 revive on the wire: only with a task, only to a peer that named the cap; an older peer gets today\'s cmd', async (t) => {
  assert.ok(C.CAPS.includes('revive') && C.OUR_CAPS.includes('revive') && C.REASONS.includes('stopped-here'));
  const { make, connect } = world(t);
  const a = make('A'); const b = make('B');
  const got = runner(b);
  await connect(a, b);
  a.sendCommand(PB, 'p1', 'a task', { report: true, revive: true });
  a.sendCommand(PB, 'p1', 'a plain command', { revive: true });
  a.sendCommand(PB, 'p1', 'a task without it', { report: true });
  await flush();
  const cmds = a.wire.filter((m) => m.t === 'cmd');
  assert.deepEqual(cmds.map((m) => m.revive), [true, undefined, undefined]);
  assert.deepEqual(got.map((c) => c.revive), [true, undefined, undefined]);
  // an older peer (no cap): the field is never written, so it behaves as today
  const { make: make2, connect: connect2 } = world(t);
  const a2 = make2('A'); const old = make2('B', { caps: OLD_CAPS });
  const got2 = runner(old);
  await connect2(a2, old);
  a2.sendCommand(PB, 'p1', 'a task', { report: true, revive: true });
  await flush();
  assert.equal('revive' in a2.wire.find((m) => m.t === 'cmd'), false);
  assert.equal(got2[0].revive, undefined);
});

function reviveHost(t) {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-revive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = { dir, now: 2e12, tabs: {}, typed: [], withs: [], starts: [], notices: [], startOk: true, stopped: {}, handlers: {} };
  const realNow = Date.now;
  Date.now = () => w.now;
  let captured = null;
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; Date.now = realNow; });
  const host = setupLink({
    app: { getPath: () => dir, getVersion: () => '0.23.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: (ch, fn) => { w.handlers[ch] = fn; } }, send: () => {}, notify: (title) => { w.notices.push(title); }, T: (k, v) => (v ? `${k}${JSON.stringify(v)}` : k),
    loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id) => ({ id, name: id, engine: 'claude' })),
    tabState: (id) => w.tabs[id] || 'gone',
    type: (id, text) => { w.typed.push([id, text]); },
    startWith: (id, text) => { w.withs.push([id, text]); return w.startOk; },
    manage: (op, id) => { w.starts.push([op, id]); return { ok: true }; },
    stoppedHere: (id) => w.stopped[id] || 0,
    answersPrompts: (id) => id === 'p4',
    confirmTrusted: async () => true,
  });
  t.after(() => host.destroy());
  host.devices();   // starts the link
  const link = captured;
  link.devices = C.normalizeDevices([{ pub: PA, name: 'Studio', addedAt: 5, allowCommands: true, allowManage: true }]);
  link.secrets[PA] = 'cd'.repeat(32);
  const dev = { pub: PA, name: 'Studio' };
  w.host = host; w.link = link;
  w.manage = (on) => { link.devices = link.devices.map((x) => ({ ...x, allowManage: on })); };
  w.send = (id, project, o = {}) => { const r = []; link.emit('command', { device: dev, id, project, text: `remote ${id}`, report: true, revive: true, ...o, reply: (s, why) => r.push(why ? `${s}:${why}` : s) }); return r; };
  w.mlog = () => { try { return fs.readFileSync(path.join(dir, 'link', 'manage.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  w.clog = () => fs.readFileSync(path.join(dir, 'link', 'commands.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).outcome);
  return w;
}

test('v3.99 revive: a stopped project is started for a paired machine\'s task only with allowManage, at accept and at pump; logged and shown', async (t) => {
  const w = reviveHost(t);
  // "manage projects" off for the device: exactly today's answer, nothing started, nothing logged
  w.manage(false);
  assert.deepEqual(w.send('t-off', 'p1'), ['queued', 'rejected:not-running']);
  assert.deepEqual([w.withs.length, w.starts.length, w.mlog().length, w.notices.length], [0, 0, 0, 0]);
  // on, but the cmd carried no revive (an older sender, or not an HQ task): today's answer
  w.manage(true);
  assert.deepEqual(w.send('t-plain', 'p1', { revive: false }), ['queued', 'rejected:not-running']);
  assert.deepEqual(w.send('t-cmd', 'p1', { report: false }), ['queued', 'rejected:not-running']);   // a plain command never starts a project
  assert.equal(w.withs.length + w.starts.length, 0);
  // on and asked for: started with the task as its first prompt, written to manage.log, the proj-op notice shown
  assert.deepEqual(w.send('t-on', 'p1'), ['queued', 'delivered']);
  assert.equal(w.withs.length, 1);
  assert.match(w.withs[0][1], /^\[Agent Office: remote task #t-on from "Studio"\] remote t-on$/);
  const m = w.mlog();
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].device, m[0].op, m[0].project, m[0].outcome, m[0].via, m[0].task], ['Studio', 'start', 'p1', 'ok', 'task', 't-on']);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0], /^main\.projOpNotice\{"device":"Studio","project":"p1","op":"machines\.op\.start"\}$/);
  // the toggle is turned off while a task waits for its start: refused at pump, never started
  const waiting = w.send('t-wait', 'p1');          // the budget's minute: it waits
  assert.deepEqual(waiting, ['queued']);
  w.manage(false);
  w.now += 61 * 1000;
  w.host.pump();
  assert.deepEqual(waiting, ['queued', 'rejected:not-running']);
  assert.equal(w.withs.length, 1);
  assert.equal(w.mlog().length, 1);
  // a tab that is 'starting' (the person there just opened it) is never restarted for another machine's task
  w.manage(true);
  w.tabs.p2 = 'starting';
  const st = w.send('t-starting', 'p2');
  w.now += 5 * 60 * 1000;
  w.host.pump();
  assert.deepEqual(st, ['queued']);
  assert.equal(w.withs.filter((x) => x[0] === 'p2').length, 0);
  assert.equal(w.starts.length, 0);
  w.tabs.p2 = 'ready';
  w.host.pump();
  assert.deepEqual(st, ['queued', 'delivered']);
  assert.equal(w.typed.length, 1);
  // a project that answers or skips its prompts is still refused, revive or not, unless the device is trusted (v3.97)
  assert.deepEqual(w.send('t-skip', 'p4'), ['rejected:not-allowed']);
  assert.equal(w.withs.filter((x) => x[0] === 'p4').length, 0);
  await w.handlers['link:setTrusted'](null, PA, true);
  assert.equal(w.link.devices.find((x) => x.pub === PA).trusted, true);
  assert.deepEqual(w.send('t-skip-own', 'p4'), ['queued', 'delivered']);
  assert.equal(w.withs.filter((x) => x[0] === 'p4').length, 1);
  assert.deepEqual(w.clog().slice(-2), ['task:queued:trusted-unattended', 'task:delivered:trusted-unattended']);
});

test('v3.99 revive: refused for 10 minutes after the person here stopped the project themselves (stopped-here)', (t) => {
  const w = reviveHost(t);
  w.stopped.p3 = w.now - 5 * 60 * 1000;
  assert.deepEqual(w.send('t-sticky', 'p3'), ['queued', 'rejected:stopped-here']);
  assert.equal(w.withs.length + w.starts.length + w.mlog().length, 0);
  assert.equal(w.clog().pop(), 'task:rejected:stopped-here');
  // a device without "manage projects" learns nothing about the stop: today's reason
  w.manage(false);
  assert.deepEqual(w.send('t-sticky-off', 'p3'), ['queued', 'rejected:not-running']);
  w.manage(true);
  w.now += 5 * 60 * 1000 + 1000;                   // the window is over
  assert.deepEqual(w.send('t-later', 'p3'), ['queued', 'delivered']);
  assert.equal(w.mlog().length, 1);
});

test('v3.99 revive budget: a start that never becomes ready (window closed) does not spin; the task ends not-running or at its TTL', (t) => {
  const w = reviveHost(t);
  w.startOk = false;                               // startWithPrompt returns false: no window to start it in
  const r = w.send('t-closed', 'p5');
  assert.deepEqual(r, ['queued']);
  assert.equal(w.starts.length, 1);                // the plain start is tried once
  for (let i = 0; i < 20; i++) w.host.pump();
  assert.equal(w.starts.length, 1);                // not again within the minute, however often the queue is pumped
  w.now += 61 * 1000; w.host.pump(); w.host.pump();
  assert.equal(w.starts.length, 2);
  w.now += 61 * 1000; w.host.pump(); w.host.pump();
  assert.equal(w.starts.length, 3);
  w.now += 30 * 1000; w.host.pump();
  assert.deepEqual(r, ['queued']);                 // the last try gets its minute
  w.now += 31 * 1000; w.host.pump();
  assert.deepEqual(r, ['queued', 'rejected:not-running']);
  assert.equal(w.starts.length, 3);
  assert.equal(w.mlog().length, 3);                // every start is in manage.log
  assert.equal(w.notices.length, 3);
  // the budget is spent: the next task from that device starts nothing
  assert.deepEqual(w.send('t-again', 'p5'), ['queued', 'rejected:not-running']);
  assert.equal(w.starts.length, 3);
  // a task with a short TTL ends at it, with its own reason
  const s = w.send('t-ttl', 'p6', { ttl: 100 * 1000 });
  assert.equal(w.starts.filter((x) => x[1] === 'p6').length, 1);
  w.now += 61 * 1000; w.host.pump();
  assert.equal(w.starts.filter((x) => x[1] === 'p6').length, 2);
  w.now += 45 * 1000; w.host.pump();
  assert.deepEqual(s, ['queued', 'rejected:expired']);
  assert.equal(w.starts.filter((x) => x[1] === 'p6').length, 2);
});
