#!/usr/bin/env node
// Bundled skill packs (contract v3.45): builds skill-packs/<id>/ from skill-packs/manifest.json.
// Per pack: fetch the pinned commit (git, depth 1) or take a local checkout (--src id=dir), copy only `take`,
// remove `drop`, apply `patches` (each must match exactly once), drop fonts without a licence file when
// `fontsNeedLicense`, write .claude-plugin/plugin.json, NOTICE (when given) and UPSTREAM.json.
// Nothing from the upstream repo is executed. An update = bump `sha` in the manifest, run this, review the diff.
//   node scripts/vendor-skills.mjs [--src id=dir ...] [id ...]   build (all packs, or the ids named)
//   node scripts/vendor-skills.mjs --check                          verify the vendored tree (no network)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill-packs');
export const MANIFEST = path.join(ROOT, 'manifest.json');
/** Never shipped in any pack: hooks, MCP configs, installers, and Anthropic's proprietary or unlicensed skills. */
export const FORBIDDEN = ['hooks', '.mcp.json', 'hooks.json', 'install.sh', 'install.ps1'];
export const FORBIDDEN_SKILLS = ['docx', 'pdf', 'pptx', 'xlsx', 'doc-coauthoring', 'discernment-nudge', 'academy-guide', 'caveman-setup'];
const LICENSE_RE = /^(LICENSE|LICENCE|NOTICE|COPYING)/i;

export const readManifest = (file = MANIFEST) => JSON.parse(fs.readFileSync(file, 'utf8'));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) walk(p, out);
  }
  return out;
}

/** drop pattern: a path relative to the pack, or `**\/<name>` = every file or folder of that name. */
function applyDrops(dest, drops) {
  const gone = [];
  for (const d of drops) {
    const targets = d.startsWith('**/') ? walk(dest).filter((p) => path.basename(p) === d.slice(3)) : [path.join(dest, d)];
    for (const t of targets) if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); gone.push(path.relative(dest, t)); }
  }
  return gone;
}

/** A .ttf/.otf without a `<Family>-OFL.txt` (or LICENSE) beside it may not be redistributed: drop it. */
function dropUnlicensedFonts(dest) {
  const gone = [];
  for (const f of walk(dest).filter((p) => /\.(ttf|otf)$/i.test(p))) {
    if (!fs.existsSync(f)) continue;
    const dir = path.dirname(f);
    const family = path.basename(f).split('-')[0];
    if (!fs.existsSync(path.join(dir, `${family}-OFL.txt`)) && !fs.readdirSync(dir).some((n) => LICENSE_RE.test(n))) {
      fs.rmSync(f); gone.push(path.relative(dest, f));
    }
  }
  return gone;
}

export function skillsOf(packDir) {
  const skills = path.join(packDir, 'skills');
  if (!fs.existsSync(skills)) return [];
  return fs.readdirSync(skills).filter((n) => fs.existsSync(path.join(skills, n, 'SKILL.md'))).sort();
}

function fetchCommit(repo, sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-vendor-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'ignore', 'inherit'] });
  git('init', '-q');
  git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, sha);
  git('-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
  return dir;
}

export function buildPack(pack, src, root = ROOT) {
  const dest = path.join(root, pack.id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const [from, to] of pack.take) {
    const s = path.join(src, from);
    if (!fs.existsSync(s)) throw new Error(`${pack.id}: ${from} is not in ${pack.repo}@${pack.sha}`);
    fs.mkdirSync(path.dirname(path.join(dest, to)), { recursive: true });
    fs.cpSync(s, path.join(dest, to), { recursive: true, dereference: false });
  }
  const dropped = applyDrops(dest, pack.drop || []);
  if (pack.fontsNeedLicense) dropped.push(...dropUnlicensedFonts(dest));
  for (const p of pack.patches || []) {
    const file = path.join(dest, p.file);
    const text = fs.readFileSync(file, 'utf8');
    if (text.split(p.find).length !== 2) throw new Error(`${pack.id}: patch for ${p.file} does not match exactly once`);
    fs.writeFileSync(file, text.replace(p.find, () => p.replace));
  }
  fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify(pack.plugin, null, 2) + '\n');
  if (pack.notice) fs.writeFileSync(path.join(dest, 'NOTICE'), pack.notice);
  const upstream = {
    repo: pack.repo, sha: pack.sha, license: pack.license, skills: skillsOf(dest),
    dropped: dropped.sort(), patches: (pack.patches || []).map((p) => ({ file: p.file, why: p.why })),
  };
  fs.writeFileSync(path.join(dest, 'UPSTREAM.json'), JSON.stringify(upstream, null, 2) + '\n');
  return upstream;
}

/** Problems with the vendored tree, [] when it is fine. Used by --check and the tests. */
export function check(root = ROOT, manifest = readManifest(path.join(root, 'manifest.json'))) {
  const bad = [];
  for (const pack of manifest.packs) {
    const dir = path.join(root, pack.id);
    if (!fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) { bad.push(`${pack.id}: no plugin.json`); continue; }
    let up = null;
    try { up = JSON.parse(fs.readFileSync(path.join(dir, 'UPSTREAM.json'), 'utf8')); } catch { bad.push(`${pack.id}: no UPSTREAM.json`); }
    if (up && up.sha !== pack.sha) bad.push(`${pack.id}: vendored ${up.sha}, manifest ${pack.sha}`);
    if (!fs.readdirSync(dir).some((n) => LICENSE_RE.test(n))) bad.push(`${pack.id}: no licence file`);
    if (!skillsOf(dir).length) bad.push(`${pack.id}: no skills`);
    for (const p of walk(dir)) {
      const name = path.basename(p);
      if (FORBIDDEN.includes(name)) bad.push(`${pack.id}: ${path.relative(dir, p)} must not ship`);
    }
    for (const s of skillsOf(dir)) if (FORBIDDEN_SKILLS.includes(s)) bad.push(`${pack.id}: skill ${s} must not ship`);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    for (const k of ['hooks', 'mcpServers', 'lspServers']) if (pj[k]) bad.push(`${pack.id}: plugin.json has ${k}`);
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const bad = check();
    for (const b of bad) console.error(b);
    process.exit(bad.length ? 1 : 0);
  }
  const srcs = {};
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--src') { const [id, dir] = args[++i].split('='); srcs[id] = path.resolve(dir); } else ids.push(args[i]);
  }
  const manifest = readManifest();
  for (const pack of manifest.packs.filter((p) => !ids.length || ids.includes(p.id))) {
    const src = srcs[pack.id] || fetchCommit(pack.repo, pack.sha);
    if (srcs[pack.id]) {
      const head = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (head !== pack.sha) throw new Error(`${pack.id}: ${src} is at ${head}, manifest pins ${pack.sha}`);
    }
    const up = buildPack(pack, src);
    console.log(`${pack.id}: ${up.skills.length} skills, ${up.dropped.length} dropped, ${up.patches.length} patched`);
    if (!srcs[pack.id]) fs.rmSync(src, { recursive: true, force: true });
  }
  const bad = check();
  for (const b of bad) console.error(b);
  process.exit(bad.length ? 1 : 0);
}
