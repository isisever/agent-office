// Projects waiting for you and quota thresholds: pure functions (no Electron; tested with node --test).
//
// A project waits in two ways (contract v2.6):
// - 'permission': its session has an open permission prompt (the plugin's stats.waiting).
// - 'done': the manager was working, its turn ended with none of its agents still running, and the user hasn't
//   looked at that project yet. A turn that ends while background agents run is the boss waiting for its agents,
//   not for the user: the project stays busy until the boss is idle and no agent of it runs.
// Looking = the window is focused and the project is active. A looked-at project gets no notification, and 'done' clears.
//
// Tabs (contract v3.0): all of a project's tabs (same folder or git worktree) are that project.
// Sessions of tabs in the same folder already carry the project name; worktree sessions carry the folder name
// (`<repo>-wt-<n>`) and join their project via aliases { session name: project name }: if one is busy the project
// is busy, and the oldest open approval prompt is the project's approval. readOffice already merges with the same map;
// it is merged here too so that data read without the map is also counted correctly.

/**
  * prev: { busy: Map<id, boolean>, waits: Map<id, string>, done: Set<id> } (empty on the first call)
  * projects: state.projects; office: readOffice(...).projects (by name); seenId: the looked-at project or null
 * → { state, attention: Map<id, 'permission' | 'done'>, events: [{ kind, id, tool? }] }
 */
function nextAttention(prev, projects, office, seenId, aliases = null) {
  const byName = mergeAliases(office, aliases);
  const state = { busy: new Map(), waits: new Map(), done: new Set() };
  const attention = new Map();
  const events = [];
  for (const proj of projects) {
    const p = byName.get(proj.name);
    const isSeen = proj.id === seenId;
    // busy = the boss works or any of its agents (running subagents) still does
    const busy = Boolean(p?.isBossBusy) || (p?.working || 0) > 0;
    const wait = p?.waiting ? `${p.waiting.tool}@${p.waiting.since}` : '';
    const wasBusy = prev.busy.get(proj.id);
    const prevWait = prev.waits.get(proj.id);
    let done = prev.done.has(proj.id) && !busy && !isSeen;
    // the first read (no previous state) produces no notifications
    if (wait && prevWait !== undefined && wait !== prevWait && !isSeen) events.push({ kind: 'permission', id: proj.id, tool: p.waiting.tool });
    if (wasBusy && !busy && !wait && !isSeen) {
      done = true;
      events.push({ kind: 'done', id: proj.id });
    }
    if (p) {
      state.busy.set(proj.id, busy);
      state.waits.set(proj.id, wait);
    }
    if (done) state.done.add(proj.id);
    if (wait) attention.set(proj.id, 'permission');
    else if (done) attention.set(proj.id, 'done');
  }
  return { state, attention, events };
}

/** office (readOffice().projects) → Map<project name, entry>; entries of aliased names merge into their project's. */
function mergeAliases(office, aliases) {
  const byName = new Map();
  for (const p of office || []) {
    const name = aliases?.[p.name] ?? p.name;
    const old = byName.get(name);
    if (!old) { byName.set(name, { ...p, name }); continue; }
    const waits = [old.waiting, p.waiting].filter(Boolean).sort((a, b) => a.since - b.since);
    byName.set(name, {
      ...old,
      working: (old.working || 0) + (p.working || 0),
      delivered: (old.delivered || 0) + (p.delivered || 0),
      isBossBusy: Boolean(old.isBossBusy || p.isBossBusy),
      waiting: waits[0] || null,
    });
  }
  return byName;
}

const emptyAttention = () => ({ busy: new Map(), waits: new Map(), done: new Set() });

// Quota warning thresholds (percent); the highest one is announced once.
const LEVELS = [95, 80];
const WINDOWS = ['fiveHour', 'sevenDay'];
const levelOf = (pct) => LEVELS.find((l) => pct >= l) || 0;

/**
  * usage: AccountUsage; alerted: Map<"<account>:<window>:<resetsAt>", level> (updated in place)
  * seed: if true, only marks (no warnings for old values at startup)
 * → [{ window, pct, level, resetsAt }]
 */
function usageAlerts(accountId, usage, alerted, { seed = false, now = Date.now() } = {}) {
  const out = [];
  for (const win of WINDOWS) {
    const w = usage?.[win];
    if (!w || !Number.isFinite(w.pct) || (w.resetsAt != null && w.resetsAt <= now)) continue;
    const level = levelOf(w.pct);
    if (!level) continue;
    const key = `${accountId}:${win}:${w.resetsAt ?? ''}`;
    if (level <= (alerted.get(key) || 0)) continue;
    alerted.set(key, level);
    if (!seed) out.push({ window: win, pct: Math.round(w.pct), level, resetsAt: w.resetsAt });
  }
  return out;
}

module.exports = { nextAttention, mergeAliases, emptyAttention, usageAlerts, LEVELS };
