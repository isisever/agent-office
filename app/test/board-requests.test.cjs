'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RQ = require('../src/board-requests.js');
const BM = require('../src/board-model.js');

const rec = (over = {}) => ({ id: 'qabcdef01', projectId: 'p1', ptyId: 'pty1', project: 'Proj', account: 'Work', sessionId: '', title: 'Fix the login', type: 'bugfix', ...over });

test('titleOf takes the first non-empty line, trimmed and cut', () => {
  assert.equal(RQ.titleOf('\n  hello   world \nsecond'), 'hello world');
  assert.equal(RQ.titleOf('x'.repeat(200)).length, 80);
  assert.equal(RQ.titleOf('   '), '');
});

test('add makes a running record and finishes older open ones of the same tab', () => {
  let l = RQ.add([], rec(), 1000);
  assert.equal(l[0].state, 'running');
  l = RQ.add(l, rec({ id: 'qabcdef02' }), 2000);
  assert.deepEqual(l.map((r) => [r.id, r.state]).sort(), [['qabcdef01', 'failed'], ['qabcdef02', 'running']]);
  assert.equal(l.find((r) => r.id === 'qabcdef01').reason, 'superseded');
  // a turn that really ran is done when a newer request follows
  let m = RQ.observe(RQ.add([], rec(), 1000), 'pty1', { busy: true }, 1500);
  m = RQ.add(m, rec({ id: 'qabcdef02' }), 2000);
  assert.equal(m.find((r) => r.id === 'qabcdef01').state, 'done');
});

test('observe: running, waiting, done after busy, failed', () => {
  let l = RQ.add([], rec(), 1000);
  assert.equal(RQ.observe(l, 'pty1', { busy: false }, 2000), l);   // inside the grace: unchanged
  l = RQ.observe(l, 'pty1', { busy: true }, 2000);
  assert.equal(l[0].state, 'running');
  l = RQ.observe(l, 'pty1', { waiting: true }, 3000);
  assert.equal(l[0].state, 'waiting');
  l = RQ.observe(l, 'pty1', { busy: false }, 4000);
  assert.equal(l[0].state, 'done');
  assert.equal(l[0].endedAt, 4000);
  const f = RQ.observe(RQ.add([], rec(), 1000), 'pty1', { failed: true }, 1500);
  assert.equal(f[0].state, 'failed');
});

test('a turn never seen busy fails visibly after the grace period instead of closing as done', () => {
  const l = RQ.observe(RQ.add([], rec(), 1000), 'pty1', { busy: false }, 1000 + RQ.GRACE_MS);
  assert.equal(l[0].state, 'failed');
  assert.equal(l[0].reason, 'never-started');
  assert.equal(RQ.card(l[0]).column, 'needs-you');
  assert.equal(RQ.clean(l[0]).reason, 'never-started');
});

test('detachGone marks records of closed tabs interrupted; bindSession fills the session id', () => {
  const l = RQ.add([], rec(), 1000);
  assert.equal(RQ.detachGone(l, new Set(['pty1']), 2000), l);
  const g = RQ.detachGone(l, new Set(), 2000)[0];
  assert.equal(g.state, 'failed');
  assert.equal(g.reason, 'interrupted');
  const sid = '11111111-2222-3333-4444-555555555555';
  assert.equal(RQ.bindSession(l, 'pty1', sid)[0].sessionId, sid);
});

test('cap keeps open, drops old finished and limits the count', () => {
  const now = 10 * RQ.KEEP_DONE_MS;
  const old = RQ.clean({ ...rec({ id: 'qaaaaaa01' }), state: 'done', at: 1, endedAt: 1 });
  const open = RQ.clean({ ...rec({ id: 'qaaaaaa02' }), state: 'running', at: 1 });
  assert.deepEqual(RQ.cap([old, open], now).map((r) => r.id), ['qaaaaaa02']);
  const many = Array.from({ length: 300 }, (_, i) => RQ.clean({ ...rec({ id: `q${(i + 0x100000).toString(16)}` }), state: 'done', at: now - i, endedAt: now - i }));
  assert.equal(RQ.cap(many, now).length, RQ.MAX_REQS);
});

test('clean drops junk', () => {
  assert.equal(RQ.clean(null), null);
  assert.equal(RQ.clean({ id: '../x' }), null);
  assert.equal(RQ.clean({ ...rec(), state: 'weird' }).state, 'done');
});

test('summary is newest first and limited', () => {
  const l = [RQ.clean({ ...rec({ id: 'qaaaaaa01' }), at: 1 }), RQ.clean({ ...rec({ id: 'qaaaaaa02' }), at: 5 })];
  assert.deepEqual(RQ.summary(l, 1).map((r) => r.id), ['qaaaaaa02']);
});

test('the board shows request cards, hides the session chat card, and done/type work on them', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  let store = BM.loadStore({ v: 1, chats: [{ sessionId: sid, projectId: 'p1', ptyId: 'pty1', project: 'Proj', title: 'old', at: 5, lastActive: 5 }], reqs: [] });
  store = { ...store, reqs: RQ.add([], rec({ sessionId: sid }), 1000) };
  const v = BM.boardCards({ tasks: [], requests: [] }, store);
  assert.deepEqual(v.cards.map((c) => c.id), ['q:qabcdef01']);
  assert.equal(v.cards[0].column, 'working');
  assert.equal(v.cards[0].account, 'Work');
  assert.ok(BM.validCardId('q:qabcdef01'));
  assert.ok(!BM.validCardId('q:../x'));
  const t = BM.setType(store, 'q:qabcdef01', 'hotfix');
  assert.equal(t.ok, true);
  assert.equal(BM.boardCards({}, t.store).cards[0].type, 'hotfix');
  const d = BM.markDone(store, 'q:qabcdef01', Date.now());
  assert.equal(BM.boardCards({}, d.store).cards[0].column, 'done');
  assert.equal(BM.markDone(store, 'q:qzzzzzzzz').ok, false);
});

test('loadStore keeps and cleans reqs', () => {
  const s = BM.loadStore({ reqs: [{ ...rec(), state: 'running', at: 5 }, { id: 'bad' }] });
  assert.equal(s.reqs.length, 1);
  assert.deepEqual(BM.loadStore(undefined).reqs, []);
});

test('assistantAtFromTail reads the latest assistant or result timestamp and skips a cut first line', () => {
  const tail = ['ned":1}', JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:05.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:06.000Z' }), JSON.stringify({ type: 'result', timestamp: '2026-01-01T00:00:07.000Z' })].join('\n');
  assert.equal(RQ.assistantAtFromTail(tail), Date.parse('2026-01-01T00:00:07.000Z'));
  assert.equal(RQ.assistantAtFromTail('{"type":"user"}'), 0);
});

test('assistantAtFromTail ignores synthetic usage-limit entries and API errors', () => {
  const tail = ['', JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:06.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:08.000Z', message: { model: '<synthetic>' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:09.000Z', isApiErrorMessage: true })].join('\n');
  assert.equal(RQ.assistantAtFromTail(tail), Date.parse('2026-01-01T00:00:06.000Z'));
  assert.equal(RQ.assistantAtFromTail(JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:08.000Z', message: { model: '<synthetic>' } })), 0);
});

test('a reply under 3 s after the send is done, not never-started', () => {
  const l0 = RQ.add([], rec(), 1000);
  const l = RQ.observe(l0, 'pty1', { busy: false, assistantAt: 1800 }, 1000 + RQ.GRACE_MS);
  assert.equal(l[0].state, 'done');
  const f = RQ.observe(l0, 'pty1', { busy: false, assistantAt: 900 }, 1000 + RQ.GRACE_MS);   // output from before the send does not count
  assert.equal(f[0].state, 'failed');
  assert.equal(f[0].reason, 'never-started');
});

test('typing again within 15 s closes a turn that ran (never sampled busy) as done, one that did not as superseded', () => {
  const l0 = RQ.add([], rec(), 1000);
  const ran = RQ.add(l0, rec({ id: 'qabcdef02' }), 5000, 3000);
  assert.equal(ran.find((r) => r.id === 'qabcdef01').state, 'done');
  const idle = RQ.add(l0, rec({ id: 'qabcdef02' }), 5000, 0);
  assert.equal(idle.find((r) => r.id === 'qabcdef01').reason, 'superseded');
});

test('a reply typed while a request waits on the person continues it (not superseded or failed)', () => {
  let l = RQ.observe(RQ.add([], rec(), 1000), 'pty1', { waiting: true }, 2000);
  l = RQ.add(l, rec({ id: 'qabcdef02' }), 3000);
  assert.equal(l.find((r) => r.id === 'qabcdef01').state, 'waiting');
});
