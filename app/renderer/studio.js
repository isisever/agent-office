// Studio experience (contract v3.120): an optional layout in the same window, like Claude Desktop's Code view.
// body.studio hides the Office (scene, left panel, tab strip, style.css); this module adds Studio's own sidebar and its
// start screen. The main region is the existing #terminal: the active session's chat view (or its terminal on Windows,
// where GUI chat is off) as the Office shows it, so no chat is rendered twice. Switching back removes body.studio and
// the Office is as it was: panes, tabs and sessions are never touched here.
// Every text from main (project, session, device and account names) is put in with textContent.

import { studioGroups, currentProjectId, filterPalette, expandProject, sessionNames, canCloseSession } from '../src/studio-view.mjs';
import { showAccountTags, projectRowView, escClearsFilter, projectClickTarget } from '../src/studio-projects.mjs';
import { studioSections, planMove, dropSide, groupNameOf, GROUP_MAX } from '../src/studio-order.mjs';
import { icon } from './studio-icons.js';
import { meterView, amountText } from '../src/economy-view.mjs';
import { mountSettingsPage } from './studio-settings.js';
import { mountTeamPage } from './studio-team.js';
import { teamGroups, whoOptions, whoPlan } from '../src/studio-team.mjs';
import { hasText } from './i18n.js';
import { anchorAbove } from '../src/menu-anchor.mjs';
import { accountChoices, accountToSet, pickerUseful } from '../src/studio-account-picker.mjs';
import { relativeTime, firstName, START_MODELS, START_MODES, startPlan, startPickers, renameText, defaultModelName } from '../src/studio-ux.mjs';
import { syncSelect, setProp } from './select-sync.js';
import { remoteGroups, remoteDot, machineTag } from '../src/studio-remote.mjs';
import { mountRemoteView } from './remote-view.js';

const REFRESH_MS = 5000;   // v3.120 Studio UX: the rows' live state (working, waiting) and the header follow within 5 s
const THEME_KEY = 'ao.studio.theme';   // Studio's own light / dark choice ('system' | 'light' | 'dark', this window only)
const OPEN_KEY = 'ao.studio.openProjects';   // v3.150 the projects the person expanded (all others start collapsed)

/** @param {string} tag @param {Record<string, any>} [props] @param {...(Node | string | null | false | undefined)} kids */
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'hidden') e.hidden = Boolean(v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/**
 * @typedef {{ id: string, label: string, keywords?: string, run: () => void }} StudioCommand
 * @param {{
 *   api: any, t: (key: string, vars?: Record<string, any>) => string, modLabel: string,
 *   hooks: {
 *     selectSession: (projectId: string, n: number) => void, newSession: (projectId: string) => void,
 *     closeSession: (projectId: string, n: number) => void,
 *     selectProject: (projectId: string) => void, selectHq: () => void, openBoard: () => void,
 *     openOfficeSettings: () => void, sidebar: () => any, showPanel: (selector: string) => boolean,
 *     appInfo: () => { version: string | null, ready: string | null }, installUpdate: () => void, toggle: () => void,
 *     openWhatsNew?: () => void,
 *     openFloat?: (selector: string) => boolean, closeFloat?: (selector: string) => void,
 *     openDesk: (projectId: string, staffId: string) => Promise<string | null>, startDesk: (projectId: string, staffId: string, text: string) => Promise<{ ok: boolean, failed?: { step: string, why: string, detail: string } }>, activePty: () => string | null, hasSession: () => boolean,
 *     startSession: (projectId: string, plan: { tabMode: 'same' | 'worktree', settings: [string, string][], reuseN?: number }, text: string) => Promise<{ ok: boolean, n: number, failed?: { step: string, why: string, detail: string } }>,
 *     projectSettings: (projectId: string) => void, showAccounts: () => void, isMac: boolean,
 *     commands: (projectId: string) => StudioCommand[],
 *     saveMember: (form: any) => Promise<any>, removeMember: (id: string) => Promise<any>, reloadTeam: () => Promise<any>,
 *     teamTools: () => Promise<{ id: string, name: string }[]>,
 *   },
 * }} o
 */
/** v3.122 the Office's floating panels outside the sidebar that studio.showPanel can show (hooks.openFloat opens them). */
export const FLOATS = Object.freeze(['#usage-panel', '#machines-panel']);

export function mountStudio({ api, t, modLabel, hooks }) {
  if (!api?.studio) return null;
  let on = false;
  /** @type {any} */
  let view = { user: { name: '', email: '', account: '' }, projects: [] };
  /** @type {any[]} */
  let devices = [];
  let picked = '';   // the project the person last chose in the sidebar (⌘1…9 and ⌘N act on it)
  let query = '';
  let timer = 0;
  let soon = 0;
  // v3.150 projects start collapsed: only the expanded ones are stored; `closed` keeps the Set-like shape the view expects
  const openIds = (() => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); } })();
  const closed = /** @type {Set<string>} */ (/** @type {unknown} */ ({
    has: (/** @type {string} */ id) => !openIds.has(id),
    add: (/** @type {string} */ id) => { openIds.delete(id); return closed; },
    delete: (/** @type {string} */ id) => { const was = !openIds.has(id); openIds.add(id); return was; },
  }));
  const saveClosed = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openIds])); } catch { /* storage off */ } };

  const search = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'st-search', oninput: () => { query = search.value.trim(); draw(); },
    onkeydown: (/** @type {KeyboardEvent} */ e) => { if (escClearsFilter(e.key, search.value)) { e.preventDefault(); e.stopPropagation(); search.value = ''; query = ''; draw(); } } }));
  const newLabel = el('span', { class: 'st-title' });
  const newBtn = el('button', { class: 'st-new st-row', onclick: () => newSession() }, el('span', { class: 'st-new-icon' }, icon('plus', 14)), newLabel);
  const pins = el('div', { class: 'st-pins' });
  const lists = el('div', { class: 'st-lists' });
  const machines = el('div', { class: 'st-machines' });
  const teamEl = el('div', { class: 'st-team' });   // v3.122 the Team section (team mode on)
  /** @type {Set<string>} */
  const openMembers = new Set();
  const account = el('div', { class: 'st-account' });
  const searchBox = el('label', { class: 'st-searchbox' }, icon('search', 14), search);
  const bar = el('aside', { id: 'studio-sidebar', hidden: true }, newBtn, searchBox, pins, lists, teamEl, machines, account);
  const greeting = el('p', { class: 'st-greeting' });
  // v3.120 Studio UX start screen: a centered composer with the project, its account, branch or new worktree, model
  // and permission mode; sending starts the session with those choices (tabs:add, then chat:setting, then the prompt)
  const startText = /** @type {HTMLTextAreaElement} */ (el('textarea', { class: 'st-start-input', rows: '3' }));
  const startProject = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-start-pick', onchange: () => { picked = startProject.value; draw(); } }));
  const startAccount = el('span', { class: 'st-start-account' });
  const startWorktree = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox' }));
  const startWtLabel = el('span', {});
  const startModel = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-start-pick' }));
  const startMode = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-start-pick' }));
  const startWho = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-start-pick st-start-who' }));   // v3.122 Who? Me or a member
  const startSend = /** @type {HTMLButtonElement} */ (el('button', { class: 'st-start-send', type: 'submit' }, icon('send', 16)));
  const startNote = el('div', { class: 'st-start-note', role: 'status' });
  const startForm = el('form', { class: 'st-start-box', onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); sendStart(); } },
    startText,
    el('div', { class: 'st-start-row' },
      startProject, startWho, startAccount, el('label', { class: 'st-start-wt' }, startWorktree, startWtLabel),
      el('span', { class: 'st-start-gap' }), startModel, startMode, startSend));
  const start = el('div', { id: 'studio-start', hidden: true }, greeting, startForm, startNote);
  startText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendStart(); }
    else if (e.key === 'Escape' && hooks.hasSession()) { e.preventDefault(); starting = false; draw(); }
  });
  let starting = false;   // ⌘N / + New session: the start screen over the current session until sent or left
  let startBusy = false;
  // v3.120 Studio UX header: in the title bar, the session's name (renamed in place with /rename), chips for the
  // project, branch and account, and the session's state; the Office's own title bar items are only hidden (studio.css)
  const headTitle = el('span', { class: 'st-head-title', tabindex: '0', role: 'button' });
  const headChips = el('span', { class: 'st-head-chips' });
  const headState = el('span', { class: 'st-head-state' });
  const header = el('div', { id: 'studio-header', hidden: true }, headTitle, headChips, headState);
  headTitle.addEventListener('click', () => renameStart());
  headTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); renameStart(); } });
  document.getElementById('titlebar')?.append(header);
  document.getElementById('body')?.prepend(bar);
  document.getElementById('terminal')?.append(start);
  // v3.122 Studio's Settings page (renderer/studio-settings.js), in the main region over the chat
  const settingsPage = mountSettingsPage({
    el, t, host: /** @type {HTMLElement} */ (document.getElementById('terminal') || document.body),
    studioTheme: () => studioTheme(), setStudioTheme: (v) => setStudioTheme(v),
    hooks: { sidebar: hooks.sidebar, showPanel: hooks.showPanel, selectHq: hooks.selectHq, openBoard: hooks.openBoard, appInfo: hooks.appInfo, installUpdate: hooks.installUpdate, openWhatsNew: hooks.openWhatsNew, openTeam: () => openTeam() },
  });
  // v3.124 Studio's Team page (renderer/studio-team.js), in the main region like Settings
  const teamPage = mountTeamPage({
    el, t, host: /** @type {HTMLElement} */ (document.getElementById('terminal') || document.body),
    hooks: {
      teamData: () => teamInfo(),
      accounts: () => { try { return hooks.sidebar()?.accountList?.() || []; } catch { return []; } },
      waiting: () => waitingDesks(),
      teamControl: () => /** @type {HTMLInputElement | null} */ (hooks.sidebar()?.settingControl?.('team')?.control || null),
      save: (form) => hooks.saveMember(form),
      remove: (id) => hooks.removeMember(id),
      reload: () => hooks.reloadTeam(),
      editMember: (m) => hooks.sidebar()?.editMember?.(m),
      openWizard: () => openWizard(),
      openDesk: (projectId, staffId) => { teamPage.close(); hooks.openDesk(projectId, staffId); },
      tools: () => hooks.teamTools(),
    },
  });
  /** v3.124 the Team page at a tab ('members', 'roles', 'departments'); the Office's Team panel outside Studio. */
  function openTeam(/** @type {string} */ tab = '') {
    if (!on) { hooks.showPanel('#sb-panel-team'); return; }
    menu.hidden = true;
    closePalette();
    hidePanel();
    settingsPage.close();
    teamPage.open(tab);
  }
  /** v3.124 the role wizard as Studio's chat sheet; a saved role goes on to the Team page's hire sheet. */
  function openWizard() {
    hooks.sidebar()?.openRoleWizard?.({
      studio: on,
      addMember: !on ? undefined : (/** @type {string} */ roleId, /** @type {any} */ role) => {
        menu.hidden = true;
        closePalette();
        hidePanel();
        settingsPage.close();
        teamPage.hire(role || { id: roleId });
      },
    });
  }
  /** v3.131 the board (Board or Reports tab) in the main region; pages and panels over it close. */
  function openBoard(/** @type {string} */ tab = 'board') {
    menu.hidden = true;
    closePalette();
    hidePanel();
    settingsPage.close();
    teamPage.close();
    hooks.openBoard(tab);
  }
  function openSettings(/** @type {string} */ section = '') {
    if (!on) { hooks.openOfficeSettings(); return; }
    menu.hidden = true;
    closePalette();
    hidePanel();
    teamPage.close();
    settingsPage.open(section);
  }
  /** @type {any} */
  let shown = null;   // the active session's row (header)

  const currentId = () => currentProjectId(view.projects, picked);
  const current = () => view.projects.find((/** @type {any} */ p) => p.id === currentId()) || null;
  /** The current project's running sessions, in the order ⌘1…9 picks them (filtered by the search like the list). */
  const shownSessions = () => studioGroups(view.projects, { query, currentId: currentId() }).find((g) => g.current)?.running || [];

  /** ⌘N, + New session (and ⌘⇧N with a new worktree): the start screen for the current project. */
  function newSession(/** @type {{ worktree?: boolean, projectId?: string }} */ o = {}) {
    if (o.projectId) picked = o.projectId;
    if (!currentId()) return;
    expandProject(closed, currentId()); saveClosed();   // v3.140 a collapsed project opens so its sessions stay listed
    teamPage.close();
    starting = true;
    startWorktree.checked = o.worktree === true;
    startNote.textContent = '';
    draw();
    startText.focus();
  }
  // v3.120 the tab a failed start created (its project and tab mode): sending again uses it, never a second tab
  /** @type {{ projectId: string, tabMode: string, n: number } | null} */
  let startTab = null;
  async function sendStart() {
    const id = startProject.value || currentId();
    const text = startText.value.trim();
    if (!id || !text || startBusy) return;
    startBusy = true;
    startSend.disabled = true;
    startNote.textContent = t('studio.start.starting');
    const td = teamInfo();
    const who = whoPlan(startWho.value, id, td?.staff || [], td?.projects || []);
    if (who.kind === 'stale') {   // the picked member is gone or no longer allowed here: never run it as Me
      startBusy = false;
      startSend.disabled = false;
      startNote.textContent = t('studio.team.whoStale');
      draw();
      startText.focus();
      return;
    }
    if (who.kind === 'desk') {
      /** @type {{ ok: boolean, failed?: { step: string, why: string, detail: string } }} */
      let r = { ok: false };
      try { r = await hooks.startDesk(who.projectId, who.staffId, text); } catch (e) { console.error(e); }
      startBusy = false;
      startSend.disabled = false;
      if (r.ok) { startText.value = ''; startNote.textContent = ''; starting = false; picked = id; expandProject(closed, id); saveClosed(); refresh(); return; }
      // the prompt was not sent: it stays in the box, and the note names why
      if (!startText.value.trim()) startText.value = text;
      const f = r.failed;
      const why = f && (f.detail || t(`studio.start.why.${f.why}`));
      startNote.textContent = f && f.step === 'prompt' ? t('studio.team.deskPromptFailed', { why }) : t('studio.team.deskFailed');
      startText.focus();
      return;
    }
    const plan = startPlan({ worktree: startWorktree.checked, model: startModel.value, mode: startMode.value }, [...startModel.options].filter((o) => !o.disabled).map((o) => o.value), startLists.get(id)?.caps || null);
    const reuseN = startTab && startTab.projectId === id && startTab.tabMode === plan.tabMode ? startTab.n : 0;
    /** @type {{ ok: boolean, n: number, failed?: { step: string, why: string, detail: string } }} */
    let r = { ok: false, n: 0 };
    try { r = await hooks.startSession(id, { ...plan, reuseN }, text); } catch (e) { console.error(e); }
    startBusy = false;
    startSend.disabled = false;
    if (r.ok) { startTab = null; startText.value = ''; startNote.textContent = ''; starting = false; picked = id; expandProject(closed, id); saveClosed(); refresh(); return; }
    startTab = r.n ? { projectId: id, tabMode: plan.tabMode, n: r.n } : null;
    // the prompt was not sent: it stays in the box, and the note names the step that failed and why
    if (!startText.value.trim()) startText.value = text;
    const f = r.failed;
    // each key in its own call: the locale test's key scanner does not read a t() nested inside another t()
    const stepLabel = !f ? '' : f.step === 'model' ? t('studio.start.step.theModel') : f.step === 'mode' ? t('studio.start.step.mode') : t('studio.start.step.prompt');
    const why = f && (f.detail || t(`studio.start.why.${f.why}`));
    startNote.textContent = f && f.step !== 'tab'
      ? t('studio.start.stepFailed', { step: stepLabel, why })
      : t('studio.start.failed');
    starting = true;
    draw();
    startText.focus();
  }
  /**
   * The header's title becomes a text box; Enter renames the session with /rename (v3.118 title order), Esc keeps it.
   * A GUI chat takes /rename as a message (Claude Code runs it locally: no turn, no restart); a terminal tab gets it
   * typed. A rename never moves or restarts the session.
   */
  function renameStart() {
    const pty = hooks.activePty();
    if (!shown || !pty || headTitle.querySelector('input')) return;
    const box = /** @type {HTMLInputElement} */ (el('input', { class: 'st-head-input', value: shown.title || '', maxlength: '120' }));
    const done = async (/** @type {boolean} */ save) => {
      const name = renameText(box.value);
      box.remove();
      draw();
      if (!save || !name || name === shown?.title) return;
      try {
        if (shown?.sessionId) await api.studio.renameSession(shown.sessionId, name);
        const r = await api.chat.rename(pty, name);
        if (r === 'terminal') await api.chat.send(pty, `/rename ${name}`);
      } catch (e) { console.error(e); }
      setTimeout(refresh, 800);
    };
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } });
    box.addEventListener('blur', () => { if (box.isConnected) done(false); });
    headTitle.replaceChildren(box);
    box.focus();
    box.select();
  }
  const rel = (/** @type {number} */ at) => relativeTime(at, Date.now(), document.documentElement.lang || navigator.language, t('studio.now'));
  /** A session's live state: a spinner while a turn runs, a badge while an approval or a question waits. */
  function stateEl(/** @type {any} */ s) {
    if (s.waiting) return el('span', { class: 'st-wait', title: t('studio.waiting') }, t('studio.waitingShort'));
    if (s.busy) return el('span', { class: 'st-spin', role: 'img', 'aria-label': t('studio.working'), title: t('studio.working') });
    return null;
  }
  async function open(/** @type {string} */ projectId, /** @type {any} */ ref) {
    picked = projectId;
    starting = false;
    teamPage.close();
    const r = await api.studio.open(projectId, ref).catch(() => null);
    if (r?.ok) { picked = r.projectId; hooks.selectSession(r.projectId, r.n); }
    refresh();
  }

  /** v3.140 the × on a session row: the Office's own close-tab handler (it asks first, also when the session is busy). */
  function closeBtn(/** @type {any} */ g, /** @type {any} */ s) {
    if (!canCloseSession(s)) return null;
    return el('button', { class: 'st-x', title: t('app.closeTab'), 'aria-label': t('app.closeTab'),
      onclick: (/** @type {MouseEvent} */ e) => { e.stopPropagation(); hooks.closeSession(g.id, s.n); setTimeout(refresh, 300); } }, icon('close', 12));
  }
  // v3.157 right-click a session row → Rename (inline): Enter saves, Esc cancels, empty = the automatic title again.
  // The name is kept per Claude session id in the app's state.json (studio:renameSession); a running session that has
  // no id yet falls back to the header's /rename. `renaming` survives the sidebar's redraws (the box is rebuilt each time).
  /** @type {{ key: string, value: string, focus: boolean } | null} */
  let renaming = null;
  const ctx = el('div', { class: 'st-menu st-ctx', role: 'menu', hidden: true });
  document.body.append(ctx);
  const closeCtx = () => { ctx.hidden = true; };
  function sessionMenu(/** @type {MouseEvent} */ e, /** @type {string} */ key, /** @type {string} */ name, /** @type {string} */ sid, /** @type {string} */ pty) {
    e.preventDefault();
    e.stopPropagation();
    ctx.replaceChildren(el('button', { class: 'st-menu-item', role: 'menuitem', type: 'button',
      onclick: () => { closeCtx(); renaming = { key, value: name, focus: true }; draw(); } }, icon('edit', 14), el('span', { class: 'st-title' }, t('studio.renameSession'))));
    ctx.hidden = false;
    ctx.dataset.sid = sid;
    ctx.dataset.pty = pty;
    const r = ctx.getBoundingClientRect();
    const view = { width: window.innerWidth, height: window.innerHeight };
    ctx.style.left = `${Math.min(e.clientX, Math.max(8, view.width - r.width - 8))}px`;
    ctx.style.top = `${Math.min(e.clientY, Math.max(8, view.height - r.height - 8))}px`;
  }
  async function saveName(/** @type {string} */ sid, /** @type {string} */ pty, /** @type {string} */ value) {
    const name = renameText(value);
    try {
      if (sid) await api.studio.renameSession(sid, name);
      else if (name && pty) { const r = await api.chat.rename(pty, name); if (r === 'terminal') await api.chat.send(pty, `/rename ${name}`); }
    } catch (e) { console.error(e); }
    refresh();
  }
  /** The row's title: the name, or the inline box while this row is being renamed. */
  function titleEl(/** @type {string} */ key, /** @type {string} */ name, /** @type {string} */ sid, /** @type {string} */ pty) {
    if (renaming?.key !== key) return el('span', { class: 'st-title' }, name);
    const st = renaming;
    const box = /** @type {HTMLInputElement} */ (el('input', { class: 'st-row-input', value: st.value, maxlength: '120', 'aria-label': t('studio.renameSession') }));
    const end = (/** @type {boolean} */ save) => { if (renaming !== st) return; renaming = null; if (box.isConnected) box.remove(); draw(); if (save) saveName(sid, pty, box.value); };
    box.addEventListener('input', () => { st.value = box.value; });
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } });
    box.addEventListener('blur', () => { if (box.isConnected && renaming === st && !st.focus) end(true); });
    if (st.focus) setTimeout(() => { st.focus = false; box.focus(); box.select(); }, 0);
    return box;
  }
  document.addEventListener('mousedown', (e) => { if (!ctx.hidden && !(e.target instanceof Node && ctx.contains(e.target))) closeCtx(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ctx.hidden) closeCtx(); });
  window.addEventListener('blur', closeCtx);
  function sessionRow(/** @type {any} */ g, /** @type {any} */ s, /** @type {number} */ i, /** @type {string} */ name) {
    const active = hooks.activePty() === s.ptyId;
    const state = s.isRunning ? 'live' : s.isAsleep ? 'asleep' : '';
    const live = stateEl(s);
    const key = `run:${s.ptyId}`;
    return el('div', { class: `st-row st-session${active ? ' active' : ''}`, title: [name, s.label, s.branch].filter(Boolean).join(' · '), onclick: () => { if (renaming?.key !== key) open(g.id, { n: s.n }); },
      oncontextmenu: (/** @type {MouseEvent} */ e) => sessionMenu(e, key, s.title || '', s.sessionId || '', s.ptyId) },
      s.busy && !s.waiting ? live : el('span', { class: `sb-dot ${state}` }),
      titleEl(key, name, s.sessionId || '', s.ptyId),
      s.waiting ? live : null,
      s.at ? el('span', { class: 'st-time' }, rel(s.at)) : null,
      closeBtn(g, s),
      g.current && i < 9 ? el('span', { class: 'st-key' }, `${modLabel}${i + 1}`) : null);
  }
  function recentRow(/** @type {any} */ g, /** @type {any} */ r) {
    const key = `rec:${r.sessionId}`;
    return el('div', { class: 'st-row st-session st-recent', title: new Date(r.at).toLocaleString(), onclick: () => { if (renaming?.key !== key) open(g.id, { sessionId: r.sessionId }); },
      oncontextmenu: (/** @type {MouseEvent} */ e) => sessionMenu(e, key, r.title || '', r.sessionId, '') },
      el('span', { class: 'sb-dot' }), titleEl(key, r.title || t('studio.untitled'), r.sessionId, ''), r.at ? el('span', { class: 'st-time' }, rel(r.at)) : null);
  }
  /** v3.150 One flat project row: caret, name (wraps), small account tag, state, session count, hover "+". Sessions only while expanded. */
  function groupEl(/** @type {any} */ g, /** @type {boolean} */ tags) {
    const v = projectRowView(g, { closed, query });
    const toggle = () => { if (closed.has(g.id)) closed.delete(g.id); else closed.add(g.id); saveClosed(); draw(); };
    const head = el('div', { class: `st-group-head st-proj${g.active ? ' active' : ''}${g.current ? ' current' : ''}`, title: g.name },
      v.expandable
        ? el('button', { class: 'st-caret', 'aria-expanded': String(v.expanded), title: g.name, onclick: (/** @type {MouseEvent} */ e) => { e.stopPropagation(); toggle(); } }, icon('chevron', 12))
        : el('span', { class: 'st-caret-gap', 'aria-hidden': 'true' }),
      el('span', { class: 'st-proj-text', onclick: () => { picked = g.id; const target = projectClickTarget(g); if (target) { open(g.id, target); return; } hooks.selectProject(g.id); refresh(); } },
        el('span', { class: 'st-project' }, g.name),
        tags && g.account ? el('span', { class: 'st-acct', title: `${t('studio.account')}: ${g.account}` }, g.account) : null),
      g.attention ? el('span', { class: `sb-attn ${g.attention}` }, '●') : null,
      v.busy ? el('span', { class: 'st-spin', role: 'img', 'aria-label': t('studio.working') })
        : v.live ? el('span', { class: 'sb-dot live', 'aria-hidden': 'true' }) : null,
      v.count && !v.expanded ? el('span', { class: 'st-count', title: t('studio.sessionCount', { n: String(v.count) }) }, String(v.count)) : null,
      el('button', { class: 'st-add', title: `${t('studio.newSession')} · ${g.name}`, onclick: () => newSession({ projectId: g.id }) }, icon('plus', 14)));
    const kids = !v.expanded ? [] : [
      ...(() => { const names = sessionNames(g.running, t('studio.untitled')); return g.running.map((/** @type {any} */ s, /** @type {number} */ i) => sessionRow(g, s, i, names[i])); })(),
      ...(g.recent.length ? [el('div', { class: 'st-sub' }, t('studio.recent')), ...g.recent.map((/** @type {any} */ r) => recentRow(g, r))] : []),
    ];
    return el('div', { class: `st-group${g.current ? ' current' : ''}` }, head, budgetBar(g.id), ...kids);
  }

  // ---- v3.153 paired machines' projects as rows of the Projects list: same row shape, a small machine tag, dimmed while
  // that machine is offline. Only what the device link allows: session view, command box, start/wake/sleep/stop/restart ----
  const rview = api.link?.sessOpen ? mountRemoteView({ api, t, inline: true, onChange: () => draw() }) : null;
  const remoteOpen = /** @type {Set<string>} */ (new Set());   // expanded remote rows (this window)
  const remoteBusy = /** @type {Set<string>} */ (new Set());
  let remoteLink = /** @type {any} */ (null);
  function remoteEl(/** @type {any} */ g) {
    const open = remoteOpen.has(g.key) || Boolean(query);
    const dot = remoteDot(g);
    // v3.158 a click selects the row: its session opens in the main chat (like a local session); the caret only expands
    const viewable = g.canView || g.dim;   // an offline machine opens too: last known content, read-only
    const select = () => {
      remoteOpen.add(g.key);
      if (viewable && rview) rview.open({ key: g.key, pub: g.pub, project: g.projectId, name: g.name, machine: g.machine, status: g.status || 'idle', online: g.online, canSend: g.canSend });
      draw();
    };
    if (rview?.isOpen(g.key) && rview.sync({ key: g.key, online: g.online, canSend: g.canSend, status: g.status || 'idle' })) setTimeout(select, 0);   // the machine came back: reopen live
    const toggle = () => { if (remoteOpen.has(g.key)) remoteOpen.delete(g.key); else remoteOpen.add(g.key); draw(); };
    const head = el('div', { class: `st-group-head st-proj st-remote${rview?.isOpen(g.key) ? ' current' : ''}${g.dim ? ' st-dim' : ''}`, title: g.dim ? `${g.name} · ${t('studio.remote.offline', { machine: g.machine })}` : `${g.name} · ${t('studio.remote.runsOn', { machine: g.machine })}` },
      el('button', { class: 'st-caret', 'aria-expanded': String(open), title: g.name, onclick: (/** @type {MouseEvent} */ e) => { e.stopPropagation(); toggle(); } }, icon('chevron', 12)),
      el('span', { class: 'st-proj-text', onclick: select },
        el('span', { class: 'st-project' }, g.name),
        el('span', { class: 'st-acct st-mach', title: t('studio.remote.runsOn', { machine: g.machine }) }, [machineTag(g), g.account].filter(Boolean).join(' · '))),
      dot ? el('span', { class: `sb-dot ${dot}`, 'aria-hidden': 'true' }) : null);
    const kids = [];
    if (open) {
      if (g.dim) kids.push(el('div', { class: 'st-sub' }, t('studio.remote.offline', { machine: g.machine })));
      if (!g.dim && g.engine && g.engine !== 'claude') kids.push(el('div', { class: 'st-sub' }, t('devices.claudeOnly')));
      for (const o of (remoteLink?.outgoing || []).filter((/** @type {any} */ o) => o.pub === g.pub && o.project === g.projectId).slice(0, 2)) {
        kids.push(el('div', { class: `st-sub cmd-${o.status}` }, `${o.firstLine} — ${o.status === 'rejected' ? t('devices.cmd.rejected', { reason: t(`devices.reason.${o.reason}`) }) : t(`devices.cmd.${o.status}`)}`));
      }
      if (g.buttons.length) kids.push(el('div', { class: 'st-rops' }, ...g.buttons.map((/** @type {string} */ b) => el('button', { class: 'st-rop', disabled: remoteBusy.has(g.key) ? 'disabled' : false, onclick: () => {
        if (remoteBusy.has(g.key)) return;
        remoteBusy.add(g.key); draw();
        Promise.resolve(api.hq.remoteOp(g.key, b)).catch(() => {}).finally(() => { remoteBusy.delete(g.key); refresh(); });
      } }, b === 'restart' ? t('hq.restart') : t(`machines.op.${b}`)))));
    }
    return el('div', { class: `st-group st-remote-group${g.dim ? ' st-dim' : ''}` }, head, ...kids);
  }

  // v3.133 the project groups' thin budget meter (main's tokens:brief, about once a minute)
  /** @type {Map<string, any>} */
  let budgetBriefs = new Map();
  api.tokens?.onBrief?.((/** @type {any} */ list) => { budgetBriefs = new Map((Array.isArray(list) ? list : []).filter((b) => b && b.id).map((b) => [b.id, b])); draw(); });
  Promise.resolve(api.tokens?.brief?.()).then((/** @type {any} */ list) => { if (Array.isArray(list)) { budgetBriefs = new Map(list.filter((b) => b && b.id).map((b) => [b.id, b])); draw(); } }).catch(() => {});
  function budgetBar(/** @type {string} */ id) {
    const v = meterView(budgetBriefs.get(id));
    if (!v) return null;
    return el('div', { class: `st-budget ${v.level}`, title: t('sidebar.budgetMeter', { pct: v.pct, used: amountText(v.used, v.unit), limit: amountText(v.limit, v.unit), period: t(`sidebar.budget_${v.period}`) }) },
      el('i', { style: `width:${v.width}%` }));
  }
  // ---- v3.142 project order and groups: the Office's own data (state.projects order, Project.group), changed through
  // projects:move / projects:renameGroup; the headings collapse with the Office's `ao.closedGroups` ----
  const closedSect = (() => { try { return new Set(JSON.parse(localStorage.getItem('ao.closedGroups') || '[]')); } catch { return new Set(); } })();
  const saveClosedSect = () => { try { localStorage.setItem('ao.closedGroups', JSON.stringify([...closedSect])); } catch { /* storage off */ } };
  let dragId = '';   // the project being dragged
  /** @type {{ name?: string, fresh?: boolean, projectId?: string } | null} */
  let editing = null;   // a group heading being renamed, or the "new group" box
  const ordered = () => (view.projects || []).map((/** @type {any} */ p) => ({ id: p.id, group: p.group || '' }));
  async function applyMove(/** @type {string} */ id, /** @type {any} */ to) {
    const plan = planMove(ordered(), id, to);
    if (plan) { await api.projects?.move?.(id, plan.order, plan.group); await refresh(); }
  }
  const clearMarks = () => lists.querySelectorAll('.st-drop-before, .st-drop-after, .st-drop-into').forEach((e) => e.classList.remove('st-drop-before', 'st-drop-after', 'st-drop-into'));
  const endDrag = () => { dragId = ''; clearMarks(); draw(); };
  /** Makes a project's card draggable by its head; a drop on the card puts the dragged project before / after it. */
  function withDrag(/** @type {HTMLElement} */ node, /** @type {any} */ g) {
    const head = /** @type {HTMLElement | null} */ (node.querySelector('.st-group-head'));
    if (!head) return node;
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); projectMenu(g, e.clientX, e.clientY); });
    if (query) return node;
    head.draggable = true;
    head.addEventListener('dragstart', (e) => { dragId = g.id; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.id); } });
    head.addEventListener('dragend', endDrag);
    node.addEventListener('dragover', (e) => {
      if (!dragId || dragId === g.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const r = head.getBoundingClientRect();
      clearMarks();
      node.classList.add(dropSide(e.clientY, r.top, r.height) === 'before' ? 'st-drop-before' : 'st-drop-after');
    });
    node.addEventListener('drop', (e) => {
      if (!dragId || dragId === g.id) return;
      e.preventDefault();
      const r = head.getBoundingClientRect();
      const id = dragId;
      const side = dropSide(e.clientY, r.top, r.height);
      dragId = '';
      clearMarks();
      applyMove(id, side === 'before' ? { beforeId: g.id } : { afterId: g.id });
    });
    return node;
  }
  /** A project's right-click menu: move it to a group in use, a new group, or out of its group. */
  function projectMenu(/** @type {any} */ g, /** @type {number} */ x, /** @type {number} */ y) {
    document.querySelector('.st-ctx')?.remove();
    const names = studioSections(ordered()).map((x2) => x2.name).filter(Boolean);
    const row = (/** @type {string} */ label, /** @type {() => void} */ run) => el('div', { class: 'st-ctx-row', onclick: () => { menuEl.remove(); run(); } }, label);
    const menuEl = el('div', { class: 'st-ctx', style: `left:${x}px;top:${y}px` },
      el('div', { class: 'st-ctx-title' }, t('studio.moveToGroup')),
      ...names.filter((n) => n !== g.group).map((n) => row(n, () => applyMove(g.id, { group: n }))),
      row(t('studio.newGroup'), () => { editing = { fresh: true, projectId: g.id }; draw(); }),
      ...(g.group ? [row(t('studio.removeFromGroup', { group: g.group }), () => applyMove(g.id, { group: '' }))] : []));
    document.body.append(menuEl);
    const off = (/** @type {Event} */ e) => { if (e.target instanceof Node && menuEl.contains(e.target)) return; menuEl.remove(); document.removeEventListener('mousedown', off, true); };
    document.addEventListener('mousedown', off, true);
  }
  function nameInput(/** @type {string} */ value, /** @type {string} */ placeholder, /** @type {(v: string) => void} */ commit) {
    let done = false;
    const finish = (/** @type {boolean} */ ok) => { if (done) return; done = true; editing = null; const v = groupNameOf(input.value); draw(); if (ok && v) commit(v); };
    const input = /** @type {HTMLInputElement} */ (el('input', {
      class: 'st-group-input', value, placeholder, maxlength: String(GROUP_MAX),
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } },
      onblur: () => finish(true), onclick: (/** @type {Event} */ e) => e.stopPropagation(),
    }));
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return input;
  }
  /** A group heading: collapse, rename (double click), ungroup; a project dropped on it goes to the end of the group. */
  function sectionHead(/** @type {{ name: string, items: any[] }} */ sec) {
    const shut = !query && Boolean(sec.name) && closedSect.has(sec.name);
    const head = el('div', { class: 'st-sect-head', 'data-group': sec.name },
      sec.name ? el('button', { class: 'st-caret', 'aria-expanded': String(!shut), title: t('sidebar.groupToggle'), onclick: () => { if (closedSect.has(sec.name)) closedSect.delete(sec.name); else closedSect.add(sec.name); saveClosedSect(); draw(); } }, icon('chevron', 12)) : null,
      editing && editing.name === sec.name && sec.name
        ? nameInput(sec.name, sec.name, (v) => { if (closedSect.delete(sec.name)) { closedSect.add(v); saveClosedSect(); } api.projects?.renameGroup?.(sec.name, v)?.then?.(refresh); })
        : el('span', { class: 'st-sect-name', title: sec.name ? t('studio.renameGroup') : '', ondblclick: () => { if (sec.name) { editing = { name: sec.name }; draw(); } } }, sec.name || t('studio.ungrouped')),
      el('span', { class: 'st-sect-count' }, String(sec.items.length)),
      sec.name ? el('button', { class: 'st-add st-ungroup', title: t('studio.ungroup'), onclick: () => { closedSect.delete(sec.name); api.projects?.renameGroup?.(sec.name, '')?.then?.(refresh); } }, icon('plus', 14)) : null);
    head.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); clearMarks(); head.classList.add('st-drop-into'); });
    head.addEventListener('dragleave', () => head.classList.remove('st-drop-into'));
    head.addEventListener('drop', (e) => { if (!dragId) return; e.preventDefault(); const id = dragId; dragId = ''; clearMarks(); applyMove(id, { group: sec.name }); });
    return head;
  }
  /** The Projects heading with its "new group" button, the new-group box, and the project cards under group headings. */
  function projectsList(/** @type {any[]} */ groups) {
    const cur = current();
    const target = editing?.projectId ? (view.projects || []).find((/** @type {any} */ p) => p.id === editing?.projectId) : cur;
    const heading = el('div', { class: 'st-head st-head-row' }, el('span', {}, t('studio.projects')),
      el('button', { class: 'st-add st-newgroup', title: t('studio.newGroup'), disabled: query ? 'disabled' : false, onclick: () => { editing = { fresh: true }; draw(); } }, icon('plus', 14)));
    const fresh = editing?.fresh ? [el('div', { class: 'st-sect-head st-sect-new' }, nameInput('', t('studio.newGroupPh', { project: target?.name || '' }), (v) => { if (target) applyMove(target.id, { group: v }); }))] : [];
    const remote = remoteGroups(view.remotes, query).map((g) => remoteEl(g));
    if (!groups.length && !remote.length) return [heading, ...fresh, el('div', { class: 'st-none' }, t('studio.none'))];
    const tags = showAccountTags(groups);
    const sections = studioSections(groups);
    const flat = sections.length === 1 && !sections[0].name;
    return [heading, ...fresh, ...sections.flatMap((sec) => {
      const cards = (!query && sec.name && closedSect.has(sec.name)) ? [] : sec.items.map((g) => withDrag(groupEl(g, tags), g));
      return flat ? cards : [sectionHead(sec), ...cards];
    }), ...(remote.length && !flat ? [el('div', { class: 'st-sect-head' }, el('span', { class: 'st-sect-name' }, t('studio.remote.heading')))] : []), ...remote];
  }
  function draw() {
    if (!on || dragId) return;
    newLabel.textContent = t('studio.newSession');
    newBtn.title = `${t('studio.newSession')} (${modLabel}N · ${t('studio.worktreeKey')} ${hooks.isMac ? '⌘⇧N' : 'Ctrl+Shift+Alt+N'})`;
    search.placeholder = t('studio.search');
    pins.replaceChildren(
      el('div', { class: 'st-row st-pin', onclick: () => hooks.selectHq() }, icon('home'), el('span', { class: 'st-title' }, t('studio.hq'))),
      el('div', { class: 'st-row st-pin', onclick: () => openBoard('board') }, icon('board'), el('span', { class: 'st-title' }, t('studio.board'))),
      el('div', { class: 'st-row st-pin', onclick: () => openBoard('reports') }, icon('report'), el('span', { class: 'st-title' }, t('studio.reports'))),
      // v3.141 the Office's Usage panel (tokens and cost) for the current project
      el('div', { class: 'st-row st-pin', title: t('studio.usageTitle'), onclick: () => hooks.showPanel('#usage-panel') }, icon('coins'), el('span', { class: 'st-title' }, t('studio.usage'))),
      el('div', { class: 'st-row st-pin', onclick: () => hooks.openBoard() }, icon('clock'), el('span', { class: 'st-title' }, t('studio.routines'))),
      el('div', { class: 'st-row st-pin', title: `${modLabel}K`, onclick: () => openPalette() }, icon('command'), el('span', { class: 'st-title' }, t('studio.commands')), el('span', { class: 'st-key' }, `${modLabel}K`)));
    lists.replaceChildren(...projectsList(studioGroups(view.projects, { query, currentId: rview?.active() ? '' : currentId(), ordered: true })));
    // paired machines: read-only (a remote target is send-as-task plus a read-only view, from HQ's board)
    machines.replaceChildren(...(devices.length ? [el('div', { class: 'st-head' }, t('studio.machines')),
      ...devices.map((d) => el('div', { class: 'st-row st-device', title: d.online ? t('studio.online') : t('studio.offline') },
        icon('device'), el('span', { class: 'st-title' }, d.name), el('span', { class: `sb-dot${d.online ? ' live' : ''}` })))] : []));
    drawTeam();
    // the footer: the current project's Claude account (main's user is the active project's; a picked project's label)
    const u = view.user || {};
    const cur = current();
    const label = cur?.account || u.account || '';
    const sameAsActive = !cur || cur.active;
    const who = (sameAsActive && (u.name || u.email)) || label;
    // v3.120 Studio UX: one account button with a menu (theme, Settings, accounts, back to the Office)
    account.replaceChildren(el('button', { class: 'st-account-btn', type: 'button', 'aria-haspopup': 'menu', title: t('studio.accountMenu'), onclick: (/** @type {MouseEvent} */ e) => { e.stopPropagation(); toggleMenu(); } },
      el('span', { class: 'st-avatar', 'aria-hidden': 'true' }, (who.trim()[0] || '?').toLocaleUpperCase()),
      el('div', { class: 'st-user', title: `${t('studio.account')}: ${label}` },
        el('span', { class: 'st-title' }, (sameAsActive && (u.name || u.email)) || label),
        el('span', { class: 'st-email' }, [sameAsActive && u.name ? u.email : '', label].filter(Boolean).join(' · '))),
      icon('chevron', 12)),
      themeButton(),
      el('button', { class: 'st-gear', type: 'button', title: `${t('studio.settings')} (${hooks.isMac ? '⌘,' : 'Ctrl+,'})`, 'aria-label': t('studio.settings'), onclick: () => openSettings() }, icon('gear', 16)));
    const fn = firstName(sameAsActive ? u.name : '');
    greeting.textContent = fn ? t('studio.greetingName', { name: fn }) : t('studio.greeting');
    drawStart(cur);
    drawHeader();
  }
  function drawStart(/** @type {any} */ cur) {
    start.hidden = !(starting || !hooks.hasSession());
    if (start.hidden) return;
    const keep = startProject.value || cur?.id || '';
    // the start pickers are redrawn on every refresh: syncSelect leaves an open (focused) one alone, or it would close
    syncSelect(startProject, view.projects.map((/** @type {any} */ p) => ({ value: p.id, label: p.name })),
      view.projects.some((/** @type {any} */ p) => p.id === (cur?.id || keep)) ? (cur?.id || keep) : (view.projects[0]?.id || ''));
    setProp(startProject, 'title', t('studio.project'));
    const proj = view.projects.find((/** @type {any} */ p) => p.id === startProject.value);
    startAccount.replaceChildren(el('span', { class: 'st-badge', title: t('studio.account') }, proj?.account || '—'),
      el('button', { type: 'button', class: 'st-link', title: t('studio.start.changeAccountTitle'), onclick: () => proj && hooks.projectSettings(proj.id) }, t('studio.start.changeAccount')));
    startWtLabel.textContent = t('studio.start.worktree');
    // v3.122 Who?: Me, or a team member allowed on this project (team mode on)
    const td = teamInfo();
    const whoList = td?.teamMode ? whoOptions(td.staff, startProject.value, td.projects) : [];
    const keepWho = startWho.value;
    // a picked member who is no longer valid stays picked (sending refuses with a note), never silently Me
    const staleName = keepWho && keepWho !== 'me' && !whoList.some((o) => o.value === keepWho) ? (startWho.selectedOptions[0]?.textContent || keepWho) : '';
    syncSelect(startWho, [...whoList.map((o) => ({ value: o.value, label: o.value === 'me' ? t('studio.team.me') : o.name })),
      ...(staleName ? [{ value: keepWho, label: staleName }] : [])],
    staleName || whoList.some((o) => o.value === keepWho) ? keepWho : 'me');
    setProp(startWho, 'hidden', whoList.length < 2 && !staleName);
    setProp(startWho, 'title', t('studio.team.who'));
    drawStartModels(proj?.id || '');
    setProp(startModel, 'title', t('chat.pick.modelTitle'));
    // v3.120 what a new tab of this project can apply (main's studio:models caps): a terminal tab offers neither
    // picker, a skip-permissions project or a desk shows its mode as held and cannot be given another one
    const can = startPickers(startLists.get(proj?.id || '')?.caps || null);
    setProp(startModel, 'hidden', !can.model);
    const dv = can.mode ? startMode.value : '';
    const caps = startLists.get(proj?.id || '')?.caps || null;
    const modeText = (/** @type {string} */ m) => (hasText(`chat.pick.mode.${m}`) ? t(`chat.pick.mode.${m}`) : m);
    const modeLabel = (/** @type {string} */ m) => (m ? modeText(m) : can.shownMode ? modeText(can.shownMode) : t('studio.start.modeDefault'));
    // v3.120 the account's reported modes (studio:models caps.modes), else START_MODES; Auto also turns on the project's Auto-approve
    const modes = Array.isArray(caps?.modes) && caps.modes.length ? ['', ...caps.modes.filter((/** @type {string} */ m) => m !== 'bypassPermissions')] : START_MODES;
    syncSelect(startMode, (can.mode ? modes : ['']).map((m) => ({ value: m, label: modeLabel(m) })), dv);
    setProp(startMode, 'disabled', !can.mode);
    setProp(startMode, 'hidden', !can.model && !can.lock);
    setProp(startMode, 'title', `${t('chat.pick.modeTitle')}${can.lock ? ` · ${t(`chat.pick.why.${can.lock}`)}` : caps?.autoApprove ? ` · ${t('chat.pick.managerNoteTitle')}` : ''}`);
    startText.placeholder = t('studio.start.placeholder');
    startSend.title = `${t('studio.start.send')} (Enter)`;
    startSend.setAttribute('aria-label', t('studio.start.send'));
    startForm.hidden = !view.projects.length;
  }
  /**
   * v3.120 Studio UX: the start screen's models are the selected project's account's (main's per-account cache, filled
   * by a session or a short probe). Until the probe answers: only the default option and a loading line.
   */
  /** @type {Map<string, { models: any[], loading: boolean, at: number, caps?: { gui: boolean, modeLock: string, modes?: string[], autoApprove?: boolean } | null }>} */
  const startLists = new Map();
  let startModelsAsked = '';
  let startModelsTimer = /** @type {any} */ (null);
  function drawStartModels(/** @type {string} */ projectId) {
    const got = startLists.get(projectId);
    const list = got?.models?.length ? got.models : START_MODELS.slice(0, 1).map((value) => ({ value, label: '', description: '' }));
    const loading = !got || got.loading;
    const mv = startModel.value;
    // the default option names the model it stands for when the account's list says ("Default (Opus 5.5)")
    const name = defaultModelName(list);
    const first = name ? t('chat.pick.model.default', { name }) : t('studio.start.modelDefault');
    syncSelect(startModel, [...list.map((/** @type {any} */ m) => ({ value: m.value, title: m.description || '', label: m.value ? (m.label || t(`chat.pick.model.${m.value}`)) : first })),
      ...(loading ? [{ value: '', label: t('studio.start.modelsLoading'), disabled: true }] : [])],
    list.some((/** @type {any} */ m) => m.value === mv) ? mv : '');
    startModel.classList.toggle('loading', loading);
    // a loaded list is asked again after a minute (a session of that account may have refreshed it)
    if (!projectId || (got && !got.loading && Date.now() - got.at < 60000) || startModelsAsked === projectId) return;
    startModelsAsked = projectId;
    api.chat.startModels(projectId).then((/** @type {any} */ r) => {
      startModelsAsked = '';
      const caps = r && typeof r.gui === 'boolean' ? { gui: r.gui, modeLock: typeof r.modeLock === 'string' ? r.modeLock : '', modes: Array.isArray(r.modes) ? r.modes.filter((/** @type {any} */ m) => typeof m === 'string') : [], autoApprove: r.autoApprove === true } : null;
      const had = JSON.stringify(startLists.get(projectId)?.caps || null);
      startLists.set(projectId, { models: Array.isArray(r?.models) ? r.models : [], loading: Boolean(r?.loading), at: Date.now(), caps });
      if (startProject.value === projectId) { if (had !== JSON.stringify(caps)) drawStart(current()); else drawStartModels(projectId); }
      if (r?.loading) { clearTimeout(startModelsTimer); startModelsTimer = setTimeout(() => { if (startProject.value === projectId && !start.hidden) drawStartModels(projectId); }, 1500); }
    }, () => { startModelsAsked = ''; startLists.set(projectId, { models: [], loading: false, at: Date.now() }); });
  }
  function drawHeader() {
    const pty = hooks.activePty();
    shown = null;
    let proj = null;
    for (const p of view.projects) { const s = p.running.find((/** @type {any} */ x) => x.ptyId === pty); if (s) { shown = s; proj = p; break; } }
    header.hidden = !on;
    if (headTitle.querySelector('input')) return;
    if (!shown || starting) {
      headTitle.textContent = starting ? t('studio.newSession') : '';
      headTitle.removeAttribute('title');
      headChips.replaceChildren();
      headState.replaceChildren();
      return;
    }
    headTitle.textContent = shown.title || t('studio.untitled');
    headTitle.title = t('studio.renameTitle');
    const chip = (/** @type {string} */ ic, /** @type {string} */ text, /** @type {string} */ tip) => (text ? el('span', { class: 'st-chip', title: `${tip}: ${text}` }, icon(ic, 12), el('span', {}, text)) : null);
    const tdh = shown.staffId ? teamInfo() : null;
    const member = tdh ? tdh.staff.find((/** @type {any} */ m) => m.id === shown.staffId) : null;
    const memberText = member ? [member.name, teamGroups({ staff: [member], presets: tdh.presets, lang: tdh.lang })[0]?.members[0]?.role].filter(Boolean).join(' · ') : '';
    headChips.replaceChildren(...[chip('team', memberText, t('studio.team.member')), chip('folder', proj?.name || '', t('studio.project')), chip('branch', shown.branch, t('studio.branch')), accountChip(proj)].filter((x) => x !== null));
    headState.replaceChildren(...(shown.waiting ? [el('span', { class: 'st-wait' }, t('studio.waiting'))] : shown.busy ? [el('span', { class: 'st-spin' }), el('span', {}, t('studio.working'))] : []));
  }

  // v3.163 the project's account in its header is a picker: a click lists the accounts, a choice sets this project's
  // account (the existing projects:setAccount; tabs of the project restart on it and resume their own conversation)
  const acctMenu = el('div', { class: 'st-menu st-acct-menu', role: 'menu', hidden: true });
  document.body.append(acctMenu);
  function accountChip(/** @type {any} */ proj) {
    if (!proj?.account) return null;
    const choices = accountChoices(hooks.accounts?.() || [], proj.account);
    const text = el('span', {}, proj.account);
    if (!pickerUseful(choices)) return el('span', { class: 'st-chip', title: `${t('studio.account')}: ${proj.account}` }, icon('user', 12), text);
    return el('button', { class: 'st-chip st-chip-pick', type: 'button', 'aria-haspopup': 'menu', title: `${t('studio.account')}: ${proj.account} - ${t('studio.accountPick')}`,
      onclick: (/** @type {MouseEvent} */ e) => { e.stopPropagation(); openAcctMenu(/** @type {HTMLElement} */ (e.currentTarget), proj.id, choices); } }, icon('user', 12), text, icon('chevronDown', 10));
  }
  function openAcctMenu(/** @type {HTMLElement} */ btn, /** @type {string} */ projectId, /** @type {any[]} */ choices) {
    if (!acctMenu.hidden) { acctMenu.hidden = true; return; }
    acctMenu.replaceChildren(el('div', { class: 'st-menu-head' }, t('studio.accountPick')),
      ...choices.map((c) => el('button', { class: 'st-menu-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(c.current), onclick: () => {
        acctMenu.hidden = true;
        const id = accountToSet(choices, c.id);
        if (id) hooks.setProjectAccount?.(projectId, id);
      } }, el('span', {}, c.label + (c.signedOut ? ` (${t('studio.accountSignedOut')})` : '')), c.current ? el('span', {}, '\u2713') : null)),
      el('div', { class: 'st-menu-note' }, t('studio.accountPickNote')));
    acctMenu.hidden = false;
    const a = btn.getBoundingClientRect();
    acctMenu.style.cssText = 'position: fixed; right: auto; bottom: auto; width: 240px;';
    const m = acctMenu.getBoundingClientRect();
    const p = anchorAbove({ left: a.left, top: a.bottom + 12 + m.height, bottom: a.bottom }, { width: 240, height: m.height }, { width: window.innerWidth, height: window.innerHeight });
    acctMenu.style.left = `${p.left}px`;
    acctMenu.style.top = `${Math.max(8, Math.min(a.bottom + 6, window.innerHeight - m.height - 8))}px`;
  }
  document.addEventListener('mousedown', (e) => { if (!acctMenu.hidden && e.target instanceof Node && !acctMenu.contains(e.target)) acctMenu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !acctMenu.hidden) acctMenu.hidden = true; });

  // ---- v3.122 the Team section: members by department, live state, their open desks ----
  const teamInfo = () => { try { return hooks.sidebar()?.teamData?.() || null; } catch { return null; } };
  /** The "<projectId>|<staffId>" keys of desk sessions waiting for the person. */
  function waitingDesks() {
    /** @type {Set<string>} */
    const waiting = new Set();
    for (const p of view.projects) for (const s of p.running) if (s.staffId && s.waiting) waiting.add(`${p.id}|${s.staffId}`);
    return waiting;
  }
  function drawTeam() {
    const td = teamInfo();
    if (!td?.teamMode) { teamEl.replaceChildren(); return; }
    const waiting = waitingDesks();
    const groups = teamGroups({ staff: td.staff, presets: td.presets, desks: td.desks, projects: td.projects, waiting, lang: td.lang });
    const stateText = (/** @type {string} */ s) => t(`studio.team.state.${s}`);
    // v3.124 the header opens the Team page
    teamEl.replaceChildren(el('button', { class: 'st-head st-team-open', type: 'button', title: t('studio.teamPage.open'), onclick: () => openTeam() }, el('span', { class: 'st-title' }, t('studio.team.title')), icon('chevron', 12)),
      ...groups.flatMap((g) => [
        ...(g.head && groups.length > 1 ? [el('div', { class: 'st-team-dept' }, g.head)] : []),
        ...g.members.flatMap((m) => {
          const open = openMembers.has(m.id);
          return [el('button', { class: `st-row st-member${open ? ' open' : ''}`, type: 'button', 'aria-expanded': String(open), title: `${m.name} · ${m.role} · ${stateText(m.state)}`,
            onclick: () => { if (open) openMembers.delete(m.id); else openMembers.add(m.id); drawTeam(); } },
          el('span', { class: 'st-avatar st-member-avatar', 'aria-hidden': 'true' }, m.initials),
          el('span', { class: 'st-title' }, m.name, el('span', { class: 'st-member-role' }, m.role)),
          el('span', { class: `st-member-state ${m.state}`, title: stateText(m.state), 'aria-label': stateText(m.state) })),
          ...(open ? (m.desks.length ? m.desks.map((d) => el('button', { class: 'st-row st-desk', type: 'button', title: stateText(d.state), onclick: () => hooks.openDesk(d.projectId, m.id) },
            el('span', { class: `st-member-state ${d.state}` }), el('span', { class: 'st-title' }, d.name))) : [el('div', { class: 'st-none st-desk' }, t('studio.team.noDesks'))]) : [])];
        })]),
      // v3.124 the Office TEAM panel's two buttons, with its labels: the member form for a new member (as a side sheet)
      // and the role wizard
      el('button', { class: 'st-row st-team-add', type: 'button', onclick: () => hooks.sidebar()?.editMember?.(null) }, el('span', { class: 'st-title' }, t('staff.add'))),
      el('button', { class: 'st-row st-team-add st-team-wizard', type: 'button', onclick: () => openWizard() }, el('span', { class: 'st-title' }, t('staff.wizard.open'))));
  }

  // ---- the account menu (footer): Studio's theme, Settings, accounts, back to the Office ----
  const menu = el('div', { class: 'st-menu', role: 'menu', hidden: true });
  bar.append(menu);
  const studioTheme = () => { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };
  function applyTheme() { const v = studioTheme(); if (v === 'system') document.body.removeAttribute('data-studio-theme'); else document.body.setAttribute('data-studio-theme', v); }
  applyTheme();
  function setStudioTheme(/** @type {string} */ v) { try { if (v === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch { /* storage off */ } applyTheme(); refresh(); }
  // the footer's sun / moon: flips Studio between light and dark (the menu and Settings still offer "System")
  const darkNow = () => { const v = studioTheme(); return v === 'dark' || (v === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches); };
  function themeButton() {
    const dark = darkNow();
    const label = t(dark ? 'studio.themeToLight' : 'studio.themeToDark');
    return el('button', { class: 'st-gear st-theme', type: 'button', title: label, 'aria-label': label,
      onclick: () => setStudioTheme(darkNow() ? 'light' : 'dark') }, icon(dark ? 'sun' : 'moon', 16));
  }
  function toggleMenu(/** @type {boolean} */ force = menu.hidden) {
    menu.hidden = !force;
    if (menu.hidden) return;
    closeCtx();
    const item = (/** @type {string} */ ic, /** @type {string} */ label, /** @type {string} */ key, /** @type {() => void} */ run, /** @type {boolean} */ checked = false) =>
      el('button', { class: `st-menu-item${checked ? ' checked' : ''}`, role: 'menuitem', type: 'button', onclick: () => { menu.hidden = true; run(); } }, icon(ic, 14), el('span', { class: 'st-title' }, label), key ? el('span', { class: 'st-key' }, key) : null);
    const theme = studioTheme();
    const setTheme = (/** @type {string} */ v) => () => setStudioTheme(v);
    menu.replaceChildren(
      el('div', { class: 'st-menu-head' }, t('studio.theme')),
      item('monitor', t('studio.themeSystem'), '', setTheme('system'), theme === 'system'),
      item('sun', t('studio.themeLight'), '', setTheme('light'), theme === 'light'),
      item('moon', t('studio.themeDark'), '', setTheme('dark'), theme === 'dark'),
      el('div', { class: 'st-menu-sep' }),
      item('user', t('studio.accounts'), '', () => hooks.showAccounts()),
      item('gear', t('studio.settings'), hooks.isMac ? '⌘,' : 'Ctrl+,', () => openSettings()),
      item('office', t('studio.toOffice'), hooks.isMac ? '⌘⇧E' : 'Ctrl+Shift+E', () => hooks.toggle()));
    placeMenu();
  }
  // v3.157 the menu opens directly above the account button (left-aligned, its bottom edge just above it) inside the window
  function placeMenu() {
    const btn = account.querySelector('.st-account-btn');
    if (!btn) return;
    const a = btn.getBoundingClientRect();
    menu.style.cssText = 'position: fixed; right: auto; bottom: auto;';
    const w = Math.min(Math.max(a.width, 200), window.innerWidth - 16);
    menu.style.width = `${w}px`;
    const m = menu.getBoundingClientRect();
    const p = anchorAbove(a, { width: w, height: m.height }, { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
  }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && e.target instanceof Node && !menu.contains(e.target) && !account.contains(e.target)) menu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) menu.hidden = true; });

  async function refresh() {
    if (!on) return;
    const [v, link] = await Promise.all([api.studio.sessions().catch(() => null), api.link?.get?.().catch(() => null)]);
    if (v) view = v;
    remoteLink = link || null;
    devices = Array.isArray(link?.devices) ? link.devices.filter((/** @type {any} */ d) => d && typeof d.name === 'string') : [];
    draw();
  }

  // ---- ⌘K command palette: the Office's own actions (app.js hooks.commands), then sessions and projects to jump to ----
  const palInput = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'st-pal-input' }));
  const palList = el('div', { class: 'st-pal-list', role: 'listbox' });
  const palette = el('div', { id: 'studio-palette', hidden: true, onmousedown: (/** @type {MouseEvent} */ e) => { if (e.target === palette) closePalette(); } },
    el('div', { class: 'st-pal', role: 'dialog', 'aria-modal': 'true' }, palInput, palList));
  document.body.append(palette);
  /** @type {(StudioCommand & { kind: string })[]} */
  let palItems = [];
  /** @type {(StudioCommand & { kind: string })[]} */
  let palShown = [];
  let palSel = 0;

  function paletteItems() {
    const cur = currentId();
    const cmds = (hooks.commands(cur) || []).map((c) => ({ ...c, kind: 'command' }));
    const sessions = [];
    const projects = [];
    for (const g of studioGroups(view.projects, { currentId: cur })) {
      for (const s of g.running) sessions.push({ id: `s:${s.ptyId}`, kind: 'session', label: `${g.name} · ${s.title}`, keywords: t('studio.running'), run: () => open(g.id, { n: s.n }) });
      for (const r of g.recent) sessions.push({ id: `r:${g.id}:${r.sessionId}`, kind: 'recent', label: `${g.name} · ${r.title}`, keywords: t('studio.recent'), run: () => open(g.id, { sessionId: r.sessionId }) });
      projects.push({ id: `p:${g.id}`, kind: 'project', label: g.name, keywords: `${t('studio.project')} ${g.account}`, run: () => { picked = g.id; hooks.selectProject(g.id); refresh(); } });
    }
    return [...cmds, ...sessions, ...projects];
  }
  function drawPalette() {
    palShown = filterPalette(palItems, palInput.value);
    palSel = Math.min(palSel, Math.max(0, palShown.length - 1));
    palList.replaceChildren(...(palShown.length ? palShown.map((it, i) => el('div', {
      class: `st-pal-row${i === palSel ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === palSel),
      onmousemove: () => { if (palSel !== i) { palSel = i; drawPalette(); } }, onclick: () => runPalette(it),
    }, el('span', { class: 'st-title' }, it.label), el('span', { class: 'st-pal-kind' }, t(`studio.kind.${it.kind}`)))) : [el('div', { class: 'st-none' }, t('studio.noResults'))]));
    palList.querySelector('.st-pal-row.active')?.scrollIntoView?.({ block: 'nearest' });
  }
  function runPalette(/** @type {StudioCommand} */ it) {
    closePalette();
    try { it.run(); } catch (e) { console.error(e); }
  }
  /** ⌘K; `items` (v3.134 "Run template…") replaces the rows with these, `hint` the placeholder. */
  function openPalette(/** @type {StudioCommand[] | undefined} */ items = undefined, hint = '') {
    if (!on) return;
    hidePanel();
    palItems = Array.isArray(items) ? items : paletteItems();
    palInput.value = '';
    palInput.placeholder = hint || t('studio.paletteHint');
    palSel = 0;
    palette.hidden = false;
    drawPalette();
    palInput.focus();
  }
  function closePalette() { palette.hidden = true; }
  palInput.addEventListener('input', () => { palSel = 0; drawPalette(); });
  palInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); } else if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palShown.length - 1); drawPalette(); } else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); drawPalette(); } else if (e.key === 'Enter') { e.preventDefault(); const it = palShown[palSel]; if (it) runPalette(it); }
  });

  // ---- An Office sidebar panel (team, accounts, MCP, devices) shown on its own over Studio ----
  // body.studio hides #sidebar; body.studio-panel shows it as a floating card with only that panel (style.css), so the
  // panel is the Office's own element with its own handlers, not a copy.
  const panelBack = el('div', { id: 'studio-panel-back', hidden: true, onmousedown: () => hidePanel() });
  document.body.append(panelBack);
  /** @type {{ el: HTMLDetailsElement, open: boolean, stored: Map<string, string | null> } | null} */
  let panelWas = null;   // the shown panel's open state and stored ao.panel.* values before showPanel opened it
  /** @type {{ el: HTMLElement, selector: string } | null} */
  let floatShown = null;   // a floating Office panel (FLOATS) shown over Studio
  /** The ao.panel.* values in localStorage (the Office's remembered open panels). */
  function panelStore() {
    /** @type {Map<string, string | null>} */
    const m = new Map();
    try {
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('ao.panel.')) m.set(k, localStorage.getItem(k)); }
    } catch { /* no storage */ }
    return m;
  }
  function restorePanelStore(/** @type {Map<string, string | null>} */ was) {
    try {
      for (const k of panelStore().keys()) if (!was.has(k)) localStorage.removeItem(k);
      for (const [k, v] of was) if (v !== null) localStorage.setItem(k, v);
    } catch { /* no storage */ }
  }
  function showPanel(/** @type {string} */ selector) {
    const sb = document.getElementById('sidebar');
    if (on && FLOATS.includes(selector)) return showFloat(selector);
    const target = /** @type {HTMLElement | null} */ (sb?.querySelector(selector) || null);
    if (!on || !sb || !target || target.hidden) return false;
    if (panelWas || floatShown) hidePanel();   // another panel was shown: put it back first
    let top = target;
    while (top.parentElement && top.parentElement !== sb) top = top.parentElement;
    for (const c of sb.children) c.classList.toggle('studio-shown', c === top);
    if (top.tagName === 'DETAILS') {
      const d = /** @type {HTMLDetailsElement} */ (top);
      panelWas = { el: d, open: d.open, stored: panelStore() };
      d.open = true;   // fires the Office's toggle handler, which stores it: hidePanel puts both back
    }
    document.body.classList.add('studio-panel');
    panelBack.hidden = false;
    return true;
  }
  /**
   * v3.122 a floating Office panel outside the sidebar (Usage, Machines): the Office opens it with its own show(), which
   * fills it and keeps refreshing it while it is open; Studio only centres it as a card (body.studio-float).
   */
  function showFloat(/** @type {string} */ selector) {
    const target = /** @type {HTMLElement | null} */ (document.querySelector(selector));
    if (!target) return false;
    if (panelWas || floatShown) hidePanel();
    if (!hooks.openFloat?.(selector) || target.hidden) return false;
    floatShown = { el: target, selector };
    target.classList.add('studio-shown');
    document.body.classList.add('studio-float');
    panelBack.hidden = false;
    return true;
  }
  function hidePanel() {
    const float = floatShown;
    floatShown = null;
    if (float) {
      float.el.classList.remove('studio-shown');
      document.body.classList.remove('studio-float');
      hooks.closeFloat?.(float.selector);   // the Office's own hide(): stops its refresh timer
    }
    // the panel's open state and the Office's stored value as they were before showPanel (the toggle event is async:
    // the stored values are put back after the Office's own toggle handler has run)
    const was = panelWas;
    panelWas = null;
    if (was) {
      if (was.el.open !== was.open) { was.el.addEventListener('toggle', () => restorePanelStore(was.stored), { once: true }); was.el.open = was.open; }
      else restorePanelStore(was.stored);
    }
    document.body.classList.remove('studio-panel');
    panelBack.hidden = true;
    for (const c of document.getElementById('sidebar')?.children || []) c.classList.remove('studio-shown');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('studio-panel') && !document.querySelector('.sb-modal-backdrop')) hidePanel();
  });

  return {
    /** Studio on or off: body.studio, the sidebar and the start screen; the Office's elements are only hidden. */
    setOn(/** @type {boolean} */ value) {
      on = Boolean(value);
      document.body.classList.toggle('studio', on);
      if (!on) { document.body.classList.remove('studio-board'); closePalette(); hidePanel(); settingsPage.close(); teamPage.close(); }
      bar.hidden = !on;
      header.hidden = !on;
      menu.hidden = true;
      starting = false;
      start.hidden = true;
      clearInterval(timer);
      if (on) { timer = window.setInterval(refresh, REFRESH_MS); refresh(); }
    },
    isOn: () => on,
    /** The Office changed (projects, tabs, the active session): redraw with fresh data. */
    changed() { if (!on) return; clearTimeout(soon); soon = window.setTimeout(refresh, 250); },
    /** ⌘N, ⌘K, ⌘1…9 (src/studio-keys.mjs) */
    newSession,
    /** ⌘⇧N: the start screen with a new worktree */
    newWorktreeSession: () => newSession({ worktree: true }),
    /** ⌘L: the composer (the start screen's when it is shown) */
    focusStart() { if (!start.hidden) { startText.focus(); return true; } return false; },
    openPalette,
    /** v3.122 Studio's Settings page, at a section ('general', 'voice', …); the Office popup outside Studio. */
    openSettings,
    /** v3.124 Studio's Team page at a tab; the Office's Team panel outside Studio. */
    openTeam,
    openBoard,
    focusSearch() { search.focus(); search.select(); },
    /** An Office sidebar panel on its own over Studio ('#sb-panel-team', '.sb-accounts', …); false when it is not there. */
    showPanel,
    hidePanel,
    /** The project ⌘N and ⌘1…9 act on, or ''. */
    currentProject: currentId,
    selectIndex(/** @type {number} */ i) {
      const id = currentId();
      const s = shownSessions()[i];
      if (id && s) open(id, { n: s.n });
    },
  };
}
