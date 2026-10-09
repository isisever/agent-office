import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OfficeFrame, OfficeStats, Worker } from '../types'

// Claude Code side of Agent Office: writes agent arrivals, tools and deliveries to
// ~/.claude/agent-office/sessions/<session>.json. The office itself is drawn by the
// plugin's viewer/office.mjs.
// `/office`: full-window office in a split next to Claude (Ghostty on macOS, kitty with remote control,
//   WezTerm; anywhere else it falls back to the band).
// `/office band` (`/office şerit`): viewer --frames renders PNG frames shown in the band above the prompt (AbovePrompt).

const workersAtom = atom({ plugin: 'agent-office', key: 'workers' } as const, [] as Worker[])
const statsAtom = atom(
  { plugin: 'agent-office', key: 'stats' } as const,
  { delivered: 0, isBossBusy: false } as OfficeStats,
)

const inboxAtom = atom({ plugin: 'agent-office', key: 'inboxSeen' } as const, 0)
const isOpenAtom = atom({ plugin: 'agent-office', key: 'isOpen' } as const, false)
const frameAtom = atom(
  { plugin: 'agent-office', key: 'frame' } as const,
  { gen: 0, accent: '3fb6a8', frameColor: '2b1d1a', title: '' } as OfficeFrame,
)

// user-facing text: settings.json `language`, else Turkish when the locale starts with `tr`, English otherwise (same rule as the viewer)
const STRINGS = {
  en: {
    description: 'Opens the Agent office full-window in a split next to Claude (Ghostty on macOS, kitty, WezTerm); `/office band`: a small band above the prompt',
    argumentHint: '[band]',
    title: 'AGENT OFFICE',
    status: (working: number, delivered: number, isBossBusy: boolean) =>
      `${working} working · ${delivered} delivered${isBossBusy ? ' · boss busy' : ''}`,
    preparing: 'Preparing the office…',
    alt: 'Agent office',
    bandOpened: 'Office band opened just above the prompt. Run /office band again to close it.',
    bandClosed: 'Office closed.',
    fallback:
      'The full-window office needs Ghostty on macOS, kitty with remote control enabled, or WezTerm, so the office opens as a band above the prompt instead. Run /office again to close it.',
    opened:
      "Office opened: type tasks into the Task line at the bottom of the office; Claude's activity shows above it. If a permission prompt appears, check the small Claude terminal next to the office. Press Ctrl-C in the office to close it.",
    running: 'The office is already open.',
    failed: (manual: string) => `Could not open the split (check Ghostty's automation permission). Manually: Cmd+Shift+D, then ${manual}`,
    failedSplit: (manual: string) => `Could not open the split. Manually: split the window, then ${manual}`,
    noNode: 'Node.js was not found on PATH; the office viewer needs it. Install Node.js 18+ and try again.',
    task: (text: string) => `Task from Agent Office: ${text}\n\nIf it fits, split the work across subagents and run them in parallel.`,
  },
  tr: {
    description: "Agent ofisini pencerede tam boy bölme olarak açar, Claude birkaç satırda kalır (macOS'ta Ghostty, kitty, WezTerm); `/office şerit`: prompt'un üstünde küçük şerit",
    argumentHint: '[şerit]',
    title: 'AGENT OFİS',
    status: (working: number, delivered: number, isBossBusy: boolean) =>
      `${working} çalışıyor · ${delivered} teslim${isBossBusy ? ' · müdür çalışıyor' : ''}`,
    preparing: 'Ofis hazırlanıyor…',
    alt: 'Agent ofisi',
    bandOpened: "Ofis şeridi açıldı: prompt'un hemen üstünde. Kapatmak için yine /office şerit.",
    bandClosed: 'Ofis kapatıldı.',
    fallback:
      "Tam pencere ofis yalnız macOS'ta Ghostty'de, uzaktan kontrolü açık kitty'de ya da WezTerm'de çalışır; ofis bunun yerine prompt'un üstünde şerit olarak açıldı. Kapatmak için yine /office.",
    opened:
      "Ofis açıldı: görevi ofisin altındaki Görev satırına yaz, Claude'un akışı onun üstünde görünür. Onay istenirse ofisin yanındaki küçük Claude terminaline bak. Kapatmak için ofiste Ctrl-C.",
    running: 'Ofis zaten açık.',
    failed: (manual: string) => `Bölme açılamadı (Ghostty'nin otomasyon iznini kontrol et). Elle: Cmd+Shift+D, sonra ${manual}`,
    failedSplit: (manual: string) => `Bölme açılamadı. Elle: pencereyi böl, sonra ${manual}`,
    noNode: "Node.js PATH'te bulunamadı; ofis görüntüleyicisi buna ihtiyaç duyar. Node.js 18+ kurup yeniden dene.",
    task: (text: string) => `Agent Ofis'ten görev: ${text}\n\nUygunsa işi alt agent'lara bölerek paralel yürüt.`,
  },
}
type Strings = (typeof STRINGS)['en']

const BAND_ARGS = new Set(['band', 'şerit', 'serit'])

// the viewer's scene is ~330x200 logical pixels; 420 px high at 2x fits both rows of desks.
// A terminal cell is roughly half as wide as tall: W = H * (columns * 0.5) / rows.
const FRAME_PX_H = 420
const CELL_ASPECT = 0.5
const MIN_IMAGE_ROWS = 6
// full-window mode: rows left to the Claude terminal below, enough for permission prompts
const CLAUDE_ROWS = 8
// kitty and WezTerm size the split when it opens: the office's share of the window, in percent
const OFFICE_PERCENT = 80

const TICK_MS = 1500
const AGENT_CHECK_MS = 5000
const HEARTBEAT_MS = 30_000
// a delivered bot stays in the file until it has partied and left (viewer PARTY_MS = forget time - 30 s);
// settings.json `forgetMinutes` (1-60, default 5) sets it, read the same way by the viewer
const FORGET_MINUTES = { min: 1, max: 60, default: 5 }
let forgetMs = FORGET_MINUTES.default * 60_000
const STALE_MS = 24 * 60 * 60_000 // another session's files untouched this long are dropped at session start
// agent details (contract v2.2): limits of the Worker fields the app's panel shows
const PROMPT_MAX = 600
const RESULT_MAX = 600
const DETAIL_MAX = 160
const HISTORY_MAX = 20
// every tool call changes a worker's detail: state-file writes from tool calls are coalesced to one per PUBLISH_MS
const PUBLISH_MS = 500

let workers: Worker[] = []
let stats: OfficeStats = { delivered: 0, isBossBusy: false }
let stateFile = ''
let viewerFile = ''
let inboxFile = ''
let inboxSeen = 0
let lastAgentCheck = 0
let project = ''
let lastPublish = 0
let isDirty = false // workers changed since the state file was last written
let isFlushScheduled = false
let framesDir = ''
let nodePath = ''
let wantedSize = '' // çizimin istediği "GxY"; ticker çalışan süreçle karşılaştırır
let runningSize = ''
let viewerToken = 0
let isOpen = false
let t: Strings = STRINGS.en
let termProgram = ''
let kittyListenOn = ''
let kittyWindowId = ''
let weztermPane = ''

async function publish($: EngineInterface, endedAt?: number) {
  if (!stateFile) return
  lastPublish = Date.now()
  isDirty = false
  await $.fs.write(stateFile, JSON.stringify({ project, updatedAt: lastPublish, endedAt, workers, stats }))
}

async function setWorkers($: EngineInterface, change: (list: Worker[]) => Worker[]) {
  workers = await update($, workersAtom, change)
  await publish($)
}

// throttled publish: writes now when the last write is PUBLISH_MS old, else once that much time has passed
// (a $.clock.after timer; the ticker, turn.complete and session.end also write whatever is still pending)
async function publishSoon($: EngineInterface) {
  isDirty = true
  const wait = lastPublish + PUBLISH_MS - Date.now()
  if (wait <= 0) return publish($)
  if (isFlushScheduled) return
  isFlushScheduled = true
  $.clock.after(wait, () => {
    isFlushScheduled = false
    if (isDirty) void publish($).catch(() => undefined)
  })
}

// cuts text to at most `max` UTF-16 units, an ellipsis marking the cut (never half a surrogate pair)
function clip(text: string, max: number) {
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut}…`
}

// the tool.call envelope beside the tool's own arguments
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

// a tool call's input in one line (contract v2.2): Bash its command, Read/Edit/Write the file path as given,
// Grep/Glob the pattern [in path], WebFetch the url, WebSearch the query, anything else its arguments as compact JSON
function detailOf(e: { tool: string }) {
  const args = e as unknown as Record<string, unknown>
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  let detail: string
  switch (e.tool) {
    case 'Bash':
      detail = text('command')
      break
    case 'Read':
    case 'Edit':
    case 'Write':
      detail = text('file_path')
      break
    case 'Grep':
    case 'Glob':
      detail = text('path') ? `${text('pattern')} in ${text('path')}` : text('pattern')
      break
    case 'WebFetch':
      detail = text('url')
      break
    case 'WebSearch':
      detail = text('query')
      break
    default: {
      const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !ENVELOPE.has(key)))
      try {
        detail = JSON.stringify(rest) ?? ''
      } catch {
        detail = ''
      }
    }
  }
  return clip(detail.replace(/\s*[\r\n]+\s*/g, ' ').trim(), DETAIL_MAX)
}

async function setStats($: EngineInterface, change: (s: OfficeStats) => OfficeStats) {
  stats = await update($, statsAtom, change)
  await publish($)
}

async function markDone($: EngineInterface, ids: Set<string>, isOk: boolean) {
  const now = Date.now()
  const fresh = workers.filter(w => ids.has(w.id) && w.doneAt === undefined)
  if (fresh.length === 0) return
  await setWorkers($, list => list.map(w => (ids.has(w.id) && w.doneAt === undefined ? { ...w, doneAt: now, isOk } : w)))
  const date = dayKey(now)
  await setStats($, s => {
    const ids = s.today?.date === date ? s.today.ids : []
    return { ...s, delivered: s.delivered + fresh.length, today: { date, ids: [...ids, ...fresh.map(w => w.id)] } }
  })
}

// local calendar day, same format as the viewer's dayKey
function dayKey(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startTicker($: EngineInterface) {
  $.clock.every(TICK_MS, () => {
    void tick($).catch(() => undefined)
  })
}

// tasks typed in the office window: inbox/<session>.jsonl, one { at, text } per line
async function readInbox($: EngineInterface) {
  let raw = ''
  try {
    raw = await $.fs.read(inboxFile)
  } catch {
    return
  }
  await submitTasks($, raw)
  if (!raw.trim()) return
  // every row is submitted now: the viewer only appends, so move the file aside (atomic) and a task
  // typed meanwhile starts a new one; rows that landed in the old file before the move are still sent
  const aside = `${inboxFile}.${Date.now()}.old`
  const moved = await $.process.run(['/bin/mv', '-f', '--', inboxFile, aside]).catch(() => undefined)
  if (moved?.exitCode !== 0) return
  try {
    await submitTasks($, await $.fs.read(aside))
  } catch {
    return // unread: keep it rather than lose a task
  }
  await remove($, [aside])
}

async function submitTasks($: EngineInterface, raw: string) {
  const tasks = raw
    .split('\n')
    .filter(Boolean)
    .map(row => {
      try {
        return JSON.parse(row) as { at: number; text: string }
      } catch {
        return undefined
      }
    })
    .filter((t): t is { at: number; text: string } => t !== undefined && t.at > inboxSeen && Boolean(t.text))
  if (tasks.length === 0) return
  inboxSeen = await update($, inboxAtom, () => Math.max(...tasks.map(t => t.at)))
  for (const task of tasks) {
    await $.prompt.submit({ asUser: true, text: t.task(task.text) })
  }
}

// $.fs cannot delete, so rm does; best effort: what it cannot remove just stays
async function remove($: EngineInterface, paths: string[]) {
  if (paths.length === 0) return
  try {
    await $.process.run(['/bin/rm', '-rf', '--', ...paths])
  } catch {
    // no rm here: nothing is removed
  }
}

// drops other sessions' state, inbox and frames once that session ended before today or went quiet for STALE_MS
// (a session that ended today still holds deliveries for the viewer's TODAY count);
// this session's files and a live session's are never touched
async function cleanUp($: EngineInterface, root: string, id: string) {
  const now = Date.now()
  const list = async (dir: string) => (await $.fs.list(dir).catch(() => [])).filter(f => !f.isLink)
  const idOf = (name: string) => /^[\w-]+/.exec(name)?.[0] ?? ''
  const ended = new Set<string>()
  const live = new Set<string>([id])
  const doomed: string[] = []
  for (const f of await list(`${root}/sessions`)) {
    const other = idOf(f.name)
    if (f.kind !== 'file' || !other || live.has(other)) continue
    const path = `${root}/sessions/${f.name}`
    let state: { endedAt?: number; updatedAt?: number } | undefined
    try {
      state = JSON.parse(await $.fs.read(path))
    } catch {
      state = undefined
    }
    const at = Math.max(state?.updatedAt ?? 0, f.mtimeMs)
    if ((state?.endedAt && dayKey(at) !== dayKey(now)) || now - at > STALE_MS) {
      ended.add(other)
      doomed.push(path)
    } else live.add(other)
  }
  // an inbox or frames folder without a live session goes with it, or once stale on its own
  const isDoomed = (other: string, mtimeMs: number) =>
    Boolean(other) && !live.has(other) && (ended.has(other) || now - mtimeMs > STALE_MS)
  for (const f of await list(`${root}/inbox`)) {
    if (f.kind === 'file' && isDoomed(idOf(f.name), f.mtimeMs)) doomed.push(`${root}/inbox/${f.name}`)
  }
  for (const f of await list(`${root}/frames`)) {
    if (f.kind !== 'dir') continue
    const path = `${root}/frames/${f.name}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat && isDoomed(idOf(f.name), stat.mtimeMs)) doomed.push(path)
  }
  await remove($, doomed)
}

// starts or restarts the viewer (office.mjs --frames) to match the band's open state and size
function syncViewer($: EngineInterface) {
  const want = isOpen ? wantedSize : ''
  if (want === runningSize) return
  viewerToken++ // eski döngü bir sonraki karede çıkar, süreci öldürür
  runningSize = want
  if (want) void runViewer($, want, viewerToken)
}

function projectSlug() {
  return project.replace(/[^\w.-]/g, '_') || 'project'
}

// absolute path of node, or '' when it is not installed; tries the inherited PATH, then a login shell (nvm etc.)
async function findNode($: EngineInterface): Promise<string> {
  if (nodePath) return nodePath
  const probes: string[][] = [
    ['node', '-e', 'process.stdout.write(process.execPath)'],
    ['/bin/sh', '-lc', 'command -v node'],
  ]
  for (const argv of probes) {
    try {
      const found = await $.process.run(argv)
      const path = found.stdout.trim()
      if (found.exitCode === 0 && path) return (nodePath = path)
    } catch {
      // not runnable here: try the next probe
    }
  }

  return ''
}

// full-window mode drives Ghostty through AppleScript: Ghostty must be the terminal and osascript must run (macOS)
async function canSplitGhostty($: EngineInterface): Promise<boolean> {
  if (termProgram.toLowerCase() !== 'ghostty') return false
  try {
    const probe = await $.process.run(['/usr/bin/osascript', '-e', 'return "ok"'])
    return probe.exitCode === 0
  } catch {
    return false
  }
}

// kitty: `kitty @` needs remote control (allow_remote_control / listen_on); without it /office falls back to the band
async function canSplitKitty($: EngineInterface): Promise<boolean> {
  if (kittyListenOn) return true
  if (!kittyWindowId) return false
  try {
    const probe = await $.process.run(['kitty', '@', 'ls'])
    return probe.exitCode === 0
  } catch {
    return false
  }
}

type Splitter = 'ghostty' | 'kitty' | 'wezterm'

async function findSplitter($: EngineInterface): Promise<Splitter | undefined> {
  if (await canSplitGhostty($)) return 'ghostty'
  if (await canSplitKitty($)) return 'kitty'
  if (termProgram.toLowerCase() === 'wezterm' || weztermPane) return 'wezterm'
  return undefined
}

async function runViewer($: EngineInterface, size: string, token: number) {
  let pending = ''
  try {
    const node = await findNode($)
    if (!node) throw new Error('node not found')
    const slug = projectSlug()
    const child = $.process.spawn({ argv: [node, viewerFile, '--frames', framesDir, size, '--project', slug] })
    for await (const { stream, text } of child) {
      if (token !== viewerToken) break
      if (stream !== 'stdout') continue
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      const last = lines.reverse().map(l => /^frame (\d+) ([0-9a-f]{6}) ([0-9a-f]{6}) (.+)$/.exec(l)).find(Boolean)
      if (last) {
        const next: OfficeFrame = { gen: Number(last[1]), accent: last[2] ?? '', frameColor: last[3] ?? '', title: last[4] ?? '' }
        await update($, frameAtom, () => next)
      }
    }
  } catch {
    // the process failed to start or died: the next tick retries
  }
  if (token === viewerToken) runningSize = ''
}

async function tick($: EngineInterface) {
  const now = Date.now()
  if (isDirty) await publish($)
  syncViewer($)
  await readInbox($)
  if (now - lastAgentCheck < AGENT_CHECK_MS) return
  lastAgentCheck = now
  // stopped or failed agents must not stay stuck at their desks
  if (workers.some(w => w.doneAt === undefined)) {
    const agents = await $.agent.list()
    const idsOf = (statuses: string[]) => new Set(agents.filter(a => statuses.includes(a.status)).map(a => a.id))
    await markDone($, idsOf(['completed']), true)
    await markDone($, idsOf(['failed', 'killed']), false)
  }
  if (workers.some(w => w.doneAt !== undefined && now - w.doneAt > forgetMs)) {
    await setWorkers($, list => list.filter(w => w.doneAt === undefined || now - w.doneAt <= forgetMs))
  }
  if (now - lastPublish > HEARTBEAT_MS) await publish($)
}

// opens the office as a split of this terminal window: scene, Claude's activity and the task line
// live in the office; the Claude terminal stays a few rows next to it (for permission prompts).
// Ghostty: upper split, the viewer then shrinks Claude's split (--grow-from). kitty: hsplit below
// Claude (splits layout). WezTerm: upper split. Both size the split themselves (OFFICE_PERCENT).
async function openViewer($: EngineInterface, node: string, splitter: Splitter): Promise<'opened' | 'running' | 'failed'> {
  const slug = projectSlug()
  try {
    const running = await $.process.run(['/usr/bin/pgrep', '-f', `viewer/office\\.mjs .*--project ${slug}( |$)`])
    if (running.exitCode === 0) return 'running'
  } catch {
    // no pgrep: just open it
  }
  if (splitter !== 'ghostty') {
    const viewer = [node, viewerFile, '--below', '--terminal-rows', String(CLAUDE_ROWS), '--project', slug]
    const argv =
      splitter === 'kitty'
        ? ['kitty', '@', ...(kittyListenOn ? ['--to', kittyListenOn] : []), 'launch', '--location=hsplit', `--bias=${OFFICE_PERCENT}`,
            '--cwd=current', ...(kittyWindowId ? [`--match=window_id:${kittyWindowId}`] : []), ...viewer]
        : ['wezterm', 'cli', 'split-pane', ...(weztermPane ? ['--pane-id', weztermPane] : []), '--top',
            '--percent', String(OFFICE_PERCENT), '--', ...viewer]
    try {
      const opened = await $.process.run(argv)
      return opened.exitCode === 0 ? 'opened' : 'failed'
    } catch {
      return 'failed'
    }
  }
  const command = `${shellQuote(node)} ${shellQuote(viewerFile)} --below --terminal-rows ${CLAUDE_ROWS} --project ${slug} --grow-from `
  const script = [
    'tell application "Ghostty"',
    '  set cfg to new surface configuration',
    '  set here to focused terminal of selected tab of front window',
    `  set command of cfg to "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" & (id of here)`,
    '  split here direction up with configuration cfg',
    'end tell',
  ].join('\n')
  try {
    const opened = await $.process.run(['/usr/bin/osascript', '-e', script])
    return opened.exitCode === 0 ? 'opened' : 'failed'
  } catch {
    return 'failed'
  }
}

// ~/.claude/agent-office/settings.json: { language: "tr" | "en" | "auto", forgetMinutes }; anything missing
// or invalid keeps the default (same rules as the viewer's readSettings)
async function readSettings($: EngineInterface, home: string): Promise<{ language?: 'tr' | 'en'; forgetMinutes: number }> {
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(`${home}/.claude/agent-office/settings.json`))
  } catch {
    raw = undefined
  }
  const settings = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const language = settings.language === 'tr' || settings.language === 'en' ? settings.language : undefined
  const minutes = typeof settings.forgetMinutes === 'number' && Number.isFinite(settings.forgetMinutes) ? settings.forgetMinutes : FORGET_MINUTES.default
  return { language, forgetMinutes: Math.min(FORGET_MINUTES.max, Math.max(FORGET_MINUTES.min, minutes)) }
}

function shellQuote(text: string) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

// toggles the in-app band; opening needs node for the viewer's --frames mode
async function toggleBand($: EngineInterface): Promise<'opened' | 'closed' | 'noNode'> {
  if (!isOpen && !(await findNode($))) return 'noNode'
  isOpen = await update($, isOpenAtom, v => !v)
  syncViewer($)
  $.ui.invalidate('ui.render')

  return isOpen ? 'opened' : 'closed'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const settings = await readSettings($, home)
    forgetMs = settings.forgetMinutes * 60_000
    const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG')) || ''
    t = (settings.language ?? (locale.toLowerCase().startsWith('tr') ? 'tr' : 'en')) === 'tr' ? STRINGS.tr : STRINGS.en
    termProgram = (await $.env.get('TERM_PROGRAM')) ?? ''
    kittyListenOn = (await $.env.get('KITTY_LISTEN_ON')) ?? ''
    kittyWindowId = (await $.env.get('KITTY_WINDOW_ID')) ?? ''
    weztermPane = (await $.env.get('WEZTERM_PANE')) ?? ''
    // inside the Agent Office app the app itself is the office: no /office command
    if (!(await $.env.get('AGENT_OFFICE_APP'))) await $.command.register({ name: 'office', description: t.description, argumentHint: t.argumentHint })
    const id = await $.session.id()
    project = (await $.session.root()).split('/').pop() ?? ''
    const root = `${home}/.claude/agent-office`
    stateFile = `${root}/sessions/${id}.json`
    viewerFile = `${$.plugin.root}/viewer/office.mjs`
    inboxFile = `${root}/inbox/${id}.jsonl`
    framesDir = `${root}/frames/${id}`
    isOpen = await read($, isOpenAtom)
    workers = await read($, workersAtom)
    stats = await read($, statsAtom)
    // a new session must not resubmit old tasks
    inboxSeen = await read($, inboxAtom)
    if (inboxSeen === 0) inboxSeen = await update($, inboxAtom, () => Date.now())
    await publish($)
    if (home) await cleanUp($, root, id).catch(() => undefined)
    startTicker($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await publish($, Date.now())

    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isBandAsked = BAND_ARGS.has(arg)
    // the band is open: plain /office closes it too, so the fallback toggles like /office band
    const splitter = isBandAsked || isOpen ? undefined : await findSplitter($)
    if (!splitter) {
      const result = await toggleBand($)
      if (result === 'noNode') return { text: t.noNode }
      if (result === 'closed') return { text: t.bandClosed }

      return { text: isBandAsked ? t.bandOpened : t.fallback }
    }
    const node = await findNode($)
    if (!node) return { text: t.noNode }
    const result = await openViewer($, node, splitter)
    const manual = `${shellQuote(node)} ${shellQuote(viewerFile)} --below --project ${projectSlug()}`
    const failed = splitter === 'ghostty' ? t.failed(manual) : t.failedSplit(manual)
    const text = { opened: t.opened, running: t.running, failed }[result]

    return { text }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('agentId' in started && started.agentId) {
      const worker: Worker = {
        id: started.agentId,
        type: e.subagentType || 'general-purpose',
        description: e.description ?? '',
        spawnAt: Date.now(),
        prompt: clip((e.prompt ?? '').replace(/\s+/g, ' ').trim(), PROMPT_MAX),
        toolCount: 0,
      }
      await setWorkers($, list => [...list.filter(w => w.id !== worker.id), worker])
    }

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId && workers.some(w => w.id === e.agentId)) {
      const call = { at: Date.now(), tool: e.tool, detail: detailOf(e) }
      workers = await update($, workersAtom, list =>
        list.map(w =>
          w.id === e.agentId
            ? {
                ...w,
                tool: call.tool,
                detail: call.detail,
                history: [...(w.history ?? []), call].slice(-HISTORY_MAX),
                toolCount: (w.toolCount ?? 0) + 1,
              }
            : w,
        ),
      )
      await publishSoon($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!stats.isBossBusy) await setStats($, s => ({ ...s, isBossBusy: true }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await setStats($, s => ({ ...s, isBossBusy: false }))
    else {
      // the subagent's report (contract v2.2 `result`); "" when it gave none
      const answer = typeof e.answer === 'string' ? e.answer.trim() : ''
      if (answer && workers.some(w => w.id === e.agentId && w.result === undefined))
        await setWorkers($, list => list.map(w => (w.id === e.agentId ? { ...w, result: clip(answer, RESULT_MAX) } : w)))
      await markDone($, new Set([e.agentId]), e.reason === 'answer')
      // whatever tool calls are still waiting on the throttle are written with the delivery
      if (isDirty) await publish($)
    }

    return next(e)
  })

  // the band just above the prompt: frame in the theme's colour, status line on top
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, isOpenAtom)) || e.props.hasSurvey) return next(e)
    // the image (kitty graphics) is drawn only in a terminal
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Image } = $.ui.resolve(e)
    const frame = await read($, frameAtom)
    const office = await read($, statsAtom)
    const team = await read($, workersAtom)
    const columns = Math.max(20, Math.min(255, e.props.bodyColumns - 2))
    const rows = Math.max(MIN_IMAGE_ROWS, Math.min(255, e.props.maxRows - 3))
    const width = Math.min(4000, Math.round((FRAME_PX_H * columns * CELL_ASPECT) / rows))
    wantedSize = `${width}x${FRAME_PX_H}`
    const accent = `#${frame.accent}`
    const working = team.filter(w => w.doneAt === undefined).length

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={accent}>
        <Box flexDirection="row" gap={2}>
          <Text bold color={accent}>{frame.title || t.title}</Text>
          <Text dimColor>{project}</Text>
          <Text color={accent}>{t.status(working, office.delivered, office.isBossBusy)}</Text>
        </Box>
        {frame.gen > 0 ? (
          <Image
            key="office"
            source={{ file: `${framesDir}/frame.png`, format: 'png', generation: frame.gen }}
            columns={columns}
            rows={rows}
            alt={t.alt}
          />
        ) : (
          <Text dimColor>{t.preparing}</Text>
        )}
      </Box>
    )
  })

}
