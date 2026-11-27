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

/**
 * One 24 h rule pass: outside Studio nothing is tracked (`since` is cleared, so time asleep in the Office never counts)
 * and nothing closes; in Studio `since` follows the sessions asleep now and the closable ones past 24 h are returned.
 * Mutates `since`.
 * @param {Map<string, number>} since
 * @param {Iterable<string>} asleepIds
 * @param {number} now
 * @param {unknown} experience
 * @param {(id: string) => boolean} [closable]
 * @returns {string[]}
 */
function sweepStep(since, asleepIds, now, experience, closable = () => true) {
  if (normalizeExperience(experience) !== 'studio') { since.clear(); return []; }
  trackAsleep(since, asleepIds, now);
  return dueToClose(since, now, closable);
}

const sameDir = (a, b) => String(a || '').replace(/[\\/]+$/, '') === String(b || '').replace(/[\\/]+$/, '');

/**
 * May the 24 h rule close this tab? Only an extra Claude Code tab with a session to resume, in the project's own folder
 * (a Recent session always opens again there), with no handoff lock and no task waiting for its report. Never a
 * project's main tab, HQ, a desk, a worktree or a shell.
 * @param {{ project: any, tab?: any } | null | undefined} r the tab as P.resolvePty gives it
 * @param {{ sid?: string, handoffLocked?: boolean, guiTaskOpen?: boolean }} o
 */
function closable(r, { sid = '', handoffLocked = false, guiTaskOpen = false } = {}) {
  if (!r?.tab || !r.project) return false;
  const { project, tab } = r;
  if (project.hq || (project.engine || 'claude') !== 'claude') return false;
  if (tab.shell || tab.staffId || tab.worktree) return false;
  if (tab.dir && !sameDir(tab.dir, project.dir)) return false;
  return Boolean(validSessionId(sid)) && !handoffLocked && !guiTaskOpen;
}

/**
 * What prefs:set does for the chat view and the experience. A chat view change moves idle tabs (v3.108). Entering
 * Studio moves idle Claude Code tabs to the GUI chat at once (busy ones when they are idle, by the tick); leaving it
 * moves nothing back (leftStudio: the GUI tabs keep their chat in the Office until their next start). Either way the
 * 24 h clocks start again.
 * @param {{ chatView?: boolean, experience?: string }} prev the prefs before
 * @param {any} p the patch from the renderer
 * @returns {{ patch: { chatView?: boolean, experience?: string }, switchIdle: boolean, clearSince: boolean, leftStudio: boolean }}
 */
function prefsPatch(prev, p) {
  /** @type {{ patch: { chatView?: boolean, experience?: string }, switchIdle: boolean, clearSince: boolean, leftStudio: boolean }} */
  const out = { patch: {}, switchIdle: false, clearSince: false, leftStudio: false };
  if (!p || typeof p !== 'object') return out;
  if (typeof p.chatView === 'boolean' && p.chatView !== prev.chatView) { out.patch.chatView = p.chatView; out.switchIdle = true; }
  if (EXPERIENCES.includes(p.experience) && p.experience !== normalizeExperience(prev.experience)) {
    out.patch.experience = p.experience;
    out.clearSince = true;
    if (p.experience === 'studio') out.switchIdle = true; else out.leftStudio = true;
  }
  return out;
}

/**
 * The mode an idle running Claude Code tab moves to (v3.108 guiSwitchIdle), or null to keep it. In Studio the target is
 * the Studio start mode (a GUI chat, except a tab switched to its terminal, HQ, Windows). In the Office a tab that ran
 * as a chat in Studio keeps it until its next start (no move back, no restart ping-pong); the others follow the chat
 * view alone. Only idle tabs are asked (main checks that first): a busy tab is never restarted.
 * @param {{ gui: boolean, studio: boolean, studioStarted: boolean, chatTarget: boolean, studioTarget: boolean }} o
 * chatTarget: guiEligible without Studio; studioTarget: guiEligible with Studio
 * @returns {boolean | null}
 */
function idleMoveTarget({ gui, studio, studioStarted, chatTarget, studioTarget }) {
  let target;
  if (studio) target = Boolean(studioTarget);
  else if (studioStarted && gui) return null;
  else target = Boolean(chatTarget);
  return Boolean(gui) === target ? null : target;
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
// accountOf(project) → the label of the Claude account the project runs on (A.accountOf, the Office's account name);
// only the label is listed, never a token or a config folder.
function listSessions({ projects, status, recent, activeId = null, staff = [], accountOf = () => '' }) {
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
    const label = accountOf(p);
    const account = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    return { id: p.id, name: p.name, dir: p.dir, engine: p.engine || 'claude', account, active: p.id === activeId, attention: st.attention || null, running, recent: recentHere };
  });
}

/** The Claude account's display name from its `.claude.json` (oauthAccount.displayName), or ''. */
function accountDisplayName(json) {
  const n = json && typeof json === 'object' ? json.oauthAccount?.displayName : '';
  return typeof n === 'string' ? n.trim().slice(0, 80) : '';
}

module.exports = {
  EXPERIENCES, ASLEEP_CLOSE_MS, RECENT_MAX, RECENT_PER_PROJECT,
  normalizeExperience, validSessionId, normalizeRecent, addRecent, dropRecent, trackAsleep, dueToClose, sweepStep, closable, prefsPatch, idleMoveTarget, tabTitle, listSessions, accountDisplayName,
};
