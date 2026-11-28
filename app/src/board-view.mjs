// v3.131 the board's display helpers (pure; renderer/board-view.js draws with them). The cards and their order come from
// src/board-model.js through board:cards; these only filter, group for display and format numbers.

/** The owner's type order: 1. bugfix, 2. hotfix, 3. feature. */
export const TYPES = Object.freeze(['bugfix', 'hotfix', 'feature']);
export const COLUMNS = Object.freeze(['todo', 'working', 'needs-you', 'review', 'done']);
export const GROUPS = Object.freeze(['project', 'type', 'member']);
export const RANGES = Object.freeze(['week', 'lastWeek', 'days30', 'custom']);

const str = (v) => (typeof v === 'string' ? v : '');
const listOf = (card, many, one) => (Array.isArray(card?.[many]) && card[many].length ? card[many].filter((x) => typeof x === 'string' && x) : str(card?.[one]) ? [card[one]] : []);
/** A card's projects and members (an order may span several). */
export const projectsOf = (card) => listOf(card, 'projects', 'project');
export const membersOf = (card) => listOf(card, 'members', 'member');

/**
 * Whether a card passes the filters: project, type and member are exact (empty = any); q matches the title, projects,
 * members and, for orders, the request id and task titles, ignoring case.
 * @param {any} card @param {{ project?: string, type?: string, member?: string, q?: string, request?: string }} f
 */
export function matches(card, f = {}) {
  if (!card || typeof card !== 'object') return false;
  if (f.request && card.request !== f.request) return false;
  if (f.project && !projectsOf(card).includes(f.project)) return false;
  if (f.type && card.type !== f.type) return false;
  if (f.member && !membersOf(card).includes(f.member)) return false;
  const q = str(f.q).trim().toLocaleLowerCase();
  if (!q) return true;
  const hay = [card.title, card.request, ...projectsOf(card), ...membersOf(card), ...(Array.isArray(card.tasks) ? card.tasks.map((x) => x?.title) : [])];
  return hay.some((h) => str(h).toLocaleLowerCase().includes(q));
}

/** The filtered cards, in the order given. */
export const filterCards = (cards, f = {}) => (Array.isArray(cards) ? cards.filter((c) => matches(c, f)) : []);

/** The choices of the filter menus: projects and members seen on the cards (sorted), and the types in priority order. */
export function filterOptions(cards) {
  const projects = new Set(); const members = new Set();
  for (const c of Array.isArray(cards) ? cards : []) { for (const p of projectsOf(c)) projects.add(p); for (const m of membersOf(c)) members.add(m); }
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b));
  return { projects: sort(projects), members: sort(members), types: [...TYPES] };
}

/**
 * The five columns with their filtered cards. Keeps the model's order (byPriority: type, then age) from view.columns;
 * a card the view lists in no column falls back to its own `column`.
 * @param {any} view board:cards result @param {any} f filters @returns {{ id: string, cards: any[] }[]}
 */
export function columnsOf(view, f = {}) {
  const cards = Array.isArray(view?.cards) ? view.cards : [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  const placed = new Set();
  const out = COLUMNS.map((id) => {
    const col = Array.isArray(view?.columns) ? view.columns.find((x) => x?.id === id) : null;
    const list = (Array.isArray(col?.cards) ? col.cards : []).map((cid) => byId.get(cid)).filter(Boolean);
    for (const c of list) placed.add(c.id);
    return { id, cards: list };
  });
  for (const c of cards) if (!placed.has(c.id)) out.find((x) => x.id === c.column)?.cards.push(c);
  return out.map((x) => ({ id: x.id, cards: filterCards(x.cards, f) }));
}

/** "45s", "12m", "3h 5m", "2d 4h"; '' for nothing. */
export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "$0.42", "$12.30", "<$0.01"; '' for nothing. */
export function fmtCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 0.01) return '<$0.01';
  return `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
}

/** "950", "12.3k", "4.1M"; '' for nothing. */
export function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1000).toFixed(v < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

const DAY = 864e5;
/** Local midnight of the Monday of the week holding `now`. */
function weekStart(now) {
  const d = new Date(now);
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}
/**
 * The report range { from, to } in ms: this week (Monday 00:00 → now), last week (the 7 days before that Monday),
 * 30 days (now − 30 d → now) or custom ('YYYY-MM-DD' dates, both days included). null when a custom date is missing
 * or the range is empty.
 * @param {string} kind @param {number} now @param {{ from?: string, to?: string }} [custom]
 */
export function rangeOf(kind, now = Date.now(), custom = {}) {
  if (kind === 'week') return { from: weekStart(now), to: now };
  if (kind === 'lastWeek') { const to = weekStart(now); return { from: weekStart(to - 1), to }; }
  if (kind === 'days30') return { from: now - 30 * DAY, to: now };
  if (kind !== 'custom') return null;
  const day = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s)); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN; };
  const from = day(custom.from); const toDay = day(custom.to);
  if (!Number.isFinite(from) || !Number.isFinite(toDay)) return null;
  const to = new Date(toDay + 36 * 36e5).setHours(0, 0, 0, 0);   // the end of the last day
  return to > from ? { from, to } : null;
}

/** Closed counts per type from a report grouped by type: { bugfix, hotfix, feature }. */
export function typeCounts(report) {
  const out = { bugfix: 0, hotfix: 0, feature: 0 };
  for (const r of Array.isArray(report?.rows) ? report.rows : []) if (TYPES.includes(r?.key)) out[r.key] += Number(r.count) || 0;
  return out;
}

/**
 * The report's rows for display: sorted (types in priority order, else by count then key), each with avgMs (the
 * average duration) and pct (0–100, the bar width against the largest count).
 * @param {any} report board:report result
 */
export function reportRows(report) {
  const rows = (Array.isArray(report?.rows) ? report.rows : []).filter((r) => r && typeof r === 'object');
  const byType = report?.groupBy === 'type';
  const sorted = [...rows].sort((a, b) => (byType ? TYPES.indexOf(a.key) - TYPES.indexOf(b.key) : (Number(b.count) || 0) - (Number(a.count) || 0) || str(a.key).localeCompare(str(b.key))));
  const max = Math.max(1, ...sorted.map((r) => Number(r.count) || 0));
  return sorted.map((r) => {
    const count = Number(r.count) || 0;
    return { key: str(r.key), count, avgMs: count ? (Number(r.durationMs) || 0) / count : 0, tokens: Number(r.tokens) || 0, usd: Number(r.usd) || 0,
      orders: Number(r.orders) || 0, chats: Number(r.chats) || 0, pct: Math.round((count / max) * 100) };
  });
}

// v3.135 live order tracking: one strip item (src/order-track.js orderStrip) as a line
const EN = {
  'orders.line.order': 'Order #{id}',
  'orders.line.progress': '{done}/{total} done',
  'orders.line.desk': 'desk {member}',
  'orders.line.at': '{project} on {machine}',
  'orders.state.working': '{who} working on project {project}',
  'orders.state.queued': '{who} queued on project {project}',
  'orders.state.queuedAhead': '{who} queued on project {project}, {n} ahead',
  'orders.state.needs': '{who} needs you on project {project}',
  'orders.state.done': '{who} done on project {project}',
  'orders.state.failed': '{who} failed on project {project}',
  'orders.line.boss': 'boss',
};
/** English fallback for `progressLine` (the renderer passes its own t). */
export const enT = (k, v = {}) => String(EN[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => String(v[x] ?? ''));

/** "Order #r12 · bugfix · 3/5 done · desk Ayşe working on project X": one strip item as a line. */
export function progressLine(item, t = enT, typeName = (x) => x) {
  if (!item || typeof item !== 'object') return '';
  const parts = [t('orders.line.order', { id: item.request }), typeName(item.type), t('orders.line.progress', { done: item.done, total: item.total })];
  const c = item.current;
  if (c) {
    const who = c.member ? t('orders.line.desk', { member: c.member }) : t('orders.line.boss');
    const project = c.machine && c.machine !== 'self' ? t('orders.line.at', { project: c.project, machine: c.machine }) : c.project;
    const v = { who, project, n: c.ahead };
    parts.push(c.state === 'queued' && c.ahead > 0 ? t('orders.state.queuedAhead', v) : t(`orders.state.${c.state}`, v));
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * v3.143 Which order a card belongs to: "#abc123" (the request id's first six characters) on an order card, '' on a
 * chat card. The aggregate board (all orders, no request filter) shows it so every card names its order.
 * @param {any} card
 */
export function orderTag(card) {
  const id = card && card.kind === 'order' && typeof card.request === 'string' ? card.request.replace(/^r[-_:]?/i, '') : '';
  return id ? `#${id.slice(0, 6)}` : '';
}

/** True when the board shows every order together (no single order picked). */
export const isAllOrders = (f) => !(f && f.request);
