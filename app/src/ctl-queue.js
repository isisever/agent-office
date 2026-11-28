'use strict';
// A phone's message that cannot be typed right now (the session is mid-turn, an approval prompt or a draft is open, a
// handoff lock is on, HQ is busy) waits here and is delivered, in order, as soon as the session takes input. It is
// never dropped silently: a message leaves the queue only when it was delivered, hit a hard refusal (onDrop is told)
// or outlived ttlMs (onDrop is told).

/**
 * @param {{ attempt: (key: string, text: string) => 'ok' | 'wait' | string, onDrop?: (key: string, text: string, reason: string) => void,
 *           now?: () => number, ttlMs?: number, max?: number }} o
 *   attempt returns 'ok' (delivered), 'wait' (not now, keep it) or a refusal reason (a hard failure).
 */
function createCtlQueue({ attempt, onDrop = () => {}, now = Date.now, ttlMs = 30 * 60 * 1000, max = 20 }) {
  const queues = new Map();   // key -> [{ text, at }]
  const pending = (key) => queues.get(key)?.length || 0;
  /** Deliver now when nothing is ahead of it, else (or when the session is not ready) queue it. 'ok' = delivered or queued. */
  function submit(key, text) {
    if (!pending(key)) {
      const r = attempt(key, text);
      if (r !== 'wait') return r;
    }
    const q = queues.get(key) || [];
    if (q.length >= max) return 'busy';   // an explicit refusal the phone sees, never a silent drop
    q.push({ text, at: now() });
    queues.set(key, q);
    return 'ok';
  }
  /** Try the waiting messages of every key (call it on a timer or on a state change); returns how many were delivered. */
  function drain() {
    let done = 0;
    for (const [key, q] of [...queues]) {
      while (q.length) {
        const m = q[0];
        if (now() - m.at > ttlMs) { q.shift(); onDrop(key, m.text, 'expired'); continue; }
        const r = attempt(key, m.text);
        if (r === 'wait') break;
        q.shift();
        if (r === 'ok') done++; else onDrop(key, m.text, r);
      }
      if (!q.length) queues.delete(key);
    }
    return done;
  }
  return { submit, drain, pending, clear: (key) => queues.delete(key) };
}

module.exports = { createCtlQueue };
