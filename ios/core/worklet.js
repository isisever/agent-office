// Entry of the Bare worklet inside Agent Office Remote (v3.121 phone controller). Swift <-> worklet: newline-delimited
// JSON frames of at most 64 KB over Bare.IPC; the commands and events are listed in controller.js.
//
// Order matters: the error handlers and a minimal IPC sender are installed BEFORE any other require(), because Bare
// aborts the whole process when an exception is uncaught and no listener exists. Everything else loads inside try/catch
// and a failure is reported to Swift as {t:'fatal', error}.
/* global Bare */
'use strict';

let b4a = null;
try { b4a = require('b4a'); } catch {}

// Minimal sender: plain JSON plus newline, capped well under the 64 KB frame limit. Never throws.
const sendRaw = (m) => {
  try {
    let line = JSON.stringify(m);
    if (line.length > 60000) line = JSON.stringify({ t: m.t, error: String(m.error || m.line || '').slice(0, 8000) });
    line += '\n';
    Bare.IPC.write(b4a ? b4a.from(line) : line);
  } catch {}
};
const fatal = (err) => sendRaw({ t: 'fatal', error: String((err && err.stack) || err) });

Bare.on('uncaughtException', fatal);
Bare.on('unhandledRejection', fatal);

try {
  require('./text-shim'); // before link-wire: Bare has no TextEncoder/TextDecoder globals
  const Hyperswarm = require('hyperswarm');
  const DHT = require('hyperdht');
  const crypto = require('./crypto-shim');
  const W = require('../../app/src/link-wire.js');
  const { createController } = require('./controller.js');

  const send = (m) => { const line = W.encode(m); if (line) Bare.IPC.write(b4a.from(line)); };
  const ctl = createController({ Hyperswarm, DHT, crypto, out: send });

  Bare.on('suspend', () => { ctl.command({ t: 'suspend' }).catch(() => {}); });
  Bare.on('resume', () => { ctl.command({ t: 'resume' }).catch(() => {}); });

  Bare.IPC.on('data', (chunk) => {
    try {
      if (!ctl.push(b4a.toString(chunk, 'utf8'))) send({ t: 'fatal', error: 'an IPC frame over 64 KB' });
    } catch (err) { fatal(err); }
  });

  send({ t: 'log', line: 'worklet up' });
} catch (err) {
  fatal(err);
}
