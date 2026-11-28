import test from 'node:test';
import assert from 'node:assert';
import { anchorAbove } from '../src/menu-anchor.mjs';

const view = { width: 1000, height: 700 };

test('opens directly above the button, left-aligned', () => {
  const p = anchorAbove({ left: 8, top: 640, bottom: 690 }, { width: 240, height: 200 }, view);
  assert.deepEqual(p, { left: 8, top: 640 - 6 - 200 });
});
test('the menu bottom sits just above the button, not near the top', () => {
  const p = anchorAbove({ left: 8, top: 640, bottom: 690 }, { width: 240, height: 100 }, view);
  assert.equal(p.top + 100, 634);
});
test('clamped inside the window horizontally', () => {
  assert.equal(anchorAbove({ left: 950, top: 600, bottom: 640 }, { width: 240, height: 100 }, view).left, 1000 - 240 - 8);
  assert.equal(anchorAbove({ left: -30, top: 600, bottom: 640 }, { width: 240, height: 100 }, view).left, 8);
});
test('flips below the button only when there is no room above', () => {
  const p = anchorAbove({ left: 8, top: 20, bottom: 60 }, { width: 200, height: 200 }, view);
  assert.equal(p.top, 66);
});
test('stays inside a window shorter than the menu', () => {
  const p = anchorAbove({ left: 8, top: 100, bottom: 140 }, { width: 200, height: 400 }, { width: 500, height: 300 });
  assert.equal(p.top, 8);
});
