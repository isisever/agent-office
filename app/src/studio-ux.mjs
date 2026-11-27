// Studio UX helpers (contract v3.120, "Studio UX"): pure logic for the header, the sidebar's session rows, the start
// screen, the model label and the context ring. The DOM is renderer/studio.js and renderer/chat.js; main uses
// sessionName for the running sessions' titles.

/** The models and permission modes a start screen may choose ('' = the project's own default). */
export const START_MODELS = ['', 'opus', 'sonnet', 'haiku'];
export const START_MODES = ['', 'default', 'acceptEdits', 'plan'];

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * A session's name, the same order as /resume in the chat (v3.118): the /rename title, then Claude Code's own title,
 * then the first prompt; '' when there is none (the caller shows "New session").
 * @param {{ custom?: string, ai?: string, title?: string, prompt?: string } | null | undefined} info
 * @param {number} [max]
 */
export function sessionName(info, max = 80) {
  if (!info || typeof info !== 'object') return '';
  const s = oneLine(info.custom) || oneLine(info.ai) || oneLine(info.title) || oneLine(info.prompt);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * How long ago `at` was, as { value, unit } for Intl.RelativeTimeFormat (value ≤ 0); unit 'now' under a minute.
 * null when `at` is not a time. A time in the future (clock skew) counts as now.
 * @param {number} at @param {number} now
 * @returns {null | { value: number, unit: 'now' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' }}
 */
export function relativeParts(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || typeof now !== 'number') return null;
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return { value: 0, unit: 'now' };
  const steps = /** @type {const} */ ([['minute', 60, 60], ['hour', 3600, 24], ['day', 86400, 7], ['week', 604800, 4.35], ['month', 2629800, 12]]);
  for (const [unit, size, next] of steps) {
    const v = Math.floor(s / size);
    if (v < next) return { value: -v, unit };
  }
  return { value: -Math.floor(s / 31557600), unit: 'year' };
}

/**
 * A short relative time ("5 min. ago", "yesterday"), in the given language; '' when unknown.
 * @param {number} at @param {number} now @param {string} [lang] @param {string} [nowLabel] what 'now' reads as
 */
export function relativeTime(at, now, lang = 'en', nowLabel = '') {
  const p = relativeParts(at, now);
  if (!p) return '';
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(lang || 'en', { numeric: 'auto', style: 'short' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }); }
  if (p.unit === 'now') return nowLabel || rtf.format(0, 'second');
  return rtf.format(p.value, p.unit);
}

/**
 * The start screen's choices → how the session starts: the tab mode for tabs:add ('same' | 'worktree') and the
 * settings to apply through chat:setting right after the GUI chat is up (tabs start with the project's own model and
 * mode; only values that differ from '' and are offered are kept).
 * @param {{ worktree?: boolean, model?: string, mode?: string } | null | undefined} choice
 * @returns {{ tabMode: 'same' | 'worktree', settings: [ 'model' | 'mode', string ][] }}
 */
export function startPlan(choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  /** @type {[ 'model' | 'mode', string ][]} */
  const settings = [];
  if (typeof c.model === 'string' && c.model && START_MODELS.includes(c.model)) settings.push(['model', c.model]);
  if (typeof c.mode === 'string' && c.mode && START_MODES.includes(c.mode)) settings.push(['mode', c.mode]);
  return { tabMode: c.worktree === true ? 'worktree' : 'same', settings };
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A model id as people read it: 'claude-opus-5-5' → 'Opus 5.5', 'claude-sonnet-4-5-20250929' → 'Sonnet 4.5',
 * 'claude-3-5-haiku-20241022' → 'Haiku 3.5', 'opus' → 'Opus', a '[1m]' suffix → ' (1M)'. Anything else as it is
 * (trimmed, at most 40 characters); '' for nothing.
 * @param {unknown} id
 */
export function modelName(id) {
  if (typeof id !== 'string') return '';
  const raw = id.trim();
  if (!raw) return '';
  const big = /\[1m\]$/i.test(raw);
  const base = raw.replace(/\[1m\]$/i, '').toLowerCase();
  const parts = base.replace(/^claude-/, '').split('-').filter((x) => !/^\d{8}$/.test(x));   // a date stamp is left out
  const fam = parts.find((x) => FAMILIES.includes(x));
  if (!fam) return raw.slice(0, 40);
  const nums = parts.filter((x) => /^\d{1,2}$/.test(x));
  const name = `${cap(fam)}${nums.length ? ` ${nums.join('.')}` : ''}`;
  return big ? `${name} (1M)` : name;
}

/** The context window of a model id: 1,000,000 for a '[1m]' id, else 200,000. */
export function contextLimit(model) {
  return typeof model === 'string' && /\[1m\]$/i.test(model.trim()) ? 1000000 : 200000;
}

/**
 * The context a turn used, from an assistant message's usage (input + cache read + cache creation tokens) → { used,
 * limit, pct } (pct 0…100, rounded); null when there is no usage.
 * @param {any} usage @param {string} [model] @param {number} [limit] a known window (the project's context cap)
 */
export function contextUsage(usage, model = '', limit = 0) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const used = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
  if (!used) return null;
  const lim = n(limit) || contextLimit(model);
  return { used, limit: lim, pct: Math.min(100, Math.round((used / lim) * 100)) };
}

/** A token count short: 812, 12.4k, 1.2M. */
export function shortTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** The first name of a display name ('Ada Lovelace' → 'Ada'); '' for none. */
export function firstName(name) {
  return oneLine(name).split(' ')[0] || '';
}
