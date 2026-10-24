// Bundled skill packs (contract v3.45): pure logic, no Electron; tested in test/skill-packs.test.mjs.
// A pack is a Claude Code plugin folder under skill-packs/<id>/ (made by scripts/vendor-skills.mjs from one pinned
// upstream commit). Each ENABLED pack reaches a Claude Code session as one `--plugin-dir`, next to Agent Office's
// own plugin; nothing is written to ~/.claude, ~/.claude.json or an account folder.
// Global: state.skillPacks { [id]: boolean } holds only what differs from the pack's default (manifest defaultOn).
// Per project: project.skillPacks { [id]: boolean }; absent = inherit the global setting.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PROJECT_VALUES = ['inherit', 'on', 'off'];

/**
 * { [id]: boolean } with only well-formed ids and boolean values (anything else is dropped).
 * @param {unknown} raw
 * @returns {Record<string, boolean>}
 */
function cleanMap(raw) {
  /** @type {Record<string, boolean>} */
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (ID_RE.test(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}
/**
 * For projects.js normalizeState: the field only when it holds something.
 * @param {unknown} raw
 * @returns {{ skillPacks?: Record<string, boolean> }}
 */
const withSkillPacks = (raw) => { const m = cleanMap(raw); return Object.keys(m).length ? { skillPacks: m } : {}; };

/** The packs shipped in `root`: manifest order, only those whose plugin folder is there. */
function loadPacks(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const packs = [];
  for (const p of Array.isArray(manifest.packs) ? manifest.packs : []) {
    if (!p || !ID_RE.test(p.id) || !fs.existsSync(path.join(root, p.id, '.claude-plugin', 'plugin.json'))) continue;
    let up = {};
    try { up = JSON.parse(fs.readFileSync(path.join(root, p.id, 'UPSTREAM.json'), 'utf8')); } catch {}
    packs.push({
      id: p.id, name: String(p.plugin?.name || p.id), repo: String(p.repo || ''), sha: String(p.sha || ''),
      license: String(p.license || ''), defaultOn: p.defaultOn === true, paidApi: p.paidApi ? String(p.paidApi) : null,
      managerOff: p.managerOff === true,
      skills: Array.isArray(up.skills) ? up.skills.length : 0,
      skillNames: Array.isArray(up.skills) ? up.skills.map(String) : [],
    });
  }
  return packs;
}

const globalOn = (state, pack) => { const v = cleanMap(state?.skillPacks)[pack.id]; return typeof v === 'boolean' ? v : pack.defaultOn; };
/** 'inherit' | 'on' | 'off' */
const projectValue = (project, id) => { const v = cleanMap(project?.skillPacks)[id]; return typeof v === 'boolean' ? (v ? 'on' : 'off') : 'inherit'; };
function packOn(state, project, pack) {
  const v = projectValue(project, pack.id);
  return v === 'inherit' ? globalOn(state, pack) : v === 'on';
}
/** The packs a Claude Code session of `project` gets (project null: the global setting). */
const enabledPacks = (state, project, packs) => packs.filter((p) => packOn(state, project, p));
/** One `--plugin-dir <dir>` per folder. */
const pluginDirArgs = (dirs) => dirs.flatMap((d) => ['--plugin-dir', d]);

/** Global on/off; same state when nothing changes or the pack is unknown. Stored only when it differs from the default. */
function setGlobal(state, id, on, packs) {
  const pack = packs.find((p) => p.id === id);
  if (!pack || typeof on !== 'boolean' || globalOn(state, pack) === on) return state;
  const { [id]: _, ...rest } = cleanMap(state.skillPacks);
  return { ...state, skillPacks: on === pack.defaultOn ? rest : { ...rest, [id]: on } };
}

/** Per project: 'inherit' | 'on' | 'off'; same state when nothing changes, the value is bad or pack/project unknown. */
function setProjectPack(state, projectId, id, value, packs) {
  const p = (state.projects || []).find((x) => x.id === projectId);
  if (!p || !packs.some((x) => x.id === id) || !PROJECT_VALUES.includes(value) || projectValue(p, id) === value) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== projectId) return x;
    const { skillPacks: old, ...rest } = x;
    const { [id]: _, ...others } = cleanMap(old);
    const map = value === 'inherit' ? others : { ...others, [id]: value === 'on' };
    return { ...rest, ...withSkillPacks(map) };
  }) };
}

// ---- what the account already has (v3.45 duplicates): Claude Code's --plugin-dir overrides a same-named plugin, so
// a pack whose plugin name the account already uses is skipped, and skills the account already has are left out of
// a copy of the pack. Read ONLY <claudeDir>/plugins/installed_plugins.json, <claudeDir>/settings.json and the folder
// listings of <claudeDir>/skills and <claudeDir>/skills/synced (never .credentials.json, .claude.json or the keychain).

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const pluginName = (key) => (key.lastIndexOf('@') > 0 ? key.slice(0, key.lastIndexOf('@')) : key);
const listDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map((e) => e.name); } catch { return []; } };

/** Names of the plugins installed in `claudeDir` and enabled in its settings.json. */
function enabledPluginNames(claudeDir) {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const settings = readJson(path.join(claudeDir, 'settings.json'));
  const on = isObj(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  return Object.keys(isObj(installed?.plugins) ? installed.plugins : {}).filter((k) => Boolean(on[k])).map(pluginName);
}

/**
 * What an account already has. claudeDir: the account's folder (configDir, or ~/.claude for Default); defaultDir:
 * ~/.claude when the account shares Default's plugins (their names count too), else null.
 * @param {{ claudeDir: string, defaultDir?: string | null }} o
 * @returns {{ plugins: string[], skills: string[] }}
 */
function readOwned({ claudeDir, defaultDir = null }) {
  const plugins = new Set(enabledPluginNames(claudeDir));
  if (defaultDir && path.resolve(defaultDir) !== path.resolve(claudeDir)) for (const n of enabledPluginNames(defaultDir)) plugins.add(n);
  const skills = new Set([...listDirs(path.join(claudeDir, 'skills')), ...listDirs(path.join(claudeDir, 'skills', 'synced'))]);
  skills.delete('synced');
  return { plugins: [...plugins].sort(), skills: [...skills].sort() };
}

/**
 * Per pack: skipped whole when its plugin name is taken ('plugin') or every skill is ('skills'); otherwise `without`
 * lists the skills to leave out (a plugin's name counts as a skill name too: a `frontend-design` plugin brings the
 * `frontend-design` skill). Pure.
 * @param {any[]} packs
 * @param {{ plugins?: string[], skills?: string[] } | null} owned
 * @returns {{ pack: any, skip: null | 'plugin' | 'skills', without: string[] }[]}
 */
function skipOwned(packs, owned) {
  const plugins = new Set(owned?.plugins || []);
  const skills = new Set([...(owned?.skills || []), ...plugins]);
  return packs.map((pack) => {
    if (plugins.has(pack.name)) return { pack, skip: 'plugin', without: [] };
    const names = pack.skillNames || [];
    const without = names.filter((n) => skills.has(n)).sort();
    return { pack, skip: names.length && without.length === names.length ? 'skills' : null, without };
  });
}

/** Folder name of a pack's copy: `<id>`, or `<id>--<hash>` for a copy without some skills. */
const skipHash = (without) => crypto.createHash('sha256').update([...without].sort().join('\n')).digest('hex').slice(0, 10);
const copyName = (id, without = []) => (without.length ? `${id}--${skipHash(without)}` : id);
const STAMP = '.agent-office-stamp.json';
const stampOf = (sha, version, without = []) => ({ sha, version, skip: without.length ? skipHash(without) : '' });
const sameStamp = (a, b) => isObj(a) && isObj(b) && a.sha === b.sha && a.version === b.version && a.skip === b.skip;

/**
 * Copy pack `src` to `<base>/<copyName>` (a skill may write into its own folder, e.g. design-dna's sharp install, so
 * never run from the signed bundle). A copy whose stamp (sha + app version + skipped skills) matches is reused as is;
 * otherwise it is built in `<dest>.tmp-<pid>` and renamed into place. → the folder; throws when the copy fails.
 * @param {{ src: string, base: string, id: string, sha: string, version: string, without?: string[] }} o
 */
function preparePackDir({ src, base, id, sha, version, without = [] }) {
  const dest = path.join(base, copyName(id, without));
  const stamp = stampOf(sha, version, without);
  if (sameStamp(readJson(path.join(dest, STAMP)), stamp)) return dest;
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(src, tmp, { recursive: true });
    for (const s of without) fs.rmSync(path.join(tmp, 'skills', s), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmp, STAMP), JSON.stringify(stamp) + '\n');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

/**
 * At start: remove from `base` what nothing will use: leftover `.tmp-` folders, copies of packs no longer shipped,
 * and copies whose stamp is for another pack commit or app version (they would be rebuilt anyway). → names removed.
 */
function prunePackDirs(base, packs, version) {
  const gone = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch { return gone; }
  for (const n of names) {
    const id = n.split('--')[0].split('.tmp-')[0];
    const pack = packs.find((p) => p.id === id);
    const st = readJson(path.join(base, n, STAMP));
    const keep = pack && !n.includes('.tmp-') && isObj(st) && st.sha === pack.sha && st.version === version;
    if (!keep) { fs.rmSync(path.join(base, n), { recursive: true, force: true }); gone.push(n); }
  }
  return gone.sort();
}

/**
 * A Claude Code session's pack arguments: the enabled packs (global / project setting), minus `managerOff` packs in
 * a manager-mode boss tab, minus what the account already has (skipOwned); dirFor(pack, without) makes the copy and
 * returns its folder, or null when the copy failed (that pack is left out). Pure apart from dirFor.
 * @param {{ state: any, project: any, packs: any[], boss?: boolean, owned?: { plugins?: string[], skills?: string[] } | null, dirFor: (pack: any, without: string[]) => string | null }} o
 * @returns {{ args: string[], ids: string[], skipped: { id: string, reason: string, skills?: string[] }[] }}
 */
function sessionPacks({ state, project, packs, boss = false, owned = null, dirFor }) {
  const skipped = [];
  const enabled = enabledPacks(state, project, packs).filter((p) => {
    if (boss && p.managerOff) { skipped.push({ id: p.id, reason: 'manager' }); return false; }
    return true;
  });
  const dirs = [];
  const ids = [];
  for (const { pack, skip, without } of skipOwned(enabled, owned)) {
    if (skip) { skipped.push({ id: pack.id, reason: skip }); continue; }
    let dir = null;
    try { dir = dirFor(pack, without); } catch { dir = null; }
    if (!dir) { skipped.push({ id: pack.id, reason: 'copy' }); continue; }
    if (without.length) skipped.push({ id: pack.id, reason: 'skills', skills: without });
    dirs.push(dir);
    ids.push(pack.id);
  }
  return { args: pluginDirArgs(dirs), ids, skipped };
}

/** Per project, several packs at once ({ [id]: 'inherit' | 'on' | 'off' }); same state when nothing changes. */
function setProjectPacks(state, projectId, values, packs) {
  let next = state;
  for (const [id, v] of Object.entries(isObj(values) ? values : {})) next = setProjectPack(next, projectId, String(id), v, packs);
  return next;
}

/** Ids of the Claude Code projects whose enabled pack set differs between two states (who a change must restart). */
function changedProjects(before, after, packs, engineOf = (p) => p.engine || 'claude') {
  const key = (s, p) => enabledPacks(s, p, packs).map((x) => x.id).join(',');
  return (after.projects || []).filter((p) => {
    if (engineOf(p) !== 'claude') return false;
    const old = (before.projects || []).find((x) => x.id === p.id);
    return !old || key(before, old) !== key(after, p);
  }).map((p) => p.id);
}

/**
 * For the renderer: every pack with its global state, the project's override and what the project gets; with
 * `owned` (the account's plugins and skills) also `owned: 'plugin' | 'skills' | null` and `ownedSkills` (already in
 * the account, so not loaded from the pack).
 */
const listing = (state, project, packs, owned = null) => {
  const by = new Map(skipOwned(packs, owned).map((r) => [r.pack.id, r]));
  return packs.map(({ skillNames, ...p }) => ({
    ...p, on: globalOn(state, p), project: project ? projectValue(project, p.id) : 'inherit', active: packOn(state, project, p),
    owned: by.get(p.id)?.skip || null, ownedSkills: by.get(p.id)?.skip ? [] : by.get(p.id)?.without || [],
  }));
};

module.exports = {
  ID_RE, PROJECT_VALUES, STAMP, cleanMap, withSkillPacks, loadPacks, globalOn, projectValue, packOn, enabledPacks, pluginDirArgs,
  setGlobal, setProjectPack, setProjectPacks, changedProjects, listing, readOwned, skipOwned, copyName, preparePackDir,
  prunePackDirs, sessionPacks,
};
