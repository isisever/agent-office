// Studio experience (contract v3.153): paired machines' projects in the Projects list. Pure logic only; renderer/studio.js
// draws it. A remote project is one row like a local one with a small machine tag. What can be done with it is exactly
// what the device link allows (read-only session view, send a command, start/wake/sleep/stop/restart where the peer
// allows managing); everything local (settings, Finder, new session, drag, close) is not offered.

const LIVE_STATUS = ['working', 'waiting', 'approval'];

/** @param {any} v @param {number} max */
const line = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');

/**
 * One list entry for a remote project row (main's HQ.remoteRows entry).
 * @param {any} r
 * @returns {{ id: string, key: string, pub: string, projectId: string, name: string, machine: string, account: string, remote: true,
 *   online: boolean, dim: boolean, state: string, status: string, engine: string, asOf: number, buttons: string[],
 *   canView: boolean, canSend: boolean, running: never[], recent: never[], attention: null, group: string } | null}
 */
export function remoteGroup(r) {
  if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !r.key || typeof r.pub !== 'string' || !r.pub || typeof r.id !== 'string') return null;
  const online = Boolean(r.online);
  const engine = typeof r.engine === 'string' ? r.engine : '';
  const state = typeof r.state === 'string' ? r.state : '';
  const status = typeof r.status === 'string' ? r.status : '';
  const claude = !engine || engine === 'claude';
  return {
    id: r.key, key: r.key, pub: r.pub, projectId: r.id, name: line(r.name, 120) || r.id, machine: line(r.machine, 60), account: line(r.account, 40),
    remote: true, online, dim: !online, state, status, engine, asOf: Number.isFinite(r.asOf) ? r.asOf : 0,
    buttons: online && Array.isArray(r.buttons) ? r.buttons.filter((b) => typeof b === 'string') : [],
    canView: online && claude,   // the session view (sess-open) needs the peer online and a Claude project
    canSend: online && claude,   // the command box (link send) is Claude only, as in HQ's board
    running: [], recent: [], attention: null, group: '',
  };
}

/**
 * The remote rows to list: sorted by machine then name (stable, never mixed into the local order), filtered by the
 * typed text (project, machine or account name). An offline machine's rows stay (dimmed).
 * @param {any[]} rows main's remote rows @param {string} [query]
 */
export function remoteGroups(rows, query = '') {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const g = remoteGroup(r);
    if (!g) continue;
    if (q && ![g.name, g.machine, g.account].some((s) => s.toLowerCase().includes(q))) continue;
    out.push(g);
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine) || a.name.localeCompare(b.name));
}

/** The machine tag is on every remote row (it is the point of the row: where it runs). */
export const machineTag = (/** @type {{ machine?: string }} */ g) => (g && g.machine) || '';

/**
 * The row's dot: 'live' (working / waiting / approval on an online machine), 'asleep', or '' (stopped, idle or offline).
 * @param {{ online: boolean, state: string, status: string }} g
 */
export function remoteDot(g) {
  if (!g.online) return '';
  if (g.state === 'asleep') return 'asleep';
  if (g.state === 'stopped') return '';
  return LIVE_STATUS.includes(g.status) ? 'live' : '';
}

/**
 * Whether a local-only row action is offered: never for a remote row.
 * @param {{ remote?: boolean } | null} g
 */
export const localActionAllowed = (g) => !(g && g.remote);
