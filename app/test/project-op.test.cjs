// Manual sleep / stop guard (contract v3.171): same safety rules as the idle sleeper.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { opGuard } = require('../src/project-op.js');

const ready = { engine: 'claude', running: true, tabState: 'ready' };

test('a ready Claude tab may sleep', () => {
  assert.deepEqual(opGuard('sleep', ready), { ok: true, action: 'do' });
});
test('a tab that is not running is a no-op (already asleep or stopped)', () => {
  assert.deepEqual(opGuard('sleep', { engine: 'claude', running: false }), { ok: true, action: 'noop' });
});
test('only Claude Code projects sleep', () => {
  assert.deepEqual(opGuard('sleep', { ...ready, engine: 'agy' }), { ok: false, reason: 'engine' });
  assert.equal(opGuard('stop', { ...ready, engine: 'agy' }).ok, true);
});
test('unsent input, a permission prompt, a turn or background work block sleeping', () => {
  assert.deepEqual(opGuard('sleep', { ...ready, hasDraft: true }), { ok: false, reason: 'draft' });
  assert.deepEqual(opGuard('sleep', { ...ready, permission: true }), { ok: false, reason: 'permission' });
  assert.deepEqual(opGuard('sleep', { ...ready, tabState: 'busy' }), { ok: false, reason: 'busy' });
  assert.deepEqual(opGuard('sleep', { ...ready, working: true }), { ok: false, reason: 'busy' });
  assert.deepEqual(opGuard('sleep', { ...ready, guiBusy: true }), { ok: false, reason: 'busy' });
});
test('a starting tab without a draft may sleep, with a draft it may not', () => {
  assert.equal(opGuard('sleep', { ...ready, tabState: 'starting' }).ok, true);
  assert.equal(opGuard('sleep', { ...ready, tabState: 'starting', hasDraft: true }).ok, false);
});
