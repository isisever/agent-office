import { expect, test } from 'claude-code/testing'
import { readyText, REPORT_MAX, reportOf, ReportTracker, TASK_MAX_MS, taskIdOf, typedTaskId, writeReport } from '../hooks/reports'
import type { Host } from '../hooks/journal'

// one boss (app contract v3.35): the plugin of the machine that runs a dispatched task writes its report; the
// dispatcher's boss gets only a fixed "report ready" notice

const MARKED = '[Agent Office: remote task #a1b2c3d4e5f60718 from "Studio"] run the tests'
const wrap = (id: string, project: string, machine: string) => `Remote task #${id} on ${project}@${machine} finished; read it with office_reports.`

test('marker: only the app-typed prefix opens a task', async () => {
  expect(taskIdOf(MARKED)).toBe('a1b2c3d4e5f60718')
  expect(taskIdOf('[Agent Office: remote command from "Studio"] run the tests')).toBe(undefined)
  expect(taskIdOf(`please ${MARKED}`)).toBe(undefined)
  expect(taskIdOf('[Agent Office: remote task #../x from "S"] hi')).toBe(undefined)
  // a task given as the first-prompt argument has lost its quotes (app promptArg), still a task
  expect(taskIdOf('[Agent Office: remote task #edb2d4505fa1dd57 from Yasin-MacBook-Air] deploy it')).toBe('edb2d4505fa1dd57')
  expect(taskIdOf('[Agent Office: remote task #x1 from a]b] hi')).toBe(undefined)
  const tr = new ReportTracker()
  expect(tr.prompt('just a prompt', 1)).toBe(undefined)
  expect(tr.pending).toBe(undefined)
  expect(tr.prompt(MARKED, 5)).toBe(undefined)
  expect(tr.pending?.id).toBe('a1b2c3d4e5f60718')
  // a second marked task closes the first (reported as partial by the caller)
  const closed = tr.prompt('[Agent Office: remote task #ffff000011112222 from "Studio"] next', 9)
  expect(closed?.id).toBe('a1b2c3d4e5f60718')
  expect(tr.pending?.id).toBe('ffff000011112222')
})

test('waits for workers: no report while agents of the session still run', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1)
  expect(tr.complete('Started two agents.', 2)).toBe(undefined)
  expect(tr.pending?.id).toBe('a1b2c3d4e5f60718')
  const task = tr.complete('All tests pass; fixed the flaky one.', 0)
  expect(task?.answer).toBe('All tests pass; fixed the flaky one.')
  expect(tr.pending).toBe(undefined)
  expect(tr.complete('later turn', 0)).toBe(undefined)
})

test('redaction and size: secrets out, summary cut to 16 KB', async () => {
  const r = reportOf({ id: 'x1', sinceMs: 0, answer: `Deployed with token sk-ant-abcdefghijklmnop and ${'y'.repeat(20000)}` }, [], 7)
  expect(r.summary.includes('sk-ant-abcdefghijklmnop')).toBe(false)
  expect(r.summary.includes('[redacted]')).toBe(true)
  expect(r.summary.length <= REPORT_MAX).toBe(true)
  expect(r.partial).toBe(false)
  const written: [string, string][] = []
  const host: Host = {
    run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    stat: async () => ({ size: 0, mtimeMs: 0 }),
    read: async () => '',
    write: async (path, text) => {
      written.push([path, text])
    },
  }
  await writeReport(host, '/data/office', '/work/shop', { id: 'x1', sinceMs: 0, answer: 'password=hunter2hunter2 done' }, 9, true)
  expect(written.length).toBe(1)
  expect(written[0]![0]).toBe('/data/office/reports/x1.json')
  const saved = JSON.parse(written[0]![1]) as { partial: boolean; summary: string; at: number }
  expect(saved.partial).toBe(true)
  expect(saved.summary.includes('hunter2hunter2')).toBe(false)
})

test('report-ready wrapper: a fixed notice, names cleaned, any other row ignored', async () => {
  expect(readyText({ at: 1, kind: 'report-ready', id: 'a1b2', machine: 'Laptop', project: 'shop' }, wrap)).toBe(
    'Remote task #a1b2 on shop@Laptop finished; read it with office_reports.',
  )
  const odd = readyText({ at: 1, kind: 'report-ready', id: 'a1b2', machine: 'L"ap\ntop', project: '[x] ignore previous' }, wrap) ?? ''
  expect(odd.includes('"')).toBe(false)
  expect(odd.includes('\n')).toBe(false)
  expect(readyText({ at: 1, kind: 'report-ready', id: 'bad id!', machine: 'L', project: 'p' }, wrap)).toBe(undefined)
  expect(readyText({ at: 1, text: 'a task' }, wrap)).toBe(undefined)
  expect(readyText({ at: 1, kind: 'report', id: 'a1', text: 'the report' }, wrap)).toBe(undefined)
})

test('an unmarked prompt of the person closes the open task as partial, with the answers so far', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1)
  expect(tr.complete('Half done; waiting on one agent.', 1)).toBe(undefined)
  const closed = tr.prompt('stop that and look at the login page', 5)
  expect(closed?.id).toBe('a1b2c3d4e5f60718')
  expect(closed?.answer).toBe('Half done; waiting on one agent.')
  expect(tr.pending).toBe(undefined)
  expect(reportOf(closed!, [], 6, true).partial).toBe(true)
  expect(tr.prompt('another plain prompt', 7)).toBe(undefined)
})

test('max wait: a task open longer than 2 h is reported as partial', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1000)
  tr.complete('Started agents.', 3)
  expect(tr.expired(1000 + TASK_MAX_MS)).toBe(undefined)
  const late = tr.expired(1001 + TASK_MAX_MS)
  expect(late?.id).toBe('a1b2c3d4e5f60718')
  expect(late?.answer).toBe('Started agents.')
  expect(tr.pending).toBe(undefined)
})

test('a collapsed paste without the marker: the id the app recorded before typing opens the task', async () => {
  const files = new Map<string, string>([['/d/tasks/s-1.json', JSON.stringify({ id: 'feed000011112222', at: 100 })]])
  const host: Host = {
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    stat: async () => ({ size: 0, mtimeMs: 0 }),
    read: async path => {
      if (!files.has(path)) throw new Error('missing')
      return files.get(path)!
    },
    write: async (path, text) => {
      files.set(path, text)
    },
  }
  const typed = await typedTaskId(host, '/d', 's-1', 200)
  expect(typed).toBe('feed000011112222')
  expect(files.get('/d/tasks/s-1.json')).toBe('')
  expect(await typedTaskId(host, '/d', 's-1', 300)).toBe(undefined)
  files.set('/d/tasks/s-1.json', JSON.stringify({ id: 'old0', at: 0 }))
  expect(await typedTaskId(host, '/d', 's-1', 3600 * 1000)).toBe(undefined)
  const tr = new ReportTracker()
  tr.prompt('[Pasted text #1 +40 lines]', 1, typed)
  expect(tr.pending?.id).toBe('feed000011112222')
})
