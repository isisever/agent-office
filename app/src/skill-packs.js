// Bundled skill packs (contract v3.45): pure logic, no Electron; tested in test/skill-packs.test.cjs.
// A pack is a Claude Code plugin folder under skill-packs/<id>/ (made by scripts/vendor-skills.mjs from one pinned
// upstream commit). Each ENABLED pack reaches a Claude Code session as one `--plugin-dir`, next to Agent Office's
// own plugin; nothing is written to ~/.claude, ~/.claude.json or an account folder.
// Global: state.skillPacks { [id]: boolean } holds only what differs from the pack's default (manifest defaultOn).
// Per project: project.skillPacks { [id]: boolean }; absent = inherit the global setting.
const fs = require('fs');
const path = require('path');

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
      skills: Array.isArray(up.skills) ? up.skills.length : 0,
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

/** For the renderer: every pack with its global state, the project's override and what the project gets. */
const listing = (state, project, packs) => packs.map((p) => ({
  ...p, on: globalOn(state, p), project: project ? projectValue(project, p.id) : 'inherit', active: packOn(state, project, p),
}));

module.exports = { ID_RE, PROJECT_VALUES, cleanMap, withSkillPacks, loadPacks, globalOn, projectValue, packOn, enabledPacks, pluginDirArgs, setGlobal, setProjectPack, listing };
