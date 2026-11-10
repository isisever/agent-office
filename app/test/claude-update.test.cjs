// Claude Code CLI update helpers: node --test test/claude-update.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const CU = require('../src/claude-update.js');

test('the command is `claude update`', () => {
  assert.equal(CU.UPDATE_COMMAND, 'claude update');
  assert.equal(CU.INTERVAL_MS, 12 * 60 * 60 * 1000);
});

test('shouldCheck: missing or invalid last check is due', () => {
  const now = 1_000_000_000;
  for (const last of [null, undefined, 0, NaN, '123', {}]) assert.equal(CU.shouldCheck(now, last), true);
});

test('shouldCheck: recent is not due, exactly the interval is', () => {
  const now = 1_000_000_000;
  assert.equal(CU.shouldCheck(now, now - 1000), false);
  assert.equal(CU.shouldCheck(now, now - CU.INTERVAL_MS + 1), false);
  assert.equal(CU.shouldCheck(now, now - CU.INTERVAL_MS), true);
  assert.equal(CU.shouldCheck(now, now - 500, 500), true);
});

test('shouldCheck: a last check in the future is due', () => {
  assert.equal(CU.shouldCheck(1000, 5000), true);
});

test('enabled: opt-out env', () => {
  assert.equal(CU.enabled({ [CU.OPT_OUT_ENV]: '1' }), false);
  assert.equal(CU.enabled({ [CU.OPT_OUT_ENV]: 'true' }), false);
  assert.equal(CU.enabled({}), true);
  assert.equal(CU.enabled({ [CU.OPT_OUT_ENV]: '0' }), true);
  assert.equal(CU.enabled(undefined), true);
});
