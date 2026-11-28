'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/link-core');

const office = { projects: [{ name: 'video', working: 0, isBossBusy: false }], workers: [], delivered: 0 };

test('a project whose GUI chat runs a turn is working before the transcript shows it', () => {
  const idle = C.snapshotOf([{ id: 'a1', name: 'video', engine: 'claude' }], office);
  assert.strictEqual(idle.projects[0].status, 'idle');   // the stale status the phone showed
  const woken = C.snapshotOf([{ id: 'a1', name: 'video', engine: 'claude', live: 'working' }], office);
  assert.strictEqual(woken.projects[0].status, 'working');
  const ask = C.snapshotOf([{ id: 'a1', name: 'video', engine: 'claude', live: 'approval' }], office);
  assert.strictEqual(ask.projects[0].status, 'approval');
});

test('wiring: main.js publishes the live tab state, the phone applies the ctl-proj status and polls', () => {
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'app', 'main.js'), 'utf8');
  assert.match(main, /live: liveStatusOf\(p\.id\)/);
  const model = fs.readFileSync(path.join(root, 'ios', 'AgentOfficeRemote', 'WorkletModel.swift'), 'utf8');
  assert.match(model, /proj\["status"\] as\? String/);
  assert.match(model, /func projectVisible/);
  const sess = fs.readFileSync(path.join(root, 'ios', 'AgentOfficeRemote', 'Sessions.swift'), 'utf8');
  assert.strictEqual((sess.match(/link\.projectVisible\(projectId, true\)/g) || []).length, 2);
});
