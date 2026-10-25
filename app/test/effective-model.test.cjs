'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const EM = require('../src/effective-model.js');

const HOME = '/home/u';
const files = (map) => (f) => { if (!(f in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return map[f]; };
const acct = path.join(HOME, '.claude', 'settings.json');

test('effective model: the account settings.json model (default account)', () => {
  const r = EM.readEffectiveModel({ home: HOME, env: {}, read: files({ [acct]: JSON.stringify({ model: 'haiku' }) }) });
  assert.deepEqual(r, { model: 'haiku', family: 'haiku', source: 'account' });
});

test('effective model: an account with its own config dir', () => {
  const dir = '/data/accounts/a1';
  const r = EM.readEffectiveModel({ configDir: dir, home: HOME, read: files({ [path.join(dir, 'settings.json')]: '{"model":"claude-opus-4-1"}', [acct]: '{"model":"haiku"}' }) });
  assert.deepEqual(r, { model: 'claude-opus-4-1', family: 'opus', source: 'account' });
});

test('effective model: no model, no file, default → null', () => {
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"theme":"dark"}' }) }), null);
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({}) }), null);
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"model":"default"}' }) }), null);
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"model":"  "}' }) }), null);
});

test('effective model: malformed settings → null, never throws', () => {
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{model: haiku' }) }), null);
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({ [acct]: 'null' }) }), null);
  assert.equal(EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"model":42}' }) }), null);
  assert.equal(EM.readEffectiveModel({ home: HOME, read: () => { throw new Error('EACCES'); } }), null);
});

test('effective model: ANTHROPIC_MODEL wins over settings', () => {
  const read = files({ [acct]: '{"model":"haiku"}' });
  assert.deepEqual(EM.readEffectiveModel({ home: HOME, env: { ANTHROPIC_MODEL: 'sonnet' }, read }), { model: 'sonnet', family: 'sonnet', source: 'env' });
  assert.equal(EM.readEffectiveModel({ home: HOME, env: { ANTHROPIC_MODEL: '' }, read }).source, 'account');
});

test('effective model: project settings come before the account', () => {
  const dir = '/p';
  const read = files({ [path.join(dir, '.claude', 'settings.json')]: '{"model":"opus"}', [acct]: '{"model":"haiku"}' });
  assert.deepEqual(EM.readEffectiveModel({ projectDir: dir, home: HOME, read }), { model: 'opus', family: 'opus', source: 'project' });
  const local = files({ [path.join(dir, '.claude', 'settings.local.json')]: '{"model":"sonnet[1m]"}', [path.join(dir, '.claude', 'settings.json')]: '{"model":"opus"}' });
  assert.equal(EM.readEffectiveModel({ projectDir: dir, home: HOME, read: local }).family, 'sonnet');
});

test('model family from aliases and full names', () => {
  assert.equal(EM.modelFamily('opusplan'), 'opus');
  assert.equal(EM.modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(EM.modelFamily('gpt-x'), null);
  assert.equal(EM.effectiveModel(), null);
});
