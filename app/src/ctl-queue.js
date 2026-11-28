'use strict';
// A phone's message that cannot be typed right now (the session is mid-turn, an approval prompt or a draft is open, a
// handoff lock is on, HQ is busy) waits here and is delivered, in order, as soon as the session takes input. It is
// never dropped silently: a message leaves the queue only when it was delivered, hit a hard refusal (onDrop is told)
// or outlived ttlMs (onDrop is told). The queue is in memory only: an app restart loses what was waiting.

/**
 * @param {{ attempt: (key: string, text: string, meta?: any) => 'ok' | 'wait' | string, onDrop?: (key: string, text: string, reason: string, meta?: any) => void,
 *           precheck?: (key: string, text: string) => string | null | undefined,
 *           now?: () => number, ttlMs?: number, max?: number }} o
 *   precheck returns a hard refusal reason (e.g. HQ is off) or nothing; it runs before a message is queued behind others.
 *   meta is an opaque value stored with the message and handed back to attempt and onDrop (the phone link that sent it).
 *   attempt returns 'ok' (delivered), 'wait' (not now, keep it) or a refusal reason (a hard failure).
 */
function createCtlQueue({ attempt, onDrop = () => {}, precheck = () => null, now = Date.now, ttlMs = 30 * 60 * 1000, max = 20 }) {
  const queues = new Map();   // key -> [{ text, at }]
  const pending = (key) => queues.get(key)?.length || 0;
  /** Deliver now when nothing is ahead of it, else (or when the session is not ready) queue it. 'ok' = delivered or queued. */
  function submit(key, text, meta) {
    if (!pending(key)) {
      const r = attempt(key, text, meta);
      if (r !== 'wait') return r;
    } else {
      const hard = precheck(key, text);   // a hard refusal is answered at once, not queued behind others and dropped later
      if (hard) return hard;
    }
    const q = queues.get(key) || [];
    if (q.length >= max) return 'busy';   // an explicit refusal the phone sees, never a silent drop
    q.push({ text, at: now(), meta });
    queues.set(key, q);
    return 'ok';
  }
  /** Try the waiting messages of every key (call it on a timer or on a state change); returns how many were delivered. */
  function drain() {
    let done = 0;
    for (const [key, q] of [...queues]) {
      while (q.length) {
        const m = q[0];
        if (now() - m.at > ttlMs) { q.shift(); onDrop(key, m.text, 'expired', m.meta); continue; }
        const r = attempt(key, m.text, m.meta);
        if (r === 'wait') break;
        q.shift();
        if (r === 'ok') done++; else onDrop(key, m.text, r, m.meta);
      }
      if (!q.length) queues.delete(key);
    }
    return done;
  }
  return { submit, drain, pending, clear: (key) => queues.delete(key) };
}

module.exports = { createCtlQueue };
