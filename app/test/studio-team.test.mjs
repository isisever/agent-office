// Studio's Team section and Who? picker (contract v3.122): node --test app/test/studio-team.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { initials, memberState, teamGroups, whoOptions, whoPlan, deskTarget, deskSendStep, deskSend } from '../src/studio-team.mjs'

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

test('whoOptions: a project on another engine offers only Me', () => {
  const other = [...projects, { id: 'g', name: 'Gamma', engine: 'agy' }, { id: 'c', name: 'Code', engine: 'claude' }]
  assert.deepEqual(whoOptions(staff, 'g', other).map((o) => o.value), ['me'])
  assert.deepEqual(whoOptions(staff, 'c', other).map((o) => o.value), ['me', 'm1'])
})

test('whoPlan: me is a session, an allowed member their desk, a stale pick is refused (never Me)', () => {
  assert.deepEqual(whoPlan('me', 'a', staff, projects), { kind: 'session' })
  assert.deepEqual(whoPlan('', 'a', staff, projects), { kind: 'session' })
  assert.deepEqual(whoPlan('m3', 'a', staff, projects), { kind: 'desk', projectId: 'a', staffId: 'm3' })
  assert.deepEqual(whoPlan('m2', 'a', staff, projects), { kind: 'stale' })            // not allowed on the project
  assert.deepEqual(whoPlan('gone', 'a', staff, projects), { kind: 'stale' })          // removed member
  assert.deepEqual(whoPlan('m1', 'g', staff, [...projects, { id: 'g', engine: 'agy' }]), { kind: 'stale' })
})

test('deskTarget: only the desk pty of that project, else null', () => {
  assert.equal(deskTarget('a:3', 'a'), 'a:3')
  assert.equal(deskTarget('a', 'a'), 'a')
  assert.equal(deskTarget('b:3', 'a'), null)
  assert.equal(deskTarget('ab:3', 'a'), null)
  assert.equal(deskTarget(null, 'a'), null)
  assert.equal(deskTarget(undefined, 'a'), null)
})

test('deskSendStep: retry only while not running, ok required, anything else fails', () => {
  assert.equal(deskSendStep('ok', 0), 'ok')
  assert.equal(deskSendStep('not-running', 100, 1000), 'retry')
  assert.equal(deskSendStep('not-running', 1000, 1000), 'fail')
  for (const r of ['busy', 'locked', 'unsupported', 'error', undefined, true]) assert.equal(deskSendStep(r, 0), 'fail')
})

test('deskSend: sends to exactly the given pty, retries a starting desk, names the failure', async () => {
  const calls = []
  let clock = 0
  const opts = { wait: async () => { clock += 100 }, now: () => clock, limit: 1000 }
  const answers = ['not-running', 'not-running', 'ok']
  assert.deepEqual(await deskSend({ ...opts, pty: 'a:3', text: 'hi', send: async (p, x) => { calls.push([p, x]); return answers.shift() } }), { ok: true })
  assert.deepEqual(calls, [['a:3', 'hi'], ['a:3', 'hi'], ['a:3', 'hi']])

  let sent = 0
  assert.deepEqual(await deskSend({ ...opts, pty: null, text: 'hi', send: async () => { sent++; return 'ok' } }), { ok: false, failed: { step: 'desk', why: 'other', detail: '' } })
  assert.equal(sent, 0)
  assert.deepEqual(await deskSend({ ...opts, pty: 'a:3', text: '', send: async () => { sent++; return 'ok' } }), { ok: true })
  assert.equal(sent, 0)

  for (const r of ['busy', 'locked', 'unsupported']) {
    assert.deepEqual(await deskSend({ ...opts, pty: 'a:3', text: 'hi', send: async () => r }), { ok: false, failed: { step: 'prompt', why: r, detail: '' } })
  }
  assert.deepEqual((await deskSend({ ...opts, pty: 'a:3', text: 'hi', send: async () => { throw new Error('x') } })).failed?.step, 'prompt')
  clock = 0
  const slow = await deskSend({ ...opts, pty: 'a:3', text: 'hi', send: async () => 'not-running' })
  assert.deepEqual(slow, { ok: false, failed: { step: 'prompt', why: 'not-running', detail: '' } })
})
