// Studio experience (contract v3.158): a remote project's session opens in the main chat. Pure logic only;
// renderer/remote-view.js (inline mode) and renderer/chat.js use it. What cannot work on another machine (attachments,
// "!" commands, pickers, slash menus, the terminal) is not offered; the composer stays a plain text box that goes through
// the device link's `send`.

/**
 * What the chat shows for a remote session.
 * @param {{ canSend?: boolean, online?: boolean, reason?: string, status?: string }} o
 * @returns {{ composer: boolean, noteKey: string }} noteKey is a `studio.remote.*` locale key ('' = no note)
 */
export function remoteChatMode(o = {}) {
  const online = Boolean(o.online);
  if (!online) return { composer: false, noteKey: 'studio.remote.offlineReadOnly' };
  if (o.reason) return { composer: false, noteKey: '' };   // the session view's own reason note explains it
  if (!o.canSend) return { composer: false, noteKey: 'studio.remote.readOnly' };
  return { composer: true, noteKey: '' };
}

/**
 * Keep the last items of a remote session per row key, so an offline machine still shows its last known content.
 * @param {Map<string, { items: any[], at: number }>} store
 * @param {string} key @param {any[]} items @param {number} at @param {number} [cap]
 */
export function rememberItems(store, key, items, at, cap = 400) {
  if (!key || !Array.isArray(items) || !items.length) return;
  store.set(key, { items: items.slice(-cap), at: Number.isFinite(at) ? at : 0 });
  while (store.size > 20) store.delete(/** @type {string} */ (store.keys().next().value));   // oldest first
}

/** @param {Map<string, { items: any[], at: number }>} store @param {string} key */
export function lastKnown(store, key) {
  const e = store.get(key);
  return e ? { items: e.items.slice(), at: e.at } : null;
}

/** The outcome of `api.link.send`: anything but a clear success is a failure the composer reports. @param {any} r */
export function sendOk(r) {
  if (r === undefined || r === null || r === true || r === 'ok') return true;
  if (typeof r === 'object') {
    // link:send answers with the whole link view; the newest outgoing record is this command
    if (Array.isArray(r.outgoing)) return !r.error && r.outgoing[0]?.status === 'sent';
    return r.ok !== false && !r.error && !r.reason;
  }
  return false;
}

/**
 * The arguments for opening a remote row's session in the main chat, from a remote group (src/studio-remote.mjs).
 * Null when the row cannot be shown at all (no key/pub, or an online machine whose project is not a Claude project).
 * An offline machine still opens (last known content, read-only).
 * @param {any} g
 */
export function remoteOpenArgs(g) {
  if (!g || typeof g.key !== 'string' || !g.key || typeof g.pub !== 'string' || !g.pub) return null;
  if (!(g.canView || g.dim)) return null;
  return { key: g.key, pub: g.pub, project: g.projectId, name: g.name, machine: g.machine, status: g.status || 'idle', online: Boolean(g.online), canSend: Boolean(g.canSend) };
}

/** Event name: another view (HQ's board) asks Studio to open a remote session inline; Studio sets `detail.handled`. */
export const OPEN_REMOTE_EVENT = 'ao:open-remote';

/** The machine name the inline header's "remote" badge shows ('' = no badge). @param {any} o */
export function remoteBadgeMachine(o) {
  const m = o && typeof o.machine === 'string' ? o.machine.replace(/\s+/g, ' ').trim() : '';
  return m.slice(0, 60);
}

/** Whether Studio takes an open-remote request: only while Studio mode is on, with arguments, and not already handled. @param {any} detail @param {boolean} studioOn */
export function acceptOpenRemote(detail, studioOn) {
  return Boolean(studioOn && detail && detail.args && !detail.handled);
}
