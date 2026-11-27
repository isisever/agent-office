// What's new (contract v3.123): node --test app/test/whats-new.test.cjs
// Version order, what a start shows, manifest validation, the shipped manifests, packaging and the release check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const WN = require('../src/whats-new.js');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');
const DIR = path.join(APP, 'whats-new');
const CHECK = path.join(ROOT, 'scripts', 'check-whats-new.mjs');

const item = (over = {}) => ({ id: 'a', title: { en: 'T', tr: 'B' }, body: { en: 'Body', tr: 'Gövde' }, ...over });

test('v3.123 compareVersions: numeric parts, prereleases before their release, invalid first', () => {
  assert.equal(WN.compareVersions('0.22.10', '0.22.9'), 1);
  assert.equal(WN.compareVersions('0.22.44', '0.22.44'), 0);
  assert.equal(WN.compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(WN.compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(WN.compareVersions('0.23.0-beta.1', '0.23.0'), -1);
  assert.equal(WN.compareVersions('0.23.0-beta.2', '0.23.0-beta.1'), 1);
  assert.equal(WN.compareVersions('junk', '0.0.1'), -1);
  assert.equal(WN.compareVersions('0.0.1', 'junk'), 1);
});

test('v3.123 versionsBetween: after (exclusive) up to (inclusive), newest first', () => {
  const avail = ['0.22.40', '0.22.44', '0.22.42', '0.22.45', 'notes'];
  assert.deepEqual(WN.versionsBetween('0.22.40', '0.22.44', avail), ['0.22.44', '0.22.42']);
  assert.deepEqual(WN.versionsBetween('0.22.44', '0.22.44', avail), []);
});

test('v3.123 decide: update, fresh install, old state, downgrade, dev runs and the env switch', () => {
  const available = ['0.22.42', '0.22.43', '0.22.44', '0.22.45'];
  const base = { current: '0.22.44', fresh: false, packaged: true, available };
  // an update shows every version in between, newest first, and remembers the running one
  assert.deepEqual(WN.decide({ ...base, lastSeen: '0.22.41' }), { show: ['0.22.44', '0.22.43', '0.22.42'], save: '0.22.44' });
  // the same version again: nothing
  assert.deepEqual(WN.decide({ ...base, lastSeen: '0.22.44' }), { show: [], save: null });
  // a downgrade: nothing shown, lastSeenVersion kept
  assert.deepEqual(WN.decide({ ...base, lastSeen: '0.22.45' }), { show: [], save: null });
  // fresh install: silent, but remembered
  assert.deepEqual(WN.decide({ ...base, fresh: true }), { show: [], save: '0.22.44' });
  // a state.json from before the feature: every manifest up to the running version, newest first
  assert.deepEqual(WN.decide({ ...base, lastSeen: undefined }), { show: ['0.22.44', '0.22.43', '0.22.42'], save: '0.22.44' });
  assert.deepEqual(WN.decide({ ...base, lastSeen: 42 }), { show: ['0.22.44', '0.22.43', '0.22.42'], save: '0.22.44' });
  // dev runs: never shown, never stored
  assert.deepEqual(WN.decide({ ...base, packaged: false, lastSeen: '0.22.41' }), { show: [], save: null });
  assert.deepEqual(WN.decide({ ...base, packaged: false, fresh: true }), { show: [], save: null });
  // AGENT_OFFICE_WHATS_NEW=1 in a dev run: shown (the newest one when nothing is pending), still not stored
  assert.deepEqual(WN.decide({ ...base, packaged: false, force: true, lastSeen: '0.22.42' }), { show: ['0.22.44', '0.22.43'], save: null });
  assert.deepEqual(WN.decide({ ...base, packaged: false, force: true, lastSeen: '0.22.44' }), { show: ['0.22.44'], save: null });
  // no manifest for the versions in between: nothing to show, still remembered
  assert.deepEqual(WN.decide({ ...base, current: '0.22.50', lastSeen: '0.22.46' }), { show: [], save: '0.22.50' });
});

test("v3.123 upgrade from a version without What's new: 0.22.44 users updating to 0.22.45 see both manifests", () => {
  const available = WN.listVersions(DIR);
  assert.deepEqual(WN.decide({ lastSeen: undefined, current: '0.22.45', fresh: false, packaged: true, available }), { show: ['0.22.45', '0.22.44'], save: '0.22.45' });
  // the fresh install of the same version stays silent
  assert.deepEqual(WN.decide({ lastSeen: undefined, current: '0.22.45', fresh: true, packaged: true, available }), { show: [], save: '0.22.45' });
  assert.deepEqual(WN.entriesFor(DIR, ['0.22.45', '0.22.44']).map((e) => e.version), ['0.22.45', '0.22.44']);
});

test('v3.123 isKnownAction: the fixed set, open-settings with a known section', () => {
  for (const a of WN.ACTIONS) assert.ok(WN.isKnownAction(a), a);
  assert.ok(WN.isKnownAction('open-settings:about'));
  assert.ok(!WN.isKnownAction('open-settings:nope'));
  assert.ok(!WN.isKnownAction('open-studio:x'));
  assert.ok(!WN.isKnownAction('rm -rf'));
  assert.ok(!WN.isKnownAction('open-settings:about:x'));
  assert.ok(!WN.isKnownAction(undefined));
});

test('v3.123 validateManifest: both languages, unique ids, known actions, experience, target, version', () => {
  assert.deepEqual(WN.validateManifest({ items: [item()] }, '1.0.0'), []);
  assert.deepEqual(WN.validateManifest({ items: [item({ experience: 'studio', target: '#x', try: { label: { en: 'Go', tr: 'Git' }, action: 'open-settings:experience' } })] }), []);
  const has = (m, re, v) => assert.ok(WN.validateManifest(m, v).some((e) => re.test(e)), `${re} in ${JSON.stringify(WN.validateManifest(m, v))}`);
  has(null, /JSON object/);
  has({ items: [] }, /non-empty/);
  has({ items: [item({ title: { en: 'T' } })] }, /title\.tr: missing/);
  has({ items: [item({ body: { en: '', tr: 'x' } })] }, /body\.en: missing/);
  has({ items: [item(), item()] }, /used twice/);
  has({ items: [item({ id: 'Bad Id' })] }, /\.id:/);
  has({ items: [item({ experience: 'web' })] }, /experience/);
  has({ items: [item({ target: '<b>' })] }, /target/);
  has({ items: [item({ try: { label: { en: 'Go', tr: 'Git' }, action: 'run-shell' } })] }, /try\.action/);
  has({ items: [item({ try: { label: { en: 'Go' }, action: 'open-studio' } })] }, /try\.label\.tr/);
  has({ items: [item({ try: { label: { en: 'Go', tr: 'Git' }, action: 'spotlight' } })] }, /spotlight needs a target/);
  assert.deepEqual(WN.validateManifest({ items: [item({ target: '#keep-awake', try: { label: { en: 'Show', tr: 'Göster' }, action: 'spotlight' } })] }), []);
  has({ version: '1.0.1', items: [item()] }, /does not match/, '1.0.0');
});

test('v3.123 the shipped manifests are valid, and the running version has one', () => {
  const versions = WN.listVersions(DIR);
  assert.ok(versions.length >= 2);
  for (const v of versions) assert.deepEqual(WN.readManifest(DIR, v).errors, [], v);
  const current = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  assert.ok(versions.includes(current), `app/whats-new/${current}.json`);
  const entries = WN.entriesFor(DIR, [current, '0.0.1']);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, current);
});

test('v3.123 every shipped target names ids and classes the renderer really has', () => {
  const R = path.join(APP, 'renderer');
  const code = fs.readdirSync(R).filter((f) => /\.(js|html)$/.test(f)).map((f) => fs.readFileSync(path.join(R, f), 'utf8')).join('\n');
  for (const v of WN.listVersions(DIR)) {
    for (const it of WN.readManifest(DIR, v).manifest.items) {
      if (!it.target) continue;
      for (const [, kind, name] of it.target.matchAll(/([#.])([A-Za-z][\w-]*)/g)) {
        const re = kind === '#' ? new RegExp(`id(: |=)["']${name}["']`) : new RegExp(`class(: |=)["'][^"']*\\b${name}\\b`);
        assert.match(code, re, `${v} ${it.id}: ${kind}${name}`);
      }
    }
  }
});

test('v3.123 electron-builder packages app/whats-new', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('whats-new/*.json'));
});

test('v3.123 the card (src/whats-new-ui.mjs): steps per experience, actions split, texts in the language', async () => {
  const { stepsFor, splitAction, textOf } = await import('../src/whats-new-ui.mjs');
  const entries = [{ version: '2.0.0', items: [item({ id: 'o', experience: 'office' }), item({ id: 's', experience: 'studio' }), item({ id: 'b' })] }, { version: '1.0.0', items: [item({ id: 'x', experience: 'both' })] }];
  assert.deepEqual(stepsFor(entries, 'office').map((s) => `${s.version}/${s.item.id}`), ['2.0.0/o', '2.0.0/b', '1.0.0/x']);
  assert.deepEqual(stepsFor(entries, 'studio').map((s) => s.item.id), ['s', 'b', 'x']);
  assert.deepEqual(stepsFor([{ version: '1.0.0', items: [item({ experience: 'studio' })] }], 'office').length, 1);
  assert.deepEqual(splitAction('open-settings:about'), { id: 'open-settings', arg: 'about' });
  assert.deepEqual(splitAction('open-studio'), { id: 'open-studio', arg: '' });
  assert.equal(textOf({ en: 'Hi', tr: 'Selam' }, 'tr'), 'Selam');
  assert.equal(textOf({ en: 'Hi', tr: 'Selam' }, 'pt-BR'), 'Hi');
});

test('v3.123 the release check: ok for a valid file, stops for a missing or invalid one', () => {
  const run = (...args) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
  const ok = run('0.22.44');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ok: app\/whats-new\/0\.22\.44\.json/);
  const missing = run('99.0.0');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing or invalid/);
  assert.equal(run().status, 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-'));
  try {
    fs.writeFileSync(path.join(tmp, '1.0.0.json'), JSON.stringify({ items: [item({ title: { en: 'Only English' } })] }));
    fs.writeFileSync(path.join(tmp, '1.0.1.json'), '{ not json');
    const bad = run('1.0.0', '--dir', tmp);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /title\.tr: missing/);
    assert.match(run('1.0.1', '--dir', tmp).stderr, /not valid JSON/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // scripts/release.mjs runs it in step 1
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'release.mjs'), 'utf8'), /check-whats-new\.mjs/);
});
