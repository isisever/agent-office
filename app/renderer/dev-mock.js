// Development only: a fake of the v2 API when window.agentOffice is missing (index.html opened in a plain browser).
// In Electron the preload provides window.agentOffice and this file is never loaded.
// ?empty → no projects; ?themesError → theme warning in the title bar; ?authError → third account 'error';
// ?loginFail → fake login exits with code 1 and the account stays 'out'. ?lang=en|tr → language setting (else auto: browser language).
// ?langs=en,tr,de → languages in the picker (a browser cannot list the folder; main reads locales/*.json). Default en,tr.
// ?platform=linux (or win32) → Linux / Windows title bar and Ctrl+Shift shortcuts (platform.js).
// ?asking → second project awaits approval (sign, ✋), third is done (●).
// ?agy → the second project runs Antigravity (contract v3.22/v3.23): no workers, its boss works (with ?asking it awaits
// approval), the office data carries engine 'agy' (agent panel's AGY tag) and turns as deliveries.
// ?agentsWaiting → no boss is busy but agents still work (sign and boss panel: waiting on agents).
// ?select=<worker id | @boss | shell:<id>> → clicks that bot/rack slot after a few seconds (agent panel test;
// e.g. ?select=m-1, ?select=shell:sh-1). ?noShells → old data (no shells field).
// ?tabs → three tabs in the first project (main, same folder, git worktree) with the worktree tab open (contract v3.0);
// "+" adds a fake tab without a worktree, ⇧⌘T one with a worktree; × closes without asking.
// ?longDir → the first project's folder is a long path (title bar cuts it from the left, v3.18).
// ?usage[=<n>] → opens project n's token usage panel (v3.13; default the first) after a moment.
// ?machines[=<n>] → a fake device link (v3.31/v3.32) with n paired machines (default 2; one v1, one offline from n ≥ 3); opens the Machines panel.
// ?theme=<name> → theme picker setting (v3.1; e.g. ?theme=sakura, ?theme=forest); default auto. The gallery is read from
// ../../themes/*.json, so it is there under Electron's loadFile or a static server at the repo root (/app/renderer/index.html).
import { galleryThemes, mergeThemes } from '../src/themes.mjs';
const q = new URLSearchParams(location.search);
const listeners = (set = new Set()) => ({ add: (cb) => (set.add(cb), () => set.delete(cb)), emit: (...a) => set.forEach((cb) => cb(...a)) });
const ev = { projects: listeners(), data: listeners(), exit: listeners(), office: listeners(), accounts: listeners() };
let seq = 0;
const rid = () => Math.random().toString(36).slice(2, 10);

/** @type {any[]} */
const accounts = [
  { id: 'default', label: 'Varsayılan', configDir: null, auth: { state: 'in', email: 'you@example.com', method: 'claude.ai' },
    usage: { updatedAt: Date.now() - 4 * 60e3, fiveHour: { pct: 74, resetsAt: Date.now() + 2.5 * 3600e3 }, sevenDay: { pct: 24, resetsAt: Date.now() + 4 * 86400e3 } } },
  { id: 'is', label: 'İş', configDir: '/tmp/accounts/is', auth: { state: 'out' } },
];
if (q.has('authError')) {
  accounts.push({ id: 'kisisel', label: 'Kişisel', configDir: '/tmp/accounts/kisisel',
    auth: { state: 'error', error: 'claude bulunamadı: zsh: command not found: claude' } });
}
const realAuth = new Map(accounts.map((a) => [a.id, a.auth])); // state to return to when 'checking' ends
const accountsCopy = () => accounts.map((a) => ({ ...a, auth: { ...a.auth } }));
const accountsChanged = () => setTimeout(() => ev.accounts.emit(accountsCopy()));
function setAuth(id, auth) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  a.auth = auth;
  if (auth.state !== 'checking') realAuth.set(id, auth);
  accountsChanged();
}
/** As in the real app: 'checking' first, the actual state a bit later. */
function check(id, ms = 900) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  const real = realAuth.get(id) || { state: 'out' };
  a.auth = { state: 'checking' };
  accountsChanged();
  setTimeout(() => setAuth(id, real), ms);
}
const logins = new Set(); // running fake login ptys (account id)
function fakeLogin(id) {
  if (logins.has(id)) return;
  logins.add(id);
  const a = accounts.find((x) => x.id === id);
  const pid = `login:${id}`;
  const fail = q.has('loginFail');
  const lines = [
    `\x1b[38;5;173m✻\x1b[0m claude auth login (sahte) · hesap: ${a?.label}\r\n\r\n`,
    'Tarayıcı açılıyor: \x1b[4mhttps://claude.ai/oauth/authorize?code=true&client_id=sahte\x1b[0m\r\n',
    'Tarayıcıda onay bekleniyor…\r\n',
    fail ? '\x1b[31mGiriş başarısız: zaman aşımı\x1b[0m\r\n' : '\x1b[32m✓\x1b[0m Giriş başarılı.\r\n',
  ];
  lines.forEach((l, i) => setTimeout(() => ev.data.emit(pid, l), 150 + i * 450));
  setTimeout(() => {
    logins.delete(id);
    ev.exit.emit(pid, fail ? 1 : 0);
    if (!fail && a) realAuth.set(id, { state: 'in', email: `${a.label.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[^a-z0-9]+/g, '') || 'hesap'}@example.com`, method: 'claude.ai' });
    check(id, 500); // main: refreshes the state when the login pty exits
  }, 150 + lines.length * 450);
}
const projects = q.has('empty') ? [] : [
  { id: rid(), dir: '/Users/me/Projects/agent-office', name: 'agent-office', accountId: 'default' },
  { id: rid(), dir: '/Users/me/Projects/shop-api', name: 'shop-api', accountId: 'is' },
  { id: rid(), dir: '/Users/me/Projects/notlar', name: 'notlar', accountId: 'default' },
];
if (q.has('agy') && projects[1]) /** @type {any} */ (projects[1]).engine = 'agy';
// ?cmdProject → the third project runs Command Code (v3.25; its row shows every control, contract v3.36)
if (q.has('cmdProject') && projects[2]) /** @type {any} */ (projects[2]).engine = 'commandcode';
// ?ocProject → the third project runs OpenCode (v3.40; Account shows OpenCode, its row disables what OpenCode can't take)
if (q.has('ocProject') && projects[2]) /** @type {any} */ (projects[2]).engine = 'opencode';
if (q.has('longDir') && projects[0]) projects[0].dir = '/Users/me/Documents/Clients/acme-corporation/2026/platform-rewrite/services/agent-office';
if (q.has('tabs') && projects[0]) {
  /** @type {any} */ (projects[0]).tabs = [
    { n: 2 },
    { n: 3, dir: '/Users/me/Projects/agent-office-wt-3', worktree: { root: '/Users/me/Projects/agent-office-wt-3', repo: '/Users/me/Projects/agent-office', branch: 'agent-office/3' } },
  ];
}
const tabIds = (p) => [p.id, ...(p.tabs || []).map((t) => `${p.id}:${t.n}`)];
const running = new Map(projects.flatMap((p, i) => tabIds(p).map((id) => [id, i !== 2])));
let activeId = projects[0]?.id ?? null;
/** @type {any[]} */
const mockMcp = [];

const snapshot = () => ({
  projects: projects.map((p) => ({ ...p })),
  activeId,
  status: projects.map((p, i) => ({
    id: p.id, isRunning: !!running.get(p.id), attention: q.has('asking') ? [null, 'permission', 'done'][i] ?? null : null,
    tabs: (p.tabs || []).map((t) => ({ n: t.n, isRunning: !!running.get(`${p.id}:${t.n}`) })),
  })),
});
const changed = () => setTimeout(() => ev.projects.emit(snapshot()));

function boot(id) {
  running.set(id, true);
  const [pid, n] = id.split(':');
  const p = projects.find((x) => x.id === pid);
  const tab = (/** @type {any} */ (p)?.tabs || []).find((t) => String(t.n) === n);
  const acc = accounts.find((a) => a.id === p?.accountId);
  setTimeout(() => ev.data.emit(id,
    `\x1b[38;5;173m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m (sahte)\r\n\r\n` +
    `  cwd: ${tab?.dir || p?.dir}\r\n  hesap: ${acc?.label}${tab?.worktree ? `\r\n  dal: ${tab.worktree.branch}` : ''}\r\n\r\n> `), 50);
  changed();
}
for (const p of projects) for (const id of tabIds(p)) if (running.get(id)) boot(id);
for (const p of projects) for (const id of tabIds(p)) if (!running.get(id)) setTimeout(() => ev.exit.emit(id, 1), 80);
if (q.has('tabs')) setTimeout(() => /** @type {HTMLElement | null} */ (document.querySelector('#tabs .tab[data-n="3"]'))?.click(), 1200);

const names = ['yeni-proje', 'web-sitesi', 'mobil-uygulama', 'raporlar'];

const langCodes = (q.get('langs') || 'en,tr').split(',').map((c) => c.trim()).filter(Boolean);
// names come from the files' "_name", as in main
const languages = await Promise.all(langCodes.map((code) => fetch(`../locales/${code}.json`).then((r) => r.json())
  .then((d) => ({ code, name: typeof d?._name === 'string' ? d._name : code })).catch(() => ({ code, name: code }))));
const known = (v) => langCodes.includes(v);
let langSetting = known(q.get('lang')) ? q.get('lang') : 'auto';
const systemLang = () => { const l = navigator.language.toLowerCase(); return langCodes.find((c) => c.toLowerCase() === l) || langCodes.find((c) => c.toLowerCase() === l.split('-')[0]) || 'en'; };
const langInfo = () => ({ setting: langSetting, lang: langSetting === 'auto' ? systemLang() : langSetting, languages });
const langEv = listeners();

// theme gallery (themes/*.json, as main reads it; names listed because a browser cannot list the folder) and the setting
const GALLERY = ['desert', 'graphite', 'latte', 'lavender', 'midnight', 'ocean', 'sakura', 'terminal'];
const galleryFiles = (await Promise.all(GALLERY.map((n) => fetch(`../../themes/${n}.json`).then((r) => r.json()).catch(() => null)))).filter(Boolean);
const mockThemes = mergeThemes(galleryThemes(galleryFiles), {});
let themeSetting = q.get('theme') || 'auto';
let resumeSetting = true;
let resumeWorkSetting = true;
let managerSetting = true;
let shareMcpSetting = true;
let reloadMcpSetting = true;
let fallbackSetting = true;
let sleepSetting = 30;
// "Resume unfinished work" (v3.8): the first click finds two projects with unfinished work (?unfinished=0: none);
// a stopped one starts, as main starts a lazy tab with --resume
let mockUnfinished = q.get('unfinished') !== '0';
const prefsNow = () => ({ resume: resumeSetting, resumeWork: resumeWorkSetting, theme: themeSetting, manager: managerSetting, shareMcp: shareMcpSetting, reloadMcp: reloadMcpSetting, fallback: fallbackSetting, sleepMinutes: sleepSetting, ...engineRows });
const engineRows = { showAgyAccount: null, showCmdAccount: null, showOcAccount: null }; // v3.30

window.agentOffice = {
  platform: q.get('platform') || 'darwin',
  home: '/Users/me',
  projects: {
    list: async () => snapshot(),
    add: async () => {
      const name = names[seq++ % names.length] + (seq > names.length ? `-${seq}` : '');
      const p = { id: rid(), dir: `/Users/me/Projects/${name}`, name, accountId: 'default' };
      projects.push(p);
      activeId = p.id;
      boot(p.id);
      return { ...p };
    },
    remove: async (id) => {
      const i = projects.findIndex((p) => p.id === id);
      if (i >= 0) projects.splice(i, 1);
      running.delete(id);
      if (activeId === id) activeId = projects[0]?.id ?? null;
      changed();
    },
    setActive: async (id) => { activeId = id; changed(); },
    openFolder: async () => true,
    menu: async () => {},
    setAccount: async (id, accountId) => {
      const p = projects.find((x) => x.id === id);
      if (p) p.accountId = accountId;
      for (const tid of p ? tabIds(p) : [id]) { ev.exit.emit(tid, 0); boot(tid); }
    },
    setManager: async (id, value) => {
      const p = projects.find((x) => x.id === id);
      if (p) { if (typeof value === 'boolean') p.manager = value; else delete p.manager; changed(); }
      return { restarted: [] };
    },
    setBossModel: async (id, value) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === id));
      if (p) { if (value) p.bossModel = value; else delete p.bossModel; changed(); }
      return { restarted: [] };
    },
    setAgentModel: async (id, value) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === id));
      if (p) { if (value) p.agentModel = value; else delete p.agentModel; changed(); }
      return { restarted: [] };
    },
    setBackup: async (id, value) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === id));
      if (p) { if (value) p.backupAccount = value; else delete p.backupAccount; changed(); }
    },
    setSkillPack: async () => ({ restarted: [] }), // v3.45
    setSavings: async (id, value) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === id));
      if (p) { if (value === 'off' || value === 'strict') p.savings = value; else delete p.savings; changed(); }
      return { restarted: [] };
    },
    setContextCap: async (id, value) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === id));
      if (p) { if (value) p.contextCap = value; else delete p.contextCap; changed(); }
      return { restarted: [] };
    },
    setEngine: async (id, value) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === id));
      if (p) { if (value === 'agy' || value === 'commandcode' || value === 'opencode') p.engine = value; else delete p.engine; changed(); }
      return { restarted: [] };
    },
    onChange: ev.projects.add,
  },
  // contract v3.44: one MCP list per project (names, source, type, host only; the token is never kept in the mock)
  skillPacks: { // contract v3.45
    list: async () => ({ packs: [
      { id: 'karpathy', name: 'andrej-karpathy-skills', license: 'MIT', skills: 1, defaultOn: true, paidApi: null, repo: 'multica-ai/andrej-karpathy-skills', sha: '2c606141936f', on: true, project: 'inherit', active: true },
      { id: 'scroll-craft', name: 'nateherk-design', license: 'MIT', skills: 1, defaultOn: false, paidApi: 'kie.ai', repo: 'nateherkai/scroll-craft', sha: '75d81f74e836', on: false, project: 'inherit', active: false },
    ] }),
    set: async () => ({ restarted: [] }),
  },
  mcp: {
    list: async () => ({ servers: [
      { name: 'github', source: 'user', type: 'http', host: 'api.githubcopilot.com', readOnly: true },
      { name: 'files', source: 'project', type: 'stdio', host: '', readOnly: true, approved: true },
      ...mockMcp.map((s) => ({ ...s, source: 'app', readOnly: false, hasToken: true })),
    ] }),
    add: async (f) => {
      if (!String(f?.name || '').trim()) return { ok: false, error: 'name' };
      if (!/^https?:\/\//.test(String(f?.url || ''))) return { ok: false, error: 'url' };
      let host = ''; try { host = new URL(f.url).host; } catch {}
      mockMcp.push({ id: rid(), name: String(f.name).trim().toLowerCase(), type: f.type === 'sse' ? 'sse' : 'http', host, scope: f.scope === 'all' ? 'all' : 'project' });
      return { ok: true, restarted: [] };
    },
    remove: async (id) => { const i = mockMcp.findIndex((s) => s.id === id); if (i >= 0) mockMcp.splice(i, 1); return { ok: i >= 0, restarted: [] }; },
  },

  tabs: {
    add: async (projectId, mode) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === projectId));
      if (!p) return null;
      const n = Math.max(1, ...(p.tabs || []).map((t) => t.n)) + 1;
      const root = `${p.dir}-wt-${n}`;
      const tab = mode === 'worktree' ? { n, dir: root, worktree: { root, repo: p.dir, branch: `agent-office/${n}` } } : { n };
      p.tabs = [...(p.tabs || []), tab];
      boot(`${p.id}:${n}`);
      return tab;
    },
    close: async (projectId, n) => {
      const p = /** @type {any} */ (projects.find((x) => x.id === projectId));
      if (!p) return { closed: false };
      p.tabs = (p.tabs || []).filter((t) => t.n !== n);
      if (!p.tabs.length) delete p.tabs;
      running.delete(`${projectId}:${n}`);
      changed();
      return { closed: true };
    },
  },
  accounts: {
    list: async () => accountsCopy(),
    add: async (label) => {
      const a = { id: rid(), label, configDir: `/tmp/accounts/${label}`, auth: { state: 'checking' } };
      accounts.push(a);
      realAuth.set(a.id, { state: 'out' });
      setTimeout(() => setAuth(a.id, { state: 'out' }), 1500);
      return { ...a, auth: { ...a.auth } };
    },
    rename: async (id, label) => { const a = accounts.find((x) => x.id === id); if (a) a.label = label; },
    setShare: async (id, on) => {
      const a = accounts.find((x) => x.id === id);
      if (a && a.id !== 'default') { if (on) delete a.shareDefault; else a.shareDefault = false; }
    },
    remove: async (id) => {
      if (id === 'default') return;
      const i = accounts.findIndex((a) => a.id === id);
      if (i >= 0) accounts.splice(i, 1);
      for (const p of projects) if (p.accountId === id) { p.accountId = 'default'; boot(p.id); }
      changed();
    },
    onChange: ev.accounts.add,
    onFallback: () => () => {},
    refreshAuth: async (id) => {
      for (const a of accounts) if (!id || a.id === id) check(a.id);
      return accountsCopy();
    },
    login: async (id) => fakeLogin(id),
    logout: async (id) => {
      if (id === 'default') return;
      realAuth.set(id, { state: 'out' });
      check(id, 400);
    },
  },
  // v3.24: Antigravity's login (?agy=in|out|unknown|missing; default: logged in)
  agy: (() => {
    const kind = q.get('agy') || 'in';
    const auth = kind === 'missing' ? { installed: false, state: 'missing' }
      : kind === 'in' ? { installed: true, state: 'in', email: 'you@gmail.com', method: 'google' } : { installed: true, state: kind };
    const lis = listeners();
    return {
      auth: async () => ({ ...auth }),
      login: async () => { setTimeout(() => { ev.data.emit('login:agy', 'agy (mock): sign in in the browser…\r\n'); ev.exit.emit('login:agy', 0); lis.emit({ ...auth }); }, 600); },
      onAuth: (cb) => lis.add(cb),
    };
  })(),
  // v3.30: Command Code's login (?cmd=in|out|missing; default: not installed)
  cmd: (() => {
    const kind = q.get('cmd') || 'missing';
    const auth = kind === 'missing' ? { installed: false, state: 'missing' } : { installed: true, state: kind };
    const lis = listeners();
    return {
      auth: async () => ({ ...auth }),
      login: async () => { setTimeout(() => { ev.data.emit('login:cmd', 'commandcode (mock): authorize in the browser…\r\n'); ev.exit.emit('login:cmd', 0); lis.emit({ ...auth, state: 'in' }); }, 600); },
      onAuth: (cb) => lis.add(cb),
    };
  })(),
  // v3.40: OpenCode's logins (?oc=in|out|missing; default: installed, no login: the free models)
  oc: (() => {
    const kind = q.get('oc') || 'out';
    const base = kind === 'missing' ? { installed: false, state: 'missing' } : kind === 'in' ? { installed: true, state: 'in', providers: [{ id: 'openai', type: 'oauth' }, { id: 'google', type: 'api' }] } : { installed: true, state: 'out' };
    let auth = base;
    const lis = listeners();
    return {
      auth: async () => ({ ...auth }),
      login: async (mode) => { setTimeout(() => { const say = mode === 'auth' ? 'opencode auth login' : `opencode console ${mode || 'login'}`; ev.data.emit('login:oc', `${say} (mock)…\r\n`); ev.exit.emit('login:oc', 0); auth = mode === 'logout' ? { installed: true, state: 'out', major: 1 } : { installed: true, state: 'in', major: 1, providers: [{ id: 'openai', type: 'oauth' }] }; lis.emit({ ...auth }); }, 600); },
      onAuth: (cb) => lis.add(cb),
    };
  })(),
  pty: {
    write: (id, d) => {
      if (id.startsWith('login:')) return; // fake login does not wait for input
      setTimeout(() => ev.data.emit(id, d === '\r' ? '\r\n> ' : d));
    },
    resize: () => {},
    onData: ev.data.add,
    onExit: ev.exit.add,
    restart: (id) => boot(id),
    wake: () => {},
    onSleep: () => {},
  },
  work: {
    resumeUnfinished: async () => {
      const hit = mockUnfinished ? projects.slice(1, 3) : [];
      mockUnfinished = false;
      for (const p of hit) if (!running.get(p.id)) boot(p.id);
      return { resumed: hit.map((p) => ({ id: p.id, name: p.name })), skipped: [] };
    },
    onResumed: () => () => {},
  },
  prefs: {
    get: async () => prefsNow(),
    set: async (p) => {
      if (typeof p?.resume === 'boolean') resumeSetting = p.resume;
      if (typeof p?.resumeWork === 'boolean') resumeWorkSetting = p.resumeWork;
      if (typeof p?.manager === 'boolean') managerSetting = p.manager;
      if (typeof p?.shareMcp === 'boolean') shareMcpSetting = p.shareMcp;
      if (typeof p?.reloadMcp === 'boolean') reloadMcpSetting = p.reloadMcp;
      if (typeof p?.fallback === 'boolean') fallbackSetting = p.fallback;
      if (typeof p?.theme === 'string') themeSetting = p.theme.trim() || 'auto';
      if ([0, 15, 30, 60].includes(p?.sleepMinutes)) sleepSetting = p.sleepMinutes;
      for (const k of ['showAgyAccount', 'showCmdAccount', 'showOcAccount']) if (typeof p?.[k] === 'boolean') engineRows[k] = p[k];
      return prefsNow();
    },
  },
  language: {
    get: async () => langInfo(),
    set: async (v) => { langSetting = known(v) ? v : 'auto'; setTimeout(() => langEv.emit(langInfo())); },
    onChange: langEv.add,
  },
  tokens: {
    report: async (id) => {
      const i = Math.max(0, projects.findIndex((p) => p.id === id));
      await new Promise((r) => setTimeout(r, 120)); // main reads the transcripts
      return mockTokenReport(i, projects[i]);
    },
    brief: async () => mockBriefs(),
    onBrief: (cb) => { const h = setTimeout(() => cb(mockBriefs()), 300); return () => clearTimeout(h); }, // main: ~8 s after start
  },
  office: {
    today: async () => {
      const now = Date.now();
      const row = (min, project, type, description, durMin, tools, isOk = true) =>
        ({ id: `d${min}`, project, type, description, spawnAt: now - (min + durMin) * 60e3, doneAt: now - min * 60e3, isOk, toolCount: tools });
      return {
        date: '', untracked: q.has('untracked') ? 2 : 0,
        deliveries: [
          row(3, projects[0]?.name ?? 'agent-office', 'Explore', 'Ofis tuvalinde tıklama noktalarını bul', 2, 14),
          row(25, projects[1]?.name ?? 'shop-api', 'general-purpose', 'Kısmi iade uç noktasını ekle', 18, 41),
          row(70, projects[1]?.name ?? 'shop-api', 'code-reviewer', 'İade akışını gözden geçir', 6, 9, false),
          row(130, projects[0]?.name ?? 'agent-office', 'Plan', 'Kota uyarılarını planla', 4, 6),
        ],
      };
    },
    onData: ev.office.add,
    themes: async () => mockThemes,
  },
  clipboard: { hasImage: async () => false, read: async () => ({ hasImage: false, text: '', files: [] }), onPaste: () => () => {}, nativePaste: () => document.execCommand('paste') },
  pathForFile: () => '',
};

// ---- fake token usage (contract v3.13): like main's src/token-usage.js summarize, opus 5.5 prices ----
function mockTotals(scale, subShare) {
  const tk = { input: 2.1e4, write5m: 4.2e5, write1h: 1.9e5, read: 4.6e7, output: 3.1e5 };
  for (const k in tk) tk[k] = Math.round(tk[k] * scale);
  const k = 4 / 1e6;
  const cost = { input: tk.input * k, write5m: tk.write5m * 1.25 * k, write1h: tk.write1h * 2 * k, read: tk.read * 0.05 * k, output: tk.output * 5 * k };
  const total = Object.values(tk).reduce((a, b) => a + b, 0);
  const usd = Object.values(cost).reduce((a, b) => a + b, 0);
  const n = Math.round(380 * scale);
  const part = (f) => ({ total: Math.round(total * f), fpt: (usd * f) / k, usd: usd * f, requests: Math.round(n * f) });
  return {
    tokens: tk, cost, total, fpt: usd / k, usd, requests: n, main: part(1 - subShare), sub: part(subShare),
    models: [{ model: 'claude-opus-5-5', ...part(0.93) }, { model: 'claude-haiku-5-5', ...part(0.07) }],
  };
}
// costliest sub-agent runs and the fixed prefix (contract v3.21)
/** @type {[string, string, string, number, number][]} label, agentType, model, steps, tool calls */
const MOCK_AGENTS = [
  ['Audit the transcript parser for double counting', 'general-purpose', 'claude-opus-5-5', 212, 240],
  ['Port the office canvas hit test to core.mjs', 'general-purpose', 'claude-opus-5-5', 96, 118],
  ['Ofis tuvalinde tıklama noktalarını bul', 'Explore', 'claude-opus-5-5', 58, 71],
  ['Write tests for the inbox and forgetting', 'general-purpose', 'claude-sonnet-5', 44, 52],
  ['Find where the sidebar renders the cost line', 'Explore', 'claude-haiku-5-5', 31, 40],
  ['Check the locales for missing keys', 'Explore', 'claude-haiku-5-5', 12, 14],
];
function mockAgents(scale, from) {
  const k = 4 / 1e6;
  const runs = MOCK_AGENTS.map(([label, agentType, model, steps, tools], j) => {
    const read = Math.round(steps * steps * 1500 * scale + steps * 30000);
    const tokens = { input: steps * 3, write5m: steps * 2400, write1h: 0, read, output: steps * 380 };
    const usd = (tokens.input + tokens.write5m * 1.25 + tokens.read * 0.05 + tokens.output * 5) * k;
    return { id: `a${j}`, session: 's1', label, agentType, model, steps, tools, tokens, usd, at: from + j * 3.1e6 };
  }).sort((a, b) => b.usd - a.usd);
  const usd = runs.reduce((n, r) => n + r.usd, 0);
  const long = runs.filter((r) => r.steps > 40);
  const longUsd = long.reduce((n, r) => n + r.usd, 0);
  const steps = runs.reduce((n, r) => n + r.steps, 0);
  return { count: runs.length, usd, steps, avgSteps: steps / runs.length, long: { limit: 40, count: long.length, usd: longUsd, share: longUsd / usd }, top: runs };
}
function mockPrefix(agents) {
  const part = (sessions, avg, requests, reads) => ({ sessions, avg, requests, reads, prefixReads: Math.min(avg * requests, reads), share: Math.min(1, (avg * requests) / reads) });
  const main = part(2, 41800, 310, 4.1e7);
  const sub = part(agents.count, 31900, agents.steps, agents.top.reduce((n, r) => n + r.tokens.read, 0));
  const all = part(main.sessions + sub.sessions, (main.avg * main.sessions + sub.avg * sub.sessions) / (main.sessions + sub.sessions), main.requests + sub.requests, main.reads + sub.reads);
  all.prefixReads = main.prefixReads + sub.prefixReads;
  all.share = all.prefixReads / all.reads;
  return { ...all, main, sub };
}
function mockTokenReport(i, p) {
  const now = Date.now();
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  const s = [1, 0.35, 0.06][i % 3];
  const hours = Array.from({ length: 24 }, (_, h) => {
    const at = top.getTime() - (23 - h) * 3600e3;
    const hr = new Date(at).getHours();
    const busy = hr >= 9 && hr <= 23 ? Math.abs(Math.sin(h * 1.7)) * s : 0;
    const total = Math.round(busy * 9e6);
    return { at, total, fpt: total * 0.085, usd: total * 0.085 * 4e-6 * (0.7 + (h % 5) * 0.15) };
  });
  const agents = { today: mockAgents(s, now - 6 * 3600e3), week: mockAgents(4 * s, now - 6 * 86400e3), all: mockAgents(7 * s, now - 11 * 86400e3) };
  return {
    projectId: p?.id, name: p?.name, now, since: now - 12 * 86400e3, firstAt: now - 11 * 86400e3,
    today: mockTotals(2.4 * s, 0.7), week: mockTotals(11 * s, 0.68), all: mockTotals(19 * s, 0.66), hours,
    agents, prefix: { today: mockPrefix(agents.today), week: mockPrefix(agents.week), all: mockPrefix(agents.all) },
  };
}
const mockBrief = (r) => ({ usd: r.today.usd, total: r.today.total, pct: r.today.fpt / r.today.total });
const mockBriefs = () => projects.map((p, i) => ({ id: p.id, ...mockBrief(mockTokenReport(i, p)) }));
if (q.has('usage')) {
  setTimeout(() => {
    const n = Math.max(1, Number(q.get('usage')) || 1);
    /** @type {HTMLElement | null} */ (document.querySelectorAll('.sb-cost')[n - 1])?.click();
  }, 900);
}

// ---- fake agents: prompt/detail/history/result for the details panel; one in the old format (no fields) ----
const T0 = Date.now();
const SCRIPT = {
  'm-1': [
    ['Grep', 'mountOffice in app/renderer'],
    ['Read', '/Users/me/Projects/agent-office/app/renderer/office-view.js'],
    ['Glob', 'app/src/**/*.mjs'],
    ['Read', '/Users/me/Projects/agent-office/app/src/office/core.mjs'],
    ['Bash', 'node --input-type=module --check < app/src/office/core.mjs && SNAP_DIR=/tmp/snaps node test/office.test.mjs'],
    ['Grep', 'hitTest|setSelected [in app]'],
  ],
  'm-2': [
    ['Bash', 'npm run test -- --grep "sipariş" --reporter=dot'],
    ['Edit', '/Users/me/Projects/shop-api/src/routes/orders/create-order.handler.ts'],
    ['WebFetch', 'https://docs.example.com/api/v2/payments/refunds?lang=tr#partial-refunds'],
    ['mcp__odoo__search_records', '{"model":"sale.order","domain":[["state","=","draft"]],"limit":20}'],
  ],
};
const mockWorkers = () => {
  const now = Date.now();
  const p0 = projects[0]?.name ?? 'agent-office';
  const p1 = projects[1]?.name ?? p0;
  const live = (id, startAgo) => {
    const steps = SCRIPT[id];
    const n = Math.floor((now - (T0 - startAgo)) / 4000); // a new tool every 4 s
    const history = [];
    for (let k = 0; k <= n; k++) {
      const [tool, detail] = steps[k % steps.length];
      history.push({ at: T0 - startAgo + k * 4000, tool, detail });
    }
    const cur = history[history.length - 1];
    return { tool: cur.tool, detail: cur.detail, history: history.slice(-20), toolCount: history.length };
  };
  return [
    {
      id: 'm-1', type: 'Explore', project: p0, spawnAt: T0 - 40000,
      description: 'Ofis tuvalinde tıklama noktalarını bul',
      prompt: 'app/ altında ofis görünümünün (office-view.js) tuvale nasıl çizdiğini ve core.mjs içinde botların nerede konumlandığını incele. ' +
        'Özellikle poseOf, along ve parti alanındaki dansçıların kutularını çıkar; devicePixelRatio ve CSS ölçeğinin tıklama koordinatlarını nasıl etkilediğini açıkla. ' +
        'Sonunda bir hitTest fonksiyonu için hangi verinin her karede saklanması gerektiğini, dosya ve satır numaralarıyla listele. Kod değiştirme, yalnızca rapor ver.',
      ...live('m-1', 40000),
    },
    {
      id: 'm-2', type: 'general-purpose', project: p1, spawnAt: T0 - 25000,
      description: 'Kısmi iade uç noktasını ekle',
      prompt: 'Siparişlere kısmi iade desteği ekle ve testlerini yaz.',
      ...live('m-2', 25000),
    },
    // old plugin: basic fields only
    { id: 'm-3', type: 'Plan', project: p0, spawnAt: T0 - 15000, description: 'Geçiş planı', tool: 'Read' },
    {
      id: 'm-4', type: 'code-reviewer', project: p1, spawnAt: T0 - 60000, doneAt: T0 + 6000, isOk: true,
      description: 'Ödeme modülünü gözden geçir',
      prompt: 'src/payments altındaki değişiklikleri gözden geçir.',
      history: [
        { at: T0 - 55000, tool: 'Bash', detail: 'git diff main...HEAD -- src/payments' },
        { at: T0 - 40000, tool: 'Read', detail: '/Users/me/Projects/shop-api/src/payments/refund.ts' },
        { at: T0 - 20000, tool: 'Grep', detail: 'amount_cents [in src/payments]' },
      ],
      toolCount: 3,
      result: 'Üç sorun buldum:\n1. refund.ts:42 — tutar kuruş yerine lira olarak karşılaştırılıyor.\n2. İade sonrası sipariş durumu güncellenmiyor.\n3. Testlerde kısmi iade senaryosu yok.\nGeri kalanı temiz görünüyor.',
    },
  ].filter((w) => w.doneAt == null || now < w.doneAt + 60000);
};

// ---- fake background commands (server room): two running, one done (0), one failed ----
const mockShells = () => {
  const p0 = projects[0]?.name ?? 'agent-office';
  const p1 = projects[1]?.name ?? p0;
  return [
    { id: 'sh-1', command: 'npm run dev -- --port 5173', description: 'Geliştirme sunucusunu başlat', startAt: T0 - 95000, status: 'running', project: p0 },
    { id: 'sh-2', command: 'pytest -x tests/test_orders.py --maxfail=3 -q', description: 'Sipariş testlerini arka planda çalıştır', agentId: 'm-2', startAt: T0 - 20000, status: 'running', project: p1 },
    { id: 'sh-3', command: 'npm run build', startAt: T0 - 120000, endAt: T0 - 70000, exitCode: 0, status: 'completed', project: p0 },
    { id: 'sh-4', command: 'cargo test --workspace', description: 'Rust testleri', agentId: 'm-old', startAt: T0 - 80000, endAt: T0 - 30000, exitCode: 101, status: 'failed', project: p1 },
  ];
};

if (q.has('select')) {
  // real click path: from the core.mjs box to canvas pixels, then to CSS pixels
  const want = q.get('select');
  setTimeout(async () => {
    const { hitBoxes } = await import('../src/office/core.mjs');
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('office'));
    const b = hitBoxes().find((h) => h.id === want && !h.isTag);
    if (!canvas || !b) return console.warn('seçilecek bot bulunamadı', want);
    const r = canvas.getBoundingClientRect();
    const { setGeometry } = await import('../src/office/core.mjs');
    const { LW, LH, S } = setGeometry(canvas.width, canvas.height);
    const cx = Math.floor((canvas.width - LW * S) / 2) + (b.x + b.w / 2) * S;
    const cy = Math.floor((canvas.height - LH * S) / 2) + (b.y + b.h / 2) * S;
    const x = r.left + (cx * r.width) / canvas.width;
    const y = r.top + (cy * r.height) / canvas.height;
    canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, button: 0 }));
  }, Number(q.get('after') ?? 3500));
}

setInterval(() => {
  const isAgyName = (name) => projects.some((p) => p.name === name && /** @type {any} */ (p).engine === 'agy');
  const workers = mockWorkers().filter((w) => !isAgyName(w.project));
  const per = projects.map((p, i) => ({
    name: p.name,
    .../** @type {any} */ (p).engine === 'agy' ? { engine: 'agy' } : {},
    working: workers.filter((w) => w.project === p.name && w.doneAt == null).length,
    delivered: i * 2 + 1,
    isBossBusy: !q.has('agentsWaiting') && i === 1,
    waiting: q.has('asking') && i === 1 ? { tool: 'Bash', since: Date.now() - 8000 } : null,
  }));
  ev.office.emit({
    workers,
    delivered: per.reduce((n, p) => n + p.delivered, 0),
    isBossBusy: per.some((p) => p.isBossBusy),
    isBossAsking: per.some((p) => p.waiting),
    projects: per,
    project: projects[0]?.name ?? '',
    sessionId: '',
    ...(q.has('noShells') ? {} : { shells: mockShells() }),
    ...(q.has('themesError') ? { themesError: 'Unexpected token } in JSON at position 120' } : {}),
  });
}, 500);

export {};

// ---- ?machines[=n]: a fake device link (contracts v3.28, v3.31, v3.32) for the Machines panel ----
if (q.has('machines')) {
  const n = Math.max(1, Math.min(6, Number(q.get('machines')) || 2));
  const GB = 2 ** 30;
  const res = (o) => ({ at: Date.now(), mem: { total: 16 * GB, free: 5.2 * GB }, load1: 2.4, cpus: 10, tabs: 3, agents: 2, sleeping: 1, platform: 'darwin', app: '0.14.0', ...o });
  const names = ['Laptop', 'Build box', 'Old Mac', 'Studio 2', 'Mini', 'Linux VM'];
  const lv = {
    name: 'Studio', id: 'abcd1234', pairing: null, error: null, outgoing: [], handoffs: { out: [], in: [] }, owners: [],
    self: { app: '0.14.0', res: res({}), catalog: [
      { id: 'p1', dirName: 'agent-office', state: 'running', engine: 'claude', accountLabel: 'Varsayılan' },
      { id: 'p2', dirName: 'shop', state: 'asleep', engine: 'claude', accountLabel: 'İş' },
    ] },
    devices: names.slice(0, n).map((name, i) => ({
      id: String(i + 1).repeat(64).slice(0, 64), name, addedAt: Date.now() - 86400e3, allowCommands: i === 0, allowHandoff: i === 0, allowManage: i === 0, allowAccounts: false,
      online: i !== 3, v: i === 2 ? 1 : i === 3 ? null : 2, app: i === 2 ? '' : i === 1 ? '0.13.0' : '0.14.0', caps: i === 2 || i === 3 ? [] : ['res', 'catalog'],
      res: i === 0 ? res({ mem: { total: 32 * GB, free: 20 * GB }, load1: 0.8, cpus: 12, tabs: 2, agents: 0, sleeping: 0 })
        : i === 1 ? res({ mem: { total: 64 * GB, free: 50 * GB }, load1: 7.9, cpus: 16, tabs: 1, agents: 4, sleeping: 0, platform: 'linux', app: '0.13.0' }) : null,
      catalog: i === 0 ? [{ id: 'r1', dirName: 'website', state: 'running', engine: 'claude', accountLabel: 'Kişisel' }, { id: 'r2', dirName: 'notes', state: 'stopped', engine: 'agy', accountLabel: '' }] : null,
    })),
    remotes: [],
  };
  lv.remotes = [{ device: lv.devices[0].id, name: lv.devices[0].name, at: Date.now(), projects: [{ id: 'r1', name: 'website', engine: 'claude', status: 'idle', working: 0, delivered: 3, attention: null }], workers: [], delivered: 3 }];
  const changed = listeners();
  const view = () => structuredClone(lv);
  const ok = () => Promise.resolve(view());
  const setDev = (id, k, on) => { const d = lv.devices.find((x) => x.id === id); if (d) d[k] = on; return ok(); };
  window.agentOffice.link = {
    get: ok, invite: ok, join: () => Promise.resolve({ ok: false, error: 'bad-code', view: view() }), cancel: ok,
    setName: (name) => { lv.name = name; return ok(); }, rename: (id, name) => setDev(id, 'name', name),
    setAllow: (id, on) => setDev(id, 'allowCommands', on), setAllowHandoff: (id, on) => setDev(id, 'allowHandoff', on),
    setAllowManage: (id, on) => setDev(id, 'allowManage', on), setAllowAccounts: (id, on) => setDev(id, 'allowAccounts', on),
    remove: (id) => { lv.devices = lv.devices.filter((d) => d.id !== id); return ok(); },
    handoffAnswer: ok, handoffAsk: ok, handoffKeep: ok, send: ok, handOff: () => Promise.resolve(true),
    onChange: changed.add,
  };
}
