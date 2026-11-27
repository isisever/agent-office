// Entry of the Bare worklet inside Agent Office Remote. Swift <-> worklet: newline-delimited JSON over Bare.IPC.
// In:  {t:'start'} {t:'connect', input} {t:'suspend'} {t:'resume'}
// Out: {t:'log', line} {t:'status', state} {t:'fatal', error}
/* global Bare */
'use strict';
const b4a = require('b4a');
const { createSpike } = require('./spike');

const send = (m) => Bare.IPC.write(b4a.from(JSON.stringify(m) + '\n'));
const log = (line) => { console.log(`[worklet] ${line}`); send({ t: 'log', line }); };
const status = (state) => send({ t: 'status', state });

Bare.on('uncaughtException', (err) => send({ t: 'fatal', error: String(err?.stack || err) }));
Bare.on('unhandledRejection', (err) => send({ t: 'fatal', error: String(err?.stack || err) }));
Bare.on('suspend', () => log('Bare suspend event'));
Bare.on('resume', () => log('Bare resume event'));

const spike = createSpike({ log, status });

let buf = '';
Bare.IPC.on('data', (chunk) => {
  buf += b4a.toString(chunk, 'utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { log('bad IPC frame'); continue; }
    if (m.t === 'start') spike.start().catch((e) => log(`start failed: ${e.message}`));
    else if (m.t === 'connect') spike.connect(m.input).catch((e) => log(`connect failed: ${e.message}`));
    else if (m.t === 'suspend') spike.suspend();
    else if (m.t === 'resume') spike.resume();
  }
});

log('worklet up');
spike.start().catch((e) => log(`start failed: ${e.message}`));
