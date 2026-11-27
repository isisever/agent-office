'use strict';
// A desk's worktree gets the project's local permission rules (contract v3.92): only the rules, merged into the
// desk's own file, and only where git reports the file ignored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const DR = require('../src/desk-rules.js');

/** A temp dir with a project folder, a desk folder and a folder for temp files. */
function dirs(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-desk-rules-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const desk = path.join(root, 'desk');
  const tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(desk);
  return { root, project, desk, tmpDir, src: path.join(project, DR.REL), dst: path.join(desk, DR.REL) };
}
const put = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const get = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const RULES = { permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'], ask: ['Bash(git push:*)'] } };

// no global or system git config and no global ignore file (the person's own may already ignore the rules file)
const NOWHERE = path.join(os.tmpdir(), 'ao-desk-rules-no-such-home');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: NOWHERE, XDG_CONFIG_HOME: NOWHERE };
/** git the way main.js runs it: no shell, → { ok, stdout }. */
const git = async (args) => {
  try { return { ok: true, stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: ENV }) }; } catch { return { ok: false, stdout: '' }; }
};
/** A real repository in the desk folder (one commit), with `files` committed. */
function repo(d, files = {}) {
  const run = (...args) => execFileSync('git', ['-C', d.desk, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore', env: ENV });
  run('init', '-q');
  fs.writeFileSync(path.join(d.desk, 'README'), 'x');
  for (const [rel, text] of Object.entries(files)) put(path.join(d.desk, rel), text);
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return run;
}
const exclude = (d) => path.join(d.desk, '.git', 'info', 'exclude');

test('wanted: only a staff desk in a worktree of its own; never a personal workspace, HQ or a mail member', () => {
  const tab = { n: 2, staffId: 's1', dir: '/w/x', worktree: { root: '/w/x', repo: '/r', branch: 'agent-office/s1' } };
  assert.equal(DR.wanted({ project: { id: 'p', parallel: true }, tab, hasMail: false }), true);
  assert.equal(DR.wanted({ project: { id: 'p', parallel: true }, tab, hasMail: true }), false);
  assert.equal(DR.wanted({ project: { id: 'p', staffOwner: 's1' }, tab, hasMail: false }), false);
  assert.equal(DR.wanted({ project: { id: 'p', hq: true }, tab, hasMail: false }), false);
  assert.equal(DR.wanted({ project: { id: 'p' }, tab: { n: 2, staffId: 's1' }, hasMail: false }), false);   // a desk in the project's own folder
  assert.equal(DR.wanted({ project: { id: 'p' }, tab: { ...tab, staffId: undefined }, hasMail: false }), false);   // a plain worktree tab
  assert.equal(DR.wanted({ project: null, tab, hasMail: false }), false);
});

test('write: only the three rule arrays cross; env, hooks, defaultMode, additionalDirectories and the rest never do', (t) => {
  const d = dirs(t);
  put(d.src, {
    env: { ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://example.invalid' },
    apiKeyHelper: '/bin/helper',
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'curl example.invalid' }] }] },
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: ['srv'],
    somethingNew: { a: 1 },
    permissions: { ...RULES.permissions, defaultMode: 'bypassPermissions', additionalDirectories: ['/main/checkout'], other: ['x'] },
  });
  put(path.join(d.project, '.claude', 'settings.json'), { tracked: true });
  put(path.join(d.project, '.claude', 'other.md'), 'x');
  assert.equal(DR.needsSync(d.project, d.desk), true);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'written');
  assert.deepEqual(get(d.dst), RULES);
  const text = fs.readFileSync(d.dst, 'utf8');
  for (const word of ['"env"', 'sk-secret', 'ANTHROPIC', 'apiKeyHelper', 'hooks', 'curl', 'Mcp', 'somethingNew', 'defaultMode', 'bypassPermissions', 'additionalDirectories', '/main/checkout', '"other"']) assert.equal(text.includes(word), false, word);
  assert.deepEqual(fs.readdirSync(path.join(d.desk, '.claude')), ['settings.local.json']);
  assert.deepEqual(fs.readdirSync(d.tmpDir), []);   // the temp file was outside the desk and is gone
  assert.deepEqual(fs.readdirSync(d.desk), ['.claude']);
});

test('rulesOf: strings only, each once, 500 per array, none over 2000 characters', () => {
  const many = Array.from({ length: DR.MAX_RULES + 20 }, (_, i) => `Bash(cmd${i}:*)`);
  const r = DR.rulesOf({ permissions: { allow: ['a', 'a', 1, null, { x: 1 }, ['b'], '', 'x'.repeat(DR.MAX_RULE_CHARS + 1), 'y'.repeat(DR.MAX_RULE_CHARS)], deny: many, ask: 'Bash' } });
  assert.deepEqual(r.allow, ['a', 'y'.repeat(DR.MAX_RULE_CHARS)]);
  assert.deepEqual(r.deny, many.slice(0, DR.MAX_RULES));
  assert.deepEqual(r.ask, []);
  for (const none of [null, [], 'x', {}, { permissions: null }, { permissions: [] }, { permissions: { allow: [], deny: [1], defaultMode: 'acceptEdits' } }, { env: { A: 'b' } }]) assert.equal(DR.rulesOf(none), null);
});

test('write: nothing when the project file is invalid JSON, has no usable rule, is missing, a folder, a symlink or over 256 KB', (t) => {
  const d = dirs(t);
  const nothing = () => {
    assert.equal(DR.needsSync(d.project, d.desk), false);
    assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'no-source');
    assert.equal(fs.existsSync(path.join(d.desk, '.claude')), false);
  };
  nothing();   // missing
  for (const bad of ['{ "permissions": { "allow": ["Bash"] }', '[]', '"x"', '{"env":{"A":"b"},"permissions":{"defaultMode":"bypassPermissions"}}', '{"permissions":{"allow":[1,2]}}']) { put(d.src, bad); nothing(); }
  fs.unlinkSync(d.src);
  fs.mkdirSync(d.src);
  nothing();
  fs.rmdirSync(d.src);
  put(path.join(d.root, 'secret.json'), RULES);
  fs.symlinkSync(path.join(d.root, 'secret.json'), d.src);
  nothing();
  fs.unlinkSync(d.src);
  put(d.src, JSON.stringify(RULES).padEnd(DR.MAX_BYTES + 1, ' '));
  nothing();
  put(d.src, JSON.stringify(RULES).padEnd(DR.MAX_BYTES, ' '));
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'written');
});

test('write: merged into the desk\'s own file: its keys and its own rules stay, the project\'s deny and ask are added', (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  const own = { model: 'opus', env: { DESK: '1' }, permissions: { allow: ['Bash(ls:*)', 'Bash(npm test:*)'], defaultMode: 'acceptEdits', additionalDirectories: ['/desk/extra'] }, hooks: { Stop: [] } };
  put(d.dst, own);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'written');
  assert.deepEqual(get(d.dst), {
    model: 'opus', env: { DESK: '1' }, hooks: { Stop: [] },
    permissions: { allow: ['Bash(npm test:*)', 'Bash(ls:*)'], defaultMode: 'acceptEdits', additionalDirectories: ['/desk/extra'], deny: ['Read(./.env)'], ask: ['Bash(git push:*)'] },
  });
});

test('write: decided by content, not by time: current when the desk holds the rules, again when the project gets a new one', (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'written');
  const first = fs.readFileSync(d.dst, 'utf8');
  assert.equal(DR.needsSync(d.project, d.desk), false);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'current');
  const later = new Date(Date.now() + 3600 * 1000);
  fs.utimesSync(d.src, later, later);   // a newer source with the same rules changes nothing
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'current');
  assert.equal(fs.readFileSync(d.dst, 'utf8'), first);
  // the desk's own "always allow" answer, written after the sync, survives the next one
  const desk = get(d.dst);
  desk.permissions.allow.push('Bash(make:*)');
  put(d.dst, desk);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'current');
  const old = new Date(Date.now() - 3600 * 1000);
  put(d.src, { permissions: { ...RULES.permissions, allow: ['Bash(npm test:*)', 'Bash(npm run lint)'] } });
  fs.utimesSync(d.src, old, old);   // an older source with a new rule is still synced
  assert.equal(DR.needsSync(d.project, d.desk), true);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'written');
  assert.deepEqual(get(d.dst).permissions.allow, ['Bash(npm test:*)', 'Bash(npm run lint)', 'Bash(make:*)']);
  assert.deepEqual(get(d.dst).permissions.deny, ['Read(./.env)']);
});

test('write: a desk file that is not a JSON object is the desk\'s own and is left alone', (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  put(d.dst, '{ not json');
  assert.equal(DR.needsSync(d.project, d.desk), false);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'no-target');
  assert.equal(fs.readFileSync(d.dst, 'utf8'), '{ not json');
});

test('write: never through a symlink in the desk, into a missing desk folder or onto the project itself', (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  const outside = path.join(d.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(d.desk, '.claude'));
  assert.equal(DR.needsSync(d.project, d.desk), false);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'no-target');
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(d.desk, '.claude'));
  fs.mkdirSync(path.join(d.desk, '.claude'));
  const victim = path.join(outside, 'victim.json');
  fs.writeFileSync(victim, '{"keep":1}');
  fs.symlinkSync(victim, d.dst);
  assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'no-target');
  assert.equal(fs.readFileSync(victim, 'utf8'), '{"keep":1}');
  assert.equal(DR.write(d.project, path.join(d.root, 'gone'), { tmpDir: d.tmpDir }), 'no-target');
  assert.equal(DR.needsSync(d.project, d.project), false);
  assert.equal(DR.write(d.project, d.project, { tmpDir: d.tmpDir }), 'no-target');
});

test('write: a failed write leaves no temp file and nothing in the desk', (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  fs.mkdirSync(d.tmpDir);
  fs.mkdirSync(path.join(d.desk, '.claude'));
  if (process.getuid && process.getuid() === 0) return;   // root writes anyway
  fs.chmodSync(path.join(d.desk, '.claude'), 0o500);   // the rename into it fails
  try { assert.equal(DR.write(d.project, d.desk, { tmpDir: d.tmpDir }), 'failed'); } finally { fs.chmodSync(path.join(d.desk, '.claude'), 0o700); }
  assert.deepEqual(fs.readdirSync(d.tmpDir), []);
  assert.deepEqual(fs.readdirSync(path.join(d.desk, '.claude')), []);
});

test('excludeAddition: only the added lines, once, with a newline first when the file does not end with one', () => {
  assert.match(DR.excludeAddition('# mine\n*.log'), /^\n# Agent Office:[^\n]*\n\.claude\/settings\.local\.json\n$/);
  assert.match(DR.excludeAddition('# mine\n*.log\n'), /^# Agent Office:[^\n]*\n\.claude\/settings\.local\.json\n$/);
  assert.match(DR.excludeAddition(''), /^# Agent Office:[^\n]*\n\.claude\/settings\.local\.json\n$/);
  assert.equal(DR.excludeAddition('*.log\n.claude/settings.local.json\n'), null);
  assert.equal(DR.excludeAddition('/.claude/settings.local.json'), null);
});

test('ensureExcluded: appends to info/exclude, keeps what is there, adds nothing the second time; false with no such dir', (t) => {
  const d = dirs(t);
  const common = path.join(d.root, 'git');
  assert.equal(DR.ensureExcluded(common), false);
  fs.mkdirSync(common);
  assert.equal(DR.ensureExcluded(common), true);   // the file and its folder are made
  assert.ok(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n').includes(DR.REL));
  const mine = '# my own lines\n*.secret\n  build/  ';   // no newline at the end
  fs.writeFileSync(path.join(common, 'info', 'exclude'), mine);
  assert.equal(DR.ensureExcluded(common), true);
  const first = fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8');
  assert.ok(first.startsWith(`${mine}\n# Agent Office:`));
  assert.ok(first.endsWith(`\n${DR.REL}\n`));
  assert.equal(DR.ensureExcluded(common), true);
  assert.equal(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8'), first);
});

test('sync: not ignored yet: one line goes into info/exclude (its content kept), then the rules are written and git does not see them', async (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  repo(d);
  const before = fs.existsSync(exclude(d)) ? fs.readFileSync(exclude(d), 'utf8') : '';
  fs.mkdirSync(path.dirname(exclude(d)), { recursive: true });
  fs.writeFileSync(exclude(d), `${before}*.mine`);
  assert.equal(await DR.sync(d.project, d.desk, { git, tmpDir: d.tmpDir }), 'written');
  assert.deepEqual(get(d.dst), RULES);
  assert.ok(fs.readFileSync(exclude(d), 'utf8').startsWith(`${before}*.mine\n`));
  assert.equal((await git(['-C', d.desk, 'status', '--porcelain'])).stdout, '');
  assert.equal(await DR.sync(d.project, d.desk, { git, tmpDir: d.tmpDir }), 'current');
});

test('sync: already ignored by the project\'s .gitignore: written, info/exclude untouched', async (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  repo(d, { '.gitignore': '.claude/settings.local.json\n' });
  const before = fs.existsSync(exclude(d)) ? fs.readFileSync(exclude(d), 'utf8') : null;
  assert.equal(await DR.sync(d.project, d.desk, { git, tmpDir: d.tmpDir }), 'written');
  assert.equal(fs.existsSync(exclude(d)) ? fs.readFileSync(exclude(d), 'utf8') : null, before);
  assert.equal((await git(['-C', d.desk, 'status', '--porcelain'])).stdout, '');
});

test('sync: a .gitignore that re-includes the file wins over info/exclude: nothing is written', async (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  repo(d, { '.gitignore': '.claude/*\n!.claude/settings.local.json\n' });
  assert.equal(await DR.sync(d.project, d.desk, { git, tmpDir: d.tmpDir }), 'not-ignored');
  assert.equal(fs.existsSync(d.dst), false);
  assert.equal(fs.existsSync(d.tmpDir) ? fs.readdirSync(d.tmpDir).length : 0, 0);
  assert.equal((await git(['-C', d.desk, 'status', '--porcelain'])).stdout, '');
});

test('sync: a file git tracks in the worktree is never written; neither when git cannot say', async (t) => {
  const d = dirs(t);
  put(d.src, RULES);
  repo(d, { [DR.REL]: '{"tracked":true}' });
  assert.equal(await DR.sync(d.project, d.desk, { git, tmpDir: d.tmpDir }), 'tracked');
  assert.deepEqual(get(d.dst), { tracked: true });
  const d2 = dirs(t);
  put(d2.src, RULES);
  assert.equal(await DR.sync(d2.project, d2.desk, { git, tmpDir: d2.tmpDir }), 'tracked');   // not a repository
  assert.equal(fs.existsSync(d2.dst), false);
});

// --- v3.94 the project account's user-level rules for a desk on another account

test('v3.94 accountRulesWanted: only a project staff desk on another account; never mail, a personal workspace or HQ', () => {
  const base = { project: { id: 'p1' }, tab: { n: 2, staffId: 's-1' }, hasMail: false, projectConfigDir: null, deskConfigDir: '/acc/b' };
  assert.equal(DR.accountRulesWanted(base), true);
  assert.equal(DR.accountRulesWanted({ ...base, projectConfigDir: '/acc/a' }), true);
  assert.equal(DR.accountRulesWanted({ ...base, deskConfigDir: null }), false, 'same account (Default): its rules are already there');
  assert.equal(DR.accountRulesWanted({ ...base, projectConfigDir: '/acc/b' }), false, 'same account');
  assert.equal(DR.accountRulesWanted({ ...base, hasMail: true }), false, 'a mail desk: the mail guard decides');
  assert.equal(DR.accountRulesWanted({ ...base, project: { id: 'p1', staffOwner: 's-1' } }), false, 'a personal workspace');
  assert.equal(DR.accountRulesWanted({ ...base, project: { id: 'hq', hq: true } }), false);
  assert.equal(DR.accountRulesWanted({ ...base, tab: { n: 2 } }), false, 'not a staff desk');
  assert.equal(DR.accountRulesWanted({ ...base, tab: null }), false, 'the main tab');
});

test('v3.94 withAccountRules: only allow/deny/ask cross, ahead of the session\'s own; every other key of the account stays behind', () => {
  const account = {
    model: 'opus', env: { SECRET: 'x' }, hooks: { PreToolUse: [] }, apiKeyHelper: '/bin/x', skipDangerousModePermissionPrompt: true,
    permissions: { allow: ['Bash(npm test:*)', 'Read', 7, ''], deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'], defaultMode: 'bypassPermissions', additionalDirectories: ['/x'] },
  };
  const json = JSON.stringify({ statusLine: { type: 'command', command: 'x' }, autoMemoryDirectory: '/m', permissions: { allow: ['Read', 'Edit'] } });
  const out = JSON.parse(DR.withAccountRules(json, account));
  assert.deepEqual(out, {
    statusLine: { type: 'command', command: 'x' }, autoMemoryDirectory: '/m',
    permissions: { allow: ['Bash(npm test:*)', 'Read', 'Edit'], deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'] },
  });
  const text = DR.withAccountRules(json, account);
  for (const never of ['defaultMode', 'bypassPermissions', 'SECRET', 'hooks', 'apiKeyHelper', 'additionalDirectories', 'skipDangerousModePermissionPrompt', 'opus']) assert.equal(text.includes(never), false, never);
  // no session settings yet: only the rules
  assert.deepEqual(JSON.parse(DR.withAccountRules(null, account)), { permissions: { allow: ['Bash(npm test:*)', 'Read'], deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'] } });
  // nothing usable in the account: the JSON as given
  assert.equal(DR.withAccountRules(json, { permissions: { defaultMode: 'acceptEdits' } }), json);
  assert.equal(DR.withAccountRules(json, null), json);
  assert.equal(DR.withAccountRules(null, null), null);
  assert.equal(DR.withAccountRules('', { model: 'x' }), null);
});

test('v3.94 readSettings follows a symlink only when asked (an account\'s settings.json, read only); main passes the rules to the desk, never to a mail session', (t) => {
  const d = dirs(t);
  const real = path.join(d.root, 'real-settings.json');
  const link = path.join(d.root, 'settings.json');
  fs.writeFileSync(real, JSON.stringify({ permissions: { allow: ['Read'] } }));
  const before = fs.readFileSync(real, 'utf8');
  fs.symlinkSync(real, link);
  assert.equal(DR.readSettings(link), null, 'the desk file path never follows a link');
  assert.deepEqual(DR.readSettings(link, { follow: true }), { permissions: { allow: ['Read'] } });
  assert.equal(DR.readSettings(path.join(d.root, 'missing.json'), { follow: true }), null);
  assert.equal(fs.readFileSync(real, 'utf8'), before);
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const guarded = mailMcp \? MG\.guardSettings\(settings, [^\n]*\) : deskAccountRules\(r, account, settings\);/, 'a mail session keeps the guard\'s settings only');
  const fn = src.slice(src.indexOf('function deskAccountRules('), src.indexOf('async function syncDeskRules('));
  assert.match(fn, /P\.findProject\(state, r\.project\.id\)/, 'the project as stored: its own account');
  assert.match(fn, /DR\.accountRulesWanted\(\{ project: own, tab: r\.tab, hasMail, projectConfigDir: from\.configDir, deskConfigDir: account\.configDir \}\)/);
  assert.match(fn, /DR\.readSettings\(accountSettingsFile\(from\), \{ follow: true \}\)/);
  assert.equal(/writeFile|writeJson|rename|mkdir/.test(fn), false, 'nothing is written for this');
  assert.match(src, /if \(guarded && \(IS_WIN \|\| guarded\.length > DR\.MAX_ARG_CHARS\)\) \{\n\s+settingsArg = settingsFile\(usageKey\(id\), guarded\);/);
});

test('v3.94 the desk\'s rules are synced on every app-triggered start, whatever `start` says', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const open = src.slice(src.indexOf('async function openDeskNow('), src.indexOf('function personalFolderName('));
  const sync = open.indexOf('if (!terms.has(id)) await syncDeskRules(p, have, m);');
  const start = open.indexOf('if (start && !terms.has(id)) {');
  assert.ok(sync > 0 && start > sync, 'an existing desk that is not running: synced before, and without, the start');
  const at = src.indexOf('function startPty(');
  const pty = src.slice(at, src.indexOf('const dir = pluginDir();', at));
  assert.match(pty, /if \(tab\?\.staffId && tab\.worktree\) syncDeskRules\(P\.findProject\(state, project\.id\) \|\| project, tab, memberById\(tab\.staffId\)\)\.catch\(/, 'every start of a worktree desk (HQ, revive, wake)');
});

test('v3.94 readSettings never blocks on a FIFO and returns null', { skip: process.platform === 'win32' }, (t) => {
  const d = dirs(t);
  const fifo = path.join(d.root, 'settings.json');
  execFileSync('mkfifo', [fifo]);
  assert.equal(DR.readSettings(fifo), null);
  assert.equal(DR.readSettings(fifo, { follow: true }), null);
  const link = path.join(d.root, 'link.json');
  fs.symlinkSync(fifo, link);
  assert.equal(DR.readSettings(link, { follow: true }), null);
});

test('v3.94 a desk worktree is trusted only when the project\'s own folder is trusted in the project\'s account (nothing is written otherwise)', (t) => {
  const PD = require('../src/project-data.js');
  const d = dirs(t);
  const key = 'hasTrustDialogAccepted';
  assert.equal(PD.folderTrusted({}, d.project), false);
  assert.equal(PD.folderTrusted(undefined, d.project), false);
  assert.equal(PD.folderTrusted({ [d.project]: { [key]: false } }, d.project), false);
  assert.equal(PD.folderTrusted({ [d.project]: { [key]: true } }, d.project), true);
  assert.equal(PD.folderTrusted({ [d.root]: { [key]: true } }, d.project), true);   // a parent's entry counts
  assert.equal(PD.folderTrusted({ [d.desk]: { [key]: true } }, d.project), false);   // another folder does not
});
