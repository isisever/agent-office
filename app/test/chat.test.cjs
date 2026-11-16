// Chat view (contract v3.78): src/chat.js reads a Claude Code transcript into chat items.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/chat.js');

const line = (o) => `${JSON.stringify({ timestamp: '2026-11-16T10:00:00.000Z', ...o })}\n`;
const user = (content, extra = {}) => line({ type: 'user', uuid: `u${Math.random()}`, message: { role: 'user', content }, ...extra });
const assistant = (content, extra = {}) => line({ type: 'assistant', uuid: `a${Math.random()}`, message: { role: 'assistant', content }, ...extra });
const kinds = (items) => items.map((i) => i.kind);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-chat-'));

test('chatItems: the person, the answer and one line per tool call; results only mark the call', () => {
  const text = user('README yaz') +
    assistant([{ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'Bakıyorum.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\n--watch' } }]) +
    user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'long output that is never shown' }]) +
    assistant([{ type: 'tool_use', id: 't2', name: 'mcp__office__office_dispatch', input: { project: 'web' } }]);
  const items = C.chatItems(text);
  assert.deepEqual(kinds(items), ['user', 'assistant', 'tool', 'toolDone', 'tool']);
  assert.equal(items[0].text, 'README yaz');
  assert.equal(items[2].name, 'Bash');
  assert.equal(items[2].detail, 'npm test --watch');
  assert.deepEqual({ id: items[3].id, error: items[3].error }, { id: 't1', error: true });
  assert.equal(items[4].name, 'office · office_dispatch');
  assert.ok(!JSON.stringify(items).includes('secret plan'), 'thinking is never shown');
  assert.ok(!JSON.stringify(items).includes('long output'), "a tool result's content is never shown");
  assert.equal(new Set(items.map((i) => i.key)).size, items.length, 'keys are unique');
  assert.equal(items[0].at, Date.parse('2026-11-16T10:00:00.000Z'));
});

test('chatItems: meta, sidechain and Claude Code’s own lines are left out; commands and notes are short', () => {
  const text = user('hidden meta', { isMeta: true }) +
    assistant([{ type: 'text', text: 'sub-agent talk' }], { isSidechain: true }) +
    user('<local-command-caveat>Caveat: …</local-command-caveat>') +
    user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>') +
    user('<local-command-stdout>Set model to sonnet</local-command-stdout>') +
    user('<task-notification><task-id>x</task-id></task-notification>') +
    user([{ type: 'text', text: '[Request interrupted by user]' }]) +
    user('summary of the earlier conversation', { isCompactSummary: true }) +
    user([{ type: 'text', text: 'şuna bak' }, { type: 'image', source: {} }]) +
    user([{ type: 'text', text: '[Image: source: /tmp/x.png]' }]) +
    line({ type: 'system', subtype: 'turn_duration' }) + line({ type: 'file-history-snapshot' }) + 'not json\n' +
    assistant([{ type: 'text', text: 'API Error: 529' }], { isApiErrorMessage: true });
  const items = C.chatItems(text);
  assert.deepEqual(kinds(items), ['command', 'note', 'note', 'note', 'user', 'error']);
  assert.equal(items[0].text, '/model sonnet');
  assert.deepEqual(items.filter((i) => i.kind === 'note').map((i) => i.note), ['task', 'interrupted', 'compact']);
  assert.deepEqual({ text: items[4].text, images: items[4].images }, { text: 'şuna bak', images: 1 });
  assert.ok(!JSON.stringify(items).includes('sub-agent talk'));
  assert.ok(!JSON.stringify(items).includes('hidden meta'));
});

test('toolDetail: the meaningful field, on one line and cut', () => {
  assert.equal(C.toolDetail('Read', { file_path: '/a/b.js' }), '/a/b.js');
  assert.equal(C.toolDetail('Grep', { pattern: 'foo', path: '/x' }), '/x');
  assert.equal(C.toolDetail('Task', { description: 'review', prompt: 'long…' }), 'review');
  assert.equal(C.toolDetail('TodoWrite', { todos: [{}, {}] }), '2');
  assert.equal(C.toolDetail('X', null), '');
  assert.ok(C.toolDetail('Bash', { command: 'x'.repeat(500) }).length <= 160);
});

test('readChat: the first read starts at a line start near the end; later reads return only new whole lines', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  const filler = user('x'.repeat(1000));
  fs.writeFileSync(f, filler.repeat(Math.ceil(C.TAIL / filler.length) + 5) + user('son mesaj'));
  const a = C.readChat(f, null);
  assert.equal(a.reset, true);
  assert.equal(a.items.at(-1).text, 'son mesaj');
  assert.ok(a.items.every((i) => i.kind === 'user'), 'the cut first line is skipped, not shown as garbage');
  assert.equal(a.cursor.size, fs.statSync(f).size);

  const same = C.readChat(f, a.cursor);
  assert.deepEqual([same.reset, same.items.length, same.more], [false, 0, false]);

  // a line still being written waits for its end
  const next = assistant([{ type: 'text', text: 'cevap' }]);
  fs.appendFileSync(f, next.slice(0, 20));
  const half = C.readChat(f, a.cursor);
  assert.equal(half.items.length, 0);
  assert.equal(half.cursor.size, a.cursor.size);
  fs.appendFileSync(f, next.slice(20));
  const b = C.readChat(f, half.cursor);
  assert.deepEqual([b.reset, b.items.map((i) => i.text)], [false, ['cevap']]);
});

test('readChat: another file, a replaced or shorter file starts over; a missing file is empty', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, user('bir') + user('iki'));
  const a = C.readChat(f, null);
  assert.equal(a.items.length, 2);
  fs.writeFileSync(f, user('yeni'));   // shorter
  const b = C.readChat(f, a.cursor);
  assert.deepEqual([b.reset, b.items.map((i) => i.text)], [true, ['yeni']]);
  const g = path.join(dir, 't.jsonl');
  fs.writeFileSync(g, user('öteki'));
  assert.equal(C.readChat(g, b.cursor).reset, true);
  assert.equal(C.readChat(f, { file: f, ino: b.cursor.ino, size: -5 }).reset, true, 'a bad cursor is ignored');
  assert.deepEqual(C.readChat(path.join(dir, 'none.jsonl'), b.cursor), { cursor: null, items: [], reset: true, more: false });
});

test('readChat: a big gain comes in steps (more), and a line longer than a step never stalls the reading', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, user('başla'));
  const a = C.readChat(f, null);
  const big = user('y'.repeat(C.STEP_MAX + 10));
  fs.appendFileSync(f, big + user('sonra'));
  let cur = a.cursor;
  const seen = [];
  for (let n = 0; n < 5; n++) {
    const r = C.readChat(f, cur);
    seen.push(...r.items.map((i) => i.text));
    cur = r.cursor;
    if (!r.more) break;
  }
  assert.deepEqual(seen, ['sonra']);
  assert.equal(cur.size, fs.statSync(f).size);
});

test('sendRefused: nothing is typed over an approval menu, a draft, a handoff or into a stopped tab', () => {
  const ok = { text: 'merhaba', running: true, locked: false, draft: false, permission: false };
  assert.equal(C.sendRefused(ok), null);
  assert.equal(C.sendRefused({ ...ok, text: '   ' }), 'empty');
  assert.equal(C.sendRefused({ ...ok, text: 'x'.repeat(C.TEXT_MAX + 1) }), 'too-long');
  assert.equal(C.sendRefused({ ...ok, locked: true }), 'locked');
  assert.equal(C.sendRefused({ ...ok, running: false }), 'not-running');
  assert.equal(C.sendRefused({ ...ok, permission: true }), 'permission');
  assert.equal(C.sendRefused({ ...ok, draft: true }), 'draft');
});

test('menuKeys: only option numbers, Esc, the tab arrows, Enter and one line of text', () => {
  assert.deepEqual(C.menuKeys(['2']), ['2']);
  assert.deepEqual(C.menuKeys(['3', { text: ' Yeşil\nve\x1b[2Jmavi ' }, '\r']), ['3', 'Yeşil ve [2Jmavi', '\r']);
  assert.deepEqual(C.menuKeys(['\x1b[C', '1']), ['\x1b[C', '1']);
  assert.deepEqual(C.menuKeys(['\x1b']), ['\x1b']);
  for (const bad of [[], ['0'], ['10'], ['a'], ['\x03'], ['\x1b[A'], [{ text: '   ' }], [{ text: 'x'.repeat(2001) }], [1], null, 'x', Array(9).fill('1')]) {
    assert.equal(C.menuKeys(bad), null, JSON.stringify(bad));
  }
});

test('toolDetail: an AskUserQuestion call shows its questions', () => {
  assert.equal(C.toolDetail('AskUserQuestion', { questions: [{ question: 'Renk?' }, { question: 'Boyut?' }] }), 'Renk? · Boyut?');
});

test('main.js: chat:send types through typePrompt; chatView is written only once set', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const send = src.slice(src.indexOf("ipcMain.handle('chat:send'"), src.indexOf("ipcMain.handle('chat:send'") + 900);
  assert.match(send, /CHAT\.sendRefused\(/);
  assert.match(send, /typePrompt\(id,/);
  assert.match(src, /\.\.\.\(typeof raw\.chatView === 'boolean' \? \{ chatView: raw\.chatView \} : \{\}\)/);
  assert.match(src, /chatView: state\.chatView === true/);
  const keys = src.slice(src.indexOf("ipcMain.handle('chat:keys'"), src.indexOf("ipcMain.handle('chat:keys'") + 900);
  assert.match(keys, /CHAT\.menuKeys\(steps\)/);
  assert.doesNotMatch(keys, /hqMinter|draftAfter/, 'a menu answer is no draft and no HQ request');
});
