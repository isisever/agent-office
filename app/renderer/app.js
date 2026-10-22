// Wires everything together: sidebar (projects, accounts), per-project terminal(s) (tabs, v3.0), office and theme colors.
import { mountTerminal, pasteIntoFocused } from './terminal.js';
import { mountSidebar } from './sidebar.js';
import { mountLogin } from './login.js';
import { mountDevices, mergeRemote } from './devices.js';
import { setLang, onLang, t } from './i18n.js';
import { modLabel, isModKey, keyOf, isMac } from './platform.js';
import { themeChoices, effectiveTheme } from '../src/themes.mjs';
import { tildePath, windowTitle } from '../src/layout.mjs';

// Fake window.agentOffice to see the layout in a plain browser (outside Electron).
if (!window.agentOffice) await import('./dev-mock.js');

const api = window.agentOffice;
// language before first render: sidebar and title are built in the right language
let initialLang = null;
try { initialLang = await api.language?.get(); } catch (e) { console.error(e); }
if (initialLang) await setLang(initialLang.lang);
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

const DEFAULT_THEME = { frame: '#2b1d1a', accent: '#3fb6a8', statusBg: '#231815', statusText: '#f3ead8' };
const isLoginId = (id) => typeof id === 'string' && id.startsWith('login:');
const BUFFER_MAX = 256 * 1024; // data for a project that has no terminal yet

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
};

let projects = [];
let activeId = null;
let status = [];
let accounts = [];
let theme = DEFAULT_THEME;
let focusName; // project last reported to the office
const panes = new Map(); // pty id (projectId or `<projectId>:<n>`) -> { el, hint, term }
const pending = new Map(); // pty id -> { data: string, exited: boolean }
const activeTab = new Map(); // projectId -> number of the visible tab (1 = main terminal; this window only)

// ---- Tabs (contract v3.0): first tab is the main terminal (pty id projectId), extra tabs `<projectId>:<n>` ----
const MAIN_TAB = 1;
const tabsOf = (p) => (Array.isArray(p?.tabs) ? p.tabs : []);
const tabPtyId = (projectId, n) => (n === MAIN_TAB ? projectId : `${projectId}:${n}`);
const ptyIdsOf = (p) => [p.id, ...tabsOf(p).map((x) => tabPtyId(p.id, x.n))];
/** Visible tab in the project; a closed tab falls back to the main terminal. */
function tabOf(p) {
  const n = activeTab.get(p.id);
  return tabsOf(p).some((x) => x.n === n) ? n : MAIN_TAB;
}
const activeProject = () => projects.find((p) => p.id === activeId) || null;
/** pty id of the visible terminal. */
const activePty = () => { const p = activeProject(); return p ? tabPtyId(p.id, tabOf(p)) : null; };
// While the login overlay is open, focus stays on its terminal.
const focusActive = () => (login?.isOpen() ? login.focus() : panes.get(activePty())?.term.focus());
let login = null; // login overlay (login.js)

// ---- Theme ----
function applyTheme(t) {
  theme = { ...DEFAULT_THEME, ...t };
  root.style.setProperty('--frame', theme.frame);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--status-bg', theme.statusBg);
  root.style.setProperty('--status-text', theme.statusText);
  for (const p of panes.values()) p.term.setTheme(theme);
  login?.setTheme(theme);
}

// ---- Title bar ----
// v3.18: the project's name, then its folder (~ for home; long paths lose their start, style.css #project-dir);
// the native window title says the same (Window menu, Mission Control, the Linux/Windows frame).
function setTitleProject() {
  const p = activeProject();
  $('project').textContent = p ? p.name : t('app.noProject');
  $('project').title = p ? p.dir : '';
  const dir = $('project-dir');
  const shown = p ? tildePath(p.dir, api.home) : '';
  // LRM marks keep a leading '/' or '~' in place inside the right-to-left box that ellipsizes from the left
  dir.textContent = shown ? `\u200e${shown}\u200e` : '';
  dir.title = p ? p.dir : '';
  dir.hidden = !shown;
  document.title = windowTitle(p, api.home, 'Agent Office');
}

let lastStats = null; // to rewrite when the language changes
function setStats(d) {
  lastStats = d;
  const list = d?.projects;
  const working = Array.isArray(list)
    ? list.reduce((n, p) => n + (p.working || 0), 0)
    : (d?.workers || []).filter((w) => w.doneAt == null).length;
  // the boss's turn ended but its agents still run: it waits for them, not for the user
  const busy = d?.isBossBusy ? t('app.bossBusy') : working > 0 ? t('app.bossAgents') : '';
  $('stats').textContent = t('app.stats', { working, delivered: d?.delivered ?? 0, busy });
  $('stats').title = t('app.statsTitle');
  const warn = $('warn');
  // a session file in a newer format (contract v2.8) takes precedence over the theme warning
  warn.textContent = d?.newerFormat ? t('app.formatWarn') : t('app.themeWarn');
  warn.hidden = !d?.themesError && !d?.newerFormat;
  warn.title = d?.newerFormat ? t('app.formatError') : d?.themesError ? t('app.themesError', { error: d.themesError }) : '';
}

// ---- Update: button in the title bar once a new version is downloaded; clicking restarts the app ----
let updateVersion = null;
let appVersion = null; // running version: tooltip of the title bar's app title
function setVersionTitle() {
  $('title').title = appVersion ? t('app.versionTitle', { version: appVersion }) : '';
}
function showUpdate(version) {
  const b = $('update');
  if (!version) return;
  updateVersion = version;
  b.hidden = false;
  b.textContent = t('app.updateReady', { version });
  b.title = t('app.updateTitle');
}
$('update').addEventListener('click', () => {
  if (confirm(t('app.updateConfirm'))) api.update?.install();
});
api.update?.onReady(showUpdate);
api.update?.state().then((s) => {
  appVersion = s?.version || null;
  setVersionTitle();
  showUpdate(s?.ready);
}).catch(() => {});

// ---- Terminals: one xterm per project, hidden ones keep their history ----
function hint(projectId, text) {
  const p = panes.get(projectId);
  if (!p) return;
  p.hint.querySelector('span').textContent = text || '';
  p.hint.hidden = !text;
}

function createPane(id) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.id = id;
  el.hidden = true;
  const hintEl = document.createElement('div');
  hintEl.className = 'hint';
  hintEl.hidden = true;
  const hintText = document.createElement('span');
  const close = document.createElement('button');
  close.textContent = '×';
  close.className = 'hint-close';
  close.title = t('app.close');
  close.addEventListener('click', () => { hintEl.hidden = true; focusActive(); });
  hintEl.append(hintText, close);
  const host = document.createElement('div');
  host.className = 'term-host';
  el.append(hintEl, host);
  $('terminals').appendChild(el);

  const term = mountTerminal(host, { projectId: id, theme });
  panes.set(id, { el, hint: hintEl, term });
  const buf = pending.get(id);
  if (buf) {
    pending.delete(id);
    if (buf.data) term.write(buf.data);
    if (buf.exited) term.exit();
  }
}

function syncPanes() {
  const ids = new Set(projects.flatMap(ptyIdsOf).filter((id) => !isLoginId(id)));
  for (const [id, p] of panes) {
    if (ids.has(id)) continue;
    p.term.destroy();
    p.el.remove();
    panes.delete(id);
  }
  for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
  for (const id of ids) if (!panes.has(id)) createPane(id);
}

/** Is the tab's claude asleep (not started yet, or ended while idle in the background; see main's src/sleep.js)? */
function isAsleep(id) {
  const [projectId, n] = String(id).split(':');
  const st = status.find((x) => x.id === projectId);
  return Boolean(n ? st?.tabs?.find((x) => x.n === Number(n))?.isAsleep : st?.isAsleep);
}

let shownId; // visible terminal; focus/resize only when it changes
function showActive() {
  const visible = activePty();
  for (const [id, p] of panes) p.el.hidden = id !== visible;
  $('empty').hidden = projects.length > 0;
  renderTabs();
  // the shown tab always runs: a sleeping claude starts (and continues its session)
  if (visible && isAsleep(visible)) api.pty.wake?.(visible);
  if (shownId === visible) return;
  shownId = visible;
  const p = panes.get(visible);
  if (p) requestAnimationFrame(() => { p.term.fit(); p.term.focus(); });
}

// The tab strip shows only when the project has more than one tab; a single terminal looks as before
// (then "+" sits in the terminal's top-right corner and appears on hover).
const baseName = (d) => String(d || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; // '/' or Windows '\\'
function tabButton(p, tab, active, running) {
  const n = tab?.n ?? MAIN_TAB;
  const dir = tab?.dir || p.dir;
  const b = document.createElement('div');
  const sleeping = !running && isAsleep(tabPtyId(p.id, n));
  b.className = 'tab' + (n === active ? ' active' : '') + (running ? '' : sleeping ? ' asleep' : ' stopped') + (tab?.worktree ? ' worktree' : '') + (tab?.shell ? ' shell' : '');
  b.dataset.n = String(n);
  b.title = (tab?.shell ? t('app.shellTab', { dir }) : tab?.worktree ? t('app.worktreeTab', { branch: tab.worktree.branch, dir }) : n === MAIN_TAB ? t('app.mainTab', { dir }) : t('app.sameTab', { dir })) + (running ? '' : sleeping ? t('app.asleep') : t('app.stopped'));
  const num = document.createElement('span');
  num.className = 'tab-n';
  num.textContent = String(n);
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = tab?.shell ? `› ${baseName(dir)}` : tab?.worktree ? `⎇ ${tab.worktree.branch}` : baseName(dir);
  b.append(num, label);
  b.addEventListener('click', () => selectTab(p.id, n));
  if (tab) {
    const x = document.createElement('button');
    x.className = 'tab-x';
    x.textContent = '×';
    x.title = t('app.closeTab');
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p.id, n); });
    b.append(x);
  }
  return b;
}
function renderTabs() {
  const p = activeProject();
  const strip = $('tabs');
  const many = Boolean(p && tabsOf(p).length);
  strip.hidden = !many;
  $('terminal').classList.toggle('has-tabs', many);
  $('tab-add').hidden = !p || many;
  $('tab-add').title = t(isMac ? 'app.newTabMac' : 'app.newTab');
  if (!many) { strip.replaceChildren(); return; }
  const st = status.find((x) => x.id === p.id);
  const runningOf = (n) => (n === MAIN_TAB ? st?.isRunning !== false : st?.tabs?.find((x) => x.n === n)?.isRunning !== false);
  const active = tabOf(p);
  const add = document.createElement('button');
  add.className = 'tab-new';
  add.textContent = '+';
  add.title = t(isMac ? 'app.newTabMac' : 'app.newTab');
  add.addEventListener('click', () => addTab(p.id));
  strip.replaceChildren(
    tabButton(p, null, active, runningOf(MAIN_TAB)),
    ...tabsOf(p).map((tab) => tabButton(p, tab, active, runningOf(tab.n))),
    add,
  );
}

function selectTab(projectId, n) {
  activeTab.set(projectId, n);
  render();
  focusActive();
}
// without mode, main asks (in a git repo, a menu: same folder / new worktree).
async function addTab(projectId, mode) {
  if (!projectId) return;
  try {
    const tab = await api.tabs?.add(projectId, mode);
    if (tab?.n) {
      applyProjects(await api.projects.list());
      selectTab(projectId, tab.n);
      return;
    }
  } catch (e) { console.error(e); }
  focusActive();
}
async function closeTab(projectId, n) {
  try {
    const r = await api.tabs?.close(projectId, n);
    // git did not remove the worktree: claude restarted in the same tab from its last session
    if (r?.restarted) panes.get(tabPtyId(projectId, n))?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
  focusActive();
}
/** ⇧⌘[ / ⇧⌘] (Linux: Ctrl+Shift+PageUp/PageDown): previous/next tab in the active project. */
function cycleTab(step) {
  const p = activeProject();
  if (!p || !tabsOf(p).length) return;
  const ns = [MAIN_TAB, ...tabsOf(p).map((x) => x.n)];
  const i = ns.indexOf(tabOf(p));
  selectTab(p.id, ns[(i + step + ns.length) % ns.length]);
}

// `login:<account>` ids go to the login overlay; a project pane is never built for them.
api.pty.onData((id, d) => {
  if (isLoginId(id)) return login?.write(id, d);
  const p = panes.get(id);
  if (p) return p.term.write(d);
  const buf = pending.get(id) || { data: '', exited: false };
  buf.data = (buf.data + d).slice(-BUFFER_MAX);
  buf.exited = false;
  pending.set(id, buf);
});
api.pty.onReloaded?.((id) => panes.get(id)?.term.reloaded());
api.pty.onSleep?.((id) => {
  panes.get(id)?.term.sleep();
  pending.delete(id);
});
api.pty.onExit((id, code) => {
  if (isLoginId(id)) return login?.exit(id, code);
  const p = panes.get(id);
  if (p) return p.term.exit();
  const buf = pending.get(id) || { data: '', exited: false };
  buf.exited = true;
  pending.set(id, buf);
});

// ---- State ----
let office = null;
let sidebar = null;

function render() {
  if (!projects.some((p) => p.id === activeId)) activeId = projects[0]?.id ?? null;
  syncPanes();
  showActive();
  sidebar?.setState({ projects, activeId, status, accounts });
  setTitleProject();
  const name = activeProject()?.name ?? null;
  if (office && name !== focusName) {
    focusName = name;
    try { office.setFocus?.(name); } catch (e) { console.error(e); }
  }
}

function applyProjects(s) {
  if (!s) return;
  projects = s.projects || [];
  activeId = s.activeId ?? null;
  status = s.status || [];
  render();
}

function setAccounts(list) {
  accounts = Array.isArray(list) ? list : [];
  login?.setAccounts(accounts);
  render();
}

async function refreshAccounts() {
  try { setAccounts(await api.accounts.list()); } catch (e) { console.error(e); render(); }
}

// ---- Actions ----
async function addProject() {
  try {
    const p = await api.projects.add();
    if (p) applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

// Connectors (v3.43): remote MCP servers, each a project with its own folder and sessions.
async function addConnector(form) {
  try {
    const r = await api.connectors.add(form);
    if (r?.ok) applyProjects(await api.projects.list());
    return r;
  } catch (e) { console.error(e); return { ok: false, error: 'failed' }; }
}
async function updateConnector(id, form) {
  try {
    const r = await api.connectors.update(id, form);
    for (const pid of r?.restarted || []) panes.get(pid)?.term.reset({ restarting: true }); // idle sessions restarted in their conversation
    if (r?.ok) applyProjects(await api.projects.list());
    return r;
  } catch (e) { console.error(e); return { ok: false, error: 'failed' }; }
}

function selectProject(id) {
  if (!id || !projects.some((p) => p.id === id)) return;
  if (id !== activeId) {
    activeId = id; // show immediately; onChange confirms
    render();
    api.projects.setActive(id).catch((e) => console.error(e));
  } else focusActive();
}

async function removeProject(p) {
  if (!confirm(t('app.removeProject', { name: p.name }))) return focusActive();
  try {
    await api.projects.remove(p.id);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project manager mode (v3.10): true | false | null; main restarts the idle tabs, whose terminals start over. */
async function setProjectManager(projectId, value) {
  try {
    const r = await api.projects.setManager?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project boss model (v3.27): 'sonnet' | 'opus' | 'haiku' | null (Auto); main restarts the idle tabs. */
async function setBossModel(projectId, value) {
  try {
    const r = await api.projects.setBossModel?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project subagent model (v3.14): 'sonnet' | 'haiku' | 'opus' | null (Auto); main restarts the idle tabs. */
async function setAgentModel(projectId, value) {
  try {
    const r = await api.projects.setAgentModel?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Opt-in project files (v3.38): true | false; main writes or removes its files and restarts the idle tabs. */
async function setProjectFiles(projectId, value) {
  try {
    const r = await api.projects.setProjectFiles?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project context cap (v3.15): 200000 | 400000 | null (Auto); main restarts the idle tabs. */
async function setContextCap(projectId, value) {
  try {
    const r = await api.projects.setContextCap?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project savings (v3.20): 'off' | 'normal' | 'strict'; main restarts the idle tabs. */
async function setSavings(projectId, value) {
  try {
    const r = await api.projects.setSavings?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/**
 * Per-project engine (v3.22): 'agy' (Antigravity) | null (Claude Code); main starts every tab of the project again,
 * fresh, or refuses / asks first when a tab is working (r.refused; the row's select goes back on the re-render).
 * The usage panel is Claude Code's only: it closes when its project moves to Antigravity or OpenCode.
 */
async function setEngine(projectId, value) {
  try {
    const r = await api.projects.setEngine?.(projectId, value);
    if ((value === 'agy' || value === 'opencode') && !r?.refused && usagePanel?.shownId() === projectId) usagePanel.hide();
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
    return r;
  } catch (e) { console.error(e); return null; }
}

/** Per-project backup account (v3.17): null (none) | 'auto' | an account id; nothing restarts. */
async function setBackup(projectId, value) {
  try {
    await api.projects.setBackup?.(projectId, value);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

async function setAccount(projectId, accountId) {
  // a new claude starts in every tab with the new account
  const proj = projects.find((p) => p.id === projectId);
  for (const id of proj ? ptyIdsOf(proj) : [projectId]) panes.get(id)?.term.reset({ restarting: true });
  hint(projectId, '');
  try {
    await api.projects.setAccount(projectId, accountId);
    applyProjects(await api.projects.list());
    if (accounts.find((a) => a.id === accountId)?.auth?.state === 'out') hint(projectId, t('app.loginHint'));
  } catch (e) { console.error(e); }
  if (projectId !== activeId) selectProject(projectId);
  else focusActive();
}

// Adding a new account opens the login overlay right away.
// With projectId ("+ Yeni hesap…" in a project row), the new account is assigned to that project at once.
async function addAccount(label, projectId) {
  let a = null;
  try { a = await api.accounts.add(label); } catch (e) { console.error(e); }
  if (a?.id && projectId) try { await api.projects.setAccount(projectId, a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
  if (a?.id) openLogin(a.id, a);
}

function openLogin(id, fallback) {
  const a = accounts.find((x) => x.id === id) || fallback;
  if (a) login.open(a);
}

async function logoutAccount(a) {
  if (a.id === 'default') return; // the system's Claude Code login cannot be signed out from here
  if (!confirm(t('app.logout', { label: a.label }))) return focusActive();
  try { await api.accounts.logout(a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function refreshAuth(id) {
  try {
    const list = await api.accounts.refreshAuth(id);
    if (Array.isArray(list)) return setAccounts(list);
  } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function renameAccount(id, label) {
  try { await api.accounts.rename(id, label); } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function setAccountShare(id, on) {
  try { await api.accounts.setShare?.(id, on); } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function removeAccount(a) {
  const users = projects.filter((p) => p.accountId === a.id).length;
  const note = users ? t('app.removeAccountNote', { n: users }) : '';
  if (!confirm(t('app.removeAccount', { label: a.label, note }))) return;
  try { await api.accounts.remove(a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
  try { applyProjects(await api.projects.list()); } catch {}
}

// ---- Sidebar ----
sidebar = mountSidebar($('sidebar'), {
  select: selectProject,
  addProject,
  setBotColor,
  removeProject,
  openFolder: (p) => api.projects.openFolder?.(p.id).catch((e) => console.error(e)),
  projectMenu: (p) => api.projects.menu?.(p.id).catch((e) => console.error(e)),
  setAccount,
  setProjectManager,
  setBossModel,
  setAgentModel,
  setProjectFiles,
  setContextCap,
  setSavings,
  setEngine,
  setBackup,
  addAccount,
  renameAccount,
  removeAccount,
  setShare: setAccountShare,
  login: (id) => openLogin(id),
  logout: logoutAccount,
  refreshAuth,
  agyLogin: () => openAgy('login'),
  agyLogout: () => openAgy('logout'),
  agyRefresh: () => api.agy?.auth(true).then(setAgyAuth, (e) => console.error(e)),
  cmdLogin: () => openCmd(),
  ocLogin: (mode) => openOc(mode || 'console'),
  ocLogout: () => openOc('logout'),
  ocRefresh: () => api.oc?.auth(true).then(setOcAuth, (e) => console.error(e)),
  cmdRefresh: () => api.cmd?.auth(true).then(setCmdAuth, (e) => console.error(e)),
  addAgy: () => addEngineAccount('agy'),
  addCmd: () => addEngineAccount('cmd'),
  addOc: () => addEngineAccount('oc'),
  hideOc: () => setEngineRow('showOcAccount', false),
  hideAgy: () => setEngineRow('showAgyAccount', false),
  hideCmd: () => setEngineRow('showCmdAccount', false),
  setLanguage: (setting) => api.language?.set(setting).catch((e) => console.error(e)),
  setResume: (on) => api.prefs?.set({ resume: on }).then((p) => sidebar.setResume(p?.resume)).catch((e) => console.error(e)),
  resumeUnfinished,
  setResumeWork: (on) => api.prefs?.set({ resumeWork: on }).then((p) => sidebar.setResumeWork(p?.resumeWork)).catch((e) => console.error(e)),
  setManager: (on) => api.prefs?.set({ manager: on }).then((p) => sidebar.setManager(p?.manager)).catch((e) => console.error(e)),
  setShareMcp: (on) => api.prefs?.set({ shareMcp: on }).then((p) => sidebar.setShareMcp(p?.shareMcp)).catch((e) => console.error(e)),
  setReloadMcp: (on) => api.prefs?.set({ reloadMcp: on }).then((p) => sidebar.setReloadMcp(p?.reloadMcp)).catch((e) => console.error(e)),
  setFallback: (on) => api.prefs?.set({ fallback: on }).then((p) => sidebar.setFallback(p?.fallback)).catch((e) => console.error(e)),
  setSleep: (minutes) => api.prefs?.set({ sleepMinutes: minutes }).then((p) => sidebar.setSleep(p?.sleepMinutes)).catch((e) => console.error(e)),
  setTheme: setThemeSetting,
  openUsage: (p) => usagePanel?.show(p),
  connector: { get: (id) => api.connectors.get(id), pickDir: () => api.connectors.pickDir(), add: addConnector, update: updateConnector },
});

login = mountLogin(document.body, { getTheme: () => theme, onClose: () => focusActive() });

// Antigravity's login (contract v3.24): one per user, agy itself in the 'login:agy' pty. Log out = /logout at its prompt.
function setAgyAuth(a) { if (a) sidebar.setAgyAuth(a); }
function openAgy(mode) {
  if (!api.agy) return;
  login.open({ id: 'agy', label: 'Antigravity' }, {
    start: () => api.agy.login(),
    hint: () => t(mode === 'logout' ? 'login.agyLogoutHint' : 'login.agyHint'),
    title: () => t(mode === 'logout' ? 'login.agyLogoutTitle' : 'login.title', { label: 'Antigravity' }),
  });
}
api.agy?.onAuth(setAgyAuth);
api.agy?.auth().then(setAgyAuth, (e) => console.error(e));

// Command Code's login (contract v3.30): one per user, `commandcode login` in the 'login:cmd' pty.
function setCmdAuth(a) { if (a) sidebar.setCmdAuth(a); }
function openCmd() {
  if (!api.cmd) return;
  login.open({ id: 'cmd', label: 'Command Code' }, {
    start: () => api.cmd.login(),
    hint: () => t('login.cmdHint'),
    title: () => t('login.title', { label: 'Command Code' }),
  });
}
api.cmd?.onAuth(setCmdAuth);
api.cmd?.auth().then(setCmdAuth, (e) => console.error(e));

// OpenCode's logins (contract v3.40): 'console' (device code) or 'auth' (one provider) in the 'login:oc' pty, first
// asked of the user (the login chooser menu), and 'logout'. Not logged in is normal: its free models need no login.
function setOcAuth(a) { if (a) sidebar.setOcAuth(a); }
function openOc(mode) {
  if (!api.oc) return;
  login.open({ id: 'oc', label: 'OpenCode' }, {
    start: () => api.oc.login(mode),
    hint: () => t(mode === 'logout' ? 'login.ocLogoutHint' : 'login.ocHint'),
    title: () => t(mode === 'logout' ? 'login.ocLogoutTitle' : 'login.title', { label: 'OpenCode' }),
  });
}
api.oc?.onAuth(setOcAuth);
api.oc?.auth().then(setOcAuth, (e) => console.error(e));

// Add account → Google Antigravity / Command Code (contract v3.30) / OpenCode (v3.40): the row stays in Accounts (showAgyAccount /
// showCmdAccount); installed and not logged in → its login starts; not installed → the row shows the install line.
async function setEngineRow(key, on) {
  try { sidebar.setEngineRows(await api.prefs?.set({ [key]: on })); } catch (e) { console.error(e); }
}
async function addEngineAccount(kind) {
  const engine = kind === 'agy' ? api.agy : kind === 'oc' ? api.oc : api.cmd;
  if (!engine) return;
  await setEngineRow(kind === 'agy' ? 'showAgyAccount' : kind === 'oc' ? 'showOcAccount' : 'showCmdAccount', true);
  let a = null;
  try { a = await engine.auth(true); } catch (e) { console.error(e); }
  if (kind === 'agy') setAgyAuth(a); else if (kind === 'oc') setOcAuth(a); else setCmdAuth(a);
  // OpenCode needs no login (free models): adding its row only shows it; signing in is a button on the row
  if (kind === 'oc' || !a?.installed || a.state === 'in') return;
  if (kind === 'agy') openAgy('login'); else openCmd();
}

function setCollapsed(c) {
  document.body.classList.toggle('sidebar-collapsed', c);
  $('toggle-sidebar').title = c ? t('app.showSidebar') : t('app.hideSidebar');
  store.set('sidebarCollapsed', c ? '1' : '0');
  requestAnimationFrame(() => panes.get(activePty())?.term.fit());
}
$('toggle-sidebar').addEventListener('click', () => {
  setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  focusActive();
});
// bot color: user's choice, stored on this computer
function setBotColor(hex) {
  store.set('botColor', hex || '');
  office?.setBotColor?.(hex);
  sidebar.setBotColor(hex);
}

setCollapsed(store.get('sidebarCollapsed') === '1');

// ---- Theme picker (v3.1): 'auto' picks by project (core.mjs), a name forces that theme for the whole office.
// The frame colours follow through onTheme → applyTheme; the bot color picker still wins over a theme's bot colours.
let officeThemes = {}; // gallery + user themes.json (main, office:themes)
let themeSetting = 'auto';
function applyThemeChoice() {
  sidebar.setThemes(themeChoices(officeThemes), themeSetting);
  try { office?.setTheme?.(effectiveTheme(themeSetting, officeThemes)); } catch (e) { console.error(e); }
}
function setThemeSetting(name) {
  themeSetting = name;
  applyThemeChoice();
  api.prefs?.set({ theme: name }).then((p) => {
    if (typeof p?.theme === 'string' && p.theme !== themeSetting) { themeSetting = p.theme; applyThemeChoice(); }
  }).catch((e) => console.error(e));
}

// ---- Language: title, empty state and hints; sidebar, office and panel redraw themselves ----
function applyStaticText() {
  $('title').textContent = t('app.appTitle');
  setVersionTitle();
  $('empty-title').textContent = t('app.emptyTitle');
  $('empty-add').textContent = t('app.emptyAdd');
  $('empty-add').title = t('app.emptyAddTitle', { mod: modLabel });
  $('empty-note').textContent = t('app.emptyNote');
  $('toggle-sidebar').title = document.body.classList.contains('sidebar-collapsed') ? t('app.showSidebar') : t('app.hideSidebar');
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.hint-close'))) b.title = t('app.close');
  setTitleProject();
  setStats(lastStats);
  renderTabs();
  if (updateVersion) showUpdate(updateVersion);
}
async function applyLanguage(li) {
  if (!li) return;
  await setLang(li.lang);
  // the office's drawn text (core.mjs) knows only English and Turkish; other languages get English
  try { office?.setLanguage?.(li.lang === 'tr' ? 'tr' : 'en'); } catch (e) { console.error(e); }
  sidebar.setLanguage(li);
}
onLang(applyStaticText);
applyStaticText();
// "Resume unfinished work" (contract v3.8): the sidebar button; the app menu's item sends its result as work:resumed
async function resumeUnfinished() {
  sidebar.setResuming(true);
  try { sidebar.showResumed(await api.work?.resumeUnfinished()); } catch (e) { console.error(e); }
  finally { sidebar.setResuming(false); }
}
api.work?.onResumed?.((r) => sidebar.showResumed(r));

api.prefs?.get().then((p) => {
  sidebar.setResume(p?.resume);
  sidebar.setResumeWork(p?.resumeWork);
  sidebar.setManager(p?.manager);
  sidebar.setShareMcp(p?.shareMcp);
  sidebar.setReloadMcp(p?.reloadMcp);
  sidebar.setFallback(p?.fallback);
  sidebar.setSleep(p?.sleepMinutes);
  sidebar.setEngineRows(p);
  if (typeof p?.theme === 'string') themeSetting = p.theme;
  applyThemeChoice();
}).catch((e) => console.error(e));

$('empty-add').addEventListener('click', addProject);
$('tab-add').addEventListener('click', () => addTab(activeId));

// ⌘V (Ctrl+Shift+V on Linux; from the menu): smart paste into the focused terminal; normal paste outside it (e.g. account name).
api.clipboard.onPaste?.(async () => {
  if (!(await pasteIntoFocused())) api.clipboard.nativePaste();
});

// ⌘O / ⌘1…9 (Ctrl+Shift+O / Ctrl+Shift+1…9 on Linux). A captured key does not reach the terminal (xterm).
window.addEventListener('keydown', (e) => {
  // tabs: on macOS ⇧⌘T new git worktree, ⇧⌘[ and ⇧⌘] previous/next; on Linux Shift is part of the
  // modifier, so previous/next is Ctrl+Shift+PageUp/PageDown (worktree from the "+" menu)
  if (isMac && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    if (e.code === 'KeyT') { e.preventDefault(); e.stopPropagation(); addTab(activeId, 'worktree'); return; }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') { e.preventDefault(); e.stopPropagation(); cycleTab(e.code === 'BracketLeft' ? -1 : 1); return; }
    return;
  }
  if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'PageUp' || e.code === 'PageDown')) {
    e.preventDefault(); e.stopPropagation(); cycleTab(e.code === 'PageUp' ? -1 : 1); return;
  }
  if (!isModKey(e)) return;
  const key = keyOf(e);
  // ⌘T / Ctrl+Shift+T: new tab (in a git repo, main asks: same folder or worktree)
  if (key === 't') { e.preventDefault(); e.stopPropagation(); addTab(activeId); return; }
  if (key === 'o') { e.preventDefault(); e.stopPropagation(); addProject(); return; }
  if (/^[1-9]$/.test(key)) {
    const p = projects[Number(key) - 1];
    if (p) { e.preventDefault(); e.stopPropagation(); selectProject(p.id); }
  }
}, true);

document.addEventListener('mouseup', (e) => {
  if (/** @type {Element} */ (e.target).closest('button, select, input, #sidebar, #login-overlay') || window.getSelection()?.toString()) return;
  focusActive();
});

// Draggable splitter: terminal height.
{
  const div = $('divider');
  const saved = Number(store.get('termHeight'));
  if (saved) root.style.setProperty('--term-h', saved + 'px');
  div.addEventListener('pointerdown', (e) => {
    div.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const move = (ev) => {
      const max = window.innerHeight * 0.8;
      const h = Math.round(Math.min(max, Math.max(120, window.innerHeight - ev.clientY - 8)));
      root.style.setProperty('--term-h', h + 'px');
      store.set('termHeight', h);
    };
    const up = () => {
      div.removeEventListener('pointermove', move);
      document.body.classList.remove('dragging');
      focusActive();
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up, { once: true });
  });
}

// ---- Agent details: right-hand panel when a bot is clicked in the office (agent-panel.js) ----
let agentPanel = null;
function selectAgent(id) {
  if (!agentPanel) return;
  if (id) agentPanel.show(id);
  else agentPanel.hide(); // onClose clears the selection
  try { office?.setSelected?.(id || null); } catch (e) { console.error(e); }
}
try {
  const { mountAgentPanel } = await import('./agent-panel.js');
  agentPanel = mountAgentPanel($('agent-panel'), {
    anchor: $('office'),
    onClose: () => { try { office?.setSelected?.(null); } catch {} },
    onSelect: (id) => { try { office?.setSelected?.(id); } catch {} },
    loadToday: () => api.office.today?.() ?? Promise.resolve(null),
    // from panel to terminal: activate that project and focus its terminal
    onOpenProject: (name) => {
      const p = projects.find((x) => x.name === name);
      if (!p) return;
      selectProject(p.id);
      setTimeout(focusActive, 50);
    },
  });
} catch (e) {
  console.warn('Ajan paneli yüklenemedi:', e.message);
}

// ---- Token usage of a project (usage-panel.js, v3.13): opened from the "≈ $… today" line in its row ----
let usagePanel = null;
try {
  const { mountUsagePanel } = await import('./usage-panel.js');
  usagePanel = mountUsagePanel($('usage-panel'), {
    anchor: $('office'),
    load: (id) => api.tokens?.report(id) ?? Promise.resolve(null),
    onClose: () => focusActive(),
  });
} catch (e) {
  console.warn('Kullanım paneli yüklenemedi:', e.message);
}
api.tokens?.onBrief?.((list) => sidebar.setTokenBriefs(list));

// ---- Office: separate module; without it only the terminal runs ----
try {
  const { mountOffice } = await import('./office-view.js');
  office = mountOffice(/** @type {HTMLCanvasElement} */ ($('office')), { onTheme: applyTheme, onSelect: (id) => selectAgent(id) });
  setBotColor(store.get('botColor') || null);
  api.office.themes().then((t) => {
    officeThemes = t && typeof t === 'object' ? t : {};
    office.setThemes?.(officeThemes);
    applyThemeChoice();
  }).catch(() => {});
} catch (e) {
  console.warn('Ofis görünümü yüklenemedi:', e.message);
  document.body.classList.add('no-office');
}

// v3.28: this user's other Agent Offices (renderer/devices.js): Devices section, remote projects, remote desks
let machines = null;
const devices = mountDevices($('sidebar'), api, { onMachines: () => machines?.toggle() });
// v3.32 Machines panel (renderer/machines.js): every machine's resources and projects, over the office like the others
try {
  const { mountMachines } = await import('./machines.js');
  machines = mountMachines($('machines-panel'), { api, view: () => devices.view(), anchor: $('office'), onClose: () => focusActive(),
    onLogin: (device, account) => login?.openRemote({ api, device, account, view: () => devices.view() }) });   // v3.34 login relay
  devices.onView(() => { machines?.render(); login?.updateRemote(); });
  if (new URLSearchParams(location.search).has('machines')) setTimeout(() => machines?.show(), 300);
} catch (e) {
  console.warn('Makineler paneli yüklenemedi:', e.message);
}
api.office.onData((local) => {
  const d = mergeRemote(local, devices.view());
  setStats(d);
  sidebar.setStats(d?.projects);
  try { office?.setData(d); } catch (e) { console.error(e); }
  try { agentPanel?.update(d); } catch (e) { console.error(e); }
});

api.language?.onChange?.(applyLanguage);
applyLanguage(initialLang);

api.projects.onChange(applyProjects);
api.accounts.onChange?.(setAccounts);
// Backup account at the usage limit (v3.17): main moved the project (its terminals start over in the same
// conversations) or found no account to move to; the notice shows over each of its terminals.
api.accounts.onFallback?.((ev) => {
  const proj = projects.find((p) => p.id === ev?.projectId);
  const ids = proj ? ptyIdsOf(proj) : [ev?.projectId];
  if (ev?.kind === 'switched' || ev?.kind === 'returned') for (const id of ids) panes.get(id)?.term.reset({ restarting: true });
  for (const id of ids) hint(id, ev?.text || '');
});
setStats(null);
try { setAccounts(await api.accounts.list()); } catch (e) { console.error(e); }
try { applyProjects(await api.projects.list()); } catch (e) { console.error(e); render(); }

// Files dropped outside the terminal must not navigate the window to that file.
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());
