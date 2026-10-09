// Agent Office kabuğu: pencere, projeler, hesaplar, her projeye bir (sekmelerle birkaç) claude pty'si ve ofis verisi.
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

let win = null;
let poll = null;
let state = null;            // { projects, accounts, activeId }
let isLoaded = false;        // renderer yüklendi mi: pty'ler ancak o zaman başlar (erken çıktı kaybolmasın)
const terms = new Map();     // pty kimliği → pty: ana sekme projectId, ek sekme `<projectId>:<n>` (bkz. projects.js tabPtyId)
const logins = new Map();    // 'login:<accountId>' → `claude auth login` pty'si (projects:changed'e girmez)
const sizes = new Map();     // pty kimliği → { cols, rows } (son pty:resize)
const auths = new Map();     // accountId → AccountAuth (yalnız bellekte)
const usages = new Map();    // accountId → AccountUsage (usage/<accountId>/last.json'da da durur)
const ptyOf = (id) => terms.get(id) || logins.get(id);
let lastSize = { cols: 100, rows: 16 };

// sessions.js yüklenemezse ofis boş veriyle devam eder.
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
// Bilinmeyen anahtarlar korunur; eski `lastProject` göçten sonra atılır.
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

// --- seni bekleyenler (bkz. src/attention.js): bildirim, Dock rozeti, proje satırındaki işaret
let attnState = N.emptyAttention();
let attention = new Map();    // projectId → 'permission' | 'done'
let lastOffice = null;        // son readOffice().projects
const alerted = new Map();    // kota eşikleri: "<hesap>:<pencere>:<sıfırlanma>" → yüzde
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
    notify(p.name, ev.kind === 'permission' ? M().notifyPermission(ev.tool) : M().notifyDone, p.id);
  }
  const key = (m) => JSON.stringify([...m]);
  if (key(r.attention) === key(attention)) return;
  attention = r.attention;
  try { app.dock?.setBadge(attention.size ? String(attention.size) : ''); } catch {}
  broadcast();
}
function alertUsage(account, usage, seed = false) {
  for (const a of N.usageAlerts(account.id, usage, alerted, { seed })) {
    const when = a.resetsAt ? new Date(a.resetsAt).toLocaleString(uiLang() === 'tr' ? 'tr-TR' : 'en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const label = account.id === A.DEFAULT_ID ? M().defaultAccount : account.label;
    notify(label, M().notifyUsage(a.window, a.pct, when));
  }
}

// Durumu değiştir, kaydet, renderer'a bildir.
// Varsayılan hesabın adı ve bilinen giriş hataları o anki dilde gider.
const accountList = () => A.withAuth(state.accounts, (id) => A.localizeAuth(auths.get(id), uiLang()), (id) => usages.get(id))
  .map((a) => (a.id === A.DEFAULT_ID ? { ...a, label: M().defaultAccount } : a));
const sendAccounts = () => send('accounts:changed', accountList());
function commit(next, { accounts = false } = {}) {
  state = next;
  saveState();
  broadcast();
  if (accounts) sendAccounts();
}

// --- dil: ayar 'auto' | 'en' | 'tr' (state.json), 'auto' sistem dilidir
const MSG = {
  tr: {
    defaultAccount: 'Varsayılan',
    pickFolder: 'Proje klasörünü seç', pickButton: 'Ekle',
    updatesOnlyInstalled: 'Güncelleme denetimi yalnızca kurulu uygulamada çalışır.',
    upToDate: (v) => `Agent Office güncel (${v}).`,
    downloading: (v) => `Yeni sürüm ${v} indiriliyor; hazır olunca başlıkta "Yeniden başlat" düğmesi çıkar.`,
    updateFailed: 'Güncelleme denetlenemedi.',
    checkUpdates: 'Güncellemeleri denetle…',
    edit: 'Düzen', undo: 'Geri al', redo: 'Yinele', cut: 'Kes', copy: 'Kopyala', paste: 'Yapıştır', selectAll: 'Tümünü seç',
    notifyPermission: (tool) => `Claude onay bekliyor${tool ? `: ${tool}` : ''}`,
    notifyDone: 'Claude işini bitirdi, seni bekliyor.',
    notifyUsage: (w, pct, when) => `${w === 'fiveHour' ? '5 saatlik' : 'Haftalık'} kotanın %${pct}'i kullanıldı${when ? ` · ${when} sıfırlanır` : ''}`,
    view: 'Görünüm', reload: 'Yeniden yükle', devTools: 'Geliştirici araçları', fullscreen: 'Tam ekran', window: 'Pencere',
    tabSame: 'Yeni terminal (aynı klasör)', tabWorktree: 'Yeni terminal, yeni git worktree\'de',
    notGit: 'Bu proje bir git deposu değil; worktree açılamaz.',
    worktreeFailed: 'Git worktree oluşturulamadı.',
    cancel: 'Vazgeç', closeTab: 'Sekmeyi kapat',
    closeTabConfirm: 'Bu sekme kapatılsın mı?', closeTabDetail: 'İçindeki Claude oturumu kapanır (sonra /resume ile devam edebilirsin).',
    closeWorktreeConfirm: (branch) => `Sekme kapatılsın mı? Worktree (${branch}) de kaldırılsın mı?`,
    closeWorktreeDetail: (root) => `${root}\n\nKaldırmak "git worktree remove" çalıştırır (zorlamadan): değişiklik varsa git reddeder ve hiçbir şey silinmez. Dal yerinde kalır.`,
    removeWorktree: 'Kapat ve worktree\'yi kaldır', keepWorktree: 'Kapat, klasör kalsın',
    worktreeKept: 'Git worktree\'yi kaldırmadı; sekme açık kaldı.',
    worktreeKeptDetail: (err) => `${err}\n\nDeğişiklikleri commit'le ya da geri al ve sekmeyi yeniden kapat; ya da "Kapat, klasör kalsın"ı seç.`,
  },
  en: {
    defaultAccount: 'Default',
    pickFolder: 'Choose the project folder', pickButton: 'Add',
    updatesOnlyInstalled: 'Checking for updates only works in the installed app.',
    upToDate: (v) => `Agent Office is up to date (${v}).`,
    downloading: (v) => `Downloading version ${v}; a "Restart" button appears in the title bar when it is ready.`,
    updateFailed: 'Could not check for updates.',
    checkUpdates: 'Check for Updates…',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    notifyPermission: (tool) => `Claude needs your approval${tool ? `: ${tool}` : ''}`,
    notifyDone: 'Claude finished and is waiting for you.',
    notifyUsage: (w, pct, when) => `${pct}% of the ${w === 'fiveHour' ? '5-hour' : 'weekly'} limit used${when ? ` · resets ${when}` : ''}`,
    view: 'View', reload: 'Reload', devTools: 'Developer Tools', fullscreen: 'Full Screen', window: 'Window',
    tabSame: 'New terminal (same folder)', tabWorktree: 'New terminal in a new git worktree',
    notGit: 'This project is not a git repository; a worktree cannot be created.',
    worktreeFailed: 'Could not create the git worktree.',
    cancel: 'Cancel', closeTab: 'Close Tab',
    closeTabConfirm: 'Close this tab?', closeTabDetail: 'Its Claude session ends (continue later with /resume).',
    closeWorktreeConfirm: (branch) => `Close this tab? Remove its worktree (${branch}) too?`,
    closeWorktreeDetail: (root) => `${root}\n\nRemoving runs "git worktree remove" (never forced): if there are changes git refuses and nothing is deleted. The branch is kept.`,
    removeWorktree: 'Close and Remove Worktree', keepWorktree: 'Close, Keep Folder',
    worktreeKept: 'Git did not remove the worktree; the tab stays open.',
    worktreeKeptDetail: (err) => `${err}\n\nCommit or discard the changes and close the tab again, or choose "Close, Keep Folder".`,
  },
};
const LANG_SETTINGS = ['auto', 'en', 'tr'];
const langSetting = () => (LANG_SETTINGS.includes(state?.language) ? state.language : 'auto');
function systemLang() {
  let l = '';
  try { l = app.getPreferredSystemLanguages()[0] || app.getLocale(); } catch {}
  return /^tr/i.test(l) ? 'tr' : 'en';
}
const uiLang = () => (langSetting() === 'auto' ? systemLang() : langSetting());
const M = () => MSG[uiLang()];
const languageInfo = () => ({ setting: langSetting(), lang: uiLang() });

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
    title: M().pickFolder,
    buttonLabel: M().pickButton,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: P.findProject(state, state.activeId)?.dir,
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

// node-pty 1.1 önceden derlenmiş spawn-helper bazen çalıştırılabilir bit'i olmadan gelir.
function fixSpawnHelper() {
  const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`);
  const helper = path.join(dir, 'spawn-helper').replace('app.asar', 'app.asar.unpacked');
  try { fs.chmodSync(helper, 0o755); } catch {}
}

// Eklenti: geliştirmede deponun plugin/ klasörü, paketlenmiş uygulamada Resources/plugin. userData'ya
// kopyalanır: claude eklenti klasörüne tip dosyaları üretir, imzalı .app paketinin içine yazmamalı.
// Açılışta bir kez kopyalanır: çalışan claude'lar aynı klasörü paylaşır, sonraki pty'ler onu silmemeli.
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

// --- hesap girişi
const shell = () => process.env.SHELL || '/bin/zsh';
const accountById = (id) => state.accounts.find((a) => a.id === id) || null;
function accountEnv(account) {
  if (account.configDir) try { fs.mkdirSync(account.configDir, { recursive: true }); } catch {}
  return A.ptyEnv(process.env, account.configDir);
}

// Etkileşimsiz claude komutu, projelerin pty'si gibi giriş kabuğundan (PATH ve rc dosyaları geçerli).
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
    // stdin kapanır: rc dosyaları ya da claude girdi beklerse askıda kalmasın (zaman aşımı da var)
    try { child.stdin?.end(); } catch {}
  });
}

// Hesap başına tek denetim; sürerken yeni istek gelirse bittiğinde bir kez daha çalışır.
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

// `claude auth login` pty'si: proje pty'leriyle aynı kanal, id 'login:<accountId>'. Hesap başına bir tane;
// yeniden açılırsa önceki (kapatılmış pencereden kalan) sessizce öldürülür, çıkışı yeni pencereye karışmaz.
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
    if (logins.get(id) !== t) return; // bilerek öldürüldü: sessiz
    logins.delete(id);
    send('pty:exit', id, exitCode);
    checkAuth(accountId, { showChecking: true });
  });
}

// --- hesap kotası (bkz. src/usage.js)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

// Betik açılışta userData/usage'a yazılır (imzalı .app paketinin içinden çalıştırılmaz).
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

// Sekmenin kota dosyasının adı: ana sekme `<projectId>`, ek sekme `<projectId>-<n>` (.json).
const usageKey = (ptyId) => String(ptyId).replace(':', '-');
// Projenin --settings'i ve kullanıcının kendi status line komutu (sekmenin klasöründen). Sekmenin önceki
// hesaplardaki dosyaları silinir: hesabı değişen proje eski hesabın kotasını yazmaya devam etmiş gibi görünmesin.
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

// Hesap klasörlerindeki proje dosyalarından en yenisi; değişen hesap last.json'a yazılır ve gönderilir.
const usageSeen = new Map(); // dosya → mtimeMs
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

// Klasörde bu hesapla sürdürülecek bir Claude oturumu var mı (bkz. projects.js historyDir).
function hasHistory(dir, configDir) {
  try { return fs.readdirSync(P.historyDir(dir, configDir, app.getPath('home'))).some((f) => f.endsWith('.jsonl')); } catch { return false; }
}
const RESUME_GRACE_MS = 8000; // --continue bu sürede hatayla biterse claude yeniden, düz başlar

// Bir sekmenin claude'unu (yeniden) başlatır; id ana sekmede projectId, ek sekmede `<projectId>:<n>`.
// Boyut o sekmenin son pty:resize'ı. resume: son oturumdan devam (--continue). Sekme kendi klasöründe
// (worktree) aynı hesap, eklenti ve status line kurallarıyla başlar. Aynı klasördeki ek sekme --continue
// almaz: ana sekmenin sürdürdüğü oturumu ikinci bir claude açmasın.
function startPty(id, { resume = false } = {}) {
  killPty(id);
  const r = P.resolvePty(state, id);
  if (!r || !win || !isLoaded) return broadcast();
  const { project, tab, dir: cwd } = r;
  const { configDir } = A.accountOf(state, project);
  if (configDir) try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  const { cols, rows } = sizes.get(id) || lastSize;
  // eklenti yolu $1 olarak geçer: boşluklu yollar (Application Support) tırnak derdi çıkarmaz.
  // Hesap klasörü rc dosyalarından sonra yeniden verilir (bkz. accounts.js ptyEnv).
  // claude'un argümanları "$@" ile geçer: eklenti yolu ve status line ayarı (kota için, bkz. usage.js).
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
    if (terms.get(id) !== t) return; // bilerek öldürüldü (yeniden başlatma/silme): sessiz
    terms.delete(id);
    // sürdürülecek oturum bulunamadı ya da açılamadı: kullanıcıya çıkış göstermeden düz başlat
    if (isResume && exitCode !== 0 && Date.now() - startedAt < RESUME_GRACE_MS) return startPty(id);
    send('pty:exit', id, exitCode);
    broadcast();
  });
  broadcast();
}

// Yüklemeden sonra çalışmayan her projenin claude'unu başlat (yeniden yüklemede çalışanlara dokunma).
// Açılışta (ayar açıksa) her proje son oturumundan devam eder.
function startMissing() {
  for (const p of state.projects) {
    for (const id of P.ptyIdsOf(p)) if (!terms.has(id)) startPty(id, { resume: state.resume !== false });
  }
}
// Projenin bütün sekmelerini yeniden başlatır (hesap değişimi).
const restartProject = (projectId) => {
  const p = P.findProject(state, projectId);
  if (p) for (const id of P.ptyIdsOf(p)) startPty(id);
};
// Worktree oturumlarının adı → proje adı (bkz. projects.js sessionAliases): ofis ve bildirimler projeye sayar.
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
    // pencere odakta değilken saniyede iki yerine iki saniyede bir oku (pil); bildirimler yine gelir
    if (!win.isFocused() && tick++ % 4 !== 0) return;
    try {
      const d = s.readOffice(state.projects.map((p) => p.name), undefined, undefined, sessionAliases());
      send('office:data', d);
      lastOffice = d.projects;
      updateAttention();
    } catch (e) { console.error('readOffice:', e.message); }
  }, 500);
}

// Listede olan klasör yalnızca etkinleşir (claude'u kapalıysa başlar).
function addDir(dir) {
  const r = P.addProject(state, dir);
  commit(r.state);
  if (!terms.has(r.project.id)) startPty(r.project.id);
  return r.project;
}

// --- projeler
ipcMain.handle('projects:list', () => snapshot());
ipcMain.handle('projects:add', async () => {
  const dir = await pickFolder();
  return dir ? addDir(dir) : null;
});
// Proje kaldırılınca bütün sekmeleri kapanır; worktree klasörlerine dokunulmaz (proje klasörü gibi).
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

// --- hesaplar
ipcMain.handle('accounts:list', () => accountList());
ipcMain.handle('accounts:add', (_e, label) => {
  const r = A.addAccount(state, label, { id: crypto.randomBytes(6).toString('hex'), root: accountsRoot() });
  try { fs.mkdirSync(r.account.configDir, { recursive: true }); } catch (e) { console.error('hesap klasörü:', e.message); }
  commit(r.state, { accounts: true });
  checkAuth(r.account.id);
  return A.withAuth([r.account], (id) => auths.get(id))[0];
});
ipcMain.handle('accounts:rename', (_e, id, label) => { commit(A.renameAccount(state, id, label), { accounts: true }); });
// Klasör silinmez: içindeki giriş ve geçmiş, yanlışlıkla silinen hesapta kaybolmasın.
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
  // varsayılan hesap kullanıcının normal Claude Code girişi: uygulama oradan çıkış yaptırmaz
  if (!account || !account.configDir) return;
  auths.set(id, { state: 'checking' });
  sendAccounts();
  const { err, stderr } = await runClaude(account, 'auth logout', 20000);
  if (err) console.error(`auth logout (${id}):`, err.message, stderr);
  await checkAuth(id);
});

// --- sekmeler (sözleşme v3.0): projede birkaç claude; ilk sekme ana terminaldir, kapanmaz
// git, uygulamanın ortamıyla (/usr/bin/git Finder'dan açılışta da PATH'te); hiçbir zaman parola sormaz.
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: app.getPath('home'), timeout: 30000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '').trim() || (err ? err.message : '') }));
  });
}
// Klasör bir git deposundaysa deponun kökü (git'in verdiği gerçek yol), değilse null.
async function gitTop(dir) {
  if (!isDir(dir)) return null;
  const r = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

// "+" menüsü: aynı klasör ya da yeni worktree (yalnız git deposunda sorulur). Seçilmezse null.
function pickTabMode() {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: M().tabSame, click: () => resolve('same') },
      { label: M().tabWorktree, click: () => resolve('worktree') },
    ]);
    // menü kapanınca tıklama birazdan gelir; gelmezse vazgeçilmiştir
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(null), 300) });
  });
}

function openTab(projectId, tab) {
  commit(P.addTab(state, projectId, tab));
  startPty(P.tabPtyId(projectId, tab.n));
  return tab;
}

// Deponun yanına `<depo>-wt-<n>` klasörü, `agent-office/<n>` dalıyla (HEAD'den) worktree açar.
// Numara, klasörü ya da dalı zaten olan numaraları atlar.
async function addWorktreeTab(project) {
  const repo = await gitTop(project.dir);
  if (!repo) { await dialog.showMessageBox(win, { type: 'info', message: M().notGit }); return null; }
  const list = await git(['-C', repo, 'branch', '--list', 'agent-office/*', '--format=%(refname:short)']);
  const branches = new Set(list.stdout.split('\n').map((b) => b.trim()).filter(Boolean));
  const n = P.nextTabNumber(project, (k) => fs.existsSync(P.worktreeRoot(repo, k)) || branches.has(P.worktreeBranch(k)));
  const root = P.worktreeRoot(repo, n);
  const branch = P.worktreeBranch(n);
  const r = await git(['-C', repo, 'worktree', 'add', '-b', branch, root]);
  if (!r.ok) { await dialog.showMessageBox(win, { type: 'warning', message: M().worktreeFailed, detail: r.stderr }); return null; }
  let real = project.dir;
  try { real = fs.realpathSync(project.dir); } catch {}
  // menü/git beklenirken proje kaldırılmış olabilir
  if (!P.findProject(state, project.id)) return null;
  return openTab(project.id, { n, dir: P.worktreeDir(repo, root, real), worktree: { root, repo, branch } });
}

// Sekmeyi durumdan çıkarır (pty, boyut ve kota dosyasıyla).
function dropTab(project, n) {
  const id = P.tabPtyId(project.id, n);
  killPty(id);
  sizes.delete(id);
  try { fs.rmSync(path.join(usageRoot(), project.accountId, `${usageKey(id)}.json`), { force: true }); } catch {}
  commit(P.removeTab(state, project.id, n));
}

// mode: 'same' | 'worktree'; verilmezse git deposunda menü sorar, değilse aynı klasör. → Tab | null
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
// Kapatmayı sorar. Worktree sekmesinde worktree kaldırılsın mı da sorulur; git reddederse (değişiklik var)
// sekme kalır ve claude'u son oturumundan devam eder. → { closed, restarted? }
ipcMain.handle('tabs:close', async (_e, projectId, n) => {
  const p = P.findProject(state, projectId);
  const tab = P.tabsOf(p).find((t) => t.n === n);
  if (!p || !tab || !win) return { closed: false };
  if (!tab.worktree) {
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: [M().closeTab, M().cancel], defaultId: 0, cancelId: 1,
      message: M().closeTabConfirm, detail: M().closeTabDetail,
    });
    if (r.response !== 0) return { closed: false };
    dropTab(p, n);
    return { closed: true };
  }
  const w = tab.worktree;
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: [M().removeWorktree, M().keepWorktree, M().cancel], defaultId: 0, cancelId: 2,
    message: M().closeWorktreeConfirm(w.branch), detail: M().closeWorktreeDetail(w.root),
  });
  if (r.response === 2) return { closed: false };
  if (r.response === 1) { dropTab(p, n); return { closed: true }; }
  const id = P.tabPtyId(p.id, n);
  killPty(id); // claude klasörde yazarken silinmesin
  const g = await git(['-C', w.repo, 'worktree', 'remove', w.root]);
  if (g.ok) { dropTab(p, n); return { closed: true }; }
  await dialog.showMessageBox(win, { type: 'warning', message: M().worktreeKept, detail: M().worktreeKeptDetail(g.stderr) });
  startPty(id, { resume: true });
  return { closed: false, restarted: true };
});

// --- pty (her mesaj bir sekmenin pty kimliği — projectId ya da `<projectId>:<n>` — ya da 'login:<accountId>' taşır)

ipcMain.on('pty:write', (_e, id, d) => ptyOf(id)?.write(d));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  if (!(cols > 0 && rows > 0)) return;
  // giriş penceresinin boyutu projelerin varsayılan boyutunu değiştirmesin
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

// Finder'da kopyalanan dosyalar: tek dosya public.file-url, birden çoksa NSFilenamesPboardType (plist).
// Electron 44 pano API'si: has() ve readText() Promise döner, availableFormats/readImage yok.
// Finder'da kopyalanan dosyaları görmez; onları macOS'un kendi panosu (osascript, furl) verir.
function clipboardFiles() {
  // önce panoda gerçekten dosya (furl) var mı bakılır: yoksa macOS düz metni de yola çevirir
  const script = 'repeat with c in (clipboard info)\n if item 1 of c is «class furl» then return POSIX path of (the clipboard as «class furl»)\nend repeat\nreturn ""';
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      const p = String(stdout || '').trim();
      resolve(!err && p.startsWith('/') ? [p] : []);
    });
  });
}
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
ipcMain.handle('office:themes', () => {
  const s = office();
  try { return s ? s.readThemes() : {}; } catch { return {}; }
});

async function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 950,
    minWidth: 900, minHeight: 640,
    backgroundColor: '#2b1d1a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    title: 'Agent Office',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Pencere yalnızca kendi sayfasını gösterir: yeni pencere ve başka adrese gitme yok; web bağlantıları tarayıcıda açılır.
  const openOutside = (url) => { if (/^https?:\/\//i.test(url)) eShell.openExternal(url).catch(() => {}); };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); openOutside(url); } });
  isLoaded = false;
  win.once('ready-to-show', () => win.show());
  win.on('focus', onFocus);
  win.on('closed', () => { killAll(); clearInterval(poll); clearInterval(usagePoll); isLoaded = false; win = null; });

  // Komut satırındaki klasör eklenir/etkinleşir; hiç proje yoksa klasör sorulur.
  const arg = argProject();
  if (arg) commit(P.addProject(state, arg).state);
  if (!state.projects.length) {
    const dir = await pickFolder();
    if (dir) commit(P.addProject(state, dir).state);
  }

  // pty, renderer boyutunu ve dinleyicilerini kurmadan önce başlarsa çıktı kaybolur; yüklemeyi bekle.
  win.webContents.on('did-finish-load', () => { isLoaded = true; startMissing(); });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  startPolling();
}

fixSpawnHelper();
// Uygulama menüsü: Yapıştır (⌘V) renderer'a gider; odak terminaldeyse panodaki görsel/dosya/metin
// Claude Code'a uygun biçimde verilir, değilse normal yapıştırma yapılır.
// ---- Güncelleme: GitHub Releases'tan (electron-updater). Yeni sürüm arka planda iner; başlıktaki düğme
// ya da uygulamadan çıkış onu kurar. Yalnız paketlenmiş (imzalı) uygulamada çalışır.
let updater = null;
let updateReady = null; // indirilmiş sürüm
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
function setupUpdates() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { console.error('electron-updater yok:', e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', (info) => { updateReady = info.version; send('update:ready', info.version); });
  updater.on('error', (e) => console.error('güncelleme:', e?.message || e));
  const check = () => updater.checkForUpdates().catch((e) => console.error('güncelleme denetimi:', e?.message || e));
  setTimeout(check, 10000);
  setInterval(check, UPDATE_EVERY_MS);
}
// menüden elle denetim: sonuç kısa bir pencereyle söylenir
async function checkUpdatesNow() {
  if (!updater) return dialog.showMessageBox(win, { message: M().updatesOnlyInstalled });
  if (updateReady) return send('update:ready', updateReady);
  try {
    const r = await updater.checkForUpdates();
    const latest = r?.updateInfo?.version;
    if (!latest || latest === app.getVersion()) dialog.showMessageBox(win, { message: M().upToDate(app.getVersion()) });
    else dialog.showMessageBox(win, { message: M().downloading(latest) });
  } catch (e) {
    dialog.showMessageBox(win, { type: 'warning', message: M().updateFailed, detail: String(e?.message || e) });
  }
}
ipcMain.handle('update:state', () => ({ version: app.getVersion(), ready: updateReady }));
ipcMain.on('update:install', () => { if (updateReady && updater) { killAll(); updater.quitAndInstall(); } });

function buildMenu() {
  const name = app.getName();
  const m = M();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: name, submenu: [{ role: 'about' }, { label: m.checkUpdates, click: () => checkUpdatesNow() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: m.edit, submenu: [
      { role: 'undo', label: m.undo }, { role: 'redo', label: m.redo }, { type: 'separator' },
      { role: 'cut', label: m.cut }, { role: 'copy', label: m.copy },
      { label: m.paste, accelerator: 'CmdOrCtrl+V', click: () => send('edit:paste') },
      { role: 'selectAll', label: m.selectAll },
    ] },
    { label: m.view, submenu: [{ role: 'reload', label: m.reload }, { role: 'toggleDevTools', label: m.devTools }, { type: 'separator' }, { role: 'togglefullscreen', label: m.fullscreen }] },
    { role: 'windowMenu', label: m.window },
  ]));
}

// --- tercihler: resume = açılışta son oturumdan devam
const prefs = () => ({ resume: state.resume !== false });
ipcMain.handle('prefs:get', () => prefs());
ipcMain.handle('prefs:set', (_e, p) => {
  if (p && typeof p.resume === 'boolean' && p.resume !== prefs().resume) commit({ ...state, resume: p.resume });
  return prefs();
});

// --- dil
ipcMain.handle('language:get', () => languageInfo());
ipcMain.handle('language:set', (_e, setting) => {
  if (!LANG_SETTINGS.includes(setting) || setting === langSetting()) return languageInfo();
  commit({ ...state, language: setting }, { accounts: true });
  buildMenu();
  send('language:changed', languageInfo());
  return languageInfo();
});

app.whenReady().then(() => {
  const raw = loadState();
  state = { ...P.normalizeState(raw), language: LANG_SETTINGS.includes(raw.language) ? raw.language : 'auto', resume: raw.resume !== false };
  buildMenu();
  setupUpdates();
  saveState();
  loadUsageCache();
  lastFocusCheck = Date.now();
  checkAllAuth();
  // paketlenmiş uygulamada ikon .icns'ten gelir; npm start'ta Dock'a elle ver
  if (!app.isPackaged) try { app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
  return createWindow();
});
app.on('activate', () => { if (!win && state) createWindow(); });
app.on('window-all-closed', () => { killAll(); app.quit(); });
app.on('before-quit', killAll);
