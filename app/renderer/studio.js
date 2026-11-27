// Studio experience (contract v3.120): an optional layout in the same window, like Claude Desktop's Code view.
// body.studio hides the Office (scene, left panel, tab strip, style.css); this module adds Studio's own sidebar and its
// start screen. The main region is the existing #terminal: the active session's chat view (or its terminal on Windows,
// where GUI chat is off) as the Office shows it, so no chat is rendered twice. Switching back removes body.studio and
// the Office is as it was: panes, tabs and sessions are never touched here.
// Every text from main (project, session, device and account names) is put in with textContent.

import { studioGroups, currentProjectId, filterPalette } from '../src/studio-view.mjs';
import { icon } from './studio-icons.js';

const REFRESH_MS = 10000;
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
  const startLabel = el('span', {});
  const startNew = el('button', { class: 'st-new st-start-new', onclick: () => newSession() }, icon('plus', 14), startLabel);
  const start = el('div', { id: 'studio-start', hidden: true }, greeting, startNew);
  document.getElementById('body')?.prepend(bar);
  document.getElementById('terminal')?.append(start);

  const currentId = () => currentProjectId(view.projects, picked);
  const current = () => view.projects.find((/** @type {any} */ p) => p.id === currentId()) || null;
  /** The current project's running sessions, in the order ⌘1…9 picks them (filtered by the search like the list). */
  const shownSessions = () => studioGroups(view.projects, { query, currentId: currentId() }).find((g) => g.current)?.running || [];

  function newSession() {
    const id = currentId();
    if (id) hooks.newSession(id);
  }
  async function open(/** @type {string} */ projectId, /** @type {any} */ ref) {
    picked = projectId;
    const r = await api.studio.open(projectId, ref).catch(() => null);
    if (r?.ok) { picked = r.projectId; hooks.selectSession(r.projectId, r.n); }
    refresh();
  }

  function sessionRow(/** @type {any} */ g, /** @type {any} */ s, /** @type {number} */ i) {
    const active = hooks.activePty() === s.ptyId;
    const state = s.isRunning ? 'live' : s.isAsleep ? 'asleep' : '';
    return el('div', { class: `st-row st-session${active ? ' active' : ''}`, title: s.title, onclick: () => open(g.id, { n: s.n }) },
      el('span', { class: `sb-dot ${state}` }),
      el('span', { class: 'st-title' }, s.title),
      g.current && i < 9 ? el('span', { class: 'st-key' }, `${modLabel}${i + 1}`) : null);
  }
  function recentRow(/** @type {any} */ g, /** @type {any} */ r) {
    return el('div', { class: 'st-row st-session st-recent', title: new Date(r.at).toLocaleString(), onclick: () => open(g.id, { sessionId: r.sessionId }) },
      el('span', { class: 'sb-dot' }), el('span', { class: 'st-title' }, r.title));
  }
  function groupEl(/** @type {any} */ g) {
    const shut = !query && closed.has(g.id);
    const toggle = () => { if (closed.has(g.id)) closed.delete(g.id); else closed.add(g.id); saveClosed(); draw(); };
    const head = el('div', { class: `st-group-head${g.active ? ' active' : ''}${g.current ? ' current' : ''}`, title: g.name },
      el('button', { class: 'st-caret', 'aria-expanded': String(!shut), title: g.name, onclick: toggle }, icon('chevron', 12)),
      el('span', { class: 'st-title st-project', onclick: () => { picked = g.id; hooks.selectProject(g.id); refresh(); } }, g.name),
      g.attention ? el('span', { class: `sb-attn ${g.attention}` }, '●') : null,
      g.account ? el('span', { class: 'st-badge', title: `${t('studio.account')}: ${g.account}` }, g.account) : null,
      el('button', { class: 'st-add', title: `${t('studio.newSession')} · ${g.name}`, onclick: () => { picked = g.id; hooks.newSession(g.id); } }, icon('plus', 14)));
    const kids = shut ? [] : [
      ...g.running.map((/** @type {any} */ s, /** @type {number} */ i) => sessionRow(g, s, i)),
      ...(g.recent.length ? [el('div', { class: 'st-sub' }, t('studio.recent')), ...g.recent.map((/** @type {any} */ r) => recentRow(g, r))] : []),
    ];
    return el('div', { class: `st-group${g.current ? ' current' : ''}` }, head, ...kids);
  }

  function draw() {
    if (!on) return;
    newLabel.textContent = t('studio.newSession');
    newBtn.title = `${modLabel}N`;
    startLabel.textContent = t('studio.newSession');
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
    account.replaceChildren(
      el('span', { class: 'st-avatar', 'aria-hidden': 'true' }, (who.trim()[0] || '?').toLocaleUpperCase()),
      el('div', { class: 'st-user', title: `${t('studio.account')}: ${label}` },
        el('span', { class: 'st-title' }, (sameAsActive && (u.name || u.email)) || label),
        el('span', { class: 'st-email' }, [sameAsActive && u.name ? u.email : '', label].filter(Boolean).join(' · '))),
      el('button', { class: 'sb-gear', title: t('studio.settings'), 'aria-label': t('studio.settings'), onclick: () => hooks.openSettings() }, icon('gear')),
      el('button', { class: 'st-switch', title: `${t('studio.toOffice')} (${modLabel === '⌘' ? '⌘⇧E' : 'Ctrl+Shift+E'})`, 'aria-label': t('studio.toOffice'), onclick: () => hooks.toggle() }, icon('office')));
    greeting.textContent = u.name ? t('studio.greetingName', { name: u.name }) : t('studio.greeting');
    start.hidden = hooks.hasSession();
  }

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
  function showPanel(/** @type {string} */ selector) {
    const sb = document.getElementById('sidebar');
    const target = /** @type {HTMLElement | null} */ (sb?.querySelector(selector) || null);
    if (!on || !sb || !target || target.hidden) return false;
    let top = target;
    while (top.parentElement && top.parentElement !== sb) top = top.parentElement;
    for (const c of sb.children) c.classList.toggle('studio-shown', c === top);
    if (top.tagName === 'DETAILS') /** @type {HTMLDetailsElement} */ (top).open = true;
    document.body.classList.add('studio-panel');
    panelBack.hidden = false;
    return true;
  }
  function hidePanel() {
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
      start.hidden = true;
      clearInterval(timer);
      if (on) { timer = window.setInterval(refresh, REFRESH_MS); refresh(); }
    },
    isOn: () => on,
    /** The Office changed (projects, tabs, the active session): redraw with fresh data. */
    changed() { if (!on) return; clearTimeout(soon); soon = window.setTimeout(refresh, 250); },
    /** ⌘N, ⌘K, ⌘1…9 (src/studio-keys.mjs) */
    newSession,
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
