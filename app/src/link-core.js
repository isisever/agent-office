// Device link (contract v3.28, v3.31 capabilities, v3.32 res/catalog, v3.33 proj-op): the pure parts. Pairing codes, topics, message schema, command sanitizing, rate
// limits and trust checks. No Electron, no network; src/link.js does the networking, main.js the glue.
'use strict';
const crypto = require('crypto');
// v3.121 the wire and pairing protocol live in link-wire.js (shared with the iPhone worklet); crypto is injected here
const W = require('./link-wire.js');
const { PAIR_TTL_MS, MAX_FRAME, MAX_COMMAND, MAX_NAME, CODE_WORDS, WORDS, ESCAPES, CONTROLS, cleanLine, deviceName, isStr, isInt, isId, hex, isHex, normalizeCode, LineReader, encode, validatePair } = W;
const { makeCode, pairSecrets, pairProof, proofOk, pairTopic } = W.createWire(crypto);

// v3.31: 2 = hello carries the app version and capabilities; a v1 peer gets no message type it does not know
const PROTOCOL = 2;
// what a peer may say it understands (hello.caps); unknown names are dropped
const CAPS = ['res', 'catalog', 'manage', 'accounts', 'report', 'task-status', 'report2', 'revive', 'sess', 'ctl'];   // v3.121 'ctl': a phone controller
// what this build sends and understands (v3.32: res and catalog)
const OUR_CAPS = ['res', 'catalog', 'report', 'manage', 'accounts', 'task-status', 'report2', 'revive', 'sess'];   // v3.48 'task-status' (task-status/task-query/task-cancel, cmd.ttl), 'report2' (larger reports, prs/artifacts/transcriptRef); v3.35 adds 'report', v3.33 'manage' (proj-op), v3.34 'accounts' (login relay)
// v3.33 what a device allowed to manage may do to a project's boss tab here (proj-op), and why it may be refused
const PROJ_OPS = ['start', 'wake', 'sleep', 'stop'];
const PROJ_OP_REASONS = ['not-allowed', 'unknown-project', 'engine', 'busy', 'locked', 'rate-limited', 'removed', 'offline', 'no-manage', 'timeout', 'failed'];
// a trusted session pings every HEARTBEAT_MS; HEARTBEAT_MISSES intervals without any data from the peer close it
// (a quit or crash may never close the stream: UDX alone took ~17 s to notice)
const HEARTBEAT_MS = 5000;
const HEARTBEAT_MISSES = 3;
// project handoff (contract v3.29)
const MAX_BUNDLE = 200 * 1024 * 1024;     // a git bundle sent over the link
const MAX_PACK = 100 * 1024 * 1024;       // the session data (transcripts, memory, facts, settings)
const CHUNK = 32 * 1024;                  // bytes per ho-chunk (base64 keeps the line under MAX_FRAME)
const HANDOFF_REASONS = ['declined', 'not-allowed', 'busy', 'engine', 'not-git', 'offline', 'too-large', 'bad-data', 'checksum', 'apply-failed', 'timeout', 'in-progress', 'cancelled', 'unknown-project', 'changed', 'subfolder', 'push-declined', 'push-failed'];
const APPLIED = ['restored', 'branch-only'];
const HANDOFF_STATUS = ['applied', 'not-applied', 'unknown'];

// --- text hygiene

/**
 * A remote command's text, made safe to type into the claude prompt: escapes and control characters removed (tabs
 * and newlines kept as spaces later by R.typedPrompt). Refused, never cut, when it is empty or too long.
 * @returns {{ ok: boolean, text?: string, reason?: 'empty' | 'too-large' | 'not-text' }}
 */
function sanitizeCommand(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' };
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND) return { ok: false, reason: 'too-large' };
  const clean = text.replace(ESCAPES, '').replace(CONTROLS, '').replace(/[\t\r\n]+/g, ' ').trim();
  if (!clean) return { ok: false, reason: 'empty' };
  return { ok: true, text: clean };
}

/** What the owning device types: marked with the sender's name so the person sees where it came from. */
const markedCommand = (deviceName, text) => `[Agent Office: remote command from "${cleanLine(deviceName, MAX_NAME).replace(/"/g, "'")}"] ${text}`;

/** v3.35 a dispatched task (office_dispatch): marked with its id so the owning side's plugin can report on it. */
const markedTask = (id, fromName, text) => `[Agent Office: remote task #${id} from "${cleanLine(fromName, MAX_NAME).replace(/"/g, "'")}"] ${text}`;

const REPORT_MAX = 16 * 1024;   // a report's summary (characters)
const REPORT_COMMITS = 12;
/** A task report as it may cross the link: { ok, partial, summary ≤16 KB, commits ≤12 { hash, subject }, at, personPrompted? }, or null. */
// v3.48 cap 'report2': a larger summary (cut with a marker), more commits, PR links (https), artifact basenames and the
// session id of the transcript (never a path). Received reports are always cleaned with the larger limits.
const REPORT2_MAX = 40 * 1024;
const REPORT2_COMMITS = 30;
const TRUNC_MARK = '\n…[truncated]';
function cleanReport(r, v2 = false) {
  if (!r || typeof r !== 'object' || typeof r.summary !== 'string' || r.summary.length > (v2 ? REPORT2_MAX : REPORT_MAX) * 2) return null;
  const max = v2 ? REPORT2_MAX : REPORT_MAX;
  let summary = r.summary.replace(ESCAPES, '').replace(CONTROLS, ' ');
  let truncated = r.truncated === true;
  if (summary.length > max) { summary = summary.slice(0, max - TRUNC_MARK.length) + TRUNC_MARK; truncated = true; }
  const commits = (Array.isArray(r.commits) ? r.commits : []).slice(0, v2 ? REPORT2_COMMITS : REPORT_COMMITS)
    .filter((c) => c && typeof c.hash === 'string' && /^[0-9a-f]{4,40}$/.test(c.hash))
    .map((c) => ({ hash: c.hash, subject: cleanLine(c.subject, 120) }));
  const out = { ok: r.ok !== false, partial: r.partial === true, summary, commits, at: isInt(r.at) ? r.at : 0, ...(truncated ? { truncated: true } : {}), ...(r.personPrompted === true ? { personPrompted: true } : {}) };   // v3.89 amendment: absent or anything else is false
  if (!v2) return out;
  const prs = (Array.isArray(r.prs) ? r.prs : []).filter((u) => typeof u === 'string' && u.length <= 300 && /^https:\/\/[^\s"'<>\\]+$/.test(u)).slice(0, 10);
  const artifacts = (Array.isArray(r.artifacts) ? r.artifacts : []).map((a) => cleanLine(a, 120)).filter((a) => a && !/[\\/]/.test(a) && a !== '..' && a !== '.').slice(0, 20);
  const ref = typeof r.transcriptRef === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(r.transcriptRef) ? r.transcriptRef : '';
  return { ...out, ...(prs.length ? { prs } : {}), ...(artifacts.length ? { artifacts } : {}), ...(ref ? { transcriptRef: ref } : {}) };
}
/** v3.48 a report as it goes to one peer: cleaned for its caps and cut (with the marker) until one cmd-report fits a frame. */
function fitReport(r, v2, id = 'x'.repeat(64)) {
  let out = cleanReport(r, v2) || cleanReport({ ...r, summary: String(r?.summary || '').slice(0, v2 ? REPORT2_MAX : REPORT_MAX) }, v2);
  if (!out) return null;
  while (Buffer.byteLength(JSON.stringify({ t: 'cmd-report', id, ...out })) > MAX_FRAME - 512 && out.summary.length > 64) {
    const keep = Math.floor((out.summary.length - TRUNC_MARK.length) * 0.75);
    out = { ...out, summary: out.summary.replace(TRUNC_MARK, '').slice(0, keep) + TRUNC_MARK, truncated: true };
  }
  return out;
}

// v3.48 cap 'task-status': the runner's live status of one task, and why a queued one waits (like the local cards)
const TASK_STATES = ['queued', 'delivered', 'running', 'needs-approval', 'reported', 'rejected', 'unknown'];
const WAIT_STATES = ['ready', 'busy', 'starting', 'asleep', 'not-running'];
const TASK_TTL_MAX = 4 * 3600 * 1000;   // a remote HQ task may wait this long in the runner's queue (cmd.ttl)
const cleanWhy = (w) => (w && typeof w === 'object' && WAIT_STATES.includes(w.state) && isInt(w.pos, 99) && isInt(w.len, 99) && isInt(w.expiresIn, TASK_TTL_MAX)
  ? { state: w.state, pos: w.pos, len: w.len, expiresIn: w.expiresIn } : null);

// --- rate limit: a token bucket per device (burst 3, one more every 10 s: about 6 a minute)

class RateLimiter {
  constructor({ burst = 3, everyMs = 10000, now = Date.now } = {}) { this.burst = burst; this.everyMs = everyMs; this.now = now; this.b = new Map(); }
  take(key) {
    const t = this.now();
    const s = this.b.get(key) || { tokens: this.burst, at: t };
    s.tokens = Math.min(this.burst, s.tokens + (t - s.at) / this.everyMs);
    s.at = t;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    this.b.set(key, s);
    return ok;
  }
}

// --- message schema: every message is one JSON object per line; anything else is dropped

const STATUS = ['working', 'idle', 'approval'];
const CMD_STATUS = ['queued', 'delivered', 'rejected'];
const REASONS = ['cancelled', 'not-allowed', 'unknown-project', 'engine', 'not-running', 'too-large', 'empty', 'not-text', 'rate-limited', 'queue-full', 'expired', 'removed', 'logged-out', 'offline', 'no-report', 'locked', 'stopped-here'];   // v3.35 reasons go only to peers with cap 'report'

/** A received snapshot reduced to the known fields (strings cleaned and cut); null when malformed. */
function cleanSnapshot(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.projects) || s.projects.length > 50) return null;
  const projects = [];
  for (const p of s.projects) {
    if (!p || !isId(p.id) || !STATUS.includes(p.status)) return null;
    projects.push({
      id: p.id, name: cleanLine(p.name, 60) || '?', engine: ['claude', 'agy', 'commandcode', 'opencode'].includes(p.engine) ? p.engine : 'claude',
      status: p.status, working: isInt(p.working, 999) ? p.working : 0, delivered: isInt(p.delivered, 99999) ? p.delivered : 0,
      attention: p.attention === 'permission' || p.attention === 'done' ? p.attention : null,
      ...(isStr(p.tool, 200) && p.tool ? { tool: cleanLine(p.tool, 60) } : {}),
    });
  }
  const ids = new Set(projects.map((p) => p.id));
  const workers = [];
  for (const w of Array.isArray(s.workers) ? s.workers.slice(0, 120) : []) {
    if (!w || !isId(w.id) || !ids.has(w.project)) continue;
    workers.push({
      id: w.id, project: w.project, type: cleanLine(w.type, 40) || 'agent', description: cleanLine(w.description, 120),
      ...(w.tool ? { tool: cleanLine(w.tool, 40) } : {}), ...(isInt(w.spawnAt) ? { spawnAt: w.spawnAt } : {}),
      ...(isInt(w.doneAt) ? { doneAt: w.doneAt, isOk: w.isOk !== false } : {}),
    });
  }
  return { projects, workers, delivered: isInt(s.delivered, 999999) ? s.delivered : 0 };
}

// --- v3.32 machine resources and the project catalog (display only)

const PLATFORMS = ['darwin', 'linux', 'win32'];
const PROJECT_STATES = ['running', 'asleep', 'stopped'];
const ENGINES = ['claude', 'agy', 'commandcode', 'opencode'];
const isNum = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

/** A received `res` reduced to the known fields; null when malformed. */
function cleanRes(r) {
  if (!r || typeof r !== 'object' || !r.mem || typeof r.mem !== 'object') return null;
  if (!isInt(r.at) || !isInt(r.mem.total) || !isInt(r.mem.free) || r.mem.free > r.mem.total) return null;
  if (!isNum(r.load1, 10000) || !isInt(r.cpus, 4096) || r.cpus < 1) return null;
  return {
    at: r.at, mem: { total: r.mem.total, free: r.mem.free }, load1: Math.round(r.load1 * 100) / 100, cpus: r.cpus,
    tabs: isInt(r.tabs, 999) ? r.tabs : 0, agents: isInt(r.agents, 999) ? r.agents : 0, sleeping: isInt(r.sleeping, 999) ? r.sleeping : 0,
    platform: PLATFORMS.includes(r.platform) ? r.platform : 'other',
    app: isStr(r.app, 20) && /^[0-9A-Za-z.+-]{1,20}$/.test(r.app) ? r.app : '',
  };
}

/**
 * A received `catalog`: the projects of a machine for display only (id, folder name, state, engine, account label).
 * No paths, remotes, prompts or output. `shared: false` = that machine stopped sharing it with us. Null when malformed.
 */
function cleanCatalog(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.projects) || c.projects.length > 50) return null;
  const projects = [];
  for (const p of c.projects) {
    if (!p || !isId(p.id) || !PROJECT_STATES.includes(p.state)) return null;
    projects.push({ id: p.id, dirName: cleanLine(p.dirName, 80) || '?', state: p.state, engine: ENGINES.includes(p.engine) ? p.engine : 'claude', accountLabel: cleanLine(p.accountLabel, 40),
      ...(typeof p.skips === 'boolean' ? { skips: p.skips } : {}) });   // v3.101 optional: its main tab answers or skips permission prompts (absent from an older peer)
  }
  return { projects, shared: c.shared !== false };
}

/**
 * This machine's resources. `cpuTimes` (os.cpus()) is used where there is no load average (Windows): the busy share
 * since the previous sample times the CPU count. Returns { res, sample } (sample = the times for the next call).
 * @param {{ now: number, total: number, free: number, loadavg: number[], cpus: { times: Record<string, number> }[], platform: string, app: string,
 *   tabs: number, agents: number, sleeping: number, prev?: { busy: number, all: number } | null }} o
 */
function resOf(o) {
  const n = Math.max(1, o.cpus.length);
  let busy = 0, all = 0;
  for (const c of o.cpus) { const t = c.times || {}; const sum = Object.values(t).reduce((a, b) => a + (Number(b) || 0), 0); all += sum; busy += sum - (Number(t.idle) || 0); }
  let load1 = Number(o.loadavg?.[0]) || 0;
  if (o.platform === 'win32' || !(load1 > 0)) {
    const db = busy - (o.prev?.busy || 0), da = all - (o.prev?.all || 0);
    load1 = o.platform === 'win32' && o.prev && da > 0 ? (db / da) * n : load1;
  }
  const res = cleanRes({ at: o.now, mem: { total: Math.round(o.total), free: Math.min(Math.round(o.free), Math.round(o.total)) }, load1: Math.max(0, load1), cpus: n, tabs: o.tabs, agents: o.agents, sleeping: o.sleeping, platform: o.platform, app: o.app });
  return { res, sample: { busy, all } };
}

/** Is `next` worth sending after `prev` (sent at prev.at)? Counts changed, memory or load moved more than 2 %, or 30 s passed. */
function resChanged(prev, next) {
  if (!prev) return true;
  if (!next) return false;
  if (next.at - prev.at >= 30000) return true;
  if (prev.tabs !== next.tabs || prev.agents !== next.agents || prev.sleeping !== next.sleeping || prev.app !== next.app || prev.cpus !== next.cpus) return true;
  const moved = (a, b, scale) => Math.abs(a - b) > 0.02 * scale;
  return moved(prev.mem.free, next.mem.free, next.mem.total) || moved(prev.load1, next.load1, next.cpus);
}

/**
 * v3.31 amendment 4: may anything be typed into a tab from outside (remote command, dispatch)? Only once its claude's
 * session id is known AND that session has had its first prompt: before that the folder trust dialog may be showing.
 * @param {{ sessionId?: string | null, prompted?: boolean }} o
 */
const typingReady = (o) => Boolean(o && typeof o.sessionId === 'string' && /^[\w-]{8,}$/.test(o.sessionId) && o.prompted === true);

// --- v3.34 remote Claude login relay (cap 'accounts', opt-in allowAccounts). Credentials never cross the link:
// only the sign-in URL (B → A), the one-time code the person pastes (A → B, memory only) and the outcome.
const LOGIN_HOSTS = ['claude.ai', 'platform.claude.com', 'console.anthropic.com'];
const LOGIN_REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const LOGIN_CODE_RE = /^[A-Za-z0-9._~-]{10,400}#[A-Za-z0-9._~-]{8,200}$/;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_REASONS = ['not-allowed', 'busy', 'unknown-account', 'timeout', 'cancelled', 'failed', 'bad-url', 'offline', 'not-supported'];
const ACCOUNT_STATES = ['in', 'out', 'checking', 'error', 'unknown'];
/** A sign-in URL Claude Code printed: https, an allowlisted host, the code-callback redirect. Checked on both sides. */
function loginUrlOk(url) {
  if (typeof url !== 'string' || url.length > 4000 || /[\s\0]/.test(url)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && LOGIN_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password
    && u.searchParams.get('redirect_uri') === LOGIN_REDIRECT;
}
const loginCodeOk = (code) => typeof code === 'string' && LOGIN_CODE_RE.test(code);
/** Terminal output → plain text (CSI, OSC and other escapes, control characters but newlines). */
/* eslint-disable no-control-regex */
function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}
/* eslint-enable no-control-regex */
/**
 * `claude auth login` output (cleaned or raw) → the first allowlisted sign-in URL and the code prompt line, if shown.
 * @returns {{ url: string | null, prompt: string }}
 */
function parseLoginOutput(text) {
  const plain = stripAnsi(text);
  const url = (plain.match(/https:\/\/[^\s"'<>]+/g) || []).find(loginUrlOk) || null;
  const line = plain.split('\n').map((l) => l.trim()).find((l) => /paste (the )?code/i.test(l)) || '';
  return { url, prompt: cleanLine(line, 200) };
}
function cleanAccounts(list) {
  if (!Array.isArray(list) || list.length > 20) return null;
  const out = [];
  for (const a of list) {
    if (!a || !isId(a.id)) return null;
    const email = isStr(a.email, 200) && /^[^\s@]+@[^\s@]+$/.test(a.email) ? a.email : '';
    out.push({ id: a.id, label: cleanLine(a.label, 40) || a.id, state: ACCOUNT_STATES.includes(a.state) ? a.state : 'unknown', ...(email ? { email } : {}) });
  }
  return out;
}

// --- v3.100 reading a remote project's session (cap 'sess'): chat items of the project's main tab, never terminal bytes
const SESS_REASONS = ['not-allowed', 'unknown-project', 'engine', 'no-session', 'rate-limited', 'limit', 'unknown-session'];
const SESS_BACKFILL_ITEMS = 200;          // a new subscription starts with the last items of the transcript's tail …
const SESS_BACKFILL_BYTES = 256 * 1024;   // … and at most this many bytes of them (JSON, UTF-8)
const SESS_FRAME_BYTES = 48 * 1024;       // one sess-items line in BYTES after JSON.stringify (well under MAX_FRAME)
const SESS_FRAME_ITEMS = 200;             // items in one frame
const SESS_FRAMES_PER_SEC = 4;
const SESS_PER_DEVICE = 2;
const SESS_PER_CONTROLLER = 3;           // v3.178 a phone: HQ + a project + one while switching                // subscriptions one device may hold here
const SESS_IDLE_MS = 10 * 60 * 1000;      // without a sess-keep the subscription ends
const SESS_QUEUE_MAX = 32;                // frames waiting for one subscription; more ends it (rate-limited)
const SESS_OPENS_PER_MIN = 12;            // sess-open messages taken from one device per minute
const SESS_TEXT_MAX = 20000;              // characters of one message (chat.js TEXT_MAX)
const SESS_KINDS = ['user', 'assistant', 'error', 'command', 'tool', 'toolDone', 'note'];
const SESS_NOTES = ['compact', 'task', 'interrupted', 'message'];
const sessBytes = (v) => Buffer.byteLength(JSON.stringify(v));
const sessId = (v, max) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max) : '');
/** One chat item off the wire, rebuilt field by field → the item, or null (an unknown kind, an empty or oversized text). */
function cleanSessItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it) || !SESS_KINDS.includes(it.kind)) return null;
  const base = { key: sessId(it.key, 120), at: isInt(it.at) ? it.at : 0, kind: it.kind };
  if (it.kind === 'note') return SESS_NOTES.includes(it.note) ? { ...base, note: it.note } : null;
  if (it.kind === 'toolDone') return { ...base, id: sessId(it.id, 100), error: it.error === true };
  if (it.kind === 'tool') {
    const name = cleanLine(it.name, 80);
    if (!name) return null;
    // detail: only a peer with the (not yet built) second opt-in sends one; one line, bounded
    const detail = typeof it.detail === 'string' && it.detail.length <= 4000 ? cleanLine(it.detail, 200) : '';
    return { ...base, id: sessId(it.id, 100), name, ...(detail ? { detail } : {}) };
  }
  if (typeof it.text !== 'string' || it.text.length > MAX_FRAME) return null;
  const text = it.text.replace(ESCAPES, '').replace(CONTROLS, '').slice(0, SESS_TEXT_MAX + 20);   // the sender's cut mark fits
  return text.trim() ? { ...base, text } : null;
}
/** An item cut so that its JSON is at most `max` BYTES (multi-byte text and JSON escapes count), or null when it cannot fit. */
function fitSessItem(it, max = SESS_FRAME_BYTES - 256) {
  if (typeof it.text === 'string' && it.text.length > SESS_TEXT_MAX) it = { ...it, text: `${it.text.slice(0, SESS_TEXT_MAX).replace(/[\ud800-\udbff]$/, '')}${TRUNC_MARK}` };
  if (sessBytes(it) <= max) return it;
  if (typeof it.text !== 'string') return null;
  let text = it.text.endsWith(TRUNC_MARK) ? it.text.slice(0, -TRUNC_MARK.length) : it.text;
  while (text && sessBytes({ ...it, text: `${text}${TRUNC_MARK}` }) > max) {
    text = text.slice(0, Math.floor(text.length * 0.8));
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);   // never half a surrogate pair
  }
  return text ? { ...it, text: `${text}${TRUNC_MARK}` } : null;
}
/** Items → sess-items messages, in order, each at most SESS_FRAME_BYTES as a line; seq counts up from `seq`. A reset
 *  always gives at least one frame (it empties the view). */
function sessFrames(id, seq, items, reset = false) {
  const room = SESS_FRAME_BYTES - 256;   // the envelope (t, id, seq, reset) and the newline
  const out = [];
  let cur = [];
  let size = 0;
  const flush = () => { out.push({ t: 'sess-items', id, seq: seq + out.length, items: cur, ...(reset && !out.length ? { reset: true } : {}) }); cur = []; size = 0; };
  for (const raw of Array.isArray(items) ? items : []) {
    const it = fitSessItem(raw, room);
    if (!it) continue;
    const n = sessBytes(it) + 1;
    if (cur.length && (size + n > room || cur.length >= SESS_FRAME_ITEMS)) flush();
    cur.push(it);
    size += n;
  }
  if (cur.length || (reset && !out.length)) flush();
  return out;
}
/** What a new subscription gets first: the last SESS_BACKFILL_ITEMS items, at most SESS_BACKFILL_BYTES of them. */
function sessBackfill(items) {
  const out = [];
  let size = 0;
  for (const raw of (Array.isArray(items) ? items : []).slice(-SESS_BACKFILL_ITEMS).reverse()) {
    const it = fitSessItem(raw);
    if (!it) continue;
    size += sessBytes(it) + 1;
    if (size > SESS_BACKFILL_BYTES) break;
    out.push(it);
  }
  return out.reverse();
}

/**
 * Validates one decoded message from a trusted device. Unknown types, missing or oversized fields → null.
 * Pairing messages are validated separately (validatePair), before trust exists.
 * @returns {any}
 */
function validateMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.t) {
    case 'ping':
      return { t: 'ping' };
    case 'hello': {
      if (!isInt(m.v, 1000) || !isStr(m.name, 200)) return null;
      // v3.31 optional: app version and capabilities (a v1 peer sends neither: caps [])
      const app = isStr(m.app, 20) && /^[0-9A-Za-z.+-]{1,20}$/.test(m.app) ? m.app : '';
      const caps = Array.isArray(m.caps) ? [...new Set(m.caps.slice(0, 16).filter((c) => CAPS.includes(c)))] : null;
      return { t: 'hello', v: m.v, name: deviceName(m.name), ...(app ? { app } : {}), ...(caps ? { caps } : {}) };
    }
    case 'res': {
      const res = cleanRes(m.res);
      // v3.97 optional: does the sending machine run our tasks unattended (v3.101: are we paired there and not paused)? Older peers send none.
      return res ? { t: 'res', res, ...(typeof m.trusted === 'boolean' ? { trusted: m.trusted } : {}) } : null;
    }
    case 'catalog': {
      const catalog = cleanCatalog(m.catalog);
      return catalog ? { t: 'catalog', catalog } : null;
    }
    case 'state': {
      const snap = cleanSnapshot(m.snap);
      return isInt(m.seq) && snap ? { t: 'state', seq: m.seq, snap } : null;
    }
    case 'cmd':
      return isId(m.id) && isId(m.project) && typeof m.text === 'string' && m.text.length <= MAX_COMMAND * 4 ? { t: 'cmd', id: m.id, project: m.project, text: m.text, ...(m.report === true ? { report: true } : {}), ...(isInt(m.ttl, TASK_TTL_MAX) && m.ttl > 0 ? { ttl: m.ttl } : {}), ...(m.revive === true ? { revive: true } : {}) } : null;   // v3.99 revive: only sent to a peer with cap 'revive'
    case 'cmd-report': {   // v3.35, only to a peer with cap 'report' (v3.48: always cleaned with the report2 limits)
      const report = cleanReport(m, true);
      return isId(m.id) && report ? { t: 'cmd-report', id: m.id, ...report } : null;
    }
    case 'task-status': {   // v3.48, only to a peer with cap 'task-status'
      const why = cleanWhy(m.why);
      return isId(m.id) && TASK_STATES.includes(m.state) && (m.reason == null || REASONS.includes(m.reason))
        ? { t: 'task-status', id: m.id, state: m.state, ...(m.reason ? { reason: m.reason } : {}), ...(why && m.state === 'queued' ? { why } : {}) } : null;
    }
    case 'task-query':      // v3.48, only to a peer with cap 'task-status'
      return Array.isArray(m.ids) && m.ids.length >= 1 && m.ids.length <= 50 && m.ids.every(isId) ? { t: 'task-query', ids: [...new Set(m.ids)] } : null;
    case 'task-cancel':     // v3.48, only to a peer with cap 'task-status'
      return isId(m.id) ? { t: 'task-cancel', id: m.id } : null;
    case 'cmd-report-ack':   // v3.35, only to a peer with cap 'report'
      return isId(m.id) ? { t: 'cmd-report-ack', id: m.id } : null;
    case 'proj-op':          // v3.33, only to a peer with cap 'manage'
      return isId(m.id) && isId(m.project) && PROJ_OPS.includes(m.op) ? { t: 'proj-op', id: m.id, op: m.op, project: m.project } : null;
    case 'proj-op-status':   // v3.33, only to a peer with cap 'manage'
      return isId(m.id) && typeof m.ok === 'boolean' && (m.reason == null || PROJ_OP_REASONS.includes(m.reason))
        ? { t: 'proj-op-status', id: m.id, ok: m.ok, ...(m.reason && !m.ok ? { reason: m.reason } : {}) } : null;
    // v3.34 login relay, only to/from a peer with cap 'accounts'
    case 'acct-view': {
      const accounts = cleanAccounts(m.accounts);
      return accounts ? { t: 'acct-view', accounts, shared: m.shared !== false } : null;
    }
    case 'login-start':
      return isId(m.id) && isId(m.account) ? { t: 'login-start', id: m.id, account: m.account } : null;
    case 'login-url':   // the host allowlist is checked by the receiver's handler (a bad URL fails the login there)
      return isId(m.id) && isStr(m.url, 4000) ? { t: 'login-url', id: m.id, url: m.url, prompt: cleanLine(m.prompt, 200) } : null;
    case 'login-code':
      return isId(m.id) && loginCodeOk(m.code) ? { t: 'login-code', id: m.id, code: m.code } : null;
    case 'login-result':
      return isId(m.id) && typeof m.ok === 'boolean' && (m.reason == null || LOGIN_REASONS.includes(m.reason))
        ? { t: 'login-result', id: m.id, ok: m.ok, ...(isStr(m.email, 200) && /^[^\s@]+@[^\s@]+$/.test(m.email) ? { email: m.email } : {}), ...(m.reason ? { reason: m.reason } : {}) } : null;
    case 'login-cancel':
      return isId(m.id) ? { t: 'login-cancel', id: m.id } : null;
    case 'cmd-status':
      return isId(m.id) && CMD_STATUS.includes(m.status) && (m.reason == null || REASONS.includes(m.reason))
        ? { t: 'cmd-status', id: m.id, status: m.status, ...(m.reason ? { reason: m.reason } : {}) } : null;
    case 'sess-open':    // v3.100, all five only to a peer with cap 'sess'
      return isId(m.id) && isId(m.project) && (m.sid == null || isId(m.sid)) ? { t: 'sess-open', id: m.id, project: m.project, ...(m.sid != null ? { sid: m.sid } : {}) } : null;
    case 'sess-keep':
      return isId(m.id) ? { t: 'sess-keep', id: m.id } : null;
    case 'sess-close':
      return isId(m.id) ? { t: 'sess-close', id: m.id } : null;
    case 'sess-end':
      return isId(m.id) && SESS_REASONS.includes(m.reason) ? { t: 'sess-end', id: m.id, reason: m.reason } : null;
    case 'sess-items': {
      if (!isId(m.id) || !isInt(m.seq) || !Array.isArray(m.items) || m.items.length > SESS_FRAME_ITEMS) return null;
      return { t: 'sess-items', id: m.id, seq: m.seq, items: m.items.map(cleanSessItem).filter(Boolean), ...(m.reset === true ? { reset: true } : {}) };
    }
    case 'ho-offer': {
      const g = m.git;
      const sum = (x) => x && isInt(x.size) && isHex(x.sha, 32) ? { size: x.size, sha: x.sha } : null;
      const pack = sum(m.pack);
      const bundle = m.bundle == null ? null : sum(m.bundle);
      if (!isId(m.id) || !isStr(m.name, 200) || !isStr(m.dir, 1024) || !m.dir || m.engine !== 'claude' || !g || typeof g !== 'object') return null;
      if (!['remote', 'bundle'].includes(g.mode) || !isStr(g.wip, 80) || !/^agent-office\/handoff-[0-9]{8,17}$/.test(g.wip)) return null;
      if (!(g.base === '' || isHex(g.base, 20)) || !(g.root === '' || isHex(g.root, 20)) || !isStr(g.remote, 1000) || /[\s\0]/.test(g.remote)) return null;
      if (!isStr(g.branch, 200) || !/^[A-Za-z0-9._/-]*$/.test(g.branch) || g.branch.includes('..') || g.branch.startsWith('-')) return null;
      if (g.remote.startsWith('-') || (g.mode === 'remote' && !g.remote)) return null;
      if (!pack || pack.size > MAX_PACK || (m.bundle != null && !bundle) || (bundle && bundle.size > MAX_BUNDLE) || (g.mode === 'bundle') !== Boolean(bundle)) return null;
      return { t: 'ho-offer', id: m.id, name: cleanLine(m.name, 60) || '?', dir: m.dir, engine: 'claude', git: { mode: g.mode, wip: g.wip, base: g.base, root: g.root, branch: g.branch, remote: g.remote }, pack, bundle };
    }
    case 'ho-answer':
      return isId(m.id) && typeof m.ok === 'boolean' && (m.reason == null || HANDOFF_REASONS.includes(m.reason)) ? { t: 'ho-answer', id: m.id, ok: m.ok, ...(m.reason ? { reason: m.reason } : {}) } : null;
    case 'ho-chunk':
      return isId(m.id) && (m.part === 'pack' || m.part === 'bundle') && isInt(m.seq, 1e6) && isStr(m.data, Math.ceil(CHUNK / 3) * 4) && /^[A-Za-z0-9+/]*={0,2}$/.test(m.data)
        ? { t: 'ho-chunk', id: m.id, part: m.part, seq: m.seq, data: m.data } : null;
    case 'ho-result':
      return isId(m.id) && typeof m.ok === 'boolean' && (m.reason == null || HANDOFF_REASONS.includes(m.reason)) && (m.applied == null || APPLIED.includes(m.applied))
        ? { t: 'ho-result', id: m.id, ok: m.ok, ...(m.reason ? { reason: m.reason } : {}), ...(m.applied ? { applied: m.applied } : {}) } : null;
    // v3.29 the sender asks again for an outcome it never heard; the receiver answers from its persisted record
    case 'ho-query':
      return isId(m.id) ? { t: 'ho-query', id: m.id } : null;
    case 'ho-status':
      return isId(m.id) && HANDOFF_STATUS.includes(m.status) && (m.reason == null || HANDOFF_REASONS.includes(m.reason)) && (m.applied == null || APPLIED.includes(m.applied))
        ? { t: 'ho-status', id: m.id, status: m.status, ...(m.reason ? { reason: m.reason } : {}), ...(m.applied ? { applied: m.applied } : {}) } : null;
    default:
      return null;
  }
}

// --- the trust list (devices.json; the secrets live apart, encrypted)

/** @typedef {{ pub: string, name: string, addedAt: number, own: boolean, allowHandoff: boolean, allowAccounts: boolean }} Device */
// v3.101 a paired device is the person's own computer: ONE state per device, `own` (false = paused). Every check below
// derives from it. The per-device switches of earlier versions (allowCommands, allowManage, allowSessions, trusted) are
// gone and ignored when read from an older devices.json.
function normalizeDevices(raw) {
  const out = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    if (!d || !isHex(d.pub, 32) || out.some((o) => o.pub === d.pub)) continue;
    out.push({ pub: d.pub, name: deviceName(d.name), addedAt: isInt(d.addedAt) ? d.addedAt : 0, own: d.own !== false,
      allowHandoff: d.allowHandoff === true, allowAccounts: d.allowAccounts === true,   // their own opt-ins, both OFF by default
      // v3.121 a phone controller is never `own` (never a remote office); `ctl` is its sealed state (see sealOwn)
      ...(d.kind === 'controller' ? { kind: 'controller', own: false, allowHandoff: false, allowAccounts: false, ctl: d.ctl !== false } : {}) });
  }
  return out;
}
const OWN_VERSION = 1;   // the marker the host seals with the own set: the migration of older pairings ran
const PAIR_CONFIRM_MS = 2 * 60 * 1000;   // v3.101 a pairing connection waits this long for the two people to confirm
/** v3.101 The keys of the devices that are `own` (paired and not paused): what the host seals inside the keychain-encrypted keys file. */
const ownKeys = (devices) => devices.filter((d) => d.own === true && d.kind !== 'controller').map((d) => d.pub);
/**
 * v3.101 (the v3.97 sealing) The trust list as read from disk. devices.json is a plain file that anything running as
 * this user can edit, so a device is `own` only when its key is also in the sealed set (kept in the encrypted keys
 * file, written only by the app: at pairing, at resume, and once by the migration). Anything else, and a sealed set
 * that is missing or malformed, reads as paused.
 */
function sealOwn(raw, sealed, sealedCtl = []) {
  const ok = new Set(Array.isArray(sealed) ? sealed.filter((k) => isHex(k, 32)) : []);
  const ctl = new Set(Array.isArray(sealedCtl) ? sealedCtl.filter((k) => isHex(k, 32)) : []);
  // v3.121 a controller is sealed the same way, in its own set: an entry devices.json alone claims is inert
  return normalizeDevices(raw).map((d) => (d.kind === 'controller' ? { ...d, ctl: d.ctl && ctl.has(d.pub) } : { ...d, own: d.own && ok.has(d.pub) }));
}
/** v3.121 The keys of the paired phone controllers (sealed next to the own set). */
const ctlKeys = (devices) => devices.filter((d) => d.kind === 'controller' && d.ctl === true).map((d) => d.pub);
/** v3.121 May this device act as a phone controller here (read the controller view, type HQ turns)? */
const isController = (devices, secrets, remotePub) => { const d = trusted(devices, secrets, remotePub); return Boolean(d && d.kind === 'controller' && d.ctl === true); };
/** v3.121 Desktops only: controllers never appear among the remote offices, office_machines or HQ targets. */
const offices = (devices) => devices.filter((d) => d.kind !== 'controller');
/**
 * v3.101 The one-time migration (a keys file without the OWN_VERSION marker): every device paired before this version
 * becomes `own`, whatever its old switches said. → { devices, names } (names: the ones that really are paired, i.e.
 * have a stored secret; the notice lists them).
 */
function migrateOwn(raw, secrets) {
  const devices = normalizeDevices(raw).map((d) => (d.kind === 'controller' ? d : { ...d, own: true }));
  return { devices, names: devices.filter((d) => secrets && isHex(secrets[d.pub], 32)).map((d) => d.name) };
}
/** The trusted device for a remote Noise key, or null. A device without a stored secret is not trusted. */
function trusted(devices, secrets, remotePub) {
  const k = hex(remotePub || '');
  return (secrets && isHex(secrets[k], 32) && devices.find((d) => d.pub === k)) || null;
}
/** v3.101 The one effective state: paired (a stored secret) and not paused. */
const isOwn = (devices, secrets, remotePub) => trusted(devices, secrets, remotePub)?.own === true;
/** v3.101 Is this device in the list and paused? (What it still has queued here is refused when the queue is pumped.) */
const isPaused = (devices, remotePub) => devices.some((d) => d.pub === hex(remotePub || '') && d.own === false && d.kind !== 'controller');
/** May this device type into our tabs (commands and tasks)? Paired and not paused. */
const mayCommand = (devices, secrets, remotePub) => isOwn(devices, secrets, remotePub);
/** v3.97 May a task from this device run in a project that answers or skips its permission prompts? Paired and not paused. */
const mayRunUnattended = (devices, secrets, remotePub) => isOwn(devices, secrets, remotePub);
/** May this device hand us a project? Its own opt-in "Accept handoffs" (v3.29), and never while paused. */
const mayHandoff = (devices, secrets, remotePub) => isOwn(devices, secrets, remotePub) && Boolean(trusted(devices, secrets, remotePub)?.allowHandoff);
/** May this device see our project catalog and start / stop projects (v3.31, v3.33, v3.99 revive)? Paired and not paused. */
const mayManage = (devices, secrets, remotePub) => isOwn(devices, secrets, remotePub);
/** v3.100 May this device read the sessions of our projects? Paired and not paused. */
const maySessions = (devices, secrets, remotePub) => isOwn(devices, secrets, remotePub);
/** May this device work with our accounts? Its own opt-in "Allow account sign-in" (v3.31), and never while paused. */
const mayAccounts = (devices, secrets, remotePub) => isOwn(devices, secrets, remotePub) && Boolean(trusted(devices, secrets, remotePub)?.allowAccounts);

// --- what this device publishes: from the same OfficeData the office renders, nothing else

/**
 * @param {{ id: string, name: string, engine?: string }[]} projects state.projects (with engineOf applied)
 * @param {any} office readOffice's result
 * @param {Map<string, string>} attention projectId → 'permission' | 'done'
 */
function snapshotOf(projects, office, attention = new Map()) {
  const byName = new Map((office?.projects || []).map((p) => [p.name, p]));
  const idOf = new Map(projects.map((p) => [p.name, p.id]));
  const list = projects.slice(0, 50).map((p) => {
    const o = byName.get(p.name) || {};
    // v3.179 `live` is the tab's own state (a GUI chat's open ask / running turn): it counts before the transcript shows it
    const status = (o.waiting || p.live === 'approval') ? 'approval' : (o.isBossBusy || o.working > 0 || p.live === 'working') ? 'working' : 'idle';
    return { id: p.id, name: p.name, engine: p.engine || 'claude', status, working: o.working || 0, delivered: o.delivered || 0, attention: attention.get(p.id) || null, ...(o.waiting?.tool ? { tool: o.waiting.tool } : {}) };
  });
  const workers = (office?.workers || []).filter((w) => idOf.has(w.project)).slice(0, 120).map((w) => ({
    id: String(w.id).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || 'w', project: idOf.get(w.project), type: w.type, description: w.description,
    ...(w.tool ? { tool: w.tool } : {}), ...(w.spawnAt ? { spawnAt: w.spawnAt } : {}), ...(w.doneAt ? { doneAt: w.doneAt, isOk: w.isOk !== false } : {}),
  }));
  return cleanSnapshot({ projects: list, workers, delivered: office?.delivered || 0 });
}

/** v3.46 what one device gets: a device without the manage cap sees no worker descriptions (task text). */
const snapshotFor = (snap, manage) => (manage || !snap?.workers ? snap : { ...snap, workers: snap.workers.map(({ description: _d, ...w }) => w) });

/** One log line for a received command (first line only, never the whole text). */
/**
 * v3.121 What a controller sees of HQ: busy is ROUT.hqBusy's answer ('ready' | 'busy' | 'starting' | 'cold' | ...),
 * attention the HQ tab's attention ('permission' = waiting for an approval).
 */
const ctlHqStatus = (busy, attention) => (attention === 'permission' ? 'approval' : busy === 'busy' || busy === 'starting' ? 'working' : 'idle');
/**
 * v3.121 One controller HQ turn: HQ off → 'no-hq'; an approval prompt open → 'busy'; ready → typed; cold (HQ not
 * running) → started with it as the first prompt; anything else (the person is typing, a turn runs) → 'busy', never
 * queued behind. It carries no "the person typed it" authority (main.js mints no request id for it).
 * @returns {'queued' | 'busy' | 'no-hq'}
 */
function ctlTurn({ enabled = true, busy, approval = false, type, start }) {
  if (!enabled) return 'no-hq';            // HQ is off (or has no project): a phone never starts it
  if (approval) return 'busy';             // an approval prompt is open in HQ: nothing is typed over it
  if (busy === 'ready') return type() !== false ? 'queued' : 'busy';
  if (busy === 'cold') { start(); return 'queued'; }
  return 'busy';
}
const logEntry = (at, device, project, text, outcome) => ({ at: new Date(at).toISOString(), device, project, firstLine: cleanLine(String(text).split(/\r?\n/)[0], 120), outcome });

module.exports = {
  PROTOCOL, CAPS, OUR_CAPS, HEARTBEAT_MS, HEARTBEAT_MISSES, PAIR_TTL_MS, MAX_FRAME, MAX_COMMAND, WORDS, CODE_WORDS, REASONS,
  MAX_BUNDLE, MAX_PACK, CHUNK, HANDOFF_REASONS, HANDOFF_STATUS, PROJ_OPS, PROJ_OP_REASONS,
  makeCode, normalizeCode, pairSecrets, pairProof, proofOk, pairTopic, hex, isHex, MAX_NAME,
  cleanLine, sanitizeCommand, markedCommand, markedTask, cleanReport, fitReport, REPORT_MAX, REPORT2_MAX, REPORT2_COMMITS, TRUNC_MARK, TASK_STATES, WAIT_STATES, TASK_TTL_MAX, deviceName, RateLimiter,
  cleanSnapshot, validateMessage, validatePair, LineReader, encode,
  normalizeDevices, ownKeys, sealOwn, ctlKeys, isController, offices, migrateOwn, isOwn, isPaused, OWN_VERSION, PAIR_CONFIRM_MS, trusted, mayCommand, mayRunUnattended, mayHandoff, mayManage, mayAccounts, maySessions,
  SESS_REASONS, SESS_BACKFILL_ITEMS, SESS_BACKFILL_BYTES, SESS_FRAME_BYTES, SESS_FRAME_ITEMS, SESS_FRAMES_PER_SEC, SESS_PER_DEVICE, SESS_PER_CONTROLLER, SESS_IDLE_MS, SESS_QUEUE_MAX, SESS_OPENS_PER_MIN,
  ctlHqStatus, ctlTurn,
  cleanSessItem, fitSessItem, sessFrames, sessBackfill, snapshotOf, snapshotFor, logEntry,
  cleanRes, cleanCatalog, resOf, resChanged, typingReady,
  LOGIN_HOSTS, LOGIN_REDIRECT, LOGIN_CODE_RE, LOGIN_TIMEOUT_MS, LOGIN_REASONS, loginUrlOk, loginCodeOk, stripAnsi, parseLoginOutput, cleanAccounts,
};
