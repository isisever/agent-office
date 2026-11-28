// Studio scene strip: which workers show, the short labels, and desk positions for N workers in a W×H strip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { visibleWorkers, shortTool, clip, projectHue, stripLayout, deskAt, LINGER_MS } from '../src/studio-scene-layout.mjs'

test('visibleWorkers keeps active and recently finished workers, oldest first', () => {
  const now = 100000
  const ws = [
    { id: 'b', spawnAt: 20, doneAt: null },
    { id: 'a', spawnAt: 10, doneAt: now - 1000, isOk: true },
    { id: 'gone', spawnAt: 5, doneAt: now - LINGER_MS - 1 },
    null,
    { spawnAt: 1 },
  ]
  assert.deepEqual(visibleWorkers(ws, now).map((w) => w.id), ['a', 'b'])
  assert.deepEqual(visibleWorkers(undefined, now), [])
})

test('shortTool strips the MCP prefix; clip adds an ellipsis', () => {
  assert.equal(shortTool('mcp__claude_ai_Docs__batch'), 'batch')
  assert.equal(shortTool('mcp__x__read'), 'read')
  assert.equal(shortTool('Bash'), 'Bash')
  assert.equal(shortTool(null), '')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abc', 4), 'abc')
})

test('projectHue is stable and in range', () => {
  assert.equal(projectHue('Alpha'), projectHue('alpha'))
  for (const n of ['', 'x', 'agent-office', 'Ölçek']) {
    const h = projectHue(n)
    assert.ok(Number.isInteger(h) && h >= 0 && h < 360, n)
  }
})

test('stripLayout centres few desks, fills with empty desks, never overlaps boss or rack', () => {
  const L = stripLayout(900, 150, 0)
  assert.equal(L.desks.length, 4)
  assert.equal(L.scrollMax, 0)
  for (const d of L.desks) assert.ok(d.x - L.pitch / 2 >= L.row.x0 - 0.5 && d.x + L.pitch / 2 <= L.row.x1 + 0.5)
  assert.ok(L.boss.x < L.row.x0 && L.rack.x > L.row.x1)
  const L3 = stripLayout(900, 150, 3)
  assert.equal(L3.desks.length, 4)
  for (let i = 1; i < L3.desks.length; i++) assert.ok(L3.desks[i].x - L3.desks[i - 1].x >= 100 - 1e-9)
})

test('stripLayout scrolls instead of shrinking below the minimum pitch', () => {
  const L = stripLayout(900, 150, 12)
  assert.equal(L.desks.length, 12)
  assert.ok(Math.abs(L.pitch - 100) < 1e-9)
  assert.ok(L.scrollMax > 0)
  assert.equal(L.desks[0].x, L.row.x0 + L.pitch / 2)
  const wide = stripLayout(3000, 150, 12)
  assert.equal(wide.scrollMax, 0)
  assert.ok(wide.pitch <= 150)
  assert.equal(stripLayout(0, 0, 2).desks.length, 2)
})

test('deskAt maps a point to a desk, respecting the scroll', () => {
  const L = stripLayout(900, 150, 12)
  const d = L.desks[3]
  assert.equal(deskAt(L, d.x, L.floorY - 20), 3)
  assert.equal(deskAt(L, d.x - L.pitch, L.floorY - 20, L.pitch), 3)
  assert.equal(deskAt(L, d.x, 0), -1)
})

test('the studio scene renderer pauses its timer and skips hidden frames', () => {
  const src = fs.readFileSync(new URL('../renderer/studio-scene.js', import.meta.url), 'utf8')
  assert.match(src, /pause\(\) \{[\s\S]*clearInterval\(timer\)/)
  assert.match(src, /dead \|\| paused \|\| document\.hidden/)
  for (const f of ['en', 'tr']) {
    const j = JSON.parse(fs.readFileSync(new URL(`../locales/${f}.json`, import.meta.url), 'utf8'))
    assert.ok(j.studio.scene?.noAgents && j.panel.thinking, f)
  }
})
