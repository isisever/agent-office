// Studio account picker in the project header (contract v3.163): pure choice logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountChoices, accountToSet, pickerUseful } from '../src/studio-account-picker.mjs';

const accounts = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work', state: 'out' }, { id: '' }, null];

test('choices list valid accounts and mark the current one by label or id', () => {
  const c = accountChoices(accounts, 'Work');
  assert.deepEqual(c.map((x) => x.id), ['default', 'work']);
  assert.deepEqual(c.map((x) => x.current), [false, true]);
  assert.equal(c[1].signedOut, true);
  assert.equal(accountChoices(accounts, 'default')[0].current, true);
  assert.equal(accountChoices(accounts, '').some((x) => x.current), false);
});

test('bad input gives no choices', () => {
  assert.deepEqual(accountChoices(null, 'x'), []);
  assert.equal(pickerUseful([]), false);
});

test('accountToSet returns only a known, different account', () => {
  const c = accountChoices(accounts, 'Work');
  assert.equal(accountToSet(c, 'default'), 'default');
  assert.equal(accountToSet(c, 'work'), null);
  assert.equal(accountToSet(c, 'nope'), null);
  assert.equal(accountToSet(c, 5), null);
  assert.equal(pickerUseful(c), true);
});
