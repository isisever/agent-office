// Mail (contract v3.83): a minimal IMAP4rev1 client, read only, no dependencies; tested in test/mail.test.cjs against
// a fake server. TLS on connect (993) only. The mailbox is opened with EXAMINE (read only: no flag, no move, no
// expunge can happen) and bodies are fetched with BODY.PEEK, so reading never marks a mail as seen. Login is LOGIN
// (an app password: Gmail, Exchange) or AUTHENTICATE XOAUTH2 (an OAuth token). The password never leaves main.
'use strict';
const tls = require('tls');
const net = require('net');

const TIMEOUT_MS = 30000;
const MAX_FETCH_BYTES = 262144;   // one message read for a model: its first 256 KB
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An IMAP quoted string. */
const quote = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
/** dd-Mon-yyyy for SEARCH SINCE. */
const imapDate = (d) => `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
/** A mailbox name we accept (no quoting games): letters, digits, space, / . _ - [ ]. */
const safeMailbox = (s) => /^[\w ./[\]-]{1,100}$/u.test(String(s)) && !/[\r\n"\\]/.test(String(s));

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
 * Connects and logs in. → a session { list, fetchRaw, close }.
 * @param {{ host: string, port?: number, user: string, password?: string, oauthToken?: string, secure?: boolean, servername?: string, connect?: Function, timeoutMs?: number }} o
 *   secure false is for tests only (a plain socket to a fake server).
 */
function open(o) {
  return new Promise((resolve, reject) => {
    const sock = o.connect ? o.connect() : o.secure === false ? net.connect(o.port || 993, o.host) : tls.connect({ host: o.host, port: o.port || 993, servername: o.servername || o.host });
    let tag = 0;
    const waiting = new Map();   // tag → { untagged: [], resolve, reject }
    let greeted = false;
    let failed = null;
    const timeout = o.timeoutMs || TIMEOUT_MS;
    let timer = setTimeout(() => fail(new Error('timeout')), timeout);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('timeout')), timeout); };
    function fail(e) {
      if (failed) return;
      failed = e;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* gone */ }
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
      if (!greeted) reject(e);
    }
    const read = responseReader((r) => {
      bump();
      if (!greeted) {
        greeted = true;
        if (!/^\* (OK|PREAUTH)/i.test(r.text)) return fail(new Error('greeting'));
        return login().then(() => resolve(session), (e) => { fail(e); reject(e); });
      }
      const m = r.text.match(/^(A\d+) (OK|NO|BAD)\b ?(.*)$/i);
      if (m && waiting.has(m[1])) {
        const w = waiting.get(m[1]);
        waiting.delete(m[1]);
        if (m[2].toUpperCase() === 'OK') w.resolve(w.untagged); else w.reject(Object.assign(new Error(m[2].toUpperCase() === 'NO' ? 'refused' : 'bad'), { detail: m[3].slice(0, 200) }));
        return;
      }
      if (r.text.startsWith('+')) { const w = [...waiting.values()].pop(); if (w?.onContinue) w.onContinue(r); return; }
      for (const w of waiting.values()) w.untagged.push(r);
    });
    sock.on('data', read);
    sock.on('error', (e) => fail(e));
    sock.on('close', () => fail(new Error('closed')));
    sock.setTimeout?.(timeout + 1000, () => fail(new Error('timeout')));

    /** @param {string} text @param {{ onContinue?: Function }} [opts] */
    function command(text, { onContinue } = {}) {
      if (failed) return Promise.reject(failed);
      const t = `A${++tag}`;
      return new Promise((res, rej) => {
        waiting.set(t, { untagged: [], resolve: res, reject: rej, onContinue });
        sock.write(`${t} ${text}\r\n`);
      });
    }
    async function login() {
      if (o.oauthToken) {
        const x = Buffer.from(`user=${o.user}\u0001auth=Bearer ${o.oauthToken}\u0001\u0001`, 'utf8').toString('base64');
        // a failed XOAUTH2 answers with a continuation holding the error: an empty line ends it
        await command(`AUTHENTICATE XOAUTH2 ${x}`, { onContinue: () => sock.write('\r\n') });
      } else await command(`LOGIN ${quote(o.user)} ${quote(o.password || '')}`);
    }
    const session = {
      /**
       * The newest messages of a mailbox (read only). → [{ uid, size, seen, header: Buffer }], newest first.
       * @param {{ mailbox?: string, sinceDays?: number, limit?: number, unseenOnly?: boolean, now?: Date }} q
       */
      async list({ mailbox = 'INBOX', sinceDays = 3, limit = 15, unseenOnly = false, now = new Date() } = {}) {
        if (!safeMailbox(mailbox)) throw new Error('mailbox');
        await command(`EXAMINE ${quote(mailbox)}`);
        const since = new Date(now.getTime() - Math.max(1, Math.min(30, sinceDays)) * 86400000);
        const found = await command(`UID SEARCH SINCE ${imapDate(since)}${unseenOnly ? ' UNSEEN' : ''}`);
        const uids = found.flatMap((r) => (/^\* SEARCH\b/i.test(r.text) ? r.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number) : []));
        const pick = uids.sort((a, b) => b - a).slice(0, Math.max(1, Math.min(50, limit)));
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
        if (!safeMailbox(mailbox) || !Number.isInteger(uid) || uid <= 0) throw new Error('uid');
        await command(`EXAMINE ${quote(mailbox)}`);
        const rows = await command(`UID FETCH ${uid} (UID BODY.PEEK[]<0.${MAX_FETCH_BYTES}>)`);
        const r = rows.find((x) => /^\* \d+ FETCH\b/i.test(x.text) && Number((x.text.match(/\bUID (\d+)/i) || [])[1]) === uid);
        return r?.literals[0] || null;
      },
      async close() {
        try { await Promise.race([command('LOGOUT'), new Promise((res) => setTimeout(res, 2000))]); } catch { /* closing */ }
        clearTimeout(timer);
        try { sock.end(); } catch { /* gone */ }
      },
    };
  });
}

module.exports = { open, responseReader, quote, imapDate, safeMailbox, MAX_FETCH_BYTES };
