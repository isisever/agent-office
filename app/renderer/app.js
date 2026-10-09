// Her şeyi bağlar: kenar çubuğu (projeler, hesaplar), proje başına terminal(ler) (sekmeler, v3.0), ofis ve tema renkleri.
import { mountTerminal, pasteIntoFocused } from './terminal.js';
import { mountSidebar } from './sidebar.js';
import { mountLogin } from './login.js';
import { setLang, onLang, pick } from './i18n.js';
import { modLabel, isModKey, keyOf, isMac } from './platform.js';

// Düz tarayıcıda (Electron dışında) düzeni görmek için sahte window.agentOffice.
if (!window.agentOffice) await import('./dev-mock.js');

const api = window.agentOffice;
// dil ilk çizimden önce: kenar çubuğu ve başlık doğru dille kurulsun
let initialLang = null;
try { initialLang = await api.language?.get(); } catch (e) { console.error(e); }
if (initialLang) setLang(initialLang.lang);
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

const DEFAULT_THEME = { frame: '#2b1d1a', accent: '#3fb6a8', statusBg: '#231815', statusText: '#f3ead8' };
const S = {
  en: {
    appTitle: 'AGENT OFFICE',
    loginHint: 'This account is not logged in: log in with “not logged in” on the left.',
    noProject: 'no project',
    bossBusy: ' · boss busy',
    stats: (working, delivered, busy) => `${working} working · ${delivered} delivered${busy}`,
    statsTitle: 'All projects (the boss watches them all)',
    themeWarn: '⚠ theme',
    themesError: (e) => `Could not read themes.json: ${e}`,
    formatWarn: '⚠ update',
    formatError: 'A newer Agent Office plugin wrote some sessions; this app cannot read them. Update the app.',
    updateReady: (v) => `⬆ ${v} ready · restart`,
    updateTitle: 'A new version was downloaded. Restarting closes open Claude sessions (continue later with /resume).',
    updateConfirm: 'Restart Agent Office to update? Open Claude sessions will close.',
    close: 'Close',
    removeProject: (name) => `“${name}”\n\nRemove this project from the list? The folder is not touched.`,
    logout: (label) => `Log out of ${label}?`,
    removeAccountNote: (n) => `\n${n} project(s) will move to the Default account and restart.`,
    removeAccount: (label, note) => `Remove the account “${label}”?${note}`,
    showSidebar: 'Show projects',
    hideSidebar: 'Hide projects',
    emptyTitle: 'No projects yet.',
    emptyAdd: '+ Add project',
    emptyAddTitle: `Add project (${modLabel}O)`,
    emptyNote: 'Pick a folder; Claude starts there.',
    newTab: isMac ? 'New terminal in this project (⌘T; git worktree: ⇧⌘T)' : 'New terminal in this project (Ctrl+Shift+T)',
    closeTab: 'Close tab',
    mainTab: (dir) => `Main terminal (cannot be closed)\n${dir}`,
    sameTab: (dir) => `Terminal in the project folder\n${dir}`,
    worktreeTab: (branch, dir) => `Git worktree, branch ${branch}\n${dir}`,
    stopped: ' (Claude stopped)',
  },
  tr: {
    appTitle: 'AGENT OFİS',
    loginHint: 'Bu hesapta giriş yapılmamış: soldaki “giriş yok” ile giriş yap.',
    noProject: 'proje yok',
    bossBusy: ' · patron meşgul',
    stats: (working, delivered, busy) => `${working} çalışıyor · ${delivered} teslim${busy}`,
    statsTitle: 'Tüm projeler (patron hepsine bakar)',
    themeWarn: '⚠ tema',
    themesError: (e) => `themes.json okunamadı: ${e}`,
    formatWarn: '⚠ güncelle',
    formatError: 'Bazı oturumları daha yeni bir Agent Office eklentisi yazmış; bu uygulama onları okuyamıyor. Uygulamayı güncelle.',
    updateReady: (v) => `⬆ ${v} hazır · yeniden başlat`,
    updateTitle: 'Yeni sürüm indirildi. Yeniden başlatınca açık Claude oturumları kapanır (sonra /resume ile devam edebilirsin).',
    updateConfirm: 'Agent Office yeniden başlatılıp güncellensin mi? Açık Claude oturumları kapanır.',
    close: 'Kapat',
    removeProject: (name) => `“${name}”\n\nProje listeden kaldırılsın mı? Klasöre dokunulmaz.`,
    logout: (label) => `${label} hesabından çıkış yapılsın mı?`,
    removeAccountNote: (n) => `\n${n} proje Varsayılan hesaba geçer ve yeniden başlar.`,
    removeAccount: (label, note) => `“${label}” hesabı kaldırılsın mı?${note}`,
    showSidebar: 'Projeleri göster',
    hideSidebar: 'Projeleri gizle',
    emptyTitle: 'Henüz proje yok.',
    emptyAdd: '+ Proje ekle',
    emptyAddTitle: `Proje ekle (${modLabel}O)`,
    emptyNote: 'Bir klasör seç; Claude orada başlar.',
    newTab: isMac ? 'Bu projede yeni terminal (⌘T; git worktree: ⇧⌘T)' : 'Bu projede yeni terminal (Ctrl+Shift+T)',
    closeTab: 'Sekmeyi kapat',
    mainTab: (dir) => `Ana terminal (kapatılamaz)\n${dir}`,
    sameTab: (dir) => `Proje klasöründe terminal\n${dir}`,
    worktreeTab: (branch, dir) => `Git worktree, dal ${branch}\n${dir}`,
    stopped: ' (Claude kapalı)',
  },
};
const t = () => pick(S);
const isLoginId = (id) => typeof id === 'string' && id.startsWith('login:');
const BUFFER_MAX = 256 * 1024; // terminali henüz olmayan projenin verisi

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
};

let projects = [];
let activeId = null;
let status = [];
let accounts = [];
let theme = DEFAULT_THEME;
let focusName; // ofise son bildirilen proje
const panes = new Map(); // pty kimliği (projectId ya da `<projectId>:<n>`) -> { el, hint, term }
const pending = new Map(); // pty kimliği -> { data: string, exited: boolean }
const activeTab = new Map(); // projectId -> görünen sekmenin numarası (1 = ana terminal; yalnız bu pencerede)

// ---- Sekmeler (sözleşme v3.0): ilk sekme ana terminal (pty kimliği projectId), ek sekme `<projectId>:<n>` ----
const MAIN_TAB = 1;
const tabsOf = (p) => (Array.isArray(p?.tabs) ? p.tabs : []);
const tabPtyId = (projectId, n) => (n === MAIN_TAB ? projectId : `${projectId}:${n}`);
const ptyIdsOf = (p) => [p.id, ...tabsOf(p).map((x) => tabPtyId(p.id, x.n))];
/** Projede görünen sekme; kapanmış sekme ana terminale düşer. */
function tabOf(p) {
  const n = activeTab.get(p.id);
  return tabsOf(p).some((x) => x.n === n) ? n : MAIN_TAB;
}
const activeProject = () => projects.find((p) => p.id === activeId) || null;
/** Görünen terminalin pty kimliği. */
const activePty = () => { const p = activeProject(); return p ? tabPtyId(p.id, tabOf(p)) : null; };
// Giriş katmanı açıkken odak onun terminalinde kalır.
const focusActive = () => (login?.isOpen() ? login.focus() : panes.get(activePty())?.term.focus());
let login = null; // giriş katmanı (login.js)

// ---- Tema ----
function applyTheme(t) {
  theme = { ...DEFAULT_THEME, ...t };
  root.style.setProperty('--frame', theme.frame);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--status-bg', theme.statusBg);
  root.style.setProperty('--status-text', theme.statusText);
  for (const p of panes.values()) p.term.setTheme(theme);
  login?.setTheme(theme);
}

// ---- Başlık ----
function setTitleProject() {
  const p = activeProject();
  $('project').textContent = p ? p.name : t().noProject;
  $('project').title = p ? p.dir : '';
}

let lastStats = null; // dil değişince yeniden yazmak için
function setStats(d) {
  lastStats = d;
  const list = d?.projects;
  const working = Array.isArray(list)
    ? list.reduce((n, p) => n + (p.working || 0), 0)
    : (d?.workers || []).filter((w) => w.doneAt == null).length;
  const busy = d?.isBossBusy ? t().bossBusy : '';
  $('stats').textContent = t().stats(working, d?.delivered ?? 0, busy);
  $('stats').title = t().statsTitle;
  const warn = $('warn');
  // daha yeni biçimde oturum dosyası (sözleşme v2.8) tema uyarısından önce gelir
  warn.textContent = d?.newerFormat ? t().formatWarn : t().themeWarn;
  warn.hidden = !d?.themesError && !d?.newerFormat;
  warn.title = d?.newerFormat ? t().formatError : d?.themesError ? t().themesError(d.themesError) : '';
}

// ---- Güncelleme: yeni sürüm indiğinde başlıkta düğme; tıklayınca uygulama yeniden başlar ----
let updateVersion = null;
function showUpdate(version) {
  const b = $('update');
  if (!version) return;
  updateVersion = version;
  b.hidden = false;
  b.textContent = t().updateReady(version);
  b.title = t().updateTitle;
}
$('update').addEventListener('click', () => {
  if (confirm(t().updateConfirm)) api.update?.install();
});
api.update?.onReady(showUpdate);
api.update?.state().then((s) => showUpdate(s?.ready)).catch(() => {});

// ---- Terminaller: proje başına bir xterm, gizliler geçmişini korur ----
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
  close.title = t().close;
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

let shownId; // görünür terminal; yalnız değişince odak/boyut
function showActive() {
  const visible = activePty();
  for (const [id, p] of panes) p.el.hidden = id !== visible;
  $('empty').hidden = projects.length > 0;
  renderTabs();
  if (shownId === visible) return;
  shownId = visible;
  const p = panes.get(visible);
  if (p) requestAnimationFrame(() => { p.term.fit(); p.term.focus(); });
}

// Sekme şeridi yalnız projede birden çok sekme varken görünür; tek terminal eskisi gibi kalır
// (o zaman "+" terminalin sağ üst köşesinde, üzerine gelince belirir).
const baseName = (d) => String(d || '').replace(/\/+$/, '').split('/').pop() || '';
function tabButton(p, tab, active, running) {
  const n = tab?.n ?? MAIN_TAB;
  const dir = tab?.dir || p.dir;
  const b = document.createElement('div');
  b.className = 'tab' + (n === active ? ' active' : '') + (running ? '' : ' stopped') + (tab?.worktree ? ' worktree' : '');
  b.dataset.n = String(n);
  b.title = (tab?.worktree ? t().worktreeTab(tab.worktree.branch, dir) : n === MAIN_TAB ? t().mainTab(dir) : t().sameTab(dir)) + (running ? '' : t().stopped);
  const num = document.createElement('span');
  num.className = 'tab-n';
  num.textContent = String(n);
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = tab?.worktree ? `⎇ ${tab.worktree.branch}` : baseName(dir);
  b.append(num, label);
  b.addEventListener('click', () => selectTab(p.id, n));
  if (tab) {
    const x = document.createElement('button');
    x.className = 'tab-x';
    x.textContent = '×';
    x.title = t().closeTab;
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
  $('tab-add').title = t().newTab;
  if (!many) { strip.replaceChildren(); return; }
  const st = status.find((x) => x.id === p.id);
  const runningOf = (n) => (n === MAIN_TAB ? st?.isRunning !== false : st?.tabs?.find((x) => x.n === n)?.isRunning !== false);
  const active = tabOf(p);
  const add = document.createElement('button');
  add.className = 'tab-new';
  add.textContent = '+';
  add.title = t().newTab;
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
// mode verilmezse main sorar (git deposunda menü: aynı klasör / yeni worktree).
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
    // git worktree'yi kaldırmadı: claude aynı sekmede son oturumundan yeniden başladı
    if (r?.restarted) panes.get(tabPtyId(projectId, n))?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
  focusActive();
}
/** ⇧⌘[ / ⇧⌘] (Linux: Ctrl+Shift+PageUp/PageDown): etkin projede önceki/sonraki sekme. */
function cycleTab(step) {
  const p = activeProject();
  if (!p || !tabsOf(p).length) return;
  const ns = [MAIN_TAB, ...tabsOf(p).map((x) => x.n)];
  const i = ns.indexOf(tabOf(p));
  selectTab(p.id, ns[(i + step + ns.length) % ns.length]);
}

// `login:<hesap>` kimlikleri giriş katmanına gider; onlar için hiçbir zaman proje bölmesi kurulmaz.
api.pty.onData((id, d) => {
  if (isLoginId(id)) return login?.write(id, d);
  const p = panes.get(id);
  if (p) return p.term.write(d);
  const buf = pending.get(id) || { data: '', exited: false };
  buf.data = (buf.data + d).slice(-BUFFER_MAX);
  buf.exited = false;
  pending.set(id, buf);
});
api.pty.onExit((id, code) => {
  if (isLoginId(id)) return login?.exit(id, code);
  const p = panes.get(id);
  if (p) return p.term.exit();
  const buf = pending.get(id) || { data: '', exited: false };
  buf.exited = true;
  pending.set(id, buf);
});

// ---- Durum ----
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

// ---- Eylemler ----
async function addProject() {
  try {
    const p = await api.projects.add();
    if (p) applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

function selectProject(id) {
  if (!id || !projects.some((p) => p.id === id)) return;
  if (id !== activeId) {
    activeId = id; // hemen göster; onChange doğrular
    render();
    api.projects.setActive(id).catch((e) => console.error(e));
  } else focusActive();
}

async function removeProject(p) {
  if (!confirm(t().removeProject(p.name))) return focusActive();
  try {
    await api.projects.remove(p.id);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

async function setAccount(projectId, accountId) {
  // yeni hesapla bütün sekmelerde yeni claude başlar
  const proj = projects.find((p) => p.id === projectId);
  for (const id of proj ? ptyIdsOf(proj) : [projectId]) panes.get(id)?.term.reset({ restarting: true });
  hint(projectId, '');
  try {
    await api.projects.setAccount(projectId, accountId);
    applyProjects(await api.projects.list());
    if (accounts.find((a) => a.id === accountId)?.auth?.state === 'out') hint(projectId, t().loginHint);
  } catch (e) { console.error(e); }
  if (projectId !== activeId) selectProject(projectId);
  else focusActive();
}

// Yeni hesap eklenince giriş katmanı hemen açılır.
// projectId verilirse (proje satırındaki "+ Yeni hesap…") yeni hesap hemen o projeye atanır.
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
  if (a.id === 'default') return; // sistemdeki Claude Code girişi buradan kapatılmaz
  if (!confirm(t().logout(a.label))) return focusActive();
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

async function removeAccount(a) {
  const users = projects.filter((p) => p.accountId === a.id).length;
  const note = users ? t().removeAccountNote(users) : '';
  if (!confirm(t().removeAccount(a.label, note))) return;
  try { await api.accounts.remove(a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
  try { applyProjects(await api.projects.list()); } catch {}
}

// ---- Kenar çubuğu ----
sidebar = mountSidebar($('sidebar'), {
  select: selectProject,
  addProject,
  setBotColor,
  removeProject,
  setAccount,
  addAccount,
  renameAccount,
  removeAccount,
  login: (id) => openLogin(id),
  logout: logoutAccount,
  refreshAuth,
  setLanguage: (setting) => api.language?.set(setting).catch((e) => console.error(e)),
  setResume: (on) => api.prefs?.set({ resume: on }).then((p) => sidebar.setResume(p?.resume)).catch((e) => console.error(e)),
});

login = mountLogin(document.body, { getTheme: () => theme, onClose: () => focusActive() });

function setCollapsed(c) {
  document.body.classList.toggle('sidebar-collapsed', c);
  $('toggle-sidebar').title = c ? t().showSidebar : t().hideSidebar;
  store.set('sidebarCollapsed', c ? '1' : '0');
  requestAnimationFrame(() => panes.get(activePty())?.term.fit());
}
$('toggle-sidebar').addEventListener('click', () => {
  setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  focusActive();
});
// bot rengi: kullanıcı seçimi, bu bilgisayarda saklanır
function setBotColor(hex) {
  store.set('botColor', hex || '');
  office?.setBotColor?.(hex);
  sidebar.setBotColor(hex);
}

setCollapsed(store.get('sidebarCollapsed') === '1');

// ---- Dil: başlık, boş durum ve ipuçları; kenar çubuğu, ofis ve panel kendini yeniden çizer ----
function applyStaticText() {
  $('title').textContent = t().appTitle;
  $('empty-title').textContent = t().emptyTitle;
  $('empty-add').textContent = t().emptyAdd;
  $('empty-add').title = t().emptyAddTitle;
  $('empty-note').textContent = t().emptyNote;
  $('toggle-sidebar').title = document.body.classList.contains('sidebar-collapsed') ? t().showSidebar : t().hideSidebar;
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.hint-close'))) b.title = t().close;
  setTitleProject();
  setStats(lastStats);
  renderTabs();
  if (updateVersion) showUpdate(updateVersion);
}
function applyLanguage(li) {
  if (!li) return;
  setLang(li.lang);
  try { office?.setLanguage?.(li.lang); } catch (e) { console.error(e); }
  sidebar.setLanguage(li);
}
onLang(applyStaticText);
applyStaticText();
api.prefs?.get().then((p) => sidebar.setResume(p?.resume)).catch((e) => console.error(e));

$('empty-add').addEventListener('click', addProject);
$('tab-add').addEventListener('click', () => addTab(activeId));

// ⌘V (Linux'ta Ctrl+Shift+V; menüden): odaktaki terminale akıllı yapıştırma; terminal dışında (ör. hesap adı) normal yapıştırma.
api.clipboard.onPaste?.(async () => {
  if (!(await pasteIntoFocused())) api.clipboard.nativePaste();
});

// ⌘O / ⌘1…9 (Linux'ta Ctrl+Shift+O / Ctrl+Shift+1…9). Yakalanan tuş terminale (xterm) ulaşmaz.
window.addEventListener('keydown', (e) => {
  // sekmeler: macOS'ta ⇧⌘T yeni git worktree, ⇧⌘[ ve ⇧⌘] önceki/sonraki; Linux'ta Shift değiştiricinin
  // parçası olduğu için önceki/sonraki Ctrl+Shift+PageUp/PageDown (worktree "+" menüsünden)
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
  // ⌘T / Ctrl+Shift+T: yeni sekme (git deposunda main aynı klasör mü worktree mi diye sorar)
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

// Sürüklenebilir ayraç: terminal yüksekliği.
{
  const div = $('divider');
  const saved = Number(store.get('termHeight'));
  if (saved) root.style.setProperty('--term-h', saved + 'px');
  div.addEventListener('pointerdown', (e) => {
    div.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const move = (ev) => {
      const max = window.innerHeight * 0.45;
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

// ---- Ajan ayrıntıları: ofiste bota tıklayınca sağdaki panel (agent-panel.js) ----
let agentPanel = null;
function selectAgent(id) {
  if (!agentPanel) return;
  if (id) agentPanel.show(id);
  else agentPanel.hide(); // onClose seçimi temizler
  try { office?.setSelected?.(id || null); } catch (e) { console.error(e); }
}
try {
  const { mountAgentPanel } = await import('./agent-panel.js');
  agentPanel = mountAgentPanel($('agent-panel'), {
    anchor: $('office'),
    onClose: () => { try { office?.setSelected?.(null); } catch {} },
    onSelect: (id) => { try { office?.setSelected?.(id); } catch {} },
    loadToday: () => api.office.today?.() ?? Promise.resolve(null),
    // panelden terminale: o projeyi etkinleştir ve terminaline odaklan
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

// ---- Ofis: ayrı modül; yoksa yalnızca terminal çalışır ----
try {
  const { mountOffice } = await import('./office-view.js');
  office = mountOffice(/** @type {HTMLCanvasElement} */ ($('office')), { onTheme: applyTheme, onSelect: (id) => selectAgent(id) });
  setBotColor(store.get('botColor') || null);
  api.office.themes().then((t) => office.setThemes?.(t)).catch(() => {});
} catch (e) {
  console.warn('Ofis görünümü yüklenemedi:', e.message);
  document.body.classList.add('no-office');
}

api.office.onData((d) => {
  setStats(d);
  sidebar.setStats(d?.projects);
  try { office?.setData(d); } catch (e) { console.error(e); }
  try { agentPanel?.update(d); } catch (e) { console.error(e); }
});

api.language?.onChange?.(applyLanguage);
applyLanguage(initialLang);

api.projects.onChange(applyProjects);
api.accounts.onChange?.(setAccounts);
setStats(null);
try { setAccounts(await api.accounts.list()); } catch (e) { console.error(e); }
try { applyProjects(await api.projects.list()); } catch (e) { console.error(e); render(); }

// Terminal dışına bırakılan dosyalar pencereyi o dosyaya götürmesin.
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());
