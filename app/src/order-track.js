'use strict';
// v3.135 live order tracking and order cost: pure helpers (no Electron, no fs).
// Cost: the app's per-tab usage files hold one session's running totals (Claude Code's status line), not per-turn
// rows, so a task's cost is the DELTA of its session's totals between the first sample after the task started and
// the last sample before it ended (main samples every board tick). A task that moved to another session keeps what
// the earlier one spent (`c`, carried). A remote task costs what its report carries, else it is unknown ("–").
// Progress: each open order becomes one strip item with its progress and the task that matters most right now;
// src/board-view.mjs (`progressLine`) turns an item into the line the HQ views show.

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE_MAX = 32;   // task usage entries kept per order (a fan-out has at most 8 targets)

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
const pair = (x) => (Array.isArray(x) ? [num(x[0]), num(x[1])] : [0, 0]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub0 = (a, b) => [Math.max(0, a[0] - b[0]), Math.max(0, a[1] - b[1])];

/** A stored usage map { [taskId]: { s, b, l, c?, f? } } with anything broken dropped. */
function cleanUsage(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw).slice(-USAGE_MAX)) {
    if (!TASK_ID_RE.test(id) || !isObj(v) || typeof v.s !== 'string' || !SID_RE.test(v.s)) continue;
    out[id] = { s: v.s, b: pair(v.b), l: pair(v.l), ...(Array.isArray(v.c) ? { c: pair(v.c) } : {}), ...(v.f === 1 ? { f: 1 } : {}) };
  }
  return out;
}

/**
 * One sample of a task's session: `sample` is { sid, tokens, usd } (the usage file of the tab the task runs in) or
 * null. `fresh`: the session was started for this task (a desk opened with it), so its totals count from zero.
 * `final`: the task has ended; this sample is its last (the entry is frozen and never moves again).
 */
function observe(entry, sample, { fresh = false, final = false } = {}) {
  if (entry?.f === 1) return entry;
  const now = sample && typeof sample.sid === 'string' && SID_RE.test(sample.sid) ? [num(sample.tokens), num(sample.usd)] : null;
  if (!now) return entry ? (final ? { ...entry, f: 1 } : entry) : null;
  let next;
  if (!entry) next = { s: sample.sid, b: fresh ? [0, 0] : now, l: now };
  else if (entry.s !== sample.sid) next = { s: sample.sid, b: [0, 0], l: now, c: add(entry.c || [0, 0], sub0(entry.l, entry.b)) };   // a new session for the same task
  else next = { ...entry, l: [Math.max(entry.l[0], now[0]), Math.max(entry.l[1], now[1])] };
  return final ? { ...next, f: 1 } : next;
}

/** { tokens, usd } a task's entry accounts for: carried + (last − base). */
function taskCost(entry) {
  if (!isObj(entry)) return { tokens: 0, usd: 0 };
  const [tokens, usd] = add(pair(entry.c), sub0(pair(entry.l), pair(entry.b)));
  return { tokens, usd };
}

/** The cost a remote report carries ({ tokens?, usd? } numbers), else null. */
function reportCost(report) {
  if (!isObj(report)) return null;
  const src = isObj(report.cost) ? report.cost : report;
  const tokens = num(src.tokens); const usd = num(src.usd);
  return tokens || usd ? { tokens, usd } : null;
}

/**
 * An order's cost from its tasks (board.json rows) and its usage map: local tasks by session delta, remote tasks by
 * the cost their report carried. → { tokens, usd, unknown } where `unknown` counts remote tasks with no cost.
 */
function orderCost(tasks, usage = {}) {
  let tokens = 0; let usd = 0; let unknown = 0;
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!isObj(t)) continue;
    if (t.machine && t.machine !== 'self') {
      const c = reportCost(t.cost);
      if (c) { tokens += c.tokens; usd += c.usd; } else unknown++;
      continue;
    }
    const c = taskCost(usage[t.id]);
    tokens += c.tokens; usd += c.usd;
  }
  return { tokens, usd: Math.round(usd * 10000) / 10000, unknown };
}

// task status → the state a progress line names
const STATE_OF = {
  queued: 'queued', waiting: 'queued', delivered: 'working', running: 'working',
  'needs-approval': 'needs', 'awaiting-consent': 'needs', blocked: 'needs',
  reported: 'done', partial: 'done', failed: 'failed', expired: 'failed', lost: 'failed', rejected: 'failed',
};
const PICK = ['needs', 'working', 'queued', 'failed', 'done'];   // the task a line names: the one that needs you first

/**
 * One strip item per open order card (board-model orderCard): `{ id, request, type, done, total, column, targets,
 * current: { state, task, project, machine, member, ahead } | null }`. `waits` is main's hqWaits() (queue places).
 */
function orderStrip(cards, waits = {}) {
  const out = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!isObj(c) || c.kind !== 'order' || c.column === 'done') continue;
    const tasks = Array.isArray(c.tasks) ? c.tasks : [];
    let current = null;
    for (const want of PICK) {
      const list = tasks.filter((t) => (STATE_OF[t.status] || 'queued') === want);
      if (!list.length) continue;
      const t = want === 'done' || want === 'failed' ? list[0] : list[list.length - 1];
      const w = isObj(waits) ? waits[t.id] : null;
      current = { state: want, task: t.id, project: t.project || '', machine: t.machine || 'self', member: t.member || '',
        ahead: want === 'queued' && isObj(w) && num(w.pos) > 1 ? w.pos - 1 : 0 };
      break;
    }
    out.push({ id: c.id, request: c.request, title: c.title || '', type: c.type, column: c.column,
      done: num(c.progress?.done), total: num(c.progress?.total),
      targets: tasks.map((t) => ({ project: t.project || '', machine: t.machine || 'self', ...(t.member ? { member: t.member } : {}), state: STATE_OF[t.status] || 'queued' })),
      current });
  }
  return out;
}

module.exports = { USAGE_MAX, cleanUsage, observe, taskCost, reportCost, orderCost, orderStrip, STATE_OF };
