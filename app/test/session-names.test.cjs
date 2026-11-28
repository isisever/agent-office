'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../src/session-names.js');
const S = require('../src/studio.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('normalizeName: one line, trimmed, capped, never non-string', () => {
  assert.equal(N.normalizeName('  My \n\t chat  '), 'My chat');
  assert.equal(N.normalizeName('a\u0000b'), 'a b');
  assert.equal(N.normalizeName('x'.repeat(300)).length, N.NAME_MAX);
  for (const v of [undefined, null, 5, {}, '', '   ']) assert.equal(N.normalizeName(v), '');
});

test('setName: sets, replaces, clears with an empty name, ignores a bad id', () => {
  let r = N.setName({}, A, ' Fix login ');
  assert.deepEqual(r, { names: { [A]: 'Fix login' }, name: 'Fix login' });
  r = N.setName(r.names, A, 'Renamed');
  assert.equal(r.names[A], 'Renamed');
  r = N.setName(r.names, B, 'Other');
  r = N.setName(r.names, A, '');
  assert.deepEqual(r.names, { [B]: 'Other' });
  assert.deepEqual(N.setName({ [B]: 'x' }, 'not-an-id', 'y'), { names: { [B]: 'x' }, name: '' });
});

test('normalizeNames drops junk and keeps only the newest KEEP_MAX entries', () => {
  assert.deepEqual(N.normalizeNames(null), {});
  assert.deepEqual(N.normalizeNames([A]), {});
  assert.deepEqual(N.normalizeNames({ [A]: ' ok ', [B]: '', bad: 'x', '33333333-3333-4333-8333-333333333333': 7 }), { [A]: 'ok' });
  const big = {};
  for (let i = 0; i < N.KEEP_MAX + 5; i++) big[`${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`] = `n${i}`;
  const out = N.normalizeNames(big);
  assert.equal(Object.keys(out).length, N.KEEP_MAX);
  assert.equal(out[`${String(0).padStart(8, '0')}-1111-4111-8111-111111111111`], undefined);
});

test('nameOf reads only own keys', () => {
  assert.equal(N.nameOf({ [A]: 'Hi' }, A), 'Hi');
  assert.equal(N.nameOf({}, 'constructor'), '');
  assert.equal(N.nameOf(null, A), '');
});

test('listSessions: a custom name wins for running and recent rows and sets sessionId', () => {
  const projects = [{ id: 'p', name: 'P', dir: '/tmp/p', tabs: [] }];
  const out = S.listSessions({
    projects, status: [{ id: 'p', isRunning: true, tabs: [] }],
    recent: [{ projectId: 'p', sessionId: B, title: 'old', dir: '/tmp/p', at: 5 }],
    infoOf: () => ({ title: 'auto', prompt: '', branch: '', at: 1, sessionId: A }),
    names: { [A]: 'Mine', [B]: 'Mine too' },
  });
  assert.equal(out[0].running[0].title, 'Mine');
  assert.equal(out[0].running[0].custom, true);
  assert.equal(out[0].running[0].sessionId, A);
  assert.equal(out[0].recent[0].title, 'Mine too');
  const plain = S.listSessions({ projects, status: [{ id: 'p', isRunning: true, tabs: [] }], recent: [], infoOf: () => ({ title: 'auto', prompt: '', sessionId: A }) });
  assert.equal(plain[0].running[0].title, 'auto');
  assert.equal(plain[0].running[0].custom, false);
});
