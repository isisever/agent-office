// End to end, in process: the phone's controller.js (+ ctl-client.js) against the desktop Link's controller handlers.
// The desktop hello reaches the phone later than the 'online' event, like on a real connection.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const crypto = require('crypto');
const C = require('../src/link-core.js');
const W = require('../src/link-wire.js');
const { Link } = require('../src/link.js');
const { createController } = require('../../ios/core/controller.js');

function desktop(helloDelayMs) {
  const pub = 'cc'.repeat(32);
  const l = Object.create(Link.prototype);
  EventEmitter.call(l);
  const dev = { pub, name: 'Phone', kind: 'controller', own: false, ctl: true };
  Object.assign(l, { devices: [dev], secrets: { [pub]: 'ee'.repeat(32) }, peers: new Map(), sessOut: new Map(), sessOpens: new Map(), ctlConns: new Map(), ctlSeq: 0,
    now: () => 1000, ctlHq: 'idle', name: 'Desk', limiter: new C.RateLimiter({ now: () => 1000 }), queryLimiter: new C.RateLimiter({ burst: 16, everyMs: 2000, now: () => 1000 }),
    snap: { projects: [{ id: 'p1', name: 'Alpha', engine: 'claude', status: 'idle', working: 0, attention: null }], workers: [], delivered: 0 } });
  l.sealed = () => l.devices;
  l.emit = EventEmitter.prototype.emit.bind(l);
  l.on = EventEmitter.prototype.on.bind(l);
  l.listenerCount = EventEmitter.prototype.listenerCount.bind(l);
  l.on('ctl-proj', ({ reply }) => reply([{ sid: 's1', title: 'one', at: 1, running: false, main: true }]));
  l.on('ctl-op', ({ id, op, reply }) => { l.ops = (l.ops || []).concat({ id, op }); reply('ok'); });
  l.on('sess-open', ({ refuse }) => refuse('no-session'));
  const toPhone = [];
  let phoneConn = null;
  const conn = { destroyed: false, destroy() { this.destroyed = true; } };
  l.write = (c, m) => { const line = W.encode(m); if (line) setImmediate(() => phoneConn?.emit('data', line)); };
  const reader = new W.LineReader((raw) => l.handleCtl(conn, dev, raw));
  return {
    l, toPhone,
    attach(pc) { phoneConn = pc; setTimeout(() => l.write(conn, { t: 'hello', v: C.PROTOCOL, name: 'Desk', caps: W.CTL_CAPS }), helloDelayMs); },
    fromPhone: (chunk) => reader.push(chunk),
  };
}

function phone(dsk) {
  const out = [];
  class FakeSwarm extends EventEmitter {
    constructor(o) { super(); this.o = o; }
    join() { setImmediate(() => { const c = new EventEmitter(); c.destroyed = false; c.destroy = () => { if (!c.destroyed) { c.destroyed = true; setImmediate(() => c.emit('close')); } }; c.remotePublicKey = Buffer.from('aa'.repeat(32), 'hex'); c.write = (s) => dsk.fromPhone(s); dsk.attach(c); this.emit('connection', c); }); return { flushed: async () => {} }; }
    async destroy() {}
  }
  const DHT = { keyPair: (seed) => ({ publicKey: crypto.createHash('sha256').update(seed).digest(), secretKey: seed }) };
  const ctl = createController({ Hyperswarm: FakeSwarm, DHT, crypto, out: (m) => out.push(m) });
  return { ctl, out };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a project screen request made the moment the phone goes online is answered, not "mac-outdated"', async () => {
  const dsk = desktop(40);
  const { ctl, out } = phone(dsk);
  await ctl.command({ t: 'init', name: 'iPhone', seed: '11'.repeat(32), paired: { pub: 'aa'.repeat(32), secret: 'bb'.repeat(32), name: 'Desk' } });
  for (let i = 0; i < 100 && !out.some((m) => m.t === 'status' && m.state === 'online'); i++) await wait(5);
  assert.ok(out.some((m) => m.t === 'status' && m.state === 'online'));
  // what WorkletModel does on 'online': the project screen and a session are requested at once
  await ctl.command({ t: 'send', msg: { t: 'ctl-proj', id: 'j1', project: 'p1' } });
  await ctl.command({ t: 'send', msg: { t: 'sess-open', id: 's1', project: 'p1', sid: 's1' } });
  await wait(200);
  const recv = out.filter((m) => m.t === 'recv').map((m) => m.msg);
  assert.ok(!recv.some((m) => m.t === 'mac-outdated'), `got ${JSON.stringify(recv.map((m) => m.t))}`);
  const proj = recv.find((m) => m.t === 'ctl-proj');
  assert.equal(proj?.proj?.sessions?.[0]?.sid, 's1');
  assert.ok(recv.some((m) => m.t === 'sess-end' && m.id === 's1' && m.reason === 'no-session'), 'sess-open with sid reaches the desktop handler');
  await ctl.destroy();
});

test('ctl-send right after going online is delivered and acked', async () => {
  const dsk = desktop(40);
  const { ctl, out } = phone(dsk);
  await ctl.command({ t: 'init', name: 'iPhone', seed: '11'.repeat(32), paired: { pub: 'aa'.repeat(32), secret: 'bb'.repeat(32), name: 'Desk' } });
  for (let i = 0; i < 100 && !out.some((m) => m.t === 'status' && m.state === 'online'); i++) await wait(5);
  await ctl.command({ t: 'send', msg: { t: 'ctl-send', id: 'x1', project: 'p1', text: 'hello' } });
  await wait(100);
  const recv = out.filter((m) => m.t === 'recv').map((m) => m.msg);
  assert.ok(!recv.some((m) => m.t === 'mac-outdated'));
  assert.ok(recv.some((m) => m.t === 'ctl-ack' && m.id === 'x1' && m.status === 'queued'), `got ${JSON.stringify(recv)}`);
  await ctl.destroy();
});

test('a desktop without ctl2 still gets "mac-outdated" for the project screen', async () => {
  const dsk = desktop(10);
  dsk.attach = function (pc) { setTimeout(() => this.l.write({}, { t: 'hello', v: 2, name: 'Old', caps: ['ctl', 'sess'] }), 10); this.pc = pc; };
  const { ctl, out } = phone(dsk);
  const l = dsk.l; dsk.attach = ((orig) => function (pc) { l.write = (c, m) => { const line = W.encode(m); if (line) setImmediate(() => pc.emit('data', line)); }; orig.call(this, pc); })(dsk.attach);
  await ctl.command({ t: 'init', name: 'iPhone', seed: '11'.repeat(32), paired: { pub: 'aa'.repeat(32), secret: 'bb'.repeat(32), name: 'Old' } });
  for (let i = 0; i < 100 && !out.some((m) => m.t === 'status' && m.state === 'online'); i++) await wait(5);
  await ctl.command({ t: 'send', msg: { t: 'ctl-proj', id: 'j1', project: 'p1' } });
  await wait(150);
  assert.ok(out.some((m) => m.t === 'recv' && m.msg.t === 'mac-outdated'));
  await ctl.destroy();
});

test('a ctl-send whose client is replaced during the caps wait is rejected, not dropped silently', async () => {
  const dsk = desktop(400);
  const { ctl, out } = phone(dsk);
  const paired = { pub: 'aa'.repeat(32), secret: 'bb'.repeat(32), name: 'Desk' };
  await ctl.command({ t: 'init', name: 'iPhone', seed: '11'.repeat(32), paired });
  for (let i = 0; i < 100 && !out.some((m) => m.t === 'status' && m.state === 'online'); i++) await wait(5);
  const sending = ctl.command({ t: 'send', msg: { t: 'ctl-send', id: 'x9', project: 'p1', text: 'hello' } });
  await wait(20);
  await ctl.command({ t: 'init', name: 'iPhone', seed: '22'.repeat(32), paired });
  await sending;
  const ack = out.filter((m) => m.t === 'recv').map((m) => m.msg).find((m) => m.t === 'ctl-ack' && m.id === 'x9');
  assert.ok(ack && ack.status === 'rejected' && ack.op === 'send', `got ${JSON.stringify(out)}`);
  assert.ok(W.validateCtl(ack), 'the ack passes the same validation the phone applies');
  await ctl.destroy();
});
