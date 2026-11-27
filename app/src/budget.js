'use strict';
// Token budgets per project (contract v3.133). Project.budget: { daily?, weekly?, unit: 'tokens' | 'usd',
// ignoreDay? } read against the token report's today (since local midnight) and week (the last 7 x 24 h) sums
// (token-usage.js). At WARN_AT a notice is shown once; at 100% HQ dispatches and routines into the project wait with
// the reason 'budget' until the person raises the budget or ignores it for today. The person's own typing is never
// blocked. Pure, no Electron.

const WARN_AT = 0.8;
const UNITS = ['tokens', 'usd'];
const RAISE_BY = 1.5;

const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day of `now` as YYYY-MM-DD. */
function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A stored budget, cleaned: null when it holds no limit. */
function normalizeBudget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const daily = positive(raw.daily);
  const weekly = positive(raw.weekly);
  if (!daily && !weekly) return null;
  return {
    ...(daily ? { daily } : {}),
    ...(weekly ? { weekly } : {}),
    unit: UNITS.includes(raw.unit) ? raw.unit : 'tokens',
    ...(typeof raw.ignoreDay === 'string' && DAY_RE.test(raw.ignoreDay) ? { ignoreDay: raw.ignoreDay } : {}),
  };
}

/**
 * The project's budget now. usage: { today: { total, usd }, week: { total, usd } } (a TokenReport or the brief's
 * sums); budget: Project.budget. The period nearest its limit decides.
 * @returns {{ level: 'none' | 'ok' | 'warn' | 'over', pct: number, period: 'daily' | 'weekly' | null, used: number,
 *   limit: number, unit: 'tokens' | 'usd', ignored: boolean, blocked: boolean }}
 */
function budgetState({ usage, budget, now }) {
  const b = normalizeBudget(budget);
  const none = { level: /** @type {const} */ ('none'), pct: 0, period: null, used: 0, limit: 0, unit: b?.unit || 'tokens', ignored: false, blocked: false };
  if (!b) return none;
  const take = (part) => {
    const n = b.unit === 'usd' ? part?.usd : part?.total;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  };
  /** @type {{ period: 'daily' | 'weekly', used: number, limit: number }[]} */
  const rows = [];
  if (b.daily) rows.push({ period: 'daily', used: take(usage?.today), limit: b.daily });
  if (b.weekly) rows.push({ period: 'weekly', used: take(usage?.week), limit: b.weekly });
  const top = rows.map((r) => ({ ...r, pct: r.used / r.limit })).sort((x, y) => y.pct - x.pct)[0];
  const level = top.pct >= 1 ? 'over' : top.pct >= WARN_AT ? 'warn' : 'ok';
  const ignored = b.ignoreDay === dayKey(now);
  return { level, pct: top.pct, period: top.period, used: top.used, limit: top.limit, unit: b.unit, ignored, blocked: level === 'over' && !ignored };
}

/** "Raise": every limit at RAISE_BY times, at least past what is used now (state from budgetState). */
function raiseBudget(budget, state) {
  const b = normalizeBudget(budget);
  if (!b) return null;
  const up = (limit, used) => {
    let v = limit * RAISE_BY;
    while (v <= used) v *= RAISE_BY;
    return b.unit === 'usd' ? Math.ceil(v * 100) / 100 : Math.ceil(v);
  };
  const out = { ...b };
  if (b.daily) out.daily = up(b.daily, state?.period === 'daily' ? state.used : 0);
  if (b.weekly) out.weekly = up(b.weekly, state?.period === 'weekly' ? state.used : 0);
  delete out.ignoreDay;
  return out;
}

/** "Ignore today": the budget no longer holds anything back until local midnight. */
const ignoreToday = (budget, now) => { const b = normalizeBudget(budget); return b ? { ...b, ignoreDay: dayKey(now) } : null; };

/** The key a notice is shown once for: per level, period and day (so a weekly warning repeats at most daily). */
const noticeKey = (state, now) => (state.level === 'warn' || state.level === 'over' ? `${state.level}:${state.period}:${dayKey(now)}` : '');

module.exports = { WARN_AT, UNITS, RAISE_BY, dayKey, normalizeBudget, budgetState, raiseBudget, ignoreToday, noticeKey };
