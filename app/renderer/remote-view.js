// Read-only view of a project's session on another machine (contract v3.100): the chat view (renderer/chat.js) fed by
// the device link instead of a local transcript. Nothing is typed here: the row's command box stays the way to type.
import { mountChat } from './chat.js';

const KEEP = 400;                 // items kept (chat.js keeps as many on screen)
const KEEP_MS = 2 * 60 * 1000;    // sess-keep while the view is open (the owning machine ends it after 10 quiet minutes)
const REASONS = ['unknown-project', 'engine', 'no-session', 'rate-limited', 'limit', 'offline'];

/** @param {{ api: any, t: (k: string, v?: any) => string }} o */
export function mountRemoteView({ api, t }) {
  /** @type {any} */ let cur = null;
  const mk = (/** @type {string} */ tag, /** @type {string} */ cls) => { const e = document.createElement(tag); e.className = cls; return e; };
  const title = mk('span', 'rv-title');
  const asOf = mk('span', 'rv-asof');
  const closeBtn = mk('button', 'rv-close');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => close());
  const head = mk('div', 'rv-head');
  head.append(title, asOf, closeBtn);
  const note = mk('div', 'rv-note');
  const body = mk('div', 'rv-body');
  const el = mk('div', 'remote-view');
  el.hidden = true;
  el.append(head, note, body);
  document.body.append(el);

  const time = (/** @type {number} */ ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  /** Why nothing is shown: the peer does not share sessions with this computer (flag off, or an older app), or another reason. */
  const reasonText = (/** @type {string} */ reason, /** @type {string} */ machine) => (reason === 'not-allowed' || reason === 'no-cap'
    ? t('hq.remoteView.off', { machine })
    : t(`hq.remoteView.reason.${REASONS.includes(reason) ? reason : reason === 'removed' ? 'offline' : 'other'}`, { machine }));
  function draw() {
    if (!cur) return;
    title.textContent = `${cur.machine} · ${cur.name}`;
    asOf.textContent = cur.at ? t('hq.remoteView.asOf', { time: time(cur.at) }) : '';
    closeBtn.title = t('hq.remoteView.close');
    closeBtn.setAttribute('aria-label', t('hq.remoteView.close'));
    // an approval is answered on the machine that owns the project (answering from here is a later slice)
    const why = cur.reason ? reasonText(cur.reason, cur.machine) : cur.status === 'approval' ? t('hq.remoteView.approval', { machine: cur.machine }) : '';
    note.textContent = why;
    note.hidden = !why;
  }
  // the data source chat.js polls instead of chat:read: the items received so far, by position
  const source = {
    read: async (/** @type {any} */ cursor) => {
      const c = cur;
      if (!c) return { sid: '', cursor: null, items: [], reset: true, more: false };
      const fresh = !cursor || cursor.epoch !== c.epoch || cursor.n < c.base;
      return { sid: c.key, cursor: { epoch: c.epoch, n: c.base + c.items.length }, items: c.items.slice(fresh ? 0 : cursor.n - c.base), reset: fresh, more: false };
    },
  };
  function take(/** @type {any} */ m) {
    if (!cur || m.id !== cur.id) return;
    if (m.end) { cur.reason = String(m.reason || 'other'); cur.id = ''; draw(); return; }
    if (m.reset) { cur.items = []; cur.base = 0; cur.epoch++; }
    cur.items.push(...(Array.isArray(m.items) ? m.items : []));
    if (cur.items.length > KEEP) { cur.base += cur.items.length - KEEP; cur.items = cur.items.slice(-KEEP); }
    cur.at = Date.now();
    draw();
  }
  api.link.onSess?.((/** @type {any} */ m) => {
    if (cur && !cur.id && !cur.reason) cur.early.push(m);   // before sessOpen answered with the id
    else take(m);
  });

  function close() {
    if (!cur) return;
    window.clearInterval(cur.keep);
    if (cur.id) api.link.sessClose(cur.id).catch(() => {});
    cur.chat.destroy();
    cur = null;
    el.hidden = true;
  }
  /** @param {{ key: string, pub: string, project: string, name: string, machine: string, status: string }} o */
  function open(o) {
    close();
    const host = mk('div', 'chat-host');
    body.append(host);
    const mine = { ...o, id: '', reason: '', epoch: 1, base: 0, items: [], early: [], at: 0, keep: 0, chat: /** @type {any} */ (null) };
    cur = mine;
    mine.chat = mountChat(host, { ptyId: '', onTerminal: () => {}, screen: () => [], source });
    mine.chat.show();
    mine.keep = window.setInterval(() => { if (mine.id) api.link.sessKeep(mine.id).catch(() => {}); }, KEEP_MS);
    el.hidden = false;
    draw();
    api.link.sessOpen(o.pub, o.project).then((/** @type {any} */ r) => {
      if (cur !== mine) { if (r?.ok) api.link.sessClose(r.id).catch(() => {}); return; }
      if (!r?.ok) { mine.reason = String(r?.reason || 'offline'); draw(); return; }
      mine.id = r.id;
      for (const m of mine.early.splice(0)) take(m);
    }).catch(() => { if (cur === mine) { mine.reason = 'offline'; draw(); } });
  }
  return {
    open, close,
    isOpen: (/** @type {string} */ key) => Boolean(cur && cur.key === key),
    /** The row's live status ('approval' shows where it is answered). */
    update(/** @type {string} */ status) { if (cur && cur.status !== status) { cur.status = status; draw(); } },
  };
}
