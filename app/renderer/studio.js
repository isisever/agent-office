// Studio experience (contract v3.120): an optional layout in the same window, like Claude Desktop's Code view.
// body.studio hides the Office (scene, left panel, tab strip, style.css); this module adds Studio's own sidebar and its
// start screen. The main region is the existing #terminal: the active session's chat view (or its terminal on Windows,
// where GUI chat is off) as the Office shows it, so no chat is rendered twice. Switching back removes body.studio and
// the Office is as it was: panes, tabs and sessions are never touched here.
// Every text from main (project, session, device and account names) is put in with textContent.

import { studioGroups, currentProjectId, filterPalette } from '../src/studio-view.mjs';
import { icon } from './studio-icons.js';
import { hasText } from './i18n.js';
import { relativeTime, firstName, START_MODELS, START_MODES, startPlan, startPickers, renameText } from '../src/studio-ux.mjs';

const REFRESH_MS = 5000;   // v3.120 Studio UX: the rows' live state (working, waiting) and the header follow within 5 s
const THEME_KEY = 'ao.studio.theme';   // Studio's own light / dark choice ('system' | 'light' | 'dark', this window only)
const CLOSED_KEY = 'ao.studio.closedProjects';   // the project groups the person collapsed (this window only)

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
 *     selectProject: (projectId: string) => void, selectHq: () => void, openBoard: () => void,
 *     openSettings: () => void, toggle: () => void, activePty: () => string | null, hasSession: () => boolean,
 *     startSession: (projectId: string, plan: { tabMode: 'same' | 'worktree', settings: [string, string][], reuseN?: number }, text: string) => Promise<{ ok: boolean, n: number, failed?: { step: string, why: string, detail: string } }>,
 *     projectSettings: (projectId: string) => void, showAccounts: () => void, isMac: boolean,
 *     commands: (projectId: string) => StudioCommand[],
 *   },
 * }} o
 */
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
  /** @type {Set<string>} */
  const closed = (() => { try { return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')); } catch { return new Set(); } })();
  const saveClosed = () => { try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed])); } catch { /* storage off */ } };

  const search = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'st-search', oninput: () => { query = search.value.trim(); draw(); } }));
  const newLabel = el('span', { class: 'st-title' });
  const newBtn = el('button', { class: 'st-new st-row', onclick: () => newSession() }, el('span', { class: 'st-new-icon' }, icon('plus', 14)), newLabel);
  const pins = el('div', { class: 'st-pins' });
  const lists = el('div', { class: 'st-lists' });
  const machines = el('div', { class: 'st-machines' });
  const account = el('div', { class: 'st-account' });
  const searchBox = el('label', { class: 'st-searchbox' }, icon('search', 14), search);
  const bar = el('aside', { id: 'studio-sidebar', hidden: true }, newBtn, searchBox, pins, lists, machines, account);
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
  const startSend = /** @type {HTMLButtonElement} */ (el('button', { class: 'st-start-send', type: 'submit' }, icon('send', 16)));
  const startNote = el('div', { class: 'st-start-note', role: 'status' });
  const startForm = el('form', { class: 'st-start-box', onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); sendStart(); } },
    startText,
    el('div', { class: 'st-start-row' },
      startProject, startAccount, el('label', { class: 'st-start-wt' }, startWorktree, startWtLabel),
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
    const plan = startPlan({ worktree: startWorktree.checked, model: startModel.value, mode: startMode.value }, [...startModel.options].filter((o) => !o.disabled).map((o) => o.value), startLists.get(id)?.caps || null);
    const reuseN = startTab && startTab.projectId === id && startTab.tabMode === plan.tabMode ? startTab.n : 0;
    /** @type {{ ok: boolean, n: number, failed?: { step: string, why: string, detail: string } }} */
    let r = { ok: false, n: 0 };
    try { r = await hooks.startSession(id, { ...plan, reuseN }, text); } catch (e) { console.error(e); }
    startBusy = false;
    startSend.disabled = false;
    if (r.ok) { startTab = null; startText.value = ''; startNote.textContent = ''; starting = false; picked = id; refresh(); return; }
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
    const r = await api.studio.open(projectId, ref).catch(() => null);
    if (r?.ok) { picked = r.projectId; hooks.selectSession(r.projectId, r.n); }
    refresh();
  }

  function sessionRow(/** @type {any} */ g, /** @type {any} */ s, /** @type {number} */ i) {
    const active = hooks.activePty() === s.ptyId;
    const state = s.isRunning ? 'live' : s.isAsleep ? 'asleep' : '';
    const name = s.title || t('studio.untitled');
    const live = stateEl(s);
    return el('div', { class: `st-row st-session${active ? ' active' : ''}`, title: [name, s.label, s.branch].filter(Boolean).join(' · '), onclick: () => open(g.id, { n: s.n }) },
      s.busy && !s.waiting ? live : el('span', { class: `sb-dot ${state}` }),
      el('span', { class: 'st-title' }, name),
      s.waiting ? live : null,
      s.at ? el('span', { class: 'st-time' }, rel(s.at)) : null,
      g.current && i < 9 ? el('span', { class: 'st-key' }, `${modLabel}${i + 1}`) : null);
  }
  function recentRow(/** @type {any} */ g, /** @type {any} */ r) {
    return el('div', { class: 'st-row st-session st-recent', title: new Date(r.at).toLocaleString(), onclick: () => open(g.id, { sessionId: r.sessionId }) },
      el('span', { class: 'sb-dot' }), el('span', { class: 'st-title' }, r.title || t('studio.untitled')), r.at ? el('span', { class: 'st-time' }, rel(r.at)) : null);
  }
  function groupEl(/** @type {any} */ g) {
    const shut = !query && closed.has(g.id);
    const toggle = () => { if (closed.has(g.id)) closed.delete(g.id); else closed.add(g.id); saveClosed(); draw(); };
    const head = el('div', { class: `st-group-head${g.active ? ' active' : ''}${g.current ? ' current' : ''}`, title: g.name },
      el('button', { class: 'st-caret', 'aria-expanded': String(!shut), title: g.name, onclick: toggle }, icon('chevron', 12)),
      el('span', { class: 'st-title st-project', onclick: () => { picked = g.id; hooks.selectProject(g.id); refresh(); } }, g.name),
      g.attention ? el('span', { class: `sb-attn ${g.attention}` }, '●') : null,
      g.account ? el('span', { class: 'st-badge', title: `${t('studio.account')}: ${g.account}` }, g.account) : null,
      el('button', { class: 'st-add', title: `${t('studio.newSession')} · ${g.name}`, onclick: () => newSession({ projectId: g.id }) }, icon('plus', 14)));
    // one session and nothing recent: the group stays compact (its head opens that session, the row is not repeated)
    if (g.running.length === 1 && !g.recent.length && !query) {
      const s = g.running[0];
      const active = hooks.activePty() === s.ptyId;
      return el('div', { class: `st-group compact${g.current ? ' current' : ''}` },
        el('div', { class: `st-group-head${g.active ? ' active' : ''}${g.current ? ' current' : ''}${active ? ' on' : ''}`, title: [g.name, s.title].filter(Boolean).join(' · '), onclick: (/** @type {MouseEvent} */ e) => { if (!(e.target instanceof Element) || !e.target.closest('.st-add')) open(g.id, { n: s.n }); } },
          stateEl(s) || el('span', { class: `sb-dot ${s.isRunning ? 'live' : s.isAsleep ? 'asleep' : ''}` }),
          el('span', { class: 'st-title st-project' }, g.name, el('span', { class: 'st-sub-name' }, s.title || '')),
          g.attention && !s.waiting ? el('span', { class: `sb-attn ${g.attention}` }, '●') : null,
          g.account ? el('span', { class: 'st-badge', title: `${t('studio.account')}: ${g.account}` }, g.account) : null,
          el('button', { class: 'st-add', title: `${t('studio.newSession')} · ${g.name}`, onclick: () => newSession({ projectId: g.id }) }, icon('plus', 14))));
    }
    const kids = shut ? [] : [
      ...g.running.map((/** @type {any} */ s, /** @type {number} */ i) => sessionRow(g, s, i)),
      ...(g.recent.length ? [el('div', { class: 'st-sub' }, t('studio.recent')), ...g.recent.map((/** @type {any} */ r) => recentRow(g, r))] : []),
    ];
    return el('div', { class: `st-group${g.current ? ' current' : ''}` }, head, ...kids);
  }

  function draw() {
    if (!on) return;
    newLabel.textContent = t('studio.newSession');
    newBtn.title = `${t('studio.newSession')} (${modLabel}N · ${t('studio.worktreeKey')} ${hooks.isMac ? '⌘⇧N' : 'Ctrl+Shift+Alt+N'})`;
    search.placeholder = t('studio.search');
    pins.replaceChildren(
      el('div', { class: 'st-row st-pin', onclick: () => hooks.selectHq() }, icon('home'), el('span', { class: 'st-title' }, t('studio.hq'))),
      el('div', { class: 'st-row st-pin', onclick: () => hooks.openBoard() }, icon('report'), el('span', { class: 'st-title' }, t('studio.reports'))),
      el('div', { class: 'st-row st-pin', onclick: () => hooks.openBoard() }, icon('clock'), el('span', { class: 'st-title' }, t('studio.routines'))),
      el('div', { class: 'st-row st-pin', title: `${modLabel}K`, onclick: () => openPalette() }, icon('command'), el('span', { class: 'st-title' }, t('studio.commands')), el('span', { class: 'st-key' }, `${modLabel}K`)));
    const groups = studioGroups(view.projects, { query, currentId: currentId() });
    lists.replaceChildren(el('div', { class: 'st-head' }, t('studio.projects')),
      ...(groups.length ? groups.map(groupEl) : [el('div', { class: 'st-none' }, t('studio.none'))]));
    // paired machines: read-only (a remote target is send-as-task plus a read-only view, from HQ's board)
    machines.replaceChildren(...(devices.length ? [el('div', { class: 'st-head' }, t('studio.machines')),
      ...devices.map((d) => el('div', { class: 'st-row st-device', title: d.online ? t('studio.online') : t('studio.offline') },
        icon('device'), el('span', { class: 'st-title' }, d.name), el('span', { class: `sb-dot${d.online ? ' live' : ''}` })))] : []));
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
      icon('chevron', 12)));
    const fn = firstName(sameAsActive ? u.name : '');
    greeting.textContent = fn ? t('studio.greetingName', { name: fn }) : t('studio.greeting');
    drawStart(cur);
    drawHeader();
  }
  function drawStart(/** @type {any} */ cur) {
    start.hidden = !(starting || !hooks.hasSession());
    if (start.hidden) return;
    const keep = startProject.value || cur?.id || '';
    startProject.replaceChildren(...view.projects.map((/** @type {any} */ p) => el('option', { value: p.id }, p.name)));
    startProject.value = view.projects.some((/** @type {any} */ p) => p.id === (cur?.id || keep)) ? (cur?.id || keep) : (view.projects[0]?.id || '');
    startProject.title = t('studio.project');
    const proj = view.projects.find((/** @type {any} */ p) => p.id === startProject.value);
    startAccount.replaceChildren(el('span', { class: 'st-badge', title: t('studio.account') }, proj?.account || '—'),
      el('button', { type: 'button', class: 'st-link', title: t('studio.start.changeAccountTitle'), onclick: () => proj && hooks.projectSettings(proj.id) }, t('studio.start.changeAccount')));
    startWtLabel.textContent = t('studio.start.worktree');
    drawStartModels(proj?.id || '');
    startModel.title = t('chat.pick.modelTitle');
    // v3.120 what a new tab of this project can apply (main's studio:models caps): a terminal tab offers neither
    // picker, a skip-permissions project or a desk shows its mode as held and cannot be given another one
    const can = startPickers(startLists.get(proj?.id || '')?.caps || null);
    startModel.hidden = !can.model;
    const dv = can.mode ? startMode.value : '';
    const caps = startLists.get(proj?.id || '')?.caps || null;
    const modeText = (/** @type {string} */ m) => (hasText(`chat.pick.mode.${m}`) ? t(`chat.pick.mode.${m}`) : m);
    const modeLabel = (/** @type {string} */ m) => (m ? modeText(m) : can.shownMode ? modeText(can.shownMode) : t('studio.start.modeDefault'));
    // v3.120 the account's reported modes (studio:models caps.modes), else START_MODES; Auto also turns on the project's Auto-approve
    const modes = Array.isArray(caps?.modes) && caps.modes.length ? ['', ...caps.modes.filter((/** @type {string} */ m) => m !== 'bypassPermissions')] : START_MODES;
    startMode.replaceChildren(...(can.mode ? modes : ['']).map((m) => el('option', { value: m }, modeLabel(m))));
    startMode.value = dv;
    startMode.disabled = !can.mode;
    startMode.hidden = !can.model && !can.lock;
    startMode.title = `${t('chat.pick.modeTitle')}${can.lock ? ` · ${t(`chat.pick.why.${can.lock}`)}` : caps?.autoApprove ? ` · ${t('chat.pick.managerNoteTitle')}` : ''}`;
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
    startModel.replaceChildren(...list.map((/** @type {any} */ m) => el('option', { value: m.value, title: m.description || '' }, m.value ? (m.label || t(`chat.pick.model.${m.value}`)) : t('studio.start.modelDefault'))),
      ...(loading ? [el('option', { value: '', disabled: true }, t('studio.start.modelsLoading'))] : []));
    startModel.value = list.some((/** @type {any} */ m) => m.value === mv) ? mv : '';
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
    headChips.replaceChildren(...[chip('folder', proj?.name || '', t('studio.project')), chip('branch', shown.branch, t('studio.branch')), chip('user', proj?.account || '', t('studio.account'))].filter((x) => x !== null));
    headState.replaceChildren(...(shown.waiting ? [el('span', { class: 'st-wait' }, t('studio.waiting'))] : shown.busy ? [el('span', { class: 'st-spin' }), el('span', {}, t('studio.working'))] : []));
  }

  // ---- the account menu (footer): Studio's theme, Settings, accounts, back to the Office ----
  const menu = el('div', { class: 'st-menu', role: 'menu', hidden: true });
  bar.append(menu);
  const studioTheme = () => { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };
  function applyTheme() { const v = studioTheme(); if (v === 'system') document.body.removeAttribute('data-studio-theme'); else document.body.setAttribute('data-studio-theme', v); }
  applyTheme();
  function toggleMenu(/** @type {boolean} */ force = menu.hidden) {
    menu.hidden = !force;
    if (menu.hidden) return;
    const item = (/** @type {string} */ ic, /** @type {string} */ label, /** @type {string} */ key, /** @type {() => void} */ run, /** @type {boolean} */ checked = false) =>
      el('button', { class: `st-menu-item${checked ? ' checked' : ''}`, role: 'menuitem', type: 'button', onclick: () => { menu.hidden = true; run(); } }, icon(ic, 14), el('span', { class: 'st-title' }, label), key ? el('span', { class: 'st-key' }, key) : null);
    const theme = studioTheme();
    const setTheme = (/** @type {string} */ v) => () => { try { if (v === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch { /* storage off */ } applyTheme(); };
    menu.replaceChildren(
      el('div', { class: 'st-menu-head' }, t('studio.theme')),
      item('monitor', t('studio.themeSystem'), '', setTheme('system'), theme === 'system'),
      item('sun', t('studio.themeLight'), '', setTheme('light'), theme === 'light'),
      item('moon', t('studio.themeDark'), '', setTheme('dark'), theme === 'dark'),
      el('div', { class: 'st-menu-sep' }),
      item('user', t('studio.accounts'), '', () => hooks.showAccounts()),
      item('gear', t('studio.settings'), '', () => hooks.openSettings()),
      item('office', t('studio.toOffice'), hooks.isMac ? '⌘⇧E' : 'Ctrl+Shift+E', () => hooks.toggle()));
  }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && e.target instanceof Node && !menu.contains(e.target) && !account.contains(e.target)) menu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) menu.hidden = true; });

  async function refresh() {
    if (!on) return;
    const [v, link] = await Promise.all([api.studio.sessions().catch(() => null), api.link?.get?.().catch(() => null)]);
    if (v) view = v;
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
  function openPalette() {
    if (!on) return;
    hidePanel();
    palItems = paletteItems();
    palInput.value = '';
    palInput.placeholder = t('studio.paletteHint');
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
    const target = /** @type {HTMLElement | null} */ (sb?.querySelector(selector) || null);
    if (!on || !sb || !target || target.hidden) return false;
    if (panelWas) hidePanel();   // another panel was shown: put it back first
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
  function hidePanel() {
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
      if (!on) { document.body.classList.remove('studio-board'); closePalette(); hidePanel(); }
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
