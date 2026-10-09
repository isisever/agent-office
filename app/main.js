// Agent Office shell: window, projects, accounts, one claude pty per project (several with tabs), and office data.
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, Notification, shell: eShell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pty = require('node-pty');
const P = require('./src/projects.js');
const A = require('./src/accounts.js');
const U = require('./src/usage.js');
const N = require('./src/attention.js');
const OS = require('./src/platform.js');
const L = require('./src/locales.js');
const IS_MAC = OS.isMac();

let win = null;
let poll = null;
let state = null;            // { projects, accounts, activeId }
let isLoaded = false;        // renderer loaded?: ptys start only then (so early output isn't lost)
const terms = new Map();     // pty id → pty: main tab projectId, extra tab `<projectId>:<n>` (see projects.js tabPtyId)
const logins = new Map();    // 'login:<accountId>' → `claude auth login` pty (not part of projects:changed)
const sizes = new Map();     // pty id → { cols, rows } (last pty:resize)
const auths = new Map();     // accountId → AccountAuth (in memory only)
const usages = new Map();    // accountId → AccountUsage (also kept in usage/<accountId>/last.json)
const ptyOf = (id) => terms.get(id) || logins.get(id);
let lastSize = { cols: 100, rows: 16 };

// If sessions.js fails to load, the office carries on with empty data.
let sessions = null;
function office() {
  if (!sessions) {
    try { sessions = require('./src/sessions.js'); } catch { return null; }
  }
  return sessions;
}

const statePath = () => path.join(app.getPath('userData'), 'state.json');
const accountsRoot = () => path.join(app.getPath('userData'), 'accounts');
const usageRoot = () => path.join(app.getPath('userData'), 'usage');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
// Unknown keys are kept; the old `lastProject` is dropped after migration.
function saveState() {
  try {
    const { lastProject, ...rest } = loadState();
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ ...rest, ...state }, null, 2));
  } catch {}
}

const send = (ch, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); };
const snapshot = () => ({
  projects: state.projects,
  activeId: state.activeId,
  status: state.projects.map((p) => ({
    id: p.id, isRunning: terms.has(p.id), attention: attention.get(p.id) || null,
    tabs: P.tabsOf(p).map((t) => ({ n: t.n, isRunning: terms.has(P.tabPtyId(p.id, t.n)) })),
  })),
});
const broadcast = () => send('projects:changed', snapshot());

// --- waiting for you (see src/attention.js): notification, Dock badge, marker on the project row
let attnState = N.emptyAttention();
let attention = new Map();    // projectId → 'permission' | 'done'
let lastOffice = null;        // last readOffice().projects
const alerted = new Map();    // quota thresholds: "<account>:<window>:<reset>" → percent
const seenId = () => (win && !win.isDestroyed() && win.isFocused() ? state.activeId : null);
function notify(title, body, projectId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (projectId && P.findProject(state, projectId)) commit(P.setActive(state, projectId));
  });
  n.show();
}
function updateAttention() {
  if (!lastOffice) return;
  const r = N.nextAttention(attnState, state.projects, lastOffice, seenId(), sessionAliases());
  attnState = r.state;
  for (const ev of r.events) {
    const p = P.findProject(state, ev.id);
    if (!p) continue;
    notify(p.name, ev.kind === 'permission' ? (ev.tool ? T('main.notifyPermissionTool', { tool: ev.tool }) : T('main.notifyPermission')) : T('main.notifyDone'), p.id);
  }
  const key = (m) => JSON.stringify([...m]);
  if (key(r.attention) === key(attention)) return;
  attention = r.attention;
  // macOS: Dock badge; Linux: app counter on desktops that support it (Unity launcher)
  try {
    if (app.dock) app.dock.setBadge(attention.size ? String(attention.size) : '');
    else app.setBadgeCount(attention.size);
  } catch {}
  broadcast();
}
function alertUsage(account, usage, seed = false) {
  for (const a of N.usageAlerts(account.id, usage, alerted, { seed })) {
    const when = a.resetsAt ? new Date(a.resetsAt).toLocaleString(uiLang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const label = account.id === A.DEFAULT_ID ? T('main.defaultAccount') : account.label;
    notify(label, T(a.window === 'fiveHour' ? 'main.usageFiveHour' : 'main.usageWeek', { pct: a.pct }) + (when ? T('main.usageResets', { when }) : ''));
  }
}

// Change the state, save it, notify the renderer.
// The default account's name and known login errors are sent in the current language.
const accountList = () => A.withAuth(state.accounts, (id) => A.localizeAuth(auths.get(id), T), (id) => usages.get(id))
  .map((a) => (a.id === A.DEFAULT_ID ? { ...a, label: T('main.defaultAccount') } : a));
const sendAccounts = () => send('accounts:changed', accountList());
function commit(next, { accounts = false } = {}) {
  state = next;
  saveState();
  broadcast();
  if (accounts) sendAccounts();
}

// --- language: the setting is 'auto' or a code that has a locales/<code>.json (state.json); 'auto' is the system language.
// Strings live in locales/*.json; T('main.key', { var }) gives the current language (formatter src/i18n.mjs, loaded at startup).
const LOCALES = L.loadLocales();
const LANGUAGES = L.languagesOf(LOCALES);
const LANG_SETTINGS = ['auto', ...LANGUAGES.map((l) => l.code)];
const langSetting = () => (LANG_SETTINGS.includes(state?.language) ? state.language : 'auto');
function systemLang() {
  let l = '';
  try { l = app.getPreferredSystemLanguages()[0] || app.getLocale(); } catch {}
  return L.resolveLang(l, Object.keys(LOCALES));
}
const uiLang = () => (langSetting() === 'auto' ? systemLang() : langSetting());
/** @typedef {(key: string, vars?: Record<string, unknown>) => string} Translate */
/** @type {((lang: string) => Translate) | null} */
let makeTranslator = null;
async function loadI18n() {
  const { translator } = await import('./src/i18n.mjs');
  makeTranslator = (lang) => translator(LOCALES[lang], LOCALES[L.FALLBACK], lang);
}
/** @type {Map<string, Translate>} */
const translators = new Map();
/** @param {string} key @param {Record<string, unknown>} [vars] */
function T(key, vars) {
  if (!makeTranslator) return key;
  const lang = uiLang();
  let tr = translators.get(lang);
  if (!tr) translators.set(lang, (tr = makeTranslator(lang)));
  return tr(key, vars);
}
T.has = (key) => T(key) !== key;
const languageInfo = () => ({ setting: langSetting(), lang: uiLang(), languages: LANGUAGES });

const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

function argProject() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const i = args.indexOf('--');
  const cands = i >= 0 ? args.slice(i + 1) : args.filter((a) => !a.startsWith('-') && a !== '.');
  const dir = cands.find((a) => isDir(path.resolve(a)));
  return dir ? path.resolve(dir) : null;
}

async function pickFolder() {
  const r = await dialog.showOpenDialog(win, {
    title: T('main.pickFolder'),
    buttonLabel: T('main.pickButton'),
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: P.findProject(state, state.activeId)?.dir,
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

// The node-pty 1.1 prebuilt spawn-helper sometimes ships without the executable bit (macOS only;
// on Linux node-pty is built from source and has no spawn-helper).
function fixSpawnHelper() {
  if (!IS_MAC) return;
  const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`);
  const helper = path.join(dir, 'spawn-helper').replace('app.asar', 'app.asar.unpacked');
  try { fs.chmodSync(helper, 0o755); } catch {}
}

// Plugin: the repo's plugin/ folder in development, Resources/plugin in the packaged app. It is copied to
// userData: claude generates type files in the plugin folder and must not write inside the signed .app bundle.
// Copied once at startup: running claudes share the same folder, later ptys must not delete it.
let plugin;
function pluginDir() {
  if (plugin !== undefined) return plugin;
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'plugin') : path.join(__dirname, '..', 'plugin');
  const dest = path.join(app.getPath('userData'), 'plugin', 'agent-office');
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(bundled, dest, { recursive: true });
    plugin = dest;
  } catch (e) {
    console.error('eklenti kopyalanamadı:', e.message);
    plugin = null;
  }
  return plugin;
}

function killPty(id) {
  const map = terms.has(id) ? terms : logins;
  const t = map.get(id);
  if (!t) return;
  map.delete(id);
  try { t.kill(); } catch {}
}
function killAll() { for (const id of [...terms.keys(), ...logins.keys()]) killPty(id); }

// --- account login
const shell = () => OS.defaultShell();
const accountById = (id) => state.accounts.find((a) => a.id === id) || null;
function accountEnv(account) {
  if (account.configDir) try { fs.mkdirSync(account.configDir, { recursive: true }); } catch {}
  return A.ptyEnv(process.env, account.configDir);
}

// Non-interactive claude command, run from the login shell like the projects' ptys (PATH and rc files apply).
function runClaude(account, args, timeout) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(shell(), ['-l', '-i', '-c', A.claudeCommand(args)], {
        env: accountEnv(account), cwd: app.getPath('home'), timeout, maxBuffer: 1 << 20, killSignal: 'SIGKILL',
      }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    } catch (err) {
      return resolve({ err, stdout: '', stderr: '' });
    }
    // stdin is closed: so it doesn't hang if rc files or claude wait for input (there is a timeout too)
    try { child.stdin?.end(); } catch {}
  });
}

// One check per account; if a new request arrives while it runs, it runs once more when it finishes.
const checking = new Map();  // accountId → Promise
const again = new Set();
function checkAuth(id, { showChecking = false } = {}) {
  const account = accountById(id);
  if (!account) return Promise.resolve();
  if (showChecking && auths.get(id)?.state !== 'checking') { auths.set(id, { state: 'checking' }); sendAccounts(); }
  if (checking.has(id)) { again.add(id); return checking.get(id); }
  const run = (async () => {
    do {
      again.delete(id);
      const acc = accountById(id);
      if (!acc) break;
      const { err, stdout, stderr } = await runClaude(acc, 'auth status --json', 20000);
      if (!accountById(id)) break;
      auths.set(id, A.authFromRun(err, stdout, stderr));
      if (err && auths.get(id).state === 'error') console.error(`auth status (${id}):`, err.message);
      sendAccounts();
    } while (again.has(id));
    checking.delete(id);
  })();
  checking.set(id, run);
  return run;
}
const checkAllAuth = (opts) => Promise.all(state.accounts.map((a) => checkAuth(a.id, opts)));

let lastFocusCheck = 0;
function onFocus() {
  updateAttention();
  if (Date.now() - lastFocusCheck < 60000) return;
  lastFocusCheck = Date.now();
  checkAllAuth();
}

// `claude auth login` pty: same channel as the project ptys, id 'login:<accountId>'. One per account;
// if reopened, the previous one (left from a closed window) is killed silently so its exit doesn't mix into the new window.
function startLogin(accountId) {
  const id = A.loginPtyId(accountId);
  const account = accountById(accountId);
  if (!account || !win) return;
  const old = logins.get(id);
  if (old) { logins.delete(id); try { old.kill(); } catch {} }
  const { cols, rows } = sizes.get(id) || lastSize;
  let t;
  try {
    t = pty.spawn(shell(), ['-l', '-i', '-c', A.claudeCommand('auth login')], {
      name: 'xterm-256color',
      cols, rows,
      cwd: app.getPath('home'),
      env: accountEnv(account),
    });
  } catch (e) {
    console.error('giriş pty\'si başlatılamadı:', e.message);
    send('pty:exit', id, -1);
    return;
  }
  logins.set(id, t);
  t.onData((d) => { if (logins.get(id) === t) send('pty:data', id, d); });
  t.onExit(({ exitCode }) => {
    if (logins.get(id) !== t) return; // killed on purpose: silent
    logins.delete(id);
    send('pty:exit', id, exitCode);
    checkAuth(accountId, { showChecking: true });
  });
}

// --- account quota (see src/usage.js)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

// The script is written to userData/usage at startup (it is not run from inside the signed .app bundle).
let usageScript;
function ensureUsageScript() {
  if (usageScript !== undefined) return usageScript;
  const f = path.join(usageRoot(), 'statusline.sh');
  try {
    fs.mkdirSync(usageRoot(), { recursive: true });
    fs.writeFileSync(f, U.SCRIPT, { mode: 0o755 });
    usageScript = f;
  } catch (e) {
    console.error('status line betiği yazılamadı:', e.message);
    usageScript = null;
  }
  return usageScript;
}

// Name of the tab's quota file: main tab `<projectId>`, extra tab `<projectId>-<n>` (.json).
const usageKey = (ptyId) => String(ptyId).replace(':', '-');
// The project's --settings and the user's own status line command (from the tab's folder). The tab's files under
// previous accounts are deleted: a project whose account changed must not look like it still writes the old account's quota.
function usageStatusLine(project, configDir, dir = project.dir, key = project.id) {
  const script = ensureUsageScript();
  if (!script) return null;
  const accDir = path.join(usageRoot(), project.accountId);
  try {
    for (const a of state.accounts) {
      if (a.id !== project.accountId) fs.rmSync(path.join(usageRoot(), a.id, `${key}.json`), { force: true });
    }
    fs.mkdirSync(accDir, { recursive: true });
  } catch (e) {
    console.error('kota klasörü:', e.message);
    return null;
  }
  const user = U.userStatusLine(U.settingsPaths(dir, configDir, app.getPath('home')).map(readJson));
  return { settings: U.statusLineSettings(script, path.join(accDir, `${key}.json`), user), userCommand: user?.command };
}

// The newest of the project files in the account folders; a changed account is written to last.json and sent.
const usageSeen = new Map(); // file → mtimeMs
function loadUsageCache() {
  for (const a of state.accounts) {
    const u = U.usageFromCache(readJson(path.join(usageRoot(), a.id, U.LAST)));
    if (u) { usages.set(a.id, u); alertUsage(a, u, true); }
  }
}
function scanUsage() {
  let changed = false;
  for (const a of state.accounts) {
    const dir = path.join(usageRoot(), a.id);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n === U.LAST || !n.endsWith('.json')) continue;
      const f = path.join(dir, n);
      let mtime;
      try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      if (usageSeen.get(f) === mtime) continue;
      usageSeen.set(f, mtime);
      const u = U.usageFromStatus(readJson(f), Math.round(mtime));
      if (!u || u.updatedAt <= (usages.get(a.id)?.updatedAt || 0)) continue;
      usages.set(a.id, u);
      alertUsage(a, u);
      try { fs.writeFileSync(path.join(dir, U.LAST), JSON.stringify(u)); } catch {}
      changed = true;
    }
  }
  if (changed) sendAccounts();
}

// Is there a Claude session in the folder to resume with this account (see projects.js historyDir).
function hasHistory(dir, configDir) {
  try { return fs.readdirSync(P.historyDir(dir, configDir, app.getPath('home'))).some((f) => f.endsWith('.jsonl')); } catch { return false; }
}
const RESUME_GRACE_MS = 8000; // if --continue ends with an error within this time, claude restarts fresh

// (Re)starts a tab's claude; the id is projectId for the main tab, `<projectId>:<n>` for an extra tab.
// The size is that tab's last pty:resize. resume: continue the last session (--continue). The tab starts in its own
// folder (worktree) with the same account, plugin and status line rules. An extra tab in the same folder gets no
// --continue: so a second claude doesn't open the session the main tab is resuming.
function startPty(id, { resume = false } = {}) {
  killPty(id);
  const r = P.resolvePty(state, id);
  if (!r || !win || !isLoaded) return broadcast();
  const { project, tab, dir: cwd } = r;
  const { configDir } = A.accountOf(state, project);
  if (configDir) try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  const { cols, rows } = sizes.get(id) || lastSize;
  // the plugin path is passed as $1: paths with spaces (Application Support) cause no quoting trouble.
  // The account folder is set again after the rc files (see accounts.js ptyEnv).
  // claude's arguments are passed via "$@": the plugin path and the status line setting (for the quota, see usage.js).
  const dir = pluginDir();
  const sl = usageStatusLine(project, configDir, cwd, usageKey(id));
  const isResume = resume && (!tab || Boolean(tab.worktree)) && hasHistory(cwd, configDir);
  const args = [...(dir ? ['--plugin-dir', dir] : []), ...(sl ? ['--settings', sl.settings] : []), ...(isResume ? ['--continue'] : [])];
  const startedAt = Date.now();
  const cmd = '[ -n "$AGENT_OFFICE_CONFIG_DIR" ] && export CLAUDE_CONFIG_DIR="$AGENT_OFFICE_CONFIG_DIR"; exec claude "$@"';
  const env = { ...A.ptyEnv(process.env, configDir), AGENT_OFFICE_APP: '1' };
  delete env.AGENT_OFFICE_STATUSLINE;
  if (sl?.userCommand) env.AGENT_OFFICE_STATUSLINE = sl.userCommand;
  let t;
  try {
    t = pty.spawn(shell(), ['-l', '-i', '-c', cmd, 'claude', ...args], {
      name: 'xterm-256color',
      cols, rows,
      cwd: isDir(cwd) ? cwd : app.getPath('home'),
      env,
    });
  } catch (e) {
    console.error('pty başlatılamadı:', e.message);
    send('pty:exit', id, -1);
    return broadcast();
  }
  terms.set(id, t);
  t.onData((d) => { if (terms.get(id) === t) send('pty:data', id, d); });
  t.onExit(({ exitCode }) => {
    if (terms.get(id) !== t) return; // killed on purpose (restart/removal): silent
    terms.delete(id);
    // the session to resume was not found or could not be opened: start fresh without showing the exit to the user
    if (isResume && exitCode !== 0 && Date.now() - startedAt < RESUME_GRACE_MS) return startPty(id);
    send('pty:exit', id, exitCode);
    broadcast();
  });
  broadcast();
}

// After loading, start the claude of every project that isn't running (on reload, leave running ones alone).
// At startup (if the setting is on) every project continues from its last session.
function startMissing() {
  for (const p of state.projects) {
    for (const id of P.ptyIdsOf(p)) if (!terms.has(id)) startPty(id, { resume: state.resume !== false });
  }
}
// Restarts all of the project's tabs (account change).
const restartProject = (projectId) => {
  const p = P.findProject(state, projectId);
  if (p) for (const id of P.ptyIdsOf(p)) startPty(id);
};
// Worktree session names → project name (see projects.js sessionAliases): the office and notifications count them toward the project.
const sessionAliases = () => P.sessionAliases(state.projects);

let usagePoll = null;
function startPolling() {
  clearInterval(poll);
  clearInterval(usagePoll);
  usagePoll = setInterval(scanUsage, 3000);
  let tick = 0;
  poll = setInterval(() => {
    const s = office();
    if (!s || !win || win.isDestroyed()) return;
    // while the window is unfocused, read every two seconds instead of twice a second (battery); notifications still come
    if (!win.isFocused() && tick++ % 4 !== 0) return;
    try {
      const d = s.readOffice(state.projects.map((p) => p.name), undefined, undefined, sessionAliases());
      send('office:data', d);
      lastOffice = d.projects;
      updateAttention();
    } catch (e) { console.error('readOffice:', e.message); }
  }, 500);
}

// A folder already in the list is only activated (its claude starts if it is stopped).
function addDir(dir) {
  const r = P.addProject(state, dir);
  commit(r.state);
  if (!terms.has(r.project.id)) startPty(r.project.id);
  return r.project;
}

// --- projects
ipcMain.handle('projects:list', () => snapshot());
ipcMain.handle('projects:add', async () => {
  const dir = await pickFolder();
  return dir ? addDir(dir) : null;
});
// Removing a project closes all its tabs; worktree folders are left untouched (like the project folder).
ipcMain.handle('projects:remove', (_e, id) => {
  const p = P.findProject(state, id);
  for (const pid of p ? P.ptyIdsOf(p) : [id]) {
    killPty(pid);
    sizes.delete(pid);
    if (p) try { fs.rmSync(path.join(usageRoot(), p.accountId, `${usageKey(pid)}.json`), { force: true }); } catch {}
  }
  commit(P.removeProject(state, id));
});
ipcMain.handle('projects:setActive', (_e, id) => { commit(P.setActive(state, id)); updateAttention(); });
ipcMain.handle('projects:setAccount', (_e, id, accountId) => {
  const p = P.findProject(state, id);
  if (!p || p.accountId === accountId) return;
  const next = P.setProjectAccount(state, id, accountId);
  if (next === state) return;
  commit(next);
  restartProject(id);
});

// --- accounts
ipcMain.handle('accounts:list', () => accountList());
ipcMain.handle('accounts:add', (_e, label) => {
  const r = A.addAccount(state, label, { id: crypto.randomBytes(6).toString('hex'), root: accountsRoot() });
  try { fs.mkdirSync(r.account.configDir, { recursive: true }); } catch (e) { console.error('hesap klasörü:', e.message); }
  commit(r.state, { accounts: true });
  checkAuth(r.account.id);
  return A.withAuth([r.account], (id) => auths.get(id))[0];
});
ipcMain.handle('accounts:rename', (_e, id, label) => { commit(A.renameAccount(state, id, label), { accounts: true }); });
// The folder is not deleted: its login and history are not lost if an account is deleted by mistake.
ipcMain.handle('accounts:remove', (_e, id) => {
  const r = A.removeAccount(state, id);
  if (r.state === state) return;
  killPty(A.loginPtyId(id));
  auths.delete(id);
  usages.delete(id);
  try { fs.rmSync(path.join(usageRoot(), id), { recursive: true, force: true }); } catch {}
  commit(r.state, { accounts: true });
  for (const pid of r.moved) restartProject(pid);
});

ipcMain.handle('accounts:refreshAuth', async (_e, id) => {
  await (id ? checkAuth(id, { showChecking: true }) : checkAllAuth({ showChecking: true }));
  return accountList();
});
ipcMain.handle('accounts:login', (_e, id) => { startLogin(id); });
ipcMain.handle('accounts:logout', async (_e, id) => {
  const account = accountById(id);
  // the default account is the user's normal Claude Code login: the app does not log out of it
  if (!account || !account.configDir) return;
  auths.set(id, { state: 'checking' });
  sendAccounts();
  const { err, stderr } = await runClaude(account, 'auth logout', 20000);
  if (err) console.error(`auth logout (${id}):`, err.message, stderr);
  await checkAuth(id);
});

// --- tabs (contract v3.0): several claudes per project; the first tab is the main terminal and cannot be closed
// git runs with the app's environment (/usr/bin/git is on PATH even when launched from Finder); it never asks for a password.
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: app.getPath('home'), timeout: 30000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '').trim() || (err ? err.message : '') }));
  });
}
// If the folder is inside a git repo, the repo root (the real path git reports), otherwise null.
async function gitTop(dir) {
  if (!isDir(dir)) return null;
  const r = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

// "+" menu: same folder or new worktree (asked only in a git repo). null if nothing is chosen.
function pickTabMode() {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: T('main.tabSame'), click: () => resolve('same') },
      { label: T('main.tabWorktree'), click: () => resolve('worktree') },
    ]);
    // the click arrives shortly after the menu closes; if it doesn't, the user cancelled
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(null), 300) });
  });
}

function openTab(projectId, tab) {
  commit(P.addTab(state, projectId, tab));
  startPty(P.tabPtyId(projectId, tab.n));
  return tab;
}

// Creates a worktree in a `<repo>-wt-<n>` folder next to the repo, on branch `agent-office/<n>` (from HEAD).
// The number skips numbers whose folder or branch already exists.
async function addWorktreeTab(project) {
  const repo = await gitTop(project.dir);
  if (!repo) { await dialog.showMessageBox(win, { type: 'info', message: T('main.notGit') }); return null; }
  const list = await git(['-C', repo, 'branch', '--list', 'agent-office/*', '--format=%(refname:short)']);
  const branches = new Set(list.stdout.split('\n').map((b) => b.trim()).filter(Boolean));
  const n = P.nextTabNumber(project, (k) => fs.existsSync(P.worktreeRoot(repo, k)) || branches.has(P.worktreeBranch(k)));
  const root = P.worktreeRoot(repo, n);
  const branch = P.worktreeBranch(n);
  const r = await git(['-C', repo, 'worktree', 'add', '-b', branch, root]);
  if (!r.ok) { await dialog.showMessageBox(win, { type: 'warning', message: T('main.worktreeFailed'), detail: r.stderr }); return null; }
  let real = project.dir;
  try { real = fs.realpathSync(project.dir); } catch {}
  // the project may have been removed while waiting for the menu/git
  if (!P.findProject(state, project.id)) return null;
  return openTab(project.id, { n, dir: P.worktreeDir(repo, root, real), worktree: { root, repo, branch } });
}

// Removes the tab from the state (along with its pty, size and quota file).
function dropTab(project, n) {
  const id = P.tabPtyId(project.id, n);
  killPty(id);
  sizes.delete(id);
  try { fs.rmSync(path.join(usageRoot(), project.accountId, `${usageKey(id)}.json`), { force: true }); } catch {}
  commit(P.removeTab(state, project.id, n));
}

// mode: 'same' | 'worktree'; if not given, a git repo asks via the menu, otherwise the same folder. → Tab | null
ipcMain.handle('tabs:add', async (_e, projectId, mode) => {
  const p = P.findProject(state, projectId);
  if (!p || !win) return null;
  let m = mode === 'same' || mode === 'worktree' ? mode : null;
  if (!m) m = (await gitTop(p.dir)) ? await pickTabMode() : 'same';
  if (m === 'worktree') return addWorktreeTab(p);
  const now = P.findProject(state, projectId);
  if (m === 'same' && now) return openTab(now.id, { n: P.nextTabNumber(now) });
  return null;
});
// Asks before closing. A worktree tab also asks whether to remove the worktree; if git refuses (there are changes)
// the tab stays and its claude continues from its last session. → { closed, restarted? }
ipcMain.handle('tabs:close', async (_e, projectId, n) => {
  const p = P.findProject(state, projectId);
  const tab = P.tabsOf(p).find((t) => t.n === n);
  if (!p || !tab || !win) return { closed: false };
  if (!tab.worktree) {
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: [T('main.closeTab'), T('main.cancel')], defaultId: 0, cancelId: 1,
      message: T('main.closeTabConfirm'), detail: T('main.closeTabDetail'),
    });
    if (r.response !== 0) return { closed: false };
    dropTab(p, n);
    return { closed: true };
  }
  const w = tab.worktree;
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: [T('main.removeWorktree'), T('main.keepWorktree'), T('main.cancel')], defaultId: 0, cancelId: 2,
    message: T('main.closeWorktreeConfirm', { branch: w.branch }), detail: T('main.closeWorktreeDetail', { root: w.root }),
  });
  if (r.response === 2) return { closed: false };
  if (r.response === 1) { dropTab(p, n); return { closed: true }; }
  const id = P.tabPtyId(p.id, n);
  killPty(id); // so it isn't deleted while claude is writing in the folder
  const g = await git(['-C', w.repo, 'worktree', 'remove', w.root]);
  if (g.ok) { dropTab(p, n); return { closed: true }; }
  await dialog.showMessageBox(win, { type: 'warning', message: T('main.worktreeKept'), detail: T('main.worktreeKeptDetail', { error: g.stderr }) });
  startPty(id, { resume: true });
  return { closed: false, restarted: true };
});

// --- pty (each message carries a tab's pty id — projectId or `<projectId>:<n>` — or 'login:<accountId>')

ipcMain.on('pty:write', (_e, id, d) => ptyOf(id)?.write(d));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  if (!(cols > 0 && rows > 0)) return;
  // the login window's size must not change the projects' default size
  if (A.loginAccountId(id) === null) lastSize = { cols, rows };
  sizes.set(id, { cols, rows });
  try { ptyOf(id)?.resize(cols, rows); } catch {}
});
ipcMain.on('pty:restart', (_e, id) => {
  const acc = A.loginAccountId(id);
  if (acc === null) return startPty(id);
  killPty(id);
  startLogin(acc);
});

// Files copied in Finder: one file is public.file-url, several are NSFilenamesPboardType (plist).
// Electron 44 clipboard API: has() and readText() return Promises, there is no availableFormats/readImage.
// It doesn't see files copied in Finder; macOS's own clipboard (osascript, furl) provides them.
function macClipboardFiles() {
  // first check whether the clipboard really holds a file (furl): otherwise macOS turns plain text into a path too
  const script = 'repeat with c in (clipboard info)\n if item 1 of c is «class furl» then return POSIX path of (the clipboard as «class furl»)\nend repeat\nreturn ""';
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      const p = String(stdout || '').trim();
      resolve(!err && p.startsWith('/') ? [p] : []);
    });
  });
}
// Linux: file managers put files as text/uri-list (or x-special/gnome-copied-files).
// Electron's clipboard first, else wl-paste (Wayland) / xclip (X11); if neither exists, there are no files.
async function linuxClipboardFiles() {
  try {
    for (const item of await clipboard.read()) {
      const type = ['x-special/gnome-copied-files', 'text/uri-list'].find((t) => item.types.includes(t));
      if (!type) continue;
      const blob = await item.getType(type);
      const files = OS.filesFromUriList(blob instanceof Blob ? await blob.text() : '');
      if (files.length) return files;
    }
  } catch {}
  for (const { cmd, args } of OS.linuxClipboardCommands()) {
    const out = await new Promise((resolve) => {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    const files = OS.filesFromUriList(out);
    if (files.length) return files;
  }
  return [];
}
const clipboardFiles = () => (IS_MAC ? macClipboardFiles() : linuxClipboardFiles());
const IMAGE_TYPES = ['image/png', 'image/tiff', 'image/jpeg', 'image/gif', 'image/heic'];
async function clipboardHasImage() {
  for (const t of IMAGE_TYPES) if (await clipboard.has(t)) return true;
  return false;
}
ipcMain.handle('clipboard:read', async () => {
  const files = await clipboardFiles();
  return { files, hasImage: !files.length && await clipboardHasImage(), text: await clipboard.readText() };
});
ipcMain.on('edit:nativePaste', (e) => e.sender.paste());
ipcMain.handle('clipboard:hasImage', () => clipboardHasImage());
ipcMain.handle('office:today', () => {
  const s = office();
  return s ? s.readToday(state.projects.map((p) => p.name), undefined, undefined, sessionAliases()) : { date: '', deliveries: [], untracked: 0 };
});
// --- themes (contract v3.1): the gallery (repo themes/*.json, Resources/themes when packaged) under the user's
// ~/.claude/agent-office/themes.json. Gallery themes lose their `match` (src/themes.mjs): they apply only when picked.
/** @typedef {{ galleryThemes(files: unknown[]): Record<string, any>, mergeThemes(gallery: Record<string, any>, user: unknown): Record<string, any>, normalizeThemeSetting(v: unknown): string }} ThemesLib */
/** @type {ThemesLib | null} */
let TH = null; // loaded at startup, like src/i18n.mjs
async function loadThemesLib() {
  try { TH = await import('./src/themes.mjs'); } catch {}
}
/** @type {unknown[] | null} */
let galleryFiles = null; // read once: the gallery ships with the app and does not change while it runs
function readGalleryFiles() {
  if (galleryFiles) return galleryFiles;
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'themes') : path.join(__dirname, '..', 'themes');
  galleryFiles = [];
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      try { galleryFiles.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
    }
  } catch {}
  return galleryFiles;
}
ipcMain.handle('office:themes', () => {
  const s = office();
  let user = {};
  try { user = s ? s.readThemes() : {}; } catch {}
  try { return TH ? TH.mergeThemes(TH.galleryThemes(readGalleryFiles()), user) : user; } catch { return user; }
});

// On Linux under npm start the window icon is the repo's build/icon.png; when packaged it comes from the .desktop file.
function devIcon() {
  const icon = path.join(__dirname, 'build', 'icon.png');
  return !app.isPackaged && fs.existsSync(icon) ? { icon } : {};
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 950,
    minWidth: 900, minHeight: 640,
    backgroundColor: '#2b1d1a',
    // macOS: title bar inside the page, traffic lights above it; Linux: the window manager's normal frame
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 10 } } : devIcon()),
    title: 'Agent Office',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The window shows only its own page: no new windows, no navigating elsewhere; web links open in the browser.
  const openOutside = (url) => { if (/^https?:\/\//i.test(url)) eShell.openExternal(url).catch(() => {}); };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); openOutside(url); } });
  isLoaded = false;
  win.once('ready-to-show', () => win.show());
  win.on('focus', onFocus);
  win.on('closed', () => { killAll(); clearInterval(poll); clearInterval(usagePoll); isLoaded = false; win = null; });

  // The folder from the command line is added/activated; if there are no projects, ask for a folder.
  const arg = argProject();
  if (arg) commit(P.addProject(state, arg).state);
  if (!state.projects.length) {
    const dir = await pickFolder();
    if (dir) commit(P.addProject(state, dir).state);
  }

  // If the pty starts before the renderer sets up its size and listeners, output is lost; wait for the load.
  win.webContents.on('did-finish-load', () => { isLoaded = true; startMissing(); });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  startPolling();
}

fixSpawnHelper();
// App menu: Paste (⌘V) goes to the renderer; if focus is in the terminal, the clipboard image/file/text
// is passed to Claude Code in a suitable form, otherwise a normal paste happens.
// ---- Updates: from GitHub Releases (electron-updater). A new version downloads in the background; the title bar
// button or quitting the app installs it. Runs only in the packaged (signed) app. On Linux only the AppImage
// updates itself (latest-linux.yml); a .deb install is the package manager's job, the updater is off.
const linuxNoUpdates = () => !IS_MAC && !process.env.APPIMAGE;
let updater = null;
let updateReady = null; // downloaded version
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
function setupUpdates() {
  if (!app.isPackaged || linuxNoUpdates()) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { console.error('electron-updater yok:', e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', (info) => { updateReady = info.version; send('update:ready', info.version); });
  updater.on('error', (e) => console.error('güncelleme:', e?.message || e));
  const check = () => updater.checkForUpdates().catch((e) => console.error('güncelleme denetimi:', e?.message || e));
  setTimeout(check, 10000);
  setInterval(check, UPDATE_EVERY_MS);
}
// manual check from the menu: the result is shown in a short dialog
async function checkUpdatesNow() {
  if (!updater) return dialog.showMessageBox(win, { message: app.isPackaged && linuxNoUpdates() ? T('main.updatesManual') : T('main.updatesOnlyInstalled') });
  if (updateReady) return send('update:ready', updateReady);
  try {
    const r = await updater.checkForUpdates();
    const latest = r?.updateInfo?.version;
    if (!latest || latest === app.getVersion()) dialog.showMessageBox(win, { message: T('main.upToDate', { version: app.getVersion() }) });
    else dialog.showMessageBox(win, { message: T('main.downloading', { version: latest }) });
  } catch (e) {
    dialog.showMessageBox(win, { type: 'warning', message: T('main.updateFailed'), detail: String(e?.message || e) });
  }
}
ipcMain.handle('update:state', () => ({ version: app.getVersion(), ready: updateReady }));
ipcMain.on('update:install', () => { if (updateReady && updater) { killAll(); updater.quitAndInstall(); } });

function buildMenu() {
  const name = app.getName();
  // Linux: no hide/show roles; cut/copy/paste use Ctrl+Shift (Ctrl+C/V in the terminal go to claude,
  // Chromium's own Ctrl+C/V works in text boxes).
  const keys = OS.shortcuts();
  const hideRoles = IS_MAC ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] : [];
  /** @param {any} item @param {string | null} accelerator */
  const withKey = (item, accelerator) => (accelerator ? { ...item, accelerator } : item);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: name, submenu: [{ role: 'about' }, { label: T('main.checkUpdates'), click: () => checkUpdatesNow() }, { type: 'separator' }, ...hideRoles, { role: 'quit' }] },
    { label: T('main.edit'), submenu: [
      { role: 'undo', label: T('main.undo') }, { role: 'redo', label: T('main.redo') }, { type: 'separator' },
      withKey({ role: 'cut', label: T('main.cut') }, keys.cut), withKey({ role: 'copy', label: T('main.copy') }, keys.copy),
      { label: T('main.paste'), accelerator: keys.paste, click: () => send('edit:paste') },
      { role: 'selectAll', label: T('main.selectAll') },
    ] },
    { label: T('main.view'), submenu: [{ role: 'reload', label: T('main.reload') }, { role: 'toggleDevTools', label: T('main.devTools') }, { type: 'separator' }, { role: 'togglefullscreen', label: T('main.fullscreen') }] },
    { role: 'windowMenu', label: T('main.window') },
  ]));
}

// --- preferences: resume = continue from the last session at startup; theme = 'auto' or a theme name (v3.1)
const themeSetting = (v) => (TH ? TH.normalizeThemeSetting(v) : 'auto');
const prefs = () => ({ resume: state.resume !== false, theme: themeSetting(state.theme) });
ipcMain.handle('prefs:get', () => prefs());
ipcMain.handle('prefs:set', (_e, p) => {
  if (p && typeof p.resume === 'boolean' && p.resume !== prefs().resume) commit({ ...state, resume: p.resume });
  if (p && typeof p.theme === 'string' && themeSetting(p.theme) !== prefs().theme) commit({ ...state, theme: themeSetting(p.theme) });
  return prefs();
});

// --- language
ipcMain.handle('language:get', () => languageInfo());
ipcMain.handle('language:set', (_e, setting) => {
  if (!LANG_SETTINGS.includes(setting) || setting === langSetting()) return languageInfo();
  commit({ ...state, language: setting }, { accounts: true });
  buildMenu();
  send('language:changed', languageInfo());
  return languageInfo();
});

app.whenReady().then(async () => {
  await loadI18n();
  await loadThemesLib();
  const raw = loadState();
  state = { ...P.normalizeState(raw), language: LANG_SETTINGS.includes(raw.language) ? raw.language : 'auto', resume: raw.resume !== false, theme: themeSetting(raw.theme) };
  buildMenu();
  setupUpdates();
  saveState();
  loadUsageCache();
  lastFocusCheck = Date.now();
  checkAllAuth();
  // in the packaged app the icon comes from the .icns; under npm start set it on the Dock by hand (Linux has no app.dock)
  if (!app.isPackaged) try { app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
  return createWindow();
});
app.on('activate', () => { if (!win && state) createWindow(); });
app.on('window-all-closed', () => { killAll(); app.quit(); });
app.on('before-quit', killAll);
