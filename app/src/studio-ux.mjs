// Studio UX helpers (contract v3.120, "Studio UX"): pure logic for the header, the sidebar's session rows, the start
// screen, the model label and the context ring. The DOM is renderer/studio.js and renderer/chat.js; main uses
// sessionName for the running sessions' titles.

import { pickerState } from './composer.mjs';

/** The models and permission modes a start screen may choose ('' = the project's own default). */
export const START_MODELS = ['', 'opus', 'sonnet', 'haiku'];
export const START_MODES = ['', 'auto', 'default', 'acceptEdits', 'plan'];   // v3.120 fallback: caps.modes is the account's list

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
 * @param {string[]} [models] the model values offered (v3.120 the account's reported list; START_MODELS by default)
 * @param {{ gui?: boolean, modeLock?: string, modes?: string[] } | null} [caps] what a new tab can apply (startPickers);
 *   modes: the account's reported permission modes (START_MODES when none)
 * @returns {{ tabMode: 'same' | 'worktree', settings: [ 'model' | 'mode', string ][] }}
 */
export function startPlan(choice, models = START_MODELS, caps = null) {
  const c = choice && typeof choice === 'object' ? choice : {};
  const can = startPickers(caps);
  /** @type {[ 'model' | 'mode', string ][]} */
  const settings = [];
  if (can.model && typeof c.model === 'string' && c.model && models.includes(c.model)) settings.push(['model', c.model]);
  const modes = Array.isArray(caps?.modes) && caps.modes.length ? caps.modes.filter((m) => m !== 'bypassPermissions') : START_MODES;
  if (can.mode && typeof c.mode === 'string' && c.mode && modes.includes(c.mode)) settings.push(['mode', c.mode]);
  return { tabMode: c.worktree === true ? 'worktree' : 'same', settings };
}

/**
 * v3.120 which start screen pickers a new session of the project can apply, from main's studio:models answer
 * (caps: { gui, modeLock }; null while it is not known yet: both offered, the start still checks each result).
 * The same lock rule as the chat's pickers (pickerState): a terminal tab (Windows, or the terminal chosen) has no
 * chat:setting, so neither picker; a skip-permissions project ('bypass') or a desk ('desk') keeps its mode.
 * @param {{ gui?: boolean, modeLock?: string } | null | undefined} caps
 * @returns {{ model: boolean, mode: boolean, lock: '' | 'bypass' | 'desk', shownMode: string }}
 */
export function startPickers(caps) {
  if (!caps || typeof caps !== 'object') return { model: true, mode: true, lock: '', shownMode: '' };
  const st = pickerState(caps.gui === true ? { modeLock: caps.modeLock || '', live: { busy: false }, asks: [] } : null, {});
  /** @type {'' | 'bypass' | 'desk'} */
  const lock = st.lock === 'bypass' || st.lock === 'desk' ? st.lock : '';
  return { model: st.enabled, mode: st.modeEnabled, lock, shownMode: lock === 'bypass' ? st.mode : '' };
}

/** How long the start screen waits for a new tab's chat to take a setting or the prompt. */
export const START_WAIT_MS = 30000;

/**
 * v3.120 one chat:setting / chat:send answer during a start → 'ok' | 'retry' | 'fail'. Only 'not-running' (the
 * chat is still starting) and 'busy' are tried again, and only while `elapsed` < `limit`; anything else ('locked',
 * 'bad', 'gone', 'error:…', a rejected call) or the time running out fails, and the prompt is not sent.
 * @param {unknown} result @param {number} elapsed @param {number} [limit]
 */
export function startStep(result, elapsed, limit = START_WAIT_MS) {
  if (result === 'ok') return 'ok';
  if ((result === 'not-running' || result === 'busy') && elapsed < limit) return 'retry';
  return 'fail';
}

/**
 * v3.120 why a start step failed, for the note under the start box → { why: 'locked' | 'busy' | 'not-running' |
 * 'bad' | 'gone' | 'unsupported' | 'error' | 'other', detail } (detail: claude's own message after 'error:').
 * @param {unknown} result
 */
export function startFailure(result) {
  const r = typeof result === 'string' ? result : '';
  if (r.startsWith('error:')) return { why: 'error', detail: r.slice(6).trim().slice(0, 200) };
  if (['locked', 'busy', 'not-running', 'bad', 'gone', 'unsupported'].includes(r)) return { why: r, detail: '' };
  return { why: 'other', detail: '' };
}

/**
 * v3.120 a session name for /rename: one line, control characters out, at most 120 characters ('' when nothing is left).
 * @param {unknown} name
 */
export function renameText(name) {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim() : '';
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

/**
 * The model the picker's default ('') option stands for, as people read it ("Opus 5.5"): the account default's
 * resolved model from claude's initialize list (value 'default' → '' with resolved 'claude-opus-5-5'), else, while
 * the session runs on that default, the model it reports. '' when unknown.
 * @param {any} models gui.models or the start screen's list @param {string} [running] gui.info.model @param {string} [picked] the chat's model setting
 */
export function defaultModelName(models, running = '', picked = '') {
  const def = Array.isArray(models) ? models.find((/** @type {any} */ m) => m && m.value === '') : null;
  return modelName(def?.resolved) || (picked ? '' : modelName(running));
}
