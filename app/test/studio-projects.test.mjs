// Contract v3.150: the flat Projects list's pure logic (account tag rule, row view, Esc in the filter, account search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showAccountTags, projectRowView, escClearsFilter } from '../src/studio-projects.mjs';
import { studioGroups } from '../src/studio-view.mjs';

test('account tags show only when more than one account is in use', () => {
  assert.equal(showAccountTags([{ account: 'A' }, { account: 'A' }, { account: '' }]), false);
  assert.equal(showAccountTags([{ account: 'A' }, { account: 'B' }]), true);
  assert.equal(showAccountTags([]), false);
  assert.equal(showAccountTags(null), false);
});

test('sessions are listed only for an expanded project', () => {
  const g = { id: 'a', running: [{ n: 1, isRunning: true }], recent: [{ sessionId: 'x' }] };
  const open = projectRowView(g);
  assert.deepEqual([open.expanded, open.expandable, open.count, open.live, open.busy], [true, true, 2, true, false]);
  assert.equal(projectRowView(g, { closed: new Set(['a']) }).expanded, false);
  assert.equal(projectRowView(g, { closed: new Set(['a']), query: 'x' }).expanded, true);   // filtering opens matches
  const none = projectRowView({ id: 'b', running: [], recent: [] });
  assert.deepEqual([none.expanded, none.expandable, none.count], [false, false, 0]);
  assert.equal(projectRowView({ id: 'c', running: [{ n: 1, busy: true }] }).busy, true);
  assert.equal(projectRowView({ id: 'c', running: [{ n: 1, waiting: true }] }).busy, true);
});

test('Esc clears a filled filter box only', () => {
  assert.equal(escClearsFilter('Escape', 'abc'), true);
  assert.equal(escClearsFilter('Escape', ''), false);
  assert.equal(escClearsFilter('a', 'abc'), false);
});

test('the filter matches the owning account too, keeping all that project\'s sessions', () => {
  const projects = [
    { id: 'p1', name: 'Alpha', account: 'Work', running: [{ n: 1, title: 'one' }], recent: [] },
    { id: 'p2', name: 'Beta', account: 'Home', running: [{ n: 1, title: 'two' }], recent: [] },
  ];
  const out = studioGroups(projects, { query: 'work', ordered: true });
  assert.deepEqual(out.map((g) => g.id), ['p1']);
  assert.equal(out[0].running.length, 1);
});
