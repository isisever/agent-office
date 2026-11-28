'use strict';
// v3.131 the HQ board as orders and conversations: pure model (no Electron, no fs).
// A card is an ORDER (an HQ request with its tasks) or a CHAT (one conversation = one Claude Code session in a
// project tab, Office or Studio). Every card has a type (bugfix > hotfix > feature, the owner's priority order) and
// sits in one of five columns. Main keeps the chat cards and the person's choices in board-cards.json.

const TYPES = Object.freeze(['bugfix', 'hotfix', 'feature']);   // priority order: index 0 goes first
const TYPE_RANK = Object.freeze({ bugfix: 0, hotfix: 1, feature: 2 });
const COLUMNS = Object.freeze(['todo', 'working', 'needs-you', 'review', 'done']);
const GROUPS = Object.freeze(['project', 'type', 'member']);
const MAX_CLOSED = 500;                       // closed chat cards kept
const MAX_OPEN = 200;                         // open chat cards kept (oldest activity dropped first)
const MAX_ORDER_META = 1000;                  // per-order choices kept
const MAX_TASK_SIDS = 1000;                   // sessions that carried a dispatched or remote task (newest kept)
const REVIEW_CLOSE_MS = 24 * 60 * 60 * 1000;  // a chat card idle in Review this long closes by itself
const TITLE_MAX = 80;
const TITLE_INPUT_MAX = 4000;                 // a chat title's raw text is cut to this before it is redacted
const AGE_MS = 10 * 60 * 1000;                // release order: a waiting item is promoted one rank per this much waiting

const RQ = require('./board-requests.js');   // v3.159 requests typed in project chats
const OT = require('./order-track.js');   // v3.135 order cost

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
// eslint-disable-next-line no-control-regex -- control characters are stripped on purpose
const line = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A valid type or ''. */
const typeOf = (x) => (isStr(x) && TYPES.includes(x.trim().toLowerCase()) ? x.trim().toLowerCase() : '');
const rankOf = (type) => (TYPE_RANK[typeOf(type)] ?? TYPE_RANK.feature);

// Keywords (en + tr). Turkish suffixes are allowed after a stem (hata → hatası, hatalı); English words need a boundary.
const HOTFIX_RE = /(^|[^\p{L}\p{N}])(ac[iıİI]l\p{L}*|urgent\p{L}*|hot[\s-]?fix\p{L}*|prod|production|canl[ıi]da|asap|kritik|critical)(?=$|[^\p{L}\p{N}])/iu;
const BUGFIX_RE = /(^|[^\p{L}\p{N}])(hata\p{L}*|bug\p{L}*|fix|fixes|fixed|broken|crash\p{L}*|çök\p{L}*|çalışmıyor\p{L}*|calismiyor\p{L}*|bozuk\p{L}*|error|errors|regression|düzelt\p{L}*)(?=$|[^\p{L}\p{N}])/iu;
const PREFIX_RE = /^\s*\[?\s*(bugfix|hotfix|feature)\s*\]?\s*[:\-–]/i;

/**
 * The type of a piece of text → { type, explicit }. An explicit "bugfix:" / "hotfix:" / "feature:" prefix wins;
 * then hotfix words (urgent, prod, acil), then bugfix words (bug, fix, hata, çalışmıyor, crash); else feature.
 */
function classify(text) {
  const s = String(text ?? '');
  const p = PREFIX_RE.exec(s);
  if (p) return { type: p[1].toLowerCase(), explicit: true };
  if (HOTFIX_RE.test(s)) return { type: 'hotfix', explicit: false };
  if (BUGFIX_RE.test(s)) return { type: 'bugfix', explicit: false };
  return { type: 'feature', explicit: false };
}
/** The type an order gets: an explicit `type` argument, else a prefix or keywords in its texts. */
function orderType(explicit, ...texts) {
  const t = typeOf(explicit);
  if (t) return t;
  for (const x of texts) { const c = classify(x); if (c.explicit) return c.type; }
  return classify(texts.filter(isStr).join(' \n ')).type;
}

/** HQ task status (hq.js STATUSES) → column. `partial` is reviewed, not done; `blocked` and failures need the person. */
function columnOf(status, reason = '') {
  switch (status) {
    case 'queued': case 'waiting': return 'todo';
    case 'delivered': case 'running': return 'working';
    case 'needs-approval': case 'awaiting-consent': case 'blocked': case 'failed': case 'expired': case 'lost': return 'needs-you';
    case 'partial': return 'review';
    case 'reported': return 'done';
    case 'rejected': return reason === 'cancelled' || reason === 'declined' ? 'done' : 'needs-you';
    default: return 'todo';
  }
}
/** A chat session's live state → column. */
function chatColumn({ busy = false, waiting = false } = {}) {
  return waiting ? 'needs-you' : busy ? 'working' : 'review';
}

/** Order cards and chat cards: type priority first (bugfix, hotfix, feature), then the oldest first. */
function compareCards(a, b) {
  return rankOf(a.type) - rankOf(b.type) || (num(a.at) - num(b.at)) || String(a.id).localeCompare(String(b.id));
}
const sortCards = (cards) => [...cards].sort(compareCards);
/** Items ({ type, at }) in release order: the same rule, stable for equal keys. */
/** The rank an item waiting since `at` has at `now`: one rank higher (lower number) per AGE_MS waited, never below 0.
 *  Without `now` (card sorting) there is no aging. A feature waits at most 2 × AGE_MS before it ranks like a bugfix. */
const agedRank = (type, at, now) => {
  const r = rankOf(type);
  if (!Number.isFinite(now) || !num(at) || now <= at) return r;
  return Math.max(0, r - Math.floor((now - at) / AGE_MS));
};
/** Release order: by (aged) type rank, then the oldest first, then the given order. `now` turns aging on. */
const byPriority = (items, typeFn = (x) => x.type, atFn = (x) => x.at, now = NaN) => items.map((x, i) => ({ x, i, r: agedRank(typeFn(x), num(atFn(x)), now) }))
  .sort((p, q) => p.r - q.r || num(atFn(p.x)) - num(atFn(q.x)) || p.i - q.i).map((p) => p.x);
/** An explicit type only: the `type` argument, else a `bugfix:` / `hotfix:` / `feature:` prefix in one of the texts; else ''. */
function explicitType(explicit, ...texts) {
  const t = typeOf(explicit);
  if (t) return t;
  for (const x of texts) { const c = classify(x); if (c.explicit) return c.type; }
  return '';
}

/** The card of an HQ request: its tasks give the column and progress; the person's choices (meta) win. */
function orderCard(request, tasks, meta = {}) {
  const ts = (Array.isArray(request.tasks) ? request.tasks : []).map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
  const cols = ts.map((t) => columnOf(t.status, t.reason));
  const has = (c) => cols.includes(c);
  let column;
  if (num(meta.doneAt)) column = 'done';
  else if (!ts.length) column = 'todo';
  else if (has('needs-you')) column = 'needs-you';
  else if (has('working')) column = 'working';
  else if (has('todo')) column = has('done') || has('review') ? 'working' : 'todo';
  else if (has('review') || !request.summary) column = 'review';   // every task ended; HQ has not closed it with a summary
  else column = 'done';
  const ended = ts.map((t) => num(t.finishedAt)).filter(Boolean);
  const closedAt = column === 'done' ? (num(meta.doneAt) || (ended.length ? Math.max(...ended) : num(request.at))) : 0;
  const projects = [...new Set(ts.map((t) => t.project).filter(Boolean))];
  const members = [...new Set(ts.map((t) => t.staff).filter(Boolean))];
  const first = ts[ts.length - 1] || ts[0];
  const cost = OT.orderCost(ts, isObj(meta.usage) ? meta.usage : {});   // v3.135 local session deltas + remote report costs
  return {
    id: `o:${request.id}`, kind: 'order', request: request.id,
    title: line(request.prompt || first?.title || request.id, TITLE_MAX),
    type: typeOf(meta.type) || typeOf(request.type) || orderType('', request.prompt, ...ts.map((t) => t.title)),
    typeBy: typeOf(meta.type) ? 'person' : typeOf(request.type) ? (request.typeBy === 'hq' ? 'hq' : 'auto') : 'auto',
    column, at: num(request.at), closedAt, durationMs: closedAt ? Math.max(0, closedAt - num(request.at)) : 0,
    project: projects.length === 1 ? projects[0] : projects.length ? `${projects.length} projects` : '', projects,
    member: members[0] || '', members, tokens: cost.tokens, usd: cost.usd, ...(cost.unknown ? { costUnknown: cost.unknown } : {}),
    progress: { done: cols.filter((c) => c === 'done' || c === 'review').length, total: ts.length },
    tasks: ts.map((t) => ({ id: t.id, title: t.title || '', project: t.project || '', machine: t.machine || 'self', status: t.status, column: columnOf(t.status, t.reason), ...(t.staff ? { member: t.staff } : {}) })),
    ...(request.routine ? { routine: true } : {}),
  };
}
/** The card of a stored chat record. */
function chatCard(rec) {
  const closedAt = num(rec.closedAt);
  return {
    id: rec.id, kind: 'chat', sessionId: rec.sessionId, projectId: rec.projectId, ptyId: rec.ptyId || '',
    title: line(rec.title || '', TITLE_MAX), type: typeOf(rec.type) || 'feature', typeBy: rec.typeBy === 'person' ? 'person' : 'auto',
    column: closedAt ? 'done' : COLUMNS.includes(rec.column) ? rec.column : 'review', at: num(rec.at), closedAt,
    ...(closedAt ? { closedBy: rec.closedBy === 'auto' ? 'auto' : 'person' } : {}),
    durationMs: Math.max(0, (closedAt || num(rec.lastActive) || num(rec.at)) - num(rec.at)),
    project: rec.project || '', projects: rec.project ? [rec.project] : [], member: rec.member || '', members: rec.member ? [rec.member] : [],
    tokens: num(rec.tokens), usd: num(rec.usd), studio: rec.studio === true,
  };
}
/** cardOf(order | session): a request ({ id, tasks: [ids] }) with ctx { tasks, meta }, or a stored chat record. */
function cardOf(x, ctx = {}) {
  if (!isObj(x)) return null;
  if (Array.isArray(x.tasks)) return orderCard(x, Array.isArray(ctx.tasks) ? ctx.tasks : [], isObj(ctx.meta) ? ctx.meta : {});
  if (isStr(x.sessionId)) return chatCard(x);
  return null;
}

// ---------- the store (board-cards.json) ----------
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const emptyStore = () => ({ v: 1, chats: [], orders: {}, taskSids: [], reqs: [] });
/** A stored record, cleaned (anything unknown or broken is dropped). */
function cleanChat(c) {
  if (!isObj(c) || !isStr(c.sessionId) || !SID_RE.test(c.sessionId)) return null;
  return {
    id: `c:${c.sessionId}`, sessionId: c.sessionId, projectId: line(c.projectId, 128), ptyId: line(c.ptyId, 140), project: line(c.project, 64),
    member: line(c.member, 40), title: line(c.title, TITLE_MAX), type: typeOf(c.type) || 'feature', typeBy: c.typeBy === 'person' ? 'person' : 'auto',
    column: COLUMNS.includes(c.column) && c.column !== 'done' ? c.column : 'review', at: num(c.at), lastActive: num(c.lastActive) || num(c.at),
    reviewSince: num(c.reviewSince), closedAt: num(c.closedAt), ...(num(c.closedAt) ? { closedBy: c.closedBy === 'auto' ? 'auto' : 'person' } : {}),
    tokens: num(c.tokens), usd: num(c.usd), ...(c.studio === true ? { studio: true } : {}),
  };
}
function loadStore(raw) {
  const s = isObj(raw) ? raw : {};
  const seen = new Set();
  const chats = (Array.isArray(s.chats) ? s.chats : []).map(cleanChat).filter((c) => c && !seen.has(c.id) && seen.add(c.id));
  const orders = {};
  for (const [k, v] of Object.entries(isObj(s.orders) ? s.orders : {})) {
    if (!ORDER_ID_RE.test(k) || !isObj(v)) continue;
    const usage = OT.cleanUsage(v.usage);
    const o = { ...(typeOf(v.type) ? { type: typeOf(v.type) } : {}), ...(num(v.doneAt) ? { doneAt: num(v.doneAt) } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
    if (Object.keys(o).length) orders[k] = o;
  }
  const taskSids = [...new Set((Array.isArray(s.taskSids) ? s.taskSids : []).filter((x) => isStr(x) && SID_RE.test(x)))];
  return capStore({ v: 1, chats, orders, taskSids, reqs: RQ.cleanList(s.reqs) });
}
/** Keeps the newest MAX_CLOSED closed and MAX_OPEN open chat cards, MAX_ORDER_META order entries and MAX_TASK_SIDS task sessions. */
function capStore(store) {
  const open = store.chats.filter((c) => !c.closedAt).sort((a, b) => b.lastActive - a.lastActive).slice(0, MAX_OPEN);
  const closed = store.chats.filter((c) => c.closedAt).sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_CLOSED);
  const keys = Object.keys(store.orders);
  const orders = keys.length > MAX_ORDER_META ? Object.fromEntries(keys.slice(-MAX_ORDER_META).map((k) => [k, store.orders[k]])) : store.orders;
  const sids = Array.isArray(store.taskSids) ? store.taskSids : [];
  const taskSids = sids.length > MAX_TASK_SIDS ? sids.slice(-MAX_TASK_SIDS) : sids;
  return { ...store, chats: [...open, ...closed], orders, taskSids, reqs: RQ.cap(Array.isArray(store.reqs) ? store.reqs : []) };
}

/** True when this session carried a dispatched or remote task (it is an order on the board, never a chat card). */
const isTaskSession = (store, sid) => Array.isArray(store.taskSids) && store.taskSids.includes(sid);
/** Remembers a task session (newest last, capped). → the store (same object if already known or invalid). */
/** A chat card the session already had is dropped: the conversation is now part of the order. */
function markTaskSession(store, sid) {
  if (!isStr(sid) || !SID_RE.test(sid) || isTaskSession(store, sid)) return store;
  return capStore({ ...store, chats: store.chats.filter((c) => c.sessionId !== sid), taskSids: [...(store.taskSids || []), sid] });
}
/** Open chat cards whose tab is gone (ptyId not in `live`, e.g. the tab was closed or the app quit) move to Review and
 *  start their Review clock, so they never stay working or needs-you. → the store (same object if nothing changed). */
function detachGone(store, live, now = Date.now()) {
  const has = (id) => (live instanceof Set ? live.has(id) : Array.isArray(live) && live.includes(id));
  let changed = false;
  const chats = store.chats.map((c) => {
    if (c.closedAt || has(c.ptyId) || (c.column === 'review' && c.reviewSince)) return c;
    changed = true;
    return { ...c, column: 'review', reviewSince: c.reviewSince || now };
  });
  return changed ? { ...store, chats } : store;
}

/**
 * One look at a project session (from tab state): creates its card on the first person prompt, then follows its state.
 * info: { sessionId, projectId, ptyId, project, member, title, prompt, busy, waiting, tokens?, usd?, studio? }.
 * A closed card opens again when its session works again (one card per conversation). → the store (same object if
 * nothing changed).
 */
function touchSession(store, info, now = Date.now(), { redact = (/** @type {string} */ x) => x } = {}) {
  if (!isObj(info) || !isStr(info.sessionId) || !SID_RE.test(info.sessionId)) return store;
  const id = `c:${info.sessionId}`;
  const cur = store.chats.find((c) => c.id === id);
  // a title is redacted (secrets) before it is cut, so a secret is never cut into a fragment the patterns miss
  const title = line(redact(String(info.title || info.prompt || '').slice(0, TITLE_INPUT_MAX)), TITLE_MAX);
  const column = chatColumn(info);
  if (!cur) {
    if (!line(info.prompt, 1) && !info.busy) return store;   // no person prompt yet
    const rec = cleanChat({ ...info, title, type: classify(`${info.title || ''} ${info.prompt || ''}`).type, column, at: now, lastActive: now, reviewSince: column === 'review' ? now : 0 });
    return rec ? capStore({ ...store, chats: [rec, ...store.chats] }) : store;
  }
  const next = { ...cur };
  if (title) next.title = title;
  if (info.project) next.project = line(info.project, 64);
  if (isStr(info.ptyId) && info.ptyId) next.ptyId = line(info.ptyId, 140);
  if (num(info.tokens) > next.tokens) next.tokens = num(info.tokens);
  if (num(info.usd) > next.usd) next.usd = num(info.usd);
  if (next.closedAt) {
    if (!info.busy && !info.waiting) return same(cur, next) ? store : replace(store, next);
    next.closedAt = 0; delete next.closedBy;   // the conversation goes on: the card opens again
  }
  next.column = column;
  if (column !== 'review') { next.lastActive = now; next.reviewSince = 0; } else if (!next.reviewSince) next.reviewSince = now;
  if (cur.typeBy !== 'person' && title && title !== cur.title) next.type = classify(`${title} ${info.prompt || ''}`).type;
  return same(cur, next) ? store : replace(store, next);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const replace = (store, rec) => ({ ...store, chats: store.chats.map((c) => (c.id === rec.id ? rec : c)) });

/** Chat cards idle in Review for `ms` close by themselves. */
function autoClose(store, now = Date.now(), ms = REVIEW_CLOSE_MS) {
  let changed = false;
  const chats = store.chats.map((c) => {
    if (c.closedAt || c.column !== 'review' || !c.reviewSince || now - c.reviewSince < ms) return c;
    changed = true;
    return { ...c, closedAt: now, closedBy: 'auto' };
  });
  return changed ? capStore({ ...store, chats }) : store;
}
/** The card id is valid: 'c:<session uuid>' or 'o:<request id>'. */
const validCardId = (id) => isStr(id) && (/^c:/.test(id) ? SID_RE.test(id.slice(2)) : /^o:/.test(id) ? ORDER_ID_RE.test(id.slice(2)) : RQ.validId(id));
/** The person marks a card done. → { store, ok } */
function markDone(store, id, now = Date.now()) {
  if (!validCardId(id)) return { store, ok: false };
  if (id.startsWith('o:')) {
    const k = id.slice(2);
    return { store: capStore({ ...store, orders: { ...store.orders, [k]: { ...(store.orders[k] || {}), doneAt: now } } }), ok: true };
  }
  if (id.startsWith('q:')) {
    const r = (store.reqs || []).find((x) => `q:${x.id}` === id);
    if (!r) return { store, ok: false };
    if (!RQ.isOpen(r)) return { store, ok: true };
    return { store: capStore({ ...store, reqs: store.reqs.map((x) => (x === r ? { ...r, state: 'done', endedAt: now } : x)) }), ok: true };
  }
  const c = store.chats.find((x) => x.id === id);
  if (!c) return { store, ok: false };
  if (c.closedAt) return { store, ok: true };
  return { store: capStore(replace(store, { ...c, closedAt: now, closedBy: 'person' })), ok: true };
}
/** The person sets a card's type. → { store, ok } */
function setType(store, id, type) {
  const t = typeOf(type);
  if (!t || !validCardId(id)) return { store, ok: false };
  if (id.startsWith('o:')) {
    const k = id.slice(2);
    return { store: capStore({ ...store, orders: { ...store.orders, [k]: { ...(store.orders[k] || {}), type: t } } }), ok: true };
  }
  if (id.startsWith('q:')) {
    const r = (store.reqs || []).find((x) => `q:${x.id}` === id);
    return r ? { store: { ...store, reqs: store.reqs.map((x) => (x === r ? { ...r, type: t, typeBy: 'person' } : x)) }, ok: true } : { store, ok: false };
  }
  const c = store.chats.find((x) => x.id === id);
  if (!c) return { store, ok: false };
  return { store: replace(store, { ...c, type: t, typeBy: 'person' }), ok: true };
}

/** Every card (orders from the HQ board, chats from the store), sorted, with the columns. */
function boardCards(board, store) {
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  const orders = (Array.isArray(board?.requests) ? board.requests : []).map((r) => orderCard(r, tasks, store.orders[r.id] || {}));
  const reqs = Array.isArray(store.reqs) ? store.reqs : [];
  const typedSids = new Set(reqs.map((r) => r.sessionId).filter(Boolean));   // a session with request cards has no card of its own
  const cards = sortCards([...orders, ...store.chats.filter((c) => !typedSids.has(c.sessionId)).map(chatCard), ...reqs.map(RQ.card)]);
  return { columns: COLUMNS.map((id) => ({ id, cards: cards.filter((c) => c.column === id).map((c) => c.id) })), cards };
}

/** Closed cards within [from, to] grouped by project | type | member: counts, duration and token cost. */
function report(cards, { from = 0, to = Infinity, groupBy = 'project' } = {}) {
  const g = GROUPS.includes(groupBy) ? groupBy : 'project';
  const rows = new Map();
  const total = { count: 0, durationMs: 0, tokens: 0, usd: 0 };
  for (const c of cards) {
    if (c.column !== 'done' || !num(c.closedAt) || c.closedAt < from || c.closedAt > to) continue;
    const keys = g === 'type' ? [c.type] : g === 'member' ? (c.members?.length ? c.members : ['']) : (c.projects?.length ? c.projects : ['']);
    for (const key of keys) {
      const r = rows.get(key) || { key, count: 0, durationMs: 0, tokens: 0, usd: 0, orders: 0, chats: 0 };
      r.count++; r.durationMs += num(c.durationMs); r.tokens += num(c.tokens); r.usd += num(c.usd);
      if (c.kind === 'order') r.orders++; else r.chats++;
      rows.set(key, r);
    }
    total.count++; total.durationMs += num(c.durationMs); total.tokens += num(c.tokens); total.usd += num(c.usd);
  }
  const list = [...rows.values()].map((r) => ({ ...r, usd: Math.round(r.usd * 100) / 100 }));
  list.sort(g === 'type' ? (a, b) => rankOf(a.key) - rankOf(b.key) : (a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { groupBy: g, from, to: Number.isFinite(to) ? to : 0, rows: list, total: { ...total, usd: Math.round(total.usd * 100) / 100 } };
}

/** v3.135 one usage sample of an order's task (OT.observe) stored under orders[request].usage; the store unchanged when nothing moved. */
function sampleUsage(store, request, taskId, sample, opts = {}) {
  if (!isStr(request) || !ORDER_ID_RE.test(request) || !isStr(taskId)) return store;
  const o = store.orders[request] || {};
  const usage = isObj(o.usage) ? o.usage : {};
  const next = OT.observe(usage[taskId], sample, opts);
  if (!next || JSON.stringify(next) === JSON.stringify(usage[taskId])) return store;
  return { ...store, orders: { ...store.orders, [request]: { ...o, usage: { ...usage, [taskId]: next } } } };
}

/** Token cost of one session from Claude Code's status line JSON (the app's usage files), only when it is that session. */
function tokensFromStatus(obj, sessionId) {
  if (!isObj(obj) || !isStr(sessionId) || obj.session_id !== sessionId) return null;
  const cw = isObj(obj.context_window) ? obj.context_window : {};
  const tokens = num(cw.total_input_tokens) + num(cw.total_output_tokens);
  const usd = num(isObj(obj.cost) ? obj.cost.total_cost_usd : 0);
  return tokens || usd ? { tokens, usd } : null;
}

module.exports = {
  TYPES, TYPE_RANK, COLUMNS, GROUPS, MAX_CLOSED, MAX_OPEN, MAX_TASK_SIDS, REVIEW_CLOSE_MS,
  typeOf, rankOf, classify, orderType, explicitType, agedRank, detachGone, AGE_MS, columnOf, chatColumn, compareCards, sortCards, byPriority,
  orderCard, chatCard, cardOf, emptyStore, loadStore, capStore, touchSession, autoClose, markDone, setType, validCardId, isTaskSession, markTaskSession,
  RQ, boardCards, report, tokensFromStatus, sampleUsage,
};
