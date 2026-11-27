// Studio experience (contract v3.120): an optional layout in the same window, like Claude Desktop's Code view.
// body.studio hides the Office (scene, left panel, tab strip, style.css); this module adds Studio's own sidebar and its
// start screen. The main region is the existing #terminal: the active session's chat view (or its terminal on Windows,
// where GUI chat is off) as the Office shows it, so no chat is rendered twice. Switching back removes body.studio and
// the Office is as it was: panes, tabs and sessions are never touched here.
// Every text from main (project, session, device and account names) is put in with textContent.

const REFRESH_MS = 10000;

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
 * @param {{
 *   api: any, t: (key: string, vars?: Record<string, any>) => string, modLabel: string,
 *   hooks: {
 *     selectSession: (projectId: string, n: number) => void, newSession: (projectId: string) => void,
 *     selectProject: (projectId: string) => void, selectHq: () => void, openBoard: () => void,
 *     openSettings: () => void, toggle: () => void, activePty: () => string | null, hasSession: () => boolean,
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
  let picked = '';   // the project the picker shows (follows the active project until the person picks another)
  let query = '';
  let timer = 0;
  let soon = 0;

  const search = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'st-search', oninput: () => { query = search.value.trim().toLowerCase(); draw(); } }));
  const newBtn = el('button', { class: 'st-new', onclick: () => newSession() });
  const pins = el('div', { class: 'st-pins' });
  const picker = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-picker', onchange: () => { picked = picker.value; hooks.selectProject(picked); refresh(); } }));
  const lists = el('div', { class: 'st-lists' });
  const machines = el('div', { class: 'st-machines' });
  const account = el('div', { class: 'st-account' });
  const bar = el('aside', { id: 'studio-sidebar', hidden: true }, newBtn, search, pins, picker, lists, machines, account);
  const greeting = el('p', { class: 'st-greeting' });
  const startNew = el('button', { class: 'st-new', onclick: () => newSession() });
  const start = el('div', { id: 'studio-start', hidden: true }, greeting, startNew);
  document.getElementById('body')?.prepend(bar);
  document.getElementById('terminal')?.append(start);

  const project = () => view.projects.find((/** @type {any} */ p) => p.id === picked) || view.projects.find((/** @type {any} */ p) => p.active) || view.projects[0] || null;
  /** The sessions of the shown project, in the order ⌘1…9 picks them (filtered by the search like the list). */
  const shownSessions = () => {
    const p = project();
    return p ? p.running.filter((/** @type {any} */ s) => matches(s.title, p.name)) : [];
  };
  const matches = (/** @type {string[]} */ ...texts) => !query || texts.some((x) => String(x || '').toLowerCase().includes(query));

  function newSession() {
    const p = project();
    if (p) hooks.newSession(p.id);
  }
  async function open(/** @type {string} */ projectId, /** @type {any} */ ref) {
    const r = await api.studio.open(projectId, ref).catch(() => null);
    if (r?.ok) { picked = r.projectId; hooks.selectSession(r.projectId, r.n); }
    refresh();
  }

  function sessionRow(/** @type {any} */ p, /** @type {any} */ s, /** @type {number} */ i) {
    const active = hooks.activePty() === s.ptyId;
    const state = s.isRunning ? 'live' : s.isAsleep ? 'asleep' : '';
    return el('div', { class: `st-row${active ? ' active' : ''}`, title: s.title, onclick: () => open(p.id, { n: s.n }) },
      el('span', { class: `sb-dot ${state}` }),
      el('span', { class: 'st-title' }, s.title),
      i < 9 ? el('span', { class: 'st-key' }, `${modLabel}${i + 1}`) : null);
  }

  function draw() {
    if (!on) return;
    newBtn.textContent = `+ ${t('studio.newSession')}`;
    newBtn.title = `${modLabel}N`;
    startNew.textContent = `+ ${t('studio.newSession')}`;
    search.placeholder = `${t('studio.search')} (${modLabel}K)`;
    pins.replaceChildren(
      el('div', { class: 'st-row st-pin', onclick: () => hooks.selectHq() }, t('studio.hq')),
      el('div', { class: 'st-row st-pin', onclick: () => hooks.openBoard() }, t('studio.reports')),
      el('div', { class: 'st-row st-pin', onclick: () => hooks.openBoard() }, t('studio.routines')));
    const p = project();
    picker.replaceChildren(...view.projects.map((/** @type {any} */ x) => el('option', { value: x.id }, x.name)));
    picker.value = p?.id || '';
    picker.title = t('studio.project');
    const running = shownSessions();
    const recent = p ? p.recent.filter((/** @type {any} */ r) => matches(r.title, p.name)) : [];
    lists.replaceChildren(
      el('div', { class: 'st-head' }, t('studio.running')),
      ...(running.length ? running.map((s, i) => sessionRow(p, s, i)) : [el('div', { class: 'st-none' }, t('studio.none'))]),
      el('div', { class: 'st-head' }, t('studio.recent')),
      ...(recent.length ? recent.map((/** @type {any} */ r) => el('div', { class: 'st-row', title: new Date(r.at).toLocaleString(), onclick: () => open(p.id, { sessionId: r.sessionId }) },
        el('span', { class: 'sb-dot' }), el('span', { class: 'st-title' }, r.title))) : [el('div', { class: 'st-none' }, t('studio.none'))]));
    // paired machines: read-only (a remote target is send-as-task plus a read-only view, from the Office's HQ)
    machines.replaceChildren(...(devices.length ? [el('div', { class: 'st-head' }, t('studio.machines')),
      ...devices.map((d) => el('div', { class: 'st-row st-device', title: d.online ? t('studio.online') : t('studio.offline') },
        el('span', { class: `sb-dot${d.online ? ' live' : ''}` }), el('span', { class: 'st-title' }, d.name)))] : []));
    const u = view.user || {};
    account.replaceChildren(
      el('div', { class: 'st-user' }, el('span', { class: 'st-title' }, u.name || u.email || u.account || ''), u.name && u.email ? el('span', { class: 'st-email' }, u.email) : null),
      el('button', { class: 'sb-gear', title: t('studio.settings'), onclick: () => hooks.openSettings() }, '⚙'),
      el('button', { class: 'st-switch', title: `${t('studio.toOffice')} (${modLabel === '⌘' ? '⌘⇧E' : 'Ctrl+Shift+E'})`, onclick: () => hooks.toggle() }, t('studio.toOffice')));
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

  return {
    /** Studio on or off: body.studio, the sidebar and the start screen; the Office's elements are only hidden. */
    setOn(/** @type {boolean} */ value) {
      on = Boolean(value);
      document.body.classList.toggle('studio', on);
      if (!on) document.body.classList.remove('studio-board');
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
    focusSearch() { search.focus(); search.select(); },
    selectIndex(/** @type {number} */ i) {
      const p = project();
      const s = shownSessions()[i];
      if (p && s) open(p.id, { n: s.n });
    },
  };
}
