'use strict';
// v3.120 Studio UX: the models an account can use, as Claude Code reports them. Pure (no Electron, no fs).
//
// Claude Code answers the stream-json `initialize` control request with `models`: [{ value, resolvedModel,
// displayName, description, ... }]. `value` 'default' is the account's default (set_model with no model); every
// other value is what set_model takes. The picker lists exactly those. A session that reports nothing (an older
// claude, an error reply) falls back to FALLBACK, the short aliases every account knows.
// The start screen, where no session runs yet, uses a per-account cache (main keeps it in userData, never in
// ~/.claude), filled by the first session of that account that reports its models or by a short probe.

const MAX_MODELS = 60;
const MAX_ACCOUNTS = 100;
const VALUE_RE = /^[A-Za-z0-9][\w.:@/[\]-]{0,99}$/;

/** @typedef {{ value: string, label: string, description: string, resolved: string }} ModelOption */

/** What a session that reports nothing may pick: the start's model and the short aliases ('' label: the app's own name). */
const FALLBACK = Object.freeze(['', 'opus', 'sonnet', 'haiku'].map((value) => Object.freeze({ value, label: '', description: '', resolved: '' })));

const str = (v, max) => (typeof v === 'string' ? [...v].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').trim().slice(0, max) : '');

/**
 * The picker options from claude's initialize answer (the control_response's inner `response`, or its `models`
 * array). 'default' becomes '' (set_model with no model) and comes first; bad or repeated entries are skipped.
 * @param {any} response @returns {ModelOption[]} [] when it lists none
 */
function parseModels(response) {
  const list = Array.isArray(response) ? response : Array.isArray(response?.models) ? response.models : [];
  /** @type {ModelOption[]} */
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.value !== 'string') continue;
    const value = m.value === 'default' ? '' : m.value;
    if (value && !VALUE_RE.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const opt = { value, label: str(m.displayName, 80) || value, description: str(m.description, 200), resolved: str(m.resolvedModel, 100) };
    if (value) out.push(opt); else out.unshift(opt);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** The options a picker shows: the reported list, or FALLBACK when there is none. @param {ModelOption[] | null | undefined} reported */
const pickerModels = (reported) => (Array.isArray(reported) && reported.length ? reported : FALLBACK);

/** May the picker (and chat:setting) set this model? Checked against the session's reported list, else FALLBACK. */
const allowedModel = (reported, value) => typeof value === 'string' && pickerModels(reported).some((m) => m.value === value);

/** The values set_model may take for these options (gui-session settingLine's allow list). */
const modelValues = (reported) => pickerModels(reported).map((m) => m.value);

/** Two lists name the same models in the same order with the same labels. */
const sameModels = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((m, i) => m.value === b[i].value && m.label === b[i].label && m.description === b[i].description && m.resolved === b[i].resolved);

/** The account's cache key: its config dir, '' for the Default account (~/.claude). */
const accountKey = (configDir) => (typeof configDir === 'string' ? configDir : '');

/**
 * The cache after a session (or a probe) of `key`'s account reported `models` → { cache, changed }. Nothing
 * changes for an empty list (a failed report never wipes a good one) or the same list; the oldest account goes
 * past MAX_ACCOUNTS. Never mutates `cache`.
 * @param {any} cache { [key]: { models: ModelOption[], at: number } } @param {string} key @param {ModelOption[]} models
 */
function mergeCache(cache, key, models, now = Date.now()) {
  const base = cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
  if (!Array.isArray(models) || !models.length) return { cache: base, changed: false };
  if (sameModels(base[key]?.models, models)) return { cache: base, changed: false };
  const next = { ...base, [key]: { ...(base[key] && typeof base[key] === 'object' ? base[key] : {}), models: models.slice(0, MAX_MODELS), at: now } };
  const keys = Object.keys(next);
  if (keys.length > MAX_ACCOUNTS) {
    keys.sort((x, y) => (Number(next[x]?.at) || 0) - (Number(next[y]?.at) || 0));
    for (const k of keys.slice(0, keys.length - MAX_ACCOUNTS)) if (k !== key) delete next[k];
  }
  return { cache: next, changed: true };
}

/** The cached list for an account (re-checked, since the file is on disk), or null when none is cached. */
function cachedModels(cache, key) {
  const e = cache && typeof cache === 'object' ? cache[key] : null;
  const models = e && Array.isArray(e.models) ? parseModels(e.models.map((m) => ({ ...m, value: m?.value === '' ? 'default' : m?.value, displayName: m?.label, resolvedModel: m?.resolved }))) : [];
  return models.length ? models : null;
}

/**
 * What the start screen shows for an account: the cached list, or only the default option with `loading` while a
 * probe runs (`probing`), or FALLBACK when there is no cache and no probe (it failed).
 */
function startModels(cache, key, probing) {
  const c = cachedModels(cache, key);
  if (c) return { models: c, loading: false };
  if (probing) return { models: [FALLBACK[0]], loading: true };
  return { models: FALLBACK, loading: false };
}

/** The initialize control request (stream-json); it sends no prompt. */
const initLine = (requestId) => `${JSON.stringify({ type: 'control_request', request_id: String(requestId), request: { subtype: 'initialize' } })}\n`;


// v3.120 Studio UX: the permission modes an account's claude takes. initialize does not list them (checked on
// 2.1.332); a set_permission_mode with an unknown value answers "Cannot set permission mode: must be one of acceptEdits,
// auto, bypassPermissions, default, dontAsk, plan". Only the model probe (a throwaway session) sends it, never a real one.
const MODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_MODES = 20;
/** What a session may pick when its account reported no list: the old list plus auto. */
const FALLBACK_MODES = Object.freeze(['auto', 'default', 'acceptEdits', 'plan']);
/** The pickers' order; a reported mode not named here follows in the reported order. */
const MODE_ORDER = ['auto', 'default', 'acceptEdits', 'plan'];
/** Never offered: it only shows (locked) the mode of a session started with skip permissions. */
const LOCKED_MODE = 'bypassPermissions';
const PROBE_MODE = '__ao_probe__';

/**
 * The modes claude reports → string[] ([] when none): an array (an initialize field, if a claude ever lists them) or
 * the error text of a set_permission_mode with an unknown value. Bad or repeated names are skipped.
 * @param {any} src
 */
function parseModes(src) {
  let list = [];
  if (Array.isArray(src)) list = src;
  else if (typeof src === 'string') {
    const m = /must be one of\s*:?\s*(.+)$/i.exec(src.trim());
    list = m ? m[1].replace(/[.\s]+$/, '').split(/\s*,\s*|\s+or\s+/) : [];
  }
  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    const name = typeof v === 'string' ? v.trim().replace(/^['"`]|['"`]$/g, '') : '';
    if (MODE_RE.test(name) && name !== PROBE_MODE && !out.includes(name)) out.push(name);
    if (out.length >= MAX_MODES) break;
  }
  return out;
}

/** The modes a picker offers: the reported list (or FALLBACK_MODES) without bypassPermissions, in MODE_ORDER first. */
function pickerModes(reported) {
  const list = Array.isArray(reported) && reported.length ? reported : FALLBACK_MODES;
  const shown = list.filter((m) => typeof m === 'string' && m !== LOCKED_MODE);
  const rank = (/** @type {string} */ m) => (MODE_ORDER.includes(m) ? MODE_ORDER.indexOf(m) : MODE_ORDER.length);
  return shown.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

/** May the picker (and chat:setting) set this mode? Against the account's reported list, else FALLBACK_MODES. */
const allowedMode = (reported, value) => typeof value === 'string' && pickerModes(reported).includes(value);

/** The account's modes after a probe reported `modes` → { cache, changed }; an empty list never wipes a good one. */
function mergeModes(cache, key, modes, now = Date.now()) {
  const base = cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
  const clean = parseModes(modes);
  if (!clean.length) return { cache: base, changed: false };
  const old = base[key] && typeof base[key] === 'object' ? base[key] : {};
  if (Array.isArray(old.modes) && old.modes.join(',') === clean.join(',')) return { cache: base, changed: false };
  return { cache: { ...base, [key]: { ...old, modes: clean, at: Number(old.at) || now } }, changed: true };
}

/** The cached modes of an account (re-checked), or null when none are cached. */
function cachedModes(cache, key) {
  const e = cache && typeof cache === 'object' ? cache[key] : null;
  const modes = e && Array.isArray(e.modes) ? parseModes(e.modes) : [];
  return modes.length ? modes : null;
}

/** The probe's second request: set_permission_mode with a value no claude takes, so its error lists the modes. */
const modeProbeLine = (requestId) => `${JSON.stringify({ type: 'control_request', request_id: String(requestId), request: { subtype: 'set_permission_mode', mode: PROBE_MODE } })}\n`;

module.exports = { FALLBACK, parseModels, pickerModels, allowedModel, modelValues, sameModels, accountKey, mergeCache, cachedModels, startModels, initLine, MAX_MODELS, MAX_ACCOUNTS,
  FALLBACK_MODES, LOCKED_MODE, parseModes, pickerModes, allowedMode, mergeModes, cachedModes, modeProbeLine };
