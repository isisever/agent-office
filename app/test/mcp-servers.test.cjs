// One MCP system (contract v3.44): node --test app/test/mcp-servers.test.cjs. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MS = require('../src/mcp-servers.js');
const SC = require('../src/shared-config.js');
const P = require('../src/projects.js');

const SECRET = 'sk-test-SECRET-123';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mcp-'));
const w = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() };
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('MCP: the list shows every source with name, type and host only; never a URL path, header, env or token', () => {
  const home = tmp(), cwd = path.join(home, 'proj'), other = path.join(home, 'other');
  fs.mkdirSync(cwd, { recursive: true });
  w(path.join(home, '.claude.json'), {
    mcpServers: { gh: { type: 'http', url: 'https://api.example.com/s/KEY123/mcp', headers: { Authorization: `Bearer ${SECRET}` } } },
    projects: { [cwd]: { mcpServers: { loc: { command: 'node', args: ['x.js'], env: { TOKEN: SECRET } } }, enabledMcpjsonServers: ['pm'] } },
  });
  w(path.join(cwd, '.mcp.json'), { mcpServers: { pm: { type: 'sse', url: 'https://pm.example.org/sse?key=KEY123' }, raw: { command: 'evil' } } });
  w(path.join(other, '.mcp.json'), { mcpServers: { o: { command: 'uvx', args: ['o'] } } });
  w(path.join(home, '.claude', 'settings.json'), { enabledMcpjsonServers: ['o'] });
  const servers = MS.normalizeServers([
    { id: 'a1', name: 'Notion', url: 'https://mcp.notion.com/mcp/KEY123', scope: 'all', token: SECRET },
    { id: 'a2', name: 'gh', url: 'https://x.io/mcp', scope: 'p1' },
  ], ['p1']);
  const office = { share: true, current: cwd, projects: [{ name: 'proj', dir: cwd, configDir: null }, { name: 'other', dir: other, configDir: null }] };
  const list = MS.listing({ account: {}, home, cwd, office, servers, projectId: 'p1', hasToken: (id) => id === 'a1' });
  const by = Object.fromEntries(list.map((s) => [`${s.source}:${s.name}`, s]));
  assert.equal(by['user:gh'].type, 'http'); assert.equal(by['user:gh'].host, 'api.example.com'); assert.ok(by['user:gh'].readOnly);
  assert.equal(by['local:loc'].type, 'stdio');
  assert.equal(by['project:pm'].type, 'sse'); assert.equal(by['project:pm'].approved, true);
  assert.equal(by['project:raw'].approved, false);
  assert.equal(by['office:o'].type, 'stdio');
  assert.equal(by['app:notion'].scope, 'all'); assert.equal(by['app:notion'].hasToken, true); assert.equal(by['app:notion'].readOnly, false);
  assert.equal(by['app:gh'].shadowed, true); // the user's own gh wins
  const json = JSON.stringify(list);
  for (const bad of [SECRET, 'KEY123', 'Authorization', '/mcp', 'x.js']) assert.ok(!json.includes(bad), bad);
});

test('MCP: account sources — another account\'s own servers are "account", Default\'s shared ones keep user/local', () => {
  const home = tmp(), acc = path.join(home, 'acc'), cwd = path.join(home, 'p');
  fs.mkdirSync(cwd, { recursive: true });
  w(path.join(home, '.claude.json'), { mcpServers: { du: { type: 'http', url: 'https://d.io' } }, projects: { [cwd]: { mcpServers: { dl: { command: 'x' } } } } });
  w(path.join(acc, '.claude.json'), { mcpServers: { au: { command: 'y' } } });
  const list = MS.listing({ account: { configDir: acc }, home, cwd, servers: [], projectId: 'p1' });
  const src = Object.fromEntries(list.map((s) => [s.name, s.source]));
  assert.deepEqual(src, { au: 'account', du: 'user', dl: 'local' });
});

test('MCP: scopes — a server for all projects reaches every project, one for a project only it; names clash per reach', () => {
  let servers = [];
  let r = MS.addServer(servers, { name: 'Notion', url: 'https://n.io/mcp', type: 'http', scope: 'all' }, 's1'); servers = r.servers;
  r = MS.addServer(servers, { name: 'flow', url: 'https://f.io/mcp', type: 'sse', scope: 'p1' }, 's2'); servers = r.servers;
  assert.equal(MS.addServer(servers, { name: 'notion', url: 'https://z.io', scope: 'p2' }, 's3').error, 'name-used');
  assert.ok(MS.addServer(servers, { name: 'flow', url: 'https://z.io', scope: 'p2' }, 's3').servers); // other project: fine
  assert.deepEqual(MS.serversFor(servers, 'p1').map((s) => s.id), ['s2', 's1']);
  assert.deepEqual(MS.serversFor(servers, 'p2').map((s) => s.id), ['s1']);
  assert.equal(MS.validate({ name: 'x', url: 'ftp://a', scope: 'all' }, []), 'url');
  assert.equal(MS.validate({ name: '!!', url: 'https://a', scope: 'all' }, []), 'name');
  assert.equal(MS.validate({ name: 'x', url: 'https://a', scope: 'p9' }, ['p1']), 'scope');
  assert.equal(MS.validate({ name: 'x', url: 'https://a', scope: 'p1', type: 'stdio' }, ['p1']), 'type');
  assert.equal(MS.serverName('Kişisel Notlar'), 'kisisel-notlar');
  assert.equal(MS.cleanToken(`Bearer ${SECRET}`), SECRET);
  const cfg = MS.appConfigs(servers, 'p1', (id) => (id === 's1' ? SECRET : ''));
  assert.deepEqual(cfg.notion, { type: 'http', url: 'https://n.io/mcp', headers: { Authorization: `Bearer ${SECRET}` } });
  assert.deepEqual(cfg.flow, { type: 'sse', url: 'https://f.io/mcp' });
  const d = MS.dropProject(servers, 'p1');
  assert.deepEqual(d.gone, ['s2']); assert.deepEqual(d.servers.map((s) => s.id), ['s1']);
  assert.equal(MS.normalizeServers(servers, ['p2']).length, 1); // a server of a project that is gone is dropped
});

test('MCP: precedence — Claude Code\'s own servers and the boss server win by name; app servers land in the 0600 tab file', () => {
  const home = tmp(), cwd = path.join(home, 'p');
  fs.mkdirSync(cwd, { recursive: true });
  w(path.join(home, '.claude.json'), { mcpServers: { gh: { command: 'gh-own' } }, projects: { [cwd]: { mcpServers: { loc: { command: 'l' } } } } });
  w(path.join(cwd, '.mcp.json'), { mcpServers: { pm: { command: 'pm' } } });
  const mcpFile = path.join(home, 'ud', 'mcp', 't.json');
  const app = { gh: { type: 'http', url: 'https://a' }, loc: { type: 'http', url: 'https://b' }, pm: { type: 'http', url: 'https://c' }, 'agent-office': { type: 'http', url: 'https://d' }, notion: { type: 'http', url: 'https://n', headers: { Authorization: `Bearer ${SECRET}` } } };
  const r = SC.prepareShared({ account: {}, home, cwd, stageRoot: path.join(home, 'st'), mcpFile, extra: { 'agent-office': { command: 'boss' } }, app });
  assert.deepEqual(r.appShadowed.sort(), ['agent-office', 'gh', 'loc', 'pm']);
  const file = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(file).sort(), ['agent-office', 'notion']);
  assert.equal(file['agent-office'].command, 'boss');
  if (process.platform !== 'win32') assert.equal(fs.statSync(mcpFile).mode & 0o777, 0o600);
  // Claude Code's files are only read
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')), { mcpServers: { pm: { command: 'pm' } } });
  // main: the tab file goes when its claude ends; app servers only on the Claude path
  const main = src('../main.js');
  assert.match(main, /const appMcp = MS\.appConfigs\(appServers\(\), project\.id, \(sid\) => tokens\(\)\.load\(sid\)\);\n\s*const prepared = sharedConfig\(account, project, cwd, usageKey\(id\), bossMcp, appMcp\);/);
  assert.equal((main.match(/MS\.appConfigs\(/g) || []).length, 1);
  for (const fn of ['function startAgy', 'function startCommandCode', 'function startOpenCode']) {
    const i = main.indexOf(fn); const body = main.slice(i, main.indexOf('\nfunction ', i + 10));
    assert.ok(i > 0 && !/appServers|tokens\(\)/.test(body), fn);
  }
});

test('MCP: migration — a v3.43 connection stays a normal project, its server is scoped to it and its token moves', () => {
  const ud = tmp();
  const oldS = MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe), newS = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe);
  assert.ok(oldS.save('p1', SECRET));
  const raw = { projects: [{ id: 'p1', dir: '/c/notion', mcp: { label: 'My Notion', url: 'https://mcp.notion.com/mcp' } }, { id: 'p2', dir: '/c/plain' }] };
  const mig = MS.migrateConnections(raw.projects, raw.mcpServers);
  const st = P.normalizeState({ ...raw, projects: mig.projects });
  assert.deepEqual(st.projects.map((p) => [p.id, p.dir, 'mcp' in p]), [['p1', '/c/notion', false], ['p2', '/c/plain', false]]);
  const servers = MS.normalizeServers(mig.servers, st.projects.map((p) => p.id));
  assert.deepEqual(servers, [{ id: 'c-p1', name: 'my-notion', type: 'http', url: 'https://mcp.notion.com/mcp', scope: 'p1' }]);
  for (const m of mig.moved) assert.ok(MS.moveToken(oldS, newS, m.from, m.to));
  assert.equal(newS.load('c-p1'), SECRET); assert.equal(oldS.has('p1'), false);
  // nothing lost when the new store cannot write: the old token stays
  assert.ok(oldS.save('p9', SECRET));
  const broken = { ...newS, save: () => false };
  assert.equal(MS.moveToken(oldS, broken, 'p9', 'c-p9'), false); assert.equal(oldS.load('p9'), SECRET);
  // idempotent: run again on the migrated state
  const again = MS.migrateConnections(st.projects, servers);
  assert.equal(again.moved.length, 0); assert.equal(again.servers.length, 1);
  // the token file is encrypted, never plain
  assert.ok(!fs.readFileSync(path.join(ud, 'mcp-tokens', 'c-p1.bin'), 'utf8').includes(SECRET));
});

test('MCP: the token is never in state.json or the renderer payload; Claude Code only (engine caps, en+tr)', async () => {
  const servers = MS.normalizeServers([{ id: 's', name: 'n', url: 'https://n.io', scope: 'all', token: SECRET, headers: { Authorization: SECRET } }], []);
  assert.ok(!JSON.stringify(servers).includes(SECRET));
  const main = src('../main.js');
  assert.match(main, /commit\(\{ \.\.\.state, mcpServers: r\.servers \}\)/);
  assert.ok(!/mcpServers: [^\n]*token/.test(main));
  assert.ok(!/connectors:|connection: Boolean|engineRefused/.test(main));
  const { cap, ENGINES } = await import('../src/engine-caps.mjs');
  assert.equal(cap('claude', 'appMcp').ok, true);
  for (const e of ENGINES.filter((x) => x !== 'claude')) assert.deepEqual(cap(e, 'appMcp'), { ok: false, reason: 'claudeOnlyMcp' });
  for (const l of ['en', 'tr']) {
    const j = JSON.parse(src(`../locales/${l}.json`));
    assert.ok(j.sidebar.na.claudeOnlyMcp && j.sidebar.mcp && j.sidebar.mcpSrc.app, l);
    assert.ok(!Object.keys(j.sidebar).some((k) => k.startsWith('conn')), l);
  }
  const sb = src('../renderer/sidebar.js');
  assert.match(sb, /cap\(engineOfRow\(p\), 'appMcp'\)/);
  assert.ok(!/p\.mcp\b|openConnectorForm/.test(sb));
});

test('MCP: handoff — no "connection" refusal any more; a leaving project takes its servers\' tokens with it (deleted here)', () => {
  const H = require('../src/handoff.js');
  assert.equal(H.refusal({ engine: 'claude', git: true, online: true }), null);
  const main = src('../main.js');
  assert.match(main, /release\(projectId\) \{[\s\S]{0,400}dropProjectServers\(p\.id\)/);
  assert.match(main, /'projects:remove'[\s\S]{0,300}dropProjectServers\(p\.id\)/);
  assert.ok(!src('../src/link-host.js').includes('info.connection'));
});
