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
// - A compaction that failed at the limit (v3.77, Claude Code 2.1.325). When the conversation is too long and the
//   automatic compaction's own request is refused for the usage limit, the turn ends on
//   "Prompt is too long · automatic compaction failed: You've reached your Fable limit. Run /usage-credits …". Claude
//   Code builds it as an API error message with error "invalid_request" and no apiError, and no such entry was found
//   in any transcript: the screen is the only place it is seen. So for this one phrase the terminal decides
//   (compactionVerdict), guarded three ways: the words must follow an Enter or a running turn (a redraw of old text
//   and a paste do not), no unsent typing may be pending when they appear, and the transcript must not contradict
//   them (the session went on, or an entry holds the words: a prompt, an answer or a tool result quoting them).

const LIMIT_PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits", "You're out of extra usage"];
// Fast mode's own cooldown ("You've hit your fast limit · resets in 8m") turns fast mode off; it does not stop work.
const NOT_LIMITS = ["You've hit your fast limit"];
const LEGACY = /^Claude (?:AI )?usage limit reached\|?(\d{9,11})?/;

const DEFAULT_LIMIT_MS = 5 * 3600e3; // a limit without a known reset time: the 5-hour window
const MIN_STAY_MS = 2 * 60e3;        // a project stays at least this long on an account before it moves again
const LOOP_WINDOW_MS = 3600e3;       // at most MAX_SWITCHES automatic moves of one project in this window
const MAX_SWITCHES = 4;
const PTY_GRACE_MS = 10000;          // terminal text in the first seconds of a start is the resumed conversation redrawn
const COMPACT_SETTLE_MS = 3000;      // a compaction failure on screen is acted on after this long (the transcript catches up)
const COMPACT_QUOTE_MS = 60000;      // an entry this long before the sighting that holds the words explains the sighting
const COMPACT_SUBMIT_MS = 10000;     // the failure follows an Enter within this long …
const COMPACT_ECHO_MS = 3000;        // text typed this shortly before the words appeared may be what the screen echoed
const COMPACT_BUSY_MS = 5000;        // … or a turn seen running this shortly before (the 1.5 s poll plus the status file's lag)
const TAIL_BYTES = 64 * 1024;        // how much of a transcript's end is read

const normQuote = (s) => String(s ?? '').replace(/[‘’]/g, "'");

/** Is this message text one of Claude Code's usage-limit messages? */
function isUsageLimitText(text) {
  const s = normQuote(text).trim();
  if (!s || NOT_LIMITS.some((p) => s.startsWith(p))) return false;
  return LIMIT_PREFIXES.some((p) => s.startsWith(p)) || LEGACY.test(s);
}

// "automatic compaction failed: " followed at once by one of the usage-limit messages (never fast mode's cooldown).
const COMPACT_FAILED = 'automatic compaction failed';
const COMPACT_LIMIT = /automatic compaction failed: (?:You've (?:hit|reached) your (?!fast limit)[A-Za-z0-9.' -]{0,40}?limit|You're out of (?:usage credits|extra usage))/;
/** Is this text Claude Code's "automatic compaction failed" message with a usage limit as its cause? */
const isCompactionLimitText = (text) => COMPACT_LIMIT.test(normQuote(text));

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
    if (e.apiError !== 'usage_limit_reached' && !isUsageLimitText(text) && !isCompactionLimitText(text)) return null;
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
 * → { scan, hit: the matched words or null, compaction: the hit is a compaction that failed at the limit (v3.77) }.
 * After a hit the tail starts over, so the same words are not hit twice.
 */
function scanPty(scan, chunk) {
  const text = (scan?.tail || '') + normQuote(plainText(chunk));
  const c = COMPACT_LIMIT.exec(text);
  if (c) return { scan: { tail: '' }, hit: c[0], compaction: true };
  const m = PTY_LIMIT.exec(text);
  if (m) return { scan: { tail: '' }, hit: m[0], compaction: false };
  return { scan: { tail: text.slice(-PTY_TAIL) }, hit: null, compaction: false };
}

// --- a compaction that failed at the limit (v3.77): the terminal decides, what the tab did and its transcript may contradict
/**
 * What the person (or the app) sent to the tab, as far as this rule needs it.
 * state: { submitAt, submitSid, typedAt, quoted, paste, text }.
 * An Enter outside a bracketed paste is a submit: submitAt, with the session the tab was in (submitSid, null unknown);
 * it clears typedAt and quoted. Text (typed or pasted, a pasted line break too) sets typedAt: the terminal echoes it
 * at once. quoted: the unsent text holds the words "automatic compaction failed" (the prompt box may redraw them
 * until they are sent); text is the short end of the unsent text that finds them across pieces. Escape sequences
 * (arrows, focus and mouse reports) and control keys change nothing: Ctrl+C is not a submit.
 * @param {object | undefined} state @param {string} data @param {number} [now] @param {string | null} [sessionId]
 */
function inputAfter(state, data, now = Date.now(), sessionId = null) {
  let { submitAt = 0, submitSid = null, typedAt = 0, quoted = false, paste = false, text = '' } = state || {};
  const s = String(data ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const n = s[i + 1];
      if (n === '[') { // CSI: parameters, then a final byte @..~
        let j = i + 2;
        while (j < s.length && (s.charCodeAt(j) < 0x40 || s.charCodeAt(j) > 0x7e)) j++;
        const seq = s.slice(i + 2, j + 1);
        if (seq === '200~') paste = true;
        else if (seq === '201~') paste = false;
        i = j;
      } else if (n === 'O') i += 2; // SS3: one more byte
      else if (n !== undefined) i += 1;
      continue;
    }
    if (c === 0x0d && !paste) { submitAt = now; submitSid = sessionId || null; typedAt = 0; quoted = false; text = ''; continue; }
    if (paste || (c >= 0x20 && c !== 0x7f)) {
      typedAt = now;
      text = (text + (c >= 0x20 ? s[i] : ' ')).slice(-COMPACT_FAILED.length);
      if (text === COMPACT_FAILED) quoted = true;
    }
  }
  return { submitAt, submitSid, typedAt, quoted, paste, text };
}
/** The input state of a tab started with a prompt as claude's argument (the carry-on after a move): sent at the start. */
const startInput = ({ prompt = '', startedAt, sessionId = null }) => (prompt ? inputAfter(undefined, '\r', startedAt, sessionId) : undefined);

/**
 * The compaction failure as it was seen: when, and what the tab had just done. input: inputAfter's state;
 * busyAt: when Claude Code's pid file last said a turn was running; startedAt: the tab's start (early: seen in the
 * first PTY_GRACE_MS, where a resumed conversation is drawn). Kept with the sighting, because later input and later
 * turns must not change what caused it.
 */
const compactionSighting = ({ at, input = null, busyAt = 0, startedAt = 0 }) => ({
  at, typedAt: input?.typedAt || 0, quoted: Boolean(input?.quoted), submitAt: input?.submitAt || 0, submitSid: input?.submitSid || null,
  busyAt: busyAt || 0, early: at - (startedAt || 0) <= PTY_GRACE_MS,
});

/**
 * Does the end of the transcript contradict a compaction failure seen on screen at `at` (ms)? It does when
 * - a prompt, an answer or another API error was written after the sighting (the session went on, the words were
 *   being written, or the turn ended on something else), or
 * - an entry written from COMPACT_QUOTE_MS before the sighting on holds the words: a prompt, an answer or a tool
 *   result quoting them is what the screen showed, or
 * - (answeredSince given: the sighting rests on an Enter at that time) an answer was written between that Enter and
 *   the sighting: the Enter's turn went through, so the words are a redraw after it.
 * Claude Code's own entry for this failure, should a version write one, is never a contradiction.
 * @param {string} tail @param {{ at: number, answeredSince?: number }} o
 */
function compactionContradicted(tail, { at, answeredSince = 0 }) {
  for (const raw of String(tail || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (e.isApiErrorMessage && isCompactionLimitText(textOf(e.message?.content))) continue;
    const turn = (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain;
    if (turn && ts > at) return true;
    if (e.isApiErrorMessage) continue;
    if (turn && e.type === 'assistant' && answeredSince > 0 && ts > answeredSince) return true;
    if (ts >= at - COMPACT_QUOTE_MS && line.includes(COMPACT_FAILED)) return true;
  }
  return false;
}

/**
 * What a compaction failure seen on screen means now.
 * sighting: compactionSighting; status: Claude Code's pid file status now ('idle' | 'shell' | 'busy' | 'waiting' |
 * undefined); sessionId: the session the tab is in now; input: inputAfter's state now; tail: the end of the tab's
 * transcript, null when it has none.
 * 'void' (never acted on; a newer sighting replaces it) when
 * - the words may be an echo: text was typed within COMPACT_ECHO_MS before them (a paste, cleared or not), or the
 *   unsent text held the words (the prompt box redrawn), or
 * - nothing caused it: no Enter within COMPACT_SUBMIT_MS before it in the session the tab is still in (an in-tab
 *   /resume draws another conversation) and no running turn within COMPACT_BUSY_MS before it (old text redrawn on
 *   a resize, in the transcript view, or by a resume), or
 * - the transcript contradicts it (compactionContradicted), or it is older than DEFAULT_LIMIT_MS.
 * 'wait' (look again) while it is younger than COMPACT_SETTLE_MS, there is no transcript, a turn is running or a
 * dialog is open (the failure ends the turn; a model printing the words is mid-turn), text was typed within
 * COMPACT_ECHO_MS or unsent text holds the words, or (early sighting: the resumed conversation may still be drawing
 * before the carry-on turn starts) Claude Code has not written a status yet.
 * Otherwise 'limit': act as on a usage limit.
 * @returns {'limit' | 'wait' | 'void'}
 */
function compactionVerdict({ sighting, now = Date.now(), status = undefined, sessionId = null, input = null, tail = null }) {
  const { at, typedAt = 0, quoted = false, submitAt = 0, submitSid = null, busyAt = 0, early = false } = sighting || {};
  if (!Number.isFinite(at) || now - at >= DEFAULT_LIMIT_MS) return 'void';
  if (quoted || (typedAt > 0 && typedAt <= at && at - typedAt <= COMPACT_ECHO_MS)) return 'void';
  const afterTurn = busyAt > 0 && busyAt <= at && at - busyAt <= COMPACT_BUSY_MS;
  const sameSession = !submitSid || !sessionId || submitSid === sessionId;
  const afterEnter = submitAt > 0 && submitAt <= at && at - submitAt <= COMPACT_SUBMIT_MS && sameSession;
  if (!afterTurn && !afterEnter) return 'void';
  if (tail === null || tail === undefined) return 'wait';
  if (compactionContradicted(tail, { at, answeredSince: afterTurn ? 0 : submitAt })) return 'void';
  const known = typeof status === 'string' && status !== '';
  if ((known && status !== 'idle' && status !== 'shell') || (early && !known)) return 'wait';
  if (input?.quoted || (input?.typedAt > 0 && now - input.typedAt < COMPACT_ECHO_MS) || now - at < COMPACT_SETTLE_MS) return 'wait';
  return 'limit';
}

/** The limit hit of a compaction sighting whose verdict is 'limit' (the shape limitFromTranscript returns). */
const compactionHit = (sighting) => ({ at: sighting.at, resetsAt: null, type: null, text: COMPACT_FAILED });

// --- accounts at their limit
/**
 * Until when the account is at its limit (ms), or 0. usage: its AccountUsage (v2.4); mark: { at, until } a limit seen
 * in one of its sessions. A window at 100 % counts until its reset (no reset time: 5 h after the reading). A mark counts
 * until its time, unless a quota reading newer than the mark shows every window below 100 %. Its firm part (v3.77
 * firmUntil: a limit without a known reset time, e.g. a model's own limit, which no quota window shows) counts until
 * its own time whatever the quota says.
 */
/** Until when a mark is firm (ms), or 0. An earlier build wrote `firm: true` for a mark firm to its end. */
const firmUntilOf = (mark) => (!mark ? 0 : Number.isFinite(mark.firmUntil) ? mark.firmUntil : mark.firm === true && Number.isFinite(mark.until) ? mark.until : 0);
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
  const firm = firmUntilOf(mark);
  if (firm > now) until = Math.max(until, firm);
  return until;
}

/** The mark kept for an account after a limit: until its reset time, else DEFAULT_LIMIT_MS from now. */
const markFor = (resetsAt, now = Date.now()) => ({ at: now, until: Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : now + DEFAULT_LIMIT_MS });
/**
 * The mark for the limits a project stopped on (v3.77). resets: their known reset times (ms); seenAt: when the
 * earliest was seen. A known reset time gives the mark of v3.17. None known: DEFAULT_LIMIT_MS from when it was seen
 * (not from now, so looking again does not push it out), and firm, so a quota reading cannot clear it early.
 */
function limitMark({ resets = [], seenAt, now = Date.now() }) {
  const known = resets.filter(Number.isFinite);
  if (known.length) return markFor(Math.max(...known), now);
  const mark = markFor(Math.min(now, Number.isFinite(seenAt) ? seenAt : now) + DEFAULT_LIMIT_MS, now);
  return { ...mark, firmUntil: mark.until };
}
/**
 * The mark kept after a new one is seen: the longer end, and separately the longer firm end, so a longer ordinary
 * mark does not drop the firm part and a firm mark does not shorten a longer ordinary one. → `old` itself when the
 * new mark adds nothing.
 */
function mergeMarks(old, mark, now = Date.now()) {
  const live = old && Number.isFinite(old.until) && old.until > now ? old : null;
  if (!live) return mark;
  const until = Math.max(live.until, mark.until);
  const firmUntil = Math.max(firmUntilOf(live), firmUntilOf(mark));
  if (until === live.until && firmUntil === firmUntilOf(live)) return old;
  return { at: Math.max(live.at || 0, mark.at || 0), until, ...(firmUntil > 0 ? { firmUntil } : {}) };
}

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
function shouldReturn({ home, current, mark = null, idle, lastSwitch = 0, now = Date.now(), modelMarks = {}, family = undefined }) {
  if (!home || home.id === current || !idle) return false;
  if (home.auth?.state !== 'in') return false;
  if (now - lastSwitch < MIN_STAY_MS) return false;
  if (limitedUntil({ usage: home.usage, mark, now })) return false;
  // v3.111: the home's own limit for the project's model holds too (family unknown: any of the home's model marks)
  const fams = family ? [family] : family === undefined ? [] : FAMILIES;
  return !fams.some((f) => modelLimitedUntil(modelMarks, home.id, f, now));
}

/** Marks kept in state.json: only well-formed ones still in the future, for known accounts. */
function normalizeMarks(raw, accountIds, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of accountIds) {
    const m = raw[id];
    if (m && Number.isFinite(m.until) && m.until > now) out[id] = { at: Number.isFinite(m.at) ? m.at : now, until: m.until, ...(firmUntilOf(m) > now ? { firmUntil: firmUntilOf(m) } : {}) };
  }
  return out;
}

// --- the limit policy (contract v3.111): explicit backup, the same model on other accounts, a second model, then wait
// Claude Code names a model's own limit in the refused request's rate_limit_info.rateLimitType ("seven_day_opus",
// "seven_day_sonnet", ... in Claude Code 2.1.329) and in its text ("You've reached your Fable limit"). The status line's
// rate_limits has only five_hour and seven_day, so a per-model limit is known only from such a hit: it is kept as a
// model mark ("<account id>|<family>") until its reset (none known: DEFAULT_LIMIT_MS, firm).
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
/** The model family of a model id or alias ('claude-opus-5-5', 'opus', 'claude-fable-5-2[1m]'), or null. */
function modelFamily(model) {
  const m = /(haiku|sonnet|opus|fable)/i.exec(String(model || ''));
  return m ? m[1].toLowerCase() : null;
}
const MODEL_LIMIT_TYPE = /_(fable|opus|sonnet|haiku)$/i;
const MODEL_LIMIT_TEXT = /You've (?:hit|reached) your (Fable|Opus|Sonnet|Haiku)\b[A-Za-z0-9. -]{0,20}?limit/i;
/** The family whose own limit a hit is ({ type, text } of limitFromTranscript), or null for an account-wide limit. */
function limitFamily(hit) {
  const t = MODEL_LIMIT_TYPE.exec(String(hit?.type || ''));
  if (t) return t[1].toLowerCase();
  const m = MODEL_LIMIT_TEXT.exec(normQuote(hit?.text));
  return m ? m[1].toLowerCase() : null;
}
const modelMarkKey = (accountId, family) => `${accountId}|${family}`;
/** Until when the account's own limit for this family holds (ms), or 0. */
function modelLimitedUntil(modelMarks, accountId, family, now = Date.now()) {
  if (!family) return 0;
  const m = modelMarks?.[modelMarkKey(accountId, family)];
  return m && Number.isFinite(m.until) && m.until > now ? m.until : 0;
}
/** Model marks kept in state.json: "<known account id>|<family>" still in the future. */
function normalizeModelMarks(raw, accountIds, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set(accountIds);
  for (const [k, m] of Object.entries(raw)) {
    const i = k.lastIndexOf('|');
    if (i < 1 || !ids.has(k.slice(0, i)) || !FAMILIES.includes(k.slice(i + 1))) continue;
    if (m && Number.isFinite(m.until) && m.until > now) out[k] = { at: Number.isFinite(m.at) ? m.at : now, until: m.until };
  }
  return out;
}

/**
 * The second model: the model a project continues with when no account has quota for its own model.
 * setting: the project's choice ('none' = wait, a model id from `order`, undefined = default); order: the app's ordered
 * model list (projects.js CLAUDE_FULL_MODELS, strongest first). The default is the model just below the current one
 * in that list. null (wait) when the current model is unknown or the last one, or the second model is the current one.
 */
function secondModel({ current, setting, order = [] }) {
  if (setting === 'none') return null;
  const fam = modelFamily(current);
  let next = null;
  if (typeof setting === 'string' && setting && order.includes(setting)) next = setting;
  else {
    const i = fam ? order.findIndex((m) => modelFamily(m) === fam) : -1;
    next = i >= 0 && i + 1 < order.length ? order[i + 1] : null;
  }
  if (!next || next === current || (fam && modelFamily(next) === fam)) return null;
  return next;
}

/**
 * Where a project at its limit goes (owner policy, v3.111). Fully automatic:
 * 1. its explicit backup account (choice: an account id; 'auto' and none are not explicit), if logged in and free;
 * 2. the first other account in `accounts` order that is logged in and free for the project's current model;
 * 3. the first such account free for the second model (secondModel), the tabs then run on it;
 * 4. else wait: { wait: the earliest time a candidate (or the current account) frees, reason }.
 * Free: no account-wide limit (limitedUntil: quota at 100 % before its reset, or a mark) and no model mark for the
 * family. A reset time that has passed counts as free. → { id, model: null | <second model>, step } | { wait, reason }.
 * model null in the result: keep the model the project runs now.
 * own: the project's own model (the one it runs on its home account); default `model`. A move onto the home drops
 * the second model (projects.js fallbackTo), so the home is checked against the project's own model only (unknown:
 * any of the home's model marks holds it) and is never paired with the second model.
 */
function planLimitMove({ choice = null, model = null, own = model, second = null, current, home = null, accounts = [], marks = {}, modelMarks = {}, now = Date.now() }) {
  const fam = modelFamily(model);
  const ownFam = modelFamily(own);
  const blocked = (a, f) => {
    const wide = limitedUntil({ usage: a.usage, mark: marks[a.id], now });
    if (a.id !== home) return Math.max(wide, modelLimitedUntil(modelMarks, a.id, f, now));
    const fams = ownFam ? [ownFam] : FAMILIES;
    return Math.max(wide, ...fams.map((x) => modelLimitedUntil(modelMarks, a.id, x, now)));
  };
  const others = accounts.filter((a) => a.id !== current);
  const loggedIn = others.filter((a) => a.auth?.state === 'in');
  if (choice && choice !== 'auto') {
    const target = choice !== current ? choice : home;
    const a = loggedIn.find((x) => x.id === target);
    if (a && !blocked(a, fam)) return { id: a.id, model: null, step: 'explicit' };
  }
  const same = loggedIn.find((a) => !blocked(a, fam));
  if (same) return { id: same.id, model: null, step: 'sameModel' };
  const secondFam = modelFamily(second);
  const notHome = loggedIn.filter((a) => a.id !== home);
  if (second && secondFam !== fam) {
    const alt = notHome.find((a) => !blocked(a, secondFam));
    if (alt) return { id: alt.id, model: second, step: 'secondModel' };
  }
  const self = accounts.find((a) => a.id === current);
  const ends = [...loggedIn, ...(self ? [self] : [])].flatMap((a) => [blocked(a, fam), ...(second && a.id !== home ? [blocked(a, secondFam)] : [])]).filter((t) => t > now);
  return { wait: ends.length ? Math.min(...ends) : null, reason: !others.length ? 'none' : !loggedIn.length ? 'notLoggedIn' : 'allLimited' };
}

/**
 * v3.164 a project about to start its interrupted tab on an account still at its limit (usage at 100 % or an unexpired
 * mark) → the move planLimitMove picks ({ id, model, step }), or null (the account is free, or there is nowhere to go:
 * it then starts where it is). Takes planLimitMove's arguments plus the account's usage and mark.
 */
function limitedStartMove({ usage = null, mark = null, now = Date.now(), current, ...rest }) {
  if (!limitedUntil({ usage, mark, now })) return null;
  const plan = planLimitMove({ ...rest, current, now });
  return plan.id ? plan : null;
}

/**
 * v3.165 a GUI chat's stream-json error text (claude's own message, no transcript read) → the limit hit it is, or null.
 * The GUI path acts on this directly: it does not wait for the session id, the transcript or the quota reading.
 */
function guiLimitHit(text, now = Date.now()) {
  const s = String(text || '');
  if (!isUsageLimitText(s) && !isCompactionLimitText(s)) return null;
  const resetsAt = parseResetText(s, now);
  return { at: now, resetsAt: resetsAt && resetsAt > now ? resetsAt : null, type: null, text: s.slice(0, 200) };
}

/**
 * v3.165 a GUI chat that is idle (no turn) on an account another tab marked limited: a synthetic hit so the project
 * moves before the next message fails. null when the account is free. `at` is the mark's time (one hit per mark).
 */
function idleLimitHit({ usage = null, mark = null, now = Date.now() }) {
  const until = limitedUntil({ usage, mark, now });
  if (!until) return null;
  return { at: mark?.at || usage?.updatedAt || until, resetsAt: until, type: null, text: '' };
}

/** The model of the session's last real answer (an assistant entry's message.model, not '<synthetic>'), or null. */
function modelFromTranscript(tail) {
  const lines = String(tail || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e?.type === 'assistant' && !e.isSidechain ? e.message?.model : null;
    if (typeof m === 'string' && m && m !== '<synthetic>') return m;
  }
  return null;
}

// A subagent stopped by the usage limit: Claude Code reports it to the main session (a tool result or task
// notification) as `Agent "<name>" failed: Agent terminated early due to an API error: You've hit your session limit ·
// resets 1:40pm ...`. Only a line that starts the text (or follows a tag) counts: a file read or an answer quoting it
// is not a failure. And only two carriers count: the body of a task notification (a user text that is one
// <task-notification> block) and a tool result that answers an Agent/Task tool use of the same session. A pasted
// prompt or another tool's output (`cat` of a log) carrying the same words is not a failure.
const SUBAGENT_LIMIT = /(?:^|\n|>)\s*Agent "([^"\n]{1,80})" failed: Agent terminated early due to an API error: ((?:You've (?:hit|reached) your (?!fast limit)[^\n<]{0,40}?limit|You're out of (?:usage credits|extra usage))[^\n<]{0,120})/g;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TASK_NOTE = /^\s*<task-notification>([\s\S]*)<\/task-notification>\s*$/;
const plainTexts = (content) => (typeof content === 'string' ? [content]
  : Array.isArray(content) ? content.flatMap((c) => (c?.type === 'text' ? [c.text || ''] : [])) : []);
/** A user entry typed by a person: text only (no tool result), not a task notification. */
const isPersonMessage = (content) => {
  const texts = plainTexts(content);
  if (!texts.length || (Array.isArray(content) && content.some((c) => c?.type === 'tool_result'))) return false;
  return !texts.some((t) => /^\s*<task-notification>/.test(t));
};
/** The texts of a user entry that may report a failed sub-agent; agentUses: the ids of Agent/Task tool uses seen. */
const blockTexts = (content, agentUses) => {
  const notes = plainTexts(content).flatMap((t) => { const m = TASK_NOTE.exec(t); return m ? [m[1]] : []; });
  const results = Array.isArray(content)
    ? content.filter((c) => c?.type === 'tool_result' && agentUses.has(c.tool_use_id)).flatMap((c) => plainTexts(c.content))
    : [];
  return [...notes, ...results];
};
/**
 * Subagents of the main session that failed on a usage limit, written at or after `since` (ms).
 * → { names: [...unique, in order], hit: { at, resetsAt, type, text } of the newest, or null }.
 */
function subagentLimits(tail, { since = 0 } = {}) {
  const names = [];
  let hit = null;
  const agentUses = new Set();
  let lastPerson = -Infinity;
  for (const raw of String(tail || '').split('\n')) {
    const line = raw.trim();
    const use = line.includes('"tool_use"') && line.includes('"assistant"');
    if (!use && !line.includes('Agent terminated early') && !line.includes('"user"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.isSidechain) continue;
    if (e.type === 'assistant') {
      const content = e.message?.content;
      if (Array.isArray(content)) for (const c of content) if (c?.type === 'tool_use' && AGENT_TOOLS.has(c.name) && c.id) agentUses.add(c.id);
      continue;
    }
    if (e.type !== 'user') continue;
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at) || at < since) continue;
    if (!e.isMeta && isPersonMessage(e.message?.content)) lastPerson = Math.max(lastPerson, at);
    for (const text of blockTexts(e.message?.content, agentUses)) {
      for (const m of normQuote(text).matchAll(SUBAGENT_LIMIT)) {
        if (!names.includes(m[1])) names.push(m[1]);
        const resetsAt = parseResetText(m[2], at);
        if (!hit || at >= hit.at) hit = { at, resetsAt: resetsAt && resetsAt > at ? resetsAt : null, type: null, text: m[2].trim().slice(0, 200) };
      }
    }
  }
  // like limitFromTranscript: a person's message after the hit (theirs or the typed carry-on) means the session went on
  if (hit && lastPerson > hit.at) return { names: [], hit: null };
  return { names, hit };
}

module.exports = {
  LIMIT_PREFIXES, DEFAULT_LIMIT_MS, MIN_STAY_MS, MAX_SWITCHES, PTY_GRACE_MS, TAIL_BYTES,
  COMPACT_SETTLE_MS, COMPACT_QUOTE_MS, COMPACT_SUBMIT_MS, COMPACT_BUSY_MS, COMPACT_ECHO_MS,
  isUsageLimitText, isCompactionLimitText, parseResetText, limitFromTranscript, plainText, scanPty,
  inputAfter, startInput, compactionSighting, compactionContradicted, compactionVerdict, compactionHit, limitMark, mergeMarks,
  limitedUntil, markFor, fullness, pickBackup, switchAllowed, shouldReturn, normalizeMarks,
  FAMILIES, modelFamily, limitFamily, modelMarkKey, modelLimitedUntil, normalizeModelMarks, secondModel, planLimitMove, limitedStartMove, guiLimitHit, idleLimitHit,
  modelFromTranscript, subagentLimits,
};
