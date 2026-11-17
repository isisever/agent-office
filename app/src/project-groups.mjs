// Project groups (contract v3.86): the PROJECTS list shown under group headings. Pure, shared by the renderer
// (sidebar.js draws it, app.js numbers ⌘1-9 in the same order); tested in test/project-groups.test.mjs.
// A project's `group` is a name the person gives (state.json, ≤ 40 characters); no group = the top of the list, without
// a heading. Members' personal workspaces (`staffOwner`, v3.83 amendment) are never in the list: they open from the
// member's card.

export const GROUP_MAX = 40;

/** A group name as kept: one line, trimmed, ≤ GROUP_MAX characters; '' for none. */
export function cleanGroup(name) {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GROUP_MAX) : '';
}

/** The projects the list shows (no personal workspaces, no HQ), in their order. */
export const listed = (projects) => (Array.isArray(projects) ? projects : []).filter((p) => p && !p.staffOwner && !p.hq);

/**
 * The list in groups → [{ name, projects }]: the ungrouped ones first (name ''), then each group by name (case and
 * Turkish letters ignored), projects keeping their own order inside a group.
 */
export function groupProjects(projects) {
  const free = [];
  const by = new Map();
  for (const p of listed(projects)) {
    const g = cleanGroup(p.group);
    if (!g) { free.push(p); continue; }
    const k = g.toLocaleLowerCase('tr');
    if (!by.has(k)) by.set(k, { name: g, projects: [] });
    by.get(k).projects.push(p);
  }
  const named = [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }));
  return [...(free.length ? [{ name: '', projects: free }] : []), ...named];
}

/** The list's order as shown (⌘1-9 follow it). */
export const shownOrder = (projects) => groupProjects(projects).flatMap((g) => g.projects);

/** The group names in use, as shown. */
export const groupNames = (projects) => groupProjects(projects).map((g) => g.name).filter(Boolean);
