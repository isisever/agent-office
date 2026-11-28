'use strict';
// v3.157 Custom session names kept in the app's own state.json (`sessionNames`: { [claude session id]: name }).
// A custom name wins over the transcript's /rename title, Claude Code's title and the first prompt; an empty name
// removes it (back to the automatic title). Pure: every function returns a new map, never writes anywhere.
const NAME_MAX = 120;
const KEEP_MAX = 500;
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One line, no control characters, collapsed spaces, at most NAME_MAX characters; '' when nothing is left. */
function normalizeName(v) {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim() : '';
}

/** The map as kept in state.json: valid session ids with a non-empty name, the newest KEEP_MAX entries. */
function normalizeNames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sid, name] of Object.entries(raw)) {
    const n = normalizeName(name);
    if (SID_RE.test(sid) && n) out[sid] = n;
  }
  return trim(out);
}

function trim(map) {
  const keys = Object.keys(map);
  if (keys.length <= KEEP_MAX) return map;
  const out = {};
  for (const k of keys.slice(keys.length - KEEP_MAX)) out[k] = map[k];
  return out;
}

/** Sets (or, for an empty name, removes) one session's name → { names, name } with the stored name ('' when removed); same map for a bad id. */
function setName(raw, sessionId, name) {
  const names = normalizeNames(raw);
  if (typeof sessionId !== 'string' || !SID_RE.test(sessionId)) return { names, name: '' };
  const n = normalizeName(name);
  delete names[sessionId];   // re-adding puts it last, so the oldest names are dropped first
  if (n) names[sessionId] = n;
  return { names: trim(names), name: n };
}

/** A session's custom name or ''. */
function nameOf(raw, sessionId) {
  const v = raw && typeof raw === 'object' && typeof sessionId === 'string' && Object.prototype.hasOwnProperty.call(raw, sessionId) ? raw[sessionId] : '';
  return normalizeName(v);
}

module.exports = { NAME_MAX, KEEP_MAX, normalizeName, normalizeNames, setName, nameOf };
