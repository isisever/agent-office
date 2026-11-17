// Team: staff (contract v3.81): src/staff.js (state) and src/staff-view.mjs (the TEAM panel's helpers).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ST = require('../src/staff.js');

const ROLES = path.join(__dirname, '..', '..', 'roles');
const known = { projectIds: ['p1', 'p2', 'p3'], accountIds: ['default', 'work'], presetIds: ['erp-odoo', 'qa', 'devops'] };
const ayse = { id: 's-a1b2c3', name: 'Ayşe', role: { preset: 'erp-odoo' }, department: 'Geliştirme', accountId: 'work', projects: ['p1', 'p2'] };

test('loadRoles: the eight shipped presets, each with a name, a brief and a short name', () => {
  const defs = ST.loadRoles(ROLES);
  assert.deepEqual(defs.map((d) => d.id), ['assistant', 'chatbot', 'data-analyst', 'devops', 'erp-odoo', 'product', 'qa', 'rpa']);
  for (const d of defs) {
    assert.ok(d.name.tr && d.name.en && d.brief.length > 200 && d.short?.tr, d.id);
  }
  assert.equal(defs.find((d) => d.id === 'assistant').writesCode, false);
  assert.match(defs.find((d) => d.id === 'qa').brief, /never change product code/);
  assert.match(defs.find((d) => d.id === 'devops').brief, /Never deploy to production/);
  assert.deepEqual(ST.loadRoles('/no/such/folder'), []);
});

test('normalizeMember: a preset or an own role; gone projects and accounts dropped; bad ones refused', () => {
  assert.deepEqual(ST.normalizeMember(ayse, known), ayse);
  const m = ST.normalizeMember({ ...ayse, accountId: 'gone', projects: ['p1', 'zz', 'p1'], department: '  ', skillPacks: ['superpowers', 'BAD id'] }, known);
  assert.deepEqual([m.accountId, m.projects, m.department, m.skillPacks], [undefined, ['p1'], undefined, { superpowers: true }], 'an old list means on');
  assert.equal(ST.normalizeMember({ ...ayse, projects: 'all' }, known).projects, 'all');
  const own = ST.normalizeMember({ id: 's-ffffff', name: 'Selin', role: { name: 'İçerik yazarı', brief: 'Writes blog posts.\nNo code.', writesCode: false }, projects: [] }, known);
  assert.deepEqual(own.role, { name: 'İçerik yazarı', brief: 'Writes blog posts.\nNo code.', writesCode: false });
  assert.equal(ST.normalizeMember({ ...ayse, role: { preset: 'unknown-role' } }, known), null, 'an unknown preset and no own name');
  assert.equal(ST.normalizeMember({ ...ayse, name: '' }, known), null);
  assert.equal(ST.normalizeMember({ ...ayse, id: 'x' }, known), null);
});

test('saveMember: adds with a new id, edits by id; unique names; at most 50', () => {
  let n = 0;
  const id = () => `s-00000${++n}`;
  const a = ST.saveMember([], { name: 'Ayşe', role: { preset: 'erp-odoo' }, projects: ['p1'] }, known, id);
  assert.equal(a.member.id, 's-000001');
  const b = ST.saveMember(a.staff, { name: 'Mert', role: { preset: 'qa' }, projects: 'all' }, known, id);
  assert.equal(b.staff.length, 2);
  const edit = ST.saveMember(b.staff, { id: 's-000001', name: 'Ayşe K.', role: { preset: 'erp-odoo' }, projects: ['p1', 'p2'] }, known, id);
  assert.deepEqual(edit.staff.map((m) => m.name), ['Ayşe K.', 'Mert']);
  assert.equal(ST.saveMember(b.staff, { name: 'mert', role: { preset: 'qa' }, projects: [] }, known, id).error, 'name-used');
  assert.equal(ST.saveMember(b.staff, { name: '', role: { preset: 'qa' } }, known, id).error, 'name');
  assert.equal(ST.saveMember(b.staff, { name: 'X', role: {} }, known, id).error, 'role');
  const full = Array.from({ length: ST.STAFF_MAX }, (_, i) => ({ id: `s-${String(i).padStart(6, '0')}`, name: `m${i}`, role: { preset: 'qa' }, projects: [] }));
  assert.equal(ST.saveMember(full, { name: 'one more', role: { preset: 'qa' } }, known, id).error, 'too-many');
  assert.deepEqual(ST.removeMember(edit.staff, 's-000001').map((m) => m.name), ['Mert']);
});

test('dropProject / dropAccount / mayWork', () => {
  const staff = [ayse, { ...ayse, id: 's-bbbbbb', name: 'Mert', projects: 'all', accountId: 'default' }];
  assert.deepEqual(ST.dropProject(staff, 'p1').map((m) => m.projects), [['p2'], 'all']);
  assert.deepEqual(ST.dropAccount(staff, 'work').map((m) => m.accountId), [undefined, 'default']);
  assert.equal(ST.mayWork(ayse, 'p2'), true);
  assert.equal(ST.mayWork(ayse, 'p3'), false);
  assert.equal(ST.mayWork(staff[1], 'anything'), true);
});

test('staff-view: roleOf merges the preset with the member’s own words; byDepartment groups, no department last', async () => {
  const V = await import('../src/staff-view.mjs');
  const defs = ST.loadRoles(ROLES);
  const r = V.roleOf(ayse, defs, 'tr');
  assert.equal(r.name, 'ERP Geliştirici (Odoo)');
  assert.equal(r.short, 'ERP');
  assert.ok(r.brief.startsWith('You are the ERP developer'));
  const own = V.roleOf({ role: { name: 'İçerik yazarı', writesCode: false } }, defs, 'tr');
  assert.deepEqual([own.name, own.short, own.writesCode], ['İçerik yazarı', 'İÇERİK', false]);
  const groups = V.byDepartment([{ name: 'a', department: 'Dev' }, { name: 'b' }, { name: 'c', department: 'Ops' }, { name: 'd', department: 'Dev' }]);
  assert.deepEqual(groups.map((g) => [g.head, g.members.map((m) => m.name)]), [['Dev', ['a', 'd']], ['Ops', ['c']], ['', ['b']]]);
});

// ---------- desks (step 3) and HQ (step 4) ----------
const P = require('../src/projects.js');

test('desks: a staff tab keeps staffId and sessionId; resolvePty gives a desk its member’s own account', () => {
  const tabs = P.normalizeTabs([{ n: 2, staffId: 's-a1b2c3', sessionId: 'abc-1' }, { n: 3, staffId: 'nope', sessionId: 'x' }, { n: 4, staffId: 's-a1b2c3', shell: true, dir: '/w' }]);
  assert.deepEqual(tabs, [{ n: 2, staffId: 's-a1b2c3', sessionId: 'abc-1' }, { n: 3 }, { n: 4, dir: '/w', shell: true }]);
  const state = {
    accounts: [{ id: 'default' }, { id: 'work' }], projects: [{ id: 'p1', dir: '/w/p1', accountId: 'default', tabs: [{ n: 2, staffId: 's-a1b2c3' }, { n: 3, staffId: 's-bbbbbb' }] }],
    staff: [{ ...ayse, id: 's-a1b2c3', accountId: 'work' }, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }],
  };
  assert.equal(P.resolvePty(state, 'p1:2').project.accountId, 'work', 'the member’s account');
  assert.equal(P.resolvePty(state, 'p1:3').project.accountId, 'default', 'no own account: the project’s');
  assert.equal(P.resolvePty(state, 'p1').project.accountId, 'default', 'the main tab is unchanged');
  assert.equal(P.resolvePty({ ...state, accounts: [{ id: 'default' }] }, 'p1:2').project.accountId, 'default', 'a gone account: the project’s');
  assert.deepEqual(P.desksOf(state.projects[0]).map((t) => t.staffId), ['s-a1b2c3', 's-bbbbbb']);
  assert.equal(P.deskOf(state.projects[0], 's-bbbbbb').n, 3);
  const next = P.setDeskSession(state, 'p1', 2, 'sess-9');
  assert.equal(P.deskOf(next.projects[0], 's-a1b2c3').sessionId, 'sess-9');
  assert.equal(P.setDeskSession(next, 'p1', 2, 'sess-9'), next, 'unchanged: same state');
});

test('a member’s role settings: a preset’s fields overridden (writes code both ways), packs on top of the desk’s project', () => {
  const defs = ST.loadRoles(ROLES);
  const pm = ST.normalizeMember({ ...ayse, role: { preset: 'assistant', brief: 'Own words.', writesCode: true } }, { ...known, presetIds: null });
  assert.deepEqual(pm.role, { preset: 'assistant', brief: 'Own words.', writesCode: true });
  assert.equal(defs.find((d) => d.id === 'assistant').writesCode, false, 'the preset does not write code');
  assert.deepEqual([ST.memberRole(pm, defs).writesCode, ST.memberRole(pm, defs).brief], [true, 'Own words.']);
  const qa = ST.normalizeMember({ ...ayse, role: { preset: 'qa', writesCode: false } }, known);
  assert.equal(ST.memberRole(qa, defs).writesCode, false);
  assert.equal(ST.normalizeMember({ ...ayse, role: { name: 'Yazar', writesCode: true } }, known).role.writesCode, undefined, 'an own role writes code unless told not to');
  assert.deepEqual(ST.packMap({ superpowers: false, 'BAD id': true, x: 'on' }), { superpowers: false });
  const state = {
    accounts: [{ id: 'default' }], staff: [{ ...ayse, accountId: undefined, skillPacks: { superpowers: true, caveman: false } }],
    projects: [{ id: 'p1', dir: '/w/p1', accountId: 'default', skillPacks: { caveman: true, other: true }, tabs: [{ n: 2, staffId: 's-a1b2c3' }] }],
  };
  assert.deepEqual(P.resolvePty(state, 'p1:2').project.skillPacks, { caveman: false, other: true, superpowers: true });
  assert.deepEqual(P.resolvePty(state, 'p1').project.skillPacks, { caveman: true, other: true }, 'the main tab: the project’s');
  assert.deepEqual(state.projects[0].skillPacks, { caveman: true, other: true }, 'the project is not changed');
});

test('parallel: a project flag, never written when off; a desk worktree lives in userData', () => {
  const s = { projects: [{ id: 'p1', dir: '/w/p1' }] };
  const on = P.setParallel(s, 'p1', true);
  assert.equal(on.projects[0].parallel, true);
  assert.equal('parallel' in P.setParallel(on, 'p1', false).projects[0], false);
  const wt = ST.deskWorktree('/ud', 'p1', 's-a1b2c3', path.posix.join);
  assert.deepEqual(wt, { root: '/ud/work/p1/s-a1b2c3', branch: 'agent-office/s-a1b2c3' });
});

test('deskWaits: one desk at work per folder unless the project is parallel', () => {
  const busy = new Set(['p1']);
  assert.equal(ST.deskWaits({}, 'p1:2', ['p1', 'p1:2'], (id) => busy.has(id)), true, 'the boss tab works: the desk waits');
  assert.equal(ST.deskWaits({}, 'p1:2', ['p1', 'p1:2'], () => false), false);
  assert.equal(ST.deskWaits({ parallel: true }, 'p1:2', ['p1', 'p1:2'], () => true), false, 'parallel: never waits');
  assert.equal(ST.deskWaits({}, 'p1:2', ['p1:2'], () => true), false, 'its own work does not count');
});

test('deskRoleFile: the member, its role in English, the project and the rest of the team; no account or token', () => {
  const defs = ST.loadRoles(ROLES);
  const staff = [ayse, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }];
  const f = ST.deskRoleFile(ayse, defs, { id: 'p1', name: 'acme', dir: '/w/acme' }, staff);
  assert.equal(f.member, 'Ayşe');
  assert.equal(f.name, 'ERP Developer (Odoo)');
  assert.equal(f.department, 'Geliştirme');
  assert.deepEqual(f.project, { name: 'acme', dir: '/w/acme' });
  assert.deepEqual(f.team, [{ name: 'Mert', role: 'QA Engineer' }]);
  assert.ok(!('accountId' in f) && !JSON.stringify(f).includes('work"'), 'no account');
});

test('machineStaff / findMember: HQ sees roles, allowed projects and desks; members found by name or id', () => {
  const defs = ST.loadRoles(ROLES);
  const projects = [{ id: 'p1', name: 'acme' }, { id: 'p2', name: 'beta' }, { id: 'p3', name: 'gamma' }];
  const staff = [ayse, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }];
  const states = { 'p1:s-a1b2c3': 'busy', 'p3:s-bbbbbb': 'idle' };
  const v = ST.machineStaff(staff, defs, projects, (pid, sid) => states[`${pid}:${sid}`] || 'none');
  assert.deepEqual(v[0].projects, ['acme', 'beta']);
  assert.deepEqual(v[0].desks, [{ project: 'acme', state: 'busy' }]);
  assert.equal(v[0].busy, true);
  assert.equal(v[1].projects, 'all');
  assert.deepEqual(v[1].desks, [{ project: 'gamma', state: 'idle' }]);
  assert.equal(v[1].role, 'QA Engineer');
  assert.equal(ST.findMember(staff, 'AYŞE').id, ayse.id);
  assert.equal(ST.findMember(staff, 's-bbbbbb').name, 'Mert');
  assert.equal(ST.findMember(staff, 'nobody'), null);
});

test('main.js: HQ dispatch to staff — checks, the desk, the lock, the member’s env', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  const hs = fn('hqStaffDesk');
  for (const r of ['staff-local-only', 'no-team', 'unknown-staff', 'staff-not-allowed']) assert.ok(hs.includes(`'${r}'`), r);
  assert.match(fn('linkTabState'), /ST\.deskWaits\(/);
  assert.match(fn('officeDispatch'), /linkHost\.dispatchLocal\(into,/);
  assert.match(src, /if \(roleFile\) env\.AGENT_OFFICE_ROLE = roleFile;/);
  assert.match(src, /if \(project\.hq && teamOn\(\)\) env\.AGENT_OFFICE_TEAM = '1';/);
  assert.match(fn('openDesk'), /ST\.deskWorktree\(app\.getPath\('userData'\)/);
});
