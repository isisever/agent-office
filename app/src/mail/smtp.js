// Mail (contract v3.83): a minimal SMTP client for the one thing main sends: a draft the person approved in the app.
// No dependencies; tested in test/mail.test.cjs against a fake server. TLS on connect (465) or STARTTLS (587, and the
// upgrade is required: no mail goes out in clear). AUTH PLAIN with an app password, or XOAUTH2 with a token. Never
// reachable from a session: no MCP tool sends.
'use strict';
const tls = require('tls');
const net = require('net');

const TIMEOUT_MS = 30000;

/** Lines of replies → one reply per complete multi-line answer: { code, text }. */
function replyReader(onReply) {
  let buf = '';
  let lines = [];
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        onReply({ code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') });
        lines = [];
      }
    }
  };
}

/** "." at a line start doubled (RFC 5321 4.5.2); the message ends with CRLF.CRLF. */
const dotStuff = (raw) => `${raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}${raw.endsWith('\n') ? '' : '\r\n'}.\r\n`;

/**
 * Sends one message. → { ok: true, response } | throws Error('auth' | 'refused' | 'tls' | 'timeout' | …) with `detail`.
 * @param {{ host: string, port?: number, security?: 'tls' | 'starttls', user: string, password?: string, oauthToken?: string,
 *   from: string, recipients: string[], raw: string, heloName?: string, secure?: boolean, connect?: Function, upgrade?: Function, timeoutMs?: number }} o
 *   secure false / connect / upgrade: tests only.
 */
function send(o) {
  return new Promise((resolve, reject) => {
    const port = o.port || (o.security === 'starttls' ? 587 : 465);
    const implicit = o.security !== 'starttls';
    let sock = o.connect ? o.connect() : (o.secure === false || !implicit) ? net.connect(port, o.host) : tls.connect({ host: o.host, port, servername: o.host });
    const timeout = o.timeoutMs || TIMEOUT_MS;
    let timer = setTimeout(() => done(new Error('timeout')), timeout);
    let finished = false;
    let pending = null;
    const done = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.end(); } catch { /* gone */ }
      if (err) reject(err); else resolve(value);
    };
    const expect = () => new Promise((res) => { pending = res; });
    const onReply = (r) => { clearTimeout(timer); timer = setTimeout(() => done(new Error('timeout')), timeout); const p = pending; pending = null; p?.(r); };
    const attach = (s) => { s.on('data', replyReader(onReply)); s.on('error', (e) => done(Object.assign(new Error('network'), { detail: e.message }))); };
    attach(sock);
    const cmd = (line) => { sock.write(`${line}\r\n`); return expect(); };
    const must = (r, ok, err) => { if (!ok.includes(r.code)) throw Object.assign(new Error(err), { detail: `${r.code} ${r.text}`.slice(0, 300) }); return r; };
    const helo = o.heloName || 'agent-office.local';
    (async () => {
      must(await expect(), [220], 'greeting');
      let ehlo = must(await cmd(`EHLO ${helo}`), [250], 'ehlo');
      if (!implicit) {
        if (!/\bSTARTTLS\b/i.test(ehlo.text)) throw new Error('tls');
        must(await cmd('STARTTLS'), [220], 'tls');
        const plain = sock;
        plain.removeAllListeners('data');
        sock = o.upgrade ? o.upgrade(plain) : tls.connect({ socket: plain, servername: o.host });
        attach(sock);
        if (!o.upgrade) await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        ehlo = must(await cmd(`EHLO ${helo}`), [250], 'ehlo');
      }
      if (o.oauthToken) {
        const x = Buffer.from(`user=${o.user}\u0001auth=Bearer ${o.oauthToken}\u0001\u0001`, 'utf8').toString('base64');
        must(await cmd(`AUTH XOAUTH2 ${x}`), [235], 'auth');
      } else {
        const p = Buffer.from(`\u0000${o.user}\u0000${o.password || ''}`, 'utf8').toString('base64');
        must(await cmd(`AUTH PLAIN ${p}`), [235], 'auth');
      }
      must(await cmd(`MAIL FROM:<${o.from}>`), [250], 'refused');
      for (const rcpt of o.recipients) must(await cmd(`RCPT TO:<${rcpt}>`), [250, 251], 'refused');
      must(await cmd('DATA'), [354], 'refused');
      sock.write(dotStuff(o.raw));
      const final = must(await expect(), [250], 'refused');
      try { sock.write('QUIT\r\n'); } catch { /* closing */ }
      done(null, { ok: true, response: final.text.slice(0, 200) });
    })().catch((e) => done(e));
  });
}

module.exports = { send, replyReader, dotStuff };
