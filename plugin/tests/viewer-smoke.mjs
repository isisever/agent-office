// Smoke test for the viewer (plain Node, no dependencies): node tests/viewer-smoke.mjs
// `claude plugin test` runs *.test.ts(x) in the hooks sandbox, which has no processes or files,
// so the viewer is checked here instead. Every run gets its own temp HOME.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'office.mjs')
const temps = []
after(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
  temps.push(dir)
  return dir
}

// a temp HOME holding one live session state file, as the plugin writes it
function homeWithSession(workers) {
  const home = tempDir()
  const sessions = join(home, '.claude', 'agent-office', 'sessions')
  mkdirSync(sessions, { recursive: true })
  const state = { project: 'my-app', updatedAt: Date.now(), workers, stats: { delivered: 1, isBossBusy: true } }
  writeFileSync(join(sessions, 'session-1.json'), JSON.stringify(state))
  return home
}

function threeWorkers() {
  const now = Date.now()
  return [
    // with the agent details of contract v2.2, which the viewer ignores
    {
      id: 'agent-1',
      type: 'Explore',
      description: 'Scan the code',
      spawnAt: now - 60_000,
      tool: 'Grep',
      prompt: 'Scan the code for TODOs',
      detail: 'TODO in src',
      history: [{ at: now - 1_000, tool: 'Grep', detail: 'TODO in src' }],
      toolCount: 1,
    },
    { id: 'agent-2', type: 'Plan', description: 'Plan the change', spawnAt: now - 30_000 },
    { id: 'agent-3', type: 'general-purpose', description: 'Write docs', spawnAt: now - 90_000, doneAt: now - 5_000, isOk: true, result: 'Docs written.' },
  ]
}

// the PNG signature, and IHDR (always the first chunk) carries width and height
function assertPng(path, width, height) {
  const png = readFileSync(path)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature')
  assert.equal(png.toString('latin1', 12, 16), 'IHDR')
  assert.equal(png.readUInt32BE(16), width, 'IHDR width')
  assert.equal(png.readUInt32BE(20), height, 'IHDR height')
  assert.equal(png.toString('latin1', png.length - 8, png.length - 4), 'IEND')
  return png
}

function snapshot(home, size) {
  const out = join(tempDir(), 'x.png')
  const run = spawnSync(process.execPath, [VIEWER, '--snapshot', out, size], {
    env: { ...process.env, HOME: home, LANG: 'en_US.UTF-8' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(run.status, 0, `viewer exited ${run.status}: ${run.stderr}`)
  return out
}

// --frames reads the session state files (--snapshot always draws the demo office): its first frame
async function firstFrame(home, size) {
  const dir = join(tempDir(), 'frames')
  const child = spawn(process.execPath, [VIEWER, '--frames', dir, size], {
    env: { ...process.env, HOME: home, LANG: 'en_US.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  try {
    const line = await new Promise((resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => reject(new Error(`no frame within 15 s: ${stderr}`)), 15_000)
      child.stdout.on('data', d => {
        out += d
        const first = out.split('\n').find(l => l.startsWith('frame '))
        if (first) {
          clearTimeout(timer)
          resolve(first)
        }
      })
      child.on('exit', code => reject(new Error(`viewer exited ${code} before a frame: ${stderr}`)))
    })
    assert.match(line, /^frame 1 [0-9a-f]{6} [0-9a-f]{6} .+$/)
    return { title: line.split(' ').slice(4).join(' '), png: join(dir, 'frame.png') }
  } finally {
    child.kill()
  }
}

test('--snapshot writes a valid PNG of the requested size', () => {
  assertPng(snapshot(tempDir(), '1600x800'), 1600, 800)
})

test('--snapshot still renders with a session state file of 3 workers in HOME', () => {
  assertPng(snapshot(homeWithSession(threeWorkers()), '1600x800'), 1600, 800)
})

test('--frames renders the session state file of 3 workers, themed for its project', async () => {
  const empty = await firstFrame(tempDir(), '800x400')
  assertPng(empty.png, 800, 400)
  assert.doesNotMatch(empty.title, /MY-APP/i)

  const busy = await firstFrame(homeWithSession(threeWorkers()), '800x400')
  assertPng(busy.png, 800, 400)
  assert.match(busy.title, /MY-APP/i, 'the title comes from the project in the state file')
})
