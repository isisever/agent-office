import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, fileKind, chipInfo, baseName, withMentions, splitMentions, pickerState, mention } from '../src/composer.mjs';

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
  assert.deepEqual(pickerState(null), { enabled: false, model: '', mode: 'default', why: 'terminal' });
  assert.equal(pickerState({ live: { busy: false }, asks: [], ended: { code: 0 } }).why, 'terminal');
  assert.deepEqual(pickerState({ live: { busy: true }, asks: [] }, { model: 'opus' }), { enabled: false, model: 'opus', mode: 'default', why: 'busy' });
  assert.equal(pickerState({ live: { busy: false }, asks: [{ id: 'a' }] }).why, 'busy');
  assert.deepEqual(pickerState({ live: { busy: false }, asks: [] }, { model: 'gpt', mode: 'bypassPermissions' }), { enabled: true, model: '', mode: 'default', why: '' });
  assert.deepEqual(pickerState({ live: { busy: false }, asks: [] }, { model: 'haiku', mode: 'plan' }), { enabled: true, model: 'haiku', mode: 'plan', why: '' });
});
