// Proje listesi: saf durum işlevleri (Electron yok; node --test ile sınanır).
// Durum: { projects: Project[], accounts: Account[], activeId: string | null } (bkz. CONTRACT.md).
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_ID, normalizeAccounts } = require('./accounts.js');

const newId = () => crypto.randomBytes(6).toString('hex');
const projectName = (dir) => path.basename(dir);

// state.json'dan okunanı temizler; eski tek projeli sürümün `lastProject`'i ilk proje olur.
function normalizeState(raw, { id = newId } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const accounts = normalizeAccounts(r.accounts);
  const known = new Set(accounts.map((a) => a.id));
  const seen = new Set();
  const projects = [];
  for (const p of Array.isArray(r.projects) ? r.projects : []) {
    if (!p || typeof p.dir !== 'string' || !p.dir || seen.has(p.dir)) continue;
    seen.add(p.dir);
    projects.push({
      id: typeof p.id === 'string' && p.id ? p.id : id(),
      dir: p.dir,
      name: projectName(p.dir),
      accountId: known.has(p.accountId) ? p.accountId : DEFAULT_ID,
    });
  }
  if (!projects.length && typeof r.lastProject === 'string' && r.lastProject) {
    projects.push({ id: id(), dir: r.lastProject, name: projectName(r.lastProject), accountId: DEFAULT_ID });
  }
  const activeId = projects.some((p) => p.id === r.activeId) ? r.activeId : (projects[0]?.id ?? null);
  return { projects, accounts, activeId };
}

const findProject = (state, id) => state.projects.find((p) => p.id === id) || null;
const findByDir = (state, dir) => state.projects.find((p) => p.dir === dir) || null;

// Klasör listede varsa yalnızca etkinleşir; yoksa eklenir ve etkinleşir.
function addProject(state, dir, { id = newId, accountId = DEFAULT_ID } = {}) {
  const old = findByDir(state, dir);
  if (old) return { state: { ...state, activeId: old.id }, project: old, isNew: false };
  const acc = state.accounts.some((a) => a.id === accountId) ? accountId : DEFAULT_ID;
  const project = { id: id(), dir, name: projectName(dir), accountId: acc };
  return { state: { ...state, projects: [...state.projects, project], activeId: project.id }, project, isNew: true };
}

// Etkin proje silinirse yerine komşusu (sonraki, yoksa önceki) geçer.
function removeProject(state, id) {
  const i = state.projects.findIndex((p) => p.id === id);
  if (i < 0) return state;
  const projects = state.projects.filter((p) => p.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = (projects[i] || projects[i - 1])?.id ?? null;
  return { ...state, projects, activeId };
}

function setActive(state, id) {
  return findProject(state, id) ? { ...state, activeId: id } : state;
}

function setProjectAccount(state, id, accountId) {
  if (!state.accounts.some((a) => a.id === accountId)) return state;
  return { ...state, projects: state.projects.map((p) => (p.id === id ? { ...p, accountId } : p)) };
}

module.exports = {
  newId, projectName, normalizeState, findProject, findByDir,
  addProject, removeProject, setActive, setProjectAccount,
};
