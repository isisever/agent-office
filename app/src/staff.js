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
const packIds = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, 12);

/**
 * A preset role file → { id, name, short?, description, brief, skillPacks, writesCode }, or null when it is not one.
 * @returns {{ id: string, name: { en: string, tr: string }, short?: { en: string, tr: string }, description: { en: string, tr: string }, brief: string, skillPacks: string[], writesCode: boolean } | null}
 */
function normalizeRoleDef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) return null;
  const name = bilingual(raw.name, NAME_MAX);
  if (!name) return null;
  const description = bilingual(raw.description, DESC_MAX) || { en: '', tr: '' };
  const short = bilingual(raw.short, 8);
  return { id, name, ...(short ? { short } : {}), description, brief: textBlock(raw.brief, BRIEF_MAX), skillPacks: packIds(raw.skillPacks), writesCode: raw.writesCode !== false };
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
 * A member's role: a preset id (its name, description and brief may be overridden) or an own role (a name, and a
 * brief or a description). → the cleaned role, or null.
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
    ...(raw.writesCode === false ? { writesCode: false } : {}),
  };
}

/**
 * One staff member, cleaned against what exists: projects and accounts that are gone are dropped (an unknown account
 * means "the project's account"). → the member, or null when it has no valid id, name or role.
 * @param {any} raw
 * @param {{ projectIds?: string[] | null, accountIds?: string[] | null, presetIds?: string[] | null }} [known]
 */
function normalizeMember(raw, { projectIds = null, accountIds = null, presetIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !STAFF_ID_RE.test(raw.id)) return null;
  const name = str(raw.name, NAME_MAX);
  const role = roleValue(raw.role, presetIds);
  if (!name || !role) return null;
  const department = str(raw.department, DEPT_MAX);
  const accountId = typeof raw.accountId === 'string' && raw.accountId && (!accountIds || accountIds.includes(raw.accountId)) ? raw.accountId : '';
  const projects = raw.projects === 'all' ? 'all'
    : [...new Set((Array.isArray(raw.projects) ? raw.projects : []).filter((id) => typeof id === 'string' && PROJECT_ID_RE.test(id) && (!projectIds || projectIds.includes(id))))];
  return {
    id: raw.id, name, role, ...(department ? { department } : {}), ...(accountId ? { accountId } : {}),
    ...(Array.isArray(raw.skillPacks) ? { skillPacks: packIds(raw.skillPacks) } : {}), projects,
  };
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

module.exports = {
  STAFF_MAX, normalizeRoleDef, loadRoles, roleValue, normalizeMember, normalizeStaff, newStaffId, saveMember, removeMember,
  dropProject, dropAccount, mayWork,
};
