import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, fileKind, chipInfo, baseName, withMentions, splitMentions, pickerState, managerOffNote, modelChoices, modeChangeable, mention } from '../src/composer.mjs';
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
  const base = { lock: '', modeEnabled: false, managerNote: false };
  assert.deepEqual(pickerState(null), { enabled: false, model: '', mode: 'default', why: 'terminal', ...base });
  assert.equal(pickerState({ live: { busy: false }, asks: [], ended: { code: 0 } }).why, 'terminal');
  assert.deepEqual(pickerState({ live: { busy: true }, asks: [] }, { model: 'opus' }), { enabled: false, model: 'opus', mode: 'default', why: 'busy', ...base, modeEnabled: true });
  assert.equal(pickerState({ live: { busy: false }, asks: [{ id: 'a' }] }).why, 'busy');
  assert.deepEqual(pickerState({ live: { busy: false }, asks: [] }, { model: 'gpt', mode: 'bypassPermissions' }), { enabled: true, model: '', mode: 'default', why: '', lock: '', modeEnabled: true, managerNote: false });
  assert.deepEqual(pickerState({ live: { busy: false }, asks: [] }, { model: 'haiku', mode: 'plan' }), { enabled: true, model: 'haiku', mode: 'plan', why: '', lock: '', modeEnabled: true, managerNote: false });
});

test('v3.121 pickerState: a skip-permissions session shows bypassPermissions and a desk keeps its mode; the model stays free', () => {
  const idle = { live: { busy: false }, asks: [] };
  assert.deepEqual(pickerState({ ...idle, modeLock: 'bypass' }, { model: 'opus', mode: 'plan' }), { enabled: true, model: 'opus', mode: 'bypassPermissions', why: '', lock: 'bypass', modeEnabled: true, managerNote: false });
  assert.deepEqual(pickerState({ ...idle, modeLock: 'desk' }, { mode: 'acceptEdits' }), { enabled: true, model: '', mode: 'acceptEdits', why: '', lock: 'desk', modeEnabled: false, managerNote: false });
  assert.equal(pickerState({ ...idle, modeLock: 'other' }).modeEnabled, true, 'an unknown lock is ignored');
  assert.equal(pickerState({ live: { busy: true }, asks: [], modeLock: 'bypass' }).mode, 'bypassPermissions', 'shown while busy too');
  // a skip-permissions chat may leave bypass between turns only (the pick turns the project's Skip permissions off)
  assert.equal(pickerState({ live: { busy: true }, asks: [], modeLock: 'bypass' }).modeEnabled, false);
  assert.equal(pickerState({ live: { busy: false }, asks: [{ id: 'a' }], modeLock: 'bypass' }).modeEnabled, false);
  assert.equal(modeChangeable('', true), true);
  assert.equal(modeChangeable('bypass', false), true);
  assert.equal(modeChangeable('bypass', true), false);
  assert.equal(modeChangeable('desk', false), false);
  const R = fs.readFileSync(new URL('../renderer/chat.js', import.meta.url), 'utf8');
  assert.match(R, /setProp\(modeSel, 'disabled', !st\.modeEnabled\);/);
  assert.match(R, /\{ value: 'bypassPermissions', label: t\('chat\.pick\.mode\.bypassPermissions'\), disabled: true, hidden: true \}/, 'listed only to show it, never to pick it');
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

test('modelChoices: the session reported models, else the fixed aliases; pickerState keeps a reported model', () => {
  assert.deepEqual(modelChoices(null).map((m) => m.value), ['', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(modelChoices({ models: [] }).map((m) => m.value), ['', 'opus', 'sonnet', 'haiku']);
  const gui = { live: { busy: false }, asks: [], models: [{ value: '', label: 'Default (recommended)', description: 'd' }, { value: 'fable', label: 'Fable 5.2' }, null] };
  assert.deepEqual(modelChoices(gui), [{ value: '', label: 'Default (recommended)', description: 'd' }, { value: 'fable', label: 'Fable 5.2', description: '' }]);
  assert.equal(pickerState(gui, { model: 'fable' }).model, 'fable');
  assert.equal(pickerState(gui, { model: 'haiku' }).model, '', 'not reported for this account');
});

test('v3.120 mode picker: the account\'s modes, Auto selected when the session reports it, the manager note otherwise', () => {
  const gui = { live: { busy: false }, asks: [], modes: ['auto', 'default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'], autoApprove: true };
  assert.deepEqual(C.modeChoices(gui), ['auto', 'default', 'acceptEdits', 'plan', 'dontAsk']);
  assert.deepEqual(C.modeChoices({}), ['auto', 'default', 'acceptEdits', 'plan']);
  let st = pickerState(gui, { mode: 'auto' });
  assert.equal(st.mode, 'auto');
  assert.equal(st.managerNote, false);
  st = pickerState(gui, { mode: 'plan' });
  assert.equal(st.mode, 'plan');
  assert.equal(st.managerNote, true, 'Auto-approve on, another mode: the manager still answers');
  assert.equal(pickerState({ ...gui, autoApprove: false }, { mode: 'plan' }).managerNote, false);
  // a skip-permissions or desk session stays locked and shows no note
  st = pickerState({ ...gui, modeLock: 'bypass' }, { mode: 'auto' });
  assert.equal(st.mode, 'bypassPermissions');
  assert.equal(st.modeEnabled, false);
  assert.equal(st.managerNote, false);
  st = pickerState({ ...gui, modeLock: 'desk' }, {});
  assert.equal(st.modeEnabled, false);
  assert.equal(st.managerNote, false);
});

test('v3.120 managerOffNote: auto mode while the project Auto-approve is off, never a lock or a terminal tab', () => {
  const gui = { live: { busy: false }, asks: [], modes: ['auto', 'default', 'acceptEdits', 'plan'], autoApprove: false };
  assert.equal(managerOffNote(gui, { mode: 'auto' }), true);
  assert.equal(managerOffNote({ ...gui, autoApprove: true }, { mode: 'auto' }), false, 'Auto-approve on: the manager answers');
  assert.equal(managerOffNote(gui, { mode: 'default' }), false);
  assert.equal(managerOffNote({ ...gui, modeLock: 'desk' }, { mode: 'auto' }), false);
  assert.equal(managerOffNote({ ...gui, modeLock: 'bypass' }, { mode: 'auto' }), false);
  assert.equal(managerOffNote({ ...gui, ended: true }, { mode: 'auto' }), false);
  assert.equal(managerOffNote(null, { mode: 'auto' }), false);
  assert.equal(managerOffNote({ ...gui, autoApprove: undefined }, { mode: 'auto' }), false, 'unknown is not off');
  // the picker itself is untouched: the mode stays auto
  assert.equal(pickerState(gui, { mode: 'auto' }).mode, 'auto');
});

test('optionsKey: same options give the same key; a changed label, title or flag changes it', () => {
  const a = [{ value: '', label: 'Default (Opus 5.5)' }, { value: 'sonnet', label: 'Sonnet', title: 'fast' }];
  assert.equal(C.optionsKey(a), C.optionsKey(a.map((o) => ({ ...o }))));
  assert.notEqual(C.optionsKey(a), C.optionsKey([{ value: '', label: 'Model as started' }, a[1]]));
  assert.notEqual(C.optionsKey(a), C.optionsKey([a[0], { ...a[1], title: 'slow' }]));
  assert.notEqual(C.optionsKey(a), C.optionsKey([a[0], { ...a[1], disabled: true }]));
  assert.notEqual(C.optionsKey(a), C.optionsKey([a[0]]));
  assert.equal(C.optionsKey(undefined), '');
});

test('selectPlan: an open (focused) picker is never rebuilt nor given a value; force overrides', () => {
  const base = { shownKey: 'a', key: 'a', focused: false, value: 'opus', want: 'opus' };
  assert.deepEqual(C.selectPlan(base), { rebuild: false, setValue: false });              // a poll with nothing new
  assert.deepEqual(C.selectPlan({ ...base, key: 'b' }), { rebuild: true, setValue: true }); // the list changed
  assert.deepEqual(C.selectPlan({ ...base, want: 'sonnet' }), { rebuild: false, setValue: true });
  assert.deepEqual(C.selectPlan({ ...base, shownKey: undefined }), { rebuild: true, setValue: true });   // first draw
  assert.deepEqual(C.selectPlan({ ...base, focused: true, key: 'b', want: 'sonnet' }), { rebuild: false, setValue: false });
  assert.deepEqual(C.selectPlan({ ...base, focused: true, want: 'sonnet', force: true }), { rebuild: false, setValue: true });
});

test('the composer and start-screen pickers are drawn through syncSelect, never rebuilt directly by a poll', () => {
  const chat = fs.readFileSync(new URL('../renderer/chat.js', import.meta.url), 'utf8');
  const studio = fs.readFileSync(new URL('../renderer/studio.js', import.meta.url), 'utf8');
  for (const sel of ['modelSel', 'modeSel']) {
    assert.match(chat, new RegExp(`syncSelect\\(${sel},`));
    assert.doesNotMatch(chat, new RegExp(`${sel}\\.(replaceChildren|innerHTML)|${sel}\\.options\\[`));
  }
  for (const sel of ['startProject', 'startWho', 'startModel', 'startMode']) {
    assert.match(studio, new RegExp(`syncSelect\\(${sel},`));
    assert.doesNotMatch(studio, new RegExp(`${sel}\\.(replaceChildren|innerHTML)`));
  }
  const sync = fs.readFileSync(new URL('../renderer/select-sync.js', import.meta.url), 'utf8');
  assert.match(sync, /document\.activeElement === sel/);
});

test('v3.147 pickerState: the permission mode stays changeable mid-turn unless locked; the model waits', () => {
  const run = pickerState({ live: { busy: true }, asks: [] });
  assert.equal(run.enabled, false);
  assert.equal(run.modeEnabled, true);
  assert.equal(pickerState({ live: { busy: false }, asks: [{ id: 'a' }] }).modeEnabled, true);
  assert.equal(pickerState({ live: { busy: true }, asks: [], modeLock: 'desk' }).modeEnabled, false);
  assert.equal(pickerState({ live: { busy: true }, asks: [], ended: { code: 0 } }).modeEnabled, false);
});
