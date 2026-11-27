'use strict';
// v3.121 the files a person attached in a tab's chat composer (contract: Studio experience). Only these open from a
// file chip (chat:openFile): a chip drawn from transcript text the person did not send from this composer (an HQ
// prompt, a delegated task, a paired device's prompt) names a path the app never saw the person pick.
const path = require('node:path');

const MAX_PER_TAB = 500;   // the oldest go first: a long session never grows this without end

/** A path as it is kept and compared: absolute and normalized, or '' when it is not one. */
function norm(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return '';
  return path.resolve(p);
}

/**
 * The mentioned paths in a message the person sent from the composer (chat:send's text): absolute paths only, as the
 * chat's own mention format writes them (an at sign before the path, quoted when it has a space).
 */
function sentPaths(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(?:^|\s)@(?:"([^"\n]+)"|(\S+))/g)) {
    const p = norm(m[1] || m[2] || '');
    if (p) out.push(p);
  }
  return out;
}

/** Per tab (pty id) the set of attached paths. */
function createAttached({ max = MAX_PER_TAB } = {}) {
  /** @type {Map<string, Set<string>>} */
  const tabs = new Map();
  return {
    /** Adds the absolute paths among `paths` for the tab → how many were taken. */
    add(id, paths) {
      if (typeof id !== 'string' || !id || !Array.isArray(paths)) return 0;
      let set = tabs.get(id);
      let n = 0;
      for (const raw of paths.slice(0, max)) {
        const p = norm(raw);
        if (!p) continue;
        if (!set) { set = new Set(); tabs.set(id, set); }
        set.delete(p);   // re-added: the newest
        set.add(p);
        n++;
      }
      while (set && set.size > max) set.delete(set.values().next().value);
      return n;
    },
    /** Did the person attach this path in this tab? */
    has(id, p) {
      const n = norm(p);
      return Boolean(n) && Boolean(tabs.get(String(id))?.has(n));
    },
    /** A closed tab: its paths go. */
    forget(id) { tabs.delete(String(id)); },
  };
}

module.exports = { createAttached, sentPaths, MAX_PER_TAB };
