import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, fileKind, chipInfo, baseName, withMentions, splitMentions, pickerState, mention } from '../src/composer.mjs';
import * as C from '../src/composer.mjs';
import fs from 'node:fs';

test('formatSize: bytes, KB, MB, one decimal under 10, unknown is empty', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(812), '812 B');
  assert.equal(formatSize(1024), '1 KB');
  assert.equal(formatSize(4300), '4.2 KB');
  assert.equal(formatSize(13 * 1024 * 1024 + 5), '13 MB');
  assert.equal(formatSize(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(formatSize(undefined), '');
  assert.equal(formatSize(-1), '');
  assert.equal(formatSize(NaN), '');
});

test('fileKind: by MIME type first, then by extension', () => {
  assert.equal(fileKind('shot.PNG'), 'image');
  assert.equal(fileKind('x', 'image/webp'), 'image');
  assert.equal(fileKind('/a/b/app.ts'), 'code');
  assert.equal(fileKind('notes.md'), 'text');
  assert.equal(fileKind('report.pdf'), 'document');
  assert.equal(fileKind('blob', 'application/pdf'), 'document');
  assert.equal(fileKind('src.tar.gz'), 'archive');
  assert.equal(fileKind('Makefile'), 'file');
  assert.equal(fileKind('.env'), 'file');
});

test('chipInfo: base name, kind, size or the extension', () => {
  assert.deepEqual(chipInfo({ path: '/Users/x/My File.pdf', size: 2048 }), { name: 'My File.pdf', kind: 'document', meta: '2 KB' });
  assert.deepEqual(chipInfo({ path: 'C:\\work\\data.csv' }), { name: 'data.csv', kind: 'text', meta: 'CSV' });
  assert.deepEqual(chipInfo({ path: '/tmp/README' }), { name: 'README', kind: 'file', meta: '' });
  assert.equal(baseName('/a/b/'), 'b');
});

test('withMentions and splitMentions round-trip; quoted paths with spaces', () => {
  const out = withMentions('look at these  ', ['/a/x.ts', '/b/my file.md']);
  assert.equal(out, 'look at these\n\n@/a/x.ts @"/b/my file.md"');
  assert.deepEqual(splitMentions(out), { text: 'look at these', files: ['/a/x.ts', '/b/my file.md'] });
  assert.equal(withMentions('hi', []), 'hi');
  assert.equal(withMentions('', ['/a']), '@/a');
  assert.equal(mention('/p q'), '@"/p q"');
});

test('splitMentions leaves ordinary text alone', () => {
  assert.deepEqual(splitMentions('ping @alice'), { text: 'ping @alice', files: [] });
  assert.deepEqual(splitMentions('line one\nand @/a/b in the middle'), { text: 'line one\nand @/a/b in the middle', files: [] });
  assert.deepEqual(splitMentions(''), { text: '', files: [] });
});

test('pickerState: terminal tabs and busy chats cannot switch; values are checked', () => {
  const base = { lock: '', modeEnabled: false };
  assert.deepEqual(pickerState(null), { enabled: false, model: '', mode: 'default', why: 'terminal', ...base });
  assert.equal(pickerState({ live: { busy: false }, asks: [], ended: { code: 0 } }).why, 'terminal');
  assert.deepEqual(pickerState({ live: { busy: true }, asks: [] }, { model: 'opus' }), { enabled: false, model: 'opus', mode: 'default', why: 'busy', ...base });
  assert.equal(pickerState({ live: { busy: false }, asks: [{ id: 'a' }] }).why, 'busy');
  assert.deepEqual(pickerState({ live: { busy: false }, asks: [] }, { model: 'gpt', mode: 'bypassPermissions' }), { enabled: true, model: '', mode: 'default', why: '', lock: '', modeEnabled: true });
  assert.deepEqual(pickerState({ live: { busy: false }, asks: [] }, { model: 'haiku', mode: 'plan' }), { enabled: true, model: 'haiku', mode: 'plan', why: '', lock: '', modeEnabled: true });
});

test('v3.121 pickerState: a skip-permissions session shows bypassPermissions and a desk keeps its mode; the model stays free', () => {
  const idle = { live: { busy: false }, asks: [] };
  assert.deepEqual(pickerState({ ...idle, modeLock: 'bypass' }, { model: 'opus', mode: 'plan' }), { enabled: true, model: 'opus', mode: 'bypassPermissions', why: '', lock: 'bypass', modeEnabled: false });
  assert.deepEqual(pickerState({ ...idle, modeLock: 'desk' }, { mode: 'acceptEdits' }), { enabled: true, model: '', mode: 'acceptEdits', why: '', lock: 'desk', modeEnabled: false });
  assert.equal(pickerState({ ...idle, modeLock: 'other' }).modeEnabled, true, 'an unknown lock is ignored');
  assert.equal(pickerState({ live: { busy: true }, asks: [], modeLock: 'bypass' }).mode, 'bypassPermissions', 'shown while busy too');
  const R = fs.readFileSync(new URL('../renderer/chat.js', import.meta.url), 'utf8');
  assert.match(R, /modeSel\.disabled = !st\.modeEnabled;/);
  assert.match(R, /h\('option', \{ value: 'bypassPermissions', disabled: true, hidden: true \}/, 'listed only to show it, never to pick it');
});

test('v3.121 addChips: drop order kept, same path once, folders stay one chip', () => {
  const a = [{ path: '/p/a.txt' }];
  const out = C.addChips(a, [{ path: '/p/c.png' }, { path: '/p/a.txt' }, { path: '/p/dir', dir: true }, { path: '/p/c.png' }, { path: '' }, null]);
  assert.deepEqual(out.map((f) => f.path), ['/p/a.txt', '/p/c.png', '/p/dir']);
  assert.equal(out[2].dir, true);
  assert.equal(a.length, 1, 'a new list; the old one is unchanged');
  assert.deepEqual(C.addChips([], []), []);
  assert.deepEqual(C.chipInfo({ path: '/p/dir', dir: true }), { name: 'dir', kind: 'folder', meta: '' });
});

test('v3.121 dropText: the count while dragging', () => {
  const t = (k, v) => `${k}${v ? `:${v.count}` : ''}`;
  assert.equal(C.dropText(3, t), 'chat.drop.many:3');
  assert.equal(C.dropText(1, t), 'chat.drop.one');
  assert.equal(C.dropText(0, t), 'chat.drop.any');
  assert.equal(C.dropText(undefined, t), 'chat.drop.any');
  for (const lang of ['en', 'tr']) {
    const L = JSON.parse(fs.readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
    assert.ok(L.chat.drop.any && L.chat.drop.one && L.chat.drop.many.includes('{count}') && L.chat.fileOpen && L.chat.fileClear && L.chat.fileGone && L.chat.fileShown, lang);
  }
});
