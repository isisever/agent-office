// Keep computer awake (contract v3.78): pure functions (no Electron; tested with node --test).
//
// The setting `keepAwake` says when the app holds a sleep block (Electron's powerSaveBlocker,
// 'prevent-app-suspension': the computer does not go to sleep on its own; the display may still turn off and a
// closed lid still sleeps a laptop):
// - 'off'      never
// - 'working'  while at least one hosted session is mid-turn or a routine run is in progress, and for GRACE_MS after
//              the last one went idle, so the block does not flap between two turns (the default)
// - 'always'   for as long as the app runs
// main.js counts the busy sessions, remembers when the count last fell to zero and starts/stops the block.

const KEEP_AWAKE_CHOICES = ['off', 'working', 'always'];
const DEFAULT_KEEP_AWAKE = 'working';
const GRACE_MS = 30 * 1000;

/** The stored setting; anything unknown or missing is the default ('working'). */
const normalizeKeepAwake = (v) => (KEEP_AWAKE_CHOICES.includes(v) ? v : DEFAULT_KEEP_AWAKE);

/**
 * When the busy count last fell to zero: `now` on a busy → idle transition, else unchanged.
 * @param {{ lastIdleAt?: number, wasBusy?: number, busy?: number, now: number }} o
 */
function nextIdleAt({ lastIdleAt = 0, wasBusy = 0, busy = 0, now }) {
  return wasBusy > 0 && !(busy > 0) ? now : lastIdleAt;
}

/**
 * Should the sleep block be held now?
 * @param {{ pref?: unknown, busy?: number, lastIdleAt?: number, now: number }} o
 *   busy = sessions mid-turn plus routine runs in progress; lastIdleAt = when that count last fell to zero (0 = never)
 */
function shouldHold({ pref, busy = 0, lastIdleAt = 0, now }) {
  const p = normalizeKeepAwake(pref);
  if (p === 'off') return false;
  if (p === 'always') return true;
  if (busy > 0) return true;
  return lastIdleAt > 0 && now >= lastIdleAt && now - lastIdleAt < GRACE_MS;
}

module.exports = { KEEP_AWAKE_CHOICES, DEFAULT_KEEP_AWAKE, GRACE_MS, normalizeKeepAwake, nextIdleAt, shouldHold };
