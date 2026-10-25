'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const EM = require('../src/effective-model.js');
const MANAGED = EM.managedSettingsPath('linux');

const HOME = '/home/u';
const files = (map) => async (f) => { if (!(f in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return map[f]; };
const acct = path.join(HOME, '.claude', 'settings.json');

test('effective model: the account settings.json model (default account)', async () => {
  const r = await EM.readEffectiveModel({ home: HOME, env: {}, read: files({ [acct]: JSON.stringify({ model: 'haiku' }) }) });
  assert.deepEqual(r, { model: 'haiku', family: 'haiku', source: 'account' });
});

test('effective model: an account with its own config dir', async () => {
  const dir = '/data/accounts/a1';
  const r = await EM.readEffectiveModel({ configDir: dir, home: HOME, read: files({ [path.join(dir, 'settings.json')]: '{"model":"claude-opus-4-1"}', [acct]: '{"model":"haiku"}' }) });
  assert.deepEqual(r, { model: 'claude-opus-4-1', family: 'opus', source: 'account' });
});

test('effective model: no model, no file, default → null', async () => {
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"theme":"dark"}' }) }), null);
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({}) }), null);
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"model":"default"}' }) }), null);
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"model":"  "}' }) }), null);
});

test('effective model: malformed settings → null, never throws', async () => {
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{model: haiku' }) }), null);
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({ [acct]: 'null' }) }), null);
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: files({ [acct]: '{"model":42}' }) }), null);
  assert.equal(await EM.readEffectiveModel({ home: HOME, read: async () => { throw new Error('EACCES'); } }), null);
});

test('effective model: ANTHROPIC_MODEL wins over settings', async () => {
  const read = files({ [acct]: '{"model":"haiku"}' });
  assert.deepEqual(await EM.readEffectiveModel({ home: HOME, env: { ANTHROPIC_MODEL: 'sonnet' }, read }), { model: 'sonnet', family: 'sonnet', source: 'env' });
  assert.equal((await EM.readEffectiveModel({ home: HOME, env: { ANTHROPIC_MODEL: '' }, read })).source, 'account');
});

test('effective model: project settings come before the account', async () => {
  const dir = '/p';
  const read = files({ [path.join(dir, '.claude', 'settings.json')]: '{"model":"opus"}', [acct]: '{"model":"haiku"}' });
  assert.deepEqual(await EM.readEffectiveModel({ projectDir: dir, home: HOME, read }), { model: 'opus', family: 'opus', source: 'project' });
  const local = files({ [path.join(dir, '.claude', 'settings.local.json')]: '{"model":"sonnet[1m]"}', [path.join(dir, '.claude', 'settings.json')]: '{"model":"opus"}' });
  assert.equal((await EM.readEffectiveModel({ projectDir: dir, home: HOME, read: local })).family, 'sonnet');
});

test('model family from aliases and full names', async () => {
  assert.equal(EM.modelFamily('opusplan'), 'opus');
  assert.equal(EM.modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(EM.modelFamily('gpt-x'), null);
  assert.equal(EM.effectiveModel(), null);
});

test('effective model: managed settings win over env and every file', async () => {
  const read = files({ [MANAGED]: '{"model":"opus"}', [acct]: '{"model":"haiku"}' });
  assert.deepEqual(await EM.readEffectiveModel({ home: HOME, platform: 'linux', env: { ANTHROPIC_MODEL: 'sonnet' }, read }), { model: 'opus', family: 'opus', source: 'managed' });
  const both = files({ [MANAGED]: '{"model":"opus","env":{"ANTHROPIC_MODEL":"sonnet"}}' });
  assert.equal((await EM.readEffectiveModel({ home: HOME, platform: 'linux', read: both })).model, 'sonnet');
  assert.equal(EM.managedSettingsPath('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.equal(EM.managedSettingsPath('win32'), 'C:\\ProgramData\\ClaudeCode\\managed-settings.json');
});

test('effective model: settings env.ANTHROPIC_MODEL beats every model key, shell env beats settings env', async () => {
  const dir = '/p';
  const read = files({
    [path.join(dir, '.claude', 'settings.local.json')]: '{"model":"opus"}',
    [acct]: '{"env":{"ANTHROPIC_MODEL":"haiku"},"model":"sonnet"}',
  });
  assert.deepEqual(await EM.readEffectiveModel({ projectDir: dir, home: HOME, platform: 'linux', read }), { model: 'haiku', family: 'haiku', source: 'account' });
  assert.equal((await EM.readEffectiveModel({ projectDir: dir, home: HOME, platform: 'linux', env: { ANTHROPIC_MODEL: 'sonnet' }, read })).source, 'env');
});

test('IPC body: wrong engine, remote folder, manager flag, account configDir', async () => {
  const dir = '/p';
  const acctDir = '/data/a1';
  const read = files({ [path.join(acctDir, 'settings.json')]: '{"model":"haiku"}', [acct]: '{"model":"opus"}' });
  const base = { project: { dir }, engine: 'claude', manager: true, configDir: acctDir, home: HOME, platform: 'linux', read, isLocalDir: async () => true };
  assert.deepEqual(await EM.effectiveModelForProject(base), { model: 'haiku', family: 'haiku', source: 'account', manager: true });
  assert.equal((await EM.effectiveModelForProject({ ...base, manager: false })).manager, false);
  assert.equal((await EM.effectiveModelForProject({ ...base, configDir: null })).family, 'opus');
  assert.equal(await EM.effectiveModelForProject({ ...base, engine: 'codex' }), null);
  assert.equal(await EM.effectiveModelForProject({ ...base, project: null }), null);
  assert.equal(await EM.effectiveModelForProject({ ...base, isLocalDir: async () => false }), null);
  assert.equal(await EM.effectiveModelForProject({ ...base, project: { dir: 'remote:abc' } }), null);
});

let clock = 0;
test('login shell: ANTHROPIC_MODEL between markers, falls back on failure, noise or a shell that never exits', async () => {
  const run = (out, err = null) => (_sh, _args, _o, cb) => cb(err, out);
  const fresh = (o) => EM.loginShellModel({ shell: '/bin/zsh', platform: 'darwin', base: {}, now: () => (clock += 1e6), ...o });
  assert.deepEqual(await fresh({ run: run('motd\n__AO_MODEL__haiku__AO_MODEL__\nbye from .zlogout') }), { ANTHROPIC_MODEL: 'haiku' });
  assert.deepEqual(await fresh({ run: run('banner without newline', null), base: { ANTHROPIC_MODEL: 'opus' } }), { ANTHROPIC_MODEL: 'opus' });
  assert.deepEqual(await fresh({ run: run('__AO_MODEL__haiku__AO_MODEL__', new Error('timeout')), base: { ANTHROPIC_MODEL: 'opus' } }), { ANTHROPIC_MODEL: 'opus' });
  assert.deepEqual(await fresh({ run: run('', new Error('timeout')), base: { ANTHROPIC_MODEL: 'opus' } }), { ANTHROPIC_MODEL: 'opus' });
  let opts;
  const hang = (_sh, _args, o) => { opts = o; };
  const t0 = Date.now();
  assert.deepEqual(await fresh({ run: hang, base: { ANTHROPIC_MODEL: 'sonnet' } }), { ANTHROPIC_MODEL: 'sonnet' });
  assert.ok(Date.now() - t0 >= 5900);
  assert.equal(opts.killSignal, 'SIGKILL');
  assert.deepEqual(await fresh({ run: run('x'), platform: 'win32', base: {} }), {});
});

test('renderer hint: Auto + haiku + manager only', async () => {
  const { showHaikuManagerHint: f } = await import('../src/effective-model-hint.mjs');
  assert.equal(f('auto', { family: 'haiku', manager: true }), true);
  assert.equal(f('auto', { family: 'opus', manager: true }), false);
  assert.equal(f('auto', { family: 'haiku', manager: false }), false);
  assert.equal(f('opus', { family: 'haiku', manager: true }), false);
  assert.equal(f('auto', null), false);
});
