// Device link (contract v3.28, v3.31 capabilities, v3.32 res/catalog, v3.33 proj-op): the pure parts. Pairing codes, topics, message schema, command sanitizing, rate
// limits and trust checks. No Electron, no network; src/link.js does the networking, main.js the glue.
'use strict';
const crypto = require('crypto');

// v3.31: 2 = hello carries the app version and capabilities; a v1 peer gets no message type it does not know
const PROTOCOL = 2;
// what a peer may say it understands (hello.caps); unknown names are dropped
const CAPS = ['res', 'catalog', 'manage', 'accounts', 'report'];
// what this build sends and understands (v3.32: res and catalog)
const OUR_CAPS = ['res', 'catalog', 'report', 'manage', 'accounts'];   // v3.35 adds 'report', v3.33 'manage' (proj-op), v3.34 'accounts' (login relay)
// v3.33 what a device allowed to manage may do to a project's boss tab here (proj-op), and why it may be refused
const PROJ_OPS = ['start', 'wake', 'sleep', 'stop'];
const PROJ_OP_REASONS = ['not-allowed', 'unknown-project', 'engine', 'busy', 'locked', 'rate-limited', 'removed', 'offline', 'no-manage', 'timeout', 'failed'];
// a trusted session pings every HEARTBEAT_MS; HEARTBEAT_MISSES intervals without any data from the peer close it
// (a quit or crash may never close the stream: UDX alone took ~17 s to notice)
const HEARTBEAT_MS = 5000;
const HEARTBEAT_MISSES = 3;
const PAIR_TTL_MS = 10 * 60 * 1000;      // a pairing code lives 10 minutes
const MAX_FRAME = 64 * 1024;              // one message on the wire (bytes); a longer line closes the connection
const MAX_COMMAND = 8 * 1024;             // a remote command's text (UTF-8 bytes)
const MAX_NAME = 40;                      // device names
const CODE_WORDS = 5;                     // 5 words of 256 = 40 bits, stretched by scrypt (see pairSecrets)
// project handoff (contract v3.29)
const MAX_BUNDLE = 200 * 1024 * 1024;     // a git bundle sent over the link
const MAX_PACK = 100 * 1024 * 1024;       // the session data (transcripts, memory, facts, settings)
const CHUNK = 32 * 1024;                  // bytes per ho-chunk (base64 keeps the line under MAX_FRAME)
const HANDOFF_REASONS = ['declined', 'not-allowed', 'busy', 'engine', 'not-git', 'offline', 'too-large', 'bad-data', 'checksum', 'apply-failed', 'timeout', 'in-progress', 'cancelled', 'unknown-project', 'changed', 'subfolder', 'push-declined', 'push-failed'];
const APPLIED = ['restored', 'branch-only'];
const HANDOFF_STATUS = ['applied', 'not-applied', 'unknown'];

// 256 short, distinct, easy-to-type English words: a code word is one byte.
const WORDS = (
  'acid aged also area army away baby back bake ball band bank barn base bath bead beam bean bear beef bell belt ' +
  'bend best bike bird bite blue boat body bold bone book boot bowl brew bulb bush cake calm camp card care cart ' +
  'case cash cave cell chef chin city clay clip club coal coat code coin cold cook cool copy cord corn cost crab ' +
  'crew crop cube cure dark dart dash data dawn deal deck deep deer desk dial dice dish dock door dove draw drum ' +
  'duck dune dust easy edge epic exit face fact fair farm fast fern film fire fish flag flat flow foam fold folk ' +
  'food fork form fort frog fuel game gate gear gift glow glue goat gold golf good gown grid grin gulf hair half ' +
  'hall hand harp hawk heat herb hero hill hint hive hold hole home hood hook horn host hour huge icon idea inch ' +
  'iron item jade jazz join joke jump keen kelp kept kick kind king kite knee knot lace lady lake lamb lamp land ' +
  'lane lark lava lawn leaf lens life lime line link lion list loaf loft logo loop lord luck lung mail main malt ' +
  'mane mask meal meat menu mild milk mill mint mist mode moon moss moth mule nail navy neck nest news nice node ' +
  'note oath oven pack page palm park path peak pear pine pink pipe plan plum poem pond pony pool port pull pump ' +
  'quiz raft rail rain ramp reed reef rice ring road robe rock roof room rope rose ruby sage sail salt sand seal ' +
  'seed ship silk sink snow soap sock sofa soil song soup star stem swan tail tank team tent tide tile toad tree'
).split(' ').slice(0, 256);
if (WORDS.length !== 256 || new Set(WORDS).size !== 256) throw new Error('link-core: word list must have 256 distinct words');

/** A fresh one-time pairing code: `word-word-word-word-word`. */
function makeCode(rand = crypto.randomBytes) {
  return [...rand(CODE_WORDS)].map((b) => WORDS[b]).join('-');
}

/** A typed code in canonical form, or null when it is not a valid code (any separator, any case). */
function normalizeCode(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== CODE_WORDS || !words.every((w) => WORDS.includes(w))) return null;
  return words.join('-');
}

/**
 * The pairing topic and proof key from a code. scrypt makes guessing a code from the (public) DHT topic
 * cost about 2^40 slow hashes, far longer than the code's 10 minutes.
 */
function pairSecrets(code) {
  const out = crypto.scryptSync(code, 'agent-office/link/pair/v1', 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { topic: out.subarray(0, 32), key: out.subarray(32) };
}

/** Proves knowledge of the code, bound to both Noise keys of this connection (so it cannot be replayed elsewhere). */
function pairProof(key, role, fromPub, toPub) {
  return crypto.createHmac('sha256', key).update(`${role}\n${hex(fromPub)}\n${hex(toPub)}`).digest('hex');
}
function proofOk(key, role, fromPub, toPub, proof) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return crypto.timingSafeEqual(Buffer.from(pairProof(key, role, fromPub, toPub), 'hex'), Buffer.from(proof, 'hex'));
}

/** The discovery topic of one pair: from the secret only the two devices hold. */
function pairTopic(secretHex) {
  return crypto.createHash('sha256').update('agent-office/link/topic/v1\n').update(Buffer.from(secretHex, 'hex')).digest();
}

const hex = (b) => (typeof b === 'string' ? b : Buffer.from(b).toString('hex'));
const isHex = (s, bytes) => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);

// --- text hygiene

// ESC sequences (CSI, OSC, DCS/APC/PM/SOS strings, two-byte escapes) and C1 CSI, then every other control char
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One display line: no escapes or control characters, collapsed spaces, at most `max` characters. */
function cleanLine(s, max) {
  const t = String(s ?? '').replace(ESCAPES, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

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
/** A task report as it may cross the link: { ok, partial, summary ≤16 KB, commits ≤12 { hash, subject }, at }, or null. */
function cleanReport(r) {
  if (!r || typeof r !== 'object' || typeof r.summary !== 'string' || r.summary.length > REPORT_MAX * 2) return null;
  const summary = r.summary.replace(ESCAPES, '').replace(CONTROLS, ' ').slice(0, REPORT_MAX);
  const commits = (Array.isArray(r.commits) ? r.commits : []).slice(0, REPORT_COMMITS)
    .filter((c) => c && typeof c.hash === 'string' && /^[0-9a-f]{4,40}$/.test(c.hash))
    .map((c) => ({ hash: c.hash, subject: cleanLine(c.subject, 120) }));
  return { ok: r.ok !== false, partial: r.partial === true, summary, commits, at: isInt(r.at) ? r.at : 0 };
}

/** A device name: one clean line, 1-40 chars, else the fallback. */
const deviceName = (s, fallback = 'Device') => cleanLine(s, MAX_NAME) || fallback;

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
const REASONS = ['not-allowed', 'unknown-project', 'engine', 'not-running', 'too-large', 'empty', 'not-text', 'rate-limited', 'queue-full', 'expired', 'removed', 'logged-out', 'offline', 'no-report', 'locked'];   // v3.35 reasons go only to peers with cap 'report'
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= 0 && v <= max;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

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
    projects.push({ id: p.id, dirName: cleanLine(p.dirName, 80) || '?', state: p.state, engine: ENGINES.includes(p.engine) ? p.engine : 'claude', accountLabel: cleanLine(p.accountLabel, 40) });
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
      return res ? { t: 'res', res } : null;
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
      return isId(m.id) && isId(m.project) && typeof m.text === 'string' && m.text.length <= MAX_COMMAND * 4 ? { t: 'cmd', id: m.id, project: m.project, text: m.text, ...(m.report === true ? { report: true } : {}) } : null;
    case 'cmd-report': {   // v3.35, only to a peer with cap 'report'
      const report = cleanReport(m);
      return isId(m.id) && report ? { t: 'cmd-report', id: m.id, ...report } : null;
    }
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

function validatePair(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'pair-hello' && isStr(m.name, 200) && typeof m.proof === 'string') return { t: 'pair-hello', name: deviceName(m.name), proof: m.proof };
  if (m.t === 'pair-ok' && isStr(m.name, 200) && typeof m.proof === 'string' && isHex(m.secret, 32)) return { t: 'pair-ok', name: deviceName(m.name), proof: m.proof, secret: m.secret };
  return null;
}

/** Splits a byte stream into lines; a line longer than MAX_FRAME makes `push` return false (close the stream). */
class LineReader {
  constructor(onLine, max = MAX_FRAME) { this.buf = ''; this.onLine = onLine; this.max = max; }
  push(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (Buffer.byteLength(line) > this.max) return false;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      this.onLine(m);
    }
    return Buffer.byteLength(this.buf) <= this.max;
  }
}
/** One message as a wire line, or null when it would exceed MAX_FRAME. */
function encode(m) {
  const s = `${JSON.stringify(m)}\n`;
  return Buffer.byteLength(s) > MAX_FRAME ? null : s;
}

// --- the trust list (devices.json; the secrets live apart, encrypted)

/** @typedef {{ pub: string, name: string, addedAt: number, allowCommands: boolean, allowHandoff: boolean, allowManage: boolean, allowAccounts: boolean }} Device */
function normalizeDevices(raw) {
  const out = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    if (!d || !isHex(d.pub, 32) || out.some((o) => o.pub === d.pub)) continue;
    out.push({ pub: d.pub, name: deviceName(d.name), addedAt: isInt(d.addedAt) ? d.addedAt : 0, allowCommands: d.allowCommands === true, allowHandoff: d.allowHandoff === true,
      allowManage: d.allowManage === true, allowAccounts: d.allowAccounts === true });   // v3.31, both OFF by default
  }
  return out;
}
/** The trusted device for a remote Noise key, or null. A device without a stored secret is not trusted. */
function trusted(devices, secrets, remotePub) {
  const k = hex(remotePub || '');
  return (secrets && isHex(secrets[k], 32) && devices.find((d) => d.pub === k)) || null;
}
/** May this device type into our tabs? Only a trusted device with the toggle on. */
const mayCommand = (devices, secrets, remotePub) => Boolean(trusted(devices, secrets, remotePub)?.allowCommands);
/** May this device hand us a project? Only a trusted device with "Accept handoffs" on (v3.29). */
const mayHandoff = (devices, secrets, remotePub) => Boolean(trusted(devices, secrets, remotePub)?.allowHandoff);
/** May this device see our project catalog (and, later, manage projects)? "Allow managing projects" on (v3.31). */
const mayManage = (devices, secrets, remotePub) => Boolean(trusted(devices, secrets, remotePub)?.allowManage);
/** May this device work with our accounts (later phases)? "Allow account sign-in" on (v3.31). */
const mayAccounts = (devices, secrets, remotePub) => Boolean(trusted(devices, secrets, remotePub)?.allowAccounts);

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
    const status = o.waiting ? 'approval' : (o.isBossBusy || o.working > 0) ? 'working' : 'idle';
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
const logEntry = (at, device, project, text, outcome) => ({ at: new Date(at).toISOString(), device, project, firstLine: cleanLine(String(text).split(/\r?\n/)[0], 120), outcome });

module.exports = {
  PROTOCOL, CAPS, OUR_CAPS, HEARTBEAT_MS, HEARTBEAT_MISSES, PAIR_TTL_MS, MAX_FRAME, MAX_COMMAND, WORDS, CODE_WORDS, REASONS,
  MAX_BUNDLE, MAX_PACK, CHUNK, HANDOFF_REASONS, HANDOFF_STATUS, PROJ_OPS, PROJ_OP_REASONS,
  makeCode, normalizeCode, pairSecrets, pairProof, proofOk, pairTopic, hex, isHex,
  cleanLine, sanitizeCommand, markedCommand, markedTask, cleanReport, REPORT_MAX, deviceName, RateLimiter,
  cleanSnapshot, validateMessage, validatePair, LineReader, encode,
  normalizeDevices, trusted, mayCommand, mayHandoff, mayManage, mayAccounts, snapshotOf, snapshotFor, logEntry,
  cleanRes, cleanCatalog, resOf, resChanged, typingReady,
  LOGIN_HOSTS, LOGIN_REDIRECT, LOGIN_CODE_RE, LOGIN_TIMEOUT_MS, LOGIN_REASONS, loginUrlOk, loginCodeOk, stripAnsi, parseLoginOutput, cleanAccounts,
};
