'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BM = require('../src/board-model.js');
const HQ = require('../src/hq.js');
const CH = require('../src/hq-chain.js');

const SID = '11111111-2222-3333-4444-555555555555';
const SID2 = '66666666-7777-8888-9999-aaaaaaaaaaaa';

test('classify: explicit prefix wins, then hotfix words, then bugfix words, else feature (en + tr)', () => {
  assert.deepEqual(BM.classify('feature: fix the login crash'), { type: 'feature', explicit: true });
  assert.deepEqual(BM.classify('Hotfix: typo'), { type: 'hotfix', explicit: true });
  assert.deepEqual(BM.classify('[bugfix] - add a button'), { type: 'bugfix', explicit: true });
  assert.equal(BM.classify('Login page crashes on submit').type, 'bugfix');
  assert.equal(BM.classify('Ödeme ekranı çalışmıyor').type, 'bugfix');
  assert.equal(BM.classify('Kayıt formunda hata var').type, 'bugfix');
  assert.equal(BM.classify('uygulama açılışta çöküyor').type, 'bugfix');
  assert.equal(BM.classify('fix the header').type, 'bugfix');
  assert.equal(BM.classify('ACİL: ödeme alınamıyor').type, 'hotfix');
  assert.equal(BM.classify('acil bakılması lazım, hata var').type, 'hotfix');
  assert.equal(BM.classify('urgent bug in prod').type, 'hotfix');
  assert.equal(BM.classify('Add dark mode').type, 'feature');
  assert.equal(BM.classify('prefix the ids, debugger panel').type, 'feature');   // no word boundary: not "fix" / "bug"
  assert.equal(BM.classify('reproduce the product page').type, 'feature');
  assert.equal(BM.classify(undefined).type, 'feature');
});

test('typeOf / orderType: explicit argument, then a prefix in any text, then keywords', () => {
  assert.equal(BM.typeOf('BugFix'), 'bugfix');
  assert.equal(BM.typeOf('chore'), '');
  assert.equal(BM.orderType('hotfix', 'add a page'), 'hotfix');
  assert.equal(BM.orderType('nope', 'add a page', 'feature: crash report view'), 'feature');
  assert.equal(BM.orderType('', 'add a page', 'login crash'), 'bugfix');
});

test('columnOf: 13 statuses map to 5 columns; partial is review, blocked needs you', () => {
  const want = { queued: 'todo', waiting: 'todo', delivered: 'working', running: 'working', 'needs-approval': 'needs-you',
    'awaiting-consent': 'needs-you', blocked: 'needs-you', failed: 'needs-you', expired: 'needs-you', lost: 'needs-you',
    partial: 'review', reported: 'done', rejected: 'needs-you' };
  for (const s of HQ.STATUSES) assert.equal(BM.columnOf(s), want[s], s);
  assert.equal(BM.columnOf('rejected', 'cancelled'), 'done');
  assert.equal(BM.columnOf('rejected', 'declined'), 'done');
  for (const s of HQ.STATUSES) assert.ok(BM.COLUMNS.includes(BM.columnOf(s)));
});

test('sortCards: bugfix, hotfix, feature, then oldest first', () => {
  const cards = [
    { id: 'a', type: 'feature', at: 1 }, { id: 'b', type: 'hotfix', at: 5 }, { id: 'c', type: 'bugfix', at: 9 },
    { id: 'd', type: 'bugfix', at: 2 }, { id: 'e', type: 'hotfix', at: 3 },
  ];
  assert.deepEqual(BM.sortCards(cards).map((c) => c.id), ['d', 'c', 'e', 'b', 'a']);
  assert.deepEqual(BM.byPriority([{ n: 1, type: 'feature', at: 1 }, { n: 2, type: 'bugfix', at: 9 }, { n: 3, type: 'feature', at: 1 }]).map((x) => x.n), [2, 1, 3]);
});

const task = (id, status, extra = {}) => ({ id, request: 'r1', title: `t ${id}`, project: 'ERP', machine: 'self', status, at: 10, ...extra });

test('orderCard: column from its tasks, progress, review until summarized, person done/type win', () => {
  const req = { id: 'r1', at: 100, prompt: 'Login crashes', tasks: ['a', 'b'] };
  let c = BM.cardOf(req, { tasks: [task('a', 'running'), task('b', 'waiting')] });
  assert.equal(c.kind, 'order');
  assert.equal(c.id, 'o:r1');
  assert.equal(c.type, 'bugfix');
  assert.equal(c.column, 'working');
  assert.deepEqual(c.progress, { done: 0, total: 2 });
  c = BM.cardOf(req, { tasks: [task('a', 'reported', { finishedAt: 400 }), task('b', 'blocked')] });
  assert.equal(c.column, 'needs-you');
  c = BM.cardOf(req, { tasks: [task('a', 'reported', { finishedAt: 400 }), task('b', 'partial', { finishedAt: 500 })] });
  assert.equal(c.column, 'review');   // partial is never done
  c = BM.cardOf(req, { tasks: [task('a', 'reported', { finishedAt: 400 }), task('b', 'reported', { finishedAt: 500 })] });
  assert.equal(c.column, 'review');   // no summary yet
  c = BM.cardOf({ ...req, summary: 'requests/r1.md', done: true }, { tasks: [task('a', 'reported', { finishedAt: 400 }), task('b', 'reported', { finishedAt: 500, staff: 'Ada' })] });
  assert.equal(c.column, 'done');
  assert.equal(c.closedAt, 500);
  assert.equal(c.durationMs, 400);
  assert.deepEqual(c.members, ['Ada']);
  c = BM.cardOf(req, { tasks: [task('a', 'running')], meta: { type: 'feature', doneAt: 900 } });
  assert.equal(c.column, 'done');
  assert.equal(c.type, 'feature');
  assert.equal(c.typeBy, 'person');
  assert.equal(BM.cardOf({ ...req, type: 'hotfix', typeBy: 'hq' }, { tasks: [] }).type, 'hotfix');
  assert.equal(BM.cardOf({ ...req, type: 'hotfix', typeBy: 'hq' }, { tasks: [] }).typeBy, 'hq');
  assert.equal(BM.cardOf(null), null);
});

test('touchSession: a card on the first person prompt, follows working / needs you / review, reopens', () => {
  let s = BM.emptyStore();
  s = BM.touchSession(s, { sessionId: SID, projectId: 'p1', project: 'ERP', title: '', prompt: '', busy: false }, 1000);
  assert.equal(s.chats.length, 0);   // no prompt yet
  s = BM.touchSession(s, { sessionId: SID, projectId: 'p1', ptyId: 'p1', project: 'ERP', title: '', prompt: 'Invoice export broken', busy: true }, 1000);
  assert.equal(s.chats.length, 1);
  let c = BM.cardOf(s.chats[0]);
  assert.equal(c.id, `c:${SID}`);
  assert.equal(c.kind, 'chat');
  assert.equal(c.title, 'Invoice export broken');
  assert.equal(c.type, 'bugfix');
  assert.equal(c.column, 'working');
  s = BM.touchSession(s, { sessionId: SID, title: 'Fix invoice export', prompt: 'Invoice export broken', busy: true, waiting: true }, 2000);
  assert.equal(s.chats[0].column, 'needs-you');
  assert.equal(s.chats[0].title, 'Fix invoice export');   // /rename or Claude's title wins over the first prompt
  const before = s;
  s = BM.touchSession(s, { sessionId: SID, title: 'Fix invoice export', prompt: 'x', busy: false, tokens: 5000, usd: 0.4 }, 3000);
  assert.equal(s.chats[0].column, 'review');
  assert.equal(s.chats[0].reviewSince, 3000);
  assert.equal(s.chats[0].tokens, 5000);
  assert.notEqual(s, before);
  assert.equal(BM.touchSession(s, { sessionId: SID, title: 'Fix invoice export', prompt: 'x', busy: false, tokens: 10 }, 4000), s);   // nothing changed
  // auto close after 24 h in review, reopen when it works again
  assert.equal(BM.autoClose(s, 3000 + BM.REVIEW_CLOSE_MS - 1), s);
  s = BM.autoClose(s, 3000 + BM.REVIEW_CLOSE_MS);
  c = BM.cardOf(s.chats[0]);
  assert.equal(c.column, 'done');
  assert.equal(c.closedBy, 'auto');
  s = BM.touchSession(s, { sessionId: SID, title: 'Fix invoice export', busy: true }, 9e9);
  assert.equal(BM.cardOf(s.chats[0]).column, 'working');
  assert.equal(s.chats[0].closedAt, 0);
  assert.equal(BM.touchSession(s, { sessionId: 'not-a-uuid', prompt: 'x' }), s);
});

test('markDone / setType: validated ids, person choices', () => {
  let s = BM.touchSession(BM.emptyStore(), { sessionId: SID, prompt: 'add export', busy: false }, 10);
  assert.equal(BM.setType(s, `c:${SID}`, 'chore').ok, false);
  assert.equal(BM.setType(s, 'x:1', 'bugfix').ok, false);
  assert.equal(BM.setType(s, `c:${SID2}`, 'bugfix').ok, false);
  let r = BM.setType(s, `c:${SID}`, 'hotfix');
  assert.ok(r.ok);
  s = r.store;
  assert.equal(s.chats[0].type, 'hotfix');
  s = BM.touchSession(s, { sessionId: SID, title: 'crash fix', prompt: 'add export', busy: true }, 20);
  assert.equal(s.chats[0].type, 'hotfix');   // the person's type is kept
  r = BM.markDone(s, `c:${SID}`, 30);
  assert.ok(r.ok);
  assert.equal(BM.cardOf(r.store.chats[0]).closedBy, 'person');
  r = BM.markDone(r.store, 'o:req-1', 40);
  assert.equal(r.store.orders['req-1'].doneAt, 40);
  r = BM.setType(r.store, 'o:req-1', 'bugfix');
  assert.equal(r.store.orders['req-1'].type, 'bugfix');
  assert.equal(BM.markDone(r.store, 'o:../x', 1).ok, false);
});

test('loadStore: cleans and caps (500 closed)', () => {
  const chats = [];
  for (let i = 0; i < 600; i++) chats.push({ sessionId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, at: i + 1, closedAt: i + 1, type: 'bugfix' });
  chats.push({ sessionId: 'bad' }, null, { sessionId: SID, at: 5, column: 'working' });
  const s = BM.loadStore({ chats, orders: { ok: { type: 'hotfix' }, 'b a d': { type: 'hotfix' }, empty: {} } });
  assert.equal(s.chats.filter((c) => c.closedAt).length, BM.MAX_CLOSED);
  assert.equal(s.chats.filter((c) => !c.closedAt).length, 1);
  assert.equal(Math.min(...s.chats.filter((c) => c.closedAt).map((c) => c.closedAt)), 101);   // the newest kept
  assert.deepEqual(s.orders, { ok: { type: 'hotfix' } });
  assert.deepEqual(BM.loadStore(null), BM.emptyStore());
});

test('boardCards: orders and chats together, sorted, with five columns', () => {
  let s = BM.touchSession(BM.emptyStore(), { sessionId: SID, prompt: 'new settings page', busy: true }, 50);
  s = BM.touchSession(s, { sessionId: SID2, prompt: 'Uygulama çalışmıyor', busy: false }, 60);
  const board = { tasks: [task('a', 'queued')], requests: [{ id: 'r1', at: 10, prompt: 'hotfix: payments down', tasks: ['a'] }] };
  const v = BM.boardCards(board, s);
  assert.deepEqual(v.columns.map((c) => c.id), ['todo', 'working', 'needs-you', 'review', 'done']);
  assert.deepEqual(v.cards.map((c) => c.id), [`c:${SID2}`, 'o:r1', `c:${SID}`]);
  assert.deepEqual(v.columns.find((c) => c.id === 'todo').cards, ['o:r1']);
  assert.deepEqual(v.columns.find((c) => c.id === 'review').cards, [`c:${SID2}`]);
});

test('report: closed cards by project, type and member, in range', () => {
  const cards = [
    { id: '1', kind: 'chat', column: 'done', closedAt: 100, durationMs: 10, tokens: 1000, usd: 0.5, type: 'feature', projects: ['ERP'], members: [] },
    { id: '2', kind: 'order', column: 'done', closedAt: 200, durationMs: 20, tokens: 0, usd: 0, type: 'bugfix', projects: ['ERP', 'Web'], members: ['Ada'] },
    { id: '3', kind: 'chat', column: 'done', closedAt: 900, durationMs: 5, tokens: 1, usd: 0, type: 'hotfix', projects: ['Web'], members: [] },
    { id: '4', kind: 'chat', column: 'review', closedAt: 0, durationMs: 99, tokens: 9, usd: 9, type: 'bugfix', projects: ['ERP'], members: [] },
  ];
  const p = BM.report(cards, { from: 0, to: 500, groupBy: 'project' });
  assert.deepEqual(p.rows.map((r) => [r.key, r.count, r.durationMs, r.tokens]), [['ERP', 2, 30, 1000], ['Web', 1, 20, 0]]);
  assert.equal(p.total.count, 2);
  assert.equal(p.total.usd, 0.5);
  const t = BM.report(cards, { groupBy: 'type' });
  assert.deepEqual(t.rows.map((r) => r.key), ['bugfix', 'hotfix', 'feature']);
  const m = BM.report(cards, { groupBy: 'member' });
  assert.deepEqual(m.rows.map((r) => [r.key, r.count]), [['', 2], ['Ada', 1]]);
  assert.equal(BM.report(cards, { groupBy: 'nope' }).groupBy, 'project');
});

test('tokensFromStatus: only the same session', () => {
  const st = { session_id: SID, cost: { total_cost_usd: 1.25 }, context_window: { total_input_tokens: 300, total_output_tokens: 40 } };
  assert.deepEqual(BM.tokensFromStatus(st, SID), { tokens: 340, usd: 1.25 });
  assert.equal(BM.tokensFromStatus(st, SID2), null);
  assert.equal(BM.tokensFromStatus(null, SID), null);
});

test('HQ.addTask: every row and request has a type (explicit, else classified)', () => {
  let b = HQ.addTask({ tasks: [], requests: [] }, { id: 't1', request: 'r1', title: 'Checkout crash', task: 'fix it', prompt: '' }, 1);
  assert.equal(b.tasks[0].type, 'bugfix');
  assert.equal(b.requests[0].type, 'bugfix');
  b = HQ.addTask(b, { id: 't2', request: 'r2', title: 'Dashboard', task: 'new page', type: 'hotfix' }, 2);
  assert.equal(b.tasks[0].type, 'hotfix');
  assert.equal(b.requests[0].type, 'hotfix');
  assert.equal(b.requests[0].typeBy, 'hq');
  b = HQ.addTask(b, { id: 't3', request: 'r3', title: 'feature: crash analytics', task: 'x' }, 3);
  assert.equal(b.tasks[0].type, 'feature');
});

test('release order: waiting stages and paced sends go bugfix, hotfix, feature', () => {
  const board = { tasks: [
    { id: 'p', status: 'reported', at: 1 },
    { id: 'f', status: CH.WAITING, after: 'p', type: 'feature', at: 2 },
    { id: 'b', status: CH.WAITING, after: 'p', type: 'bugfix', at: 3 },
    { id: 'h', status: CH.WAITING, after: 'p', type: 'hotfix', at: 4 },
  ], requests: [] };
  assert.deepEqual(CH.settle(board, 5).release.map((x) => x.id), ['b', 'h', 'f']);
  let t = 0;
  const pacer = HQ.createPacer({ burst: 1, everyMs: 1000, now: () => t });
  const sent = [];
  pacer.submit('k', () => sent.push('first'));
  pacer.submit('k', () => sent.push('feature'), 'feature');
  pacer.submit('k', () => sent.push('bugfix'), 'bugfix');
  pacer.submit('k', () => sent.push('hotfix'), 'hotfix');
  for (let i = 1; i <= 3; i++) { t = i * 1000; pacer.flush(); }
  assert.deepEqual(sent, ['first', 'bugfix', 'hotfix', 'feature']);
});

test('task sessions: remembered across a reload, deduped, invalid ids ignored, capped to the newest', () => {
  let s = BM.markTaskSession(BM.emptyStore(), SID);
  assert.ok(BM.isTaskSession(s, SID));
  assert.equal(BM.markTaskSession(s, SID), s);
  assert.equal(BM.markTaskSession(s, 'not-a-sid'), s);
  const back = BM.loadStore(JSON.parse(JSON.stringify({ ...s, taskSids: [...s.taskSids, SID, 'bad', 7] })));
  assert.deepEqual(back.taskSids, [SID]);
  const many = [];
  for (let i = 0; i < BM.MAX_TASK_SIDS + 5; i++) many.push(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const capped = BM.loadStore({ taskSids: many });
  assert.equal(capped.taskSids.length, BM.MAX_TASK_SIDS);
  assert.equal(capped.taskSids[0], many[5]);   // the oldest dropped first
});
