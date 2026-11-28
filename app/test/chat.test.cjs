// Chat view (contract v3.80): src/chat.js reads a Claude Code transcript into chat items.
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
  // v3.117 a command's printed text is shown (it was hidden before)
  assert.deepEqual(kinds(items), ['command', 'output', 'note', 'note', 'note', 'user', 'error']);
  assert.equal(items[0].text, '/model sonnet');
  assert.equal(items[1].text, 'Set model to sonnet');
  assert.deepEqual(items.filter((i) => i.kind === 'note').map((i) => i.note), ['task', 'interrupted', 'compact']);
  assert.deepEqual({ text: items[5].text, images: items[5].images }, { text: 'şuna bak', images: 1 });
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

test('menuKeys: only option numbers, Esc, the arrows (v3.80 amendment: ↑ ↓ for a dialog without numbers), Enter and one line of text', () => {
  assert.deepEqual(C.menuKeys(['2']), ['2']);
  assert.deepEqual(C.menuKeys(['3', { text: ' Yeşil\nve\x1b[2Jmavi ' }, '\r']), ['3', 'Yeşil ve [2Jmavi', '\r']);
  assert.deepEqual(C.menuKeys(['\x1b[C', '1']), ['\x1b[C', '1']);
  assert.deepEqual(C.menuKeys(['\x1b']), ['\x1b']);
  for (const bad of [[], ['0'], ['10'], ['a'], ['\x03'], ['\x1b[H'], ['\x1b[3~'], [{ text: '   ' }], [{ text: 'x'.repeat(2001) }], [1], null, 'x', Array(9).fill('1')]) {
    assert.equal(C.menuKeys(bad), null, JSON.stringify(bad));
  }
});

test('toolDetail: an AskUserQuestion call shows its questions', () => {
  assert.equal(C.toolDetail('AskUserQuestion', { questions: [{ question: 'Renk?' }, { question: 'Boyut?' }] }), 'Renk? · Boyut?');
});

test('main.js: chat:send types through typePrompt; chatView is written only once set', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const send = src.slice(src.indexOf("ipcMain.handle('chat:send'"), src.indexOf("ipcMain.handle('chat:send'") + 2400);   // v3.109 images are checked first
  assert.match(send, /CHAT\.sendRefused\(/);
  assert.match(send, /typePrompt\(id,/);
  assert.match(src, /\.\.\.\(typeof raw\.chatView === 'boolean' \? \{ chatView: raw\.chatView \} : \{\}\)/);
  assert.match(src, /chatView: state\.chatView === true/);
  const keys = src.slice(src.indexOf("ipcMain.handle('chat:keys'"), src.indexOf("ipcMain.handle('chat:keys'") + 900);
  assert.match(keys, /CHAT\.menuKeys\(steps\)/);
  assert.doesNotMatch(keys, /hqMinter|draftAfter/, 'a menu answer is no draft and no HQ request');
  assert.match(keys, /typeof expect !== 'string' \|\| !expect\) return 'stale'/, 'a call that names no menu types nothing');
  assert.match(keys, /menuTyping\.get\(id\)[^\n]*return 'busy'/, 'one answer at a time');
  // the renderer checks the menu on the live screen (not the scrolled view) right before it sends the keys
  const chat = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  const press = chat.slice(chat.indexOf('async function press('), chat.indexOf('async function press(') + 900);
  // a menu or a dialog: the re-read is the same reader the card was drawn with, and a terminal-only one types nothing
  assert.match(press, /now = openOnScreen\(screen\(\)\)/);
  assert.match(press, /keyOf\(now\) !== expect \|\| mustUseTerminal\(now\)/);
  assert.ok(press.indexOf('keyOf(now) !== expect') < press.indexOf('api.chat.keys(ptyId, steps, expect)'), 'checked before the keys are sent');
  assert.match(chat, /const keyOf = screenKey;/);
  assert.match(chat.slice(chat.indexOf('function checkMenu('), chat.indexOf('function checkMenu(') + 300), /m = openOnScreen\(screen\(\)\)/, 'the card reads the screen the same way');
  // one item that throws while it is rendered does not drop the rest of the batch
  const app = chat.slice(chat.indexOf('function append('), chat.indexOf('function append(') + 900);
  assert.match(app, /try \{ n = item\(it\); \} catch/);
  assert.match(app, /textBody\(it\.text\)/);
  const term = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'terminal.js'), 'utf8');
  const scr = term.slice(term.indexOf('    screen() {'), term.indexOf('    screen() {') + 300);
  assert.match(scr, /b\.baseY \+ i/);
  assert.doesNotMatch(scr, /viewportY/);
});

test('chat reply: the quoted message goes first as "> " lines, cut at a word end', async () => {
  const R = await import('../src/chat-reply.mjs');
  assert.equal(R.withReply('first line\n\nsecond', 'my answer'), '> first line\n>\n> second\n\nmy answer');
  assert.equal(R.withReply('   ', 'plain'), 'plain');
  const long = 'word '.repeat(300);
  const q = R.quoteExcerpt(long);
  assert.ok(q.length <= R.QUOTE_MAX + 1 && q.endsWith('…') && !q.includes('wor…'));
  assert.equal(R.quoteExcerpt('a\r\nb'), 'a\nb');
});

test('chat markdown: blocks and inline marks as data, never HTML', async () => {
  const M = await import('../src/chat-md.mjs');
  const flat = (k) => k.map((x) => (x.t === 'text' || x.t === 'code' ? `${x.t === 'code' ? '`' : ''}${x.text}` : `<${x.t}${x.href ? ` ${x.href}` : ''}>${flat(x.kids)}</${x.t}>`)).join('');
  assert.equal(flat(M.inline('**aa** and *bb* and __cc__ ~~dd~~ `x*y*` snake_case_name')), '<b>aa</b> and <i>bb</i> and <b>cc</b> <s>dd</s> `x*y* snake_case_name');
  assert.equal(flat(M.inline('see [docs](https://ex.com/a) or https://ex.com/b.')), 'see <link https://ex.com/a>docs</link> or <link https://ex.com/b>https://ex.com/b</link>.');
  assert.equal(flat(M.inline('[x](javascript:alert(1)) <b>raw</b> 2 * 3 * 4')), '[x](javascript:alert(1)) <b>raw</b> 2 * 3 * 4', 'unsafe links and HTML stay text; spaced stars are no italic');
  const b = M.blocks('# Title\n\nText **bold**\nnext line\n\n- one\n- two\n  - nested\n1. first\n2. second\n\n> quoted\n\n---\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|--:|\n| 1 | **2** |');
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'ul', 'ol', 'quote', 'hr', 'pre', 'table']);
  assert.equal(b[0].level, 1);
  assert.equal(flat(b[1].kids), 'Text <b>bold</b>\nnext line');
  assert.equal(b[2].items.length, 2);
  assert.equal(b[2].items[1].sub[0].t, 'ul');
  assert.deepEqual([b[3].start, b[3].items.length], [1, 2]);
  assert.equal(b[6].lang, 'js');
  assert.equal(b[6].text, 'const a = 1;');
  assert.deepEqual([b[7].head.length, b[7].rows.length, b[7].align], [2, 1, ['left', 'right']]);
  assert.equal(flat(b[7].rows[0][1]), '<b>2</b>');
  assert.deepEqual(M.blocks('```\nunclosed\n# not a head').map((x) => x.t), ['pre'], 'an open fence runs to the end');
});

test('chat markdown: a heading with a long run of spaces parses in linear time', async () => {
  const M = await import('../src/chat-md.mjs');
  const flat = (k) => k.map((x) => x.text ?? '').join('');
  const t0 = performance.now();
  const b = M.blocks(`# a${' '.repeat(4000)}b\n## Title${' '.repeat(3000)}.\ntext${' '.repeat(4000)}# x\n# ${' '.repeat(4000)}`);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `took ${ms} ms`);
  assert.deepEqual(b.slice(0, 2).map((x) => [x.t, x.level]), [['h', 1], ['h', 2]]);
  assert.equal(flat(b[0].kids).length, 4002);
  // closing #s and spaces are still cut
  assert.equal(flat(M.blocks('## Title ##  ')[0].kids), 'Title');
  assert.equal(flat(M.blocks('# a#')[0].kids), 'a');
  assert.equal(flat(M.blocks('#   ')[0].kids), '');
  assert.equal(M.blocks('#tag')[0].t, 'p');
});

test('chat markdown: quotes and lists nest MAX_NEST deep, deeper marks stay text', async () => {
  const M = await import('../src/chat-md.mjs');
  const depthOf = (bs) => bs.reduce((d, b) => Math.max(d, b.t === 'quote' ? 1 + depthOf(b.blocks) : b.t === 'ul' || b.t === 'ol' ? 1 + Math.max(0, ...b.items.map((it) => depthOf(it.sub))) : 0), 0);
  const t0 = performance.now();
  const q = M.blocks(`${'>'.repeat(5000)} deep`);
  assert.equal(depthOf(q), M.MAX_NEST);
  let in4 = q;
  for (let n = 0; n < M.MAX_NEST; n++) in4 = in4[0].blocks;
  assert.equal(in4[0].t, 'p');
  assert.ok(in4[0].kids[0].text.startsWith('>>>'), 'the rest of the marks are text');
  const stairs = Array.from({ length: 3000 }, (_, n) => `${'  '.repeat(n)}- item ${n}`).join('\n');
  const l = M.blocks(stairs);
  assert.equal(depthOf(l), M.MAX_NEST);
  const mixed = M.blocks(Array.from({ length: 2000 }, (_, n) => `${'> '.repeat(n % 50)}- x`).join('\n'));
  assert.ok(depthOf(mixed) <= M.MAX_NEST);
  assert.ok(performance.now() - t0 < 2000, 'bounded work');
  // ordinary nesting is unchanged
  const ok = M.blocks('- a\n  - b\n    - c\n\n> q\n> > qq');
  assert.equal(ok[0].items[0].sub[0].items[0].sub[0].t, 'ul');
  assert.equal(ok[1].blocks[1].t, 'quote');
});

test('chat markdown: a mailto link stays text (the app opens only http(s) outside)', async () => {
  const M = await import('../src/chat-md.mjs');
  assert.deepEqual(M.inline('[mail](mailto:a@b.co)'), [{ t: 'text', text: '[mail](mailto:a@b.co)' }]);
  assert.equal(M.inline('[x](https://ex.com)')[0].t, 'link');
});

// --- v3.100 what crosses the device link (linkItems) and the redaction it relies on
test('link items: text is redacted, a tool row carries its name only, images and details stay here', () => {
  const { linkItems, chatItems: parse, LINK_TOOL_DETAIL } = require('../src/chat.js');
  const L = (o) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', ...o });
  const items = parse([
    L({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'use token: abcdefgh1234 here' }, { type: 'image', source: {} }] } }),
    L({ type: 'user', uuid: 'u0', message: { content: [{ type: 'image', source: {} }] } }),
    L({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' } }] } }),
    L({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } }),
    L({ type: 'user', uuid: 'u3', isCompactSummary: true, message: { content: 'summary text' } }),
  ].join('\n'));
  assert.ok(items.find((x) => x.kind === 'tool').detail.includes('id_ed25519'));   // the local chat view keeps its detail line
  const out = linkItems(items);
  assert.equal(LINK_TOOL_DETAIL, false);
  assert.deepEqual(out.map(({ at: _at, ...x }) => x), [
    { key: 'u1', kind: 'user', text: 'use token: [redacted] here' },
    { key: 'a1:1', kind: 'assistant', text: 'ok' },
    { key: 'a1:2', kind: 'tool', id: 't1', name: 'Bash' },
    { key: 'u2:0', kind: 'toolDone', id: 't1', error: true },
    { key: 'u3', kind: 'note', note: 'compact' },
  ]);
  for (const never of ['id_ed25519', 'hidden', 'boom', 'summary text', 'images']) assert.ok(!JSON.stringify(out).includes(never), never);
  // the opt-in that is not built: even then the detail goes through the redaction
  const withDetail = linkItems([{ key: 'k', at: 1, kind: 'tool', id: 't', name: 'Bash', detail: 'curl -H "Authorization: Bearer abcdefgh12345678"' }], { toolDetail: true });
  assert.ok(withDetail[0].detail.startsWith('curl -H') && !withDetail[0].detail.includes('abcdefgh12345678'));
  assert.deepEqual(linkItems(null), []);
});

test('link items: hidden blocks are dropped anywhere in a user message, the local view is unchanged', () => {
  const { linkItems } = require('../src/chat.js');
  const tags = ['bash-input', 'bash-stdout', 'bash-stderr', 'local-command-stdout', 'ide_selection', 'ide_opened_file', 'system-reminder', 'command-args'];
  for (const tag of tags) {
    const mid = linkItems([{ key: 'm', at: 1, kind: 'user', text: `before\n<${tag}>SECRET-${tag}</${tag}>\nafter` }]);
    assert.equal(mid[0].text, 'before\n\nafter', `${tag} in the middle`);
    const end = linkItems([{ key: 'e', at: 1, kind: 'user', text: `hello\n<${tag}>SECRET-${tag}</${tag}>` }]);
    assert.equal(end[0].text.trim(), 'hello', `${tag} at the end`);
    const cut = linkItems([{ key: 'c', at: 1, kind: 'user', text: `hello <${tag}>SECRET-${tag} and no close` }]);
    assert.equal(cut[0].text.trim(), 'hello', `${tag} cut off`);
  }
  assert.equal(linkItems([{ key: 'i', at: 1, kind: 'user', text: 'look\n[Image: source: /Users/x/shot.png]\nplease' }])[0].text, 'look\n\nplease');
  assert.deepEqual(linkItems([{ key: 'o', at: 1, kind: 'user', text: '<bash-input>ls</bash-input>' }]), []);
  assert.equal(linkItems([{ key: 'a', at: 1, kind: 'assistant', text: 'the <bash-input> tag' }])[0].text, 'the <bash-input> tag');
});

test('redaction (best effort): PEM private keys and secret-looking assignments', () => {
  const { redact } = require('../src/hq.js');
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAB3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(redact(`before\n${pem}\nafter`), 'before\n[redacted private key]\nafter');
  assert.equal(redact('x -----BEGIN RSA PRIVATE KEY-----\nMIIEow'), 'x [redacted private key]');   // cut off before its END line
  assert.equal(redact('-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY----- and -----BEGIN EC PRIVATE KEY-----\nBB\n-----END EC PRIVATE KEY-----'), '[redacted private key] and [redacted private key]');
  assert.equal(redact('-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----'), '-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----');
  assert.equal(redact('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG'), 'export AWS_SECRET_ACCESS_KEY=[redacted]');
  assert.equal(redact('API_KEY_PROD=abc12345 npm run deploy'), 'API_KEY_PROD=[redacted] npm run deploy');
  assert.equal(redact('export DB_PASSWORD_2="two words" && run'), 'export DB_PASSWORD_2=[redacted] && run');
  assert.equal(redact("STRIPE_TOKEN_LIVE='q w e'"), 'STRIPE_TOKEN_LIVE=[redacted]');
  assert.equal(redact('export SESSION=4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'), 'export SESSION=[redacted]');   // looks random
  assert.equal(redact('export PATH=/usr/local/bin:/usr/bin'), 'export PATH=/usr/local/bin:/usr/bin');
  assert.equal(redact('export NODE_ENV=production PORT=3000 AUTHOR=jane'), 'export NODE_ENV=production PORT=3000 AUTHOR=jane');
  assert.equal(redact('password=hunter22 token: abcdefgh'), 'password=[redacted] token: [redacted]');   // the older patterns still hold, once
});

test('v3.109 "@" files: git list, walk, ranking, mentions; tool lines carry their file; reveal only inside the folder', () => {
  const FM = require('../src/file-match.js');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  assert.deepEqual(FM.parseGitFiles('a.js\0src/b.js\0\0bad\nname\0'), ['a.js', 'src/b.js']);
  const files = ['src/login/form.js', 'README.md', 'test/login.test.js', 'src/app.js', 'docs/blogin-notes.md'];
  assert.deepEqual(FM.rankFiles(files, 'login'), ['test/login.test.js', 'docs/blogin-notes.md', 'src/login/form.js'], 'name starts, name contains, path contains');
  assert.deepEqual(FM.rankFiles(files, 'sapp'), ['src/app.js'], 'letters in order');
  assert.equal(FM.rankFiles(files, '').length, 5);
  assert.equal(FM.mention('src/a.js'), '@src/a.js');
  assert.equal(FM.mention('docs/setup "guide".md'), '@"docs/setup guide.md"', 'a path with a space is quoted (quotes inside dropped)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fm-'));
  try {
    for (const f of ['a.txt', 'src/b.js', 'node_modules/x/c.js', '.git/HEAD', '.hidden/d.txt']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x'); }
    assert.deepEqual(FM.walkFiles(dir).sort(), ['a.txt', 'src/b.js'], 'no node_modules, no dot folders');
    assert.ok(FM.insidePath(dir, 'src/b.js').endsWith(path.join('src', 'b.js')));
    assert.ok(FM.insidePath(dir, path.join(dir, 'a.txt')));
    assert.equal(FM.insidePath(dir, '../../etc/passwd'), '');
    assert.equal(FM.insidePath(dir, '/etc/hosts'), '');
    assert.equal(FM.insidePath(dir, 'missing.txt'), '', 'only what exists');
    if (process.platform !== 'win32') {
      fs.symlinkSync('/etc', path.join(dir, 'out'));
      assert.equal(FM.insidePath(dir, 'out/hosts'), '', 'a link out of the folder is outside');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const CHAT = require('../src/chat.js');
  const items = CHAT.chatItems(JSON.stringify({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/src/a.js', old_string: 'x' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } }));
  assert.equal(items[0].path, '/w/src/a.js');
  assert.equal('path' in items[1], false);
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const reveal = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:reveal'"), MAIN.indexOf("ipcMain.handle('chat:reveal'") + 900);
  assert.match(reveal, /^ipcMain\.handle\('chat:reveal', \(_e, id, p\) => revealInside\(String\(id \|\| ''\), p\)\);\n/);
  assert.match(reveal, /FM\.revealTarget\(\[r\.dir, r\.project\?\.dir\], p\)/);
  assert.match(reveal, /if \(!target\) return 'outside';/);
  assert.match(reveal, /if \(target\.root\) eShell\.openPath\(target\.path\); else eShell\.showItemInFolder\(target\.path\);/);
  assert.doesNotMatch(reveal, /openExternal/);
});

test('v3.109 pasted images: checked types, count and size; image blocks for a GUI tab, @path files for a terminal tab', () => {
  const CHAT = require('../src/chat.js');
  const GS = require('../src/gui-session.js');
  const fs = require('node:fs'); const path = require('node:path');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  assert.deepEqual(CHAT.cleanImages(undefined), { images: [] });
  assert.deepEqual(CHAT.cleanImages([{ type: 'IMAGE/PNG', data: png }]).images, [{ type: 'image/png', data: png, ext: 'png' }]);
  assert.deepEqual(CHAT.cleanImages([{ type: 'image/tiff', data: png }]), { error: 'image-type' });
  assert.deepEqual(CHAT.cleanImages([{ type: 'image/png', data: 'not base64!' }]), { error: 'image-type' });
  assert.deepEqual(CHAT.cleanImages(Array.from({ length: 6 }, () => ({ type: 'image/png', data: png }))), { error: 'too-many-images' });
  assert.deepEqual(CHAT.cleanImages([{ type: 'image/jpeg', data: 'A'.repeat(CHAT.IMAGE_MAX + 4) }]), { error: 'image-size' }, 'the base64 text counts (as the API counts it)');
  assert.equal(CHAT.cleanImages([{ type: 'image/jpeg', data: 'A'.repeat(CHAT.IMAGE_MAX) }]).images.length, 1);
  const withImg = JSON.parse(GS.userLine('look', [{ type: 'image/png', data: png }]));
  assert.deepEqual(withImg.message.content, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]);
  assert.deepEqual(JSON.parse(GS.userLine('', [{ type: 'image/png', data: png }])).message.content.map((b) => b.type), ['image'], 'an image alone');
  assert.equal(JSON.parse(GS.userLine('plain')).message.content, 'plain', 'no images: a plain string as before');
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const send = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:send'"), MAIN.indexOf('const chatImagesDir'));
  assert.ok(send.indexOf('CHAT.cleanImages(images)') < send.indexOf('typePrompt('), 'checked before anything is sent');
  assert.match(send, /if \(gui \|\| !img\.images\.length\) \{[\s\S]*?typePrompt\(id, ctx \+ body, \{ images: img\.images \}\)/);
  assert.match(send, /paths\.map\(FM\.mention\)/);
  const save = MAIN.slice(MAIN.indexOf('function saveChatImages('), MAIN.indexOf('function saveChatImages(') + 900);
  assert.match(save, /mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(save, /\{ mode: 0o600, flag: 'wx' \}/);
  assert.match(save, /7 \* 864e5/);
  assert.match(send, /for \(const p of paths\) \{ try \{ fs\.rmSync\(p\); \}/, 'files of a message that was not typed go at once');
  // a mode switch never cuts a prompt just typed in, nor a task that has not reported
  assert.match(MAIN, /const guiRecent = \(pid\) => Date\.now\(\) - \(activity\.get\(pid\)\?\.inputAt \|\| 0\) < 15000;/);
  assert.match(MAIN, /return guiRecent\(pid\) \|\| guiTaskOpen\(pid\);/);
  assert.match(MAIN, /handoffLocked\(pid\) \|\| guiHolds\(pid\)\) continue;/);
  // v3.112 the Terminal button: a terminal tab still waits out the typing window; every tab waits for an open task
  assert.match(MAIN, /tasks: guiTaskOpen\(id\), working: t\.gui \? guiWorking\(sid\) : false, recent: !waived && guiRecent\(id\)/);
  // v3.116 only typing marks a tab as just written to: never its output or a focus report
  assert.equal((MAIN.match(/a\.inputAt = a\.at/g) || []).length, 5);
  assert.doesNotMatch(MAIN.slice(MAIN.indexOf('onData: (d) => {'), MAIN.indexOf('onExit:', MAIN.indexOf('onData: (d) => {'))), /inputAt/);
  assert.match(MAIN, /if \(!t\.sendUser\(text, images\)\) return false;/);
});

test('v3.113 Show in Finder: real paths on both sides, worktree tabs, files that are gone; the attach button', () => {
  const FM = require('../src/file-match.js');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-reveal-')));
  try {
    const proj = path.join(base, 'proj');
    const wt = path.join(base, 'proj-wt-2');
    for (const f of ['proj/src/a.js', 'proj/..notes.md', 'proj-wt-2/src/a.js', 'other/x.txt']) { fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true }); fs.writeFileSync(path.join(base, f), 'x'); }
    // absolute and relative paths, and a name that only starts with ".."
    assert.deepEqual(FM.revealTarget(proj, path.join(proj, 'src/a.js')), { path: path.join(proj, 'src/a.js'), gone: false });
    assert.deepEqual(FM.revealTarget(proj, 'src/a.js'), { path: path.join(proj, 'src/a.js'), gone: false });
    assert.equal(FM.revealTarget(proj, '..notes.md')?.path, path.join(proj, '..notes.md'), '"..notes.md" is inside');
    assert.equal(FM.revealTarget(proj, '../other/x.txt'), null);
    assert.equal(FM.revealTarget(proj, path.join(base, 'other/x.txt')), null);
    assert.equal(FM.revealTarget(proj, ''), null);
    assert.equal(FM.revealTarget(proj, 'a\0b'), null);
    assert.equal(FM.revealTarget([], 'src/a.js'), null);
    // a worktree tab: its own folder first, the project's folder too
    assert.equal(FM.revealTarget([wt, proj], 'src/a.js')?.path, path.join(wt, 'src/a.js'), 'relative: from the tab folder');
    assert.equal(FM.revealTarget([wt, proj], path.join(proj, 'src/a.js'))?.path, path.join(proj, 'src/a.js'), 'the project folder is allowed too');
    assert.equal(FM.revealTarget([wt, proj], path.join(base, 'other/x.txt')), null);
    assert.equal(FM.revealTarget(wt, path.join(proj, 'src/a.js')), null, 'only the folders given');
    // gone: the nearest existing folder inside; never a folder outside
    assert.deepEqual(FM.revealTarget(proj, 'src/deleted.js'), { path: path.join(proj, 'src'), gone: true });
    assert.deepEqual(FM.revealTarget(proj, path.join(proj, 'new/deep/file.js')), { path: proj, gone: true, root: true }, 'the root itself: opened, not shown');
    assert.equal(FM.revealTarget(proj, path.join(base, 'other/gone.txt')), null);
    assert.equal(FM.revealTarget(proj, '/no-such-root-ao/x.js'), null);
    assert.equal(FM.insidePath(proj, 'src/deleted.js'), '', 'insidePath stays: only what exists');
    if (process.platform !== 'win32') {
      // linked roots (macOS /tmp → /private/tmp): the tab folder through a link, the file through the real path, and back
      const link = path.join(base, 'link-to-proj');
      fs.symlinkSync(proj, link);
      assert.equal(FM.revealTarget(link, path.join(proj, 'src/a.js'))?.path, path.join(proj, 'src/a.js'));
      assert.equal(FM.revealTarget(proj, path.join(link, 'src/a.js'))?.path, path.join(proj, 'src/a.js'));
      assert.deepEqual(FM.revealTarget(link, path.join(link, 'src/gone.js')), { path: path.join(proj, 'src'), gone: true });
      if (process.platform === 'darwin' && fs.existsSync('/private/tmp')) {
        const t = fs.mkdtempSync('/tmp/ao-reveal-');
        try {
          fs.writeFileSync(path.join(t, 'f.txt'), 'x');
          const priv = path.join('/private', t);
          assert.equal(FM.revealTarget(t, path.join(priv, 'f.txt'))?.path, path.join(priv, 'f.txt'), '/tmp tab, /private/tmp file');
          assert.equal(FM.revealTarget(priv, path.join(t, 'f.txt'))?.path, path.join(priv, 'f.txt'), '/private/tmp tab, /tmp file');
          assert.deepEqual(FM.revealTarget(t, path.join(priv, 'gone/f.txt')), { path: priv, gone: true, root: true });
        } finally { fs.rmSync(t, { recursive: true, force: true }); }
      }
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
  // picked files: images the API takes by their name
  assert.equal(FM.imageType('/a/b/Shot.PNG'), 'image/png');
  assert.equal(FM.imageType('x.jpeg'), 'image/jpeg');
  assert.equal(FM.imageType('x.jpg'), 'image/jpeg');
  assert.equal(FM.imageType('x.webp'), 'image/webp');
  assert.equal(FM.imageType('x.gif'), 'image/gif');
  assert.equal(FM.imageType('x.svg'), '');
  assert.equal(FM.imageType('/a/png'), '');
  // wiring: main's picker, preload, the renderer's button, strings in both languages
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const pick = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:pick'"), MAIN.indexOf("ipcMain.handle('chat:pick'") + 1400);
  assert.match(pick, /dialog\.showOpenDialog\(win, \{/);
  assert.match(pick, /: \['openFile', 'multiSelections'\]/, 'several files at once on every system');
  assert.match(pick, /\['openFile', 'openDirectory', 'multiSelections'\]/, 'v3.121 folders too on macOS');
  assert.match(pick, /defaultPath: r\.dir/);
  assert.match(pick, /FM\.imageType\(p\)/);
  assert.match(pick, /st\.size <= FM\.PICK_IMAGE_MAX/);
  assert.match(pick, /data: await fs\.promises\.readFile\(p\)/);
  assert.doesNotMatch(pick, /base64/, 'bytes over IPC, not base64');
  assert.equal(FM.PICK_IMAGE_MAX, 10 * 1024 * 1024);
  assert.match(MAIN, /return target\.gone \? 'gone' : 'ok';/);
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(PRE, /pick: \(id, wantImages\) => ipcRenderer\.invoke\('chat:pick', id, wantImages\)/);
  const R = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  assert.match(R, /class: 'chat-attach'/);
  assert.match(R, /api\.chat\.pick\(ptyId, Boolean\(gui\)\)/);
  // v3.121 picked non-image files go through attachPaths: chips in Studio, still @path in the input in the Office
  assert.match(R, /if \(blobs\.length\) addImages\(blobs\.map[^\n]*\n\s+if \(paths\.length\) attachPaths\(paths[,)]/);
  assert.match(R, /function attachPaths\([^)]*\) \{\n\s+if \(studioOn\(\) && !source\) addFiles\([^\n]*\n\s+else \{ registerAttached\(paths\); insertPaths\(paths\); \}/);
  assert.match(R, /new Blob\(\[im\.data\]/);
  assert.doesNotMatch(R, /atob/);
  assert.match(R, /if \(attach\.disabled\) return;/);
  assert.match(R, /if \(onFail\) onFail\(f\); else note\(t\('chat\.why\.image-size'\)\)/);
  assert.match(R, /if \(r === 'gone'\) note\(t\('chat\.revealGone'\)\);/);
  for (const lang of ['en', 'tr']) {
    const L = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'));
    assert.ok(L.chat.attach && L.chat.revealGone && L.main.chatPickFiles, lang);
  }
});

// ---- v3.115 sub-agents in the chat (test names: "v3.115 …" below)
test('chatItems: an Agent call is marked as one; a sub-agent transcript is read with its sidechain lines', () => {
  const boss = assistant([{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Port HR', prompt: 'long brief' } }, { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/a' } }]);
  const items = C.chatItems(boss);
  assert.equal(items[0].agent, true);
  assert.equal(items[0].detail, 'Port HR');
  assert.equal(items[1].agent, undefined);
  const side = user('Do the port', { isSidechain: true }) + assistant([{ type: 'text', text: 'Done.' }], { isSidechain: true });
  assert.deepEqual(C.chatItems(side), [], 'the boss chat never shows sidechain lines');
  assert.deepEqual(kinds(C.chatItems(side, { sidechain: true })), ['user', 'assistant']);
});

test('agentFile: only ids Claude Code makes build a path, inside the session\'s subagents folder', () => {
  const t = path.join('/x', 'proj', 's1.jsonl');
  assert.equal(C.agentFile(t, 'a3d81ff3acf26ea76'), path.join('/x', 'proj', 's1', 'subagents', 'agent-a3d81ff3acf26ea76.jsonl'));
  for (const bad of ['../s2', 'a/b', '', 'a.b', 'x'.repeat(65), 5, null]) assert.equal(C.agentFile(t, bad), null, String(bad));
  assert.equal(C.agentFile('', 'abc'), null);
});

test('chatAgents: meta links each agent to its Agent call; workers say which run; old unfinished ones stopped', () => {
  const dir = tmp();
  const t = path.join(dir, 's1.jsonl');
  fs.writeFileSync(t, '');
  const sub = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const put = (id, meta, ageMs) => {
    const f = path.join(sub, `agent-${id}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    if (meta) fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify(meta));
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(f, when, when);
  };
  put('run1', { agentType: 'Explore', description: 'Look\naround', toolUseId: 'tuA' }, 600000);
  put('done1', { agentType: 'fork', description: 'Port', toolUseId: 'tuB', finished: true }, 600000);
  put('old1', { agentType: 'fork', description: 'Killed', toolUseId: 'tuC' }, 600000);
  put('fresh1', { description: 'Just started', toolUseId: 'tuD' }, 1000);
  put('nometa', null, 600000);
  fs.writeFileSync(path.join(sub, 'notes.txt'), 'x');
  const workers = [{ id: 'run1', spawnAt: 10, tool: 'mcp__s__t', detail: 'q', toolCount: 3 }, { id: 'gone', spawnAt: 1 }];
  const list = C.chatAgents(t, workers);
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(by).sort(), ['done1', 'fresh1', 'nometa', 'old1', 'run1']);
  assert.deepEqual({ ...by.run1 }, { id: 'run1', toolUseId: 'tuA', description: 'Look around', type: 'Explore', state: 'running', tool: 's · t', detail: 'q', toolCount: 3, at: 10 });
  assert.equal(by.done1.state, 'done');
  assert.equal(by.old1.state, 'stopped');
  assert.equal(by.fresh1.state, 'running');
  assert.equal(by.nometa.toolUseId, '');
  assert.equal(list[0].id, 'run1', 'oldest first');
  assert.deepEqual(C.chatAgents(path.join(dir, 'none.jsonl'), []), []);
});

test('main.js: chat:agent reads only a file agentFile built, with sidechain lines; preload exposes both calls', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = main.slice(main.indexOf("ipcMain.handle('chat:agent',"), main.indexOf('\n});\n', main.indexOf("ipcMain.handle('chat:agent',")));
  assert.match(body, /CHAT\.agentFile\(known\.file, agentId\)/);
  assert.match(body, /\{ sidechain: true \}/);
  assert.match(main, /ipcMain\.handle\('chat:agents',[\s\S]*?CHAT\.chatAgents\(known\.file, office\(\)\?\.readSession\(known\.sid\)\?\.workers\)/);
  const link = main.slice(main.indexOf('function linkSessionOf(id) {'), main.indexOf("ipcMain.handle('chat:read'"));
  assert.ok(!/subagent|chatAgents|agentFile/.test(link), 'a paired device never gets the sub-agents');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /agents: \(id\) => ipcRenderer\.invoke\('chat:agents', id\)/);
  assert.match(preload, /agent: \(id, agentId, cursor\) => ipcRenderer\.invoke\('chat:agent', id, agentId, cursor\)/);
});

test('v3.117 a command\'s printed text is an output item (no colours); it never crosses the device link', () => {
  const items = C.chatItems(user('<command-name>/model</command-name>\n<command-args></command-args>') +
    user('<local-command-stdout>Set model to `Opus`</local-command-stdout>') +
    user('<local-command-stdout>\n\x1b[1mContext\x1b[22m  ⛁ 12%   \n\n</local-command-stdout>') +
    user('<local-command-stdout></local-command-stdout>') + user('<local-command-stderr>oops</local-command-stderr>'));
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [['command', '/model'], ['output', 'Set model to `Opus`'], ['output', 'Context  ⛁ 12%']]);
  assert.deepEqual(C.linkItems(items, { redact: (s) => s }).map((i) => i.kind), ['command']);
});

test('v3.117 chat:command: a GUI tab moves to its terminal for the command (never saved), typed once idle; back ignores its own typing', () => {
  const GS = require('../src/gui-session.js');
  for (const ok of ['/resume', '/model opus', '/plugin:cmd x', '/mcp']) assert.equal(GS.isCommand(ok), true, ok);
  for (const bad of ['resume', '/', '/ x', '/a\x1b[A', '/a\rb', 5, null, `/x ${'a'.repeat(2000)}`]) assert.equal(GS.isCommand(bad), false, String(bad));
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:command'"), MAIN.indexOf('\n});\n', MAIN.indexOf("ipcMain.handle('chat:command'")));
  assert.match(body, /if \(!GS\.isCommand\(cmd\)\) return 'bad-command';/);
  assert.match(body, /if \(handoffLocked\(id\)\)/);
  assert.match(body, /if \(!t\.gui\) return 'terminal';/, 'a terminal tab goes through chat:send and its refusals');
  assert.doesNotMatch(body, /typePrompt/, 'nothing is typed before the renderer sees the prompt box');
  assert.match(body, /switchMode\(id, 'terminal', \{ temp: true \}\)/);
  // typed only when the prompt box is up and nothing else could take the keys
  const go = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:commandGo'"), MAIN.indexOf('\n});\n', MAIN.indexOf("ipcMain.handle('chat:commandGo'")));
  assert.match(go, /if \(!r \|\| guiTaskOpen\(id\) \|\| guiRecent\(id\) \|\| !idleSession\(id\) \|\| attention\.get\(r\.project\.id\) === 'permission'\) return 'wait';/);
  assert.match(go, /if \(!R\.canTypePrompt\(/);
  assert.match(go, /if \(handoffLocked\(id\)\) return 'wait';/);
  assert.match(go, /cmdTyped\.set\(id, activity\.get\(id\)\?\.inputAt \|\| Date\.now\(\)\);/);
  const sw = MAIN.slice(MAIN.indexOf('function switchMode('), MAIN.indexOf("ipcMain.handle('chat:command'"));
  assert.match(sw, /const choice = temp \? cmdTabs : termTabs;/);
  assert.match(sw, /if \(!temp\) saveState\(\)/);
  // the way back waives only the command's own typing, never a prompt typed after it
  assert.match(sw, /const waived = back && \(activity\.get\(id\)\?\.inputAt \|\| 0\) <= \(cmdTyped\.get\(id\) \|\| 0\);/);
  assert.match(sw, /recent: !waived && guiRecent\(id\)/);
  assert.match(MAIN, /terminal: termTabs\.has\(id\) \|\| cmdTabs\.has\(id\)/);
  assert.match(MAIN, /ipcMain\.handle\('chat:mode', \(_e, id, mode\) => switchMode\(String\(id\), mode\)\);/);
  const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(APP, /if \(!promptReady\(lines\)\) \{ w\.seen = true;/);
  assert.match(APP, /api\.chat\.commandGo\(id\)/);
  assert.match(APP, /if \(stillTyped\(lines, w\.text\)\)/);
  assert.match(APP, /if \(w\.gui\) setChatMode\(id, true\);/);
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8')).chat.cmd.running, lang);
});

test('v3.118 sessionList: newest first, named by /rename, then Claude Code\'s title, then the first prompt; the own session left out', () => {
  const a = tmp();
  const b = tmp();
  const put = (dir, id, text, ageS) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, text);
    const when = Date.now() / 1000 - ageS;
    fs.utimesSync(f, when, when);
  };
  put(a, 's-old', user('<command-name>/model</command-name>') + user('fix the login test', { gitBranch: 'fix/login' }) + line({ type: 'ai-title', aiTitle: 'Login test fix' }), 300);
  put(a, 's-named', user('first ask') + line({ type: 'ai-title', aiTitle: 'Auto title' }) + line({ type: 'custom-title', customTitle: 'My name' }), 200);
  put(b, 's-plain', user('README please'), 100);
  put(b, 's-own', user('this tab'), 10);
  put(a, 's-empty', line({ type: 'file-history-snapshot' }), 50);
  fs.writeFileSync(path.join(a, 'notes.txt'), 'x');
  const list = C.sessionList([a, b, a], { exclude: new Set(['s-own']) });
  assert.deepEqual(C.sessionList([b], { exclude: 's-own' }).map((s) => s.id), ['s-plain']);
  assert.deepEqual(list.map((s) => s.id), ['s-plain', 's-named', 's-old']);
  assert.deepEqual(list.map((s) => [s.title, s.prompt]), [['', 'README please'], ['My name', 'first ask'], ['Login test fix', 'fix the login test']]);
  assert.equal(list[2].branch, 'fix/login');
  assert.deepEqual(C.sessionList(['/no/such/dir']), []);
});

test('v3.118 chat:resume: only a listed session of a GUI tab, never while anything runs; preload exposes it', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:resume'"), MAIN.indexOf('\n});\n', MAIN.indexOf("ipcMain.handle('chat:resume'")));
  assert.match(body, /if \(!t\.gui\) return 'unsupported';/);
  assert.match(body, /if \(handoffLocked\(id\)\)/);
  assert.match(body, /if \(!validSid\(sid\) \|\| !\(chatSessionsOf\(id, t\) \|\| \[\]\)\.some\(\(x\) => x\.id === sid\)\) return 'gone';/);
  assert.match(body, /if \(GS\.switchPlan\(facts\) === 'busy'\) return `busy:\$\{GS\.switchWhy\(facts\)\}`;/);
  assert.match(body, /startPty\(id, \{ sessionId: sid, resume: true \}\);/);
  // a session another running tab is in is never offered (two claude processes would write one transcript)
  assert.match(MAIN, /CHAT\.sessionList\(TIO\.historyDirsOf\(r\.dir, configDir, app\.getPath\('home'\)\), \{ exclude: liveSids\(\) \}\)/);
  assert.match(MAIN.slice(MAIN.indexOf('function liveSids('), MAIN.indexOf('function liveSids(') + 700), /for \(const \[pid, tt\] of terms\)/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /sessions: \(id\) => ipcRenderer\.invoke\('chat:sessions', id\)/);
  assert.match(preload, /resume: \(id, sid\) => ipcRenderer\.invoke\('chat:resume', id, sid\)/);
});

test('PR #20 review fixes: commandGo re-checks tasks and typing, tabStateOf parks cmdTabs, liveSids skips sleeping sessions', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = (start, len) => MAIN.slice(MAIN.indexOf(start), MAIN.indexOf(start) + len);
  assert.match(body("ipcMain.handle('chat:commandGo'", 900), /guiTaskOpen\(id\) \|\| guiRecent\(id\) \|\| !idleSession\(id\)/);
  assert.match(body('function tabStateOf(', 700), /if \(cmdTabs\.has\(projectId\)\) return 'busy'/);
  assert.match(body('function liveSids(', 1400), /for \(const how of asleep\.values\(\)\)[^\n]*validSid\(how\?\.sessionId\)/);
});

test('v3.121 openTarget: a chip opens in its default app; what could run code is only shown; gone or relative is null', () => {
  const FM = require('../src/file-match.js');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-open-')));
  try {
    for (const f of ['a.txt', 'run.command', 'x.sh']) fs.writeFileSync(path.join(d, f), 'x');
    fs.mkdirSync(path.join(d, 'folder'));
    fs.mkdirSync(path.join(d, 'Tool.app'));
    assert.deepEqual(FM.openTarget(path.join(d, 'a.txt')), { path: path.join(d, 'a.txt'), action: 'open' });
    assert.equal(FM.openTarget(path.join(d, 'folder')).action, 'open');
    assert.equal(FM.openTarget(path.join(d, 'Tool.app')).action, 'reveal');
    assert.equal(FM.openTarget(path.join(d, 'run.command')).action, 'reveal');
    assert.equal(FM.openTarget(path.join(d, 'x.sh')).action, 'reveal');
    if (process.platform !== 'win32') { fs.writeFileSync(path.join(d, 'tool'), 'x'); fs.chmodSync(path.join(d, 'tool'), 0o755); assert.equal(FM.openTarget(path.join(d, 'tool')).action, 'reveal'); }
    assert.equal(FM.openTarget(path.join(d, 'gone.txt')), null);
    assert.equal(FM.openTarget('a.txt'), null);
    assert.equal(FM.openTarget(''), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN, /ipcMain\.handle\('chat:openFile', async \(e, id, p, how\) => \{\n\s+if \(!fromWin\(e\)\) return 'gone';/);
  const R = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  assert.match(R, /fileChips = \[\]; drawChips\(\); {3}\/\/ only after a send that worked/, 'chips clear only after a successful send');
});

test('v3.121 openTarget: a symbolic link and any bundle are only shown; launchers and scripts by extension too', () => {
  const FM = require('../src/file-match.js');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-open-')));
  try {
    fs.mkdirSync(path.join(d, 'Real.app', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'Real.app', 'Contents', 'Info.plist'), '<plist/>');
    fs.writeFileSync(path.join(d, 'shell.terminal'), '<plist/>');
    fs.writeFileSync(path.join(d, 'plain.txt'), 'x');
    // a bundle without a telling extension: Contents/Info.plist is enough
    fs.mkdirSync(path.join(d, 'Thing', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'Thing', 'Contents', 'Info.plist'), '<plist/>');
    assert.equal(FM.openTarget(path.join(d, 'Thing')).action, 'reveal');
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(d, 'Real.app'), path.join(d, 'notes'));        // a link to an app, with no extension
      fs.symlinkSync(path.join(d, 'shell.terminal'), path.join(d, 'readme.txt'));   // a harmless name for a .terminal
      fs.symlinkSync(path.join(d, 'plain.txt'), path.join(d, 'link.txt'));     // even a link to a plain file
      fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, 'dangling.txt'));
      assert.deepEqual(FM.openTarget(path.join(d, 'notes')), { path: path.join(d, 'notes'), action: 'reveal' });
      assert.deepEqual(FM.openTarget(path.join(d, 'readme.txt')), { path: path.join(d, 'readme.txt'), action: 'reveal' });
      assert.equal(FM.openTarget(path.join(d, 'link.txt')).action, 'reveal');
      assert.equal(FM.openTarget(path.join(d, 'dangling.txt')), null);
    }
    const exts = ['fileloc', 'prefPane', 'mpkg', 'pkg', 'action', 'workflow', 'kext', 'bundle', 'plugin', 'py', 'pl', 'rb', 'jar', 'scpt', 'applescript', 'terminal', 'webloc', 'inetloc', 'command', 'tool'];
    for (const x of exts) {
      assert.ok(FM.RUNS_EXT.has(x.toLowerCase()), x);
      const f = path.join(d, `f.${x}`);
      fs.writeFileSync(f, 'x');
      assert.equal(FM.openTarget(f).action, 'reveal', x);
    }
    assert.equal(FM.openTarget(path.join(d, 'plain.txt')).action, 'open');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('v3.121 attached files: only paths the person attached in this tab open; others are at most revealed in the project', () => {
  const ATT = require('../src/attached.js');
  const a = ATT.createAttached({ max: 3 });
  assert.equal(a.add('t1', ['/p/a.txt', 'rel/b.txt', '', null, '/p/x\0y']), 1);
  assert.ok(a.has('t1', '/p/a.txt'));
  assert.ok(a.has('t1', '/p/sub/../a.txt'), 'normalized');
  assert.ok(!a.has('t2', '/p/a.txt'), 'per tab');
  assert.ok(!a.has('t1', 'rel/b.txt'));
  assert.ok(!a.has('t1', '/p/other.txt'));
  a.add('t1', ['/p/b', '/p/c', '/p/d']);
  assert.ok(!a.has('t1', '/p/a.txt'), 'the oldest goes past the cap');
  a.forget('t1');
  assert.ok(!a.has('t1', '/p/d'));
  // the @paths of a message the person sent (the chat's mention format); relative mentions and e-mail are not paths
  assert.deepEqual(ATT.sentPaths('look at @/u/a.txt and @"/u/My File.pdf"\n\n@src/x.js mail me@host.com @/u/b'), ['/u/a.txt', '/u/My File.pdf', '/u/b']);
  assert.deepEqual(ATT.sentPaths(''), []);
  assert.deepEqual(ATT.sentPaths('> quoted @/u/theirs.html\n\nmine @/u/mine.txt'), ['/u/mine.txt']);   // a reply's quote is not attached


  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = (start, n) => MAIN.slice(MAIN.indexOf(start), MAIN.indexOf(start) + n);
  const open = body("ipcMain.handle('chat:openFile'", 600);
  assert.match(open, /if \(!attachedFiles\.has\(id, p\)\) return how === 'reveal' \? revealInside\(id, p\) : 'refused';/);
  assert.ok(open.indexOf('attachedFiles.has') < open.indexOf('FM.openTarget'), 'checked before anything opens');
  assert.match(body("ipcMain.handle('chat:pick'", 2000), /attachedFiles\.add\(String\(id\), \[\.\.\.paths, \.\.\.images\.map\(\(i\) => i\.path\)\]\);/);
  assert.match(body("ipcMain.handle('chat:send'", 1200), /attachedFiles\.add\(id, ATT\.sentPaths\(body\)\);/);
  assert.match(body("ipcMain.handle('chat:attach'", 300), /if \(!fromWin\(e\)\) return 0;/);
  assert.match(body('function revealInside(', 400), /FM\.revealTarget\(\[r\.dir, r\.project\?\.dir\], p\)/);
  // HQ, delegated and paired-device prompts never reach chat:send: they are typed into the tab by main itself
  assert.equal((MAIN.match(/attachedFiles\.add\(/g) || []).length, 3, 'only pick, attach and send add paths');
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(PRE, /openFile: \(id, path, how\) => ipcRenderer\.invoke\('chat:openFile', id, path, how\)/);
  assert.match(PRE, /attach: \(id, paths\) => ipcRenderer\.invoke\('chat:attach', id, paths\)/);
  const R = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  assert.match(R, /api\.chat\.openFile\(ptyId, p, how\)/);
  assert.match(R, /function addFiles\([^\n]*\n\s+registerAttached\(/, 'dropped files are registered');
});

test('v3.121 chat:setting: only from the window; a skip-permissions or desk session keeps its mode, the model may change', () => {
  const STU = require('../src/studio.js');
  assert.equal(STU.modeLock({}), '');
  assert.equal(STU.modeLock({ skip: true }), 'bypass');
  assert.equal(STU.modeLock({ desk: true }), 'desk');
  assert.equal(STU.modeLock({ skip: true, desk: true }), 'desk', 'a mail desk turns bypass off: its own rules hold');
  assert.equal(STU.settingAllowed('', 'mode'), true);
  assert.equal(STU.settingAllowed('bypass', 'mode'), false);
  assert.equal(STU.settingAllowed('desk', 'mode'), false);
  assert.equal(STU.settingAllowed('desk', 'model'), true);
  assert.equal(STU.settingAllowed('bypass', 'model'), true);
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:setting'"), MAIN.indexOf("ipcMain.handle('chat:setting'") + 500);
  assert.match(h, /^ipcMain\.handle\('chat:setting', async \(e, id, key, value\) => \{\n\s+if \(!fromWin\(e\)\) return 'bad';/);
  assert.match(h, /if \(!STU\.settingAllowed\(guiModeLock\.get\(String\(id\)\) \|\| '', String\(key\)\)\) return 'locked';/);
  assert.match(MAIN, /guiModeLock\.set\(id, STU\.modeLock\(\{ skip: P\.skipPermissionsArgs\(project\)\.length > 0, desk: Boolean\(mailMcp\) \|\| Boolean\(r\.tab\?\.staffId\) \|\| guarded !== settings \}\)\);/);
  assert.match(MAIN, /modeLock: guiModeLock\.get\(id\) \|\| ''/, 'the chat learns the lock with its GUI info');
});

test('v3.120 sessionNames: a /rename that scrolled out of both windows is kept; only appended lines are read; split lines wait', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-names-'));
  const f = path.join(d, 's.jsonl');
  const pad = (n) => `${Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `${'ğx'.repeat(50)}${i}` } })).join('\n')}\n`;
  const size = () => fs.statSync(f).size;
  fs.writeFileSync(f, `${pad(10)}${JSON.stringify({ type: 'custom-title', customTitle: 'Early' })}\n`);
  let n = C.sessionNames(f, size());
  assert.equal(n.custom, 'Early');
  assert.equal(n.end, size());
  fs.appendFileSync(f, pad(500));
  n = C.sessionNames(f, size(), n);
  fs.appendFileSync(f, `${JSON.stringify({ type: 'custom-title', customTitle: 'Mid' })}\n${pad(2000)}`);
  n = C.sessionNames(f, size(), n);
  assert.equal(n.custom, 'Mid');
  assert.equal(C.sessionInfo(f, size()).title, 'Early');   // the windows alone miss it
  assert.equal(C.sessionInfo(f, size(), fs, n).title, 'Mid');
  fs.appendFileSync(f, '{"type":"custom-ti');
  n = C.sessionNames(f, size(), n);
  assert.equal(n.custom, 'Mid');
  fs.appendFileSync(f, 'tle","customTitle":"Split"}\n');
  n = C.sessionNames(f, size(), n);
  assert.equal(n.custom, 'Split');
  assert.equal(n.end, size());
  assert.equal(C.sessionNames(f, 10, n).custom, '');   // a shorter file is not the one remembered
  fs.rmSync(d, { recursive: true, force: true });
});
