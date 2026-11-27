'use strict';
// Lean MCP per session (contract v3.128): the default, the dedupe and the effective server list per session kind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LEAN = require('../src/mcp-lean.js');
const SC = require('../src/shared-config.js');
const P = require('../src/projects.js');

const odoo = (key) => ({ type: 'http', url: 'https://erp.example/mcp', headers: { Authorization: `Bearer ${key}` } });
const bot = (n) => ({ type: 'http', url: `https://bots.example/${n}` });

test('the office share is off by default; the global setting or the project opt-in turns it on', () => {
  assert.equal(LEAN.officeShareOn({}), false);
  assert.equal(LEAN.officeShareOn({ global: undefined, project: { id: 'p' } }), false);
  assert.equal(LEAN.officeShareOn({ global: true, project: { id: 'p' } }), true);
  assert.equal(LEAN.officeShareOn({ global: false, project: { id: 'p', shareMcp: true } }), true);
  assert.equal(LEAN.officeShareOn({ global: true, project: {}, desk: true }), false, 'never a desk');
  assert.equal(LEAN.officeShareOn({ global: true, project: { shareMcp: true }, hq: true }), false, 'never HQ');
});

test('state.json: absent or the old auto-written true is off; only an explicit choice keeps it on', () => {
  assert.equal(LEAN.shareMcpFromFile({}), false);
  assert.equal(LEAN.shareMcpFromFile({ shareMcp: true }), false, 'pre-v3.128 files wrote true for everyone');
  assert.equal(LEAN.shareMcpFromFile({ shareMcp: true, shareMcpChosen: true }), true);
  assert.equal(LEAN.shareMcpFromFile({ shareMcp: false, shareMcpChosen: true }), false);
  assert.equal(LEAN.shareMcpFromFile(null), false);
});

test('dedupe: same URL and headers is passed once; different headers or args stay', () => {
  const r = LEAN.dedupeServers({ a: odoo('k1'), b: { headers: { Authorization: 'Bearer k1' }, url: 'https://erp.example/mcp', type: 'http' }, c: odoo('k2'), d: { command: 'x', args: ['1'] }, e: { command: 'x', args: ['2'] } });
  assert.deepEqual(Object.keys(r.servers), ['a', 'c', 'd', 'e']);
  assert.deepEqual(r.dropped, ['b']);
  const k = LEAN.dedupeServers({ a: bot(1), b: bot(2) }, { keep: { own: bot(1) } });
  assert.deepEqual(Object.keys(k.servers), ['b']);
});

test('boss: shared minus duplicates of what it has, plus extra and app servers (never dropped by dedupe)', () => {
  const r = LEAN.sessionMcp({
    kind: 'boss',
    shared: { 'odoo-erp-NodesyAI': odoo('k1'), 'nodesyai-a': bot('a'), 'thinkone-copy': odoo('k2') },
    own: { 'odoo-erp': odoo('k1') },
    app: { 'odoo-erp-thinkone': odoo('k2'), 'odoo-erp': bot('z') },
    extra: { 'agent-office': { command: 'node', args: ['office.js'] } },
  });
  assert.deepEqual(Object.keys(r.servers).sort(), ['agent-office', 'nodesyai-a', 'odoo-erp-thinkone']);
  assert.deepEqual(r.dropped.sort(), ['odoo-erp-NodesyAI', 'thinkone-copy']);
  assert.deepEqual(r.shadowed, ['odoo-erp'], 'an app server whose name the account already has stays shadowed');
  assert.equal(r.strict, false);
});

test('desk: only the project\'s own servers, member tools and extra; strict; never the shared set', () => {
  const r = LEAN.sessionMcp({ kind: 'desk', shared: { 'nodesyai-a': bot('a') }, own: { local: bot('l') }, app: { tool: bot('t') }, extra: { mail: bot('m') } });
  assert.deepEqual(Object.keys(r.servers).sort(), ['local', 'mail', 'tool']);
  assert.equal(r.strict, true);
  const app = LEAN.deskAppServers([{ id: 'g', scope: 'all' }, { id: 't', scope: 'all' }, { id: 'p', scope: ['p1'] }], ['t']);
  assert.deepEqual(app.map((s) => s.id), ['t', 'p'], 'an every-project server only when it is a member tool');
});

test('hq: only the agent-office server, strict', () => {
  const r = LEAN.sessionMcp({ kind: 'hq', shared: { a: bot('a') }, own: { b: bot('b') }, app: { c: bot('c') }, extra: { 'agent-office': bot('o') } });
  assert.deepEqual(Object.keys(r.servers), ['agent-office']);
  assert.equal(r.strict, true);
});

test('prepareShared: a desk file holds the project servers and runs strict; a boss gets the dedupe', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-'));
  const proj = path.join(home, 'proj');
  const other = path.join(home, 'other');
  fs.mkdirSync(proj); fs.mkdirSync(other);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'odoo-erp': odoo('k1') },
    projects: { [proj]: { mcpServers: { mine: bot('mine') } }, [other]: { mcpServers: { 'odoo-copy': odoo('k1'), theirs: bot('theirs') } } },
  }));
  const office = { share: true, current: proj, projects: [{ name: 'proj', dir: proj, configDir: null, share: true }, { name: 'other', dir: other, configDir: null, share: true }], accounts: [] };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers;
  const boss = SC.prepareShared({ account: { id: 'default', configDir: null }, home, cwd: proj, stageRoot: path.join(home, 'st'), mcpFile: path.join(home, 'mcp', 'boss.json'), office });
  assert.deepEqual(Object.keys(read(boss.mcpConfig)).sort(), ['theirs'], 'the copy of a server it has is left out');
  // an app server attached to the project wins over a shared copy of the same server
  const withApp = SC.prepareShared({ account: { id: 'default', configDir: null }, home, cwd: proj, stageRoot: path.join(home, 'st'), mcpFile: path.join(home, 'mcp', 'app.json'), office, app: { 'theirs-app': bot('theirs') } });
  assert.deepEqual(Object.keys(read(withApp.mcpConfig)).sort(), ['theirs-app']);
  assert.deepEqual(withApp.mcpDeduped, ['theirs']);
  assert.equal(boss.strict, undefined);
  const desk = SC.prepareShared({ account: { id: 'default', configDir: null }, home, cwd: path.join(home, 'wt'), stageRoot: path.join(home, 'st'), mcpFile: path.join(home, 'mcp', 'desk.json'), office, desk: true, ownDir: proj, extra: { mail: bot('m') } });
  assert.deepEqual(Object.keys(read(desk.mcpConfig)).sort(), ['mail', 'mine']);
  assert.equal(desk.strict, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a project opt-in is kept only when on', () => {
  const state = { projects: [{ id: 'p', name: 'p', dir: '/x' }] };
  const on = P.setProjectShareMcp(state, 'p', true);
  assert.equal(on.projects[0].shareMcp, true);
  const off = P.setProjectShareMcp(on, 'p', false);
  assert.equal('shareMcp' in off.projects[0], false);
  assert.equal(P.setProjectShareMcp(off, 'p', false), off);
});
