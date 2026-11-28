// The project's account label: a project moved to a backup keeps remembering its home; choosing the account it is on
// makes that the home (no stale "back to <home>" note).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { accountChoices, accountToSet } from '../src/studio-account-picker.mjs';
const require = createRequire(import.meta.url);
const P = require('../src/projects.js');
const STU = require('../src/studio.js');

const state = () => ({
  accounts: [{ id: 'default', label: 'Default', configDir: null }, { id: 'tk', label: 'ThinkOne', configDir: '/x/tk' }],
  projects: [{ id: 'p1', dir: '/a', name: 'a', accountId: 'default', homeAccount: 'tk' }],
  activeId: 'p1',
});

test('setProjectAccount to the account it is already on forgets the stale home', () => {
  const next = P.setProjectAccount(state(), 'p1', 'default');
  assert.equal(next.projects[0].accountId, 'default');
  assert.equal('homeAccount' in next.projects[0], false);
});

test('the picker lets the current account be chosen only while a home is remembered', () => {
  const c = accountChoices(state().accounts, 'Default');
  assert.equal(accountToSet(c, 'default'), null);
  assert.equal(accountToSet(c, 'default', true), 'default');
});

test('Studio project list carries the home label next to the account label', () => {
  const s = state();
  const out = STU.listSessions({
    projects: s.projects, status: [], recent: [],
    accountOf: () => 'Default', homeOf: (p) => (p.homeAccount === 'tk' ? 'ThinkOne' : ''),
  });
  assert.equal(out[0].account, 'Default');
  assert.equal(out[0].home, 'ThinkOne');
});

test('re-picking the project own account only forgets the home label and does not move the tabs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("ipcMain.handle('projects:setAccount'"), src.indexOf('moveProject(id, from);', src.indexOf("ipcMain.handle('projects:setAccount'")));
  assert.match(body, /commit\(next\);\s*\n\s*if \(p\.accountId === accountId\) return;/);
});
