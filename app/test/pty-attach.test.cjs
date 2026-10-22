// Tests for src/pty-attach.js: the one wiring path for every pty's onData/onExit registrations (id guard, the quit
// guard of src/pty-guard.js: muted while quitting, logged throws, held disposables that release(t) drops). A fake pty
// carries the registrations; the events are emitted by hand. The real createGuard is used, not a stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPty } = require('../src/pty-attach.js');
const PG = require('../src/pty-guard.js');

// A pty stand-in: onData / onExit keep their listeners, emit() delivers to them, each registration disposes itself.
function fakePty() {
  const listeners = { data: [], exit: [] };
  const reg = (kind) => (f) => { listeners[kind].push(f); return { dispose: () => { const i = listeners[kind].indexOf(f); if (i !== -1) listeners[kind].splice(i, 1); } }; };
  return { onData: reg('data'), onExit: reg('exit'), emit: (kind, ev) => { for (const f of [...listeners[kind]]) f(ev); }, count: (kind) => listeners[kind].length };
}
const guard = (isQuitting = () => false) => PG.createGuard(isQuitting);

test('pty-attach: the id guard delivers only while the map holds this pty', () => {
  const map = new Map();
  const calls = [];
  const t = fakePty();
  attachPty(map, 'id', t, { onData: (d) => calls.push(`data:${d}`), onExit: () => calls.push('exit') }, guard());
  map.set('id', t);
  t.emit('data', 'a');
  map.set('id', fakePty());   // replaced: this pty is no longer the one
  t.emit('data', 'b');
  map.delete('id');           // killed on purpose: silent
  t.emit('exit');
  assert.deepEqual(calls, ['data:a']);
});

test('pty-attach: map null has no id guard (the relay facade listeners)', () => {
  const calls = [];
  const t = fakePty();
  attachPty(null, 'id', t, { onExit: (e) => calls.push(e.exitCode) }, guard());
  t.emit('exit', { exitCode: 3 });
  assert.deepEqual(calls, [3]);
});

test('pty-attach: a throw in a handler is logged by guarded(), the next event still works', (tt) => {
  const logs = [];
  tt.mock.method(console, 'error', (...a) => logs.push(a.join(' ')));
  const map = new Map();
  const t = fakePty();
  let n = 0;
  attachPty(map, 'id', t, { onData: () => { if (++n === 1) throw new Error('deliberate'); } }, guard());
  map.set('id', t);
  t.emit('data');
  t.emit('data');
  assert.equal(n, 2);
  assert.match(logs[0], /pty callback: deliberate/);
});

test('pty-attach: while quitting nothing is delivered; once quitting is reset, events flow again', () => {
  let quitting = true;
  const map = new Map();
  const calls = [];
  const t = fakePty();
  attachPty(map, 'id', t, { onData: (d) => calls.push(d), onExit: () => calls.push('exit') }, guard(() => quitting));
  map.set('id', t);
  t.emit('data', 'x');
  t.emit('exit');
  quitting = false;   // main's unquit(): the update install did not quit
  t.emit('data', 'y');
  assert.deepEqual(calls, ['y']);
});

test('pty-attach: listeners are held, release(t) drops every one of them before a kill', () => {
  const g = guard();
  const map = new Map();
  const calls = [];
  const t = fakePty();
  attachPty(map, 'id', t, { onData: () => calls.push('d'), onExit: () => calls.push('e') }, g);
  attachPty(null, 'id', t, { onData: () => calls.push('facade') }, g);
  map.set('id', t);
  assert.equal(t.count('data'), 2);
  g.release(t);
  assert.equal(t.count('data'), 0);
  assert.equal(t.count('exit'), 0);
  t.emit('data');
  t.emit('exit');
  assert.deepEqual(calls, []);
});

test('pty-attach: the returned IDisposable drops only its own listeners, and is safe twice', () => {
  const g = guard();
  const t = fakePty();
  const calls = [];
  attachPty(null, 'id', t, { onData: () => calls.push('a') }, g);
  const sub = attachPty(null, 'id', t, { onData: () => calls.push('b') }, g);
  sub.dispose();
  sub.dispose();
  t.emit('data');
  assert.deepEqual(calls, ['a']);
  g.release(t);   // the already disposed one is disposed again harmlessly
  assert.equal(t.count('data'), 0);
});

test('pty-attach: events pass through untouched, unused handlers stay unregistered', () => {
  const map = new Map();
  const t = fakePty();
  let seen = null;
  attachPty(map, 'id', t, { onExit: (e) => { seen = e; } }, guard());
  assert.equal(t.count('data'), 0);
  map.set('id', t);
  const ev = { exitCode: 7 };
  t.emit('exit', ev);
  assert.equal(seen, ev);
});

test('pty-attach: two ptys of the same id do not cross wires', () => {
  const map = new Map();
  const calls = [];
  const t1 = fakePty();
  const t2 = fakePty();
  attachPty(map, 'ok', t1, { onData: () => calls.push('t1') }, guard());
  attachPty(map, 'ok', t2, { onData: () => calls.push('t2') }, guard());
  map.set('ok', t2);
  t1.emit('data');   // stale pty: silent
  t2.emit('data');
  assert.deepEqual(calls, ['t2']);
});

// Every pty start in main.js (agent tabs, logins, the relay, the plain terminal tab, and any start added later) must
// register its listeners through attachPty: a direct t.onData( / t.onExit( would skip the id guard, the quit guard
// and hold(), so release(t) could not drop it before a kill. Comments are left out; the facade's `onData:` keys are
// property names, not calls.
test('main.js registers no pty listener outside attachPty', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // line-wise, so a '/*' inside a string (a git glob) cannot hide code: comment lines and trailing // comments go
  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').split('\n')
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '')));
  const direct = code.map((l, i) => [i + 1, l]).filter(([, l]) => /\.\s*on(Data|Exit)\s*\(/.test(l));
  assert.deepEqual(direct, [], 'direct .onData( / .onExit( calls in main.js: use attachPty');
  // the helper is the one place that calls them
  const helper = fs.readFileSync(path.join(__dirname, '..', 'src', 'pty-attach.js'), 'utf8');
  assert.match(helper, /t\.onData\(/);
  assert.match(helper, /t\.onExit\(/);
});
