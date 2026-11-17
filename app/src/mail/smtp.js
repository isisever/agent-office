// Mail (contract v3.83): a minimal SMTP client for the one thing main sends: a draft the person approved in the app
// (and `verify`: log in and quit, to test an account before it is saved). No dependencies; tested in
// test/mail.test.cjs against a fake server. TLS on connect (465) or STARTTLS (587, Exchange's client port; the upgrade
// is required: no mail and no password goes out in clear), the certificate checked by net.js. The login method follows
// the server's EHLO: XOAUTH2 with a token; else AUTH PLAIN, else AUTH LOGIN (Exchange and Microsoft 365 offer LOGIN,
// not PLAIN); a server offering neither (NTLM / Kerberos only) → `auth-method`. Never reachable from a session.
'use strict';
const N = require('./net.js');

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
/** The AUTH mechanisms an EHLO answer offers, upper case. */
const authMechs = (ehlo) => (String(ehlo).match(/^AUTH[ =](.*)$/im)?.[1] || '').trim().toUpperCase().split(/\s+/).filter(Boolean);

/**
 * Sends one message, or with `verify` only logs in and quits. → { ok: true, response } | throws a net.js mailError
 * ('auth' | 'auth-method' | 'tls' | 'cert' | 'refused' | 'dns' | 'refused-port' | 'timeout' | 'network' | 'greeting').
 * @param {{ host: string, port?: number, security?: 'tls' | 'starttls', user: string, password?: string, oauthToken?: string, pin?: string,
 *   from?: string, recipients?: string[], raw?: string, verify?: boolean, heloName?: string, secure?: boolean, timeoutMs?: number }} o
 *   secure false: tests only (no TLS at all, also after STARTTLS).
 */
async function send(o) {
  const port = o.port || (o.security === 'starttls' ? 587 : 465);
  const implicit = o.security !== 'starttls';
  const timeout = o.timeoutMs || TIMEOUT_MS;
  let sock = o.secure === false || !implicit ? await N.plainSocket({ host: o.host, port, timeoutMs: timeout }) : await N.secureSocket({ host: o.host, port, pin: o.pin, timeoutMs: timeout });
  let pending = null;
  let failure = null;
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { failure = N.mailError('timeout'); pending?.reject(failure); }, timeout); };
  const onReply = (r) => { arm(); const p = pending; pending = null; p?.resolve(r); };
  const attach = (s) => {
    s.on('data', replyReader(onReply));
    s.on('error', (e) => { failure = N.socketError(e); pending?.reject(failure); });
    s.on('close', () => { failure = failure || N.mailError('closed'); pending?.reject(failure); });
  };
  const expect = () => (failure ? Promise.reject(failure) : new Promise((resolve, reject) => { pending = { resolve, reject }; }));
  const cmd = (line) => { const p = expect(); sock.write(`${line}\r\n`); return p; };
  const must = (r, ok, code) => { if (!ok.includes(r.code)) throw N.mailError(code, `${r.code} ${r.text}`); return r; };
  const helo = o.heloName || 'agent-office.local';
  attach(sock);
  arm();
  try {
    must(await expect(), [220], 'greeting');
    let ehlo = must(await cmd(`EHLO ${helo}`), [250], 'greeting');
    if (!implicit) {
      if (!/^STARTTLS\b/im.test(ehlo.text)) throw N.mailError('tls', 'the server offers no STARTTLS');
      must(await cmd('STARTTLS'), [220], 'tls');
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      if (o.secure !== false) sock = await N.secureSocket({ host: o.host, socket: sock, pin: o.pin, timeoutMs: timeout });
      attach(sock);
      ehlo = must(await cmd(`EHLO ${helo}`), [250], 'greeting');
    }
    const mechs = authMechs(ehlo.text);
    if (o.oauthToken) {
      const x = Buffer.from(`user=${o.user}\u0001auth=Bearer ${o.oauthToken}\u0001\u0001`, 'utf8').toString('base64');
      must(await cmd(`AUTH XOAUTH2 ${x}`), [235], 'auth');
    } else if (mechs.includes('PLAIN')) {
      must(await cmd(`AUTH PLAIN ${Buffer.from(`\u0000${o.user}\u0000${o.password || ''}`, 'utf8').toString('base64')}`), [235], 'auth');
    } else if (mechs.includes('LOGIN')) {
      must(await cmd('AUTH LOGIN'), [334], 'auth-method');
      must(await cmd(Buffer.from(o.user, 'utf8').toString('base64')), [334], 'auth');
      must(await cmd(Buffer.from(o.password || '', 'utf8').toString('base64')), [235], 'auth');
    } else throw N.mailError('auth-method', mechs.length ? `AUTH ${mechs.join(' ')}` : 'no AUTH offered');
    if (o.verify) {
      try { sock.write('QUIT\r\n'); } catch { /* closing */ }
      return { ok: true, response: 'logged in' };
    }
    must(await cmd(`MAIL FROM:<${o.from}>`), [250], 'refused');
    for (const rcpt of o.recipients || []) must(await cmd(`RCPT TO:<${rcpt}>`), [250, 251], 'refused');
    must(await cmd('DATA'), [354], 'refused');
    const final = expect();
    sock.write(dotStuff(o.raw || ''));
    const r = must(await final, [250], 'refused');
    try { sock.write('QUIT\r\n'); } catch { /* closing */ }
    return { ok: true, response: r.text.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    try { sock.end(); } catch { /* gone */ }
  }
}

module.exports = { send, replyReader, dotStuff, authMechs };
