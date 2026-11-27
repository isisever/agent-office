'use strict';
// v3.134 order templates: the store's validation and caps (src/order-templates.js) and the composer fill
// (src/template-fill.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const OT = require('../src/order-templates.js');

let n = 0;
const newId = () => `tp${(n++).toString(16).padStart(8, '0')}`;
const ok = { name: 'Nightly fix', text: 'fix the flaky login test', type: 'bugfix' };

test('save validates name, text, type and targets', () => {
  const r = OT.save([], { ...ok, targets: ['web', 'web', ' api ', 3] }, { newId });
  assert.equal(r.ok, true);
  assert.deepEqual(r.list[0], { id: r.id, name: 'Nightly fix', text: 'fix the flaky login test', type: 'bugfix', targets: ['web', 'api'] });
  for (const bad of [null, 'x', [], { ...ok, name: '' }, { ...ok, name: 'x'.repeat(81) }, { ...ok, text: '  ' }, { ...ok, text: 'x'.repeat(4001) },
    { ...ok, type: 'chore' }, { ...ok, type: 1 }, { ...ok, name: 5 }]) {
    assert.equal(OT.save([], bad, { newId }).ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal(OT.save([], { ...ok, targets: 'a, b' }, { newId }).list[0].targets.join('|'), 'a|b');
  assert.equal(OT.save([], { ...ok, targets: Array.from({ length: 20 }, (_, i) => `p${i}`) }, { newId }).list[0].targets.length, OT.TARGETS_MAX);
  assert.equal(OT.save([], { ...ok, text: 'a\u001b[31mb\u0007' }, { newId }).list[0].text, 'a[31mb');   // no escapes reach the terminal
});

test('an id must be known; a new template mints one', () => {
  const a = OT.save([], ok, { newId });
  assert.equal(OT.save(a.list, { ...ok, id: 'tp99999999' }, { newId }).reason, 'unknown');
  assert.equal(OT.save(a.list, { ...ok, id: '../x' }, { newId }).reason, 'unknown');
  const b = OT.save(a.list, { ...ok, id: a.id, name: 'Renamed' }, { newId });
  assert.equal(b.ok, true);
  assert.equal(b.list.length, 1);
  assert.equal(b.list[0].name, 'Renamed');
});

test('at most 50 templates; an update still works at the cap', () => {
  let list = [];
  for (let i = 0; i < OT.MAX_TEMPLATES; i++) list = OT.save(list, { ...ok, name: `t${i}` }, { newId }).list;
  assert.equal(list.length, 50);
  assert.equal(OT.save(list, ok, { newId }).reason, 'too-many');
  assert.equal(OT.save(list, { ...ok, id: list[0].id, name: 'x' }, { newId }).ok, true);
  assert.equal(OT.normalizeList([...list, ...list.map((x, i) => ({ ...x, id: newId(), name: `y${i}` }))]).length, 50);
});

test('remove and a hand-edited list', () => {
  const a = OT.save([], ok, { newId });
  assert.equal(OT.remove(a.list, 'tp00000000x').reason, 'unknown');
  assert.equal(OT.remove(a.list, 42).reason, 'unknown');
  assert.deepEqual(OT.remove(a.list, a.id).list, []);
  const raw = [a.list[0], a.list[0], { id: 'bad', ...ok }, { ...ok }, 'x', { ...ok, id: 'tp0000ffff', type: 'nope' }];
  assert.deepEqual(OT.normalizeList(raw).map((x) => x.id), [a.id]);
  assert.deepEqual(OT.normalizeList(undefined), []);
});

test('fill text: type prefix and targets as text; never a second prefix', async () => {
  const { fillText, fromText } = await import('../src/template-fill.mjs');
  assert.equal(fillText({ text: 'fix the login', type: 'bugfix' }), 'bugfix: fix the login');
  assert.equal(fillText({ text: 'hotfix: patch it', type: 'feature', targets: ['web', 'api'] }), 'feature: patch it\nTargets: web, api');
  assert.equal(fillText({ text: 'x', type: 'weird' }), 'feature: x');
  // round trip: Save as template from a filled composer gives the same template back
  const d = fromText(fillText({ text: 'ship the export\nwith tests', type: 'hotfix', targets: ['web'] }));
  assert.deepEqual(d, { name: 'ship the export', text: 'ship the export\nwith tests', type: 'hotfix', targets: ['web'] });
  assert.equal(fromText('plain text').type, 'feature');
  assert.equal(fromText('x'.repeat(100)).name.length, 60);
});
