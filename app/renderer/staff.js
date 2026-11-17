// Team: staff (contract v3.81): the TEAM panel's rows and the member popup, drawn into the sidebar (sidebar.js passes
// its own h / openModal / closeModal). The team lives in Agent Office: nothing here touches a project folder. Main
// keeps and checks the list (staff:list / staff:save / staff:remove, src/staff.js).
import { roleOf, byDepartment } from '../src/staff-view.mjs';

const hueOf = (s) => { let x = 7; for (const c of String(s)) x = (Math.imul(x, 31) + c.charCodeAt(0)) >>> 0; return x % 360; };

/**
 * The TEAM list: department headers (none when no member has one), a card per member.
 * @param {{ h: Function, t: Function, lang: string, staff: any[], presets: any[], projects: any[], accounts: any[], labelOf: Function, onEdit: (m: any) => void,
 *   desks?: any[], onDesk?: (projectId: string, staffId: string) => void }} c  desks: main's desk states (v3.81)
 * @returns {HTMLElement[]}
 */
export function teamRows(c) {
  const { h, t } = c;
  if (!c.staff.length) return [h('li', { class: 'sb-staff-empty' }, t('staff.empty'))];
  const groups = byDepartment(c.staff);
  const named = groups.some((g) => g.head);
  return groups.flatMap((g) => [
    ...(named ? [h('li', { class: 'sb-role-head' }, g.head || t('staff.noDepartment'))] : []),
    ...g.members.map((m) => card(c, m)),
  ]);
}

function card(c, m) {
  const { h, t } = c;
  const role = roleOf(m, c.presets, c.lang);
  const projects = m.projects === 'all' ? t('staff.allProjects')
    : m.projects.map((id) => c.projects.find((p) => p.id === id)?.name).filter(Boolean).join(', ') || t('staff.noProjects');
  const acc = m.accountId ? c.accounts.find((a) => a.id === m.accountId) : null;
  // v3.81 desks: one chip per project the member may work on (● at work, ○ open, ◌ asleep, + no desk yet); a click opens it
  const allowed = m.projects === 'all' ? c.projects.filter((p) => !p.hq) : c.projects.filter((p) => m.projects.includes(p.id));
  const deskOf = (pid) => (c.desks || []).find((d) => d.staffId === m.id && d.projectId === pid);
  const mark = { busy: '●', idle: '○', asleep: '◌', off: '○' };
  const chips = allowed.slice(0, 12).map((p) => {
    const d = deskOf(p.id);
    return h('button', {
      class: `sb-desk ${d ? d.state : 'none'}`, title: t(`staff.desk.${d ? d.state : 'none'}`, { project: p.name }),
      onclick: (e) => { e.stopPropagation(); c.onDesk?.(p.id, m.id); },
    }, `${d ? mark[d.state] : '+'} ${p.name}`);
  });
  const atWork = (c.desks || []).filter((d) => d.staffId === m.id && d.state === 'busy')
    .map((d) => c.projects.find((p) => p.id === d.projectId)?.name).filter(Boolean);
  return h('li', {
    class: 'sb-proj sb-staff sb-member-card', 'data-staff': m.id, style: `--staff-h: ${hueOf(m.name)}`,
    title: [role.description, role.writesCode ? '' : t('staff.noCode')].filter(Boolean).join('\n'),
    onclick: () => c.onEdit(m),
  },
  h('span', { class: 'sb-dot sb-avatar' }, h('span', { class: 'sb-eyes' })),
  h('span', { class: 'sb-name' }, m.name),
  h('span', { class: 'sb-icons' }, h('button', { class: 'sb-x sb-gear', title: t('staff.edit'), onclick: (e) => { e.stopPropagation(); c.onEdit(m); } }, '⚙')),
  h('div', { class: `sb-staff-state${atWork.length ? ' working' : ''}` }, atWork.length ? t('staff.working', { role: role.name, projects: atWork.join(', ') }) : role.name),
  chips.length ? h('div', { class: 'sb-desks' }, ...chips) : h('div', { class: 'sb-staff-where', title: projects }, t('staff.where', { projects })),
  acc ? h('div', { class: 'sb-staff-where' }, c.labelOf(acc)) : null);
}

/**
 * The member popup: add (member null) or edit. Saving goes through main (names unique, projects and accounts checked).
 * The role's settings are always on show and editable: a preset fills them in (name, description, instructions,
 * writes code, its suggested skill packs) and the member keeps only what differs from the preset, so a preset's later
 * wording still reaches it; "own role" keeps what is in the fields. listPacks() → the skill packs ([{ id, name }]).
 * @param {{ h: Function, t: Function, lang: string, member: any, staff: any[], presets: any[], projects: any[], accounts: any[], labelOf: Function,
 *   openModal: Function, closeModal: Function, save: (form: any) => Promise<any>, remove: (id: string) => Promise<any>, listPacks?: () => Promise<any[]> }} c
 */
export function openMemberEditor(c) {
  const { h, t } = c;
  const m = c.member;
  const l = c.lang === 'tr' ? 'tr' : 'en';
  const own = Boolean(m && !m.role?.preset);
  const field = (label, input, hint) => h('label', { class: 'sb-field' }, h('span', { class: 'sb-field-label' }, label), input, hint ? h('span', { class: 'sb-field-hint' }, hint) : null);
  const name = h('input', { class: 'sb-input', value: m?.name || '', maxLength: 40, placeholder: t('staff.namePh') });
  const role = h('select', { class: 'sb-acct' },
    ...c.presets.map((d) => h('option', { value: d.id, selected: m?.role?.preset === d.id }, d.name[l])),
    h('option', { value: '', selected: own }, t('staff.ownRole')));
  if (!m) role.value = c.presets[0]?.id || '';
  const presetOf = () => c.presets.find((d) => d.id === role.value) || null;
  const roleName = h('input', { class: 'sb-input', maxLength: 40, placeholder: t('staff.roleNamePh') });
  const roleDesc = h('textarea', { rows: 3, maxLength: 400, placeholder: t('staff.descriptionPh') });
  const brief = h('textarea', { rows: 10, maxLength: 4000, placeholder: t('staff.briefPh'), class: 'sb-brief' });
  const noCode = h('input', { type: 'checkbox' });
  /** pack id → 'inherit' | 'on' | 'off'; the selects are drawn when the list arrives */
  const packPick = new Map();
  const packBox = h('div', { class: 'sb-staff-packs' });
  const drawPacks = (packs) => packBox.replaceChildren(...packs.map((pk) => {
    const suggested = (presetOf()?.skillPacks || []).includes(pk.id);
    const sel = h('select', { class: 'sb-acct sb-mode', onchange: (e) => packPick.set(pk.id, e.target.value) },
      ...[['inherit', t('staff.packProject')], ['on', t('sidebar.skillPackOn')], ['off', t('sidebar.skillPackOff')]]
        .map(([v, label]) => h('option', { value: v, selected: (packPick.get(pk.id) || 'inherit') === v }, label)));
    return h('div', { class: 'sb-botcolor sb-langrow' }, h('span', {}, suggested ? `${pk.name} (${t('staff.packSuggested')})` : pk.name), sel);
  }));
  let packList = [];
  /** The fields from a preset (its suggested packs on, the rest the project's). */
  const fill = (def) => {
    roleName.value = def.name[l];
    roleDesc.value = def.description[l];
    brief.value = def.brief;
    noCode.checked = !def.writesCode;
    packPick.clear();
    for (const id of def.skillPacks || []) packPick.set(id, 'on');
    drawPacks(packList);
  };
  const reset = h('button', { class: 'sb-btn sb-reset-role', title: t('staff.resetRoleTitle'), onclick: (e) => { e.preventDefault(); const d = presetOf(); if (d) fill(d); } }, t('staff.resetRole'));
  const def0 = presetOf();
  if (def0) fill(def0);
  if (m) {
    if (m.role?.name) roleName.value = m.role.name;
    if (m.role?.description) roleDesc.value = m.role.description;
    if (m.role?.brief) brief.value = m.role.brief;
    if (typeof m.role?.writesCode === 'boolean') noCode.checked = !m.role.writesCode;
    packPick.clear();
    for (const [id, on] of Object.entries(m.skillPacks || {})) packPick.set(id, on ? 'on' : 'off');
  }
  const showRole = () => { reset.hidden = !presetOf(); };
  role.addEventListener('change', () => { const d = presetOf(); if (d) fill(d); showRole(); });
  showRole();
  c.listPacks?.().then((packs) => { packList = Array.isArray(packs) ? packs : []; drawPacks(packList); }).catch(() => {});
  const roleBox = h('div', { class: 'sb-own-role' },
    field(t('staff.roleName'), roleName),
    field(t('staff.description'), roleDesc),
    field(t('staff.brief'), brief, t('staff.briefHint')),
    h('label', { class: 'sb-botcolor sb-langrow' }, h('span', {}, t('staff.noCode')), noCode),
    field(t('staff.skillPacks'), packBox, t('staff.skillPacksHint')),
    reset);
  /** The role to save: a preset with only what differs from it, or the fields as an own role. */
  const roleForm = () => {
    const d = presetOf();
    const same = (a, b) => String(a || '').replace(/\r\n?/g, '\n').trim() === String(b || '').replace(/\r\n?/g, '\n').trim();
    if (!d) return { name: roleName.value, description: roleDesc.value, brief: brief.value, ...(noCode.checked ? { writesCode: false } : {}) };
    return {
      preset: d.id,
      ...(same(roleName.value, d.name[l]) ? {} : { name: roleName.value }),
      ...(same(roleDesc.value, d.description[l]) ? {} : { description: roleDesc.value }),
      ...(same(brief.value, d.brief) ? {} : { brief: brief.value }),
      ...(!noCode.checked === d.writesCode ? {} : { writesCode: !noCode.checked }),
    };
  };
  const departments = [...new Set(c.staff.map((x) => x.department).filter(Boolean))];
  const dept = h('input', { class: 'sb-input', value: m?.department || '', maxLength: 30, placeholder: t('staff.departmentPh'), list: 'sb-departments' });
  const deptList = h('datalist', { id: 'sb-departments' }, ...departments.map((d) => h('option', { value: d })));
  const account = h('select', { class: 'sb-acct' }, h('option', { value: '' }, t('staff.projectAccount')),
    ...c.accounts.map((a) => h('option', { value: a.id, selected: m?.accountId === a.id }, c.labelOf(a))));
  const all = h('input', { type: 'checkbox', checked: m?.projects === 'all', onchange: () => { for (const b of boxes) b.disabled = all.checked; } });
  const picked = new Set(Array.isArray(m?.projects) ? m.projects : []);
  const boxes = c.projects.map((p) => h('input', { type: 'checkbox', value: p.id, checked: picked.has(p.id), disabled: m?.projects === 'all' }));
  const scope = h('div', { class: 'sb-scope' },
    h('label', { class: 'sb-scope-all' }, all, ' ', t('staff.allProjects')),
    h('div', { class: 'sb-scope-list' }, ...c.projects.map((p, i) => h('label', {}, boxes[i], ' ', p.name))));
  const err = h('div', { class: 'sb-note warn', hidden: true });
  const save = h('button', {
    class: 'sb-btn primary', onclick: async () => {
      const form = {
        ...(m ? { id: m.id } : {}), name: name.value, department: dept.value, accountId: account.value,
        role: roleForm(),
        skillPacks: Object.fromEntries([...packPick].filter(([, v]) => v !== 'inherit').map(([id, v]) => [id, v === 'on'])),
        projects: all.checked ? 'all' : boxes.filter((b) => b.checked).map((b) => b.value),
      };
      save.disabled = true;
      const r = await c.save(form);
      save.disabled = false;
      if (r?.ok) { c.closeModal(); return; }
      err.textContent = t(`staff.error.${['name', 'role', 'name-used', 'too-many'].includes(r?.error) ? r.error : 'failed'}`);
      err.hidden = false;
    },
  }, t('sidebar.save'));
  const remove = m ? h('button', {
    class: 'sb-btn sb-warn', onclick: async () => {
      if (!confirm(t('staff.removeConfirm', { name: m.name }))) return;
      const r = await c.remove(m.id);
      if (r?.ok) c.closeModal();
    },
  }, t('staff.remove')) : null;
  c.openModal(m ? t('staff.editTitle', { name: m.name }) : t('staff.addTitle'), [
    field(t('staff.name'), name),
    field(t('staff.role'), role), roleBox,
    field(t('staff.department'), dept, t('staff.departmentHint')), deptList,
    field(t('staff.account'), account, t('staff.accountHint')),
    field(t('staff.projects'), scope, t('staff.projectsHint')),
    h('div', { class: 'sb-field-hint' }, t('staff.applyNote')),
    err,
  ], [remove, h('button', { class: 'sb-btn', onclick: () => c.closeModal() }, t('sidebar.cancel')), save], 'sb-modal-form');
  requestAnimationFrame(() => name.focus());
}
