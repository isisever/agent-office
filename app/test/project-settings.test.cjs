'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PS = require('../src/project-settings.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-project-settings-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('setProjectModel: creates .claude/settings.json with {model}', () => {
  const dir = tmp();
  assert.equal(PS.setProjectModel(dir, 'opus'), true);
  const f = PS.projFile(dir);
  assert.deepEqual(readJson(f), { model: 'opus' });
});

test('setProjectModel: preserves every other key and the file mode; no-op when unchanged', () => {
  const dir = tmp();
  const f = PS.projFile(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ statusLine: { type: 'command' }, env: { FOO: '1' } }, null, 2), { mode: 0o640 });
  const before = fs.statSync(f).mode & 0o777;
  assert.equal(PS.setProjectModel(dir, 'sonnet'), true);
  assert.deepEqual(readJson(f), { statusLine: { type: 'command' }, env: { FOO: '1' }, model: 'sonnet' });
  assert.equal(fs.statSync(f).mode & 0o777, before); // mode preserved
  assert.equal(PS.setProjectModel(dir, 'sonnet'), false); // unchanged → no-op
});

test('stripAccountModel: removes only model, keeps the rest, returns the removed value', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ model: 'haiku', statusLine: { type: 'command' }, env: { A: '1' } }));
  assert.equal(PS.stripAccountModel(f), 'haiku');
  assert.deepEqual(readJson(f), { statusLine: { type: 'command' }, env: { A: '1' } });
});

test('stripAccountModel: null when there is no model (and when the file is absent)', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ statusLine: { type: 'command' } }));
  assert.equal(PS.stripAccountModel(f), null);
  assert.deepEqual(readJson(f), { statusLine: { type: 'command' } }); // untouched
  assert.equal(PS.stripAccountModel(path.join(dir, 'missing.json')), null);
});

test('captureAccountModel: moves the model to the project file AND empties the account model; idempotent (loop invariant)', () => {
  const dir = tmp();
  const projectDir = tmp();
  const acc = path.join(dir, 'settings.json');
  fs.writeFileSync(acc, JSON.stringify({ model: 'opus', theme: 'dark' }));
  assert.equal(PS.captureAccountModel(acc, projectDir), 'opus');
  assert.deepEqual(readJson(PS.projFile(projectDir)), { model: 'opus' });
  assert.deepEqual(readJson(acc), { theme: 'dark' }); // model removed, other keys kept
  // idempotent: no model left in the account file → a second call is a no-op, and the account file never gains a model
  assert.equal(PS.captureAccountModel(acc, projectDir), null);
  assert.deepEqual(readJson(acc), { theme: 'dark' });
  assert.equal('model' in readJson(acc), false);
});
