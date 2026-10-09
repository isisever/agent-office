// Project list: pure state functions (no Electron; tested with node --test).
// State: { projects: Project[], accounts: Account[], activeId: string | null } (see CONTRACT.md).
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_ID, normalizeAccounts } = require('./accounts.js');

const newId = () => crypto.randomBytes(6).toString('hex');
const projectName = (dir) => path.basename(dir);

// Cleans what was read from state.json; the old single-project version's `lastProject` becomes the first project.
function normalizeState(raw, { id = newId } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const accounts = normalizeAccounts(r.accounts);
  const known = new Set(accounts.map((a) => a.id));
  const seen = new Set();
  const projects = [];
  for (const p of Array.isArray(r.projects) ? r.projects : []) {
    if (!p || typeof p.dir !== 'string' || !p.dir || seen.has(p.dir)) continue;
    seen.add(p.dir);
    projects.push({
      id: typeof p.id === 'string' && p.id ? p.id : id(),
      dir: p.dir,
      name: projectName(p.dir),
      accountId: known.has(p.accountId) ? p.accountId : DEFAULT_ID,
      ...withTabs(normalizeTabs(p.tabs)),
    });
  }
  if (!projects.length && typeof r.lastProject === 'string' && r.lastProject) {
    projects.push({ id: id(), dir: r.lastProject, name: projectName(r.lastProject), accountId: DEFAULT_ID });
  }
  const activeId = projects.some((p) => p.id === r.activeId) ? r.activeId : (projects[0]?.id ?? null);
  return { projects, accounts, activeId };
}

// --- tabs (contract v3.0)
// Project.tabs holds only extra tabs; the first tab (main terminal) is implicit, counts as number 1 and cannot be closed.
// Tab = { n: number (≥ 2), dir?: string, worktree?: { root, repo, branch } }
// Without dir the tab runs in the project folder; with worktree the tab is in a folder created by `git worktree add`.
const MAIN_TAB = 1;
const isObj = (o) => Boolean(o) && typeof o === 'object';
const isStr = (s) => typeof s === 'string' && s.length > 0;

// Cleans the tabs from state.json: invalid and duplicate numbers are dropped, order is kept.
function normalizeTabs(list) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    if (!isObj(t) || !Number.isInteger(t.n) || t.n <= MAIN_TAB || seen.has(t.n)) continue;
    seen.add(t.n);
    const tab = { n: t.n };
    const w = t.worktree;
    if (isStr(t.dir) && isObj(w) && isStr(w.root) && isStr(w.repo) && isStr(w.branch)) {
      tab.dir = t.dir;
      tab.worktree = { root: w.root, repo: w.repo, branch: w.branch };
    }
    out.push(tab);
  }
  return out;
}
// a project without tabs stays as before (the tabs field is never written)
const withTabs = (tabs) => (tabs.length ? { tabs } : {});
const tabsOf = (project) => (Array.isArray(project?.tabs) ? project.tabs : []);

// pty id: main tab projectId, extra tab `<projectId>:<n>`. Login ptys are `login:<account>` (no clash).
const tabPtyId = (projectId, n = MAIN_TAB) => (n === MAIN_TAB ? projectId : `${projectId}:${n}`);
/** pty id → { projectId, n } (main tab n = 1); a login pty or invalid id → null. */
function parsePtyId(id) {
  if (!isStr(id) || id.startsWith('login:')) return null;
  const m = /^(.+):(\d+)$/.exec(id);
  if (!m) return { projectId: id, n: MAIN_TAB };
  const n = Number(m[2]);
  return n > MAIN_TAB ? { projectId: m[1], n } : null;
}
/** All of the project's pty ids: main tab first. */
const ptyIdsOf = (project) => [project.id, ...tabsOf(project).map((t) => tabPtyId(project.id, t.n))];
/** The folder the tab runs in. */
const tabDir = (project, tab) => tab?.dir || project.dir;
/** Project and tab from a pty id (tab is null for the main tab); unknown → null. */
function resolvePty(state, id) {
  const r = parsePtyId(id);
  const project = r && findProject(state, r.projectId);
  if (!project) return null;
  if (r.n === MAIN_TAB) return { project, tab: null, dir: project.dir };
  const tab = tabsOf(project).find((t) => t.n === r.n);
  return tab ? { project, tab, dir: tabDir(project, tab) } : null;
}

/**
  * New tab number: the one after the largest. If taken(n) returns true (e.g. the worktree folder or branch
  * already exists) it moves on to the next; at most 100 tries.
 * @param {{ tabs?: { n: number }[] } | null} project
 * @param {(n: number) => boolean} [taken]
 */
function nextTabNumber(project, taken = (_n) => false) {
  let n = Math.max(MAIN_TAB, ...tabsOf(project).map((t) => t.n)) + 1;
  for (let i = 0; i < 100 && taken(n); i++) n++;
  return n;
}

// Worktree naming: a `<repo>-wt-<n>` folder next to the repo, branch `agent-office/<n>`.
// If the project is a subfolder of the repo, the tab runs in the same subfolder inside the worktree.
const worktreeRoot = (repo, n) => path.join(path.dirname(repo), `${path.basename(repo)}-wt-${n}`);
const worktreeBranch = (n) => `agent-office/${n}`;
/** The worktree counterpart of projectDir if it is inside the repo; otherwise the worktree root. */
function worktreeDir(repo, root, projectDir) {
  const rel = path.relative(repo, projectDir);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? root : path.join(root, rel);
}

function addTab(state, projectId, tab) {
  const p = findProject(state, projectId);
  if (!p || !Number.isInteger(tab?.n) || tab.n <= MAIN_TAB || tabsOf(p).some((t) => t.n === tab.n)) return state;
  return { ...state, projects: state.projects.map((x) => (x.id === projectId ? { ...x, tabs: [...tabsOf(x), tab] } : x)) };
}
// The main tab cannot be removed; when the last extra tab goes, the tabs field is deleted.
function removeTab(state, projectId, n) {
  const p = findProject(state, projectId);
  if (!p || !tabsOf(p).some((t) => t.n === n)) return state;
  return {
    ...state,
    projects: state.projects.map((x) => {
      if (x.id !== projectId) return x;
      const { tabs, ...rest } = x;
      return { ...rest, ...withTabs(tabsOf(x).filter((t) => t.n !== n)) };
    }),
  };
}

/**
  * Session name → project name. The plugin names a session after its folder (basename); if a worktree tab's
  * folder has another name (`<repo>-wt-<n>`), those sessions count toward its project. A name that clashes
  * with a project's own name is not mapped (that name belongs to that project).
 */
function sessionAliases(projects) {
  const names = new Set(projects.map((p) => p.name));
  const out = {};
  for (const p of projects) {
    for (const t of tabsOf(p)) {
      const name = path.basename(tabDir(p, t));
      if (name && !names.has(name) && !(name in out)) out[name] = p.name;
    }
  }
  return out;
}

const findProject = (state, id) => state.projects.find((p) => p.id === id) || null;
const findByDir = (state, dir) => state.projects.find((p) => p.dir === dir) || null;

// If the folder is in the list it is only activated; otherwise it is added and activated.
function addProject(state, dir, { id = newId, accountId = DEFAULT_ID } = {}) {
  const old = findByDir(state, dir);
  if (old) return { state: { ...state, activeId: old.id }, project: old, isNew: false };
  const acc = state.accounts.some((a) => a.id === accountId) ? accountId : DEFAULT_ID;
  const project = { id: id(), dir, name: projectName(dir), accountId: acc };
  return { state: { ...state, projects: [...state.projects, project], activeId: project.id }, project, isNew: true };
}

// If the active project is deleted, its neighbor (the next one, else the previous) takes its place.
function removeProject(state, id) {
  const i = state.projects.findIndex((p) => p.id === id);
  if (i < 0) return state;
  const projects = state.projects.filter((p) => p.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = (projects[i] || projects[i - 1])?.id ?? null;
  return { ...state, projects, activeId };
}

function setActive(state, id) {
  return findProject(state, id) ? { ...state, activeId: id } : state;
}

function setProjectAccount(state, id, accountId) {
  if (!state.accounts.some((a) => a.id === accountId)) return state;
  return { ...state, projects: state.projects.map((p) => (p.id === id ? { ...p, accountId } : p)) };
}

// Claude Code's session history folder: <account folder or ~/.claude>/projects/<path, non-alphanumerics → '-'>
// (tried: /Users/a/.claude → -Users-a--claude). If it has a .jsonl, `claude --continue` finds a session to resume.
const historyDir = (projectDir, configDir, home) =>
  path.join(configDir || path.join(home, '.claude'), 'projects', String(projectDir).replace(/[^a-zA-Z0-9]/g, '-'));

module.exports = {
  historyDir,
  MAIN_TAB, normalizeTabs, tabsOf, tabPtyId, parsePtyId, ptyIdsOf, tabDir, resolvePty,
  nextTabNumber, worktreeRoot, worktreeBranch, worktreeDir, addTab, removeTab, sessionAliases,
  newId, projectName, normalizeState, findProject, findByDir,
  addProject, removeProject, setActive, setProjectAccount,
};
