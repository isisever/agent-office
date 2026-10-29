// ao-delegate CLI (contract v3.56): node --test app/test/delegate-cli.test.cjs
// Arg parsing, manifest resolution, and the "not a git repo" / "unknown account" errors. git and the delegate child
// are stubbed — no real worktree is made and no real delegate runs. The key is never printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../src/delegate-cli.js');

test('parseArgs: account, optional -m model, task after --', () => {
  assert.deepEqual(CLI.parseArgs(['Work', '--', 'fix', 'the', 'bug']), { accountRef: 'Work', model: null, task: 'fix the bug' });
  assert.deepEqual(CLI.parseArgs(['abc123', '-m', 'opus', '--', 'do it']), { accountRef: 'abc123', model: 'opus', task: 'do it' });
  assert.throws(() => CLI.parseArgs(['Work', 'extra', '--', 'x']), /unexpected argument/);
  assert.throws(() => CLI.parseArgs(['--bad', '--', 'x']), /unknown option/);
  assert.throws(() => CLI.parseArgs(['Work']), /no task given/);       // nothing after --
  assert.throws(() => CLI.parseArgs(['--', 'x']), /usage/);            // no account
});

test('readManifest: missing env / bad JSON / no repoTop are clear errors', () => {
  assert.throws(() => CLI.readManifest({}), /delegation is off/);
  const env = { [CLI.MANIFEST_ENV]: '/tmp/x.json' };
  assert.throws(() => CLI.readManifest(env, () => '{not json'), /not valid JSON/);
  assert.throws(() => CLI.readManifest(env, () => JSON.stringify({ delegates: [] })), /no repoTop/);
  const m = CLI.readManifest(env, () => JSON.stringify({ delegates: [{ id: 'a' }], repoTop: '/r', keyDir: '/k', ocConfigHome: '/oc' }));
  assert.deepEqual(m, { delegates: [{ id: 'a' }], repoTop: '/r', keyDir: '/k', ocConfigHome: '/oc' });
});

test('resolveAccount: by id, by label (case-insensitive), clear error otherwise', () => {
  const list = [{ id: 'a1', label: 'Work', engine: 'claude' }, { id: 'b2', label: 'FixCloud', engine: 'opencode' }];
  assert.equal(CLI.resolveAccount(list, 'a1').id, 'a1');
  assert.equal(CLI.resolveAccount(list, 'work').id, 'a1');
  assert.throws(() => CLI.resolveAccount(list, 'nope'), /not a delegatable account.*Work, FixCloud/s);
  assert.throws(() => CLI.resolveAccount([{ id: 'x', label: 'Dup' }, { id: 'y', label: 'Dup' }], 'dup'), /more than one/);
});

test('run: not a git repo → clear error; no delegate child is spawned', () => {
  let spawned = false;
  const git = (args) => (args.includes('rev-parse') && args.includes('--show-toplevel')
    ? { status: 128, stdout: '', stderr: 'fatal: not a git repository' }
    : { status: 0, stdout: '', stderr: '' });
  assert.throws(() => CLI.run({
    argv: ['Work', '--', 'task'],
    env: { [CLI.MANIFEST_ENV]: '/m.json' },
    out: { write() {} },
    deps: { git, spawn: () => { spawned = true; return 0; }, readFile: () => JSON.stringify({ delegates: [{ id: 'a1', label: 'Work', engine: 'claude' }], repoTop: '/notrepo', keyDir: '/k' }) },
  }), /not a git repository/);
  assert.equal(spawned, false);
});

test('run: unknown account → clear error before any git call', () => {
  let gitCalls = 0;
  assert.throws(() => CLI.run({
    argv: ['Ghost', '--', 'task'],
    env: { [CLI.MANIFEST_ENV]: '/m.json' },
    out: { write() {} },
    deps: { git: () => { gitCalls++; return { status: 0, stdout: '', stderr: '' }; }, spawn: () => 0, readFile: () => JSON.stringify({ delegates: [{ id: 'a1', label: 'Work', engine: 'claude' }], repoTop: '/r', keyDir: '/k' }) },
  }), /not a delegatable account/);
  assert.equal(gitCalls, 0);
});

test('run: happy path makes a worktree, runs the child, commits, prints branch/path/diff — never the key', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args.includes('--show-toplevel')) return { status: 0, stdout: '/repo\n', stderr: '' };
    if (args.includes('rev-parse')) return { status: 0, stdout: 'abcdef1234567890\n', stderr: '' };
    if (args[2] === 'worktree' && args[3] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('--cached') && args.includes('--quiet')) return { status: 1, stdout: '', stderr: '' }; // staged changes exist
    if (args.includes('diff')) return { status: 0, stdout: ' file.js | 2 +-\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let launch = null;
  const spawn = (o) => { launch = o; return 0; };
  let printed = '';
  const code = CLI.run({
    argv: ['Work', '-m', 'opus', '--', 'do the thing'],
    env: { [CLI.MANIFEST_ENV]: '/m.json', SECRET: 'nope' },
    out: { write: (s) => { printed += s; } },
    deps: { git, spawn, now: () => 777, rand: () => 'ab12cd', readFile: () => JSON.stringify({ delegates: [{ id: 'a1', label: 'Work', engine: 'claude', model: 'sonnet' }], repoTop: '/repo', keyDir: '/keys' }) },
  });
  assert.equal(code, 0);
  assert.match(printed, /branch: ao-delegate\/777-ab12cd/);
  assert.match(printed, /worktree: /);
  assert.match(printed, /file\.js \| 2/);
  // the model override (-m opus) reached the claude child; no secret/key value is in the printed output
  assert.equal(launch.cmd, 'claude');
  assert.ok(launch.args.includes('opus'));
  assert.ok(calls.some((c) => c.includes('worktree add') && c.includes('ao-delegate/777-ab12cd')));
  assert.ok(calls.some((c) => c.startsWith('-C') && c.includes('commit') && c.includes('user.email=agent-office@localhost')));
  assert.doesNotMatch(printed, /SECRET|nope/);
});

test('run: delegate made no changes → honest "no file changes", no commit', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args.includes('--show-toplevel')) return { status: 0, stdout: '/repo\n', stderr: '' };
    if (args.includes('rev-parse')) return { status: 0, stdout: 'abcdef1234567890\n', stderr: '' };
    if (args[2] === 'worktree' && args[3] === 'add') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('--cached') && args.includes('--quiet')) return { status: 0, stdout: '', stderr: '' }; // no staged changes
    return { status: 0, stdout: '', stderr: '' };
  };
  let printed = '';
  const code = CLI.run({
    argv: ['Work', '--', 'look but do not touch'],
    env: { [CLI.MANIFEST_ENV]: '/m.json' },
    out: { write: (s) => { printed += s; } },
    deps: { git, spawn: () => 0, now: () => 5, rand: () => 'ff', readFile: () => JSON.stringify({ delegates: [{ id: 'a1', label: 'Work', engine: 'claude', model: 'sonnet' }], repoTop: '/repo', keyDir: '/keys' }) },
  });
  assert.equal(code, 0);
  assert.match(printed, /no file changes/);
  assert.equal(calls.some((c) => c.includes('commit')), false); // nothing staged → no commit attempt
});
