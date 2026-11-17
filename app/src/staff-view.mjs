// Team: staff (contract v3.83), the parts the renderer shares (the TEAM panel, the member popup); pure, tested in
// test/staff.test.cjs through a dynamic import. src/staff.js keeps the state logic (main side).

/** The member's role definition: the preset (if any) with the member's own name, description, brief on top. */
export function roleOf(member, defs, lang = 'en') {
  const def = member?.role?.preset ? (defs || []).find((d) => d.id === member.role.preset) || null : null;
  const l = lang === 'tr' ? 'tr' : 'en';
  return {
    name: member?.role?.name || def?.name?.[l] || '',
    description: member?.role?.description || def?.description?.[l] || '',
    brief: member?.role?.brief || def?.brief || '',
    writesCode: typeof member?.role?.writesCode === 'boolean' ? member.role.writesCode : def ? def.writesCode : true,
    skillPacks: def?.skillPacks || [],
    short: [...String(def?.short?.[l] || (member?.role?.name || def?.name?.[l] || '').split(/[\s(/-]+/).filter(Boolean)[0] || '').toLocaleUpperCase(l)].slice(0, 7).join(''),
  };
}

/** The TEAM panel's groups: departments in the order first met, members without one last (head ''). */
export function byDepartment(staff) {
  const groups = new Map();
  for (const m of Array.isArray(staff) ? staff : []) {
    const k = m.department || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const named = [...groups.entries()].filter(([k]) => k).map(([head, members]) => ({ head, members }));
  return groups.has('') ? [...named, { head: '', members: groups.get('') }] : named;
}


// v3.84 the company's functions (the same list as src/staff.js DEPARTMENTS): a preset's department id, shown as the
// localized label (staff.dept.<id>); any other value is a label the person wrote and is shown as it is.
export const DEPARTMENTS = ['management', 'marketing', 'sales', 'operations', 'hr', 'finance', 'rnd'];
export const deptLabel = (t, d) => (DEPARTMENTS.includes(d) ? t(`staff.dept.${d}`) : d || '');

/** The role picker's groups: the functions in DEPARTMENTS order, then other labels, then roles without one (dept ''). */
export function groupRoles(presets) {
  const groups = new Map(DEPARTMENTS.map((d) => [d, []]));
  for (const r of Array.isArray(presets) ? presets : []) {
    const k = r.department || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rest = groups.get('') || [];
  groups.delete('');
  const out = [...groups.entries()].filter(([, roles]) => roles.length).map(([dept, roles]) => ({ dept, roles }));
  return rest.length ? [...out, { dept: '', roles: rest }] : out;
}
