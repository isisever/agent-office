'use strict';
// A folder trusted in one account is trusted in the account a desk is about to run in (no trust dialog to wait behind).
// Every file lives in a temp home; the real ~/.claude*.json files are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PD = require('../src/project-data.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-trust-'));
  const dir = path.join(home, 'proj'); fs.mkdirSync(dir);
  const other = path.join(home, 'acct2'); fs.mkdirSync(other);
  return { home, dir, other, from: path.join(home, '.claude.json'), to: path.join(other, '.claude.json') };
}

test('carryFolderTrust: trusted in the source account, written to the target account only', () => {
  const t = setup();
  fs.writeFileSync(t.from, JSON.stringify({ projects: { [t.dir]: { hasTrustDialogAccepted: true } } }));
  assert.equal(PD.carryFolderTrust(null, t.other, t.home, t.dir), true);
  const to = JSON.parse(fs.readFileSync(t.to, 'utf8'));
  assert.equal(to.projects[t.dir].hasTrustDialogAccepted, true);
  assert.equal(PD.carryFolderTrust(null, t.other, t.home, t.dir), false, 'already trusted: no rewrite');
});

test('carryFolderTrust: trust through a parent folder, not trusted, same account', () => {
  const t = setup();
  fs.writeFileSync(t.from, JSON.stringify({ projects: { [t.home]: { hasTrustDialogAccepted: true } } }));
  assert.equal(PD.carryFolderTrust(null, t.other, t.home, t.dir), true, 'parent trust counts');
  const t2 = setup();
  fs.writeFileSync(t2.from, JSON.stringify({ projects: {} }));
  assert.equal(PD.carryFolderTrust(null, t2.other, t2.home, t2.dir), false, 'the person never trusted it: Claude Code asks');
  assert.equal(fs.existsSync(t2.to), false);
  assert.equal(PD.carryFolderTrust(t2.other, t2.other, t2.home, t2.dir), false, 'same account');
});
