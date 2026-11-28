// v3.178 cap 'ctl2': wire validators and the desktop Link's handling of a phone's any-project sess-open and ctl-proj.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const C = require('../src/link-core.js');
const W = require('../src/link-wire.js');
const { Link } = require('../src/link.js');

const ok = (m) => assert.deepEqual(W.validateCtl(m), m, JSON.stringify(m));
const bad = (m) => assert.equal(W.validateCtl(m), null, JSON.stringify(m));

test('ctl2 is a cap and every new message is validated', () => {
  assert.ok(W.CTL_CAPS.includes('ctl2'));
  // ctl-proj: request, answer, error
  ok({ t: 'ctl-proj', id: 'a', project: 'p1' });
  bad({ t: 'ctl-proj', id: 'a' });
  bad({ t: 'ctl-proj', id: 'bad id', project: 'p1' });
  const proj = { id: 'p1', name: 'Alpha', engine: 'claude', status: 'working', attention: 'permission', tool: 'Bash',
    sessions: [{ sid: 's1', title: 'fix', at: 5, running: true, main: true }],
    pending: [{ askId: 'k1', kind: 'question', at: 7, tool: 'Ask', detail: 'which?', options: [{ key: 'o1', label: 'One' }] }] };
  ok({ t: 'ctl-proj', id: 'a', project: 'p1', proj });
  bad({ t: 'ctl-proj', id: 'a', project: 'p1', proj: { ...proj, status: 'nope' } });
  assert.equal(W.validateCtl({ t: 'ctl-proj', id: 'a', project: 'p1', proj: { ...proj, sessions: Array.from({ length: 40 }, (_, i) => ({ sid: `s${i}`, title: 't', at: 1 })) } }).proj.sessions.length, W.CTL_SESSIONS);
  ok({ t: 'ctl-proj', id: 'a', project: 'p1', error: 'engine' });
  bad({ t: 'ctl-proj', id: 'a', project: 'p1', error: 'weird' });
  // ctl-send
  ok({ t: 'ctl-send', id: 'a', project: 'p1', text: 'go' });
  bad({ t: 'ctl-send', id: 'a', project: 'p1' });
  bad({ t: 'ctl-send', id: 'a', project: 'p1', text: 'x'.repeat(W.MAX_COMMAND * 4 + 1) });
  // ctl-ask / ctl-ask-clear
  ok({ t: 'ctl-ask', seq: 1, project: 'p1', ask: { askId: 'k1', kind: 'permission', at: 3 } });
  bad({ t: 'ctl-ask', seq: 1, project: 'p1', ask: { askId: 'k1', kind: 'other', at: 3 } });
  bad({ t: 'ctl-ask', project: 'p1', ask: { askId: 'k1', kind: 'plan', at: 3 } });
  assert.equal(W.validateCtl({ t: 'ctl-ask', seq: 1, project: 'p1', ask: { askId: 'k1', kind: 'question', at: 3, options: Array.from({ length: 12 }, (_, i) => ({ key: `o${i}`, label: 'l' })) } }).ask.options.length, W.CTL_ASK_OPTIONS);
  assert.equal(W.validateCtl({ t: 'ctl-ask', seq: 1, project: 'p1', ask: { askId: 'k1', kind: 'plan', at: 3, detail: 'a\nb' } }).ask.detail.includes('\n'), false);
  ok({ t: 'ctl-ask-clear', seq: 2, project: 'p1', askId: 'k1' });
  bad({ t: 'ctl-ask-clear', seq: 2, project: 'p1' });
  // ctl-answer: exactly one key
  ok({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { decision: 'allow' } });
  ok({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { decision: 'deny' } });
  ok({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { option: 'o1' } });
  ok({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { text: 'hello' } });
  bad({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { decision: 'maybe' } });
  bad({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { decision: 'allow', text: 'x' } });
  bad({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: {} });
  bad({ t: 'ctl-answer', id: 'a', project: 'p1', askId: 'k1', answer: { text: 'x'.repeat(2001) } });
  bad({ t: 'ctl-answer', id: 'a', project: 'p1', answer: { decision: 'allow' } });
  // ctl-stop / ctl-ack
  ok({ t: 'ctl-stop', id: 'a', project: 'p1' });
  bad({ t: 'ctl-stop', id: 'a' });
  ok({ t: 'ctl-ack', id: 'a', op: 'send', status: 'queued' });
  ok({ t: 'ctl-ack', id: 'a', op: 'answer', status: 'rejected', reason: 'stale' });
  bad({ t: 'ctl-ack', id: 'a', op: 'other', status: 'done' });
  bad({ t: 'ctl-ack', id: 'a', op: 'stop', status: 'maybe' });
  bad({ t: 'ctl-ack', id: 'a', op: 'stop', status: 'done', reason: 'nope' });
});

test('sess-open takes an optional sid; unknown-session is a reason', () => {
  assert.deepEqual(C.validateMessage({ t: 'sess-open', id: 'a', project: 'p1' }), { t: 'sess-open', id: 'a', project: 'p1' });
  assert.deepEqual(C.validateMessage({ t: 'sess-open', id: 'a', project: 'p1', sid: 's-1' }), { t: 'sess-open', id: 'a', project: 'p1', sid: 's-1' });
  assert.equal(C.validateMessage({ t: 'sess-open', id: 'a', project: 'p1', sid: 'bad sid' }), null);
  assert.ok(C.SESS_REASONS.includes('unknown-session'));
  assert.equal(C.validateMessage({ t: 'sess-end', id: 'a', reason: 'unknown-session' }).reason, 'unknown-session');
  assert.ok(C.SESS_PER_CONTROLLER >= 3);
});

function fakeLink(caps) {
  const pub = 'cc'.repeat(32);
  const l = Object.create(Link.prototype);
  EventEmitter.call(l);
  const dev = { pub, name: 'Phone', kind: 'controller', own: false, ctl: true };
  Object.assign(l, { devices: [dev], secrets: { [pub]: 'ee'.repeat(32) }, peers: new Map(), sessOut: new Map(), sessOpens: new Map(), ctlConns: new Map(), ctlSeq: 0,
    now: () => 1000, ctlHq: 'idle', name: 'Desk', limiter: new C.RateLimiter({ now: () => 1000 }), queryLimiter: new C.RateLimiter({ burst: 16, everyMs: 2000, now: () => 1000 }),
    snap: { projects: [{ id: 'p1', name: 'Alpha', engine: 'claude', status: 'working', working: 1, attention: null }, { id: 'p2', name: 'Beta', engine: 'agy', status: 'idle', working: 0, attention: null }], workers: [], delivered: 0 } });
  l.sealed = () => l.devices;
  const sent = [];
  l.write = (conn, m) => sent.push(m);
  l.emit = EventEmitter.prototype.emit.bind(l);
  l.on = EventEmitter.prototype.on.bind(l);
  l.listenerCount = EventEmitter.prototype.listenerCount.bind(l);
  const conn = { destroyed: false, destroy() { this.destroyed = true; } };
  l.handleCtl(conn, dev, { t: 'hello', v: 2, caps });
  return { l, dev, conn, sent };
}

test('a ctl2 phone opens any project and a recent session; an old phone only the HQ', (t) => {
  const old = fakeLink(['ctl', 'sess']);
  old.l.handleCtl(old.conn, old.dev, { t: 'sess-open', id: 'a', project: 'p1' });
  assert.deepEqual(old.sent.at(-1), { t: 'sess-end', id: 'a', reason: 'not-allowed' });
  old.l.handleCtl(old.conn, old.dev, { t: 'ctl-proj', id: 'b', project: 'p1' });   // dropped: no ctl2
  assert.ok(!old.sent.some((m) => m.t === 'ctl-proj'));

  const x = fakeLink(['ctl', 'sess', 'ctl2']);
  const opened = [];
  x.l.on('sess-open', (o) => opened.push(o));
  x.l.handleCtl(x.conn, x.dev, { t: 'sess-open', id: 'a', project: 'p1' });
  x.l.handleCtl(x.conn, x.dev, { t: 'sess-open', id: 'b', project: 'p1', sid: 's-9' });
  x.l.handleCtl(x.conn, x.dev, { t: 'sess-open', id: 'c', project: 'hq' });
  assert.deepEqual(opened.map((o) => [o.project, o.sid]), [['p1', undefined], ['p1', 's-9'], ['hq', undefined]]);
  assert.ok(opened.every((o) => o.controller === true));
  x.l.handleCtl(x.conn, x.dev, { t: 'sess-open', id: 'd', project: 'p1' });   // the fourth one
  assert.deepEqual(x.sent.at(-1), { t: 'sess-end', id: 'd', reason: 'limit' });
  x.l.handleCtl(x.conn, x.dev, { t: 'sess-open', id: 'e', project: 'p1:tab' });
  assert.equal(x.sent.at(-1).reason, 'unknown-project');
});

test('ctl-proj answers with the project row and the host sessions', () => {
  const x = fakeLink(['ctl', 'sess', 'ctl2']);
  x.l.on('ctl-proj', ({ project, reply }) => reply([{ sid: 's1', title: 'fix', at: 4, running: true, main: true }]));
  x.l.handleCtl(x.conn, x.dev, { t: 'ctl-proj', id: 'r1', project: 'p1' });
  const r = x.sent.at(-1);
  assert.equal(r.t, 'ctl-proj'); assert.equal(r.id, 'r1');
  assert.equal(r.proj.name, 'Alpha'); assert.equal(r.proj.status, 'working');
  assert.deepEqual(r.proj.sessions, [{ sid: 's1', title: 'fix', at: 4, running: true, main: true }]);
  x.l.handleCtl(x.conn, x.dev, { t: 'ctl-proj', id: 'r2', project: 'p2' });
  assert.deepEqual(x.sent.at(-1), { t: 'ctl-proj', id: 'r2', project: 'p2', error: 'engine' });
  x.l.handleCtl(x.conn, x.dev, { t: 'ctl-proj', id: 'r3', project: 'nope' });
  assert.deepEqual(x.sent.at(-1), { t: 'ctl-proj', id: 'r3', project: 'nope', error: 'unknown-project' });
});
