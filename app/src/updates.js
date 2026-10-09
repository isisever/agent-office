// In-app updates: pure decisions (no Electron; tested with node --test). main.js runs electron-updater and asks
// these functions what to say and when to check.

const FIRST_CHECK_MS = 10 * 1000;          // first check after launch
const UPDATE_EVERY_MS = 60 * 60 * 1000;    // then every hour
const FOCUS_CHECK_MS = 30 * 60 * 1000;     // and on window focus when the last check is older than this

/** "1.2.3" / "v1.2.3" → [1, 2, 3]; anything else → null. Release versions only (no prerelease tags). */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 by numeric semver order (0.10.0 > 0.9.1); null when either is not a version. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/**
 * What the manual "Check for Updates…" says.
 * current: the running version; ready: a downloaded version or null; downloading: the version being downloaded or null;
 * latest: the version the check returned (null/undefined = the check gave no answer).
 * → { kind: 'ready' | 'downloading' | 'upToDate' | 'unknown', version }
 *   ready: show the title bar's restart button; downloading: "Downloading <version>…";
 *   upToDate: "up to date (<current>)"; unknown: "could not check" (still names the current version).
 */
function updateMessage({ current, ready = null, downloading = null, latest = null }) {
  if (ready) return { kind: 'ready', version: ready };
  if (downloading) return { kind: 'downloading', version: downloading };
  const c = compareVersions(latest, current);
  if (c === null) return { kind: 'unknown', version: current };
  if (c > 0) return { kind: 'downloading', version: latest };
  return { kind: 'upToDate', version: current };
}

/** Check on focus? Only when the last check (ms timestamp, 0 = never) is at least FOCUS_CHECK_MS old. */
const shouldCheckOnFocus = (lastCheckAt, now = Date.now()) => now - (lastCheckAt || 0) >= FOCUS_CHECK_MS;

module.exports = { FIRST_CHECK_MS, UPDATE_EVERY_MS, FOCUS_CHECK_MS, parseVersion, compareVersions, updateMessage, shouldCheckOnFocus };
