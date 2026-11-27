// Studio's Team section and Who? picker (contract v3.122): node --test app/test/studio-team.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { initials, memberState, teamGroups, whoOptions, whoPlan } from '../src/studio-team.mjs'

const projects = [{ id: 'hq', hq: true }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'own', staffOwner: 'm1' }]
const staff = [
  { id: 'm1', name: 'Ada Lovelace', department: 'Engineering', projects: 'all', role: { name: 'Developer' } },
  { id: 'm2', name: 'grace', department: '', projects: ['b'], role: { name: 'Tester' } },
  { id: 'm3', name: 'Linus T', department: 'Engineering', projects: ['a'], role: { name: 'Reviewer' } },
]
const desks = [{ projectId: 'a', staffId: 'm1', state: 'busy' }, { projectId: 'b', staffId: 'm1', state: 'off' }, { projectId: 'b', staffId: 'm2', state: 'idle' }, { projectId: 'a', staffId: 'm3', state: 'asleep' }]

test('initials', () => {
  assert.equal(initials('Ada Lovelace'), 'AL')
  assert.equal(initials('grace'), 'G')
  assert.equal(initials(''), '?')
})

test('memberState: needs you over working over idle', () => {
  assert.equal(memberState(desks, 'm1'), 'working')
  assert.equal(memberState(desks, 'm2'), 'idle')
  assert.equal(memberState(desks, 'm1', new Set(['a|m1'])), 'needs')
  assert.equal(memberState(desks, 'nobody'), 'idle')
})

test('teamGroups: departments first, open desks only, desk states', () => {
  const g = teamGroups({ staff, desks, projects, waiting: new Set(['b|m2']) })
  assert.deepEqual(g.map((x) => x.head), ['Engineering', ''])
  assert.deepEqual(g[0].members.map((m) => [m.id, m.initials, m.role, m.state]), [['m1', 'AL', 'Developer', 'working'], ['m3', 'LT', 'Reviewer', 'idle']])
  assert.deepEqual(g[0].members[0].desks, [{ projectId: 'a', name: 'Alpha', state: 'working' }])
  assert.deepEqual(g[0].members[1].desks, [{ projectId: 'a', name: 'Alpha', state: 'asleep' }])
  assert.equal(g[1].members[0].state, 'needs')
  assert.equal(g[1].members[0].desks[0].state, 'needs')
})

test('whoOptions: Me, then members allowed on the project; none for HQ or an unknown project', () => {
  assert.deepEqual(whoOptions(staff, 'a', projects).map((o) => o.value), ['me', 'm1', 'm3'])
  assert.deepEqual(whoOptions(staff, 'b', projects).map((o) => o.value), ['me', 'm1', 'm2'])
  assert.deepEqual(whoOptions(staff, 'hq', projects).map((o) => o.value), ['me'])
  assert.deepEqual(whoOptions(staff, 'zzz', projects).map((o) => o.value), ['me'])
})

test('whoPlan: me is a session, an allowed member their desk, anyone else falls back to me', () => {
  assert.deepEqual(whoPlan('me', 'a', staff, projects), { kind: 'session' })
  assert.deepEqual(whoPlan('', 'a', staff, projects), { kind: 'session' })
  assert.deepEqual(whoPlan('m3', 'a', staff, projects), { kind: 'desk', projectId: 'a', staffId: 'm3' })
  assert.deepEqual(whoPlan('m2', 'a', staff, projects), { kind: 'session' })
})
