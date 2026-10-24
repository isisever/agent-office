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
    '--allowedTools', 'Read(//ud/hq/**),mcp__agent-office__office_machines,mcp__agent-office__office_reports,mcp__agent-office__office_board,mcp__agent-office__office_summary,mcp__agent-office__office_dispatch',
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
test('office MCP: the HQ tab lists 6 tools, a project boss 4; HQ-only tools refused for other tabs', async () => {
  const [hq] = await rpc({ AGENT_OFFICE_HQ: '1' }, [{ id: 1, method: 'tools/list' }]);
  assert.deepEqual(hq.result.tools.map((t) => t.name).sort(), ['office_board', 'office_dispatch', 'office_machines', 'office_project', 'office_reports', 'office_summary']);
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

test('v3.46 amendment: waitState names why a task waits', () => {
  assert.deepEqual(['ready', 'busy', 'starting'].map((s) => HQ.waitState(s, false)), ['ready', 'busy', 'starting']);
  assert.equal(HQ.waitState('gone', true), 'asleep');
  assert.equal(HQ.waitState('gone', false), 'not-running');
  assert.ok(HQ.WAIT_STATES.includes('not-running'));
});

test('v3.46 amendment: an HQ task wakes/starts a gone boss, waits for it, then is typed; at most 3 tries a minute apart', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  let tab = 'gone'; const ops = [];
  const { host, typed } = waitHost(t, { tabState: () => tab, manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  const seen = [];
  const r = host.dispatchLocal('p1', 'scan the repo', 'HQ', (id, s, why) => seen.push([s, why]), { ttl: 3600000, revive: true });
  assert.equal(r.status, 'queued');
  assert.deepEqual(ops, []);   // a boss just stopped is not restarted at once
  clock += 30000; host.pump();
  assert.equal(ops.length, 0);
  clock += 31000; host.pump();
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
  for (let i = 0; i < 6; i++) { clock += 61000; host.pump(); }
  assert.equal(ops.length, 3);
  assert.deepEqual(seen2.at(-1), ['rejected', 'not-running']);
});

test('v3.46 amendment: the revive budget is per project: several queued HQ tasks start the boss 3 times in all, then all are refused', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  const ops = [];
  const { host } = waitHost(t, { tabState: () => 'gone', manage: (op, id) => { ops.push([op, id]); return { ok: true }; } });
  const seen = [[], [], [], [], []];
  seen.forEach((a) => host.dispatchLocal('p1', 'x', 'HQ', (id, s, why) => a.push([s, why]), { ttl: 3600000, revive: true }));
  host.pump(); assert.equal(ops.length, 0);
  for (let i = 0; i < 8; i++) { clock += 61000; host.pump(); }
  assert.equal(ops.length, 3);
  for (const a of seen) assert.deepEqual(a.at(-1), ['rejected', 'not-running']);
});

test('v3.46 amendment: without revive a gone boss refuses at once; a failed start says why', (t) => {
  const real = Date.now; let clock = real(); Date.now = () => clock;
  t.after(() => { Date.now = real; });
  let res = { ok: false, reason: 'locked' };
  const { host } = waitHost(t, { tabState: () => 'gone', manage: () => res });
  const a = []; host.dispatchLocal('p1', 'x', 'Boss', (id, s, why) => a.push([s, why]));
  assert.deepEqual(a.at(-1), ['rejected', 'not-running']);
  const b = []; host.dispatchLocal('p1', 'x', 'HQ', (id, s, why) => b.push([s, why]), { revive: true });
  clock += 61000; host.pump();
  assert.deepEqual(b.at(-1), ['rejected', 'locked']);
  res = { ok: false, reason: 'failed' };
  const c = []; host.dispatchLocal('p1', 'x', 'HQ', (id, s, why) => c.push([s, why]), { revive: true });
  clock += 61000; host.pump();
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
