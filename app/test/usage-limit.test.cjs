const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/usage.js');

test('applyLimitHit: a usage-limit stop shows the account as full until a newer reading arrives', () => {
  const now = 1000 * 60e3;
  const reading = { updatedAt: now - 73 * 60e3, fiveHour: { pct: 19, resetsAt: now + 90 * 60e3 }, sevenDay: { pct: 5, resetsAt: now + 4e8 } };
  const hit = { at: now - 10 * 60e3, resetsAt: now + 90 * 60e3, type: 'five_hour' };
  const u = U.applyLimitHit(reading, hit, now);
  assert.deepEqual(u.fiveHour, { pct: 100, resetsAt: hit.resetsAt });
  assert.equal(u.sevenDay.pct, 5);
  assert.equal(u.updatedAt, hit.at);
  assert.equal(U.applyLimitHit(u, hit, now), u, 'idempotent');
  // a status line reading written after the stop wins (scanUsage keeps the newer updatedAt)
  assert.equal(U.applyLimitHit({ ...reading, updatedAt: hit.at + 1 }, hit, now).fiveHour.pct, 19);
  assert.equal(U.applyLimitHit(reading, { ...hit, resetsAt: now - 1 }, now), reading, 'reset already passed');
  assert.equal(U.applyLimitHit(reading, { ...hit, resetsAt: null }, now), reading, 'no reset time');
  assert.deepEqual(U.applyLimitHit(reading, { ...hit, type: 'seven_day' }, now).sevenDay, { pct: 100, resetsAt: hit.resetsAt });
  const other = U.applyLimitHit(null, { ...hit, type: 'opus' }, now);
  assert.deepEqual(other.limited, { type: 'opus', resetsAt: hit.resetsAt });
  assert.ok(U.usageFromCache(other), 'a limited-only record survives the cache');
});
