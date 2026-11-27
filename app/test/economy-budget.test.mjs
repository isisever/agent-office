// v3.133 economy mode and token budgets (src/economy.js, src/budget.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ECO = require('../src/economy.js');
const B = require('../src/budget.js');

const defaults = { contextCap: 200000, agentModel: 'sonnet', savings: 'normal', shareMcp: true, sleepMinutes: 30 };

test('economy: the project override wins over the global switch', () => {
  assert.equal(ECO.economyOn(true, {}), true);
  assert.equal(ECO.economyOn(false, {}), false);
  assert.equal(ECO.economyOn(true, { economy: 'off' }), false);
  assert.equal(ECO.economyOn(false, { economy: 'on' }), true);
  assert.equal(ECO.economyValue('bogus'), 'inherit');
  assert.deepEqual(ECO.withEconomy('inherit'), {});
  assert.deepEqual(ECO.withEconomy('on'), { economy: 'on' });
});

test('economy: fills only the settings left at the default', () => {
  const p = { id: 'a', savings: 'off' };
  assert.equal(ECO.applyEconomy(p, false), p);
  assert.deepEqual(ECO.applyEconomy(p, true), { id: 'a', savings: 'off', contextCap: 150000 });
  assert.deepEqual(ECO.applyEconomy({ id: 'b', contextCap: 400000 }, true), { id: 'b', contextCap: 400000, savings: 'strict' });
});

test('economy: idle sleep is raised to at least 60 min, off stays off', () => {
  assert.equal(ECO.sleepMinutesFor(30, true), 60);
  assert.equal(ECO.sleepMinutesFor(15, false), 15);
  assert.equal(ECO.sleepMinutesFor(0, true), 0);
  assert.equal(ECO.sleepMinutesFor(60, true), 60);
});

test('economy: the effective view names where each value comes from', () => {
  const v = ECO.effectiveView({ economy: 'on', agentModel: 'opus' }, { globalOn: false, defaults });
  assert.equal(v.on, true);
  assert.deepEqual(v.contextCap, { value: 150000, source: 'economy' });
  assert.deepEqual(v.agentModel, { value: 'opus', source: 'project' });
  assert.deepEqual(v.savings, { value: 'strict', source: 'economy' });
  assert.deepEqual(v.shareMcp, { value: false, source: 'economy' });
  assert.deepEqual(v.sleepMinutes, { value: 60, source: 'economy' });
  const off = ECO.effectiveView({ shareMcp: true }, { globalOn: false, defaults });
  assert.deepEqual(off.contextCap, { value: 200000, source: 'default' });
  assert.deepEqual(off.shareMcp, { value: true, source: 'project' });
});

const now = new Date(2026, 10, 28, 15, 0).getTime();
const usage = { today: { total: 900000, usd: 4 }, week: { total: 3000000, usd: 20 } };

test('budgetState: none without a limit', () => {
  assert.equal(B.budgetState({ usage, budget: null, now }).level, 'none');
  assert.equal(B.budgetState({ usage, budget: { daily: 0 }, now }).level, 'none');
});

test('budgetState: ok, warn at 80%, over at 100%', () => {
  assert.equal(B.budgetState({ usage, budget: { daily: 2000000 }, now }).level, 'ok');
  const w = B.budgetState({ usage, budget: { daily: 1000000 }, now });
  assert.equal(w.level, 'warn');
  assert.equal(w.blocked, false);
  const o = B.budgetState({ usage, budget: { daily: 800000 }, now });
  assert.equal(o.level, 'over');
  assert.equal(o.blocked, true);
  assert.equal(o.period, 'daily');
});

test('budgetState: USD and the period nearest its limit', () => {
  const s = B.budgetState({ usage, budget: { daily: 10, weekly: 20, unit: 'usd' }, now });
  assert.equal(s.period, 'weekly');
  assert.equal(s.level, 'over');
  assert.equal(s.used, 20);
});

test('budgetState: ignore today stops blocking until midnight', () => {
  const b = B.ignoreToday({ daily: 800000 }, now);
  const s = B.budgetState({ usage, budget: b, now });
  assert.equal(s.level, 'over');
  assert.equal(s.ignored, true);
  assert.equal(s.blocked, false);
  const tomorrow = now + 24 * 3600 * 1000;
  assert.equal(B.budgetState({ usage, budget: b, now: tomorrow }).blocked, true);
});

test('raiseBudget: past what is used, ignore cleared', () => {
  const st = B.budgetState({ usage, budget: { daily: 500000, ignoreDay: '2026-11-28' }, now });
  const r = B.raiseBudget({ daily: 500000, ignoreDay: '2026-11-28' }, st);
  assert.ok(r.daily > 900000);
  assert.equal(r.ignoreDay, undefined);
  assert.equal(B.budgetState({ usage, budget: r, now }).blocked, false);
});

test('normalizeBudget and noticeKey', () => {
  assert.deepEqual(B.normalizeBudget({ daily: 5, unit: 'eur', ignoreDay: 'x' }), { daily: 5, unit: 'tokens' });
  assert.equal(B.noticeKey({ level: 'ok' }, now), '');
  assert.equal(B.noticeKey({ level: 'warn', period: 'daily' }, now), 'warn:daily:2026-11-28');
});
