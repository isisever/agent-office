'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HO = require('../src/hq-order.js');

test('createKick: a burst runs one pump after the last call', () => {
  const pending = [];
  const timers = { set: (f) => { const t = { f, off: false }; pending.push(t); return t; }, clear: (t) => { t.off = true; } };
  let n = 0;
  const kick = HO.createKick(() => { n++; }, 200, timers);
  kick(); kick(); kick();
  for (const t of pending.splice(0)) if (!t.off) t.f();
  assert.equal(n, 1);
  kick();
  for (const t of pending.splice(0)) if (!t.off) t.f();
  assert.equal(n, 2);
});

test('readOffice: an unchanged session file is not re-parsed, a changed one is', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cache-'));
  const root = path.join(home, '.claude', 'agent-office');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const f = path.join(root, 'sessions', 's1.json');
  const now = Date.now();
  fs.writeFileSync(f, JSON.stringify({ project: 'p', updatedAt: now, workers: [] }));
  const S = require('../src/sessions.js');
  const before = S._parseCount();
  S.readOffice(null, now, root);
  S.readOffice(null, now, root);
  assert.equal(S._parseCount() - before, 1);
  fs.writeFileSync(f, JSON.stringify({ project: 'p', updatedAt: now, workers: [{ id: 'w', name: 'x' }] }));
  const d = S.readOffice(null, now, root);
  assert.equal(S._parseCount() - before, 2);
  assert.equal(d.workers.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});
