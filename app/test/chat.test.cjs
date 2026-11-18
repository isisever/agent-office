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
  const send = src.slice(src.indexOf("ipcMain.handle('chat:send'"), src.indexOf("ipcMain.handle('chat:send'") + 900);
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
