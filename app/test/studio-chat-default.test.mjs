// v3.161 Studio always opens in the chat view, on every platform; the terminal only after the person switches to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatShownFor, chatButtonFor } from '../src/chat-view.mjs';

const base = { chatView: false, studio: true, win: false, isGui: false, chatOff: false, hq: false };

for (const win of [false, true]) {
  test(`Studio shows the chat for a terminal-backed tab (win=${win})`, () => {
    assert.equal(chatShownFor({ ...base, win }), true);
    assert.equal(chatShownFor({ ...base, win, isGui: true }), true);
  });
  test(`Studio offers the switch to the terminal, never forces it (win=${win})`, () => {
    assert.equal(chatButtonFor({ ...base, win, capable: true }), true);
    assert.equal(chatButtonFor({ ...base, win, capable: false }), false);
  });
}

test('the Office without the chat view keeps its terminal', () => {
  assert.equal(chatShownFor({ ...base, studio: false }), false);
  assert.equal(chatShownFor({ ...base, studio: false, win: true }), false);
});
