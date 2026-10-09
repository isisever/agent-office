// Sol kenar çubuğu: PROJELER (her satır bir proje) ve HESAPLAR.
// Yapı yalnızca proje/hesap listesi değişince yeniden kurulur; ofis istatistikleri yerinde güncellenir
// (açık <select> ya da yazılan ad 500 ms'lik veriyle bozulmasın). Dil değişince her şey yeniden çizilir.
import { getLang, locale, onLang, pick } from './i18n.js';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const S = {
  en: {
    idle: 'idle',
    working: (n) => `${n} working`,
    delivered: (n) => `${n} delivered`,
    defaultLabel: 'Default',
    defaultNote: 'The Default account is your normal Claude Code login on this Mac; you cannot log out of it here.',
    authDot: { in: 'Logged in', out: 'Not logged in', checking: 'Checking login', error: 'Could not read login status' },
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    justNow: 'just now',
    minAgo: (m) => `${m} min ago`,
    hrAgo: (h) => `${h} h ago`,
    dayAgo: (d) => `${d} d ago`,
    botColor: 'Bot color',
    botColorTitle: 'Color of the bots',
    botColorReset: 'Default color',
    language: 'Language',
    languageTitle: 'Interface language (Auto follows the system)',
    auto: 'Auto',
    projects: 'PROJECTS',
    addProject: '+ Add project',
    addProjectTitle: 'Add project (⌘O)',
    accounts: 'ACCOUNTS',
    account: 'Account',
    accountTitle: 'Claude account used in this project (changing it restarts Claude)',
    newAccount: '+ New account…',
    noLogin: '⚠ not logged in',
    noLoginTitle: (label) => `“${label}” is not logged in; Claude cannot work in this project.\nClick to log in`,
    claudeRunning: 'Claude running',
    claudeStopped: 'Claude stopped',
    bossBusy: 'Boss busy',
    removeFromList: 'Remove from list',
    noProjects: 'No projects yet',
    accountName: 'Account name',
    login: 'Log in',
    loginTitle: (label) => `Log in to “${label}”`,
    loggedIn: 'logged in',
    loginMethod: 'Login method',
    logout: 'Log out',
    logoutTitle: (label) => `Log out of “${label}”`,
    checking: 'checking…',
    unknownError: 'Unknown error',
    error: 'error',
    notLoggedIn: 'not logged in',
    system: 'system',
    systemTitle: 'The system ~/.claude login.',
    refreshAuth: 'Refresh login status',
    rename: 'Rename',
    removeAccount: 'Remove account',
    newAccountTitle: 'New Claude account',
    addAccount: '+ Add account',
    fiveHour: '5 h',
    week: 'Week',
    fiveHourName: '5-hour usage',
    weekName: 'Weekly usage',
    reset: 'reset',
    used: (name, pct) => `${name}: ${pct}% used`,
    wasReset: 'Has reset',
    resetsAt: (when) => `Resets: ${when}`,
    lastInfo: (ago) => `Last value: ${ago} (from an open Claude session on this account)`,
  },
  tr: {
    idle: 'boşta',
    working: (n) => `${n} çalışan`,
    delivered: (n) => `${n} teslim`,
    defaultLabel: 'Varsayılan',
    defaultNote: 'Varsayılan hesap, sistemdeki normal Claude Code girişidir; buradan çıkış yapılmaz.',
    authDot: { in: 'Giriş yapıldı', out: 'Giriş yapılmadı', checking: 'Giriş durumu kontrol ediliyor', error: 'Giriş durumu okunamadı' },
    days: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
    justNow: 'az önce',
    minAgo: (m) => `${m} dk önce`,
    hrAgo: (h) => `${h} sa önce`,
    dayAgo: (d) => `${d} gün önce`,
    botColor: 'Bot rengi',
    botColorTitle: 'Botların rengi',
    botColorReset: 'Varsayılan renk',
    language: 'Dil',
    languageTitle: 'Arayüz dili (Otomatik sistem dilini izler)',
    auto: 'Otomatik',
    projects: 'PROJELER',
    addProject: '+ Proje ekle',
    addProjectTitle: 'Proje ekle (⌘O)',
    accounts: 'HESAPLAR',
    account: 'Hesap',
    accountTitle: 'Bu projede kullanılacak Claude hesabı (değiştirince Claude yeniden başlar)',
    newAccount: '+ Yeni hesap…',
    noLogin: '⚠ giriş yok',
    noLoginTitle: (label) => `“${label}” hesabında giriş yapılmamış; Claude bu projede çalışamaz.\nTıkla: giriş yap`,
    claudeRunning: 'Claude çalışıyor',
    claudeStopped: 'Claude kapalı',
    bossBusy: 'Patron meşgul',
    removeFromList: 'Listeden kaldır',
    noProjects: 'Henüz proje yok',
    accountName: 'Hesap adı',
    login: 'Giriş yap',
    loginTitle: (label) => `“${label}” hesabına giriş yap`,
    loggedIn: 'giriş yapıldı',
    loginMethod: 'Giriş yöntemi',
    logout: 'Çıkış yap',
    logoutTitle: (label) => `“${label}” hesabından çıkış yap`,
    checking: 'kontrol ediliyor…',
    unknownError: 'Bilinmeyen hata',
    error: 'hata',
    notLoggedIn: 'giriş yapılmadı',
    system: 'sistem',
    systemTitle: 'Sistemdeki ~/.claude girişi.',
    refreshAuth: 'Giriş durumunu yenile',
    rename: 'Yeniden adlandır',
    removeAccount: 'Hesabı kaldır',
    newAccountTitle: 'Yeni Claude hesabı',
    addAccount: '+ Hesap ekle',
    fiveHour: '5 sa',
    week: 'Hafta',
    fiveHourName: '5 saatlik kullanım',
    weekName: 'Haftalık kullanım',
    reset: 'sıfırlandı',
    used: (name, pct) => `${name}: %${pct} kullanıldı`,
    wasReset: 'Sıfırlandı',
    resetsAt: (when) => `Sıfırlanma: ${when}`,
    lastInfo: (ago) => `Son bilgi: ${ago} (bu hesapta açık bir Claude oturumundan)`,
  },
};
const t = () => pick(S);

/** Projenin satır altı özeti: "2 çalışan · 5 teslim". */
function statsText(s) {
  if (!s) return t().idle;
  const parts = [];
  if (s.working) parts.push(t().working(s.working));
  if (s.delivered) parts.push(t().delivered(s.delivered));
  return parts.length ? parts.join(' · ') : t().idle;
}

/** Varsayılan hesabın adı seçili dilde (main 'Varsayılan' olarak saklar). */
const labelOf = (a) => (a.id === 'default' ? t().defaultLabel : a.label);

const pad2 = (n) => String(n).padStart(2, '0');
/** Sıfırlanma zamanı: 24 saat içindeyse "14:30", değilse "Pzt 09:00" / "Mon 09:00". */
function resetText(ms, now) {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return ms - now < 24 * 3600e3 ? hm : `${t().days[d.getDay()]} ${hm}`;
}
/** "3 dk önce", "2 sa önce", "1 gün önce". */
function agoText(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return t().justNow;
  if (m < 60) return t().minAgo(m);
  const hr = Math.round(m / 60);
  return hr < 24 ? t().hrAgo(hr) : t().dayAgo(Math.round(hr / 24));
}
const STALE_MS = 30 * 60e3;

export function mountSidebar(el, on) {
  let projects = [];
  let accounts = [];
  let activeId = null;
  let status = new Map();
  let stats = new Map();
  let projKey = '';
  let acctKey = '';
  let editing = null; // { id: string | null } — hesap adı düzenleniyor (null id = yeni hesap)
  let langSetting = 'auto';

  // bot rengi: ofisteki botların gövde rengi (↺ = temanın varsayılanı)
  const botInput = h('input', { type: 'color', class: 'sb-color', oninput: (e) => on.setBotColor?.(e.target.value) });
  const botLabel = h('span', {});
  const botReset = h('button', { class: 'sb-x', onclick: () => on.setBotColor?.(null) }, '↺');
  const botRow = h('div', { class: 'sb-botcolor' }, botLabel, botInput, botReset);
  // dil: Otomatik (sistem) / English / Türkçe; dil adları kendi dillerinde
  const langLabel = h('span', {});
  const langSelect = h('select', { class: 'sb-acct sb-lang', onchange: (e) => on.setLanguage?.(e.target.value) });
  const langRow = h('div', { class: 'sb-botcolor sb-langrow' }, langLabel, langSelect);
  const projHead = h('span', {});
  const acctHead = h('span', {});
  const addProjectBtn = h('button', { class: 'sb-add', id: 'sb-add-project', onclick: () => on.addProject() });
  const projList = h('ul', { class: 'sb-list', id: 'sb-projects' });
  const acctList = h('ul', { class: 'sb-list', id: 'sb-accounts' });
  el.append(
    h('div', { class: 'sb-head' }, projHead),
    projList,
    addProjectBtn,
    h('div', { class: 'sb-accounts' },
      h('div', { class: 'sb-head' }, acctHead),
      acctList,
    ),
    langRow,
    botRow,
  );

  /** Kalıcı öğelerin metinleri (başlıklar, düğmeler, alt satırlar). */
  function renderChrome() {
    projHead.textContent = t().projects;
    acctHead.textContent = t().accounts;
    addProjectBtn.textContent = t().addProject;
    addProjectBtn.title = t().addProjectTitle;
    botLabel.textContent = t().botColor;
    botInput.title = t().botColorTitle;
    botReset.title = t().botColorReset;
    langLabel.textContent = t().language;
    langSelect.title = t().languageTitle;
    langSelect.replaceChildren(
      h('option', { value: 'auto', selected: langSetting === 'auto' }, t().auto),
      h('option', { value: 'en', selected: langSetting === 'en' }, 'English'),
      h('option', { value: 'tr', selected: langSetting === 'tr' }, 'Türkçe'),
    );
  }
  renderChrome();

  // Projenin hesabı: açıkça "Hesap" etiketli açılır liste; son seçenek yeni hesap açıp bu projeye atar.
  const NEW_ACCOUNT = '__new__';
  function accountSelect(p) {
    const sel = h('select', {
      class: 'sb-acct',
      title: t().accountTitle,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.value !== NEW_ACCOUNT) return on.setAccount(p.id, e.target.value);
        e.target.value = p.accountId;
        editing = { id: null, forProject: p.id };
        renderAccounts();
      },
    }, accounts.map((a) => h('option', { value: a.id, selected: a.id === p.accountId }, labelOf(a))));
    if (!accounts.some((a) => a.id === p.accountId)) {
      sel.append(h('option', { value: p.accountId, selected: true }, '?'));
    }
    sel.append(h('option', { value: NEW_ACCOUNT }, t().newAccount));
    return h('label', { class: 'sb-acct-wrap', onclick: (e) => e.stopPropagation() },
      h('span', { class: 'sb-acct-label' }, t().account), sel);
  }

  /** Hesabında giriş yoksa proje satırında uyarı; tıklayınca giriş katmanı açılır. */
  function loginBadge(p) {
    const a = accounts.find((x) => x.id === p.accountId);
    if (a?.auth?.state !== 'out') return null;
    return h('button', {
      class: 'sb-warn',
      title: t().noLoginTitle(labelOf(a)),
      onclick: (e) => { e.stopPropagation(); on.login(a.id); },
    }, t().noLogin);
  }

  function renderProjects() {
    projList.replaceChildren(...projects.map((p, i) => {
      const s = stats.get(p.name);
      const live = status.get(p.id);
      return h('li', {
        class: 'sb-proj' + (p.id === activeId ? ' active' : ''),
        'data-id': p.id,
        title: p.dir + (i < 9 ? `\n⌘${i + 1}` : ''),
        onclick: () => on.select(p.id),
      },
        h('span', { class: 'sb-dot' + (live ? ' live' : ''), title: live ? t().claudeRunning : t().claudeStopped }),
        h('span', { class: 'sb-name' }, p.name),
        h('span', { class: 'sb-boss', hidden: !s?.isBossBusy, title: t().bossBusy }, '★'),
        h('button', {
          class: 'sb-x', title: t().removeFromList,
          onclick: (e) => { e.stopPropagation(); on.removeProject(p); },
        }, '×'),
        h('div', { class: 'sb-meta' },
          accountSelect(p),
          loginBadge(p),
          h('span', { class: 'sb-stats', title: statsText(s) }, statsText(s)),
        ),
      );
    }));
    if (!projects.length) projList.append(h('li', { class: 'sb-empty' }, t().noProjects));
  }

  function nameInput(initial, done) {
    let finished = false;
    const finish = (val) => { if (finished) return; finished = true; editing = null; done(val); renderAccounts(); };
    const input = h('input', {
      class: 'sb-input', value: initial, maxLength: 40, placeholder: t().accountName,
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(input.value.trim());
        else if (e.key === 'Escape') finish('');
      },
      onblur: () => finish(input.value.trim()),
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }

  /** Hesabın giriş satırı: e-posta + yöntem ya da durum, yanında Giriş yap / Çıkış yap. */
  function authRow(a, isDefault) {
    const auth = a.auth;
    if (!auth?.state) return null;
    const btn = (cls, text, title, fn) => h('button', { class: 'sb-btn ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(); } }, text);
    const loginBtn = () => btn('primary', t().login, t().loginTitle(labelOf(a)), () => on.login(a.id));
    switch (auth.state) {
      case 'in':
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text sb-email', title: (auth.email || '') + (isDefault ? `\n${t().defaultNote}` : '') }, auth.email || t().loggedIn),
          auth.method ? h('span', { class: 'sb-method', title: t().loginMethod }, auth.method) : h('span', { class: 'sb-method' }),
          isDefault ? null : btn('', t().logout, t().logoutTitle(labelOf(a)), () => on.logout(a)),
        );
      case 'checking':
        return h('div', { class: 'sb-auth' }, h('span', { class: 'sb-auth-text' }, t().checking));
      case 'error':
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text', title: auth.error || t().unknownError }, t().error),
          loginBtn());
      default:
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text', title: isDefault ? t().defaultNote : '' }, t().notLoggedIn),
          loginBtn());
    }
  }

  /** Hesabın plan kotası: 5 saatlik ve haftalık kullanım, sıfırlanma zamanı (son açık oturumdan). */
  function usageRows(a) {
    const u = a.usage;
    if (!u || a.auth?.state !== 'in') return null;
    const now = Date.now();
    const ago = agoText(u.updatedAt, now);
    const row = (label, name, w) => {
      if (!w) return null;
      const isReset = w.resetsAt != null && w.resetsAt <= now;
      const pct = isReset ? 0 : Math.round(w.pct);
      const when = w.resetsAt == null ? '' : isReset ? t().reset : resetText(w.resetsAt, now);
      const level = pct >= 90 ? ' hi' : pct >= 70 ? ' mid' : '';
      const tip = t().used(name, pct)
        + (w.resetsAt == null ? '' : '\n' + (isReset ? t().wasReset : t().resetsAt(new Date(w.resetsAt).toLocaleString(locale(), { weekday: 'long', hour: '2-digit', minute: '2-digit' }))))
        + '\n' + t().lastInfo(ago);
      return h('div', { class: 'sb-usage' + level, title: tip },
        h('span', { class: 'sb-usage-label' }, label),
        h('span', { class: 'sb-usage-bar' }, h('span', { style: `width:${pct}%` })),
        h('span', { class: 'sb-usage-pct' }, getLang() === 'tr' ? `%${pct}` : `${pct}%`),
        h('span', { class: 'sb-usage-when' }, when));
    };
    return h('div', { class: 'sb-usages' + (now - u.updatedAt > STALE_MS ? ' stale' : '') },
      row(t().fiveHour, t().fiveHourName, u.fiveHour),
      row(t().week, t().weekName, u.sevenDay));
  }

  function renderAccounts() {
    const rows = accounts.map((a) => {
      const isDefault = a.id === 'default';
      if (editing && editing.id === a.id) {
        return h('li', { class: 'sb-acc editing' }, nameInput(labelOf(a), (label) => {
          if (label && label !== a.label) on.renameAccount(a.id, label);
        }));
      }
      const state = a.auth?.state;
      return h('li', { class: 'sb-acc' + (state ? ` auth-${state}` : ''), 'data-id': a.id },
        h('div', { class: 'sb-acc-top', title: isDefault ? `${t().systemTitle}\n${t().defaultNote}` : (a.configDir || '') },
          h('span', { class: 'sb-adot', title: t().authDot[state] || '' }),
          h('span', { class: 'sb-name' }, labelOf(a)),
          isDefault ? h('span', { class: 'sb-tag' }, t().system) : null,
          h('button', {
            class: 'sb-x', title: t().refreshAuth, disabled: state === 'checking',
            onclick: () => on.refreshAuth(a.id),
          }, '↻'),
          isDefault ? null : [
            h('button', { class: 'sb-x', title: t().rename, onclick: () => { editing = { id: a.id }; renderAccounts(); } }, '✎'),
            h('button', { class: 'sb-x', title: t().removeAccount, onclick: () => on.removeAccount(a) }, '×'),
          ],
        ),
        authRow(a, isDefault),
        usageRows(a),
      );
    });
    if (editing && editing.id === null) {
      const forProject = editing.forProject;
      rows.push(h('li', { class: 'sb-acc editing' }, nameInput('', (label) => {
        if (label) on.addAccount(label, forProject);
      })));
    }
    acctList.replaceChildren(...rows,
      h('li', {}, h('button', {
        class: 'sb-add', title: t().newAccountTitle,
        onclick: () => { editing = { id: null }; renderAccounts(); },
      }, t().addAccount)));
  }

  // sıfırlanma zamanları ve "x dk önce" kendiliğinden eskir: dakikada bir yeniden çiz
  setInterval(() => { if (!editing && accounts.some((a) => a.usage)) renderAccounts(); }, 60000);

  // dil değişti: her şey yeniden çizilir; hesap adı düzenleniyorsa hesaplar düzenleme bitince çizilir
  // (yazılan ad kaybolmasın; nameInput bitince renderAccounts çağırır)
  onLang(() => {
    renderChrome();
    renderProjects();
    if (!editing) renderAccounts();
  });

  return {
    /** Dil ayarı ve etkin dil: { setting: 'auto' | 'en' | 'tr', lang }. */
    setLanguage(li) {
      if (!li) return;
      langSetting = ['en', 'tr'].includes(li.setting) ? li.setting : 'auto';
      langSelect.value = langSetting;
    },
    /** Seçicide gösterilen bot rengi. */
    setBotColor(hex) { botInput.value = hex || '#3fb6a8'; },
    /** Proje listesi, etkin proje, çalışma durumu ve hesaplar. */
    setState(s) {
      projects = s.projects || [];
      accounts = s.accounts || [];
      activeId = s.activeId;
      status = new Map((s.status || []).map((x) => [x.id, x.isRunning]));
      const pk = JSON.stringify([projects, activeId, [...status], accounts.map((a) => [a.id, a.label, a.auth?.state])]);
      if (pk !== projKey) { projKey = pk; renderProjects(); }
      const ak = JSON.stringify(accounts);
      if (ak !== acctKey && !editing) { acctKey = ak; renderAccounts(); }
    },
    /** OfficeData.projects: proje adına göre çalışan / teslim / patron. */
    setStats(list) {
      stats = new Map((list || []).map((s) => [s.name, s]));
      for (const li of projList.querySelectorAll('.sb-proj')) {
        const p = projects.find((x) => x.id === li.dataset.id);
        const s = p && stats.get(p.name);
        const t = statsText(s);
        const st = li.querySelector('.sb-stats');
        if (st.textContent !== t) { st.textContent = t; st.title = t; }
        li.querySelector('.sb-boss').hidden = !s?.isBossBusy;
      }
    },
  };
}
