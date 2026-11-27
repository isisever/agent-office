'use strict';
// v3.133 the HQ tasks held for a project's budget (reason 'budget'), kept in userData/budget-held.json so an app
// restart does not strand the queued rows on the board. Pure helpers (no Electron, no fs): main.js reads the file at
// start, writes it with state-file.js writeAtomic after every change, and releases a project's tasks as soon as its
// budget no longer blocks (Raise, Ignore today, a changed budget, a new day or week).
//
// File shape: { v: 1, held: { [projectId]: [{ qid, args, at }] } }. Capped: MAX_PER_PROJECT tasks per project,
// MAX_TOTAL in all, MAX_ARGS_BYTES per task; past a cap the oldest are dropped and returned so their rows can close.

const MAX_PER_PROJECT = 20;
const MAX_TOTAL = 100;
const MAX_ARGS_BYTES = 64 * 1024;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sizeOf = (v) => { try { return Buffer.byteLength(JSON.stringify(v)); } catch { return Infinity; } };

/** One stored item, cleaned; null when it is not usable. */
function cleanItem(v) {
  if (!isObj(v) || typeof v.qid !== 'string' || !v.qid || v.qid.length > 64 || !isObj(v.args)) return null;
  if (sizeOf(v.args) > MAX_ARGS_BYTES) return null;
  return { qid: v.qid, args: v.args, at: Number.isFinite(v.at) ? v.at : 0 };
}

/**
 * Applies the caps: per project the newest MAX_PER_PROJECT, then in all the newest MAX_TOTAL.
 * @param {Map<string, any[]>} map
 * @returns {{ held: Map<string, any[]>, dropped: any[] }}
 */
function cap(map) {
  const dropped = [];
  /** @type {{ id: string, item: any }[]} */
  let all = [];
  for (const [id, items] of map) {
    const keep = items.slice(-MAX_PER_PROJECT);
    dropped.push(...items.slice(0, items.length - keep.length));
    for (const item of keep) all.push({ id, item });
  }
  if (all.length > MAX_TOTAL) {
    all.sort((a, b) => a.item.at - b.item.at);
    dropped.push(...all.slice(0, all.length - MAX_TOTAL).map((x) => x.item));
    all = all.slice(all.length - MAX_TOTAL);
  }
  const held = new Map();
  for (const { id, item } of all) held.set(id, [...(held.get(id) || []), item]);
  for (const items of held.values()) items.sort((a, b) => a.at - b.at);
  return { held, dropped };
}

/** The held tasks from the file's parsed contents (anything malformed is skipped). */
function fromJson(raw) {
  const map = new Map();
  const src = isObj(raw) && isObj(raw.held) ? raw.held : {};
  for (const [id, list] of Object.entries(src)) {
    if (!id || !Array.isArray(list)) continue;
    const items = list.map(cleanItem).filter(Boolean);
    if (items.length) map.set(id, items);
  }
  return cap(map).held;
}

/** The file's contents for the held tasks. */
function toJson(map) {
  /** @type {Record<string, any[]>} */
  const held = {};
  for (const [id, items] of map) if (items.length) held[id] = items;
  return { v: 1, held };
}

/**
 * Adds a held task for the project. Returns the new map and the tasks the caps pushed out.
 * @param {Map<string, any[]>} map
 * @param {string} id
 * @param {{ qid: string, args: any }} item
 * @param {number} [now]
 */
function add(map, id, item, now = Date.now()) {
  const clean = cleanItem({ ...item, at: now });
  if (!clean) return { held: map, dropped: [{ qid: item?.qid, args: item?.args }] };
  const next = new Map(map);
  next.set(id, [...(next.get(id) || []), clean]);
  return cap(next);
}

/** Takes the project's held tasks out: { held, taken }. */
function take(map, id) {
  const taken = map.get(id) || [];
  if (!taken.length) return { held: map, taken };
  const held = new Map(map);
  held.delete(id);
  return { held, taken };
}

/** True when the project holds tasks and its budget state no longer blocks. */
const releasable = (map, id, state) => (map.get(id) || []).length > 0 && state?.blocked !== true;

/** True when the board row is still waiting for the budget (not removed or closed by hand meanwhile). */
const stillHeld = (board, qid) => Array.isArray(board?.tasks)
  && board.tasks.some((t) => t && t.id === qid && t.status === 'queued' && t.reason === 'budget');

module.exports = { MAX_PER_PROJECT, MAX_TOTAL, MAX_ARGS_BYTES, fromJson, toJson, add, take, releasable, stillHeld };
