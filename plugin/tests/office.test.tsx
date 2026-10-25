import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { OfficeStats } from '../types'

type Harness = Parameters<TestBody>[1]
type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

const ran = (exitCode: number, stdout = ''): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// a session in /work/my-app (or `root`) with the given environment; process.run answers from `run`, fs.read from `files`.
// `isTicking`: a mocked clock drives the plugin's ticker (advance it to run a tick)
function setUp(
  on: Harness,
  env: Record<string, string>,
  run: (argv: readonly string[]) => RunResult = () => ran(1),
  { files = {}, isTicking = false, root = '/work/my-app' }: { files?: Record<string, string>; isTicking?: boolean; root?: string } = {},
) {
  const writes: { path: string; text: string }[] = []
  const runs: (readonly string[])[] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  const commands: string[] = []
  const registered: { name: string; description?: string; argumentHint?: string }[] = []
  on('command.register', (_$, e) => {
    commands.push(e.name)
    registered.push(e)
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

  return { writes, runs, clock, commands, registered }
}

const nodeFound = (argv: readonly string[]) => (argv[0] === 'node' ? ran(0, '/usr/local/bin/node') : ran(1))
const start = { cwd: '/work/my-app', surface: 'terminal', isInteractive: true } as const
const band = {
  plugin: 'agent-office',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 120 } as never,
} as const

test('/office is registered in a terminal session with the split, band and stats hint', async ($, on) => {
  const { commands, registered } = setUp(on, { HOME: '/home/tester' })
  await $.session.start(start)
  expect(commands).toEqual(['office'])
  expect(registered[0]?.argumentHint).toBe('[band|stats]')
})

test('inside the Agent Office app /office is registered for the summary only and the state file is still written', async ($, on) => {
  const { registered, writes } = setUp(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1' })
  await $.session.start(start)
  expect(registered.map(r => r.name)).toEqual(['office'])
  expect(registered[0]?.argumentHint).toBe('[stats]')
  expect(registered[0]?.description).toContain("Today's summary")
  expect(writes.some(w => w.path.endsWith('/sessions/session-1.json'))).toBe(true)
})

// a claude started inside another one (app contract v3.12, nested sessions) inherits AGENT_OFFICE_APP: it writes no
// state file, so it never shows in the office, and /office works as outside the app
test('a nested claude inside the app writes no state file and registers /office as outside the app', async ($, on) => {
  const { registered, writes } = setUp(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-1' })
  await $.session.start(start)
  expect(registered[0]?.argumentHint).toBe('[band|stats]')
  expect(writes.filter(w => w.path.includes('/sessions/'))).toEqual([])
})

test('inside the Agent Office app the Turkish hint names only istatistik', async ($, on) => {
  const { registered } = setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', AGENT_OFFICE_APP: '1' })
  await $.session.start(start)
  expect(registered[0]?.argumentHint).toBe('[istatistik]')
})

// inside the app: stats and plain /office give the summary; band or anything else only points to the window
test('inside the Agent Office app /office stats and plain /office give the summary and start no viewer', async ($, on) => {
  const env = { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty', AGENT_OFFICE_APP: '1' }
  const { runs } = setUp(on, env, nodeFound)
  on('fs.list', () => ({ value: [] }))

  await $.session.start(start)
  for (const args of ['stats', 'STATS', '', '  ']) {
    const reply = await $.command.run({ command: 'office', args } as Parameters<typeof $.command.run>[0])
    expect((reply as { text: string }).text).toContain('Agent Office · today')
  }
  // no split, no node lookup, no viewer: opening the band or a split would run processes first
  expect(runs).toEqual([])
})

test('inside the Agent Office app /office istatistik answers in Turkish', async ($, on) => {
  setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', AGENT_OFFICE_APP: '1' }, nodeFound)
  on('fs.list', () => ({ value: [] }))

  await $.session.start(start)
  for (const args of ['istatistik', 'İSTATİSTİK']) {
    const reply = await $.command.run({ command: 'office', args } as Parameters<typeof $.command.run>[0])
    expect((reply as { text: string }).text).toContain('Agent Ofis · bugün')
  }
})

test('inside the Agent Office app /office band (or anything else) opens nothing and points to the window and stats', async ($, on) => {
  const env = { HOME: '/home/tester', LANG: 'en_US.UTF-8', TERM_PROGRAM: 'ghostty', AGENT_OFFICE_APP: '1' }
  const { runs } = setUp(on, env, nodeFound)

  await $.session.start(start)
  for (const args of ['band', 'band', 'whatever']) {
    const reply = await $.command.run({ command: 'office', args } as Parameters<typeof $.command.run>[0])
    expect((reply as { text: string }).text).toBe("The office is already shown in the Agent Office window. Run /office stats for today's summary.")
  }
  // the band stays closed: opening it would look up node and start the viewer, a split would run osascript
  expect(runs).toEqual([])
})

test('inside the Agent Office app /office şerit answers in Turkish and opens nothing', async ($, on) => {
  const { runs } = setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', AGENT_OFFICE_APP: '1' }, nodeFound)

  await $.session.start(start)
  const reply = await $.command.run({ command: 'office', args: 'şerit' } as Parameters<typeof $.command.run>[0])
  expect((reply as { text: string }).text).toContain('Ofis zaten Agent Ofis penceresinde görünüyor')
  expect((reply as { text: string }).text).toContain('/office istatistik')
  expect(runs).toEqual([])
})

// USERPROFILE is a POSIX-looking path in the Windows tests: the engine running them on macOS/Linux would resolve
// C:\... as a relative path
test('on Windows the state file goes under USERPROFILE and the project is the folder name', async ($, on) => {
  const env = { OS: 'Windows_NT', USERPROFILE: '/win/Users/tester', HOME: '/home/other', AGENT_OFFICE_APP: '1' }
  const { writes } = setUp(on, env, undefined, { root: 'C:\\work\\my-app' })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))

  await $.session.start({ ...start, cwd: 'C:\\work\\my-app' })
  const spawn = { prompt: 'scan', description: 'Scan the code', subagentType: 'Explore' }
  await $.agent.spawn(spawn as Parameters<typeof $.agent.spawn>[0])

  const last = writes[writes.length - 1]
  expect(last?.path).toBe('/win/Users/tester/.claude/agent-office/sessions/session-1.json')
  expect(JSON.parse(last?.text ?? '{}').project).toBe('my-app')
})

test('on Windows old session files are removed with cmd.exe, not /bin/rm', async ($, on) => {
  const root = '/win/Users/tester/.claude/agent-office'
  const old = Date.now() - 48 * 60 * 60_000
  const files = { [`${root}/sessions/ended.json`]: JSON.stringify({ updatedAt: old, endedAt: old }) }
  const { runs } = setUp(on, { OS: 'Windows_NT', USERPROFILE: '/win/Users/tester' }, undefined, { files, root: 'C:\\work\\my-app' })
  const listing: Record<string, unknown[]> = {
    [`${root}/sessions`]: [{ name: 'ended.json', kind: 'file', size: 0, mtimeMs: old, isLink: false }],
  }
  on('fs.list', (_$, e) => ({ value: (listing[e.path ?? ''] ?? []) as never }))

  await $.session.start({ ...start, cwd: 'C:\\work\\my-app' })

  const target = '\\win\\Users\\tester\\.claude\\agent-office\\sessions\\ended.json'
  expect(runs.some(argv => argv[0] === '/bin/rm')).toBe(false)
  expect(runs).toContainEqual(['cmd.exe', '/d', '/c', 'rmdir', '/s', '/q', target])
  expect(runs).toContainEqual(['cmd.exe', '/d', '/c', 'del', '/f', '/q', target])
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
  // the day's log keeps each delivery after its worker leaves (contract v2.9)
  const log = state.stats.today.log as { id: string; type: string; description: string; isOk: boolean; toolCount: number; spawnAt: number; doneAt: number }[]
  expect(log.map(d => [d.id, d.description, d.isOk]).sort()).toEqual([['agent-1', 'one', true], ['agent-2', 'two', false], ['agent-3', 'three', false]])
  expect(log.every(d => d.type === 'Explore' && d.toolCount === 0 && d.doneAt >= d.spawnAt)).toBe(true)
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
    dir?: string
  }[]
  stats: OfficeStats
  format?: number
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

test("a subagent's answer is stored as its result, cut to 4000 chars; no answer leaves it out", async ($, on) => {
  const { writes } = setUpDetails(on)

  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  await spawnAgent($, 'Write the docs', 'general-purpose')
  await spawnAgent($, 'Long report', 'general-purpose')
  await completeTurn($, 'answer', 'agent-1', '  Found 3 bugs.\nAll in core.ts.  ')
  await completeTurn($, 'error', 'agent-2')
  await completeTurn($, 'answer', 'agent-3', 'z'.repeat(5000))

  const [one, two, three] = stateOf(writes).workers
  expect(one?.result).toBe('Found 3 bugs.\nAll in core.ts.')
  expect(one?.isOk).toBe(true)
  expect(two?.result).toBeUndefined()
  expect(two?.isOk).toBe(false)
  expect(three?.result?.length).toBe(4000)
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

// background shells (contract v2.3)

type ShellState = { id: string; command: string; description?: string; agentId?: string; startAt: number; endAt?: number; exitCode?: number; status?: string }
const shellsOf = (writes: { path: string; text: string }[]): ShellState[] => lastState(writes).shells ?? []

// a session whose tools answer like the engine: a background Bash (run_in_background, or `backgroundTaskId`
// given in args as a stand-in for Ctrl+B) gets task id bash-1, bash-2…, Monitor mon-1…, TaskStop names its task
function setUpShells(on: Harness) {
  const set = setUpTicking(on, { HOME: '/home/tester' })
  let spawned = 0
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++spawned}` }))
  on('agent.list', () => ({ value: [] }))
  answerTurns(on)
  let tasks = 0
  on('tool.call', (_$, e) => {
    const args = e as unknown as Record<string, unknown>
    if (args.tool === 'Bash' && args.command === 'refused') return { deny: 'denied' } as never
    if (args.tool === 'Bash' && (args.run_in_background || args.ctrlB))
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `bash-${++tasks}`, ...(args.dies ? { backgroundEndsWithFinalResponse: true } : {}) } } as never
    if (args.tool === 'Bash') return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
    if (args.tool === 'Monitor') return { result: { taskId: `mon-${++tasks}`, timeoutMs: 1000 } } as never
    if (args.tool === 'TaskStop') return { result: { message: 'stopped', task_id: args.task_id, task_type: 'local_bash' } } as never
    return { result: 'ok' } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  return set
}

const notification = (taskId: string, status: string, summary: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`

test('a background Bash call records a running shell; a foreground one does not', async ($, on) => {
  const { writes, clock } = setUpShells(on)

  await $.session.start(start)
  await spawnAgent($, 'Run the tests', 'general-purpose')
  await $.tool.call({ tool: 'Bash', command: 'npm run dev\n  --port 3000', description: 'Start the dev server', run_in_background: true } as never)
  await callTool($, 'agent-1', 'Bash', { command: 'npm test', description: 'Run tests', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' } as never)
  await $.tool.call({ tool: 'Bash', command: 'refused', run_in_background: true } as never)
  // a foreground command moved to the background (Ctrl+B) carries backgroundTaskId too
  await $.tool.call({ tool: 'Bash', command: 'make all', ctrlB: true } as never)
  await $.tool.call({ tool: 'Monitor', command: 'tail -f log', description: 'Watch the log', timeout_ms: 1000 } as never)
  await $.tool.call({ tool: 'Monitor', ws: { url: 'wss://x' }, description: 'Socket', timeout_ms: 1000 } as never)
  await clock.advance(PUBLISH_MS)

  const shells = shellsOf(writes)
  expect(shells.map(s => [s.id, s.command, s.description, s.agentId, s.status, s.endAt])).toEqual([
    ['bash-1', 'npm run dev --port 3000', 'Start the dev server', undefined, 'running', undefined],
    ['bash-2', 'npm test', 'Run tests', 'agent-1', 'running', undefined],
    ['bash-3', 'make all', undefined, undefined, 'running', undefined],
    ['mon-4', 'tail -f log', 'Watch the log', undefined, 'running', undefined],
  ])
  expect(shells.every(s => typeof s.startAt === 'number')).toBe(true)
})

test('a background shell ends by its notification with the exit code, by TaskStop, its agent answering, Stop or session end', async ($, on) => {
  const { writes, clock } = setUpShells(on)
  on('session.end', (_$, e) => e as never)

  await $.session.start(start)
  await spawnAgent($, 'Build', 'general-purpose')
  for (let i = 1; i <= 7; i++) await $.tool.call({ tool: 'Bash', command: `job ${i}`, run_in_background: true } as never)
  await callTool($, 'agent-1', 'Bash', { command: 'watch build', run_in_background: true, dies: true })

  // idle: the notification is submitted as a prompt
  await $.prompt.submit({ text: notification('bash-1', 'completed', 'Background command "job 1" completed (exit code 0)'), origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: notification('bash-2', 'failed', 'Background command "job 2" failed with exit code 144'), origin: { kind: 'task-notification' } } as never)
  // a typed prompt quoting a notification ends nothing
  await $.prompt.submit({ text: notification('bash-5', 'completed', 'completed (exit code 0)'), origin: { kind: 'composer' } } as never)
  // mid-turn: absorbed as an attachment row
  await $.session.append({
    message: { type: 'attachment', name: 'queued_command', content: [{ type: 'text', text: `<system-reminder>${notification('bash-3', 'killed', 'Background command "job 3" was stopped')}</system-reminder>` }] },
    door: 'attachment',
    origin: { kind: 'task-notification' },
    uuid: 'row-1',
  } as never)
  await $.tool.call({ tool: 'TaskStop', task_id: 'bash-4' } as never)
  await completeTurn($, 'answer', 'agent-1', 'built')
  await clock.advance(PUBLISH_MS)

  let shells = shellsOf(writes)
  const ended = () => shellsOf(writes).map(s => [s.id, s.status, s.exitCode, typeof s.endAt])
  expect(ended()).toEqual([
    ['bash-1', 'completed', 0, 'number'],
    ['bash-2', 'failed', 144, 'number'],
    ['bash-3', 'killed', undefined, 'number'],
    ['bash-4', 'killed', undefined, 'number'],
    ['bash-5', 'running', undefined, 'undefined'],
    ['bash-6', 'running', undefined, 'undefined'],
    ['bash-7', 'running', undefined, 'undefined'],
    ['bash-8', 'killed', undefined, 'number'],
  ])
  // a second notification for an ended shell changes nothing
  const endAt = shells[0]?.endAt
  await $.prompt.submit({ text: notification('bash-1', 'failed', 'failed with exit code 1'), origin: { kind: 'task-notification' } } as never)
  await clock.advance(PUBLISH_MS)
  shells = shellsOf(writes)
  expect([shells[0]?.status, shells[0]?.exitCode, shells[0]?.endAt]).toEqual(['completed', 0, endAt])

  // Stop lists what is still in flight: a running shell missing from it has ended
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bash-6', type: 'shell', status: 'running', description: 'job 6' }, { id: 'bash-7', type: 'shell', status: 'running', description: 'job 7' }] })
  await clock.advance(PUBLISH_MS)
  expect(ended()[4]).toEqual(['bash-5', 'completed', undefined, 'number'])

  // the session ending stops the rest
  await $.session.end({ reason: 'exit', sessionId: 'session-1' } as never)
  expect(ended().slice(5)).toEqual([
    ['bash-6', 'killed', undefined, 'number'],
    ['bash-7', 'killed', undefined, 'number'],
    ['bash-8', 'killed', undefined, 'number'],
  ])
})

test('at most 20 shells are kept: finished ones are dropped first, then the oldest running', async ($, on) => {
  const { writes, clock } = setUpShells(on)

  await $.session.start(start)
  for (let i = 1; i <= 20; i++) await $.tool.call({ tool: 'Bash', command: `job ${i}`, run_in_background: true } as never)
  await $.prompt.submit({ text: notification('bash-5', 'completed', 'completed (exit code 0)'), origin: { kind: 'task-notification' } } as never)
  await $.tool.call({ tool: 'Bash', command: 'job 21', run_in_background: true } as never)
  await clock.advance(PUBLISH_MS)
  let ids = shellsOf(writes).map(s => s.id)
  expect(ids.length).toBe(20)
  expect(ids.includes('bash-5')).toBe(false)
  expect(ids[0]).toBe('bash-1')

  await $.tool.call({ tool: 'Bash', command: 'job 22', run_in_background: true } as never)
  await clock.advance(PUBLISH_MS)
  ids = shellsOf(writes).map(s => s.id)
  expect(ids.length).toBe(20)
  expect([ids[0], ids[19]]).toEqual(['bash-2', 'bash-22'])
})

test('a finished shell leaves the state file once FORGET_MS has passed; running ones stay', async ($, on) => {
  const { writes, clock } = setUpShells(on)
  const now = Date.now()
  const shell = (id: string, endAgo?: number) => ({
    id,
    command: id,
    startAt: now - FORGET_MS * 2,
    ...(endAgo === undefined ? { status: 'running' } : { endAt: now - endAgo, exitCode: 0, status: 'completed' }),
  })
  const seed = [shell('long-gone', FORGET_MS + 60_000), shell('just-done', 60_000), shell('still-running')]
  let isRewritten = false
  on('state.get', async (_$, e, next) => {
    const read = await next(e)
    return e.key === 'shells' && !isRewritten && read.value ? { ...read, value: { ...read.value, value: seed } } : read
  })
  on('state.set', (_$, e, next) => {
    if (e.key === 'shells') isRewritten = true
    return next(e)
  })

  await $.session.start(start)
  expect(shellsOf(writes).map(s => s.id)).toEqual(['long-gone', 'just-done', 'still-running'])
  await clock.advance(TICK_MS)
  expect(shellsOf(writes).map(s => s.id)).toEqual(['just-done', 'still-running'])
})

test('a permission dialog marks the session waiting until its tool is answered, a prompt comes or the turn ends', async ($, on) => {
  const { writes } = setUp(on, { HOME: '/home/tester' })
  answerTurns(on)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('classic.PermissionRequest', () => ({}) as never)

  await $.session.start(start)
  await $.turn.start({ text: 'hello', turnId: 'turn-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  const waiting = stateOf(writes).stats.waiting
  expect(waiting?.kind).toBe('permission')
  expect(waiting?.tool).toBe('Bash')
  expect(typeof waiting?.since).toBe('number')
  // another tool finishing does not close Bash's dialog
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  expect(stateOf(writes).stats.waiting?.tool).toBe('Bash')
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  expect(stateOf(writes).stats.waiting).toBe(undefined)

  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: {} })
  expect(stateOf(writes).stats.waiting?.tool).toBe('Edit')
  await completeTurn($, 'aborted')
  expect(stateOf(writes).stats.waiting).toBe(undefined)
  expect(stateOf(writes).format).toBe(2)
  expect(stateOf(writes).stats.isBossBusy).toBe(false)
})

// /office stats: today's deliveries from every session file, plus what works and runs right now
test('/office stats sums today across sessions: count, failed, agent time, per project, last ones, working agents and shells', async ($, on) => {
  const root = '/home/tester/.claude/agent-office'
  // the plugin reads its own Date.now(): a run that straddles midnight would see another day than `today` below
  const toMidnight = new Date(Date.now()).setHours(24, 0, 0, 0) - Date.now()
  if (toMidnight < 5_000) await new Promise(resolve => setTimeout(resolve, toMidnight + 50))
  const now = Date.now()
  // ended.json's delivery is always the oldest of the three (b 1s ago, a 2s ago, c >= 3s ago) so "Last deliveries"
  // has one order at any time of day; "an hour ago", but not before midnight unless the day is under 6s old
  const earlier = Math.max(3_000, Math.min(HOUR, Math.floor((now - new Date(now).setHours(0, 0, 0, 0)) / 2)))
  const today = (() => {
    const d = new Date(now)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const delivery = (id: string, type: string, description: string, minutes: number, isOk = true, ago = 60_000) =>
    ({ id, type, description, spawnAt: now - ago - minutes * 60_000, doneAt: now - ago, isOk, toolCount: 3 })
  const sessions: Record<string, unknown> = {
    // another live session: two deliveries, one agent at work, one shell running
    'other.json': {
      format: 2, project: 'api', updatedAt: now - 10_000,
      workers: [{ id: 'w-1', type: 'Explore', description: 'Map the routes', spawnAt: now - 5000 }],
      shells: [{ id: 'sh-1', command: 'npm run dev', startAt: now - 9000, status: 'running' }, { id: 'sh-2', command: 'ls', startAt: now - 9000, endAt: now - 8000, status: 'completed' }],
      stats: { delivered: 2, isBossBusy: true, today: { date: today, ids: ['a', 'b'], log: [delivery('a', 'Explore', 'Scan the code', 2, true, 2_000), delivery('b', 'general-purpose', 'Fix the bug', 10, false, 1_000)] } },
    },
    // ended today: its delivery counts, its leftover worker does not work any more
    'ended.json': {
      format: 2, project: 'web', updatedAt: now - earlier, endedAt: now - earlier,
      workers: [{ id: 'w-9', type: 'Plan', description: 'gone', spawnAt: now - 2 * HOUR }],
      stats: { delivered: 1, isBossBusy: false, today: { date: today, ids: ['c', 'd'], log: [delivery('c', 'Plan', 'Plan the release', 1, true, earlier)] } },
    },
    // yesterday's file and a newer format are left out
    'yesterday.json': { format: 2, project: 'old', updatedAt: now - 48 * HOUR, stats: { delivered: 5, isBossBusy: false, today: { date: '2000-01-01', ids: ['x'], log: [] } } },
    'future.json': { format: 99, project: 'new', updatedAt: now, stats: { delivered: 1, isBossBusy: false, today: { date: today, ids: ['y'], log: [delivery('y', 'Explore', 'future', 1)] } } },
  }
  const files = Object.fromEntries(Object.entries(sessions).map(([name, s]) => [`${root}/sessions/${name}`, JSON.stringify(s)]))
  setUp(on, { HOME: '/home/tester', LANG: 'en_US.UTF-8' }, undefined, { files })
  on('fs.list', (_$, e) => ({
    value: e.path === `${root}/sessions`
      ? [entry('other.json', 'file', now), entry('ended.json', 'file', now - earlier), entry('yesterday.json', 'file', now - 48 * HOUR), entry('future.json', 'file', now)]
      : [],
  }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))

  await $.session.start(start)
  await spawnAgent($, 'Write the docs', 'general-purpose')
  const reply = await $.command.run({ command: 'office', args: 'stats' } as Parameters<typeof $.command.run>[0])
  const text = (reply as { text: string }).text
  const lines = text.split('\n')

  expect(lines[0]).toBe(`Agent Office · today (${today})`)
  // 3 logged + 1 delivery without a log entry (ended.json has 2 ids, 1 log row); 13 minutes of agent time
  expect(lines[1]).toBe('Delivered: 4 (1 failed) · agent time 13m 0s')
  expect(text).toContain('+1 more without details')
  expect(text).toContain('  api: 2 · 12m 0s')
  expect(text).toContain('  web: 1 · 1m 0s')
  expect(text).not.toContain('future')
  // newest first, with project names as there are several
  const last = lines.slice(lines.indexOf('Last deliveries:') + 1, lines.indexOf('Last deliveries:') + 4)
  expect(last.map(l => l.replace(/^ {2}\d\d:\d\d /, ''))).toEqual([
    '✗ general-purpose · Fix the bug · 10m 0s (api)',
    '✓ Explore · Scan the code · 2m 0s (api)',
    '✓ Plan · Plan the release · 1m 0s (web)',
  ])
  expect(text).toContain('Working now: 2 · ')
  expect(text).toContain('Explore "Map the routes" (api)')
  expect(text).toContain('general-purpose "Write the docs" (my-app)')
  expect(text).not.toContain('gone')
  expect(text).toContain('Background shells running: 1 · npm run dev (api)')
})

test('/office istatistik answers in Turkish and without deliveries says so; it opens no view', async ($, on) => {
  const { runs } = setUp(on, { HOME: '/home/tester', LANG: 'tr_TR.UTF-8', TERM_PROGRAM: 'ghostty' }, nodeFound)
  on('fs.list', () => ({ value: [] }))

  await $.session.start(start)
  for (const args of ['istatistik', 'İSTATİSTİK', 'stats']) {
    const reply = await $.command.run({ command: 'office', args } as Parameters<typeof $.command.run>[0])
    const text = (reply as { text: string }).text
    expect(text).toContain('Agent Ofis · bugün')
    expect(text).toContain('Bugün henüz teslim yok.')
    expect(text).toContain('Şu an çalışan: yok')
    expect(text).toContain('Çalışan arka plan komutu: yok')
  }
  expect(runs.some(argv => argv[0] === '/usr/bin/osascript')).toBe(false)
  // the band stayed closed: /office şerit now opens it rather than closing it
  const opened = await $.command.run({ command: 'office', args: 'şerit' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(opened)).toContain('şeridi açıldı')
})

// manager mode: the engine's own prompt stands beneath the plugin as one shared section
function setUpCompose(on: Harness, env: Record<string, string>) {
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
}
const composing = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], outputStyle: null } as const
const mainLoop = { ...composing, tools: ['Agent', 'Bash', 'Read'], traits: [] }

test('inside the app with manager mode on, the manager section is appended to the system prompt once', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' })
  const { sections } = await $.prompt.compose(mainLoop)
  expect(sections.map(s => s.id)).toEqual(['intro', 'agent-office:manager', 'agent-office:host'])
  const manager = sections[1]
  expect(manager?.scope).toBe('session')
  expect(manager?.text).toContain('You are the manager in Agent Office')
  expect(manager?.text).toContain("Don't end a turn with remaining work")
  expect(manager?.text).toContain('take precedence over this')
  // work across projects (app contract v3.5): another project's job is done in its folder, so it shows up there
  expect(manager?.text).toContain("work in that project's folder with absolute paths")
  // the text is the same on every request (prompt cache)
  const again = await $.prompt.compose(mainLoop)
  expect(again.sections[1]?.text).toBe(manager?.text)
})

// model per agent (app contract v3.14): the boss picks with the Agent tool's model parameter, unless the project pins it
test('the manager brief says one scoped task per agent and which model each kind of job gets', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' })
  const text = (await $.prompt.compose(mainLoop)).sections[1]?.text ?? ''
  expect(text).toContain('One scoped task per agent')
  expect(text).toContain('start a fresh agent for the next task')
  expect(text).toContain('"haiku" for searches and lookups')
  expect(text).toContain('"sonnet" for mechanical edits, test and build runs and routine fixes')
  expect(text).toContain('design, hard debugging and reviews')
  expect(text).not.toContain('{{MODEL}}')
})

// a model set without forcing it is only the default for agents started without one: the boss still picks
test('CLAUDE_CODE_SUBAGENT_MODEL without _FORCE keeps the model advice', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })
  expect((await $.prompt.compose(mainLoop)).sections[1]?.text).toContain('"haiku" for searches and lookups')
})

for (const [model, shown] of [['sonnet', 'Sonnet'], ['HAIKU', 'Haiku'], ['opus', 'Opus'], ['claude-sonnet-4-6', 'claude-sonnet-4-6'], ['', 'your own model']] as const) {
  test(`a project that pins agents to "${model}" gets the pinned line instead of the model advice`, async ($, on) => {
    const env: Record<string, string> = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }
    if (model) env.CLAUDE_CODE_SUBAGENT_MODEL = model
    setUpCompose(on, env)
    const manager = (await $.prompt.compose(mainLoop)).sections[1]
    expect(manager?.scope).toBe('session')
    expect(manager?.text).toContain(`Every agent of this session runs on ${shown} (the person's setting in Agent Office)`)
    expect(manager?.text).toContain("don't set the Agent tool's model parameter")
    expect(manager?.text).not.toContain('"haiku" for searches')
    expect(manager?.text).toContain('One scoped task per agent')
    expect((await $.prompt.compose(mainLoop)).sections[1]?.text).toBe(manager?.text)
  })
}

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=0 is no pin', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_MANAGER: '1', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })
  expect((await $.prompt.compose(mainLoop)).sections[1]?.text).toContain('"haiku" for searches and lookups')
})

for (const [name, env, ids] of [
  ['inside the app with manager mode off', { HOME: '/home/tester', AGENT_OFFICE_APP: '1' }, ['intro', 'agent-office:host']],
  ['inside the app with AGENT_OFFICE_MANAGER=0', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '0' }, ['intro', 'agent-office:host']],
  ['outside the app without opting in', { HOME: '/home/tester' }, ['intro']],
] as const) {
  test(`${name} there is no manager section`, async ($, on) => {
    setUpCompose(on, env)
    expect((await $.prompt.compose(mainLoop)).sections.map(s => s.id)).toEqual(ids)
  })
}

// the host (app contract v3.51): every loop inside the app learns it runs in Agent Office, manager on or off
test('inside the app every loop gets the host section: Agent Office is the process, its permissions need a reopen', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1' })
  const host = (await $.prompt.compose(mainLoop)).sections.find(s => s.id === 'agent-office:host')
  expect(host?.scope).toBe('session')
  const text = host?.text ?? ''
  expect(text).toContain('You run inside the Agent Office desktop app (its built-in terminal), not Terminal, iTerm or VS Code.')
  expect(text).toContain('Screen Recording, Accessibility, Automation, Files) are granted to Agent Office')
  expect(text).toContain('quits and reopens Agent Office')
  expect(text).toContain('Never quit or restart Agent Office yourself.')
  expect(text.length).toBeLessThanOrEqual(500)
  // the same text on every request (prompt cache), and for a subagent or a teammate too
  expect((await $.prompt.compose(mainLoop)).sections.find(s => s.id === 'agent-office:host')?.text).toBe(text)
  expect((await $.prompt.compose({ ...composing, tools: ['Bash'], traits: [] })).sections.map(s => s.id)).toEqual(['intro', 'agent-office:host'])
  expect((await $.prompt.compose({ ...composing, tools: ['Agent'], traits: ['teammate'] })).sections.map(s => s.id)).toEqual(['intro', 'agent-office:host'])
})

test('an HQ session under the app gets the host section too', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_HQ: '1' })
  const host = (await $.prompt.compose(mainLoop)).sections.find(s => s.id === 'agent-office:host')
  expect(host?.text).toContain('You run inside the Agent Office desktop app')
})

test('on Windows the host section has no macOS permissions sentence', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', OS: 'Windows_NT', AGENT_OFFICE_APP: '1' })
  const text = (await $.prompt.compose(mainLoop)).sections.find(s => s.id === 'agent-office:host')?.text ?? ''
  expect(text).toContain('not Terminal, iTerm or VS Code')
  expect(text).not.toContain('macOS')
  expect(text).toContain('Never quit or restart Agent Office yourself.')
})

for (const [name, env] of [
  ['outside the app', { HOME: '/home/tester', AGENT_OFFICE_MANAGER: '1' }],
  ['in a nested claude', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', CLAUDECODE: '1' }],
  ['in a nested claude (CLAUDE_CODE_CHILD_SESSION)', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['in a nested claude (CLAUDE_CODE_SESSION_ID of a parent)', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', CLAUDE_CODE_SESSION_ID: 'parent-1' }],
] as const) {
  test(`${name} there is no host section`, async ($, on) => {
    setUpCompose(on, env)
    expect((await $.prompt.compose(mainLoop)).sections.map(s => s.id)).not.toContain('agent-office:host')
  })
}

test('without the app the plugin user opts in with AGENT_OFFICE_MANAGER=1', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_MANAGER: '1' })
  expect((await $.prompt.compose(mainLoop)).sections.map(s => s.id)).toEqual(['intro', 'agent-office:manager'])
})

test('a loop that cannot start agents, or a teammate, gets no manager section', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' })
  expect((await $.prompt.compose({ ...composing, tools: ['Bash', 'Read'], traits: [] })).sections.map(s => s.id)).toEqual(['intro', 'agent-office:host'])
  expect((await $.prompt.compose({ ...composing, tools: ['Agent'], traits: ['teammate'] })).sections.map(s => s.id)).toEqual(['intro', 'agent-office:host'])
})

test('a nested claude gets neither the manager section nor the directory', async ($, on) => {
  const env = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', AGENT_OFFICE_DIRECTORY: '/ud/directory/p1.json', CLAUDECODE: '1' }
  setUpCompose(on, env)
  on('fs.read', () => ({ value: JSON.stringify({ format: 1, projects: [{ name: 'a', dir: '/a', account: 'Default', mcp: [], current: true }] }) }))
  on('session.id', () => ({ value: 'session-1' }))
  expect((await $.prompt.compose(mainLoop)).sections.map(s => s.id)).toEqual(['intro'])
})

// the office directory (app contract v3.9): the app's per-tab file becomes one section for every loop in the app
function setUpDirectory(on: Harness, env: Record<string, string>, files: Record<string, string>) {
  setUpCompose(on, env)
  const reads: string[] = []
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  return { reads }
}
const DIRECTORY_FILE = '/ud/directory/p1.json'
const directory = {
  format: 1,
  projects: [
    { name: 'new-gen-bpm', dir: '/work/new-gen-bpm', account: 'Default', mcp: ['nodesyai-onprem'], current: true },
    { name: 'nodesyai-connect', dir: '/work/connect/nodesyai-connect', account: 'NodesyAI', mcp: ['nodesyai-onprem-nodesyai-connect', 'nodesyai-flow'] },
    { name: 'notes', dir: '/work/notes', account: 'Default', mcp: [] },
  ],
}

test('inside the app the office directory lists every project with its folder, account and MCP servers, the current one marked', async ($, on) => {
  setUpDirectory(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }, { [DIRECTORY_FILE]: JSON.stringify(directory) })
  const { sections } = await $.prompt.compose(mainLoop)
  expect(sections.map(s => s.id)).toEqual(['intro', 'agent-office:host', 'agent-office:projects'])
  const text = sections[2]?.text ?? ''
  expect(sections[2]?.scope).toBe('session')
  expect(text).toContain('# Projects in this Agent Office')
  expect(text).toContain("- new-gen-bpm (this session's project): /work/new-gen-bpm (account Default; MCP: nodesyai-onprem)")
  expect(text).toContain('- nodesyai-connect: /work/connect/nodesyai-connect (account NodesyAI; MCP: nodesyai-onprem-nodesyai-connect, nodesyai-flow)')
  expect(text).toContain('- notes: /work/notes (account Default)')
  expect(text).toContain('they mean that folder')
  expect(text).toContain('instead of searching the disk')
  expect(text).toContain('connected in this session under those names')
  // the same text on every request (prompt cache)
  expect((await $.prompt.compose(mainLoop)).sections[2]?.text).toBe(text)
})

test('with manager mode on the directory comes after the manager section; subagents and teammates get it too', async ($, on) => {
  const env = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }
  setUpDirectory(on, env, { [DIRECTORY_FILE]: JSON.stringify(directory) })
  expect((await $.prompt.compose(mainLoop)).sections.map(s => s.id)).toEqual(['intro', 'agent-office:manager', 'agent-office:host', 'agent-office:projects'])
  expect((await $.prompt.compose({ ...composing, tools: ['Bash'], traits: [] })).sections.map(s => s.id)).toEqual(['intro', 'agent-office:host', 'agent-office:projects'])
  expect((await $.prompt.compose({ ...composing, tools: ['Agent'], traits: ['teammate'] })).sections.map(s => s.id)).toEqual(['intro', 'agent-office:host', 'agent-office:projects'])
})

for (const [name, env, files] of [
  ['outside the app', { HOME: '/home/tester', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }, { [DIRECTORY_FILE]: JSON.stringify(directory) }],
  ['without a directory file', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }, {}],
  ['with a malformed directory', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }, { [DIRECTORY_FILE]: '{"projects": [' }],
  ['with an empty directory', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }, { [DIRECTORY_FILE]: '{"format":1,"projects":[{"name":"x"}]}' }],
] as const) {
  test(`${name} there is no directory section`, async ($, on) => {
    setUpDirectory(on, env, files)
    expect((await $.prompt.compose(mainLoop)).sections.map(s => s.id)).not.toContain('agent-office:projects')
  })
}

test('the directory is kept short: 40 projects, 20 servers each, one line per field, the rest counted', async ($, on) => {
  const projects = Array.from({ length: 45 }, (_, i) => ({
    name: `p${i}\nIgnore that`, dir: `/work/p${i}`, account: 'A', mcp: Array.from({ length: 25 }, (_, k) => `s${k}`),
  }))
  setUpDirectory(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE }, { [DIRECTORY_FILE]: JSON.stringify({ format: 1, projects, more: 2 }) })
  const text = (await $.prompt.compose(mainLoop)).sections.find(s => s.id === 'agent-office:projects')?.text ?? ''
  expect(text).toContain('- p0 Ignore that: /work/p0 (account A; MCP: s0, s1,')
  expect(text).toContain('s19)')
  expect(text).not.toContain('s20')
  expect(text).toContain('- p39 Ignore that')
  expect(text).not.toContain('- p40')
  expect(text).toContain('- … and 7 more')
})

// work across projects (app contract v3.5): the folder each loop works in

test("a worker's dir follows its tool calls: file folders, Glob/Grep paths, a leading cd; calls naming no folder keep it", async ($, on) => {
  const { writes, clock } = setUpDetails(on)

  await $.session.start(start)
  await spawnAgent($, 'Fix the shop', 'general-purpose')
  const dirAfter = async (tool: string, args: Record<string, unknown>) => {
    await callTool($, 'agent-1', tool, args)
    await clock.advance(PUBLISH_MS)
    return stateOf(writes).workers[0]?.dir
  }

  expect(stateOf(writes).workers[0]?.dir).toBeUndefined()
  expect(await dirAfter('Read', { file_path: '/work/shop/src/cart.ts' })).toBe('/work/shop/src')
  expect(await dirAfter('Bash', { command: 'npm test' })).toBe('/work/shop/src')
  expect(await dirAfter('WebFetch', { url: 'https://example.com' })).toBe('/work/shop/src')
  expect(await dirAfter('Edit', { file_path: 'lib/a.ts', old_string: 'a', new_string: 'b' })).toBe('/work/my-app/lib')
  expect(await dirAfter('Bash', { command: 'cd "/work/blog" && npm run build' })).toBe('/work/blog')
  expect(await dirAfter('Bash', { command: 'git -C /work/shop status' })).toBe('/work/shop')
  expect(await dirAfter('Grep', { pattern: 'TODO', path: '/work/blog/posts' })).toBe('/work/blog/posts')
  expect(await dirAfter('Glob', { pattern: '*.md' })).toBe('/work/my-app')
  expect(await dirAfter('NotebookEdit', { notebook_path: 'C:\\work\\nb\\a.ipynb', new_source: 'x' })).toBe('C:\\work\\nb')
  expect(await dirAfter('Write', { file_path: '~/notes/todo.md', content: 'x' })).toBe('/home/tester/notes')
})

test("a subagent started with a cwd works there first, and its relative paths count from it", async ($, on) => {
  const { writes, clock } = setUpDetails(on)

  await $.session.start(start)
  await $.agent.spawn({ prompt: 'go', description: 'Blog', subagentType: 'Explore', cwd: '/work/blog' } as Parameters<typeof $.agent.spawn>[0])
  expect(stateOf(writes).workers[0]?.dir).toBe('/work/blog')
  await callTool($, 'agent-1', 'Read', { file_path: 'posts/a.md' })
  await clock.advance(PUBLISH_MS)
  expect(stateOf(writes).workers[0]?.dir).toBe('/work/blog/posts')
})

test("the boss's folder this turn: main-loop calls set stats.bossDir, its own folder writes nothing, a new turn forgets it", async ($, on) => {
  const { writes, clock } = setUpDetails(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix the shop', turnId: 'turn-1' })
  const before = writes.length
  await $.tool.call({ tool: 'Read', file_path: '/work/my-app/README.md' } as never)
  await clock.advance(PUBLISH_MS)
  expect(writes.length).toBe(before)
  expect(stateOf(writes).stats.bossDir).toBeUndefined()

  await $.tool.call({ tool: 'Edit', file_path: '/work/shop/a.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.advance(PUBLISH_MS)
  expect(stateOf(writes).stats.bossDir).toBe('/work/shop')
  expect(stateOf(writes).stats.isBossBusy).toBe(true)

  await completeTurn($, 'answer')
  expect(stateOf(writes).stats.bossDir).toBeUndefined()
  await $.turn.start({ text: 'again', turnId: 'turn-2' })
  expect(stateOf(writes).stats.bossDir).toBeUndefined()
})

test("CwdChanged moves the main loop (bossDir, relative paths) and a subagent's dir", async ($, on) => {
  const { writes, clock } = setUpDetails(on)
  on('classic.CwdChanged', () => ({}) as never)

  await $.session.start(start)
  await spawnAgent($, 'Scan', 'Explore')
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await $.classic.CwdChanged({ old_cwd: '/work/my-app', new_cwd: '/work/shop' })
  await clock.advance(PUBLISH_MS)
  expect(stateOf(writes).stats.bossDir).toBe('/work/shop')
  await $.classic.CwdChanged({ old_cwd: '/work/my-app', new_cwd: '/work/blog', agent_id: 'agent-1' })
  await clock.advance(PUBLISH_MS)
  expect(stateOf(writes).workers[0]?.dir).toBe('/work/blog')

  // the next turn starts where the main loop now runs
  await completeTurn($, 'answer')
  await $.turn.start({ text: 'again', turnId: 'turn-2' })
  expect(stateOf(writes).stats.bossDir).toBe('/work/shop')
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as never)
  await clock.advance(PUBLISH_MS)
  expect(stateOf(writes).stats.bossDir).toBe('/work/shop')
})

// manager mode's nudge: the main loop's own calls in a row this turn; the reminder rides the sixth call's result
function setUpNudge(on: Harness, env: Record<string, string> = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' }) {
  setUp(on, env)
  on('tool.call', (_$, e) => (e.tool === 'Write' ? ({ deny: 'no' }) : ({ result: 'ok' })) as never)
  answerTurns(on)
}
const nudgeOf = (answer: unknown) => ((answer as { context?: string[] }).context ?? []).filter(text => text.includes('Agent Office manager mode'))
const mainCall = ($: Engine, tool: string, args: Record<string, unknown> = {}) => $.tool.call({ tool, ...args } as never)

test('manager mode nudges the main loop on its sixth own call in a row this turn, then not on the next calls', async ($, on) => {
  setUpNudge(on)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  for (let i = 1; i <= 5; i++) expect(nudgeOf(await mainCall($, i % 2 ? 'Bash' : 'Read', { command: 'ls', file_path: '/a' }))).toEqual([])
  const sixth = await mainCall($, 'mcp__shop__list_orders')
  expect(nudgeOf(sixth)).toHaveLength(1)
  expect(nudgeOf(sixth)[0]).toContain('6 steps')
  expect((sixth as { result?: unknown }).result).toBe('ok')
  // not on every call (the next one comes NUDGE_REPEAT calls later)
  for (let i = 0; i < 8; i++) expect(nudgeOf(await mainCall($, 'Bash', { command: 'ls' }))).toEqual([])
  // a new turn counts afresh
  await completeTurn($, 'answer')
  await $.turn.start({ text: 'more', turnId: 'turn-2' })
  for (let i = 1; i <= 5; i++) expect(nudgeOf(await mainCall($, 'Edit', { file_path: '/a' }))).toEqual([])
  expect(nudgeOf(await mainCall($, 'Edit', { file_path: '/a' }))).toHaveLength(1)
})

test('handing work off resets the count; bookkeeping calls neither count nor reset it', async ($, on) => {
  setUpNudge(on)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  const run = async (tools: string[]) => {
    const nudges: number[] = []
    for (const [i, tool] of tools.entries()) if (nudgeOf(await mainCall($, tool, { command: 'ls' })).length) nudges.push(i)
    return nudges
  }
  expect(await run(['Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Agent', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash'])).toEqual([])
  expect(await run(['SendMessage', 'Read', 'Read', 'TodoWrite', 'ToolSearch', 'Read', 'TaskOutput', 'Read', 'AskUserQuestion'])).toEqual([])
  expect(await run(['Task', 'Read', 'Read', 'Read', 'Read', 'Read', 'Read'])).toEqual([6])
})

test("a refused call passes the nudge to the next; subagents' and teammates' calls never count", async ($, on) => {
  setUpNudge(on)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  for (let i = 0; i < 10; i++) expect(nudgeOf(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-1' } as never))).toEqual([])
  for (let i = 0; i < 5; i++) await mainCall($, 'Read', { file_path: '/a' })
  // the sixth is refused: its answer stays a plain deny, and the next call carries the nudge
  const refused = await mainCall($, 'Write', { file_path: '/a', content: 'x' })
  expect(refused).toEqual({ deny: 'no' })
  expect(nudgeOf(await mainCall($, 'Read', { file_path: '/a' }))).toHaveLength(1)
  expect(nudgeOf(await mainCall($, 'Read', { file_path: '/a' }))).toEqual([])
})

test('a boss that keeps working alone gets a firmer reminder with the count every 10 own calls; a new turn starts gently', async ($, on) => {
  setUpNudge(on)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  const texts: [number, string][] = []
  for (let i = 1; i <= 40; i++) for (const text of nudgeOf(await mainCall($, 'Bash', { command: 'ls' }))) texts.push([i, text])
  expect(texts.map(([i]) => i)).toEqual([6, 16, 26, 36])
  expect(texts[0]?.[1]).toContain('6 steps of this turn yourself')
  expect(texts[1]?.[1]).toContain('reminder 2 this turn: 16 steps in a row are your own')
  expect(texts[1]?.[1]).toContain('Stop doing the work yourself now')
  expect(texts[1]?.[1]).toContain('your next call should be the Agent tool')
  expect(texts[1]?.[1]).toContain('if the person asked you to do this yourself, carry on')
  expect(texts[3]?.[1]).toContain('reminder 4 this turn: 36 steps')
  // a hand-off resets the count and the next reminder is the gentle text again (the boss may review and check)
  await mainCall($, 'Agent')
  const after: string[] = []
  for (let i = 1; i <= 6; i++) after.push(...nudgeOf(await mainCall($, 'Read', { file_path: '/a' })))
  expect(after).toHaveLength(1)
  expect(after[0]).toContain('6 steps of this turn yourself')
  // no hand-off since that one: the next is firm again
  const again: string[] = []
  for (let i = 1; i <= 10; i++) again.push(...nudgeOf(await mainCall($, 'Read', { file_path: '/a' })))
  expect(again).toHaveLength(1)
  expect(again[0]).toContain('reminder 6 this turn: 16 steps')
  // a new turn starts with the gentle one
  await completeTurn($, 'answer')
  await $.turn.start({ text: 'more', turnId: 'turn-2' })
  const fresh: string[] = []
  for (let i = 1; i <= 6; i++) fresh.push(...nudgeOf(await mainCall($, 'Read', { file_path: '/a' })))
  expect(fresh).toHaveLength(1)
  expect(fresh[0]).toContain('6 steps of this turn yourself')
})

test('the owed reminder carries the real count; a repeat-refused call keeps it owed', async ($, on) => {
  setUp(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', AGENT_OFFICE_STEP_BUDGET: '20', AGENT_OFFICE_STEP_CAP: '1' })
  on('tool.call', (_$, e) => (e.tool === 'Write' ? ({ deny: 'no' }) : e.tool === 'Bash' ? ({ result: { exitCode: 1, stderr: 'boom: same failure' } }) : ({ result: 'ok' })) as never)
  answerTurns(on)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  // calls 1-3 fail identically (the third marks the call refused); 4th is the repeat-refused one
  for (let i = 0; i < 3; i++) await mainCall($, 'Bash', { command: 'make' })
  await mainCall($, 'Read', { file_path: '/a' })
  await mainCall($, 'Read', { file_path: '/a' })
  // the sixth call is the repeat-refused one: no result to carry the reminder, the seventh does
  expect(await mainCall($, 'Bash', { command: 'make' })).toMatchObject({ deny: expect.any(String) })
  const owed = nudgeOf(await mainCall($, 'Read', { file_path: '/a' }))
  expect(owed).toHaveLength(1)
  expect(owed[0]).toContain('7 steps of this turn yourself')
})

test('an HQ session (no Agent tool) is never nudged, even with manager mode on', async ($, on) => {
  setUpNudge(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', AGENT_OFFICE_HQ: '1' })
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  for (let i = 0; i < 14; i++) expect(nudgeOf(await mainCall($, 'Read', { file_path: '/a' }))).toEqual([])
})

test('office_dispatch from any server counts as a hand-off and resets the count', async ($, on) => {
  setUpNudge(on)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  for (let i = 0; i < 5; i++) await mainCall($, 'Bash', { command: 'ls' })
  await mainCall($, 'mcp__agent-office__office_dispatch')
  for (let i = 0; i < 5; i++) expect(nudgeOf(await mainCall($, 'Bash', { command: 'ls' }))).toEqual([])
  expect(nudgeOf(await mainCall($, 'Bash', { command: 'ls' }))).toHaveLength(1)
})

for (const [name, env] of [
  ['manager mode off', { HOME: '/home/tester', AGENT_OFFICE_APP: '1' }],
  ['AGENT_OFFICE_MANAGER=0', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '0' }],
] as const) {
  test(`with ${name} the main loop is never nudged`, async ($, on) => {
    setUpNudge(on, env)
    await $.session.start(start)
    await $.turn.start({ text: 'build it', turnId: 'turn-1' })
    for (let i = 0; i < 12; i++) expect(nudgeOf(await mainCall($, 'Bash', { command: 'ls' }))).toEqual([])
  })
}

test('the manager text delegates large-input and parallel work, keeps trivial edits, and asks for short reports', async ($, on) => {
  setUpCompose(on, { HOME: '/home/tester', AGENT_OFFICE_MANAGER: '1' })
  const text = (await $.prompt.compose(mainLoop)).sections[1]?.text ?? ''
  expect(text).toContain('Delegate when the input is large and the answer small')
  expect(text).toContain('can run in parallel')
  expect(text).toContain('do trivial edits')
  expect(text).not.toContain('never trivial here')
  expect(text).toContain('Put long context in a file and pass its path')
  expect(text).toContain('report at most 15 lines plus the path')
  expect(text).toContain('One scoped task per agent')
  expect(text).toContain('stays available to the person')
  expect(text).toContain('run_in_background')
  // re-read on every request: it must not grow (3038 characters before v3.20)
  expect(text.length).toBeLessThanOrEqual(3038)
  expect(text).toContain('Make technical choices yourself')
  expect(text).toContain('Never end a turn with an offer')
  expect(text).not.toContain('A small single-step task you do yourself')
})

// the subagents' step budget (app contract v3.20): a wrap-up reminder at N calls, a shorter one every N/2 after, and
// with the hard cap (Strict) calls past 2N refused; never the boss, a teammate or a nested session
const NORMAL = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1', AGENT_OFFICE_STEP_BUDGET: '4' }
const STRICT = { ...NORMAL, AGENT_OFFICE_STEP_CAP: '1' }
const stepOf = (answer: unknown) => ((answer as { context?: string[] }).context ?? []).filter(text => text.startsWith('Agent Office:'))
function setUpSteps(on: Harness, env: Record<string, string>, toolCalls: string[] = []) {
  const set = setUpTicking(on, env)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'test-model', agentId: `agent-${++spawned}` }))
  on('tool.call', (_$, e) => {
    toolCalls.push(e.tool)
    return (e.tool === 'Write' ? { deny: 'no' } : { result: 'ok' }) as never
  })
  answerTurns(on)
  return set
}
// lets a call the plugin started without awaiting it (TaskStop) reach the engine
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const agentCall = ($: Engine, agentId = 'agent-1', tool = 'Read') => $.tool.call({ tool, file_path: '/a', agentId } as never)
// the calls (1-based) whose answer carried a reminder, of `count` calls by agent-1
async function remindedCalls($: Engine, count: number) {
  const at: number[] = []
  for (let i = 1; i <= count; i++) if (stepOf(await agentCall($)).length) at.push(i)
  return at
}

test('a subagent is told to wrap up at N tool calls, then more briefly every N/2 calls; no cap without Strict', async ($, on) => {
  const { writes, clock } = setUpSteps(on, NORMAL)
  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  const answers: unknown[] = []
  for (let i = 1; i <= 12; i++) answers.push(await agentCall($))
  const reminded = answers.flatMap((a, i) => (stepOf(a).length ? [i + 1] : []))
  expect(reminded).toEqual([4, 6, 8, 10, 12])
  expect(stepOf(answers[3])[0]).toContain("you've used 4 tool calls")
  expect(stepOf(answers[3])[0]).toContain('Stop exploring now')
  expect(stepOf(answers[3])[0]).toContain('≤15 lines')
  expect(stepOf(answers[3])[0]).toContain('return its path')
  expect(stepOf(answers[3])[0]).not.toContain('refused')
  expect(stepOf(answers[5])[0]).toContain('6 tool calls, past your budget of 4. Stop now')
  // no refusal without the cap: every call ran
  expect(answers.every(a => (a as { result?: unknown }).result === 'ok')).toBe(true)
  await clock.advance(PUBLISH_MS)
  const w = stateOf(writes).workers[0] as State['workers'][number] & { nudges?: number; denied?: number }
  expect([w.toolCount, w.nudges, w.denied]).toEqual([12, 5, undefined])
})

test('Strict refuses calls past 2N, telling the agent to answer now; the count is logged on the worker and its delivery', async ($, on) => {
  const toolCalls: string[] = []
  const { writes, clock } = setUpSteps(on, STRICT, toolCalls)
  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  const answers: unknown[] = []
  for (let i = 1; i <= 9; i++) answers.push(await agentCall($))
  expect(stepOf(answers[3])[0]).toContain('Tool calls past 8 will be refused')
  expect(answers.slice(0, 8).every(a => (a as { result?: unknown }).result === 'ok')).toBe(true)
  const refused = answers[8] as { deny?: string }
  expect(refused.deny).toContain('Give your final answer now')
  // the refused call never reached the tool
  expect(toolCalls.filter(t => t === 'Read')).toHaveLength(8)
  await clock.advance(PUBLISH_MS)
  const w = stateOf(writes).workers[0] as State['workers'][number] & { nudges?: number; denied?: number }
  expect([w.nudges, w.denied]).toEqual([3, 1])
  await completeTurn($, 'answer', 'agent-1', 'done')
  await clock.advance(PUBLISH_MS)
  expect(stateOf(writes).stats.today?.log?.[0]).toMatchObject({ toolCount: 9, nudges: 3, denied: 1 })
})

test('an agent that keeps calling after refusals is stopped once, so a refused call cannot loop forever; the boss is told', async ($, on) => {
  const toolCalls: string[] = []
  setUpSteps(on, STRICT, toolCalls)
  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  for (let i = 1; i <= 8; i++) await agentCall($)
  const refusals: string[] = []
  for (let i = 1; i <= 4; i++) refusals.push((await agentCall($)).deny ?? '')
  await flush()
  expect(refusals[0]).toContain('refusal 1 of 5')
  expect(toolCalls.filter(t => t === 'TaskStop')).toEqual([])
  for (let i = 1; i <= 3; i++) expect((await agentCall($)).deny).toContain('was not run')
  await flush()
  // the fifth refusal stops it (TaskStop with its id), once; no refused call ran its tool
  expect(toolCalls.filter(t => t === 'TaskStop')).toEqual(['TaskStop'])
  expect(toolCalls.filter(t => t === 'Read')).toHaveLength(8)
  // the boss's next Agent call says the agent was stopped, not interrupted by the person; once
  const note = (answer: unknown) => ((answer as { context?: string[] }).context ?? []).filter(text => text.startsWith('Agent Office stopped'))
  const told = note(await $.tool.call({ tool: 'Agent', prompt: 'x' } as never))
  expect(told).toHaveLength(1)
  expect(told[0]).toContain('agent agent-1')
  expect(told[0]).toContain('did not interrupt')
  expect(note(await $.tool.call({ tool: 'Agent', prompt: 'y' } as never))).toEqual([])
})

test('a reminder whose call is refused rides that agent\'s next call', async ($, on) => {
  setUpSteps(on, NORMAL)
  await $.session.start(start)
  await spawnAgent($, 'Scan the code', 'Explore')
  for (let i = 1; i <= 3; i++) await agentCall($)
  expect(await agentCall($, 'agent-1', 'Write')).toEqual({ deny: 'no' })
  expect(stepOf(await agentCall($))).toHaveLength(1)
  expect(stepOf(await agentCall($))).toHaveLength(1) // the sixth: N/2 after N
  expect(stepOf(await agentCall($))).toEqual([])
})

test('the boss, a teammate and unknown agents get no step budget, even in Strict', async ($, on) => {
  setUpSteps(on, STRICT)
  await $.session.start(start)
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  await spawnAgent($, 'Pair on it', 'teammate')
  for (let i = 0; i < 20; i++) {
    const boss = await $.tool.call({ tool: 'Agent', prompt: 'x; done when npm test passes' } as never)
    expect(stepOf(boss)).toEqual([])
    expect((boss as { deny?: string }).deny).toBeUndefined()
    const mate = await agentCall($)
    expect(stepOf(mate)).toEqual([])
    expect((mate as { deny?: string }).deny).toBeUndefined()
    expect((await agentCall($, 'agent-404')).deny).toBeUndefined()
  }
})

for (const [name, env] of [
  ['Savings off (no budget)', { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_STEP_CAP: '1' }],
  ['a nested claude', { ...STRICT, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-1' }],
  ['a budget below 2', { ...STRICT, AGENT_OFFICE_STEP_BUDGET: '1' }],
] as const) {
  test(`with ${name} a subagent is never reminded or refused`, async ($, on) => {
    setUpSteps(on, env)
    await $.session.start(start)
    await spawnAgent($, 'Scan the code', 'Explore')
    expect(await remindedCalls($, 3)).toEqual([])
    for (let i = 0; i < 20; i++) expect((await agentCall($)).deny).toBeUndefined()
  })
}

for (const [name, env, type, expected] of [
  ['a budgeted subagent', STRICT, 'Explore', 'keep this task to about 4 tool calls'],
  ['a teammate', NORMAL, 'teammate', ''],
  ['an unbudgeted subagent', { HOME: '/home/tester' }, 'Explore', ''],
] as const) {
  test(`${name}: the task says the budget at spawn only when the agent has one`, async ($, on) => {
    const prompts: string[] = []
    setUpTicking(on, env)
    on('agent.spawn', (_$, e) => {
      prompts.push(e.prompt)
      return { model: 'test-model', agentId: 'agent-1' }
    })
    await $.session.start(start)
    await spawnAgent($, 'Scan the code', type)
    if (expected) {
      expect(prompts[0]).toContain(expected)
      expect(prompts[0]).toContain('Calls past 8 are refused')
    } else expect(prompts[0]).toBe('Scan the code')
  })
}
