// One MCP system (contract v3.44, supersedes the connection parts of v3.42/v3.43). Pure helpers (no Electron).
//
// A project's Claude Code sessions get MCP servers from Claude Code's own files (read-only here: ~/.claude.json
// top-level and projects[dir].mcpServers, the account's .claude.json, the project's approved .mcp.json), from other
// office projects (v3.9 share) and from servers added in Agent Office. The last are kept in state.json as
// `mcpServers: [{ id, name, type: 'http' | 'sse', url, scope: 'all' | <projectId> }]` with no token: the token is in
// the token store below (safeStorage), keyed by the server id. They reach claude through the tab's 0600 --mcp-config
// file (shared-config.js prepareShared `app`), only where no server of that name is already defined for the session.
const fs = require('fs');
const path = require('path');
const SC = require('./shared-config.js');

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const TYPES = ['http', 'sse'];
const NAME_MAX = 48;

// Turkish letters NFKD does not decompose (ı, İ) or that should read as their base letter: 'Kişisel' → 'kisisel'.
const TR = { ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' };
/** The server's name inside the session (`/mcp` lists it by this): 'My Notion!' → 'my-notion', '' → ''. */
const serverName = (s) => String(s || '').replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR[/** @type {keyof typeof TR} */ (c)]).normalize('NFKD')
  .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX).toLowerCase();

/** The address when it is a usable http(s) URL, else ''. */
function cleanUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}
/** The host of an address (never its path, query or credentials), or ''. */
const hostOf = (v) => { try { return new URL(String(v)).host; } catch { return ''; } };

/** The token as typed: trimmed, a pasted leading 'Bearer ' dropped (the header adds it; no 'Bearer Bearer x'). */
const cleanToken = (v) => (typeof v === 'string' ? v.trim().replace(/^bearer\s+/i, '').trim() : '');

/** A config's transport: its `type`, else 'http' with a url, else 'stdio'. */
const typeOf = (c) => (isObj(c) && typeof c.type === 'string' && c.type ? c.type : isObj(c) && typeof c.url === 'string' ? 'http' : 'stdio');

/**
 * state.json `mcpServers` → the valid entries (unknown fields, a token among them, dropped). A server scoped to a
 * project that is not in `projectIds` is dropped; duplicate ids and duplicate names within one scope too.
 * @param {any} list @param {string[]} [projectIds]
 * @returns {{ id: string, name: string, type: 'http' | 'sse', url: string, scope: string }[]}
 */
function normalizeServers(list, projectIds) {
  const known = projectIds ? new Set(projectIds) : null;
  const out = [];
  const ids = new Set(), names = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || typeof s.id !== 'string' || !/^[\w-]{1,64}$/.test(s.id) || ids.has(s.id)) continue;
    const name = serverName(s.name), url = cleanUrl(s.url);
    const type = TYPES.includes(s.type) ? s.type : 'http';
    const scope = s.scope === 'all' || (typeof s.scope === 'string' && s.scope && (!known || known.has(s.scope))) ? s.scope : null;
    if (!name || !url || !scope || names.has(`${scope}\0${name}`)) continue;
    ids.add(s.id); names.add(`${scope}\0${name}`);
    out.push({ id: s.id, name, type, url, scope });
  }
  return out;
}

/** Error code for the add form ('name' | 'url' | 'type' | 'scope') or null. */
function validate(f, projectIds = []) {
  if (!serverName(f?.name)) return 'name';
  if (!cleanUrl(f?.url)) return 'url';
  if (f?.type !== undefined && !TYPES.includes(f.type)) return 'type';
  if (f?.scope !== 'all' && !projectIds.includes(f?.scope)) return 'scope';
  return null;
}

/** The servers that apply to a project's sessions: its own (by scope) first, then the ones for all projects. */
const serversFor = (servers, projectId) => [
  ...servers.filter((s) => s.scope === projectId), ...servers.filter((s) => s.scope === 'all'),
];

/**
 * Adds a server. → { servers, server } or { error: 'name-used' } when a server of that name already applies to the
 * same sessions (same scope, or one side is 'all' and the other a project).
 */
function addServer(servers, f, newId) {
  const server = { id: newId, name: serverName(f.name), type: TYPES.includes(f.type) ? f.type : 'http', url: cleanUrl(f.url), scope: f.scope };
  const clash = servers.some((s) => s.name === server.name && (s.scope === server.scope || s.scope === 'all' || server.scope === 'all'));
  return clash ? { error: 'name-used' } : { servers: [...servers, server], server };
}
const removeServer = (servers, id) => servers.filter((s) => s.id !== id);
/** The servers of a project that leaves (removed, handed off): → { servers, gone: ids whose token must go } */
function dropProject(servers, projectId) {
  return { servers: servers.filter((s) => s.scope !== projectId), gone: servers.filter((s) => s.scope === projectId).map((s) => s.id) };
}

/** The claude MCP entry: a remote server, the token as a bearer header. Lives only in the tab's 0600 MCP file. */
function serverConfig(s, token) {
  return { type: s.type, url: s.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
}
/** `{ name: config }` of the app-added servers for a project's Claude Code session (tokenOf(id) → token or ''). */
function appConfigs(servers, projectId, tokenOf) {
  const out = {};
  for (const s of serversFor(servers, projectId)) if (!out[s.name]) out[s.name] = serverConfig(s, tokenOf(s.id));
  return out;
}

/**
 * Migration (v3.44): a v3.43 connection was a project with `mcp: { label, url }`. It stays a normal project; its
 * server becomes an app-added server scoped to it (id `c-<projectId>`), and the caller moves its token
 * (`moved`: [{ from: projectId, to: serverId }]). Idempotent: a project without `mcp` is left as it is.
 */
function migrateConnections(projects, servers) {
  const list = Array.isArray(servers) ? servers.filter(isObj) : [];
  const moved = [];
  const out = (Array.isArray(projects) ? projects : []).map((p) => {
    if (!isObj(p) || !isObj(p.mcp)) return p;
    const { mcp, ...rest } = p;
    const url = cleanUrl(mcp.url), name = serverName(mcp.label) || 'server';
    if (url && typeof p.id === 'string' && p.id) {
      const id = `c-${String(p.id).replace(/[^\w-]/g, '_')}`.slice(0, 64);
      if (!list.some((s) => s.id === id)) list.push({ id, name, type: 'http', url, scope: p.id });
      moved.push({ from: p.id, to: id });
    }
    return rest;
  });
  return { projects: out, servers: list, moved };
}

/**
 * The token store (v3.43, kept): one file per id under `dir`, encrypted with `safe` (Electron safeStorage); a 0600
 * plain file only where no keyring exists. `save` returns false when the token could not be written (the old one stays).
 * @param {string} dir
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} safe
 * @param {typeof fs} [fsx]
 */
function tokenStore(dir, safe, fsx = fs) {
  const file = (/** @type {string} */ id, /** @type {string} */ ext) => path.join(dir, `${String(id).replace(/[^\w-]/g, '_')}.${ext}`);
  const remove = (/** @type {string} */ id, exts = ['bin', 'txt']) => { for (const ext of exts) try { fsx.rmSync(file(id, ext), { force: true }); } catch {} };
  return {
    /** @param {string} id @param {string} token */
    save(id, token) {
      if (!token) { remove(id); return true; }
      try {
        fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const enc = safe.isEncryptionAvailable();
        // a temp file, then rename: a write that fails half-way (disk full) never truncates the old token
        const to = file(id, enc ? 'bin' : 'txt'), tmp = `${to}.tmp`;
        try { fsx.writeFileSync(tmp, enc ? safe.encryptString(token) : token, { mode: 0o600 }); fsx.renameSync(tmp, to); } catch (e) { try { fsx.rmSync(tmp, { force: true }); } catch {} throw e; }
        remove(id, [enc ? 'txt' : 'bin']);
        return true;
      } catch { return false; }
    },
    /** @param {string} id */
    load(id) {
      try { return safe.decryptString(fsx.readFileSync(file(id, 'bin'))); } catch {}
      try { return fsx.readFileSync(file(id, 'txt'), 'utf8'); } catch {}
      return '';
    },
    /** @param {string} id */
    has: (id) => fsx.existsSync(file(id, 'bin')) || fsx.existsSync(file(id, 'txt')),
    remove,
  };
}

/** Moves a token between stores (migration). The old one is removed only once the new one is saved. → ok */
function moveToken(from, to, fromId, toId) {
  const token = from.load(fromId);
  if (!token) return true;
  if (!to.save(toId, token)) return false;
  from.remove(fromId);
  return true;
}

/**
 * What the MCP panel lists for one project's Claude Code sessions (v3.44). Names, transport, where each comes from
 * and the host of remote ones; never a URL path, header, env, argument or token.
 * source: 'user' (~/.claude.json mcpServers) | 'local' (~/.claude.json projects[dir]) | 'account' (the account's own
 * .claude.json) | 'project' (.mcp.json; approved: false = Claude Code asks before using it) | 'office' (another
 * project's, v3.9 share) | 'app' (added in Agent Office; scope 'all' | 'project'; shadowed: a server of that name
 * already reaches the session, so this one is not added).
 * @param {{ account: any, home: string, cwd: string | null, office?: any, servers?: any[], projectId: string,
 *   hasToken?: (id: string) => boolean, read?: (file: string) => any }} o
 */
function listing({ account, home, cwd, office = null, servers = [], projectId, hasToken = () => false, read }) {
  const rd = read || ((/** @type {string} */ f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } });
  const plan = SC.mcpPlan({ account, home, cwd, office, read: rd });
  const isDefault = !account?.configDir || path.resolve(account.configDir) === path.resolve(path.join(home, '.claude'));
  const defaultConfig = rd(path.join(home, '.claude.json'));
  const defLocal = isObj(defaultConfig?.projects) && cwd ? defaultConfig.projects[cwd]?.mcpServers : null;
  const host = (c) => (typeOf(c) === 'stdio' ? '' : hostOf(c.url));
  const out = [];
  const seen = new Set();
  const push = (name, c, source, more = {}) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, source, type: typeOf(c), host: host(c), readOnly: true, ...more });
  };
  const picks = plan.own.approvals.filter(Boolean);
  const approved = (n) => !picks.some((p) => p.off.includes(n)) && picks.some((p) => p.all || p.on.includes(n));
  for (const [n, c] of Object.entries(plan.own.local)) push(n, c, isDefault ? 'local' : 'account');
  for (const [n, c] of Object.entries(plan.own.project)) push(n, c, 'project', { approved: approved(n) });
  for (const [n, c] of Object.entries(plan.own.user)) push(n, c, isDefault ? 'user' : 'account');
  for (const [n, c] of Object.entries(plan.servers)) push(n, c, isObj(defLocal) && isObj(defLocal[n]) ? 'local' : isObj(defaultConfig?.mcpServers?.[n]) ? 'user' : 'office');
  for (const s of serversFor(servers, projectId)) {
    const shadowed = seen.has(s.name) || s.name === 'agent-office';
    if (!shadowed) seen.add(s.name);
    out.push({ name: s.name, source: 'app', type: s.type, host: hostOf(s.url), readOnly: false, id: s.id, scope: s.scope === 'all' ? 'all' : 'project', hasToken: Boolean(hasToken(s.id)), ...(shadowed ? { shadowed: true } : {}) });
  }
  return out;
}

module.exports = {
  TYPES, serverName, cleanUrl, hostOf, cleanToken, typeOf, normalizeServers, validate, serversFor, addServer, removeServer,
  dropProject, serverConfig, appConfigs, migrateConnections, tokenStore, moveToken, listing,
};
