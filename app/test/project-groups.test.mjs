// Project groups (contract v3.86): src/project-groups.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGroup, groupProjects, shownOrder, groupNames, listed } from '../src/project-groups.mjs';

const P = (id, group, extra = {}) => ({ id, name: id, ...(group !== undefined ? { group } : {}), ...extra });

test('groups: ungrouped first, then groups by name; personal workspaces never listed', () => {
  const list = [P('a'), P('b', 'Müşteri'), P('c', 'ERP'), P('d', 'erp '), P('e'), P('me', undefined, { staffOwner: 's-a1a1a1' }), P('f', 'işler')];
  const g = groupProjects(list);
  assert.deepEqual(g.map((x) => [x.name, x.projects.map((p) => p.id)]), [['', ['a', 'e']], ['ERP', ['c', 'd']], ['işler', ['f']], ['Müşteri', ['b']]]);
  assert.deepEqual(shownOrder(list).map((p) => p.id), ['a', 'e', 'c', 'd', 'f', 'b']);
  assert.deepEqual(groupNames(list), ['ERP', 'işler', 'Müşteri']);
  assert.equal(listed(list).some((p) => p.staffOwner), false);
  assert.deepEqual(groupProjects([P('x')]).map((x) => x.name), [''], 'no groups: one block, no heading');
});

test('cleanGroup: one trimmed line, at most 40 characters', () => {
  assert.equal(cleanGroup('  Müşteri\n işleri  '), 'Müşteri işleri');
  assert.equal(cleanGroup('x'.repeat(60)).length, 40);
  assert.equal(cleanGroup(5), '');
  assert.equal(cleanGroup('   '), '');
});

test('state: normalizeState keeps a clean group, setGroup sets and clears it', async () => {
  const { createRequire } = await import('node:module');
  const P = createRequire(import.meta.url)('../src/projects.js');
  const s = P.normalizeState({ projects: [{ id: 'a', dir: '/a', group: ' ERP\n işleri ' }, { id: 'b', dir: '/b', group: '   ' }] });
  assert.equal(s.projects[0].group, 'ERP işleri');
  assert.equal('group' in s.projects[1], false);
  assert.equal(P.setGroup(s, 'b', 'Müşteriler').projects[1].group, 'Müşteriler');
  assert.equal('group' in P.setGroup(s, 'a', '').projects[0], false);
  assert.deepEqual(P.setGroup(s, 'zz', 'X').projects, s.projects, 'an unknown id changes nothing');
});
