// Chat view "/" commands (contract v3.80 amendment): src/slash-commands.js (what a tab offers) and src/slash-match.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SLASH = require('../src/slash-commands.js');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  return root;
}

test('describe: frontmatter name and description, else the first text line', () => {
  assert.deepEqual(SLASH.describe('---\nname: deploy\ndescription: "Deploy to staging"\n---\n# Body'), { name: 'deploy', description: 'Deploy to staging' });
  assert.deepEqual(SLASH.describe('\n# Fix the build\nmore'), { name: '', description: 'Fix the build' });
});

test('commandsFor: project, account, synced skills, enabled plugins, packs, /office, built-ins; the first of a name wins', () => {
  const root = tree({
    'proj/.claude/commands/deploy.md': '---\ndescription: Deploy to staging\n---\n',
    'proj/.claude/commands/db/migrate.md': 'Run migrations',
    'proj/.claude/skills/brand/SKILL.md': '---\nname: brand-voice\ndescription: Write in the brand voice\n---\n',
    'proj/.claude/commands/compact.md': 'Our own compact',
    'cfg/commands/standup.md': 'Write my standup',
    'cfg/skills/synced/org_user/xlsx/SKILL.md': '---\nname: xlsx\ndescription: Spreadsheets\n---\n',
    'cfg/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'postman@market': [{ installPath: 'PLUG' }], 'off@market': [{ installPath: 'OFF' }] } }),
    'cfg/settings.json': JSON.stringify({ enabledPlugins: { 'postman@market': true, 'off@market': false } }),
    'plug/skills/api-engineer/SKILL.md': '---\nname: api-engineer\ndescription: APIs\n---\n',
    'pack/skills/brainstorming/SKILL.md': '---\nname: brainstorming\ndescription: Plan first\n---\n',
  });
  // installPath is absolute in Claude Code's file
  fs.writeFileSync(path.join(root, 'cfg/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'postman@market': [{ installPath: path.join(root, 'plug') }], 'off@market': [{ installPath: path.join(root, 'plug') }] } }));
  const list = SLASH.commandsFor({ cwd: path.join(root, 'proj'), claudeDir: path.join(root, 'cfg'), packs: [{ name: 'superpowers', dir: path.join(root, 'pack') }], extra: [{ name: 'office', description: 'Office' }] });
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(by.deploy.description, 'Deploy to staging');
  assert.equal(by['db:migrate'].source, 'project');
  assert.equal(by['brand-voice'].description, 'Write in the brand voice');
  assert.equal(by.compact.description, 'Our own compact', 'a project command shadows the built-in');
  assert.equal(by.standup.source, 'user');
  assert.equal(by.xlsx.source, 'user');
  assert.equal(by['postman:api-engineer'].source, 'plugin');
  assert.ok(!list.some((c) => c.name.startsWith('off:')), 'a disabled plugin offers nothing');
  assert.equal(by['superpowers:brainstorming'].description, 'Plan first');
  assert.equal(by.office.source, 'plugin');
  assert.equal(by.model.ui, true);
  assert.equal(by.init.ui, undefined);
  assert.equal(new Set(list.map((c) => c.name)).size, list.length);
  // no project folder, nothing on disk: the built-ins
  assert.ok(SLASH.commandsFor({ cwd: null, claudeDir: '/no/such' }).length >= SLASH.BUILTIN.length);
});

test('slash-match: the query only while typing the first word; prefix, plugin part, substring, description', async () => {
  const M = await import('../src/slash-match.mjs');
  assert.equal(M.slashQuery('/co'), 'co');
  assert.equal(M.slashQuery('/'), '');
  assert.equal(M.slashQuery('/compact now'), null);
  assert.equal(M.slashQuery('/compact now', 4), 'com');
  assert.equal(M.slashQuery('hello /co'), null);
  const list = [{ name: 'context' }, { name: 'compact' }, { name: 'code-review' }, { name: 'superpowers:code' }, { name: 'clear', description: 'Start a new context' }, { name: 'xco' }];
  assert.deepEqual(M.matchCommands(list, 'co').map((c) => c.name), ['compact', 'context', 'code-review', 'superpowers:code', 'xco', 'clear']);
  assert.deepEqual(M.matchCommands(list, 'context').map((c) => c.name), ['context', 'clear']);
  assert.equal(M.matchCommands(list, '', 3).length, 3);
});

test('main.js: chat:commands for Claude Code tabs only, cached', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:commands'"), MAIN.indexOf("ipcMain.handle('chat:read'"));
  assert.match(body, /P\.engineOf\(r\.project\) !== 'claude'\) return \[\]/);
  assert.match(body, /SLASH\.commandsFor\(/);
  assert.match(body, /Date\.now\(\) - hit\.at < 30000/);
});
