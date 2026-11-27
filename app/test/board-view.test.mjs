import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, matches, filterCards, filterOptions, columnsOf, fmtDuration, fmtCost, fmtTokens, rangeOf, typeCounts, reportRows } from '../src/board-view.mjs';

const order = { id: 'o:r1', kind: 'order', request: 'r1', title: 'Ship the login page', type: 'feature', column: 'working', project: '2 projects', projects: ['web', 'api'], member: 'Ada', members: ['Ada'], tasks: [{ id: 't1', title: 'Wire OAuth' }] };
const chat = { id: 'c:1', kind: 'chat', title: 'Crash on save', type: 'bugfix', column: 'review', project: 'web', projects: ['web'], member: '', members: [] };
const hot = { id: 'c:2', kind: 'chat', title: 'Prod down', type: 'hotfix', column: 'review', project: 'api', projects: [], member: 'Bo', members: [] };

test('types keep the owner order: bugfix, hotfix, feature', () => {
  assert.deepEqual(TYPES, ['bugfix', 'hotfix', 'feature']);
});

test('matches: project, type, member, request and search', () => {
  assert.ok(matches(order, {}));
  assert.ok(matches(order, { project: 'api' }));
  assert.ok(!matches(chat, { project: 'api' }));
  assert.ok(matches(hot, { project: 'api' }), 'falls back to the single project field');
  assert.ok(matches(hot, { member: 'Bo' }));
  assert.ok(matches(chat, { type: 'bugfix' }) && !matches(chat, { type: 'feature' }));
  assert.ok(matches(order, { q: 'oauth' }), 'task titles are searched');
  assert.ok(matches(order, { q: 'LOGIN' }));
  assert.ok(!matches(order, { q: 'nothing' }));
  assert.ok(matches(order, { request: 'r1' }) && !matches(chat, { request: 'r1' }));
  assert.ok(!matches(null, {}));
  assert.deepEqual(filterCards([order, chat, hot], { project: 'web' }).map((c) => c.id), ['o:r1', 'c:1']);
  assert.deepEqual(filterCards(null, {}), []);
});

test('filterOptions: sorted projects and members, types in priority order', () => {
  assert.deepEqual(filterOptions([order, chat, hot]), { projects: ['api', 'web'], members: ['Ada', 'Bo'], types: ['bugfix', 'hotfix', 'feature'] });
});

test('columnsOf keeps the model order and filters', () => {
  const view = { columns: [{ id: 'todo', cards: [] }, { id: 'working', cards: ['o:r1'] }, { id: 'review', cards: ['c:2', 'c:1'] }], cards: [order, chat, hot] };
  const cols = columnsOf(view);
  assert.deepEqual(cols.map((c) => c.id), ['todo', 'working', 'needs-you', 'review', 'done']);
  assert.deepEqual(cols[3].cards.map((c) => c.id), ['c:2', 'c:1']);
  assert.deepEqual(columnsOf(view, { type: 'bugfix' })[3].cards.map((c) => c.id), ['c:1']);
  // a card listed in no column falls back to its own column
  assert.deepEqual(columnsOf({ cards: [chat] })[3].cards.map((c) => c.id), ['c:1']);
  assert.equal(columnsOf(null).length, 5);
});

test('fmtDuration, fmtCost, fmtTokens', () => {
  assert.equal(fmtDuration(0), '');
  assert.equal(fmtDuration(NaN), '');
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(12 * 60_000), '12m');
  assert.equal(fmtDuration(3 * 36e5), '3h');
  assert.equal(fmtDuration(3 * 36e5 + 5 * 60_000), '3h 5m');
  assert.equal(fmtDuration(52 * 36e5), '2d 4h');
  assert.equal(fmtDuration(48 * 36e5), '2d');
  assert.equal(fmtCost(0), '');
  assert.equal(fmtCost(0.004), '<$0.01');
  assert.equal(fmtCost(0.42), '$0.42');
  assert.equal(fmtCost(12.3), '$12.30');
  assert.equal(fmtCost(1234.5), '$1,235');
  assert.equal(fmtTokens(0), '');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(1500), '1.5k');
  assert.equal(fmtTokens(12_300), '12k');
  assert.equal(fmtTokens(4_100_000), '4.1M');
});

test('rangeOf: this week, last week, 30 days, custom', () => {
  const now = new Date(2026, 10, 28, 15, 30).getTime();   // Saturday 28 Nov 2026
  const mon = new Date(2026, 10, 23).getTime();
  assert.deepEqual(rangeOf('week', now), { from: mon, to: now });
  assert.deepEqual(rangeOf('lastWeek', now), { from: new Date(2026, 10, 16).getTime(), to: mon });
  assert.deepEqual(rangeOf('days30', now), { from: now - 30 * 864e5, to: now });
  assert.deepEqual(rangeOf('custom', now, { from: '2026-11-01', to: '2026-11-02' }), { from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 3).getTime() });
  assert.equal(rangeOf('custom', now, { from: '2026-11-05', to: '2026-11-01' }), null);
  assert.equal(rangeOf('custom', now, { from: 'x' }), null);
  assert.equal(rangeOf('nope', now), null);
  // a Monday is the start of its own week
  const monday = new Date(2026, 10, 23, 9).getTime();
  assert.equal(rangeOf('week', monday).from, mon);
});

test('typeCounts and reportRows', () => {
  const rep = { groupBy: 'type', rows: [{ key: 'feature', count: 4, durationMs: 4000 }, { key: 'bugfix', count: 7, durationMs: 7000, tokens: 10, usd: 1.5 }, { key: 'hotfix', count: 2 }] };
  assert.deepEqual(typeCounts(rep), { bugfix: 7, hotfix: 2, feature: 4 });
  assert.deepEqual(typeCounts(null), { bugfix: 0, hotfix: 0, feature: 0 });
  const rows = reportRows(rep);
  assert.deepEqual(rows.map((r) => r.key), ['bugfix', 'hotfix', 'feature']);
  assert.equal(rows[0].avgMs, 1000);
  assert.equal(rows[0].pct, 100);
  assert.equal(rows[1].pct, 29);
  const byProject = reportRows({ groupBy: 'project', rows: [{ key: 'b', count: 1 }, { key: 'a', count: 1 }, { key: 'c', count: 3 }] });
  assert.deepEqual(byProject.map((r) => r.key), ['c', 'a', 'b']);
  assert.deepEqual(reportRows(null), []);
});
