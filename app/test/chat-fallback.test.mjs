// Contract v3.165: the Studio chat names the account a limited session switches to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackNote } from '../src/chat-fallback.mjs';

test('switched names both accounts', () => {
  assert.deepEqual(fallbackNote({ kind: 'switched', fromName: 'NodesyAI', toName: 'Default' }), { key: 'chat.accountFallback.switched', params: { from: 'NodesyAI', to: 'Default' } });
});
test('no backup says so', () => {
  assert.equal(fallbackNote({ kind: 'stuck', reason: 'none', fromName: 'NodesyAI' }).key, 'chat.accountFallback.none');
  assert.equal(fallbackNote({ kind: 'stuck', reason: 'allLimited', fromName: 'A' }).key, 'chat.accountFallback.allLimited');
});
test('unknown events give nothing', () => { assert.equal(fallbackNote({ kind: 'resumed' }), null); assert.equal(fallbackNote(null), null); });
test('resumed and cleared events clear the strip', async () => {
  const { clearsFallback } = await import('../src/chat-fallback.mjs');
  assert.equal(clearsFallback({ kind: 'resumed' }), true);
  assert.equal(clearsFallback({ kind: 'cleared' }), true);
  assert.equal(clearsFallback({ kind: 'stuck' }), false);
  assert.equal(clearsFallback(null), false);
});
