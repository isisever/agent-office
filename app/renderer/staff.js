// Team: staff (contract v3.81): the TEAM panel's rows and the member popup, drawn into the sidebar (sidebar.js passes
// its own h / openModal / closeModal). The team lives in Agent Office: nothing here touches a project folder. Main
// keeps and checks the list (staff:list / staff:save / staff:remove, src/staff.js).
import { roleOf, byDepartment } from '../src/staff-view.mjs';

const hueOf = (s) => { let x = 7; for (const c of String(s)) x = (Math.imul(x, 31) + c.charCodeAt(0)) >>> 0; return x % 360; };

/**
 * The TEAM list: department headers (none when no member has one), a card per member.
 * @param {{ h: Function, t: Function, lang: string, staff: any[], presets: any[], projects: any[], accounts: any[], labelOf: Function, onEdit: (m: any) => void }} c
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
  return h('li', {
    class: 'sb-proj sb-staff sb-member-card', 'data-staff': m.id, style: `--staff-h: ${hueOf(m.name)}`,
    title: [role.description, role.writesCode ? '' : t('staff.noCode')].filter(Boolean).join('\n'),
    onclick: () => c.onEdit(m),
  },
  h('span', { class: 'sb-dot sb-avatar' }, h('span', { class: 'sb-eyes' })),
  h('span', { class: 'sb-name' }, m.name),
  h('span', { class: 'sb-icons' }, h('button', { class: 'sb-x sb-gear', title: t('staff.edit'), onclick: (e) => { e.stopPropagation(); c.onEdit(m); } }, '⚙')),
  h('div', { class: 'sb-staff-state' }, role.name),
  h('div', { class: 'sb-staff-where', title: projects }, t('staff.where', { projects }) + (acc ? ` · ${c.labelOf(acc)}` : '')));
}

/**
 * The member popup: add (member null) or edit. Saving goes through main (names unique, projects and accounts checked).
 * @param {{ h: Function, t: Function, lang: string, member: any, staff: any[], presets: any[], projects: any[], accounts: any[], labelOf: Function,
 *   openModal: Function, closeModal: Function, save: (form: any) => Promise<any>, remove: (id: string) => Promise<any> }} c
 */
export function openMemberEditor(c) {
  const { h, t } = c;
  const m = c.member;
  const own = Boolean(m && !m.role?.preset);
  const field = (label, input, hint) => h('label', { class: 'sb-field' }, h('span', { class: 'sb-field-label' }, label), input, hint ? h('span', { class: 'sb-field-hint' }, hint) : null);
  const name = h('input', { class: 'sb-input', value: m?.name || '', maxLength: 40, placeholder: t('staff.namePh') });
  const role = h('select', { class: 'sb-acct' },
    ...c.presets.map((d) => h('option', { value: d.id, selected: m?.role?.preset === d.id }, d.name[c.lang === 'tr' ? 'tr' : 'en'])),
    h('option', { value: '', selected: own }, t('staff.ownRole')));
  if (!m) role.value = c.presets[0]?.id || '';
  const desc = h('div', { class: 'sb-note' });
  const ownName = h('input', { class: 'sb-input', value: m?.role?.name || '', maxLength: 40, placeholder: t('staff.roleNamePh') });
  const ownBrief = h('textarea', { rows: 5, placeholder: t('staff.briefPh') });
  ownBrief.value = m?.role?.brief || '';
  const noCode = h('input', { type: 'checkbox', checked: m?.role?.writesCode === false });
  const ownBox = h('div', { class: 'sb-own-role' },
    field(t('staff.roleName'), ownName), field(t('staff.brief'), ownBrief, t('staff.briefHint')),
    h('label', { class: 'sb-botcolor sb-langrow' }, h('span', {}, t('staff.noCode')), noCode));
  const showRole = () => {
    const def = c.presets.find((d) => d.id === role.value);
    desc.textContent = def ? def.description[c.lang === 'tr' ? 'tr' : 'en'] : '';
    desc.hidden = !def;
    ownBox.hidden = Boolean(def);
  };
  role.addEventListener('change', showRole);
  showRole();
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
        role: role.value ? { preset: role.value } : { name: ownName.value, brief: ownBrief.value, ...(noCode.checked ? { writesCode: false } : {}) },
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
    field(t('staff.role'), role), desc, ownBox,
    field(t('staff.department'), dept, t('staff.departmentHint')), deptList,
    field(t('staff.account'), account, t('staff.accountHint')),
    field(t('staff.projects'), scope, t('staff.projectsHint')),
    err,
  ], [remove, h('button', { class: 'sb-btn', onclick: () => c.closeModal() }, t('sidebar.cancel')), save], 'sb-modal-form');
  requestAnimationFrame(() => name.focus());
}
