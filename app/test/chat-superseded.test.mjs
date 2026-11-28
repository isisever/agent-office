// Contract v3.164: a limit error followed by progress is marked superseded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLimitError, showsProgress, limitFlow } from '../src/chat-superseded.mjs';

const err = (key) => ({ key, kind: 'error', text: "You've hit your 5-hour limit · resets 3:40pm (Europe/Istanbul)" });
const user = (key) => ({ key, kind: 'user', text: 'Your last turn stopped on a usage limit.' });
const answer = (key) => ({ key, kind: 'assistant', text: 'Carrying on.' });

test('limit error text is recognised, other errors are not', () => {
  assert.equal(isLimitError(err('a')), true);
  assert.equal(isLimitError({ kind: 'error', text: "You’ve reached your weekly limit" }), true);
  assert.equal(isLimitError({ kind: 'error', text: 'API Error: 500' }), false);
  assert.equal(isLimitError({ kind: 'assistant', text: "You've hit your limit" }), false);
});

test('progress is a non-empty answer or a tool call', () => {
  assert.equal(showsProgress(answer('a')), true);
  assert.equal(showsProgress({ kind: 'tool' }), true);
  assert.equal(showsProgress({ kind: 'assistant', text: '  ' }), false);
  assert.equal(showsProgress(user('u')), false);
});

test('the stale error before the carry-on and the work is superseded', () => {
  const r = limitFlow([], [user('u1'), err('e1'), user('u2'), answer('a1')]);
  assert.deepEqual(r, { open: [], superseded: ['e1'] });
});

test('an error with nothing after it stays open and is carried across batches', () => {
  const first = limitFlow([], [user('u1'), err('e1'), user('u2')]);
  assert.deepEqual(first, { open: ['e1'], superseded: [] });
  assert.deepEqual(limitFlow(first.open, [answer('a1')]), { open: [], superseded: ['e1'] });
});

test('an error that ends the transcript is never superseded', () => {
  assert.deepEqual(limitFlow([], [answer('a0'), err('e1')]), { open: ['e1'], superseded: [] });
});
