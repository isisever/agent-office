import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Delivery, OfficeFrame, OfficeStats, Shell, Worker } from '../types'

// Claude Code side of Agent Office: writes agent arrivals, tools, deliveries and background shells to
// ~/.claude/agent-office/sessions/<session>.json. The office itself is drawn by the
// plugin's viewer/office.mjs.
// `/office`: full-window office in a split next to Claude (Ghostty on macOS, kitty with remote control,
//   WezTerm; anywhere else it falls back to the band).
// `/office band` (`/office şerit`): viewer --frames renders PNG frames shown in the band above the prompt (AbovePrompt).

const workersAtom = atom({ plugin: 'agent-office', key: 'workers' } as const, [] as Worker[])
const shellsAtom = atom({ plugin: 'agent-office', key: 'shells' } as const, [] as Shell[])
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
    description: 'Opens the Agent office full-window in a split next to Claude (Ghostty on macOS, kitty, WezTerm); `/office band`: a small band above the prompt; `/office stats`: today in text',
    argumentHint: '[band|stats]',
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
    stats: {
      heading: (date: string) => `Agent Office · today (${date})`,
      delivered: (count: number, failed: number, time: string) =>
        `Delivered: ${count}${failed ? ` (${failed} failed)` : ''} · agent time ${time}`,
      none: 'No deliveries yet today.',
      untracked: (count: number) => `+${count} more without details (older plugin version)`,
      project: (name: string, count: number, time: string) => `  ${name}: ${count} · ${time}`,
      last: 'Last deliveries:',
      working: (count: number) => (count ? `Working now: ${count}` : 'Working now: none'),
      shells: (count: number) => (count ? `Background shells running: ${count}` : 'Background shells running: none'),
      duration: (h: number, m: number, s: number) => (h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`),
      noProject: '(no project)',
    },
  },
  tr: {
    description: "Agent ofisini pencerede tam boy bölme olarak açar, Claude birkaç satırda kalır (macOS'ta Ghostty, kitty, WezTerm); `/office şerit`: prompt'un üstünde küçük şerit; `/office istatistik`: bugünün özeti",
    argumentHint: '[şerit|istatistik]',
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
    stats: {
      heading: (date: string) => `Agent Ofis · bugün (${date})`,
      delivered: (count: number, failed: number, time: string) =>
        `Teslim: ${count}${failed ? ` (${failed} başarısız)` : ''} · agent süresi ${time}`,
      none: 'Bugün henüz teslim yok.',
      untracked: (count: number) => `+${count} teslim daha, ayrıntısız (eski eklenti sürümü)`,
      project: (name: string, count: number, time: string) => `  ${name}: ${count} · ${time}`,
      last: 'Son teslimler:',
      working: (count: number) => (count ? `Şu an çalışan: ${count}` : 'Şu an çalışan: yok'),
      shells: (count: number) => (count ? `Çalışan arka plan komutu: ${count}` : 'Çalışan arka plan komutu: yok'),
      duration: (h: number, m: number, s: number) => (h ? `${h} sa ${m} dk` : m ? `${m} dk ${s} sn` : `${s} sn`),
      noProject: '(proje yok)',
    },
  },
}
type Strings = (typeof STRINGS)['en']

const BAND_ARGS = new Set(['band', 'şerit', 'serit'])
// /office stats; 'İSTATİSTİK'.toLowerCase() birleşik nokta (U+0307) bırakır, karşılaştırmadan önce atılır
const STATS_ARGS = new Set(['stats', 'istatistik'])
// /office stats: a session counts as live like the app's readOffice (LIVE_MS; the plugin's heartbeat is 30 s)
const LIVE_MS = 3 * 60_000
const STATS_LAST = 5 // deliveries listed by /office stats
const STATS_LIST_MAX = 3 // working agents / shells named per line before "+n"

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
const RESULT_MAX = 4000
const DESCRIPTION_MAX = 200
const LOG_MAX = 300 // deliveries kept per session per day
const DETAIL_MAX = 160
const HISTORY_MAX = 20
// background shells (contract v2.3): running ones plus those finished within forgetMs, at most this many
const SHELLS_MAX = 20
// every tool call changes a worker's detail: state-file writes from tool calls are coalesced to one per PUBLISH_MS
const PUBLISH_MS = 500
// session file format (contract): fields are only added within a format; a reader that knows an older
// format reads a newer one wrong, so the app warns when it sees a format above its own
const FORMAT = 2

let workers: Worker[] = []
let shells: Shell[] = []
// shells whose Bash result said backgroundEndsWithFinalResponse: they die when their subagent answers,
// and no completion notification follows (agentId -> shell ids)
const endsWithAgent = new Map<string, Set<string>>()
let stats: OfficeStats = { delivered: 0, isBossBusy: false }
let stateFile = ''
let rootDir = ''
let sessionId = ''
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
  await $.fs.write(stateFile, JSON.stringify({ format: FORMAT, project, updatedAt: lastPublish, endedAt, workers, shells, stats }))
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

// keeps running shells and finished ones; past SHELLS_MAX the oldest finished go first, then the oldest running
function capShells(list: Shell[]) {
  const sorted = [...list].sort((a, b) => a.startAt - b.startAt)
  while (sorted.length > SHELLS_MAX) {
    const finished = sorted.findIndex(s => s.endAt !== undefined)
    sorted.splice(finished === -1 ? 0 : finished, 1)
  }
  return sorted
}

async function setShells($: EngineInterface, change: (list: Shell[]) => Shell[]) {
  shells = await update($, shellsAtom, list => capShells(change(list)))
  await publishSoon($)
}

type ShellEnd = { status: NonNullable<Shell['status']>; exitCode?: number }

// ends the running shells `endOf` names (by id); finished ones keep their first ending
async function endShells($: EngineInterface, endOf: (s: Shell) => ShellEnd | undefined) {
  if (!shells.some(s => s.endAt === undefined && endOf(s))) return
  const now = Date.now()
  await setShells($, list =>
    list.map(s => {
      const end = s.endAt === undefined ? endOf(s) : undefined
      if (!end) return s
      const done: Shell = { ...s, endAt: now, status: end.status }
      if (end.exitCode !== undefined) done.exitCode = end.exitCode
      return done
    }),
  )
}

// a background shell a tool call started (contract v2.3), from the call and the tool's result:
// Bash with run_in_background, or moved to the background later (Ctrl+B, its timeout), carries
// result.backgroundTaskId; Monitor running a command carries result.taskId (a ws monitor is no shell)
function shellOf(e: { tool: string; tool_use_id?: string; agentId?: string }, done: unknown, startAt: number): Shell | undefined {
  const args = e as unknown as Record<string, unknown>
  const answer = done !== null && typeof done === 'object' ? (done as Record<string, unknown>) : {}
  if ('deny' in answer && answer.deny !== undefined) return undefined
  if (answer.isError) return undefined
  const result = answer.result !== null && typeof answer.result === 'object' ? (answer.result as Record<string, unknown>) : {}
  let taskId: unknown
  if (e.tool === 'Bash') {
    taskId = result.backgroundTaskId
    if (!taskId && args.run_in_background !== true) return undefined
  } else if (e.tool === 'Monitor') {
    if (typeof args.command !== 'string') return undefined
    taskId = result.taskId
  } else return undefined
  const id = typeof taskId === 'string' && taskId ? taskId : e.tool_use_id
  if (!id) return undefined
  const shell: Shell = { id, command: detailOf({ tool: 'Bash', command: args.command } as { tool: string }), startAt, status: 'running' }
  if (typeof args.description === 'string' && args.description.trim()) shell.description = args.description.trim()
  if (e.agentId) shell.agentId = e.agentId
  if (result.backgroundEndsWithFinalResponse === true && e.agentId) {
    const ids = endsWithAgent.get(e.agentId) ?? new Set<string>()
    endsWithAgent.set(e.agentId, ids.add(id))
  }
  return shell
}

// the engine's background task notifications, as the model reads them:
// <task-notification><task-id>b…</task-id><tool-use-id>toolu_…</tool-use-id><status>completed</status>
// <summary>Background command "…" completed (exit code 0)</summary></task-notification>
// (status failed: "failed with exit code 1"; killed/stopped: "was stopped")
function notificationsIn(text: string) {
  const found: { ids: string[]; end: ShellEnd }[] = []
  for (const [block] of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim() ?? ''
    const ids = [tag('task-id'), tag('tool-use-id')].filter(Boolean)
    if (ids.length === 0) continue
    const code = /exit code (-?\d+)/.exec(tag('summary'))
    const exitCode = code ? Number(code[1]) : undefined
    const word = tag('status').toLowerCase()
    const status: ShellEnd['status'] =
      word === 'killed' || word === 'stopped' || word === 'cancelled'
        ? 'killed'
        : word === 'failed' || (exitCode !== undefined && exitCode !== 0)
          ? 'failed'
          : 'completed'
    found.push({ ids, end: exitCode === undefined ? { status } : { status, exitCode } })
  }
  return found
}

async function endNotified($: EngineInterface, text: string) {
  if (!text.includes('<task-notification>')) return
  const found = notificationsIn(text)
  if (found.length > 0) await endShells($, s => found.find(n => n.ids.includes(s.id))?.end)
}

async function setStats($: EngineInterface, change: (s: OfficeStats) => OfficeStats) {
  stats = await update($, statsAtom, change)
  await publish($)
}

// the permission dialog for `tool` (any tool when left out) was answered: the session no longer waits on the person
async function clearWaiting($: EngineInterface, tool?: string) {
  if (!stats.waiting || (tool !== undefined && stats.waiting.tool !== tool)) return
  await setStats($, ({ waiting: _, ...rest }) => rest)
}

async function markDone($: EngineInterface, ids: Set<string>, isOk: boolean) {
  const now = Date.now()
  const fresh = workers.filter(w => ids.has(w.id) && w.doneAt === undefined)
  if (fresh.length === 0) return
  await setWorkers($, list => list.map(w => (ids.has(w.id) && w.doneAt === undefined ? { ...w, doneAt: now, isOk } : w)))
  const date = dayKey(now)
  // the day's log outlives the workers (they leave after FORGET_MS): the app's end-of-day summary reads it
  const logged: Delivery[] = fresh.map(w => ({
    id: w.id,
    type: w.type,
    description: clip(w.description ?? '', DESCRIPTION_MAX),
    spawnAt: w.spawnAt,
    doneAt: now,
    isOk,
    toolCount: w.toolCount ?? 0,
  }))
  await setStats($, s => {
    const isToday = s.today?.date === date
    const ids = isToday ? s.today!.ids : []
    const log = isToday ? (s.today!.log ?? []) : []
    return {
      ...s,
      delivered: s.delivered + fresh.length,
      today: { date, ids: [...ids, ...fresh.map(w => w.id)], log: [...log, ...logged].slice(-LOG_MAX) },
    }
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
  if (shells.some(s => s.endAt !== undefined && now - s.endAt > forgetMs)) {
    shells = await update($, shellsAtom, list => list.filter(s => s.endAt === undefined || now - s.endAt <= forgetMs))
    await publish($)
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

type SessionFile = { format?: number; project?: string; updatedAt?: number; endedAt?: number; workers?: Worker[]; shells?: Shell[]; stats?: OfficeStats }

// every session file changed today (or live), this session's from memory (fresher than its throttled file);
// files of a newer format are skipped, like the app does
async function readSessions($: EngineInterface, now: number) {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const sessions: SessionFile[] = []
  const entries = rootDir ? await $.fs.list(`${rootDir}/sessions`).catch(() => []) : []
  for (const f of entries) {
    if (f.kind !== 'file' || f.isLink || !f.name.endsWith('.json')) continue
    if (f.name === `${sessionId}.json` || f.mtimeMs < Math.min(midnight, now - LIVE_MS)) continue
    try {
      const state = JSON.parse(await $.fs.read(`${rootDir}/sessions/${f.name}`)) as SessionFile
      if (state && typeof state === 'object' && !(Number(state.format) > FORMAT)) sessions.push(state)
    } catch {
      // unreadable or half-written: skipped
    }
  }
  sessions.push({ project, updatedAt: now, workers, shells, stats })
  return sessions
}

function durationOf(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  return t.stats.duration(Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60)
}

function clockOf(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// "a, b, c +2"
function listOf(names: string[]) {
  const shown = names.slice(0, STATS_LIST_MAX).join(', ')
  return names.length > STATS_LIST_MAX ? `${shown} +${names.length - STATS_LIST_MAX}` : shown
}

// /office stats: today's deliveries across all sessions (stats.today.log, contract v2.9), the agents
// working now and the background shells running now, as a few lines of text
async function statsText($: EngineInterface) {
  const now = Date.now()
  const date = dayKey(now)
  const sessions = await readSessions($, now)
  const name = (s: SessionFile) => String(s.project ?? '') || t.stats.noProject
  const deliveries: (Delivery & { project: string })[] = []
  let untracked = 0
  const working: string[] = []
  const running: string[] = []
  for (const s of sessions) {
    const today = s.stats?.today
    if (today?.date === date) {
      const log = Array.isArray(today.log) ? today.log.filter(d => d && Number.isFinite(d.doneAt)) : []
      for (const d of log) deliveries.push({ ...d, project: name(s) })
      untracked += Math.max(0, new Set(Array.isArray(today.ids) ? today.ids : []).size - log.length)
    }
    const isLive = !s.endedAt && now - (s.updatedAt ?? 0) <= LIVE_MS
    if (!isLive) continue
    for (const w of Array.isArray(s.workers) ? s.workers : []) {
      if (w.doneAt === undefined) working.push(`${w.type}${w.description ? ` "${clip(w.description, 40)}"` : ''} (${name(s)})`)
    }
    for (const sh of Array.isArray(s.shells) ? s.shells : []) {
      if (sh.endAt === undefined) running.push(`${clip(sh.command, 40)} (${name(s)})`)
    }
  }
  deliveries.sort((a, b) => b.doneAt - a.doneAt)
  const timeOf = (d: Delivery) => Math.max(0, d.doneAt - (Number.isFinite(d.spawnAt) ? d.spawnAt : d.doneAt))
  const lines = [t.stats.heading(date)]
  if (deliveries.length === 0 && untracked === 0) lines.push(t.stats.none)
  else {
    const failed = deliveries.filter(d => d.isOk === false).length
    const total = deliveries.reduce((sum, d) => sum + timeOf(d), 0)
    lines.push(t.stats.delivered(deliveries.length + untracked, failed, durationOf(total)))
    if (untracked) lines.push(t.stats.untracked(untracked))
    const perProject = new Map<string, { count: number; time: number }>()
    for (const d of deliveries) {
      const p = perProject.get(d.project) ?? { count: 0, time: 0 }
      perProject.set(d.project, { count: p.count + 1, time: p.time + timeOf(d) })
    }
    for (const [p, { count, time }] of [...perProject].sort((a, b) => b[1].count - a[1].count))
      lines.push(t.stats.project(p, count, durationOf(time)))
    if (deliveries.length) {
      lines.push(t.stats.last)
      for (const d of deliveries.slice(0, STATS_LAST)) {
        const what = [d.type, clip(d.description ?? '', 60)].filter(Boolean).join(' · ')
        lines.push(`  ${clockOf(d.doneAt)} ${d.isOk === false ? '✗' : '✓'} ${what} · ${durationOf(timeOf(d))}${perProject.size > 1 ? ` (${d.project})` : ''}`)
      }
    }
  }
  lines.push(t.stats.working(working.length) + (working.length ? ` · ${listOf(working)}` : ''))
  lines.push(t.stats.shells(running.length) + (running.length ? ` · ${listOf(running)}` : ''))

  return lines.join('\n')
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
    rootDir = root
    sessionId = id
    stateFile = `${root}/sessions/${id}.json`
    viewerFile = `${$.plugin.root}/viewer/office.mjs`
    inboxFile = `${root}/inbox/${id}.jsonl`
    framesDir = `${root}/frames/${id}`
    isOpen = await read($, isOpenAtom)
    workers = await read($, workersAtom)
    shells = await read($, shellsAtom)
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
    // background shells end with the session
    shells = await update($, shellsAtom, list =>
      list.map(s => (s.endAt === undefined ? { ...s, endAt: Date.now(), status: 'killed' as const } : s)),
    )
    await publish($, Date.now())

    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\u0307/g, '')
    if (STATS_ARGS.has(arg)) return { text: await statsText($) }
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
    if (e.tool !== 'Bash' && e.tool !== 'Monitor' && e.tool !== 'TaskStop') {
      const answered = await next(e)
      // allowed and run, or denied: its permission dialog is closed (a failure here must not rerun the tool)
      await clearWaiting($, e.tool).catch(() => undefined)
      return answered
    }
    const startAt = Date.now()
    const done = await next(e)
    // the tool has run: a failure from here on must not reach .catch, which would run it again
    try {
      await clearWaiting($, e.tool)
      if (e.tool === 'TaskStop') {
        // a stopped task: TaskStop's result names it (task_id), its input too (task_id, deprecated shell_id)
        const result = 'result' in done && !done.isError ? (done.result as Record<string, unknown> | undefined) : undefined
        const args = e as unknown as Record<string, unknown>
        const id = [result?.task_id, args.task_id, args.shell_id].find(v => typeof v === 'string' && v)
        if (id) await endShells($, s => (s.id === id ? { status: 'killed' } : undefined))
      } else {
        const shell = shellOf(e, done, startAt)
        if (shell) await setShells($, list => [...list.filter(s => s.id !== shell.id), shell])
      }
    } catch {
      // the shell is not recorded; the call's answer stands
    }

    return done
  }).catch(($, e, next) => next(e))

  // background tasks end with a notification the engine submits as a prompt (origin task-notification)
  // when the session is idle; one that arrives mid-turn is absorbed as an attachment row instead, so
  // session.append (same origin) sees both. Either ends the shell it names, the first one wins.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') await endNotified($, e.text)
    else await clearWaiting($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const text = e.message.content.map(b => (typeof b.text === 'string' ? b.text : '')).join('\n')
      await endNotified($, text)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // backstop: when the main loop stops, Stop lists the background work still in flight; a running
  // shell missing from it has ended without a notification we saw (exit code unknown)
  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks
    if (Array.isArray(inFlight)) {
      const ids = new Set(inFlight.map(task => task.id))
      await endShells($, s => (ids.has(s.id) ? undefined : { status: 'completed' }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // a permission dialog opens (main session or a subagent): the app tells the person (contract v2.6)
  on('classic.PermissionRequest', async ($, e, next) => {
    const tool = typeof e.tool_name === 'string' ? e.tool_name : ''
    await setStats($, s => ({ ...s, waiting: { kind: 'permission', tool, since: Date.now() } }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!stats.isBossBusy) await setStats($, s => ({ ...s, isBossBusy: true }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // the main turn is over: nothing is left waiting on a dialog
    if (e.agentId === undefined) await setStats($, ({ waiting: _, ...s }) => ({ ...s, isBossBusy: false }))
    else {
      // the subagent's report (contract v2.2 `result`); "" when it gave none
      const answer = typeof e.answer === 'string' ? e.answer.trim() : ''
      if (answer && workers.some(w => w.id === e.agentId && w.result === undefined))
        await setWorkers($, list => list.map(w => (w.id === e.agentId ? { ...w, result: clip(answer, RESULT_MAX) } : w)))
      await markDone($, new Set([e.agentId]), e.reason === 'answer')
      // its shells that end with its final response (Bash backgroundEndsWithFinalResponse) die now
      const ending = endsWithAgent.get(e.agentId)
      if (ending) {
        endsWithAgent.delete(e.agentId)
        await endShells($, s => (ending.has(s.id) ? { status: 'killed' } : undefined))
      }
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
