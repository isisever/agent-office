// HQ / Müdür (contract v3.46): node --test app/test/hq.test.cjs. Temp dirs only; nothing under the real ~/.claude.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const HQ = require('../src/hq.js');
const HO = require('../src/hq-order.js');
// v3.130 a typed id is an order until it is closed. These tests cover the follow-up rules after an order is closed
// (today's v3.91/v3.103 rules): the minter closes every order it mints.
const legacyMinter = (o) => { const m = HQ.createMinter(o); const mint = m.mint; m.mint = (a) => { const id = mint(a); m.closeOrder(id); return id; }; return m; };
const P = require('../src/projects.js');
const OM = require('../src/office-mcp.js');
const LH = require('../src/link-host.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const fnBody = (name) => { const i = MAIN.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return MAIN.slice(i, MAIN.indexOf('\n}\n', i)); };

test('seam: resolvePty("hq") gives the frozen HQ project, never one of state.projects', () => {
  const s = P.normalizeState({ projects: [{ id: 'aaaaaaaaaaaa', dir: '/x/a' }], hq: { accountId: 'work', dispatchWithoutAsking: 'yes' } });
  assert.deepEqual(s.hq, { accountId: 'work', enabled: true });   // v3.103 the old setting is dropped when read
  P.setHqDir('');
  assert.equal(P.resolvePty(s, 'hq'), null);   // before main set the folder
  P.setHqDir('/ud/hq');
  const r = P.resolvePty(s, 'hq');
  assert.equal(r.project.id, 'hq');
  assert.equal(r.dir, '/ud/hq');
  assert.equal(r.project.engine, 'claude');
  assert.equal(r.project.accountId, 'work');
  assert.ok(Object.isFrozen(r.project));

  assert.ok(!P.findProject(s, 'hq'));
  assert.ok(!s.projects.some((p) => p.id === 'hq'));
  assert.equal(P.setActive(s, 'hq'), s);   // window-only selection
  assert.equal(P.setActive(s, `${'a'.repeat(64)}:abc123`), s);
  assert.equal(P.managerOf(s, r.project), true);
  P.setHqDir('');
});

test('findProject callers and state.projects loops treat hq explicitly', () => {
  assert.match(fnBody('projectOp'), /P\.isHqId\(projectId\)\) return \{ ok: false, reason: 'unknown-project' \}/);
  assert.match(fnBody('bossSid'), /P\.resolvePty\(state, tab\)\?\.project/);
  assert.match(fnBody('lockedNotice'), /P\.resolvePty\(state, id\)\?\.project/);
  assert.doesNotMatch(fnBody('onOfficeReport'), /P\.findProject/);
  assert.match(fnBody('sleepIdle'), /if \(r\.project\.hq\) continue/);
  // the link snapshot, catalog and handoff iterate state.projects, which never holds hq
  assert.doesNotMatch(MAIN, /state\.projects\.(push|concat)\([^)]*hq/i);
  assert.match(fnBody('officeServerFor'), /project\.hq\) && id === HQ\.HQ_ID/);
});

test('launch args: strict MCP (agent-office only), --tools Read allowlist, no user settings, all office tools auto-allowed', () => {
  const a = HQ.launchArgs({ dir: '/ud/hq', mcpConfig: '/m/hq.json' });
  assert.deepEqual(a, [
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '/m/hq.json', '--permission-mode', 'default', '--tools', 'Read',
    '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Glob,Grep,Task,Agent,Skill,mcp__agent-office__office_project',
    '--allowedTools', 'Read(//ud/hq/**),mcp__agent-office__office_machines,mcp__agent-office__office_reports,mcp__agent-office__office_board,mcp__agent-office__office_summary,mcp__agent-office__office_dispatch,mcp__agent-office__office_task',   // office_task: v3.87
  ]);
  assert.ok(!HQ.launchArgs({ dir: '/ud/hq' }).includes('--mcp-config'));
  // the MCP file holds only agent-office, 0600
  const d = tmp('hq-mcp-');
  const f = HQ.writeMcpFile(path.join(d, 'x', 'hq.json'), { 'agent-office': { command: 'node' }, github: { headers: { Authorization: 'x' } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mcpServers: { 'agent-office': { command: 'node' } } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(HQ.writeMcpFile(path.join(d, 'y.json'), { github: {} }), null);
  // startPty: HQ skips the shared config, app servers and skill packs; only the Agent Office plugin dir
  const sp = fnBody('startPty');
  assert.match(sp, /project\.hq \? null : MS\.sessionServers/);
  assert.match(sp, /project\.hq \? hqMcpConfig\(usageKey\(id\), bossMcp\) : sharedConfig\(/);
  assert.match(sp, /const shared = project\.hq \? \[\] : SC\.sharedArgs/);
  assert.match(sp, /const packs = project\.hq \? \[\] : SP\.sessionPacks/);
  assert.match(sp, /HQ\.launchArgs\(\{ dir: cwd, mcpConfig: prepared\.mcpConfig/);
  assert.match(MAIN, /if \(project\.hq\) env\.AGENT_OFFICE_HQ = '1'/);
});

test('redaction runs before every dispatch', () => {
  const r = HQ.redact('deploy with token=abcd1234efgh and Bearer abcdefghijkl and https://u:pw@host/x and sk-ant-0123456789abc');
  assert.doesNotMatch(r, /abcd1234efgh|abcdefghijkl|u:pw@|sk-ant-0123456789abc/);
  assert.match(fnBody('officeDispatch'), /const task = HQ\.redact\(/);
  assert.match(fnBody('hqDispatch'), /const task = HQ\.redact\(/);
});

test('consent matrix: the app is the only gate; no dialog by default for the live minted id, a dialog only with askBeforeDispatch or adhoc', () => {
  let t = 1000;
  const m = legacyMinter({ now: () => t, rand: () => 'x' });
  const id = m.mint();
  for (const [ask, remote, request, want] of [
    [false, false, id, 'none'], [false, true, id, 'none'], [true, true, id, 'app'], [true, false, id, 'app'],   // v3.101 a paired machine follows the same rule
    [false, false, 'rforged', 'app'], [false, false, '', 'app'], [false, false, HQ.ADHOC, 'app'],
  ]) assert.equal(HQ.consentFor({ ask, remote, request, minter: m, now: t }), want, `${ask} ${remote} ${request}`);
  m.clear();   // an inbox row (report-ready / request-done) is a turn the person did not type
  assert.equal(HQ.consentFor({ remote: false, request: id, minter: m, now: t }), 'follow');
  assert.equal(HQ.consentFor({ ask: true, remote: false, request: id, minter: m, now: t }), 'app');
  const id2 = m.mint();
  t += 31 * 60 * 1000;
  assert.equal(HQ.consentFor({ remote: false, request: id2, minter: m, now: t }), 'follow');   // past its 30 min TTL, within 2 h
  assert.equal(HQ.consentFor({ ask: true, remote: false, request: id2, minter: m, now: t }), 'app');
  assert.equal(HQ.submitsTyped(true, '\r'), true);
  assert.equal(HQ.submitsTyped(false, '\r'), false);
  assert.match(fnBody('inboxRow'), /hqMinter\.clear\(\)/);
});

test('request ids: only minted ones are accepted, else the current one, else the capped adhoc bucket', () => {
  let t = 1000;
  const m = legacyMinter({ now: () => t, rand: () => 'x' });
  assert.equal(HQ.resolveRequest(m, 'rmadeup'), HQ.ADHOC);
  assert.equal(HQ.resolveRequest(m, ''), HQ.ADHOC);
  const a = m.mint(); t += 1;
  const b = m.mint();
  assert.equal(HQ.resolveRequest(m, a), a);          // issued earlier, still within 30 min
  assert.equal(HQ.resolveRequest(m, 'rmadeup'), b);  // unminted → current
  m.clear();
  assert.equal(HQ.resolveRequest(m, 'rmadeup'), HQ.ADHOC);
  t += 31 * 60 * 1000;
  assert.equal(HQ.resolveRequest(m, a), HQ.ADHOC);
  // adhoc: capped by its open tasks only (it never ends)
  let board = HQ.emptyBoard();
  for (let i = 0; i < 8; i++) board = HQ.addTask(board, { id: `ad${i}`, request: HQ.ADHOC, status: 'queued', pub: 'self' }, 1);
  assert.equal(HQ.capReason(board, HQ.ADHOC), 'request-cap');
  board = HQ.setStatus(board, 'ad0', 'reported');
  assert.equal(HQ.capReason(board, HQ.ADHOC), null);
  assert.match(fnBody('hqDispatch'), /HQ\.resolveRequest\(hqMinter,/);
});

test('backoff: 5 s doubling to 10 min, reset after 60 s alive, stop after 5 fast failures; reset restarts', () => {
  let t = 0;
  const r = HQ.createRestarter({ now: () => t });
  assert.equal(r.tick(false), 'start');
  const waits = [];
  for (let i = 0; i < 4; i++) {   // ends after 1 s each time (fast)
    t += 1000;
    assert.equal(r.tick(false), 'wait');
    const from = t;
    while (r.tick(false) === 'wait') t += 1000;
    waits.push(t - from);
  }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000]);
  t += 1000;
  assert.equal(r.tick(false), 'give-up');
  assert.equal(r.tick(false), 'stopped');
  assert.equal(r.stopped, true);
  r.reset();
  assert.equal(r.tick(false), 'start');
  // slow failures (alive 30 s) keep doubling up to 10 min and never stop
  const slow = [];
  for (let i = 0; i < 10; i++) {
    t += 30000;
    assert.equal(r.tick(true), 'run');
    r.tick(false);
    const from = t;
    while (r.tick(false) === 'wait') t += 1000;
    slow.push(t - from);
  }
  assert.deepEqual(slow.slice(0, 3), [5000, 10000, 20000]);
  assert.equal(slow[9], 600000);
  // a pty that lived 60 s resets the backoff
  t += 61000;
  assert.equal(r.tick(true), 'run');
  assert.equal(r.tick(false), 'start');
});

test('on/off and lazy start: HQ starts only once wanted and on; off kills it; never sleeps', () => {
  assert.equal(HQ.normalizeHq({}).enabled, true);
  assert.equal(HQ.normalizeHq({ enabled: false }).enabled, false);
  const tick = fnBody('hqTick');
  assert.match(tick, /hqSettings\(\)\.enabled && hqWanted/);
  assert.match(tick, /step === 'start'\) startPty\(HQ\.HQ_ID/);
  assert.match(tick, /step === 'give-up'\) \{ notify\(T\('main\.hqGaveUp'\)/);
  assert.match(MAIN, /ipcMain\.handle\('hq:open', \(\) => \{ hqWanted = true;/);
  assert.match(fnBody('inboxRow'), /hqWanted = true/);
  assert.match(MAIN, /if \(!next\.enabled\) killPty\(HQ\.HQ_ID\)/);
  assert.match(fnBody('sleepIdle'), /r\.project\.hq\) continue/);
  assert.match(fnBody('bossSid'), /lastSid\.get\(tab\)/);
});

test('paced remote task: a queued row at submit (counted by the caps), renamed to its real id when sent', () => {
  let board = HQ.emptyBoard();
  for (let i = 0; i < 11; i++) board = HQ.addTask(board, { id: `t${i}`, request: 'r1', status: 'delivered', pub: 'self' }, 1);
  assert.equal(HQ.capReason(board, 'r2'), null);
  board = HQ.addTask(board, { id: 'hheld', request: 'r2', status: 'queued', reason: 'paced', pub: 'a'.repeat(64) }, 2);
  assert.equal(HQ.capReason(board, 'r2'), 'open-cap');
  board = HQ.renameTask(board, 'hheld', 'real01', { status: 'queued' });
  const t = board.tasks.find((x) => x.id === 'real01');
  assert.equal(t.brief, 'tasks/real01/brief.md');
  assert.ok(!board.tasks.some((x) => x.id === 'hheld'));
  assert.deepEqual(board.requests.find((r) => r.id === 'r2').tasks, ['real01']);
  assert.match(fnBody('hqDispatch'), /row\(\{ id: heldId, status: 'queued', reason: 'paced' \}, extra\)/);
});

test('remote depth 1: a boss with an incoming device task queued or awaiting its report may not dispatch', () => {
  const owed = new Set();
  const link = { owesReportFor: (p) => owed.has(p) };
  const queue = new Map([['p1', [{ report: true, device: { pub: 'b'.repeat(64) } }]], ['p2', [{ report: true, device: { pub: 'self' } }]], ['p3', [{ report: false, device: { pub: 'c'.repeat(64) } }]]]);
  assert.equal(LH.remoteTaskOpen(queue, link, 'p1'), true);
  assert.equal(LH.remoteTaskOpen(queue, link, 'p2'), false);   // local (HQ) tasks: depthRefused covers them
  assert.equal(LH.remoteTaskOpen(queue, link, 'p3'), false);   // a plain command is not a task
  owed.add('p4');
  assert.equal(LH.remoteTaskOpen(queue, link, 'p4'), true);
  assert.match(fnBody('officeDispatch'), /linkHost\?\.remoteTaskOpen\(/);
});

test('snapshot: worker descriptions only for devices with the manage cap', () => {
  const C = require('../src/link-core.js');
  const snap = { projects: [], workers: [{ id: 'w', project: 'p', type: 'x', description: 'secret task text' }], delivered: 0 };
  assert.equal(C.snapshotFor(snap, true).workers[0].description, 'secret task text');
  assert.ok(!('description' in C.snapshotFor(snap, false).workers[0]));
  assert.equal(snap.workers[0].description, 'secret task text');   // the published one is untouched
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'link.js'), 'utf8'), /C\.snapshotFor\(this\.snap, C\.mayManage\(this\.devices, this\.secrets, pub\)\)/);
});

test('board: statuses, report files, request done, persistence and restart → lost', () => {
  let b = HQ.emptyBoard();
  b = HQ.addTask(b, { id: 't1', request: 'r1', title: 'Fix login', pub: 'self', project: 'web', projectId: 'p1', status: 'queued', prompt: 'with password=hunter22' });
  b = HQ.addTask(b, { id: 't2', request: 'r1', title: 'Docs', pub: 'self', project: 'docs', projectId: 'p2', status: 'queued' });
  assert.match(b.requests[0].prompt, /\[redacted\]/);
  b = HQ.setStatus(b, 't1', 'delivered');
  b = HQ.applyReport(b, 't1', { summary: 'done https://github.com/a/b/pull/7 and http://evil/x', commits: [{ hash: 'abc', subject: 'fix' }] });
  assert.deepEqual(b.tasks.find((t) => t.id === 't1').prs, ['https://github.com/a/b/pull/7']);
  let f = HQ.finishRequests(b);
  assert.deepEqual(f.done, []);
  // persisted and read back like main does (state-file atomic write), then a restart: t2's queue entry is gone
  const dir = tmp('ao-hq-');
  const SF = require('../src/state-file.js');
  SF.writeAtomic(path.join(dir, 'board.json'), JSON.stringify(b));
  const back = HQ.loadBoard(SF.readState(path.join(dir, 'board.json')).raw);
  const after = HQ.markLost(back, () => false);
  assert.equal(after.tasks.find((t) => t.id === 't2').status, 'lost');
  assert.equal(after.tasks.find((t) => t.id === 't1').status, 'reported');
  f = HQ.finishRequests(after);
  assert.deepEqual(f.done, [{ id: 'r1', n: 2 }]);
  assert.deepEqual(HQ.finishRequests(f.board).done, []);   // only once
  const md = HQ.reportMd(after.tasks.find((t) => t.id === 't1'), { summary: 'done\u001b[31m' });
  assert.match(md, /# Fix login/);
  assert.ok(!md.includes('\u001b'));
  assert.equal(HQ.taskFile(dir, '../x', 'report.md'), null);
  assert.match(fnBody('saveHqBoard'), /SF\.writeAtomic\(hqBoardFile\(\)/);
  assert.match(fnBody('setupHq'), /HQ\.markLost\(/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retention: 500 tasks / 90 days, open tasks kept', () => {
  const now = Date.now();
  const tasks = Array.from({ length: 510 }, (_, i) => ({ id: `t${i}`, status: 'reported', at: now - i, finishedAt: now - i, commits: [], prs: [] }));
  tasks.push({ id: 'old', status: 'failed', at: 0, finishedAt: 0, commits: [], prs: [] });
  const { board, removed } = HQ.prune({ tasks, requests: [] }, now);
  assert.equal(board.tasks.length, 500);
  assert.ok(removed.includes('old'));
});

test('caps: 8 per request, 12 open, depth 1', () => {
  let b = HQ.emptyBoard();
  for (let i = 0; i < 8; i++) b = HQ.addTask(b, { id: `a${i}`, request: 'r1', pub: 'self', project: 'p', projectId: 'pp', status: 'queued' });
  assert.equal(HQ.capReason(b, 'r1'), 'request-cap');
  assert.equal(HQ.capReason(b, 'r2'), null);
  for (let i = 0; i < 4; i++) b = HQ.addTask(b, { id: `b${i}`, request: 'r2', pub: 'self', project: 'q', status: 'queued' });
  assert.equal(HQ.capReason(b, 'r3'), 'open-cap');
  assert.equal(HQ.depthRefused(b, 'pp'), true);      // the boss working on an HQ task may not dispatch on
  assert.equal(HQ.depthRefused(b, 'other'), false);
  assert.equal(HQ.depthRefused(b, 'hq'), false);
  assert.match(fnBody('officeDispatch'), /HQ\.depthRefused\(loadHqBoard\(\), tab\)\) return \{ status: 'rejected', reason: 'depth' \}/);
  assert.match(fnBody('hqDispatch'), /HQ\.capReason\(board, request, hqOrders\(\)\.queuedIds\(\), \{ order: !ask && hqOrderOpen\(request\) \}\)/);
});

test('remote rows: keyed <pub>:<id>, restricted actions; offline peers from the cache (names and ids only)', () => {
  const pub = 'ab'.repeat(32);
  let cache = HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage: false, projects: [{ id: 'p1', name: 'site', status: 'working', secret: 'x' }] }], 5);
  assert.deepEqual(cache[pub].projects, [{ id: 'p1', name: 'site', status: 'working', asOf: 5 }]);   // v3.96 last-known status and asOf; unknown fields dropped
  cache = HQ.mergePeerCache(cache, [{ pub, name: 'mini', online: false, projects: null }], 9);
  assert.equal(cache[pub].lastSeen, 5);
  assert.equal(cache[pub].projects.length, 1);
  const rows = HQ.remoteRows(cache, { [pub]: { online: false } });
  assert.equal(rows[0].key, `${pub}:p1`);
  assert.equal(rows[0].online, false);
  assert.deepEqual(rows[0].actions, ['watch', 'board', 'reports', 'dispatch']);
  for (const a of ['terminal', 'gear', 'remove', 'handoff', 'settings', 'start', 'sleep']) assert.equal(HQ.remoteActionAllowed(rows[0], a), false);
  const managed = HQ.remoteRows(HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage: true, projects: [{ id: 'p1', name: 'site' }] }]), { [pub]: { online: true } });
  assert.ok(HQ.remoteActionAllowed(managed[0], 'sleep'));
  assert.deepEqual(HQ.parseRemoteKey(`${pub}:p1`), { pub, id: 'p1' });
  assert.equal(HQ.parseRemoteKey('aaaaaaaaaaaa'), null);
  assert.equal(P.parsePtyId('hq').projectId, 'hq');
});

test('pacing: 5 parallel tasks to one device are held, none dropped', () => {
  let t = 0;
  const pacer = HQ.createPacer({ now: () => t });
  const sent = [];
  for (let i = 0; i < 5; i++) pacer.submit('dev', () => sent.push(i));
  assert.deepEqual(sent, [0, 1, 2]);
  t += 10000; pacer.flush();
  t += 10000; pacer.flush();
  assert.deepEqual(sent, [0, 1, 2, 3, 4]);
  assert.equal(pacer.size, 0);
});

test('local task ids survive a restart; HQ tasks wait up to 4 h in the queue', () => {
  const dir = tmp('ao-lt-');
  const f = path.join(dir, 'local-tasks.json');
  LH.saveTaskIds(f, new Set(['aa11', 'bad id!', 'bb22']));
  assert.deepEqual([...LH.loadTaskIds(f)], ['aa11', 'bb22']);
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
  assert.equal(LH.ttlOf({}), LH.QUEUE_TTL_MS);
  assert.equal(LH.ttlOf({ ttl: HQ.HQ_TTL_MS }), 4 * 3600 * 1000);
  assert.equal(LH.ttlOf({ ttl: 99 * 3600 * 1000 }), 4 * 3600 * 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

function rpc(env, msgs) {
  const dir = tmp('ao-hqs-');
  const script = OM.writeServerScript(dir);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (c) => { buf += c; if (buf.split('\n').filter(Boolean).length >= msgs.length) p.stdin.end(); });
    p.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))); });
    for (const m of msgs) p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  });
}
test('office MCP: the HQ tab lists 7 tools (v3.87 office_task), a project boss 4; HQ-only tools refused for other tabs', async () => {
  const [hq] = await rpc({ AGENT_OFFICE_HQ: '1' }, [{ id: 1, method: 'tools/list' }]);
  assert.deepEqual(hq.result.tools.map((t) => t.name).sort(), ['office_board', 'office_dispatch', 'office_machines', 'office_project', 'office_reports', 'office_summary', 'office_task']);
  const [boss, call] = await rpc({}, [{ id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'office_board', arguments: {} } }]);
  assert.equal(boss.result.tools.length, 4);
  assert.ok(call.error);
  assert.deepEqual(OM.serverConfig({ socket: 's', token: 't', hq: true }).env.AGENT_OFFICE_HQ, '1');
  assert.equal(OM.serverConfig({ socket: 's', token: 't' }).env.AGENT_OFFICE_HQ, undefined);
  const dir = tmp('ao-hqk-');
  fs.chmodSync(dir, 0o700);
  const sock = OM.createOfficeSocket({ socketFile: path.join(dir, 'o.sock'), handle: (tab, tool) => ({ tab, tool }) });
  assert.ok(await sock.ready);
  const ask = (token, tool) => new Promise((resolve) => {
    const c = require('net').createConnection(path.join(dir, 'o.sock'));
    c.on('data', (d) => { c.destroy(); resolve(JSON.parse(String(d))); });
    c.on('connect', () => c.write(`${JSON.stringify({ token, tool, args: {} })}\n`));
  });
  const bossTok = sock.add('aaaaaaaaaaaa');
  const hqTok = sock.add('hq');
  assert.equal((await ask(bossTok, 'office_board')).error, 'unknown-tool');
  assert.deepEqual((await ask(hqTok, 'office_board')).result, { tab: 'hq', tool: 'office_board' });
  assert.equal((await ask('nope', 'office_board')).error, 'unauthorized');
  sock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a foreign request id resolves to the current id and consentFor sees it live (real path)', () => {
  let t = 1000;
  const m = legacyMinter({ now: () => t, rand: () => 'x' });
  const cur = m.mint();
  const request = HQ.resolveRequest(m, 'rforged');
  assert.equal(request, cur);
  assert.equal(HQ.consentFor({ remote: false, request, minter: m, now: t }), 'none');
  assert.equal(HQ.consentFor({ ask: true, remote: false, request, minter: m, now: t }), 'app');
  t += 31 * 60 * 1000;   // expired: falls to adhoc → dialog
  const late = HQ.resolveRequest(m, 'rforged');
  assert.equal(late, HQ.ADHOC);
  assert.equal(HQ.consentFor({ remote: false, request: late, minter: m, now: t }), 'app');
});

test('caps are re-checked after the consent dialog resolves', () => {
  const body = fnBody('hqDispatch');
  const a = body.indexOf('confirmHqDispatch(args, remote)');
  const b = body.indexOf('HQ.capReason(loadHqBoard(), request, hqOrders().queuedIds(), { order: !ask && hqOrderOpen(request) })', a);
  assert.ok(a > 0 && b > a, 'fresh capReason after the dialog');
  // behavior: the board that filled while the dialog was open now refuses
  let board = HQ.emptyBoard();
  assert.equal(HQ.capReason(board, 'r1'), null);
  for (let i = 0; i < HQ.MAX_PER_REQUEST; i++) board = HQ.addTask(board, { id: `x${i}`, request: 'r1', status: 'queued', pub: 'self' }, 1);
  assert.equal(HQ.capReason(board, 'r1'), 'request-cap');
});

test('HQ launch keeps MCP tools next to --tools Read (live-checked)', () => {
  const args = HQ.launchArgs({ dir: '/h', mcpConfig: '/c.json', server: 'agent-office' });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
});

// ---- v3.46 amendment: why a queued HQ task waits, wake/start of a gone boss, Cancel

function waitHost(t, over = {}) {
  const dir = tmp('ao-hqwait-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const typed = [];
  const host = LH.setupLink({
    app: { getPath: () => dir, getVersion: () => '0.21.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: () => {} }, send: () => {}, notify: () => {}, T: (k) => k, loginOf: () => 'in', reportsDir: path.join(dir, 'r'),
    projects: () => [{ id: 'p1', name: 'pii', engine: 'claude' }], type: (id, text) => { typed.push(text); }, ...over,
  });
  t.after(() => host.destroy());
  return { host, typed };
}

test('v3.83: HQ\'s task for a staff member reaches the member\'s desk tab; a paired device cannot target a desk', (t) => {
  const tab = { 'p1:2': 'ready' };
  const { host, typed } = waitHost(t, {
    tabState: (id) => tab[id] || 'gone',
    desk: (id) => (id === 'p1:2' ? { id: 'p1:2', name: 'pii · Ahmet', engine: 'claude' } : null),
    type: (id, text) => { typed.push([id, text]); },
  });
  const seen = [];
  const r = host.dispatchLocal('p1:2', 'deploy the SaaS', 'HQ', (id, s, why) => seen.push([s, why]), { ttl: 3600000, revive: true });
  assert.notEqual(r.status, 'rejected', JSON.stringify(r));
  host.pump();
  assert.equal(typed.length, 1);
  assert.equal(typed[0][0], 'p1:2', 'typed into the desk, not the project boss');
  assert.match(typed[0][1], /deploy the SaaS/);
  assert.ok(seen.some((x) => x[0] === 'delivered'));
  assert.equal(host.dispatchLocal('p9:2', 'x', 'HQ', () => {}).reason, 'unknown-project', 'a tab that is no desk stays unknown');
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN, /desk: \(id\) => \{\s+const r = String\(id\)\.includes\(':'\) \? P\.resolvePty\(state, String\(id\)\) : null;/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'link-host.js'), 'utf8'), /\(device\.pub === SELF \? d\.desk\?\.\(project\) \|\| null : null\)/);
});

test('v3.83 amendment: a gone desk starts at once with HQ\'s task as its first prompt; a tab stuck starting gets it after 20 s', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const tab = { 'p1:2': 'gone', p1: 'starting' };
  const started = []; let refuse = false;
  const { host, typed } = waitHost(t, {
    tabState: (id) => tab[id] || 'gone',
    desk: (id) => (id === 'p1:2' ? { id: 'p1:2', name: 'pii · Ahmet', engine: 'claude' } : null),
    manage: () => { throw new Error('not used when startWith takes it'); },
    startWith: (id, text) => { if (refuse) return false; started.push([id, text]); tab[id] = 'starting'; return true; },
  });
  const seen = [];
  host.dispatchLocal('p1:2', 'deploy the SaaS', 'HQ', (id, s) => seen.push(s), { ttl: 3600000, revive: true });
  host.pump();
  assert.equal(started.length, 1, 'no minute of waiting for a desk');
  assert.equal(started[0][0], 'p1:2');
  assert.match(started[0][1], /deploy the SaaS/);
  assert.deepEqual(seen, ['queued', 'delivered']);
  // a running boss tab that never had a prompt: waits, then is restarted with the task (once main agrees)
  const seen2 = [];
  host.dispatchLocal('p1', 'scan', 'HQ', (id, s) => seen2.push(s), { ttl: 3600000, revive: true });
  refuse = true;
  for (let e = 0; e < 30000; e += 1500) { clock += 1500; host.pump(); }
  assert.deepEqual(seen2, ['queued'], 'main refused: still waiting');
  refuse = false;
  for (let e = 0; e < 21000; e += 1500) { clock += 1500; host.pump(); }
  assert.deepEqual(started.at(-1)[0], 'p1');
  assert.deepEqual(seen2, ['queued', 'delivered']);
  assert.equal(typed.length, 0, 'nothing typed into a tab that takes no typing');
  // a device's command never restarts a tab (revive is this machine's own)
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN, /startWith: startWithPrompt/);
  assert.match(MAIN, /if \(startedWith\.get\(id\) === t \|\| tabStateOf\(id\) !== 'starting' \|\| activity\.get\(id\)\?\.draft\) return false;/);
});

test('v3.46 amendment: waitState names why a task waits', () => {
  assert.deepEqual(['ready', 'busy', 'starting'].map((s) => HQ.waitState(s, false)), ['ready', 'busy', 'starting']);
  assert.equal(HQ.waitState('gone', true), 'asleep');
  assert.equal(HQ.waitState('gone', false), 'not-running');
  assert.ok(HQ.WAIT_STATES.includes('not-running'));
});

test('v3.46 amendment: an HQ task wakes/starts a gone boss, waits for it, then is typed; at most 3 tries a minute apart', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const adv = (ms) => { for (let e = 0; e < ms; e += 1500) { clock += 1500; host.pump(); } };   // real pumps tick every 1.5 s
  let tab = 'gone'; const ops = [];
  const { host, typed } = waitHost(t, { tabState: () => tab, manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  const seen = [];
  const r = host.dispatchLocal('p1', 'scan the repo', 'HQ', (id, s, why) => seen.push([s, why]), { ttl: 3600000, revive: true });
  assert.equal(r.status, 'queued');
  assert.deepEqual(ops, []);   // a stopped tab gets a short settle time (it may still be shutting down), not a minute
  adv(4500);
  assert.deepEqual(ops, [['start', 'p1']]);
  adv(50000);
  assert.equal(ops.length, 1);   // the second start is not before the gap
  const w = host.waitInfo(r.id);
  assert.deepEqual([w.project, w.pos, w.len, w.expiresAt], ['p1', 1, 1, w.expiresAt]);
  tab = 'starting'; host.pump();
  assert.equal(typed.length, 0);
  tab = 'ready'; host.pump();
  assert.equal(typed.length, 1);
  assert.deepEqual(seen.map((x) => x[0]), ['queued', 'delivered']);
  assert.equal(host.waitInfo(r.id), null);
  // ready reset the budget: a new gone spell waits a minute again, then tries
  tab = 'gone'; ops.length = 0;
  const seen2 = [];
  host.dispatchLocal('p1', 'again', 'HQ', (id, s, why) => seen2.push([s, why]), { ttl: 3600000, revive: true });
  host.pump(); assert.equal(ops.length, 0);
  adv(4500); assert.equal(ops.length, 1);
  adv(6 * 61000);
  assert.equal(ops.length, 3);   // budget unchanged: 3 starts in all, a minute apart
  assert.deepEqual(seen2.at(-1), ['rejected', 'not-running']);
});

test('v3.104: the first start of a sleeping tab is at once; of a stopped tab after the settle time; retries keep the minute', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const adv = (ms) => { for (let e = 0; e < ms; e += 1500) { clock += 1500; host.pump(); } };
  const ops = [];
  const { host } = waitHost(t, { tabState: () => 'gone', asleep: () => true, manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  host.dispatchLocal('p1', 'x', 'HQ', () => {}, { ttl: 3600000, revive: true });
  assert.deepEqual(ops, [['start', 'p1']], 'asleep: started in the dispatch call itself');
  adv(57000); assert.equal(ops.length, 1);
  adv(4500); assert.equal(ops.length, 2, 'second start after the minute');
  adv(57000); assert.equal(ops.length, 2);
  adv(4500); assert.equal(ops.length, 3);
  adv(3 * 61000); assert.equal(ops.length, 3, 'no fourth start');
});

test('v3.104: a tab the person stopped here within 10 minutes keeps the old minute before the first start', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const adv = (ms) => { for (let e = 0; e < ms; e += 1500) { clock += 1500; host.pump(); } };
  const ops = [];
  const { host } = waitHost(t, { tabState: () => 'gone', stoppedHere: () => clock - 60000, manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  host.dispatchLocal('p1', 'x', 'HQ', () => {}, { ttl: 3600000, revive: true });
  adv(57000); assert.equal(ops.length, 0);
  adv(6000); assert.equal(ops.length, 1);
});

test('v3.46 amendment: the revive budget is per project: several queued HQ tasks start the boss 3 times in all, then all are refused', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const adv = (ms) => { for (let e = 0; e < ms; e += 1500) { clock += 1500; host.pump(); } };   // real pumps tick every 1.5 s
  const ops = [];
  const { host } = waitHost(t, { tabState: () => 'gone', manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  const seen = [[], [], [], [], []];
  seen.forEach((a) => host.dispatchLocal('p1', 'x', 'HQ', (id, s, why) => a.push([s, why]), { ttl: 3600000, revive: true }));
  host.pump(); assert.equal(ops.length, 0);
  adv(8 * 61000);
  assert.equal(ops.length, 3);
  for (const a of seen) assert.deepEqual(a.at(-1), ['rejected', 'not-running']);
});

test('v3.46 amendment: a cancelled wait does not carry its gone-spell start over: a later task waits a fresh minute', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const adv = (ms) => { for (let e = 0; e < ms; e += 1500) { clock += 1500; host.pump(); } };
  const ops = [];
  const { host } = waitHost(t, { tabState: () => 'gone', manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  const a = host.dispatchLocal('p1', 'x', 'HQ', () => {}, { ttl: 3600000, revive: true });
  adv(1500);                      // the queue saw the tab gone (inside the settle time)
  assert.equal(host.cancel(a.id), true);
  adv(5 * 60000);                 // the person ran and stopped the boss meanwhile; nothing queued, no pumps see it
  host.dispatchLocal('p1', 'y', 'HQ', () => {}, { ttl: 3600000, revive: true });
  host.pump();
  assert.equal(ops.length, 0);    // a fresh gone spell: the settle time starts again, nothing is carried over
  adv(4500);
  assert.equal(ops.length, 1);
});

test('v3.46 amendment: without revive a gone boss refuses at once; a failed start says why', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const adv = (ms) => { for (let e = 0; e < ms; e += 1500) { clock += 1500; host.pump(); } };   // real pumps tick every 1.5 s
  let res = { ok: false, reason: 'locked' };
  const { host } = waitHost(t, { tabState: () => 'gone', manage: () => res });
  const a = []; host.dispatchLocal('p1', 'x', 'Boss', (id, s, why) => a.push([s, why]));
  assert.deepEqual(a.at(-1), ['rejected', 'not-running']);
  const b = []; host.dispatchLocal('p1', 'x', 'HQ', (id, s, why) => b.push([s, why]), { revive: true });
  adv(61000);
  assert.deepEqual(b.at(-1), ['rejected', 'locked']);
  res = { ok: false, reason: 'failed' };
  const c = []; host.dispatchLocal('p1', 'x', 'HQ', (id, s, why) => c.push([s, why]), { revive: true });
  adv(61000);
  assert.deepEqual(c.at(-1), ['rejected', 'not-running']);
});

test('v3.46 amendment: Cancel takes a queued task out of its project queue as rejected: cancelled', (t) => {
  const { host, typed } = waitHost(t, { tabState: () => 'busy' });
  const s1 = []; const a = host.dispatchLocal('p1', 'one', 'HQ', (id, s, why) => s1.push([s, why]));
  const b = host.dispatchLocal('p1', 'two', 'HQ');
  assert.deepEqual([host.waitInfo(b.id).pos, host.waitInfo(b.id).len], [2, 2]);
  assert.equal(host.cancel(a.id), true);
  assert.deepEqual(s1.at(-1), ['rejected', 'cancelled']);
  assert.deepEqual([host.waitInfo(b.id).pos, host.waitInfo(b.id).len], [1, 1]);
  assert.equal(host.cancel(a.id), false);
  assert.equal(host.cancel('nope'), false);
  assert.equal(host.knows(a.id), false);
  assert.equal(typed.length, 0);
});

test('v3.46 amendment: main wires waits, the push, Cancel (validated, queued local cards only) and revive for HQ only', () => {
  assert.match(MAIN, /const hqView = \(\) => \(\{[^\n]*waits: hqWaits\(\) \}\);/);
  assert.match(fnBody('hqWaits'), /t\.status !== 'queued' \|\| t\.machine !== 'self'/);
  assert.match(fnBody('hqTick'), /hqWaitsPush\(\);/);
  assert.match(MAIN, /const broadcast = \(\) => \{[^\n]*hqWaitsPush\(\)/);
  const i = MAIN.indexOf("ipcMain.handle('hq:cancel'");
  assert.ok(i > 0);
  const body = MAIN.slice(i, MAIN.indexOf('\n});', i));
  assert.match(body, /typeof id !== 'string' \|\| !\/\^\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(id\)/);
  assert.match(body, /t\.status === 'queued' && t\.machine === 'self'\) linkHost\?\.cancel\(id\)/);
  assert.match(fnBody('hqDispatch'), /\{ ttl: HQ\.HQ_TTL_MS, revive: true \}/);
  assert.doesNotMatch(fnBody('officeDispatch'), /revive: true/);   // a project boss's dispatch never wakes a target
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(pre, /cancel: \(id\) => ipcRenderer\.invoke\('hq:cancel', id\)/);
});

test('shell status: tabStateOf types into a shell tab; tabWorkRunning still sees work; kill paths check it', () => {
  const R = require('../src/resume.js');
  const make = (status, extra = {}) => {
    const deps = {
      state: {}, P: { resolvePty: () => ({ project: { id: 'p' } }) }, terms: new Map([['p', { pid: 1 }]]), handoffLocks: new Set(), cmdTabs: new Set(),
      A: { accountOf: () => ({ configDir: '/c' }) }, Z: { claudePidFile: () => '/c/sessions/1.json' }, app: { getPath: () => '/h' },
      readJson: () => (status === null ? null : { sessionId: 's1', status }), validSid: (s) => s || '', LC: { typingReady: () => true },
      sessionPrompted: () => true, R, office: () => ({ readSession: () => extra.office }), activity: new Map(), attention: new Map(),
    };
    const names = Object.keys(deps);
    return new Function(...names, `${fnBody('tabStateOf')}\n}\n${fnBody('tabWorkRunning')}\n}\nreturn { tabStateOf, tabWorkRunning };`)(...names.map((n) => deps[n]));
  };
  for (const [status, ts, work] of [['idle', 'ready', false], ['shell', 'ready', true], ['busy', 'busy', true], ['waiting', 'busy', true]]) {
    const f = make(status);
    assert.equal(f.tabStateOf('p'), ts, status);
    assert.equal(f.tabWorkRunning('p'), work, status);
  }
  assert.equal(make(null).tabStateOf('p'), 'busy', 'no pid file: busy');
  // HQ relaunch (account/model change) never kills HQ while work runs, a background shell included
  assert.match(MAIN, /relaunch && terms\.has\(HQ\.HQ_ID\) && tabStateOf\(HQ\.HQ_ID\) !== 'busy' && !tabWorkRunning\(HQ\.HQ_ID\)\) killPty\(HQ\.HQ_ID\)/);
  // v3.33 sleep/stop refuse a tab with work running ('ready' includes shell)
  assert.match(fnBody('projectOp'), /if \(tabWorkRunning\(id\)\) return \{ ok: false, reason: 'busy' \}/);
});

test('v3.48 review 5: report.md keeps report2 sizes (40 KB summary cut with the marker, 30 commits) and fences the summary', () => {
  const C = require('../src/link-core.js');
  const board = { tasks: [{ id: 't1', title: 'Big', project: 'p', machine: 'self', status: 'queued', commits: [], prs: [], at: 1 }], requests: [] };
  const commits = Array.from({ length: 40 }, (_, i) => ({ hash: `h${i}`, subject: `s${i}` }));
  const task = HQ.applyReport(board, 't1', { summary: 'x', commits }).tasks[0];
  assert.equal(task.commits.length, C.REPORT2_COMMITS);
  const md = HQ.reportMd(task, { summary: `# not a heading\n\`\`\`\n${'y'.repeat(50000)}` });
  assert.ok(md.includes('y'.repeat(30000)));
  assert.ok(md.includes(C.TRUNC_MARK));
  assert.match(md, /\n````text\n# not a heading\n```\n/);   // fenced longer than the backticks inside: stays data
  assert.match(md, /\n````\n/);
});

test('HQ boss model: a listed model or a valid custom id; anything else is dropped (v3.73)', () => {
  for (const v of ['sonnet', 'claude-fable-5-2', 'claude-next-9']) assert.equal(HQ.normalizeHq({ bossModel: v }).bossModel, v);
  for (const v of ['a b', 'x;rm -rf ~', '-p', 'flash', 'fixcloud/glm-4.6', '', 5]) assert.equal('bossModel' in HQ.normalizeHq({ bossModel: v }), false, String(v));
  assert.equal('bossModel' in P.normalizeState({ hq: { bossModel: '$(id)' } }).hq, false);
  assert.match(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), /o\.bossModel === '' \|\| HQ\.hqBossModel\(o\.bossModel\)/); // the IPC setter leaves an invalid value out
});

test('v3.83 amendment: a task started as the first-prompt argument keeps a marker the plugin reads', () => {
  const C = require('../src/link-core.js');
  const R = require('../src/resume.js');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'plugin', 'hooks', 'reports.ts'), 'utf8');
  const MARKER = new RegExp(src.match(/^const MARKER = \/(.*)\/$/m)[1]);
  const typed = C.markedTask('edb2d4505fa1dd57', 'Yasin-MacBook-Air', 'deploy\n1. "check" it');
  assert.equal(MARKER.exec(typed)?.[1], 'edb2d4505fa1dd57');
  assert.equal(MARKER.exec(R.promptArg(typed))?.[1], 'edb2d4505fa1dd57', 'quotes and line breaks dropped, the id still read');
});

test('v3.83 amendment task watch: live board status, and a task whose session never reports ends with a partial report', () => {
  const TW = require('../src/task-watch.js');
  let r = TW.watchStep({ status: 'queued', live: 'idle', now: 0 });
  assert.deepEqual(r, { mem: {} }, 'not delivered yet: nothing to watch');
  r = TW.watchStep({ status: 'delivered', live: 'busy', now: 1000 });
  assert.equal(r.status, 'running');
  r = TW.watchStep({ status: 'running', live: 'permission', now: 2000, mem: r.mem });
  assert.equal(r.status, 'needs-approval');
  r = TW.watchStep({ status: 'needs-approval', live: 'idle', now: 3000, mem: r.mem });
  assert.deepEqual([r.status, r.end], ['delivered', undefined]);
  r = TW.watchStep({ status: 'delivered', live: 'idle', now: 3000 + TW.IDLE_MS - 1, mem: r.mem });
  assert.equal(r.end, undefined, 'not yet');
  const busyAgain = TW.watchStep({ status: 'delivered', live: 'busy', now: 3000 + TW.IDLE_MS - 1, mem: r.mem });
  assert.equal(busyAgain.mem.idleSince, undefined, 'work again: the idle clock starts over');
  r = TW.watchStep({ status: 'delivered', live: 'idle', now: 3000 + TW.IDLE_MS, mem: r.mem });
  assert.equal(r.end, 'idle');
  let g = TW.watchStep({ status: 'running', live: 'gone', now: 0, mem: { since: 0 } });
  g = TW.watchStep({ status: 'running', live: 'gone', now: TW.GONE_MS, mem: g.mem });
  assert.equal(g.end, 'gone');
  assert.equal(TW.watchStep({ status: 'reported', live: 'gone', now: 9e9, mem: g.mem }).end, undefined);
  const rep = TW.fallbackReport({ why: 'idle', answer: 'Sunucuya giremedim.', now: 5 });
  assert.deepEqual([rep.ok, rep.partial, rep.at, rep.commits], [false, true, 5, []]);
  assert.match(rep.summary, /^\[Agent Office\] .*went idle[\s\S]*Sunucuya giremedim\.$/);
  assert.match(TW.fallbackReport({ why: 'gone', answer: '', now: 1 }).summary, /stopped[\s\S]*no answer/);
  // the queue takes the report like the plugin's own: same file, same scan
  const C = require('../src/link-core.js');
  assert.equal(C.cleanReport(rep, true).partial, true);
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN, /rec = \{ machine: selfName\(\), project: officeName\(p\.name\), pub: 'self', into \};/);
  assert.ok(MAIN.includes("if (fs.existsSync(f)) continue;   // the plugin's own report is on its way"));
});

test('v3.83 amendment: lastAnswer reads the newest assistant text of a transcript', () => {
  const CHAT = require('../src/chat.js');
  const f = path.join(tmp('ao-last-'), 's.jsonl');
  const line = (o) => `${JSON.stringify({ timestamp: '2026-11-17T10:00:00.000Z', uuid: String(Math.random()), ...o })}\n`;
  fs.writeFileSync(f, line({ type: 'user', message: { role: 'user', content: 'deploy' } })
    + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } })
    + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sunucuya giremedim.' }] } }));
  assert.equal(CHAT.lastAnswer(f), 'Sunucuya giremedim.');
  assert.equal(CHAT.lastAnswer(path.join(path.dirname(f), 'none.jsonl')), '');
});

test('v3.87 office_task: what each op does; approving a held task is the person\'s alone', () => {
  const t = (status, machine = 'self') => ({ id: 'x', status, machine });
  const plan = (task, op) => HQ.taskOpPlan(task, op);
  assert.deepEqual(plan(t('awaiting-consent'), 'approve'), { error: 'person-only' });
  assert.deepEqual(plan(t('awaiting-consent'), 'allow'), { error: 'person-only' });
  assert.deepEqual(plan(t('awaiting-consent'), 'cancel'), { do: 'decline' });
  assert.deepEqual(plan(t('waiting'), 'cancel'), { do: 'cancel-waiting' });
  assert.deepEqual(plan(t('queued'), 'cancel'), { do: 'cancel-queued' });
  assert.deepEqual(plan(t('queued', 'abc'), 'cancel'), { do: 'cancel-remote' });
  assert.deepEqual(plan(t('delivered'), 'cancel'), { do: 'close-open' });
  assert.deepEqual(plan(t('running'), 'done'), { do: 'done' });
  assert.deepEqual(plan(t('queued'), 'done'), { error: 'not-started' });
  assert.deepEqual(plan(t('running'), 'remove'), { error: 'still-open' });
  assert.deepEqual(plan(t('reported'), 'remove'), { do: 'remove' });
  assert.deepEqual(plan(t('reported'), 'cancel'), { error: 'already-ended' });
  assert.deepEqual(plan(null, 'cancel'), { error: 'unknown-task' });
  assert.deepEqual(plan(t('running'), 'delete-all'), { error: 'bad-op' });
  const board = { tasks: [{ id: 'a', request: 'r1', status: 'reported', title: 'A' }, { id: 'b', request: 'r2', status: 'reported', title: 'B' }], requests: [{ id: 'r1' }, { id: 'r2' }] };
  const nb = HQ.removeTask(board, 'a');
  assert.deepEqual([nb.tasks.map((x) => x.id), nb.requests.map((x) => [x.id, x.removed || 0])], [['b'], [['r1', 1], ['r2', 0]]], 'the request stays and counts the removed row');
  assert.equal(HQ.retitleTask(board, 'b', '  New\ntitle ').tasks[1].title, 'New title');
  assert.equal(HQ.retitleTask(board, 'b', '   ').tasks[1].title, 'B', 'an empty title changes nothing');
  assert.ok(HQ.HQ_OFFICE_TOOLS.includes('office_task'));
  const OM2 = require('../src/office-mcp.js');
  assert.ok(OM2.toolsFor('hq').some((x) => x.name === 'office_task'));
  assert.ok(!OM2.toolsFor('p1').some((x) => x.name === 'office_task'), 'a project boss never gets it');
});

test('v3.87 review fixes: office_task decisions (held cards, no link, the cap after remove, closed by HQ)', () => {
  const t = (status, machine = 'self') => ({ id: 'x', status, machine });
  // a card the person is about to Allow is never relabelled; other open and ended tasks can be
  assert.deepEqual(HQ.taskOpPlan(t('awaiting-consent'), 'retitle'), { error: 'held' });
  for (const s of ['queued', 'waiting', 'running', 'reported']) assert.deepEqual(HQ.taskOpPlan(t(s), 'retitle'), { do: 'retitle' }, s);
  // a held card of the person's own project routine is not HQ's to decline
  assert.deepEqual(HQ.taskOpPlan(t('awaiting-consent'), 'cancel', { ownHeld: false }), { error: 'person-only' });
  assert.deepEqual(HQ.taskOpPlan(t('awaiting-consent'), 'cancel', { ownHeld: true }), { do: 'decline' });
  // no link host: nothing can be taken out of a queue, so never ok
  assert.deepEqual(HQ.taskOpPlan(t('queued'), 'cancel', { link: false }), { error: 'no-link' });
  assert.deepEqual(HQ.taskOpPlan(t('queued', 'abc'), 'cancel', { link: false }), { error: 'no-link' });
  assert.deepEqual(HQ.taskOpPlan(t('running'), 'cancel', { link: false }), { do: 'close-open' }, 'closing a typed task needs no link');
  assert.deepEqual(HQ.taskOpPlan(t('waiting'), 'cancel', { link: false }), { do: 'cancel-waiting' });
  // remove never gets a request under its cap
  const CH = require('../src/hq-chain.js');
  const now = 1_000_000;
  let b = HQ.emptyBoard();
  for (let i = 0; i < HQ.MAX_PER_REQUEST; i++) b = HQ.addTask(b, { id: `t${i}`, request: 'r1', title: 'x', status: 'reported' }, now);
  assert.equal(HQ.capReason(b, 'r1'), 'request-cap');
  b = HQ.removeTask(HQ.removeTask(b, 't0'), 't1');
  assert.equal(b.tasks.length, HQ.MAX_PER_REQUEST - 2);
  assert.equal(HQ.removedOf(b, 'r1'), 2);
  assert.equal(HQ.capReason(b, 'r1'), 'request-cap', 'dispatch → remove → dispatch stays capped');
  assert.equal(CH.capFor(b, 'r1', 1), 'request-cap', 'the staged path counts removed rows too');
  assert.equal(HQ.capReason(b, 'r2'), null);
  for (let i = 2; i < HQ.MAX_PER_REQUEST; i++) b = HQ.removeTask(b, `t${i}`);
  assert.deepEqual([b.tasks.length, b.requests.map((r) => [r.id, r.tasks.length, r.removed])], [0, [['r1', 0, HQ.MAX_PER_REQUEST]]]);
  assert.equal(HQ.capReason(b, 'r1'), 'request-cap', 'an emptied request is still full');
  assert.equal(HQ.prune(b, now + 1000).board.requests.length, 1, 'kept while its id can still be used');
  assert.equal(HQ.prune(b, now + HQ.ROUTINE_MINT_MS + 1).board.requests.length, 0);
  assert.deepEqual(HQ.finishRequests(b).done, [], 'an emptied request never finishes again');
  // the adhoc bucket counts open tasks only and goes with its last task
  let a = HQ.addTask(HQ.emptyBoard(), { id: 'x1', request: HQ.ADHOC, title: 'x', status: 'reported' }, now);
  a = HQ.removeTask(a, 'x1');
  assert.deepEqual([a.requests.length, HQ.removedOf(a, HQ.ADHOC)], [0, 0]);
  // done: closed by HQ, marked, no report file named unless written, no PRs from HQ's note, never twice
  let c = HQ.addTask(HQ.emptyBoard(), { id: 'd1', request: 'r1', title: 'D', status: 'running' }, now);
  const closed = HQ.closeByHq(c, 'd1', {}, now + 5).tasks[0];
  assert.deepEqual([closed.status, closed.closedByHq, closed.finishedAt, closed.report, closed.prs], ['reported', true, now + 5, undefined, []]);
  assert.equal(HQ.closeByHq(c, 'd1', { report: true }).tasks[0].report, 'tasks/d1/report.md');
  assert.equal(HQ.boardView(HQ.closeByHq(c, 'd1'))[0].closedByHq, true, 'HQ sees it on office_board');
  c = HQ.applyReport(c, 'd1', { summary: 'real' });
  assert.equal(HQ.closeByHq(c, 'd1').tasks[0].closedByHq, undefined, 'a task that really reported is left alone');
  // main.js hqTaskOp: the decision comes from taskOpPlan with what main knows; done goes through closeByHq
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = src.slice(src.indexOf('function hqTaskOp('), src.indexOf('\n}\n', src.indexOf('function hqTaskOp(')));
  assert.match(body, /HQ\.taskOpPlan\(task, op, \{ link: Boolean\(linkHost\), ownHeld: !heldRun \|\| heldRun\.kind === 'hq' \}\)/);
  assert.match(body, /HQ\.closeByHq\(loadHqBoard\(\), id, \{ report: wrote \}\)/);
  assert.doesNotMatch(body, /applyReport/, 'done is never a full report');
  assert.match(body, /const r = await approveHeld\(id, false\); if \(r && r\.ok === false\) return \{ ok: false/);
});

test('v3.89 amendment: a report the person\'s own prompt may have shaped is marked on the row, for HQ and over the link', () => {
  const C = require('../src/link-core.js');
  const now = 1700000000000;
  let b = HQ.addTask(HQ.emptyBoard(), { id: 'p1', request: 'r1', title: 'P', status: 'running' }, now);
  b = HQ.applyReport(b, 'p1', { summary: 'the meeting is at three', personPrompted: true }, now + 5);
  const row = b.tasks[0];
  assert.deepEqual([row.status, row.personPrompted], ['reported', true], 'a task with no later stage is simply reported, with the note');
  const view = HQ.boardView(b)[0];
  assert.deepEqual([view.personPrompted, view.note], [true, HQ.PERSON_PROMPTED_NOTE]);
  assert.match(HQ.reportMd(row, { summary: 'the meeting is at three' }), /\nNote: The person typed in that session while the task ran/);
  const plain = HQ.applyReport(HQ.addTask(HQ.emptyBoard(), { id: 'p2', request: 'r1', title: 'P', status: 'running' }, now), 'p2', { summary: 'done' });
  assert.equal(plain.tasks[0].personPrompted, undefined);
  assert.deepEqual([HQ.boardView(plain)[0].personPrompted, HQ.boardView(plain)[0].note], [undefined, undefined]);
  assert.doesNotMatch(HQ.reportMd(plain.tasks[0], { summary: 'done' }), /Note:/);
  // the link keeps the mark only when it is exactly true (both report generations); unknown or absent is false
  for (const v2 of [false, true]) {
    assert.equal(C.cleanReport({ summary: 's', commits: [], personPrompted: true }, v2).personPrompted, true);
    for (const mark of [undefined, false, 'true', 1]) assert.equal('personPrompted' in C.cleanReport({ summary: 's', commits: [], personPrompted: mark }, v2), false);
  }
  assert.equal(C.fitReport({ summary: 's', commits: [], personPrompted: true }, true).personPrompted, true);
  // main.js: the report-ready row carries the mark, never report text
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /kind: 'report-ready', id, machine: officeName\(rec\.machine\), project: officeName\(rec\.project\), \.\.\.\(report\.personPrompted === true \? \{ personPrompted: true \} : \{\}\) \}/);
});

// --- v3.91 HQ's initiative, v3.103 for every later turn of a typed request: follow-up tasks without the dialog
const WEB = { projectId: 'p-web' };
const initiativeCase = () => {
  const clock = { t: 1000 };
  const m = legacyMinter({ now: () => clock.t, rand: () => 'x' });
  const id = m.mint();
  const board = HQ.addTask(HQ.emptyBoard(), { id: 't1', request: id, title: 'first', pub: 'self', project: 'web', projectId: 'p-web', status: 'reported', consented: true }, clock.t);
  m.clear();   // a report came in: the typed id is no longer live
  const ask = (over = {}) => HQ.initiativeFor({ request: id, minter: m, board, targets: [WEB], now: clock.t, ...over });
  return { clock, m, id, board, ask };
};

test('askBeforeDispatch setting: default off, kept only when true; the initiative setting is gone', () => {
  assert.equal('askBeforeDispatch' in HQ.normalizeHq({}), false);
  assert.equal('askBeforeDispatch' in HQ.normalizeHq({ askBeforeDispatch: 'yes' }), false);
  assert.equal('askBeforeDispatch' in HQ.normalizeHq({ askBeforeDispatch: false }), false);
  assert.equal(HQ.normalizeHq({ askBeforeDispatch: true }).askBeforeDispatch, true);
  assert.equal('initiative' in HQ.normalizeHq({ initiative: true }), false);
  assert.equal(HQ.MAX_INITIATIVE, 4);
  assert.equal(HQ.INITIATIVE_MS, 2 * 3600 * 1000);
  assert.equal(HQ.MAX_PER_REQUEST, 8);
  assert.equal(HQ.MAX_OPEN, 12);
});

test('follow-up: a later turn of a typed request needs no consent (consentFor says follow, initiativeFor holds)', () => {
  const { clock, m, id, ask } = initiativeCase();
  assert.equal(HQ.consentFor({ remote: false, request: id, minter: m, now: clock.t }), 'follow');
  assert.equal(HQ.consentFor({ ask: true, remote: false, request: id, minter: m, now: clock.t }), 'app');
  assert.equal(m.isLive(id), false);
  assert.equal(ask(), true);
  assert.equal(ask({ initiative: false }), true);   // a stale argument changes nothing: there is no such setting any more
  assert.equal(ask({ targets: [{ projectId: 'p-web', remote: true }] }), false);   // a paired machine target must name the machine
});

test('initiative: only an id the person typed (never a routine, adhoc, a foreign or an empty id)', () => {
  const { clock, m, board, ask } = initiativeCase();
  clock.t += 5;   // another id than the typed one
  const rid = m.mint({ origin: 'routine', run: 'run1' });
  assert.equal(m.typedAt(rid), 0);
  const withRoutine = HQ.addTask(board, { id: 't2', request: rid, title: 'r', pub: 'self', project: 'web' }, clock.t);
  assert.equal(ask({ request: rid, board: withRoutine }), false);
  const withAdhoc = HQ.addTask(board, { id: 't3', request: HQ.ADHOC, title: 'a', pub: 'self', project: 'web' }, clock.t);
  assert.equal(ask({ request: HQ.ADHOC, board: withAdhoc }), false);
  const withForged = HQ.addTask(board, { id: 't4', request: 'rforged', title: 'f', pub: 'self', project: 'web' }, clock.t);
  assert.equal(ask({ request: 'rforged', board: withForged }), false);
  assert.equal(ask({ request: '' }), false);
  assert.equal(ask({ minter: null }), false);
});

test('initiative: the request is younger than 2 hours', () => {
  const { clock, m, id, ask } = initiativeCase();
  assert.equal(m.typedAt(id), 1000);
  clock.t = 1000 + HQ.INITIATIVE_MS - 1;
  assert.equal(ask(), true);
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), id);                  // usable past the 30 min TTL (v3.103 default)
  assert.equal(HQ.resolveRequest(m, id, { ask: true, now: clock.t }), HQ.ADHOC);   // askBeforeDispatch on: ends with its TTL as before
  clock.t = 1000 + HQ.INITIATIVE_MS;
  assert.equal(ask(), false);
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), HQ.ADHOC);
});

test('follow-up: v3.103 the request no longer needs a task on the board', () => {
  const { id, board, ask } = initiativeCase();
  assert.equal(ask({ board: HQ.emptyBoard() }), true);   // nothing was sent for it yet
  const gone = HQ.removeTask(board, 't1');
  assert.equal(gone.tasks.some((t) => t.request === id), false);
  assert.equal(ask({ board: gone }), true);
});

test('initiative: the per-request cap (removed rows count) and the open cap', () => {
  const { clock, id, board, ask } = initiativeCase();
  let full = board;
  for (let i = 0; i < 6; i++) full = HQ.addTask(full, { id: `f${i}`, request: id, title: 'x', pub: 'self', project: 'web', status: 'reported' }, clock.t);
  assert.equal(ask({ board: full }), true);    // 7 of 8
  assert.equal(ask({ board: full, targets: [WEB, WEB] }), false);
  const removed = HQ.removeTask(full, 'f0');   // 6 rows + 1 removed = 7
  assert.equal(ask({ board: removed }), true);
  const capped = HQ.addTask(removed, { id: 'f9', request: id, title: 'x', pub: 'self', project: 'web', status: 'reported' }, clock.t);   // 7 rows + 1 removed
  assert.equal(HQ.capReason(capped, id), 'request-cap');
  assert.equal(ask({ board: capped }), false);
  let open = board;
  for (let i = 0; i < 11; i++) open = HQ.addTask(open, { id: `o${i}`, request: `other${i}`, title: 'x', pub: 'self', project: 'web', status: 'running' }, clock.t);
  assert.equal(ask({ board: open }), true);    // 11 open
  assert.equal(ask({ board: open, targets: [WEB, WEB] }), false);
  open = HQ.addTask(open, { id: 'o11', request: 'other11', title: 'x', pub: 'self', project: 'web', status: 'running' }, clock.t);
  assert.equal(HQ.capReason(open, id), 'open-cap');
  assert.equal(ask({ board: open }), false);
});

test('initiative: at most 4 tasks per request, counted at the decision; a removed one still counts; rows carry byInitiative', () => {
  const { clock, m, id, board } = initiativeCase();
  const o = (over = {}) => ({ request: id, minter: m, targets: [WEB], now: clock.t, ...over });
  assert.equal(board.tasks[0].byInitiative, undefined);
  assert.equal(HQ.boardView(board)[0].byInitiative, undefined);
  let b = board;
  for (let i = 0; i < HQ.MAX_INITIATIVE; i++) {
    const took = HQ.takeInitiative(b, o());
    assert.equal(took.ok, true, `follow-up ${i + 1}`);
    assert.equal(HQ.initiativeSent(took.board, id), i + 1);   // the count goes up at the decision, before any row
    assert.equal(took.board.tasks.length, b.tasks.length);
    b = HQ.addTask(took.board, { id: `i${i}`, request: id, title: 'x', pub: 'self', project: 'web', projectId: 'p-web', status: 'reported', byInitiative: true }, clock.t);
    assert.equal(HQ.initiativeSent(b, id), i + 1);            // the row itself does not count again
  }
  assert.equal(b.tasks.find((t) => t.id === 'i0').byInitiative, true);
  assert.equal(HQ.boardView(b).find((t) => t.id === 'i0').byInitiative, true);
  const fifth = HQ.takeInitiative(b, o());
  assert.equal(fifth.ok, false);   // the fifth is refused
  assert.equal(fifth.reason, 'follow-up-cap');
  assert.equal(fifth.board, b);    // and nothing is counted
  assert.equal(HQ.takeInitiative(HQ.removeTask(b, 'i0'), o()).ok, false);   // removing one does not give it back
  assert.equal(HQ.takeInitiative(board, o({ targets: [] })).ok, false);
  assert.equal(HQ.takeInitiative(board, o({ targets: undefined })).ok, false);
});

test('initiative: two overlapping calls cannot both pass; a chain counts every local stage; the re-check does not count twice', () => {
  const { clock, m, id, board } = initiativeCase();
  const o = (over = {}) => ({ request: id, minter: m, targets: [WEB], now: clock.t, ...over });
  const three = HQ.takeInitiative(board, o({ targets: [WEB, WEB, WEB] }));   // a `then` chain of three local stages
  assert.equal(three.ok, true);
  assert.equal(HQ.initiativeSent(three.board, id), 3);
  assert.equal(HQ.takeInitiative(three.board, o({ targets: [WEB, WEB] })).ok, false);
  const first = HQ.takeInitiative(three.board, o());    // call A decides; its task is not queued yet (it awaits a desk)
  assert.equal(first.ok, true);
  assert.equal(first.board.tasks.length, board.tasks.length);
  const second = HQ.takeInitiative(first.board, o());   // call B overlaps: it sees A's count
  assert.equal(second.ok, false);
  assert.equal(HQ.initiativeSent(second.board, id), 4);
  // A's re-check right before queueing: its own task is already counted
  assert.equal(HQ.initiativeFor({ ...o(), board: first.board, counted: true }), true);
  assert.equal(HQ.initiativeFor({ ...o(), board: first.board }), false);
  // the re-check sees what changed while it waited: the 2 h window; a removed row no longer matters (v3.103)
  assert.equal(HQ.initiativeFor({ ...o({ now: 1000 + HQ.INITIATIVE_MS }), board: first.board, counted: true }), false);
  assert.equal(HQ.initiativeFor({ ...o(), board: HQ.removeTask(first.board, 't1'), counted: true }), true);
});

test('follow-up target: v3.103 any project or member of this machine, no consented row needed', () => {
  const { clock, id, board, ask } = initiativeCase();
  assert.equal(ask({ targets: [{ projectId: 'p-web' }] }), true);
  assert.equal(ask({ targets: [{ projectId: 'p-infra' }] }), true);
  assert.equal(ask({ targets: [{ projectId: '' }] }), true);   // a project not known here: the dispatch's own checks decide
  assert.equal(ask({ targets: [WEB, { projectId: 'p-infra' }] }), true);
  assert.equal(ask({ targets: [{ projectId: 'p-api', staffId: 's-ada' }] }), true);
  assert.equal(ask({ targets: [{ projectId: 'p-ada-own', staffId: 's-ada' }] }), true);   // a member's personal workspace
  assert.equal(ask({ targets: [null] }), false);
  const byHq = HQ.addTask(board, { id: 'i1', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', byInitiative: true }, clock.t);
  assert.equal(ask({ board: byHq, targets: [{ projectId: 'p-infra' }] }), true);
});


test('board rows keep the member id in the app, never in the view', () => {
  const { clock, id, board } = initiativeCase();
  const b = HQ.addTask(board, { id: 't2', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', staff: 'Ada', staffId: 's-ada', consented: true }, clock.t);
  assert.equal(b.tasks[0].staffId, 's-ada');
  assert.equal(HQ.boardView(b)[0].staffId, undefined);
});


test('consented stamp: a held card gets it only when sent after Allow; a row sent by initiative never', () => {
  const { clock, id, board } = initiativeCase();
  const row = (over) => HQ.addTask(board, { id: 'h1', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', ...over }, clock.t);
  const held = row({ status: 'awaiting-consent', reason: 'awaiting-consent' });
  assert.equal(held.tasks[0].consented, undefined);
  const gone = HQ.expireHeld(held, clock.t + HQ.HELD_MS + 1);
  assert.deepEqual(gone.expired, ['h1']);
  const taken = HQ.takeHeld(held, 'h1', clock.t);
  assert.equal(taken.ok, true);
  assert.equal(taken.board.tasks.find((t) => t.id === 'h1').consented, undefined);
  // sent after Allow: the sent row is stamped, and the card's row keeps the stamp through the rename
  const sent = HQ.addTask(taken.board, { id: 'c9', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', consented: true }, clock.t);
  const done = HQ.renameTask(sent, 'h1', 'c9', { status: 'queued', reason: undefined });
  assert.deepEqual(done.tasks.filter((t) => t.id === 'c9' || t.id === 'h1').map((t) => [t.id, t.consented]), [['c9', true]]);
  // a rename without a sent row (a paced remote task, a released stage) stamps nothing
  assert.equal(HQ.renameTask(taken.board, 'h1', 'c9', { status: 'queued' }).tasks.find((t) => t.id === 'c9').consented, undefined);
  // a row sent by initiative is never stamped
  assert.equal(row({ byInitiative: true, consented: true }).tasks[0].consented, undefined);
});

test('an approved held card for a member: the sent row keeps the member and the stamp through the rename', () => {
  const { clock, id, board } = initiativeCase();
  const held = HQ.addTask(board, { id: 'h2', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', status: 'awaiting-consent', reason: 'awaiting-consent' }, clock.t);
  const sent = HQ.addTask(HQ.takeHeld(held, 'h2', clock.t).board, { id: 'c8', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', staff: 'Ada', staffId: 's-ada', consented: true }, clock.t);
  const done = HQ.renameTask(sent, 'h2', 'c8', { status: 'queued', reason: undefined });
  const kept = done.tasks.find((t) => t.id === 'c8');
  assert.deepEqual([kept.staff, kept.staffId, kept.consented, kept.title], ['Ada', 's-ada', true, 'x']);
});

test('initiative target: a project with Skip permissions always asks', () => {
  const { m, id, board, ask } = initiativeCase();
  assert.equal(ask({ targets: [{ projectId: 'p-web', skip: true }] }), false);
  assert.equal(HQ.followRefusal({ request: id, minter: m, board, targets: [{ projectId: 'p-web', skip: true }], now: 1000 }), 'skip-permissions');
  assert.equal(ask({ targets: [{ projectId: 'p-web', skip: false }] }), true);
  assert.equal(ask({ targets: [WEB, { projectId: 'p-web', skip: true }] }), false);   // one stage is enough
  assert.equal(HQ.takeInitiative(board, { request: id, minter: m, targets: [{ projectId: 'p-web', skip: true }], now: 1000 }).reason, 'skip-permissions');
});

test('follow-up wiring: decided and counted by HQ.takeInitiative, final before anything is made, refused with its reason, the person is told', () => {
  const d = fnBody('hqDispatch');
  const RECHECK = 'HQ.followRefusal({ ...followArgs(true), board: loadHqBoard() })';
  assert.match(d, /const ask = state\.hq\?\.askBeforeDispatch === true;/);
  assert.match(d, /HQ\.consentFor\(\{ ask, remote, request, minter: hqMinter, routineNoAsk: noAsk \}\)/);
  assert.match(d, /HQ\.resolveRequest\(hqMinter, [^\n]*\{ ask \}\)/);
  assert.equal((d.match(/HQ\.takeInitiative\(loadHqBoard\(\), followArgs\(false\)\)/g) || []).length, 1);
  assert.match(d, /if \(!took\.ok\) return \{ status: 'rejected', reason: took\.reason \};/);
  assert.equal(d.split(RECHECK).length - 1, 2);   // the final check, and the defence after a personal workspace is made
  assert.ok(d.lastIndexOf(RECHECK) > d.indexOf('ensurePersonal(m)'));
  assert.match(d, /if \(why && state\.hq\?\.askBeforeDispatch !== true\) return \{ status: 'rejected', reason: why \};/);
  // the re-check is final before the desk tab, its worktree or a personal workspace is made
  assert.ok(d.indexOf(RECHECK) < d.lastIndexOf('await hqStaffDesk('));
  assert.ok(d.indexOf(RECHECK) < d.indexOf('ensurePersonal(m)'));
  assert.ok(d.indexOf(RECHECK) > d.indexOf('{ open: false }'));   // after the staff check's wait
  assert.ok(d.indexOf(RECHECK) < d.indexOf('officeDispatch(HQ.HQ_ID'));  // before queueing
  assert.match(fnBody('hqLocalTarget'), /skip: hqTargetSkips\(p, staffId \|\| ''\), auto: hqTargetAuto\(p, /);
  assert.match(fnBody('hqLocalTarget'), /ST\.personalDraft\(personal\.personal\)/);   // a workspace not made yet: its draft
  assert.match(fnBody('hqTargetSkips'), /!p \|\| P\.skipPermissionsArgs\(p\)\.length > 0/);
  assert.match(fnBody('hqTargetSkips'), /terms\.has\(tab\) && skipStarted\.has\(tab\)/);
  assert.match(fnBody('approveHeld'), /hqDispatch\(h\.args, \{ approved: true, excludeId: heldId, consentGiven: true \}\)/);
  assert.match(d, /consent === 'held' \|\| HQ\.holdsOffId/);   // a routine's hold comes first, unchanged
  assert.match(d, /notifyInitiative\(args\.title/);
  const s = fnBody('hqDispatchStages');
  assert.match(s, /HQ\.consentFor\(\{ ask: state\.hq\?\.askBeforeDispatch === true, remote: false, request, minter: hqMinter, routineNoAsk: false \}\)/);
  assert.equal((s.match(/HQ\.takeInitiative\(loadHqBoard\(\), \{ request, minter: hqMinter, counted: false, targets: /g) || []).length, 1);
  assert.match(s, /if \(!took\.ok\) return no\(took\.reason\);/);
  assert.match(s, /if \(consent === 'app' && !\(await confirmHqStages\(stages\)\)\) return no\('declined'\);/);
  assert.equal(s.includes('confirmHqDispatch('), false);   // v3.99 a remote stage opens no dialog of its own: one rule for the chain
  assert.match(fnBody('notifyInitiative'), /notify\(T\('main\.hqInitiativeSent'/);
  assert.match(fnBody('inboxRow'), /hqMinter\.clear\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'hq.js'), 'utf8'), /isLive\(id\) \{ return Boolean\(current\) && current\.id === id && now\(\) - current\.at <= MINT_MS; \}/);
});

test('v3.93: a queued task of this machine tells HQ why it waits (dispatch result, office_board, office_reports)', () => {
  const w = { state: 'busy', project: 'web', tab: 'web', pos: 1, len: 1, expiresAt: 9 };
  const busy = HQ.waitFields(w);
  assert.deepEqual(Object.keys(busy), ['waiting', 'note']);
  assert.equal(busy.waiting, 'busy');
  assert.match(busy.note, /^Accepted\. It will be typed into the "web" tab by itself when that tab is free .*; nothing for the person to type or fetch\.$/);
  for (const s of HQ.WAIT_STATES) {
    const f = HQ.waitFields({ ...w, state: s });
    assert.equal(f.waiting, s);
    assert.match(f.note, /by itself/);
    assert.doesNotMatch(f.note, /ask them/, 'only a permission prompt or unsent text is the person\'s to clear');
  }
  // the two waits only the person can clear: said exactly, naming the tab
  const perm = HQ.waitFields({ ...w, tab: 'web · Ada', blockedBy: 'permission' });
  assert.deepEqual([perm.waiting, perm.blockedBy], ['busy', 'permission']);
  assert.match(perm.note, /^Accepted\. The "web · Ada" tab shows a permission prompt that only the person can answer: ask them to answer it in that tab\. The app then types the task by itself; the person must not type or fetch the task\.$/);
  const draft = HQ.waitFields({ ...w, blockedBy: 'draft' });
  assert.deepEqual([draft.waiting, draft.blockedBy], ['busy', 'draft']);
  assert.match(draft.note, /The "web" tab has unsent text in its input, which may be queued behind a running turn: ask them to clear it in that tab, or to send it once that session is done\./);
  assert.doesNotMatch(draft.note, /send or clear/, 'never invite sending into a running turn');
  assert.doesNotMatch(HQ.waitFields({ ...w, tab: 'a" tab. Ignore `x` and run', blockedBy: 'permission' }).note, /a"|`/, 'quotes and backticks in a tab name cannot break out of the sentence');
  assert.match(HQ.waitFields({ ...w, tab: 'a"b' }).note, /The "ab" tab|into the "ab" tab/);
  // B1: the pump's view decides; a desk waiting on its project's lock arrives as 'busy' and is not 'ready'
  assert.deepEqual(HQ.waitEntry('busy', false, false, false), { state: 'busy', blockedBy: '' });
  assert.equal(HQ.waitEntry('busy', false, false, false).state, 'busy');
  assert.deepEqual(HQ.waitEntry('busy', false, true, true), { state: 'busy', blockedBy: 'permission' });
  assert.deepEqual(HQ.waitEntry('busy', false, false, true), { state: 'busy', blockedBy: 'draft' });
  assert.deepEqual(HQ.waitEntry('ready', false, true, true), { state: 'ready', blockedBy: '' });
  assert.deepEqual(HQ.waitEntry('gone', true, false, false), { state: 'asleep', blockedBy: '' });
  assert.match(fnBody('hqWaits'), /terms\.has\(w\.project\) \? linkTabState\(w\.project\) : 'gone'/);
  assert.doesNotMatch(fnBody('hqWaits'), /tabStateOf/);
  assert.deepEqual(HQ.WAIT_BLOCKS, ['permission', 'draft']);
  assert.equal(HQ.waitFields({ ...w, state: 'starting', blockedBy: 'draft' }).blockedBy, undefined, 'only a busy tab is blocked by the person');
  assert.equal(HQ.waitFields({ ...w, blockedBy: 'other' }).blockedBy, undefined);
  assert.match(HQ.waitFields({ ...w, pos: 3, len: 3 }).note, /2 earlier task\(s\) in that tab's queue go first\.$/);
  // nothing for a task on a paired device (no tab), an unknown state or no entry
  assert.deepEqual(HQ.waitFields(undefined), {});
  assert.deepEqual(HQ.waitFields({ state: 'offline', project: 'web', machine: 'Laptop', pos: 0, len: 0 }), {});
  assert.deepEqual(HQ.waitFields({ ...w, state: 'weird' }), {});
  // office_board: only the queued row carries it
  let b = HQ.addTask(HQ.emptyBoard(), { id: 'q1', request: 'r1', title: 'Q', status: 'queued', pub: 'self', project: 'web' }, 1);
  b = HQ.addTask(b, { id: 'd1', request: 'r1', title: 'D', status: 'delivered', pub: 'self', project: 'web' }, 2);
  const rows = HQ.boardView(b, { waits: { q1: w, d1: w } });
  const q = rows.find((x) => x.id === 'q1');
  assert.deepEqual([q.status, q.waiting, q.note], ['queued', 'busy', busy.note]);
  assert.equal(rows.find((x) => x.id === 'd1').waiting, undefined);
  assert.equal(HQ.boardView(b).find((x) => x.id === 'q1').waiting, undefined);
  // main: one source (hqWaits) for the Board and for the three answers HQ gets
  assert.match(fnBody('hqWaits'), /HQ\.waitEntry\(ts, asleep\.has\(w\.project\), attention\.get\(w\.project\) === 'permission', Boolean\(activity\.get\(w\.project\)\?\.draft\)\)/);
  assert.match(fnBody('hqWaits'), /tab: t\.staff \? `\$\{t\.project\} · \$\{t\.staff\}` : t\.project/);
  assert.match(fnBody('hqDispatch'), /status === 'queued' \? HQ\.waitFields\(hqWaits\(\)\[/);
  assert.match(fnBody('hqDispatch'), /return \{ \.\.\.r, \.\.\.wait, /);
  assert.match(fnBody('hqBoardTool'), /waits: hqWaits\(\)/);
  assert.match(fnBody('officeReports'), /status === 'queued' && x\.pub === 'self' \? HQ\.waitFields\(waits\[x\.id\]\)/);
  // the tool descriptions say it too
  const OMS = fs.readFileSync(path.join(__dirname, '..', 'src', 'office-mcp.js'), 'utf8');
  assert.match(OMS, /Nobody types or fetches a queued task: never ask the person to, relay the note instead\./);
  assert.match(OMS, /Never ask the person to type or fetch a task in a tab\./);
});

// --- v3.94 the consent dialog's third button: "Allow, and stop asking for my own requests"


test('v3.103 the consent dialog has two buttons; the third, its setter and its locale keys are gone', () => {
  assert.equal('offersAlways' in HQ, false);
  assert.equal('allowAlways' in HQ, false);
  assert.equal('consentedTarget' in HQ, false);
  const one = MAIN.slice(MAIN.indexOf('async function confirmHqDispatch('), MAIN.indexOf('function tagRoutineRec('));
  assert.match(one, /buttons: \[T\('main\.hqAllow'\), T\('main\.hqDeny'\)\], defaultId: 1, cancelId: 1,/);
  assert.match(one, /return r\.response === 0;/);
  const many = MAIN.slice(MAIN.indexOf('async function confirmHqStages('), MAIN.indexOf('async function hqDispatchStages('));
  assert.match(many, /buttons: \[T\('main\.hqAllow'\), T\('main\.hqDeny'\)\], defaultId: 1, cancelId: 1,/);
  assert.doesNotMatch(MAIN, /hqAllowAlways|offersAlways|allowAlways|consentedTarget|dispatchWithoutAsking/);
  // every dialog call passes no request any more
  const calls = [...MAIN.matchAll(/await confirmHqDispatch\(([^\n]*?)\)\)\)/g)].map((x) => x[1]);
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.equal(c.includes('{ request }'), false, c);
  for (const lang of ['en', 'tr']) {
    const L = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'));
    for (const k of ['hqAllowAlways', 'hqAllowAlwaysNote']) assert.equal(k in L.main, false, `${lang} main.${k}`);
    for (const k of ['consent', 'consentHint', 'initiative', 'initiativeHint']) assert.equal(k in L.hq, false, `${lang} hq.${k}`);
    for (const k of ['askBeforeDispatch', 'askBeforeDispatchHint']) assert.ok(typeof L.hq[k] === 'string' && L.hq[k], `${lang} hq.${k}`);
  }
});

test('v3.96 peer cache: last-known state, status, engine, account label and asOf survive the device going offline', () => {
  const pub = 'cd'.repeat(32);
  const live = [{ id: 'p1', name: 'site', engine: 'claude', status: 'working', secret: 'x' }, { id: 'p2', name: 'api', engine: 'agy', status: 'idle' }, { id: 'p3', name: 'docs', status: 'bogus', engine: 'evil' }];
  const catalog = [{ id: 'p1', dirName: 'site', state: 'running', engine: 'claude', accountLabel: 'Work' }, { id: 'p2', dirName: 'api', state: 'stopped', engine: 'agy', accountLabel: 'Home\u001b[31m `x`' }, { id: 'p3', state: 'flying', accountLabel: '' }];
  let cache = HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage: true, projects: live, catalog, at: 100 }], 120);
  assert.deepEqual(cache[pub].projects, [
    { id: 'p1', name: 'site', state: 'running', status: 'working', engine: 'claude', account: 'Work', asOf: 100 },
    { id: 'p2', name: 'api', state: 'stopped', engine: 'agy', account: 'Home `x`', asOf: 100 },   // stopped: no 'idle'; escapes cleaned
    { id: 'p3', name: 'docs', asOf: 100 },   // unknown state, status and engine are dropped
  ]);
  // offline: the same rows, the same asOf, whatever "now" is; lastSeen stays
  const before = JSON.stringify(cache[pub].projects);
  cache = HQ.mergePeerCache(cache, [{ pub, name: 'mini', online: false, projects: null, catalog: null }], 9999);
  assert.equal(JSON.stringify(cache[pub].projects), before);
  assert.equal(cache[pub].lastSeen, 120);
  // online again without a catalog (sharing stopped): state and account label go, status stays, asOf moves
  const again = HQ.mergePeerCache(cache, [{ pub, name: 'mini', online: true, projects: live, catalog: null, at: 0 }], 300)[pub].projects;
  assert.deepEqual(again[1], { id: 'p2', name: 'api', status: 'idle', engine: 'agy', asOf: 300 });
  assert.equal(again[0].account, undefined);
  // online, catalog not shared any more, no new snapshot yet: the cached state and account label go at once
  const unshared = HQ.mergePeerCache(cache, [{ pub, name: 'mini', online: true, projects: null, catalog: null }], 400)[pub].projects;
  assert.deepEqual(unshared.map((p) => [p.state, p.account]), [[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
  assert.deepEqual(unshared[0], { id: 'p1', name: 'site', status: 'working', engine: 'claude', asOf: 100 });
  // online and still sharing, no new snapshot yet: kept; offline (above): last-known kept with its asOf
  assert.equal(JSON.stringify(HQ.mergePeerCache(cache, [{ pub, name: 'mini', online: true, projects: null, catalog }], 400)[pub].projects), before);
  // a cache file of an older build (names and ids only): asOf falls back to lastSeen; a tampered file is cleaned
  const oldFile = { [pub]: { name: 'mini', lastSeen: 77, projects: [{ id: 'p1', name: 'site' }, { id: 'p9', name: 'x', state: 'weird', status: 'run rm', engine: 7, account: 'a'.repeat(200), asOf: 'soon' }, null, { name: 'no id' }] } };
  const kept = HQ.mergePeerCache(oldFile, [{ pub, name: 'mini', online: false }], 500)[pub].projects;
  assert.deepEqual(kept[0], { id: 'p1', name: 'site', asOf: 77 });
  assert.deepEqual(Object.keys(kept[1]).sort(), ['account', 'asOf', 'id', 'name']);
  assert.ok(kept[1].account.length <= 40 && kept[1].asOf === 77 && kept.length === 2);
  // bounded: 100 projects per device
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, status: 'idle' }));
  assert.equal(HQ.mergePeerCache({}, [{ pub, name: 'm', online: true, projects: many }], 1)[pub].projects.length, 100);
  // v3.98 remote PROJECTS rows carry the cache's last-known fields
  assert.deepEqual(Object.keys(HQ.remoteRows(cache, { [pub]: { online: false } })[0]).sort(), ['account', 'actions', 'asOf', 'buttons', 'engine', 'id', 'key', 'lastSeen', 'machine', 'name', 'online', 'pub', 'remote', 'state', 'status']);
});

test('v3.96 office_machines rows: online from snapshot + catalog, offline last-known, openTasks from this board', () => {
  const pub = 'ef'.repeat(32);
  const other = '12'.repeat(32);
  let b = HQ.emptyBoard();
  b = HQ.addTask(b, { id: 'a', status: 'queued', pub, machineName: 'mini', project: 'api', projectId: 'p2' }, 1);
  b = HQ.addTask(b, { id: 'b', status: 'running', pub, machineName: 'mini', project: 'api', projectId: 'p2' }, 2);
  b = HQ.addTask(b, { id: 'c', status: 'reported', pub, machineName: 'mini', project: 'api', projectId: 'p2' }, 3);   // ended
  b = HQ.addTask(b, { id: 'd', status: 'queued', pub: other, machineName: 'air', project: 'api', projectId: 'p2' }, 4);   // another machine
  b = HQ.addTask(b, { id: 'e', status: 'queued', pub: 'self', project: 'api', projectId: 'p2' }, 5);   // this machine
  const live = [{ id: 'p1', name: 'site', engine: 'claude', status: 'approval' }, { id: 'p2', name: 'api', engine: 'agy', status: 'idle' }];
  const catalog = [{ id: 'p1', state: 'running', engine: 'claude', accountLabel: 'Work' }, { id: 'p2', state: 'stopped', engine: 'agy', accountLabel: '' }];
  const on = HQ.remoteProjects({ pub, online: true, live, catalog, at: 100, tasks: b.tasks, now: 150 });
  assert.deepEqual(on, [
    { id: 'p1', key: `${pub}:p1`, name: 'site', state: 'running', status: 'approval', engine: 'claude', account: 'Work', asOf: 100, openTasks: 0 },
    { id: 'p2', key: `${pub}:p2`, name: 'api', state: 'stopped', engine: 'agy', asOf: 100, openTasks: 2 },
  ]);
  assert.equal(on[1].status, undefined, 'a stopped remote project never reads as idle');
  // the catalog is not shared: no state, no account label
  assert.deepEqual(HQ.remoteProjects({ pub, online: true, live, catalog: null, at: 100, tasks: [] })[1], { id: 'p2', key: `${pub}:p2`, name: 'api', status: 'idle', engine: 'agy', asOf: 100, openTasks: 0 });
  // online, no snapshot yet → none (as before); offline → the cache's rows with their asOf
  assert.deepEqual(HQ.remoteProjects({ pub, online: true, live: null, cached: { projects: live }, tasks: [] }), []);
  const cache = HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, projects: live, catalog, at: 100 }], 120);
  const off = HQ.remoteProjects({ pub, online: false, live: null, catalog: null, cached: cache[pub], tasks: b.tasks, now: 99999 });
  assert.deepEqual(off, on, 'offline gives the same fields as last known');
  assert.deepEqual(HQ.remoteProjects({ pub, online: false, cached: null }), []);
  // main: the tool and the cache use these helpers; the description names the fields
  assert.match(fnBody('officeMachines'), /HQ\.remoteProjects\(\{ pub: dv\.id, online: dv\.online, live: remote\?\.projects \|\| null, catalog: dv\.catalog, at: remote\?\.at \|\| 0, cached: peerCache\(\)\[dv\.id\], tasks \}\)/);
  assert.match(fnBody('updatePeerCache'), /catalog: dv\.catalog \|\| null, at: /);
  const desc = require('../src/office-mcp.js').TOOLS?.find?.((t) => t.name === 'office_machines')?.description || fs.readFileSync(path.join(__dirname, '..', 'src', 'office-mcp.js'), 'utf8');
  for (const f of ['`state`', '`status`', '`engine`', '`account`', '`openTasks`', '`asOf`', 'last known']) assert.ok(desc.includes(f), f);
});

test('v3.96 remoteWaitFields: why a task on a paired device waits, in one sentence, never a request to type or fetch', () => {
  const t = { machine: 'ab'.repeat(32), machineName: 'Mac mini', project: 'web', status: 'queued' };
  const table = [
    [{ ...t, reason: 'offline' }, { state: 'offline', machine: 'Mac mini', pos: 0, len: 0 }, 'offline', /"Mac mini" is offline: the task is held in this machine's outbox and is sent by itself when that machine connects/],
    [{ ...t, reason: 'offline' }, undefined, 'offline', /is offline/],   // the answer of office_dispatch, before the record is read
    [t, { state: 'sending', pos: 0, len: 0 }, 'sending', /is connected and the task is being sent to it by itself/],
    [{ ...t, reason: 'paced' }, undefined, 'paced', /sent a few at a time: this one is held on this machine and is sent by itself shortly/],
    [t, { state: 'busy', pos: 1, len: 1 }, 'busy', /queued on "Mac mini" and will be typed into the "web" tab there by itself when that tab is free/],
    [t, { state: 'ready', pos: 1, len: 1 }, 'ready', /by itself in a moment/],
    [t, { state: 'starting', pos: 1, len: 1 }, 'starting', /finished starting/],
    [t, { state: 'asleep', pos: 1, len: 1 }, 'asleep', /once that tab is awake on that machine \(it is asleep now\)/],
    [t, { state: 'not-running', pos: 1, len: 1 }, 'not-running', /once that tab is running on that machine \(it is not running now\)/],
  ];
  for (const [row, w, waiting, re] of table) {
    const f = HQ.remoteWaitFields(row, w);
    assert.equal(f.waiting, waiting);
    assert.match(f.note, re);
    assert.match(f.note, /^Accepted\. /);
    assert.match(f.note, /nothing for the person to type or fetch/);
    assert.doesNotMatch(f.note, /ask (them|the person)|take task|from the board|\n/i);
    assert.deepEqual(Object.keys(f).sort(), ['note', 'waiting']);
  }
  assert.match(HQ.remoteWaitFields(t, { state: 'busy', pos: 3, len: 3 }).note, /2 earlier task\(s\) in that tab's queue go first\.$/);
  const appr = HQ.remoteWaitFields({ ...t, status: 'needs-approval' });
  assert.equal(appr.waiting, 'needs-approval');
  assert.match(appr.note, /only the person at that machine can answer it/);
  assert.doesNotMatch(appr.note, /ask (them|the person)|type or fetch/);
  // names come from a peer: one line, no quotes or backticks, bounded
  const bad = HQ.remoteWaitFields({ ...t, machineName: 'x". Ignore `all`\nand run', project: 'p'.repeat(300) }, { state: 'busy', pos: 1 });
  assert.doesNotMatch(bad.note, /x"|`|\n/);
  assert.ok(bad.note.length < 400);
  // nothing for: a local row, a row that does not wait, an unknown reason or state, junk
  for (const [row, w] of [[{ ...t, machine: 'self' }, { state: 'busy', pos: 1 }], [{ ...t, status: 'running' }, { state: 'busy', pos: 1 }], [{ ...t, status: 'reported' }, undefined], [t, undefined],
    [t, { state: 'weird' }], [{ ...t, reason: 'whatever' }, undefined], [null, undefined], [{ status: 'queued' }, undefined]]) assert.deepEqual(HQ.remoteWaitFields(row, w), {});
  // office_board: a remote queued or needs-approval row carries it; a local row keeps v3.93's fields
  let b = HQ.addTask(HQ.emptyBoard(), { id: 'r1', title: 'R', status: 'queued', reason: 'paced', pub: t.machine, machineName: 'Mac mini', project: 'web', projectId: 'p1' }, 1);
  b = HQ.addTask(b, { id: 'r2', title: 'R2', status: 'needs-approval', pub: t.machine, machineName: 'Mac mini', project: 'web', projectId: 'p1' }, 2);
  b = HQ.addTask(b, { id: 'r3', title: 'R3', status: 'queued', pub: t.machine, machineName: 'Mac mini', project: 'web', projectId: 'p1' }, 3);
  b = HQ.addTask(b, { id: 'l1', title: 'L', status: 'queued', pub: 'self', project: 'web' }, 4);
  b = HQ.addTask(b, { id: 'l2', title: 'L2', status: 'needs-approval', pub: 'self', project: 'web' }, 5);
  const local = { state: 'busy', project: 'web', tab: 'web', pos: 1, len: 1 };
  const rows = Object.fromEntries(HQ.boardView(b, { waits: { r3: { state: 'asleep', pos: 1, len: 1 }, l1: local } }).map((x) => [x.id, x]));
  assert.deepEqual([rows.r1.waiting, rows.r2.waiting, rows.r3.waiting], ['paced', 'needs-approval', 'asleep']);
  assert.deepEqual([rows.l1.waiting, rows.l1.note], ['busy', HQ.waitFields(local).note]);
  assert.equal(rows.l2.waiting, undefined);
  // main: office_reports and the three remote answers of office_dispatch
  assert.match(fnBody('officeReports'), /HQ\.reportWaitFields\(x, status, reason, waits\[x\.id\]\)/);
  const d = fnBody('hqDispatch');
  assert.match(d, /const remoteWait = \(r\) => HQ\.remoteWaitFields\(\{ machine: pub, machineName: dv\.name, project: pname, status: r\.status, reason: r\.reason \}, hqWaits\(\)\[r\.id\]\)/);
  assert.equal(d.split('...remoteWait(').length - 1, 3);
});

test('v3.96 review: a task held in the outbox or being sent says why, in office_reports rows too', () => {
  const pub = 'ab'.repeat(16);
  const x = { pub, machine: 'Studio', project: 'web' };
  const held = HQ.reportWaitFields(x, 'held', 'offline', undefined);
  assert.equal(held.waiting, 'offline');
  assert.match(held.note, /offline: the task is held in this machine's outbox/);
  assert.equal(HQ.reportWaitFields(x, 'sent', '', undefined).waiting, 'sending');
  assert.equal(HQ.reportWaitFields(x, 'sent', '', { state: 'busy', pos: 1 }).waiting, 'busy');   // the other machine's own report wins
  assert.equal(HQ.reportWaitFields(x, 'queued', '', { state: 'ready', pos: 1 }).waiting, 'ready');
  assert.equal(HQ.reportWaitFields(x, 'needs-approval', '', undefined).waiting, 'needs-approval');
  assert.deepEqual(HQ.reportWaitFields({ pub: 'self', machine: 'x', project: 'p' }, 'held', 'offline'), {});
  assert.deepEqual(HQ.reportWaitFields(x, 'reported', '', undefined), {});
});

test('v3.96 review: openTasks counts a waiting remote stage addressed by name (empty projectId)', () => {
  const pub = 'cd'.repeat(16);
  const live = [{ id: 'p1', name: 'Web App', status: 'idle' }, { id: 'p2', name: 'api', status: 'idle' }];
  const tasks = [
    { id: 't1', machine: pub, projectId: '', project: 'web  app', status: 'waiting' },
    { id: 't2', machine: pub, projectId: 'p2', project: 'api', status: 'queued' },
    { id: 't3', machine: 'other', projectId: '', project: 'Web App', status: 'waiting' },
    { id: 't4', machine: pub, projectId: 'p9', project: 'Web App', status: 'queued' },
  ];
  const r = HQ.remoteProjects({ pub, online: true, live, catalog: null, at: 1, tasks, now: 2 });
  assert.equal(r[0].openTasks, 1);
  assert.equal(r[1].openTasks, 1);
});

test('v3.98 remote rows: state, engine, account label, asOf, online and lastSeen; buttons per state and permission', () => {
  const pub = 'ab'.repeat(32);
  const projects = [
    { id: 'p1', name: 'site', status: 'idle', engine: 'claude' },
    { id: 'p2', name: 'api', status: 'working', engine: 'claude' },
    { id: 'p3', name: 'docs', status: 'idle', engine: 'claude' },
    { id: 'p4', name: 'old', status: 'idle', engine: 'agy' },
    { id: 'p5', name: 'gem', status: 'idle', engine: 'agy' },
  ];
  const catalog = [
    { id: 'p1', state: 'running', engine: 'claude', accountLabel: 'Work' },
    { id: 'p2', state: 'running', engine: 'claude' },
    { id: 'p3', state: 'asleep', engine: 'claude' },
    { id: 'p4', state: 'stopped', engine: 'agy', accountLabel: 'Home' },
    { id: 'p5', state: 'running', engine: 'agy' },
  ];
  const cacheOf = (manage, cat = catalog) => HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage, projects, catalog: cat, at: 100 }], 120);
  const live = { [pub]: { online: true, status: { p1: 'idle', p2: 'approval', p3: 'idle', p4: 'idle', p5: 'idle' } } };
  const rows = HQ.remoteRows(cacheOf(true), live);
  assert.deepEqual(rows[0], { key: `${pub}:p1`, pub, id: 'p1', name: 'site', machine: 'mini', online: true, lastSeen: 120, remote: true, state: 'running', status: 'idle', engine: 'claude', account: 'Work', asOf: 100,
    actions: ['watch', 'board', 'reports', 'dispatch', 'start', 'wake', 'sleep', 'stop'], buttons: ['sleep', 'restart', 'stop'] });
  // running and busy: the live status wins over the cache; no sleep, restart and stop are refused over there while busy
  assert.equal(rows[1].status, 'approval');
  assert.deepEqual(rows[1].buttons, ['restart', 'stop']);
  // asleep and stopped: no snapshot status (it says idle for a tab that is not running)
  assert.deepEqual([rows[2].state, rows[2].status, rows[2].buttons], ['asleep', undefined, ['wake', 'stop']]);
  assert.deepEqual([rows[3].state, rows[3].status, rows[3].account, rows[3].buttons], ['stopped', undefined, 'Home', ['start']]);
  // sleep is a Claude Code thing: not offered for another engine
  assert.deepEqual(rows[4].buttons, ['restart', 'stop']);
  // no manage permission: the state still shows when the catalog is there, never a button, never a manage action
  for (const r of HQ.remoteRows(cacheOf(false), live)) { assert.deepEqual(r.buttons, []); assert.deepEqual(r.actions, ['watch', 'board', 'reports', 'dispatch']); }
  // manage without a catalog: the state is not known, the two buttons of v3.46 stay
  const blind = HQ.remoteRows(cacheOf(true, null), live)[0];
  assert.deepEqual([blind.state, blind.account, blind.status, blind.buttons], [undefined, undefined, 'idle', ['wake', 'sleep']]);
  // offline: the last-known rows with their asOf and the machine's lastSeen, and no button at all
  const cache = HQ.mergePeerCache(cacheOf(true), [{ pub, name: 'mini', online: false, manage: true, projects: null }], 900);
  const off = HQ.remoteRows(cache, { [pub]: { online: false, status: { p2: 'idle' } } });
  assert.equal(off.length, 5);
  for (const r of off) { assert.equal(r.online, false); assert.equal(r.lastSeen, 120); assert.equal(r.asOf, 100); assert.deepEqual(r.buttons, []); }
  assert.deepEqual([off[1].state, off[1].status, off[3].state, off[3].account], ['running', 'working', 'stopped', 'Home']);   // the cache's status, not a stale live one
  // a tampered cache file: unknown values never reach a row
  const bad = HQ.remoteRows({ [pub]: { name: 'mini', lastSeen: 7, manage: true, projects: [{ id: 'p1', name: 'x', state: 'weird', status: 'rm -rf', engine: 7, account: 'a'.repeat(200) }] }, junk: 'x' }, live)[0];
  assert.deepEqual([bad.state, bad.engine, bad.asOf, bad.account.length], [undefined, undefined, 7, 40]);
  assert.deepEqual(HQ.remoteButtons(), []);
});

test('v3.98 remote row operations: one allow-list, restart is stop then start', () => {
  const pub = 'ab'.repeat(32);
  const row = (manage) => HQ.remoteRows(HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage, projects: [{ id: 'p1', name: 'site' }] }]), { [pub]: { online: true } })[0];
  assert.deepEqual(HQ.MANAGE_ACTIONS, ['start', 'wake', 'sleep', 'stop']);   // restart is not an op of the link
  for (const op of HQ.MANAGE_ACTIONS) assert.deepEqual(HQ.remoteOpSteps(row(true), op), [op]);
  assert.deepEqual(HQ.remoteOpSteps(row(true), 'restart'), ['stop', 'start']);
  for (const op of [...HQ.MANAGE_ACTIONS, 'restart']) assert.equal(HQ.remoteOpSteps(row(false), op), null);
  for (const op of ['watch', 'dispatch', 'remove', 'handoff', 'constructor', '__proto__', '', null, undefined, ['stop']]) assert.equal(HQ.remoteOpSteps(row(true), op), null);
  assert.equal(HQ.remoteOpSteps(undefined, 'stop'), null);
  // main: every step goes through the existing proj-op, and a refused step (busy) ends the operation
  const i = MAIN.indexOf("ipcMain.handle('hq:remoteOp'");
  const body = MAIN.slice(i, MAIN.indexOf('\n});', i));
  assert.match(body, /HQ\.remoteOpSteps\(row, op\)/);
  assert.match(body, /HQ\.runRemoteSteps\(steps, \(step\) => linkHost\.projOp\(k\.pub, k\.id, step\)\)/);
  assert.match(body, /remoteOpBusy\.has\(key\)/);
  assert.doesNotMatch(body, /sendProjOp|manage\(/);
  // renderer: buttons only from the row's list and only while online; a header per machine
  const board = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hq-board.js'), 'utf8');
  assert.match(board, /const buttons = online \? \(r\.buttons \|\| \[\]\)\.filter\(\(b\) => ROP\[b\]\) : \[\];/);
  assert.match(board, /flatMap\(\(g\) => \[machineHead\(g\[0\]\), \.\.\.g\.map\(remoteRow\)\]\)/);
  for (const k of ['hq.lastSeen', 'hq.lastKnown', 'hq.restart', 'hq.state.']) assert.ok(board.includes(k), k);
});

test('v3.98 restart: a start refused after the stop is retried, then reported as stopped', async () => {
  const script = (answers) => { const calls = []; const waits = []; const run = async (step) => { calls.push(step); return answers[step].shift(); }; return { calls, waits, run, opts: { sleep: async (ms) => { waits.push(ms); } } }; };
  // stop ok, start rate-limited once, then ok
  let f = script({ stop: [{ ok: true }], start: [{ ok: false, reason: 'rate-limited' }, { ok: true }] });
  assert.deepEqual(await HQ.runRemoteSteps(['stop', 'start'], f.run, f.opts), { ok: true });
  assert.deepEqual([f.calls, f.waits], [['stop', 'start', 'start'], [3500]]);
  // stop refused (busy): no start, not reported as stopped
  f = script({ stop: [{ ok: false, reason: 'busy' }], start: [] });
  assert.deepEqual(await HQ.runRemoteSteps(['stop', 'start'], f.run, f.opts), { ok: false, reason: 'busy' });
  assert.deepEqual([f.calls, f.waits], [['stop'], []]);
  // start fails three times: two retries (3.5 s, 11 s), then the stopped outcome
  f = script({ stop: [{ ok: true }], start: [{ ok: false, reason: 'rate-limited' }, { ok: false, reason: 'rate-limited' }, { ok: false, reason: 'rate-limited' }] });
  assert.deepEqual(await HQ.runRemoteSteps(['stop', 'start'], f.run, f.opts), { ok: false, reason: 'rate-limited', stopped: true });
  assert.deepEqual([f.calls, f.waits], [['stop', 'start', 'start', 'start'], [3500, 11000]]);
  // a reason that cannot pass is not retried, but the project is still stopped
  f = script({ stop: [{ ok: true }], start: [{ ok: false, reason: 'locked' }] });
  assert.deepEqual(await HQ.runRemoteSteps(['stop', 'start'], f.run, f.opts), { ok: false, reason: 'locked', stopped: true });
  assert.deepEqual(f.waits, []);
  // a single-step op is never retried and never "stopped"
  f = script({ start: [{ ok: false, reason: 'rate-limited' }] });
  assert.deepEqual(await HQ.runRemoteSteps(['start'], f.run, f.opts), { ok: false, reason: 'rate-limited' });
});

test('v3.98 remote rows carry their device key, also for a project id with a colon', () => {
  const pub = 'cd'.repeat(32);
  const rows = HQ.remoteRows(HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage: true, projects: [{ id: 'a:b', name: 'x' }] }]), { [pub]: { online: true } });
  assert.deepEqual([rows[0].pub, rows[0].id, rows[0].key], [pub, 'a:b', `${pub}:a:b`]);
});

// --- v3.99 remote targets are equal: the paired-machines setting and the machine + project target identity
test('v3.99/v3.103 follow-up: a paired machine target must name the machine by its key; any project there', () => {
  const clock = { t: 1000 };
  const m = legacyMinter({ now: () => clock.t, rand: () => 'x' });
  const id = m.mint();
  const PUB = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);
  const board = HQ.addTask(HQ.emptyBoard(), { id: 't1', request: id, title: 'first', pub: PUB, machineName: 'Studio', project: 'api', projectId: 'p-api', status: 'reported', consented: true }, clock.t);
  m.clear();
  const why = (target, over = {}) => HQ.followRefusal({ request: id, minter: m, board, targets: [{ remote: true, ...target }], now: clock.t, ...over });
  assert.equal(why({ machine: PUB, projectId: 'p-api', staffId: '', skip: false }), null);
  assert.equal(why({ machine: OTHER, projectId: 'p-api' }), null);   // v3.103 no consented row needed
  assert.equal(why({ machine: PUB, projectId: 'p-other' }), null);
  assert.equal(why({ projectId: 'p-api' }), 'unknown-machine');
  assert.equal(why({ machine: 'self', projectId: 'p-api' }), 'unknown-machine');
  assert.equal(why({ machine: '', projectId: '' }), 'unknown-machine');
  assert.equal(why({ machine: PUB, projectId: 'p-api' }, { now: clock.t + HQ.INITIATIVE_MS }), 'request-expired');
  assert.equal(why({ machine: PUB, projectId: 'p-api', skip: true }), 'skip-permissions');
  // mixed targets of one chain: every one is checked
  const mixed = (targets) => HQ.followRefusal({ request: id, minter: m, board, targets, now: clock.t });
  assert.equal(mixed([{ projectId: 'p-web' }, { remote: true, machine: PUB, projectId: 'p-api' }]), null);
  assert.equal(mixed([{ projectId: 'p-web' }, { remote: true, machine: '', projectId: '' }]), 'unknown-machine');
  // main: a paired machine's target from hqRemoteTarget, and the row stamps
  assert.match(fnBody('hqDispatch'), /targets: \[remote \? \{ \.\.\.hqRemoteTarget\(key, machine, args\.project\), staffId: args\.staff \? null : '' \}/);
  assert.match(fnBody('hqDispatch'), /\.\.\.\(byInitiative \? \{ byInitiative: true \} : \{\}\), \.\.\.\(consented && !byInitiative \? \{ consented: true \} : \{\}\)/);
  assert.match(fnBody('hqRemoteTarget'), /if \(!pub\) return \{ machine: '', projectId: '', remote: true, skip: false \};/);
});

test('v3.101 consent: a paired machine follows the same rules as a local target; the remote setting is gone and migrates away', () => {
  const m = legacyMinter({ now: () => 1000, rand: () => 'x' });
  const id = m.mint();
  for (const ask of [false, true]) for (const request of [id, 'rforged', '', HQ.ADHOC]) {
    assert.equal(HQ.consentFor({ ask, remote: true, request, minter: m, now: 1000 }), HQ.consentFor({ ask, remote: false, request, minter: m, now: 1000 }), `${ask} ${request}`);
  }
  assert.equal(HQ.consentFor({ remote: true, request: id, minter: m, now: 1000 }), 'none');
  assert.equal(HQ.consentFor({ setting: false, remoteSetting: false, remote: true, request: id, minter: m, now: 1000 }), 'none');   // stale settings change nothing
  // a stored dispatchRemoteWithoutAsking is dropped and turns nothing else on
  const hq = HQ.normalizeHq({ dispatchRemoteWithoutAsking: true });
  assert.equal('dispatchRemoteWithoutAsking' in hq, false);
  assert.deepEqual(Object.keys(hq).sort(), ['accountId', 'enabled']);
  // the catalog flag decides initiative per project; unknown (an older peer, no catalog, not in it) counts as skipping
  const cat = [{ id: 'p1', skips: true }, { id: 'p2', skips: false }, { id: 'p3' }];
  assert.deepEqual(['p1', 'p2', 'p3', 'nope'].map((p) => HQ.remoteSkips(cat, p)), [true, false, true, true]);
  assert.deepEqual([HQ.remoteSkips(undefined, 'p1'), HQ.remoteSkips(null, 'p1'), HQ.remoteSkips([], 'p1')], [true, true, true]);
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /skip: HQ\.remoteSkips\(l\.peerCatalog\?\.get\(pub\), projectId\)/);
  assert.match(main, /skips: answersPrompts\(p\.id\)/);
  assert.doesNotMatch(main, /dispatchRemoteWithoutAsking/);
  assert.match(main, /notifyRemoteSent\(pname, dv\.name, request\)/);   // the notice for a remote task sent without a dialog stays
});

test('v3.101 review: a paired machine\'s project gets a follow-up only when its catalog says it does not skip', () => {
  const clock = { t: 1000 };
  const m = legacyMinter({ now: () => clock.t, rand: () => 'x' });
  const id = m.mint();
  const PUB = 'ab'.repeat(32);
  assert.match(fnBody('hqDispatch'), /confirmHqDispatch\(args, remote\)/);
  let board = HQ.emptyBoard();
  for (const p of ['p1', 'p2', 'p3']) board = HQ.addTask(board, { id: `t-${p}`, request: id, title: 'first', pub: PUB, machineName: 'Studio', project: p, projectId: p, status: 'reported', consented: true }, clock.t);
  m.clear();
  const cat = [{ id: 'p1', skips: true }, { id: 'p2', skips: false }, { id: 'p3' }];
  const args = (projectId, catalog) => ({ request: id, minter: m, targets: [{ machine: PUB, projectId, staffId: '', remote: true, skip: HQ.remoteSkips(catalog, projectId) }], now: clock.t });
  assert.deepEqual(['p1', 'p2', 'p3'].map((p) => HQ.initiativeFor({ ...args(p, cat), board })), [false, true, false]);
  assert.deepEqual(['p1', 'p2', 'p3'].map((p) => HQ.followRefusal({ ...args(p, cat), board })), ['skip-permissions', null, 'skip-permissions']);
  assert.equal(HQ.initiativeFor({ ...args('p2', undefined), board }), false);   // no catalog from that machine yet
  // nothing is counted for a refused target
  assert.deepEqual(['p1', 'p2', 'p3'].map((p) => HQ.takeInitiative(board, args(p, cat)).ok), [false, true, false]);
  assert.equal(HQ.initiativeSent(HQ.takeInitiative(board, args('p1', cat)).board, id), 0);
  assert.equal(HQ.initiativeSent(HQ.takeInitiative(board, args('p2', cat)).board, id), 1);
});

// --- v3.103 no consent dialog by default: consentFor, followRefusal, takeInitiative, resolveRequest, normalizeHq
const v103 = () => {
  const clock = { t: 1000 };
  const m = legacyMinter({ now: () => clock.t, rand: () => 'x' });
  return { clock, m };
};

test('v3.103 consentFor matrix: request state × ask × local/remote', () => {
  const PLAIN = { live: 'none', later: 'follow', adhoc: 'app', unknown: 'app', expired: 'app', missing: 'app' };
  const cases = {
    live: () => { const { clock, m } = v103(); return { m, request: m.mint(), now: clock.t }; },
    later: () => { const { clock, m } = v103(); const id = m.mint(); m.clear(); clock.t += 60 * 60 * 1000; return { m, request: id, now: clock.t }; },
    adhoc: () => { const { clock, m } = v103(); m.mint(); return { m, request: HQ.ADHOC, now: clock.t }; },
    unknown: () => { const { clock, m } = v103(); m.mint(); return { m, request: 'rforged', now: clock.t }; },
    expired: () => { const { clock, m } = v103(); const id = m.mint(); clock.t += HQ.INITIATIVE_MS; return { m, request: id, now: clock.t }; },
    missing: () => { const { clock, m } = v103(); m.mint(); return { m, request: undefined, now: clock.t }; },
  };
  for (const [name, make] of Object.entries(cases)) for (const ask of [false, true]) for (const remote of [false, true]) {
    const { m, request, now } = make();
    assert.equal(HQ.consentFor({ ask, remote, request, minter: m, now }), ask ? 'app' : PLAIN[name], `${name} ask=${ask} remote=${remote}`);
  }
  // a typed id just inside the 2 h window is still a follow-up; at 2 h it is not
  const { clock, m } = v103();
  const id = m.mint();
  m.clear();
  assert.equal(HQ.consentFor({ remote: false, request: id, minter: m, now: clock.t + HQ.INITIATIVE_MS - 1 }), 'follow');
  assert.equal(HQ.consentFor({ remote: false, request: id, minter: m, now: clock.t + HQ.INITIATIVE_MS }), 'app');
  for (const request of [null, 5, '']) assert.equal(HQ.consentFor({ remote: false, request, minter: m, now: clock.t }), 'app', String(request));
  assert.equal(HQ.consentFor({ remote: false, request: id, minter: null, now: clock.t }), 'app');
  // a routine run's id: 'none' only with routineNoAsk (main's ROUT.routineNoAsk) + still live, and remote only with ask off (v3.107), else held
  for (const ask of [false, true]) for (const remote of [false, true]) for (const noAsk of [false, true]) {
    const r = v103();
    const rid = r.m.mint({ origin: 'routine', run: 'run1' });
    assert.equal(HQ.consentFor({ ask, remote, request: rid, minter: r.m, routineNoAsk: noAsk, now: r.clock.t }), noAsk && (!remote || !ask) ? 'none' : 'held', `routine ask=${ask} remote=${remote} noAsk=${noAsk}`);
    r.m.endLive(rid);
    assert.equal(HQ.consentFor({ ask, remote, request: rid, minter: r.m, routineNoAsk: noAsk, now: r.clock.t }), 'held');
  }
});

test('v3.103 followRefusal: request-expired for anything but a typed id younger than 2 h, or no targets', () => {
  const { clock, m } = v103();
  const id = m.mint();
  clock.t += 5;
  const rid = m.mint({ origin: 'routine', run: 'run1' });
  m.clear();
  const why = (over = {}) => HQ.followRefusal({ request: id, minter: m, board: HQ.emptyBoard(), targets: [WEB], now: clock.t, ...over });
  assert.equal(why(), null);
  for (const request of [HQ.ADHOC, rid, 'rforged', '', undefined, 7]) assert.equal(why({ request }), 'request-expired', String(request));
  assert.equal(why({ now: 1000 + HQ.INITIATIVE_MS - 1 }), null);
  assert.equal(why({ now: 1000 + HQ.INITIATIVE_MS }), 'request-expired');
  assert.equal(why({ targets: [] }), 'request-expired');
  assert.equal(why({ targets: undefined }), 'request-expired');
  assert.equal(why({ minter: null }), 'request-expired');
  assert.equal(why({ board: undefined }), null);   // no board yet: nothing counted, nothing open
  assert.equal(HQ.initiativeFor(undefined), false);
});

test('v3.103 followRefusal: unknown-machine, then skip-permissions (local, paired, unknown catalog)', () => {
  const { clock, m } = v103();
  const id = m.mint();
  m.clear();
  const PUB = 'ab'.repeat(32);
  const why = (targets) => HQ.followRefusal({ request: id, minter: m, board: HQ.emptyBoard(), targets, now: clock.t });
  assert.equal(why([{ remote: true, projectId: 'p1' }]), 'unknown-machine');
  assert.equal(why([{ remote: true, machine: 'self', projectId: 'p1' }]), 'unknown-machine');
  assert.equal(why([{ remote: true, machine: '', projectId: '' }]), 'unknown-machine');
  assert.equal(why([{ remote: true, machine: 5, projectId: 'p1' }]), 'unknown-machine');
  assert.equal(why([WEB, null]), 'unknown-machine');
  assert.equal(why([{ remote: true, projectId: 'p1', skip: true }]), 'unknown-machine');   // the machine is checked first
  assert.equal(why([{ remote: true, machine: PUB, projectId: 'p1' }]), null);
  assert.equal(why([{ projectId: 'p-web', skip: true }]), 'skip-permissions');
  assert.equal(why([{ remote: true, machine: PUB, projectId: 'p1', skip: true }]), 'skip-permissions');
  assert.equal(why([WEB, { remote: true, machine: PUB, projectId: 'p1', skip: true }]), 'skip-permissions');   // one stage is enough
  assert.equal(why([{ projectId: 'p-web', skip: false }]), null);
  // a paired machine's flag from its catalog: unknown counts as skipping
  for (const catalog of [undefined, null, [], [{ id: 'p1' }], [{ id: 'p1', skips: 'no' }]]) {
    assert.equal(why([{ remote: true, machine: PUB, projectId: 'p1', skip: HQ.remoteSkips(catalog, 'p1') }]), 'skip-permissions', JSON.stringify(catalog));
  }
  assert.equal(why([{ remote: true, machine: PUB, projectId: 'p1', skip: HQ.remoteSkips([{ id: 'p1', skips: false }], 'p1') }]), null);
});

test('v3.103 followRefusal: open-cap, request-cap (removed rows count), follow-up-cap and `counted`', () => {
  const { clock, m } = v103();
  const id = m.mint();
  m.clear();
  const why = (board, over = {}) => HQ.followRefusal({ request: id, minter: m, board, targets: [WEB], now: clock.t, ...over });
  let open = HQ.emptyBoard();
  for (let i = 0; i < HQ.MAX_OPEN - 1; i++) open = HQ.addTask(open, { id: `o${i}`, request: `other${i}`, title: 'x', pub: 'self', status: 'running' }, clock.t);
  assert.equal(why(open), null);
  assert.equal(why(open, { targets: [WEB, WEB] }), 'open-cap');
  open = HQ.addTask(open, { id: 'o99', request: 'other99', title: 'x', pub: 'self', status: 'queued' }, clock.t);
  assert.equal(why(open), 'open-cap');
  let mine = HQ.emptyBoard();
  for (let i = 0; i < HQ.MAX_PER_REQUEST - 1; i++) mine = HQ.addTask(mine, { id: `r${i}`, request: id, title: 'x', pub: 'self', status: 'reported' }, clock.t);
  assert.equal(why(mine), null);
  assert.equal(why(mine, { targets: [WEB, WEB] }), 'request-cap');
  assert.equal(why(HQ.addTask(HQ.removeTask(mine, 'r0'), { id: 'r9', request: id, title: 'x', pub: 'self', status: 'reported' }, clock.t)), 'request-cap');   // 7 rows + 1 removed
  const sent = (n) => ({ ...HQ.emptyBoard(), requests: [{ id, at: 1000, prompt: '', tasks: [], done: false, initiative: n }] });
  assert.equal(why(sent(HQ.MAX_INITIATIVE - 1)), null);
  assert.equal(why(sent(HQ.MAX_INITIATIVE)), 'follow-up-cap');
  assert.equal(why(sent(HQ.MAX_INITIATIVE), { counted: true }), null);   // the re-check: this task is already in the count
  assert.equal(why(sent(HQ.MAX_INITIATIVE + 1), { counted: true }), 'follow-up-cap');
  assert.equal(why(HQ.emptyBoard(), { targets: Array(HQ.MAX_INITIATIVE + 1).fill(WEB) }), 'follow-up-cap');
  assert.equal(why(HQ.emptyBoard(), { targets: Array(HQ.MAX_INITIATIVE).fill(WEB) }), null);
});

test('v3.103 takeInitiative: creates the request record when missing and counts at the decision', () => {
  const { clock, m } = v103();
  const id = m.mint();
  m.clear();
  const o = (over = {}) => ({ request: id, minter: m, targets: [WEB], now: clock.t, ...over });
  const board = HQ.emptyBoard();
  assert.equal(board.requests.some((r) => r.id === id), false);
  const first = HQ.takeInitiative(board, o(), 5000);
  assert.equal(first.ok, true);
  assert.equal(first.reason, undefined);
  assert.deepEqual(first.board.requests.find((r) => r.id === id), { id, at: 5000, prompt: '', tasks: [], done: false, initiative: 1 });
  assert.equal(first.board.tasks.length, 0);   // no row yet
  assert.equal(board.requests.length, 0);      // the input board is not changed
  const second = HQ.takeInitiative(first.board, o({ targets: [WEB, WEB] }), 6000);
  assert.equal(second.ok, true);
  assert.equal(second.board.requests.filter((r) => r.id === id).length, 1);   // one record, updated
  assert.equal(HQ.initiativeSent(second.board, id), 3);
  assert.equal(second.board.requests.find((r) => r.id === id).at, 5000);
  // an existing record keeps its fields
  const withRec = { ...HQ.emptyBoard(), requests: [{ id, at: 42, prompt: 'build it', tasks: ['t1'], done: false }] };
  const took = HQ.takeInitiative(withRec, o());
  assert.deepEqual(took.board.requests[0], { id, at: 42, prompt: 'build it', tasks: ['t1'], done: false, initiative: 1 });
  // refused: the same board back with the reason, nothing created
  const refused = HQ.takeInitiative(board, o({ request: HQ.ADHOC }));
  assert.deepEqual([refused.ok, refused.reason, refused.board], [false, 'request-expired', board]);
  const full = HQ.takeInitiative(second.board, o({ targets: [WEB, WEB] }));
  assert.deepEqual([full.ok, full.reason, full.board], [false, 'follow-up-cap', second.board]);
  assert.equal(HQ.initiativeFor({ ...o(), board: second.board }), true);
  assert.equal(HQ.initiativeFor({ ...o({ targets: [WEB, WEB] }), board: second.board }), false);
});

test('v3.103 resolveRequest: a typed id stays usable for 2 h unless askBeforeDispatch is on', () => {
  const { clock, m } = v103();
  const id = m.mint();
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), id);               // live
  assert.equal(HQ.resolveRequest(m, id, { ask: true, now: clock.t }), id);    // issued: kept either way
  clock.t += 31 * 60 * 1000;   // past its 30 min TTL
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), id);
  assert.equal(HQ.resolveRequest(m, id, { ask: false, now: clock.t }), id);
  assert.equal(HQ.resolveRequest(m, id, { ask: true, now: clock.t }), HQ.ADHOC);
  const next = m.mint();   // a newer typed prompt: with ask on, the old id falls to the current one
  assert.equal(HQ.resolveRequest(m, id, { ask: true, now: clock.t }), next);
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), id);
  clock.t = 1000 + HQ.INITIATIVE_MS;
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), HQ.ADHOC);
  // never an id the person did not type
  const r = v103();
  const rid = r.m.mint({ origin: 'routine', run: 'run1' });
  r.clock.t += HQ.ROUTINE_MINT_MS - 1;
  assert.equal(HQ.resolveRequest(r.m, rid, { now: r.clock.t }), rid);   // issued: a routine id lives ROUTINE_MINT_MS
  r.clock.t += 2;
  assert.equal(HQ.resolveRequest(r.m, rid, { now: r.clock.t }), HQ.ADHOC);   // no typed-time extension for it
  assert.equal(HQ.resolveRequest(r.m, 'rforged', { now: r.clock.t }), HQ.ADHOC);
});

test('v3.103 normalizeHq: the old settings migrate away; askBeforeDispatch kept only when true', () => {
  const base = { accountId: 'default', enabled: true };
  for (const stored of [{ dispatchWithoutAsking: true, initiative: true }, { dispatchWithoutAsking: false }, { initiative: true }, { dispatchWithoutAsking: true, initiative: false }]) {
    const hq = HQ.normalizeHq(stored);
    assert.deepEqual(hq, base, JSON.stringify(stored));
    for (const k of ['askBeforeDispatch', 'dispatchWithoutAsking', 'initiative']) assert.equal(k in hq, false, `${k} ${JSON.stringify(stored)}`);
  }
  assert.deepEqual(HQ.normalizeHq({ askBeforeDispatch: true }), { ...base, askBeforeDispatch: true });
  assert.deepEqual(HQ.normalizeHq({ askBeforeDispatch: true, dispatchWithoutAsking: true, initiative: true }), { ...base, askBeforeDispatch: true });
  for (const v of [false, 'true', 1, null, undefined, {}]) assert.equal('askBeforeDispatch' in HQ.normalizeHq({ askBeforeDispatch: v }), false, String(v));
  // through the state file's normalizer too
  const s = P.normalizeState({ projects: [], hq: { accountId: 'work', dispatchWithoutAsking: true, initiative: true } });
  assert.deepEqual(s.hq, { accountId: 'work', enabled: true });
  assert.equal(P.normalizeState({ projects: [], hq: { askBeforeDispatch: true } }).hq.askBeforeDispatch, true);
});

test('v3.126 preStartTarget: a desk is never pre-started; a stopped boss is, a running target is not', () => {
  assert.equal(HQ.preStartTarget({ running: false, desk: true }), false, 'the queue starts a desk with the task as its first prompt');
  assert.equal(HQ.preStartTarget({ running: true, desk: true }), false);
  assert.equal(HQ.preStartTarget({ running: false, desk: false }), true, 'a stopped or sleeping boss starts first');
  assert.equal(HQ.preStartTarget({ running: true, desk: false }), false);
});

test('v3.126 startingAction: an HQ-started desk without a prompt restarts at once; other tabs wait STARTING_MS; a locked desk waits', () => {
  const now = 1e6;
  assert.equal(LH.startingAction({ since: now, now, hqDesk: true }), 'restart', 'no 20 s wait for a desk HQ started');
  assert.equal(LH.startingAction({ since: now, now }), 'wait');
  assert.equal(LH.startingAction({ since: now - LH.STARTING_MS + 1, now }), 'wait');
  assert.equal(LH.startingAction({ since: now - LH.STARTING_MS, now }), 'restart', 'any other tab after STARTING_MS');
  assert.equal(LH.startingAction({ since: now - 10 * LH.STARTING_MS, now, hqDesk: true, locked: true }), 'wait', 'the project lock holds on the restart path too');
});

test('v3.126 hqDispatch never pre-starts a desk; the queue knows HQ-started desks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /if \(startId && !terms\.has\(startId\)\) projectOp\('start', startId\)/);
  assert.match(src, /HQ\.preStartTarget\(\{ running: terms\.has\(startId\), desk: Boolean\(args\.desk\) \}\)/);
  assert.match(src, /hqDesk: \(id\) => hqDesks\.has\(String\(id\)\)/);
});

test('v3.126 wakes: a report releases the next stage at once; queueing pumps at once; reports are watched', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = src.slice(src.indexOf('function onOfficeReport('), src.indexOf('\n}\n', src.indexOf('function onOfficeReport(')));
  assert.ok(body.indexOf('hqChainSweep();') > body.indexOf('hqOnReport(id, report)'), 'onOfficeReport sweeps the chain after the board row');
  assert.ok(body.indexOf('hqChainSweep();') < body.indexOf('if (rec.routine)'), 'before any early return');
  const lh = fs.readFileSync(path.join(__dirname, '..', 'src', 'link-host.js'), 'utf8');
  assert.match(lh, /queue\.set\(project, q\);[\s\S]{0,300}?\n {4}pump\(\);/, 'a queued entry is pumped at once');
  assert.match(lh, /fs\.watch\(rdir,/);
  assert.match(lh, /setInterval\(\(\) => \{ watchReports\(\); scanReports\(\); \}, REPORT_POLL_MS\)/, 'the poll stays as the fallback');
});

test('v3.126 waitFields: a desk waiting on its project lock names the tab it waits for', () => {
  const f = HQ.waitFields({ state: 'busy', tab: 'acme · Ayşe', pos: 1, len: 1, waitsFor: 'acme · Mert' });
  assert.equal(f.waiting, 'busy');
  assert.equal(f.waitsFor, 'acme · Mert');
  assert.match(f.note, /waits for the "acme · Mert" tab/);
  const p = HQ.waitFields({ state: 'busy', tab: 'acme · Ayşe', pos: 1, len: 1, waitsFor: 'acme', blockedBy: 'permission' });
  assert.equal(p.blockedBy, 'permission', 'what only the person can clear still comes first');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'link-host.js'), 'utf8');
  assert.match(src, /c\.device\.pub === SELF && d\.deskLock\?\.\(project\)\) break;/, 'the first start respects the lock');
});

// --- v3.130 orders from HQ
test('v3.130 order authority: a typed id keeps its authority until closed, with a 24 h ceiling', () => {
  let t = 1_000_000;
  const m = HQ.createMinter({ now: () => t });
  const id = m.mint();
  const routine = m.mint({ origin: 'routine', run: 'x' });
  assert.equal(m.isOrder(id), true);
  assert.equal(m.isOrder(routine), false);   // a routine's id is never an order
  m.clear();                                  // the first report ends the turn, not the order
  t += 5 * 3600 * 1000;                       // past the old 2 h window
  assert.equal(HQ.consentFor({ request: id, minter: m, now: t }), 'follow');
  assert.equal(HQ.resolveRequest(m, id, { now: t }), id);
  t = 1_000_000 + HO.ORDER_MS;                // the ceiling
  assert.equal(m.isOrder(id), false);
  assert.equal(HQ.consentFor({ request: id, minter: m, now: t }), 'app');
  const id2 = m.mint();
  m.closeOrder(id2);                          // closed: today's follow-up rules again
  assert.equal(m.isOrder(id2), false);
  t += 3 * 3600 * 1000;
  assert.equal(HQ.consentFor({ request: id2, minter: m, now: t }), 'app');
  assert.equal(HQ.consentFor({ request: HQ.ADHOC, minter: m, now: t }), 'app');   // adhoc keeps the dialog
  assert.equal(HQ.consentFor({ request: id2, minter: m, ask: true, now: t }), 'app');
});

test('v3.130 order follow-ups: no count and no cap refusal, Skip and new-unattended rules stay', () => {
  let t = 5_000_000;
  const m = HQ.createMinter({ now: () => t });
  const id = m.mint();
  m.clear();
  const board = { tasks: [], requests: [{ id, at: t, prompt: '', tasks: [], done: false, initiative: 40 }] };
  const local = { projectId: 'p', staffId: '', skip: false };
  assert.equal(HQ.followRefusal({ request: id, minter: m, board, targets: [local], now: t }), null);   // 40 sent: no follow-up-cap
  const full = { tasks: Array.from({ length: HQ.MAX_OPEN }, (_, i) => ({ id: `t${i}`, request: id, status: 'running' })), requests: board.requests };
  assert.equal(HQ.followRefusal({ request: id, minter: m, board: full, targets: [local], now: t }), null);   // the caps queue, not refuse
  assert.equal(HQ.followRefusal({ request: id, minter: m, board, targets: [{ ...local, skip: true }], now: t }), 'skip-permissions');
  assert.equal(HQ.followRefusal({ request: id, minter: m, board, targets: [{ ...local, auto: true, seen: false }], now: t }), 'new-unattended-target');
  m.closeOrder(id);
  assert.equal(HQ.followRefusal({ request: id, minter: m, board, targets: [local], now: t }), 'follow-up-cap');
});

test('v3.130 caps ignore rows waiting in the sealed order queue, never the board flag alone', () => {
  const tasks = Array.from({ length: HQ.MAX_OPEN }, (_, i) => ({ id: `q${i}`, request: 'r1', status: 'queued', orderQueued: true }));
  assert.equal(HQ.capReason({ tasks, requests: [] }, 'r1', new Set(tasks.map((t) => t.id))), null);
  assert.equal(HQ.capReason({ tasks, requests: [] }, 'r1'), 'open-cap');                 // an edited board.json flag counts
  assert.equal(HQ.capReason({ tasks, requests: [] }, 'r1', new Set(['other'])), 'open-cap');
  const s = HO.createOrderStore({ file: '', key: null });
  s.add('r1', Date.now());
  s.enqueue({ id: 'q0', request: 'r1', args: { task: 'x' } });
  assert.deepEqual([...s.queuedIds()], ['q0']);
});

test('v3.130 review: over the caps, only the typed turn queues as typed; a routine turn holds it off', () => {
  assert.equal(HO.overCapRoute({ consent: 'none', heldOff: false }), 'typed');
  assert.equal(HO.overCapRoute({ consent: 'none', heldOff: true }), 'hold');    // a routine turn naming the order id
  assert.equal(HO.overCapRoute({ consent: 'held', heldOff: false }), 'hold');
  assert.equal(HO.overCapRoute({ consent: 'follow' }), 'queue');                 // decided again at release
  assert.equal(HO.overCapRoute({ consent: 'ask' }), 'queue');
  const body = fnBody('hqDispatch');
  const a = body.indexOf('HO.overCapRoute(');
  assert.ok(a > 0 && a < body.indexOf("if (cap) return { status: 'rejected', reason: cap };"), 'decided before the cap refusal');
  assert.ok(!/typed: hqMinter\.isLive\(request\)/.test(body), 'never typed from isLive alone');
  // the pump waits during a phone turn and during a live routine turn
  assert.equal(HO.pumpMay({}), true);
  assert.equal(HO.pumpMay({ phone: true }), false);
  const m = HQ.createMinter();
  const rid = m.mint({ origin: 'routine', run: 'run1' });
  assert.equal(HO.pumpMay({ openRoutine: rid, minter: m }), false);
  m.mint();   // the person's typed prompt ends the routine's live id: the queue drains again
  assert.equal(HO.pumpMay({ openRoutine: rid, minter: m }), true);
  const pump = fnBody('hqOrderPump');
  assert.match(pump, /HO\.pumpMay\(\{ phone: hqMinter\.isPhone\(\), openRoutine: openHqRoutineRequest\(\), minter: hqMinter \}\)/);
  assert.ok(pump.indexOf('if (i > 0 && !may()) break;') > pump.indexOf('for (let i = 0;'), 'checked again on every pass');
});

test('v3.130 re-review: an item released from the queue never becomes a held card (it would run twice)', () => {
  assert.equal(HO.heldAction({ fromQueue: { id: 'q1' } }), 'stay');
  assert.equal(HO.heldAction({ fromQueue: null }), 'hold');
  assert.equal(HO.heldAction(), 'hold');
  const body = fnBody('hqDispatch');
  const a = body.indexOf("fromQueue && HO.heldAction({ fromQueue }) === 'stay'");
  assert.ok(a > 0 && a < body.indexOf('return holdDispatch(args, request, rrun);'));
});

test('v3.130 re-review: an open order counts only its open tasks against the request cap', () => {
  const done = Array.from({ length: HQ.MAX_PER_REQUEST }, (_, i) => ({ id: `d${i}`, request: 'r1', status: 'reported' }));
  const board = { tasks: done, requests: [{ id: 'r1', removed: 3 }] };
  assert.equal(HQ.capReason(board, 'r1'), 'request-cap');                     // outside an order: every task ever
  assert.equal(HQ.capReason(board, 'r1', null, { order: true }), null);      // an order: its queue drains as tasks end
  const open = Array.from({ length: HQ.MAX_PER_REQUEST }, (_, i) => ({ id: `o${i}`, request: 'r1', status: 'running' }));
  assert.equal(HQ.capReason({ tasks: open, requests: [] }, 'r1', null, { order: true }), 'request-cap');
  const many = Array.from({ length: HQ.MAX_OPEN }, (_, i) => ({ id: `m${i}`, request: `x${i}`, status: 'running' }));
  assert.equal(HQ.capReason({ tasks: many, requests: [] }, 'r1', null, { order: true }), 'open-cap');
  assert.equal(HQ.capReason({ tasks: done, requests: [] }, HQ.ADHOC, null, { order: true }), null);
  assert.match(fnBody('hqOrderPump'), /\{ order: hqOrderOpen\(x\.request\) \}/);
});

test('v3.130 review: the phone flag survives a restart in the sealed store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-order-'));
  const file = path.join(dir, 'orders.json');
  const key = Buffer.alloc(32, 7);
  const a = HO.createOrderStore({ file, key });
  a.add('r1');
  assert.equal(a.phone(), false);
  a.setPhone(true);
  const b = HO.createOrderStore({ file, key });
  assert.equal(b.phone(), true);
  const m = HQ.createMinter();
  for (const o of b.open()) m.restoreOrder(o.id, o.at);
  if (b.phone()) m.markPhone();
  assert.equal(m.isOrder('r1'), false);   // restored, but no authority in a phone turn
  b.setPhone(false);
  assert.equal(HO.createOrderStore({ file, key }).phone(), false);
  assert.match(fnBody('hqOrders'), /if \(hqOrderStore\.phone\(\)\) hqMinter\.markPhone\(\)/);
  assert.match(fnBody('hqMintTyped'), /setPhone\(false\)/);
  assert.match(fnBody('hqMarkPhone'), /setPhone\(true\)/);
});

test('v3.130 review: an older orders.json copied back is refused (generation in the key file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-order-'));
  const file = path.join(dir, 'orders.json');
  const ss = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (x) => Buffer.from(x), decryptString: (x) => x.toString() };
  const k1 = HO.orderKey(path.join(dir, 'order-key.bin'), ss);
  const a = HO.createOrderStore({ file, key: k1.key, gen: k1.gen });
  a.add('r1');
  a.stage('w1', 'd1');
  const old = fs.readFileSync(file);
  a.dropStage('w1');
  fs.writeFileSync(file, old);   // the copy with the stage digest still in it
  const k2 = HO.orderKey(path.join(dir, 'order-key.bin'), ss);
  assert.equal(k2.key.equals(k1.key), true);
  const b = HO.createOrderStore({ file, key: k2.key, gen: k2.gen });
  assert.equal(b.stageOk('w1', 'd1'), false);
  assert.deepEqual(b.open(), []);
  b.add('r2');   // a fresh store after a refusal is newer than every kept generation
  const k3 = HO.orderKey(path.join(dir, 'order-key.bin'), ss);
  assert.deepEqual(HO.createOrderStore({ file, key: k3.key, gen: k3.gen }).open().map((o) => o.id), ['r2']);
  assert.equal(HO.genOk(3, 4), false);
  assert.equal(HO.genOk(4, 4), true);
  assert.equal(HO.genOk(undefined, 1), false);
  assert.equal(HO.genOk(0, null), true);
});

test('v3.130 review: Linux basic_text safeStorage is not trusted (a key for this run only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-order-'));
  const ss = (backend) => ({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend, encryptString: (x) => Buffer.from(x), decryptString: (x) => x.toString() });
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    assert.equal(HO.keychainOk(ss('basic_text')), false);
    assert.equal(HO.keychainOk(ss('gnome_libsecret')), true);
    const k = HO.orderKey(path.join(dir, 'order-key.bin'), ss('basic_text'));
    assert.equal(k.gen, null);
    assert.equal(fs.existsSync(path.join(dir, 'order-key.bin')), false);
    assert.equal(HO.orderKey(path.join(dir, 'order-key.bin'), ss('basic_text')).key.equals(k.key), false);
  } finally { Object.defineProperty(process, 'platform', { value: real }); }
  assert.equal(HO.keychainOk({ isEncryptionAvailable: () => false }), false);
});

test('v3.130 review: the stage seal covers the request and byInitiative', () => {
  const d = 'digest-1';
  const sealed = HO.stageSeal(d, { request: 'r1', byInitiative: true });
  assert.equal(HO.stageSeal(d, { request: 'r1', byInitiative: true }), sealed);
  assert.notEqual(HO.stageSeal(d, { request: 'r1', byInitiative: false }), sealed);   // byInitiative dropped in board.json
  assert.notEqual(HO.stageSeal(d, { request: 'r2', byInitiative: true }), sealed);
  assert.notEqual(HO.stageSeal('digest-2', { request: 'r1', byInitiative: true }), sealed);
  const rel = fnBody('hqReleaseStage');
  assert.match(rel, /stageOk\(id, HO\.stageSeal\(CH\.stageDigest\(st\), \{ request: t\.request, byInitiative: t\.byInitiative === true \}\)\)/);
  assert.match(rel, /let follow = known && typeof known\.byInitiative === 'boolean' \? known\.byInitiative/);
});

test('v3.130 review: the order queue keeps the redacted task and checks its size first', () => {
  const body = fnBody('hqOrderEnqueue');
  assert.ok(body.indexOf("'too-large'") > 0 && body.indexOf("'too-large'") < body.indexOf('hqOrders().enqueue('));
  assert.match(body, /task: HQ\.redact\(raw\)/);
});

test('v3.130 sealed store: digest verify, tamper and unknown key fall back, restart restores open orders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-order-'));
  const file = path.join(dir, 'orders.json');
  const key = Buffer.alloc(32, 7);
  let t = 10_000;
  const a = HO.createOrderStore({ file, key, now: () => t });
  a.add('r1', t); a.add('r2', t);
  a.close('r2');
  a.stage('w1', 'digest-1');
  const b = HO.createOrderStore({ file, key, now: () => t });
  assert.deepEqual(b.open(), [{ id: 'r1', at: 10_000 }]);
  assert.equal(b.stageOk('w1', 'digest-1'), true);
  assert.equal(b.stageOk('w1', 'digest-2'), false);    // the stage record changed: the dialog
  assert.equal(b.stageOk('w9', 'digest-1'), false);    // unknown stage: the dialog
  const m = HQ.createMinter({ now: () => t });
  for (const o of b.open()) m.restoreOrder(o.id, o.at);
  assert.equal(m.isOrder('r1'), true);
  assert.equal(HQ.consentFor({ request: 'r1', minter: m, now: t }), 'follow');
  assert.equal(HO.createOrderStore({ file, key: Buffer.alloc(32, 8), now: () => t }).stageOk('w1', 'digest-1'), false);   // another key
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, body: raw.body.replace('digest-1', 'digest-X') }));
  const c = HO.createOrderStore({ file, key, now: () => t });
  assert.equal(c.stageOk('w1', 'digest-X'), false);   // tampered: nothing is trusted
  assert.deepEqual(c.open(), []);
  assert.equal(HO.unseal(key, HO.seal(key, { x: 1 })).x, 1);
  assert.equal(HO.unseal(null, HO.seal(key, { x: 1 })), null);
  t += HO.ORDER_MS;
  assert.equal(b.isOpen('r1'), false);   // the ceiling
});

test('v3.130 order queue: release order (priority, then FIFO), n ahead, ceiling 50, close drops it', () => {
  const s = HO.createOrderStore({ file: '', key: null });
  s.add('r1', Date.now());
  const args = { project: 'p', task: 'x' };
  for (const id of ['a', 'b', 'c']) assert.equal(s.enqueue({ id, request: 'r1', args }).ok, true);
  s.enqueue({ id: 'u', request: 'r1', args, priority: 2 });
  assert.deepEqual(HO.releaseOrder(s.queue()).map((x) => x.id), ['u', 'a', 'b', 'c']);
  assert.equal(s.ahead('a'), 1);
  assert.equal(s.ahead('c'), 3);
  assert.equal(s.ahead('zz'), -1);
  assert.equal(HO.nextRelease(s.queue(), (x) => x.id !== 'u').id, 'a');   // the first one that may run
  s.remove('a');
  s.enqueue({ id: 'a', request: 'r1', args, seq: 1 });   // met a full queue again: keeps its place
  assert.equal(s.ahead('a'), 1);
  for (let i = s.queue().length; i < HO.ORDER_QUEUE_MAX; i++) s.enqueue({ id: `x${i}`, request: 'r1', args });
  assert.deepEqual(s.enqueue({ id: 'over', request: 'r1', args }), { ok: false, reason: 'order-queue-full' });
  assert.equal(s.close('r1').length, HO.ORDER_QUEUE_MAX);
  assert.equal(s.queue().length, 0);
});

test('v3.130 auto-continue: once per open order, only for a retryable block, never with ask on', () => {
  const task = { id: 'w1', status: 'blocked', after: 't1', reason: 'after-failed' };
  assert.equal(HO.mayAutoContinue({ task, open: true, used: 0 }), true);
  assert.equal(HO.mayAutoContinue({ task, open: true, used: 1 }), false);   // the second block waits for the person
  assert.equal(HO.mayAutoContinue({ task: { ...task, autoContinued: true }, open: true }), false);
  assert.equal(HO.mayAutoContinue({ task, open: false }), false);
  assert.equal(HO.mayAutoContinue({ task, open: true, ask: true }), false);
  for (const reason of ['after-rejected', 'after-blocked', 'after-closed-by-hq', 'after-person-prompted']) assert.equal(HO.mayAutoContinue({ task: { ...task, reason }, open: true }), false, reason);
  for (const reason of ['after-partial', 'after-expired', 'after-lost']) assert.equal(HO.mayAutoContinue({ task: { ...task, reason }, open: true }), true, reason);
  const s = HO.createOrderStore({ file: '', key: null });
  s.add('r1', Date.now());
  assert.equal(s.autoUsed('r1'), 0); s.takeAuto('r1'); assert.equal(s.autoUsed('r1'), 1);
  assert.equal(s.noticeOnce('r1', 'start'), true);
  assert.equal(s.noticeOnce('r1', 'start'), false);   // one notice per order and kind
  assert.equal(s.noticeOnce('r1', 'end'), true);
});

test('v3.130 phone turns never use a typed order\'s authority, until the person types again', () => {
  let t = 7_000_000;
  const m = HQ.createMinter({ now: () => t });
  const id = m.mint();
  m.clear();                                   // a report: the order lends its authority to HQ's later turns
  t += 3 * 3600 * 1000;
  assert.equal(HQ.consentFor({ request: id, minter: m, now: t }), 'follow');
  m.markPhone();                               // a phone turn names the open order's id explicitly
  assert.equal(m.isPhone(), true);
  assert.equal(m.isOrder(id), false);
  assert.equal(m.current(), null);
  assert.equal(HQ.consentFor({ request: id, minter: m, now: t }), 'app');      // past 2 h: the untyped rules → the dialog
  assert.equal(HQ.resolveRequest(m, id, { now: t }), HQ.ADHOC);
  const board = { tasks: [], requests: [{ id, at: t, prompt: '', tasks: [], done: false, initiative: 40 }] };
  assert.equal(HQ.followRefusal({ request: id, minter: m, board, targets: [{ projectId: 'p', staffId: '', skip: false }], now: t }), 'request-expired');
  // inside 2 h a phone turn gets today's follow-up rules (the count), never the order's
  const id2 = m.mint(); m.clear(); m.markPhone();
  const b2 = { tasks: [], requests: [{ id: id2, at: t, prompt: '', tasks: [], done: false, initiative: 4 }] };
  assert.equal(HQ.followRefusal({ request: id2, minter: m, board: b2, targets: [{ projectId: 'p', staffId: '', skip: false }], now: t }), 'follow-up-cap');
  m.clear();                                   // a report does not end the phone turn's flag
  assert.equal(m.isOrder(id2), false);
  m.mint({ origin: 'routine', run: 'x' });     // nor does a routine's id
  assert.equal(m.isPhone(), true);
  m.mint();                                    // the person types in HQ: orders lend their authority again
  assert.equal(m.isPhone(), false);
  assert.equal(m.isOrder(id), true);
});
