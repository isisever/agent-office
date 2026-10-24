// Bundled skill packs (contract v3.45): node --test app/test/skill-packs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  // main.js passes them next to its own plugin, for Claude Code sessions (startClaude)
  const main = fs.readFileSync(path.join(HERE, '..', 'main.js'), 'utf8');
  assert.match(main, /SP\.pluginDirArgs\(SP\.enabledPacks\(state, project, skillPacks\(\)\)/);
  assert.match(main, /\['--plugin-dir', dir\] : \[\]\), \.\.\.packs, \.\.\.shared/);
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
