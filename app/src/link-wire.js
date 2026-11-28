// Device link wire and pairing protocol (contract v3.28 pairing, v3.121 phone controller), shared by the desktop
// (src/link-core.js, Node crypto) and the iPhone worklet (ios/core, crypto-shim on sodium-native). No Node built-ins,
// no Buffer: crypto is injected by createWire, bytes are Uint8Array, text goes through TextEncoder/TextDecoder.
'use strict';

const PAIR_TTL_MS = 10 * 60 * 1000;      // a pairing code lives 10 minutes
const MAX_FRAME = 64 * 1024;              // one message on the wire (bytes); a longer line closes the connection
const MAX_COMMAND = 8 * 1024;             // a remote command's text (UTF-8 bytes)
const MAX_NAME = 40;                      // device names
const CODE_WORDS = 5;                     // 5 words of 256 = 40 bits, stretched by scrypt (see pairSecrets)
// scrypt parameters of the pairing code: changing any of them breaks pairing with every older build
const PAIR_SALT = 'agent-office/link/pair/v1';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

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
if (WORDS.length !== 256 || new Set(WORDS).size !== 256) throw new Error('link-wire: word list must have 256 distinct words');

// --- bytes and text (no Buffer: the worklet has none)

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8Len = (s) => enc.encode(s).length;
const HEXES = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex = (b) => { let s = ''; for (const x of b) s += HEXES[x]; return s; };
function fromHex(s) {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
const hex = (b) => (typeof b === 'string' ? b : toHex(b));
const isHex = (s, bytes) => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);
const normalizeCode = (text) => {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== CODE_WORDS || !words.every((w) => WORDS.includes(w))) return null;
  return words.join('-');
};

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
/** A device name: one clean line, 1-40 chars, else the fallback. */
const deviceName = (s, fallback = 'Device') => cleanLine(s, MAX_NAME) || fallback;

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= 0 && v <= max;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

// --- framing: one JSON object per line

/** Splits a byte stream into lines; a line longer than MAX_FRAME makes `push` return false (close the stream). */
class LineReader {
  constructor(onLine, max = MAX_FRAME) { this.buf = ''; this.onLine = onLine; this.max = max; }
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : dec.decode(chunk);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (utf8Len(line) > this.max) return false;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      this.onLine(m);
    }
    return utf8Len(this.buf) <= this.max;
  }
}
/** One message as a wire line, or null when it would exceed MAX_FRAME. */
function encode(m) {
  const s = `${JSON.stringify(m)}\n`;
  return utf8Len(s) > MAX_FRAME ? null : s;
}

// --- pairing messages. v3.121: `kind: 'controller'` marks a phone pairing (both sides say it; a mismatch fails)

const KINDS = ['controller'];
/** @returns {null | { t: 'pair-hello', name: string, proof: string, secret?: undefined, kind?: string } | { t: 'pair-ok', name: string, proof: string, secret: string, kind?: string }} */
function validatePair(m) {
  if (!m || typeof m !== 'object') return null;
  const kind = KINDS.includes(m.kind) ? { kind: m.kind } : {};
  if (m.t === 'pair-hello' && isStr(m.name, 200) && typeof m.proof === 'string') return { t: 'pair-hello', name: deviceName(m.name), proof: m.proof, ...kind };
  if (m.t === 'pair-ok' && isStr(m.name, 200) && typeof m.proof === 'string' && isHex(m.secret, 32)) return { t: 'pair-ok', name: deviceName(m.name), proof: m.proof, secret: m.secret, ...kind };
  return null;
}

// --- v3.121 phone controller messages (cap 'ctl'). A controller reads a snapshot and types HQ turns, nothing else.

const CTL_STATUS = ['working', 'idle', 'approval'];
/** v3.121 the caps a phone controller and the desktop exchange in their hello: 'sess' = it reads the HQ session (sess-end). */
const CTL_CAPS = ['ctl', 'sess', 'ctl2'];
const CTL_HQ_STATUS = ['queued', 'delivered', 'rejected'];
const CTL_REASONS = ['not-allowed', 'rate-limited', 'empty', 'too-large', 'not-text', 'no-hq', 'busy', 'offline', 'failed'];
const CTL_PROJECTS = 50;
const CTL_REPORTS = 20;
const CTL_REPORT_TEXT = 4000;
// v3.178 cap 'ctl2': project screen, live session of any project, send, approve and stop from the phone.
const CTL_SESSIONS = 30;
const CTL_ASK_OPTIONS = 8;
const CTL_ASK_KINDS = ['permission', 'question', 'plan'];
const CTL_ACK = ['queued', 'done', 'rejected'];
const CTL_ACK_OPS = ['send', 'answer', 'stop'];
const CTL_ACK_REASONS = ['unknown-project', 'engine', 'not-running', 'busy', 'locked', 'stale', 'too-large', 'empty', 'rate-limited', 'failed', 'not-allowed'];
const CTL_PROJ_ERRORS = ['unknown-project', 'engine', 'rate-limited'];
const ENGINES = ['claude', 'agy', 'commandcode', 'opencode'];

function cleanCtlProject(p) {
  if (!p || !isId(p.id) || !CTL_STATUS.includes(p.status)) return null;
  return {
    id: p.id, name: cleanLine(p.name, 60) || '?', engine: ENGINES.includes(p.engine) ? p.engine : 'claude', status: p.status,
    working: isInt(p.working, 999) ? p.working : 0, sessions: isInt(p.sessions, 999) ? p.sessions : 0,
    attention: p.attention === 'permission' || p.attention === 'done' ? p.attention : null,
    ...(isStr(p.tool, 200) && p.tool ? { tool: cleanLine(p.tool, 60) } : {}),
  };
}
/** The read-only snapshot a controller gets: projects with status and session counts, and the HQ's status. */
function cleanCtlView(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.projects) || v.projects.length > CTL_PROJECTS) return null;
  const projects = v.projects.map(cleanCtlProject);
  if (projects.some((p) => !p)) return null;
  const hq = v.hq && typeof v.hq === 'object' && CTL_STATUS.includes(v.hq.status) ? { status: v.hq.status } : null;
  return { name: deviceName(v.name, 'Agent Office'), projects, hq, delivered: isInt(v.delivered, 999999) ? v.delivered : 0 };
}
function cleanCtlReport(r) {
  if (!r || !isId(r.id) || !isInt(r.at)) return null;
  return { id: r.id, at: r.at, project: cleanLine(r.project, 60), title: cleanLine(r.title, 120),
    summary: String(r.summary ?? '').replace(ESCAPES, '').replace(CONTROLS, '').slice(0, CTL_REPORT_TEXT) };
}

function cleanCtlAsk(a) {
  if (!a || typeof a !== 'object' || !isId(a.askId) || !CTL_ASK_KINDS.includes(a.kind) || !isInt(a.at)) return null;
  const options = Array.isArray(a.options)
    ? a.options.slice(0, CTL_ASK_OPTIONS).map((o) => (o && isId(o.key) ? { key: o.key, label: cleanLine(o.label, 40) } : null)).filter(Boolean) : [];
  return { askId: a.askId, kind: a.kind, at: a.at,
    ...(isStr(a.tool, 200) && a.tool ? { tool: cleanLine(a.tool, 60) } : {}),
    ...(isStr(a.detail, 2000) && a.detail ? { detail: cleanLine(a.detail, 300) } : {}),
    ...(options.length ? { options } : {}) };
}
function cleanCtlSession(s) {
  if (!s || !isId(s.sid) || !isInt(s.at)) return null;
  return { sid: s.sid, title: cleanLine(s.title, 80), at: s.at, running: s.running === true, main: s.main === true };
}
function cleanCtlProj(p) {
  const base = cleanCtlProject({ ...p, sessions: 0, working: 0 });
  if (!base || !Array.isArray(p.sessions)) return null;
  const pending = Array.isArray(p.pending) ? p.pending.slice(0, CTL_ASK_OPTIONS).map(cleanCtlAsk).filter(Boolean) : [];
  return { id: base.id, name: base.name, engine: base.engine, status: base.status, attention: base.attention,
    ...(base.tool ? { tool: base.tool } : {}),
    sessions: p.sessions.slice(0, CTL_SESSIONS).map(cleanCtlSession).filter(Boolean),
    ...(pending.length ? { pending } : {}) };
}

/** Every ctl-* message, validated with size limits; null when malformed. Sent only to and from a peer with cap 'ctl'. */
function validateCtl(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.t) {
    case 'ctl-view': {      // desktop → phone
      const view = cleanCtlView(m.view);
      return isInt(m.seq) && view ? { t: 'ctl-view', seq: m.seq, view } : null;
    }
    case 'ctl-event': {     // desktop → phone: one status change
      const e = m.event;
      if (!isInt(m.seq) || !e || typeof e !== 'object' || !(e.project === 'hq' || isId(e.project)) || !CTL_STATUS.includes(e.status) || !isInt(e.at)) return null;
      return { t: 'ctl-event', seq: m.seq, event: { project: e.project, status: e.status, at: e.at, ...(e.attention === 'permission' || e.attention === 'done' ? { attention: e.attention } : {}) } };
    }
    case 'ctl-hq':          // phone → desktop: one typed HQ turn
      return isId(m.id) && typeof m.text === 'string' && m.text.length <= MAX_COMMAND * 4 ? { t: 'ctl-hq', id: m.id, text: m.text } : null;
    case 'ctl-hq-status':   // desktop → phone
      return isId(m.id) && CTL_HQ_STATUS.includes(m.status) && (m.reason == null || CTL_REASONS.includes(m.reason))
        ? { t: 'ctl-hq-status', id: m.id, status: m.status, ...(m.reason ? { reason: m.reason } : {}) } : null;
    case 'ctl-reports': {   // phone → desktop: a request (no `reports`); desktop → phone: the answer
      if (!isId(m.id)) return null;
      if (m.reports == null) return { t: 'ctl-reports', id: m.id, limit: isInt(m.limit, CTL_REPORTS) && m.limit > 0 ? m.limit : CTL_REPORTS };
      if (!Array.isArray(m.reports) || m.reports.length > CTL_REPORTS) return null;
      return { t: 'ctl-reports', id: m.id, reports: m.reports.map(cleanCtlReport).filter(Boolean) };
    }
    // --- cap 'ctl2'. The caller must drop these from a peer whose hello lacks 'ctl2'.
    case 'ctl-proj': {      // phone → desktop: request {id, project}; desktop → phone: {id, project, proj} or {id, project, error}
      if (!isId(m.id) || !isId(m.project)) return null;
      if (m.proj != null) { const proj = cleanCtlProj(m.proj); return proj ? { t: 'ctl-proj', id: m.id, project: m.project, proj } : null; }
      if (m.error != null) return CTL_PROJ_ERRORS.includes(m.error) ? { t: 'ctl-proj', id: m.id, project: m.project, error: m.error } : null;
      return { t: 'ctl-proj', id: m.id, project: m.project };
    }
    case 'ctl-send':        // phone → desktop
      return isId(m.id) && isId(m.project) && typeof m.text === 'string' && m.text.length <= MAX_COMMAND * 4 ? { t: 'ctl-send', id: m.id, project: m.project, text: m.text } : null;
    case 'ctl-ask': {       // desktop → phone: a pending approval/question
      const ask = cleanCtlAsk(m.ask);
      return isInt(m.seq) && isId(m.project) && ask ? { t: 'ctl-ask', seq: m.seq, project: m.project, ask } : null;
    }
    case 'ctl-ask-clear':   // desktop → phone: answered anywhere
      return isInt(m.seq) && isId(m.project) && isId(m.askId) ? { t: 'ctl-ask-clear', seq: m.seq, project: m.project, askId: m.askId } : null;
    case 'ctl-answer': {    // phone → desktop: exactly one of decision / option / text
      const a = m.answer;
      if (!isId(m.id) || !isId(m.project) || !isId(m.askId) || !a || typeof a !== 'object' || Array.isArray(a)) return null;
      const keys = Object.keys(a);
      if (keys.length !== 1) return null;
      const answer = keys[0] === 'decision' && (a.decision === 'allow' || a.decision === 'deny') ? { decision: a.decision }
        : keys[0] === 'option' && isId(a.option) ? { option: a.option }
        : keys[0] === 'text' && typeof a.text === 'string' && a.text.length <= 2000 ? { text: a.text } : null;
      return answer ? { t: 'ctl-answer', id: m.id, project: m.project, askId: m.askId, answer } : null;
    }
    case 'ctl-stop':        // phone → desktop
      return isId(m.id) && isId(m.project) ? { t: 'ctl-stop', id: m.id, project: m.project } : null;
    case 'ctl-ack':         // desktop → phone: the result of ctl-send / ctl-answer / ctl-stop
      return isId(m.id) && CTL_ACK_OPS.includes(m.op) && CTL_ACK.includes(m.status) && (m.reason == null || CTL_ACK_REASONS.includes(m.reason))
        ? { t: 'ctl-ack', id: m.id, op: m.op, status: m.status, ...(m.reason ? { reason: m.reason } : {}) } : null;
    default:
      return null;
  }
}

/**
 * The parts that need crypto, on an injected implementation of the Node crypto subset createHash('sha256'),
 * createHmac('sha256'), scryptSync, randomBytes and timingSafeEqual (Node's crypto, or ios/core/crypto-shim.js).
 */
function createWire(crypto) {
  /** A fresh one-time pairing code: `word-word-word-word-word`. */
  function makeCode(rand = crypto.randomBytes) {
    return [...rand(CODE_WORDS)].map((b) => WORDS[b]).join('-');
  }
  /**
   * The pairing topic and proof key from a code. scrypt makes guessing a code from the (public) DHT topic
   * cost about 2^40 slow hashes, far longer than the code's 10 minutes.
   */
  function pairSecrets(code) {
    const out = crypto.scryptSync(code, PAIR_SALT, 64, SCRYPT);
    return { topic: out.subarray(0, 32), key: out.subarray(32) };
  }
  /** Proves knowledge of the code, bound to both Noise keys of this connection (so it cannot be replayed elsewhere). */
  function pairProof(key, role, fromPub, toPub) {
    return crypto.createHmac('sha256', key).update(`${role}\n${hex(fromPub)}\n${hex(toPub)}`).digest('hex');
  }
  function proofOk(key, role, fromPub, toPub, proof) {
    if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
    return crypto.timingSafeEqual(fromHex(pairProof(key, role, fromPub, toPub)), fromHex(proof));
  }
  /** The discovery topic of one pair: from the secret only the two devices hold. */
  function pairTopic(secretHex) {
    return crypto.createHash('sha256').update('agent-office/link/topic/v1\n').update(fromHex(secretHex)).digest();
  }
  return { makeCode, pairSecrets, pairProof, proofOk, pairTopic };
}

/** v3.121 The QR payload of a phone pairing: agentoffice://pair?v=1&c=<code>&n=<name>&k=<pub hex>&caps=ctl. */
function pairUrl({ code, name, pub }) {
  return `agentoffice://pair?v=1&c=${encodeURIComponent(code)}&n=${encodeURIComponent(deviceName(name))}&k=${hex(pub)}&caps=ctl`;
}
/** Parses a scanned pairing URL → { code, name, pub, caps } or null. */
function parsePairUrl(text) {
  const m = /^agentoffice:\/\/pair\?(.*)$/.exec(String(text ?? '').trim());
  if (!m || m[1].length > 600) return null;
  const q = {};
  for (const part of m[1].split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { q[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')); } catch { return null; }
  }
  const code = normalizeCode(q.c);
  if (q.v !== '1' || !code || !isHex(q.k, 32)) return null;
  const caps = String(q.caps || '').split(',').filter((c) => c === 'ctl');
  if (!caps.length) return null;
  return { code, name: deviceName(q.n, 'Agent Office'), pub: q.k, caps };
}

module.exports = {
  PAIR_TTL_MS, MAX_FRAME, MAX_COMMAND, MAX_NAME, CODE_WORDS, WORDS, PAIR_SALT, SCRYPT, KINDS,
  CTL_STATUS, CTL_CAPS, CTL_SESSIONS, CTL_ASK_OPTIONS, CTL_ASK_KINDS, CTL_ACK, CTL_ACK_OPS, CTL_ACK_REASONS, CTL_PROJ_ERRORS, CTL_HQ_STATUS, CTL_REASONS, CTL_PROJECTS, CTL_REPORTS, CTL_REPORT_TEXT,
  ESCAPES, CONTROLS, cleanLine, deviceName, isStr, isInt, isId, hex, isHex, toHex, fromHex, utf8Len, normalizeCode,
  LineReader, encode, validatePair, validateCtl, cleanCtlView, createWire, pairUrl, parsePairUrl,
};
