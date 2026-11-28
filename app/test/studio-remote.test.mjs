// Contract v3.153: remote machines' projects in Studio's Projects list (pure logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteGroup, remoteGroups, remoteDot, localActionAllowed, machineTag } from '../src/studio-remote.mjs';

const row = (o = {}) => ({ key: 'pubA:p1', pub: 'pubA', id: 'p1', name: 'Alpha', machine: 'Mac mini', online: true, state: 'running', status: 'working', engine: 'claude', buttons: ['sleep', 'stop'], asOf: 5, ...o });

test('an online claude project can be viewed and sent to, with its manage buttons', () => {
  const g = remoteGroup(row());
  assert.equal(g.remote, true);
  assert.equal(g.id, 'pubA:p1');
  assert.equal(g.projectId, 'p1');
  assert.deepEqual([g.canView, g.canSend, g.dim], [true, true, false]);
  assert.deepEqual(g.buttons, ['sleep', 'stop']);
  assert.equal(machineTag(g), 'Mac mini');
});

test('an offline machine keeps its rows dimmed with last-known data and no actions', () => {
  const g = remoteGroup(row({ online: false, buttons: ['start'] }));
  assert.deepEqual([g.dim, g.canView, g.canSend, g.buttons, g.name, g.status], [true, false, false, [], 'Alpha', 'working']);
  assert.equal(remoteDot(g), '');
});

test('a non-claude project is shown but neither viewed nor sent to', () => {
  const g = remoteGroup(row({ engine: 'codex' }));
  assert.deepEqual([g.canView, g.canSend], [false, false]);
});

test('dot follows state and status', () => {
  assert.equal(remoteDot(remoteGroup(row())), 'live');
  assert.equal(remoteDot(remoteGroup(row({ state: 'asleep', status: '' }))), 'asleep');
  assert.equal(remoteDot(remoteGroup(row({ state: 'stopped', status: 'working' }))), '');
  assert.equal(remoteDot(remoteGroup(row({ status: 'idle' }))), '');
});

test('rows are sorted by machine then name and filtered by project, machine or account', () => {
  const rows = [row({ key: 'b:1', pub: 'b', id: '1', name: 'Zed', machine: 'B' }), row({ key: 'a:2', pub: 'a', id: '2', name: 'Beta', machine: 'A', account: 'Work' }),
    row({ key: 'a:1', pub: 'a', id: '1', name: 'Alpha', machine: 'A' })];
  assert.deepEqual(remoteGroups(rows).map((g) => g.id), ['a:1', 'a:2', 'b:1']);
  assert.deepEqual(remoteGroups(rows, 'zed').map((g) => g.id), ['b:1']);
  assert.deepEqual(remoteGroups(rows, 'work').map((g) => g.id), ['a:2']);
  assert.deepEqual(remoteGroups(rows, 'B').map((g) => g.id), ['a:2', 'b:1']);
});

test('malformed rows are dropped; local-only actions are never allowed on remote rows', () => {
  assert.deepEqual(remoteGroups([null, {}, { key: 'x' }, 'str']), []);
  assert.equal(remoteGroups(null).length, 0);
  assert.equal(localActionAllowed(remoteGroup(row())), false);
  assert.equal(localActionAllowed({ id: 'local' }), true);
});
