// Left sidebar: PROJECTS (one project per row) and ACCOUNTS.
// The structure is rebuilt only when the project/account list changes; office stats update in place
// (so an open <select> or a name being typed is not disrupted by 500 ms data). A language change redraws everything.
import { hasText, locale, onLang, t } from './i18n.js';
import { modLabel } from './platform.js';

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


/** The project's subline summary: "2 çalışan · 5 teslim". */
function statsText(s) {
  if (!s) return t('sidebar.idle');
  const parts = [];
  if (s.working) parts.push(t('sidebar.working', { n: s.working }));
  if (s.delivered) parts.push(t('sidebar.delivered', { n: s.delivered }));
  return parts.length ? parts.join(' · ') : t('sidebar.idle');
}

/** The default account's name in the selected language (main stores it as 'Varsayılan'). */
const labelOf = (a) => (a.id === 'default' ? t('sidebar.defaultLabel') : a.label);

const pad2 = (n) => String(n).padStart(2, '0');
/** Reset time: "14:30" if within 24 hours, otherwise "Pzt 09:00" / "Mon 09:00". */
function resetText(ms, now) {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return ms - now < 24 * 3600e3 ? hm : `${t(`sidebar.days.${d.getDay()}`)} ${hm}`;
}
/** "3 dk önce", "2 sa önce", "1 gün önce". */
function agoText(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return t('sidebar.justNow');
  if (m < 60) return t('sidebar.minAgo', { n: m });
  const hr = Math.round(m / 60);
  return hr < 24 ? t('sidebar.hrAgo', { n: hr }) : t('sidebar.dayAgo', { n: Math.round(hr / 24) });
}
const STALE_MS = 30 * 60e3;

export function mountSidebar(el, on) {
  let projects = [];
  let accounts = [];
  let activeId = null;
  let status = new Map();
  let attn = new Map(); // projectId → 'permission' | 'done' (main's notification state)
  let stats = new Map();
  let projKey = '';
  let acctKey = '';
  let editing = null; // { id: string | null } — account name being edited (null id = new account)
  let langSetting = 'auto';
  /** @type {{ code: string, name: string }[]} */
  let languages = []; // locales/*.json (from main, LanguageInfo.languages)

  // bot color: body color of the office bots (↺ = the theme's default)
  const botInput = h('input', { type: 'color', class: 'sb-color', oninput: (e) => on.setBotColor?.(e.target.value) });
  const botLabel = h('span', {});
  const botReset = h('button', { class: 'sb-x', onclick: () => on.setBotColor?.(null) }, '↺');
  const botRow = h('div', { class: 'sb-botcolor' }, botLabel, botInput, botReset);
  // language: Automatic (system) and the languages in locales/; language names in their own language (the file's "_name")
  const langLabel = h('span', {});
  const langSelect = h('select', { class: 'sb-acct sb-lang', onchange: (e) => on.setLanguage?.(e.target.value) });
  const langRow = h('div', { class: 'sb-botcolor sb-langrow' }, langLabel, langSelect);
  // theme (v3.1): Auto (per project) or one theme for the whole office; each option's tooltip is its description
  let themeSetting = 'auto';
  /** @type {{ name: string, description: string, isBuiltin: boolean }[]} */
  let themeChoices = [];
  const themeLabel = h('span', {});
  const themeSelect = h('select', { class: 'sb-acct sb-lang sb-theme', onchange: (e) => on.setTheme?.(e.target.value) });
  const themeRow = h('div', { class: 'sb-botcolor sb-langrow' }, themeLabel, themeSelect);
  // resume the last session on launch (claude --continue)
  const resumeLabel = h('span', {});
  const resumeBox = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => on.setResume?.(e.target.checked) });
  const resumeRow = h('label', { class: 'sb-botcolor sb-langrow' }, resumeLabel, resumeBox);
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
    resumeRow,
    langRow,
    themeRow,
    botRow,
  );

  /** Text of the persistent elements (headings, buttons, sublines). */
  function renderChrome() {
    projHead.textContent = t('sidebar.projects');
    acctHead.textContent = t('sidebar.accounts');
    addProjectBtn.textContent = t('sidebar.addProject');
    addProjectBtn.title = t('sidebar.addProjectTitle', { mod: modLabel });
    botLabel.textContent = t('sidebar.botColor');
    botInput.title = t('sidebar.botColorTitle');
    botReset.title = t('sidebar.botColorReset');
    langLabel.textContent = t('sidebar.language');
    resumeLabel.textContent = t('sidebar.resume');
    resumeRow.title = t('sidebar.resumeTitle');
    langSelect.title = t('sidebar.languageTitle');
    themeLabel.textContent = t('sidebar.theme');
    renderLanguages();
    renderThemes();
  }
  /** Tooltip of a theme option: the theme's description; the built-ins' come from the locale files. */
  function themeDesc(c) {
    if (c.description) return c.description;
    if (!c.isBuiltin) return '';
    return t(c.name === 'forest' ? 'sidebar.themeForestTitle' : 'sidebar.themeClassicTitle');
  }
  function renderThemes() {
    const known = themeChoices.some((c) => c.name === themeSetting);
    const cur = known ? themeSetting : 'auto';
    themeSelect.replaceChildren(
      h('option', { value: 'auto', selected: cur === 'auto', title: t('sidebar.themeAutoTitle') }, t('sidebar.themeAuto')),
      ...themeChoices.map((c) => h('option', { value: c.name, selected: cur === c.name, title: themeDesc(c) }, c.name)),
    );
    // the closed picker shows the chosen theme's description
    const chosen = themeChoices.find((c) => c.name === cur);
    themeSelect.title = chosen ? themeDesc(chosen) || chosen.name : t('sidebar.themeAutoTitle');
  }
  function renderLanguages() {
    langSelect.replaceChildren(
      h('option', { value: 'auto', selected: langSetting === 'auto' }, t('sidebar.auto')),
      ...languages.map((l) => h('option', { value: l.code, selected: langSetting === l.code }, l.name)),
    );
  }
  renderChrome();

  // The project's account: a dropdown explicitly labeled "Hesap"; the last option creates a new account and assigns it here.
  const NEW_ACCOUNT = '__new__';
  function accountSelect(p) {
    const sel = h('select', {
      class: 'sb-acct',
      title: t('sidebar.accountTitle'),
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
    sel.append(h('option', { value: NEW_ACCOUNT }, t('sidebar.newAccount')));
    return h('label', { class: 'sb-acct-wrap', onclick: (e) => e.stopPropagation() },
      h('span', { class: 'sb-acct-label' }, t('sidebar.account')), sel);
  }

  /** Warning in the project row if its account is not logged in; clicking opens the login overlay. */
  function loginBadge(p) {
    const a = accounts.find((x) => x.id === p.accountId);
    if (a?.auth?.state !== 'out') return null;
    return h('button', {
      class: 'sb-warn',
      title: t('sidebar.noLoginTitle', { label: labelOf(a) }),
      onclick: (e) => { e.stopPropagation(); on.login(a.id); },
    }, t('sidebar.noLogin'));
  }

  function renderProjects() {
    projList.replaceChildren(...projects.map((p, i) => {
      const s = stats.get(p.name);
      const live = status.get(p.id);
      return h('li', {
        class: 'sb-proj' + (p.id === activeId ? ' active' : ''),
        'data-id': p.id,
        title: p.dir + (i < 9 ? `\n${modLabel}${i + 1}` : ''),
        onclick: () => on.select(p.id),
      },
        h('span', { class: 'sb-dot' + (live ? ' live' : ''), title: live ? t('sidebar.claudeRunning') : t('sidebar.claudeStopped') }),
        h('span', { class: 'sb-name' }, p.name),
        attn.get(p.id) === 'permission'
          ? h('span', { class: 'sb-attn permission', title: t('sidebar.attnPermission') }, '✋')
          : attn.get(p.id) === 'done' ? h('span', { class: 'sb-attn done', title: t('sidebar.attnDone') }, '●') : null,
        h('span', { class: 'sb-boss', hidden: !s?.isBossBusy, title: t('sidebar.bossBusy') }, '★'),
        h('button', {
          class: 'sb-x', title: t('sidebar.removeFromList'),
          onclick: (e) => { e.stopPropagation(); on.removeProject(p); },
        }, '×'),
        h('div', { class: 'sb-meta' },
          accountSelect(p),
          loginBadge(p),
          h('span', { class: 'sb-stats', title: statsText(s) }, statsText(s)),
        ),
      );
    }));
    if (!projects.length) projList.append(h('li', { class: 'sb-empty' }, t('sidebar.noProjects')));
  }

  function nameInput(initial, done) {
    let finished = false;
    const finish = (val) => { if (finished) return; finished = true; editing = null; done(val); renderAccounts(); };
    const input = h('input', {
      class: 'sb-input', value: initial, maxLength: 40, placeholder: t('sidebar.accountName'),
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

  /** The account's login row: email + method or state, with Giriş yap / Çıkış yap next to it. */
  function authRow(a, isDefault) {
    const auth = a.auth;
    if (!auth?.state) return null;
    const btn = (cls, text, title, fn) => h('button', { class: 'sb-btn ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(); } }, text);
    const loginBtn = () => btn('primary', t('sidebar.login'), t('sidebar.loginTitle', { label: labelOf(a) }), () => on.login(a.id));
    switch (auth.state) {
      case 'in':
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text sb-email', title: (auth.email || '') + (isDefault ? `\n${t('sidebar.defaultNote')}` : '') }, auth.email || t('sidebar.loggedIn')),
          auth.method ? h('span', { class: 'sb-method', title: t('sidebar.loginMethod') }, auth.method) : h('span', { class: 'sb-method' }),
          isDefault ? null : btn('', t('sidebar.logout'), t('sidebar.logoutTitle', { label: labelOf(a) }), () => on.logout(a)),
        );
      case 'checking':
        return h('div', { class: 'sb-auth' }, h('span', { class: 'sb-auth-text' }, t('sidebar.checking')));
      case 'error':
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text', title: auth.error || t('sidebar.unknownError') }, t('sidebar.error')),
          loginBtn());
      default:
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text', title: isDefault ? t('sidebar.defaultNote') : '' }, t('sidebar.notLoggedIn')),
          loginBtn());
    }
  }

  /** The account's plan quota: 5-hour and weekly usage, reset time (from the last open session). */
  function usageRows(a) {
    const u = a.usage;
    if (!u || a.auth?.state !== 'in') return null;
    const now = Date.now();
    const ago = agoText(u.updatedAt, now);
    const row = (label, name, w) => {
      if (!w) return null;
      const isReset = w.resetsAt != null && w.resetsAt <= now;
      const pct = isReset ? 0 : Math.round(w.pct);
      const when = w.resetsAt == null ? '' : isReset ? t('sidebar.reset') : resetText(w.resetsAt, now);
      const level = pct >= 90 ? ' hi' : pct >= 70 ? ' mid' : '';
      const tip = t('sidebar.used', { name, pct })
        + (w.resetsAt == null ? '' : '\n' + (isReset ? t('sidebar.wasReset') : t('sidebar.resetsAt', { when: new Date(w.resetsAt).toLocaleString(locale(), { weekday: 'long', hour: '2-digit', minute: '2-digit' }) })))
        + '\n' + t('sidebar.lastInfo', { ago });
      return h('div', { class: 'sb-usage' + level, title: tip },
        h('span', { class: 'sb-usage-label' }, label),
        h('span', { class: 'sb-usage-bar' }, h('span', { style: `width:${pct}%` })),
        h('span', { class: 'sb-usage-pct' }, t('sidebar.pct', { pct })),
        h('span', { class: 'sb-usage-when' }, when));
    };
    return h('div', { class: 'sb-usages' + (now - u.updatedAt > STALE_MS ? ' stale' : '') },
      row(t('sidebar.fiveHour'), t('sidebar.fiveHourName'), u.fiveHour),
      row(t('sidebar.week'), t('sidebar.weekName'), u.sevenDay));
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
        h('div', { class: 'sb-acc-top', title: isDefault ? `${t('sidebar.systemTitle')}\n${t('sidebar.defaultNote')}` : (a.configDir || '') },
          h('span', { class: 'sb-adot', title: hasText(`sidebar.authDot.${state}`) ? t(`sidebar.authDot.${state}`) : '' }),
          h('span', { class: 'sb-name' }, labelOf(a)),
          isDefault ? h('span', { class: 'sb-tag' }, t('sidebar.system')) : null,
          h('button', {
            class: 'sb-x', title: t('sidebar.refreshAuth'), disabled: state === 'checking',
            onclick: () => on.refreshAuth(a.id),
          }, '↻'),
          isDefault ? null : [
            h('button', { class: 'sb-x', title: t('sidebar.rename'), onclick: () => { editing = { id: a.id }; renderAccounts(); } }, '✎'),
            h('button', { class: 'sb-x', title: t('sidebar.removeAccount'), onclick: () => on.removeAccount(a) }, '×'),
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
        class: 'sb-add', title: t('sidebar.newAccountTitle'),
        onclick: () => { editing = { id: null }; renderAccounts(); },
      }, t('sidebar.addAccount'))));
  }

  // reset times and "x dk önce" go stale on their own: redraw once a minute
  setInterval(() => { if (!editing && accounts.some((a) => a.usage)) renderAccounts(); }, 60000);

  // language changed: everything is redrawn; if an account name is being edited, accounts are drawn when editing ends
  // (so the typed name is not lost; nameInput calls renderAccounts when done)
  onLang(() => {
    renderChrome();
    renderProjects();
    if (!editing) renderAccounts();
  });

  return {
    /** Language setting, active language and languages: { setting: 'auto' | code, lang, languages: [{ code, name }] }. */
    setLanguage(li) {
      if (!li) return;
      if (Array.isArray(li.languages)) languages = li.languages;
      langSetting = languages.some((l) => l.code === li.setting) ? li.setting : 'auto';
      renderLanguages();
    },
    /** Theme picker: options after Auto (src/themes.mjs themeChoices) and the setting ('auto' | name). */
    setThemes(choices, setting) {
      if (Array.isArray(choices)) themeChoices = choices;
      if (typeof setting === 'string') themeSetting = setting;
      renderThemes();
    },
    /** Setting to resume the last session on launch. */
    setResume(on) { resumeBox.checked = on !== false; },
    /** Bot color shown in the picker. */
    setBotColor(hex) { botInput.value = hex || '#3fb6a8'; },
    /** Project list, active project, working state and accounts. */
    setState(s) {
      projects = s.projects || [];
      accounts = s.accounts || [];
      activeId = s.activeId;
      status = new Map((s.status || []).map((x) => [x.id, x.isRunning]));
      attn = new Map((s.status || []).filter((x) => x.attention).map((x) => [x.id, x.attention]));
      const pk = JSON.stringify([projects, activeId, [...status], [...attn], accounts.map((a) => [a.id, a.label, a.auth?.state])]);
      if (pk !== projKey) { projKey = pk; renderProjects(); }
      const ak = JSON.stringify(accounts);
      if (ak !== acctKey && !editing) { acctKey = ak; renderAccounts(); }
    },
    /** OfficeData.projects: working / delivered / boss by project name. */
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
