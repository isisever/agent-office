// The office journal (app contract v3.12): what each session did, so the other sessions of the office learn of the
// work that concerns their project. At the end of every main-loop turn that did something (or said something
// worth keeping), the session appends one line to <data dir>/journal.jsonl: when, which session and project, the
// folders it touched, the new git commits in them, the person's prompt, a short summary of the boss's answer and
// the transcript's path. Inside the app, every prompt of another session gets the entries that concern its project
// (they touched its folder or name it) as context beside the prompt, each once.
//
// No imports: plugin/tests/journal-git.mjs loads this file in plain Node (type stripping) and runs the git side
// against a real temp repository, which `claude plugin test` (no processes) cannot. A hooks module may not hand `$`
// across an import, so register.tsx passes a Host of plain functions that call `$`.

export const JOURNAL_FILE = 'journal.jsonl'
export const JOURNAL_OLD_FILE = 'journal.1.jsonl'
export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024 // past this the file is moved to journal.1.jsonl and a new one starts
export const JOURNAL_FORMAT = 1
export const PROMPT_MAX = 150
export const SUMMARY_MAX = 400
export const SAID_LITTLE = 200 // an answer shorter than this, in a turn that ran nothing, is not journaled
export const DIRS_MAX = 16 // folders recorded per entry
export const REPOS_MAX = 6 // repositories checked for commits per entry
export const COMMITS_MAX = 6 // commits recorded per repository
export const SUBJECT_MAX = 120
// injection (prompt.submit)
export const NEWS_MAX = 8 // entries per injection
export const NEWS_CHARS = 2000 // characters per injection
export const NEWS_SUMMARY = 220 // a summary as the news shows it
export const LOOKBACK_MS = 24 * 60 * 60_000 // a new session hears of the last day
export const GRACE_MS = 60_000 // entries can land slightly out of time order: re-check the last minute by id
export const SEEN_MAX = 200
const GIT_TIMEOUT_MS = 5000

export type JournalCommit = { hash: string; subject: string }
export type JournalRepo = {
  dir: string // the repository's main working copy (a worktree maps to it)
  name: string // the office project holding it, else the folder's name
  worktree?: string // the worktree the commits were made in, when not the main working copy
  branch?: string
  commits: JournalCommit[]
}
export type JournalEntry = {
  v: number
  id: string
  at: number
  session: string
  project: { name: string; dir: string }
  account?: string
  prompt?: string
  summary?: string
  dirs: string[] // the folders touched, normalized: real path, a worktree's mapped to its main working copy
  repos?: JournalRepo[] // only repositories with new commits
  edits?: number
  commands?: number
  agents?: number
  transcript?: string
}
export type JournalSeen = { cursor: number; seen: string[] }
export type OfficeProject = { name: string; dir: string; account?: string; current?: boolean }

type RunResult = { exitCode: number; stdout: string; stderr: string }
/** What the journal needs from the engine: register.tsx wraps `$.process.run`, `$.fs.stat`, `$.fs.read`, `$.fs.write`. */
export type Host = {
  run: (argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }) => Promise<RunResult>
  stat: (path: string, options?: { resolve: boolean }) => Promise<{ size: number; mtimeMs: number; realPath?: string }>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

// --- text

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '[redacted]'], // a JWT
  [/\b(?:sk|nsk|pk|rk|ak|fxc)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]'], // sk-ant-…, nsk_…, pk_live_…, fxc-…
  [/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@'], // user:password@ in a URL
  [
    /\b((?:[\w-]*[_-])?(?:key|apikey|token|secret|passw(?:or)?d|pwd|credentials?|authorization|auth))\b(["']?\s*[:=]\s*["']?)[^\s"'&,;)\]}>]{4,}/gi,
    '$1$2[redacted]',
  ],
]

/** The text with obvious secrets (tokens, keys, passwords, URL credentials) replaced by [redacted]. */
export function redact(text: string) {
  return SECRET_PATTERNS.reduce((out, [pattern, to]) => out.replace(pattern, to), text)
}

/** Cuts to `max` UTF-16 units with an ellipsis, never half a surrogate pair. */
export function clip(text: string, max: number) {
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut}…`
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The boss's answer as the journal keeps it: code blocks out, inline code bare, one line, redacted, cut. */
export function summaryOf(answer: string, max = SUMMARY_MAX) {
  const text = answer
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
  return clip(oneLine(redact(text)), max)
}

/** The person's prompt as the journal keeps it; '' for a background task's notification or other tagged input. */
export function promptOf(text: string, max = PROMPT_MAX) {
  const bare = text.replace(/<([\w-]+)>[\s\S]*?<\/\1>/g, ' ')
  return clip(oneLine(redact(bare)), max)
}

/** Whether a turn is worth an entry: it ran commands, edited files, started agents, committed, or said enough. */
export function isWorthJournal(acts: { edits: number; commands: number; agents: number }, answer: string) {
  return acts.edits > 0 || acts.commands > 0 || acts.agents > 0 || summaryOf(answer, 10_000).length >= SAID_LITTLE
}

// --- paths

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
const keyOf = (p: string) => trimSlash(p.replace(/\\/g, '/')).normalize('NFC').toLowerCase()
export const baseName = (p: string) => trimSlash(p).split(/[\\/]/).pop() || p

/** Whether `path` is `dir` or inside it (separators alike, case-insensitive: macOS and Windows disks mostly are). */
export function isWithin(path: string, dir: string) {
  const p = keyOf(path)
  const d = keyOf(dir)
  return p === d || p.startsWith(d === '/' ? d : `${d}/`)
}

export type Place = { path: string; top?: string; main?: string }

/**
 * Where a folder is, normalized: inside a git working copy, its main working copy plus the folder's path below the
 * worktree's top (so every worktree of a repository maps to one place); else its real path. One git call.
 */
export async function placeOfDir(host: Host, dir: string): Promise<Place> {
  try {
    const found = await host.run(
      ['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--show-prefix'],
      { timeoutMs: GIT_TIMEOUT_MS },
    )
    const [top, common, prefix = ''] = found.stdout.split(/\r?\n/)
    if (found.exitCode === 0 && top && common) {
      const commonDir = trimSlash(common)
      // a repository's common dir is <main>/.git; a bare repository's is the repository itself
      const main = /[\\/]\.git$/.test(commonDir) ? commonDir.replace(/[\\/]\.git$/, '') : commonDir
      const below = trimSlash(prefix.trim())
      return { path: below ? `${main}/${below}` : main, top: trimSlash(top), main }
    }
  } catch {
    // no git, or it hung: the real path
  }
  const real = await host.stat(dir, { resolve: true }).then(s => s.realPath, () => undefined)
  return { path: trimSlash(real ?? dir) }
}

/** The commits made on `top`'s HEAD since `sinceMs` (committer date), newest first, at most COMMITS_MAX, and the branch. */
export async function commitsSince(host: Host, top: string, sinceMs: number): Promise<{ branch?: string; commits: JournalCommit[] }> {
  // git compares whole seconds: a commit in the turn's first second still counts
  const since = new Date(Math.max(0, sinceMs)).toISOString()
  try {
    const log = await host.run(['git', '-C', top, 'log', `-n${COMMITS_MAX}`, `--since=${since}`, '--format=%h%x1f%s', 'HEAD', '--'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (log.exitCode !== 0) return { commits: [] }
    const commits = log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [hash = '', subject = ''] = line.split('\x1f')
        return { hash: hash.trim(), subject: clip(oneLine(redact(subject)), SUBJECT_MAX) }
      })
      .filter(c => /^[0-9a-f]{4,}$/.test(c.hash))
    if (!commits.length) return { commits }
    const head = await host.run(['git', '-C', top, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    return { commits, ...(branch && branch !== 'HEAD' ? { branch } : {}) }
  } catch {
    return { commits: [] }
  }
}

/** The office project whose folder holds `dir` (the deepest), by name. */
export function projectNameOf(dir: string, projects: readonly OfficeProject[]) {
  let best: OfficeProject | undefined
  for (const p of projects) if (isWithin(dir, p.dir) && (!best || p.dir.length > best.dir.length)) best = p
  return best?.name
}

/** The office directory file's projects (app contract v3.9); [] when unreadable. */
export function directoryProjects(raw: string): OfficeProject[] {
  try {
    const data = JSON.parse(raw) as { projects?: unknown }
    if (!Array.isArray(data?.projects)) return []
    return data.projects
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .filter(p => typeof p.name === 'string' && typeof p.dir === 'string' && p.name && p.dir)
      .map(p => ({
        name: String(p.name),
        dir: String(p.dir),
        ...(typeof p.account === 'string' && p.account ? { account: p.account } : {}),
        ...(p.current === true ? { current: true } : {}),
      }))
  } catch {
    return []
  }
}

// --- writing

export type TurnRecord = {
  session: string
  turnId: string
  project: { name: string; dir: string }
  account?: string
  prompt: string
  answer: string
  touched: readonly string[] // absolute folders, as the tool calls named them
  sinceMs: number // commits since then count as this session's
  acts: { edits: number; commands: number; agents: number }
  transcript?: string
  projects: readonly OfficeProject[] // the office directory, to name repositories
  isWindows?: boolean
}

/** The entry for a finished turn, or undefined when it is not worth one (git is asked only then). */
export async function entryOf(host: Host, turn: TurnRecord, now: number): Promise<JournalEntry | undefined> {
  if (!isWorthJournal(turn.acts, turn.answer)) return undefined
  const folders = [...new Set([turn.project.dir, ...turn.touched].filter(Boolean))].slice(0, DIRS_MAX)
  const places = await Promise.all(folders.map(dir => placeOfDir(host, dir)))
  const dirs = [...new Map(places.map(p => [keyOf(p.path), p.path])).values()]
  const tops = [...new Map(places.filter(p => p.top).map(p => [keyOf(p.top!), p])).values()].slice(0, turn.acts.commands || turn.acts.agents ? REPOS_MAX : 0)
  const repos: JournalRepo[] = []
  for (const place of tops) {
    const found = await commitsSince(host, place.top!, turn.sinceMs)
    if (!found.commits.length) continue
    const main = place.main ?? place.top!
    repos.push({
      dir: main,
      name: projectNameOf(main, turn.projects) ?? projectNameOf(place.top!, turn.projects) ?? baseName(main),
      ...(keyOf(place.top!) !== keyOf(main) ? { worktree: place.top! } : {}),
      ...(found.branch ? { branch: found.branch } : {}),
      commits: found.commits,
    })
  }
  const prompt = promptOf(turn.prompt)
  const summary = summaryOf(turn.answer)
  return {
    v: JOURNAL_FORMAT,
    id: `${turn.session}:${turn.turnId || now}`,
    at: now,
    session: turn.session,
    project: turn.project,
    ...(turn.account ? { account: turn.account } : {}),
    ...(prompt ? { prompt } : {}),
    ...(summary ? { summary } : {}),
    dirs,
    ...(repos.length ? { repos } : {}),
    ...(turn.acts.edits ? { edits: turn.acts.edits } : {}),
    ...(turn.acts.commands ? { commands: turn.acts.commands } : {}),
    ...(turn.acts.agents ? { agents: turn.acts.agents } : {}),
    ...(turn.transcript ? { transcript: turn.transcript } : {}),
  }
}

/**
 * Appends one line to the journal: on macOS and Linux with O_APPEND (`cat >>`, one write, so sessions ending at
 * the same moment do not tear each other's lines); on Windows by rewriting the file. A file past
 * JOURNAL_MAX_BYTES is moved to journal.1.jsonl first (replacing the older one).
 */
export async function appendEntry(host: Host, dataDir: string, entry: JournalEntry, isWindows = false) {
  const file = `${dataDir}/${JOURNAL_FILE}`
  const line = `${JSON.stringify(entry)}\n`
  const size = await host.stat(file).then(s => s.size, () => 0)
  if (size + line.length > JOURNAL_MAX_BYTES) {
    const old = `${dataDir}/${JOURNAL_OLD_FILE}`
    const mv = isWindows
      ? ['cmd.exe', '/d', '/c', 'move', '/y', file.replace(/\//g, '\\'), old.replace(/\//g, '\\')]
      : ['/bin/mv', '-f', '--', file, old]
    await host.run(mv).catch(() => undefined)
  }
  if (isWindows) {
    const before = await host.read(file).catch(() => '')
    await host.write(file, before.length > JOURNAL_MAX_BYTES ? line : before + line)
    return
  }
  const done = await host.run(['/bin/sh', '-c', 'umask 077; cat >> "$1"', 'sh', file], { stdin: line, timeoutMs: GIT_TIMEOUT_MS })
  if (done.exitCode !== 0) throw new Error(`journal append failed: ${done.stderr}`)
}

// --- reading

/** The entries of a journal file's text, oldest first; broken lines are skipped. */
export function parseJournal(raw: string): JournalEntry[] {
  const out: JournalEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as JournalEntry
      if (e && typeof e === 'object' && typeof e.id === 'string' && Number.isFinite(e.at) && typeof e.session === 'string' && e.project)
        out.push(e)
    } catch {
      // a torn or foreign line
    }
  }
  return out
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether an entry concerns a project: it touched the project's folder (normalized like the entry's: real path,
 * worktrees mapped to the main working copy) or one below it, committed in it, or names the project in its prompt or
 * a commit subject; in its summary only when the turn did work (so a mere answer that mentions the project, such as
 * the reply to its own news, does not echo back). Names under 3 characters are not matched.
 */
export function concerns(entry: JournalEntry, project: { name: string; base: string }) {
  const dirs = [...(Array.isArray(entry.dirs) ? entry.dirs : []), ...(entry.repos ?? []).map(r => r.dir)]
  if (project.base && dirs.some(d => typeof d === 'string' && isWithin(d, project.base))) return true
  const name = project.name.trim()
  if (name.length < 3) return false
  const didWork = Boolean(entry.edits || entry.commands || entry.agents || entry.repos?.length)
  const said = [entry.prompt ?? '', didWork ? (entry.summary ?? '') : '', ...(entry.repos ?? []).flatMap(r => r.commits.map(c => c.subject))]
  return new RegExp(`(^|[^\\w-])${escapeRe(name)}($|[^\\w-])`, 'i').test(said.join('\n'))
}

/**
 * The entries to show a session now: other sessions' entries after its cursor (less GRACE_MS, by id) that concern
 * its project, and the cursor and seen ids that follow.
 */
export function selectNews(entries: readonly JournalEntry[], state: JournalSeen, me: { session: string; name: string; base: string }) {
  const seen = new Set(state.seen)
  const fresh = entries.filter(e => e.at > state.cursor - GRACE_MS && !seen.has(e.id))
  const news = fresh.filter(e => e.session !== me.session && concerns(e, me))
  const cursor = Math.max(state.cursor, ...fresh.map(e => e.at))
  const next = [...state.seen.filter(id => entries.some(e => e.id === id && e.at > cursor - GRACE_MS)), ...fresh.map(e => e.id)].slice(-SEEN_MAX)
  return { news, state: { cursor, seen: next } }
}

const pad = (n: number) => String(n).padStart(2, '0')

function timeOf(at: number, now: number) {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** One entry as a news line. */
export function newsLine(e: JournalEntry, now: number) {
  const who = `${e.project?.name || 'a session'} boss${e.account ? ` (account ${e.account})` : ''}`
  const parts: string[] = []
  for (const r of e.repos ?? []) {
    const list = r.commits.map(c => `${c.hash} "${c.subject}"`).join(', ')
    parts.push(`commits in ${r.name}${r.branch ? ` (${r.branch})` : ''}: ${list}`)
  }
  if (e.prompt) parts.push(`asked: "${clip(e.prompt, PROMPT_MAX)}"`)
  if (e.summary) parts.push(`summary: ${clip(e.summary, NEWS_SUMMARY)}`)
  if (e.transcript) parts.push(`transcript: ${e.transcript}`)
  return `- [${timeOf(e.at, now)}] ${who} — ${parts.join('; ') || 'worked here'}`
}

/** The context block for a prompt: the newest NEWS_MAX entries (oldest first) within NEWS_CHARS, the rest counted. */
export function newsText(news: readonly JournalEntry[], journalPath: string, now: number) {
  if (!news.length) return ''
  const head = "Office news (other Agent Office sessions' work that concerns this project, from the office journal):"
  let shown = news.slice(-NEWS_MAX).map(e => newsLine(e, now))
  const size = () => head.length + shown.reduce((n, l) => n + l.length + 1, 0)
  while (shown.length > 1 && size() > NEWS_CHARS) shown = shown.slice(1)
  if (size() > NEWS_CHARS) shown = [clip(shown[0]!, NEWS_CHARS - head.length - 1)]
  const rest = news.length - shown.length
  return [head, ...shown, ...(rest > 0 ? [`- … and ${rest} more in ${journalPath}`] : [])].join('\n')
}
