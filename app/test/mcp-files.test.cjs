// Edit an MCP server in Claude Code's own files (contract v3.69): node --test app/test/mcp-files.test.cjs. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MF = require('../src/mcp-files.js');
const MS = require('../src/mcp-servers.js');

const SECRET = 'sk-test-SECRET-123';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mcpf-'));
const w = (f, o, indent = 2) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, indent) + '\n'); };
const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('MCP files: the form gets names, transport, address and args; never a header or env value or a keyed address', () => {
  const r = MF.editable('odoo', { type: 'http', url: 'https://erp.example/mcp', headers: { Authorization: `Bearer ${SECRET}`, 'X-Db': 'prod' } });
  assert.deepEqual(r, { name: 'odoo', type: 'http', url: 'https://erp.example/mcp', headers: { Authorization: MF.MASK, 'X-Db': MF.MASK } });
  const k = MF.editable('old', { url: `https://x.example/mcp?key=${SECRET}` });
  assert.equal(k.url, '');
  assert.equal(k.urlHidden, true);
  for (const u of ['https://h/abc123def456ghi789jkl0/sse', 'https://h/01234567-89ab-cdef-0123-456789abcdef/sse']) {
    const pe = MF.editable('p', { url: u });
    assert.equal(pe.url, '');
    assert.equal(pe.urlHidden, true);
    assert.ok(!JSON.stringify(pe).includes('abc123def') && !JSON.stringify(pe).includes('89ab-cdef'));
  }
  for (const u of ['https://h/sse', 'https://h/mcp', 'https://h/v1/messages', 'https://h/api/mcp', 'https://host']) {
    const pe = MF.editable('p', { url: u });
    assert.equal(pe.url, u);
    assert.ok(!pe.urlHidden, u);
  }
  const s = MF.editable('files', { command: 'npx', args: ['-y', 'srv'], env: { API_KEY: SECRET } });
  assert.deepEqual(s, { name: 'files', type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { API_KEY: MF.MASK } });
  assert.ok(!JSON.stringify([r, k, s]).includes(SECRET));
});

test('MCP files: an edit keeps masked values, other fields and key order; renames in place; validates', () => {
  const cfg = { mcpServers: {
    a: { type: 'http', url: 'https://a.example/mcp', headers: { Authorization: `Bearer ${SECRET}` }, timeout: 5 },
    b: { command: 'npx', args: ['x'], env: { KEY: SECRET, PATHY: '/p' } },
    c: { type: 'sse', url: 'https://c.example/sse' },
  }, other: 1 };
  const before = JSON.stringify(cfg);
  let r = MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'a2', type: 'sse', url: '', headers: { Authorization: MF.MASK, 'X-New': 'v' } });
  assert.equal(JSON.stringify(cfg), before); // the input is not changed
  assert.deepEqual(Object.keys(r.config.mcpServers), ['a2', 'b', 'c']);
  assert.deepEqual(r.config.mcpServers.a2, { type: 'sse', url: 'https://a.example/mcp', headers: { Authorization: `Bearer ${SECRET}`, 'X-New': 'v' }, timeout: 5 });
  assert.equal(r.config.other, 1);
  // a header left out is removed; a new address is checked like the add form
  r = MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'a', type: 'http', url: 'https://a.example/v2', headers: {} });
  assert.deepEqual(r.config.mcpServers.a, { type: 'http', url: 'https://a.example/v2', timeout: 5 });
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'a', type: 'http', url: 'http://a.example/' }).error, 'url-http');
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'a', type: 'http', url: 'https://a.example/?k=1' }).error, 'url-secret');
  // stdio: masked env kept, a changed one replaced, no type added where Claude Code had none
  r = MF.applyEdit(cfg, ['mcpServers'], 'b', { name: 'b', type: 'stdio', command: 'uvx', args: ['y', ' '], env: { KEY: MF.MASK, PATHY: '/q' } });
  assert.deepEqual(r.config.mcpServers.b, { command: 'uvx', args: ['y'], env: { KEY: SECRET, PATHY: '/q' } });
  // transport change drops the old transport's fields
  r = MF.applyEdit(cfg, ['mcpServers'], 'c', { name: 'c', type: 'stdio', command: 'node', args: ['s.js'] });
  assert.deepEqual(r.config.mcpServers.c, { type: 'stdio', command: 'node', args: ['s.js'] });
  r = MF.applyEdit(cfg, ['mcpServers'], 'b', { name: 'b', type: 'http', url: 'https://b.example/mcp' });
  assert.deepEqual(r.config.mcpServers.b, { type: 'http', url: 'https://b.example/mcp' });
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'b', { name: 'b', type: 'http', url: '' }).error, 'url');
  // errors
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'zz', { name: 'zz', type: 'stdio', command: 'x' }).error, 'unknown');
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'c', type: 'http', url: '' }).error, 'name-used');
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'bad name', type: 'http', url: '' }).error, 'name');
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'b', { name: 'b', type: 'stdio', command: ' ' }).error, 'command');
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'b', { name: 'b', type: 'stdio', command: 'x', env: { '1A': 'v' } }).error, 'env');
  assert.equal(MF.applyEdit(cfg, ['mcpServers'], 'a', { name: 'a', type: 'http', url: '', headers: { 'Bad Name': 'v' } }).error, 'header');
});

test('MCP files: targets per source; the file is rewritten atomically with its indent, mode and other keys', () => {
  const home = tmp(), cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  assert.deepEqual(MF.target({ where: 'user', account: {}, home, cwd }), { file: path.join(home, '.claude.json'), keys: ['mcpServers'] });
  assert.deepEqual(MF.target({ where: 'local', account: { configDir: '/acc' }, home, cwd }), { file: path.join('/acc', '.claude.json'), keys: ['projects', cwd, 'mcpServers'] });
  assert.deepEqual(MF.target({ where: 'default-local', account: { configDir: '/acc' }, home, cwd }), { file: path.join(home, '.claude.json'), keys: ['projects', cwd, 'mcpServers'] });
  assert.deepEqual(MF.target({ where: 'project', account: {}, home, cwd }), { file: path.join(cwd, '.mcp.json'), keys: ['mcpServers'] });
  assert.equal(MF.target({ where: 'project', account: {}, home, cwd: null }), null);
  assert.equal(MF.target({ where: 'office', account: {}, home, cwd }), null);
  const file = path.join(home, '.claude.json');
  w(file, { numStartups: 3, projects: { [cwd]: { mcpServers: { loc: { command: 'a' } }, history: [1] } } }, 4);
  fs.chmodSync(file, 0o644);
  const tg = MF.target({ where: 'local', account: {}, home, cwd });
  assert.deepEqual(MF.editFile(tg.file, tg.keys, 'loc', { name: 'loc', type: 'stdio', command: 'b' }), { ok: true, name: 'loc' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\n {4}"numStartups"/);
  assert.ok(text.endsWith('\n'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(rd(file), { numStartups: 3, projects: { [cwd]: { mcpServers: { loc: { command: 'b' } }, history: [1] } } });
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.includes('.tmp')), []);
  // a bad file or a missing one is not touched
  fs.writeFileSync(path.join(cwd, '.mcp.json'), '{ broken');
  assert.deepEqual(MF.editFile(path.join(cwd, '.mcp.json'), ['mcpServers'], 'x', { name: 'x', type: 'stdio', command: 'y' }), { ok: false, error: 'read' });
  assert.equal(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'), '{ broken');
  assert.equal(MF.editFile(path.join(home, 'none.json'), ['mcpServers'], 'x', {}).error, 'read');
});

test('MCP files: the panel marks which file each row lives in, and another project\'s row with its folder', () => {
  const home = tmp(), cwd = path.join(home, 'proj'), other = path.join(home, 'other');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  w(path.join(home, '.claude.json'), { mcpServers: { u: { command: 'u' } }, projects: { [cwd]: { mcpServers: { l: { command: 'l' } } }, [other]: { mcpServers: { o: { command: 'o' } } } } });
  w(path.join(cwd, '.mcp.json'), { mcpServers: { pr: { command: 'p' } } });
  const office = { share: true, current: cwd, projects: [{ name: 'proj', dir: cwd, configDir: null }, { name: 'other', dir: other, configDir: null }] };
  const rows = MS.listing({ account: {}, home, cwd, office, projectId: 'p1' });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.u.where, 'user');
  assert.equal(by.l.where, 'local');
  assert.equal(by.pr.where, 'project');
  assert.equal(by.o.source, 'office');
  assert.equal(by.o.where, undefined);
  assert.equal(by.o.origin, other);
  // main turns origin into the project id and resolves the file there; the IPC handlers exist
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('mcp:getFile'/);
  assert.match(main, /ipcMain\.handle\('mcp:updateFile'/);
  assert.match(main, /originId: from\.id/);
});
