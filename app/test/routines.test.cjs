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

test('normalizeRoutine: bad HH:MM, oversize prompt cut, redaction, unknown project kept, remote kept (v3.49), max 20', () => {
  assert.equal(rt({ schedule: { kind: 'daily', at: '25:00' } }), null);
  assert.equal(rt({ schedule: { kind: 'hours', every: 0 } }), null);
  assert.ok(Buffer.byteLength(rt({ prompt: 'x'.repeat(20000) }).prompt) <= ROUT.PROMPT_MAX);
  assert.ok(!rt({ prompt: 'deploy with token=abcd1234efgh5678' }).prompt.includes('abcd1234efgh5678'));
  assert.equal(ROUT.cleanPrompt('use token=abcd1234efgh5678').redacted, true);
  assert.deepEqual(rt({ target: { kind: 'project', projectId: 'gone-project' } }).target, { kind: 'project', projectId: 'gone-project' });
  assert.deepEqual(rt({ target: { kind: 'remote', pub: 'ab'.repeat(16), projectId: 'x' } }).target, { kind: 'remote', pub: 'ab'.repeat(16), projectId: 'x' });
  assert.equal(rt({ target: { kind: 'remote', pub: 'not-hex', projectId: 'x' } }), null);
  assert.equal(rt({ target: { kind: 'remote', pub: 'ab'.repeat(16), projectId: 'x y' } }), null);
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

test('review fixes: one live routine id at a time; project prompts leave room for the wrapper; long absences clamp to 7 days', () => {
  const m = HQ.createMinter();
  const a = m.mint({ origin: 'routine' });
  const b = m.mint({ origin: 'routine' });
  assert.deepEqual([m.isLiveRoutine(a), m.isLiveRoutine(b), m.issued(a)], [false, true, true]);
  const big = rt({ target: { kind: 'project', projectId: 'p1' }, prompt: 'x'.repeat(9000) });
  const text = ROUT.wrapText({ routine: big, request: 'rabc123', slotAt: 0, t });
  assert.ok(Buffer.byteLength(text) <= 8 * 1024);
  const r = rt({ schedule: { kind: 'hours', every: 1 } });
  const res = planOf({ routines: [r], file: { sched: { [r.id]: { nextAt: at(2026, 9, 1, 9), lastSlotAt: at(2026, 9, 1, 8) } } }, now: at(2026, 10, 24, 9) + 1000 });
  assert.deepEqual(res.actions.map((x) => [x.kind, x.trigger]), [['skip', 'schedule'], ['run', 'schedule']]);
  assert.ok(res.actions[0].missedCount <= 24 * 7);
});

test('pruneRuns keeps open runs, 90 days and 300 rows', () => {
  const now = at(2026, 10, 24);
  const runs = [{ id: 'a', status: 'waiting', at: 0 }, { id: 'b', status: 'ok', at: 0, finishedAt: 0 }, ...Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, status: 'ok', at: now }))];
  const kept = ROUT.pruneRuns(runs, now);
  assert.equal(kept.length, 300);
  assert.equal(kept[0].id, 'a');
  assert.ok(!kept.some((r) => r.id === 'b'));
});

// --- Phase 1 review fixes (v3.47)
const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const mainFn = (name) => { const i = MAIN_SRC.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return MAIN_SRC.slice(i, MAIN_SRC.indexOf('\n}\n', i)); };

test('restart keeps held cards: markLost skips awaiting-consent; a run whose held cards are all gone is found and ends', () => {
  let b = HQ.addTask(HQ.emptyBoard(), { id: 'hheld1', request: 'r1', title: 't', project: 'p', status: 'awaiting-consent' }, 1000);
  b = HQ.addTask(b, { id: 'tq1', request: 'r1', title: 't', project: 'p', status: 'queued' }, 1000);
  const after = HQ.markLost(b, () => false, 2000);
  assert.deepEqual(after.tasks.map((x) => [x.id, x.status]).sort(), [['hheld1', 'awaiting-consent'], ['tq1', 'lost']]);
  const held = new Set(after.tasks.filter((x) => x.status === 'awaiting-consent').map((x) => x.id));
  const runs = [{ id: 'ru1', status: 'awaiting-consent', held: ['hheld1'] }, { id: 'ru2', status: 'awaiting-consent', held: ['hgone'] }, { id: 'ru3', status: 'awaiting-consent' }, { id: 'ru4', status: 'running', held: ['hgone'] }];
  assert.deepEqual(ROUT.staleHeldRuns(runs, held).map((r) => r.id), ['ru2', 'ru3']);
  const body = mainFn('setupRoutines');
  assert.match(body, /ROUT\.staleHeldRuns\(rt\(\)\.runs, heldIds\)\) finishRun\(run, 'attention', 'lost'\)/);
});

test('a project run id stops being live after its dispatch; no-ask for a project routine only for its own project', () => {
  const m = HQ.createMinter();
  const rid = m.mint({ origin: 'routine' });
  m.endLive(rid);
  assert.deepEqual([m.issued(rid), m.isLiveRoutine(rid)], [true, false]);
  assert.equal(HQ.consentFor({ setting: true, remote: false, request: rid, minter: m, routineNoAsk: true }), 'held');
  const proj = rt({ noAsk: true, target: { kind: 'project', projectId: 'p1' } });
  assert.equal(ROUT.routineNoAsk(proj, { projectId: 'p1' }), true);
  assert.equal(ROUT.routineNoAsk(proj, { projectId: 'p2' }), false);
  assert.equal(ROUT.routineNoAsk(proj, { projectId: '' }), false);
  assert.equal(ROUT.routineNoAsk(proj, { remote: true, projectId: 'p1' }), false);
  assert.equal(ROUT.routineNoAsk(rt({ noAsk: true }), { projectId: 'p9' }), true);   // an HQ routine: any local project
  assert.equal(ROUT.routineNoAsk(rt({ noAsk: false }), { projectId: 'p9' }), false);
  assert.match(mainFn('deliverRun'), /await hqDispatch\(\{[^\n]*\n\s*hqMinter\.endLive\(run\.request\)/);
});

test('HQ routine turn: liveness ends when the turn is over; not typed while HQ inbox rows wait', () => {
  const now = 10 * 60e3;
  assert.equal(ROUT.hqTurn({ status: 'typed', tab: 'busy', typedAt: now, now }), 'busy');
  assert.equal(ROUT.hqTurn({ status: 'typed', tab: 'ready', typedAt: now - 60e3, now }), 'wait');
  assert.equal(ROUT.hqTurn({ status: 'typed', tab: 'ready', typedAt: now - 3 * 60e3, now }), 'over');
  assert.equal(ROUT.hqTurn({ status: 'running', tab: 'ready', typedAt: now, now }), 'over');   // busy → ready
  assert.equal(ROUT.hqTurn({ status: 'running', tab: 'gone', typedAt: now, now }), 'over');
  assert.equal(ROUT.hqTurn({ status: 'running', tab: 'starting', typedAt: now, now }), 'wait');
  assert.match(mainFn('deliverRun'), /if \(turn === 'wait'\) return;\n\s*hqMinter\.endLive\(run\.request\)/);
  assert.equal(ROUT.hqBusy({ state: 'ready', now: 1e6, inboxWaiting: true }), 'busy');
  assert.equal(ROUT.hqBusy({ state: 'ready', now: 1e6, inboxWaiting: false }), 'ready');
  assert.match(mainFn('deliverRun'), /inboxWaiting: inboxWaiting\(bossSid\(HQ\.HQ_ID\)\)/);
});

test('pty:shown sets the shown tab in main (HQ on screen even when HQ never slept)', () => {
  const line = MAIN_SRC.split('\n').find((l) => l.startsWith("ipcMain.on('pty:shown'"));
  assert.ok(line);
  const handlers = {};
  const run = new Function('ipcMain', 'ROUT', 'HQ', 'win', `let shownTab = ''; ${line}\n${MAIN_SRC.split('\n').find((l) => l.startsWith('const hqOnScreen'))}\nreturn { onScreen: () => hqOnScreen(), tab: () => shownTab };`);
  const w = { isFocused: () => true, isMinimized: () => false };
  const s = run({ on: (ch, fn) => { handlers[ch] = fn; } }, ROUT, HQ, w);
  handlers['pty:shown']({}, 'hq');
  assert.deepEqual([s.tab(), s.onScreen()], ['hq', true]);
  handlers['pty:shown']({}, 'aaaaaaaaaaaa:0');
  assert.deepEqual([s.tab(), s.onScreen()], ['aaaaaaaaaaaa:0', false]);
  handlers['pty:shown']({}, { bad: 1 });
  assert.equal(s.tab(), '');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const show = app.slice(app.indexOf('function showActive('), app.indexOf('if (shownId === visible) return;'));
  assert.match(show, /api\.pty\.shown\?\.\(visible \|\| ''\)/);   // sent before the early return, for every tab change
});

test('off-id dispatches are held only while the HQ routine id is live (the person\'s own requests go through after)', () => {
  const m = HQ.createMinter();
  const rid = m.mint({ origin: 'routine' });
  assert.equal(HQ.holdsOffId({ approved: false, request: HQ.ADHOC, minter: m, openRoutine: rid }), true);
  assert.equal(HQ.holdsOffId({ approved: false, request: rid, minter: m, openRoutine: rid }), false);
  assert.equal(HQ.holdsOffId({ approved: true, request: HQ.ADHOC, minter: m, openRoutine: rid }), false);
  m.endLive(rid);
  assert.equal(HQ.holdsOffId({ approved: false, request: HQ.ADHOC, minter: m, openRoutine: rid }), false);
  const typed = m.mint();
  assert.equal(HQ.holdsOffId({ approved: false, request: typed, minter: m, openRoutine: rid }), false);
  assert.equal(HQ.holdsOffId({ approved: false, request: typed, minter: m, openRoutine: '' }), false);
});

test('approve with a lost routines.json entry ends the card; expiry reports finished requests; Allow restarts the run clock', () => {
  const body = mainFn('approveHeld');
  assert.match(body, /if \(!h\) \{ saveHqBoard\(board\); hqStatus\(heldId, 'rejected', 'lost'\);/);
  const old = HQ.addTask(HQ.emptyBoard(), { id: 'hheld2', request: 'r2', title: 't', project: 'p', status: 'awaiting-consent' }, 0);
  const ex = HQ.expireHeld(old, HQ.HELD_MS + 1);
  assert.deepEqual(ex.done.map((d) => d.id), ['r2']);
  assert.deepEqual(HQ.expireHeld(old, 1).done, []);
  assert.match(mainFn('routinesTick'), /const \{ board, expired, done \} = HQ\.expireHeld[^\n]*\n[^\n]*\n\s*saveHqBoard\(board\);\n\s*hqRequestsDone\(done\);/);
  const run = { status: 'awaiting-consent', typedAt: 5 };
  ROUT.approveRun(run, true, 99);
  assert.deepEqual([run.status, run.typedAt], ['running', 99]);
  const declined = { status: 'awaiting-consent', typedAt: 5 };
  ROUT.approveRun(declined, false, 99);
  assert.deepEqual([declined.status, declined.typedAt], ['running', 5]);
});

test('routines.json: a tick alone (lastTickAt) is written at most once a minute; any other change at once', () => {
  const f = { sched: { a: { nextAt: 1 } }, lastTickAt: 1000, tz: 'X', runs: [], held: {} };
  const w = { key: ROUT.persistKey(f), tickAt: 1000 };
  assert.equal(ROUT.shouldPersist(w, { ...f, lastTickAt: 6000 }, 6000), false);
  assert.equal(ROUT.shouldPersist(w, { ...f, lastTickAt: 61000 }, 61000), true);
  assert.equal(ROUT.shouldPersist(w, { ...f, lastTickAt: 6000, runs: [{ id: 'ru1' }] }, 6000), true);
  assert.equal(ROUT.shouldPersist(w, { ...f, lastTickAt: 6000, sched: {} }, 6000), true);
  assert.equal(ROUT.shouldPersist({ key: '', tickAt: 0 }, f, 1000), true);
});

// --- v3.49 remote targets: the real main.js functions (deliverRun, hqDispatch, holdDispatch, approveHeld, the report and
// status paths) run against stubs for the link, the board file and Electron. No real link, userData or ~/.claude.
const PUB = 'ab'.repeat(16);
function remoteHarness({ online = true } = {}) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-remote-'));
  const names = ['tagRoutineRec', 'hqDispatch', 'holdDispatch', 'approveHeld', 'routineProblem', 'finishRun', 'routinesOnDone', 'routinesOnSummary',
    'deliverRun', 'hqStatus', 'hqRequestsDone', 'hqOnReport', 'onOfficeReport'];
  const lines = ['const isHere', 'const routineById', 'const routineRunOfRequest', 'const byName', 'const officeName', 'const openHqRoutineRequest'];
  const src = [
    ...lines.map((l) => MAIN_SRC.split('\n').find((x) => x.startsWith(l))),
    ...names.map((n) => { const i = MAIN_SRC.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return MAIN_SRC.slice(i, MAIN_SRC.indexOf('\n}\n', i) + 2); }),
  ].join('\n');
  const env = {
    HQ, ROUT, LC: require('../src/link-core.js'), SF: require('../src/state-file.js'), P: require('../src/projects.js'), fs, path, crypto: require('crypto'), T: t,
    state: { projects: [], routines: [], hq: { enabled: true } }, file: { runs: [], held: {}, sched: {} }, board: HQ.emptyBoard(), dispatches: new Map(),
    notes: [], sent: [], dialogs: 0, rows: [], records: new Map(), online, n: 0,
  };
  const link = { devices: [{ pub: PUB, name: 'Mac2' }], get conns() { return new Set(env.online ? [PUB] : []); },
    remotes: new Map([[PUB, { snap: { projects: [{ id: 'web', name: 'Web' }] } }]]), outgoing: [] };
  const prelude = `
    const { HQ, ROUT, LC, SF, P, fs, path, crypto, T } = env; let state = env.state;
    const hqMinter = HQ.createMinter(); const hqPacer = HQ.createPacer();
    const win = { isFocused: () => true, isDestroyed: () => false };
    const terms = new Map(); const rtFailNoticed = new Set(); let rtSettleUntil = 0; let hqWanted = false; const hqLastKey = 0;
    const rt = () => env.file; const saveRt = () => {}; const hqDir = () => ${JSON.stringify(dir)};
    const loadHqBoard = () => env.board; const saveHqBoard = (b) => { env.board = b; };
    const loadDispatches = () => env.dispatches; const saveDispatches = () => {};
    const selfName = () => 'Mac1'; const peerCache = () => ({ [${JSON.stringify(PUB)}]: { name: 'Mac2', projects: [{ id: 'web', name: 'Web' }] } });
    const notify = (title, body) => env.notes.push({ title, body });
    const confirmHqDispatch = async () => { env.dialogs++; return true; };
    const projectOp = () => {}; const bossSid = () => 'sid'; const inboxRow = (sid, tab, row) => env.rows.push(row);
    const linkHost = { link: () => env.link, remoteTask: (id) => env.records.get(id) || null, knows: () => false };
    env.pace = (ok) => { hqPacer.submit = ok ? hqPacer.submit : (pub, fn) => { env.paced = fn; return false; }; };
    const officeDispatch = (tab, args, o = {}) => {
      const id = 'c' + (++env.n);
      env.sent.push({ id, args, hold: Boolean(o.hold) });
      env.dispatches.set(id, { id, tab, machine: 'Mac2', project: 'Web', pub: args.machine, at: Date.now(), status: o.hold ? 'held' : 'sent' });
      env.records.set(id, { id, status: o.hold && !env.online ? 'held' : 'sent' });
      return { id, status: o.hold && !env.online ? 'held' : 'sent' };
    };
    const tabStateOf = () => 'ready'; const hqOnScreen = () => false; const inboxWaiting = () => false; const startPty = () => {}; const typePrompt = () => true; const hqRestarter = { tick: () => {} };
    const hqSettings = () => ({ enabled: true });
  `;
  env.link = link;
  const api = new Function('env', `${prelude}\n${src}\nreturn { deliverRun, approveHeld, hqStatus, hqRequestsDone, onOfficeReport, routineProblem, hqMinter };`)(env);
  // the restart rule and the tick's wait rule, as main runs them
  const stillOpenLine = MAIN_SRC.split('\n').find((l) => l.trim().startsWith('const stillOpen = (run) =>'));
  api.stillOpen = new Function('HQ', 'linkHost', `${stillOpenLine}\nreturn stillOpen;`)(HQ, { knows: () => false, remoteTask: (id) => env.records.get(id) || null });
  const routine = ROUT.normalizeRoutine({ id: 'rt0000000a', name: 'Nightly', prompt: 'Run the tests', target: { kind: 'remote', pub: PUB, projectId: 'web' }, schedule: { kind: 'daily', at: '09:00' }, noAsk: true });
  env.state.routines = [routine];
  const newRun = () => { const run = { id: 'ru0000000' + env.file.runs.length, routine: routine.id, name: routine.name, kind: 'remote', slotAt: Date.now(), at: Date.now(), trigger: 'manual', status: 'waiting', tasks: [] }; env.file.runs.unshift(run); return run; };
  return { env, api, routine, newRun, dir };
}

test('remote routine run → a held "awaiting approval" card + notification; never a modal or a send; the checkbox is ignored', async () => {
  const { env, api, routine, newRun } = remoteHarness();
  assert.equal(routine.noAsk, true);   // ticked, but it applies to local targets only
  assert.equal(ROUT.routineNoAsk(routine, { remote: false, projectId: 'web' }), false);
  assert.equal(api.routineProblem(routine), '');
  const run = newRun();
  await api.deliverRun(run, Date.now());
  const card = env.board.tasks[0];
  assert.deepEqual([card.status, card.machine, card.machineName, card.project, card.projectId], ['awaiting-consent', PUB, 'Mac2', 'Web', 'web']);
  assert.equal(run.status, 'awaiting-consent');
  assert.deepEqual(run.held, [card.id]);
  assert.deepEqual([env.sent.length, env.dialogs], [0, 0]);
  assert.equal(env.notes.length, 1);
  assert.match(env.notes[0].title, /Nightly.*Web.*Mac2/);
  assert.match(env.sent.length ? '' : card.request, /./);
  // also with the global "dispatch without asking" on
  env.state.hq.dispatchWithoutAsking = true;
  const m = HQ.createMinter();
  const id = m.mint({ origin: 'routine', run: 'x' });
  assert.equal(HQ.consentFor({ setting: true, remote: true, request: id, minter: m, routineNoAsk: true }), 'held');
});

test('approve a remote held card → sent through the pacer; the record names the run; an OK report ends the run ok', async () => {
  const { env, api, newRun } = remoteHarness();
  const run = newRun();
  await api.deliverRun(run, Date.now());
  const held = env.board.tasks[0].id;
  assert.deepEqual(await api.approveHeld(held, true), { ok: true });
  assert.deepEqual(await api.approveHeld(held, true), { ok: false, reason: 'not-held' });   // twice sends once
  assert.equal(env.sent.length, 1);
  assert.deepEqual([env.sent[0].args.machine, env.sent[0].args.project, env.sent[0].hold], [PUB, 'web', false]);
  assert.match(env.sent[0].args.task, /^\[routine /);
  const id = env.sent[0].id;
  assert.equal(env.dispatches.get(id).routine, run.id);
  assert.equal(run.status, 'running');
  assert.ok(run.tasks.includes(id));
  assert.equal(env.board.tasks.filter((x) => x.status === 'awaiting-consent').length, 0);
  api.onOfficeReport({ id, pub: PUB, report: { summary: 'OK: all 120 tests pass\nmore' } });
  assert.deepEqual([run.status, run.outcome], ['ok', 'OK: all 120 tests pass']);
  assert.equal(env.rows.length, 0);   // HQ was not asked: no HQ inbox rows
});

test('offline device: approve → the task waits in the outbox (held), history shows offline; ATTENTION report → attention', async () => {
  const { env, api, newRun } = remoteHarness({ online: false });
  assert.equal(api.routineProblem(env.state.routines[0]), '');   // offline is not a problem
  const run = newRun();
  await api.deliverRun(run, Date.now());
  await api.approveHeld(env.board.tasks[0].id, true);
  assert.deepEqual([env.sent.length, env.sent[0].hold], [1, true]);
  const id = env.sent[0].id;
  const task = env.board.tasks.find((x) => x.id === id);
  assert.deepEqual([task.status, task.reason], ['queued', 'offline']);
  assert.equal(ROUT.runWait(env.board.tasks.filter((x) => x.request === run.request)), 'offline');
  assert.equal(env.dispatches.get(id).routine, run.id);
  api.onOfficeReport({ id, pub: PUB, report: { summary: 'ATTENTION: 2 tests fail on main' } });
  assert.deepEqual([run.status, run.outcome], ['attention', 'ATTENTION: 2 tests fail on main']);
});

test('expiry ends a remote run with attention: the held card after 12 h, or the outbox entry (expired on the link)', async () => {
  const a = remoteHarness();
  const run = a.newRun();
  await a.api.deliverRun(run, Date.now());
  const { board, expired, done } = HQ.expireHeld(a.env.board, Date.now() + HQ.HELD_MS + 1);
  assert.equal(expired.length, 1);
  a.env.board = board;
  a.api.hqRequestsDone(done);
  assert.deepEqual([run.status, run.reason], ['attention', 'expired']);
  const b = remoteHarness({ online: false });
  const run2 = b.newRun();
  await b.api.deliverRun(run2, Date.now());
  await b.api.approveHeld(b.env.board.tasks[0].id, true);
  b.api.hqStatus(b.env.sent[0].id, 'expired', 'expired');   // what hqMirrorRemote does when the 24 h outbox TTL runs out
  assert.deepEqual([run2.status, run2.reason], ['attention', 'expired']);
  // decline → the run ends too (its request is done with a rejected task)
  const c = remoteHarness();
  const run3 = c.newRun();
  await c.api.deliverRun(run3, Date.now());
  await c.api.approveHeld(c.env.board.tasks[0].id, false);
  assert.deepEqual([run3.status, run3.reason, c.env.sent.length], ['attention', 'declined', 0]);
});

test('old peer (no task-status): an unknown record keeps the run open (no wait shown) until lost or the remote timeout', async () => {
  const { env, api, newRun } = remoteHarness();
  const run = newRun();
  await api.deliverRun(run, Date.now());
  await api.approveHeld(env.board.tasks[0].id, true);
  const id = env.sent[0].id;
  env.records.set(id, { id, status: 'unknown' });
  assert.equal(HQ.boardOfRemote(env.records.get(id)), null);   // the card stays as it was
  assert.equal(run.status, 'running');
  api.hqStatus(id, 'lost', 'unknown');   // its next hello: lost (never typed twice)
  assert.deepEqual([run.status, run.reason], ['attention', 'unknown']);
  assert.equal(ROUT.runTimeoutMs('remote', HQ.HQ_TTL_MS), HQ.HQ_TTL_MS + 3600e3 + ROUT.REMOTE_WAIT_MS);
  assert.equal(ROUT.runTimeoutMs('project', HQ.HQ_TTL_MS), HQ.HQ_TTL_MS + 3600e3);
});

test('remoteProblem / runWait: unpaired or unknown project → target-gone; waits from the newest open task', () => {
  const tg = { kind: 'remote', pub: PUB, projectId: 'web' };
  const cache = { [PUB]: { projects: [{ id: 'web' }] } };
  assert.equal(ROUT.remoteProblem(tg, { paired: [PUB], cache }), '');
  assert.equal(ROUT.remoteProblem(tg, { paired: [], cache }), 'target-gone');
  assert.equal(ROUT.remoteProblem({ ...tg, projectId: 'api' }, { paired: [PUB], cache }), 'target-gone');
  assert.equal(ROUT.runWait([{ status: 'queued', reason: 'paced', at: 1 }]), 'paced');
  assert.equal(ROUT.runWait([{ status: 'reported', at: 2 }, { status: 'running', at: 1 }]), 'running');
  assert.equal(ROUT.runWait([{ status: 'awaiting-consent', at: 1 }]), '');
  assert.equal(ROUT.runWait([]), '');
});

test('review: a paced remote send keeps the run open across a restart; late reports never reach HQ inbox; no timeout while open; old-peer unknown shows no wait', async () => {
  const { env, api, newRun } = remoteHarness();
  env.pace(false);
  const run = newRun();
  await api.deliverRun(run, Date.now());
  await api.approveHeld(env.board.tasks[0].id, true);
  assert.equal(env.sent.length, 0);
  assert.match(run.tasks[0], /^h/);   // the pacer's id for now
  env.paced();   // the device's limit allows it
  const id = env.sent[0].id;
  assert.deepEqual(run.tasks, [id]);
  assert.equal(env.dispatches.get(id).routine, run.id);
  assert.equal(api.stillOpen(run), true);   // restart: the record is open → the run keeps waiting
  // far past the 29 h timeout, but the task is still open on the board: the run stays
  await api.deliverRun(run, Date.now() + 40 * H);
  assert.equal(run.status, 'running');
  // old peer drop: unknown record → the tick shows no wait
  env.records.set(id, { id, status: 'unknown' });
  assert.match(MAIN_SRC, /linkHost\?\.remoteTask\(t\.id\)\?\.status !== 'unknown'/);
  // the run ends some other way; a late report for its tagged record writes no HQ inbox row
  run.status = 'attention'; run.finishedAt = Date.now();
  api.onOfficeReport({ id, pub: PUB, report: { summary: 'OK: late' } });
  assert.deepEqual([env.rows.length, run.status], [0, 'attention']);
});
