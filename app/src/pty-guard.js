// Quit-time safety for node-pty callbacks: pure helpers (no Electron; tested with node --test).
//
// node-pty's exit ThreadSafeFunction can still deliver onData/onExit after a pty was killed, while the app quits and
// the Node environment tears down (microsoft/node-pty#904/#951). main wraps every pty callback in guarded(), keeps
// the disposables that onData/onExit return (node-pty's public IDisposable API) with hold(), and disposes them with
// release() before the kill. will-quit then waits (capped) for the killed pids to be reaped with waitGone().

/**
 * @param {() => boolean} isQuitting
 */
function createGuard(isQuitting) {
  /** @type {WeakMap<object, { dispose(): void }[]>} */
  const subs = new WeakMap();
  return {
    /**
     * The one wrapper for every pty callback: delivers nothing while quitting, and a throw inside it is logged
     * instead of becoming an uncaught one (an uncaught throw in a dying environment is what aborts the process).
     * @template {any[]} A
     * @param {(...a: A) => void} f
     * @returns {(...a: A) => void}
     */
    guarded(f) {
      return (...a) => {
        if (isQuitting()) return;
        try { f(...a); } catch (e) { console.error('pty callback:', e instanceof Error ? e.message : e); }
      };
    },
    /** Keeps the disposables of a pty's listeners (what t.onData/t.onExit return). */
    hold(/** @type {object} */ t, /** @type {({ dispose(): void } | undefined)[]} */ ...ds) {
      const list = subs.get(t) || [];
      for (const d of ds) if (d && typeof d.dispose === 'function') list.push(d);
      subs.set(t, list);
    },
    /** Disposes every held listener of a pty, once: nothing is left to fire from it. */
    release(/** @type {object} */ t) {
      const list = subs.get(t);
      subs.delete(t);
      for (const d of list || []) { try { d.dispose(); } catch {} }
    },
  };
}

/** True while the pid still exists (signal 0 only checks). EPERM means it exists but is not ours. */
function alive(/** @type {number} */ pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e)?.code === 'EPERM'; }
}

/**
 * Waits until every pid is gone (reaped: its node-pty exit thread has run) or timeoutMs passed. Empties `pids`
 * of the ones gone. Resolves true when all are gone.
 * @param {number[]} pids
 * @param {{ timeoutMs?: number, stepMs?: number, isAlive?: (pid: number) => boolean }} [o]
 */
async function waitGone(pids, { timeoutMs = 1000, stepMs = 20, isAlive = alive } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    for (let i = pids.length - 1; i >= 0; i--) if (!isAlive(pids[i])) pids.splice(i, 1);
    if (!pids.length) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

module.exports = { createGuard, waitGone, alive };
