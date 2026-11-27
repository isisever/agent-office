'use strict';
// v3.135 live order tracking and order cost: pure helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const OT = require('../src/order-track.js');
const BM = require('../src/board-model.js');

const SID = '11111111-2222-3333-4444-555555555555';
const SID2 = '66666666-7777-8888-9999-000000000000';

test('observe: the delta of one session from the first sample to the last', () => {
  let e = OT.observe(undefined, { sid: SID, tokens: 1000, usd: 0.5 });
  assert.deepEqual(OT.taskCost(e), { tokens: 0, usd: 0 });
  e = OT.observe(e, { sid: SID, tokens: 4000, usd: 2 });
  assert.deepEqual(OT.taskCost(e), { tokens: 3000, usd: 1.5 });
  e = OT.observe(e, { sid: SID, tokens: 5000, usd: 2.5 }, { final: true });
  assert.equal(e.f, 1);
  assert.equal(OT.observe(e, { sid: SID, tokens: 9000, usd: 9 }), e, 'a frozen entry never moves');
  assert.deepEqual(OT.taskCost(e), { tokens: 4000, usd: 2 });
});

test('observe: a fresh desk session counts from zero; a new session carries the old delta', () => {
  let e = OT.observe(undefined, { sid: SID, tokens: 200, usd: 0.1 }, { fresh: true });
  assert.deepEqual(OT.taskCost(e), { tokens: 200, usd: 0.1 });
  e = OT.observe(e, { sid: SID2, tokens: 50, usd: 0.05 });
  assert.deepEqual(OT.taskCost(e), { tokens: 250, usd: 0.15000000000000002 });
  assert.equal(OT.observe(undefined, null), null);
  assert.equal(OT.observe(undefined, { sid: 'nope', tokens: 1 }), null);
});

test('cleanUsage drops broken entries', () => {
  const u = OT.cleanUsage({ t1: { s: SID, b: [1, 2], l: [3, 4] }, 'bad id!': { s: SID }, t2: { s: 'x' }, t3: { s: SID, b: 'x', l: [-1, 'y'], f: 1 } });
  assert.deepEqual(Object.keys(u), ['t1', 't3']);
  assert.deepEqual(u.t3, { s: SID, b: [0, 0], l: [0, 0], f: 1 });
});

test('orderCost: local deltas plus remote report costs; a remote task without one is unknown', () => {
  const tasks = [{ id: 'a', machine: 'self' }, { id: 'b', machine: 'pubX', cost: { tokens: 100, usd: 0.25 } }, { id: 'c', machine: 'pubY' }];
  const usage = { a: { s: SID, b: [100, 0.1], l: [1100, 0.6] } };
  assert.deepEqual(OT.orderCost(tasks, usage), { tokens: 1100, usd: 0.75, unknown: 1 });
  assert.deepEqual(OT.reportCost({ usd: 1.2 }), { tokens: 0, usd: 1.2 });
  assert.equal(OT.reportCost({ summary: 'x' }), null);
});

test('board-model: sampleUsage stores per task; the order card shows tokens and usd; report rows include it', () => {
  const board = { requests: [{ id: 'r12', at: 1, prompt: 'bugfix: login', tasks: ['a'], summary: 'ok' }],
    tasks: [{ id: 'a', request: 'r12', status: 'reported', machine: 'self', project: 'X', at: 1, startedAt: 2, finishedAt: 10 }] };
  let s = BM.emptyStore();
  s = BM.sampleUsage(s, 'r12', 'a', { sid: SID, tokens: 0, usd: 0 }, { fresh: true });
  s = BM.sampleUsage(s, 'r12', 'a', { sid: SID, tokens: 5000, usd: 1.25 }, { final: true });
  const again = BM.sampleUsage(s, 'r12', 'a', { sid: SID, tokens: 9000, usd: 3 });
  assert.equal(again, s, 'frozen: unchanged store');
  const loaded = BM.loadStore(JSON.parse(JSON.stringify(s)));
  const card = BM.boardCards(board, loaded).cards.find((c) => c.id === 'o:r12');
  assert.equal(card.tokens, 5000);
  assert.equal(card.usd, 1.25);
  const rep = BM.report([card], { groupBy: 'project' });
  assert.equal(rep.rows[0].orders, 1);
  assert.equal(rep.total.usd, 1.25);
});

test('orderStrip: open orders only, the task that needs you first, queue places', () => {
  const cards = [
    { id: 'o:r12', kind: 'order', request: 'r12', type: 'bugfix', column: 'working', progress: { done: 3, total: 5 },
      tasks: [{ id: 'a', status: 'reported', project: 'X' }, { id: 'b', status: 'running', project: 'X', member: 'Ayşe (QA)' }, { id: 'c', status: 'queued', project: 'Y' }] },
    { id: 'o:r13', kind: 'order', request: 'r13', type: 'feature', column: 'todo', progress: { done: 0, total: 1 }, tasks: [{ id: 'd', status: 'queued', project: 'Z' }] },
    { id: 'o:r14', kind: 'order', request: 'r14', type: 'feature', column: 'done', progress: { done: 1, total: 1 }, tasks: [] },
    { id: 'c:x', kind: 'chat', column: 'working' },
  ];
  const items = OT.orderStrip(cards, { d: { pos: 3, len: 3 } });
  assert.deepEqual(items.map((i) => i.id), ['o:r12', 'o:r13']);
  assert.equal(items[0].current.state, 'working');
  assert.equal(items[0].current.member, 'Ayşe (QA)');
  assert.equal(items[1].current.ahead, 2);
  const n = OT.orderStrip([{ ...cards[0], tasks: [...cards[0].tasks, { id: 'e', status: 'needs-approval', project: 'W' }] }])[0];
  assert.equal(n.current.state, 'needs');
});

test('progressLine formats one item', async () => {
  const { progressLine } = await import('../src/board-view.mjs');
  const item = { request: 'r12', type: 'bugfix', done: 3, total: 5, current: { state: 'working', project: 'X', machine: 'self', member: 'Ayşe (QA)', ahead: 0 } };
  assert.equal(progressLine(item), 'Order #r12 · bugfix · 3/5 done · desk Ayşe (QA) working on project X');
  assert.equal(progressLine({ ...item, current: { state: 'queued', project: 'Y', machine: 'self', member: '', ahead: 2 } }), 'Order #r12 · bugfix · 3/5 done · boss queued on project Y, 2 ahead');
  assert.equal(progressLine({ ...item, current: { state: 'failed', project: 'P', machine: 'laptop', member: '', ahead: 0 } }), 'Order #r12 · bugfix · 3/5 done · boss failed on project P on laptop');
  assert.equal(progressLine({ ...item, current: null }, undefined, (x) => x.toUpperCase()), 'Order #r12 · BUGFIX · 3/5 done');
  assert.equal(progressLine(null), '');
});
