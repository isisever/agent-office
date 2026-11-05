'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const D = require('../src/delegate.js');

const known = new Set(['a', 'b', 'c']);

test('delegatesValue: filters unknown ids, dedups, ignores non-strings', () => {
  assert.deepEqual(D.delegatesValue(['a', 'zzz', 'b', 'a', 5, null], known), ['a', 'b']);
  assert.deepEqual(D.delegatesValue('a', known), []);
});

test('withDelegates: {} when empty, never stores []', () => {
  assert.deepEqual(D.withDelegates([], known), {});
  assert.deepEqual(D.withDelegates(['x'], known), {});
  assert.deepEqual(D.withDelegates(undefined, known), {});
  assert.deepEqual(D.withDelegates(['b', 'b'], known), { delegates: ['b'] });
});

test('manifest: delegates are claude-only and carry no key/secret field', () => {
  const accounts = [
    { id: 'a', label: 'Work', provider: 'anthropic', model: 'opus', configDir: '/cfg/a', key: 'SECRET' },
    { id: 'b', label: 'Other', provider: 'x', model: 'glm', apiKey: 'SECRET' },
    { id: 'c', label: 'OC', provider: 'opencode', model: 'm' },
  ];
  const m = D.manifest(accounts, { delegates: ['a', 'b', 'c', 'gone'] });
  assert.deepEqual(m.map((x) => x.engine), ['claude', 'claude', 'claude']);
  for (const x of m) {
    assert.deepEqual(Object.keys(x).sort(), ['configDir', 'engine', 'id', 'label', 'model']);
    assert.ok(!('key' in x) && !('apiKey' in x));
  }
  assert.ok(!JSON.stringify(m).includes('SECRET'));
  assert.deepEqual(D.manifest(accounts, {}), []);
});

test('delegateLaunch claude: clean env, CLAUDE_CONFIG_DIR set, cwd is the worktree', () => {
  const env = { PATH: '/bin', HOME: '/h', AGENT_OFFICE_X: '1', AGENT_OFFICE_DELEGATES: '[]', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/boss', CLAUDE_CODE_FOO: '1' };
  const r = D.delegateLaunch({ account: { provider: 'anthropic', model: 'haiku', configDir: '/cfg/b' }, task: 'do it', worktree: '/wt', env });
  assert.equal(r.cmd, 'claude');
  assert.deepEqual(r.args, ['-p', 'do it', '--model', 'haiku', '--permission-mode', 'acceptEdits', '--add-dir', '/wt']);
  assert.equal(r.cwd, '/wt');
  assert.equal(r.env.CLAUDE_CONFIG_DIR, '/cfg/b');
  assert.equal(r.env.PATH, '/bin');
  assert.ok(!Object.keys(r.env).some((k) => /^(AGENT_OFFICE|ANTHROPIC)/.test(k)));
  assert.ok(!Object.keys(r.env).some((k) => /^CLAUDE_/.test(k) && k !== 'CLAUDE_CONFIG_DIR'));
  assert.equal(D.delegateLaunch({ account: { provider: 'anthropic', configDir: '/c' }, task: 't', worktree: '/wt', env }).args[3], 'sonnet');
});

test('worktree helpers: path outside the repo under tmpBase, throwaway branch', () => {
  const repo = '/home/u/proj';
  const base = path.join(os.tmpdir(), 'x');
  const w = D.worktreeAddArgs(repo, base, '123');
  assert.ok(w.path.startsWith(base));
  assert.ok(!w.path.startsWith(repo));
  assert.equal(w.branch, 'ao-delegate/123');
  assert.deepEqual(w.args, ['-C', repo, 'worktree', 'add', '-b', 'ao-delegate/123', w.path, 'HEAD']);
  assert.ok(!w.args.includes('--detach'));
  assert.throws(() => D.worktreeAddArgs(repo, path.join(repo, 'tmp'), '1'));
  assert.deepEqual(D.worktreeRemoveArgs('/p'), ['worktree', 'remove', '--force', '/p']);
});

test('constants', () => {
  assert.equal(D.DELEGATE_ENV, 'AGENT_OFFICE_DELEGATES');
  assert.equal(D.AO_DELEGATE_CMD, 'ao-delegate');
});
