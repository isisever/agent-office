// Her şeyi bağlar: kenar çubuğu (projeler, hesaplar), proje başına terminal, ofis ve tema renkleri.
import { mountTerminal, pasteIntoFocused } from './terminal.js';
import { mountSidebar } from './sidebar.js';
import { mountLogin } from './login.js';
import { setLang, onLang, pick } from './i18n.js';

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
    emptyAddTitle: 'Add project (⌘O)',
    emptyNote: 'Pick a folder; Claude starts there.',
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
    emptyAddTitle: 'Proje ekle (⌘O)',
    emptyNote: 'Bir klasör seç; Claude orada başlar.',
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
const panes = new Map(); // projectId -> { el, hint, term }
const pending = new Map(); // projectId -> { data: string, exited: boolean }

const activeProject = () => projects.find((p) => p.id === activeId) || null;
// Giriş katmanı açıkken odak onun terminalinde kalır.
const focusActive = () => (login?.isOpen() ? login.focus() : panes.get(activeId)?.term.focus());
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
  warn.textContent = t().themeWarn;
  warn.hidden = !d?.themesError;
  warn.title = d?.themesError ? t().themesError(d.themesError) : '';
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

function createPane(project) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.id = project.id;
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

  const term = mountTerminal(host, { projectId: project.id, theme });
  panes.set(project.id, { el, hint: hintEl, term });
  const buf = pending.get(project.id);
  if (buf) {
    pending.delete(project.id);
    if (buf.data) term.write(buf.data);
    if (buf.exited) term.exit();
  }
}

function syncPanes() {
  const ids = new Set(projects.map((p) => p.id).filter((id) => !isLoginId(id)));
  for (const [id, p] of panes) {
    if (ids.has(id)) continue;
    p.term.destroy();
    p.el.remove();
    panes.delete(id);
  }
  for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
  for (const p of projects) if (ids.has(p.id) && !panes.has(p.id)) createPane(p);
}

let shownId; // görünür terminal; yalnız değişince odak/boyut
function showActive() {
  for (const [id, p] of panes) p.el.hidden = id !== activeId;
  $('empty').hidden = projects.length > 0;
  if (shownId === activeId) return;
  shownId = activeId;
  const p = panes.get(activeId);
  if (p) requestAnimationFrame(() => { p.term.fit(); p.term.focus(); });
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
  panes.get(projectId)?.term.reset({ restarting: true }); // yeni hesapla yeni claude başlar
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
  requestAnimationFrame(() => panes.get(activeId)?.term.fit());
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
  for (const b of document.querySelectorAll('.hint-close')) b.title = t().close;
  setTitleProject();
  setStats(lastStats);
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

// ⌘V (menüden): odaktaki terminale akıllı yapıştırma; terminal dışında (ör. hesap adı) normal yapıştırma.
api.clipboard.onPaste?.(async () => {
  if (!(await pasteIntoFocused())) api.clipboard.nativePaste();
});

window.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
  if (e.key.toLowerCase() === 'o') { e.preventDefault(); addProject(); return; }
  if (/^[1-9]$/.test(e.key)) {
    const p = projects[Number(e.key) - 1];
    if (p) { e.preventDefault(); selectProject(p.id); }
  }
}, true);

document.addEventListener('mouseup', (e) => {
  if (e.target.closest('button, select, input, #sidebar, #login-overlay') || window.getSelection()?.toString()) return;
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
  office = mountOffice($('office'), { onTheme: applyTheme, onSelect: (id) => selectAgent(id) });
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
