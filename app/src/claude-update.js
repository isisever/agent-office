// Keep the Claude Code CLI current: pure helpers (no Electron; tested with node --test).
//
// On startup Agent Office runs `claude update` in the background, at most once per INTERVAL_MS per machine (the
// throttle stamp lives in userData, see main.js). It never edits the user's Claude config (autoUpdates and the like
// stay as the user set them) and it is skipped when the OPT_OUT_ENV environment variable is '1' or 'true'.

const UPDATE_COMMAND = 'claude update';
const INTERVAL_MS = 12 * 60 * 60 * 1000;
const OPT_OUT_ENV = 'AGENT_OFFICE_NO_CLAUDE_UPDATE';

/**
 * Is a check due? True when there is no valid last check, it lies in the future, or the interval has passed.
 * @param {number} now @param {unknown} lastCheckedAt @param {number} [interval]
 */
function shouldCheck(now, lastCheckedAt, interval = INTERVAL_MS) {
  if (typeof lastCheckedAt !== 'number' || !Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;
  if (lastCheckedAt > now) return true;
  return now - lastCheckedAt >= interval;
}

/** @param {Record<string, string | undefined>} [env] false when the user opted out */
function enabled(env) {
  const v = String((env || {})[OPT_OUT_ENV] ?? '').trim().toLowerCase();
  return !(v === '1' || v === 'true');
}

module.exports = { UPDATE_COMMAND, INTERVAL_MS, OPT_OUT_ENV, shouldCheck, enabled };
