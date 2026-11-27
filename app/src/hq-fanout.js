// Fan-out orders and role assignment (contract v3.132): pure rules, no Electron; tested in test/hq-fanout.test.cjs.
// HQ's office_dispatch may carry `targets: [{ project, machine?, desk? | member? | staff? | role?, title? }]` (at most
// FANOUT_MAX) instead of one target, with one shared task text and type. main.js expands it into one single dispatch per
// target, in the same order, and runs each through the unchanged hqDispatch path (consent, caps / order queue,
// redaction, seal). A target with `role` gets a staff member picked by `pickMember`.
'use strict';

const { mayWork } = require('./staff.js');
const { TERMINAL } = require('./hq.js');

const FANOUT_MAX = 8;
const TARGET_KEYS = new Set(['project', 'machine', 'desk', 'member', 'staff', 'role', 'title']);
// a fan-out call names its targets only in `targets`: these single-target or staged arguments may not be given with it
const SINGLE_KEYS = ['project', 'machine', 'staff', 'member', 'role', 'desk', 'after', 'then'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const low = (v) => str(v).toLocaleLowerCase('tr');

/**
 * Why a fan-out call is refused before anything runs, or '' when it is valid.
 * 'bad-targets' (not a non-empty array), 'too-many-targets' (> FANOUT_MAX), 'fanout-mixed' (also a single target or
 * stages), 'bad-target' (not an object, no project, an unknown key, or more than one of desk / member / staff / role).
 */
function fanOutRefusal(args) {
  const a = args && typeof args === 'object' ? args : {};
  const ts = a.targets;
  if (!Array.isArray(ts) || !ts.length) return 'bad-targets';
  if (ts.length > FANOUT_MAX) return 'too-many-targets';
  if (SINGLE_KEYS.some((k) => a[k] !== undefined && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length))) return 'fanout-mixed';
  for (const t of ts) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return 'bad-target';
    if (Object.keys(t).some((k) => !TARGET_KEYS.has(k))) return 'bad-target';
    if (Object.keys(t).some((k) => t[k] !== undefined && typeof t[k] !== 'string')) return 'bad-target';
    if (!str(t.project)) return 'bad-target';
    if (['desk', 'member', 'staff', 'role'].filter((k) => str(t[k])).length > 1) return 'bad-target';
  }
  return '';
}

/**
 * One single-dispatch argument object per target, in the request's order. The shared fields (task, type, title,
 * request) are copied; a target's `desk` / `member` / `staff` all name a staff member (its desk) and become `staff`
 * (never the app's internal `desk`); `role` is kept for main to resolve with pickMember. Call fanOutRefusal first.
 * @returns {{ n: number, role: string, args: Record<string, any> }[]}
 */
function expandFanOut(args) {
  const { targets, ...shared } = args;
  return targets.map((t, i) => {
    const member = str(t.staff) || str(t.member) || str(t.desk);
    const one = { ...shared, project: str(t.project) };
    if (str(t.machine)) one.machine = str(t.machine);
    if (str(t.title)) one.title = str(t.title);
    if (member) one.staff = member;
    return { n: i + 1, role: member ? '' : str(t.role), args: one };
  });
}

/** A member's role words that `role` may name: the preset id, the member's own role name, the preset's names. */
function roleKeys(member, defs) {
  const r = member?.role || {};
  const def = r.preset ? (Array.isArray(defs) ? defs : []).find((d) => d?.id === r.preset) || null : null;
  const names = def?.name && typeof def.name === 'object' ? Object.values(def.name) : def?.name ? [def.name] : [];
  return [r.preset, r.name, ...names].map(low).filter(Boolean);
}

/** The label of a member's role for a refusal: its own name, else the preset's English name, else the preset id. */
function roleLabel(member, defs) {
  const r = member?.role || {};
  const def = r.preset ? (Array.isArray(defs) ? defs : []).find((d) => d?.id === r.preset) || null : null;
  return str(r.name) || str(def?.name?.en ?? def?.name) || str(r.preset);
}

/**
 * The staff member for a role in a project: one that has the role (preset id or role name, case ignored) and may work
 * on the project; the fewest open tasks first (idle = 0); a tie goes to a member whose desk in that project is warm
 * (running); then the team's order. No fit: { reason: 'no-member-for-role', roles } with the roles available there.
 * @param {{ staff: any[], project: any, role: string, load?: Record<string, number>, warm?: Iterable<string>, defs?: any[] }} o
 *   project: the project object (or id); load: open tasks by member id; warm: ids of members whose desk there runs.
 * @returns {{ member: any } | { reason: 'no-member-for-role', roles: string[] }}
 */
function pickMember({ staff, project, role, load = {}, warm = [], defs = [] }) {
  const team = Array.isArray(staff) ? staff : [];
  const here = team.filter((m) => m && mayWork(m, project));
  const want = low(role);
  const warmSet = new Set(warm || []);
  const fits = want ? here.filter((m) => roleKeys(m, defs).includes(want)) : [];
  if (!fits.length) return { reason: 'no-member-for-role', roles: [...new Set(here.map((m) => roleLabel(m, defs)).filter(Boolean))].sort() };
  const n = (m) => Math.max(0, Number(load?.[m.id]) || 0);
  const ranked = fits.map((m, i) => ({ m, i })).sort((a, b) => n(a.m) - n(b.m) || Number(warmSet.has(b.m.id)) - Number(warmSet.has(a.m.id)) || a.i - b.i);
  return { member: ranked[0].m };
}

/** Open (not ended) HQ tasks per staff member id, from board rows (`staffId`). */
function memberLoad(tasks) {
  /** @type {Record<string, number>} */ const out = {};
  for (const t of Array.isArray(tasks) ? tasks : []) if (t && typeof t.staffId === 'string' && t.staffId && !TERMINAL.has(t.status)) out[t.staffId] = (out[t.staffId] || 0) + 1;
  return out;
}

module.exports = { FANOUT_MAX, fanOutRefusal, expandFanOut, pickMember, memberLoad, roleKeys, roleLabel };
