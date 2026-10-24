// Routines (contract v3.47): node --test app/test/routines.test.cjs
// Pure: fake clocks (explicit `now`), process.env.TZ switched per block; no Electron, no real ~/.claude.
'use strict';
process.env.TZ = 'Europe/Istanbul';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROUT = require('../src/routines.js');
const HQ = require('../src/hq.js');
const R = require('../src/resume.js');

const at = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const H = 3600e3;
const withTz = (tz, fn) => { const old = process.env.TZ; process.env.TZ = tz; try { fn(); } finally { process.env.TZ = old; } };
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));
const t = (key, vars = {}) => String(key.split('.').reduce((o, k) => o?.[k], EN) ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const rt = (o = {}) => ROUT.normalizeRoutine({ id: 'rt00000001', name: 'Daily', prompt: 'Check the builds', target: { kind: 'hq' }, schedule: { kind: 'daily', at: '09:00' }, ...o });
const planOf = (o) => ROUT.plan({ cfg: {}, tz: 'Europe/Istanbul', ...o });

test('nextAfter: daily, weekdays (Fri → Mon), weekly, every N hours with and without a window', () => {
  assert.equal(ROUT.nextAfter({ kind: 'daily', at: '09:00' }, at(2026, 10, 24, 8)), at(2026, 10, 24, 9));
  assert.equal(ROUT.nextAfter({ kind: 'daily', at: '09:00' }, at(2026, 10, 24, 9)), at(2026, 10, 25, 9));
  assert.equal(ROUT.nextAfter({ kind: 'weekdays', at: '09:00' }, at(2026, 10, 23, 18)), at(2026, 10, 26, 9));
  assert.equal(ROUT.nextAfter({ kind: 'weekly', day: 1, at: '09:00' }, at(2026, 10, 26, 8)), at(2026, 10, 26, 9));
  assert.equal(ROUT.nextAfter({ kind: 'weekly', day: 1, at: '09:00' }, at(2026, 10, 26, 10)), at(2026, 11, 2, 9));
  assert.equal(ROUT.nextAfter({ kind: 'hours', every: 6 }, at(2026, 10, 24, 7)), at(2026, 10, 24, 12));
  const win = { kind: 'hours', every: 2, from: '22:00', to: '06:00' };   // across midnight
  assert.equal(ROUT.nextAfter(win, at(2026, 10, 24, 23)), at(2026, 10, 25, 0));
  assert.equal(ROUT.nextAfter(win, at(2026, 10, 25, 6, 30)), at(2026, 10, 25, 22));
  assert.equal(ROUT.nextAfter({ kind: 'hours', every: 3, from: '09:00', to: '17:00' }, at(2026, 10, 24, 15, 1)), at(2026, 10, 25, 9));
});

test('DST America/New_York: spring-forward time runs once at the first valid instant, fall-back once, hours stay on the wall clock', () => withTz('America/New_York', () => {
  const s = ROUT.slotsBetween({ kind: 'daily', at: '02:30' }, at(2026, 3, 7, 12), at(2026, 3, 9, 12));
  assert.equal(s.length, 2);
  assert.deepEqual([new Date(s[0]).getDate(), new Date(s[0]).getHours(), new Date(s[0]).getMinutes()], [8, 3, 30]);
  const f = ROUT.slotsBetween({ kind: 'daily', at: '01:30' }, at(2026, 10, 31, 12), at(2026, 11, 1, 23));
  assert.equal(f.length, 1);
  const h = ROUT.slotsBetween({ kind: 'hours', every: 6 }, at(2026, 3, 7, 23), at(2026, 3, 8, 23));
  assert.deepEqual(h.map((x) => new Date(x).getHours()), [0, 6, 12, 18]);
}));

test('Europe/Istanbul (no DST) control: daily gaps are exactly 24 h', () => {
  const s = ROUT.slotsBetween({ kind: 'daily', at: '09:00' }, at(2026, 3, 1), at(2026, 4, 30));
  assert.ok(s.length > 50);
  for (let i = 1; i < s.length; i++) assert.equal(s[i] - s[i - 1], 24 * H);
});

test('DST switch does not re-anchor: the 09:00 slot after the change runs on time, nothing skipped', () => withTz('America/New_York', () => {
  const r = rt();
  let { file } = ROUT.plan({ routines: [r], cfg: {}, file: {}, now: at(2026, 3, 7, 9, 30), tz: 'America/New_York' });
  assert.equal(file.sched[r.id].nextAt, at(2026, 3, 8, 9));
  const res = ROUT.plan({ routines: [r], cfg: {}, file, now: at(2026, 3, 8, 9) + 5000, tz: 'America/New_York' });
  assert.deepEqual(res.actions.map((a) => [a.kind, a.trigger, a.slotAt]), [['run', 'schedule', at(2026, 3, 8, 9)]]);
  file = res.file;
  assert.equal(file.sched[r.id].nextAt, at(2026, 3, 9, 9));
}));

test('plan: a new routine never fires at once; on time within GRACE runs', () => {
  const r = rt();
  const a = planOf({ routines: [r], file: {}, now: at(2026, 10, 24, 9) });
  assert.equal(a.actions.length, 0);
  assert.equal(a.file.sched[r.id].nextAt, at(2026, 10, 25, 9));
  const b = planOf({ routines: [r], file: { sched: { [r.id]: { nextAt: at(2026, 10, 24, 9) } } }, now: at(2026, 10, 24, 9) + 5000 });
  assert.deepEqual(b.actions.map((x) => [x.kind, x.trigger]), [['run', 'schedule']]);
});

test('plan: 3 missed + once → one catch-up and one skip (2); skip policy → one skip (3); older than 24 h → skipped', () => {
  const r = rt();
  const file = { sched: { [r.id]: { nextAt: at(2026, 10, 22, 9) } } };
  const a = planOf({ routines: [r], file: structuredClone(file), now: at(2026, 10, 24, 12) });
  assert.deepEqual(a.actions.map((x) => [x.kind, x.trigger, x.reason, x.missedCount]), [['skip', 'schedule', 'missed', 2], ['run', 'catch-up', undefined, undefined]]);
  assert.equal(a.actions[1].slotAt, at(2026, 10, 24, 9));
  const b = planOf({ routines: [rt({ missed: 'skip' })], file: structuredClone(file), now: at(2026, 10, 24, 12) });
  assert.deepEqual(b.actions.map((x) => [x.kind, x.reason, x.missedCount]), [['skip', 'missed', 3]]);
  const w = rt({ schedule: { kind: 'weekly', day: 1, at: '09:00' } });
  const c = planOf({ routines: [w], file: { sched: { [w.id]: { nextAt: at(2026, 10, 26, 9) } } }, now: at(2026, 10, 28, 9) });
  assert.deepEqual(c.actions.map((x) => [x.kind, x.reason, x.missedCount]), [['skip', 'missed', 1]]);
});

test('plan: paused keeps moving nextAt (resume never catches up); edit (no sched) re-anchors; deleted routines pruned', () => {
  const r = rt({ paused: true });
  let { file } = planOf({ routines: [r], file: { sched: { [r.id]: { nextAt: at(2026, 10, 22, 9) }, rtdeadbeef: { nextAt: 1 } } }, now: at(2026, 10, 24, 12) });
  assert.equal(file.sched.rtdeadbeef, undefined);
  assert.equal(file.sched[r.id].nextAt, at(2026, 10, 25, 9));
  const res = planOf({ routines: [{ ...r, paused: false }], file, now: at(2026, 10, 24, 12, 5) });
  assert.equal(res.actions.length, 0);
  assert.equal(planOf({ routines: [rt()], file: { sched: {} }, now: at(2026, 10, 24, 9, 1) }).actions.length, 0);
});

test('plan gates: overlap, maxPerDay, global dailyCap (local midnight boundary)', () => {
  const r = rt({ maxPerDay: 1 });
  const due = () => ({ sched: { [r.id]: { nextAt: at(2026, 10, 24, 9) } } });
  const now = at(2026, 10, 24, 9) + 1000;
  assert.equal(planOf({ routines: [r], file: due(), now, openRun: () => true }).actions[0].reason, 'overlap');
  const today = { id: 'ru1', routine: r.id, at: at(2026, 10, 24, 0, 5), status: 'ok' };
  assert.equal(planOf({ routines: [r], file: { ...due(), runs: [today] }, now }).actions[0].reason, 'daily-cap');
  const yesterday = { ...today, at: at(2026, 10, 23, 23, 59) };
  assert.equal(planOf({ routines: [r], file: { ...due(), runs: [yesterday] }, now }).actions[0].kind, 'run');
  const other = { ...today, routine: 'rt00000002' };
  assert.equal(planOf({ routines: [r], cfg: { dailyCap: 1 }, file: { ...due(), runs: [other] }, now }).actions[0].reason, 'global-cap');
  const skipped = { ...today, status: 'skipped' };   // skipped records never count
  assert.equal(planOf({ routines: [r], file: { ...due(), runs: [skipped] }, now }).actions[0].kind, 'run');
});

test('quiet hours: once waits until the end, skip skips; a window across midnight; manual ignores quiet but not caps', () => {
  const cfg = { quiet: { from: '08:00', to: '10:00' } };
  const r = rt();
  const file = () => ({ sched: { [r.id]: { nextAt: at(2026, 10, 24, 9) } } });
  const a = planOf({ routines: [r], cfg, file: file(), now: at(2026, 10, 24, 9) + 1000 });
  assert.deepEqual([a.actions[0].kind, a.actions[0].notBefore], ['wait', at(2026, 10, 24, 10)]);
  assert.equal(planOf({ routines: [rt({ missed: 'skip' })], cfg, file: file(), now: at(2026, 10, 24, 9) + 1000 }).actions[0].reason, 'quiet');
  const night = { from: '22:00', to: '07:00' };
  assert.equal(ROUT.inQuiet(at(2026, 10, 24, 23, 30), night), true);
  assert.equal(ROUT.inQuiet(at(2026, 10, 24, 6, 59), night), true);
  assert.equal(ROUT.inQuiet(at(2026, 10, 24, 7), night), false);
  const open = () => false;
  assert.equal(ROUT.manualGate({ routine: r, cfg, runs: [], now: at(2026, 10, 24, 9), openRun: open }), null);
  const runs = [1, 2, 3, 4].map((i) => ({ id: `ru${i}`, routine: r.id, at: at(2026, 10, 24, 1, i), status: 'ok' }));
  assert.equal(ROUT.manualGate({ routine: r, cfg, runs, now: at(2026, 10, 24, 9), openRun: open }), 'daily-cap');
  assert.equal(ROUT.manualGate({ routine: r, cfg, runs: [], now: at(2026, 10, 24, 9), openRun: () => true }), 'overlap');
});

test('timezone change (IANA name) re-anchors; forward jump of 8 h (wake) takes the late path; backward jump re-anchors', () => {
  const r = rt();
  const past = { sched: { [r.id]: { nextAt: at(2026, 10, 24, 9) } } };
  const tz = planOf({ routines: [r], file: { ...structuredClone(past), tz: 'Europe/Berlin', lastTickAt: at(2026, 10, 24, 11) }, now: at(2026, 10, 24, 11) + 5000 });
  assert.equal(tz.actions.length, 0);
  assert.equal(tz.file.sched[r.id].nextAt, at(2026, 10, 25, 9));
  const woke = { ...structuredClone(past), tz: 'Europe/Istanbul', lastTickAt: at(2026, 10, 24, 3) };
  assert.equal(ROUT.wokeUp(woke, at(2026, 10, 24, 11)), true);
  assert.deepEqual(planOf({ routines: [r], file: woke, now: at(2026, 10, 24, 11) }).actions.map((x) => x.trigger), ['catch-up']);
  const back = planOf({ routines: [r], file: { ...structuredClone(past), tz: 'Europe/Istanbul', lastTickAt: at(2026, 10, 24, 14) }, now: at(2026, 10, 24, 11) });
  assert.equal(back.actions.length, 0);
  assert.equal(back.file.sched[r.id].nextAt, at(2026, 10, 25, 9));
});

test('normalizeRoutine: bad HH:MM, oversize prompt cut, redaction, unknown project kept, remote dropped (Phase 2), max 20', () => {
  assert.equal(rt({ schedule: { kind: 'daily', at: '25:00' } }), null);
  assert.equal(rt({ schedule: { kind: 'hours', every: 0 } }), null);
  assert.ok(Buffer.byteLength(rt({ prompt: 'x'.repeat(20000) }).prompt) <= ROUT.PROMPT_MAX);
  assert.ok(!rt({ prompt: 'deploy with token=abcd1234efgh5678' }).prompt.includes('abcd1234efgh5678'));
  assert.equal(ROUT.cleanPrompt('use token=abcd1234efgh5678').redacted, true);
  assert.deepEqual(rt({ target: { kind: 'project', projectId: 'gone-project' } }).target, { kind: 'project', projectId: 'gone-project' });
  assert.equal(rt({ target: { kind: 'remote', pub: 'ab'.repeat(16), projectId: 'x' } }), null);
  const many = Array.from({ length: 25 }, (_, i) => ({ ...rt(), id: `rt${String(i).padStart(8, '0')}` }));
  assert.equal(ROUT.normalizeRoutines(many).length, 20);
  assert.equal(rt({ schedule: { kind: 'hours', every: 5 } }).maxPerDay, 5);
  assert.deepEqual(ROUT.normalizeCfg({ quiet: { from: '22:00', to: '22:00' }, dailyCap: 500 }), { quiet: null, dailyCap: 48 });
});

test('wrapText: quote-free [routine <id>] marker first, the request id and the OK/ATTENTION tail; promptArg keeps the marker', () => {
  const text = ROUT.wrapText({ routine: rt(), request: 'rabc123', slotAt: at(2026, 10, 24, 9), t });
  assert.ok(text.startsWith('[routine rabc123] '));
  assert.match(text, /office_summary/);
  assert.match(text, /OK:/);
  assert.match(text, /ATTENTION:/);
  assert.ok(R.promptArg(text).startsWith('[routine rabc123]'));
  assert.match(ROUT.wrapText({ routine: rt({ target: { kind: 'project', projectId: 'p1' } }), request: 'rabc123', slotAt: 0, t }), /report's first line/);
  assert.deepEqual(ROUT.outcomeOf('\n OK: all green\nmore'), { status: 'ok', outcome: 'OK: all green' });
  assert.equal(ROUT.outcomeOf('ATTENTION: CI red').status, 'attention');
  assert.equal(ROUT.outcomeOf('').status, 'attention');
});

test('cold HQ start without history: the routine prompt is passed even with no resume args', () => {
  const text = '[routine rabc123] Routine Daily: check';
  const args = R.claudeArgs(['--plugin-dir', 'x'], [], text, { always: true });
  assert.equal(args[args.length - 1], R.promptArg(text));
  assert.deepEqual(R.claudeArgs(['--plugin-dir', 'x'], [], text), ['--plugin-dir', 'x']);   // unchanged default
});

test('keystroke race: HQ is busy 15 s after a keystroke or while on screen; keystrokes in the paste→Enter gap are queued', () => {
  const now = 1_000_000;
  assert.equal(ROUT.hqBusy({ state: 'ready', lastKeyAt: now - 5000, now }), 'busy');
  assert.equal(ROUT.hqBusy({ state: 'ready', lastKeyAt: now - 20000, now }), 'ready');
  assert.equal(ROUT.hqBusy({ state: 'ready', lastKeyAt: 0, now, onScreen: true }), 'busy');
  assert.equal(ROUT.hqBusy({ state: 'starting', lastKeyAt: 0, now }), 'starting');
  let clock = 0;
  const g = ROUT.createWriteGate({ now: () => clock, holdMs: 1000 });
  assert.equal(g.queue('a'), false);
  g.hold();
  assert.equal(g.queue('x'), true);
  assert.equal(g.queue('y'), true);
  assert.deepEqual(g.release(), ['x', 'y']);
  assert.equal(g.queue('z'), false);
  g.hold(); clock = 5000;
  assert.equal(g.queue('late'), false);   // a lost Enter never blocks the person for long
});

test('minter: a routine id survives clear() and a typed mint as issued, but its no-ask ends; TTL; endRun', () => {
  let clock = 1000;
  const m = HQ.createMinter({ now: () => clock });
  const typed = m.mint();
  const rid = m.mint({ origin: 'routine', run: 'ru1' });
  assert.equal(m.current(), typed);   // a routine mint does not replace the typed request
  assert.equal(m.isLiveRoutine(rid), true);
  assert.equal(m.runOf(rid), 'ru1');
  m.clear();   // an inbox row (report / request-done) for HQ
  assert.equal(m.issued(rid), true);
  assert.equal(m.isLiveRoutine(rid), false);
  const rid2 = m.mint({ origin: 'routine' });
  m.mint();   // the person typed
  assert.equal(m.isLiveRoutine(rid2), false);
  clock += HQ.ROUTINE_MINT_MS + 1;
  assert.equal(m.issued(rid2), false);
  const rid3 = m.mint({ origin: 'routine' });
  m.endRun(rid3);
  assert.equal(m.issued(rid3), false);
});

test('report row ends no-ask: consentFor a routine id → none, then held after the inbox row clears it', () => {
  const m = HQ.createMinter();
  const rid = m.mint({ origin: 'routine' });
  assert.equal(HQ.consentFor({ setting: false, remote: false, request: rid, minter: m, routineNoAsk: true }), 'none');
  m.clear();
  assert.equal(HQ.consentFor({ setting: true, remote: false, request: rid, minter: m, routineNoAsk: true }), 'held');
});

test('consentFor matrix: typed/routine × local/remote × setting × routine checkbox; routines never get the modal', () => {
  for (const remote of [false, true]) for (const setting of [false, true]) for (const noAsk of [false, true]) {
    const m = HQ.createMinter();
    const typed = m.mint();
    const rid = m.mint({ origin: 'routine' });
    assert.equal(HQ.consentFor({ setting, remote, request: typed, minter: m, routineNoAsk: noAsk }), setting && !remote ? 'none' : 'app');
    assert.equal(HQ.consentFor({ setting, remote, request: rid, minter: m, routineNoAsk: noAsk }), noAsk && !remote ? 'none' : 'held');
  }
});

test('awaiting-consent is open: counts toward the 12-open and 8-per-request caps', () => {
  let b = HQ.emptyBoard();
  for (let i = 0; i < 8; i++) b = HQ.addTask(b, { id: `h${i}`, request: 'r1', title: 't', project: 'p', status: 'awaiting-consent' });
  assert.equal(HQ.capReason(b, 'r1'), 'request-cap');
  for (let i = 0; i < 4; i++) b = HQ.addTask(b, { id: `x${i}`, request: 'r2', title: 't', project: 'p', status: 'awaiting-consent' });
  assert.equal(HQ.capReason(b, 'r3'), 'open-cap');
  assert.equal(HQ.addTask(HQ.emptyBoard(), { id: 'h1', request: 'r9', title: 't', routine: 'rt00000001', run: 'ru1', prompt: 'Daily' }).requests[0].routine, 'rt00000001');
});

test('approve twice sends once: takeHeld moves the row out of awaiting-consent; then renameTask; 12 h expiry', () => {
  let b = HQ.addTask(HQ.emptyBoard(), { id: 'hheld1', request: 'r1', title: 't', project: 'p', status: 'awaiting-consent' }, 1000);
  const first = HQ.takeHeld(b, 'hheld1');
  assert.equal(first.ok, true);
  assert.equal(first.board.tasks[0].status, 'queued');
  assert.equal(HQ.takeHeld(first.board, 'hheld1').ok, false);
  b = HQ.renameTask(first.board, 'hheld1', 'treal1', { status: 'queued' });
  assert.deepEqual([b.tasks[0].id, b.requests[0].tasks], ['treal1', ['treal1']]);
  const old = HQ.addTask(HQ.emptyBoard(), { id: 'hheld2', request: 'r2', title: 't', project: 'p', status: 'awaiting-consent' }, 0);
  assert.deepEqual(HQ.expireHeld(old, HQ.HELD_MS - 1).expired, []);
  const ex = HQ.expireHeld(old, HQ.HELD_MS + 1);
  assert.deepEqual([ex.expired, ex.board.tasks[0].status], [['hheld2'], 'expired']);
});

test('pruneRuns keeps open runs, 90 days and 300 rows', () => {
  const now = at(2026, 10, 24);
  const runs = [{ id: 'a', status: 'waiting', at: 0 }, { id: 'b', status: 'ok', at: 0, finishedAt: 0 }, ...Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, status: 'ok', at: now }))];
  const kept = ROUT.pruneRuns(runs, now);
  assert.equal(kept.length, 300);
  assert.equal(kept[0].id, 'a');
  assert.ok(!kept.some((r) => r.id === 'b'));
});
