// Studio experience (contract v3.120): the pure parts of Studio's sidebar and its ⌘K command palette, so they can be
// tested without a window. renderer/studio.js draws what these return.

import { cleanGroup } from './project-groups.mjs';

const PALETTE_MAX = 60;   // rows the palette shows at most

const lower = (/** @type {unknown} */ s) => String(s ?? '').toLocaleLowerCase();
const byName = (/** @type {any} */ a, /** @type {any} */ b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id));

/**
 * The sidebar's project groups: every project (by name), its Running sessions (by tab number, main tab first) and its
 * Recent ones (newest first). With a search, a project whose name matches keeps all its sessions; otherwise only the
 * matching sessions stay, and a project with none left is dropped.
 * @param {any[]} projects StudioProject[] from studio:sessions
 * @param {{ query?: string, currentId?: string, ordered?: boolean }} [o] currentId: the project ⌘1…9 and ⌘N act on; ordered (v3.142): keep the given (Office) order instead of sorting by name
 * @returns {{ id: string, name: string, group: string, account: string, active: boolean, current: boolean, attention: string | null, running: any[], recent: any[] }[]}
 */
export function studioGroups(projects, { query = '', currentId = '', ordered = false } = {}) {
  const q = lower(query).trim();
  const has = (/** @type {unknown} */ s) => !q || lower(s).includes(q);
  const out = [];
  for (const p of (Array.isArray(projects) ? projects : []).filter((x) => x && typeof x.id === 'string').slice().sort(ordered ? () => 0 : byName)) {
    const all = has(p.name);
    const running = (Array.isArray(p.running) ? p.running : []).slice().sort((a, b) => a.n - b.n).filter((s) => all || has(s.title));
    const recent = (Array.isArray(p.recent) ? p.recent : []).slice().sort((a, b) => b.at - a.at).filter((r) => all || has(r.title));
    if (q && !all && !running.length && !recent.length) continue;
    out.push({
      id: p.id, name: String(p.name || ''), group: cleanGroup(p.group), account: typeof p.account === 'string' ? p.account : '',
      active: p.active === true, current: p.id === currentId, attention: p.attention || null, running, recent,
    });
  }
  return out;
}

/**
 * The project ⌘1…9 and ⌘N act on: the active project, else (HQ or nothing is active) the one the person last picked
 * in the sidebar, else the first by name.
 * @param {any[]} projects @param {string} [picked]
 */
export function currentProjectId(projects, picked = '') {
  const list = Array.isArray(projects) ? projects : [];
  return (list.find((p) => p.active) || list.find((p) => p.id === picked) || list.slice().sort(byName)[0] || { id: '' }).id;
}

/**
 * The palette's rows for a query: every word of the query must be in the row's label or keywords. A label that starts
 * with the query comes first, then one with a word starting with it, then the rest; ties keep their order (commands,
 * then sessions, then projects, as given). An empty query lists everything in order.
 * @template {{ label: string, keywords?: string }} T
 * @param {T[]} items @param {string} query
 * @returns {T[]}
 */
export function filterPalette(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = lower(query).trim();
  if (!q) return list.slice(0, PALETTE_MAX);
  const words = q.split(/\s+/);
  const scored = [];
  list.forEach((it, i) => {
    const label = lower(it.label);
    const hay = `${label} ${lower(it.keywords)}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = label.startsWith(q) ? 0 : label.split(/[\s·:/-]+/).some((w) => w.startsWith(words[0])) ? 1 : 2;
    scored.push({ it, i, score });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).slice(0, PALETTE_MAX).map((x) => x.it);
}

/**
 * v3.140 The collapsed set after a session was added to or opened in project `id`: that project is expanded, so a new
 * session never hides its siblings (the old session stays listed and clickable). Returns the same Set.
 * @param {Set<string>} closed @param {string} id
 */
export function expandProject(closed, id) {
  closed.delete(id);
  return closed;
}

/**
 * v3.140 Row names for a project's sessions: a session's own title when it has one; sessions without a title (no
 * message yet) are numbered by their tab ("New session 2") once more than one of them is listed, so they can be told
 * apart. A single untitled session keeps the plain fallback.
 * @param {{ n: number, title?: string }[]} sessions @param {string} untitled the localized fallback ("New session")
 * @returns {string[]} one name per session, in the given order
 */
export function sessionNames(sessions, untitled) {
  const list = Array.isArray(sessions) ? sessions : [];
  const blank = list.filter((s) => !s.title).length;
  return list.map((s) => s.title || (blank > 1 ? `${untitled} ${s.n}` : untitled));
}

/**
 * v3.140 May a session row show a close button? Same rule as the Office's tab ×: an extra tab can be closed, a
 * project's main tab (n 1) never. The confirmation (also for a busy session) is the Office's own tabs:close dialog.
 * @param {{ n: number } | null | undefined} s
 */
export function canCloseSession(s) {
  return Boolean(s) && Number.isInteger(s.n) && s.n !== 1;
}
