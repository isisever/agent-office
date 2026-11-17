'use strict';
// A desk's worktree gets the project's local permission rules (contract v3.92).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DR = require('../src/desk-rules.js');

/** A temp dir with a project folder and a desk folder. */
function dirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-desk-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const desk = path.join(root, 'desk');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(desk);
  return { root, project, desk, src: path.join(project, DR.REL), dst: path.join(desk, DR.REL) };
}
const RULES = JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } });
const age = (file, secondsAgo) => { const at = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(file, at, at); };

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

test('copy: the one file goes into the desk, its folder is made, nothing else is copied', (t) => {
  const d = dirs(t);
  fs.writeFileSync(d.src, RULES);
  fs.writeFileSync(path.join(d.project, '.claude', 'settings.json'), '{"tracked":true}');
  fs.writeFileSync(path.join(d.project, '.claude', 'other.md'), 'x');
  assert.equal(DR.needsCopy(d.project, d.desk), true);
  assert.equal(DR.copy(d.project, d.desk), 'copied');
  assert.equal(fs.readFileSync(d.dst, 'utf8'), RULES);
  assert.deepEqual(fs.readdirSync(path.join(d.desk, '.claude')), ['settings.local.json']);
});

test('copy: again only when the source is newer than the copy', (t) => {
  const d = dirs(t);
  fs.writeFileSync(d.src, RULES);
  age(d.src, 100);
  assert.equal(DR.copy(d.project, d.desk), 'copied');
  assert.equal(DR.needsCopy(d.project, d.desk), false);
  assert.equal(DR.copy(d.project, d.desk), 'current');
  fs.writeFileSync(d.dst, '{"desk":1}');   // the desk's own change stays while the source is older
  assert.equal(DR.copy(d.project, d.desk), 'current');
  assert.equal(fs.readFileSync(d.dst, 'utf8'), '{"desk":1}');
  age(d.dst, 50);
  fs.writeFileSync(d.src, '{"v":2}');
  assert.equal(DR.needsCopy(d.project, d.desk), true);
  assert.equal(DR.copy(d.project, d.desk), 'copied');
  assert.equal(fs.readFileSync(d.dst, 'utf8'), '{"v":2}');
});

test('copy: skipped when the source is missing, a folder, a symlink or over 256 KB', (t) => {
  const d = dirs(t);
  assert.equal(DR.needsCopy(d.project, d.desk), false);
  assert.equal(DR.copy(d.project, d.desk), 'no-source');
  fs.mkdirSync(d.src);
  assert.equal(DR.copy(d.project, d.desk), 'no-source');
  fs.rmdirSync(d.src);
  const secret = path.join(d.root, 'secret.json');
  fs.writeFileSync(secret, '{"secret":1}');
  fs.symlinkSync(secret, d.src);
  assert.equal(DR.needsCopy(d.project, d.desk), false);
  assert.equal(DR.copy(d.project, d.desk), 'no-source');
  fs.unlinkSync(d.src);
  fs.writeFileSync(d.src, Buffer.alloc(DR.MAX_BYTES + 1, 0x20));
  assert.equal(DR.needsCopy(d.project, d.desk), false);
  assert.equal(DR.copy(d.project, d.desk), 'no-source');
  fs.writeFileSync(d.src, Buffer.alloc(DR.MAX_BYTES, 0x20));
  assert.equal(DR.copy(d.project, d.desk), 'copied');
  assert.equal(fs.existsSync(path.join(d.desk, '.claude', `.settings.local.json.${process.pid}.tmp`)), false);
});

test('copy: never written through a symlink in the desk, into a missing desk folder or onto the project itself', (t) => {
  const d = dirs(t);
  fs.writeFileSync(d.src, RULES);
  const outside = path.join(d.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(d.desk, '.claude'));
  assert.equal(DR.needsCopy(d.project, d.desk), false);
  assert.equal(DR.copy(d.project, d.desk), 'no-target');
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(d.desk, '.claude'));
  fs.mkdirSync(path.join(d.desk, '.claude'));
  const victim = path.join(outside, 'victim.json');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, d.dst);
  assert.equal(DR.copy(d.project, d.desk), 'no-target');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(DR.copy(d.project, path.join(d.root, 'gone')), 'no-target');
  assert.equal(DR.needsCopy(d.project, d.project), false);
  assert.equal(DR.copy(d.project, d.project), 'no-target');
});

test('excludeText: the line is added once, after what is there', () => {
  const a = DR.excludeText('# git ls-files --others --exclude-from=.git/info/exclude\n*.log');
  assert.match(a, /^# git ls-files[^\n]*\n\*\.log\n# Agent Office:[^\n]*\n\.claude\/settings\.local\.json\n$/);
  assert.equal(DR.excludeText(a), null);
  assert.equal(DR.excludeText('/.claude/settings.local.json\n'), null);
  assert.match(DR.excludeText(''), /^# Agent Office:[^\n]*\n\.claude\/settings\.local\.json\n$/);
});

test('ensureExcluded: writes the common dir\'s info/exclude once; false when there is no such dir', (t) => {
  const d = dirs(t);
  const common = path.join(d.root, 'git');
  assert.equal(DR.ensureExcluded(common), false);
  fs.mkdirSync(common);
  assert.equal(DR.ensureExcluded(common), true);
  const first = fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8');
  assert.ok(first.split('\n').includes(DR.REL));
  assert.equal(DR.ensureExcluded(common), true);
  assert.equal(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8'), first);
});
