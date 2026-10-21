// Tests for src/pty-attach.js: the wiring shared by every pty's onData/onExit registrations (id guard, quit ignore,
// swallowed throws, disposables). A fake pty carries the registrations; the events are emitted by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPty } = require('../src/pty-attach.js');

// A pty stand-in: onData / onExit keep their listeners, emit() delivers to them, each registration disposes itself.
function fakePty() {
  const listeners = { data: [], exit: [] };
  return {
    onData: (f) => { listeners.data.push(f); return { dispose: () => { const i = listeners.data.indexOf(f); if (i !== -1) listeners.data.splice(i, 1); } }; },
    onExit: (f) => { listeners.exit.push(f); return { dispose: () => { const i = listeners.exit.indexOf(f); if (i !== -1) listeners.exit.splice(i, 1); } }; },
    emit: (kind, ev) => { for (const f of [...listeners[kind]]) f(ev); },
  };
}

test('pty-attach: the id guard delivers only while the map holds this pty', () => {
  const map = new Map();
  const calls = [];
  const t = fakePty();
  attachPty(map, 'id', t, { onData: (d) => calls.push(`data:${d}`), onExit: () => calls.push('exit') });
  map.set('id', t);
  t.emit('data', 'a');
  map.set('id', fakePty());   // replaced: this pty is no longer the one
  t.emit('data', 'b');
  map.delete('id');           // killed on purpose: silent
  t.emit('exit');
  assert.deepEqual(calls, ['data:a']);
});

test('pty-attach: a throw in a handler is logged, the next event still works', () => {
  const map = new Map();
  const t = fakePty();
  const logs = [];
  let n = 0;
  const dispose = attachPty(map, 'id', t, {
    onData: () => { if (++n === 1) throw new Error('deliberate'); },
  }, { log: (...a) => logs.push(a.join(' ')) });
  map.set('id', t);
  t.emit('exit');
  t.emit('data');
  t.emit('data');
  assert.equal(n, 2);
  assert.match(logs[0], /pty handler: deliberate/);
  dispose();
});

test('pty-attach: ignore() (the quitting flag) silences every event', () => {
  const map = new Map();
  const calls = [];
  const t = fakePty();
  attachPty(map, 'id', t, { onData: (d) => calls.push(d), onExit: () => calls.push('exit') }, { ignore: () => true });
  map.set('id', t);
  t.emit('data', 'x');
  t.emit('exit');
  assert.deepEqual(calls, []);
});

test('pty-attach: dispose drops every registration, the pty may exist still', () => {
  const map = new Map();
  const calls = [];
  const t = fakePty();
  const dispose = attachPty(map, 'id', t, { onData: () => calls.push('d'), onExit: () => calls.push('e') });
  assert.deepEqual(calls, []);
  map.set('id', t);
  t.emit('data');
  t.emit('exit');
  assert.deepEqual(calls, ['d', 'e']);
  dispose();
  t.emit('data');
  t.emit('exit');
  assert.deepEqual(calls, ['d', 'e']);
});

test('pty-attach: events pass through untouched, unused handlers stay unregistered', () => {
  const map = new Map();
  const t = fakePty();
  let seen = null;
  const dispose = attachPty(map, 'id', t, { onExit: (e) => { seen = e; } });
  map.set('id', t);
  const ev = { exitCode: 7 };
  t.emit('exit', ev);
  assert.equal(seen, ev);
  dispose();
});

test('pty-attach: two ptys of the same id do not cross wires', () => {
  const map = new Map();
  const calls = [];
  const t1 = fakePty();
  const t2 = fakePty();
  const dispose1 = attachPty(map, 'ok', t1, { onData: () => calls.push('t1') });
  const dispose2 = attachPty(map, 'ok', t2, { onData: () => calls.push('t2') });
  map.set('ok', t2);
  t1.emit('data');   // stale pty: silent
  t2.emit('data');
  assert.deepEqual(calls, ['t2']);
  dispose1();
  dispose2();
});
