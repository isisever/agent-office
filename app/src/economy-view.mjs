// v3.133 the renderer side of economy mode and token budgets: pure helpers shared by the Office sidebar, Studio's
// sidebar, the board's report, the budget banner and the title bar's leaf (renderer/economy-button.js).

/** Whether economy applies to a project: its own override ('on' | 'off'), else the global switch. */
export const economyOn = (/** @type {any} */ p, /** @type {boolean} */ globalOn) =>
  p?.economy === 'on' || (p?.economy !== 'off' && globalOn === true);

/**
 * The values economy gives this project (only those the person left at the default), for "150K (economy)" style
 * labels. sleepMinutes: the global idle sleep (0 = off).
 * @returns {{ contextCap: number | null, agentModel: string | null, savings: string | null, shareMcp: boolean, sleepMinutes: number | null }}
 */
export function economyEffects(/** @type {any} */ p, { globalOn = false, sleepMinutes = 0 } = {}) {
  const none = { contextCap: null, agentModel: null, savings: null, shareMcp: false, sleepMinutes: null };
  if (!economyOn(p, globalOn)) return none;
  return {
    contextCap: p?.contextCap ? null : 150000,
    agentModel: p?.agentModel ? null : 'sonnet',
    savings: p?.savings ? null : 'strict',
    shareMcp: p?.shareMcp !== true,   // true: the shared set is off because of economy
    sleepMinutes: sleepMinutes > 0 && sleepMinutes < 60 ? 60 : null,
  };
}

/**
 * A budget meter from a token brief's `budget` (main's budget.js budgetState): null when the project has none.
 * @returns {{ pct: number, width: number, level: string, blocked: boolean, ignored: boolean, period: string, used: number, limit: number, unit: string } | null}
 */
export function meterView(/** @type {any} */ brief) {
  const b = brief?.budget;
  if (!b || !b.level || b.level === 'none') return null;
  const pct = Math.max(0, Math.round((Number(b.pct) || 0) * 100));
  return { pct, width: Math.min(100, pct), level: String(b.level), blocked: b.blocked === true, ignored: b.ignored === true,
    period: b.period === 'weekly' ? 'weekly' : 'daily', used: Number(b.used) || 0, limit: Number(b.limit) || 0, unit: b.unit === 'usd' ? 'usd' : 'tokens' };
}

/** An amount in the budget's unit: "$4.20" or "1.2M" tokens. */
export function amountText(/** @type {number} */ n, /** @type {string} */ unit) {
  if (unit === 'usd') return `$${(Number(n) || 0).toFixed(2)}`;
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

/** The projects whose "budget reached" banner shows now: blocked and not dismissed for this level today. */
export function bannersOf(/** @type {any[]} */ briefs, /** @type {Set<string>} */ dismissed = new Set()) {
  return (Array.isArray(briefs) ? briefs : []).filter((b) => b && b.id && meterView(b)?.blocked && !dismissed.has(b.id));
}
