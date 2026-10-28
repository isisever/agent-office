// Project list: pure state functions (no Electron; tested with node --test).
// State: { projects: Project[], accounts: Account[], activeId: string | null } (see CONTRACT.md).
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_ID, normalizeAccounts, SAVINGS_LEVELS, SAVINGS_DEFAULT } = require('./accounts.js');
const { withSkillPacks } = require('./skill-packs.js');
const { isFixcloudModel } = require('./fixcloud.js');
const HQ = require('./hq.js');
const ROUT = require('./routines.js');

// v3.46 HQ: its folder (userData/hq) is set by main at startup; 'hq' is never in state.projects.
let hqDir = '';
const setHqDir = (dir) => { hqDir = String(dir || ''); };
/** The named seam: the HQ as a frozen project-like object (resolvePty('hq')), or null before main set its folder. */
const hqProject = (state) => (hqDir ? HQ.hqProject(state?.hq, hqDir) : null);
const isHqId = (id) => id === HQ.HQ_ID;

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
      ...(Number.isFinite(p.addedAt) ? { addedAt: p.addedAt } : {}), // v3.13; projects from before have none
      ...withManager(p.manager),
      ...withBossModel(p.bossModel),
      ...withAgentModel(p.agentModel),
      ...withContextCap(p.contextCap),
      ...withSavings(p.savings),
      ...withEngine(p.engine),
      ...withProjectFiles(p.projectFiles),
      ...withSkillPacks(p.skillPacks), // v3.45 per-project skill pack overrides
      ...withBackup(p.backupAccount, known),
      ...withHome(p.homeAccount, known, known.has(p.accountId) ? p.accountId : DEFAULT_ID),
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
    if (t.shell === true && !(isStr(t.dir) && t.dir)) continue; // a shell tab needs its folder: never turn into a Claude tab
    seen.add(t.n);
    const tab = { n: t.n };
    const w = t.worktree;
    if (isStr(t.dir) && isObj(w) && isStr(w.root) && isStr(w.repo) && isStr(w.branch)) {
      tab.dir = t.dir;
      tab.worktree = { root: w.root, repo: w.repo, branch: w.branch };
    } else if (t.shell === true && isStr(t.dir) && t.dir) { // a plain terminal tab (contract v3.42): the shell, no engine
      tab.dir = t.dir;
      tab.shell = true;
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
/** The project's engine pty ids (main tab first); plain terminal tabs are left out: no restart, sleep or account logic applies to a shell. */
const ptyIdsOf = (project) => [project.id, ...tabsOf(project).filter((t) => !t.shell).map((t) => tabPtyId(project.id, t.n))];
/** Every pty id of the project, plain terminal tabs included (starting at launch, killing on removal). */
const allPtyIdsOf = (project) => [project.id, ...tabsOf(project).map((t) => tabPtyId(project.id, t.n))];
/** The folder the tab runs in. */
const tabDir = (project, tab) => tab?.dir || project.dir;
/** Project and tab from a pty id (tab is null for the main tab); unknown → null. */
function resolvePty(state, id) {
  if (isHqId(id)) { const hq = hqProject(state); return hq ? { project: hq, tab: null, dir: hq.dir } : null; }
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
      if (t.shell) continue; // a plain terminal runs no session
      const name = path.basename(tabDir(p, t));
      if (name && !names.has(name) && !(name in out)) out[name] = p.name;
    }
  }
  return out;
}

/**
  * Where the projects live (contract v3.5): { dir, name } for every project folder and every worktree tab's folder,
  * so readOffice can place a path some session works in under the project that holds it.
 */
function projectPlaces(projects) {
  const out = [];
  for (const p of projects) {
    out.push({ dir: p.dir, name: p.name });
    for (const t of tabsOf(p)) if (t.dir && t.dir !== p.dir) out.push({ dir: t.dir, name: p.name });
  }
  return out;
}

const findProject = (state, id) => state.projects.find((p) => p.id === id) || null;
const findByDir = (state, dir) => state.projects.find((p) => p.dir === dir) || null;

// If the folder is in the list it is only activated; otherwise it is added and activated.
function addProject(state, dir, { id = newId, accountId = DEFAULT_ID, now = Date.now } = {}) {
  const old = findByDir(state, dir);
  if (old) return { state: { ...state, activeId: old.id }, project: old, isNew: false };
  const acc = state.accounts.some((a) => a.id === accountId) ? accountId : DEFAULT_ID;
  const project = { id: id(), dir, name: projectName(dir), accountId: acc, addedAt: now() };
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
  if (isHqId(id) || HQ.parseRemoteKey(id)) return state;   // HQ and remote rows are selected in the window only
  return findProject(state, id) ? { ...state, activeId: id } : state;
}

// A change made by the user: the project stays on that account (any automatic move's home is forgotten, v3.17).
function setProjectAccount(state, id, accountId) {
  if (!state.accounts.some((a) => a.id === accountId)) return state;
  return { ...state, projects: state.projects.map((p) => {
    if (p.id !== id) return p;
    const { homeAccount: _, ...rest } = p;
    return { ...rest, accountId };
  }) };
}

// --- per-project manager mode (contract v3.10)
// Project.manager: true = the boss delegates (manager mode), false = it does the work itself; absent = the global
// setting (state.manager). A project on the global setting never has the field written.
const withManager = (v) => (typeof v === 'boolean' ? { manager: v } : {});

/** value: true | false | null (null: back to the global setting). Same state when nothing changes. */
function setProjectManager(state, id, value) {
  const p = findProject(state, id);
  const v = typeof value === 'boolean' ? value : null;
  if (!p || (p.manager ?? null) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { manager: _, ...rest } = x;
    return v === null ? rest : { ...rest, manager: v };
  }) };
}

/** Does this project's boss delegate? Its own setting, else the global one (on by default). */
const managerOf = (state, project) => (typeof project?.manager === 'boolean' ? project.manager : state.manager !== false);

// --- per-project boss model (contract v3.27, per engine v3.36)
// Project.bossModel is the model of the project's MAIN session (every tab of the project), validated against the
// project's engine: Claude's aliases 'sonnet' | 'opus' | 'haiku' (`--model <alias>`), Antigravity's tiers 'flash' | 'pro'
// (`--model <slug>`), Command Code's full model ids (`-m <id>`). Absent = Auto: the program's own default. Never
// written for Auto; a value that doesn't fit the engine counts as Auto (switching back finds it again).
// src/engine-caps.mjs BOSS_MODEL_CHOICES holds the same values for the sidebar.
const BOSS_MODELS = ['sonnet', 'opus', 'haiku'];
const BOSS_MODELS_BY_ENGINE = {
  claude: BOSS_MODELS,
  agy: ['flash', 'pro'],
  commandcode: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'deepseek/deepseek-v4-flash'],
  opencode: ['opencode/big-pickle'], // v3.40: `-m provider/model`; OpenCode's free model, no login needed
};
// v3.55: a fixcloud account binds its project to OpenCode with `-m fixcloud/<model>`; the model is the account's own,
// so any `fixcloud/<model>` value is valid for the opencode engine (beyond the fixed list above).
const bossModelValue = (v, engine) => {
  const e = engineValue(engine) || 'claude';
  if (e === 'opencode' && isFixcloudModel(v)) return v;
  return (BOSS_MODELS_BY_ENGINE[e] || []).includes(v) ? v : null;
};
// normalizeState keeps a model valid for ANY engine (switching back finds it again); only the launch args check the active engine
const anyEngineBossModel = (v) => isFixcloudModel(v) || Object.values(BOSS_MODELS_BY_ENGINE).some((l) => l.includes(v));
const withBossModel = (v) => (anyEngineBossModel(v) ? { bossModel: v } : {});

/** value: one of the project's engine's models, or null (Auto). Same state when nothing changes. */
function setProjectBossModel(state, id, value) {
  const p = findProject(state, id);
  const v = bossModelValue(value, p?.engine);
  if (!p || (p.bossModel ?? null) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { bossModel: _, ...rest } = x;
    return v === null ? rest : { ...rest, bossModel: v };
  }) };
}

/** The model the project pins its boss session to (for its engine), or null (Auto). */
const bossModelOf = (project) => bossModelValue(project?.bossModel, project?.engine);

/** The boss model's launch arguments for the project's engine: claude and agy `--model <v>`, Command Code and OpenCode `-m <id>`; [] for Auto. */
const bossModelArgs = (project) => {
  const v = bossModelOf(project);
  if (!v) return [];
  const e = engineValue(project?.engine);
  return e === 'commandcode' || e === 'opencode' ? ['-m', v] : ['--model', v];
};

// --- per-project subagent model (contract v3.14)
// Project.agentModel: 'sonnet' | 'haiku' | 'opus' runs every subagent of the project's sessions on that model;
// absent = Auto: the boss picks per agent (the plugin's manager brief). Never written for Auto.
const AGENT_MODELS = ['sonnet', 'haiku', 'opus'];
const agentModelValue = (v) => (AGENT_MODELS.includes(v) ? v : null);
const withAgentModel = (v) => (agentModelValue(v) ? { agentModel: v } : {});

/** value: 'sonnet' | 'haiku' | 'opus' | null (Auto). Same state when nothing changes. */
function setProjectAgentModel(state, id, value) {
  const p = findProject(state, id);
  const v = agentModelValue(value);
  if (!p || (p.agentModel ?? null) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { agentModel: _, ...rest } = x;
    return v === null ? rest : { ...rest, agentModel: v };
  }) };
}

/** The model the project pins its subagents to, or null (Auto). */
const agentModelOf = (project) => agentModelValue(project?.agentModel);

// --- per-project context cap (contract v3.15)
// Project.contextCap: 200000 | 400000 tokens makes Claude Code auto-compact earlier (CLAUDE_CODE_AUTO_COMPACT_WINDOW,
// accounts.js sessionEnv); absent = Auto: Claude Code's own window (the model's, 1M on a 1M model). Never written for Auto.
const CONTEXT_CAPS = [200000, 400000];
const contextCapValue = (v) => (CONTEXT_CAPS.includes(v) ? v : null);
const withContextCap = (v) => (contextCapValue(v) ? { contextCap: v } : {});

/** value: 200000 | 400000 | null (Auto). Same state when nothing changes. */
function setProjectContextCap(state, id, value) {
  const p = findProject(state, id);
  const v = contextCapValue(value);
  if (!p || (p.contextCap ?? null) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { contextCap: _, ...rest } = x;
    return v === null ? rest : { ...rest, contextCap: v };
  }) };
}

/** The project's auto-compact window in tokens, or null (Auto). */
const contextCapOf = (project) => contextCapValue(project?.contextCap);

// --- per-project savings (contract v3.20)
// Project.savings: 'off' | 'strict'; absent = 'normal', the default (accounts.js SAVINGS holds what each level sets).
// Never written for Normal.
const savingsValue = (v) => (SAVINGS_LEVELS.includes(v) ? v : SAVINGS_DEFAULT);
const withSavings = (v) => (savingsValue(v) !== SAVINGS_DEFAULT ? { savings: v } : {});

/** value: 'off' | 'normal' | 'strict' (null or anything else: Normal). Same state when nothing changes. */
function setProjectSavings(state, id, value) {
  const p = findProject(state, id);
  const v = savingsValue(value);
  if (!p || savingsValue(p.savings) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { savings: _, ...rest } = x;
    return { ...rest, ...withSavings(v) };
  }) };
}

/** The project's savings level: 'off' | 'normal' | 'strict'. */
const savingsOf = (project) => savingsValue(project?.savings);

// --- per-project engine (contract v3.22)
// Project.engine: 'agy' runs Google Antigravity CLI in the project's tabs instead of Claude Code (v3.22);
// 'commandcode' runs Command Code's `commandcode` (contract v3.25); absent = Claude Code. Never written for Claude
// Code. Neither engine gets anything of Claude Code's setup (account folder, plugin, status line, memory, MCP
// config) or of the office (directory, journal, savings); the app observes both one way.
// 'opencode' runs OpenCode's `opencode` (contract v3.40), observed the same way.
const ENGINES = ['claude', 'agy', 'commandcode', 'opencode'];
const engineValue = (v) => (v === 'agy' || v === 'commandcode' || v === 'opencode' ? v : null);
const withEngine = (v) => (engineValue(v) ? { engine: v } : {});


/**
 * value: 'agy' | 'commandcode' | 'opencode' | 'claude' | null (both: Claude Code). Same state when nothing changes.
 */
function setProjectEngine(state, id, value) {
  const p = findProject(state, id);
  const v = engineValue(value);
  if (!p || engineValue(p.engine) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { engine: _, ...rest } = x;
    return v === null ? rest : { ...rest, engine: v };
  }) };
}

/** The program the project's tabs run: 'claude' | 'agy' | 'commandcode' | 'opencode'. */
const engineOf = (project) => engineValue(project?.engine) || 'claude';

// --- opt-in project files (contract v3.38, src/project-files.js)
// Project.projectFiles: true lets Agent Office write its files into the project folder for Antigravity / Command Code
// (manager brief, worker agent, Stop gate, the project's own MCP servers). Absent = off (the default). Never written for off.
/** @type {(v: unknown) => { projectFiles?: true }} */
const withProjectFiles = (v) => (v === true ? { projectFiles: true } : {});

/** value: true | false. Same state when nothing changes. */
function setProjectFiles(state, id, value) {
  const p = findProject(state, id);
  const v = value === true;
  if (!p || (p.projectFiles === true) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { projectFiles: _, ...rest } = x;
    return v ? { ...rest, projectFiles: true } : rest;
  }) };
}

/** Whether the project lets Agent Office add its files. */
const projectFilesOf = (project) => project?.projectFiles === true;

// --- backup account at the usage limit (contract v3.17, src/fallback.js)
// Project.backupAccount: 'auto' (any other logged-in account not at its limit) or an account id; absent = none.
// Project.homeAccount: the account the project was on before an automatic move to a backup; it goes back there once
// that account's limit resets. Never written when there is no automatic move in progress.
const withBackup = (v, known) => (v === 'auto' || (typeof v === 'string' && known.has(v)) ? { backupAccount: v } : {});
const withHome = (v, known, accountId) => (typeof v === 'string' && known.has(v) && v !== accountId ? { homeAccount: v } : {});

/** value: null (none) | 'auto' | an account id. Same state when nothing changes or the account is unknown. */
function setProjectBackup(state, id, value) {
  const p = findProject(state, id);
  const v = value === 'auto' || state.accounts.some((a) => a.id === value) ? value : null;
  if (!p || (p.backupAccount ?? null) === v) return state;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { backupAccount: _, ...rest } = x;
    return v === null ? rest : { ...rest, backupAccount: v };
  }) };
}

/** The project's backup setting: 'auto', an account id, or null (none). */
const backupOf = (project) => (typeof project?.backupAccount === 'string' && project.backupAccount ? project.backupAccount : null);

/**
 * An automatic move at the usage limit: the project goes to accountId and remembers where it came from (the first
 * account of a chain stays the home). Moving onto the home itself forgets it.
 */
function fallbackTo(state, id, accountId) {
  const p = findProject(state, id);
  if (!p || p.accountId === accountId || !state.accounts.some((a) => a.id === accountId)) return state;
  const home = p.homeAccount || p.accountId;
  return { ...state, projects: state.projects.map((x) => {
    if (x.id !== id) return x;
    const { homeAccount: _, ...rest } = x;
    return home === accountId ? { ...rest, accountId } : { ...rest, accountId, homeAccount: home };
  }) };
}

/** Back to the home account (its limit reset): the home is forgotten. Same state when there is none. */
function returnHome(state, id) {
  const p = findProject(state, id);
  if (!p?.homeAccount || !state.accounts.some((a) => a.id === p.homeAccount)) return state;
  return fallbackTo(state, id, p.homeAccount);
}

// Claude Code's session history folder: <account folder or ~/.claude>/projects/<path, non-alphanumerics → '-'>
// (tried: /Users/a/.claude → -Users-a--claude). If it has a .jsonl, `claude --continue` finds a session to resume.
// (Command Code names its folders differently: token-usage.js ccSlugOf, contract v3.25.)
const historyDir = (projectDir, configDir, home) =>
  path.join(configDir || path.join(home, '.claude'), 'projects', String(projectDir).replace(/[^a-zA-Z0-9]/g, '-'));

/** The projects as the renderer gets them (v3.44: since connections are gone, all of a project's fields). */
const forRenderer = (projects) => projects.map((p) => ({ ...p }));

/**
 * What saveState writes to state.json: the file's unknown keys kept, the old `lastProject` dropped, the state on top.
 * App-added MCP servers (v3.44) keep only their known fields, so a token or header can never be written there.
 */
function stateFile(prev, state) {
  const { lastProject, ...rest } = prev && typeof prev === 'object' ? prev : {};
  const out = { ...rest, ...state };
  for (const k of ['mcpServers']) if (Array.isArray(out[k])) {
    out[k] = out[k].map(({ id, name, type, url, scope, held }) => ({ id, name, type, url, scope, ...(held ? { held } : {}) }));
  }
  return out;
}

module.exports = {
  forRenderer, stateFile,
  historyDir,
  MAIN_TAB, normalizeTabs, tabsOf, tabPtyId, parsePtyId, ptyIdsOf, allPtyIdsOf, tabDir, resolvePty,
  nextTabNumber, worktreeRoot, worktreeBranch, worktreeDir, addTab, removeTab, sessionAliases, projectPlaces,
  newId, projectName, findProject, setHqDir, hqProject, isHqId,
  /** state.hq (v3.46) normalized next to the rest */
  normalizeState: (raw, o) => ({ ...normalizeState(raw, o), hq: HQ.normalizeHq(raw?.hq), routines: ROUT.normalizeRoutines(raw?.routines), routinesCfg: ROUT.normalizeCfg(raw?.routinesCfg) }), findByDir,
  addProject, removeProject, setActive, setProjectAccount, setProjectManager, managerOf,
  BOSS_MODELS, BOSS_MODELS_BY_ENGINE, setProjectBossModel, bossModelOf, bossModelArgs,
  AGENT_MODELS, setProjectAgentModel, agentModelOf,
  CONTEXT_CAPS, setProjectContextCap, contextCapOf,
  setProjectSavings, savingsOf,
  ENGINES, setProjectEngine, engineOf,
  setProjectFiles, projectFilesOf,
  setProjectBackup, backupOf, fallbackTo, returnHome,
};
