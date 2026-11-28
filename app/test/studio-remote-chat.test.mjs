// Contract v3.158: remote sessions open in the main chat (pure logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteChatMode, rememberItems, lastKnown, sendOk } from '../src/studio-remote-chat.mjs';

test('an online sendable session has the composer and no note', () => {
  assert.deepEqual(remoteChatMode({ online: true, canSend: true }), { composer: true, noteKey: '' });
});
test('an offline machine is read-only with a note', () => {
  assert.deepEqual(remoteChatMode({ online: false, canSend: true }), { composer: false, noteKey: 'studio.remote.offlineReadOnly' });
  assert.equal(remoteChatMode({}).composer, false);
});
test('a closed view reason or a non-sendable project has no composer', () => {
  assert.deepEqual(remoteChatMode({ online: true, canSend: true, reason: 'limit' }), { composer: false, noteKey: '' });
  assert.deepEqual(remoteChatMode({ online: true, canSend: false }), { composer: false, noteKey: 'studio.remote.readOnly' });
});
test('last known items are kept per key, capped, and copied out', () => {
  const s = new Map();
  rememberItems(s, 'a:p', [1, 2, 3, 4], 10, 3);
  assert.deepEqual(lastKnown(s, 'a:p'), { items: [2, 3, 4], at: 10 });
  lastKnown(s, 'a:p').items.push(9);
  assert.equal(lastKnown(s, 'a:p').items.length, 3);
  assert.equal(lastKnown(s, 'x'), null);
  rememberItems(s, 'a:p', [], 11);   // an empty read does not wipe what was known
  assert.equal(lastKnown(s, 'a:p').at, 10);
});
test('the store holds at most 20 rows, oldest dropped', () => {
  const s = new Map();
  for (let i = 0; i < 25; i++) rememberItems(s, `k${i}`, [i], i);
  assert.equal(s.size, 20);
  assert.equal(s.has('k0'), false);
  assert.equal(s.has('k24'), true);
});
test('sendOk accepts success shapes only', () => {
  for (const r of [undefined, true, 'ok', { ok: true }, {}]) assert.equal(sendOk(r), true);
  for (const r of [false, 'error', { ok: false }, { reason: 'x' }, { error: 'x' }]) assert.equal(sendOk(r), false);
});
