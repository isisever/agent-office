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
  w(path.join(home, '.claude.json'), { mcpServers: { gh: { command: 'gh-own' } }, projects: { [cwd]: { mcpServers: { loc: { command: 'l' } }, enabledMcpjsonServers: ['pm'] } } });
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
  const ud = tmp(), home = tmp();
  const store = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe);
  const r = MS.addServer([], { name: 'n', url: 'https://n.io/mcp', type: 'http', scope: 'all' }, 's1');
  assert.ok(store.save(r.server.id, MS.cleanToken(`Bearer ${SECRET}`)));
  // a token smuggled into the state (an old file, a bug) is still never written: the real state.json writer
  const state = { projects: [{ id: 'p1', dir: home }], mcpServers: [{ ...r.server, token: SECRET, headers: { Authorization: SECRET } }] };
  const file = JSON.stringify(P.stateFile({ lastProject: 'x', keep: 1 }, state));
  assert.ok(!file.includes(SECRET) && !file.includes('Authorization') && !file.includes('lastProject') && file.includes('"keep":1'));
  assert.ok(!JSON.stringify(MS.normalizeServers(state.mcpServers, ['p1'])).includes(SECRET));
  // the renderer payloads: mcp:list (MS.listing with the real store) and projects:list (P.forRenderer)
  const payload = JSON.stringify({ servers: MS.listing({ account: {}, home, cwd: home, servers: r.servers, projectId: 'p1', hasToken: (id) => store.has(id) }), projects: P.forRenderer(state.projects) });
  assert.ok(!payload.includes(SECRET) && payload.includes('"hasToken":true'));
  // engines: the function the Claude start uses gives app servers to claude only, and reads no token for the others
  const { cap, ENGINES } = await import('../src/engine-caps.mjs');
  for (const e of ENGINES) {
    let read = 0;
    const cfg = MS.sessionServers(e, r.servers, 'p1', (id) => { read++; return store.load(id); });
    assert.equal(cap(e, 'appMcp').ok, e === 'claude', e);
    if (e === 'claude') assert.equal(cfg.n.headers.Authorization, `Bearer ${SECRET}`);
    else { assert.deepEqual(cfg, {}, e); assert.equal(read, 0, e); assert.deepEqual(cap(e, 'appMcp'), { ok: false, reason: 'claudeOnlyMcp' }); }
  }
  for (const l of ['en', 'tr']) {
    const j = JSON.parse(src(`../locales/${l}.json`));
    assert.ok(j.sidebar.na.claudeOnlyMcp && j.sidebar.mcp && j.sidebar.mcpSrc.app, l);
    assert.ok(!Object.keys(j.sidebar).some((k) => k.startsWith('conn')), l);
  }
  const sb = src('../renderer/sidebar.js');
  assert.match(sb, /cap\(engineOfRow\(p\), 'appMcp'\)/);
  assert.ok(!/p\.mcp\b|openConnectorForm/.test(sb));
});

test('MCP: an unapproved or disabled .mcp.json server shadows nothing (session and panel agree)', () => {
  const home = tmp(), cwd = path.join(home, 'p');
  fs.mkdirSync(cwd, { recursive: true });
  w(path.join(home, '.claude.json'), { projects: { [cwd]: { enabledMcpjsonServers: ['ok', 'off'], disabledMcpjsonServers: ['off'] } } });
  w(path.join(cwd, '.mcp.json'), { mcpServers: { ok: { command: 'a' }, off: { command: 'b' }, raw: { command: 'c' } } });
  const app = { ok: { type: 'http', url: 'https://a' }, off: { type: 'http', url: 'https://b' }, raw: { type: 'http', url: 'https://c' } };
  const r = SC.prepareShared({ account: {}, home, cwd, stageRoot: path.join(home, 'st'), mcpFile: path.join(home, 'ud', 't.json'), app });
  assert.deepEqual(r.appShadowed, ['ok']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'ud', 't.json'), 'utf8')).mcpServers).sort(), ['off', 'raw']);
  const servers = ['ok', 'off', 'raw'].map((n) => ({ id: `s-${n}`, name: n, type: 'http', url: 'https://x.io', scope: 'p1' }));
  const list = MS.listing({ account: {}, home, cwd, servers, projectId: 'p1' }).filter((s) => s.source === 'app');
  assert.deepEqual(list.map((s) => [s.name, Boolean(s.shadowed)]), [['ok', true], ['off', false], ['raw', false]]);
});

test('MCP: agent-office is shadowed only in the boss tab; the panel says so only with manager mode', () => {
  const home = tmp(), cwd = path.join(home, 'p');
  fs.mkdirSync(cwd, { recursive: true });
  const servers = [{ id: 's', name: 'agent-office', type: 'http', url: 'https://x.io', scope: 'all' }];
  const plain = MS.listing({ account: {}, home, cwd, servers, projectId: 'p1', boss: false })[0];
  assert.ok(!plain.shadowed && !plain.bossShadowed);
  const boss = MS.listing({ account: {}, home, cwd, servers, projectId: 'p1', boss: true })[0];
  assert.ok(!boss.shadowed && boss.bossShadowed);
  // the session: only the boss tab has the extra agent-office server, so only there the app one is left out
  const app = MS.appConfigs(servers, 'p1', () => '');
  const prep = (extra, f) => SC.prepareShared({ account: {}, home, cwd, stageRoot: path.join(home, 'st'), mcpFile: path.join(home, f), extra, app });
  assert.deepEqual(prep({ 'agent-office': { command: 'boss' } }, 'b.json').appShadowed, ['agent-office']);
  assert.equal(prep(null, 'o.json').appShadowed, undefined);
});

test('MCP: handoff keeps the servers and tokens here, held for the folder; removing the project drops them', () => {
  const H = require('../src/handoff.js');
  assert.equal(H.refusal({ engine: 'claude', git: true, online: true }), null);
  assert.ok(!src('../src/link-host.js').includes('info.connection'));
  const ud = tmp();
  const store = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe), old = MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe);
  let servers = [{ id: 'own', name: 'flow', type: 'http', url: 'https://f.io', scope: 'p1' }, { id: 'all', name: 'n', type: 'http', url: 'https://n.io', scope: 'all' }];
  store.save('own', SECRET); store.save('all', SECRET);
  // release: handed off, the project leaves the state, its server waits for its folder
  servers = MS.holdProject(servers, 'p1', '/w/proj');
  const reloaded = MS.normalizeServers(JSON.parse(JSON.stringify(P.stateFile({}, { mcpServers: servers }))).mcpServers, ['p2']);
  assert.deepEqual(reloaded.map((s) => [s.id, s.held || null]), [['own', '/w/proj'], ['all', null]]);
  assert.deepEqual(MS.settleTokens(reloaded, old, store), { moved: 0, failed: 0, dropped: 0, removed: 0 }); // the start sweep keeps it
  assert.equal(store.load('own'), SECRET);
  assert.equal(MS.appConfigs(reloaded, 'p2', () => '').flow, undefined); // no other project gets it meanwhile
  // handed back: a project adopted at that folder (a new id) has its server again
  const back = MS.adoptHeld(reloaded, '/w/proj', 'p3');
  assert.deepEqual(MS.serversFor(back, 'p3').map((s) => s.id), ['own', 'all']);
  assert.ok(!back.some((s) => s.held));
  // projects:remove: the project is really gone here; its server and token go, the one for all stays
  const d = MS.dropProject(back, 'p3');
  for (const id of d.gone) store.remove(id);
  assert.deepEqual(d.servers.map((s) => s.id), ['all']); assert.equal(store.has('own'), false); assert.equal(store.has('all'), true);
});

test('MCP: a token move that failed is retried at the next start; orphaned tokens are swept', () => {
  const ud = tmp();
  const old = MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe), good = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe);
  old.save('p1', SECRET); old.save('pbad', 'tok-bad'); old.save('pgone', 'tok-gone');
  const raw = { projects: [{ id: 'p1', dir: '/a', mcp: { label: 'Notion', url: 'https://n.io/mcp' } }, { id: 'pbad', dir: '/b', mcp: { label: 'x', url: 'not a url' } }] };
  // first start: the new store cannot write
  const mig = MS.migrateConnections(raw.projects, raw.mcpServers);
  const servers = MS.normalizeServers(mig.servers, ['p1', 'pbad']);
  const broken = { ...good, save: () => false };
  assert.deepEqual(MS.settleTokens(servers, old, broken), { moved: 0, failed: 1, dropped: 0, removed: 2 }); // pbad (invalid URL), pgone
  assert.equal(old.load('p1'), SECRET); assert.equal(old.has('pbad'), false); assert.equal(old.has('pgone'), false);
  // the state is saved without `mcp` on the project; the next start finds c-p1 without a token and moves it
  const saved = JSON.parse(JSON.stringify(P.stateFile({}, { projects: mig.projects, mcpServers: servers })));
  const again = MS.migrateConnections(saved.projects, saved.mcpServers);
  assert.equal(again.moved.length, 0);
  const s2 = MS.normalizeServers(again.servers, ['p1', 'pbad']);
  good.save('stray', 'tok-stray'); // a server removed by hand from state.json
  assert.deepEqual(MS.settleTokens(s2, old, good), { moved: 1, failed: 0, dropped: 0, removed: 1 });
  assert.equal(good.load('c-p1'), SECRET); assert.equal(old.has('p1'), false); assert.equal(good.has('stray'), false);
  assert.deepEqual(MS.settleTokens(s2, old, good), { moved: 0, failed: 0, dropped: 0, removed: 0 }); // idempotent
});

test('MCP: the add form refuses plain http to another host and keys in the address (en+tr); stored ones still load', () => {
  const v = (url) => MS.validate({ name: 'x', url, scope: 'all' }, []);
  assert.equal(v('https://a.io/mcp'), null);
  for (const u of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://[::1]:8080/mcp']) assert.equal(v(u), null, u);
  assert.equal(v('http://a.io/mcp'), 'url-http');
  assert.equal(v('https://user:pw@a.io/mcp'), 'url-secret');
  assert.equal(v('https://a.io/mcp?key=K'), 'url-secret');
  assert.equal(v('ftp://a.io'), 'url');
  for (const l of ['en', 'tr']) {
    const e = JSON.parse(src(`../locales/${l}.json`)).sidebar;
    assert.ok(e.mcpError.urlHttp && e.mcpError.urlSecret && e.mcpRemoveConfirm.includes('{name}') && e.mcpRemoveFailed && e.mcpBossShadowed, l);
  }
  // a v3.43 connection with such an address is migrated as it was (it worked before); the panel shows its host only
  const mig = MS.migrateConnections([{ id: 'p1', dir: '/a', mcp: { label: 'n', url: 'http://a.io/mcp?key=KEY9' } }], []);
  const servers = MS.normalizeServers(mig.servers, ['p1']);
  assert.equal(servers.length, 1);
  const row = MS.listing({ account: {}, home: tmp(), cwd: null, servers, projectId: 'p1' })[0];
  assert.ok(row.host === 'a.io' && !JSON.stringify(row).includes('KEY9'));
});

test('MCP: a corrupt or missing state.json never sweeps the tokens; state.json is written atomically', () => {
  const SF = require('../src/state-file.js');
  const ud = tmp(), file = path.join(ud, 'state.json');
  const store = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe), old = MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe);
  store.save('m-1', SECRET); old.save('p1', SECRET);
  // the start, as main runs it: settle with sweep only when the state was read whole
  const start = () => {
    const r = SF.readState(file);
    const servers = MS.normalizeServers(MS.migrateConnections(r.raw.projects, r.raw.mcpServers).servers, []);
    return MS.settleTokens(servers, old, store, { sweep: SF.trusted(r, file) });
  };
  assert.deepEqual(start(), { moved: 0, failed: 0, dropped: 0, removed: 0 }); // missing: nothing removed
  fs.writeFileSync(file, '{"mcpServers": [{"id": "m-1", "na'); // a write cut half-way
  assert.deepEqual(SF.readState(file), { raw: {}, ok: false, corrupt: true, unreadable: false });
  assert.deepEqual(start(), { moved: 0, failed: 0, dropped: 0, removed: 0 });
  assert.equal(store.load('m-1'), SECRET); assert.equal(old.load('p1'), SECRET);
  assert.ok(fs.readFileSync(SF.corruptPath(file), 'utf8').startsWith('{"mcpServers"')); // the bad copy is kept
  // the next save replaces the bad file with a state without servers; the copy still blocks the sweep
  SF.writeAtomic(file, JSON.stringify({ projects: [] }));
  assert.equal(SF.readState(file).ok, true);
  assert.deepEqual(start(), { moved: 0, failed: 0, dropped: 0, removed: 0 });
  assert.equal(store.has('m-1'), true);
  fs.writeFileSync(file, 'garbage'); SF.readState(file);
  assert.ok(fs.readFileSync(SF.corruptPath(file), 'utf8').startsWith('{"mcpServers"')); // never overwritten
  // once the copy is dealt with, a whole state sweeps as before
  fs.rmSync(SF.corruptPath(file)); SF.writeAtomic(file, '{}');
  assert.deepEqual(start(), { moved: 0, failed: 0, dropped: 0, removed: 2 });
  // atomic: no temp file left, and a failed write leaves the old file whole
  SF.writeAtomic(file, '{"a":1}');
  assert.deepEqual(fs.readdirSync(ud).filter((f) => f.endsWith('.tmp')), []);
  const failing = { ...fs, renameSync: () => { throw new Error('disk full'); } };
  assert.throws(() => SF.writeAtomic(file, '{"a":2}', failing));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(ud).filter((f) => f.endsWith('.tmp')), []);
  // main reads and writes state.json only through these
  const main = src('../main.js');
  assert.ok(main.includes('SF.readState(statePath())') && main.includes('SF.writeAtomic(statePath()'));
  assert.ok(/settleTokens\(state\.mcpServers, oldTokens\(\), tokens\(\), \{ sweep: SF\.trusted\(read, statePath\(\)\) \}\)/.test(main));
});

test('MCP: held servers are listed as handed off and removable; adding the folder again re-attaches them', () => {
  const home = tmp();
  let servers = [{ id: 'own', name: 'flow', type: 'http', url: 'https://f.io/x', scope: 'p1' }, { id: 'all', name: 'n', type: 'http', url: 'https://n.io', scope: 'all' }];
  servers = MS.normalizeServers(MS.holdProject(servers, 'p1', '/w/proj'), ['p2']);
  const list = MS.listing({ account: {}, home, cwd: null, servers, projectId: 'p2', read: () => null, hasToken: (id) => id === 'own' });
  const away = list.find((s) => s.id === 'own');
  assert.deepEqual(away, { name: 'flow', source: 'app', type: 'http', host: 'f.io', readOnly: false, id: 'own', scope: 'held', away: true, folder: 'proj', hasToken: true });
  assert.equal(list.at(-1).id, 'own'); // last, after the ones the session gets
  assert.ok(!JSON.stringify(list).includes('/w/proj'));
  assert.equal(MS.removeServer(servers, 'own').length, 1); // mcp:remove by id (main also drops the token)
  // the panel labels it (en+tr)
  for (const l of ['en', 'tr']) {
    const j = JSON.parse(src(`../locales/${l}.json`));
    assert.ok(j.sidebar.mcpAway.includes('{folder}') && j.sidebar.mcpAwayHint, l);
  }
  assert.equal(JSON.parse(src('../locales/tr.json')).sidebar.mcpAway.startsWith('devredildi'), true);
  const sb = src('../renderer/sidebar.js');
  assert.ok(sb.includes("t('sidebar.mcpAway'") && sb.includes("s.away ? ' away' : ''"));
  // projects:add / addDir re-attaches the held servers of that folder
  const main = src('../main.js');
  const addDir = main.slice(main.indexOf('function addDir('), main.indexOf("ipcMain.handle('projects:add'"));
  assert.ok(addDir.includes('MS.adoptHeld(r.state.mcpServers || [], r.project.dir, r.project.id)'));
  const back = MS.adoptHeld(servers, '/w/proj', 'p4');
  assert.deepEqual(MS.serversFor(back, 'p4').map((s) => s.id), ['own', 'all']);
});

test('MCP: adopting does not re-scope a held server whose name the project already has; it stays held', () => {
  let servers = [
    { id: 'h1', name: 'flow', type: 'http', url: 'https://f.io', scope: 'p1', held: '/w/proj' },
    { id: 'h2', name: 'docs', type: 'http', url: 'https://d.io', scope: 'p1', held: '/w/proj' },
    { id: 'h3', name: 'docs', type: 'http', url: 'https://d2.io', scope: 'p0', held: '/w/proj' }, // an older handoff of the same folder
    { id: 'mine', name: 'flow', type: 'http', url: 'https://mine.io', scope: 'p5' },
  ];
  servers = MS.adoptHeld(servers, '/w/proj', 'p5');
  assert.deepEqual(servers.map((s) => [s.id, s.scope, s.held || null]), [['h1', 'p1', '/w/proj'], ['h2', 'p5', null], ['h3', 'p0', '/w/proj'], ['mine', 'p5', null]]);
  assert.deepEqual(Object.keys(MS.appConfigs(servers, 'p5', () => '')).sort(), ['docs', 'flow']);
  assert.equal(MS.appConfigs(servers, 'p5', () => '').flow.url, 'https://mine.io');
  // still in the panel as away, so it can be removed
  const list = MS.listing({ account: {}, home: tmp(), cwd: null, servers, projectId: 'p5', read: () => null });
  assert.deepEqual(list.filter((s) => s.away).map((s) => s.id), ['h1', 'h3']);
});

test('MCP: a v3.43 token that does not decrypt now is kept and retried; one stored empty is dropped', () => {
  const ud = tmp();
  const lockedSafe = { ...fakeSafe, decryptString: () => { throw new Error('no key'); } };
  const oldW = MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe);
  oldW.save('p1', SECRET);
  const old = MS.tokenStore(path.join(ud, 'connector-tokens'), lockedSafe), good = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe);
  const servers = [{ id: 'c-p1', name: 'notion', type: 'http', url: 'https://n.io', scope: 'p1' }];
  assert.deepEqual(old.read('p1'), { token: '', failed: true });
  assert.deepEqual(MS.pendingMoves(servers, old, good), [{ from: 'p1', to: 'c-p1' }]);
  assert.deepEqual(MS.settleTokens(servers, old, good, { sweep: false }), { moved: 0, failed: 1, dropped: 0, removed: 0 });
  assert.equal(old.has('p1'), true); assert.equal(good.has('c-p1'), false);
  // with the sweep on too: the file waits for its move, so it is not swept
  assert.deepEqual(MS.settleTokens(servers, old, good), { moved: 0, failed: 1, dropped: 0, removed: 0 });
  assert.equal(old.has('p1'), true);
  // the keychain is open again at a later start: it moves
  const back = MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe);
  assert.deepEqual(MS.settleTokens(servers, back, good), { moved: 1, failed: 0, dropped: 0, removed: 0 });
  assert.equal(good.load('c-p1'), SECRET); assert.equal(back.has('p1'), false);
  const main = src('../main.js').split('\n');
  for (const k of ['could not be moved', 'stored empty']) {
    const line = main.find((l) => l.includes(k));
    assert.ok(line && /\$\{settled\.(failed|dropped)\}/.test(line));
    assert.ok(line.match(/\$\{[^}]*\}/g).every((x) => /^\$\{settled\.(failed|dropped)\}$/.test(x))); // a count, never a token
  }
});

test('MCP: a v3.43 token stored empty is dropped, not retried forever', () => {
  const ud = tmp(), dir = path.join(ud, 'connector-tokens');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'p1.bin'), '');
  const old = MS.tokenStore(dir, fakeSafe), good = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe);
  const servers = [{ id: 'c-p1', name: 'notion', type: 'http', url: 'https://n.io', scope: 'p1' }];
  assert.deepEqual(old.read('p1'), { token: '', failed: false });
  assert.deepEqual(MS.settleTokens(servers, old, good, { sweep: false }), { moved: 0, failed: 0, dropped: 1, removed: 0 });
  assert.equal(old.has('p1'), false);
  assert.deepEqual(MS.pendingMoves(servers, old, good), []); // terminal
});

test('MCP: an empty .bin next to a real .txt still reads the .txt; adding is refused while state.json cannot be saved', () => {
  const ud = tmp(), dir = path.join(ud, 'connector-tokens');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'p1.bin'), ''); fs.writeFileSync(path.join(dir, 'p1.txt'), SECRET);
  assert.deepEqual(MS.tokenStore(dir, fakeSafe).read('p1'), { token: SECRET, failed: false });
  const main = src('../main.js');
  const add = main.slice(main.indexOf("ipcMain.handle('mcp:add'"), main.indexOf("ipcMain.handle('mcp:remove'"));
  assert.ok(add.indexOf("if (!stateWritable) return { ok: false, error: 'state' }") < add.indexOf('tokens().save('));
  for (const l of ['en', 'tr']) assert.ok(JSON.parse(src(`../locales/${l}.json`)).sidebar.mcpError.state);
});

test('MCP: a state.json that is there but cannot be read is not saved over and not swept; crash temps are cleaned', () => {
  const SF = require('../src/state-file.js');
  const ud = tmp(), file = path.join(ud, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: [{ id: 'm-1', name: 'a', type: 'http', url: 'https://a.io', scope: 'all' }] }));
  const store = MS.tokenStore(path.join(ud, 'mcp-tokens'), fakeSafe); store.save('m-1', SECRET);
  for (const code of ['EACCES', 'EBUSY', 'EIO']) {
    const busy = { ...fs, readFileSync: (f, ...a) => { if (f === file) throw Object.assign(new Error(code), { code }); return fs.readFileSync(f, ...a); } };
    const r = SF.readState(file, busy);
    assert.deepEqual(r, { raw: {}, ok: false, corrupt: false, unreadable: true });
    assert.equal(SF.trusted(r, file, busy), false);
    assert.deepEqual(MS.settleTokens([], MS.tokenStore(path.join(ud, 'connector-tokens'), fakeSafe), store, { sweep: SF.trusted(r, file, busy) }).removed, 0);
    assert.equal(fs.existsSync(SF.corruptPath(file)), false);
  }
  assert.equal(store.load('m-1'), SECRET);
  assert.equal(SF.readState(path.join(ud, 'none.json')).unreadable, false); // missing is not unreadable
  // main: an unreadable start turns saving off for the run
  const main = src('../main.js');
  assert.ok(/function saveState\(\) \{\n {2}if \(!stateWritable\) return;/.test(main));
  assert.ok(main.includes('if (read.unreadable) { stateWritable = false;'));
  // temps a crash left: ours (state.json.<pid>.tmp) go, this process's own and anything else stay
  for (const f of ['state.json.123.tmp', 'state.json.9.tmp', `state.json.${process.pid}.tmp`, 'other.json.5.tmp', 'state.json.x.tmp', 'state.jsonX7.tmp']) fs.writeFileSync(path.join(ud, f), '');
  assert.equal(SF.cleanTemps(file), 2);
  assert.deepEqual(fs.readdirSync(ud).filter((f) => f.endsWith('.tmp')).sort(), ['other.json.5.tmp', `state.json.${process.pid}.tmp`, 'state.json.x.tmp', 'state.jsonX7.tmp'].sort());
  assert.ok(main.includes('SF.cleanTemps(statePath())'));
});

test('MCP: the held folder and an added or adopted folder match however each is spelled', () => {
  const root = fs.realpathSync(tmp()), dir = path.join(root, 'proj');
  fs.mkdirSync(dir);
  const link = path.join(root, 'link'); fs.symlinkSync(dir, link);
  const servers = MS.holdProject([{ id: 's1', name: 'flow', type: 'http', url: 'https://f.io', scope: 'p1' }], 'p1', `${dir}/`);
  assert.equal(servers[0].held, dir);
  for (const spelling of [dir, `${dir}/`, `${dir}//`, link, `${root}/x/../proj`]) {
    assert.equal(MS.serversFor(MS.adoptHeld(servers, spelling, 'p2'), 'p2').length, 1, spelling);
  }
  assert.equal(MS.serversFor(MS.adoptHeld(servers, path.join(root, 'other'), 'p2'), 'p2').length, 0);
  // a held value saved by an older build with a trailing slash still matches
  assert.equal(MS.serversFor(MS.adoptHeld([{ ...servers[0], held: `${dir}/` }], dir, 'p2'), 'p2').length, 1);
  // a folder gone (handed off and moved away) still compares by its resolved spelling
  assert.equal(MS.dirKey('/nope/a/b/'), path.resolve('/nope/a/b'));
});
