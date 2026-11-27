// Orders from HQ (contract v3.130). A request the person typed in HQ is an ORDER: it keeps its typed authority until
// it is closed (office_summary) or ORDER_MS passed, its excess tasks wait in an order queue instead of being refused,
// one blocked stage per order is continued by HQ itself, and the person gets one notice when it starts and one when
// it ends or needs them. Pure helpers plus a small sealed store (HMAC over the whole body with a key the app keeps
// encrypted by the OS): a tampered or unknown store reads as empty, so every check falls back to today's rules.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ORDER_MS = 24 * 3600 * 1000;    // hard ceiling of an order's typed authority
const ORDER_QUEUE_MAX = 50;           // queued tasks per order
const AUTO_CONTINUE_MAX = 1;          // blocked stages HQ continues on its own per order
// a stage blocked by how the stage before it ended, where retrying is the order's own business. Never: a declined or
// refused stage (after-rejected), one the person closed or typed into, one blocked behind another block.
const AUTO_REASONS = new Set(['after-partial', 'after-failed', 'after-expired', 'after-lost']);
const NOTICES = ['start', 'needs', 'end'];

const isStr = (x) => typeof x === 'string' && x.length > 0;
const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** Is this order record still authoritative? Not closed and younger than ORDER_MS. */
const orderOpen = (o, now = Date.now()) => isObj(o) && !o.closed && Number.isFinite(o.at) && now - o.at >= 0 && now - o.at < ORDER_MS;

const hmac = (key, body) => crypto.createHmac('sha256', key).update(body).digest('hex');
/** The store body sealed with the key. */
function seal(key, data) { const body = JSON.stringify(data); return { v: 1, body, mac: hmac(key, body) }; }
/** The sealed body, or null when the key is missing, the MAC does not match or the record is malformed. */
function unseal(key, raw) {
  if (!key || !isObj(raw) || raw.v !== 1 || typeof raw.body !== 'string' || typeof raw.mac !== 'string') return null;
  const want = Buffer.from(hmac(key, raw.body), 'hex');
  const got = Buffer.from(raw.mac, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const d = JSON.parse(raw.body); return isObj(d) ? d : null; } catch { return null; }
}

/** Queue release order: higher priority first, then first in, first out. */
const releaseOrder = (queue) => [...(Array.isArray(queue) ? queue : [])].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || a.seq - b.seq);
/** How many queued items are released before this one. -1 when it is not queued. */
function aheadOf(queue, id) { const i = releaseOrder(queue).findIndex((x) => x.id === id); return i; }
/** The next item to release: the first in release order that `canRun(item)` allows, else null. */
function nextRelease(queue, canRun) { for (const x of releaseOrder(queue)) if (canRun(x)) return x; return null; }
/** Room in an order's queue? → null or 'order-queue-full'. */
const queueRefusal = (queue, request) => ((Array.isArray(queue) ? queue : []).filter((x) => x.request === request).length >= ORDER_QUEUE_MAX ? 'order-queue-full' : null);

/** May HQ continue this blocked stage itself? Once per open order, only for an AUTO_REASONS block, never with
 *  `askBeforeDispatch` on. `used`: how many stages the order already continued on its own. */
function mayAutoContinue({ task, open, used = 0, ask = false }) {
  return !ask && open === true && isObj(task) && task.status === 'blocked' && isStr(task.after) && AUTO_REASONS.has(task.reason) && task.autoContinued !== true && used < AUTO_CONTINUE_MAX;
}

const emptyData = () => ({ orders: {}, stages: {}, queue: [], seq: 0 });
function clean(d, now) {
  const out = emptyData();
  if (!isObj(d)) return out;
  for (const [id, o] of Object.entries(isObj(d.orders) ? d.orders : {})) if (isObj(o) && Number.isFinite(o.at) && now - o.at < 2 * ORDER_MS) out.orders[id] = o;
  for (const [id, g] of Object.entries(isObj(d.stages) ? d.stages : {})) if (isStr(g)) out.stages[id] = g;
  out.queue = (Array.isArray(d.queue) ? d.queue : []).filter((x) => isObj(x) && isStr(x.id) && isStr(x.request) && isObj(x.args) && Number.isFinite(x.seq) && orderOpen(out.orders[x.request], now));
  out.seq = Number.isFinite(d.seq) ? d.seq : 0;
  return out;
}

/**
 * The order store (userData/hq/orders.json, 0600). `key`: a Buffer/string, or null (then nothing is read or kept
 * across a restart: memory only). Every change is written sealed at once.
 */
function createOrderStore({ file, key, now = Date.now }) {
  let d = emptyData();
  if (key && file) { try { d = clean(unseal(key, JSON.parse(fs.readFileSync(file, 'utf8'))), now()); } catch { d = emptyData(); } }
  const save = () => {
    if (!key || !file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(seal(key, d)), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { console.error('hq orders:', e.message); }
  };
  const order = (id) => (isStr(id) ? d.orders[id] : undefined);
  return {
    /** the open orders, for the minter after a restart */
    open() { return Object.entries(d.orders).filter(([, o]) => orderOpen(o, now())).map(([id, o]) => ({ id, at: o.at })); },
    add(id, at = now()) { if (!isStr(id) || d.orders[id]) return; d.orders[id] = { at, closed: false, noticed: [], auto: 0 }; save(); },
    isOpen(id) { return orderOpen(order(id), now()); },
    /** closes the order: its queued tasks are dropped (→ their ids) */
    close(id) {
      const o = order(id);
      if (!o || o.closed) return [];
      o.closed = true;
      const gone = d.queue.filter((x) => x.request === id).map((x) => x.id);
      d.queue = d.queue.filter((x) => x.request !== id);
      save();
      return gone;
    },
    /** one notice of each kind per order → true the first time */
    noticeOnce(id, kind) {
      const o = order(id);
      if (!o || !NOTICES.includes(kind) || (o.noticed || []).includes(kind)) return false;
      o.noticed = [...(o.noticed || []), kind];
      save();
      return true;
    },
    autoUsed(id) { return Number(order(id)?.auto) || 0; },
    takeAuto(id) { const o = order(id); if (!o) return; o.auto = (Number(o.auto) || 0) + 1; save(); },
    /** a waiting stage's accepted digest (CH.stageDigest), for its release after a restart */
    stage(id, digest) { if (!isStr(id) || !isStr(digest)) return; d.stages[id] = digest; save(); },
    stageOk(id, digest) { return isStr(id) && isStr(digest) && d.stages[id] === digest; },
    dropStage(id) { if (d.stages[id] === undefined) return; delete d.stages[id]; save(); },
    queue() { return d.queue.slice(); },
    /** → { ok, item } | { ok: false, reason } */
    enqueue({ id, request, args, priority = 0, typed = false, seq = undefined }) {
      if (!isStr(id) || !isStr(request) || !isObj(args)) return { ok: false, reason: 'bad-request' };
      const have = d.queue.find((x) => x.id === id);
      if (have) return { ok: true, item: have };
      const why = queueRefusal(d.queue, request);
      if (why) return { ok: false, reason: why };
      const item = { id, request, args, priority: Number(priority) || 0, typed: typed === true, seq: Number.isFinite(seq) ? Number(seq) : ++d.seq, at: now() };
      d.queue.push(item);
      save();
      return { ok: true, item };
    },
    remove(id) { const n = d.queue.length; d.queue = d.queue.filter((x) => x.id !== id); if (d.queue.length !== n) save(); },
    ahead(id) { return aheadOf(d.queue, id); },
  };
}

/** The key that seals the store: 32 random bytes kept in `file` encrypted with Electron's safeStorage. Without OS
 *  encryption: a key for this run only (the store is then never trusted after a restart: today's dialog). */
function orderKey(file, safeStorage) {
  try {
    if (!safeStorage?.isEncryptionAvailable?.()) return crypto.randomBytes(32);
    try { const k = safeStorage.decryptString(fs.readFileSync(file)); if (/^[0-9a-f]{64}$/.test(k)) return Buffer.from(k, 'hex'); } catch {}
    const k = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, safeStorage.encryptString(k), { mode: 0o600 });
    return Buffer.from(k, 'hex');
  } catch { return crypto.randomBytes(32); }
}

module.exports = { ORDER_MS, ORDER_QUEUE_MAX, AUTO_CONTINUE_MAX, AUTO_REASONS, orderOpen, seal, unseal, releaseOrder, aheadOf, nextRelease, queueRefusal, mayAutoContinue, createOrderStore, orderKey };
