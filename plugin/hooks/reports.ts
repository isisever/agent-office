// "One boss" (app contract v3.35), the side of the machine that runs a dispatched task: the app types the task as
// `[Agent Office: remote task #<id> from "<machine>"] <text>`; this module notes the id at prompt.submit and, on a
// main turn.complete with no worker of this session still running, writes <data dir>/reports/<id>.json (the answer,
// redacted and cut to 40 KB (v3.48; the app cuts it further, with a marker, for an older dispatcher), PR links found in it, and the commits made since the task arrived). The app sends it to the dispatcher and
// deletes the file. A new marked task, or an unmarked prompt of the person, closes a still open one as partial; so
// does a wait of more than TASK_MAX_MS. Before typing, the app also writes <data dir>/tasks/<session>.json { id, at }
// (typedTaskId), so the task is known even if the engine hands the hook a prompt without the marker (a collapsed paste). On the dispatcher's side the boss gets only
// a fixed "report ready" row (readyText); the report itself is read through the office_reports tool.
import { clip, commitsSince, placeOfDir, redact } from './journal'
import type { Host, JournalCommit } from './journal'

export const REPORT_MAX = 40 * 1024 // v3.48 (cap report2); was 16 KB
export const REPORT_COMMITS = 30
const PR_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.com\/[\w./-]+\/-\/merge_requests\/\d+)/g
export const REPORTS_DIR = 'reports'
export const TASKS_DIR = 'tasks'
export const TASK_MAX_MS = 2 * 3600 * 1000 // an open task is reported as partial after this long
const TYPED_FRESH_MS = 10 * 60 * 1000
const ID = /^[A-Za-z0-9_.:-]{1,64}$/
const MARKER = /^\[Agent Office: remote task #([A-Za-z0-9_.:-]{1,64}) from "[^"\n]{0,64}"\] /

export type PendingTask = { id: string; sinceMs: number; answer: string }
export type TaskReport = { ok: boolean; partial: boolean; summary: string; commits: JournalCommit[]; at: number; truncated?: boolean; prs?: string[] }

/** The task id of a prompt the app typed for a dispatched task, or undefined. */
export function taskIdOf(text: string): string | undefined {
  return MARKER.exec(typeof text === 'string' ? text : '')?.[1]
}

/** The open task of this session: one at a time; it reports once the main turn ends with no worker running. */
export class ReportTracker {
  pending: PendingTask | undefined = undefined

  /**
   * A prompt of the person or the app arrived (not an engine notification): a marked one (or one the app recorded as
   * typed, `typedId`) opens a task; any other closes the open task. → the previous task when it was still open
   * (the caller reports it as partial, with the answers so far).
   */
  prompt(text: string, now: number, typedId?: string): PendingTask | undefined {
    const id = taskIdOf(text) ?? (typedId && ID.test(typedId) ? typedId : undefined)
    const before = this.pending
    this.pending = id ? { id, sinceMs: now, answer: '' } : undefined
    return before
  }

  /** → the open task when it has waited longer than TASK_MAX_MS (report it as partial), else undefined. */
  expired(now: number): PendingTask | undefined {
    const task = this.pending
    if (!task || now - task.sinceMs <= TASK_MAX_MS) return undefined
    this.pending = undefined
    return task
  }

  /** The main turn ended with `running` workers of this session still at work. → the task to report now, if any. */
  complete(answer: string, running: number): PendingTask | undefined {
    const task = this.pending
    if (!task) return undefined
    if (answer.trim()) task.answer = answer
    if (running > 0) return undefined // its agents are still working: the turn after their notifications reports
    this.pending = undefined
    return task
  }
}

/** The report of a task: the answer redacted and cut, the commits, the time. */
export function reportOf(task: PendingTask, commits: JournalCommit[], now: number, partial = false): TaskReport {
  const full = redact(task.answer.trim())
  const summary = clip(full, REPORT_MAX) || '(the session gave no answer)'
  const prs = [...new Set(full.match(PR_RE) || [])].slice(0, 10)
  return { ok: true, partial, summary, commits: commits.slice(0, REPORT_COMMITS), at: now, ...(full.length > REPORT_MAX ? { truncated: true } : {}), ...(prs.length ? { prs } : {}) }
}

/** Writes <root>/reports/<id>.json for the app (never throws). */
export async function writeReport(host: Host, root: string, cwd: string, task: PendingTask, now: number, partial = false, isWindows = false) {
  try {
    const place = cwd ? await placeOfDir(host, cwd) : { path: '' }
    const commits = 'top' in place && place.top ? (await commitsSince(host, place.top, task.sinceMs)).commits : []
    const dir = `${root}/${REPORTS_DIR}`
    await host.run(isWindows ? ['cmd.exe', '/d', '/c', 'if not exist "' + dir.replace(/\//g, '\\') + '" mkdir "' + dir.replace(/\//g, '\\') + '"'] : ['/bin/mkdir', '-p', '--', dir]).catch(() => undefined)
    await host.write(`${dir}/${task.id}.json`, JSON.stringify(reportOf(task, commits, now, partial)))
  } catch {
    // best effort: the dispatcher then sees the task as delivered without a report
  }
}

/** The task id the app recorded before typing into this session (<root>/tasks/<sid>.json), cleared once read. */
export async function typedTaskId(host: Host, root: string, sid: string, now: number): Promise<string | undefined> {
  if (!root || !ID.test(sid)) return undefined
  const file = `${root}/${TASKS_DIR}/${sid}.json`
  let raw = ''
  try {
    raw = await host.read(file)
  } catch {
    return undefined
  }
  if (!raw.trim()) return undefined
  await host.write(file, '').catch(() => undefined)
  try {
    const o = JSON.parse(raw) as { id?: unknown; at?: unknown }
    return typeof o.id === 'string' && ID.test(o.id) && typeof o.at === 'number' && Math.abs(now - o.at) <= TYPED_FRESH_MS ? o.id : undefined
  } catch {
    return undefined
  }
}

const cleanName = (value: unknown, max = 64) =>
  typeof value === 'string' ? clip(value.replace(/[\u0000-\u001f\u007f"`[\]]/g, ' ').replace(/\s+/g, ' ').trim(), max) : ''

/**
 * The prompt for an inbox row of kind 'report-ready' (the app writes { at, kind, id, machine, project }, never report
 * text): a fixed notice, not a task. undefined for any other row.
 */
export function readyText(row: unknown, wrap: (id: string, project: string, machine: string) => string): string | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const r = row as Record<string, unknown>
  if (r.kind !== 'report-ready' || typeof r.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(r.id)) return undefined
  return wrap(r.id, cleanName(r.project) || '?', cleanName(r.machine) || '?')
}
