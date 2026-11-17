// Keep computer awake (contract v3.78): node --test app/test/keep-awake.test.cjs
// Pure: explicit `now`; no Electron.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const KA = require('../src/keep-awake.js');

const T0 = 1_800_000_000_000;

test('normalizeKeepAwake: the three values pass, anything else is working', () => {
  assert.deepEqual(KA.KEEP_AWAKE_CHOICES, ['off', 'working', 'always']);
  for (const v of KA.KEEP_AWAKE_CHOICES) assert.equal(KA.normalizeKeepAwake(v), v);
  for (const v of [undefined, null, '', 'on', 'ALWAYS', true, false, 0, 1, {}, []]) assert.equal(KA.normalizeKeepAwake(v), 'working');
  assert.equal(KA.DEFAULT_KEEP_AWAKE, 'working');
});

test('off: never held', () => {
  assert.equal(KA.shouldHold({ pref: 'off', busy: 0, lastIdleAt: 0, now: T0 }), false);
  assert.equal(KA.shouldHold({ pref: 'off', busy: 3, lastIdleAt: 0, now: T0 }), false);
  assert.equal(KA.shouldHold({ pref: 'off', busy: 0, lastIdleAt: T0 - 1000, now: T0 }), false);   // inside the grace period too
});

test('always: held whatever the sessions do', () => {
  assert.equal(KA.shouldHold({ pref: 'always', busy: 0, lastIdleAt: 0, now: T0 }), true);
  assert.equal(KA.shouldHold({ pref: 'always', busy: 2, lastIdleAt: 0, now: T0 }), true);
  assert.equal(KA.shouldHold({ pref: 'always', busy: 0, lastIdleAt: T0 - 10 * KA.GRACE_MS, now: T0 }), true);
});

test('working: held while a session is busy, not while none ever was', () => {
  assert.equal(KA.shouldHold({ pref: 'working', busy: 1, lastIdleAt: 0, now: T0 }), true);
  assert.equal(KA.shouldHold({ pref: 'working', busy: 5, lastIdleAt: T0 - 10 * KA.GRACE_MS, now: T0 }), true);
  assert.equal(KA.shouldHold({ pref: 'working', busy: 0, lastIdleAt: 0, now: T0 }), false);
  assert.equal(KA.shouldHold({ pref: 'working', now: T0 }), false);   // counts left out
});

test('working: the grace period after the last session went idle', () => {
  assert.equal(KA.GRACE_MS, 30000);
  const hold = (ago) => KA.shouldHold({ pref: 'working', busy: 0, lastIdleAt: T0 - ago, now: T0 });
  assert.equal(hold(0), true);
  assert.equal(hold(1), true);
  assert.equal(hold(KA.GRACE_MS - 1), true);
  assert.equal(hold(KA.GRACE_MS), false);       // released at exactly 30 s
  assert.equal(hold(KA.GRACE_MS + 1), false);
  assert.equal(hold(-5000), false);             // a clock set back: an idle time in the future holds nothing
});

test('an unknown or missing setting behaves as working', () => {
  for (const pref of [undefined, null, '', 'sometimes', 42, true]) {
    assert.equal(KA.shouldHold({ pref, busy: 1, lastIdleAt: 0, now: T0 }), true);
    assert.equal(KA.shouldHold({ pref, busy: 0, lastIdleAt: 0, now: T0 }), false);
    assert.equal(KA.shouldHold({ pref, busy: 0, lastIdleAt: T0 - KA.GRACE_MS + 1, now: T0 }), true);
    assert.equal(KA.shouldHold({ pref, busy: 0, lastIdleAt: T0 - KA.GRACE_MS, now: T0 }), false);
  }
});

test('nextIdleAt: stamped only when the busy count falls to zero', () => {
  assert.equal(KA.nextIdleAt({ lastIdleAt: 0, wasBusy: 2, busy: 0, now: T0 }), T0);      // busy → idle
  assert.equal(KA.nextIdleAt({ lastIdleAt: 7, wasBusy: 2, busy: 1, now: T0 }), 7);       // one still works
  assert.equal(KA.nextIdleAt({ lastIdleAt: 7, wasBusy: 0, busy: 0, now: T0 }), 7);       // idle stays idle: not pushed out
  assert.equal(KA.nextIdleAt({ lastIdleAt: 7, wasBusy: 0, busy: 1, now: T0 }), 7);       // idle → busy
  assert.equal(KA.nextIdleAt({ now: T0 }), 0);
});

test('a turn, a pause shorter than the grace period, another turn: held throughout, then released', () => {
  let wasBusy = 0;
  let lastIdleAt = 0;
  const held = [];
  const steps = [[0, 1], [10, 1], [20, 0], [40, 0], [45, 1], [60, 0], [89, 0], [90, 0], [200, 0]];   // [seconds, busy]
  for (const [s, busy] of steps) {
    const now = T0 + s * 1000;
    lastIdleAt = KA.nextIdleAt({ lastIdleAt, wasBusy, busy, now });
    wasBusy = busy;
    held.push(KA.shouldHold({ pref: 'working', busy, lastIdleAt, now }));
  }
  assert.deepEqual(held, [true, true, true, true, true, true, true, false, false]);
});
