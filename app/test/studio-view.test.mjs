// Studio (contract v3.120): the multi-project sidebar's groups, the account label per project and the ⌘K palette filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { studioGroups, currentProjectId, filterPalette } from '../src/studio-view.mjs';

const require = createRequire(import.meta.url);
const S = require('../src/studio.js');

const run = (n, title) => ({ ptyId: n === 1 ? 'p' : `p:${n}`, n, title, isRunning: false, isAsleep: false });
const projects = [
  { id: 'b', name: 'beta', account: 'Work', active: true, running: [run(3, 'fix login'), run(1, 'beta')], recent: [{ sessionId: 's1', title: 'old', at: 1 }, { sessionId: 's2', title: 'newer', at: 5 }] },
  { id: 'a', name: 'Alpha', account: 'Personal', active: false, running: [run(1, 'Alpha')], recent: [] },
  { id: 'c', name: 'gamma', running: [run(1, 'gamma'), run(2, 'login page')], recent: [] },
];

test('groups: every project by name, running by tab number, recent newest first', () => {
  const g = studioGroups(projects, { currentId: 'b' });
  assert.deepEqual(g.map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(g[1].running.map((s) => s.n), [1, 3]);
  assert.deepEqual(g[1].recent.map((r) => r.sessionId), ['s2', 's1']);
  assert.deepEqual(g.map((x) => x.current), [false, true, false]);
  assert.deepEqual(g.map((x) => x.active), [false, true, false]);
  assert.deepEqual(projects[0].running.map((s) => s.n), [3, 1], 'the input is not reordered');
});

test('groups: a search keeps a matching project whole, else only matching sessions; empty projects drop', () => {
  const g = studioGroups(projects, { query: ' LOGIN ' });
  assert.deepEqual(g.map((x) => x.id), ['b', 'c']);
  assert.deepEqual(g[0].running.map((s) => s.title), ['fix login']);
  assert.deepEqual(g[0].recent, []);
  assert.deepEqual(g[1].running.map((s) => s.title), ['login page']);
  const whole = studioGroups(projects, { query: 'bet' });
  assert.equal(whole.length, 1);
  assert.equal(whole[0].running.length, 2);
  assert.equal(whole[0].recent.length, 2);
  assert.deepEqual(studioGroups(projects, { query: 'nothing' }), []);
  assert.deepEqual(studioGroups(null), []);
});

test('groups: the account label is passed through, missing is empty', () => {
  assert.deepEqual(studioGroups(projects).map((x) => x.account), ['Personal', 'Work', '']);
});

test('current project: the active one, else the last picked one, else the first by name', () => {
  assert.equal(currentProjectId(projects, 'c'), 'b');
  const noneActive = projects.map((p) => ({ ...p, active: false }));   // HQ is selected
  assert.equal(currentProjectId(noneActive, 'c'), 'c');
  assert.equal(currentProjectId(noneActive, 'gone'), 'a');
  assert.equal(currentProjectId(noneActive), 'a');
  assert.equal(currentProjectId([]), '');
});

test('listSessions: each project carries its account label only (trimmed, capped), "" without accountOf', () => {
  const ps = [{ id: 'x', name: 'X', dir: '/x', tabs: [] }, { id: 'y', name: 'Y', dir: '/y', tabs: [] }];
  const labels = { x: '  Work  ', y: 'L'.repeat(200) };
  const out = S.listSessions({ projects: ps, status: [], recent: [], accountOf: (p) => labels[p.id] });
  assert.equal(out[0].account, 'Work');
  assert.equal(out[1].account.length, 80);
  assert.equal(S.listSessions({ projects: ps, status: [], recent: [] })[0].account, '');
  assert.equal(S.listSessions({ projects: ps, status: [], recent: [], accountOf: () => ({ token: 'secret' }) })[0].account, '', 'only a string label');
});

test('palette: every word must match label or keywords; prefix first, then word start, then the rest', () => {
  const items = [
    { id: 'mcp', label: 'MCP servers', keywords: 'tools' },
    { id: 'skills', label: 'Skills', keywords: 'packs' },
    { id: 'settings', label: 'Project settings', keywords: 'edit account' },
    { id: 'accounts', label: 'Accounts', keywords: 'login switch' },
    { id: 'sess', label: 'beta · fix login', keywords: 'session' },
  ];
  assert.deepEqual(filterPalette(items, '').map((x) => x.id), ['mcp', 'skills', 'settings', 'accounts', 'sess']);
  assert.deepEqual(filterPalette(items, 'set').map((x) => x.id), ['settings']);
  assert.deepEqual(filterPalette(items, 'login').map((x) => x.id), ['sess', 'accounts'], 'a word of the label before a keyword');
  assert.deepEqual(filterPalette(items, 'S').map((x) => x.id), ['skills', 'mcp', 'settings', 'accounts', 'sess'], 'prefix, then word start, then the rest');
  assert.deepEqual(filterPalette(items, 'project account').map((x) => x.id), ['settings']);
  assert.deepEqual(filterPalette(items, 'zzz'), []);
  assert.equal(filterPalette(Array.from({ length: 100 }, (_, i) => ({ label: `x${i}` })), 'x').length, 60);
});
