'use strict';
// Studio experience (contract v3.120): the pure parts main.js uses. The experience setting, the session list the
// Studio sidebar shows (running and recent sessions per project), the recent list kept in state.json, the 24 h rule
// for sessions that sleep too long, and the Claude account's display name for the start screen.

const EXPERIENCES = ['office', 'studio'];
const ASLEEP_CLOSE_MS = 24 * 60 * 60 * 1000;   // a Studio session asleep longer than this closes (it stays in Recent)
const RECENT_MAX = 50;                          // recent sessions kept in state.json, all projects together
const RECENT_PER_PROJECT = 10;                  // recent sessions listed per project
const MAIN_TAB = 1;                             // a project's main tab (src/projects.js); its pty id is the project id
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/** 'studio' or 'office'; anything else (unset, a typo, an older state.json) is the Office. */
function normalizeExperience(v) {
  return v === 'studio' ? 'studio' : 'office';
}

/** A Claude Code session id as claude writes it, or ''. */
const validSessionId = (v) => (typeof v === 'string' && SID_RE.test(v) ? v : '');

/**
 * The recent list as kept in state.json: entries of projects that still exist, a valid session id, each session once
 * (the first one wins, so a newer entry put in front replaces an older one), newest first, at most RECENT_MAX.
 * @param {unknown} raw
 * @param {Iterable<string>} projectIds
 * @returns {{ projectId: string, sessionId: string, title: string, dir: string, at: number }[]}
 */
function normalizeRecent(raw, projectIds) {
  const known = new Set(projectIds);
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.projectId !== 'string' || !known.has(r.projectId)) continue;
    const sessionId = validSessionId(r.sessionId);
    if (!sessionId || !Number.isFinite(r.at)) continue;
    const key = `${r.projectId}\n${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      projectId: r.projectId, sessionId,
      title: typeof r.title === 'string' ? r.title.slice(0, 200) : '',
      dir: typeof r.dir === 'string' ? r.dir.slice(0, 4096) : '',
      at: r.at,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, RECENT_MAX);
}

/** The recent list with this entry in front (it replaces the same session's older entry). */
function addRecent(list, entry, projectIds) {
  return normalizeRecent([entry, ...(Array.isArray(list) ? list : [])], projectIds);
}

/** The recent list without one session (it was opened again: it is running now). */
function dropRecent(list, projectId, sessionId) {
  return (Array.isArray(list) ? list : []).filter((r) => !(r.projectId === projectId && r.sessionId === sessionId));
}

/**
 * Keeps `since` (pty id → when it was first seen asleep) in step with the sessions asleep now: a newly asleep one
 * starts at `now`, one that woke up or closed is dropped. Mutates and returns `since`.
 * @param {Map<string, number>} since
 * @param {Iterable<string>} asleepIds
 * @param {number} now
 */
function trackAsleep(since, asleepIds, now) {
  const ids = new Set(asleepIds);
  for (const id of [...since.keys()]) if (!ids.has(id)) since.delete(id);
  for (const id of ids) if (!since.has(id)) since.set(id, now);
  return since;
}

/**
 * The sessions to close now under the 24 h rule: asleep for more than ASLEEP_CLOSE_MS, and closable (main decides:
 * an extra Claude Code tab with a session to resume later; never a project's main tab, a desk, a worktree or a shell).
 * @param {Map<string, number>} since
 * @param {number} now
 * @param {(id: string) => boolean} closable
 * @returns {string[]}
 */
function dueToClose(since, now, closable) {
  const out = [];
  for (const [id, at] of since) if (now - at > ASLEEP_CLOSE_MS && closable(id)) out.push(id);
  return out;
}

const baseName = (d) => String(d || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

/** A tab's title in the sidebar: the staff member, the worktree branch or the folder's name. */
function tabTitle(project, tab, staff) {
  const member = tab.staffId ? (staff || []).find((m) => m.id === tab.staffId) : null;
  if (member) return member.name;
  if (tab.worktree?.branch) return tab.worktree.branch;
  return baseName(tab.dir || project.dir) || project.name;
}

/**
 * What the Studio sidebar lists: per project, its running sessions (the main tab first, then the tabs by number; a
 * plain shell tab is no session) and its recent ones (newest first, at most RECENT_PER_PROJECT). Asleep sessions are
 * running ones that will start again when shown.
 * @param {{ projects: any[], status: any[], recent: any[], activeId?: string | null, staff?: any[] }} o
 */
function listSessions({ projects, status, recent, activeId = null, staff = [] }) {
  const byId = new Map((status || []).map((s) => [s.id, s]));
  const rec = Array.isArray(recent) ? recent : [];
  return (projects || []).map((p) => {
    const st = byId.get(p.id) || {};
    const tabSt = new Map((st.tabs || []).map((t) => [t.n, t]));
    const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter((t) => !t.shell).slice().sort((a, b) => a.n - b.n);
    const running = [
      { ptyId: p.id, n: MAIN_TAB, title: p.name, isRunning: st.isRunning === true, isAsleep: st.isAsleep === true },
      ...tabs.map((t) => ({
        ptyId: `${p.id}:${t.n}`, n: t.n, title: tabTitle(p, t, staff),
        isRunning: tabSt.get(t.n)?.isRunning === true, isAsleep: tabSt.get(t.n)?.isAsleep === true,
      })),
    ];
    const recentHere = rec.filter((r) => r.projectId === p.id).sort((a, b) => b.at - a.at).slice(0, RECENT_PER_PROJECT)
      .map((r) => ({ sessionId: r.sessionId, title: r.title || baseName(r.dir) || p.name, at: r.at }));
    return { id: p.id, name: p.name, dir: p.dir, engine: p.engine || 'claude', active: p.id === activeId, attention: st.attention || null, running, recent: recentHere };
  });
}

/** The Claude account's display name from its `.claude.json` (oauthAccount.displayName), or ''. */
function accountDisplayName(json) {
  const n = json && typeof json === 'object' ? json.oauthAccount?.displayName : '';
  return typeof n === 'string' ? n.trim().slice(0, 80) : '';
}

module.exports = {
  EXPERIENCES, ASLEEP_CLOSE_MS, RECENT_MAX, RECENT_PER_PROJECT,
  normalizeExperience, validSessionId, normalizeRecent, addRecent, dropRecent, trackAsleep, dueToClose, tabTitle, listSessions, accountDisplayName,
};
