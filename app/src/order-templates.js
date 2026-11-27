'use strict';
// v3.134 Order templates: stored HQ order texts the person can put into HQ's composer and send themselves.
// Pure rules (validation, caps, save, remove); main.js keeps the list in state.json (saved atomically) and owns the IPC.
// A template never sends anything and never carries authority: only the person's own send of the filled composer does.

const MAX_TEMPLATES = 50;
const NAME_MAX = 80;
const TEXT_MAX = 4000;
const TARGETS_MAX = 10;
const TARGET_MAX = 80;
const TYPES = ['bugfix', 'hotfix', 'feature'];
const ID_RE = /^tp[0-9a-f]{8}$/;

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
// control characters other than tab and newline are dropped (no terminal escapes reach the HQ terminal on fill)
// eslint-disable-next-line no-control-regex
const clean = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/g, '');
const oneLine = (s) => clean(s).replace(/\s+/g, ' ').trim();

/** The targets list: an array of short project names (or one comma-separated string) → at most TARGETS_MAX, unique. */
function normalizeTargets(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const v = oneLine(x).slice(0, TARGET_MAX);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= TARGETS_MAX) break;
  }
  return out;
}

/**
 * A template from untrusted input → { id, name, text, type, targets? } or null (invalid).
 * name: 1..NAME_MAX after trimming; text: 1..TEXT_MAX (longer is refused, not cut); type: one of TYPES.
 * `id` must be a known template id or empty (then newId() mints one).
 * @param {any} raw @param {{ newId?: () => string }} [opts]
 */
function normalizeTemplate(raw, { newId } = {}) {
  if (!isObj(raw)) return null;
  if (typeof raw.name !== 'string' || typeof raw.text !== 'string' || typeof raw.type !== 'string') return null;
  const name = oneLine(raw.name);
  const text = clean(raw.text).trim();
  const type = raw.type.trim().toLowerCase();
  if (!name || name.length > NAME_MAX || !text || text.length > TEXT_MAX || !TYPES.includes(type)) return null;
  let id = typeof raw.id === 'string' ? raw.id : '';
  if (id && !ID_RE.test(id)) return null;
  if (!id) { if (typeof newId !== 'function') return null; id = newId(); }
  const targets = normalizeTargets(raw.targets);
  return { id, name, text, type, ...(targets.length ? { targets } : {}) };
}

/** A stored list (state.json, may be edited by hand) → valid templates only, unique ids, at most MAX_TEMPLATES. */
function normalizeList(raw) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(raw) ? raw : []) {
    const t = isObj(x) && typeof x.id === 'string' && x.id ? normalizeTemplate(x) : null;
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

/** Saves `raw` into `list` (new or an update of a known id) → { ok, list, id } or { ok: false, reason }. */
function save(list, raw, { newId }) {
  const cur = normalizeList(list);
  if (!isObj(raw)) return { ok: false, reason: 'invalid' };
  const known = typeof raw.id === 'string' && raw.id ? cur.find((x) => x.id === raw.id) : null;
  if (raw.id && !known) return { ok: false, reason: 'unknown' };
  if (!known && cur.length >= MAX_TEMPLATES) return { ok: false, reason: 'too-many' };
  const t = normalizeTemplate({ ...raw, id: known ? known.id : '' }, { newId });
  if (!t) return { ok: false, reason: 'invalid' };
  return { ok: true, id: t.id, list: known ? cur.map((x) => (x.id === t.id ? t : x)) : [...cur, t] };
}

/** Removes template `id` → { ok, list } or { ok: false, reason: 'unknown' }. */
function remove(list, id) {
  const cur = normalizeList(list);
  if (typeof id !== 'string' || !cur.some((x) => x.id === id)) return { ok: false, reason: 'unknown' };
  return { ok: true, list: cur.filter((x) => x.id !== id) };
}

module.exports = { MAX_TEMPLATES, NAME_MAX, TEXT_MAX, TARGETS_MAX, TARGET_MAX, TYPES, ID_RE, normalizeTargets, normalizeTemplate, normalizeList, save, remove };
