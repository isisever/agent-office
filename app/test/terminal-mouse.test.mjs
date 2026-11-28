// Terminal mouse mode and the splitter drag: see MOUSE_OFF and shouldReportSize in src/terminal-keys.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOUSE_OFF, shouldReportSize } from '../src/terminal-keys.mjs'

test('MOUSE_OFF resets every mouse tracking mode and encoding', () => {
  for (const m of [1000, 1002, 1003, 1006]) assert.ok(MOUSE_OFF.includes(`\x1b[?${m}l`), String(m))
  assert.ok(!MOUSE_OFF.includes('h'), 'only resets, never enables')
})

test('the pty size is held back while the splitter is dragged', () => {
  assert.equal(shouldReportSize({ dragging: true }), false)
  assert.equal(shouldReportSize({ dragging: false }), true)
})

test('terminal.js wires both fixes', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../renderer/terminal.js', import.meta.url), 'utf8')
  assert.match(src, /term\.write\(MOUSE_OFF\)/)
  assert.match(src, /shouldReportSize/)
  assert.match(src, /macOptionClickForcesSelection: true/)
})
