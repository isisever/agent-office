// Studio's Team page (contract v3.124): node --test app/test/studio-team-page.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEAM_TABS, roleCard, filterRoles, prefillMember, hireForm, memberPacks, memberCards, departmentCounts, renameForms } from '../src/studio-team-page.mjs'

const ROLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles')
const presets = readdirSync(ROLES).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(ROLES, f), 'utf8')))

test('tabs', () => {
  assert.deepEqual(TEAM_TABS, ['members', 'roles', 'departments'])
})

test('roleCard: the texts in the UI language', () => {
  const qa = presets.find((d) => d.id === 'qa')
  const en = roleCard(qa, 'en')
  const tr = roleCard(qa, 'tr')
  assert.equal(en.name, qa.name.en)
  assert.equal(tr.name, qa.name.tr)
  assert.equal(tr.description, qa.description.tr)
  assert.equal(en.brief, qa.brief)
  assert.equal(en.writesCode, qa.writesCode)
  assert.deepEqual(en.skillPacks, qa.skillPacks)
  assert.equal(en.initial, 'Q')
  assert.equal(roleCard({ id: 'x', name: { en: 'ışık' } }, 'tr').initial, 'I')
})

test('filterRoles: every shipped preset, sorted, search and the writes-code filter', () => {
  const all = filterRoles(presets)
  assert.equal(all.length, 19)
  assert.deepEqual(all.map((r) => r.name), [...all.map((r) => r.name)].sort((a, b) => a.localeCompare(b, 'en')))
  const code = filterRoles(presets, { code: 'code' })
  const noCode = filterRoles(presets, { code: 'noCode' })
  assert.ok(code.length > 0 && noCode.length > 0)
  assert.equal(code.length + noCode.length, 19)
  assert.ok(code.every((r) => r.writesCode) && noCode.every((r) => !r.writesCode))
  assert.deepEqual(filterRoles(presets, { query: 'QA' }).map((r) => r.id), ['qa'])
  // by the department's label in the UI language, and case-insensitively in Turkish
  const deptName = (d) => (d === 'rnd' ? 'Ar-Ge' : d)
  assert.ok(filterRoles(presets, { query: 'ar-ge', deptName }).some((r) => r.id === 'software-developer'))
  assert.ok(filterRoles(presets, { query: 'İK', lang: 'tr', deptName: (d) => (d === 'hr' ? 'İK' : d) }).some((r) => r.id === 'hr-specialist'))
  assert.deepEqual(filterRoles(presets, { query: 'no such role at all' }), [])
  assert.deepEqual(filterRoles([{ name: { en: 'no id' } }, null]), [])
})

test('prefillMember and hireForm: a new member from a preset', () => {
  const qa = presets.find((d) => d.id === 'qa')
  const p = prefillMember({ ...qa, tools: ['canva'] }, { deptName: (d) => `label:${d}`, servers: [{ id: 'c1', name: 'canva' }, { id: 'x', name: 'other' }] })
  assert.deepEqual(p, { name: '', role: { preset: 'qa' }, department: 'label:rnd', accountId: '', projects: [], skillPacks: { superpowers: true }, tools: ['c1'] })
  assert.equal(prefillMember({ id: 'r', name: { en: 'R' } }).department, '')
  const form = hireForm(p, { name: 'Ada', department: 'QA team', accountId: 'acc1', projects: ['a', 3] })
  assert.equal(form.name, 'Ada')
  assert.equal(form.department, 'QA team')
  assert.equal(form.accountId, 'acc1')
  assert.deepEqual(form.projects, ['a'])
  assert.deepEqual(form.role, { preset: 'qa' })
  assert.equal('id' in form, false)   // no id: main adds the member and runs its own checks
  assert.equal(hireForm(p, { name: 'B', all: true, projects: ['a'] }).projects, 'all')
  assert.equal(hireForm(p, { name: 'B' }).department, 'label:rnd')
})

const projects = [{ id: 'hq', hq: true }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
const staff = [
  { id: 'm1', name: 'Ada Lovelace', department: 'Engineering', projects: 'all', role: { preset: 'qa' }, accountId: 'acc1', skillPacks: { superpowers: false, docs: true } },
  { id: 'm2', name: 'grace', projects: ['b'], role: { name: 'Tester' } },
  { id: 'm3', name: 'Linus T', department: 'Engineering', projects: ['a'], role: { preset: 'devops' }, skillPacks: ['old'] },
]

test('memberPacks: role defaults with the member\'s own choices on top', () => {
  assert.deepEqual(memberPacks(staff[0], presets).sort(), ['docs'])
  assert.deepEqual(memberPacks(staff[1], presets), [])
  const devops = presets.find((d) => d.id === 'devops')
  assert.deepEqual(memberPacks(staff[2], presets).sort(), [...devops.skillPacks, 'old'].sort())
})

test('memberCards: grouped by department with account, projects, packs and live state', () => {
  const desks = [{ projectId: 'a', staffId: 'm1', state: 'busy' }, { projectId: 'b', staffId: 'm2', state: 'idle' }]
  const groups = memberCards({ staff, presets, desks, projects, waiting: new Set(['b|m2']), lang: 'tr', accounts: [{ id: 'acc1', label: 'Work' }] })
  assert.deepEqual(groups.map((g) => g.head), ['Engineering', ''])
  const [ada, linus] = groups[0].members
  assert.equal(ada.initials, 'AL')
  assert.equal(ada.role, presets.find((d) => d.id === 'qa').name.tr)
  assert.equal(ada.account, 'Work')
  assert.equal(ada.allProjects, true)
  assert.deepEqual(ada.projects.map((p) => p.name), ['Alpha', 'Beta'])
  assert.equal(ada.state, 'working')
  assert.equal(linus.account, '')
  assert.deepEqual(linus.projects, [{ id: 'a', name: 'Alpha' }])
  const grace = groups[1].members[0]
  assert.equal(grace.state, 'needs')
  assert.equal(grace.desks[0].state, 'needs')
  assert.equal(grace.role, 'Tester')
})

test('departmentCounts and renameForms', () => {
  assert.deepEqual(departmentCounts(staff), [{ name: 'Engineering', count: 2 }, { name: '', count: 1 }])
  assert.deepEqual(departmentCounts([]), [])
  const r = renameForms(staff, 'Engineering', '  R&D ')
  assert.ok('forms' in r)
  assert.deepEqual(r.forms.map((f) => [f.id, f.department]), [['m1', 'R&D'], ['m3', 'R&D']])
  assert.deepEqual(r.forms[0].role, staff[0].role)   // the rest of the member is sent as it is
  assert.deepEqual(renameForms(staff, 'Engineering', 'Engineering'), { forms: [] })
  assert.deepEqual(renameForms(staff, 'Engineering', '  '), { error: 'empty' })
  assert.deepEqual(renameForms(staff, '', 'X'), { error: 'none' })
})
