// Studio's Team page (contract v3.124): pure helpers over the Office's team data (staff.list: team mode, presets,
// staff; desk states; projects; accounts), so the page's choices can be tested. Main keeps every limit and check
// (src/staff.js saveMember: ≤ 50 members, unique names, a valid role); nothing here validates a member.
import { byDepartment } from './staff-view.mjs';
import { teamGroups, allowedProjects } from './studio-team.mjs';

/** The page's tabs, in order. */
export const TEAM_TABS = ['members', 'roles', 'departments'];
/** The Roles gallery's "writes code" filter. */
export const CODE_FILTERS = ['all', 'code', 'noCode'];

const lc = (/** @type {unknown} */ s, /** @type {string} */ l) => String(s || '').toLocaleLowerCase(l === 'tr' ? 'tr' : 'en');

/**
 * One role card: the preset's (or the person's own library role's) texts in the UI language.
 * @param {any} def a RoleDef from staff.list presets @param {string} lang
 */
export function roleCard(def, lang = 'en') {
  const l = lang === 'tr' ? 'tr' : 'en';
  const name = def?.name?.[l] || def?.name?.en || def?.id || '';
  return {
    id: String(def?.id || ''),
    name,
    initial: ([...String(name).trim()][0] || '?').toLocaleUpperCase(l),
    short: def?.short?.[l] || '',
    description: def?.description?.[l] || def?.description?.en || '',
    brief: typeof def?.brief === 'string' ? def.brief : '',
    department: typeof def?.department === 'string' ? def.department : '',
    writesCode: def?.writesCode !== false,
    skillPacks: Array.isArray(def?.skillPacks) ? def.skillPacks.filter((x) => typeof x === 'string') : [],
    tools: Array.isArray(def?.tools) ? def.tools.filter((x) => typeof x === 'string') : [],
    custom: Boolean(def?.custom),
  };
}

/**
 * The Roles gallery: the role cards matching the search (name, short name, description, id, department) and the
 * "writes code" filter, sorted by name in the UI language.
 * @param {any[]} presets @param {{ query?: string, code?: string, lang?: string, deptName?: (d: string) => string }} [o]
 */
export function filterRoles(presets, { query = '', code = 'all', lang = 'en', deptName = (d) => d } = {}) {
  const q = lc(query, lang).trim();
  return (Array.isArray(presets) ? presets : [])
    .map((d) => roleCard(d, lang))
    .filter((r) => r.id)
    .filter((r) => (code === 'code' ? r.writesCode : code === 'noCode' ? !r.writesCode : true))
    .filter((r) => !q || [r.name, r.short, r.description, r.id, r.department, r.department ? deptName(r.department) : ''].some((x) => lc(x, lang).includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, lang === 'tr' ? 'tr' : 'en'));
}

/**
 * A new member prefilled from a role (the Roles gallery's Hire): the role by its id (no own changes on top), the
 * role's department label, its default skill packs on and the app-added MCP servers the role suggests ticked (as
 * the Office's member popup does). Name, account and projects are left for the person.
 * @param {any} def @param {{ deptName?: (d: string) => string, servers?: { id: string, name: string }[] }} [o]
 */
export function prefillMember(def, { deptName = (d) => d, servers = [] } = {}) {
  const r = roleCard(def);
  return {
    name: '',
    role: { preset: r.id },
    department: r.department ? deptName(r.department) : '',
    accountId: '',
    projects: /** @type {string[] | 'all'} */ ([]),
    skillPacks: Object.fromEntries(r.skillPacks.map((id) => [id, true])),
    tools: (Array.isArray(servers) ? servers : []).filter((s) => s && r.tools.includes(s.name)).map((s) => s.id),
  };
}

/**
 * The staff:save form for a hire: the prefill with what the person filled in (no id: main adds the member).
 * @param {ReturnType<typeof prefillMember>} prefill
 * @param {{ name?: string, department?: string, accountId?: string, all?: boolean, projects?: string[] }} input
 */
export function hireForm(prefill, input) {
  return {
    ...prefill,
    name: String(input?.name || ''),
    department: String(input?.department ?? prefill.department ?? ''),
    accountId: String(input?.accountId || ''),
    projects: input?.all ? 'all' : (Array.isArray(input?.projects) ? input.projects.filter((x) => typeof x === 'string') : []),
  };
}

/**
 * The skill packs a member works with: the role's defaults with the member's own choices on top (an old list reads
 * as on, as main reads it).
 * @param {any} member @param {any[]} presets
 */
export function memberPacks(member, presets) {
  const def = member?.role?.preset ? (presets || []).find((d) => d.id === member.role.preset) : null;
  const on = new Set(Array.isArray(def?.skillPacks) ? def.skillPacks : []);
  const own = member?.skillPacks;
  if (Array.isArray(own)) for (const id of own) on.add(id);
  else if (own && typeof own === 'object') for (const [id, v] of Object.entries(own)) { if (v) on.add(id); else on.delete(id); }
  return [...on];
}

/**
 * The Members tab: the members grouped by department (named ones first, as the TEAM panel and Studio's sidebar),
 * each with initials, role, live state, open desks, department, account label, allowed projects and skill packs.
 * @param {{ staff: any[], presets?: any[], desks?: any[], projects?: any[], waiting?: Set<string>, lang?: string,
 *   accounts?: { id: string, label: string }[] }} o
 */
export function memberCards({ staff, presets = [], desks = [], projects = [], waiting = new Set(), lang = 'en', accounts = [] }) {
  const byId = new Map((Array.isArray(staff) ? staff : []).map((m) => [m.id, m]));
  return teamGroups({ staff, presets, desks, projects, waiting, lang }).map((g) => ({
    head: g.head,
    members: g.members.map((c) => {
      const m = byId.get(c.id) || {};
      return {
        ...c,
        member: m,
        department: m.department || '',
        accountId: m.accountId || '',
        account: m.accountId ? (accounts || []).find((a) => a.id === m.accountId)?.label || '' : '',
        allProjects: m.projects === 'all',
        projects: allowedProjects(m, projects).map((p) => ({ id: p.id, name: p.name || p.id })),
        skillPacks: memberPacks(m, presets),
      };
    }),
  }));
}

/**
 * The Departments tab: each department with its member count (in the order first met), members without one last
 * (name '').
 * @param {any[]} staff @returns {{ name: string, count: number }[]}
 */
export function departmentCounts(staff) {
  return byDepartment(staff).map((g) => ({ name: g.head, count: g.members.length }));
}

/**
 * Renaming a department: the staff:save forms of its members with the new label (each saved through main, which
 * checks it as any edit). An empty name is refused here; the same name changes nothing.
 * @param {any[]} staff @param {string} from @param {string} to
 * @returns {{ forms: any[] } | { error: 'empty' | 'none' }}
 */
export function renameForms(staff, from, to) {
  const name = String(to || '').trim();
  if (!from) return { error: 'none' };
  if (!name) return { error: 'empty' };
  if (name === from) return { forms: [] };
  return { forms: (Array.isArray(staff) ? staff : []).filter((m) => (m.department || '') === from).map((m) => ({ ...m, department: name })) };
}
