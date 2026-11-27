'use strict';
// Fan-out orders and role assignment (contract v3.132): src/hq-fanout.js, plus how main.js wires it (source checks).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const FO = require('../src/hq-fanout.js');
const HQ = require('../src/hq.js');
const BM = require('../src/board-model.js');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const fnBody = (name) => { const i = MAIN.indexOf(`async function ${name}(`); assert.ok(i >= 0, name); return MAIN.slice(i, MAIN.indexOf('\n}\n', i)); };

const DEFS = [
  { id: 'qa', name: { en: 'QA engineer', tr: 'Test uzmanı' } },
  { id: 'software-developer', name: { en: 'Software developer', tr: 'Yazılım geliştirici' } },
  { id: 'devops', name: { en: 'DevOps engineer', tr: 'DevOps mühendisi' } },
];
const STAFF = [
  { id: 'm1', name: 'Ada', role: { preset: 'software-developer' }, projects: ['p1', 'p2'] },
  { id: 'm2', name: 'Bob', role: { preset: 'qa' }, projects: ['p1'] },
  { id: 'm3', name: 'Cem', role: { preset: 'qa' }, projects: ['p1', 'p2'] },
  { id: 'm4', name: 'Dee', role: { preset: 'devops', name: 'Release manager' }, projects: 'all' },
];
const P1 = { id: 'p1', name: 'web' };
const P2 = { id: 'p2', name: 'api' };

test('fanOutRefusal: shape, max 8, no mixing with a single target or stages', () => {
  assert.equal(FO.FANOUT_MAX, 8);
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [{ project: 'web' }, { project: 'api', role: 'qa' }] }), '');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [] }), 'bad-targets');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: 'web' }), 'bad-targets');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: Array.from({ length: 9 }, () => ({ project: 'web' })) }), 'too-many-targets');
  assert.equal(FO.fanOutRefusal({ task: 'x', project: 'web', targets: [{ project: 'api' }] }), 'fanout-mixed');
  assert.equal(FO.fanOutRefusal({ task: 'x', staff: 'Ada', targets: [{ project: 'api' }] }), 'fanout-mixed');
  assert.equal(FO.fanOutRefusal({ task: 'x', then: [{ task: 'y' }], targets: [{ project: 'api' }] }), 'fanout-mixed');
  assert.equal(FO.fanOutRefusal({ task: 'x', after: 't1', targets: [{ project: 'api' }] }), 'fanout-mixed');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [{ machine: 'mac' }] }), 'bad-target');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [{ project: 'web', member: 'Ada', role: 'qa' }] }), 'bad-target');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [{ project: 'web', staffName: 'x' }] }), 'bad-target');   // never the app's internal args
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [{ project: 'web', desk: 'p1:3' , role: 'qa' }] }), 'bad-target');
  assert.equal(FO.fanOutRefusal({ task: 'x', targets: [null] }), 'bad-target');
});

test('expandFanOut: one task per target in the same order, shared task/type, member/desk become staff (never desk)', () => {
  const out = FO.expandFanOut({ task: 'Do it', type: 'bugfix', title: 'T', request: 'r1', targets: [
    { project: 'web', member: 'Ada' }, { project: 'api', machine: 'mini', title: 'Own' }, { project: 'web', role: 'qa' }, { project: 'web', desk: 'Cem' },
  ] });
  assert.deepEqual(out.map((x) => x.n), [1, 2, 3, 4]);
  assert.deepEqual(out.map((x) => x.args.project), ['web', 'api', 'web', 'web']);
  for (const x of out) { assert.equal(x.args.task, 'Do it'); assert.equal(x.args.type, 'bugfix'); assert.equal(x.args.request, 'r1'); assert.equal(x.args.targets, undefined); assert.equal(x.args.desk, undefined); }
  assert.equal(out[0].args.staff, 'Ada');
  assert.equal(out[1].args.machine, 'mini'); assert.equal(out[1].args.title, 'Own'); assert.equal(out[1].args.staff, undefined);
  assert.equal(out[2].role, 'qa'); assert.equal(out[2].args.staff, undefined);
  assert.equal(out[3].args.staff, 'Cem'); assert.equal(out[3].role, '');
});

test('pickMember: role + project, fewest open tasks, warm desk wins a tie, then team order', () => {
  // idle members first
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: 'qa', load: { m2: 1 }, defs: DEFS }).member.id, 'm3');
  // a tie: the warm desk wins; without warmth, the team's order
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: 'qa', load: {}, warm: ['m3'], defs: DEFS }).member.id, 'm3');
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: 'qa', load: {}, warm: [], defs: DEFS }).member.id, 'm2');
  // load beats warmth
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: 'qa', load: { m3: 2, m2: 1 }, warm: ['m3'], defs: DEFS }).member.id, 'm2');
  // only members allowed on the project
  assert.equal(FO.pickMember({ staff: STAFF, project: P2, role: 'qa', load: { m3: 5 }, defs: DEFS }).member.id, 'm3');
  // a role name (preset name in either language, the member's own name), case ignored
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: 'Software Developer', defs: DEFS }).member.id, 'm1');
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: 'yazılım geliştirici', defs: DEFS }).member.id, 'm1');
  assert.equal(FO.pickMember({ staff: STAFF, project: P2, role: 'release manager', defs: DEFS }).member.id, 'm4');
  // a personal workspace belongs to its owner only
  assert.equal(FO.pickMember({ staff: STAFF, project: { id: 'pw', staffOwner: 'm4' }, role: 'devops', defs: DEFS }).member.id, 'm4');
});

test('pickMember: no fit → no-member-for-role with the roles available on that project', () => {
  const r = FO.pickMember({ staff: STAFF, project: P2, role: 'designer', defs: DEFS });
  assert.equal(r.reason, 'no-member-for-role');
  assert.deepEqual(r.roles, ['QA engineer', 'Release manager', 'Software developer']);
  assert.deepEqual(FO.pickMember({ staff: [], project: P1, role: 'qa' }), { reason: 'no-member-for-role', roles: [] });
  assert.equal(FO.pickMember({ staff: STAFF, project: P1, role: '', defs: DEFS }).reason, 'no-member-for-role');
});

test('memberLoad: open tasks per member id only', () => {
  assert.deepEqual(FO.memberLoad([
    { staffId: 'm2', status: 'running' }, { staffId: 'm2', status: 'queued' }, { staffId: 'm2', status: 'reported' },
    { staffId: 'm3', status: 'failed' }, { status: 'running' }, null,
  ]), { m2: 2 });
});

// The fan-out runs each target through hqDispatch one after another: simulate that sequence with the real cap rule.
test('caps with fan-out: each expanded task is checked against the board with the ones before it', () => {
  let board = HQ.emptyBoard();
  for (let i = 0; i < HQ.MAX_PER_REQUEST - 3; i++) board = HQ.addTask(board, { id: `t${i}`, request: 'r1', project: 'web', status: 'running' });
  const items = FO.expandFanOut({ task: 'x', request: 'r1', targets: Array.from({ length: 6 }, (_, i) => ({ project: `p${i}` })) });
  const results = items.map((it) => {
    const cap = HQ.capReason(board, it.args.request);
    if (cap) return cap;
    board = HQ.addTask(board, { id: `f${it.n}`, request: 'r1', project: it.args.project, status: 'queued' });
    return 'ok';
  });
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'request-cap', 'request-cap', 'request-cap']);   // no shortcut past MAX_PER_REQUEST
});

test('consent per target: decided for each expanded task (a remote target and a local one of the same request)', () => {
  const m = HQ.createMinter({ now: () => 1000, rand: () => 'x' });
  const id = m.mint();
  const items = FO.expandFanOut({ task: 'x', request: id, targets: [{ project: 'web' }, { project: 'api', machine: 'mini' }] });
  const asks = items.map((it) => HQ.consentFor({ ask: true, remote: Boolean(it.args.machine), request: it.args.request, minter: m, now: 1000 }));
  assert.deepEqual(asks, ['app', 'app']);   // askBeforeDispatch: one dialog per target, never one for all
  assert.deepEqual(items.map((it) => HQ.consentFor({ ask: false, remote: Boolean(it.args.machine), request: 'rforged', minter: m, now: 1000 })), ['app', 'app']);
});

test('main wiring: targets go through hqFanOut → hqDispatch per target in order, never a shortcut', () => {
  assert.match(MAIN, /args\.targets !== undefined \? hqFanOut\(args\) : hqDispatch\(args\)/);
  const fan = fnBody('hqFanOut');
  assert.match(fan, /FO\.fanOutRefusal\(args\)/);
  assert.match(fan, /for \(const item of FO\.expandFanOut\(args\)\)/);
  assert.match(fan, /await hqDispatch\(one\)/);   // sequential: each cap check sees the rows before it
  assert.doesNotMatch(fan, /officeDispatch|hqOrderEnqueue|addTask|approved: true/);   // no path around consent, caps, queue, redaction
  assert.match(fan, /FO\.pickMember\(/);
  assert.match(fan, /no-team|staff-local-only/);
  assert.match(fnBody('hqDispatch'), /if \(args\?\.targets !== undefined\) return hqFanOut\(args\)/);
});

test('board: a fan-out order card carries every target project and assigned member', () => {
  const board = { requests: [{ id: 'r1', at: 1, prompt: 'Run the smoke test everywhere', tasks: ['a', 'b', 'c'] }], tasks: [
    { id: 'a', request: 'r1', project: 'web', staff: 'Cem', status: 'running', at: 2 },
    { id: 'b', request: 'r1', project: 'api', staff: 'Cem', status: 'queued', at: 3 },
    { id: 'c', request: 'r1', project: 'web', staff: 'Bob', status: 'reported', at: 4 },
  ] };
  const card = BM.orderCard(board.requests[0], board.tasks);
  assert.ok(card);
  assert.deepEqual([...card.projects].sort(), ['api', 'web']);
  assert.deepEqual([...card.members].sort(), ['Bob', 'Cem']);
  assert.equal(card.progress.total, 3);
  assert.deepEqual(card.tasks.map((x) => `${x.project}@${x.member}`).sort(), ['api@Cem', 'web@Bob', 'web@Cem']);   // one target chip each, with its member
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'board-view.js'), 'utf8'), /x\.member \? ` @\$\{x\.member\}`/);
});
