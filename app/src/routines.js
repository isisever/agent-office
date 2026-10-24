// Routines (contract v3.47): recurring tasks for HQ and local Claude Code project bosses. Pure helpers, no Electron:
// definitions (normalize), the scheduler (next slot, missed slots, the per-tick plan with caps, quiet hours, no
// overlap, missed-run policy, 24 h catch-up limit, timezone change and clock jumps), the text typed for a run, the
// outcome line, history retention, HQ's busy check and the write gate around a typed routine prompt.
// Every function takes `now` (ms); wall-clock schedules use the process's local timezone.
'use strict';
const HQ = require('./hq');

const MAX_ROUTINES = 20;
const PROMPT_MAX = 8 * 1024;
const NAME_MAX = 60;
const GRACE_MS = 10 * 60 * 1000;            // a slot this recent still counts as on time
const CATCHUP_MAX_MS = 24 * 3600 * 1000;    // a missed slot older than this is skipped, never caught up
const JUMP_MS = 60 * 1000;                  // a tick gap longer than this = woke up / clock jumped
const RETAIN_RUNS = 300;
const RETAIN_MS = 90 * 24 * 3600 * 1000;
const KEY_QUIET_MS = 15 * 1000;             // HQ counts as busy this long after a keystroke
const OPEN_RUN = new Set(['waiting', 'typed', 'running', 'awaiting-consent']);
const KINDS = ['daily', 'weekdays', 'weekly', 'hours'];

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const line = (s, max) => { const t = String(s ?? '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

/** 'HH:MM' → { h, m } or null */
function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ''));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}
const mins = (s) => { const p = parseHHMM(s); return p ? p.h * 60 + p.m : -1; };
const wallMins = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

function normalizeSchedule(raw) {
  const o = isObj(raw) ? raw : {};
  if (!KINDS.includes(o.kind)) return null;
  if (o.kind === 'hours') {
    const every = int(o.every, 1, 24, 0);
    if (!every) return null;
    const from = parseHHMM(o.from) ? o.from : undefined;
    const to = parseHHMM(o.to) ? o.to : undefined;
    return { kind: 'hours', every, ...(from ? { from } : {}), ...(from && to ? { to } : {}) };
  }
  if (!parseHHMM(o.at)) return null;
  if (o.kind === 'weekly') { const day = int(o.day, 0, 6, -1); return day < 0 ? null : { kind: 'weekly', day, at: o.at }; }
  return { kind: o.kind, at: o.at };
}

/** The slots of one calendar day (y, mo, d + k) for a schedule, as ms (wall clock, local constructor per day). */
function daySlots(s, y, mo, d) {
  if (s.kind === 'hours') {
    const from = s.from ? mins(s.from) : 0;
    let span = 24 * 60 - 1 - from;                                   // no window: the rest of the day
    if (s.from && s.to) { const to = mins(s.to); span = to === from ? 24 * 60 - 1 : (to - from + 24 * 60) % (24 * 60); }
    const out = [];
    for (let i = 0; i * s.every * 60 <= span && i < 24; i++) out.push(new Date(y, mo, d, 0, from + i * s.every * 60).getTime());
    return out;
  }
  const day = new Date(y, mo, d, 12).getDay();
  if (s.kind === 'weekdays' && (day === 0 || day === 6)) return [];
  if (s.kind === 'weekly' && day !== s.day) return [];
  const p = /** @type {{h:number,m:number}} */ (parseHHMM(s.at));
  return [new Date(y, mo, d, p.h, p.m).getTime()];                  // spring forward: V8 moves a missing time forward
}

/** The first slot strictly after afterMs. */
function nextAfter(schedule, afterMs) {
  const s = normalizeSchedule(schedule);
  if (!s) return Infinity;
  const b = new Date(afterMs);
  for (let k = -1; k <= 9; k++) {
    const hit = daySlots(s, b.getFullYear(), b.getMonth(), b.getDate() + k).filter((t) => t > afterMs).sort((x, y) => x - y)[0];
    if (hit !== undefined) return hit;
  }
  return Infinity;
}
/** Slots in (fromMs, toMs]. */
function slotsBetween(schedule, fromMs, toMs, limit = 500) {
  const out = [];
  for (let t = nextAfter(schedule, fromMs); t <= toMs && out.length < limit; t = nextAfter(schedule, t)) out.push(t);
  return out;
}
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function inQuiet(ms, quiet) {
  if (!quiet) return false;
  const f = mins(quiet.from); const t = mins(quiet.to); const c = wallMins(ms);
  if (f < 0 || t < 0 || f === t) return false;
  return f < t ? c >= f && c < t : c >= f || c < t;
}
const quietEnd = (ms, quiet) => nextAfter({ kind: 'daily', at: quiet.to }, ms);
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

/** A routine prompt without obvious secrets → { text, redacted } */
function cleanPrompt(p) {
  const raw = String(p ?? '').replace(/\r\n?/g, '\n');
  let text = HQ.redact(raw);
  while (Buffer.byteLength(text, 'utf8') > PROMPT_MAX) text = text.slice(0, Math.floor(text.length * 0.9));
  return { text: text.trim(), redacted: text !== raw && HQ.redact(raw) !== raw };
}

/** One definition; null when it cannot run at all (no name/prompt, bad schedule, unknown target kind). */
/** @param {any} raw @param {{ now?: number, newId?: () => string }} [o] */
function normalizeRoutine(raw, { now = Date.now(), newId } = {}) {
  const o = isObj(raw) ? raw : {};
  const id = /^rt[0-9a-f]{8}$/.test(String(o.id)) ? o.id : newId ? newId() : '';
  const name = line(o.name, NAME_MAX);
  const prompt = cleanPrompt(o.prompt).text;
  const schedule = normalizeSchedule(o.schedule);
  const t = isObj(o.target) ? o.target : {};
  const target = t.kind === 'hq' ? { kind: 'hq' } : t.kind === 'project' && /^[A-Za-z0-9_.-]{1,64}$/.test(String(t.projectId)) ? { kind: 'project', projectId: t.projectId } : null;
  if (!id || !name || !prompt || !schedule || !target) return null;
  const dflt = schedule.kind === 'hours' ? Math.min(24, Math.ceil(24 / /** @type {any} */ (schedule).every)) : 4;
  return {
    id, name, prompt, target, schedule, missed: o.missed === 'skip' ? 'skip' : 'once', paused: o.paused === true,
    noAsk: o.noAsk === true, maxPerDay: int(o.maxPerDay, 1, 24, dflt),
    createdAt: Number.isFinite(o.createdAt) ? o.createdAt : now, updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : now,
  };
}
function normalizeRoutines(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map((r) => normalizeRoutine(r)).filter((r) => r && !seen.has(r.id) && seen.add(r.id)).slice(0, MAX_ROUTINES);
}
function normalizeCfg(raw) {
  const o = isObj(raw) ? raw : {};
  const q = isObj(o.quiet) && parseHHMM(o.quiet.from) && parseHHMM(o.quiet.to) && o.quiet.from !== o.quiet.to ? { from: o.quiet.from, to: o.quiet.to } : null;
  return { quiet: q, dailyCap: int(o.dailyCap, 1, 96, 48) };
}
/** routines.json (runtime): per-routine schedule state, the last tick, the run history, held approvals. */
function normalizeFile(raw) {
  const o = isObj(raw) ? raw : {};
  return {
    sched: isObj(o.sched) ? Object.fromEntries(Object.entries(o.sched).filter(([, s]) => isObj(s) && Number.isFinite(s.nextAt))) : {},
    lastTickAt: Number.isFinite(o.lastTickAt) ? o.lastTickAt : 0,
    tz: typeof o.tz === 'string' ? o.tz : '',
    runs: (Array.isArray(o.runs) ? o.runs : []).filter((r) => isObj(r) && isStr(r.id) && isStr(r.routine)),
    held: isObj(o.held) ? o.held : {},
  };
}
const counted = (r) => r.status !== 'skipped';
const runsOn = (runs, day, rid) => runs.filter((r) => counted(r) && dayKey(r.at) === day && (!rid || r.routine === rid)).length;
const wokeUp = (file, now) => Boolean(file.lastTickAt) && (now - file.lastTickAt > JUMP_MS || now < file.lastTickAt - 1000);

/**
 * One scheduler pass. → { actions, file }. Action = { kind: 'run'|'skip'|'wait', routine, slotAt, trigger, reason?,
 * missedCount?, notBefore? }. Main records them as runs; it never decides when a routine is due.
 */
/** @param {{ routines: any[], cfg: any, file: any, now: number, tz?: string, openRun?: (id: string) => boolean, blocked?: (r: any) => boolean }} o */
function plan({ routines, cfg, file, now, tz = '', openRun = () => false, blocked = () => false }) {
  const f = normalizeFile(file);
  const c = normalizeCfg(cfg);
  const actions = [];
  // a backward clock jump or another timezone (by IANA name): every routine re-anchors, nothing is caught up
  if ((f.lastTickAt && now < f.lastTickAt - 1000) || (f.tz && tz && f.tz !== tz)) f.sched = {};
  const ids = new Set(routines.map((r) => r.id));
  for (const k of Object.keys(f.sched)) if (!ids.has(k)) delete f.sched[k];
  const today = dayKey(now);
  let total = runsOn(f.runs, today);
  for (const r of routines) {
    const s = f.sched[r.id];
    if (r.paused || blocked(r) || !s) { f.sched[r.id] = { nextAt: nextAfter(r.schedule, now), lastCheckAt: now }; continue; }
    s.lastCheckAt = now;
    if (now < s.nextAt) continue;
    const due = slotsBetween(r.schedule, s.lastSlotAt ?? s.nextAt - 1, now);
    if (!due.length) { s.nextAt = nextAfter(r.schedule, now); continue; }
    const L = due[due.length - 1];
    const older = due.length - 1;
    const skip = (n) => n && actions.push({ kind: 'skip', routine: r.id, slotAt: L, trigger: 'schedule', reason: 'missed', missedCount: n });
    let run = null;
    if (now - L <= GRACE_MS) { skip(older); run = { kind: 'run', routine: r.id, slotAt: L, trigger: 'schedule' }; }
    else if (now - L > CATCHUP_MAX_MS || r.missed === 'skip') skip(due.length);
    else { skip(older); run = { kind: 'run', routine: r.id, slotAt: L, trigger: 'catch-up' }; }
    s.lastSlotAt = L;
    s.nextAt = nextAfter(r.schedule, Math.max(now, L));
    if (!run) continue;
    const gate = openRun(r.id) ? 'overlap' : runsOn(f.runs, today, r.id) + actions.filter((a) => a.kind !== 'skip' && a.routine === r.id).length >= r.maxPerDay ? 'daily-cap' : total >= c.dailyCap ? 'global-cap' : '';
    if (gate) { actions.push({ ...run, kind: 'skip', reason: gate }); continue; }
    if (inQuiet(now, c.quiet)) {
      if (r.missed === 'skip') { actions.push({ ...run, kind: 'skip', reason: 'quiet' }); continue; }
      actions.push({ ...run, kind: 'wait', reason: 'quiet', notBefore: quietEnd(now, c.quiet) });
    } else actions.push(run);
    total++;
  }
  f.lastTickAt = now;
  if (tz) f.tz = tz;
  return { actions, file: f };
}
/** "Run now": no schedule, no quiet hours; overlap and both daily caps still apply. → reason or null */
/** @param {{ routine: any, cfg: any, runs: any[], now: number, openRun: (id: string) => boolean }} o */
function manualGate({ routine, cfg, runs, now, openRun }) {
  if (openRun(routine.id)) return 'overlap';
  if (runsOn(runs, dayKey(now), routine.id) >= routine.maxPerDay) return 'daily-cap';
  if (runsOn(runs, dayKey(now)) >= normalizeCfg(cfg).dailyCap) return 'global-cap';
  return null;
}

/** The text typed into HQ (or dispatched to a boss) for one run. A quote-free `[routine <id>]` marker comes first. */
function wrapText({ routine, request, slotAt, t }) {
  const d = new Date(slotAt);
  const time = `${dayKey(slotAt)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const tail = t(routine.target.kind === 'hq' ? 'routines.wrapHq' : 'routines.wrapProject', { request });
  return `[routine ${request}] ${t('routines.wrapHead', { name: routine.name, time, request })}: ${HQ.redact(routine.prompt)}\n\n${tail}`;
}
/** The first non-empty line of a summary or report: OK → 'ok', anything else → 'attention'. */
function outcomeOf(text) {
  const first = String(text ?? '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return { status: /^\**\s*OK\b/i.test(first) ? 'ok' : 'attention', outcome: line(first, 160) };
}
const pruneRuns = (runs, now) => runs.filter((r) => OPEN_RUN.has(r.status) || now - (r.finishedAt || r.at) <= RETAIN_MS).slice(0, RETAIN_RUNS);

/** HQ is typed into only when its tab is ready, nobody typed there in the last 15 s and it is not the tab on screen. */
function hqBusy({ state, lastKeyAt = 0, now, onScreen = false }) {
  if (state !== 'ready') return state;
  return onScreen || now - lastKeyAt < KEY_QUIET_MS ? 'busy' : 'ready';
}
/** Between the paste and its Enter, the person's keystrokes for HQ are held and sent after the Enter. */
function createWriteGate({ now = Date.now, holdMs = 2000 } = {}) {
  let until = 0; let queue = [];
  return {
    hold() { until = now() + holdMs; },
    /** true when d was queued (do not write it now) */
    queue(d) { if (now() >= until) return false; queue.push(d); return true; },
    release() { until = 0; const q = queue; queue = []; return q; },
    get holding() { return now() < until; },
  };
}

module.exports = {
  MAX_ROUTINES, PROMPT_MAX, GRACE_MS, CATCHUP_MAX_MS, JUMP_MS, OPEN_RUN, KEY_QUIET_MS,
  parseHHMM, normalizeSchedule, nextAfter, slotsBetween, dayKey, inQuiet, quietEnd, tzName, cleanPrompt,
  normalizeRoutine, normalizeRoutines, normalizeCfg, normalizeFile, wokeUp, plan, manualGate, wrapText, outcomeOf, pruneRuns,
  hqBusy, createWriteGate,
};
