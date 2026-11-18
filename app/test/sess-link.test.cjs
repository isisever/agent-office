// Reading a remote project's session (contract v3.100): the wire (cap 'sess'), its bounds, the per-device permission
// "Allow reading sessions from this device" and the host's reader. Two src/link.js instances joined by in-memory streams.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('../src/link-core.js');
const CHAT = require('../src/chat.js');
const { Link } = require('../src/link.js');

const OLD_CAPS = ['res', 'catalog', 'report', 'manage', 'accounts', 'task-status', 'report2', 'revive'];   // a v3.99 peer
const kp = (n) => ({ publicKey: Buffer.alloc(32, n), secretKey: Buffer.alloc(64, n) });
const PA = C.hex(kp(1).publicKey);
const PB = C.hex(kp(2).publicKey);
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const swarmFactory = () => ({ join: () => ({ flushed: async () => {}, refresh: async () => {} }), on: () => {}, leave: async () => {}, destroy: async () => {} });
const item = (n, text = `message ${n}`) => ({ key: `k${n}`, at: 1000 + n, kind: 'assistant', text });
const sessWire = (l) => l.wire.filter((m) => String(m.t).startsWith('sess-'));

/** A = the machine that owns the project ("Studio"), B = the machine that reads ("Laptop"). */
function world(t, { allow = true, capsA = null, capsB = null, gap = 20 } = {}) {
  const clock = { now: 1e9 };
  const make = (who, caps) => {
    const other = who === 'A' ? PB : PA;
    const l = new Link({ keyPair: kp(who === 'A' ? 1 : 2), name: who === 'A' ? 'Studio' : 'Laptop', swarmFactory, now: () => clock.now, heartbeatMs: 60000, sessGapMs: gap });
    l.devices = C.normalizeDevices([{ pub: other, name: who === 'A' ? 'Laptop' : 'Studio', addedAt: 0, own: who !== 'A' || allow }]);
    l.secrets = { [other]: 'ab'.repeat(32) };
    if (caps) l.helloMsg = () => ({ t: 'hello', v: 2, name: l.name, caps });
    l.wire = [];
    const w = l.write.bind(l);
    l.write = (conn, m) => { l.wire.push(m); return w(conn, m); };
    l.got = [];
    for (const ev of ['sess-open', 'sess-closed', 'sess-items', 'sess-end']) l.on(ev, (m) => l.got.push([ev, m]));
    t.after(() => l.destroy());
    return l;
  };
  const a = make('A', capsA);
  const b = make('B', capsB);
  const x = new EventEmitter(); const y = new EventEmitter();
  for (const [p, q] of [[x, y], [y, x]]) {
    p.destroyed = false;
    p.write = (line) => { if (!p.destroyed) setImmediate(() => { if (!q.destroyed) q.emit('data', Buffer.from(line)); }); return true; };
    p.destroy = () => { if (p.destroyed) return; p.destroyed = q.destroyed = true; p.emit('close'); q.emit('close'); };
  }
  a.session(x, a.devices[0], 'test');
  b.session(y, b.devices[0], 'test');
  return { a, b, clock, drop: () => x.destroy(), ready: flush };
}
const of = (l, ev) => l.got.filter((g) => g[0] === ev).map((g) => g[1]);

test('sess wire: the cap is announced, validators rebuild every message and bound every field', () => {
  assert.ok(C.CAPS.includes('sess') && C.OUR_CAPS.includes('sess'));
  assert.deepEqual(C.validateMessage({ t: 'hello', v: 2, name: 'x', caps: ['sess', 'nope'] }).caps, ['sess']);
  assert.deepEqual(C.validateMessage({ t: 'sess-open', id: 'i1', project: 'p1', extra: 1 }), { t: 'sess-open', id: 'i1', project: 'p1' });
  assert.equal(C.validateMessage({ t: 'sess-open', id: 'i1', project: '../x' }), null);
  assert.deepEqual(C.validateMessage({ t: 'sess-keep', id: 'i1', x: 1 }), { t: 'sess-keep', id: 'i1' });
  assert.deepEqual(C.validateMessage({ t: 'sess-close', id: 'i1' }), { t: 'sess-close', id: 'i1' });
  for (const reason of C.SESS_REASONS) assert.deepEqual(C.validateMessage({ t: 'sess-end', id: 'i1', reason }), { t: 'sess-end', id: 'i1', reason });
  assert.deepEqual(C.SESS_REASONS, ['not-allowed', 'unknown-project', 'engine', 'no-session', 'rate-limited', 'limit']);
  assert.equal(C.validateMessage({ t: 'sess-end', id: 'i1', reason: 'because' }), null);
  const m = C.validateMessage({ t: 'sess-items', id: 'i1', seq: 3, reset: true, more: 'x', items: [
    { key: 'a b<c>', at: 5, kind: 'user', text: 'hi\x1b[31m there\x00', images: 3, path: '/secret' },
    { key: 'k2', at: -1, kind: 'tool', id: 'toolu_1', name: 'Bash', input: { command: 'rm' }, result: 'out' },
    { key: 'k3', kind: 'toolDone', id: 'toolu_1', error: 'yes', content: 'RESULT' },
    { key: 'k4', kind: 'note', note: 'compact' }, { key: 'k5', kind: 'note', note: 'other' },
    { key: 'k6', kind: 'thinking', text: 'hm' }, { key: 'k7', kind: 'assistant', text: '   ' }, null, 'x',
    { key: 'k8', kind: 'assistant', text: 'x'.repeat(C.MAX_FRAME + 1) },
  ] });
  assert.deepEqual(m, { t: 'sess-items', id: 'i1', seq: 3, reset: true, items: [
    { key: 'abc', at: 5, kind: 'user', text: 'hi there' },
    { key: 'k2', at: 0, kind: 'tool', id: 'toolu_1', name: 'Bash' },
    { key: 'k3', at: 0, kind: 'toolDone', id: 'toolu_1', error: false },
    { key: 'k4', at: 0, kind: 'note', note: 'compact' },
  ] });
  assert.equal(C.validateMessage({ t: 'sess-items', id: 'i1', seq: 0, items: new Array(C.SESS_FRAME_ITEMS + 1).fill({ kind: 'note', note: 'task' }) }), null);
  assert.equal(C.validateMessage({ t: 'sess-items', id: 'i1', seq: -1, items: [] }), null);
});

test('sess frames: measured in bytes after JSON.stringify (multi-byte text, escapes), every frame fits the link', () => {
  const texts = ['€'.repeat(20000), '😀'.repeat(30000), '"\\\n\t'.repeat(20000), 'plain '.repeat(3000)];
  const items = texts.map((x, n) => item(n, x)).concat(Array.from({ length: 500 }, (_, n) => item(100 + n, `çok kısa ${n} 😀`)));
  const frames = C.sessFrames('i1', 7, items, true);
  assert.ok(frames.length > 4);
  frames.forEach((f, n) => {
    const line = C.encode(f);
    assert.ok(line, 'the frame is under MAX_FRAME');
    assert.ok(Buffer.byteLength(line) <= C.SESS_FRAME_BYTES, `frame ${n}: ${Buffer.byteLength(line)} bytes`);
    assert.ok(Buffer.byteLength(line) < C.MAX_FRAME);
    assert.equal(f.seq, 7 + n);
    assert.equal(f.reset === true, n === 0);
    assert.ok(f.items.length <= C.SESS_FRAME_ITEMS);
    assert.deepEqual(C.validateMessage(JSON.parse(line)), f);   // what is sent is what the receiver keeps
  });
  const all = frames.flatMap((f) => f.items);
  assert.deepEqual(all.map((x) => x.key), items.map((x) => x.key));   // in order, none lost
  assert.ok(all[0].text.endsWith('…[truncated]') && all[0].text.length < texts[0].length);   // 60 KB of text: cut by bytes, and marked
  assert.ok(all[1].text.endsWith('…[truncated]') && all[1].text.length <= 20000 + 13);     // cut by characters
  assert.ok(!/[\ud800-\udbff]…/.test(all[1].text.slice(-20)), 'no half surrogate pair before the mark');
  assert.equal(all[3].text, texts[3]);
  assert.deepEqual(C.sessFrames('i1', 0, [], true), [{ t: 'sess-items', id: 'i1', seq: 0, items: [], reset: true }]);
  assert.deepEqual(C.sessFrames('i1', 0, [], false), []);
});

test('sess backfill: the last 200 items, at most 256 KB', () => {
  const many = Array.from({ length: 450 }, (_, n) => item(n));
  const out = C.sessBackfill(many);
  assert.equal(out.length, C.SESS_BACKFILL_ITEMS);
  assert.equal(out[0].key, 'k250');
  assert.equal(out.at(-1).key, 'k449');
  const big = C.sessBackfill(Array.from({ length: 100 }, (_, n) => item(n, 'ş'.repeat(8000))));   // 16 KB each
  assert.ok(big.length < 100 && big.length >= 14);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= C.SESS_BACKFILL_BYTES);
  assert.equal(big.at(-1).key, 'k99');   // the newest are kept
});

test('sess gate (v3.101): a paired device may read; a paused one hears not-allowed and gets no item', async (t) => {
  assert.equal(C.normalizeDevices([{ pub: PB, name: 'x' }])[0].allowSessions, undefined);   // the v3.100 switch is gone
  const all = C.normalizeDevices([{ pub: PB, name: 'x', own: false, allowHandoff: true, allowAccounts: true }]);
  assert.equal(C.maySessions(all, { [PB]: 'ab'.repeat(32) }, PB), false);   // paused: no, whatever else is on
  assert.equal(C.maySessions(C.normalizeDevices([{ pub: PB, name: 'x' }]), { [PB]: 'ab'.repeat(32) }, PB), true);
  assert.equal(C.maySessions(C.normalizeDevices([{ pub: PB, name: 'x' }]), {}, PB), false);   // not paired
  const { a, b, ready } = world(t, { allow: false });
  await ready();
  a.devices = a.devices.map((d) => ({ ...d, own: false }));
  const r = b.openSess(PA, 'p1');
  assert.equal(r.ok, true);
  await flush();
  assert.deepEqual(sessWire(a), [{ t: 'sess-end', id: r.id, reason: 'not-allowed' }]);
  assert.equal(of(a, 'sess-open').length, 0);
  assert.equal(a.sessOut.size, 0);
  assert.deepEqual(of(b, 'sess-end').map((m) => m.reason), ['not-allowed']);
  assert.equal(b.sessIn.size, 0);
  assert.equal(a.sessPush(`${PB}/${r.id}`, [item(1)]), false);
});

test('sess compat: a peer without the cap is never sent a sess message, in either direction', async (t) => {
  const old = world(t, { capsA: OLD_CAPS });   // the owning machine runs an older app
  await old.ready();
  assert.deepEqual(old.b.openSess(PA, 'p1'), { ok: false, reason: 'no-cap' });
  await flush();
  assert.deepEqual(sessWire(old.b), []);
  const reader = world(t, { capsB: OLD_CAPS });   // the reading machine never announced the cap: no answer at all
  await reader.ready();
  reader.b.write(reader.b.conns.get(PA), { t: 'sess-open', id: 'i1', project: 'p1' });
  await flush();
  assert.deepEqual(sessWire(reader.a), []);
  assert.equal(reader.a.sessOut.size, 0);
  assert.equal(of(reader.a, 'sess-open').length, 0);
});

test('sess stream: items reach the reader in order, at most 4 frames a second', async (t) => {
  assert.equal(Math.ceil(1000 / C.SESS_FRAMES_PER_SEC), 250);
  const { a, b, ready } = world(t, { gap: 250 });
  assert.equal(new Link({ keyPair: kp(3), name: 'x', swarmFactory }).sessGapMs, 250);
  await ready();
  const r = b.openSess(PA, 'p1');
  await flush();
  const open = of(a, 'sess-open')[0];
  assert.equal(open.project, 'p1');
  assert.equal(open.device.pub, PB);
  const big = Array.from({ length: 3 }, (_, n) => item(n, 'ö'.repeat(15000)));   // 30 KB each: one frame per item
  assert.equal(a.sessPush(open.key, big, { reset: true }), true);
  await flush();
  assert.equal(sessWire(a).length, 1);
  await wait(120);
  assert.equal(sessWire(a).length, 1);   // the second frame waits for its quarter second
  await wait(700);
  assert.equal(sessWire(a).length, 3);
  await flush();
  const got = of(b, 'sess-items');
  assert.deepEqual(got.map((m) => [m.id, m.seq, m.reset, m.items[0].key]), [[r.id, 0, true, 'k0'], [r.id, 1, false, 'k1'], [r.id, 2, false, 'k2']]);
  assert.equal(got[0].pub, PA);
  // items for a subscription this device did not open are dropped
  a.write(a.conns.get(PB), { t: 'sess-items', id: 'not-mine', seq: 0, items: [item(9)] });
  await flush();
  assert.equal(of(b, 'sess-items').length, 3);
  b.closeSess(r.id);
  await flush();
  assert.equal(a.sessOut.size, 0);
  assert.deepEqual(of(a, 'sess-closed').map((m) => m.why), ['closed']);
  assert.equal(a.sessPush(open.key, [item(5)]), false);
});

test('sess revoke: turning the permission off mid-stream ends it at once; waiting frames are never sent', async (t) => {
  const { a, b, ready } = world(t, { gap: 40 });
  await ready();
  const r = b.openSess(PA, 'p1');
  await flush();
  const { key } = of(a, 'sess-open')[0];
  a.sessPush(key, Array.from({ length: 6 }, (_, n) => item(n, 'x'.repeat(30000))), { reset: true });
  await flush();
  assert.equal(sessWire(a).filter((m) => m.t === 'sess-items').length, 1);
  a.setOwn(PB, false);
  assert.equal(a.sessOut.size, 0);
  assert.deepEqual(sessWire(a).at(-1), { t: 'sess-end', id: r.id, reason: 'not-allowed' });
  await wait(200);
  await flush();
  assert.equal(sessWire(a).filter((m) => m.t === 'sess-items').length, 1);
  assert.deepEqual(of(a, 'sess-closed').map((m) => m.why), ['revoked']);
  assert.deepEqual(of(b, 'sess-end').map((m) => m.reason), ['not-allowed']);
  assert.equal(a.sessPush(key, [item(9)]), false);
  // a permission taken away behind the setter's back is caught at the next send too
  a.setOwn(PB, true);
  b.openSess(PA, 'p1');
  await flush();
  const again = of(a, 'sess-open')[1];
  a.devices = a.devices.map((d) => ({ ...d, own: false }));
  assert.equal(a.sessPush(again.key, [item(1)]), false);
  assert.equal(a.sessOut.size, 0);
  assert.equal(sessWire(a).filter((m) => m.t === 'sess-items').length, 1);
});

test('sess unpair: removing the device ends its subscriptions and sends nothing more', async (t) => {
  const { a, b, ready } = world(t, { gap: 40 });
  await ready();
  b.openSess(PA, 'p1');
  await flush();
  const { key } = of(a, 'sess-open')[0];
  a.sessPush(key, Array.from({ length: 4 }, (_, n) => item(n, 'x'.repeat(30000))), { reset: true });
  await flush();
  const before = sessWire(a).length;
  await a.remove(PB);
  assert.equal(a.sessOut.size, 0);
  assert.deepEqual(of(a, 'sess-closed').map((m) => m.why), ['removed']);
  await wait(150);
  assert.equal(sessWire(a).length, before);
  assert.deepEqual(of(b, 'sess-end').map((m) => m.reason), ['offline']);   // the connection went with it
});

test('sess limits: two subscriptions per device, main tab only, idle timeout, the connection, the open rate', async (t) => {
  const { a, b, clock, ready, drop } = world(t);
  await ready();
  const conn = b.conns.get(PA);
  for (const id of ['s1', 's2', 's3']) b.write(conn, { t: 'sess-open', id, project: 'p1' });
  b.write(conn, { t: 'sess-open', id: 's4', project: 'p1:2' });   // an extra tab or a desk
  await flush();
  assert.equal(C.SESS_PER_DEVICE, 2);
  assert.deepEqual([...a.sessOut.values()].map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(sessWire(a), [{ t: 'sess-end', id: 's3', reason: 'limit' }, { t: 'sess-end', id: 's4', reason: 'unknown-project' }]);
  // the reading side gives up its oldest view instead of running into the cap
  const r1 = b.openSess(PA, 'p1'); const r2 = b.openSess(PA, 'p2'); const r3 = b.openSess(PA, 'p3');
  assert.deepEqual([...b.sessIn.keys()], [r2.id, r3.id]);
  assert.ok(sessWire(b).some((m) => m.t === 'sess-close' && m.id === r1.id));
  // idle: one is kept, the other is not
  assert.equal(C.SESS_IDLE_MS, 10 * 60 * 1000);
  clock.now += C.SESS_IDLE_MS - 1000;
  a.sweepSess();
  assert.equal(a.sessOut.size, 2);
  b.write(conn, { t: 'sess-keep', id: 's1' });
  await flush();
  clock.now += 2000;
  a.sweepSess();
  assert.deepEqual([...a.sessOut.values()].map((s) => s.id), ['s1']);
  assert.deepEqual(sessWire(a).at(-1), { t: 'sess-end', id: 's2', reason: 'limit' });
  assert.deepEqual(of(a, 'sess-closed').at(-1).why, 'idle');
  // a queue that outgrows its bound ends the subscription
  const key = `${PB}/s1`;
  assert.equal(a.sessPush(key, Array.from({ length: (C.SESS_QUEUE_MAX + 2) * 2 }, (_, n) => item(n, 'x'.repeat(20000)))), false);
  assert.deepEqual(sessWire(a).at(-1), { t: 'sess-end', id: 's1', reason: 'rate-limited' });
  // too many opens in a minute
  for (let n = 0; n < C.SESS_OPENS_PER_MIN + 2; n++) b.write(conn, { t: 'sess-open', id: `r${n}`, project: 'p1' });
  await flush();
  assert.ok(sessWire(a).some((m) => m.t === 'sess-end' && m.reason === 'rate-limited' && m.id.startsWith('r')));
  // the connection: every subscription on it ends, nothing is written after
  clock.now += 61000;
  b.write(conn, { t: 'sess-close', id: 'r0' });
  b.write(conn, { t: 'sess-open', id: 'last', project: 'p1' });
  await flush();
  assert.ok(a.sessOut.has(`${PB}/last`));
  const mine = b.openSess(PA, 'p9');
  const n = sessWire(a).length;
  drop();
  await flush();
  assert.equal(a.sessOut.size, 0);
  assert.equal(of(a, 'sess-closed').at(-1).why, 'offline');
  assert.equal(sessWire(a).length, n);
  assert.ok(of(b, 'sess-end').some((m) => m.id === mine.id && m.reason === 'offline'));
  assert.deepEqual(b.openSess(PA, 'p1'), { ok: false, reason: 'offline' });
});

test('sess host: only chat items of the main tab are read; tool rows carry the name only; sessions.log has no content', (t) => {
  const { setupLink } = require('../src/link-host.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sess-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const line = (o) => `${JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', ...o })}\n`;
  fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', message: { content: 'deploy with API_KEY_PROD=abc12345xyz please' } })
    + line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'PRIVATE-THOUGHT' }, { type: 'text', text: 'Running it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat /srv/app/hidden-path.txt' } }] } })
    + line({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'RESULT-BYTES' }, { type: 'image', source: { data: 'IMAGE-BYTES' } }] } }));
  let captured = null;
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; });
  const handlers = new Map();
  const notices = [];
  const sessions = { p1: { file }, p2: { reason: 'no-session' }, hq: { reason: 'unknown-project' } };
  const host = setupLink({
    app: { getPath: () => dir, getVersion: () => '0.23.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, send: () => {}, notify: (title) => notices.push(title), T: (k, v) => `${k}:${v ? JSON.stringify(v) : ''}`, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => [{ id: 'p1', name: 'shop', engine: 'claude' }, { id: 'p2', name: 'idle', engine: 'claude' }, { id: 'p3', name: 'other', engine: 'agy' }], tabState: () => 'ready', type: () => {},
    sessionOf: (id) => sessions[id],
  });
  t.after(() => host.destroy());
  host.devices();   // starts the link
  const link = captured;
  const pushed = [];
  link.sessPush = (key, items, o) => { pushed.push({ key, items, o }); return true; };
  const refused = [];
  const open = (key, project) => link.emit('sess-open', { key, device: { pub: PA, name: 'Laptop' }, id: key, project, refuse: (why) => refused.push([project, why]) });
  open('k1', 'p1');
  for (const p of ['p2', 'p3', 'nope', 'hq']) open(`k-${p}`, p);
  assert.deepEqual(refused, [['p2', 'no-session'], ['p3', 'engine'], ['nope', 'unknown-project'], ['hq', 'unknown-project']]);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].o, { reset: true });
  assert.deepEqual(pushed[0].items.map((x) => [x.kind, x.text || x.name || '']), [['user', 'deploy with API_KEY_PROD=[redacted] please'], ['assistant', 'Running it.'], ['tool', 'Bash'], ['toolDone', '']]);
  assert.deepEqual(Object.keys(pushed[0].items[2]).sort(), ['at', 'id', 'key', 'kind', 'name']);   // no detail, no input
  const sent = JSON.stringify(pushed);
  for (const never of ['abc12345xyz', 'PRIVATE-THOUGHT', 'hidden-path', 'RESULT-BYTES', 'IMAGE-BYTES', 'cat /srv']) assert.ok(!sent.includes(never), never);
  assert.deepEqual(notices, ['main.sessionViewed:{"device":"Laptop","project":"shop"}']);
  assert.deepEqual(handlers.get('link:get')().sessReaders, [{ device: 'Laptop', project: 'p1' }]);   // the row's marker
  link.emit('sess-closed', { key: 'k1', why: 'closed' });
  link.emit('sess-closed', { key: 'k-p2', why: 'refused' });   // never started: not logged
  assert.deepEqual(handlers.get('link:get')().sessReaders, []);
  const log = fs.readFileSync(path.join(dir, 'link', 'sessions.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map(({ at: _at, ...rest }) => rest), [{ device: 'Laptop', project: 'shop', event: 'open' }, { device: 'Laptop', project: 'shop', event: 'close', why: 'closed' }]);
  assert.ok(!fs.readFileSync(path.join(dir, 'link', 'sessions.log'), 'utf8').includes('Running'));
  for (const ch of ['link:setPaused', 'link:sessOpen', 'link:sessKeep', 'link:sessClose']) assert.ok(handlers.has(ch), ch);
});

test('sess wiring: main gives the main tab only, preload and the Devices popup carry the new calls', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const main = read('main.js');
  assert.match(main, /sessionOf: linkSessionOf,/);
  const fn = main.slice(main.indexOf('function linkSessionOf(id) {'), main.indexOf("ipcMain.handle('chat:read'"));
  assert.match(fn, /p\.hq \|\| p\.staffOwner \|\| id === HQ\.HQ_ID/);   // never HQ or a personal workspace
  assert.match(fn, /!r \|\| r\.tab /);                                  // never a desk or an extra tab
  assert.match(fn, /engineOf\(p\) !== 'claude'/);
  const preload = read('preload.js');
  for (const call of ['setPaused', 'sessOpen', 'sessKeep', 'sessClose']) assert.match(preload, new RegExp(`${call}: \\(.*ipcRenderer\\.invoke\\('link:${call}'`));
  assert.match(preload, /onSess: listen\('link:sess'\)/);
  assert.match(read('renderer/devices.js'), /sb-dev-pause/);
  assert.equal(CHAT.LINK_TOOL_DETAIL, false);
  const host = read('src/link-host.js');
  assert.match(host, /CHAT\.linkItems\(items\)/);   // the host never passes the tool-detail option
});
