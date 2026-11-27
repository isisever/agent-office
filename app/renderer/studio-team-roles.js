// Studio's Team page, Roles tab (contract v3.124): every ready-made role (and the person's own library roles) as a
// card, with a search and a "writes code" filter. A card opens its detail sheet (the full description and the brief,
// read only and folded); Hire fills a new member from the role and saves it through staff:save, where main checks it
// (≤ 50 members, a unique name). "Custom role" opens the Office's role wizard.

import { icon } from './studio-icons.js';
import { filterRoles, roleCard, prefillMember, hireForm, CODE_FILTERS } from '../src/studio-team-page.mjs';
import { DEPARTMENTS } from '../src/staff-view.mjs';

/** @param {import('./studio-team.js').TeamView} v */
export function drawRoles(v) {
  const { el, t, td, lang, hooks, dept, state, sheet } = v;
  /** @type {{ query: string, code: string }} */
  const s = state.roles || (state.roles = { query: '', code: 'all' });
  const presets = Array.isArray(td.presets) ? td.presets : [];

  const search = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'st-team-search', placeholder: t('studio.teamPage.rolesSearch'), 'aria-label': t('studio.teamPage.rolesSearch') }));
  search.value = s.query;
  search.addEventListener('input', () => { s.query = search.value; drawGrid(); });
  const filterLabel = { all: t('studio.teamPage.filterAll'), code: t('studio.teamPage.filterCode'), noCode: t('studio.teamPage.filterNoCode') };
  const seg = el('div', { class: 'st-team-seg', role: 'radiogroup', 'aria-label': t('studio.teamPage.filterCode') },
    ...CODE_FILTERS.map((id) => el('button', { class: 'st-team-seg-opt', type: 'button', role: 'radio', 'aria-checked': String(s.code === id), onclick: () => { s.code = id; v.redraw(); } },
      /** @type {Record<string, string>} */ (filterLabel)[id])));
  const grid = el('div', { class: 'st-team-grid' });
  const codeChip = (/** @type {boolean} */ code) => el('span', { class: `st-team-chip${code ? ' code' : ''}` }, code ? t('studio.teamPage.writesCode') : t('studio.teamPage.noCode'));
  const packChips = (/** @type {string[]} */ packs) => packs.map((p) => el('span', { class: 'st-team-chip' }, p));

  const custom = el('button', { class: 'st-team-card st-team-custom', type: 'button', onclick: () => hooks.openWizard() },
    el('span', { class: 'st-team-card-top' }, el('span', { class: 'st-avatar st-team-avatar' }, icon('plus', 16)),
      el('span', { class: 'st-team-card-name' }, t('studio.teamPage.customRole'))),
    el('span', { class: 'st-team-card-text' }, t('studio.teamPage.customRoleText')));

  function card(/** @type {ReturnType<typeof roleCard>} */ r) {
    return el('button', { class: 'st-team-card', type: 'button', title: r.name, onclick: () => detail(r.id) },
      el('span', { class: 'st-team-card-top' },
        el('span', { class: 'st-avatar st-team-avatar', 'aria-hidden': 'true' }, r.initial),
        el('span', { class: 'st-team-card-name' }, r.name, r.department ? el('span', { class: 'st-team-card-sub' }, dept(r.department)) : null)),
      el('span', { class: 'st-team-card-text' }, r.description),
      el('span', { class: 'st-team-chips' }, codeChip(r.writesCode), ...packChips(r.skillPacks)));
  }
  function drawGrid() {
    const list = filterRoles(presets, { query: s.query, code: s.code, lang, deptName: dept });
    grid.replaceChildren(...list.map(card), custom);
    if (!list.length) grid.prepend(el('div', { class: 'st-none st-team-none' }, t('studio.teamPage.noRoles')));
  }
  drawGrid();

  /** The role's detail sheet: the full description, its kind and packs, the brief read only and folded, and Hire. */
  function detail(/** @type {string} */ id) {
    const def = presets.find((d) => d.id === id);
    if (!def) return;
    const r = roleCard(def, lang);
    sheet.open(r.name, [
      el('div', { class: 'st-team-chips' }, r.department ? el('span', { class: 'st-team-chip' }, dept(r.department)) : null, codeChip(r.writesCode)),
      el('p', { class: 'st-team-desc' }, r.description),
      r.skillPacks.length ? el('div', { class: 'st-team-field' }, el('span', { class: 'st-team-label' }, t('studio.teamPage.packs')), el('span', { class: 'st-team-chips' }, ...packChips(r.skillPacks))) : null,
      r.tools.length ? el('div', { class: 'st-team-field' }, el('span', { class: 'st-team-label' }, t('studio.teamPage.tools')), el('span', { class: 'st-team-chips' }, ...packChips(r.tools))) : null,
      r.brief ? el('details', { class: 'st-team-brief' }, el('summary', {}, t('studio.teamPage.brief')), el('pre', {}, r.brief)) : null,
      el('div', { class: 'st-team-actions' }, el('button', { class: 'st-set-btn primary', type: 'button', onclick: () => hire(def) }, t('studio.teamPage.hire'))),
    ]);
  }

  /** Hire: the shared hire sheet (openHire); Cancel goes back to the role's detail. */
  const hire = (/** @type {any} */ def) => openHire(v, def, () => detail(def.id));

  return [el('div', { class: 'st-team-toolbar' }, el('label', { class: 'st-set-searchbox st-team-searchbox' }, icon('search', 14), search), seg), grid];
}

/**
 * Hire: a new member prefilled from the role; the person fills name, department, account and projects. Also opened by
 * the role wizard in Studio once it saved a role (v3.124, studio-team.js hire). Cancel runs onCancel, else closes.
 * @param {import('./studio-team.js').TeamView} v @param {any} def a RoleDef @param {(() => void) | null} [onCancel]
 */
export async function openHire(v, def, onCancel = null) {
  const { el, t, td, lang, hooks, dept, sheet } = v;
  const servers = await hooks.tools().catch(() => []);
  const prefill = prefillMember(def, { deptName: dept, servers });
  const r = roleCard(def, lang);
  const field = (/** @type {string} */ label, /** @type {Node} */ input) => el('label', { class: 'st-team-field' }, el('span', { class: 'st-team-label' }, label), input);
  const name = /** @type {HTMLInputElement} */ (el('input', { class: 'st-team-input', maxlength: '40', placeholder: t('staff.namePh') }));
  const department = /** @type {HTMLInputElement} */ (el('input', { class: 'st-team-input', maxlength: '30', list: 'st-team-depts' }));
  department.value = prefill.department;
  const labels = [...new Set([...DEPARTMENTS.map((d) => dept(d)), ...(td.staff || []).map((/** @type {any} */ m) => m.department).filter(Boolean)])];
  const account = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-team-input' }, el('option', { value: '' }, t('staff.projectAccount')),
    ...hooks.accounts().map((a) => el('option', { value: a.id }, a.label))));
  const projects = (td.projects || []).filter((/** @type {any} */ p) => !p.hq && !p.staffOwner);
  const all = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', onchange: () => { for (const b of boxes) b.disabled = all.checked; } }));
  const boxes = projects.map((/** @type {any} */ p) => /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', value: p.id })));
  const err = el('div', { class: 'st-team-error', role: 'alert', hidden: true });
  const save = /** @type {HTMLButtonElement} */ (el('button', { class: 'st-set-btn primary', type: 'submit' }, t('studio.teamPage.hireSave')));
  const form = el('form', { class: 'st-team-form', onsubmit: async (/** @type {Event} */ e) => {
    e.preventDefault();
    save.disabled = true;
    err.hidden = true;
    const res = await hooks.save(hireForm(prefill, { name: name.value, department: department.value, accountId: account.value, all: all.checked, projects: boxes.filter((b) => b.checked).map((b) => b.value) }));
    save.disabled = false;
    if (res?.ok) { sheet.close(); v.go('members'); return; }
    err.textContent = v.errorText(res?.error);   // main's own check (name, a used name, the 50-member limit)
    err.hidden = false;
  } },
  el('p', { class: 'st-team-desc' }, t('studio.teamPage.hireText', { role: r.name })),
  field(t('staff.name'), name),
  field(t('staff.department'), department),
  el('datalist', { id: 'st-team-depts' }, ...labels.map((d) => el('option', { value: d }))),
  field(t('staff.account'), account),
  el('div', { class: 'st-team-field' }, el('span', { class: 'st-team-label' }, t('staff.projects')),
    el('label', { class: 'st-team-check' }, all, el('span', {}, t('staff.allProjects'))),
    ...projects.map((/** @type {any} */ p, /** @type {number} */ i) => el('label', { class: 'st-team-check' }, boxes[i], el('span', {}, p.name)))),
  el('p', { class: 'st-team-hint' }, t('studio.teamPage.hireHint')),
  err,
  el('div', { class: 'st-team-actions' }, el('button', { class: 'st-set-btn', type: 'button', onclick: () => (onCancel ? onCancel() : sheet.close()) }, t('sidebar.cancel')), save));
  sheet.open(t('studio.teamPage.hireTitle', { role: r.name }), [form]);
  name.focus();
}
