// pty handler wiring: pure logic (no Electron; tested with node --test).
//
// Every spawned pty (user logins, the remote relay login, running tabs) registers its onData / onExit handlers right
// after spawn. The wiring around each registration is the same, and it is the wiring fixes must not miss:
// - the id guard: a replaced or purpose-killed pty (its map entry deleted before the kill) must not act on events
//   that race its death — the handler body only runs while its own map still holds this exact pty;
// - the quitting flag: while the app is quitting, no event does anything any more (the exit callbacks of the killed
//   ptys can still fire); the ignore() hook is the app's `quitting` read;
// - a thrown error inside a callback is logged, never left for the caller (an uncaught throw surface in a dying
//   environment is what turns into the SIGABRT on quit, microsoft/node-pty#904/#951);
// - each registration returns a disposable; simply drop a pty's handlers before you kill it.
// The handlers themselves are the site's own work (a login check, an exit notice, resume logic) and stay there.

/**
 * Register (and wrap) a pty's event handlers with the shared wiring.
 * @template V
 * @param {Map<string, V>} map a site's pty map (terms / logins / relays): the id guard reads `map.get(id) === t`
 * @param {string} id @param {any} t
 * @param {{ onData?: (e: any) => void, onExit?: (e: any) => void }} handlers the site's own work, one per event
 * @param {{ ignore?: () => boolean, log?: (msg: string, err: string) => void }} [opts] ignore: the app's quitting
 *   read; log: where a thrown handler's message goes (the app's console.error by default)
 * @returns {() => void} dispose: drop every listener this call registered; safe however many times it runs
 */
const attachPty = (map, id, t, { onData, onExit }, { ignore = () => false, log = console.error } = {}) => {
  const wrap = (f) => (...a) => {
    if (ignore() || map.get(id) !== t) return;
    try { f(...a); } catch (e) { log('pty handler:', e.message); }
  };
  const d = [];
  if (onData) d.push(t.onData(wrap(onData)));
  if (onExit) d.push(t.onExit(wrap(onExit)));
  return () => { for (const x of d) x.dispose(); };
};

module.exports = { attachPty };
