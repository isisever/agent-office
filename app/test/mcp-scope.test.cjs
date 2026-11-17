// MCP servers for several projects (contract v3.82): src/mcp-servers.js scope as 'all' | id | id[].
const { test } = require('node:test');
const assert = require('node:assert/strict');
const MS = require('../src/mcp-servers.js');

const http = (id, name, scope, extra = {}) => ({ id, name, type: 'http', url: 'https://mcp.example.com/', scope, ...extra });

test('cleanScope: all, one id as a string, two or more as a list; unknown ids dropped', () => {
  const known = new Set(['a', 'b', 'c']);
  assert.equal(MS.cleanScope('all', known), 'all');
  assert.equal(MS.cleanScope('a', known), 'a');
  assert.equal(MS.cleanScope(['a'], known), 'a', 'one id stays a string (the old shape)');
  assert.deepEqual(MS.cleanScope(['a', 'b', 'a', 'zz'], known), ['a', 'b']);
  assert.equal(MS.cleanScope(['zz'], known), null);
  assert.equal(MS.cleanScope([], known), null);
  assert.equal(MS.cleanScope(42, known), null);
});

test('normalizeServers: a list survives; unknown projects leave it; one left is a string', () => {
  const out = MS.normalizeServers([http('s1', 'jira', ['a', 'b']), http('s2', 'wiki', ['a', 'gone'])], ['a', 'b']);
  assert.deepEqual(out.map((s) => s.scope), [['a', 'b'], 'a']);
  // a list meeting an earlier server of the same name is dropped; same name for disjoint projects is fine
  const two = MS.normalizeServers([http('s1', 'jira', ['a', 'b']), http('s2', 'jira', ['b', 'c']), http('s3', 'jira', 'd')], ['a', 'b', 'c', 'd']);
  assert.deepEqual(two.map((s) => s.id), ['s1', 's3']);
  // the old rule for string scopes is unchanged: 'all' and a project may share a name in stored state
  assert.equal(MS.normalizeServers([http('s1', 'x', 'all'), http('s2', 'x', 'a')], ['a']).length, 2);
});

test('serversFor / inScope: a list reaches each of its projects, and only them', () => {
  const servers = [http('s1', 'jira', ['a', 'b']), http('s2', 'notion', 'all'), http('s3', 'one', 'c')];
  assert.deepEqual(MS.serversFor(servers, 'a').map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(MS.serversFor(servers, 'c').map((s) => s.id), ['s3', 's2']);
  assert.equal(MS.inScope(servers[0], 'c'), false);
});

test('validate / addServer: a list of known projects; a name may not reach the same session twice', () => {
  assert.equal(MS.validate({ name: 'jira', url: 'https://x.example.com/', scope: ['a', 'b'] }, ['a', 'b']), null);
  assert.equal(MS.validate({ name: 'jira', url: 'https://x.example.com/', scope: ['a', 'zz'] }, ['a', 'b']), 'scope');
  assert.equal(MS.validate({ name: 'jira', url: 'https://x.example.com/', scope: [] }, ['a']), 'scope');
  const base = [http('s1', 'jira', ['a', 'b'])];
  assert.equal(MS.addServer(base, { name: 'jira', url: 'https://y.example.com/', scope: 'b' }, 's2').error, 'name-used');
  assert.equal(MS.addServer(base, { name: 'jira', url: 'https://y.example.com/', scope: 'c' }, 's2').server.scope, 'c');
  assert.equal(MS.addServer(base, { name: 'wiki', url: 'https://y.example.com/', scope: ['c'] }, 's2').server.scope, 'c', 'a one-id list is stored as a string');
});

test('setScope: changes the project set; clash, unknown project and held servers refused', () => {
  const servers = [http('s1', 'jira', 'a'), http('s2', 'jira', 'c'), http('s3', 'old', 'z', { held: '/w/z' })];
  const r = MS.setScope(servers, 's1', ['a', 'b'], ['a', 'b', 'c']);
  assert.deepEqual(r.server.scope, ['a', 'b']);
  assert.equal(r.before.scope, 'a');
  assert.equal(MS.setScope(servers, 's1', ['a', 'c'], ['a', 'b', 'c']).error, 'name-used');
  assert.equal(MS.setScope(servers, 's1', 'all', ['a', 'b', 'c']).error, 'name-used');
  assert.equal(MS.setScope(servers, 's1', ['a', 'nope'], ['a', 'b', 'c']).error, 'scope');
  assert.equal(MS.setScope(servers, 's3', 'all', ['a']).error, 'unknown');
});

test('dropProject / holdProject: a shared server stays for the others; one for that project alone goes or is held', () => {
  const servers = [http('s1', 'jira', ['a', 'b']), http('s2', 'mine', 'a'), http('s3', 'trio', ['a', 'b', 'c'])];
  const d = MS.dropProject(servers, 'a');
  assert.deepEqual(d.gone, ['s2']);
  assert.deepEqual(d.servers.map((s) => [s.id, s.scope]), [['s1', 'b'], ['s3', ['b', 'c']]]);
  const h = MS.holdProject(servers, 'a', '/w/a');
  assert.deepEqual(h.map((s) => [s.id, s.scope, Boolean(s.held)]), [['s1', 'b', false], ['s2', 'a', true], ['s3', ['b', 'c'], false]]);
});

test('listing: a list shows as "projects" with its count, nothing more', () => {
  const rows = MS.listing({ account: null, home: '/nohome', cwd: null, servers: [http('s1', 'jira', ['a', 'b'])], projectId: 'a', read: () => null });
  const row = rows.find((r) => r.id === 's1');
  assert.equal(row.scope, 'projects');
  assert.equal(row.projects, 2);
  assert.ok(!JSON.stringify(row).includes('mcp.example.com/'), 'no URL path');
});
