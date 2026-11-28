// Contract v3.162: sessions come back after a restart (transcripts merged into Recent); a project click selects its session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { projectClickTarget } from '../src/studio-projects.mjs';
const require = createRequire(import.meta.url);
const STU = require('../src/studio.js');
const P = require('../src/projects.js');

test('transcripts fill Recent after a restart, newest first, without duplicates or running sessions', () => {
  const kept = [{ sessionId: 'aaa', title: 'kept', at: 100 }];
  const history = [{ id: 'aaa', prompt: 'dup', at: 300 }, { id: 'bbb', title: 'old', at: 200 }, { id: 'ccc', prompt: 'live', at: 400 }, { id: 'ddd', prompt: 'p', at: 500 }];
  const out = STU.mergeRecent(kept, history, { exclude: ['ccc'] });
  assert.deepEqual(out.map((r) => r.sessionId), ['ddd', 'bbb', 'aaa']);
  assert.equal(out.find((r) => r.sessionId === 'aaa').title, 'kept');
  assert.equal(STU.mergeRecent([], history, { limit: 2 }).length, 2);
  assert.deepEqual(STU.mergeRecent(null, null), []);
});

test('a custom name wins for a transcript session', () => {
  assert.equal(STU.mergeRecent([], [{ id: 'x1', title: 't', at: 1 }], { names: { x1: 'mine' } })[0].title, 'mine');
});

test('the history folder follows Claude Code slug rule on Windows and POSIX paths', () => {
  assert.equal(P.historyDir('C:\\Users\\x\\my proj', '', '/h'), ['/h', '.claude', 'projects', 'C--Users-x-my-proj'].join(require('node:path').sep));
});

test('clicking a project opens its first running tab, else its newest recent session, else nothing', () => {
  assert.deepEqual(projectClickTarget({ running: [{ n: 0 }, { n: 2 }], recent: [{ sessionId: 's1' }] }), { n: 0 });
  assert.deepEqual(projectClickTarget({ running: [], recent: [{ sessionId: 's1' }, { sessionId: 's2' }] }), { sessionId: 's1' });
  assert.equal(projectClickTarget({ running: [], recent: [] }), null);
  assert.equal(projectClickTarget(null), null);
});
