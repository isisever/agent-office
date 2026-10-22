// pty handler wiring: pure logic (no Electron; tested with node --test).
//
// Every spawned pty (user logins, the remote relay login, running tabs) registers its onData / onExit handlers right
// after spawn, and every registration goes through attachPty, so the wiring is written once:
// - the id guard: a replaced or purpose-killed pty (its map entry deleted before the kill) must not act on events
//   that race its death; the handler body only runs while its own map still holds this exact pty. With map null
//   there is no id guard (the relay facade's listeners belong to its caller, which decides for itself);
// - the quit guard from src/pty-guard.js createGuard(): guarded() delivers nothing while the app quits and logs a
//   thrown handler error instead of leaving it uncaught (microsoft/node-pty#904/#951); hold() keeps the disposables
//   node-pty returns, so the app's release(t) drops every listener of a pty before it kills it.
// The handlers themselves are the site's own work (a login check, an exit notice, resume logic) and stay there.

/**
 * Register a pty's event handlers with the shared wiring.
 * @param {Map<string, any> | null} map a site's pty map (terms / logins / relays): the id guard reads
 *   `map.get(id) === t`; null: no id guard
 * @param {string} id @param {any} t
 * @param {{ onData?: (e: any) => void, onExit?: (e: any) => void }} handlers the site's own work, one per event
 * @param {{ guarded: (f: (...a: any[]) => void) => (...a: any[]) => void, hold: (t: object, ...ds: any[]) => void }} guard
 *   the app's quit guard (src/pty-guard.js createGuard)
 * @returns {{ dispose(): void }} this call's listeners as one IDisposable. They are held as well, so release(t)
 *   drops them before a kill; only a caller that hands listeners out (the relay facade) returns it on.
 */
const attachPty = (map, id, t, { onData, onExit }, { guarded, hold }) => {
  const wrap = (/** @type {(e: any) => void} */ f) => guarded((/** @type {any} */ e) => { if (!map || map.get(id) === t) f(e); });
  /** @type {{ dispose(): void }[]} */
  const ds = [];
  if (onData) ds.push(t.onData(wrap(onData)));
  if (onExit) ds.push(t.onExit(wrap(onExit)));
  hold(t, ...ds);
  return { dispose: () => { for (const d of ds.splice(0)) { try { d.dispose(); } catch {} } } };
};

module.exports = { attachPty };
