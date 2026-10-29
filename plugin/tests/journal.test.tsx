import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { GRACE_MS, NEWS_CHARS, newsText, redact, selectNews, summaryOf } from '../hooks/journal'
import type { JournalEntry } from '../hooks/journal'

// the office journal (app contract v3.12): each main turn that did something appends an entry to
// <data dir>/journal.jsonl; inside the app the other sessions get the entries that concern their project as context

type Harness = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]
type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

const ran = (exitCode: number, stdout = ''): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const DATA = '/data/office'
const JOURNAL = `${DATA}/journal.jsonl`
const DIRECTORY_FILE = '/app/directory/tab-1.json'
const directory = {
  format: 1,
  projects: [
    { name: 'my-app', dir: '/work/my-app', account: 'Work', mcp: [], current: true },
    { name: 'shop', dir: '/work/shop', account: 'Default', mcp: [] },
  ],
}
// git working copies: folder → [top, common dir]; /work/shop-wt-1 is a worktree of /work/shop
const REPOS: Record<string, [string, string]> = {
  '/work/my-app': ['/work/my-app', '/work/my-app/.git'],
  '/work/shop': ['/work/shop', '/work/shop/.git'],
  '/work/shop-wt-1': ['/work/shop-wt-1', '/work/shop/.git'],
}

// a session in /work/my-app (or `root`) inside the app; git answers from REPOS and `commits` (top → "hash\x1fsubject"
// lines), the journal append (sh -c 'cat >> file') lands in `files`
function setUp(
  on: Harness,
  { env = {}, files = {}, commits = {}, root = '/work/my-app' }: { env?: Record<string, string>; files?: Record<string, string>; commits?: Record<string, string>; root?: string } = {},
) {
  const environment: Record<string, string> = {
    HOME: '/home/tester',
    AGENT_OFFICE_APP: '1',
    AGENT_OFFICE_DATA_DIR: DATA,
    AGENT_OFFICE_DIRECTORY: DIRECTORY_FILE,
    ...env,
  }
  const store: Record<string, string> = { [DIRECTORY_FILE]: JSON.stringify(directory), ...files }
  const mtimes: Record<string, number> = {}
  const gitCalls: string[][] = []
  const appended: JournalEntry[] = []
  on('env.get', (_$, e) => ({ value: environment[e.name] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: root }))
  on('command.register', () => ({ value: undefined as never }))
  on('clock.every', () => ({ value: undefined as never }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$, e) => {
    const text = store[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_$, e) => {
    const text = store[e.path]
    if (text === undefined && !e.resolve) throw new Error(`ENOENT: ${e.path}`)
    const stat = { kind: 'file' as const, size: text?.length ?? 0, mtimeMs: mtimes[e.path] ?? Date.now(), isLink: false }
    return { value: e.resolve ? { ...stat, realPath: e.path } : stat }
  })
  on('process.run', (_$, e) => {
    const argv = e.argv
    if (argv[0] === '/bin/sh') {
      const file = argv[4] ?? ''
      const line = e.init?.stdin ?? ''
      store[file] = (store[file] ?? '') + line
      mtimes[file] = Date.now()
      appended.push(JSON.parse(line) as JournalEntry)
      return { value: ran(0) }
    }
    if (argv[0] !== 'git') return { value: ran(1) }
    gitCalls.push([...argv])
    const dir = argv[2] ?? ''
    if (argv[3] === 'rev-parse' && argv.includes('--show-toplevel')) {
      const top = Object.keys(REPOS).find(r => dir === r || dir.startsWith(`${r}/`))
      if (!top) return { value: ran(128) }
      const [t, common] = REPOS[top]!
      return { value: ran(0, `${t}\n${common}\n${dir === top ? '' : `${dir.slice(top.length + 1)}/`}\n`) }
    }
    if (argv[3] === 'rev-parse') return { value: ran(0, 'main\n') }
    if (argv[3] === 'log') return { value: ran(0, commits[dir] ?? '') }
    return { value: ran(1) }
  })
  on('session.start', (_$, e) => e)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('clock.after', () => ({ value: undefined as never }))
  on('ui.render', { component: 'AbovePrompt' }, () => undefined as never)
  return { appended, gitCalls, store, mtimes }
}

const start = { cwd: '/work/my-app', surface: 'terminal', isInteractive: true } as const
const complete = ($: Engine, answer: string, agentId?: string, turnId = 'turn-1') =>
  $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId, agentId } as Parameters<typeof $.turn.complete>[0])
const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as unknown as Parameters<typeof $.prompt.submit>[0])
const contextOf = (result: unknown) => ((result as { context?: string[] }).context ?? []).join('\n')

function entry(over: Partial<JournalEntry> & { id: string }): JournalEntry {
  return { v: 1, at: Date.now() - 60_000, session: 'session-9', project: { name: 'shop', dir: '/work/shop' }, dirs: ['/work/shop'], ...over }
}
const journalOf = (entries: JournalEntry[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n'

test('a main turn that commits in another project writes one entry: project, account, folders, commits, prompt, summary, transcript', async ($, on) => {
  const { appended } = setUp(on, { commits: { '/work/shop': 'abc1234\x1fAdd on-prem MCP\ndef5678\x1fFix the build' } })
  await $.session.start(start)
  await $.classic.UserPromptSubmit({ prompt: 'x', transcript_path: '/home/tester/.claude/projects/-work-my-app/session-1.jsonl' } as never)
  await $.turn.start({ text: 'Add the on-prem MCP to shop and commit it', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/shop/src/mcp.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd /work/shop && git commit -am "Add on-prem MCP"' } as never)
  await complete($, 'Added the **on-prem MCP** to shop:\n\n```ts\nconst token = "x"\n```\n\nCommitted as `abc1234` on main.')

  expect(appended.length).toBe(1)
  const e = appended[0]!
  expect(e).toMatchObject({
    v: 1,
    id: 'session-1:turn-1',
    session: 'session-1',
    project: { name: 'my-app', dir: '/work/my-app' },
    account: 'Work',
    prompt: 'Add the on-prem MCP to shop and commit it',
    summary: 'Added the on-prem MCP to shop: Committed as abc1234 on main.',
    transcript: '/home/tester/.claude/projects/-work-my-app/session-1.jsonl',
    edits: 1,
    commands: 1,
  })
  expect(e.dirs).toEqual(['/work/my-app', '/work/shop/src', '/work/shop'])
  expect(e.repos).toEqual([
    {
      dir: '/work/shop',
      name: 'shop',
      branch: 'main',
      commits: [
        { hash: 'abc1234', subject: 'Add on-prem MCP' },
        { hash: 'def5678', subject: 'Fix the build' },
      ],
    },
  ])
})

test('the transcript path falls back to Claude Code’s folder for the session when no classic hook named it', async ($, on) => {
  const { appended } = setUp(on, { env: { CLAUDE_CONFIG_DIR: '/accounts/work' } })
  await $.session.start(start)
  await $.turn.start({ text: 'run the tests', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await complete($, 'All tests pass.')
  expect(appended[0]?.transcript).toBe('/accounts/work/projects/-work-my-app/session-1.jsonl')
  // a plain run outside the directory: the project is the folder
  expect(appended[0]?.repos).toBeUndefined()
})

test('a commit in a worktree is recorded under the main working copy, with the worktree named', async ($, on) => {
  const { appended } = setUp(on, { commits: { '/work/shop-wt-1': '1111111\x1fWorktree change' } })
  await $.session.start(start)
  await $.turn.start({ text: 'fix shop in a worktree', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /work/shop-wt-1 commit -am "Worktree change"' } as never)
  await complete($, 'Done.')
  expect(appended[0]?.dirs).toContain('/work/shop')
  expect(appended[0]?.repos?.[0]).toMatchObject({ dir: '/work/shop', name: 'shop', worktree: '/work/shop-wt-1' })
})

test('secrets are redacted in the stored prompt, summary and commit subjects', async ($, on) => {
  const { appended, store } = setUp(on, { commits: { '/work/my-app': 'aaaaaaa\x1fRotate key=hunter2secret' } })
  await $.session.start(start)
  await $.turn.start({ text: 'call it with Bearer abcdefghijklmnop12345 please', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', command: 'curl …' } as never)
  await complete($, 'Used nsk_live_0123456789abcdef and sk-ant-api03-ABCDEFGHIJKLMNOP; API_TOKEN=zzzzzzzz; https://bob:pa55word@example.com/x')
  const raw = store[JOURNAL] ?? ''
  for (const secret of ['abcdefghijklmnop12345', 'nsk_live_0123456789abcdef', 'sk-ant-api03', 'zzzzzzzz', 'pa55word', 'hunter2secret']) expect(raw).not.toContain(secret)
  expect(appended[0]?.prompt).toBe('call it with Bearer [redacted] please')
  expect(appended[0]?.summary).toContain('API_TOKEN=[redacted]')
  expect(appended[0]?.summary).toContain('https://[redacted]@example.com/x')
  expect(appended[0]?.repos?.[0]?.commits[0]?.subject).toBe('Rotate key=[redacted]')
})

test('a turn that ran nothing and said little writes nothing and asks git nothing; a long answer is kept', async ($, on) => {
  const { appended, gitCalls } = setUp(on)
  await $.session.start(start)
  await $.turn.start({ text: 'what is in README?', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Read', file_path: '/work/my-app/README.md' } as never)
  await complete($, 'A short readme.')
  expect(appended.length).toBe(0)
  expect(gitCalls.length).toBe(0)

  await $.turn.start({ text: 'explain the design', turnId: 'turn-2' })
  await complete($, 'The design splits the work in three layers. '.repeat(8), undefined, 'turn-2')
  expect(appended.length).toBe(1)
  // nothing ran: no commit can be this session's, so git log is not asked
  expect(gitCalls.some(c => c[3] === 'log')).toBe(false)
})

test("a subagent's turn writes no entry; its work counts towards the main turn's", async ($, on) => {
  const { appended } = setUp(on, { commits: { '/work/shop': 'bbbbbbb\x1fAgent commit' } })
  await $.session.start(start)
  await $.turn.start({ text: 'delegate it', turnId: 'turn-1' })
  await $.agent.spawn({ prompt: 'commit in shop', description: 'commit', subagentType: 'general-purpose' } as Parameters<typeof $.agent.spawn>[0])
  await $.tool.call({ tool: 'Bash', command: 'cd /work/shop && git commit -m x', agentId: 'agent-1' } as never)
  await complete($, 'Committed it.', 'agent-1')
  expect(appended.length).toBe(0)
  await complete($, 'The agent committed it.')
  expect(appended.length).toBe(1)
  expect(appended[0]).toMatchObject({ agents: 1, commands: 1 })
  expect(appended[0]?.repos?.[0]?.commits[0]?.hash).toBe('bbbbbbb')
})

test('AGENT_OFFICE_JOURNAL=0 turns the journal off', async ($, on) => {
  const { appended } = setUp(on, { env: { AGENT_OFFICE_JOURNAL: '0' } })
  await $.session.start(start)
  await $.turn.start({ text: 'x', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', command: 'make' } as never)
  await complete($, 'Built.')
  expect(appended.length).toBe(0)
})

test("a prompt gets other sessions' entries that touched this project's folder or a worktree of it, or name it, once", async ($, on) => {
  const now = Date.now()
  const entries = [
    entry({ id: 'a', at: now - 5000, project: { name: 'shop', dir: '/work/shop' }, dirs: ['/work/shop', '/work/my-app/src'], account: 'Default',
      repos: [{ dir: '/work/my-app', name: 'my-app', branch: 'main', commits: [{ hash: 'abc1234', subject: 'Add on-prem MCP' }] }],
      prompt: 'add the MCP to my-app', summary: 'Added it and committed.', transcript: '/t/a.jsonl' }),
    entry({ id: 'b', at: now - 4000, dirs: ['/work/shop'], summary: 'Told the my-app team about the API change.', edits: 2 }),
    entry({ id: 'g', at: now - 3500, dirs: ['/work/shop'], summary: 'Answered that my-app got a commit (no work done).' }),
    entry({ id: 'h', at: now - 3200, dirs: ['/work/shop'], prompt: 'check how my-app calls the cart', summary: 'It calls /cart.' }),
    entry({ id: 'c', at: now - 3000, dirs: ['/work/shop'], summary: 'Refactored the cart.' }),
    entry({ id: 'd', at: now - 2000, session: 'session-1', project: { name: 'my-app', dir: '/work/my-app' }, dirs: ['/work/my-app'], summary: 'my own turn' }),
    entry({ id: 'e', at: now - 3 * 24 * 60 * 60_000, dirs: ['/work/my-app'], summary: 'too old for a new session' }),
    entry({ id: 'f', at: now - 1000, dirs: ['/work/my-app-other'], summary: 'a sibling folder with the same prefix' }),
  ]
  setUp(on, { files: { [JOURNAL]: journalOf(entries) } })
  await $.session.start(start)
  const text = contextOf(await submit($, 'what changed?'))
  expect(text).toContain("Office news (other Agent Office sessions' work that concerns this project")
  expect(text).toContain('shop boss (account Default) — commits in my-app (main): abc1234 "Add on-prem MCP"; asked: "add the MCP to my-app"; summary: Added it and committed.; transcript: /t/a.jsonl')
  expect(text).toContain('Told the my-app team')
  expect(text).toContain('check how my-app calls the cart')
  for (const not of ['no work done', 'Refactored the cart', 'my own turn', 'too old', 'sibling folder']) expect(text).not.toContain(not)
  // shown once
  expect(contextOf(await submit($, 'and now?'))).toBe('')
})

test("a session in a worktree tab hears of work on the main working copy", async ($, on) => {
  const entries = [entry({ id: 'a', at: Date.now() - 1000, project: { name: 'my-app', dir: '/work/my-app' }, dirs: ['/work/shop/api'], summary: 'Changed the API.' })]
  setUp(on, { files: { [JOURNAL]: journalOf(entries) }, root: '/work/shop-wt-1', env: { AGENT_OFFICE_DIRECTORY: '' } })
  await $.session.start({ ...start, cwd: '/work/shop-wt-1' })
  expect(contextOf(await submit($, 'hi'))).toContain('Changed the API.')
})

test('outside the app, or for a background notification, no news is added', async ($, on) => {
  const entries = [entry({ id: 'a', at: Date.now() - 1000, dirs: ['/work/my-app'], summary: 'news' })]
  setUp(on, { files: { [JOURNAL]: journalOf(entries) }, env: { AGENT_OFFICE_APP: '' } })
  await $.session.start(start)
  expect(contextOf(await submit($, 'hi'))).toBe('')
})

// a claude started inside another one (a `claude -p` in a boss's Bash call) inherits the app's env: it is not an
// office session, so it neither writes the journal nor gets news (app contract v3.12, nested sessions)
for (const [name, env] of [
  ['CLAUDECODE=1', { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'parent-1' }],
  ["only a parent's CLAUDE_CODE_SESSION_ID", { CLAUDE_CODE_SESSION_ID: 'parent-1' }],
] as const) {
  test(`a nested session (${name}) writes no journal entry and gets no news`, async ($, on) => {
    const entries = [entry({ id: 'a', at: Date.now() - 1000, dirs: ['/work/my-app'], summary: 'news' })]
    const { appended, gitCalls } = setUp(on, { files: { [JOURNAL]: journalOf(entries) }, env })
    await $.session.start(start)
    expect(contextOf(await submit($, 'hi'))).toBe('')
    await $.turn.start({ text: 'build it', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Bash', command: 'cd /work/shop && make' } as never)
    await complete($, 'Built it and committed the result.')
    expect(appended.length).toBe(0)
    expect(gitCalls.length).toBe(0)
  })
}

test("the session's own CLAUDE_CODE_SESSION_ID does not make it nested", async ($, on) => {
  const entries = [entry({ id: 'a', at: Date.now() - 1000, dirs: ['/work/my-app'], summary: 'news' })]
  setUp(on, { files: { [JOURNAL]: journalOf(entries) }, env: { CLAUDE_CODE_SESSION_ID: 'session-1' } })
  await $.session.start(start)
  expect(contextOf(await submit($, 'hi'))).toContain('news')
})

test('news are capped at 8 entries and 2000 characters, the rest counted with the journal path', async ($, on) => {
  const now = Date.now()
  const entries = Array.from({ length: 12 }, (_, i) => entry({ id: `n${i}`, at: now - 20_000 + i * 1000, dirs: ['/work/my-app'], summary: `change ${i} ${'x'.repeat(100)}` }))
  setUp(on, { files: { [JOURNAL]: journalOf(entries) } })
  await $.session.start(start)
  const text = contextOf(await submit($, 'hi'))
  expect(text.split('\n').filter(l => l.startsWith('- [')).length).toBe(8)
  expect(text).toContain('change 11')
  expect(text).not.toContain('change 3 ')
  expect(text).toContain(`- … and 4 more in ${JOURNAL}`)
  expect(text.length).toBeLessThanOrEqual(NEWS_CHARS + 80)
})

test('the directory section points to the journal in one sentence', async ($, on) => {
  setUp(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  await $.session.start(start)
  const composing = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], outputStyle: null, tools: ['Bash'], traits: [] } as const
  const text = (await $.prompt.compose(composing as never)).sections.find(s => s.id === 'agent-office:projects')?.text ?? ''
  expect(text).toContain(`office journal \`${JOURNAL}\``)
  expect(text).toContain('when the person refers to work done in another project or session, read it')
})

// pure parts
test('selectNews keeps a cursor and the ids it saw, re-checking the last minute for late lines', () => {
  const me = { session: 'me', name: 'my-app', base: '/work/my-app' }
  const first = selectNews([entry({ id: 'x', at: 10_000_000, dirs: ['/work/my-app'] })], { cursor: 0, seen: [] }, me)
  expect(first.news.map(e => e.id)).toEqual(['x'])
  expect(first.state).toEqual({ cursor: 10_000_000, seen: ['x'] })
  // a line that landed late (older time, inside the grace window) is still shown, the seen one is not
  const late = entry({ id: 'y', at: 10_000_000 - GRACE_MS / 2, dirs: ['/work/my-app'] })
  const second = selectNews([entry({ id: 'x', at: 10_000_000, dirs: ['/work/my-app'] }), late], first.state, me)
  expect(second.news.map(e => e.id)).toEqual(['y'])
})

test('a bare fxc- key is redacted', () => {
  expect(redact('got fxc-ABC123def456GHI789 back')).toBe('got [redacted] back')
})

test('redact and summaryOf leave ordinary words alone', () => {
  expect(redact('the monkey: banana; author=jane; keyboard layout')).toBe('the monkey: banana; author=jane; keyboard layout')
  expect(summaryOf('# Done\n\nSee `src/a.ts`.\n```\ncode\n```')).toBe('Done See src/a.ts.')
  expect(newsText([], '/j', Date.now())).toBe('')
})
