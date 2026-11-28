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
  if (typeof r === 'object') return r.ok !== false && !r.error && !r.reason;
  return false;
}
