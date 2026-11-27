// Studio's Team page (contract v3.124): a full page in Studio's main region with three tabs (Members, Roles,
// Departments) over the Office's own team data (sidebar.teamData) and the Office's own calls (staff:save,
// staff:remove, the member popup, the role wizard, the desk path). Main keeps every limit and check; its errors are
// shown inline. Pure parts in src/studio-team-page.mjs. Texts from main (names, labels) go in with textContent.

import { icon } from './studio-icons.js';
import { TEAM_TABS } from '../src/studio-team-page.mjs';
import { deptLabel } from '../src/staff-view.mjs';
import { drawRoles } from './studio-team-roles.js';
import { drawMembers } from './studio-team-members.js';
import { drawDepartments } from './studio-team-departments.js';

const SYNC_MS = 2000;   // live states (working, needs you) and changes made elsewhere follow within 2 s

/**
 * @typedef {{
 *   teamData: () => any, accounts: () => { id: string, label: string }[], waiting: () => Set<string>,
 *   teamControl: () => HTMLInputElement | null,
 *   save: (form: any) => Promise<any>, remove: (id: string) => Promise<any>, reload: () => Promise<any>,
 *   editMember: (member: any) => void, openWizard: () => void, openDesk: (projectId: string, staffId: string) => void,
 *   tools: () => Promise<{ id: string, name: string }[]>,
 * }} TeamHooks
 * @typedef {{
 *   el: (tag: string, props?: Record<string, any>, ...kids: any[]) => HTMLElement,
 *   t: (key: string, vars?: Record<string, any>) => string, td: any, lang: string, hooks: TeamHooks,
 *   dept: (d: string) => string, errorText: (e: unknown) => string,
 *   sheet: { open: (title: string, body: (Node | null)[]) => void, close: () => void },
 *   redraw: () => void, go: (tab: string) => void, close: () => void, state: Record<string, any>,
 * }} TeamView
 * @typedef {(v: TeamView) => (Node | null)[]} TabDraw
 */

/** @type {Record<string, TabDraw>} the tabs' views (renderer/studio-team-*.js) */
const views = { members: drawMembers, roles: drawRoles, departments: drawDepartments };

/**
 * @param {{ el: TeamView['el'], t: TeamView['t'], host: HTMLElement, hooks: TeamHooks }} o
 */
export function mountTeamPage({ el, t, host, hooks }) {
  let tab = 'members';
  let timer = 0;
  /** @type {Record<string, any>} each tab's own state (search, filter, an open editor), kept across redraws */
  const state = {};

  const backBtn = el('button', { class: 'st-set-back', type: 'button', onclick: () => close() }, icon('back', 16));
  const title = el('h1', { class: 'st-set-title' });
  const tabsEl = el('div', { class: 'st-team-tabs', role: 'tablist' });
  const content = el('div', { class: 'st-team-content' });
  const sheetTitle = el('h2', { class: 'st-sheet-title' });
  const sheetBody = el('div', { class: 'st-sheet-body' });
  const sheetEl = el('aside', { class: 'st-sheet', role: 'dialog', 'aria-modal': 'true', hidden: true },
    el('div', { class: 'st-sheet-head' }, sheetTitle, el('button', { class: 'st-set-back', type: 'button', onclick: () => sheet.close() }, icon('close', 16))),
    sheetBody);
  const sheetBack = el('div', { class: 'st-sheet-back', hidden: true, onmousedown: () => sheet.close() });
  const page = el('div', { id: 'studio-team', hidden: true, role: 'region' },
    el('div', { class: 'st-set-top' }, backBtn, title, tabsEl), content, sheetBack, sheetEl);
  host.append(page);

  const sheet = {
    open(/** @type {string} */ name, /** @type {(Node | null)[]} */ body) {
      sheetTitle.textContent = name;
      sheetBody.replaceChildren(...body.filter((x) => x !== null));
      sheetEl.hidden = false;
      sheetBack.hidden = false;
      sheetBody.scrollTop = 0;
      /** @type {HTMLElement | null} */ (sheetBody.querySelector('input, textarea, select, button'))?.focus();
    },
    close() { sheetEl.hidden = true; sheetBack.hidden = true; sheetBody.replaceChildren(); },
  };
  const errorText = (/** @type {unknown} */ e) => t(`staff.error.${typeof e === 'string' && ['name', 'role', 'name-used', 'too-many'].includes(e) ? e : 'failed'}`);

  /** The team data from the Office's sidebar (staff.list, desks, projects), or null. */
  const data = () => { try { return hooks.teamData() || null; } catch { return null; } };

  /** Team mode off: a friendly empty state with the Office's own switch (Settings → Team). */
  function offState() {
    const ctl = hooks.teamControl();
    const turnOn = el('button', { class: 'st-set-btn primary', type: 'button', disabled: !ctl || undefined, onclick: async () => {
      const box = hooks.teamControl();
      if (!box) return;
      /** @type {HTMLButtonElement} */ (turnOn).disabled = true;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));   // the Office's own handler: prefs.set, then the list
      for (let i = 0; i < 30 && !data()?.teamMode; i++) await new Promise((r) => setTimeout(r, 100));
      draw();
    } }, t('studio.teamPage.turnOn'));
    return el('div', { class: 'st-team-empty' },
      el('span', { class: 'st-team-empty-icon', 'aria-hidden': 'true' }, icon('team', 28)),
      el('h2', {}, t('studio.teamPage.offTitle')),
      el('p', {}, t('studio.teamPage.offText')),
      turnOn);
  }

  function draw() {
    if (page.hidden) return;
    const td = data();
    title.textContent = t('studio.teamPage.title');
    const on = Boolean(td?.teamMode);
    tabsEl.hidden = !on;
    if (!on) { sheet.close(); content.replaceChildren(offState()); return; }
    const label = { members: t('studio.teamPage.tabMembers'), roles: t('studio.teamPage.tabRoles'), departments: t('studio.teamPage.tabDepartments') };
    tabsEl.replaceChildren(...TEAM_TABS.map((id) => el('button', {
      class: `st-team-tab${id === tab ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(id === tab), onclick: () => go(id),
    }, /** @type {Record<string, string>} */ (label)[id])));
    const lang = td.lang === 'tr' ? 'tr' : 'en';
    const view = views[tab];
    // a text box being typed in keeps its place: the live refresh waits until it is left
    const typing = document.activeElement instanceof HTMLElement && content.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
    if (typing && content.childElementCount) return;
    const scroll = content.scrollTop;
    content.replaceChildren(...(view ? view({ el, t, td, lang, hooks, dept: (d) => deptLabel(t, d), errorText, sheet, redraw: force, go, close, state }) : []).filter((x) => x !== null));
    content.scrollTop = scroll;
  }
  /** A redraw after the person's own action: a text box that kept the focus does not hold it back. */
  function force() {
    if (document.activeElement instanceof HTMLElement && content.contains(document.activeElement)) document.activeElement.blur();
    draw();
  }
  function go(/** @type {string} */ to) {
    if (!TEAM_TABS.includes(to)) return;
    tab = to;
    content.replaceChildren();
    content.scrollTop = 0;
    draw();
    focusSearch();
  }
  /** v3.124 the Roles tab (every Add member entry) opens with its search focused. */
  function focusSearch() {
    if (tab === 'roles') /** @type {HTMLElement | null} */ (content.querySelector('.st-team-search'))?.focus();
  }
  function open(/** @type {string} */ to = '') {
    if (TEAM_TABS.includes(to)) tab = to;
    page.hidden = false;
    content.replaceChildren();
    draw();
    clearInterval(timer);
    timer = window.setInterval(draw, SYNC_MS);
    if (tab === 'roles' && data()?.teamMode) focusSearch(); else backBtn.focus();
  }
  function close() {
    page.hidden = true;
    sheet.close();
    clearInterval(timer);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || page.hidden || document.querySelector('.sb-modal-backdrop')) return;
    e.preventDefault();
    if (!sheetEl.hidden) sheet.close(); else close();
  });
  return { open, close, isOpen: () => !page.hidden, redraw: () => draw() };
}
