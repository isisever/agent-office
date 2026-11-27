// GUI chat (contract v3.108): src/gui-session.js and src/gui-proc.js. node --test app/test/gui-session.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const GS = require('../src/gui-session.js');
const { spawnGui } = require('../src/gui-proc.js');

const parse = (s) => JSON.parse(s);

test('GUI chat: which tabs run as a GUI chat (v3.108)', () => {
  const base = { chatView: true, terminal: false, engine: 'claude', hq: false, shell: false, platform: 'darwin' };
  assert.equal(GS.guiEligible(base), true);
  assert.equal(GS.guiEligible({ ...base, platform: 'linux' }), true);
  assert.equal(GS.guiEligible({ ...base, chatView: false }), false, 'the chat view setting is off');
  assert.equal(GS.guiEligible({ ...base, terminal: true }), false, 'the person switched the tab to its terminal');
  assert.equal(GS.guiEligible({ ...base, engine: 'agy' }), false, 'another engine');
  assert.equal(GS.guiEligible({ ...base, hq: true }), false, 'HQ keeps its terminal');
  assert.equal(GS.guiEligible({ ...base, shell: true }), false, 'a plain shell tab');
  assert.equal(GS.guiEligible({ ...base, platform: 'win32' }), false, 'not on Windows yet');
});

test('GUI chat: argv puts the protocol flags first, the tab arguments after', () => {
  const args = GS.guiArgs(['--model', 'opus', '--plugin-dir', '/p', '--resume', 'abc']);
  assert.deepEqual(args.slice(0, GS.GUI_FLAGS.length), GS.GUI_FLAGS);
  assert.deepEqual(args.slice(GS.GUI_FLAGS.length), ['--model', 'opus', '--plugin-dir', '/p', '--resume', 'abc']);
  for (const f of ['-p', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool']) assert.ok(GS.GUI_FLAGS.includes(f), f);
  assert.equal(GS.GUI_FLAGS[GS.GUI_FLAGS.indexOf('--permission-prompt-tool') + 1], 'stdio');
});

test('GUI chat: protocol lines', () => {
  assert.deepEqual(parse(GS.userLine('hi')), { type: 'user', message: { role: 'user', content: 'hi' } });
  assert.deepEqual(parse(GS.interruptLine('i1')), { type: 'control_request', request_id: 'i1', request: { subtype: 'interrupt' } });
  assert.deepEqual(parse(GS.allowLine('r1', { a: 1 })).response, { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { a: 1 } } });
  assert.equal(parse(GS.denyLine('r1', 'no')).response.response.behavior, 'deny');
  assert.ok(GS.userLine('a\nb').endsWith('\n') && GS.userLine('a\nb').split('\n').length === 2, 'one line, newline escaped');
});

test('GUI chat: stdout splits into JSON objects across chunks; other lines are skipped', () => {
  const l = GS.createLines();
  assert.deepEqual(l.push('{"type":"a"}\nnot json\n{"ty'), [{ type: 'a' }]);
  assert.deepEqual(l.push('pe":"b"}\n\n'), [{ type: 'b' }]);
});

const req = (tool, input, id = 'r1') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } });

test('GUI chat: a request becomes a card', () => {
  const p = GS.askOf(req('Bash', { command: 'touch x' }), 5);
  assert.deepEqual({ id: p.id, kind: p.kind, tool: p.tool, detail: p.detail, since: p.since }, { id: 'r1', kind: 'permission', tool: 'Bash', detail: 'touch x', since: 5 });
  const q = GS.askOf(req('AskUserQuestion', { questions: [{ question: 'Color?', header: 'C', options: [{ label: 'Red', description: 'r' }, { label: 'Blue' }] }] }));
  assert.equal(q.kind, 'question');
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Red', 'Blue']);
  assert.equal(GS.askOf(req('ExitPlanMode', { plan: '# Plan' })).plan, '# Plan');
  assert.equal(GS.askOf(req('mcp__srv__do', {})).name, 'srv · do');
  assert.equal(GS.askOf({ type: 'control_request', request_id: 'x', request: { subtype: 'interrupt' } }), null);
  assert.equal(GS.askOf(req('', {})), null, 'no tool name');
  assert.equal(GS.askOf({ type: 'assistant' }), null);
});

test('GUI chat: the app answers only what Auto-approve would (v3.71 rules), never on a mail desk', () => {
  const can = (tool, input) => !(tool === 'Bash' && /sudo/.test(input.command));
  const o = { autoApprove: true, mailGuard: false, canAutoApprove: can };
  assert.equal(GS.autoAllows({ ...o, tool: 'Bash', input: { command: 'ls' } }), true);
  assert.equal(GS.autoAllows({ ...o, tool: 'Bash', input: { command: 'sudo ls' } }), false, 'refused by the rules');
  assert.equal(GS.autoAllows({ ...o, autoApprove: false, tool: 'Bash', input: { command: 'ls' } }), false, 'switch off');
  assert.equal(GS.autoAllows({ ...o, mailGuard: true, tool: 'Bash', input: { command: 'ls' } }), false, 'mail desk');
  assert.equal(GS.autoAllows({ ...o, tool: 'AskUserQuestion', input: {} }), false, 'a question to the person');
  assert.equal(GS.autoAllows({ ...o, tool: 'ExitPlanMode', input: {} }), false, 'a plan to the person');
  assert.equal(GS.autoAllows({ ...o, canAutoApprove: null, tool: 'Bash', input: { command: 'ls' } }), false, 'rules not loaded: ask');
  assert.equal(GS.autoAllows({ ...o, canAutoApprove: () => { throw new Error('x'); }, tool: 'Bash', input: {} }), false);
});

test('GUI chat: the generated auto-approve copy matches the plugin source', async () => {
  const mod = require('node:module');
  const copy = fs.readFileSync(path.join(__dirname, '..', 'src', 'auto-approve.mjs'), 'utf8');
  assert.match(copy, /^\/\/ Generated from plugin\/hooks\/auto-approve\.ts/);
  // CI runs Node 22 (which has it): there the comparison must not be skipped
  if (process.env.CI) assert.equal(typeof mod.stripTypeScriptTypes, 'function', 'Node 22.13+ needed to check the copy');
  if (typeof mod.stripTypeScriptTypes === 'function') {
    process.removeAllListeners('warning');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'plugin', 'hooks', 'auto-approve.ts'), 'utf8');
    assert.equal(copy.slice(copy.indexOf('\n') + 1), mod.stripTypeScriptTypes(src), 'run node app/scripts/sync-core.mjs');
  }
  const AA = await import('../src/auto-approve.mjs');
  assert.equal(AA.canAutoApprove('Bash', { command: 'ls' }), true);
  assert.equal(AA.canAutoApprove('Bash', { command: 'sudo rm -rf /' }), false);
  assert.equal(AA.canAutoApprove('Edit', { file_path: '/x/.git/hooks/pre-commit' }), false);
  assert.equal(AA.canAutoApprove('AskUserQuestion', {}), false);
});

test('GUI chat: answers to cards', () => {
  const perm = GS.askOf(req('Bash', { command: 'ls' }));
  assert.deepEqual(parse(GS.answerLine(perm, { command: 'ls' }, { allow: true })).response.response, { behavior: 'allow', updatedInput: { command: 'ls' } });
  const no = parse(GS.answerLine(perm, {}, { allow: false, message: 'not now' })).response.response;
  assert.deepEqual(no, { behavior: 'deny', message: 'not now' });
  const input = { questions: [{ question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] };
  const q = GS.askOf(req('AskUserQuestion', input));
  const yes = parse(GS.answerLine(q, input, { allow: true, answers: { 'Color?': 'Blue\n' } })).response.response;
  assert.deepEqual(yes.updatedInput.answers, { 'Color?': 'Blue' });
  assert.deepEqual(yes.updatedInput.questions, input.questions);
  assert.equal(GS.answerLine(q, input, { allow: true, answers: {} }), null, 'a question needs an answer');
  assert.equal(GS.answerLine(q, input, { allow: true, answers: { 'Other?': 'x' } }), null, 'only its own questions');
  assert.equal(GS.answerLine(null, {}, { allow: true }), null);
});

test('GUI chat: the live line follows the turn', () => {
  let live = { busy: false, text: '', tool: '' };
  const ev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null });
  live = GS.nextLive(live, ev({ type: 'message_start' }));
  assert.equal(live.busy, true);
  live = GS.nextLive(live, ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }));
  live = GS.nextLive(live, ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }));
  assert.equal(live.text, 'Hello');
  live = GS.nextLive(live, { type: 'stream_event', parent_tool_use_id: 'sub', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'X' } } });
  assert.equal(live.text, 'Hello', 'a subagent stream is not the main answer');
  live = GS.nextLive(live, { type: 'assistant', parent_tool_use_id: null });
  assert.equal(live.text, '', 'the whole message arrived (the transcript shows it)');
  live = GS.nextLive(live, ev({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } }));
  assert.equal(live.tool, 'Bash');
  assert.deepEqual(GS.nextLive(live, { type: 'result' }), { busy: false, text: '', tool: '' });
});

/** A fake child process: stdin collects lines, out() feeds stdout. */
function fakeSpawn() {
  const made = [];
  const spawn = (file, args, opts) => {
    const c = new EventEmitter();
    c.pid = 4242;
    c.written = [];
    c.stdin = Object.assign(new EventEmitter(), { destroyed: false, write: (s) => { c.written.push(parse(s)); return true; } });
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = null;
    c.kill = (sig) => { c.killed = sig || 'SIGTERM'; };
    c.out = (o) => c.stdout.emit('data', `${JSON.stringify(o)}\n`);
    made.push({ file, args, opts, c });
    return c;
  };
  return { spawn, made };
}

test('GUI chat: the process wrapper is shaped like a pty and answers through main', () => {
  const { spawn, made } = fakeSpawn();
  const seen = [];
  const groupKills = [];
  const t = spawnGui(spawn, '/bin/zsh', ['-c', 'exec claude'], { cwd: '/w', env: { A: '1' } }, {
    onAsk: (ask, input) => { seen.push(ask.tool); return ask.tool === 'Read' && input.file_path === '/w/a'; },
    killGroup: (pid, sig) => groupKills.push([pid, sig]),
  });
  const c = made[0].c;
  assert.equal(t.pid, 4242);
  assert.equal(t.gui, true);
  assert.deepEqual(made[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(made[0].opts.detached, true, 'its own process group');
  assert.equal(typeof t.onData(() => {}).dispose, 'function');
  t.write('x'); t.resize(80, 24);   // no terminal: nothing happens
  assert.equal(c.written.length, 0);

  assert.equal(t.sendUser('hello'), true);
  assert.deepEqual(c.written.at(-1), { type: 'user', message: { role: 'user', content: 'hello' } });
  assert.equal(t.live().busy, true);

  c.out(req('Read', { file_path: '/w/a' }, 'auto'));   // main answers it: allow, no card
  assert.deepEqual(c.written.at(-1).response.response, { behavior: 'allow', updatedInput: { file_path: '/w/a' } });
  c.out(req('Bash', { command: 'rm x' }, 'r2'));       // goes to the person
  assert.deepEqual(t.asks().map((a) => a.id), ['r2']);
  assert.equal('input' in t.asks()[0], false, 'the full input stays in main');
  assert.equal(t.answer('nope', { allow: true }), 'gone');
  assert.equal(t.answer('r2', { allow: false, message: 'no' }), 'ok');
  assert.equal(c.written.at(-1).response.response.behavior, 'deny');
  assert.deepEqual(t.asks(), []);
  assert.deepEqual(seen, ['Read', 'Bash']);

  c.out(req('Bash', { command: 'ls' }, 'r3'));
  c.out({ type: 'control_cancel_request', request_id: 'r3' });
  assert.deepEqual(t.asks(), [], 'withdrawn by claude');
  c.out(req('Bash', { command: 'ls' }, 'r4'));
  c.out({ type: 'result', subtype: 'success' });
  assert.deepEqual(t.asks(), [], 'a finished turn leaves nothing open');
  assert.equal(t.live().busy, false);

  c.out({ type: 'system', subtype: 'init', session_id: 'sid-1' });
  assert.equal(t.sessionId(), 'sid-1');
  t.interrupt();
  assert.equal(c.written.at(-1).request.subtype, 'interrupt');

  const exits = [];
  t.onExit((e) => exits.push(e));
  t.kill();
  assert.deepEqual(groupKills, [[-4242, 'SIGTERM']], 'the whole group is stopped');
  assert.equal(c.killed, null);
  c.emit('exit', 0, null);
  c.emit('exit', 0, null);
  assert.deepEqual(exits, [{ exitCode: 0 }], 'exit reported once');
  assert.equal(t.sendUser('late'), false, 'nothing is written after the end');
});

test('GUI chat: an unreadable request is denied, never left hanging; stderr reaches onData', () => {
  const { spawn, made } = fakeSpawn();
  const t = spawnGui(spawn, 'sh', [], { cwd: '/', env: {} }, { killGroup: () => {} });
  const data = [];
  t.onData((d) => data.push(d));
  const c = made[0].c;
  c.out({ type: 'control_request', request_id: 'bad', request: { subtype: 'can_use_tool' } });
  assert.equal(c.written.at(-1).response.response.behavior, 'deny');
  c.stderr.emit('data', 'oops\n');
  assert.deepEqual(data, ['oops\r\n']);
  const exits = [];
  t.onExit((e) => exits.push(e));
  c.emit('error', new Error('spawn sh ENOENT'));
  assert.equal(exits[0].exitCode, 127);
});

test('GUI chat: an open request makes its project wait (attention, v2.6)', () => {
  const N = require('../src/attention.js');
  const office = [{ name: 'a', isBossBusy: true }, { name: 'b', waiting: { tool: 'Edit', since: 1 } }];
  assert.equal(N.withWaits(office, new Map()), office, 'nothing open: unchanged');
  const out = N.withWaits(office, new Map([['a', { tool: 'Bash', since: 5 }], ['b', { tool: 'Bash', since: 9 }], ['c', { tool: 'Read', since: 2 }]]));
  assert.deepEqual(out.find((p) => p.name === 'a').waiting, { tool: 'Bash', since: 5 });
  assert.deepEqual(out.find((p) => p.name === 'b').waiting, { tool: 'Edit', since: 1 }, 'the oldest wins');
  assert.deepEqual(out.find((p) => p.name === 'c'), { name: 'c', waiting: { tool: 'Read', since: 2 } });
  assert.equal(office[0].waiting, undefined, 'the office data is not changed');
  const projects = [{ id: 'A', name: 'a' }];
  const first = N.nextAttention(N.emptyAttention(), projects, office, null);
  const r = N.nextAttention(first.state, projects, out, null);
  assert.equal(r.attention.get('A'), 'permission');
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'A', tool: 'Bash' }]);
});

test('GUI chat: error text for the usage-limit watch (v3.77)', () => {
  assert.equal(GS.errorText({ type: 'result', is_error: true, result: 'Claude usage limit reached' }), 'Claude usage limit reached');
  assert.equal(GS.errorText({ type: 'result', is_error: false, result: 'ok' }), '');
  assert.equal(GS.errorText({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'limit hit' }] } }), 'limit hit');
  assert.equal(GS.errorText({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }), '');
});

test('GUI chat: main wiring (source text): a card is a waiting approval for HQ, sleep, mode switches', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fnBody = (name) => { const i = MAIN.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return MAIN.slice(i, MAIN.indexOf('\n}\n', i)); };
  // HQ's task watch reads needs-approval while a dispatched task's GUI tab shows a card
  assert.match(fnBody('tabLive'), /if \(t\.gui && t\.asks\(\)\.length > 0\) return 'permission'/);
  // never slept, never moved while a card is open or a turn runs (rule 4)
  assert.match(fnBody('sleepIdle'), /if \(t\.gui && \(t\.asks\(\)\.length > 0 \|\| t\.live\(\)\.busy\)\) continue/);
  assert.match(fnBody('guiSwitchIdle'), /idleSession\(pid\)/);
  assert.match(fnBody('guiSwitchIdle'), /handoffLocked\(pid\)/);
  // how a GUI tab ended reaches its chat; a new start clears it
  assert.match(MAIN, /if \(guiProc\) guiEnded\.set\(id, \{ code: exitCode, text: GS\.endNote\(guiProc\.stderr\(\)\)/);
  assert.match(fnBody('startPty'), /guiEnded\.delete\(id\)/);
  // typed prompts (HQ dispatch, routines, remote tasks) reach a GUI tab as a message
  assert.match(fnBody('typePrompt'), /if \(t\.gui\) \{\s+if \(!t\.sendUser\(text, images\)\) return false;/);
  // HQ never runs as a GUI chat; auto answers go through the plugin's rules
  assert.match(fnBody('guiTab'), /hq: Boolean\(r\.project\.hq\)/);
  assert.match(fnBody('guiAsk'), /GS\.autoAllows\(/);
});

test('GUI chat: the end note keeps the last lines of stderr, without escapes or blank lines', () => {
  assert.equal(GS.endNote('\x1b[31mshell-init: x\x1b[0m\n\n  \nerror: An unknown error occurred (Unexpected)\n'), 'shell-init: x\nerror: An unknown error occurred (Unexpected)');
  assert.equal(GS.endNote(''), '');
  assert.equal(GS.endNote('a'.repeat(2000)).length, 800);
});

test('v3.112 Terminal button: a GUI tab switches by its own state; a new one with no conversation starts fresh', () => {
  // a GUI tab: no open card, no turn, no task, nothing running → resume its session; no session yet → fresh
  assert.equal(GS.switchPlan({ gui: true, guiSid: 's1' }), 'resume');
  assert.equal(GS.switchPlan({ gui: true, sid: 's0' }), 'resume');
  assert.equal(GS.switchPlan({ gui: true }), 'fresh');
  // the terminal's typing window and a permission prompt elsewhere do not hold a GUI tab
  assert.equal(GS.switchPlan({ gui: true, guiSid: 's1', recent: true, permission: true }), 'resume');
  for (const o of [{ asks: 1 }, { busy: true }, { tasks: true }, { working: true }]) assert.equal(GS.switchPlan({ gui: true, guiSid: 's1', ...o }), 'busy', JSON.stringify(o));
  // a terminal tab: as before (an idle pid-file session, nothing typed in the last 15 s, no permission prompt, no task)
  assert.equal(GS.switchPlan({ gui: false, sid: 's1' }), 'resume');
  for (const o of [{ sid: '' }, { recent: true }, { permission: true }, { tasks: true }]) assert.equal(GS.switchPlan({ gui: false, sid: 's1', ...o }), 'busy', JSON.stringify(o));
  // wiring: chat:mode uses the plan; a fresh start passes no session id but keeps the --continue rule
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const mode = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:mode'"), MAIN.indexOf("ipcMain.on('pty:wake'"));
  assert.match(mode, /const facts = \{ gui: Boolean\(t\.gui\)/);
  assert.match(mode, /GS\.switchPlan\(facts\)/);
  assert.match(mode, /startPty\(id, plan === 'resume' \? \{ sessionId: sid, resume: true \} : \{ resume: true \}\)/);
  // the reason a switch was refused shows under the chat input too
  const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(APP, /panes\.get\(id\)\?\.chat\?\.note\?\.\(why\)/);
});

test('v3.112 AskUserQuestion: the answer reaches claude as updatedInput.answers and the card leaves the open list', () => {
  const written = [];
  const child = Object.assign(new EventEmitter(), { pid: 42, stdin: Object.assign(new EventEmitter(), { destroyed: false, write: (s) => { written.push(s); return true; } }), stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const t = spawnGui(() => child, 'sh', [], { cwd: '/', env: {} }, { killGroup: () => {} });
  const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] };
  child.stdout.emit('data', `${JSON.stringify({ type: 'control_request', request_id: 'req-7', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } })}\n`);
  assert.equal(t.asks().length, 1);
  assert.equal(t.asks()[0].kind, 'question');
  assert.equal(t.answer('req-7', { allow: true, answers: { 'Which color?': 'Blue' } }), 'ok');
  assert.equal(t.asks().length, 0, 'answered: no longer open, so the chat drops the card');
  const out = JSON.parse(written.at(-1));
  assert.deepEqual(out, { type: 'control_response', response: { subtype: 'success', request_id: 'req-7', response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Which color?': 'Blue' } } } } });
  // Skip: a deny with the same request id; answering again is 'gone'
  child.stdout.emit('data', `${JSON.stringify({ type: 'control_request', request_id: 'req-8', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } })}\n`);
  assert.equal(t.answer('req-8', { allow: false }), 'ok');
  assert.equal(JSON.parse(written.at(-1)).response.response.behavior, 'deny');
  assert.equal(JSON.parse(written.at(-1)).response.request_id, 'req-8');
  assert.equal(t.answer('req-8', { allow: false }), 'gone');
});

test('v3.112 chat renderer (source text): an answered card is taken down; paste, drop and the switch note are wired', () => {
  const CHAT = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  const answer = CHAT.slice(CHAT.indexOf('async function answer('), CHAT.indexOf('function withMessage('));
  // the bug: askShown = '' equals "nothing open", so setGui never redrew (hid) the last answered card
  assert.doesNotMatch(answer, /askShown = '';/);
  assert.match(answer, /askShown = ASK_REDRAW;/);
  assert.match(answer, /if \(!next\.length\) drawAsk\(null\);/);
  // permission and plan cards go through the same answer()
  const draw = CHAT.slice(CHAT.indexOf('function drawAsk('), CHAT.indexOf('async function interrupt('));
  assert.equal((draw.match(/answer\(ask, \{ allow: true \}\)/g) || []).length, 2);
  // files dropped anywhere on the chat; Finder files and images from the menu's Paste
  assert.match(CHAT, /el\.addEventListener\('drop'/);
  assert.match(CHAT, /async function pasteFromMenu\(\)/);
  assert.match(CHAT, /navigator\.clipboard\.read\(\)/);
  // text with an image (spreadsheet cells) goes to the normal paste so the text is not lost
  assert.match(CHAT, /if \(!clip\?\.hasImage \|\| \(typeof clip\.text === 'string' && clip\.text\.trim\(\)\)\) return false;/);
  assert.match(CHAT, /paste: \(\) => pasteFromMenu\(\)/);
  const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(APP, /if \(chat && await chat\.paste\(\)\.catch\(\(\) => false\)\) return;/);
});

test('v3.116 switchWhy names what a refused switch waits for; typesInput ignores escapes the terminal sends itself', () => {
  assert.equal(GS.switchWhy({ gui: true, tasks: true, asks: 1 }), 'task');
  assert.equal(GS.switchWhy({ gui: true, asks: 2, busy: true }), 'asks');
  assert.equal(GS.switchWhy({ gui: true, busy: true, working: true }), 'turn');
  assert.equal(GS.switchWhy({ gui: true, working: true }), 'agents');
  assert.equal(GS.switchWhy({ gui: false, sid: '', idleWhy: 'agents' }), 'agents');
  assert.equal(GS.switchWhy({ gui: false, sid: '', idleWhy: 'draft' }), 'draft');
  assert.equal(GS.switchWhy({ gui: false, sid: '', idleWhy: 'odd' }), 'session');
  assert.equal(GS.switchWhy({ gui: false, sid: 's1', recent: true, permission: true }), 'permission');
  assert.equal(GS.switchWhy({ gui: false, sid: 's1', recent: true }), 'recent');
  // every refused plan has a reason
  for (const o of [{ gui: true, asks: 1 }, { gui: true, busy: true }, { gui: true, working: true }, { gui: false }, { gui: false, sid: 's', recent: true }, { gui: false, sid: 's', permission: true }]) {
    assert.equal(GS.switchPlan(o), 'busy');
    assert.ok(GS.switchWhy(o), JSON.stringify(o));
  }
  for (const d of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[<0;10;5M', '\x1b[A', '', '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', '\x1bP>|xterm.js(5.5.0)\x1b\\']) assert.equal(GS.typesInput(d), false, JSON.stringify(d));
  for (const d of ['a', '\r', 'hello\r', '\x1b[200~text\x1b[201~', '\x03']) assert.equal(GS.typesInput(d), true, JSON.stringify(d));
});

test('settingLine: set_model / set_permission_mode control requests, only known values', () => {
  const GS2 = require('../src/gui-session.js');
  const p = (s) => JSON.parse(s);
  assert.deepEqual(p(GS2.settingLine('s1', 'model', 'opus')), { type: 'control_request', request_id: 's1', request: { subtype: 'set_model', model: 'opus' } });
  assert.deepEqual(p(GS2.settingLine('s2', 'model', '')), { type: 'control_request', request_id: 's2', request: { subtype: 'set_model' } });
  assert.deepEqual(p(GS2.settingLine('s3', 'mode', 'plan')), { type: 'control_request', request_id: 's3', request: { subtype: 'set_permission_mode', mode: 'plan' } });
  assert.equal(GS2.settingLine('s4', 'mode', 'bypassPermissions'), null);
  assert.equal(GS2.settingLine('s5', 'model', 'gpt-4'), null);
  assert.equal(GS2.settingLine('s6', 'effort', 'high'), null);
});

test('nextLive: a user or assistant message outside a turn does not make a fresh session busy', () => {
  const GS3 = require('../src/gui-session.js');
  const idle = { busy: false, text: '', tool: '' };
  assert.deepEqual(GS3.nextLive(idle, { type: 'user', parent_tool_use_id: null, message: { content: 'replayed' } }), idle);
  assert.deepEqual(GS3.nextLive(idle, { type: 'assistant', parent_tool_use_id: null, message: { content: [] } }), idle);
  assert.equal(GS3.nextLive(idle, { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } }).busy, true);
  assert.equal(GS3.nextLive({ busy: true, text: 'x', tool: 'Read' }, { type: 'user', parent_tool_use_id: null }).busy, true);
});

test('GUI chat setting: waits for claude\'s control_response; an error reply changes nothing and is reported', async () => {
  const { spawn, made } = fakeSpawn();
  const t = spawnGui(spawn, 'sh', [], { cwd: '/', env: {} }, { killGroup: () => {} });
  const c = made[0].c;
  assert.equal(await t.setting('model', 'gpt-4'), 'bad');
  const ok = t.setting('model', 'sonnet');
  const req = c.written.at(-1);
  assert.equal(req.request.subtype, 'set_model');
  assert.equal(await t.setting('mode', 'plan'), 'busy', 'one setting request at a time');
  assert.equal(t.settings().model, '', 'not recorded before claude answers');
  c.out({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { model: 'claude-sonnet' } } });
  assert.equal(await ok, 'ok');
  assert.equal(t.settings().model, 'sonnet');
  const bad = t.setting('mode', 'plan');
  const req2 = c.written.at(-1);
  c.out({ type: 'control_response', response: { subtype: 'error', request_id: req2.request_id, error: 'Cannot set permission mode' } });
  assert.equal(await bad, 'error:Cannot set permission mode');
  assert.equal(t.settings().mode, '', 'an error reply records nothing');
  assert.equal(t.live().busy, false, 'a setting never starts a turn');
  const lost = t.setting('mode', 'plan');
  c.emit('exit', 0, null);
  assert.equal(await lost, 'gone');
});
