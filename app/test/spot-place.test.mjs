// What's-new spotlight placement and the chat message buttons' anchoring: node --test app/test/spot-place.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { placeSpot, movedSpot } from '../src/spot-place.mjs';

const box = (left, top, width, height) => ({ left, top, width, height, bottom: top + height });

test('ring pads the target; tip goes below when there is room', () => {
  const p = placeSpot(box(100, 100, 50, 20), 1000, 800);
  assert.deepEqual(p.ring, { left: 94, top: 94, width: 62, height: 32 });
  assert.equal(p.tip.top, 134);
  assert.equal(p.tip.bottom, undefined);
});

test('tip goes above near the bottom edge and stays inside the viewport horizontally', () => {
  const p = placeSpot(box(980, 780, 40, 20), 1000, 800);
  assert.equal(p.tip.top, undefined);
  assert.equal(p.tip.bottom, 800 - 780 + 14);
  assert.equal(p.tip.left, 1000 - 260 - 8);
  assert.equal(placeSpot(box(-30, 10, 10, 10), 1000, 800).tip.left, 8);
});

test('tip stays on screen when the target is scrolled above the viewport', () => {
  const p = placeSpot(box(10, -500, 50, 20), 1000, 90);
  assert.ok(p.tip.top >= 8 && p.tip.top <= 90);
});

test('movedSpot ignores sub-pixel changes and reports real moves', () => {
  const a = placeSpot(box(100, 100, 50, 20), 1000, 800);
  assert.equal(movedSpot(a, placeSpot(box(100.4, 100, 50, 20), 1000, 800)), false);
  assert.equal(movedSpot(a, placeSpot(box(140, 100, 50, 20), 1000, 800)), true);
  assert.equal(movedSpot(null, a), true);
});

test('Office chat buttons of a left-aligned message anchor at its left edge', () => {
  const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-msg:not\(\.user\) \.chat-acts \{ left: 8px; right: auto; \}/);
});
