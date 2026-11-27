// Studio's Team section and "Who?" picker (contract v3.122): pure helpers over the Office's team data (staff, role
// presets, desk states from main and the sessions' waiting flags), so they can be tested.
import { roleOf, byDepartment } from './staff-view.mjs';
import { START_WAIT_MS, startFailure } from './studio-ux.mjs';

/** Up to two initials of a name ("Ada Lovelace" → "AL", "ada" → "A"). */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => [...p][0]).join('').toLocaleUpperCase() || '?';
}

/**
 * A member's live state from their desks: 'needs' (a desk session waits for the person), 'working' (a desk is busy),
 * else 'idle'. waiting: the "<projectId>|<staffId>" keys of desk sessions with an open question.
 * @param {any[]} desks @param {string} memberId @param {Set<string>} [waiting]
 * @returns {'needs' | 'working' | 'idle'}
 */
export function memberState(desks, memberId, waiting = new Set()) {
  const mine = (desks || []).filter((d) => d && d.staffId === memberId);
  if (mine.some((d) => waiting.has(`${d.projectId}|${memberId}`))) return 'needs';
  if (mine.some((d) => d.state === 'busy')) return 'working';
  return 'idle';
}

/** The projects a member may work on (not HQ, not a personal workspace). */
export function allowedProjects(member, projects) {
  const list = (projects || []).filter((p) => !p.hq && !p.staffOwner);
  return member?.projects === 'all' ? list : list.filter((p) => Array.isArray(member?.projects) && member.projects.includes(p.id));
}

/**
 * The Team section: members grouped by department (named ones first), each with initials, role, live state and their
 * open desks per project (a desk that is off is left out).
 * @param {{ staff: any[], presets?: any[], desks?: any[], projects?: any[], waiting?: Set<string>, lang?: string }} o
 */
export function teamGroups({ staff, presets = [], desks = [], projects = [], waiting = new Set(), lang = 'en' }) {
  return byDepartment(staff).map((g) => ({
    head: g.head,
    members: g.members.map((m) => ({
      id: m.id,
      name: m.name || '',
      initials: initials(m.name),
      role: roleOf(m, presets, lang).name,
      state: memberState(desks, m.id, waiting),
      desks: (desks || []).filter((d) => d.staffId === m.id && d.state !== 'off').map((d) => ({
        projectId: d.projectId,
        name: (projects || []).find((p) => p.id === d.projectId)?.name || d.projectId,
        state: waiting.has(`${d.projectId}|${m.id}`) ? 'needs' : d.state === 'busy' ? 'working' : d.state === 'asleep' ? 'asleep' : 'idle',
      })),
    })),
  }));
}

/**
 * The start screen's "Who?" options for a project: Me first, then the members allowed on it. Desks run Claude Code,
 * so a project on another engine offers only Me.
 */
export function whoOptions(staff, projectId, projects) {
  const p = (projects || []).find((x) => x.id === projectId);
  const claude = p && (!p.engine || p.engine === 'claude');
  const members = claude ? (staff || []).filter((m) => allowedProjects(m, projects).some((x) => x.id === projectId)) : [];
  return [{ value: 'me', name: '' }, ...members.map((m) => ({ value: m.id, name: m.name || '' }))];
}

/**
 * Who → how the start screen starts the work: 'me' a normal session (the existing start plan); a member allowed on
 * the project their desk (the Office's desk-start path), then the prompt. A pick that is no longer valid (the member
 * was removed or is no longer allowed on the project) is refused, never silently run as Me.
 * @returns {{ kind: 'session' } | { kind: 'desk', projectId: string, staffId: string } | { kind: 'stale' }}
 */
export function whoPlan(who, projectId, staff, projects) {
  if (!who || who === 'me') return { kind: 'session' };
  const ok = whoOptions(staff, projectId, projects).some((o) => o.value === who);
  return ok ? { kind: 'desk', projectId, staffId: who } : { kind: 'stale' };
}

/** The desk's own session to send to: the pty id openDesk returned, only when it belongs to the project; else null. */
export function deskTarget(pty, projectId) {
  if (typeof pty !== 'string' || !pty || !projectId) return null;
  return pty === projectId || pty.startsWith(`${projectId}:`) ? pty : null;
}

/**
 * One chat:send answer while sending the start prompt to a desk: 'ok' sent; 'retry' the desk's chat is still starting
 * ('not-running', within the limit); anything else 'fail' (busy, locked, unsupported, an error, or the time is up).
 * @param {unknown} result @param {number} elapsed @param {number} [limit]
 * @returns {'ok' | 'retry' | 'fail'}
 */
export function deskSendStep(result, elapsed, limit = START_WAIT_MS) {
  if (result === 'ok') return 'ok';
  if (result === 'not-running' && elapsed < limit) return 'retry';
  return 'fail';
}

/**
 * Sends the start prompt to exactly one desk session (bounded retry while its chat starts).
 * @param {{ pty: string | null, text: string, send: (pty: string, text: string) => Promise<unknown>,
 *   wait: () => Promise<void>, now?: () => number, limit?: number }} o (wait: the pause between tries)
 * @returns {Promise<{ ok: true } | { ok: false, failed: { step: 'desk' | 'prompt', why: string, detail: string } }>}
 */
export async function deskSend({ pty, text, send, wait, now = Date.now, limit = START_WAIT_MS }) {
  if (!pty) return { ok: false, failed: { step: 'desk', why: 'other', detail: '' } };
  if (!text) return { ok: true };
  const t0 = now();
  for (;;) {
    const r = await send(pty, text).catch(() => 'error');
    const next = deskSendStep(r, now() - t0, limit);
    if (next === 'ok') return { ok: true };
    if (next === 'fail') return { ok: false, failed: { step: 'prompt', ...startFailure(r) } };
    await wait();
  }
}
