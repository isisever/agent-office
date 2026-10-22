// Left sidebar: collapsible panels PROJECTS (one project per row), ACCOUNTS, DEVICES (devices.js) and CONNECTIONS (v3.43).
// The structure is rebuilt only when the project/account list changes; office stats update in place
// (so an open <select> or a name being typed is not disrupted by 500 ms data). A language change redraws everything.
import { hasText, locale, onLang, t } from './i18n.js';
import { modLabel, platform } from './platform.js';
import { isBossHere, projectStatus } from '../src/project-status.mjs';
import { bossModelChoices, cap } from '../src/engine-caps.mjs';

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


/** The project's subline summary: "2 çalışan · 5 teslim" (src/project-status.mjs). */
const statsText = (s) => projectStatus(s, t);

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

/** "$3.52" under $10, "$170" above (an estimate at list prices; contract v3.13). */
const usdText = (v) => `$${(Number(v) || 0).toLocaleString(locale(), { maximumFractionDigits: v < 10 ? 2 : 0, minimumFractionDigits: v < 10 && v > 0 ? 2 : 0 })}`;
/** The project row's usage line: "≈ $12 today · 16%" (16% = full-price equivalent of today's tokens). */
function costText(b) {
  const pct = Math.round((Number(b?.pct) || 0) * 100);
  return b && b.total > 0 ? t('sidebar.costLine', { usd: usdText(b.usd), pct }) : t('sidebar.costNone');
}

export function mountSidebar(el, on) {
  let projects = [];
  let accounts = [];
  let agyAuth = null; // Antigravity's login (v3.24, main's AgyAuth); null until main answers
  let cmdAuth = null; // Command Code's login (v3.30, main's CmdAuth); null until main answers
  // The Antigravity / Command Code rows (v3.30): true = added via Add account, false = removed, null = the old rule
  let showAgy = null;
  let showCmd = null;
  let ocAuth = null; // OpenCode's logins (v3.40, main's OcAuth); null until main answers
  let showOc = null;
  let addMenu = false; // the Add account type menu is open (v3.30)
  let ocLoginMenu = false; // the OpenCode login chooser is open: normal (device code) vs one provider (v3.40)
  let addFor = null; // the project whose Account dropdown opened the type menu (v3.36): a new Claude account goes to it
  let activeId = null;
  let status = new Map();
  let asleep = new Set(); // projects whose main claude sleeps (src/sleep.js)
  let attn = new Map(); // projectId → 'permission' | 'done' (main's notification state)
  let stats = new Map();
  let briefs = new Map(); // projectId → { usd, total, pct } today's token usage (main's tokens:brief, v3.13)
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
  // interrupted turns carry on by themselves at launch (main's src/resume.js); needs "continue last session"
  const resumeWorkLabel = h('span', {});
  const resumeWorkBox = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => on.setResumeWork?.(e.target.checked) });
  const resumeWorkRow = h('label', { class: 'sb-botcolor sb-langrow sb-subpref' }, resumeWorkLabel, resumeWorkBox);
  const syncResumeWork = () => {
    resumeWorkBox.disabled = !resumeBox.checked;
    resumeWorkRow.classList.toggle('is-disabled', !resumeBox.checked);
  };
  // manager mode: the boss delegates the work to agents (plugin, AGENT_OFFICE_MANAGER); sessions started afterwards
  const managerLabel = h('span', {});
  const managerBox = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => on.setManager?.(e.target.checked) });
  const managerRow = h('label', { class: 'sb-botcolor sb-langrow' }, managerLabel, managerBox);
  // every session also gets the other office projects' MCP servers (contract v3.9); sessions started afterwards
  const shareMcpLabel = h('span', {});
  const shareMcpBox = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => on.setShareMcp?.(e.target.checked) });
  const shareMcpRow = h('label', { class: 'sb-botcolor sb-langrow' }, shareMcpLabel, shareMcpBox);
  // an idle running session whose MCP servers changed restarts in its conversation (contract v3.11)
  const reloadMcpLabel = h('span', {});
  const reloadMcpBox = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => on.setReloadMcp?.(e.target.checked) });
  const reloadMcpRow = h('label', { class: 'sb-botcolor sb-langrow' }, reloadMcpLabel, reloadMcpBox);
  // a project at the usage limit moves to its backup account, and back after the reset (contract v3.17)
  const fallbackLabel = h('span', {});
  const fallbackBox = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => on.setFallback?.(e.target.checked) });
  const fallbackRow = h('label', { class: 'sb-botcolor sb-langrow' }, fallbackLabel, fallbackBox);
  // sleep idle background sessions after N minutes (0 = off); main's src/sleep.js has the rules
  const SLEEP_CHOICES = [0, 15, 30, 60];
  let sleepMinutes = 30;
  const sleepLabel = h('span', {});
  const sleepSelect = h('select', { class: 'sb-acct sb-lang sb-sleep', onchange: (e) => on.setSleep?.(Number(e.target.value)) });
  const sleepRow = h('div', { class: 'sb-botcolor sb-langrow' }, sleepLabel, sleepSelect);
  const projHead = h('span', {});
  const acctHead = h('span', {});
  const settingsBtn = h('button', { class: 'sb-x sb-gear sb-gear-head', id: 'sb-settings', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openSettings(); } }, '⚙'); // inside <summary>: must not toggle the panel
  const addProjectBtn = h('button', { class: 'sb-add', id: 'sb-add-project', onclick: () => on.addProject() });
  // "Resume unfinished work" (v3.8): main checks every tab; the result shows under the button for a while
  const resumeAllBtn = h('button', { class: 'sb-add sb-resume-all', id: 'sb-resume-all', onclick: () => on.resumeUnfinished?.() });
  const resumeNote = h('div', { class: 'sb-note', id: 'sb-resume-note', hidden: true });
  let noteTimer = null;
  const projList = h('ul', { class: 'sb-list', id: 'sb-projects' });
  const acctList = h('ul', { class: 'sb-list', id: 'sb-accounts' });
  // v3.43: collapsible panels (open/closed is remembered on this computer): PROJECTS, ACCOUNTS, DEVICES (devices.js adds
  // its own after ACCOUNTS) and MCP (v3.44: every server the active project's sessions get). The whole sidebar scrolls.
  const mcpList = h('ul', { class: 'sb-list', id: 'sb-mcp' });
  const mcpHead = h('span', {});
  const mcpNote = h('div', { class: 'sb-note', id: 'sb-mcp-note', hidden: true });
  const addMcpBtn = h('button', { class: 'sb-add', id: 'sb-add-mcp', onclick: () => openMcpForm() });
  let mcpKey = null;
  function panel(id, head, body, cls = '') {
    let open = true;
    try { open = localStorage.getItem(`ao.panel.${id}`) !== '0'; } catch {}
    const d = h('details', { class: `sb-panel ${cls}`, id: `sb-panel-${id}`, open }, h('summary', { class: 'sb-head sb-head-row' }, head), body);
    d.addEventListener('toggle', () => { try { localStorage.setItem(`ao.panel.${id}`, d.open ? '1' : '0'); } catch {} });
    return d;
  }
  el.append(
    panel('projects', [projHead], h('div', { class: 'sb-top', id: 'sb-top' }, projList, addProjectBtn, resumeAllBtn, resumeNote)),
    panel('accounts', [acctHead, settingsBtn], h('div', { class: 'sb-panel-body' }, acctList), 'sb-accounts'),
    panel('mcp', [mcpHead], h('div', { class: 'sb-panel-body' }, mcpNote, mcpList, addMcpBtn), 'sb-mcp-panel'),
  );
  el.querySelector('#sb-panel-mcp')?.addEventListener('toggle', () => renderMcp(true)); // re-read Claude Code's files

  /** Text of the persistent elements (headings, buttons, sublines). */
  function renderChrome() {
    projHead.textContent = t('sidebar.projects');
    acctHead.textContent = t('sidebar.accounts');
    mcpHead.textContent = t('sidebar.mcp');
    addMcpBtn.textContent = t('sidebar.mcpAdd');
    addMcpBtn.title = t('sidebar.mcpAddTitle');
    settingsBtn.title = t('sidebar.settingsTitle');
    settingsBtn.setAttribute('aria-label', t('sidebar.settings'));
    addProjectBtn.textContent = t('sidebar.addProject');
    addProjectBtn.title = t('sidebar.addProjectTitle', { mod: modLabel });
    resumeAllBtn.textContent = t('sidebar.resumeUnfinished');
    resumeAllBtn.title = t('sidebar.resumeUnfinishedTitle');
    botLabel.textContent = t('sidebar.botColor');
    botInput.title = t('sidebar.botColorTitle');
    botReset.title = t('sidebar.botColorReset');
    langLabel.textContent = t('sidebar.language');
    resumeLabel.textContent = t('sidebar.resume');
    resumeRow.title = t('sidebar.resumeTitle');
    resumeWorkLabel.textContent = t('sidebar.resumeWork');
    resumeWorkRow.title = t('sidebar.resumeWorkTitle');
    managerLabel.textContent = t('sidebar.manager');
    managerRow.title = t('sidebar.managerTitle');
    shareMcpLabel.textContent = t('sidebar.shareMcp');
    shareMcpRow.title = t('sidebar.shareMcpTitle');
    reloadMcpLabel.textContent = t('sidebar.reloadMcp');
    reloadMcpRow.title = t('sidebar.reloadMcpTitle');
    fallbackLabel.textContent = t('sidebar.fallback');
    fallbackRow.title = t('sidebar.fallbackTitle');
    sleepLabel.textContent = t('sidebar.sleep');
    sleepRow.title = t('sidebar.sleepTitle');
    renderSleep();
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
  function renderSleep() {
    sleepSelect.replaceChildren(...SLEEP_CHOICES.map((n) =>
      h('option', { value: String(n), selected: n === sleepMinutes }, n ? t('sidebar.sleepAfter', { n }) : t('sidebar.sleepOff'))));
  }
  function renderLanguages() {
    langSelect.replaceChildren(
      h('option', { value: 'auto', selected: langSetting === 'auto' }, t('sidebar.auto')),
      ...languages.map((l) => h('option', { value: l.code, selected: langSetting === l.code }, l.name)),
    );
  }
  renderChrome();

  // Settings popups: the project popup collects its changes as a draft and applies them on Save (account first, it
  // may restart the tabs); Cancel / Escape / a click outside discards. The global popup applies each change at once.
  /** @type {Map<string, () => unknown> | null} */
  let draft = null;
  const queue = (key, fn) => draft?.set(key, fn);

  const engineOfRow = (p) => (p.engine === 'agy' || p.engine === 'commandcode' || p.engine === 'opencode' ? p.engine : 'claude');
  /**
   * A row control with its label (contract v3.36): every engine shows it; one the engine can't honour (src/engine-caps.mjs)
   * is disabled, its reason in the title and in a small line shown on hover or focus.
   */
  function control(p, feature, label, sel, extraClass = '') {
    const c = cap(engineOfRow(p), feature, { projectFiles: p.projectFiles === true }); // v3.38: some need the toggle
    const reason = c.ok ? '' : t(`sidebar.na.${c.reason}`);
    if (reason) { sel.disabled = true; sel.title = reason; }
    return h('label', {
      class: 'sb-acct-wrap' + (reason ? ' sb-na-wrap' : '') + extraClass, title: reason || null, tabindex: reason ? '0' : null,
      onclick: (e) => e.stopPropagation(),
    }, h('span', { class: 'sb-acct-label' }, label), sel, reason ? h('span', { class: 'sb-na', role: 'note' }, reason) : null);
  }

  // The project's account (contract v2.1, v3.36): the Claude accounts, then Antigravity and Command Code (each one
  // login), then "New account…" (the Add account type menu). Choosing Antigravity or Command Code sets the project's
  // engine (main's projects:setEngine: refused or cancelled, the select goes back); choosing a Claude account sets the
  // engine back to Claude Code and the account. p.accountId stays the Claude account while another engine runs.
  const NEW_ACCOUNT = '__new__';
  const ENGINE_OPT = { agy: '__engine:agy', commandcode: '__engine:commandcode', opencode: '__engine:opencode' }; // opencode: v3.40
  function accountSelect(p) {
    const engine = engineOfRow(p);
    const now = engine === 'claude' ? p.accountId : ENGINE_OPT[engine];
    const sel = h('select', {
      class: 'sb-acct',
      title: t('sidebar.accountTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        const v = e.target.value;
        if (v === NEW_ACCOUNT) { // the type menu lives in the ACCOUNTS list: close the popup, open the menu there
          e.target.value = now;
          closeModal();
          addMenu = true; addFor = p.id;
          renderAccounts();
          acctList.querySelector('.sb-add-menu')?.scrollIntoView?.({ block: 'nearest' });
          return;
        }
        queue('account', async () => {
          const eng = Object.keys(ENGINE_OPT).find((k) => ENGINE_OPT[k] === v) || null;
          // leaving agy/cmd for another Claude account: the account first, so the restarted tabs use it
          const leaving = !eng && engine !== 'claude';
          if (leaving && v !== p.accountId) await on.setAccount(p.id, v);
          if (eng || engine !== 'claude') {
            const r = await on.setEngine?.(p.id, eng);
            if (!r || r.refused) { // failed: the old account again, if it was already moved
              if (leaving && v !== p.accountId) await on.setAccount(p.id, p.accountId);
              return;
            }
          }
          if (!eng && !leaving && v !== p.accountId) on.setAccount(p.id, v);
        });
      },
    }, accounts.map((a) => h('option', { value: a.id, selected: now === a.id }, labelOf(a))));
    if (!accounts.some((a) => a.id === p.accountId)) {
      sel.append(h('option', { value: p.accountId, selected: now === p.accountId }, '?'));
    }
    const engineOpt = (value, selected, label) => h('option', { value, selected }, label);
    if (agyShown() || engine === 'agy') {
      sel.append(engineOpt(ENGINE_OPT.agy, engine === 'agy', t('sidebar.engineAgy') + (agyAuth?.email ? ` · ${agyAuth.email}` : '')));
    }
    if (cmdShown() || engine === 'commandcode') {
      sel.append(engineOpt(ENGINE_OPT.commandcode, engine === 'commandcode', t('sidebar.engineCommandcode')));
    }
    if (ocShown() || engine === 'opencode') { // contract v3.40
      sel.append(engineOpt(ENGINE_OPT.opencode, engine === 'opencode', t('sidebar.engineOpencode')));
    }
    sel.append(h('option', { value: NEW_ACCOUNT }, t('sidebar.newAccount')));
    return control(p, 'account', t('sidebar.account'), sel);
  }

  // How the project's boss works (contract v3.10): the global setting, delegates (manager mode) or does it itself.
  // Applies when the project's Claude starts next; main restarts its idle tabs right away.
  const MANAGER_VALUES = { default: null, on: true, off: false };
  function managerSelect(p) {
    const now = typeof p.manager === 'boolean' ? (p.manager ? 'on' : 'off') : 'default';
    const sel = h('select', {
      class: 'sb-acct sb-mode',
      title: t('sidebar.projectManagerTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('manager', () => on.setProjectManager?.(p.id, MANAGER_VALUES[e.target.value] ?? null)),
    },
    h('option', { value: 'default', selected: now === 'default' }, t('sidebar.projectManagerDefault')),
    h('option', { value: 'on', selected: now === 'on' }, t('sidebar.projectManagerOn')),
    h('option', { value: 'off', selected: now === 'off' }, t('sidebar.projectManagerOff')));
    return control(p, 'manager', t('sidebar.projectManager'), sel);
  }

  // The model of the project's boss session (contract v3.27): Auto (claude's default) or one model, `--model`.
  const claudeModelLabel = (v) => (v === 'sonnet' ? t('sidebar.bossModelSonnet') : v === 'opus' ? t('sidebar.bossModelOpus')
    : v === 'haiku' ? t('sidebar.bossModelHaiku') : '');
  function bossModelSelect(p) {
    const choices = bossModelChoices(engineOfRow(p)); // per engine (contract v3.36)
    const now = choices.some((c) => c.value === p.bossModel) ? p.bossModel : 'auto';
    const opt = (v, label) => h('option', { value: v, selected: now === v }, label);
    const sel = h('select', {
      class: 'sb-acct sb-mode',
      title: t('sidebar.bossModelTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('bossModel', () => on.setBossModel?.(p.id, e.target.value === 'auto' ? null : e.target.value)),
    },
    opt('auto', t('sidebar.bossModelAuto')), ...choices.map((c) => opt(c.value, claudeModelLabel(c.value) || c.label)));
    return control(p, 'bossModel', t('sidebar.bossModel'), sel);
  }

  // "Let Agent Office add its files to this project" (contract v3.38): off by default; Antigravity and Command Code only.
  function projectFilesToggle(p) {
    const box = h('input', {
      type: 'checkbox', class: 'sb-files', checked: p.projectFiles === true, title: t('sidebar.projectFilesTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('projectFiles', () => on.setProjectFiles?.(p.id, e.target.checked)),
    });
    return control(p, 'projectFiles', t('sidebar.projectFiles'), box);
  }

  // The model the project's agents run on (contract v3.14): Auto (the boss picks per agent) or one pinned model.
  // Applies like the boss setting: next start, idle tabs right away.
  function agentModelSelect(p) {
    const now = ['sonnet', 'haiku', 'opus'].includes(p.agentModel) ? p.agentModel : 'auto';
    const opt = (v, label) => h('option', { value: v, selected: now === v }, label);
    const sel = h('select', {
      class: 'sb-acct sb-mode',
      title: t('sidebar.agentModelTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('agentModel', () => on.setAgentModel?.(p.id, e.target.value === 'auto' ? null : e.target.value)),
    },
    opt('auto', t('sidebar.agentModelAuto')), opt('sonnet', t('sidebar.agentModelSonnet')),
    opt('haiku', t('sidebar.agentModelHaiku')), opt('opus', t('sidebar.agentModelOpus')));
    return control(p, 'agentModel', t('sidebar.agentModel'), sel);
  }

  // When the project's Claude summarizes its conversation (contract v3.15): Auto (Claude Code's own window) or a cap
  // in tokens. Applies like the agent model: next start, idle tabs right away.
  function contextCapSelect(p) {
    const now = [200000, 400000].includes(p.contextCap) ? String(p.contextCap) : 'auto';
    const opt = (v, label) => h('option', { value: v, selected: now === v }, label);
    const sel = h('select', {
      class: 'sb-acct sb-mode',
      title: t('sidebar.contextCapTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('contextCap', () => on.setContextCap?.(p.id, e.target.value === 'auto' ? null : Number(e.target.value))),
    },
    opt('auto', t('sidebar.contextCapAuto')), opt('200000', '200K'), opt('400000', '400K'));
    return control(p, 'contextCap', t('sidebar.contextCap'), sel);
  }

  // Token savings (contract v3.20): Off, Normal (the default: no field) or Strict; the subagents' step budget and the
  // tool output caps (accounts.js SAVINGS). Applies like the context cap: next start, idle tabs right away.
  function savingsSelect(p) {
    const now = ['off', 'strict'].includes(p.savings) ? p.savings : 'normal';
    const opt = (v, label) => h('option', { value: v, selected: now === v }, label);
    const sel = h('select', {
      class: 'sb-acct sb-mode',
      title: t('sidebar.savingsTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('savings', () => on.setSavings?.(p.id, e.target.value)),
    },
    opt('off', t('sidebar.savingsOff')), opt('normal', t('sidebar.savingsNormal')), opt('strict', t('sidebar.savingsStrict')));
    return control(p, 'savings', t('sidebar.savings'), sel);
  }

  // The program the project's tabs run (contract v3.22, v3.25): a read-only tag since v3.36; the Account dropdown
  // picks it (Claude accounts, Antigravity, Command Code, OpenCode).
  function engineTag(p) {
    const engine = engineOfRow(p);
    if (engine === 'claude') return h('span', { class: 'sb-tag sb-engine', title: t('sidebar.engineTitle'), 'aria-label': t('sidebar.engine') }, t('sidebar.engineClaude'));
    if (engine === 'opencode') return h('span', { class: 'sb-tag sb-agy', title: t('sidebar.ocHintTitle') }, t('sidebar.ocHint')); // v3.40
    return engine === 'commandcode'
      ? h('span', { class: 'sb-tag sb-agy', title: t('sidebar.cmdHintTitle') }, t('sidebar.cmdHint'))
      : h('span', { class: 'sb-tag sb-agy', title: t('sidebar.agyHintTitle') }, t('sidebar.agyHint'));
  }

  // The account the project continues on when its own reaches the usage limit (contract v3.17): none, any other
  // logged-in account with quota left, or one account. Nothing restarts when it changes.
  function backupSelect(p) {
    const now = p.backupAccount === 'auto' || accounts.some((a) => a.id === p.backupAccount) ? p.backupAccount : 'none';
    const opt = (v, label) => h('option', { value: v, selected: now === v }, label);
    const sel = h('select', {
      class: 'sb-acct sb-mode sb-backup',
      title: t('sidebar.backupTitle'),
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => queue('backup', () => on.setBackup?.(p.id, e.target.value === 'none' ? null : e.target.value)),
    },
    opt('none', t('sidebar.backupNone')), opt('auto', t('sidebar.backupAuto')),
    ...accounts.filter((a) => a.id !== p.accountId || a.id === now).map((a) => opt(a.id, labelOf(a))));
    return control(p, 'backup', t('sidebar.backup'), sel);
  }

  /** On a backup after its own account's usage limit: a tag naming the account it goes back to. */
  function onBackupTag(p) {
    const home = accounts.find((a) => a.id === p.homeAccount);
    if (!home) return null;
    return h('span', { class: 'sb-tag sb-onbackup', title: t('sidebar.onBackupTitle', { home: labelOf(home) }) }, t('sidebar.onBackup', { home: labelOf(home) }));
  }

  /** Warning in the project row if its account is not logged in; clicking opens the login overlay. */
  function loginBadge(p) {
    const engine = engineOfRow(p);
    if (engine === 'opencode') { // contract v3.40: no login is normal (free models); only a missing CLI is a problem
      if (ocAuth?.state !== 'missing') return null;
      return h('span', { class: 'sb-warn', title: t('sidebar.ocMissingTitle') }, t('sidebar.ocMissing'));
    }
    if (engine !== 'claude') { // Antigravity's / Command Code's own login (v3.24, v3.30; contract v3.36)
      const auth = engine === 'agy' ? agyAuth : cmdAuth;
      if (auth?.state !== 'out') return null;
      const label = engine === 'agy' ? t('sidebar.engineAgy') : t('sidebar.engineCommandcode');
      return h('button', {
        class: 'sb-warn',
        title: t('sidebar.noLoginTitle', { label }),
        onclick: (e) => { e.stopPropagation(); if (engine === 'agy') on.agyLogin?.(); else on.cmdLogin?.(); },
      }, t('sidebar.noLogin'));
    }
    const a = accounts.find((x) => x.id === p.accountId);
    if (a?.auth?.state !== 'out') return null;
    return h('button', {
      class: 'sb-warn',
      title: t('sidebar.noLoginTitle', { label: labelOf(a) }),
      onclick: (e) => { e.stopPropagation(); on.login(a.id); },
    }, t('sidebar.noLogin'));
  }

  // ---- Settings popups ----
  let modal = null;
  function closeModal() {
    modal?.remove();
    modal = null;
    draft = null;
  }
  /** One popup at a time: a title, a body and buttons; Escape and a click on the backdrop close it. */
  function openModal(title, body, buttons, cls = '') {
    closeModal();
    const backdrop = h('div', {
      class: 'sb-modal-backdrop',
      onmousedown: (e) => { if (e.target === backdrop) closeModal(); },
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Escape') closeModal(); },
    },
    h('div', { class: 'sb-modal ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sb-modal-head' }, h('span', {}, title),
        h('button', { class: 'sb-x', title: t('sidebar.cancel'), onclick: () => closeModal() }, '×')),
      h('div', { class: 'sb-modal-body' }, body),
      h('div', { class: 'sb-modal-foot' }, buttons)));
    modal = backdrop;
    document.body.append(backdrop);
    backdrop.querySelector('select, input, button.primary')?.focus();
  }

  /** The project's popup (contract v3.42): every per-project setting; Save applies what changed. */
  function openProjectSettings(p) {
    const map = new Map();
    const body = [
      accountSelect(p), managerSelect(p), bossModelSelect(p), agentModelSelect(p), projectFilesToggle(p),
      contextCapSelect(p), savingsSelect(p), backupSelect(p),
    ];
    const save = h('button', {
      class: 'sb-btn primary', onclick: async () => {
        const fns = [...map.entries()].sort((a, b) => (a[0] === 'account' ? -1 : 0) - (b[0] === 'account' ? -1 : 0)).map((x) => x[1]);
        closeModal();
        for (const fn of fns) { try { await fn(); } catch (e) { console.error(e); } }
      },
    }, t('sidebar.save'));
    openModal(`${t('sidebar.projectSettings')} · ${p.name}`, body,
      [h('button', { class: 'sb-btn', onclick: () => closeModal() }, t('sidebar.cancel')), save]);
    draft = map; // after openModal (its closeModal clears the previous draft); controls read it when they change
  }

  /** The MCP panel (contract v3.44): the active project's servers, read-only ones labelled with where they come from.
   *  Main sends names, transport, source and host only (never a URL path, header or token). */
  async function renderMcp(force = false) {
    const p = projects.find((x) => x.id === activeId);
    const key = JSON.stringify([activeId, p ? engineOfRow(p) : null, p?.accountId]);
    if (!force && key === mcpKey) return;
    mcpKey = key;
    const r = p ? await on.mcp?.list(p.id) : null;
    if (mcpKey !== key) return; // the active project changed meanwhile
    const list = r?.servers || [];
    const gate = p ? cap(engineOfRow(p), 'appMcp') : { ok: true };
    mcpNote.hidden = gate.ok;
    mcpNote.textContent = gate.ok ? '' : t('sidebar.na.claudeOnlyMcp');
    const where = (s) => [
      t(`sidebar.mcpSrc.${s.source}`) + (s.source === 'app' ? ` · ${s.scope === 'all' ? t('sidebar.mcpScopeAll') : t('sidebar.mcpScopeOne')}` : ''),
      s.host || '',
    ].filter(Boolean).join(' · ');
    const hint = (s) => [
      s.readOnly ? t('sidebar.mcpReadOnly') : null,
      s.source === 'project' && s.approved === false ? t('sidebar.mcpUnapproved') : null,
      s.shadowed ? t('sidebar.mcpShadowed') : null,
      s.source === 'app' && !gate.ok ? t('sidebar.na.claudeOnlyMcp') : null,
    ].filter(Boolean).join('\n');
    mcpList.replaceChildren(...list.map((s) => h('li', { class: 'sb-mcp-row' + (s.shadowed ? ' shadowed' : '') + (s.readOnly ? ' ro' : ''), title: hint(s) || null },
      h('span', { class: 'sb-name' }, s.name),
      h('span', { class: 'sb-tag' }, s.type),
      h('span', { class: 'sb-mcp-src' }, where(s)),
      s.readOnly ? null : h('button', {
        class: 'sb-x', title: t('sidebar.mcpRemove'),
        onclick: async () => { await on.mcp?.remove(s.id); renderMcp(true); },
      }, '×'))));
    if (!list.length) mcpList.append(h('li', { class: 'sb-empty' }, p ? t('sidebar.mcpNone') : t('sidebar.mcpNoProject')));
  }

  /** Add a remote MCP server (v3.44) for all projects or one; the token goes to main only (stored encrypted there). */
  function openMcpForm() {
    const field = (label, input, hint) => h('label', { class: 'sb-field' }, h('span', { class: 'sb-field-label' }, label), input, hint ? h('span', { class: 'sb-field-hint' }, hint) : null);
    const name = h('input', { maxLength: 48, placeholder: t('sidebar.mcpNamePh') });
    const url = h('input', { type: 'url', placeholder: 'https://…', spellcheck: false });
    const type = h('select', {}, h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE'));
    const token = h('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: t('sidebar.mcpTokenPh') });
    const scope = h('select', {}, h('option', { value: 'all' }, t('sidebar.mcpScopeAll')),
      ...projects.map((p) => h('option', { value: p.id, selected: p.id === activeId }, p.name)));
    const err = h('div', { class: 'sb-note warn', hidden: true });
    const save = h('button', {
      class: 'sb-btn primary',
      onclick: async () => {
        save.disabled = true;
        err.hidden = true;
        const r = await on.mcp?.add({ name: name.value, url: url.value, type: type.value, token: token.value, scope: scope.value });
        if (r?.ok) { closeModal(); renderMcp(true); return; }
        save.disabled = false;
        err.textContent = t(`sidebar.mcpError.${{ 'name-used': 'nameUsed' }[r?.error] || r?.error || 'failed'}`);
        err.hidden = false;
      },
    }, t('sidebar.save'));
    openModal(t('sidebar.mcpAddTitle'), [
      field(t('sidebar.mcpName'), name),
      field(t('sidebar.mcpUrl'), url, t('sidebar.mcpUrlHint')),
      field(t('sidebar.mcpType'), type),
      field(t('sidebar.mcpToken'), token, t('sidebar.mcpTokenHint')),
      field(t('sidebar.mcpScope'), scope, t('sidebar.mcpScopeHint')),
      err,
    ], [h('button', { class: 'sb-btn', onclick: () => closeModal() }, t('sidebar.cancel')), save], 'sb-modal-form');
  }

  /** The global popup (contract v3.42): the rows that used to sit under ACCOUNTS; each change applies at once. */
  function openSettings() {
    openModal(t('sidebar.settings'),
      [resumeRow, resumeWorkRow, managerRow, shareMcpRow, reloadMcpRow, fallbackRow, sleepRow, langRow, themeRow, botRow],
      [h('button', { class: 'sb-btn primary', onclick: () => closeModal() }, t('sidebar.close'))], 'sb-modal-global');
  }

  function renderProjects() {
    const rowOf = (p, i) => {
      const s = stats.get(p.name);
      const live = status.get(p.id);
      const sleeping = !live && asleep.has(p.id);
      const claude = engineOfRow(p) === 'claude'; // every engine shows every control; some disabled (contract v3.36)
      const dotTitle = !claude ? (p.engine === 'commandcode'
        ? (live ? t('sidebar.cmdRunning') : sleeping ? t('sidebar.cmdAsleep') : t('sidebar.cmdStopped'))
        : p.engine === 'opencode'
          ? (live ? t('sidebar.ocRunning') : sleeping ? t('sidebar.ocAsleep') : t('sidebar.ocStopped'))
          : live ? t('sidebar.agyRunning') : sleeping ? t('sidebar.agyAsleep') : t('sidebar.agyStopped'))
        : live ? t('sidebar.claudeRunning') : sleeping ? t('sidebar.claudeAsleep') : t('sidebar.claudeStopped');
      return h('li', {
        class: 'sb-proj' + (p.id === activeId ? ' active' : ''),
        'data-id': p.id,
        title: p.dir + (i < 9 ? `\n${modLabel}${i + 1}` : ''),
        onclick: () => on.select(p.id),
        oncontextmenu: (e) => { e.preventDefault(); on.projectMenu?.(p); },
      },
        h('span', { class: 'sb-dot' + (live ? ' live' : sleeping ? ' asleep' : ''), title: dotTitle }),
        h('span', { class: 'sb-name' }, p.name),
        h('span', { class: 'sb-icons' },
          attn.get(p.id) === 'permission'
            ? h('span', { class: 'sb-attn permission', title: t('sidebar.attnPermission') }, '✋')
            : attn.get(p.id) === 'done' ? h('span', { class: 'sb-attn done', title: t('sidebar.attnDone') }, '●') : null,
          h('span', { class: 'sb-boss', hidden: !isBossHere(s), title: t('sidebar.bossBusy') }, '★'),
          h('button', { class: 'sb-x sb-folder', title: t('sidebar.openFolderTitle', { dir: p.dir }), 'aria-label': t('sidebar.openFolder'), onclick: (e) => { e.stopPropagation(); on.openFolder?.(p); } }, '📁'),
          h('button', {
            class: 'sb-x sb-gear', title: t('sidebar.projectSettingsTitle'), 'aria-label': t('sidebar.projectSettings'),
            onclick: (e) => { e.stopPropagation(); openProjectSettings(p); },
          }, '⚙'),
          h('button', {
            class: 'sb-x', title: t('sidebar.removeFromList'),
            onclick: (e) => { e.stopPropagation(); on.removeProject(p); },
          }, '×')),
        h('div', { class: 'sb-meta' },
          claude ? onBackupTag(p) : null,
          loginBadge(p),
          engineTag(p),
          h('span', { class: 'sb-stats', title: statsText(s) }, statsText(s)),
        ),
        h('button', {
          class: 'sb-cost', hidden: !cap(engineOfRow(p), 'cost').ok || !briefs.has(p.id), title: t('sidebar.costTitle'),
          onclick: (e) => { e.stopPropagation(); on.openUsage?.(p); },
        }, costText(briefs.get(p.id))),
      );
    };
    projList.replaceChildren(...projects.map((p, i) => rowOf(p, i)));
    if (!projects.length) projList.append(h('li', { class: 'sb-empty' }, t('sidebar.noProjects')));
    renderMcp();
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

  /** "Use Default's plugins, skills and MCP servers" (default on); applies when the account's sessions start next. */
  function shareRow(a) {
    return h('label', { class: 'sb-share', title: t('sidebar.shareDefaultTitle') },
      h('input', {
        type: 'checkbox', class: 'sb-check', checked: a.shareDefault !== false,
        onchange: (e) => on.setShare?.(a.id, e.target.checked),
      }),
      h('span', {}, t('sidebar.shareDefault')));
  }

  // The official install lines (src/agy-auth.js AGY_INSTALL): shown, never run.
  const AGY_INSTALL = platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
  /** Antigravity is listed when agy is installed or a project runs it (contract v3.24), or added via Add account; removed hides it unless a project runs it (v3.30). */
  const agyUsed = () => projects.some((p) => p.engine === 'agy');
  const agyShown = () => agyUsed() || showAgy === true || (showAgy !== false && Boolean(agyAuth?.installed));
  // Command Code (contract v3.30): the same rule with commandcode and engine 'commandcode'.
  const CMD_INSTALL = 'npm i -g command-code';
  const cmdUsed = () => projects.some((p) => p.engine === 'commandcode');
  const cmdShown = () => cmdUsed() || showCmd === true || (showCmd !== false && Boolean(cmdAuth?.installed));
  // OpenCode (contract v3.40): the same rule; its free models need no login, so a row without one is normal.
  const OC_INSTALL = platform === 'win32' ? 'npm i -g opencode-ai' : 'curl -fsSL https://opencode.ai/install | bash';
  const ocUsed = () => projects.some((p) => p.engine === 'opencode');
  const ocShown = () => ocUsed() || showOc === true || (showOc !== false && Boolean(ocAuth?.installed));
  const rowBtn = (cls, text, title, fn) => h('button', { class: 'sb-btn ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(); } }, text);
  /** × on an engine row: hides it (no log out); not while a project runs that engine. */
  const hideBtn = (used, fn) => (used ? null : h('button', { class: 'sb-x', title: t('sidebar.hideEngineRow'), onclick: () => fn() }, '×'));

  /** Antigravity's single login (contract v3.24): its state with Giriş yap / Çıkış yap, or how to install agy. */
  function agyRow() {
    if (!agyShown()) return null;
    const state = agyAuth?.state || 'checking';
    const btn = (cls, text, title, fn) => h('button', { class: 'sb-btn ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(); } }, text);
    const loginBtn = () => btn('primary', t('sidebar.login'), t('sidebar.agyLoginTitle'), () => on.agyLogin?.());
    const logoutBtn = () => btn('', t('sidebar.logout'), t('sidebar.agyLogoutTitle'), () => on.agyLogout?.());
    const text = (s, title = '') => h('span', { class: 'sb-auth-text' + (state === 'in' ? ' sb-email' : ''), title }, s);
    let auth;
    if (state === 'missing') {
      auth = h('div', { class: 'sb-auth sb-agy-missing' }, text(t('sidebar.agyMissing'), t('sidebar.agyMissingTitle')),
        rowBtn('', t('sidebar.checkAgain'), t('sidebar.checkAgainTitle'), () => on.agyRefresh?.()),
        h('code', { class: 'sb-agy-install', title: t('sidebar.agyInstallTitle') }, AGY_INSTALL));
    } else if (state === 'in') {
      const key = agyAuth.method === 'apikey' || agyAuth.method === 'adc';
      auth = h('div', { class: 'sb-auth' },
        text(agyAuth.email || t(agyAuth.method === 'apikey' ? 'sidebar.agyApiKey' : agyAuth.method === 'adc' ? 'sidebar.agyAdc' : 'sidebar.loggedIn'),
          key ? t('sidebar.agyKeyNote') : agyAuth.email || ''),
        h('span', { class: 'sb-method', title: t('sidebar.loginMethod') }, agyAuth.method === 'google' ? 'Google' : ''),
        key ? null : logoutBtn());
    } else if (state === 'out') {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.notLoggedIn')), loginBtn());
    } else if (state === 'unknown') {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.agyUnknown'), t('sidebar.agyUnknownTitle')), loginBtn(), logoutBtn());
    } else {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.checking')));
    }
    return h('li', { class: `sb-acc sb-agy auth-${state}`, 'data-id': 'agy' },
      h('div', { class: 'sb-acc-top', title: t('sidebar.agyTitle') },
        h('span', { class: 'sb-adot', title: hasText(`sidebar.authDot.${state}`) ? t(`sidebar.authDot.${state}`) : '' }),
        h('span', { class: 'sb-name' }, 'Antigravity'),
        h('span', { class: 'sb-tag' }, 'agy'),
        h('button', { class: 'sb-x', title: t('sidebar.refreshAuth'), disabled: state === 'checking', onclick: () => on.agyRefresh?.() }, '↻'),
        hideBtn(agyUsed(), () => on.hideAgy?.()),
      ),
      auth);
  }

  /** Command Code's single login (contract v3.30): logged in = ~/.commandcode/auth.json exists; Giriş yap runs `commandcode login`. */
  function cmdRow() {
    if (!cmdShown()) return null;
    const state = cmdAuth?.state || 'checking';
    const text = (s, title = '') => h('span', { class: 'sb-auth-text', title }, s);
    let auth;
    if (state === 'missing') {
      auth = h('div', { class: 'sb-auth sb-agy-missing' }, text(t('sidebar.cmdMissing'), t('sidebar.cmdMissingTitle')),
        rowBtn('', t('sidebar.checkAgain'), t('sidebar.checkAgainTitle'), () => on.cmdRefresh?.()),
        h('code', { class: 'sb-agy-install', title: t('sidebar.cmdInstallTitle') }, CMD_INSTALL));
    } else if (state === 'in') {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.loggedIn'), t('sidebar.cmdInTitle')));
    } else if (state === 'out') {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.notLoggedIn')),
        rowBtn('primary', t('sidebar.login'), t('sidebar.cmdLoginTitle'), () => on.cmdLogin?.()));
    } else {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.checking')));
    }
    return h('li', { class: `sb-acc sb-agy sb-cmd auth-${state}`, 'data-id': 'cmd' },
      h('div', { class: 'sb-acc-top', title: t('sidebar.cmdTitle') },
        h('span', { class: 'sb-adot', title: hasText(`sidebar.authDot.${state}`) ? t(`sidebar.authDot.${state}`) : '' }),
        h('span', { class: 'sb-name' }, 'Command Code'),
        h('span', { class: 'sb-tag' }, 'cmd'),
        h('button', { class: 'sb-x', title: t('sidebar.refreshAuth'), disabled: state === 'checking', onclick: () => on.cmdRefresh?.() }, '↻'),
        hideBtn(cmdUsed(), () => on.hideCmd?.()),
      ),
      auth);
  }

  /** OpenCode's logins (contract v3.40): the providers it is logged in to, with Giriş yap / Çıkış yap; or that
   *  the free models work without any login. v1: Giriş yap opens the login chooser (normal device code vs one
   *  provider); v2.x has one login (`opencode auth login opencode`), so it starts right away. */
  function ocRow() {
    const toggle = (e) => { e.stopPropagation(); ocLoginMenu = !ocLoginMenu; renderAccounts(); acctList.querySelector('.sb-oc-menu')?.scrollIntoView?.({ block: 'nearest' }); };
    if (!ocShown()) return null;
    const state = ocAuth?.state || 'checking';
    const v2 = (ocAuth?.major ?? 0) >= 2;
    // v2.x ignores the mode for login (one login, `auth login opencode`); 'console' is the allowlisted default (v3.41)
    const v2Login = () => on.ocLogin?.('console');
    // which logout main runs (ocLoginArgs, v3.41): the OpenCode entry when it is logged in, else `auth logout` (asks which)
    const consoleIn = (ocAuth?.providers || []).some((x) => x.id === 'opencode');
    const logoutTitle = t(!consoleIn ? 'sidebar.ocLogoutAuth' : v2 ? 'sidebar.ocLogoutV2' : 'sidebar.ocLogoutTitle');
    const text = (s, title = '') => h('span', { class: 'sb-auth-text' + (state === 'in' ? ' sb-email' : ''), title }, s);
    let auth;
    if (state === 'missing') {
      auth = h('div', { class: 'sb-auth sb-agy-missing' }, text(t('sidebar.ocMissing'), t('sidebar.ocMissingTitle')),
        rowBtn('', t('sidebar.checkAgain'), t('sidebar.checkAgainTitle'), () => on.ocRefresh?.()),
        h('code', { class: 'sb-agy-install', title: t('sidebar.ocInstallTitle') }, OC_INSTALL));
    } else if (state === 'in') {
      const names = (ocAuth.providers || []).map((x) => x.id).join(', ');
      auth = h('div', { class: 'sb-auth' }, text(names || t('sidebar.loggedIn'), t('sidebar.ocInTitle', { providers: names })),
        rowBtn('', t('sidebar.login'), t(v2 ? 'sidebar.ocLoginV2' : 'sidebar.ocAddTitle'), v2 ? v2Login : toggle),
        rowBtn('', t('sidebar.logout'), logoutTitle, () => on.ocLogout?.()));
    } else if (state === 'out') {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.ocFree'), t('sidebar.ocFreeTitle')),
        rowBtn('primary', t('sidebar.login'), t(v2 ? 'sidebar.ocLoginV2' : 'sidebar.ocLoginTitle'), v2 ? v2Login : toggle));
    } else {
      auth = h('div', { class: 'sb-auth' }, text(t('sidebar.checking')));
    }
    return h('li', { class: `sb-acc sb-agy sb-oc auth-${state}`, 'data-id': 'oc' },
      h('div', { class: 'sb-acc-top', title: t('sidebar.ocTitle') },
        h('span', { class: 'sb-adot', title: hasText(`sidebar.authDot.${state}`) ? t(`sidebar.authDot.${state}`) : '' }),
        h('span', { class: 'sb-name' }, 'OpenCode'),
        h('span', { class: 'sb-tag' }, 'oc'),
        h('button', { class: 'sb-x', title: t('sidebar.refreshAuth'), disabled: state === 'checking', onclick: () => on.ocRefresh?.() }, '↻'),
        hideBtn(ocUsed(), () => on.hideOc?.()),
      ),
      auth);
  }

  /** The OpenCode login chooser (like the Add account type menu): normal login (`opencode console login`, the device
   *  code) or one provider (OAuth in the browser, or an API key, `opencode auth login`). v1 only: v2.x has one login. */
  function ocLoginMenuRow() {
    const item = (text, title, fn) => h('button', {
      class: 'sb-add-item sb-oc-item', title,
      onclick: (e) => { e.stopPropagation(); ocLoginMenu = false; fn(); },
    }, text);
    return h('li', { class: 'sb-oc-menu', role: 'menu' },
      item(t('sidebar.ocNormalLogin'), t('sidebar.ocNormalLoginTitle'), () => on.ocLogin?.('console')),
      item(t('sidebar.ocApiKeyLogin'), t('sidebar.ocApiKeyLoginTitle'), () => on.ocLogin?.('auth')));
  }

  /** The Add account type menu (contract v3.30): Claude (the name field, as before), Google Antigravity, Command Code. */
  function addMenuRow() {
    const item = (text, title, fn) => h('button', {
      class: 'sb-add-item', title,
      onclick: (e) => { e.stopPropagation(); addMenu = false; fn(); addFor = null; },
    }, text);
    return h('li', { class: 'sb-add-menu', role: 'menu' },
      item(t('sidebar.addClaude'), t('sidebar.newAccountTitle'), () => { editing = { id: null, ...(addFor ? { forProject: addFor } : {}) }; renderAccounts(); }),
      item(t('sidebar.addAgy'), t('sidebar.addAgyTitle'), () => { renderAccounts(); on.addAgy?.(); }),
      item(t('sidebar.addCmd'), t('sidebar.addCmdTitle'), () => { renderAccounts(); on.addCmd?.(); }),
      item(t('sidebar.addOc'), t('sidebar.addOcTitle'), () => { renderAccounts(); on.addOc?.(); }));
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
        isDefault ? null : shareRow(a),
      );
    });
    if (editing && editing.id === null) {
      const forProject = editing.forProject;
      rows.push(h('li', { class: 'sb-acc editing' }, nameInput('', (label) => {
        if (label) on.addAccount(label, forProject);
      })));
    }
    const agy = agyRow();
    const cmd = cmdRow();
    const oc = ocRow();
    const ocMenu = oc && (ocAuth?.major ?? 0) < 2 && ocLoginMenu ? ocLoginMenuRow() : null;
    acctList.replaceChildren(...rows, ...(agy ? [agy] : []), ...(cmd ? [cmd] : []), ...(oc ? [oc] : []),
      ...(ocMenu ? [ocMenu] : []),
      h('li', {}, h('button', {
        class: 'sb-add', title: t('sidebar.addAccountTitle'), 'aria-haspopup': 'menu', 'aria-expanded': String(addMenu),
        onclick: (e) => { e.stopPropagation(); addMenu = !addMenu; addFor = null; renderAccounts(); acctList.querySelector('.sb-add-menu')?.scrollIntoView?.({ block: 'nearest' }); },
      }, t('sidebar.addAccount'))),
      ...(addMenu ? [addMenuRow()] : []));
  }
  // the type menu and the OpenCode login chooser close on a click elsewhere or Escape
  document.addEventListener('click', (e) => {
    if (addMenu && !(e.target instanceof Node && acctList.querySelector('.sb-add-menu')?.contains(e.target))) { addMenu = false; addFor = null; renderAccounts(); }
    if (ocLoginMenu && !(e.target instanceof Node && acctList.querySelector('.sb-oc-menu')?.contains(e.target))) { ocLoginMenu = false; renderAccounts(); }
  });
  document.addEventListener('keydown', (e) => {
    if (addMenu && e.key === 'Escape') { addMenu = false; addFor = null; renderAccounts(); }
    if (ocLoginMenu && e.key === 'Escape') { ocLoginMenu = false; renderAccounts(); }
  });

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
    setResume(on) { resumeBox.checked = on !== false; syncResumeWork(); },
    /** Setting to carry on interrupted work at launch (greyed while "continue last session" is off). */
    setResumeWork(on) { resumeWorkBox.checked = on !== false; syncResumeWork(); },
    /** The button is working (main checks the transcripts): no second click meanwhile. */
    setResuming(on) { resumeAllBtn.disabled = Boolean(on); },
    /**
     * Result of "Resume unfinished work": { resumed: [{ id, name }], skipped: [{ id, name }] } (main's
     * resumeUnfinished), shown under the button for a while; null hides it.
     */
    showResumed(r) {
      clearTimeout(noteTimer);
      if (!r) { resumeNote.hidden = true; return; }
      const names = (list) => list.map((x) => x.name).join(', ');
      const resumed = Array.isArray(r.resumed) ? r.resumed : [];
      const skipped = Array.isArray(r.skipped) ? r.skipped : [];
      const lines = [resumed.length ? t('sidebar.resumeUnfinishedDone', { n: resumed.length, names: names(resumed) }) : t('sidebar.resumeUnfinishedNone')];
      if (skipped.length) lines.push(t('sidebar.resumeUnfinishedSkipped', { names: names(skipped) }));
      resumeNote.textContent = lines.join('\n');
      resumeNote.classList.toggle('is-none', !resumed.length);
      resumeNote.hidden = false;
      noteTimer = setTimeout(() => { resumeNote.hidden = true; }, 12000);
    },
    /** Manager mode setting (the boss delegates to agents). */
    setManager(on) { managerBox.checked = on !== false; },
    /** "Share MCP servers between projects" setting (v3.9). */
    setShareMcp(on) { shareMcpBox.checked = on !== false; },
    /** "Reload sessions when MCP changes" setting (v3.11). */
    setReloadMcp(on) { reloadMcpBox.checked = on !== false; },
    /** "Backup account at the usage limit" setting (v3.17). */
    setFallback(on) { fallbackBox.checked = on !== false; },
    /** Minutes after which an idle background session sleeps (0 = off). */
    setSleep(minutes) {
      if (!SLEEP_CHOICES.includes(minutes)) return;
      sleepMinutes = minutes;
      renderSleep();
    },
    /** Bot color shown in the picker. */
    setBotColor(hex) { botInput.value = hex || '#3fb6a8'; },
    /** Project list, active project, working state and accounts. */
    setState(s) {
      projects = s.projects || [];
      accounts = s.accounts || [];
      activeId = s.activeId;
      status = new Map((s.status || []).map((x) => [x.id, x.isRunning]));
      asleep = new Set((s.status || []).filter((x) => x.isAsleep).map((x) => x.id));
      attn = new Map((s.status || []).filter((x) => x.attention).map((x) => [x.id, x.attention]));
      const pk = JSON.stringify([projects, activeId, [...status], [...asleep], [...attn], accounts.map((a) => [a.id, a.label, a.auth?.state])]);
      if (pk !== projKey) { projKey = pk; renderProjects(); }
      const ak = JSON.stringify([accounts, agyShown(), cmdShown(), ocShown()]);
      if (ak !== acctKey && !editing) { acctKey = ak; renderAccounts(); }
    },
    /** Antigravity's login state (contract v3.24, main's AgyAuth). */
    setAgyAuth(a) {
      const before = JSON.stringify([agyAuth?.state, agyAuth?.email]);
      agyAuth = a || null;
      if (before !== JSON.stringify([agyAuth?.state, agyAuth?.email])) renderProjects();
      if (!editing) renderAccounts();
    },
    /** Command Code's login state (contract v3.30, main's CmdAuth). */
    setCmdAuth(a) {
      const before = cmdAuth?.state;
      cmdAuth = a || null;
      if (before !== cmdAuth?.state) renderProjects();
      if (!editing) renderAccounts();
    },
    /** OpenCode's login state (contract v3.40, main's OcAuth). */
    setOcAuth(a) {
      ocAuth = a || null;
      if (!editing) renderAccounts();
    },
    /** The Antigravity / Command Code / OpenCode rows' setting (contract v3.30, prefs showAgyAccount / showCmdAccount). */
    setEngineRows(p) {
      showAgy = typeof p?.showAgyAccount === 'boolean' ? p.showAgyAccount : null;
      showCmd = typeof p?.showCmdAccount === 'boolean' ? p.showCmdAccount : null;
      showOc = typeof p?.showOcAccount === 'boolean' ? p.showOcAccount : null;
      if (!editing) renderAccounts();
    },
    /** Today's token usage per project: [{ id, usd, total, pct }] (contract v3.13); the line opens the usage panel. */
    setTokenBriefs(list) {
      briefs = new Map((Array.isArray(list) ? list : []).filter((b) => b && b.id).map((b) => [b.id, b]));
      for (const li of el.querySelectorAll('.sb-proj')) {
        const btn = li.querySelector('.sb-cost');
        if (!btn) continue;
        const b = briefs.get(li.dataset.id);
        const p = projects.find((x) => x.id === li.dataset.id);
        btn.hidden = !b || !p || !cap(engineOfRow(p), 'cost').ok; // Antigravity: no token counts (contract v3.36)
        btn.textContent = costText(b);
      }
    },
    /** OfficeData.projects: working / delivered / boss by project name. */
    setStats(list) {
      stats = new Map((list || []).map((s) => [s.name, s]));
      for (const li of el.querySelectorAll('.sb-proj')) {
        const p = projects.find((x) => x.id === li.dataset.id);
        const s = p && stats.get(p.name);
        const t = statsText(s);
        const st = li.querySelector('.sb-stats');
        if (st.textContent !== t) { st.textContent = t; st.title = t; }
        li.querySelector('.sb-boss').hidden = !isBossHere(s);
      }
    },
  };
}
