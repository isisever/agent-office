// Mail (contract v3.85): a minimal IMAP4rev1 client, read only, no dependencies; tested in test/mail.test.cjs against
// a fake server. TLS on connect (993), the certificate checked by net.js (system trust or the account's pinned one).
// The mailbox is opened with EXAMINE (read only: no flag, no move, no expunge can happen) and bodies are fetched with
// BODY.PEEK, so reading never marks a mail as seen (v3.93: folders are created, renamed, emptied-and-removed and mails
// moved only for an organizing plan the person approved; see src/mail/folders.js). Login follows the server's
// CAPABILITY: XOAUTH2 with an OAuth token; else AUTHENTICATE PLAIN when offered (any characters in the password;
// Exchange and Gmail offer it over TLS); else LOGIN, unless the server says LOGINDISABLED (Exchange Online: OAuth
// only → `login-disabled`). The password never leaves main.
'use strict';
const N = require('./net.js');

const TIMEOUT_MS = 30000;
const MAX_FETCH_BYTES = 262144;   // one message read for a model: its first 256 KB
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An IMAP quoted string (7-bit; a password with other characters goes through AUTHENTICATE PLAIN). */
const quote = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
/** dd-Mon-yyyy for SEARCH SINCE. */
const imapDate = (d) => `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
/** A mailbox name we accept, in its IMAP form (modified UTF-7 is ASCII): printable, no quote, backslash or wildcard. */
const safeMailbox = (s) => /^[\x20-\x7e]{1,300}$/.test(String(s)) && !/["\\*%]/.test(String(s));
/** One `* LIST (flags) "delim" name` line → { name (IMAP form), delim, flags } or null; the name may be a literal. */
function listLine(r) {
  const m = r.text.match(/^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\]|\\.)*") (.*)$/i);
  if (!m) return null;
  const delim = m[2].toUpperCase() === 'NIL' ? '' : m[2].slice(1, -1).replace(/\\(.)/g, '$1');
  let name = m[3].trim();
  // eslint-disable-next-line no-control-regex
  const lit = name.match(/^(?:\{\d+\})?\u0000(\d+)\u0000$/);
  if (lit) name = (r.literals[Number(lit[1])] || Buffer.alloc(0)).toString('utf8');
  else if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return { name, delim, flags: m[1].split(/\s+/).filter(Boolean) };
}
/** CAPABILITY words, upper case, from a greeting's [CAPABILITY …] or a * CAPABILITY line. */
const capsOf = (text) => {
  const m = String(text).match(/\bCAPABILITY ([^\]\r\n]*)/i);
  return m ? m[1].trim().toUpperCase().split(/\s+/) : [];
};

/**
 * Splits the server's bytes into responses: each a { text, literals } where a `{n}` literal's bytes are collected.
 * Feed it chunks; it calls onResponse for each complete one.
 */
function responseReader(onResponse) {
  let buf = Buffer.alloc(0);
  let cur = null;          // { text, literals, need }
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (cur && cur.need > 0) {
        if (buf.length < cur.need) return;
        cur.literals.push(buf.subarray(0, cur.need));
        buf = buf.subarray(cur.need);
        cur.need = 0;
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 2);
      if (!cur) cur = { text: '', literals: [], need: 0 };
      cur.text += line;
      const m = line.match(/\{(\d+)\}$/);
      if (m) { cur.need = Number(m[1]); cur.text += `\u0000${cur.literals.length}\u0000`; if (cur.need === 0) cur.literals.push(Buffer.alloc(0)); continue; }
      const done = cur;
      cur = null;
      onResponse(done);
    }
  };
}

/**
 * Connects, checks the certificate, logs in. → a session { list, fetchRaw, close, caps }.
 * @param {{ host: string, port?: number, user: string, password?: string, oauthToken?: string, pin?: string, secure?: boolean, timeoutMs?: number }} o
 *   secure false is for tests only (a plain socket to a fake server).
 */
async function open(o) {
  const timeout = o.timeoutMs || TIMEOUT_MS;
  const sock = o.secure === false ? await N.plainSocket({ host: o.host, port: o.port || 993, timeoutMs: timeout })
    : await N.secureSocket({ host: o.host, port: o.port || 993, pin: o.pin, timeoutMs: timeout });
  let tag = 0;
  const waiting = new Map();   // tag → { untagged: [], resolve, reject, onContinue }
  let greeting = null;
  let failed = null;
  let timer = null;
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => fail(N.mailError('timeout')), timeout); };
  function fail(e) {
    if (failed) return;
    failed = e;
    clearTimeout(timer);
    try { sock.destroy(); } catch { /* gone */ }
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    greeting?.reject(e);
  }
  const greeted = new Promise((resolve, reject) => { greeting = { resolve, reject }; });
  const read = responseReader((r) => {
    bump();
    if (greeting) {
      const g = greeting;
      greeting = null;
      if (/^\* (OK|PREAUTH)/i.test(r.text)) g.resolve(r.text); else g.reject(N.mailError('greeting', r.text));
      return;
    }
    const m = r.text.match(/^(A\d+) (OK|NO|BAD)\b ?(.*)$/i);
    if (m && waiting.has(m[1])) {
      const w = waiting.get(m[1]);
      waiting.delete(m[1]);
      if (m[2].toUpperCase() === 'OK') w.resolve(w.untagged); else w.reject(N.mailError(m[2].toUpperCase() === 'NO' ? 'refused' : 'bad', m[3]));
      return;
    }
    if (r.text.startsWith('+')) { const w = [...waiting.values()].pop(); if (w?.onContinue) w.onContinue(r); return; }
    for (const w of waiting.values()) w.untagged.push(r);
  });
  sock.on('data', read);
  sock.on('error', (e) => fail(N.socketError(e)));
  sock.on('close', () => fail(N.mailError('closed')));
  bump();

  /** @param {string} text @param {{ onContinue?: Function, show?: string }} [opts] show: the line as logged/echoed (never a secret) */
  function command(text, { onContinue } = {}) {
    if (failed) return Promise.reject(failed);
    const t = `A${++tag}`;
    return new Promise((res, rej) => {
      waiting.set(t, { untagged: [], resolve: res, reject: rej, onContinue });
      sock.write(`${t} ${text}\r\n`);
    });
  }
  const greet = await greeted;
  let caps = capsOf(greet);
  if (!caps.length) caps = capsOf((await command('CAPABILITY')).map((r) => r.text).join('\n'));
  const login = async () => {
    if (o.oauthToken) {
      const x = Buffer.from(`user=${o.user}\u0001auth=Bearer ${o.oauthToken}\u0001\u0001`, 'utf8').toString('base64');
      // a failed XOAUTH2 answers with a continuation holding the error: an empty line ends it
      return command(`AUTHENTICATE XOAUTH2 ${x}`, { onContinue: () => sock.write('\r\n') });
    }
    const plain = Buffer.from(`\u0000${o.user}\u0000${o.password || ''}`, 'utf8').toString('base64');
    if (caps.includes('AUTH=PLAIN')) {
      if (caps.includes('SASL-IR')) return command(`AUTHENTICATE PLAIN ${plain}`);
      return command('AUTHENTICATE PLAIN', { onContinue: () => sock.write(`${plain}\r\n`) });
    }
    if (caps.includes('LOGINDISABLED')) throw N.mailError('login-disabled', caps.filter((c) => c.startsWith('AUTH=')).join(' '));
    // LOGIN takes quoted 7-bit strings only
    if (/[^\x20-\x7e]/.test(`${o.user}${o.password || ''}`)) throw N.mailError('auth-method', 'non-ASCII password without AUTH=PLAIN');
    return command(`LOGIN ${quote(o.user)} ${quote(o.password || '')}`);
  };
  try { await login(); } catch (e) {
    fail(e);
    throw e.message === 'refused' || e.message === 'bad' ? N.mailError('auth', e.detail) : e;
  }
  const session = {
    caps,
    /**
     * The newest messages of a mailbox (read only). → [{ uid, size, seen, header: Buffer }], newest first.
     * @param {{ mailbox?: string, sinceDays?: number, limit?: number, unseenOnly?: boolean, now?: Date }} q
     */
    async list({ mailbox = 'INBOX', sinceDays = 3, limit = 15, unseenOnly = false, now = new Date() } = {}) {
      if (!safeMailbox(mailbox)) throw N.mailError('mailbox');
      await command(`EXAMINE ${quote(mailbox)}`).catch((e) => { throw N.mailError('mailbox', e.detail); });
      const since = new Date(now.getTime() - Math.max(1, Math.min(365, sinceDays)) * 86400000);
      const found = await command(`UID SEARCH SINCE ${imapDate(since)}${unseenOnly ? ' UNSEEN' : ''}`);
      const uids = found.flatMap((r) => (/^\* SEARCH\b/i.test(r.text) ? r.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number) : []));
      const pick = uids.sort((a, b) => b - a).slice(0, Math.max(1, Math.min(100, limit)));
      if (!pick.length) return [];
      const rows = await command(`UID FETCH ${pick.join(',')} (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])`);
      return rows.filter((r) => /^\* \d+ FETCH\b/i.test(r.text)).map((r) => ({
        uid: Number((r.text.match(/\bUID (\d+)/i) || [])[1]),
        size: Number((r.text.match(/\bRFC822\.SIZE (\d+)/i) || [])[1] || 0),
        seen: /\bFLAGS \([^)]*\\Seen/i.test(r.text),
        header: r.literals[0] || Buffer.alloc(0),
      })).filter((x) => x.uid > 0).sort((a, b) => b.uid - a.uid);
    },
    /** One message's first bytes (read only). → Buffer, or null when there is no such uid. */
    async fetchRaw({ mailbox = 'INBOX', uid }) {
      if (!safeMailbox(mailbox) || !Number.isInteger(uid) || uid <= 0) throw N.mailError('not-found');
      await command(`EXAMINE ${quote(mailbox)}`).catch((e) => { throw N.mailError('mailbox', e.detail); });
      const rows = await command(`UID FETCH ${uid} (UID BODY.PEEK[]<0.${MAX_FETCH_BYTES}>)`);
      const r = rows.find((x) => /^\* \d+ FETCH\b/i.test(x.text) && Number((x.text.match(/\bUID (\d+)/i) || [])[1]) === uid);
      return r?.literals[0] || null;
    },
    // ---- v3.93 folders: listing is read only; the rest runs only for a plan the person approved (main: mail:planRun)
    /** Every folder: [{ name (IMAP form), delim, flags }]. */
    async folders() {
      const rows = await command('LIST "" "*"');
      return rows.map(listLine).filter(Boolean);
    },
    /** CREATE a folder (its IMAP name). */
    async create(name) {
      if (!safeMailbox(name)) throw N.mailError('mailbox');
      await command(`CREATE ${quote(name)}`).catch((e) => { throw N.mailError('mailbox', e.detail); });
    },
    /** RENAME a folder (IMAP names). */
    async rename(from, to) {
      if (!safeMailbox(from) || !safeMailbox(to)) throw N.mailError('mailbox');
      await command(`RENAME ${quote(from)} ${quote(to)}`).catch((e) => { throw N.mailError('mailbox', e.detail); });
    },
    /** DELETE a folder only when STATUS says it holds no message. → 'removed' | 'not-empty' */
    async removeEmpty(name) {
      if (!safeMailbox(name)) throw N.mailError('mailbox');
      const st = await command(`STATUS ${quote(name)} (MESSAGES)`).catch((e) => { throw N.mailError('mailbox', e.detail); });
      const n = st.map((r) => r.text.match(/\(.*\bMESSAGES (\d+)/i)).find(Boolean);
      if (!n || Number(n[1]) !== 0) return 'not-empty';
      await command(`DELETE ${quote(name)}`).catch((e) => { throw N.mailError('mailbox', e.detail); });
      return 'removed';
    },
    /**
     * Moves mails (uids) from one folder to another. → { moved: uids, missing: uids }. UID MOVE when the server has
     * MOVE; else UID COPY, then \Deleted and UID EXPUNGE on exactly those uids (UIDPLUS); a server with neither is
     * refused (`no-move`): a plain EXPUNGE would also remove mails someone else marked deleted.
     */
    async move(from, uids, to) {
      if (!safeMailbox(from) || !safeMailbox(to)) throw N.mailError('mailbox');
      const want = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0);
      if (!want.length) return { moved: [], missing: [] };
      const canMove = caps.includes('MOVE');
      if (!canMove && !caps.includes('UIDPLUS')) throw N.mailError('no-move');
      await command(`SELECT ${quote(from)}`).catch((e) => { throw N.mailError('mailbox', e.detail); });
      const found = await command(`UID FETCH ${want.join(',')} (UID)`);
      const here = new Set(found.map((r) => Number((r.text.match(/^\* \d+ FETCH \(.*\bUID (\d+)/i) || [])[1])).filter((u) => u > 0));
      const moved = want.filter((u) => here.has(u));
      for (let i = 0; i < moved.length; i += 100) {
        const set = moved.slice(i, i + 100).join(',');
        if (canMove) await command(`UID MOVE ${set} ${quote(to)}`).catch((e) => { throw N.mailError('refused', e.detail); });
        else {
          await command(`UID COPY ${set} ${quote(to)}`).catch((e) => { throw N.mailError('refused', e.detail); });
          await command(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
          await command(`UID EXPUNGE ${set}`);
        }
      }
      return { moved, missing: want.filter((u) => !here.has(u)) };
    },
    async close() {
      try { await Promise.race([command('LOGOUT'), new Promise((res) => setTimeout(res, 2000))]); } catch { /* closing */ }
      clearTimeout(timer);
      failed = failed || N.mailError('closed');
      try { sock.end(); } catch { /* gone */ }
    },
  };
  return session;
}

module.exports = { open, responseReader, quote, imapDate, safeMailbox, capsOf, listLine, MAX_FETCH_BYTES };
