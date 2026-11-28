// Studio experience (contract v3.142): the pure parts of dragging projects in the sidebar and managing project groups.
// The data is the Office's own: state.projects keeps the list's order, Project.group the group (src/project-groups.mjs).
// renderer/studio.js draws and calls `projects:move` / `projects:renameGroup` with what these return.
import { cleanGroup, GROUP_MAX } from './project-groups.mjs';

const key = (/** @type {unknown} */ g) => cleanGroup(g).toLocaleLowerCase('tr');

/**
 * The sidebar's sections: the ungrouped projects first (name ''), then each group by name (case and Turkish letters
 * ignored), the projects keeping the order they were given in. Same layout as the Office list (`groupProjects`).
 * @template {{ group?: string }} T
 * @param {T[]} items
 * @returns {{ name: string, items: T[] }[]}
 */
export function studioSections(items) {
  const free = [];
  const by = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const g = cleanGroup(it.group);
    if (!g) { free.push(it); continue; }
    if (!by.has(key(g))) by.set(key(g), { name: g, items: [] });
    by.get(key(g)).items.push(it);
  }
  const named = [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }));
  return [...(free.length ? [{ name: '', items: free }] : []), ...named];
}

/**
 * Where a drop puts the project.
 * @param {{ id: string, group?: string, hq?: boolean }[]} projects state.projects in their stored order
 * @param {string} id the dragged project
 * @param {{ beforeId?: string, afterId?: string, group?: string }} to a drop on a row (before / after that project, taking
 *   its group) or on a group heading (`group`: '' = the ungrouped part; the project goes to the end of that group)
 * @returns {{ order: string[], group: string } | null} the full id order and the project's group; null for nothing to do
 */
export function planMove(projects, id, to) {
  const list = Array.isArray(projects) ? projects.filter((p) => p && typeof p.id === 'string') : [];
  const me = list.find((p) => p.id === id);
  if (!me || !to) return null;
  const rest = list.filter((p) => p.id !== id);
  const ids = rest.map((p) => p.id);
  let at;
  let group;
  const ref = to.beforeId ?? to.afterId;
  if (typeof ref === 'string') {
    const i = ids.indexOf(ref);
    if (i < 0 || ref === id) return null;
    group = cleanGroup(rest[i].group);
    at = to.beforeId !== undefined ? i : i + 1;
  } else if (typeof to.group === 'string') {
    group = cleanGroup(to.group);
    let last = -1;
    rest.forEach((p, i) => { if (key(p.group) === key(group)) last = i; });
    at = last + 1 || ids.length;   // an empty group: the end of the list
  } else return null;
  const order = [...ids.slice(0, at), id, ...ids.slice(at)];
  const same = order.every((x, i) => x === list[i].id) && key(me.group) === key(group);
  return same ? null : { order, group };
}

/**
 * The drop position over a row: the upper half is "before", the lower half "after".
 * @param {number} y pointer y @param {number} top row top @param {number} height row height
 */
export const dropSide = (y, top, height) => (height > 0 && y - top < height / 2 ? 'before' : 'after');

/** A group name as the inline editors keep it ('' = refused / nothing). */
export const groupNameOf = (/** @type {unknown} */ raw) => cleanGroup(raw);
export { GROUP_MAX };
