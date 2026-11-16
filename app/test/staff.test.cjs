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
  assert.deepEqual([m.accountId, m.projects, m.department, m.skillPacks], [undefined, ['p1'], undefined, ['superpowers']]);
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
