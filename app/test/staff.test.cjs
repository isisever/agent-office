// Team: staff (contract v3.83): src/staff.js (state) and src/staff-view.mjs (the TEAM panel's helpers).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ST = require('../src/staff.js');

const ROLES = path.join(__dirname, '..', '..', 'roles');
const known = { projectIds: ['p1', 'p2', 'p3'], accountIds: ['default', 'work'], presetIds: ['erp-odoo', 'qa', 'devops'] };
const ayse = { id: 's-a1b2c3', name: 'Ayşe', role: { preset: 'erp-odoo' }, department: 'Geliştirme', accountId: 'work', projects: ['p1', 'p2'] };

test('loadRoles: the shipped presets, each with a name, a brief, a short name and one of the seven functions', () => {
  const defs = ST.loadRoles(ROLES);
  assert.deepEqual(defs.map((d) => d.id), ['accountant', 'assistant', 'chatbot', 'content-writer', 'customer-support', 'data-analyst', 'devops',
    'digital-marketer', 'erp-odoo', 'financial-analyst', 'hr-specialist', 'operations-specialist', 'product', 'project-manager', 'qa', 'rpa',
    'sales-rep', 'social-media-designer', 'software-developer']);
  for (const d of defs) {
    assert.ok(d.name.tr && d.name.en && d.brief.length > 200 && d.short?.tr, d.id);
    assert.ok(ST.DEPARTMENTS.includes(d.department), `${d.id}: ${d.department}`);
    assert.ok([...d.short.tr].length <= 7 && [...d.short.en].length <= 7, `${d.id}: the desk plate shows 7 letters`);
  }
  for (const dept of ST.DEPARTMENTS) assert.ok(defs.some((d) => d.department === dept), `${dept} has a role`);
  const designer = defs.find((d) => d.id === 'social-media-designer');
  assert.deepEqual([designer.department, designer.tools, designer.writesCode], ['marketing', ['canva'], false]);
  assert.match(designer.brief, /Canva/);
  assert.equal(defs.find((d) => d.id === 'assistant').writesCode, false);
  assert.match(defs.find((d) => d.id === 'qa').brief, /never change product code/);
  assert.match(defs.find((d) => d.id === 'devops').brief, /Never deploy to production/);
  assert.deepEqual(ST.loadRoles('/no/such/folder'), []);
});

test('normalizeMember: a preset or an own role; gone projects and accounts dropped; bad ones refused', () => {
  assert.deepEqual(ST.normalizeMember(ayse, known), ayse);
  const m = ST.normalizeMember({ ...ayse, accountId: 'gone', projects: ['p1', 'zz', 'p1'], department: '  ', skillPacks: ['superpowers', 'BAD id'] }, known);
  assert.deepEqual([m.accountId, m.projects, m.department, m.skillPacks], [undefined, ['p1'], undefined, { superpowers: true }], 'an old list means on');
  assert.equal(ST.normalizeMember({ ...ayse, projects: 'all' }, known).projects, 'all');
  const own = ST.normalizeMember({ id: 's-ffffff', name: 'Selin', role: { name: 'İçerik yazarı', brief: 'Writes blog posts.\nNo code.', writesCode: false }, projects: [] }, known);
  assert.deepEqual(own.role, { name: 'İçerik yazarı', brief: 'Writes blog posts.\nNo code.', writesCode: false });
  assert.equal(ST.normalizeMember({ ...ayse, role: { preset: 'unknown-role' } }, known), null, 'an unknown preset and no own name');
  assert.equal(ST.normalizeMember({ ...ayse, name: '' }, known), null);
  assert.equal(ST.normalizeMember({ ...ayse, id: 'x' }, known), null);
});

test('saveMember: adds with a new id, edits by id; unique names; at most 50', () => {
  let n = 0;
  const id = () => `s-00000${++n}`;
  const a = ST.saveMember([], { name: 'Ayşe', role: { preset: 'erp-odoo' }, projects: ['p1'] }, known, id);
  assert.equal(a.member.id, 's-000001');
  const b = ST.saveMember(a.staff, { name: 'Mert', role: { preset: 'qa' }, projects: 'all' }, known, id);
  assert.equal(b.staff.length, 2);
  const edit = ST.saveMember(b.staff, { id: 's-000001', name: 'Ayşe K.', role: { preset: 'erp-odoo' }, projects: ['p1', 'p2'] }, known, id);
  assert.deepEqual(edit.staff.map((m) => m.name), ['Ayşe K.', 'Mert']);
  assert.equal(ST.saveMember(b.staff, { name: 'mert', role: { preset: 'qa' }, projects: [] }, known, id).error, 'name-used');
  assert.equal(ST.saveMember(b.staff, { name: '', role: { preset: 'qa' } }, known, id).error, 'name');
  assert.equal(ST.saveMember(b.staff, { name: 'X', role: {} }, known, id).error, 'role');
  const full = Array.from({ length: ST.STAFF_MAX }, (_, i) => ({ id: `s-${String(i).padStart(6, '0')}`, name: `m${i}`, role: { preset: 'qa' }, projects: [] }));
  assert.equal(ST.saveMember(full, { name: 'one more', role: { preset: 'qa' } }, known, id).error, 'too-many');
  assert.deepEqual(ST.removeMember(edit.staff, 's-000001').map((m) => m.name), ['Mert']);
});

test('dropProject / dropAccount / mayWork', () => {
  const staff = [ayse, { ...ayse, id: 's-bbbbbb', name: 'Mert', projects: 'all', accountId: 'default' }];
  assert.deepEqual(ST.dropProject(staff, 'p1').map((m) => m.projects), [['p2'], 'all']);
  assert.deepEqual(ST.dropAccount(staff, 'work').map((m) => m.accountId), [undefined, 'default']);
  assert.equal(ST.mayWork(ayse, 'p2'), true);
  assert.equal(ST.mayWork(ayse, 'p3'), false);
  assert.equal(ST.mayWork(staff[1], 'anything'), true);
});

test('staff-view: roleOf merges the preset with the member’s own words; byDepartment groups, no department last', async () => {
  const V = await import('../src/staff-view.mjs');
  const defs = ST.loadRoles(ROLES);
  const r = V.roleOf(ayse, defs, 'tr');
  assert.equal(r.name, 'ERP Geliştirici (Odoo)');
  assert.equal(r.short, 'ERP');
  assert.ok(r.brief.startsWith('You are the ERP developer'));
  const own = V.roleOf({ role: { name: 'İçerik yazarı', writesCode: false } }, defs, 'tr');
  assert.deepEqual([own.name, own.short, own.writesCode], ['İçerik yazarı', 'İÇERİK', false]);
  const groups = V.byDepartment([{ name: 'a', department: 'Dev' }, { name: 'b' }, { name: 'c', department: 'Ops' }, { name: 'd', department: 'Dev' }]);
  assert.deepEqual(groups.map((g) => [g.head, g.members.map((m) => m.name)]), [['Dev', ['a', 'd']], ['Ops', ['c']], ['', ['b']]]);
  // v3.84 the role picker: the functions in order, other labels after them, roles without one last
  assert.deepEqual(V.DEPARTMENTS, ST.DEPARTMENTS, 'one list on both sides');
  const picked = V.groupRoles([{ id: 'a', department: 'rnd' }, { id: 'b' }, { id: 'c', department: 'management' }, { id: 'd', department: 'Kendi' }, { id: 'e', department: 'rnd' }]);
  assert.deepEqual(picked.map((g) => [g.dept, g.roles.map((r) => r.id)]), [['management', ['c']], ['rnd', ['a', 'e']], ['Kendi', ['d']], ['', ['b']]]);
  const t = (k) => `<${k}>`;
  assert.deepEqual([V.deptLabel(t, 'hr'), V.deptLabel(t, 'Kendi'), V.deptLabel(t, '')], ['<staff.dept.hr>', 'Kendi', '']);
});

test('role library (v3.84): custom roles saved, offered like presets, removed without leaving a member roleless', () => {
  const defs = ST.loadRoles(ROLES);
  const form = { name: 'Etkinlik Planlayıcı', short: 'ETKİNLİK', department: 'marketing', description: 'Plans events.', brief: 'You plan events.', writesCode: true, skillPacks: ['anthropic-skills', 'BAD id'], tools: ['canva'] };
  const r = ST.saveCustomRole([], form, defs, () => 'my-aaaaaa');
  assert.equal(r.role.id, 'my-aaaaaa');
  assert.deepEqual([r.role.name, r.role.short, r.role.department, r.role.skillPacks, r.role.tools, r.role.custom], [{ en: 'Etkinlik Planlayıcı', tr: 'Etkinlik Planlayıcı' }, { en: 'ETKİNLİK', tr: 'ETKİNLİK' }, 'marketing', ['anthropic-skills'], ['canva'], true]);
  assert.equal(ST.saveCustomRole(r.roles, { ...form }, defs, () => 'my-bbbbbb').error, 'name-used');
  assert.equal(ST.saveCustomRole([], { ...form, name: 'qa / test uzmanı' }, defs).error, 'name-used', 'a preset’s name is taken too');
  assert.equal(ST.saveCustomRole([], { ...form, brief: '' }, defs).error, 'brief');
  assert.equal(ST.saveCustomRole([], { ...form, name: ' ' }, defs).error, 'name');
  const edited = ST.saveCustomRole(r.roles, { ...form, id: 'my-aaaaaa', brief: 'New words.' }, defs);
  assert.deepEqual([edited.roles.length, edited.role.brief], [1, 'New words.']);
  // state.json keeps plain texts; reading them back gives the same role
  const file = ST.customRoleFile(r.role);
  assert.deepEqual(file, { id: 'my-aaaaaa', name: 'Etkinlik Planlayıcı', short: 'ETKİNLİK', department: 'marketing', description: 'Plans events.', brief: 'You plan events.', skillPacks: ['anthropic-skills'], tools: ['canva'], writesCode: true });
  assert.deepEqual(ST.normalizeCustomRoles([file, file, { id: 'bad', name: 'x', brief: 'y' }]), [r.role]);
  assert.deepEqual(P.stateFile({}, { customRoles: [r.role] }).customRoles, [file]);
  // a member on it: valid while the role exists; removing the role copies it onto the member
  const m = ST.normalizeMember({ ...ayse, role: { preset: 'my-aaaaaa', brief: 'Mine.' } }, { ...known, presetIds: ['my-aaaaaa'] });
  assert.equal(ST.memberRole(m, [r.role]).name, 'Etkinlik Planlayıcı');
  const gone = ST.removeCustomRole(r.roles, [m], 'my-aaaaaa');
  assert.deepEqual(gone.roles, []);
  assert.deepEqual(gone.staff[0].role, { name: 'Etkinlik Planlayıcı', description: 'Plans events.', brief: 'Mine.' });
  assert.ok(ST.normalizeMember(gone.staff[0], known), 'still a valid member');
});

test('member tools (v3.84): known server ids kept; a desk gets them on top of its project’s scope', () => {
  const MS = require('../src/mcp-servers.js');
  const m = ST.normalizeMember({ ...ayse, tools: ['srv1', 'gone', 'srv1', '../x'] }, { ...known, toolIds: ['srv1', 'srv2'] });
  assert.deepEqual(m.tools, ['srv1']);
  assert.equal(ST.normalizeMember(ayse, known).tools, undefined, 'none: no field');
  // v3.85 mail accounts: known ids only
  assert.deepEqual(ST.normalizeMember({ ...ayse, mail: ['m-aaaaaa', 'm-gone00', 'x', 'm-aaaaaa'] }, { ...known, mailIds: ['m-aaaaaa'] }).mail, ['m-aaaaaa']);
  assert.equal(ST.normalizeMember(ayse, known).mail, undefined);
  const servers = [{ id: 'srv1', name: 'canva', type: 'http', url: 'https://mcp.canva.com/mcp', scope: 'p9' }, { id: 'srv2', name: 'x', type: 'http', url: 'https://x', scope: 'p2' }];
  assert.deepEqual(MS.withTools(servers, 'p1', ['srv1']).map((s) => s.scope), ['p1', 'p2']);
  assert.equal(MS.withTools(servers, 'p1', undefined), servers);
  assert.deepEqual(Object.keys(MS.appConfigs(MS.withTools(servers, 'p1', ['srv1']), 'p1', () => '')), ['canva']);
  assert.deepEqual(Object.keys(MS.appConfigs(servers, 'p1', () => '')), [], 'without the member: not in p1');
  const state = { accounts: [{ id: 'default' }], staff: [{ ...ayse, accountId: undefined, tools: ['srv1'] }], projects: [{ id: 'p1', dir: '/w/p1', accountId: 'default', tabs: [{ n: 2, staffId: 's-a1b2c3' }] }] };
  assert.deepEqual(P.resolvePty(state, 'p1:2').project.staffTools, ['srv1']);
  assert.equal(P.resolvePty(state, 'p1').project.staffTools, undefined);
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8'), /MS\.sessionServers\(P\.engineOf\(project\), MS\.withTools\(appServers\(\), project\.id, project\.staffTools\)/);
});

// ---------- desks (step 3) and HQ (step 4) ----------
const P = require('../src/projects.js');

test('desks: a staff tab keeps staffId and sessionId; resolvePty gives a desk its member’s own account', () => {
  const tabs = P.normalizeTabs([{ n: 2, staffId: 's-a1b2c3', sessionId: 'abc-1' }, { n: 3, staffId: 'nope', sessionId: 'x' }, { n: 4, staffId: 's-a1b2c3', shell: true, dir: '/w' }]);
  assert.deepEqual(tabs, [{ n: 2, staffId: 's-a1b2c3', sessionId: 'abc-1' }, { n: 3 }, { n: 4, dir: '/w', shell: true }]);
  const state = {
    accounts: [{ id: 'default' }, { id: 'work' }], projects: [{ id: 'p1', dir: '/w/p1', accountId: 'default', tabs: [{ n: 2, staffId: 's-a1b2c3' }, { n: 3, staffId: 's-bbbbbb' }] }],
    staff: [{ ...ayse, id: 's-a1b2c3', accountId: 'work' }, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }],
  };
  assert.equal(P.resolvePty(state, 'p1:2').project.accountId, 'work', 'the member’s account');
  assert.equal(P.resolvePty(state, 'p1:3').project.accountId, 'default', 'no own account: the project’s');
  assert.equal(P.resolvePty(state, 'p1').project.accountId, 'default', 'the main tab is unchanged');
  assert.equal(P.resolvePty({ ...state, accounts: [{ id: 'default' }] }, 'p1:2').project.accountId, 'default', 'a gone account: the project’s');
  assert.deepEqual(P.desksOf(state.projects[0]).map((t) => t.staffId), ['s-a1b2c3', 's-bbbbbb']);
  assert.equal(P.deskOf(state.projects[0], 's-bbbbbb').n, 3);
  const next = P.setDeskSession(state, 'p1', 2, 'sess-9');
  assert.equal(P.deskOf(next.projects[0], 's-a1b2c3').sessionId, 'sess-9');
  assert.equal(P.setDeskSession(next, 'p1', 2, 'sess-9'), next, 'unchanged: same state');
});

test('a member’s role settings: a preset’s fields overridden (writes code both ways), packs on top of the desk’s project', () => {
  const defs = ST.loadRoles(ROLES);
  const pm = ST.normalizeMember({ ...ayse, role: { preset: 'assistant', brief: 'Own words.', writesCode: true } }, { ...known, presetIds: null });
  assert.deepEqual(pm.role, { preset: 'assistant', brief: 'Own words.', writesCode: true });
  assert.equal(defs.find((d) => d.id === 'assistant').writesCode, false, 'the preset does not write code');
  assert.deepEqual([ST.memberRole(pm, defs).writesCode, ST.memberRole(pm, defs).brief], [true, 'Own words.']);
  const qa = ST.normalizeMember({ ...ayse, role: { preset: 'qa', writesCode: false } }, known);
  assert.equal(ST.memberRole(qa, defs).writesCode, false);
  assert.equal(ST.normalizeMember({ ...ayse, role: { name: 'Yazar', writesCode: true } }, known).role.writesCode, undefined, 'an own role writes code unless told not to');
  assert.deepEqual(ST.packMap({ superpowers: false, 'BAD id': true, x: 'on' }), { superpowers: false });
  const state = {
    accounts: [{ id: 'default' }], staff: [{ ...ayse, accountId: undefined, skillPacks: { superpowers: true, caveman: false } }],
    projects: [{ id: 'p1', dir: '/w/p1', accountId: 'default', skillPacks: { caveman: true, other: true }, tabs: [{ n: 2, staffId: 's-a1b2c3' }] }],
  };
  assert.deepEqual(P.resolvePty(state, 'p1:2').project.skillPacks, { caveman: false, other: true, superpowers: true });
  assert.deepEqual(P.resolvePty(state, 'p1').project.skillPacks, { caveman: true, other: true }, 'the main tab: the project’s');
  assert.deepEqual(state.projects[0].skillPacks, { caveman: true, other: true }, 'the project is not changed');
});

test('parallel: a project flag, never written when off; a desk worktree lives in userData', () => {
  const s = { projects: [{ id: 'p1', dir: '/w/p1' }] };
  const on = P.setParallel(s, 'p1', true);
  assert.equal(on.projects[0].parallel, true);
  assert.equal('parallel' in P.setParallel(on, 'p1', false).projects[0], false);
  const wt = ST.deskWorktree('/ud', 'p1', 's-a1b2c3', path.posix.join);
  assert.deepEqual(wt, { root: '/ud/work/p1/s-a1b2c3', branch: 'agent-office/s-a1b2c3' });
});

test('deskWaits: one desk at work per folder unless the project is parallel', () => {
  const busy = new Set(['p1']);
  assert.equal(ST.deskWaits({}, 'p1:2', ['p1', 'p1:2'], (id) => busy.has(id)), true, 'the boss tab works: the desk waits');
  assert.equal(ST.deskWaits({}, 'p1:2', ['p1', 'p1:2'], () => false), false);
  assert.equal(ST.deskWaits({ parallel: true }, 'p1:2', ['p1', 'p1:2'], () => true), false, 'parallel: never waits');
  assert.equal(ST.deskWaits({}, 'p1:2', ['p1:2'], () => true), false, 'its own work does not count');
});

test('deskRoleFile: the member, its role in English, the project and the rest of the team; no account or token', () => {
  const defs = ST.loadRoles(ROLES);
  const staff = [ayse, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }];
  const f = ST.deskRoleFile(ayse, defs, { id: 'p1', name: 'acme', dir: '/w/acme' }, staff);
  assert.equal(f.member, 'Ayşe');
  assert.equal(f.name, 'ERP Developer (Odoo)');
  assert.equal(f.department, 'Geliştirme');
  assert.deepEqual(f.project, { name: 'acme', dir: '/w/acme' });
  assert.deepEqual(f.team, [{ name: 'Mert', role: 'QA Engineer' }]);
  assert.ok(!('accountId' in f) && !JSON.stringify(f).includes('work"'), 'no account');
});

test('machineStaff / findMember: HQ sees roles, allowed projects and desks; members found by name or id', () => {
  const defs = ST.loadRoles(ROLES);
  const projects = [{ id: 'p1', name: 'acme' }, { id: 'p2', name: 'beta' }, { id: 'p3', name: 'gamma' }];
  const staff = [ayse, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }];
  const states = { 'p1:s-a1b2c3': 'busy', 'p3:s-bbbbbb': 'idle' };
  const v = ST.machineStaff(staff, defs, projects, (pid, sid) => states[`${pid}:${sid}`] || 'none');
  assert.deepEqual(v[0].projects, ['acme', 'beta']);
  assert.deepEqual(v[0].desks, [{ project: 'acme', state: 'busy' }]);
  assert.equal(v[0].busy, true);
  assert.equal(v[1].projects, 'all');
  assert.deepEqual(v[1].desks, [{ project: 'gamma', state: 'idle' }]);
  assert.equal(v[1].role, 'QA Engineer');
  assert.equal(ST.findMember(staff, 'AYŞE').id, ayse.id);
  assert.equal(ST.findMember(staff, 's-bbbbbb').name, 'Mert');
  assert.equal(ST.findMember(staff, 'nobody'), null);
});

test('main.js: HQ dispatch to staff — checks, the desk, the lock, the member’s env', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  const hs = fn('hqStaffDesk');
  for (const r of ['staff-local-only', 'no-team', 'unknown-staff', 'staff-not-allowed']) assert.ok(hs.includes(`'${r}'`), r);
  assert.match(fn('linkTabState'), /ST\.deskWaits\(/);
  assert.match(fn('officeDispatch'), /linkHost\.dispatchLocal\(into,/);
  assert.match(src, /if \(roleFile\) env\.AGENT_OFFICE_ROLE = roleFile;/);
  assert.match(src, /if \(project\.hq && teamOn\(\)\) env\.AGENT_OFFICE_TEAM = '1';/);
  assert.match(fn('openDesk'), /ST\.deskWorktree\(app\.getPath\('userData'\)/);
});

test('v3.83 amendment: a personal workspace is its owner\'s alone; normalizeState keeps staffOwner', () => {
  const ST2 = require('../src/staff.js');
  const P2 = require('../src/projects.js');
  const own = { id: 'p9', name: 'Ahmet - kişisel', staffOwner: 's-a1a1a1' };
  const ahmet = { id: 's-a1a1a1', name: 'Ahmet', projects: ['p1'] };
  const all = { id: 's-b2b2b2', name: 'Mert', projects: 'all' };
  assert.equal(ST2.mayWork(ahmet, own), true, 'the owner, whatever the list says');
  assert.equal(ST2.mayWork(all, own), false, '"all" never reaches another member\'s workspace');
  assert.equal(ST2.mayWork(ahmet, 'p1'), true);
  assert.equal(ST2.mayWork(ahmet, { id: 'p1' }), true);
  assert.equal(ST2.personalOf([{ id: 'p1' }, own], 's-a1a1a1'), own);
  assert.equal(ST2.personalOf([{ id: 'p1' }], 's-a1a1a1'), null);
  const s = P2.normalizeState({ projects: [{ id: 'p9', dir: '/d/Ahmet - kişisel', staffOwner: 's-a1a1a1' }, { id: 'p8', dir: '/x', staffOwner: '../bad' }] });
  assert.equal(s.projects[0].staffOwner, 's-a1a1a1');
  assert.equal(s.projects[1].staffOwner, undefined);
  const ms = ST2.machineStaff([ahmet, all], [], [{ id: 'p1', name: 'site' }, own], () => 'none');
  assert.deepEqual([ms[0].projects, ms[0].personal], [['site'], 'Ahmet - kişisel']);
  assert.equal(ms[1].personal, undefined);
});

test('v3.83 amendment: trustFolder marks only the app-made folder trusted, once, keeping every other field', () => {
  const fs = require('fs');
  const path = require('path');
  const PD = require('../src/project-data.js');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ao-trust-'));
  const ws = path.join(dir, 'Natasha - kişisel');
  fs.mkdirSync(ws);
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { x: 1 }, projects: { '/other': { allowedTools: ['Read'] } } }));
  assert.equal(PD.trustFolder(cfg, dir, ws), true);
  const j = JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8'));
  assert.equal(j.projects[ws].hasTrustDialogAccepted, true);
  assert.deepEqual([j.oauthAccount, j.projects['/other']], [{ x: 1 }, { allowedTools: ['Read'] }]);
  assert.equal(PD.trustFolder(cfg, dir, ws), false, 'already trusted: not written again');
  fs.writeFileSync(path.join(cfg, '.claude.json'), '{ broken');
  assert.equal(PD.trustFolder(cfg, dir, ws), false, 'an unreadable file is left alone');
  assert.equal(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8'), '{ broken');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('followsProjectAccount: every tab moves with its project’s account except a desk on its member’s own account', () => {
  const state = {
    accounts: [{ id: 'default' }, { id: 'work' }, { id: 'spare' }],
    projects: [{ id: 'p1', dir: '/w/p1', accountId: 'default', tabs: [{ n: 2, staffId: 's-a1b2c3' }, { n: 3, staffId: 's-bbbbbb' }, { n: 4 }] }],
    staff: [{ ...ayse, id: 's-a1b2c3', accountId: 'work' }, { id: 's-bbbbbb', name: 'Mert', role: { preset: 'qa' }, projects: 'all' }],
  };
  assert.equal(P.followsProjectAccount(state, 'p1'), true, 'the main tab');
  assert.equal(P.followsProjectAccount(state, 'p1:4'), true, 'an ordinary tab');
  assert.equal(P.followsProjectAccount(state, 'p1:3'), true, 'a desk without an account of its own');
  assert.equal(P.followsProjectAccount(state, 'p1:2'), false, 'a desk on its member’s account');
  // the project moved onto the very account the desk runs on (its backup): the desk still did not move
  const moved = { ...state, projects: [{ ...state.projects[0], accountId: 'work', homeAccount: 'default' }] };
  assert.equal(P.resolvePty(moved, 'p1:2').project.accountId, 'work');
  assert.equal(P.followsProjectAccount(moved, 'p1:2'), false, 'the same account by chance: still the member’s own');
  assert.equal(P.followsProjectAccount({ ...state, accounts: [{ id: 'default' }] }, 'p1:2'), true, 'a gone account: the project’s');
  assert.equal(P.followsProjectAccount(state, 'p1:9'), true, 'an unknown tab is nobody’s desk');
  // main.js: the backup account and a project move read only the tabs on the project's account
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  assert.match(src, /const accountTabs = \(p\) => P\.ptyIdsOf\(p\)\.filter\(\(id\) => P\.followsProjectAccount\(state, id\)\);/);
  for (const name of ['moveProject', 'checkLimits', 'maybeReturn']) {
    assert.match(fn(name), /accountTabs\(p\)/, name);
    assert.doesNotMatch(fn(name), /P\.ptyIdsOf\(p\)/, `${name}: no desk of another account`);
  }
  assert.doesNotMatch(fn('onLimit'), /P\.ptyIdsOf\(p\)/);
});

test('office_dispatch: a model-supplied desk (or staffName) is ignored; only the app sets them', () => {
  const OM = require('../src/office-mcp.js');
  assert.deepEqual(OM.modelArgs('office_dispatch', { project: 'acme', task: 'x', staff: 'Ayşe', desk: 'p1:2', staffName: 'Boss', targetName: 'Elsewhere' }), { project: 'acme', task: 'x', staff: 'Ayşe' });
  assert.deepEqual(OM.modelArgs('office_dispatch', null), {});
  assert.deepEqual(OM.modelArgs('office_dispatch', ['desk']), {});
  assert.deepEqual(OM.modelArgs('office_project', { project: 'acme', op: 'start' }), { project: 'acme', op: 'start' });
  const given = { task: 'x', desk: 'p1:2' };
  OM.modelArgs('office_dispatch', given);
  assert.equal(given.desk, 'p1:2', 'the caller’s object is not changed');
  const d = OM.TOOLS.find((x) => x.name === 'office_dispatch');
  assert.ok(!('desk' in d.inputSchema.properties) && !('staffName' in d.inputSchema.properties), 'neither is a declared argument');
  // the app's own boundary (the socket's handler) drops them before any dispatch code runs
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /function officeTool\(tab, tool, args\) \{\n {2}args = OM\.modelArgs\(tool, args\);/);
});

test('main.js: HQ dispatch to staff asks before it creates — workspace, desk and worktree only after consent', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  const hd = fn('hqDispatch');
  const ask = hd.indexOf('confirmHqDispatch(');
  const hold = hd.indexOf('return holdDispatch(');
  assert.ok(ask > 0 && hold > 0);
  assert.ok(hd.indexOf('ensurePersonal(') > ask && hd.indexOf('ensurePersonal(') > hold, 'the personal workspace is made after the dialog and never for a held task');
  assert.ok(hd.indexOf('{ open: false }') > 0 && hd.indexOf('{ open: false }') < ask, 'before consent: the checks only');
  assert.equal(hd.indexOf('openDesk('), -1);
  const opens = [...hd.matchAll(/hqStaffDesk\(/g)].map((m) => m.index);
  assert.equal(opens.length, 2);
  assert.ok(opens[0] < ask && opens[1] > ask, 'the desk is opened after consent');
  const hs = fn('hqStaffDesk');
  assert.ok(hs.indexOf('if (!open) return') > 0 && hs.indexOf('if (!open) return') < hs.indexOf('openDesk('), 'open: false returns before anything is opened');
  // the dialog names the member and the target, also for a workspace that does not exist yet
  assert.match(hd, /targetName: personalFolderName\(personal\)/);
  assert.match(fn('confirmHqDispatch'), /T\('main\.hqAskStaff', \{ staff: args\.staffName, project: officeName\(args\.targetName \|\| args\.project\) \}\)/);
  // a held task keeps its member, so approval sends it to the desk
  assert.match(fn('holdDispatch'), /\.\.\.\(args\.staff \? \{ staff: String\(args\.staff\) \} : \{\}\)/);
  // removing a member is refused like the other writes when state.json could not be read
  assert.match(src, /ipcMain\.handle\('staff:remove', \(_e, id\) => \{\n {2}if \(!stateWritable\) return \{ ok: false, error: 'state' \};/);
});

test('v3.83 review fix: only a folder the app made (or a real, empty one) is trusted, in the account the desk runs on', () => {
  const fs = require('fs');
  const PD = require('../src/project-data.js');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ao-trust2-'));
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg);
  const fresh = path.join(dir, 'ws', 'Ada - personal');
  const made = fs.mkdirSync(fresh, { recursive: true });
  assert.ok(made, 'mkdirSync names what it created');
  assert.equal(PD.appMadeFolder(fresh, Boolean(made)), true, 'created in this call');
  const again = fs.mkdirSync(fresh, { recursive: true });
  assert.equal(again, undefined);
  assert.equal(PD.appMadeFolder(fresh, Boolean(again)), true, 'already there, but a real and empty directory');
  const full = path.join(dir, 'full');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, '.mcp.json'), '{}');
  assert.equal(PD.appMadeFolder(full, false), false, 'a folder with content is never the app\'s own');
  assert.equal(PD.appMadeFolder(path.join(dir, 'missing'), true), false);
  assert.equal(PD.appMadeFolder(path.join(full, '.mcp.json'), true), false, 'a file');
  let linked = true;
  const link = path.join(dir, 'link');
  const emptyLink = path.join(dir, 'empty-link');
  try { fs.symlinkSync(full, link, 'dir'); fs.symlinkSync(fresh, emptyLink, 'dir'); } catch { linked = false; }   // no symlink right (Windows)
  if (linked) {
    assert.equal(PD.appMadeFolder(link, false), false, 'a symlink');
    assert.equal(PD.appMadeFolder(link, true), false);
    assert.equal(PD.appMadeFolder(emptyLink, false), false, 'a symlink to an empty folder too');
    assert.equal(PD.trustFolder(cfg, dir, link), false, 'trustFolder refuses a symlink: its real path is another folder');
    assert.equal(fs.existsSync(path.join(cfg, '.claude.json')), false, 'nothing was written');
  }
  assert.equal(PD.trustFolder(cfg, dir, path.join(dir, 'missing')), false);
  assert.equal(PD.trustFolder(cfg, dir, fresh), true);
  const j = JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8'));
  assert.equal(j.projects[fresh].hasTrustDialogAccepted, true);
  assert.ok(!Object.keys(j.projects).some((k) => k === full || k === fs.realpathSync(full)), 'no other folder');
  fs.rmSync(dir, { recursive: true, force: true });
  // the mark survives a restart, and only as true
  const ws = { id: 'p9', dir: '/w/ada', name: 'Ada - personal', accountId: 'default', staffOwner: 's-a1b2c3', appMade: true, tabs: [{ n: 2, staffId: 's-a1b2c3' }] };
  const state = P.normalizeState({ projects: [ws, { id: 'p8', dir: '/w/x', name: 'x', accountId: 'default', appMade: 'yes' }], accounts: [{ id: 'work', name: 'Work', configDir: '/cfg/work' }], staff: [] });
  assert.deepEqual(state.projects.map((p) => p.appMade), [true, undefined]);
  // the desk runs on the member's current account, whatever account the workspace was made on
  const seen = P.resolvePty({ ...state, staff: [{ id: 's-a1b2c3', name: 'Ada', accountId: 'work' }] }, 'p9:2');
  assert.deepEqual([seen.project.accountId, seen.project.appMade, seen.dir], ['work', true, '/w/ada']);
  assert.equal(P.resolvePty({ ...state, staff: [{ id: 's-a1b2c3', name: 'Ada' }] }, 'p9:2').project.accountId, 'default', 'no account of their own: the project\'s');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  assert.match(fn('ensurePersonal'), /const appMade = PD\.appMadeFolder\(dir, Boolean\(made\)\);/);
  assert.doesNotMatch(fn('ensurePersonal'), /trustFolder|realpath/, 'creating a workspace trusts nothing by itself');
  const tp = fn('trustPersonalDesk');
  assert.match(tp, /const r = P\.resolvePty\(state, id\);\n {2}if \(!r\?\.tab\?\.staffId \|\| !r\.project\.staffOwner \|\| r\.project\.appMade !== true \|\| r\.dir !== r\.project\.dir\) return;/);
  assert.match(tp, /PD\.trustFolder\(A\.accountOf\(state, r\.project\)\.configDir, app\.getPath\('home'\), r\.dir\)/);
  const od = fn('openDesk');
  assert.equal(od.split('trustPersonalDesk(id);').length, 3, 'an existing desk and a new one');
  assert.ok(od.lastIndexOf('trustPersonalDesk(id);') < od.lastIndexOf('startPty(id)'), 'before the session starts');
});

// ---------- v3.88 the personal workspace's settings in the member's popup ----------
const P88 = require('../src/projects.js');
const autoOn = (s, id) => P88.setProjectAutoApprove(s, id, true);
const autoOff = (s, id) => P88.setProjectAutoApprove(s, id, false);
const skipOn = (s, id) => P88.setProjectSkipPermissions(s, id, true);

test('personalTarget: only personal:<staff id> names a personal workspace', () => {
  assert.equal(ST.personalTarget('personal:s-a1b2c3'), 's-a1b2c3');
  for (const bad of ['s-a1b2c3', 'personal:', 'personal:p1', 'personal:s-XYZ', '', null, 7]) assert.equal(ST.personalTarget(bad), '');
});

test('personal draft: off by default, written by the project setters, kept through a save, never taken from the form', () => {
  const staff = [ST.normalizeMember(ayse, known)];
  assert.equal('personal' in staff[0], false, 'nothing is widened by default');
  assert.equal(ST.setPersonalDraft(staff, 's-ffffff', autoOn), staff, 'unknown member');
  assert.equal(ST.setPersonalDraft(staff, ayse.id, autoOff), staff, 'no change, same list');
  const on = ST.setPersonalDraft(staff, ayse.id, autoOn);
  assert.deepEqual(on[0].personal, { autoApprove: true });
  const both = ST.setPersonalDraft(on, ayse.id, skipOn);
  assert.deepEqual(both[0].personal, { autoApprove: true, skipPermissions: true });
  const off = ST.setPersonalDraft(both, ayse.id, autoOff);
  assert.deepEqual(off[0].personal, { skipPermissions: true });
  // only the two switches survive normalization, and only as true
  assert.deepEqual(ST.normalizeMember({ ...ayse, personal: { autoApprove: true, skipPermissions: 'yes', accountId: 'x', dir: '/' } }, known).personal, { autoApprove: true });
  // editing the member keeps the draft; a form cannot set it (new member or edit)
  const saved = ST.saveMember(both, { ...ayse, name: 'Ayşe K', personal: {} }, known);
  assert.deepEqual(saved.member.personal, { autoApprove: true, skipPermissions: true });
  const fresh = ST.saveMember([], { name: 'Can', role: { preset: 'qa' }, projects: [], personal: { autoApprove: true, skipPermissions: true } }, known);
  assert.equal('personal' in fresh.member, false);
});

test('personal draft: taken off the member when the workspace is made', () => {
  const staff = ST.setPersonalDraft([ST.normalizeMember(ayse, known)], ayse.id, autoOn);
  const t = ST.takePersonalDraft(staff, ayse.id);
  assert.deepEqual(t.draft, { autoApprove: true });
  assert.equal('personal' in t.staff[0], false);
  const none = ST.takePersonalDraft(t.staff, ayse.id);
  assert.deepEqual(none.draft, {});
  assert.equal(none.staff, t.staff);
});

test('main: the personal workspace takes the project setters, its draft at creation, and staff-not-allowed names its fix', () => {
  const MAIN88 = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN88, /personalSetting\(target, \(s, pid\) => P\.setProjectAutoApprove\(s, pid, value === true\)\)/);
  assert.match(MAIN88, /personalSetting\(target, \(s, pid\) => P\.setProjectSkipPermissions\(s, pid, value === true\)\)/);
  const ep = MAIN88.slice(MAIN88.indexOf('function ensurePersonal('), MAIN88.indexOf('function trustPersonalDesk('));
  assert.match(ep, /ST\.takePersonalDraft\(/);
  assert.match(ep, /ST\.applyPersonalDraft\(state, m\.id, own\.id, \{ autoApprove: P\.setProjectAutoApprove, skipPermissions: P\.setProjectSkipPermissions \}\)/);
  assert.match(MAIN88, /reason: 'staff-not-allowed', hint: ST\.NOT_ALLOWED_HINT/);
  assert.match(MAIN88, /no\('staff-not-allowed', \{ stage: s\.n, hint: ST\.NOT_ALLOWED_HINT \}\)/);
  assert.match(ST.NOT_ALLOWED_HINT, /not assigned to that project.*member's settings/);
});

test('HQ brief and tool text: one approval for a chain, the Allow button only, a desk prompt is the person\'s', () => {
  const read = (f) => require('fs').readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  const team = read('plugin/hooks/staff.ts');
  assert.match(team, /as stages of ONE request \(office_dispatch with \\`then\\`\) in the turn the person typed it, so the person approves the whole chain once/);
  assert.match(team, /only when a later step cannot be known in advance/);
  const hq = read('plugin/hooks/hq.ts');
  assert.doesNotMatch(hq, /is never yours/);
  assert.match(hq, /Only pressing Allow on a task held for consent is the person's/);
  assert.match(hq, /Dispatching, cancelling, closing and retitling open tasks are yours/);
  assert.match(hq, /A desk's own permission prompt is answered by the person in that desk's tab; you cannot answer it/);
  assert.match(hq, /a member with mail asks by design/);
  const mcp = read('app/src/office-mcp.js');
  assert.match(mcp, /staff-not-allowed: the person can assign the project in the member\\'s settings/);
});

test('routePersonalSetting: a workspace that exists gets the setting, not the draft', () => {
  const P = require('../src/projects.js');
  const set = (s, pid) => P.setProjectSkipPermissions(s, pid, true);
  const state = { projects: [{ id: 'p9', dir: '/w/ada', name: 'Ada', staffOwner: 's-a1b2c3' }], staff: [{ id: 's-a1b2c3', name: 'Ada' }] };
  const r = ST.routePersonalSetting(state, 'personal:s-a1b2c3', set);
  assert.equal(r.id, 'p9');
  assert.equal(r.next.projects[0].skipPermissions, true);
  assert.equal('personal' in r.next.staff[0], false, 'the draft stays untouched');
});

test('routePersonalSetting: no workspace yet goes to the draft; a real project with that id wins', () => {
  const P = require('../src/projects.js');
  const set = (s, pid) => P.setProjectAutoApprove(s, pid, true);
  const state = { projects: [], staff: [{ id: 's-a1b2c3', name: 'Ada' }] };
  const d = ST.routePersonalSetting(state, 'personal:s-a1b2c3', set);
  assert.equal(d.id, '');
  assert.deepEqual(d.next.staff[0].personal, { autoApprove: true });
  // a hand-edited project whose real id looks like a personal target is a project, not the member's workspace
  const odd = { projects: [{ id: 'personal:s-a1b2c3', dir: '/w/x', name: 'x' }], staff: state.staff };
  const o = ST.routePersonalSetting(odd, 'personal:s-a1b2c3', set);
  assert.equal(o.id, 'personal:s-a1b2c3');
  assert.equal(o.next.projects[0].autoApprove, true);
  assert.equal('personal' in o.next.staff[0], false);
  // an ordinary project id passes straight through
  assert.equal(ST.routePersonalSetting({ projects: [{ id: 'p1', dir: '/a', name: 'a' }], staff: [] }, 'p1', set).id, 'p1');
});

test('applyPersonalDraft: the draft is applied to the new workspace and cleared from the member', () => {
  const P = require('../src/projects.js');
  const setters = { autoApprove: P.setProjectAutoApprove, skipPermissions: P.setProjectSkipPermissions };
  const state = {
    projects: [{ id: 'p9', dir: '/w/ada', name: 'Ada', staffOwner: 's-a1b2c3' }],
    staff: [{ id: 's-a1b2c3', name: 'Ada', personal: { autoApprove: true, skipPermissions: true } }],
  };
  const next = ST.applyPersonalDraft(state, 's-a1b2c3', 'p9', setters);
  assert.equal(next.projects[0].autoApprove, true);
  assert.equal(next.projects[0].skipPermissions, true);
  assert.equal('personal' in next.staff[0], false);
  const none = ST.applyPersonalDraft({ ...state, staff: [{ id: 's-a1b2c3', name: 'Ada' }] }, 's-a1b2c3', 'p9', setters);
  assert.equal(none.projects[0].autoApprove, undefined, 'off when never chosen');
});
