// HQ / Müdür (contract v3.46): node --test app/test/hq.test.cjs. Temp dirs only; nothing under the real ~/.claude.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const HQ = require('../src/hq.js');
const P = require('../src/projects.js');
const OM = require('../src/office-mcp.js');
const LH = require('../src/link-host.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const fnBody = (name) => { const i = MAIN.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return MAIN.slice(i, MAIN.indexOf('\n}\n', i)); };

test('seam: resolvePty("hq") gives the frozen HQ project, never one of state.projects', () => {
  const s = P.normalizeState({ projects: [{ id: 'aaaaaaaaaaaa', dir: '/x/a' }], hq: { accountId: 'work', dispatchWithoutAsking: 'yes' } });
  assert.deepEqual(s.hq, { accountId: 'work', enabled: true, dispatchWithoutAsking: false });
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

test('consent matrix: the app is the only gate; no dialog only for local + setting on + live minted id', () => {
  let t = 1000;
  const m = HQ.createMinter({ now: () => t, rand: () => 'x' });
  const id = m.mint();
  for (const [setting, remote, request, want] of [
    [false, false, id, 'app'], [false, true, id, 'app'], [true, true, id, 'app'], [true, false, id, 'none'],
    [true, false, 'rforged', 'app'], [true, false, '', 'app'], [true, false, HQ.ADHOC, 'app'],
  ]) assert.equal(HQ.consentFor({ setting, remote, request, minter: m }), want, `${setting} ${remote} ${request}`);
  m.clear();   // an inbox row (report-ready / request-done) is a turn the person did not type
  assert.equal(HQ.consentFor({ setting: true, remote: false, request: id, minter: m }), 'app');
  const id2 = m.mint();
  t += 31 * 60 * 1000;
  assert.equal(HQ.consentFor({ setting: true, remote: false, request: id2, minter: m }), 'app');
  assert.equal(HQ.submitsTyped(true, '\r'), true);
  assert.equal(HQ.submitsTyped(false, '\r'), false);
  assert.match(fnBody('inboxRow'), /hqMinter\.clear\(\)/);
});

test('request ids: only minted ones are accepted, else the current one, else the capped adhoc bucket', () => {
  let t = 1000;
  const m = HQ.createMinter({ now: () => t, rand: () => 'x' });
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
  assert.match(fnBody('hqDispatch'), /HQ\.capReason\(board, request\)/);
});

test('remote rows: keyed <pub>:<id>, restricted actions; offline peers from the cache (names and ids only)', () => {
  const pub = 'ab'.repeat(32);
  let cache = HQ.mergePeerCache({}, [{ pub, name: 'mini', online: true, manage: false, projects: [{ id: 'p1', name: 'site', status: 'working', secret: 'x' }] }], 5);
  assert.deepEqual(cache[pub].projects, [{ id: 'p1', name: 'site' }]);
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
  const m = HQ.createMinter({ now: () => t, rand: () => 'x' });
  const cur = m.mint();
  const request = HQ.resolveRequest(m, 'rforged');
  assert.equal(request, cur);
  assert.equal(HQ.consentFor({ setting: true, remote: false, request, minter: m }), 'none');
  assert.equal(HQ.consentFor({ setting: false, remote: false, request, minter: m }), 'app');
  t += 31 * 60 * 1000;   // expired: falls to adhoc → dialog
  const late = HQ.resolveRequest(m, 'rforged');
  assert.equal(late, HQ.ADHOC);
  assert.equal(HQ.consentFor({ setting: true, remote: false, request: late, minter: m }), 'app');
});

test('caps are re-checked after the consent dialog resolves', () => {
  const body = fnBody('hqDispatch');
  const a = body.indexOf('confirmHqDispatch(args, remote)');
  const b = body.indexOf('HQ.capReason(loadHqBoard(), request)', a);
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
  assert.deepEqual(ops, []);   // a boss just stopped is not restarted at once
  adv(30000);
  assert.equal(ops.length, 0);
  adv(31000);
  assert.deepEqual(ops, [['start', 'p1']]);
  host.pump();
  assert.equal(ops.length, 1);   // not again within a minute
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
  adv(6 * 61000);
  assert.equal(ops.length, 3);
  assert.deepEqual(seen2.at(-1), ['rejected', 'not-running']);
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
  adv(3000);                      // the queue saw the tab gone
  assert.equal(host.cancel(a.id), true);
  adv(5 * 60000);                 // the person ran and stopped the boss meanwhile; nothing queued, no pumps see it
  host.dispatchLocal('p1', 'y', 'HQ', () => {}, { ttl: 3600000, revive: true });
  adv(57000);
  assert.equal(ops.length, 0);    // not restarted within a minute
  adv(6000);
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
      state: {}, P: { resolvePty: () => ({ project: { id: 'p' } }) }, terms: new Map([['p', { pid: 1 }]]), handoffLocks: new Set(),
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

// --- v3.91 HQ's initiative: follow-up tasks of a typed request without the dialog (setting `initiative`, default off)
const WEB = { projectId: 'p-web' };   // the target the person consented to in initiativeCase
const initiativeCase = () => {
  const clock = { t: 1000 };
  const m = HQ.createMinter({ now: () => clock.t, rand: () => 'x' });
  const id = m.mint();
  const board = HQ.addTask(HQ.emptyBoard(), { id: 't1', request: id, title: 'first', pub: 'self', project: 'web', projectId: 'p-web', status: 'reported', consented: true }, clock.t);
  m.clear();   // a report came in: the typed id is no longer live
  const ask = (over = {}) => HQ.initiativeFor({ initiative: true, remote: false, request: id, minter: m, board, targets: [WEB], now: clock.t, ...over });
  return { clock, m, id, board, ask };
};

test('initiative setting: default off, kept only as a boolean', () => {
  assert.equal('initiative' in HQ.normalizeHq({}), false);
  assert.equal('initiative' in HQ.normalizeHq({ initiative: 'yes' }), false);
  assert.equal('initiative' in HQ.normalizeHq({ initiative: true, ...{ initiative: false } }), false);
  assert.equal(HQ.normalizeHq({ initiative: true }).initiative, true);
  assert.equal(HQ.MAX_INITIATIVE, 4);
  assert.equal(HQ.INITIATIVE_MS, 2 * 3600 * 1000);
  assert.equal(HQ.MAX_PER_REQUEST, 8);
  assert.equal(HQ.MAX_OPEN, 12);
});

test('initiative: a local follow-up of a typed request with a task on the board needs no consent; consentFor is untouched', () => {
  const { m, id, ask } = initiativeCase();
  assert.equal(HQ.consentFor({ setting: true, remote: false, request: id, minter: m }), 'app');   // today's answer stands
  assert.equal(m.isLive(id), false);
  assert.equal(ask(), true);
  assert.equal(ask({ initiative: false }), false);   // setting off
  assert.equal(ask({ initiative: undefined }), false);
  assert.equal(ask({ remote: true }), false);        // never a linked machine
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
  assert.equal(HQ.resolveRequest(m, id, { initiative: true, now: clock.t }), id);   // usable past the 30 min TTL
  assert.equal(HQ.resolveRequest(m, id, { now: clock.t }), HQ.ADHOC);               // setting off: as before
  assert.equal(HQ.resolveRequest(m, id), HQ.ADHOC);
  clock.t = 1000 + HQ.INITIATIVE_MS;
  assert.equal(ask(), false);
  assert.equal(HQ.resolveRequest(m, id, { initiative: true, now: clock.t }), HQ.ADHOC);
});

test('initiative: the request still has a task on the board', () => {
  const { id, board, ask } = initiativeCase();
  assert.equal(ask({ board: HQ.emptyBoard() }), false);   // nothing was sent for it yet: the first task asks
  const gone = HQ.removeTask(board, 't1');                // every row removed: not the same piece of work any more
  assert.equal(gone.tasks.some((t) => t.request === id), false);
  assert.equal(ask({ board: gone }), false);
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
  const o = (over = {}) => ({ initiative: true, remote: false, request: id, minter: m, targets: [WEB], now: clock.t, ...over });
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
  assert.equal(fifth.ok, false);   // the fifth asks
  assert.equal(fifth.board, b);    // and nothing is counted
  assert.equal(HQ.takeInitiative(HQ.removeTask(b, 'i0'), o()).ok, false);   // removing one does not give it back
  assert.equal(HQ.takeInitiative(board, o({ targets: [] })).ok, false);
  assert.equal(HQ.takeInitiative(board, o({ targets: undefined })).ok, false);
});

test('initiative: two overlapping calls cannot both pass; a chain counts every local stage; the re-check does not count twice', () => {
  const { clock, m, id, board } = initiativeCase();
  const o = (over = {}) => ({ initiative: true, remote: false, request: id, minter: m, targets: [WEB], now: clock.t, ...over });
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
  // the re-check sees what changed while it waited: the 2 h window, the setting, the consented row
  assert.equal(HQ.initiativeFor({ ...o({ now: 1000 + HQ.INITIATIVE_MS }), board: first.board, counted: true }), false);
  assert.equal(HQ.initiativeFor({ ...o({ initiative: false }), board: first.board, counted: true }), false);
  assert.equal(HQ.initiativeFor({ ...o(), board: HQ.removeTask(first.board, 't1'), counted: true }), false);
});

test('initiative target: only a project the person consented to for this request', () => {
  const { clock, id, board, ask } = initiativeCase();
  assert.equal(ask({ targets: [{ projectId: 'p-web' }] }), true);
  assert.equal(ask({ targets: [{ projectId: 'p-infra' }] }), false);          // another project: the dialog
  assert.equal(ask({ targets: [{ projectId: '' }] }), false);
  assert.equal(ask({ targets: [{}] }), false);
  assert.equal(ask({ targets: [null] }), false);
  assert.equal(ask({ targets: [WEB, { projectId: 'p-infra' }] }), false);     // a chain: every local stage's target
  // a row of ANOTHER request to that project does not help
  const other = HQ.addTask(board, { id: 'o1', request: 'rother', title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra' }, clock.t);
  assert.equal(ask({ board: other, targets: [{ projectId: 'p-infra' }] }), false);
  // a remote row with the same project id is not a local target
  const remote = HQ.addTask(board, { id: 'r1', request: id, title: 'x', pub: 'devpub', project: 'infra', projectId: 'p-infra' }, clock.t);
  assert.equal(ask({ board: remote, targets: [{ projectId: 'p-infra' }] }), false);
  // a consented chain: each of its stages' targets counts, waiting rows too
  const chain = HQ.addTask(board, { id: 'w1', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', status: 'waiting', after: 't1', consented: true }, clock.t);
  assert.equal(ask({ board: chain, targets: [{ projectId: 'p-infra' }] }), true);
  assert.equal(HQ.consentedTarget(chain, id, { projectId: 'p-infra' }), true);
  assert.equal(HQ.consentedTarget(chain, 'rother', { projectId: 'p-infra' }), false);
});

test('initiative target: a row sent by initiative does not make its target eligible', () => {
  const { clock, id, board, ask } = initiativeCase();
  const b = HQ.addTask(board, { id: 'i1', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', byInitiative: true }, clock.t);
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-infra' }] }), false);
  assert.equal(ask({ board: b }), true);   // the consented target still is
});

test('initiative target: the same project with another member, or with / without a member, asks', () => {
  const { clock, id, board, ask } = initiativeCase();
  assert.equal(ask({ targets: [{ projectId: 'p-web', staffId: 's-ada' }] }), false);   // the boss was consented, not the member
  const b = HQ.addTask(board, { id: 't2', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', staff: 'Ada', staffId: 's-ada', consented: true }, clock.t);
  assert.equal(b.tasks[0].staffId, 's-ada');
  assert.equal(HQ.boardView(b)[0].staffId, undefined);   // the id stays in the app
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-api', staffId: 's-ada' }] }), true);
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-api', staffId: 's-bob' }] }), false);   // same project, other member
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-api' }] }), false);                     // same project, its boss
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-api', staffId: '' }] }), false);
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-api', staffId: null }] }), false);      // a member the app could not resolve
  assert.equal(ask({ board: b, targets: [{ projectId: 'p-web', staffId: 's-ada' }] }), false);   // same member, other project
  // an older row that names a member without an id matches nothing (not the boss either)
  const old = HQ.addTask(board, { id: 't3', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', staff: 'Ada' }, clock.t);
  assert.equal(ask({ board: old, targets: [{ projectId: 'p-api', staffId: 's-ada' }] }), false);
  assert.equal(ask({ board: old, targets: [{ projectId: 'p-api' }] }), false);
});

test('initiative target: a member\'s personal workspace only after a consented row of this request went there', () => {
  const { clock, id, board, ask } = initiativeCase();
  const own = { projectId: 'p-ada-own', staffId: 's-ada' };   // Ada's personal workspace is a project of its own
  assert.equal(ask({ targets: [own] }), false);
  // Ada worked in the web project with consent: her personal workspace is still another target
  const inWeb = HQ.addTask(board, { id: 't2', request: id, title: 'x', pub: 'self', project: 'web', projectId: 'p-web', staff: 'Ada', staffId: 's-ada' }, clock.t);
  assert.equal(ask({ board: inWeb, targets: [own] }), false);
  // a workspace that is not made yet has no project id: its waiting row makes nothing eligible
  const unmade = HQ.addTask(board, { id: 'w1', request: id, title: 'x', pub: 'self', project: 'Ada', staff: 'Ada', staffId: 's-ada', status: 'waiting', after: 't1' }, clock.t);
  assert.equal(ask({ board: unmade, targets: [{ projectId: '', staffId: 's-ada' }] }), false);
  assert.equal(ask({ board: unmade, targets: [own] }), false);
  const byHq = HQ.addTask(board, { id: 'i1', request: id, title: 'x', pub: 'self', project: 'Ada', projectId: 'p-ada-own', staff: 'Ada', staffId: 's-ada', byInitiative: true }, clock.t);
  assert.equal(ask({ board: byHq, targets: [own] }), false);
  const consented = HQ.addTask(board, { id: 't4', request: id, title: 'x', pub: 'self', project: 'Ada', projectId: 'p-ada-own', staff: 'Ada', staffId: 's-ada', consented: true }, clock.t);
  assert.equal(ask({ board: consented, targets: [own] }), true);
  assert.equal(ask({ board: consented, targets: [{ projectId: 'p-ada-own', staffId: 's-bob' }] }), false);
});

test('initiative target: only a row stamped consented counts; a held card only after the person allowed it', () => {
  const { clock, id, board, ask } = initiativeCase();
  const INFRA = { projectId: 'p-infra' };
  const row = (over) => HQ.addTask(board, { id: 'h1', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', ...over }, clock.t);
  // a row written before the flag existed counts for nothing, whatever its status
  for (const status of ['queued', 'running', 'reported']) assert.equal(HQ.consentedTarget(row({ status }), id, INFRA), false, status);
  // a held card: awaiting consent, declined, expired
  const held = row({ status: 'awaiting-consent', reason: 'awaiting-consent' });
  assert.equal(held.tasks[0].consented, undefined);
  assert.equal(HQ.consentedTarget(held, id, INFRA), false);
  assert.equal(ask({ board: held, targets: [INFRA] }), false);
  assert.equal(HQ.consentedTarget(HQ.setStatus(held, 'h1', 'rejected', 'declined'), id, INFRA), false);
  const gone = HQ.expireHeld(held, clock.t + HQ.HELD_MS + 1);
  assert.deepEqual(gone.expired, ['h1']);
  assert.equal(HQ.consentedTarget(gone.board, id, INFRA), false);
  // taken by Allow but not sent yet: still nothing
  const taken = HQ.takeHeld(held, 'h1', clock.t);
  assert.equal(taken.ok, true);
  assert.equal(HQ.consentedTarget(taken.board, id, INFRA), false);
  // sent after Allow: the sent row is stamped, and the card's row keeps the stamp through the rename
  const sent = HQ.addTask(taken.board, { id: 'c9', request: id, title: 'x', pub: 'self', project: 'infra', projectId: 'p-infra', consented: true }, clock.t);
  const done = HQ.renameTask(sent, 'h1', 'c9', { status: 'queued', reason: undefined });
  assert.deepEqual(done.tasks.filter((t) => t.id === 'c9' || t.id === 'h1').map((t) => [t.id, t.consented]), [['c9', true]]);
  assert.equal(HQ.consentedTarget(done, id, INFRA), true);
  assert.equal(ask({ board: done, targets: [INFRA] }), true);
  // a rename without a sent row (a paced remote task, a released stage) stamps nothing
  assert.equal(HQ.renameTask(taken.board, 'h1', 'c9', { status: 'queued' }).tasks.find((t) => t.id === 'c9').consented, undefined);
  // a row sent by initiative is never stamped
  const own = row({ byInitiative: true, consented: true });
  assert.equal(own.tasks[0].consented, undefined);
  assert.equal(HQ.consentedTarget(own, id, INFRA), false);
});

test('initiative target: an approved held card for a member counts for that member, never for the project\'s boss tab', () => {
  const { clock, id, board, ask } = initiativeCase();
  // the card's row names the project only; the row written when it is sent knows the member
  const held = HQ.addTask(board, { id: 'h2', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', status: 'awaiting-consent', reason: 'awaiting-consent' }, clock.t);
  const sent = HQ.addTask(HQ.takeHeld(held, 'h2', clock.t).board, { id: 'c8', request: id, title: 'x', pub: 'self', project: 'api', projectId: 'p-api', staff: 'Ada', staffId: 's-ada', consented: true }, clock.t);
  const done = HQ.renameTask(sent, 'h2', 'c8', { status: 'queued', reason: undefined });
  const kept = done.tasks.find((t) => t.id === 'c8');
  assert.deepEqual([kept.staff, kept.staffId, kept.consented, kept.title], ['Ada', 's-ada', true, 'x']);
  assert.equal(HQ.consentedTarget(done, id, { projectId: 'p-api', staffId: 's-ada' }), true);
  assert.equal(HQ.consentedTarget(done, id, { projectId: 'p-api' }), false);                     // not the boss tab
  assert.equal(HQ.consentedTarget(done, id, { projectId: 'p-api', staffId: 's-bob' }), false);
  assert.equal(ask({ board: done, targets: [{ projectId: 'p-api' }] }), false);
  // a card for a personal workspace that was made after Allow: the row gets the project it went to
  const bare = HQ.addTask(board, { id: 'h3', request: id, title: 'x', pub: 'self', project: 'Ada', status: 'awaiting-consent' }, clock.t);
  const made = HQ.addTask(HQ.takeHeld(bare, 'h3', clock.t).board, { id: 'c7', request: id, title: 'x', pub: 'self', project: 'Ada', projectId: 'p-ada-own', staff: 'Ada', staffId: 's-ada', consented: true }, clock.t);
  assert.equal(HQ.consentedTarget(HQ.renameTask(made, 'h3', 'c7', { status: 'queued' }), id, { projectId: 'p-ada-own', staffId: 's-ada' }), true);
});

test('initiative target: a project with Skip permissions always asks', () => {
  const { m, id, board, ask } = initiativeCase();
  assert.equal(ask({ targets: [{ projectId: 'p-web', skip: true }] }), false);
  assert.equal(ask({ targets: [{ projectId: 'p-web', skip: false }] }), true);
  assert.equal(ask({ targets: [WEB, { projectId: 'p-web', skip: true }] }), false);   // one stage is enough
  assert.equal(HQ.takeInitiative(board, { initiative: true, remote: false, request: id, minter: m, targets: [{ projectId: 'p-web', skip: true }], now: 1000 }).ok, false);
});

test('initiative wiring: decided and counted by HQ.takeInitiative, final before anything is made, the person is told', () => {
  const d = fnBody('hqDispatch');
  assert.equal((d.match(/HQ\.takeInitiative\(loadHqBoard\(\), initiativeArgs\(false\)\)/g) || []).length, 1);
  assert.equal((d.match(/HQ\.initiativeFor\(\{ \.\.\.initiativeArgs\(true\), board: loadHqBoard\(\) \}\)/g) || []).length, 1);
  // the re-check is final before the desk tab, its worktree or a personal workspace is made
  assert.ok(d.indexOf('HQ.initiativeFor({ ...initiativeArgs(true), board: loadHqBoard() })') < d.lastIndexOf('await hqStaffDesk('));
  assert.ok(d.indexOf('HQ.initiativeFor({ ...initiativeArgs(true), board: loadHqBoard() })') < d.indexOf('ensurePersonal(m)'));
  assert.ok(d.indexOf('HQ.initiativeFor({ ...initiativeArgs(true), board: loadHqBoard() })') > d.indexOf('{ open: false }'));   // after the staff check's wait
  assert.ok(d.indexOf('HQ.initiativeFor({ ...initiativeArgs(true), board: loadHqBoard() })') < d.indexOf('officeDispatch(HQ.HQ_ID'));  // before queueing
  assert.match(d, /skip: hqTargetSkips\(p, /);
  assert.match(fnBody('hqTargetSkips'), /!p \|\| P\.skipPermissionsArgs\(p\)\.length > 0/);
  assert.match(fnBody('hqTargetSkips'), /terms\.has\(tab\) && skipStarted\.has\(tab\)/);
  assert.match(fnBody('approveHeld'), /hqDispatch\(h\.args, \{ approved: true, excludeId: heldId, consentGiven: true \}\)/);
  assert.match(d, /consent === 'held' \|\| HQ\.holdsOffId/);   // a routine's hold comes first, unchanged
  assert.match(d, /notifyInitiative\(args\.title/);
  const s = fnBody('hqDispatchStages');
  assert.equal((s.match(/HQ\.takeInitiative\(loadHqBoard\(\), initiativeArgs\(false\)\)/g) || []).length, 1);
  assert.ok(s.indexOf('HQ.initiativeFor({ ...initiativeArgs(true), board: loadHqBoard() })') > s.indexOf('await confirmHqDispatch(s, true)'));   // after the remote dialogs
  assert.match(s, /for \(const s of stages\.filter\(\(x\) => x\.remote\)\) if \(!\(await confirmHqDispatch\(s, true\)\)\) return no\('declined'/);
  assert.match(fnBody('notifyInitiative'), /notify\(T\('main\.hqInitiativeSent'/);
  assert.match(fnBody('inboxRow'), /hqMinter\.clear\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'hq.js'), 'utf8'), /isLive\(id\) \{ return Boolean\(current\) && current\.id === id && now\(\) - current\.at <= MINT_MS; \}/);
});
