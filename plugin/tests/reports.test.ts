import { expect, test } from 'claude-code/testing'
import { readyText, REPORT_MAX, reportOf, ReportTracker, TASK_MAX_MS, taskContext, taskIdOf, typedTaskId, UNATTENDED_TASK_TEXT, writeReport } from '../hooks/reports'
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
  expect(tr.pending?.sinceMs).toBe(9)
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

test('redaction and size: secrets out, summary cut to REPORT_MAX (40 KB)', async () => {
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

test('the person\'s own prompt keeps the open task: it reports at the next turn end with no worker running (v3.89)', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1)
  expect(tr.complete('Half done; waiting on one agent.', 1)).toBe(undefined)
  expect(tr.prompt('split this among subagents', 5)).toBe(undefined)
  expect(tr.pending?.id).toBe('a1b2c3d4e5f60718')
  expect(tr.pending?.sinceMs).toBe(1)
  expect(tr.pending?.answer).toBe('Half done; waiting on one agent.')
  // the follow-up's turn: still waiting on its agents, then the real final answer
  expect(tr.complete('Split into three agents.', 3)).toBe(undefined)
  const task = tr.complete('All three finished; tests pass.', 0)
  expect(task?.id).toBe('a1b2c3d4e5f60718')
  expect(task?.answer).toBe('All three finished; tests pass.')
  expect(reportOf(task!, [], 6).partial).toBe(false)
  // the report says the person typed in that session: it may answer the person rather than the task
  expect(reportOf(task!, [], 6).personPrompted).toBe(true)
  expect(tr.pending).toBe(undefined)
  expect(tr.prompt('another plain prompt', 7)).toBe(undefined)
  expect(tr.pending).toBe(undefined)
})

test('personPrompted: only the person\'s own prompt marks the report; the notice says so', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1)
  // the same task typed again by the app is not the person's prompt
  tr.prompt(MARKED, 2)
  const plain = reportOf(tr.complete('Done.', 0)!, [], 3)
  expect('personPrompted' in plain).toBe(false)
  // a prompt before any task marks nothing
  tr.prompt('hello', 4)
  tr.prompt(MARKED, 5)
  expect(tr.pending?.personPrompted).toBe(undefined)
  tr.prompt('what time is the meeting?', 6)
  expect(tr.pending?.personPrompted).toBe(true)
  // closed as partial by another task: the mark stays on the report
  const closed = tr.prompt('[Agent Office: remote task #ffff000011112222 from "Studio"] next', 7)
  expect(reportOf(closed!, [], 8, true).personPrompted).toBe(true)
  expect(tr.pending?.personPrompted).toBe(undefined)
  const say = (id: string, project: string, machine: string, personPrompted: boolean) => `${id} ${project}@${machine}${personPrompted ? ' person-prompted' : ''}`
  expect(readyText({ at: 1, kind: 'report-ready', id: 'a1', machine: 'L', project: 'p', personPrompted: true }, say)).toBe('a1 p@L person-prompted')
  expect(readyText({ at: 1, kind: 'report-ready', id: 'a1', machine: 'L', project: 'p' }, say)).toBe('a1 p@L')
  expect(readyText({ at: 1, kind: 'report-ready', id: 'a1', machine: 'L', project: 'p', personPrompted: 'true' }, say)).toBe('a1 p@L')
})

test('a task never crosses into another session: a new session id (/clear) closes it as partial', async () => {
  const tr = new ReportTracker()
  expect(tr.session('s1')).toBe(undefined)
  tr.prompt(MARKED, 1, undefined, 's1')
  expect(tr.pending?.sid).toBe('s1')
  tr.complete('Half done; waiting on one agent.', 1)
  // the same session starting again (a reload) keeps it
  expect(tr.session('s1')).toBe(undefined)
  expect(tr.session('')).toBe(undefined)
  expect(tr.pending?.id).toBe('a1b2c3d4e5f60718')
  const stale = tr.session('s2')
  expect(stale?.id).toBe('a1b2c3d4e5f60718')
  expect(tr.pending).toBe(undefined)
  expect(reportOf(stale!, [], 9, true).partial).toBe(true)
  expect(reportOf(stale!, [], 9, true).summary).toBe('Half done; waiting on one agent.')
  // nothing left for the new conversation to report
  expect(tr.complete('An answer in the cleared conversation.', 0)).toBe(undefined)
  // a task opened before the session id was known adopts the first id it sees, then follows the same rule
  tr.prompt(MARKED, 10)
  expect(tr.session('s2')).toBe(undefined)
  expect(tr.pending?.sid).toBe('s2')
  expect(tr.session('s3')?.id).toBe('a1b2c3d4e5f60718')
})

test('the same task typed again does not close or restart it; another id closes it as partial (v3.89)', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1)
  tr.complete('Half done.', 1)
  expect(tr.prompt(MARKED, 5)).toBe(undefined)
  expect(tr.prompt('[Pasted text #1 +40 lines]', 6, 'a1b2c3d4e5f60718')).toBe(undefined)
  expect(tr.pending?.sinceMs).toBe(1)
  expect(tr.pending?.answer).toBe('Half done.')
  // a prompt of the person with a stale typed id of another task is that other task
  const closed = tr.prompt('[Pasted text #2 +3 lines]', 8, 'ffff000011112222')
  expect(closed?.id).toBe('a1b2c3d4e5f60718')
  expect(closed?.answer).toBe('Half done.')
  expect(reportOf(closed!, [], 9, true).partial).toBe(true)
  expect(tr.pending?.id).toBe('ffff000011112222')
})

test('max wait counts from the task\'s start: the person\'s prompts do not hold a task open past 2 h (v3.89)', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1000)
  tr.complete('Started agents.', 2)
  // a prompt every 20 minutes, the same task typed again in between, agents never done
  for (let at = 1000 + 20 * 60 * 1000; at <= 1000 + TASK_MAX_MS; at += 20 * 60 * 1000) {
    expect(tr.expired(at)).toBe(undefined)
    expect(tr.prompt('and also the login page', at)).toBe(undefined)
    expect(tr.prompt(MARKED, at + 1)).toBe(undefined)
    expect(tr.complete('', 2)).toBe(undefined)
  }
  expect(tr.pending?.sinceMs).toBe(1000)
  const late = tr.expired(1001 + TASK_MAX_MS)
  expect(late?.id).toBe('a1b2c3d4e5f60718')
  expect(late?.answer).toBe('Started agents.')
  expect(tr.pending).toBe(undefined)
  expect(tr.prompt('one more', 2000 + TASK_MAX_MS)).toBe(undefined)
  expect(tr.pending).toBe(undefined)
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

test('a dispatched task (v3.95) gets the nobody-at-this-tab sentence; a prompt the person types gets nothing', () => {
  for (const part of ['Nobody is at this tab', 'Do not use AskUserQuestion or plan mode for this task', 'decide, do the work, and state each assumption in the report'])
    expect(UNATTENDED_TASK_TEXT).toContain(part)
  expect(UNATTENDED_TASK_TEXT.split('\n').length).toBe(1)
  expect(taskContext('[Agent Office: remote task #a1b2c3d4e5f60718 from "HQ"] fix the build')).toBe(UNATTENDED_TASK_TEXT)
  expect(taskContext('a collapsed paste', 'a1b2c3d4e5f60718')).toBe(UNATTENDED_TASK_TEXT)   // the id the app recorded before typing
  expect(taskContext('fix the build')).toBe(undefined)
  expect(taskContext('please [Agent Office: remote task #a1 from "HQ"] fix it')).toBe(undefined)
  expect(taskContext('[Agent Office: remote command from "Studio"] run the tests')).toBe(undefined)
  expect(taskContext('fix the build', '../x y')).toBe(undefined)
})
