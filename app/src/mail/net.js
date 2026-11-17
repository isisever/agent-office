// Mail (contract v3.83 amendment): the TLS connection both clients use, and what its failures mean. No dependencies;
// tested in test/mail.test.cjs. A server certificate must be valid for the host (the system's trust store) or be
// the exact certificate the person trusted for this account (`pin`: its SHA-256 fingerprint, for an Exchange server
// with the company's own certificate authority). Nothing is written to the socket before that check passed.
'use strict';
const tls = require('tls');
const net = require('net');

/** An Error with a code the UI knows and a short detail (never a secret). */
const mailError = (code, detail = '', extra = {}) => Object.assign(new Error(code), { detail: String(detail || '').replace(/[\r\n]+/g, ' ').slice(0, 300), ...extra });

/** What a failed connection means: dns | refused-port | timeout | network (other socket errors). */
function socketError(e) {
  const c = e?.code || '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return mailError('dns', e.hostname || '');
  if (c === 'ECONNREFUSED') return mailError('refused-port', `${e.address || ''}:${e.port || ''}`);
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET' && /timed out/i.test(e.message)) return mailError('timeout');
  if (e?.message === 'timeout') return mailError('timeout');
  return mailError('network', e?.message || c);
}

/** The certificate facts the person sees before trusting one. */
const certInfo = (cert) => (cert && cert.fingerprint256 ? {
  fingerprint: cert.fingerprint256, subject: cert.subject?.CN || '', issuer: cert.issuer?.CN || cert.issuer?.O || '',
  validTo: cert.valid_to || '', altNames: String(cert.subjectaltname || '').slice(0, 300),
} : null);

/**
 * A verified TLS socket: on connect (`port`), or over an existing plain socket (`socket`, STARTTLS).
 * Resolves once the certificate is trusted; rejects with `cert` (and `cert` facts to show) when it is not.
 * @param {{ host: string, port?: number, socket?: any, pin?: string, timeoutMs?: number }} o
 */
function secureSocket(o) {
  return new Promise((resolve, reject) => {
    let done = false;
    const s = tls.connect({ host: o.host, port: o.port, socket: o.socket, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: false });
    const timer = setTimeout(() => finish(mailError('timeout')), o.timeoutMs || 20000);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { try { s.destroy(); } catch { /* gone */ } reject(err); } else resolve(s);
    }
    s.once('secureConnect', () => {
      const cert = s.getPeerCertificate();
      const pinned = Boolean(o.pin) && cert?.fingerprint256 === o.pin;
      if (s.authorized || pinned) return finish(null);
      finish(mailError('cert', String(s.authorizationError || 'untrusted'), { cert: certInfo(cert) }));
    });
    s.once('error', (e) => finish(socketError(e)));
  });
}

/** A plain socket (STARTTLS starts here; tests use it for fake servers). */
function plainSocket({ host, port, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    const timer = setTimeout(() => { s.destroy(); reject(mailError('timeout')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(socketError(e)); });
  });
}

module.exports = { mailError, socketError, certInfo, secureSocket, plainSocket };
