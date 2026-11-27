// v3.131 the board: orders and project conversations as cards in five columns (To do, Working, Needs you, Review,
// Done), sorted by type (bugfix, hotfix, feature) then age by src/board-model.js, plus a Reports tab. One component
// for both experiences: the Office's HQ board (renderer/hq-board.js) and Studio's Board / Reports entries show it.
// Every text from a card is put in with textContent: titles and names are data, never markup.
import { meterView, amountText } from '../src/economy-view.mjs';
import { TYPES, GROUPS, RANGES, projectsOf, membersOf, columnsOf, filterOptions, fmtDuration, fmtCost, fmtTokens, rangeOf, typeCounts, reportRows } from '../src/board-view.mjs';

const POLL_MS = 30000;   // a fallback only: main pushes board:cards whenever the store changes

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node | string | null | undefined | false)} kids */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k != null && k !== false) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/**
 * @param {{ api: any, t: (k: string, v?: any) => string,
 *   renderTasks: (card: any) => Node[], openChat: (card: any) => void }} o
 *   renderTasks draws an order's tasks with the HQ board's task detail and actions (Cancel, Continue, Allow);
 *   openChat opens a chat card's session (an Office tab or a Studio session).
 */
export function mountBoardView({ api, t, renderTasks, openChat }) {
  /** @type {any} */ let view = { columns: [], cards: [] };
  let tab = 'board';
  /** @type {{ project: string, type: string, member: string, q: string, request: string }} */
  const f = { project: '', type: '', member: '', q: '', request: '' };
  /** @type {Set<string>} */ const expanded = new Set();
  let menuFor = '';
  let note = '';
  /** @type {any} */ const rep = { range: 'week', from: '', to: '', groupBy: 'project', data: null, types: null, seq: 0 };

  const tabBtn = (key) => el('button', { class: 'bv-tab', 'data-tab': key, onclick: () => setTab(key) }, t(`board.tab.${key}`));
  const tabs = el('div', { class: 'bv-tabs', role: 'tablist' }, tabBtn('board'), tabBtn('reports'));
  // filters: built once so the search box keeps its focus and text across live updates
  const pick = (key) => /** @type {HTMLSelectElement} */ (el('select', { class: 'bv-pick', 'aria-label': t(`board.filter.${key}`), onchange: (/** @type {Event} */ e) => { f[key] = /** @type {HTMLSelectElement} */ (e.target).value; draw(); } }));
  const projectSel = pick('project'); const typeSel = pick('type'); const memberSel = pick('member');
  const search = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'bv-search', placeholder: t('board.search'), oninput: () => { f.q = search.value; draw(); } }));
  const requestChip = el('button', { class: 'bv-chip bv-request', hidden: true, title: t('board.showAll'), onclick: () => { f.request = ''; draw(); } });
  const filters = el('div', { class: 'bv-filters' }, projectSel, typeSel, memberSel, search, requestChip);
  // reports controls
  const rangeSel = /** @type {HTMLSelectElement} */ (el('select', { class: 'bv-pick', 'aria-label': t('board.range.label'), onchange: () => { rep.range = rangeSel.value; drawReportControls(); loadReport(); } },
    ...RANGES.map((r) => el('option', { value: r }, t(`board.range.${r}`)))));
  const fromIn = /** @type {HTMLInputElement} */ (el('input', { type: 'date', class: 'bv-date', 'aria-label': t('board.range.from'), onchange: () => { rep.from = fromIn.value; loadReport(); } }));
  const toIn = /** @type {HTMLInputElement} */ (el('input', { type: 'date', class: 'bv-date', 'aria-label': t('board.range.to'), onchange: () => { rep.to = toIn.value; loadReport(); } }));
  const groupSel = /** @type {HTMLSelectElement} */ (el('select', { class: 'bv-pick', 'aria-label': t('board.groupBy.label'), onchange: () => { rep.groupBy = groupSel.value; loadReport(); } },
    ...GROUPS.map((g) => el('option', { value: g }, t(`board.groupBy.${g}`)))));
  const reportBar = el('div', { class: 'bv-filters', hidden: true }, rangeSel, fromIn, toIn, groupSel);
  const body = el('div', { class: 'bv-body' });
  const root = el('div', { class: 'bv-root' }, el('div', { class: 'bv-head' }, tabs, filters, reportBar), body);
  root.addEventListener('click', () => { if (menuFor) { menuFor = ''; draw(); } });

  /** Fills a filter menu, keeping the choice (or an "all" entry when the choice is gone). */
  function fill(/** @type {HTMLSelectElement} */ sel, /** @type {string} */ key, /** @type {string[]} */ values, /** @type {(v: string) => string} */ label) {
    if (f[key] && !values.includes(f[key])) values = [...values, f[key]];
    const sig = JSON.stringify(values);
    if (sel.dataset.sig !== sig) {
      sel.replaceChildren(el('option', { value: '' }, t(`board.filter.${key}`)), ...values.map((v) => el('option', { value: v }, label(v))));
      sel.dataset.sig = sig;
    }
    sel.value = f[key];
  }
  const typeName = (/** @type {string} */ x) => t(`board.type.${x}`);
  function typeChip(/** @type {any} */ c) {
    const open = menuFor === c.id;
    return el('span', { class: 'bv-type-wrap' },
      el('button', { class: `bv-type bv-${c.type}`, title: `${t('board.typeTip')}${c.typeBy === 'person' ? ` · ${t('board.typeByPerson')}` : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(open),
        onclick: (/** @type {Event} */ e) => { e.stopPropagation(); menuFor = open ? '' : c.id; draw(); } }, typeName(c.type)),
      open ? el('div', { class: 'bv-menu', role: 'menu' }, ...TYPES.map((x) => el('button', { class: `bv-menu-item${x === c.type ? ' on' : ''}`, role: 'menuitem',
        onclick: async (/** @type {Event} */ e) => {
          e.stopPropagation(); menuFor = '';
          const r = await api.board.setType(c.id, x).catch(() => null);
          if (r?.ok) { view = r; note = ''; } else note = t('board.gone');
          draw();
        } }, el('span', { class: `bv-dot bv-${x}` }), typeName(x)))) : null);
  }
  const sourceOf = (/** @type {any} */ c) => (c.kind === 'chat' ? 'chat' : c.routine ? 'routine' : 'order');
  function card(/** @type {any} */ c) {
    const isOrder = c.kind === 'order';
    const open = isOrder && expanded.has(c.id);
    const age = c.durationMs || (c.at && !c.closedAt ? Date.now() - c.at : 0);
    const cost = [fmtTokens(c.tokens) && `${fmtTokens(c.tokens)} ${t('board.tokens')}`, fmtCost(c.usd)].filter(Boolean).join(' · ');
    const click = () => {
      if (isOrder) { if (open) expanded.delete(c.id); else expanded.add(c.id); draw(); } else openChat(c);
    };
    return el('div', { class: `bv-card bv-k-${c.kind}${open ? ' open' : ''}`, 'data-id': c.id, tabindex: '0', role: 'button', 'aria-expanded': isOrder ? String(open) : null,
      title: isOrder ? t('board.orderTip') : t('board.openChat'),
      onclick: click, onkeydown: (/** @type {KeyboardEvent} */ e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); click(); } } },
    el('div', { class: 'bv-card-top' }, typeChip(c), el('span', { class: `bv-source bv-src-${sourceOf(c)}` }, t(`board.source.${sourceOf(c)}`)),
      isOrder && c.progress?.total ? el('span', { class: 'bv-progress', title: t('board.progressTip') }, `${c.progress.done}/${c.progress.total}`) : null),
    el('div', { class: 'bv-title' }, c.title || c.request || c.id),
    el('div', { class: 'bv-meta' }, ...projectsOf(c).map((p) => el('span', { class: 'bv-chip bv-proj' }, p)),
      ...membersOf(c).map((m) => el('span', { class: 'bv-chip bv-member' }, `@${m}`))),
    isOrder && (c.tasks || []).length > 1 ? el('div', { class: 'bv-targets' }, ...c.tasks.map((/** @type {any} */ x) => el('span', { class: `bv-chip bv-target bv-c-${x.column}`, title: `${x.title || x.id} · ${x.status}` },
      `${x.project}${x.machine && x.machine !== 'self' ? ` · ${x.machine}` : ''}`))) : null,
    el('div', { class: 'bv-foot' }, el('span', {}, fmtDuration(age)), cost ? el('span', {}, cost) : null,
      c.column === 'review' ? el('button', { class: 'bv-done', title: t('board.doneTip'), onclick: async (/** @type {Event} */ e) => {
        e.stopPropagation();
        const r = await api.board.done(c.id).catch(() => null);
        if (r?.ok) { view = r; note = ''; } else note = t('board.gone');
        draw();
      } }, t('board.done')) : null),
    open ? el('div', { class: 'bv-tasks', onclick: (/** @type {Event} */ e) => e.stopPropagation() }, ...renderTasks(c)) : null);
  }
  function drawBoard() {
    const opts = filterOptions(view.cards);
    fill(projectSel, 'project', opts.projects, (v) => v);
    fill(typeSel, 'type', opts.types, typeName);
    fill(memberSel, 'member', opts.members, (v) => v);
    requestChip.hidden = !f.request;
    requestChip.textContent = f.request ? `✕ ${f.request}` : '';
    const cols = columnsOf(view, f);
    body.replaceChildren(...(note ? [el('p', { class: 'bv-note', role: 'status' }, note)] : []),
      el('div', { class: 'bv-cols' }, ...cols.map((col) => el('section', { class: `bv-col bv-col-${col.id}` },
        el('h3', {}, t(`board.col.${col.id}`), el('span', { class: 'bv-count' }, String(col.cards.length))),
        ...(col.cards.length ? col.cards.map(card) : [el('p', { class: 'bv-empty' }, t('board.empty'))])))));
  }
  function drawReportControls() {
    rangeSel.value = rep.range;
    fromIn.hidden = toIn.hidden = rep.range !== 'custom';
    groupSel.value = rep.groupBy;
  }
  async function loadReport() {
    const range = rangeOf(rep.range, Date.now(), { from: rep.from, to: rep.to });
    const seq = ++rep.seq;
    if (!range) { rep.data = null; rep.types = null; drawReport(); return; }
    const [data, types, briefs] = await Promise.all([api.board.report(range, rep.groupBy).catch(() => null),
      rep.groupBy === 'type' ? null : api.board.report(range, 'type').catch(() => null),
      Promise.resolve(api.tokens?.brief?.()).catch(() => null)]);   // v3.133 the projects' budget meters
    reportBriefs = new Map((Array.isArray(briefs) ? briefs : []).filter((b) => b && b.name).map((b) => [b.name, b]));
    if (seq !== rep.seq) return;   // a newer choice is on its way
    rep.data = data && !data.error ? data : null;
    rep.types = rep.groupBy === 'type' ? rep.data : types && !types.error ? types : null;
    drawReport();
  }
  function drawReport() {
    if (tab !== 'reports') return;
    const data = rep.data;
    if (!data) { body.replaceChildren(el('p', { class: 'bv-empty' }, t(rep.range === 'custom' ? 'board.pickDates' : 'board.noReport'))); return; }
    const n = typeCounts(rep.types);
    const keyOf = (/** @type {string} */ k) => (!k ? t('board.none') : data.groupBy === 'type' ? typeName(k) : k);
    const rows = reportRows(data);
    const tot = data.total || {};
    const cell = (/** @type {string} */ s, cls = '') => el('td', { class: cls }, s || '–');
    body.replaceChildren(
      el('p', { class: 'bv-headline' }, t('board.headline', { range: t(`board.range.${rep.range}`), bugfix: n.bugfix, hotfix: n.hotfix, feature: n.feature })),
      rows.length ? el('table', { class: 'bv-report' },
        el('thead', {}, el('tr', {}, ...['key', 'bar', 'count', 'avg', 'tokens', 'cost'].map((k) => el('th', { class: `bv-th-${k}` }, k === 'key' ? t(`board.groupBy.${data.groupBy}`) : k === 'bar' ? '' : t(`board.report.${k}`))))),
        el('tbody', {}, ...rows.map((r) => el('tr', {},
          el('td', { class: 'bv-key' }, data.groupBy === 'type' ? el('span', { class: `bv-dot bv-${r.key}` }) : null, keyOf(r.key), data.groupBy === 'project' ? budgetCell(r.key) : null),
          el('td', { class: 'bv-barcell' }, el('span', { class: `bv-bar${data.groupBy === 'type' ? ` bv-${r.key}` : ''}`, style: `width:${r.pct}%` })),
          cell(String(r.count), 'bv-num'), cell(fmtDuration(r.avgMs), 'bv-num'), cell(fmtTokens(r.tokens), 'bv-num'), cell(fmtCost(r.usd), 'bv-num')))),
        el('tfoot', {}, el('tr', {}, el('td', {}, t('board.report.total')), el('td', {}),
          cell(String(tot.count || 0), 'bv-num'), cell(fmtDuration(tot.count ? tot.durationMs / tot.count : 0), 'bv-num'), cell(fmtTokens(tot.tokens), 'bv-num'), cell(fmtCost(tot.usd), 'bv-num'))))
        : el('p', { class: 'bv-empty' }, t('board.noReport')));
  }
  /** @type {Map<string, any>} */
  let reportBriefs = new Map();
  /** v3.133 a project row's budget meter (by project name), or null without a budget. */
  function budgetCell(/** @type {string} */ name) {
    const v = meterView(reportBriefs.get(name));
    if (!v) return null;
    return el('span', { class: `bv-budget ${v.level}`, title: t('sidebar.budgetMeter', { pct: v.pct, used: amountText(v.used, v.unit), limit: amountText(v.limit, v.unit), period: t(`sidebar.budget_${v.period}`) }) },
      el('i', { style: `width:${v.width}%` }));
  }
  function draw() {
    for (const b of tabs.children) { const on = b.getAttribute('data-tab') === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    filters.hidden = tab !== 'board';
    reportBar.hidden = tab !== 'reports';
    if (tab === 'board') drawBoard(); else drawReport();
  }
  function setTab(/** @type {string} */ next) {
    tab = next === 'reports' ? 'reports' : 'board';
    menuFor = '';
    if (tab === 'reports') { drawReportControls(); loadReport(); }
    draw();
  }
  const take = (/** @type {any} */ v) => { if (v && Array.isArray(v.cards)) { view = v; draw(); if (tab === 'reports') loadReport(); } };
  const pull = () => api.board?.cards().then(take).catch(() => {});
  if (api.board) {
    api.board.onCards?.(take);
    pull();
    setInterval(() => { if (root.isConnected) pull(); }, POLL_MS);
  }
  draw();
  return {
    el: root,
    /** Draws again (the HQ view behind an open order's tasks changed). */
    render: () => draw(),
    setTab,
    /** Shows only one request's card (a routine run's "Show on board"); '' shows all. */
    setRequest(/** @type {string} */ id) { f.request = id || ''; tab = 'board'; if (id) expanded.add(`o:${id}`); draw(); },
    available: Boolean(api.board),
  };
}

