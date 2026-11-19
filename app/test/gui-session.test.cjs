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
