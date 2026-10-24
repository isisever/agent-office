// Bundled skill packs (contract v3.45): node --test app/test/skill-packs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check, skillsOf, readManifest, FORBIDDEN_SKILLS } from '../../scripts/vendor-skills.mjs';
import { caps, ENGINES } from '../src/engine-caps.mjs';

const require = createRequire(import.meta.url);
const SP = require('../src/skill-packs.js');
const P = require('../src/projects.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const ROOT = path.join(REPO, 'skill-packs');
const packs = SP.loadPacks(ROOT);
const ids = (list) => list.map((p) => p.id);
const DEFAULT_ON = ['karpathy', 'ui-ux-pro-max', 'superpowers', 'skill-creator', 'design-dna', 'anthropic-skills'];
const DEFAULT_OFF = ['caveman', 'taste-skill', 'scroll-craft'];

test('skill packs: the nine packs ship, defaults as decided', () => {
  assert.deepEqual(ids(packs).sort(), [...DEFAULT_ON, ...DEFAULT_OFF].sort());
  assert.deepEqual(ids(SP.enabledPacks({}, null, packs)), DEFAULT_ON);
  for (const p of packs) assert.ok(p.skills > 0 && p.license && /^[0-9a-f]{40}$/.test(p.sha), p.id);
  assert.equal(packs.find((p) => p.id === 'scroll-craft').paidApi, 'kie.ai');
});

test('skill packs: launch args = exactly one --plugin-dir per enabled pack', () => {
  const state = { skillPacks: { caveman: true, superpowers: false }, projects: [] };
  const on = SP.enabledPacks(state, null, packs);
  assert.deepEqual(ids(on), ['karpathy', 'ui-ux-pro-max', 'skill-creator', 'design-dna', 'anthropic-skills', 'caveman']);
  assert.deepEqual(SP.pluginDirArgs(on.map((p) => `/u/${p.id}`)), on.flatMap((p) => ['--plugin-dir', `/u/${p.id}`]));
});

// startPty's assembly (main.js passes SP.sessionPacks(...).args after its own --plugin-dir): behaviour per project
const dirFor = (pack, without) => `/u/${SP.copyName(pack.id, without)}`;
const dirsOf = (args) => args.filter((_, i) => i % 2 === 1);
test('skill packs: session args per project (override, manager-off boss tab, owned, failed copy)', () => {
  const state = P.normalizeState({ projects: [{ id: 'a', dir: '/a' }, { id: 'b', dir: '/b', skillPacks: { karpathy: false, caveman: true } }] });
  const [a, b] = state.projects;
  const ra = SP.sessionPacks({ state, project: a, packs, dirFor });
  assert.deepEqual(ra.ids, DEFAULT_ON);
  assert.deepEqual(ra.args, DEFAULT_ON.flatMap((id) => ['--plugin-dir', `/u/${id}`]));
  const rb = SP.sessionPacks({ state, project: b, packs, dirFor });
  assert.deepEqual(rb.ids, [...DEFAULT_ON.filter((x) => x !== 'karpathy'), 'caveman']);
  // the manager-mode boss tab does not get superpowers (managerOff); a worker tab of the same project does
  const boss = SP.sessionPacks({ state, project: a, packs, boss: true, dirFor });
  assert.ok(!boss.ids.includes('superpowers') && boss.skipped.some((x) => x.id === 'superpowers' && x.reason === 'manager'));
  assert.ok(packs.find((p) => p.id === 'superpowers').managerOff);
  // the account already has a superpowers plugin and the frontend-design skill
  const owned = { plugins: ['superpowers'], skills: ['frontend-design', 'claude-api'] };
  const ro = SP.sessionPacks({ state, project: a, packs, owned, dirFor });
  assert.ok(!ro.ids.includes('superpowers'));
  const anth = dirsOf(ro.args).find((d) => d.includes('anthropic-skills'));
  assert.equal(anth, `/u/${SP.copyName('anthropic-skills', ['claude-api', 'frontend-design'])}`);
  assert.match(anth, /anthropic-skills--[0-9a-f]{10}$/);
  assert.deepEqual(ro.skipped.find((x) => x.id === 'anthropic-skills').skills, ['claude-api', 'frontend-design']);
  // a pack whose copy failed is left out, the others still load
  const rf = SP.sessionPacks({ state, project: a, packs, dirFor: (p, w) => (p.id === 'karpathy' ? null : p.id === 'design-dna' ? (() => { throw new Error('disk'); })() : dirFor(p, w)) });
  assert.deepEqual(rf.ids, DEFAULT_ON.filter((x) => x !== 'karpathy' && x !== 'design-dna'));
  assert.equal(rf.args.length, rf.ids.length * 2);
  // main.js uses this assembly next to its own plugin
  const main = fs.readFileSync(path.join(HERE, '..', 'main.js'), 'utf8');
  assert.match(main, /SP\.sessionPacks\(\{/);
});

test('skill packs: skipOwned skips a taken plugin name, trims clashing skills, skips a pack left empty', () => {
  const fake = [{ id: 'x', name: 'xp', skillNames: ['a', 'b'] }, { id: 'y', name: 'yp', skillNames: ['c'] }, { id: 'z', name: 'zp', skillNames: ['d'] }];
  const r = SP.skipOwned(fake, { plugins: ['xp', 'd'], skills: ['c'] });
  assert.deepEqual(r.map((x) => [x.pack.id, x.skip, x.without]), [['x', 'plugin', []], ['y', 'skills', ['c']], ['z', 'skills', ['d']]]);
  assert.deepEqual(SP.skipOwned(fake, null).map((x) => x.skip), [null, null, null]);
  const l = SP.listing({ projects: [] }, null, packs, { plugins: ['skill-creator'], skills: ['frontend-design'] });
  assert.equal(l.find((p) => p.id === 'skill-creator').owned, 'plugin');
  assert.deepEqual(l.find((p) => p.id === 'anthropic-skills').ownedSkills, ['frontend-design']);
  assert.equal('skillNames' in l[0], false);
});

test('skill packs: readOwned reads only installed_plugins.json, settings.json and the skills folders', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-owned-'));
  const acc = path.join(tmp, 'acc');
  const def = path.join(tmp, 'def');
  const w = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); };
  w(path.join(acc, 'plugins', 'installed_plugins.json'), { plugins: { 'superpowers@m': [{ scope: 'user', installPath: '/x' }], 'off@m': [{}] } });
  w(path.join(acc, 'settings.json'), { enabledPlugins: { 'superpowers@m': true, 'off@m': false } });
  w(path.join(def, 'plugins', 'installed_plugins.json'), { plugins: { 'skill-creator@claude-plugins-official': [{}] } });
  w(path.join(def, 'settings.json'), { enabledPlugins: { 'skill-creator@claude-plugins-official': true } });
  fs.mkdirSync(path.join(acc, 'skills', 'frontend-design'), { recursive: true });
  w(path.join(acc, 'skills', 'synced', 'claude-api', 'SKILL.md'), 'x');
  w(path.join(acc, '.credentials.json'), { secret: 'never read' });
  const reads = [];
  const orig = fs.readFileSync;
  fs.readFileSync = (f, ...r) => { reads.push(String(f)); return orig(f, ...r); };
  let owned;
  try { owned = SP.readOwned({ claudeDir: acc, defaultDir: def }); } finally { fs.readFileSync = orig; }
  assert.deepEqual(owned, { plugins: ['skill-creator', 'superpowers'], skills: ['claude-api', 'frontend-design'] });
  assert.equal(reads.length, 4); // two files per folder
  assert.ok(reads.every((f) => /(installed_plugins|settings)\.json$/.test(f)), reads.join());
  assert.deepEqual(SP.readOwned({ claudeDir: acc }).plugins, ['superpowers']); // not sharing Default's
  assert.deepEqual(SP.readOwned({ claudeDir: path.join(tmp, 'none') }), { plugins: [], skills: [] });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('skill packs: readOwned counts claude.ai-synced skills and plugins (anthropic-skills: namespace, bucket layout)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-synced-'));
  const acc = path.join(tmp, 'acc');
  const w = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  const bucket = 'aaaaaaaa-0000-4000-8000-000000000001_bbbbbbbb-0000-4000-8000-000000000002';
  const sk = path.join(acc, 'skills', 'synced');
  for (const n of ['skill-creator', 'pdf', 'docx']) w(path.join(sk, bucket, n, 'SKILL.md'), '---\nname: x\n---');
  w(path.join(sk, bucket, 'manifest.json'), JSON.stringify({ skills: [{ skillId: 'skill-creator', name: 'skill-creator' }] }));
  w(path.join(sk, bucket, '.last-complete-round'), '1');
  fs.mkdirSync(path.join(sk, `.bucket-${bucket}`), { recursive: true });
  const pl = path.join(acc, 'plugins', 'synced', bucket);
  w(path.join(pl, 'cowork-plugin-management', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cowork-plugin-management' }));
  fs.mkdirSync(path.join(pl, 'cowork-plugin-management', 'skills', 'create-cowork-plugin'), { recursive: true });
  w(path.join(pl, 'manifest.json'), JSON.stringify({ plugins: [] }));
  w(path.join(pl, '.marketplaces.json'), '{}');
  w(path.join(acc, '.credentials.json'), JSON.stringify({ secret: 'never read' }));
  w(path.join(acc, '.claude.json'), JSON.stringify({ oauthAccount: 'never read' }));
  const reads = [];
  const orig = fs.readFileSync;
  fs.readFileSync = (f, ...r) => { reads.push(String(f)); return orig(f, ...r); };
  let owned;
  try { owned = SP.readOwned({ claudeDir: acc }); } finally { fs.readFileSync = orig; }
  assert.deepEqual(owned, { plugins: ['cowork-plugin-management'], skills: ['docx', 'pdf', 'skill-creator'] });
  assert.ok(reads.every((f) => /(installed_plugins|settings)\.json$/.test(f)), reads.join());
  const packs = [{ id: 'skill-creator', name: 'skill-creator', skillNames: ['skill-creator'] }];
  assert.equal(SP.skipOwned(packs, owned)[0].skip, 'skills');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('skill packs: copies are stamped and reused, rebuilt atomically, pruned at start', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copy-'));
  const src = path.join(tmp, 'src');
  const base = path.join(tmp, 'base');
  fs.mkdirSync(path.join(src, 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(src, 'skills', 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'skills', 'a', 'SKILL.md'), 'a');
  fs.writeFileSync(path.join(src, 'skills', 'b', 'SKILL.md'), 'b');
  const o = { src, base, id: 'p', sha: 's1', version: '1.0.0' };
  const d = SP.preparePackDir(o);
  assert.equal(d, path.join(base, 'p'));
  fs.writeFileSync(path.join(d, 'skills', 'a', 'installed.txt'), 'user-approved install'); // e.g. design-dna's sharp
  assert.equal(SP.preparePackDir(o), d);
  assert.ok(fs.existsSync(path.join(d, 'skills', 'a', 'installed.txt')), 'same stamp: not wiped');
  SP.preparePackDir({ ...o, version: '1.0.1' });
  assert.ok(!fs.existsSync(path.join(d, 'skills', 'a', 'installed.txt')), 'new app version: rebuilt');
  const w = SP.preparePackDir({ ...o, version: '1.0.1', without: ['b'] });
  assert.equal(path.basename(w), SP.copyName('p', ['b']));
  assert.deepEqual(fs.readdirSync(path.join(w, 'skills')), ['a']);
  assert.ok(!fs.readdirSync(base).some((n) => n.includes('.tmp-')));
  assert.throws(() => SP.preparePackDir({ ...o, src: path.join(tmp, 'missing'), version: '2' }));
  assert.ok(!fs.readdirSync(base).some((n) => n.includes('.tmp-')), 'a failed copy leaves no temp folder');
  fs.mkdirSync(path.join(base, 'p.tmp-999'));
  fs.mkdirSync(path.join(base, 'gone'));
  const gone = SP.prunePackDirs(base, [{ id: 'p', sha: 's1' }], '1.0.1');
  assert.deepEqual(gone, ['gone', 'p.tmp-999']);
  assert.deepEqual(SP.prunePackDirs(base, [{ id: 'p', sha: 's2' }], '1.0.1').sort(), ['p', SP.copyName('p', ['b'])].sort()); // new pack commit
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('skill packs: one batched project call; only projects whose pack set changed restart', () => {
  let s = P.normalizeState({ projects: [{ id: 'a', dir: '/a' }, { id: 'b', dir: '/b', skillPacks: { karpathy: true } }, { id: 'c', dir: '/c', engine: 'agy' }] });
  const n = SP.setProjectPacks(s, 'a', { karpathy: 'off', caveman: 'on', bogus: 'on', superpowers: 'maybe' }, packs);
  assert.deepEqual(n.projects[0].skillPacks, { karpathy: false, caveman: true });
  assert.equal(SP.setProjectPacks(n, 'a', { karpathy: 'off' }, packs), n);
  assert.deepEqual(SP.changedProjects(s, n, packs), ['a']);
  const g = SP.setGlobal(s, 'karpathy', false, packs);
  assert.deepEqual(SP.changedProjects(s, g, packs), ['a']); // b keeps karpathy on, c is not Claude Code
  assert.deepEqual(SP.changedProjects(s, s, packs), []);
});

test('skill packs: project overrides travel with a handoff as plain settings (booleans only)', () => {
  const H = require('../src/handoff.js');
  assert.deepEqual(H.cleanSettings({ skillPacks: { caveman: true }, manager: false }), { manager: false, skillPacks: { caveman: true } });
  const adopted = P.normalizeState({ projects: [{ id: 'a', dir: '/a', ...H.cleanSettings({ skillPacks: { caveman: true, 'Bad Id': true, x: 'token' } }) }] });
  assert.deepEqual(adopted.projects[0].skillPacks, { caveman: true });
  const main = fs.readFileSync(path.join(HERE, '..', 'main.js'), 'utf8');
  assert.match(main, /savings: p\.savings, engine: p\.engine, skillPacks: p\.skillPacks/);
});

test('skill packs: superpowers has no bootstrap skill or always-on wording', () => {
  const sp = path.join(ROOT, 'superpowers', 'skills');
  assert.ok(!fs.existsSync(path.join(sp, 'using-superpowers')));
  const brain = fs.readFileSync(path.join(sp, 'brainstorming', 'SKILL.md'), 'utf8');
  assert.match(brain, /^description: "Use when the user asks to design or plan/m);
  for (const s of fs.readdirSync(sp)) {
    const text = fs.readFileSync(path.join(sp, s, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /before ANY response|ABSOLUTELY MUST|You MUST use this/, s);
  }
});

test('vendor check: forbidden files fail the check (settings, .lsp.json, monitors, root commands/agents, install scripts)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-vendor-check-'));
  const dir = path.join(tmp, 'p');
  const w = (rel, text = '{}') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('.claude-plugin/plugin.json', JSON.stringify({ name: 'p' }));
  w('UPSTREAM.json', JSON.stringify({ sha: 'x' }));
  w('LICENSE', 'MIT');
  w('skills/s/SKILL.md', 'x');
  const manifest = { packs: [{ id: 'p', sha: 'x' }] };
  assert.deepEqual(check(tmp, manifest), []);
  w('skills/s/package.json', JSON.stringify({ scripts: { test: 'node t' } }));
  assert.deepEqual(check(tmp, manifest), []);
  for (const rel of ['skills/s/settings.json', 'skills/s/.lsp.json', 'skills/s/monitors/m.json', 'skills/s/x/hooks.json', 'skills/s/y/.mcp.json', 'commands/c.md', 'agents/a.md']) w(rel);
  w('skills/s/z/package.json', JSON.stringify({ scripts: { postinstall: 'curl' } }));
  const bad = check(tmp, manifest).join('\n');
  for (const want of ['settings.json', '.lsp.json', 'monitors', 'hooks.json', '.mcp.json', 'commands/', 'agents/', 'postinstall']) assert.ok(bad.includes(want), want);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('skill packs: global setting stores only what differs from the default', () => {
  let s = { projects: [] };
  s = SP.setGlobal(s, 'caveman', true, packs);
  assert.deepEqual(s.skillPacks, { caveman: true });
  s = SP.setGlobal(s, 'karpathy', false, packs);
  assert.deepEqual(s.skillPacks, { caveman: true, karpathy: false });
  s = SP.setGlobal(s, 'caveman', false, packs);
  assert.deepEqual(s.skillPacks, { karpathy: false });
  assert.equal(SP.setGlobal(s, 'karpathy', false, packs), s); // unchanged
  assert.equal(SP.setGlobal(s, 'nope', true, packs), s); // unknown pack
  assert.equal(SP.setGlobal(s, 'caveman', 'yes', packs), s); // not a boolean
});

test('skill packs: per-project inherit / on / off, kept by normalizeState', () => {
  let s = P.normalizeState({ projects: [{ id: 'a', dir: '/a' }, { id: 'b', dir: '/b' }] });
  s = { ...s, skillPacks: { superpowers: false } };
  s = SP.setProjectPack(s, 'a', 'superpowers', 'on', packs);
  s = SP.setProjectPack(s, 'a', 'karpathy', 'off', packs);
  const [a, b] = s.projects;
  assert.deepEqual(a.skillPacks, { superpowers: true, karpathy: false });
  assert.equal(SP.projectValue(a, 'caveman'), 'inherit');
  assert.ok(ids(SP.enabledPacks(s, a, packs)).includes('superpowers'));
  assert.ok(!ids(SP.enabledPacks(s, a, packs)).includes('karpathy'));
  assert.ok(!ids(SP.enabledPacks(s, b, packs)).includes('superpowers')); // b inherits the global off
  assert.equal(SP.setProjectPack(s, 'a', 'superpowers', 'maybe', packs), s);
  assert.equal(SP.setProjectPack(s, 'zz', 'superpowers', 'on', packs), s);
  const back = SP.setProjectPack(SP.setProjectPack(s, 'a', 'superpowers', 'inherit', packs), 'a', 'karpathy', 'inherit', packs);
  assert.equal('skillPacks' in back.projects[0], false); // nothing left: no field
  // state.json round trip keeps overrides and drops junk
  const n = P.normalizeState({ projects: [{ id: 'a', dir: '/a', skillPacks: { superpowers: true, 'Bad Id': true, caveman: 'on' } }] });
  assert.deepEqual(n.projects[0].skillPacks, { superpowers: true });
  const l = SP.listing(s, a, packs).find((p) => p.id === 'superpowers');
  assert.deepEqual([l.on, l.project, l.active], [false, 'on', true]);
});

test('skill packs: vendored tree is clean (no hooks, .mcp.json, proprietary skills), pinned, licensed', () => {
  assert.deepEqual(check(ROOT), []);
  const manifest = readManifest(path.join(ROOT, 'manifest.json'));
  for (const pack of manifest.packs) {
    const dir = path.join(ROOT, pack.id);
    assert.ok(fs.readdirSync(dir).some((n) => /^(LICENSE|NOTICE)/.test(n)), `${pack.id} licence`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'UPSTREAM.json'), 'utf8')).sha, pack.sha);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'superpowers', 'hooks')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'ui-ux-pro-max', 'stack')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'caveman', 'src')), false);
  const anth = skillsOf(path.join(ROOT, 'anthropic-skills'));
  for (const s of FORBIDDEN_SKILLS) assert.ok(!anth.includes(s), s);
  assert.ok(!anth.includes('skill-creator')); // the skill-creator pack has it
  assert.ok(!skillsOf(path.join(ROOT, 'caveman')).includes('caveman-setup'));
  assert.ok(fs.existsSync(path.join(ROOT, 'karpathy', 'NOTICE')));
  const dna = fs.readFileSync(path.join(ROOT, 'design-dna', 'skills', 'design-dna', 'SKILL.md'), 'utf8');
  assert.match(dna, /ask the user before installing it/);
  assert.doesNotMatch(dna, /```bash\n {2}npm install --prefix/);
});

test('packaging: the app ships skill-packs/ and the plugin reviewer agent (plugin/agents)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const res = pkg.build.extraResources;
  const plugin = res.find((r) => r.to === 'plugin');
  assert.ok(plugin.filter.includes('agents/**'));
  assert.ok(fs.existsSync(path.join(REPO, 'plugin', 'agents', 'reviewer.md')));
  const sp = res.find((r) => r.to === 'skill-packs');
  assert.equal(sp.from, '../skill-packs');
  assert.ok(sp.filter.includes('**/*'));
  // the Windows config is built from the same extraResources
  assert.match(fs.readFileSync(path.join(HERE, '..', 'scripts', 'win-builder-config.cjs'), 'utf8'), /\.\.\.build/);
});

test('skill packs: Claude Code only (engine caps); every pack has its strings', () => {
  for (const e of ENGINES) assert.equal(caps(e).skillPacks.ok, e === 'claude', e);
  for (const lang of ['en', 'tr']) {
    const sb = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'locales', `${lang}.json`), 'utf8')).sidebar;
    for (const p of packs) assert.ok(sb.skillPack[p.id], `${lang} ${p.id}`);
    assert.ok(sb.na.claudeOnlySkills);
  }
});
