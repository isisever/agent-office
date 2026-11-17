// 3D office (contract v3.81): core.mjs's scene and src/office3d.mjs's boxes, camera and picking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoOffice, render, resetOffice, sceneOf, setGeometry, setLanguage, setTheme, BOSS_ID } from '../src/office/core.mjs'
import { buildStatic, buildDynamic, cameraFor, pickBot, project, staticKey, pitchFor } from '../src/office3d.mjs'

const NOW = new Date(2026, 9, 9, 11, 0, 0).getTime()
function sceneAt(w = 1320, h = 700) {
  setLanguage('tr')
  setTheme('classic')
  resetOffice()
  setGeometry(w, h)
  let s = null
  for (let t = 0; t <= 20000; t += 110) {
    render(NOW + t, demoOffice(NOW + t))
    s = sceneOf()
  }
  return s
}

test('sceneOf: the frame’s layout, desks, every drawn bot with its pose, the labels', () => {
  const s = sceneAt()
  assert.ok(s.L.desks.length > 0 && s.desks.length === s.L.desks.length)
  assert.ok(s.bots.some((b) => b.id === BOSS_ID && b.isBoss && b.seated))
  assert.ok(s.bots.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && ['type', 'stand', 'walk', 'dance'].includes(b.pose)))
  assert.ok(s.tags.some((t) => t.id === BOSS_ID))
  assert.ok(s.tags.every((t) => t.lines.every(([text, c]) => typeof text === 'string' && Number.isInteger(c))))
  assert.equal(new Set(s.bots.map((b) => b.id)).size, s.bots.length, 'one entry per bot')
})

test('buildStatic / buildDynamic: triangles with a colour each; every bot gets an anchor', () => {
  const s = sceneAt()
  const st = buildStatic(s)
  assert.equal(st.p.length % 9, 0, 'whole triangles')
  assert.equal(st.p.length, st.n.length)
  assert.equal(st.p.length, st.c.length)
  assert.equal(st.e.length, st.count)
  assert.ok(st.c.every((v) => v >= 0 && v <= 1))
  const dyn = buildDynamic(s)
  assert.deepEqual([...dyn.anchors.keys()].sort(), s.bots.map((b) => b.id).sort())
  assert.equal(staticKey(s), staticKey({ ...s, now: s.now + 1000 }), 'time does not rebuild the static part')
})

test('cameraFor: the whole office (walls included) is on the canvas, for wide and tall canvases', () => {
  for (const [w, h] of [[1320, 700], [2600, 700], [900, 900], [700, 1100]]) {
    const s = sceneAt(w, h)
    const cam = cameraFor(s.LW, s.LH, w, h)
    for (const x of [0, s.LW]) for (const z of [0, s.LH]) for (const y of [0, 30]) {
      const p = project(cam.mvp, [x, y, z], w, h)
      assert.ok(p && p[0] >= 0 && p[0] <= w && p[1] >= 0 && p[1] <= h, `${w}x${h}: corner ${[x, y, z]} → ${p}`)
    }
  }
  assert.ok(pitchFor(2600, 700) > pitchFor(900, 900), 'a wide view looks down more steeply')
})

test('pickBot: a bot’s projected body picks it; empty floor picks nothing', () => {
  const s = sceneAt()
  const w = 1320
  const h = 700
  const cam = cameraFor(s.LW, s.LH, w, h)
  const { anchors } = buildDynamic(s)
  const boss = anchors.get(BOSS_ID)
  const mid = project(cam.mvp, [boss.x, boss.top / 2, boss.z], w, h)
  assert.equal(pickBot(anchors, cam.mvp, w, h, mid[0], mid[1]), BOSS_ID)
  const corner = project(cam.mvp, [s.LW - 20, 0, s.LH - 20], w, h)
  assert.equal(pickBot(anchors, cam.mvp, w, h, corner[0], corner[1]), null)
})
