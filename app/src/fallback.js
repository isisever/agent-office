// Backup account at the usage limit (contract v3.17): pure functions (no Electron; tested with node --test).
//
// How a limit is seen (Claude Code 2.1.302):
// - The transcript. A request refused for the plan's usage limit ends the turn with an assistant entry
//   { isApiErrorMessage: true, error: "rate_limit", apiError: "usage_limit_reached",
//     apiErrorParams: { rate_limit_info: { resetsAt: <unix s>, rateLimitType: "five_hour" | "seven_day" | … } },
//     message: { content: [{ type: "text", text: "You've hit your session limit · resets 3pm (Europe/Istanbul)" }] } }.
//   Its text starts with one of Claude Code's own usage-limit prefixes (its `ZVs` list, LIMIT_PREFIXES here). This is
//   the main signal: it is the session's own record, so scrollback, a redraw on --resume or the user typing the words
//   cannot fake it, and an entry older than the tab's start is ignored.
// - The terminal. The same words on screen ("You've hit your session limit · resets …", the auto-continue line
//   "Usage limit reached · continuing automatically …", older versions' "Claude AI usage limit reached") are only a
//   hint: they count when the account's quota (status line, v2.4) also says it is at 100 %. The user's own typing is
//   echoed, and the model may print the words, so the terminal alone never switches an account.
// - The quota. An account whose 5-hour or weekly window is at 100 % and not reset yet is "at its limit": it is never
//   picked as a backup and a project does not go back to it.

const LIMIT_PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits", "You're out of extra usage"];
// Fast mode's own cooldown ("You've hit your fast limit · resets in 8m") turns fast mode off; it does not stop work.
const NOT_LIMITS = ["You've hit your fast limit"];
const LEGACY = /^Claude (?:AI )?usage limit reached\|?(\d{9,11})?/;

const DEFAULT_LIMIT_MS = 5 * 3600e3; // a limit without a known reset time: the 5-hour window
const MIN_STAY_MS = 2 * 60e3;        // a project stays at least this long on an account before it moves again
const LOOP_WINDOW_MS = 3600e3;       // at most MAX_SWITCHES automatic moves of one project in this window
const MAX_SWITCHES = 4;
const PTY_GRACE_MS = 10000;          // terminal text in the first seconds of a start is the resumed conversation redrawn
const TAIL_BYTES = 64 * 1024;        // how much of a transcript's end is read

const normQuote = (s) => String(s ?? '').replace(/[‘’]/g, "'");

/** Is this message text one of Claude Code's usage-limit messages? */
function isUsageLimitText(text) {
  const s = normQuote(text).trim();
  if (!s || NOT_LIMITS.some((p) => s.startsWith(p))) return false;
  return LIMIT_PREFIXES.some((p) => s.startsWith(p)) || LEGACY.test(s);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/**
 * The reset time in a limit message, in ms, or null. Claude Code writes it in the session's local time:
 * "resets 3pm", "resets 3:30pm", "resets Oct 20, 9am", "resets Jan 3, 2027, 9am" (a time zone in brackets may follow);
 * older versions "Claude AI usage limit reached|<unix s>". now: the time the message was written.
 */
function parseResetText(text, now = Date.now()) {
  const s = normQuote(text);
  const legacy = LEGACY.exec(s.trim());
  if (legacy?.[1]) return Number(legacy[1]) * 1000;
  const m = /\bresets (?:([A-Za-z]{3}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i.exec(s);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toLowerCase() === 'pm') hour += 12;
  const minute = m[5] ? Number(m[5]) : 0;
  const base = new Date(now);
  if (!m[1]) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const d = new Date(m[3] ? Number(m[3]) : base.getFullYear(), month, Number(m[2]), hour, minute);
  if (!m[3] && d.getTime() < now - 86400e3) d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n') : '');

/**
 * The end of a transcript (JSONL text, maybe starting mid-line) → the usage limit it ends on, or null.
 * The last user or assistant entry decides: a usage-limit API error written at or after `since` (the tab's start, ms)
 * is a limit; a newer prompt or answer means the session went on. → { at, resetsAt, type, text }
 */
function limitFromTranscript(tail, { since = 0 } = {}) {
  const lines = String(tail || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || (e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) continue;
    if (e.type === 'user') return null;
    if (!e.isApiErrorMessage) return null;
    const text = textOf(e.message?.content);
    if (e.apiError !== 'usage_limit_reached' && !isUsageLimitText(text)) return null;
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at) || at < since) return null;
    const info = e.apiErrorParams?.rate_limit_info;
    const resetsAt = Number.isFinite(info?.resetsAt) ? info.resetsAt * 1000 : parseResetText(text, at);
    return { at, resetsAt: resetsAt && resetsAt > at ? resetsAt : null, type: typeof info?.rateLimitType === 'string' ? info.rateLimitType : null, text: text.slice(0, 200) };
  }
  return null;
}

// --- terminal hint
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;:]*m/g;
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC = /\x1b[@-_()*+#%][0-9A-Za-z]?/g;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]+/g;
/** Terminal output → plain text: colors removed, cursor moves and line breaks become spaces. */
const plainText = (s) => String(s || '').replace(OSC, '').replace(SGR, '').replace(CSI, ' ').replace(ESC, '').replace(CTRL, ' ').replace(/ {2,}/g, ' ');
const PTY_LIMIT = /You've hit your (?!fast limit)[A-Za-z' -]{0,40}?limit|You've reached your [A-Za-z' -]{0,40}?limit|You're out of (?:usage credits|extra usage)|Usage limit reached · (?:limit resets|continuing automatically)|Claude (?:AI )?usage limit reached/;
const PTY_TAIL = 400;

/**
 * Scans a chunk of a tab's terminal output. scan: { tail } carried between chunks (a message can arrive in pieces).
 * → { scan, hit: the matched words or null }. After a hit the tail starts over, so the same words are not hit twice.
 */
function scanPty(scan, chunk) {
  const text = (scan?.tail || '') + normQuote(plainText(chunk));
  const m = PTY_LIMIT.exec(text);
  if (m) return { scan: { tail: '' }, hit: m[0] };
  return { scan: { tail: text.slice(-PTY_TAIL) }, hit: null };
}

// --- accounts at their limit
/**
 * Until when the account is at its limit (ms), or 0. usage: its AccountUsage (v2.4); mark: { at, until } a limit seen
 * in one of its sessions. A window at 100 % counts until its reset (no reset time: 5 h after the reading). A mark counts
 * until its time, unless a quota reading newer than the mark shows every window below 100 %.
 */
function limitedUntil({ usage = null, mark = null, now = Date.now() } = {}) {
  let until = 0;
  let full = false;
  for (const w of [usage?.fiveHour, usage?.sevenDay]) {
    if (!w || !Number.isFinite(w.pct) || w.pct < 100) continue;
    const end = Number.isFinite(w.resetsAt) ? w.resetsAt : (usage.updatedAt || 0) + DEFAULT_LIMIT_MS;
    if (end > now) { until = Math.max(until, end); full = true; }
  }
  const markOk = mark && Number.isFinite(mark.until) && mark.until > now
    && !(usage && Number.isFinite(usage.updatedAt) && usage.updatedAt > (mark.at || 0) && !full);
  if (markOk) until = Math.max(until, mark.until);
  return until;
}

/** The mark kept for an account after a limit: until its reset time, else DEFAULT_LIMIT_MS from now. */
const markFor = (resetsAt, now = Date.now()) => ({ at: now, until: Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : now + DEFAULT_LIMIT_MS });

/** How full the account's quota is (0–100, the fuller window; unknown 0), to prefer the emptier backup. */
function fullness(usage, now = Date.now()) {
  let p = 0;
  for (const w of [usage?.fiveHour, usage?.sevenDay]) {
    if (!w || !Number.isFinite(w.pct) || (Number.isFinite(w.resetsAt) && w.resetsAt <= now)) continue;
    p = Math.max(p, w.pct);
  }
  return p;
}

/**
 * The account a project at its limit moves to.
 * choice: the project's backup setting (null = none, 'auto' = any other account, or an account id);
 * current: its account id; home: the account it moved away from earlier (v3.17 homeAccount) or null;
 * accounts: [{ id, auth?: { state }, usage? }] (in the sidebar's order); marks: { [accountId]: { at, until } }.
 * A candidate must be logged in ('in') and not at its limit. With a set backup the project is on already, its home is
 * the candidate (a chain A → B → A happens only after A reset). 'auto' prefers the home, then the emptier quota.
 * → { id } | { reason: 'off' | 'none' | 'notLoggedIn' | 'allLimited' }
 */
function pickBackup({ choice = null, current, home = null, accounts = [], marks = {}, now = Date.now() }) {
  if (!choice) return { reason: 'off' };
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let cands;
  if (choice === 'auto') cands = accounts.filter((a) => a.id !== current);
  else if (choice !== current) cands = byId.has(choice) ? [byId.get(choice)] : [];
  else cands = home && home !== current && byId.has(home) ? [byId.get(home)] : [];
  if (!cands.length) return { reason: 'none' };
  const loggedIn = cands.filter((a) => a.auth?.state === 'in');
  if (!loggedIn.length) return { reason: 'notLoggedIn' };
  const free = loggedIn.filter((a) => !limitedUntil({ usage: a.usage, mark: marks[a.id], now }));
  if (!free.length) return { reason: 'allLimited' };
  const order = (a) => (a.id === home ? -1 : fullness(a.usage, now));
  const best = free.map((a, i) => ({ a, i })).sort((x, y) => order(x.a) - order(y.a) || x.i - y.i)[0].a;
  return { id: best.id };
}

/**
 * May the project move automatically now? history: the times of its earlier automatic moves.
 * Not within MIN_STAY_MS of the last one, and fewer than MAX_SWITCHES in the last hour (no ping-pong).
 * → { ok, reason?: 'soon' | 'loop', history: the times still inside the window }
 */
function switchAllowed(history = [], now = Date.now()) {
  const recent = history.filter((t) => Number.isFinite(t) && now - t < LOOP_WINDOW_MS);
  const last = recent.length ? Math.max(...recent) : 0;
  if (last && now - last < MIN_STAY_MS) return { ok: false, reason: 'soon', history: recent };
  if (recent.length >= MAX_SWITCHES) return { ok: false, reason: 'loop', history: recent };
  return { ok: true, history: recent };
}

/**
 * Does a project on a backup go back to its home account now? home: { id, auth?, usage? } or null; current: the
 * project's account id; idle: none of its tabs is mid-turn, has unsent text or runs agents or shells;
 * lastSwitch: the time of its last automatic move.
 */
function shouldReturn({ home, current, mark = null, idle, lastSwitch = 0, now = Date.now() }) {
  if (!home || home.id === current || !idle) return false;
  if (home.auth?.state !== 'in') return false;
  if (now - lastSwitch < MIN_STAY_MS) return false;
  return !limitedUntil({ usage: home.usage, mark, now });
}

/** Marks kept in state.json: only well-formed ones still in the future, for known accounts. */
function normalizeMarks(raw, accountIds, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of accountIds) {
    const m = raw[id];
    if (m && Number.isFinite(m.until) && m.until > now) out[id] = { at: Number.isFinite(m.at) ? m.at : now, until: m.until };
  }
  return out;
}

module.exports = {
  LIMIT_PREFIXES, DEFAULT_LIMIT_MS, MIN_STAY_MS, MAX_SWITCHES, PTY_GRACE_MS, TAIL_BYTES,
  isUsageLimitText, parseResetText, limitFromTranscript, plainText, scanPty,
  limitedUntil, markFor, fullness, pickBackup, switchAllowed, shouldReturn, normalizeMarks,
};
