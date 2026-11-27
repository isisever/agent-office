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

test('economy view: effects, meter and banners', async () => {
  const V = await import('../src/economy-view.mjs');
  assert.equal(V.economyOn({ economy: 'off' }, true), false);
  assert.deepEqual(V.economyEffects({ contextCap: 400000 }, { globalOn: true, sleepMinutes: 30 }),
    { contextCap: null, agentModel: 'sonnet', savings: 'strict', shareMcp: true, sleepMinutes: 60 });
  assert.equal(V.economyEffects({}, { globalOn: false }).contextCap, null);
  assert.equal(V.meterView({}), null);
  const m = V.meterView({ budget: { level: 'over', pct: 1.3, blocked: true, period: 'daily', used: 1.3e6, limit: 1e6, unit: 'tokens' } });
  assert.equal(m.pct, 130);
  assert.equal(m.width, 100);
  assert.equal(V.amountText(1.3e6, 'tokens'), '1.3M');
  assert.equal(V.amountText(4.2, 'usd'), '$4.20');
  const briefs = [{ id: 'a', budget: { level: 'over', blocked: true } }, { id: 'b', budget: { level: 'warn' } }];
  assert.deepEqual(V.bannersOf(briefs).map((b) => b.id), ['a']);
  assert.deepEqual(V.bannersOf(briefs, new Set(['a'])), []);
});

// v3.133 the held budget tasks survive a restart (src/budget-held.js; main.js writes them to userData)
const BH = require('../src/budget-held.js');
const SF = require('../src/state-file.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('budget held: restored from disk after a restart and released once the budget allows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-held-'));
  const file = path.join(dir, 'budget-held.json');
  try {
    // first run: two tasks held for project a, one for b, written atomically
    let held = BH.fromJson(SF.readState(file).raw);
    assert.equal(held.size, 0);
    held = BH.add(held, 'a', { qid: 'q1', args: { project: 'A', task: 'one' } }, 1).held;
    held = BH.add(held, 'a', { qid: 'q2', args: { project: 'A', task: 'two' } }, 2).held;
    held = BH.add(held, 'b', { qid: 'q3', args: { project: 'B', task: 'three' } }, 3).held;
    SF.writeAtomic(file, JSON.stringify(BH.toJson(held)));
    assert.deepEqual(fs.readdirSync(dir), ['budget-held.json']);

    // restart: the map comes back from the file as it was
    const back = BH.fromJson(SF.readState(file).raw);
    assert.deepEqual([...back.keys()].sort(), ['a', 'b']);
    assert.deepEqual(back.get('a').map((h) => h.qid), ['q1', 'q2']);
    assert.equal(back.get('a')[1].args.task, 'two');

    // still blocked: nothing goes out; a new day (or Raise / Ignore today) no longer blocks: a's tasks are released
    assert.equal(BH.releasable(back, 'a', { blocked: true }), false);
    assert.equal(BH.releasable(back, 'a', { blocked: false, level: 'ok' }), true);
    assert.equal(BH.releasable(back, 'c', { blocked: false }), false);
    const { held: rest, taken } = BH.take(back, 'a');
    assert.deepEqual(taken.map((h) => h.qid), ['q1', 'q2']);
    assert.deepEqual([...rest.keys()], ['b']);

    // a row removed from the board by hand meanwhile is not re-sent
    const board = { tasks: [{ id: 'q1', status: 'queued', reason: 'budget' }, { id: 'q2', status: 'rejected', reason: 'removed' }] };
    assert.deepEqual(taken.filter((h) => BH.stillHeld(board, h.qid)).map((h) => h.qid), ['q1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget held: capped, malformed entries skipped', () => {
  let held = new Map();
  const dropped = [];
  for (let i = 0; i < BH.MAX_PER_PROJECT + 3; i++) {
    const r = BH.add(held, 'a', { qid: `q${i}`, args: { task: String(i) } }, i);
    held = r.held; dropped.push(...r.dropped);
  }
  assert.equal(held.get('a').length, BH.MAX_PER_PROJECT);
  assert.deepEqual(dropped.map((d) => d.qid), ['q0', 'q1', 'q2']);
  assert.equal(held.get('a')[0].qid, 'q3');
  for (let p = 0; p < 10; p++) for (let i = 0; i < BH.MAX_PER_PROJECT; i++) held = BH.add(held, `p${p}`, { qid: `p${p}-${i}`, args: {} }, 1000 + p * 100 + i).held;
  assert.equal([...held.values()].reduce((n, l) => n + l.length, 0), BH.MAX_TOTAL);
  assert.equal(BH.add(new Map(), 'a', { qid: 'big', args: { task: 'x'.repeat(BH.MAX_ARGS_BYTES + 1) } }).dropped.length, 1);
  const raw = { held: { a: [{ qid: 'ok', args: {} }, { qid: 5, args: {} }, { qid: 'noargs' }, null], b: 'x' } };
  assert.deepEqual([...BH.fromJson(raw).entries()].map(([k, v]) => [k, v.map((h) => h.qid)]), [['a', ['ok']]]);
  assert.equal(BH.fromJson(null).size, 0);
});
