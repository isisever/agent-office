// HQ task watch (contract v3.81 amendment): this machine's own dispatched tasks (HQ's, a boss's, a routine's) are
// followed in the tab they were typed into, so the Board and HQ know where each one is, and a task always ends.
// The session's plugin writes the report when its turn ends (plugin/hooks/reports.ts); if that never happens (the
// session went idle without a marked task, crashed, or its tab was closed) the app ends the task itself with a partial
// report holding the session's last answer. Pure; tested in test/hq.test.cjs.
'use strict';

const IDLE_MS = 3 * 60 * 1000;    // idle this long after its task (nothing running, no prompt open) and no report: ended
const GONE_MS = 60 * 1000;        // the tab gone this long and no report: ended
const OPEN = new Set(['delivered', 'running', 'needs-approval']);
const SUMMARY_MAX = 16 * 1024;

/**
 * One look at one task. → { status?, end?: 'idle' | 'gone', mem } — status: the board status to show now
 * (`running` while the tab works, `needs-approval` while it waits on a prompt or dialog, `delivered` while idle);
 * end: write the fallback report now.
 * @param {{ status: string, live: 'gone' | 'busy' | 'permission' | 'idle', now: number, mem?: { since?: number, idleSince?: number } }} o
 *   status: the task's board status; live: its tab now; mem: what the last look kept for this task
 * @returns {{ status?: string, end?: 'idle' | 'gone', mem: { since?: number, idleSince?: number } }}
 */
function watchStep({ status, live, now, mem = {} }) {
  if (!OPEN.has(status)) return { mem: {} };
  const since = Number.isFinite(mem.since) ? mem.since : now;   // first seen delivered
  if (live === 'busy' || live === 'permission') return { status: live === 'busy' ? 'running' : 'needs-approval', mem: { since } };
  const idleSince = Number.isFinite(mem.idleSince) ? mem.idleSince : now;
  const wait = live === 'gone' ? GONE_MS : IDLE_MS;
  const end = now - idleSince >= wait && now - since >= wait ? (live === 'gone' ? 'gone' : 'idle') : undefined;
  return { status: 'delivered', ...(end ? { end } : {}), mem: { since, idleSince } };
}

/** The report the app writes for a task its session never reported on: partial, with the session's last answer. */
function fallbackReport({ why, answer, now }) {
  const head = why === 'gone'
    ? '[Agent Office] The session that had this task stopped before it wrote its report. Its last answer:'
    : '[Agent Office] The session that had this task went idle without writing its report (it may be waiting for the person). Its last answer:';
  const body = String(answer || '').trim() || '(no answer in its conversation)';
  return { ok: false, partial: true, summary: `${head}\n\n${body}`.slice(0, SUMMARY_MAX), commits: [], at: now };
}

module.exports = { IDLE_MS, GONE_MS, watchStep, fallbackReport };
