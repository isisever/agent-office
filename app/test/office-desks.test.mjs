import test from 'node:test'
import assert from 'node:assert/strict'
import { deskGrid, DESK_TIERS, setGeometry, resetOffice, render, sceneOf } from '../src/office/core.mjs'

test('deskGrid keeps the comfortable pitch while it holds the demand', () => {
  const g = deskGrid(240, 40, 3)
  assert.equal(g.pitchX, DESK_TIERS[0][0])
  assert.ok(g.count >= 3)
})

test('deskGrid tightens the pitch instead of capping at 4 rows or 4 desks', () => {
  const loose = deskGrid(240, 40, 0)
  const need = loose.count + 3
  const g = deskGrid(240, 40, need)
  assert.ok(g.count > loose.count)
  assert.ok(g.pitchX < loose.pitchX)
  const tall = deskGrid(240, 400, 0)
  assert.ok(tall.rows > 4, 'rows are not capped at 4')
})

test('deskGrid returns the densest grid when the demand is above capacity', () => {
  const g = deskGrid(240, 40, 999)
  assert.equal(g.pitchX, DESK_TIERS.at(-1)[0])
})

test('the scene grows its desks with the workers and shows the project on the plate', () => {
  setGeometry(1320, 800)
  resetOffice()
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, spawnAt: i, project: `proj${i % 2}`, type: 'general-purpose', tool: 'Bash' }))
  const data = (n) => ({ workers: mk(n), delivered: 0, isBossBusy: false, projects: [], project: '', sessionId: '' })
  render(5000, data(2))
  const few = sceneOf().desks.length
  render(5000, data(few + 6))
  const many = sceneOf().desks
  assert.ok(many.length > few, `desks grew from ${few} to ${many.length}`)
  assert.ok(many.some((d) => d.proj && d.proj.name === 'proj0'), 'a desk carries its project')
})
