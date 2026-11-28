'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FB = require('../src/fallback.js');

const NOW = 1_000_000;
const accounts = [{ id: 'think', name: 'ThinkOne', auth: { state: 'in' } }, { id: 'default', name: 'Default', auth: { state: 'in' } }];
const base = { choice: 'default', model: 'opus', own: 'opus', second: null, current: 'think', home: 'think', accounts, marks: {}, modelMarks: {}, now: NOW };

test('an account with an unexpired mark moves to the fallback before resuming', () => {
  const plan = FB.limitedStartMove({ ...base, mark: { at: NOW - 10, until: NOW + 5000 }, marks: { think: { at: NOW - 10, until: NOW + 5000 } } });
  assert.ok(plan);
  assert.equal(plan.id, 'default');
});

test('an expired mark keeps the project where it is', () => {
  const mark = { at: NOW - 9000, until: NOW - 1 };
  assert.equal(FB.limitedStartMove({ ...base, mark, marks: { think: mark } }), null);
});

test('no mark and no usage limit keeps the project where it is', () => {
  assert.equal(FB.limitedStartMove({ ...base }), null);
});

test('a limited account with nowhere to go starts where it is', () => {
  const mark = { at: NOW - 10, until: NOW + 5000 };
  assert.equal(FB.limitedStartMove({ ...base, mark, marks: { think: mark }, accounts: [accounts[0]] }), null);
});

test('a GUI stream limit error is a hit without a transcript', () => {
  const hit = FB.guiLimitHit("You've hit your 5-hour limit · resets 3:40pm", NOW);
  assert.ok(hit);
  assert.equal(hit.at, NOW);
  assert.equal(FB.guiLimitHit('API Error: 500', NOW), null);
});

test('an idle chat on a marked account gets a hit once per mark; a free account none', () => {
  const mark = { at: NOW - 10, until: NOW + 5000 };
  assert.equal(FB.idleLimitHit({ mark, now: NOW }).at, NOW - 10);
  assert.equal(FB.idleLimitHit({ now: NOW }), null);
});

test('an idle chat move waits while any tab of the project is mid-turn', () => {
  assert.equal(FB.idleMoveReady([false, false]), true);
  assert.equal(FB.idleMoveReady([false, true]), false);
  assert.equal(FB.idleMoveReady([]), true);
});

test('a no-backup plan is not redone for the same limit window', () => {
  const entry = FB.retryEntry({ wait: NOW + 500000, hitAt: 100, now: NOW });
  assert.equal(entry.until, NOW + 60000);   // capped so a freed account is noticed
  assert.equal(FB.retryGate(entry, { hitAt: 100, now: NOW + 1500 }), false);
  assert.equal(FB.retryGate(entry, { hitAt: 101, now: NOW + 1500 }), true);   // a newer hit
  assert.equal(FB.retryGate(entry, { hitAt: 100, now: NOW + 60000 }), true);   // the window ended
  assert.equal(FB.retryGate(undefined, { hitAt: 1, now: NOW }), true);
});

test('the startup move honors the loop guard', () => {
  const recent = [NOW - 1000];
  assert.equal(FB.switchAllowed(recent, NOW).ok, false);
  assert.equal(FB.switchAllowed([], NOW).ok, true);
});

test('an idle hit is marked so the retry gate can ignore its moving timestamp', () => {
  const mark = { at: NOW - 10, until: NOW + 5000 };
  assert.equal(FB.idleLimitHit({ mark, now: NOW }).idle, true);
});
