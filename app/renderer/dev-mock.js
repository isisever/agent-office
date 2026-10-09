// Yalnızca geliştirme: window.agentOffice yokken (index.html düz tarayıcıda açılınca) v2 API'sinin sahtesi.
// Electron'da preload window.agentOffice'u verir ve bu dosya hiç yüklenmez.
// ?empty → proje yok; ?themesError → başlıkta tema uyarısı; ?authError → üçüncü hesap 'error';
// ?loginFail → sahte giriş 1 koduyla biter ve hesap 'out' kalır.
// ?select=<işçi id | @boss | shell:<id>> → birkaç saniye sonra o bota/raf yuvasına tıklanır (ajan paneli denemesi;
// ör. ?select=m-1, ?select=shell:sh-1). ?noShells → eski veri (shells alanı yok).
const q = new URLSearchParams(location.search);
const listeners = (set = new Set()) => ({ add: (cb) => (set.add(cb), () => set.delete(cb)), emit: (...a) => set.forEach((cb) => cb(...a)) });
const ev = { projects: listeners(), data: listeners(), exit: listeners(), office: listeners(), accounts: listeners() };
let seq = 0;
const rid = () => Math.random().toString(36).slice(2, 10);

const accounts = [
  { id: 'default', label: 'Varsayılan', configDir: null, auth: { state: 'in', email: 'you@example.com', method: 'claude.ai' } },
  { id: 'is', label: 'İş', configDir: '/tmp/accounts/is', auth: { state: 'out' } },
];
if (q.has('authError')) {
  accounts.push({ id: 'kisisel', label: 'Kişisel', configDir: '/tmp/accounts/kisisel',
    auth: { state: 'error', error: 'claude bulunamadı: zsh: command not found: claude' } });
}
const realAuth = new Map(accounts.map((a) => [a.id, a.auth])); // 'checking' bittiğinde dönülecek durum
const accountsCopy = () => accounts.map((a) => ({ ...a, auth: { ...a.auth } }));
const accountsChanged = () => setTimeout(() => ev.accounts.emit(accountsCopy()));
function setAuth(id, auth) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  a.auth = auth;
  if (auth.state !== 'checking') realAuth.set(id, auth);
  accountsChanged();
}
/** Gerçekteki gibi: önce 'checking', biraz sonra asıl durum. */
function check(id, ms = 900) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  const real = realAuth.get(id) || { state: 'out' };
  a.auth = { state: 'checking' };
  accountsChanged();
  setTimeout(() => setAuth(id, real), ms);
}
const logins = new Set(); // çalışan sahte giriş pty'leri (hesap kimliği)
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
    check(id, 500); // main: giriş pty'si kapanınca durumu yeniler
  }, 150 + lines.length * 450);
}
const projects = q.has('empty') ? [] : [
  { id: rid(), dir: '/Users/me/Projects/agent-office', name: 'agent-office', accountId: 'default' },
  { id: rid(), dir: '/Users/me/Projects/shop-api', name: 'shop-api', accountId: 'is' },
  { id: rid(), dir: '/Users/me/Projects/notlar', name: 'notlar', accountId: 'default' },
];
const running = new Map(projects.map((p, i) => [p.id, i !== 2]));
let activeId = projects[0]?.id ?? null;

const snapshot = () => ({
  projects: projects.map((p) => ({ ...p })),
  activeId,
  status: projects.map((p) => ({ id: p.id, isRunning: !!running.get(p.id) })),
});
const changed = () => setTimeout(() => ev.projects.emit(snapshot()));

function boot(id) {
  running.set(id, true);
  const p = projects.find((x) => x.id === id);
  const acc = accounts.find((a) => a.id === p?.accountId);
  setTimeout(() => ev.data.emit(id,
    `\x1b[38;5;173m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m (sahte)\r\n\r\n` +
    `  cwd: ${p?.dir}\r\n  hesap: ${acc?.label}\r\n\r\n> `), 50);
  changed();
}
for (const p of projects) if (running.get(p.id)) boot(p.id);
for (const p of projects) if (!running.get(p.id)) setTimeout(() => ev.exit.emit(p.id, 1), 80);

const names = ['yeni-proje', 'web-sitesi', 'mobil-uygulama', 'raporlar'];

window.agentOffice = {
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
    setAccount: async (id, accountId) => {
      const p = projects.find((x) => x.id === id);
      if (p) p.accountId = accountId;
      ev.exit.emit(id, 0);
      boot(id);
    },
    onChange: ev.projects.add,
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
    remove: async (id) => {
      if (id === 'default') return;
      const i = accounts.findIndex((a) => a.id === id);
      if (i >= 0) accounts.splice(i, 1);
      for (const p of projects) if (p.accountId === id) { p.accountId = 'default'; boot(p.id); }
      changed();
    },
    onChange: ev.accounts.add,
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
  pty: {
    write: (id, d) => {
      if (id.startsWith('login:')) return; // sahte giriş girdi beklemez
      setTimeout(() => ev.data.emit(id, d === '\r' ? '\r\n> ' : d));
    },
    resize: () => {},
    onData: ev.data.add,
    onExit: ev.exit.add,
    restart: (id) => boot(id),
  },
  office: {
    onData: ev.office.add,
    themes: async () => ({}),
  },
  clipboard: { hasImage: async () => false, read: async () => ({ hasImage: false, text: '', files: [] }), onPaste: () => () => {}, nativePaste: () => document.execCommand('paste') },
  pathForFile: () => '',
};

// ---- sahte ajanlar: ayrıntı paneli için prompt/detail/history/result; biri eski biçimde (alanlar yok) ----
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
    const n = Math.floor((now - (T0 - startAgo)) / 4000); // 4 sn'de bir yeni araç
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
    // eski eklenti: yalnız temel alanlar
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

// ---- sahte arka plan komutları (sunucu odası): ikisi çalışıyor, biri bitti (0), biri başarısız ----
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
  // gerçek tıklama yolu: core.mjs kutusundan tuval pikseline, oradan CSS pikseline
  const want = q.get('select');
  setTimeout(async () => {
    const { hitBoxes } = await import('../src/office/core.mjs');
    const canvas = document.getElementById('office');
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
  const workers = mockWorkers();
  const per = projects.map((p, i) => ({
    name: p.name,
    working: workers.filter((w) => w.project === p.name && w.doneAt == null).length,
    delivered: i * 2 + 1,
    isBossBusy: i === 1,
  }));
  ev.office.emit({
    workers,
    delivered: per.reduce((n, p) => n + p.delivered, 0),
    isBossBusy: per.some((p) => p.isBossBusy),
    projects: per,
    project: projects[0]?.name ?? '',
    sessionId: '',
    ...(q.has('noShells') ? {} : { shells: mockShells() }),
    ...(q.has('themesError') ? { themesError: 'Unexpected token } in JSON at position 120' } : {}),
  });
}, 500);
