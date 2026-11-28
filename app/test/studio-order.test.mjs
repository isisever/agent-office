// Studio (contract v3.142): the sections, the drop plan and the Office-side store functions behind drag and drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { studioSections, planMove, dropSide } from '../src/studio-order.mjs';
import { studioGroups } from '../src/studio-view.mjs';

const require = createRequire(import.meta.url);
const P = require('../src/projects.js');

const list = [{ id: 'a' }, { id: 'b', group: 'ERP' }, { id: 'c' }, { id: 'd', group: 'erp' }, { id: 'e', group: 'Alpha' }];

test('sections: ungrouped first, groups by name (case ignored), order kept inside', () => {
  const s = studioSections(list);
  assert.deepEqual(s.map((x) => x.name), ['', 'Alpha', 'ERP']);
  assert.deepEqual(s[2].items.map((x) => x.id), ['b', 'd']);
  assert.deepEqual(studioSections(null), []);
});

test('studioGroups ordered keeps the given order and carries the group', () => {
  const g = studioGroups([{ id: 'z', name: 'Zed', group: ' ERP ' }, { id: 'a', name: 'Ann' }], { ordered: true });
  assert.deepEqual(g.map((x) => x.id), ['z', 'a']);
  assert.equal(g[0].group, 'ERP');
});

test('move before / after a row takes that row\'s group', () => {
  assert.deepEqual(planMove(list, 'a', { afterId: 'b' }), { order: ['b', 'a', 'c', 'd', 'e'], group: 'ERP' });
  assert.deepEqual(planMove(list, 'e', { beforeId: 'a' }), { order: ['e', 'a', 'b', 'c', 'd'], group: '' });
  assert.deepEqual(planMove(list, 'c', { afterId: 'e' }), { order: ['a', 'b', 'd', 'e', 'c'], group: 'Alpha' });
});

test('move onto a group heading goes to the end of that group; "" = ungrouped', () => {
  assert.deepEqual(planMove(list, 'a', { group: 'erp' }), { order: ['b', 'c', 'd', 'a', 'e'], group: 'erp' });
  assert.deepEqual(planMove(list, 'b', { group: '' }), { order: ['a', 'c', 'b', 'd', 'e'], group: '' });
  assert.deepEqual(planMove(list, 'a', { group: 'New' }), { order: ['b', 'c', 'd', 'e', 'a'], group: 'New' });
});

test('a drop that changes nothing, or a bad one, is null', () => {
  assert.notEqual(planMove(list, 'a', { beforeId: 'b' }), null, 'a joins the ERP group');
  assert.notEqual(planMove(list, 'c', { beforeId: 'd' }), null, 'c joins the ERP group');
  assert.equal(planMove(list, 'a', { afterId: 'a' }), null);
  assert.equal(planMove(list, 'a', { beforeId: 'nope' }), null);
  assert.equal(planMove(list, 'nope', { group: '' }), null);
  assert.equal(planMove(list, 'a', {}), null);
  assert.equal(planMove(list, 'e', { group: 'Alpha' }), null, 'e is already the last of its own group');
});

test('dropSide: upper half before, lower half after', () => {
  assert.equal(dropSide(10, 0, 40), 'before');
  assert.equal(dropSide(30, 0, 40), 'after');
});

test('store: reorderProjects and renameGroup', () => {
  const st = { projects: list.map((p) => ({ ...p })) };
  const moved = P.reorderProjects(st, ['e', 'a']);
  assert.deepEqual(moved.projects.map((p) => p.id), ['e', 'b', 'c', 'd', 'a'], 'the named slots swap, the rest stay');
  const renamed = P.renameGroup(st, 'Erp', 'Backend');
  assert.deepEqual(renamed.projects.map((p) => p.group), [undefined, 'Backend', undefined, 'Backend', 'Alpha']);
  const un = P.renameGroup(st, 'ERP', '');
  assert.ok(un.projects.every((p) => p.group !== 'ERP' && p.group !== 'erp'));
  assert.equal(P.renameGroup(st, '', 'x'), st);
});
