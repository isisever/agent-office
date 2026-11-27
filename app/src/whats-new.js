// What's new (contract v3.123): one manifest per version in app/whats-new/<version>.json, shown once after an
// update as a short step-through quickstart. Pure helpers (version order, what to show, manifest validation) plus
// two small file readers; main.js, scripts/check-whats-new.mjs and the tests use them.
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'tr'];
const EXPERIENCES = ['office', 'studio', 'both'];
// "Try it" may only run one of these; each maps to an existing handler in the renderer (renderer/app.js whatsNewActions)
// v3.123 (with v3.122): open-studio-settings is Studio's Settings page, open-start-screen a new Studio session's start
// screen; spotlight only points at the item's target (it needs one)
const ACTIONS = ['spotlight', 'open-studio', 'open-office', 'open-settings', 'open-studio-settings', 'open-palette', 'open-start-screen', 'open-devices', 'open-team', 'open-team-page', 'open-board', 'focus-composer'];
// open-settings:<section>: the Settings popup, then the row marked data-settings-section="<section>"
const SETTINGS_SECTIONS = ['experience', 'keep-awake', 'language', 'about'];
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** @param {string} v */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').replace(/^v/, ''));
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/**
 * Semver order: -1, 0 or 1. A prerelease sorts before its release (0.23.0-beta.1 < 0.23.0); an unparsable version
 * sorts before every valid one.
 * @param {string} a @param {string} b
 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The versions after `after` up to and including `upTo`, newest first.
 * @param {string} after @param {string} upTo @param {string[]} available
 */
function versionsBetween(after, upTo, available) {
  return available.filter((v) => parseVersion(v) && compareVersions(v, after) > 0 && compareVersions(v, upTo) <= 0)
    .sort((a, b) => compareVersions(b, a));
}

/**
 * What to show at start and what to remember.
 * - fresh install (no state.json yet): nothing; lastSeenVersion is set silently (first-run onboarding covers it)
 * - dev run (not packaged): nothing and nothing stored, unless `force` (AGENT_OFFICE_WHATS_NEW=1)
 * - an update: every manifest after lastSeenVersion up to the running version, newest first
 * - a state.json from before this feature (no lastSeenVersion): every manifest up to the running version, newest
 *   first (the first manifest is 0.22.44, so an update from it to 0.22.45 shows both)
 * - force with nothing pending: the newest manifest up to the running version (for trying the dialog)
 * `save` is the new lastSeenVersion, or null to leave it as it is (dev runs never write it; a downgrade keeps it).
 * @param {{ lastSeen?: unknown, current: string, fresh: boolean, packaged: boolean, force?: boolean, available: string[] }} o
 * @returns {{ show: string[], save: string | null }}
 */
function decide({ lastSeen, current, fresh, packaged, force = false, available }) {
  const seen = typeof lastSeen === 'string' && parseVersion(lastSeen) ? lastSeen : null;
  let show = [];
  let save = null;
  if (fresh && !seen) save = current;
  else if (!seen) { show = versionsBetween('0.0.0-0', current, available); save = current; }
  else if (compareVersions(current, seen) > 0) { show = versionsBetween(seen, current, available); save = current; }
  if (!packaged) { save = null; if (!force) show = []; }
  if (force && !show.length) show = versionsBetween('0.0.0-0', current, available).slice(0, 1);
  return { show, save };
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';
/** @param {unknown} v @param {string} where @param {string[]} errors */
function checkLangs(v, where, errors) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${where}: must be an object with ${LANGS.join(' and ')}`); return; }
  for (const l of LANGS) if (!isText(/** @type {any} */ (v)[l])) errors.push(`${where}.${l}: missing or empty`);
}

/**
 * Validate one action id: a known action, `open-settings:<section>` with a known section.
 * @param {unknown} action
 */
function isKnownAction(action) {
  if (typeof action !== 'string') return false;
  const [id, arg, ...rest] = action.split(':');
  if (rest.length || !ACTIONS.includes(id)) return false;
  if (id === 'open-settings') return arg === undefined || SETTINGS_SECTIONS.includes(arg);
  return arg === undefined;
}

/**
 * A manifest's problems (empty list: valid). `version` is the file's version; a "version" field, when present, must match it.
 * @param {unknown} m @param {string} [version]
 * @returns {string[]}
 */
function validateManifest(m, version) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the file must hold a JSON object with "items"'];
  const doc = /** @type {any} */ (m);
  if (version !== undefined && doc.version !== undefined && doc.version !== version) errors.push(`version: "${doc.version}" does not match the file name (${version})`);
  if (!Array.isArray(doc.items) || !doc.items.length) return [...errors, 'items: must be a non-empty list'];
  const ids = new Set();
  doc.items.forEach((/** @type {any} */ it, /** @type {number} */ i) => {
    const at = `items[${i}]`;
    if (!it || typeof it !== 'object' || Array.isArray(it)) { errors.push(`${at}: must be an object`); return; }
    if (typeof it.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(it.id)) errors.push(`${at}.id: lowercase letters, digits and dashes`);
    else if (ids.has(it.id)) errors.push(`${at}.id: "${it.id}" is used twice`);
    else ids.add(it.id);
    checkLangs(it.title, `${at}.title`, errors);
    checkLangs(it.body, `${at}.body`, errors);
    if (it.experience !== undefined && !EXPERIENCES.includes(it.experience)) errors.push(`${at}.experience: one of ${EXPERIENCES.join(', ')}`);
    if (it.target !== undefined && (!isText(it.target) || /[<>{}]/.test(it.target))) errors.push(`${at}.target: a CSS selector`);
    if (it.try !== undefined) {
      if (!it.try || typeof it.try !== 'object') errors.push(`${at}.try: must be an object with label and action`);
      else {
        checkLangs(it.try.label, `${at}.try.label`, errors);
        if (it.try.action === 'spotlight' && it.target === undefined) errors.push(`${at}.try.action: spotlight needs a target`);
        if (!isKnownAction(it.try.action)) errors.push(`${at}.try.action: "${it.try.action}" is not one of ${ACTIONS.join(', ')} (open-settings:${SETTINGS_SECTIONS.join('|')})`);
      }
    }
  });
  return errors;
}

/** The versions with a manifest file in `dir` (unsorted). @param {string} dir */
function listVersions(dir, fsx = fs) {
  try { return fsx.readdirSync(dir).filter((f) => f.endsWith('.json') && VERSION_RE.test(f.slice(0, -5))).map((f) => f.slice(0, -5)); } catch { return []; }
}

/**
 * One manifest read and validated: { manifest, errors }; manifest is null when it is missing, unreadable or invalid.
 * @param {string} dir @param {string} version
 */
function readManifest(dir, version, fsx = fs) {
  let text;
  try { text = fsx.readFileSync(path.join(dir, `${version}.json`), 'utf8'); } catch { return { manifest: null, errors: [`${version}.json: not found`] }; }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { manifest: null, errors: [`${version}.json: not valid JSON (${/** @type {Error} */ (e).message})`] }; }
  const errors = validateManifest(doc, version);
  return { manifest: errors.length ? null : doc, errors };
}

/**
 * The renderer's entries for these versions: [{ version, items }], invalid or missing files left out.
 * @param {string} dir @param {string[]} versions
 */
function entriesFor(dir, versions, fsx = fs) {
  return versions.map((v) => ({ version: v, manifest: readManifest(dir, v, fsx).manifest }))
    .filter((e) => e.manifest).map((e) => ({ version: e.version, items: e.manifest.items }));
}

module.exports = {
  LANGS, EXPERIENCES, ACTIONS, SETTINGS_SECTIONS,
  parseVersion, compareVersions, versionsBetween, decide, isKnownAction, validateManifest,
  listVersions, readManifest, entriesFor,
};
