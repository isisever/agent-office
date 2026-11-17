// Team: staff (contract v3.81): pure logic plus the preset role loader, no Electron; tested in test/staff.test.cjs.
// The team lives in Agent Office, not in the project folders: a staff member is a name, a role (a preset from
// roles/*.json, shipped like themes/ and skill-packs/, or the person's own role written on the member), an optional
// department label, an optional Claude account of its own, and the projects it may work on. Nothing here starts a
// session (desks: v3.81 step 3) or gives work (HQ: step 4). What the renderer also needs is in src/staff-view.mjs. With state.teamMode off the TEAM panel is not shown;
// the stored staff stays for when it is turned on again. Design: .claude/docs/design-staff.md.
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;          // preset role ids
const STAFF_ID_RE = /^s-[0-9a-f]{6,16}$/;
const PROJECT_ID_RE = /^[\w-]{1,64}$/;
const STAFF_MAX = 50;
const NAME_MAX = 40;
const DEPT_MAX = 30;
const DESC_MAX = 400;
const BRIEF_MAX = 4000;
// v3.82 the company's functions: a preset's department, in this order in the role picker; an own or custom role may
// also carry a free label (≤ 30)
const DEPARTMENTS = ['management', 'marketing', 'sales', 'operations', 'hr', 'finance', 'rnd'];
const CUSTOM_ID_RE = /^my-[0-9a-f]{6,16}$/;       // a role from the person's library (the wizard or the popup)
const CUSTOM_MAX = 60;
const TOOL_ID_RE = /^[\w-]{1,64}$/;               // an app-added MCP server's id (src/mcp-servers.js)

// eslint-disable-next-line no-control-regex
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
// eslint-disable-next-line no-control-regex
const textBlock = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
/** { en, tr } from either a { en, tr } object or one string. */
function bilingual(v, max) {
  if (typeof v === 'string') { const s = str(v, max); return s ? { en: s, tr: s } : null; }
  if (!v || typeof v !== 'object') return null;
  const en = str(v.en, max);
  const tr = str(v.tr, max);
  return en || tr ? { en: en || tr, tr: tr || en } : null;
}
/** A member's skill packs on top of its desk's project ({ [pack id]: on }); an old list means "on". */
function packMap(v) {
  const out = {};
  if (Array.isArray(v)) for (const id of packIds(v)) out[id] = true;
  else if (v && typeof v === 'object') for (const [k, on] of Object.entries(v)) if (ID_RE.test(k) && typeof on === 'boolean' && Object.keys(out).length < 30) out[k] = on;
  return out;
}
const packIds = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, 12);

/**
 * A preset role file → { id, name, short?, department?, description, brief, skillPacks, tools?, writesCode }, or null
 * when it is not one. department: one of DEPARTMENTS (or a free label on a custom role); tools: names of MCP servers the
 * role works best with (a suggestion: the member popup ticks the app-added servers of those names for a new member).
 * @returns {{ id: string, name: { en: string, tr: string }, short?: { en: string, tr: string }, department?: string, description: { en: string, tr: string }, brief: string, skillPacks: string[], tools?: string[], writesCode: boolean, custom?: boolean } | null}
 */
function normalizeRoleDef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) return null;
  const name = bilingual(raw.name, NAME_MAX);
  if (!name) return null;
  const description = bilingual(raw.description, DESC_MAX) || { en: '', tr: '' };
  const short = bilingual(raw.short, 8);
  const department = str(raw.department, DEPT_MAX);
  const tools = packIds(raw.tools);
  return {
    id, name, ...(short ? { short } : {}), ...(department ? { department } : {}), description, brief: textBlock(raw.brief, BRIEF_MAX),
    skillPacks: packIds(raw.skillPacks), ...(tools.length ? { tools } : {}), writesCode: raw.writesCode !== false,
  };
}

/** The preset roles shipped in `dir` (roles/*.json), sorted by file name; unreadable or malformed files are skipped. */
function loadRoles(dir, fsImpl = fs) {
  let files = [];
  try { files = fsImpl.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const def = normalizeRoleDef(JSON.parse(fsImpl.readFileSync(path.join(dir, f), 'utf8')));
      if (def && !out.some((d) => d.id === def.id)) out.push(def);
    } catch { /* skipped */ }
  }
  return out;
}

/**
 * A member's role: a preset id (its name, description, brief and writesCode may be overridden; the member popup
 * shows the preset's values and keeps only what differs) or an own role (a name, and a brief or a description).
 * → the cleaned role, or null.
 */
function roleValue(raw, presetIds = null) {
  if (!raw || typeof raw !== 'object') return null;
  const preset = typeof raw.preset === 'string' && ID_RE.test(raw.preset) && (!presetIds || presetIds.includes(raw.preset)) ? raw.preset : '';
  const name = str(raw.name, NAME_MAX);
  const description = str(raw.description, DESC_MAX);
  const brief = textBlock(raw.brief, BRIEF_MAX);
  if (!preset && !name) return null;
  return {
    ...(preset ? { preset } : {}), ...(name ? { name } : {}), ...(description ? { description } : {}), ...(brief ? { brief } : {}),
    ...(typeof raw.writesCode === 'boolean' && (preset || raw.writesCode === false) ? { writesCode: raw.writesCode } : {}),
  };
}

/**
 * One staff member, cleaned against what exists: projects and accounts that are gone are dropped (an unknown account
 * means "the project's account"). → the member, or null when it has no valid id, name or role.
 * @param {any} raw
 * @param {{ projectIds?: string[] | null, accountIds?: string[] | null, presetIds?: string[] | null, toolIds?: string[] | null }} [known]
 */
function normalizeMember(raw, { projectIds = null, accountIds = null, presetIds = null, toolIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !STAFF_ID_RE.test(raw.id)) return null;
  const name = str(raw.name, NAME_MAX);
  const role = roleValue(raw.role, presetIds);
  if (!name || !role) return null;
  const department = str(raw.department, DEPT_MAX);
  const accountId = typeof raw.accountId === 'string' && raw.accountId && (!accountIds || accountIds.includes(raw.accountId)) ? raw.accountId : '';
  const projects = raw.projects === 'all' ? 'all'
    : [...new Set((Array.isArray(raw.projects) ? raw.projects : []).filter((id) => typeof id === 'string' && PROJECT_ID_RE.test(id) && (!projectIds || projectIds.includes(id))))];
  // v3.82 the member's own MCP tools: app-added servers its desks get whatever the project's scope says
  const tools = [...new Set((Array.isArray(raw.tools) ? raw.tools : []).filter((id) => typeof id === 'string' && TOOL_ID_RE.test(id) && (!toolIds || toolIds.includes(id))))].slice(0, 20);
  return {
    id: raw.id, name, role, ...(department ? { department } : {}), ...(accountId ? { accountId } : {}),
    ...(Object.keys(packMap(raw.skillPacks)).length ? { skillPacks: packMap(raw.skillPacks) } : {}), ...(tools.length ? { tools } : {}), projects,
  };
}

// ---------- the person's role library (v3.82) ----------
// Roles the person made (the role wizard, or "save as a role" later) live in state.customRoles and are offered with
// the presets; members point at them like at a preset ({ preset: 'my-…' }). Their name is one string (both languages).

/** One custom role → a RoleDef with custom: true, or null. */
function normalizeCustomRole(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !CUSTOM_ID_RE.test(raw.id)) return null;
  const name = str(typeof raw.name === 'object' && raw.name ? raw.name.en || raw.name.tr : raw.name, NAME_MAX);
  const brief = textBlock(raw.brief, BRIEF_MAX);
  if (!name || !brief) return null;
  const description = str(typeof raw.description === 'object' && raw.description ? raw.description.en || raw.description.tr : raw.description, DESC_MAX);
  const short = str(typeof raw.short === 'object' && raw.short ? raw.short.en || raw.short.tr : raw.short, 8);
  const def = normalizeRoleDef({
    id: 'x', name, ...(short ? { short } : {}), department: raw.department, description, brief, skillPacks: raw.skillPacks, tools: raw.tools, writesCode: raw.writesCode,
  });
  return def && { ...def, id: raw.id, custom: true };
}
/** state.customRoles → the valid ones (unique ids, at most CUSTOM_MAX). */
function normalizeCustomRoles(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = normalizeCustomRole(raw);
    if (r && !out.some((x) => x.id === r.id) && out.length < CUSTOM_MAX) out.push(r);
  }
  return out;
}
/** What state.json keeps of a custom role (no `custom` flag, one-string texts). */
const customRoleFile = (r) => ({
  id: r.id, name: r.name.en, ...(r.short ? { short: r.short.en } : {}), ...(r.department ? { department: r.department } : {}),
  description: r.description.en, brief: r.brief, skillPacks: r.skillPacks, ...(r.tools ? { tools: r.tools } : {}), writesCode: r.writesCode,
});
/**
 * Adds or replaces a custom role (form.id kept when it is one of the list). → { roles, role } | { error: 'name' |
 * 'brief' | 'name-used' | 'too-many' }. Names are unique among custom roles and presets, ignoring case.
 */
function saveCustomRole(roles, form, presets = [], newId = () => `my-${Math.random().toString(16).slice(2, 12).padEnd(10, '0')}`) {
  const list = Array.isArray(roles) ? roles : [];
  const exists = typeof form?.id === 'string' && list.some((r) => r.id === form.id);
  let id = exists ? form.id : newId();
  for (let i = 0; !exists && i < 20 && list.some((r) => r.id === id); i++) id = newId();
  if (!str(form?.name, NAME_MAX)) return { error: 'name' };
  const role = normalizeCustomRole({ ...form, id });
  if (!role) return { error: 'brief' };
  const key = (s) => String(s).toLocaleLowerCase('tr');
  const taken = [...list.filter((r) => r.id !== id).map((r) => r.name.en), ...presets.flatMap((d) => [d.name.en, d.name.tr])];
  if (taken.some((n) => key(n) === key(role.name.en))) return { error: 'name-used' };
  if (!exists && list.length >= CUSTOM_MAX) return { error: 'too-many' };
  return { roles: exists ? list.map((r) => (r.id === id ? role : r)) : [...list, role], role };
}
/**
 * Removes a custom role; members that used it keep it as their own role (its name, description, brief and writesCode
 * copied onto them, their own changes on top), so nobody loses a role. → { roles, staff }
 */
function removeCustomRole(roles, staff, id) {
  const role = (Array.isArray(roles) ? roles : []).find((r) => r.id === id);
  const left = (Array.isArray(roles) ? roles : []).filter((r) => r.id !== id);
  if (!role) return { roles: left, staff: Array.isArray(staff) ? staff : [] };
  const members = (Array.isArray(staff) ? staff : []).map((m) => {
    if (m.role?.preset !== id) return m;
    const { preset: _p, ...own } = m.role;
    return { ...m, role: { name: role.name.en, description: role.description.en, brief: role.brief, ...(role.writesCode ? {} : { writesCode: false }), ...own } };
  });
  return { roles: left, staff: members };
}

/** state.staff → the valid members (at most STAFF_MAX, unique ids). */
function normalizeStaff(list, known = {}) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = normalizeMember(raw, known);
    if (m && !out.some((x) => x.id === m.id) && out.length < STAFF_MAX) out.push(m);
  }
  return out;
}

/** A new member's id. @param {() => string} [hex] */
const newStaffId = (hex = () => Math.random().toString(16).slice(2, 12).padEnd(10, '0')) => `s-${hex()}`;

/**
 * Adds or replaces a member (by id; a form without one gets a new id). → { staff, member } | { error: 'name' | 'role'
 * | 'too-many' | 'name-used' }. Names are unique, ignoring case.
 */
function saveMember(staff, form, known = {}, newId = newStaffId) {
  const list = Array.isArray(staff) ? staff : [];
  const exists = typeof form?.id === 'string' && list.some((m) => m.id === form.id);
  let id = exists ? form.id : newId();
  for (let i = 0; !exists && i < 20 && list.some((m) => m.id === id); i++) id = newId();   // a new id never takes an old one
  if (!exists && list.some((m) => m.id === id)) return { error: 'too-many' };
  if (!str(form?.name, NAME_MAX)) return { error: 'name' };
  const member = normalizeMember({ ...form, id }, known);
  if (!member) return { error: 'role' };
  if (list.some((m) => m.id !== id && m.name.toLocaleLowerCase('tr') === member.name.toLocaleLowerCase('tr'))) return { error: 'name-used' };
  if (!exists && list.length >= STAFF_MAX) return { error: 'too-many' };
  return { staff: exists ? list.map((m) => (m.id === id ? member : m)) : [...list, member], member };
}
const removeMember = (staff, id) => (Array.isArray(staff) ? staff : []).filter((m) => m.id !== id);

/** A project removed from this machine leaves every member's list ('all' stays 'all'). */
const dropProject = (staff, projectId) => (Array.isArray(staff) ? staff : [])
  .map((m) => (Array.isArray(m.projects) && m.projects.includes(projectId) ? { ...m, projects: m.projects.filter((x) => x !== projectId) } : m));
/** A removed account: its members use their projects' accounts again. */
const dropAccount = (staff, accountId) => (Array.isArray(staff) ? staff : [])
  .map((m) => (m.accountId === accountId ? (({ accountId: _a, ...rest }) => rest)(m) : m));

/** May the member work on this project? */
const mayWork = (member, projectId) => member?.projects === 'all' || (Array.isArray(member?.projects) && member.projects.includes(projectId));

// ---------- desks (step 3) and HQ (step 4) ----------
// A desk is a staff member's tab in a project (tab.staffId): its own session, with the member's account and role.
// One project folder, one desk at work at a time (the lock), unless the project allows parallel work: then each desk
// works in its own git worktree under userData/work/<project>/<member> (never next to the project, never in Projects).

/** The member's role for the model (English), from its preset with its own words on top. */
function memberRole(member, defs) {
  const def = member?.role?.preset ? (defs || []).find((d) => d.id === member.role.preset) || null : null;
  return {
    name: member?.role?.name || def?.name?.en || '',
    description: member?.role?.description || def?.description?.en || '',
    brief: member?.role?.brief || def?.brief || '',
    writesCode: typeof member?.role?.writesCode === 'boolean' ? member.role.writesCode : def ? def.writesCode : true,
    skillPacks: def?.skillPacks || [],   // the preset's suggestion; what a desk gets is member.skillPacks on its project's
  };
}

/** Where a parallel desk works: its folder and branch (path joined by the caller's `join`, so tests run on any OS). */
const deskWorktree = (userData, projectId, staffId, join = path.join) => ({
  root: join(userData, 'work', projectId, staffId),
  branch: `agent-office/${staffId}`,
});

/**
 * Must HQ's task for this desk wait (the lock)? A project that does not allow parallel work has one desk (or its main
 * tab) at work at a time: the desk waits while another of the project's tabs is busy. busyOf(ptyId) → boolean.
 * @param {{ parallel?: boolean, tabs?: any[] } } project @param {string} deskPty @param {string[]} ptyIds the project's ptys
 */
function deskWaits(project, deskPty, ptyIds, busyOf) {
  if (project?.parallel === true) return false;
  return ptyIds.some((id) => id !== deskPty && busyOf(id));
}

/** The role file a desk's session reads (AGENT_OFFICE_ROLE, plugin hooks/staff.ts). Never a token or a path outside. */
function deskRoleFile(member, defs, project, staff) {
  const r = memberRole(member, defs);
  const team = (Array.isArray(staff) ? staff : []).filter((m) => m.id !== member.id).slice(0, 20)
    .map((m) => ({ name: m.name, role: memberRole(m, defs).name }));
  return {
    format: 2, member: member.name, name: r.name, description: r.description, brief: r.brief, writesCode: r.writesCode,
    ...(member.department ? { department: member.department } : {}),
    project: { name: project.name, dir: project.dir }, team,
  };
}

/**
 * HQ's view of the team (office_machines, team mode only): each member's role, department, the projects it may work
 * on (names) and its desks with their state. deskState(projectId, staffId) → 'busy' | 'idle' | 'none'.
 */
function machineStaff(staff, defs, projects, deskState) {
  return (Array.isArray(staff) ? staff : []).map((m) => {
    const r = memberRole(m, defs);
    const allowed = m.projects === 'all' ? projects : projects.filter((p) => m.projects.includes(p.id));
    const desks = allowed.map((p) => ({ project: p.name, state: deskState(p.id, m.id) })).filter((d) => d.state !== 'none');
    return {
      name: m.name, role: r.name, ...(r.description ? { description: r.description } : {}), ...(m.department ? { department: m.department } : {}),
      writesCode: r.writesCode, projects: m.projects === 'all' ? 'all' : allowed.map((p) => p.name), desks,
      busy: desks.some((d) => d.state === 'busy'),
    };
  });
}

/** A member by id or by name (case and Turkish dotted/dotless i ignored), or null. */
function findMember(staff, key) {
  const k = String(key || '').trim().toLocaleLowerCase('tr');
  if (!k) return null;
  return (Array.isArray(staff) ? staff : []).find((m) => m.id === key || m.name.toLocaleLowerCase('tr') === k) || null;
}

module.exports = {
  STAFF_MAX, DEPARTMENTS, packMap, normalizeCustomRole, normalizeCustomRoles, customRoleFile, saveCustomRole, removeCustomRole, normalizeRoleDef, loadRoles, roleValue, normalizeMember, normalizeStaff, newStaffId, saveMember, removeMember,
  dropProject, dropAccount, mayWork, memberRole, deskWorktree, deskWaits, deskRoleFile, machineStaff, findMember,
};
