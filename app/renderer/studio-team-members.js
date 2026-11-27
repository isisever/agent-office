// Studio's Team page, Members tab (contract v3.124): a card per member grouped by department, with initials, name,
// role, department, account, allowed projects, skill packs and the live state (idle, working, needs you) with the
// open desks. Open desk picks one of the member's projects (the Office's desk path); Edit opens the Office's own
// member popup as a side sheet (every field, its save and main's checks); Remove asks first, then staff:remove.

import { icon } from './studio-icons.js';
import { memberCards } from '../src/studio-team-page.mjs';

/** @param {import('./studio-team.js').TeamView} v */
export function drawMembers(v) {
  const { el, t, td, lang, hooks, dept, state } = v;
  /** @type {{ picking: string, error: Record<string, string> }} */
  const s = state.members || (state.members = { picking: '', error: {} });
  const staff = Array.isArray(td.staff) ? td.staff : [];
  const stateText = (/** @type {string} */ x) => (x === 'needs' ? t('studio.teamPage.stateNeeds') : x === 'working' ? t('studio.teamPage.stateWorking') : x === 'asleep' ? t('studio.teamPage.stateAsleep') : t('studio.teamPage.stateIdle'));
  const head = el('div', { class: 'st-team-toolbar' },
    el('span', { class: 'st-team-count' }, t('studio.teamPage.count', { n: staff.length })),
    el('span', { class: 'st-start-gap' }),
    el('button', { class: 'st-set-btn primary', type: 'button', onclick: () => v.go('roles') }, t('studio.teamPage.addMember')));
  if (!staff.length) {
    return [el('div', { class: 'st-team-empty' },
      el('span', { class: 'st-team-empty-icon', 'aria-hidden': 'true' }, icon('team', 28)),
      el('h2', {}, t('studio.teamPage.noMembersTitle')),
      el('p', {}, t('studio.teamPage.noMembersText')),
      el('button', { class: 'st-set-btn primary', type: 'button', onclick: () => v.go('roles') }, t('studio.teamPage.browseRoles')))];
  }
  const groups = memberCards({ staff, presets: td.presets, desks: td.desks, projects: td.projects, waiting: hooks.waiting(), lang, accounts: hooks.accounts() });
  const line = (/** @type {string} */ ic, /** @type {string} */ label, /** @type {string} */ text) => (text ? el('div', { class: 'st-team-line', title: `${label}: ${text}` }, icon(ic, 12), el('span', {}, text)) : null);

  function card(/** @type {ReturnType<typeof memberCards>[number]['members'][number]} */ m) {
    const projects = m.allProjects ? t('staff.allProjects') : m.projects.map((p) => p.name).join(', ') || t('studio.teamPage.noProjects');
    const picking = s.picking === m.id;
    const err = s.error[m.id] || '';
    const deskBtn = el('button', { class: 'st-set-btn', type: 'button', 'aria-expanded': String(picking), disabled: !m.projects.length || undefined, onclick: () => {
      if (m.projects.length === 1) { hooks.openDesk(m.projects[0].id, m.id); return; }
      s.picking = picking ? '' : m.id;
      v.redraw();
    } }, t('studio.teamPage.openDesk'));
    const remove = el('button', { class: 'st-set-btn warn', type: 'button', onclick: async () => {
      if (!confirm(t('staff.removeConfirm', { name: m.name }))) return;
      const r = await hooks.remove(m.id);
      if (r?.ok) delete s.error[m.id]; else s.error[m.id] = r?.error === 'unknown' ? t('studio.teamPage.removeGone') : v.errorText(r?.error);
      v.redraw();
    } }, t('studio.teamPage.remove'));
    return el('div', { class: 'st-team-card st-team-member', 'data-id': m.id },
      el('div', { class: 'st-team-card-top' },
        el('span', { class: 'st-avatar st-team-avatar', 'aria-hidden': 'true' }, m.initials),
        el('span', { class: 'st-team-card-name' }, m.name, el('span', { class: 'st-team-card-sub' }, m.role)),
        el('span', { class: `st-team-state ${m.state}`, title: stateText(m.state) }, el('span', { class: `st-member-state ${m.state}` }), stateText(m.state))),
      line('team', t('staff.department'), m.department ? dept(m.department) : ''),
      line('user', t('staff.account'), m.account || t('staff.projectAccount')),
      line('folder', t('staff.projects'), projects),
      m.skillPacks.length ? el('div', { class: 'st-team-chips' }, ...m.skillPacks.map((p) => el('span', { class: 'st-team-chip' }, p))) : null,
      m.desks.length ? el('div', { class: 'st-team-desks' }, ...m.desks.map((d) => el('button', { class: 'st-team-desk', type: 'button', title: stateText(d.state), onclick: () => hooks.openDesk(d.projectId, m.id) },
        el('span', { class: `st-member-state ${d.state}` }), el('span', {}, d.name)))) : null,
      picking ? el('div', { class: 'st-team-pick', role: 'menu' }, el('span', { class: 'st-team-label' }, t('studio.teamPage.pickProject')),
        ...m.projects.map((p) => el('button', { class: 'st-team-desk', type: 'button', role: 'menuitem', onclick: () => { s.picking = ''; hooks.openDesk(p.id, m.id); } }, icon('folder', 12), el('span', {}, p.name)))) : null,
      err ? el('div', { class: 'st-team-error', role: 'alert' }, err) : null,
      el('div', { class: 'st-team-actions' }, remove, el('button', { class: 'st-set-btn', type: 'button', onclick: () => hooks.editMember(m.member) }, t('studio.teamPage.edit')), deskBtn));
  }
  return [head, ...groups.flatMap((g) => [
    el('h2', { class: 'st-team-group' }, g.head ? dept(g.head) : t('staff.noDepartment'), el('span', { class: 'st-team-group-n' }, String(g.members.length))),
    el('div', { class: 'st-team-grid' }, ...g.members.map(card)),
  ])];
}
