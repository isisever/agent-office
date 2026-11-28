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

test('sendOk reads the link view returned by link:send', () => {
  assert.equal(sendOk({ error: null, outgoing: [{ status: 'sent' }] }), true);
  assert.equal(sendOk({ error: null, outgoing: [{ status: 'rejected', reason: 'not-running' }] }), false);
  assert.equal(sendOk({ error: 'off', outgoing: [] }), false);
});

import { remoteOpenArgs, remoteBadgeMachine, OPEN_REMOTE_EVENT } from '../src/studio-remote-chat.mjs';
import { remoteGroup } from '../src/studio-remote.mjs';

test('remoteOpenArgs: online claude row opens with send; offline opens read-only; non-claude/invalid do not', () => {
  const base = { key: 'k', pub: 'p', id: 'proj', name: 'N', machine: 'Mac' };
  const on = remoteOpenArgs(remoteGroup({ ...base, online: true, status: 'idle' }));
  assert.deepEqual(on, { key: 'k', pub: 'p', project: 'proj', name: 'N', machine: 'Mac', status: 'idle', online: true, canSend: true });
  const off = remoteOpenArgs(remoteGroup({ ...base, online: false }));
  assert.equal(off.online, false); assert.equal(off.canSend, false);
  assert.equal(remoteOpenArgs(remoteGroup({ ...base, online: true, engine: 'codex' })), null);
  assert.equal(remoteOpenArgs(null), null);
});

test('remoteBadgeMachine trims, collapses spaces, caps, and is empty without a machine', () => {
  assert.equal(remoteBadgeMachine({ machine: '  Mac   mini ' }), 'Mac mini');
  assert.equal(remoteBadgeMachine({ machine: 'x'.repeat(100) }).length, 60);
  assert.equal(remoteBadgeMachine({}), '');
  assert.equal(OPEN_REMOTE_EVENT, 'ao:open-remote');
});

import { acceptOpenRemote } from '../src/studio-remote-chat.mjs';
test('acceptOpenRemote: only in Studio mode, with args, and once', () => {
  const d = () => ({ args: { key: 'k' }, handled: false });
  assert.equal(acceptOpenRemote(d(), true), true);
  assert.equal(acceptOpenRemote(d(), false), false);
  assert.equal(acceptOpenRemote({ args: null, handled: false }, true), false);
  assert.equal(acceptOpenRemote({ ...d(), handled: true }, true), false);
  assert.equal(acceptOpenRemote(undefined, true), false);
});
