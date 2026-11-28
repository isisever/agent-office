'use strict';
// v3.159 requests typed in project chats: pure model (no Electron, no fs). One card per user request typed into a
// project chat (Studio GUI chat or a terminal tab's composer); HQ's own chat and dispatched tasks never get one.
// Records live in board-cards.json (`reqs`), next to the chat cards and order choices; board-model merges them in.

const MAX_REQS = 200;                       // records kept (open first, then the newest closed)
const KEEP_DONE_MS = 14 * 24 * 60 * 60 * 1000;   // a finished request older than this is dropped
const GRACE_MS = 20 * 1000;                 // a turn not seen busy this long after the send is taken as finished
const TITLE_MAX = 80;
const STATES = Object.freeze(['running', 'waiting', 'done', 'failed']);
// Why a request closed as failed (never silently as done): its turn never started, its tab or the app went away
// mid-work, or a newer request replaced it before it ran.
const FAIL_REASONS = Object.freeze(['never-started', 'interrupted', 'superseded']);
const ID_RE = /^q[0-9a-f]{6,24}$/;

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
// eslint-disable-next-line no-control-regex -- control characters are stripped on purpose
const line = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The card title of a request: its first non-empty line, trimmed (redacted by the caller's function first). */
function titleOf(text, redact = (/** @type {string} */ x) => x) {
  const first = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return line(redact(first.slice(0, 4000)), TITLE_MAX);
}
/** A stored record, cleaned (anything unknown or broken is dropped). */
function clean(r) {
  if (!isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const state = STATES.includes(r.state) ? r.state : 'done';
  const closed = state === 'done' || state === 'failed';
  return { id: r.id, projectId: line(r.projectId, 128), ptyId: line(r.ptyId, 140), project: line(r.project, 64), account: line(r.account, 64),
    sessionId: line(r.sessionId, 40), title: line(r.title, TITLE_MAX), type: ['bugfix', 'hotfix', 'feature'].includes(r.type) ? r.type : 'feature',
    typeBy: r.typeBy === 'person' ? 'person' : 'auto', state, at: num(r.at), endedAt: closed ? num(r.endedAt) || num(r.at) : 0,
    busySeen: r.busySeen === true, ...(closed && state === 'failed' && FAIL_REASONS.includes(r.reason) ? { reason: r.reason } : {}) };
}
const cleanList = (/** @type {any} */ list) => cap((Array.isArray(list) ? list : []).map(clean).filter(Boolean));
const isOpen = (/** @type {any} */ r) => r.state === 'running' || r.state === 'waiting';

/** Keeps open records, drops old finished ones and keeps at most MAX_REQS (newest first among the closed). */
function cap(list, now = Date.now()) {
  const open = list.filter(isOpen);
  const closed = list.filter((r) => !isOpen(r) && now - (r.endedAt || r.at) < KEEP_DONE_MS).sort((a, b) => (b.endedAt || b.at) - (a.endedAt || a.at));
  return [...open, ...closed].slice(0, MAX_REQS);
}
/** A request was typed: a new running record; older open ones of the same tab are finished (their turn is over). */
function add(list, rec, now = Date.now()) {
  // Only a turn that really ran (seen busy, not waiting on the person) counts as done; the rest did not get its work.
  const old = list.map((r) => {
    if (!isOpen(r) || r.ptyId !== rec.ptyId) return r;
    return r.busySeen && r.state === 'running' ? { ...r, state: 'done', endedAt: now } : { ...r, state: 'failed', reason: 'superseded', endedAt: now };
  });
  const c = clean({ ...rec, state: 'running', at: now });
  return c ? cap([...old, c], now) : list;
}
/** The live state of a tab (busy, waiting, failed) moves its open records. → the list (same array when nothing changed). */
function observe(list, ptyId, live, now = Date.now()) {
  let changed = false;
  const out = list.map((r) => {
    if (!isOpen(r) || r.ptyId !== ptyId) return r;
    let n = r;
    if (live.failed) n = { ...r, state: 'failed', endedAt: now };
    else if (live.waiting) n = { ...r, state: 'waiting', busySeen: true };
    else if (live.busy) n = { ...r, state: 'running', busySeen: true };
    else if (r.busySeen) n = { ...r, state: 'done', endedAt: now };
    else if (now - r.at >= GRACE_MS) n = { ...r, state: 'failed', reason: 'never-started', endedAt: now };
    if (n !== r && JSON.stringify(n) !== JSON.stringify(r)) { changed = true; return n; }
    return r;
  });
  return changed ? cap(out, now) : list;
}
/** Open records whose tab is gone are interrupted, not done: the work was cut off (tab closed or app quit). */
function detachGone(list, live, now = Date.now()) {
  const gone = list.some((r) => isOpen(r) && !live.has(r.ptyId));
  return gone ? cap(list.map((r) => (isOpen(r) && !live.has(r.ptyId) ? { ...r, state: 'failed', reason: 'interrupted', endedAt: now } : r)), now) : list;
}
/** The session a tab's open records belong to, once known (a new chat learns its session id after the first turn). */
function bindSession(list, ptyId, sid) {
  if (!sid || !list.some((r) => isOpen(r) && r.ptyId === ptyId && !r.sessionId)) return list;
  return list.map((r) => (isOpen(r) && r.ptyId === ptyId && !r.sessionId ? { ...r, sessionId: line(sid, 40) } : r));
}
const COLUMN = Object.freeze({ running: 'working', waiting: 'needs-you', failed: 'needs-you', done: 'done' });
/** The board card of a record: the shape of a chat card (the board opens it as a chat) with `typed` and `state`. */
function card(r) {
  return { id: `q:${r.id}`, kind: 'chat', typed: true, state: r.state, sessionId: r.sessionId, projectId: r.projectId, ptyId: r.ptyId,
    title: r.title, type: r.type, typeBy: r.typeBy, column: COLUMN[r.state], at: r.at, closedAt: isOpen(r) ? 0 : r.endedAt,
    ...(isOpen(r) ? {} : { closedBy: 'auto' }), ...(r.reason ? { reason: r.reason } : {}), durationMs: Math.max(0, (isOpen(r) ? 0 : r.endedAt) - r.at), project: r.project, projects: r.project ? [r.project] : [],
    account: r.account, member: '', members: [], tokens: 0, usd: 0, studio: true };
}
/** A compact list for HQ's board tool: what the person asked in each project and how far it is. */
function summary(list, limit = 30) {
  return [...list].sort((a, b) => b.at - a.at).slice(0, limit).map((r) => ({ id: r.id, project: r.project, account: r.account, title: r.title, state: r.state, type: r.type, at: r.at, ...(r.endedAt ? { endedAt: r.endedAt } : {}) }));
}
const validId = (/** @type {any} */ id) => typeof id === 'string' && id.startsWith('q:') && ID_RE.test(id.slice(2));
module.exports = { MAX_REQS, KEEP_DONE_MS, GRACE_MS, STATES, titleOf, clean, cleanList, cap, add, observe, bindSession, detachGone, card, summary, validId, isOpen };
