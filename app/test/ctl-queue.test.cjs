'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../src/link-core.js');
const { createCtlQueue } = require('../src/ctl-queue.js');

// A fake session: takes input only when idle, like a project chat, a terminal PTY or HQ between turns.
function fake() {
  const s = { busy: true, got: [], clock: 0 };
  const q = createCtlQueue({ now: () => s.clock, ttlMs: 1000, max: 3,
    attempt: (key, text) => { if (key === 'gone') return 'engine'; if (s.busy) return 'wait'; s.got.push(text); return 'ok'; },
    onDrop: (key, text, reason) => { (s.dropped ||= []).push([text, reason]); } });
  return { s, q };
}

test('a message sent while the session is busy is queued, not refused, and delivered in order once it is idle', () => {
  const { s, q } = fake();
  assert.equal(q.submit('p1', 'one'), 'ok');   // 'ok' -> the phone gets the queued ack
  assert.equal(q.submit('p1', 'two'), 'ok');
  assert.deepEqual(s.got, []);
  assert.equal(q.drain(), 0);                  // still busy: nothing lost, nothing delivered
  assert.equal(q.pending('p1'), 2);
  s.busy = false;
  assert.equal(q.submit('p1', 'three'), 'ok'); // behind the waiting ones, order kept
  assert.equal(q.drain(), 3);
  assert.deepEqual(s.got, ['one', 'two', 'three']);
  assert.equal(q.pending('p1'), 0);
});

test('an idle session gets the message at once; a hard refusal is returned to the phone', () => {
  const { s, q } = fake();
  s.busy = false;
  assert.equal(q.submit('p1', 'now'), 'ok');
  assert.deepEqual(s.got, ['now']);
  assert.equal(q.submit('gone', 'x'), 'engine');
});

test('nothing is dropped silently: overflow is refused, expiry is reported', () => {
  const { s, q } = fake();
  for (const t of ['a', 'b', 'c']) assert.equal(q.submit('p1', t), 'ok');
  assert.equal(q.submit('p1', 'd'), 'busy');   // the phone sees a refusal
  s.clock = 5000;
  q.drain();
  assert.equal(s.dropped.length, 3);
  assert.equal(s.dropped[0][1], 'expired');
});

test('HQ: the old ctlTurn refused a busy HQ (the phone lost the turn); the queue turns that into a wait', () => {
  assert.equal(C.ctlTurn({ busy: 'busy', type: () => true, start: () => {} }), 'busy');
  const calls = [];
  const state = { busy: 'busy' };
  const q = createCtlQueue({ attempt: (k, text) => { const r = C.ctlTurn({ busy: state.busy, type: () => { calls.push(text); return true; }, start: () => calls.push(text) }); return r === 'queued' ? 'ok' : r === 'busy' ? 'wait' : r; } });
  assert.equal(q.submit('hq', 'order'), 'ok');
  state.busy = 'ready';
  q.drain();
  assert.deepEqual(calls, ['order']);
});

test('main.js routes a phone send and an HQ turn through the queue', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /if \(op === 'send'\) return ctlQueue\.submit\(id, text, late\)/);
  assert.match(src, /ctlHq: \(text, o\) => \{ const r = ctlQueue\.submit\(HQ\.HQ_ID, text, o\?\.late\)/);
  assert.match(src, /return \['busy', 'locked', 'not-running'\]\.includes\(why\) \? 'wait' : why/);
});

test('A: a queued message that later expires or hard-fails tells the phone that sent it (meta handed to onDrop)', () => {
  const told = [];
  const st = { clock: 0, mode: 'wait' };
  const q = createCtlQueue({ now: () => st.clock, ttlMs: 1000,
    attempt: () => st.mode, onDrop: (key, text, reason, late) => late?.(reason === 'expired' ? 'stale' : reason) });
  assert.equal(q.submit('p1', 'a', (r) => told.push(['a', r])), 'ok');
  assert.equal(q.submit('p1', 'b', (r) => told.push(['b', r])), 'ok');
  st.clock = 5000;
  q.drain();
  assert.deepEqual(told, [['a', 'stale'], ['b', 'stale']]);
  st.clock = 0; st.mode = 'wait';
  q.submit('p2', 'c', (r) => told.push(['c', r]));
  st.mode = 'engine';
  q.drain();
  assert.deepEqual(told[2], ['c', 'engine']);
});

test('A: link emits a late callback that pushes a rejected ctl-ack / ctl-hq-status, and the docs say so', () => {
  const link = fs.readFileSync(path.join(__dirname, '../src/link.js'), 'utf8');
  assert.match(link, /late: \(reason\) => ack\('rejected'/);
  assert.match(link, /late: \(reason\) => send\('rejected'/);
  const contract = fs.readFileSync(path.join(__dirname, '../CONTRACT.md'), 'utf8');
  assert.match(contract, /later `rejected`|a later `rejected`/);
  assert.match(contract, /in memory only/);
});

test('B: ctlSendNow answers wait while handoff-locked, before chatSend can print a notice', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const body = main.slice(main.indexOf('function ctlSendNow'));
  const lock = body.indexOf('if (handoffLocked(id)) return \'wait\'');
  assert.ok(lock > 0 && lock < body.indexOf('chatSend(id, text, [])'));
});

test('C: a hard refusal is rejected at once even when messages already wait behind a busy session', () => {
  let hqOn = true;
  const q = createCtlQueue({ attempt: () => 'wait', precheck: () => (hqOn ? null : 'no-hq') });
  assert.equal(q.submit('hq', 'one'), 'ok');
  hqOn = false;
  assert.equal(q.submit('hq', 'two'), 'no-hq');
  assert.equal(q.pending('hq'), 1);
});
