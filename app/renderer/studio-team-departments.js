// Studio's Team page, Departments tab (contract v3.124): each department with its member count. Rename gives every
// member of the department the new label, one staff:save per member (main checks each as any edit); a member that
// could not be saved is named with main's reason.

import { departmentCounts, renameForms, renameBoxValue } from '../src/studio-team-page.mjs';

/** @param {import('./studio-team.js').TeamView} v */
export function drawDepartments(v) {
  const { el, t, td, hooks, dept, state } = v;
  /** @type {{ editing: string, error: string, busy: boolean, draft: string | null }} */
  const s = state.departments || (state.departments = { editing: '', error: '', busy: false, draft: null });
  const staff = Array.isArray(td.staff) ? td.staff : [];
  const list = departmentCounts(staff);
  if (!list.length) return [el('div', { class: 'st-none' }, t('studio.teamPage.noDepartments'))];

  async function rename(/** @type {string} */ from, /** @type {string} */ to) {
    // a function's id shown as its label: the label unchanged is no rename
    // the list as it is now (an edit saved since the box was drawn is never overwritten)
    const fresh = hooks.teamData()?.staff;
    const r = String(to || '').trim() === dept(from) ? { forms: [] } : renameForms(Array.isArray(fresh) ? fresh : staff, from, to);
    if ('error' in r) { s.error = t('studio.teamPage.renameEmpty'); v.redraw(); return; }
    s.busy = true;
    /** @type {string[]} */
    const failed = [];
    for (const form of r.forms) {
      const res = await hooks.save(form);
      if (!res?.ok) failed.push(`${form.name}: ${v.errorText(res?.error)}`);
    }
    s.busy = false;
    s.editing = failed.length ? from : '';
    if (!failed.length) s.draft = null;   // a failed rename keeps the person's text
    s.error = failed.length ? `${t('studio.teamPage.renameFailed')} ${failed.join(' · ')}` : '';
    v.redraw();
  }

  function row(/** @type {{ name: string, count: number }} */ d) {
    const count = el('span', { class: 'st-team-group-n' }, t('studio.teamPage.memberCount', { n: d.count }));
    if (d.name && s.editing === d.name) {
      const input = /** @type {HTMLInputElement} */ (el('input', { class: 'st-team-input', maxlength: '30', 'aria-label': t('studio.teamPage.rename') }));
      const hadDraft = typeof s.draft === 'string';
      input.value = renameBoxValue(s.draft, dept(d.name));
      input.addEventListener('input', () => { s.draft = input.value; });
      const save = /** @type {HTMLButtonElement} */ (el('button', { class: 'st-set-btn primary', type: 'submit', disabled: s.busy || undefined }, t('sidebar.save')));
      const form = el('form', { class: 'st-team-dept-row editing', onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); save.disabled = true; rename(d.name, input.value); } },
        input, count,
        el('button', { class: 'st-set-btn', type: 'button', onclick: () => { s.editing = ''; s.error = ''; s.draft = null; v.redraw(); } }, t('sidebar.cancel')), save);
      // the first open selects the old name; a draft keeps the caret at its end
      requestAnimationFrame(() => { if (input.isConnected && document.activeElement !== input) { input.focus(); if (hadDraft) input.setSelectionRange(input.value.length, input.value.length); else input.select(); } });
      return form;
    }
    return el('div', { class: 'st-team-dept-row' },
      el('span', { class: 'st-team-dept-name' }, d.name ? dept(d.name) : t('staff.noDepartment')), count,
      d.name ? el('button', { class: 'st-set-btn', type: 'button', disabled: s.busy || undefined, onclick: () => { s.editing = d.name; s.error = ''; s.draft = null; v.redraw(); } }, t('studio.teamPage.rename')) : el('span', {}));
  }
  return [
    el('p', { class: 'st-team-hint' }, t('studio.teamPage.departmentsHint')),
    el('div', { class: 'st-team-depts' }, ...list.map(row)),
    s.error ? el('div', { class: 'st-team-error', role: 'alert' }, s.error) : null,
  ];
}
