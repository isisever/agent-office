import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Harness = Parameters<TestBody>[1]
type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

const ran = (exitCode: number, stdout = ''): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// a session in /work/my-app with the given environment; process.run answers from `run`, fs.read from `files`.
// `isTicking`: a mocked clock drives the plugin's ticker (advance it to run a tick)
function setUp(
  on: Harness,
  env: Record<string, string>,
  run: (argv: readonly string[]) => RunResult = () => ran(1),
  { files = {}, isTicking = false }: { files?: Record<string, string>; isTicking?: boolean } = {},
) {
  const writes: { path: string; text: string }[] = []
  const runs: (readonly string[])[] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/my-app' }))
  const commands: string[] = []
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: undefined as never }
  })
  const clock = isTicking ? mock.clock(on) : undefined
  if (!isTicking) on('clock.every', () => ({ value: undefined as never }))
  on('fs.write', (_$, e) => {
    writes.push(e)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: run(e.argv) }
  })
  on('session.start', (_$, e) => e)
  on('ui.render', { component: 'AbovePrompt' }, () => undefined as never)

  return { writes, runs, clock, commands }
}

const nodeFound = (argv: readonly string[]) => (argv[0] === 'node' ? ran(0, '/usr/local/bin/node') : ran(1))
const start = { cwd: '/work/my-app', surface: 'terminal', isInteractive: true } as const
const band = {
  plugin: 'agent-office',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 120 } as never,
} as const

test('/office is registered in a terminal session but not inside the Agent Office app', async ($, on) => {
  const { commands } = setUp(on, { HOME: '/home/tester' })
  await $.session.start(start)
  expect(commands).toEqual(['office'])
})

test('inside the Agent Office app no /office command is registered and the state file is still written', async ($, on) => {
  const { commands, writes } = setUp(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1' })
  await $.session.start(start)
  expect(commands).toEqual([])
  expect(writes.some(w => w.path.endsWith('/sessions/session-1.json'))).toBe(true)
})

test('a spawned agent is written to the session state file', async ($, on) => {
  const { writes } = setUp(on, { HOME: '/home/tester' })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))

  await $.session.start(start)
  const spawn = { prompt: 'scan', description: 'Scan the code', subagentType: 'Explore' }
  await $.agent.spawn(spawn as Parameters<typeof $.agent.spawn>[0])

  const last = writes[writes.length - 1]
  expect(last?.path).toBe('/home/tester/.claude/agent-office/sessions/session-1.json')
  const state = JSON.parse(last?.text ?? '{}')
  expect(state.project).toBe('my-app')
  expect(state.workers.map((w: { id: string; type: string }) => [w.id, w.type])).toEqual([['agent-1', 'Explore']])
})

test('/office şerit opens the Turkish band above the prompt and closes it again', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound)

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: 'şerit' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('şeridi açıldı')
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /AGENT OFİS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /hazırlanıyor/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 çalışıyor · 0 teslim/ })).toBeDefined()
  await ui.unmount()

  const closed = await $.command.run({ command: 'office', args: 'şerit' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(closed)).toContain('kapatıldı')
})

test('/office band is the English alias and the band speaks English outside a tr locale', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound)

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('band opened')
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /AGENT OFFICE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Preparing the office/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 working · 0 delivered/ })).toBeDefined()
  await ui.unmount()

  const closed = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(closed)).toContain('Office closed')
})

test('/office outside Ghostty falls back to the band and says so', async ($, on) => {
  const { runs } = setUp(on, { HOME: '/home/tester', LANG: 'C', TERM_PROGRAM: 'iTerm.app' }, nodeFound)

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('needs Ghostty on macOS')
  expect(runs.some(argv => argv[0] === '/usr/bin/osascript')).toBe(false)
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /AGENT OFFICE/ })).toBeDefined()
  await ui.unmount()

  const closed = await $.command.run({ command: 'office', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(closed)).toContain('Office closed')
})

test('/office in Ghostty on macOS opens a split running the plugin viewer', async ($, on) => {
  const { runs } = setUp(on, { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty' }, argv =>
    argv[0] === '/usr/bin/osascript' ? ran(0) : nodeFound(argv),
  )

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('Office opened')
  const split = runs.filter(argv => argv[0] === '/usr/bin/osascript').map(argv => argv[2] ?? '').find(s => s.includes('split here'))
  expect(split).toMatch(/\/viewer\/office\.mjs'? --below --terminal-rows 8 --project my-app --grow-from/)
  expect(split).not.toMatch(/\.claude\/agent-office\/office\.mjs/)
})

test('/office in kitty with remote control opens an hsplit running the plugin viewer', async ($, on) => {
  const env = { HOME: '/home/tester', LANG: 'en_US.UTF-8', KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1' }
  const { runs } = setUp(on, env, argv => (argv[0] === 'kitty' ? ran(0) : nodeFound(argv)))

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('Office opened')
  const launch = runs.find(argv => argv[0] === 'kitty' && argv.includes('launch'))?.join(' ')
  expect(launch).toMatch(/^kitty @ --to unix:\/tmp\/kitty-1 launch --location=hsplit .*--match=window_id:3 /)
  expect(launch).toMatch(/\/viewer\/office\.mjs --below --terminal-rows 8 --project my-app$/)
  expect(runs.some(argv => argv[0] === '/usr/bin/osascript')).toBe(false)
})

test('/office in kitty without remote control falls back to the band', async ($, on) => {
  const env = { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM: 'xterm-kitty', KITTY_WINDOW_ID: '3' }
  const { runs } = setUp(on, env, argv => (argv[0] === 'kitty' ? ran(1) : nodeFound(argv)))

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('kitty with remote control')
  expect(runs.some(argv => argv[0] === 'kitty' && argv.includes('ls'))).toBe(true)
  expect(runs.some(argv => argv[0] === 'kitty' && argv.includes('launch'))).toBe(false)
})

test('/office in WezTerm opens a top split running the plugin viewer', async ($, on) => {
  const env = { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '7' }
  const { runs } = setUp(on, env, argv => (argv[0] === 'wezterm' ? ran(0, '8\n') : nodeFound(argv)))

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('Office opened')
  const split = runs.find(argv => argv[0] === 'wezterm')?.join(' ')
  expect(split).toMatch(/^wezterm cli split-pane --pane-id 7 --top --percent 80 -- \S+ \S+\/viewer\/office\.mjs --below --terminal-rows 8 --project my-app$/)
  expect(runs.some(argv => argv[0] === '/usr/bin/osascript')).toBe(false)
})

test('/office without node replies with a clear message', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'en_US.UTF-8' })

  await $.session.start(start)
  const reply = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(reply)).toContain('Node.js was not found')
  // the band stayed closed: asking again still reports the missing node instead of closing
  const again = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(again)).toContain('Node.js was not found')
})

const HOUR = 60 * 60_000
const entry = (name: string, kind: 'file' | 'dir', mtimeMs = 0) => ({ name, kind, size: 0, mtimeMs, isLink: false })
const lastState = (writes: { path: string; text: string }[]) =>
  JSON.parse([...writes].reverse().find(w => w.path.endsWith('/sessions/session-1.json'))?.text ?? '{}')

test('failed and killed agents are delivered as failures, completed ones as successes', async ($, on) => {
  const { writes, clock } = setUp(on, { HOME: '/home/tester' }, undefined, { isTicking: true })
  let spawned = 0
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++spawned}` }))
  const statuses = { 'agent-1': 'completed', 'agent-2': 'failed', 'agent-3': 'killed' } as const
  on('agent.list', () => ({
    value: Object.entries(statuses).map(([id, status]) => ({ id, status, description: id, type: 'Explore' })),
  }))

  await $.session.start(start)
  for (const description of ['one', 'two', 'three'])
    await $.agent.spawn({ prompt: 'go', description, subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])
  await clock?.advance(1500)

  const state = lastState(writes)
  const outcome = Object.fromEntries(state.workers.map((w: { id: string; isOk?: boolean }) => [w.id, w.isOk]))
  expect(outcome).toEqual({ 'agent-1': true, 'agent-2': false, 'agent-3': false })
  expect(state.stats.delivered).toBe(3)
  expect([...state.stats.today.ids].sort()).toEqual(['agent-1', 'agent-2', 'agent-3'])
})

test('session start removes sessions ended before today and stale ones, never this one, a live one or one ended today', async ($, on) => {
  const root = '/home/tester/.claude/agent-office'
  const now = Date.now()
  const old = now - 48 * HOUR
  const lastNight = new Date(now).setHours(0, 0, 0, 0) - 60_000
  const sessions: Record<string, string> = {
    'session-1.json': JSON.stringify({ updatedAt: old, endedAt: old }),
    'ended.json': JSON.stringify({ updatedAt: lastNight, endedAt: lastNight }),
    'endedToday.json': JSON.stringify({ updatedAt: now, endedAt: now }),
    'quiet.json': JSON.stringify({ updatedAt: old }),
    'live.json': JSON.stringify({ updatedAt: now - HOUR }),
    'broken.json': '{',
  }
  const files = Object.fromEntries(Object.entries(sessions).map(([name, text]) => [`${root}/sessions/${name}`, text]))
  const { runs } = setUp(on, { HOME: '/home/tester' }, undefined, { files })
  const listing: Record<string, ReturnType<typeof entry>[]> = {
    [`${root}/sessions`]: [
      entry('session-1.json', 'file', old),
      entry('ended.json', 'file', lastNight),
      entry('endedToday.json', 'file', now),
      entry('quiet.json', 'file', old),
      entry('live.json', 'file', now - HOUR),
      entry('broken.json', 'file', old),
    ],
    [`${root}/inbox`]: [
      entry('session-1.jsonl', 'file', old),
      entry('ended.jsonl', 'file', now),
      entry('live.jsonl', 'file', old),
      entry('orphan.jsonl', 'file', old),
      entry('newborn.jsonl', 'file', now),
    ],
    [`${root}/frames`]: [entry('session-1', 'dir'), entry('quiet', 'dir'), entry('live', 'dir'), entry('orphan', 'dir'), entry('newborn', 'dir')],
  }
  on('fs.list', (_$, e) => ({ value: listing[e.path ?? ''] ?? [] }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: e.path.endsWith('/newborn') ? now : old, isLink: false } }))

  await $.session.start(start)

  const removed = runs.filter(argv => argv[0] === '/bin/rm').flatMap(argv => argv.slice(3))
  expect([...removed].sort()).toEqual(
    [
      `${root}/sessions/ended.json`,
      `${root}/sessions/quiet.json`,
      `${root}/sessions/broken.json`,
      `${root}/inbox/ended.jsonl`,
      `${root}/inbox/orphan.jsonl`,
      `${root}/frames/quiet`,
      `${root}/frames/orphan`,
    ].sort(),
  )
})

test('submitted inbox rows are cleared, and a task typed meanwhile is still sent', async ($, on) => {
  const inbox = '/home/tester/.claude/agent-office/inbox/session-1.jsonl'
  const at = Date.now() + 60_000
  const row = (text: string, offset: number) => JSON.stringify({ at: at + offset, text }) + '\n'
  const files: Record<string, string> = { [inbox]: row('first', 0) }
  const { runs, clock } = setUp(
    on,
    { HOME: '/home/tester' },
    argv => {
      // the viewer appends right before the move: that row goes aside with the file
      if (argv[0] !== '/bin/mv') return ran(0)
      files[argv[4] ?? ''] = (files[inbox] ?? '') + row('second', 1)
      delete files[inbox]
      return ran(0)
    },
    { files, isTicking: true },
  )
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  await $.session.start(start)
  await clock?.advance(1500)

  expect(submitted.map(text => text.split('\n')[0])).toEqual(['Task from Agent Office: first', 'Task from Agent Office: second'])
  const moved = runs.find(argv => argv[0] === '/bin/mv')
  expect(moved?.slice(3, 4)).toEqual([inbox])
  expect(runs.some(argv => argv[0] === '/bin/rm' && argv.includes(moved?.[4] ?? '-'))).toBe(true)
  // the next tick finds no inbox and submits nothing again
  await clock?.advance(1500)
  expect(submitted.length).toBe(2)
})

const SETTINGS_FILE = '/home/tester/.claude/agent-office/settings.json'

test('settings.json language "en" wins over a tr locale', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound, {
    files: { [SETTINGS_FILE]: JSON.stringify({ language: 'en' }) },
  })

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('band opened')
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /AGENT OFFICE/ })).toBeDefined()
  await ui.unmount()
})

test('settings.json language "tr" wins over an en locale', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound, {
    files: { [SETTINGS_FILE]: JSON.stringify({ language: 'tr', forgetMinutes: 10 }) },
  })

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('şeridi açıldı')
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /AGENT OFİS/ })).toBeDefined()
  await ui.unmount()
})

test('a malformed settings.json falls back to the locale', async ($, on) => {
  const { writes } = setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound, {
    files: { [SETTINGS_FILE]: '{ "language": "en", ' },
  })

  await $.session.start(start)
  expect(writes.some(w => w.path.endsWith('/sessions/session-1.json'))).toBe(true)
  const opened = await $.command.run({ command: 'office', args: 'şerit' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('şeridi açıldı')
})

test('settings.json with invalid values keeps the defaults', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound, {
    files: { [SETTINGS_FILE]: JSON.stringify({ language: 'de', forgetMinutes: 'soon' }) },
  })

  await $.session.start(start)
  const opened = await $.command.run({ command: 'office', args: 'band' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('band opened')
})

// The plugin stamps times with Date.now(), which a test cannot move; mock.clock only drives its
// $.clock timers (the ticker, the throttled write). Times are therefore set relative to the real clock.
const FORGET_MS = 5 * 60_000
const TICK_MS = 1500
const PUBLISH_MS = 500

// setUp with mock.clock driving the ticker
function setUpTicking(on: Harness, env: Record<string, string>, files: Record<string, string> = {}) {
  const { clock, ...rest } = setUp(on, env, undefined, { files, isTicking: true })
  if (!clock) throw new Error('no mock clock')
  return { ...rest, clock }
}

// the state file as the plugin last wrote it
type Engine = Parameters<TestBody>[0]
type State = {
  workers: {
    id: string
    tool?: string
    doneAt?: number
    isOk?: boolean
    prompt?: string
    detail?: string
    history?: { at: number; tool: string; detail: string }[]
    toolCount?: number
    result?: string
  }[]
  stats: { delivered: number; isBossBusy: boolean }
}
const stateOf = (writes: { path: string; text: string }[]): State => lastState(writes)
const spawnAgent = ($: Engine, description: string, subagentType: string) =>
  $.agent.spawn({ prompt: description, description, subagentType } as Parameters<typeof $.agent.spawn>[0])
const completeTurn = ($: Engine, reason: string, agentId?: string, answer = '') =>
  $.turn.complete({ reason, answer, durationMs: 1, isAborted: false, turnId: 'turn-1', agentId } as Parameters<typeof $.turn.complete>[0])

test('tool.call shows the tool on its running worker; unknown agents and the main agent change nothing', async ($, on) => {
  const { writes, clock } = setUpTicking(on, { HOME: '/home/tester' })
  let spawned = 0
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++spawned}` }))
  on('tool.call', () => ({ result: 'ok' }) as never)

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  await spawnAgent($, 'Write the docs', 'general-purpose')

  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agent-1' } as never)
  // tool calls are written at most every PUBLISH_MS
  await clock.advance(PUBLISH_MS)
  const tools = () => stateOf(writes).workers.map(w => [w.id, w.tool])
  expect(tools()).toEqual([
    ['agent-1', 'Grep'],
    ['agent-2', undefined],
  ])

  const before = writes.length
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-404' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(writes.length).toBe(before)
  expect(tools()).toEqual([
    ['agent-1', 'Grep'],
    ['agent-2', undefined],
  ])
})

// the main loop beneath the plugins: turns start and complete as asked
function answerTurns(on: Harness) {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('turn.start marks the boss busy and the main turn completing frees him', async ($, on) => {
  const { writes } = setUp(on, { HOME: '/home/tester' })
  answerTurns(on)

  await $.session.start(start)
  expect(stateOf(writes).stats.isBossBusy).toBe(false)
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  expect(stateOf(writes).stats.isBossBusy).toBe(true)
  await completeTurn($, 'answer')
  expect(stateOf(writes).stats.isBossBusy).toBe(false)
})

test("a subagent's turn.complete delivers its worker once, isOk only for an answer", async ($, on) => {
  const { writes } = setUp(on, { HOME: '/home/tester' })
  answerTurns(on)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++spawned}` }))

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  await spawnAgent($, 'Write the docs', 'general-purpose')
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })

  await completeTurn($, 'answer', 'agent-1')
  await completeTurn($, 'error', 'agent-2')
  let state = stateOf(writes)
  expect(state.workers.map(w => [w.id, typeof w.doneAt, w.isOk])).toEqual([
    ['agent-1', 'number', true],
    ['agent-2', 'number', false],
  ])
  // a subagent finishing does not free the boss
  expect(state.stats).toMatchObject({ delivered: 2, isBossBusy: true })

  // completing again changes nothing: each is delivered once
  const doneAt = state.workers[0]?.doneAt
  await completeTurn($, 'answer', 'agent-1')
  await completeTurn($, 'answer', 'agent-2')
  state = stateOf(writes)
  expect(state.stats.delivered).toBe(2)
  expect(state.workers[0]?.doneAt).toBe(doneAt)
  expect(state.workers[1]?.isOk).toBe(false)
})

test('a delivered worker leaves the state file once FORGET_MS has passed', async ($, on) => {
  const { writes, clock } = setUpTicking(on, { HOME: '/home/tester' })
  on('agent.list', () => ({ value: [] }))
  const now = Date.now()
  const worker = (id: string, doneAgo?: number) => ({
    id,
    type: 'Explore',
    description: id,
    spawnAt: now - FORGET_MS * 2,
    ...(doneAgo === undefined ? {} : { doneAt: now - doneAgo, isOk: true }),
  })
  // what an earlier part of this session left in the plugin's state: read until the plugin writes its own
  const seed = [worker('long-gone', FORGET_MS + 60_000), worker('just-delivered', 60_000), worker('still-working')]
  let isRewritten = false
  on('state.get', async (_$, e, next) => {
    const read = await next(e)
    return e.key === 'workers' && !isRewritten && read.value ? { ...read, value: { ...read.value, value: seed } } : read
  })
  on('state.set', (_$, e, next) => {
    if (e.key === 'workers') isRewritten = true
    return next(e)
  })

  await $.session.start(start)
  expect(stateOf(writes).workers.map(w => w.id)).toEqual(['long-gone', 'just-delivered', 'still-working'])
  await clock.advance(TICK_MS)
  expect(stateOf(writes).workers.map(w => w.id)).toEqual(['just-delivered', 'still-working'])
})

test('a task typed into the office inbox is submitted to Claude once; old and malformed rows are ignored', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = setUpTicking(on, { HOME: '/home/tester' }, files)
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  const before = Date.now()
  await $.session.start(start)
  await clock.advance(TICK_MS)
  expect(submitted).toEqual([])

  // the viewer appends one { at, text } row per task typed
  const rows = [
    JSON.stringify({ at: before - 60_000, text: 'from before this session' }),
    '{ not json',
    JSON.stringify({ at: Date.now() + 1_000, text: '' }),
    JSON.stringify({ at: Date.now() + 1_000, text: 'tidy the README' }),
  ]
  files['/home/tester/.claude/agent-office/inbox/session-1.jsonl'] = rows.join('\n') + '\n'
  await clock.advance(TICK_MS)
  await clock.advance(TICK_MS * 3)
  expect(submitted).toEqual([
    'Task from Agent Office: tidy the README\n\nIf it fits, split the work across subagents and run them in parallel.',
  ])
})

// agent details (contract v2.2)

// a session with ticking clock, agents spawned as agent-1, agent-2… and tool calls answered
function setUpDetails(on: Harness) {
  const set = setUpTicking(on, { HOME: '/home/tester' })
  let spawned = 0
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++spawned}` }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('agent.list', () => ({ value: [] }))
  answerTurns(on)
  return set
}
const callTool = ($: Engine, agentId: string, tool: string, args: Record<string, unknown>) =>
  $.tool.call({ tool, ...args, agentId } as never)

test('agent.spawn stores the prompt with whitespace collapsed, cut to 600 chars', async ($, on) => {
  const { writes } = setUpDetails(on)

  await $.session.start(start)
  await $.agent.spawn({ prompt: '  Scan\n\n the   code\tfor bugs ', description: 'Scan', subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])
  await $.agent.spawn({ prompt: 'x'.repeat(700), description: 'Long', subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])

  const [short, long] = stateOf(writes).workers
  expect(short?.prompt).toBe('Scan the code for bugs')
  expect(short?.toolCount).toBe(0)
  expect(long?.prompt?.length).toBe(600)
  expect(long?.prompt?.endsWith('x…')).toBe(true)
})

test('tool.call sets a one-line detail per tool: Bash, Read, Edit, Write, Grep, Glob, WebFetch, WebSearch, others as JSON', async ($, on) => {
  const { writes, clock } = setUpDetails(on)

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  const detailAfter = async (tool: string, args: Record<string, unknown>) => {
    await callTool($, 'agent-1', tool, args)
    await clock.advance(PUBLISH_MS)
    const worker = stateOf(writes).workers[0]
    expect(worker?.tool).toBe(tool)
    return worker?.detail
  }

  expect(await detailAfter('Bash', { command: 'cd app &&\n  npm test\n', description: 'Run tests' })).toBe('cd app && npm test')
  expect(await detailAfter('Read', { file_path: 'src/My File.ts', offset: 10 })).toBe('src/My File.ts')
  expect(await detailAfter('Edit', { file_path: '/work/my-app/a.ts', old_string: 'a', new_string: 'b' })).toBe('/work/my-app/a.ts')
  expect(await detailAfter('Write', { file_path: '/work/my-app/b.ts', content: 'x\ny' })).toBe('/work/my-app/b.ts')
  expect(await detailAfter('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO in src')
  expect(await detailAfter('Grep', { pattern: 'TODO' })).toBe('TODO')
  expect(await detailAfter('Glob', { pattern: '**/*.ts', path: 'app' })).toBe('**/*.ts in app')
  expect(await detailAfter('WebFetch', { url: 'https://example.com/a', prompt: 'summarise' })).toBe('https://example.com/a')
  expect(await detailAfter('WebSearch', { query: 'kitty graphics protocol' })).toBe('kitty graphics protocol')
  expect(await detailAfter('mcp__docs__search', { q: 'line\nbreak', limit: 3 })).toBe('{"q":"line\\nbreak","limit":3}')

  const long = await detailAfter('Bash', { command: `echo ${'y'.repeat(300)}` })
  expect(long?.length).toBe(160)
  expect(long?.endsWith('…')).toBe(true)
})

test('history keeps the last 20 calls oldest first and toolCount counts them all', async ($, on) => {
  const { writes, clock } = setUpDetails(on)

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  await spawnAgent($, 'Write the docs', 'general-purpose')
  for (let i = 1; i <= 25; i++) await callTool($, 'agent-1', 'Bash', { command: `step ${i}` })
  await callTool($, 'agent-2', 'Read', { file_path: 'README.md' })
  await clock.advance(PUBLISH_MS)

  const [one, two] = stateOf(writes).workers
  expect(one?.toolCount).toBe(25)
  expect(one?.history?.map(h => h.detail)).toEqual(Array.from({ length: 20 }, (_, i) => `step ${i + 6}`))
  expect(one?.history?.every(h => h.tool === 'Bash' && typeof h.at === 'number')).toBe(true)
  const at = one?.history?.map(h => h.at) ?? []
  expect(at).toEqual([...at].sort((a, b) => a - b))
  expect(one?.detail).toBe('step 25')
  expect(two?.toolCount).toBe(1)
  expect(two?.history).toEqual([{ at: expect.any(Number), tool: 'Read', detail: 'README.md' }])
})

test("a subagent's answer is stored as its result, cut to 600 chars; no answer leaves it out", async ($, on) => {
  const { writes } = setUpDetails(on)

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  await spawnAgent($, 'Write the docs', 'general-purpose')
  await spawnAgent($, 'Long report', 'general-purpose')
  await completeTurn($, 'answer', 'agent-1', '  Found 3 bugs.\nAll in core.ts.  ')
  await completeTurn($, 'error', 'agent-2')
  await completeTurn($, 'answer', 'agent-3', 'z'.repeat(1000))

  const [one, two, three] = stateOf(writes).workers
  expect(one?.result).toBe('Found 3 bugs.\nAll in core.ts.')
  expect(one?.isOk).toBe(true)
  expect(two?.result).toBeUndefined()
  expect(two?.isOk).toBe(false)
  expect(three?.result?.length).toBe(600)
})

test('tool calls are coalesced into one write per PUBLISH_MS and the last state is always written', async ($, on) => {
  const { writes, clock } = setUpDetails(on)
  const stateWrites = () => writes.filter(w => w.path.endsWith('/sessions/session-1.json')).length
  on('session.end', (_$, e) => e as never)

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  await spawnAgent($, 'Write the docs', 'general-purpose')

  // a burst right after a write: nothing is written until PUBLISH_MS has passed, then once, with every call
  const before = stateWrites()
  for (let i = 1; i <= 5; i++) await callTool($, 'agent-1', 'Bash', { command: `step ${i}` })
  expect(stateWrites()).toBe(before)
  await clock.advance(PUBLISH_MS)
  expect(stateWrites()).toBe(before + 1)
  expect(stateOf(writes).workers[0]).toMatchObject({ toolCount: 5, detail: 'step 5' })
  await clock.advance(TICK_MS)
  expect(stateWrites()).toBe(before + 1)

  // calls still waiting on the throttle are written with the delivery
  await callTool($, 'agent-2', 'Read', { file_path: 'a.md' })
  await callTool($, 'agent-1', 'Read', { file_path: 'last.md' })
  await completeTurn($, 'answer', 'agent-2', 'done')
  const [one, two] = stateOf(writes).workers
  expect(one).toMatchObject({ toolCount: 6, detail: 'last.md' })
  expect(two).toMatchObject({ toolCount: 1, result: 'done', isOk: true })

  // and at session end
  await callTool($, 'agent-1', 'Grep', { pattern: 'end' })
  await $.session.end({ reason: 'exit', sessionId: 'session-1' } as never)
  expect(stateOf(writes).workers[0]).toMatchObject({ toolCount: 7, detail: 'end', tool: 'Grep' })
})
