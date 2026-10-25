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
  assert.match(main, /officeDispatch\(HQ\.HQ_ID, \{ machine: pub, project: pid, task \}, \{ hold: true, ttl: HQ\.HQ_TTL_MS \}\)/);
  assert.match(main, /linkHost\?\.cancelRemote\(id\)/);
  assert.match(main, /HQ\.remoteOpen\(linkHost\?\.remoteTask\(t\.id\)\)/);
  assert.match(host, /link\.on\('task-cancel', onTaskCancel\)/);
  assert.match(host, /attentionOf\?\.\(t\.project\) === 'permission' \? 'needs-approval'/);
  assert.match(fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8'), /app\/test\/hq-link\.test\.cjs/);
});
