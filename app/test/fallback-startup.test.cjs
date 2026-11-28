'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FB = require('../src/fallback.js');

const NOW = 1_000_000;
const accounts = [{ id: 'think', name: 'ThinkOne' }, { id: 'default', name: 'Default' }];
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
