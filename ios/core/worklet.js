// Entry of the Bare worklet inside Agent Office Remote (v3.121 phone controller). Swift <-> worklet: newline-delimited
// JSON frames of at most 64 KB over Bare.IPC; the commands and events are listed in controller.js.
/* global Bare */
'use strict';
const b4a = require('b4a');
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');
const crypto = require('./crypto-shim');
const W = require('../../app/src/link-wire.js');
const { createController } = require('./controller.js');

const send = (m) => { const line = W.encode(m); if (line) Bare.IPC.write(b4a.from(line)); };
const ctl = createController({ Hyperswarm, DHT, crypto, out: send });

Bare.on('uncaughtException', (err) => send({ t: 'fatal', error: String(err?.stack || err) }));
Bare.on('unhandledRejection', (err) => send({ t: 'fatal', error: String(err?.stack || err) }));
Bare.on('suspend', () => { ctl.command({ t: 'suspend' }).catch(() => {}); });
Bare.on('resume', () => { ctl.command({ t: 'resume' }).catch(() => {}); });

Bare.IPC.on('data', (chunk) => {
  if (!ctl.push(b4a.toString(chunk, 'utf8'))) send({ t: 'fatal', error: 'an IPC frame over 64 KB' });
});

send({ t: 'log', line: 'worklet up' });
