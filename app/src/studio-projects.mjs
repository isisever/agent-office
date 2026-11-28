// Studio experience (contract v3.150): the pure parts of the flat Projects list. renderer/studio.js draws what these return.
// One row per project (no nesting), group headings are plain labels (studio-order.mjs), a project's sessions show only
// while it is expanded, and the owning account is a small muted tag instead of a level.

/**
 * Should rows show an account tag? Only when the projects belong to more than one account; with a single account the
 * tag would repeat on every row and add noise.
 * @param {{ account?: string }[]} groups
 */
export function showAccountTags(groups) {
  const seen = new Set();
  for (const g of Array.isArray(groups) ? groups : []) if (g && g.account) seen.add(g.account);
  return seen.size > 1;
}

/**
 * The view of one project row: whether its sessions are listed, how many sessions it has, and whether any is running.
 * While a filter is typed every project with matches is expanded so the matching sessions are visible.
 * @param {{ id: string, running?: any[], recent?: any[], attention?: string | null }} g a studioGroups() entry
 * @param {{ closed?: Set<string>, query?: string }} [o]
 * @returns {{ expanded: boolean, expandable: boolean, count: number, live: boolean, busy: boolean }}
 */
export function projectRowView(g, { closed = new Set(), query = '' } = {}) {
  const running = Array.isArray(g.running) ? g.running : [];
  const recent = Array.isArray(g.recent) ? g.recent : [];
  const count = running.length + recent.length;
  const expandable = count > 0;
  const expanded = expandable && (Boolean(String(query).trim()) || !closed.has(g.id));
  return {
    expanded, expandable, count,
    live: running.some((s) => s && s.isRunning),
    busy: running.some((s) => s && (s.busy || s.waiting)),
  };
}

/**
 * Keyboard rule of the filter box: Esc with text clears it (and is consumed); Esc on an empty box is left alone.
 * @param {string} key @param {string} value
 * @returns {boolean} true when the box should be cleared
 */
export function escClearsFilter(key, value) {
  return key === 'Escape' && String(value ?? '') !== '';
}

/**
 * v3.162 What clicking a project's name opens: its first session. A running or asleep tab first (the list's first row),
 * else the most recent saved/transcript session (reopened in a new tab), else nothing (the project is only selected).
 * @param {{ running?: { n: number }[], recent?: { sessionId: string }[] }} g a studioGroups() entry
 * @returns {{ n: number } | { sessionId: string } | null}
 */
export function projectClickTarget(g) {
  const running = Array.isArray(g?.running) ? g.running : [];
  if (running.length && Number.isInteger(running[0]?.n)) return { n: running[0].n };
  const recent = Array.isArray(g?.recent) ? g.recent : [];
  if (recent.length && typeof recent[0]?.sessionId === 'string' && recent[0].sessionId) return { sessionId: recent[0].sessionId };
  return null;
}
