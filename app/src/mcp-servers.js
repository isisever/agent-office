// One MCP system (contract v3.44, supersedes the connection parts of v3.42/v3.43). Pure helpers (no Electron).
//
// A project's Claude Code sessions get MCP servers from Claude Code's own files (read-only here: ~/.claude.json
// top-level and projects[dir].mcpServers, the account's .claude.json, the project's approved .mcp.json), from other
// office projects (v3.9 share) and from servers added in Agent Office. The last are kept in state.json as either a
// remote server `{ id, name, type: 'http' | 'sse', url, scope: 'all' | <projectId> }` whose token is in the token
// store below (safeStorage, keyed by the server id), or (v3.59) a stdio/CLI server
// `{ id, name, type: 'stdio', command, args: string[], env: { [k]: string }, scope }` whose command/args/env live in
// state.json: stdio carries no token, and its env is for non-secret values (paths, flags), never a key or password.
// They reach claude through the tab's 0600 --mcp-config
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
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
/**
 * Why an address typed in the add form is refused (v3.44), or null: 'url' (not an http(s) URL), 'url-http' (plain
 * http other than to this computer), 'url-secret' (a user:password@ part or a query string: a key belongs in the
 * token field, which is stored encrypted, not in state.json). Stored and migrated servers are only checked by cleanUrl.
 */
function urlProblem(v) {
  if (!cleanUrl(v)) return 'url';
  const u = new URL(String(v).trim());
  if (u.username || u.password || u.search) return 'url-secret';
  if (u.protocol === 'http:' && !LOOPBACK.includes(u.hostname)) return 'url-http';
  return null;
}
/** The host of an address (never its path, query or credentials), or ''. */
const hostOf = (v) => { try { return new URL(String(v)).host; } catch { return ''; } };

/** The token as typed: trimmed, a pasted leading 'Bearer ' dropped (the header adds it; no 'Bearer Bearer x'). */
const cleanToken = (v) => (typeof v === 'string' ? v.trim().replace(/^bearer\s+/i, '').trim() : '');

/** A stdio server's launch command (v3.59): trimmed, or ''. */
const cleanCommand = (v) => (typeof v === 'string' ? v.trim() : '');
/** stdio args → a clean string[] (non-strings and blank-after-trim dropped), at most 64. */
const cleanArgs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 64) : []);
/** stdio env → { KEY: value } with shell-safe names and string values; non-secret only (kept in state.json), at most 64. */
const cleanEnv = (v) => {
  /** @type {Record<string, string>} */
  const out = {};
  if (isObj(v)) for (const [k, val] of Object.entries(v)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof val === 'string' && Object.keys(out).length < 64) out[k] = val;
  }
  return out;
};

/** A config's transport: its `type`, else 'http' with a url, else 'stdio'. */
const typeOf = (c) => (isObj(c) && typeof c.type === 'string' && c.type ? c.type : isObj(c) && typeof c.url === 'string' ? 'http' : 'stdio');

/**
 * state.json `mcpServers` → the valid entries (unknown fields, a token among them, dropped). A server scoped to a
 * project that is not in `projectIds` is dropped; duplicate ids and duplicate names within one scope too.
 * @param {any} list @param {string[]} [projectIds]
 * @returns {({ id: string, name: string, type: 'http' | 'sse', url: string, scope: string, held?: string }
 *   | { id: string, name: string, type: 'stdio', command: string, args: string[], env: Record<string, string>, scope: string, held?: string })[]}
 */
function normalizeServers(list, projectIds) {
  const known = projectIds ? new Set(projectIds) : null;
  /** @type {({ id: string, name: string, type: 'http' | 'sse', url: string, scope: string, held?: string } | { id: string, name: string, type: 'stdio', command: string, args: string[], env: Record<string, string>, scope: string, held?: string })[]} */
  const out = [];
  const ids = new Set(), names = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || typeof s.id !== 'string' || !/^[\w-]{1,64}$/.test(s.id) || ids.has(s.id)) continue;
    const name = serverName(s.name);
    const stdio = s.type === 'stdio';
    const command = stdio ? cleanCommand(s.command) : '';
    const url = stdio ? '' : cleanUrl(s.url);
    // held: the folder of a project handed off from here (v3.44) — the server waits for it to come back
    const held = typeof s.held === 'string' && s.held && s.scope !== 'all' && (!known || !known.has(s.scope)) ? s.held : null;
    const scope = s.scope === 'all' || (typeof s.scope === 'string' && s.scope && (!known || known.has(s.scope) || held)) ? s.scope : null;
    if (!name || (stdio ? !command : !url) || !scope || names.has(`${scope}\0${name}`)) continue;
    ids.add(s.id); names.add(`${scope}\0${name}`);
    out.push(stdio
      ? { id: s.id, name, type: 'stdio', command, args: cleanArgs(s.args), env: cleanEnv(s.env), scope, ...(held ? { held } : {}) }
      : { id: s.id, name, type: TYPES.includes(s.type) ? s.type : 'http', url, scope, ...(held ? { held } : {}) });
  }
  return out;
}

/** Error code for the add form ('name' | 'command' | 'url' | 'url-http' | 'url-secret' | 'type' | 'scope') or null. */
function validate(f, projectIds = []) {
  if (!serverName(f?.name)) return 'name';
  if (f?.type === 'stdio') {
    if (!cleanCommand(f?.command)) return 'command';
  } else {
    const bad = urlProblem(f?.url);
    if (bad) return bad;
    if (f?.type !== undefined && !TYPES.includes(f.type)) return 'type';
  }
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
  const server = f.type === 'stdio'
    ? { id: newId, name: serverName(f.name), type: 'stdio', command: cleanCommand(f.command), args: cleanArgs(f.args), env: cleanEnv(f.env), scope: f.scope }
    : { id: newId, name: serverName(f.name), type: TYPES.includes(f.type) ? f.type : 'http', url: cleanUrl(f.url), scope: f.scope };
  const clash = servers.some((s) => s.name === server.name && (s.scope === server.scope || s.scope === 'all' || server.scope === 'all'));
  return clash ? { error: 'name-used' } : { servers: [...servers, server], server };
}
const removeServer = (servers, id) => servers.filter((s) => s.id !== id);
/** The servers of a project removed from this machine: → { servers, gone: ids whose token must go } */
function dropProject(servers, projectId) {
  return { servers: servers.filter((s) => s.scope !== projectId), gone: servers.filter((s) => s.scope === projectId).map((s) => s.id) };
}

/**
 * One spelling per folder for `held` (v3.44): absolute, no trailing separator, links resolved when it exists, NFC. The
 * dir saved at handoff and the one a project is added or adopted at compare equal however each was spelled.
 * @param {string} dir
 */
function dirKey(dir) {
  let d = path.resolve(String(dir || ''));
  try { d = fs.realpathSync(d); } catch {}
  d = d.normalize('NFC');
  return d.length > 1 && /[\\/]$/.test(d) && !/^[A-Za-z]:[\\/]$/.test(d) ? d.replace(/[\\/]+$/, '') : d;
}

/**
 * A project handed off from here (v3.44): its own servers and their tokens stay on this machine, held for its folder
 * (`held: dir`), and come back to it when a project at that folder is adopted again (`adoptHeld`).
 */
const holdProject = (servers, projectId, dir) => servers.map((s) => (s.scope === projectId ? { ...s, held: dirKey(dir) } : s));
/**
 * A project arrives at `dir` (handed back, or the folder added again): the servers held for that folder are its own
 * again — except one whose name the project already has a server of; that one stays held (the panel lists it as
 * handed off, where it can be removed).
 */
function adoptHeld(servers, dir, projectId) {
  const key = dirKey(dir);
  const names = new Set(servers.filter((s) => !s.held && s.scope === projectId).map((s) => s.name));
  return servers.map((s) => {
    if (typeof s.held !== 'string' || dirKey(s.held) !== key || names.has(s.name)) return s;
    names.add(s.name);
    const { held, ...rest } = s;
    return { ...rest, scope: projectId };
  });
}

/**
 * The claude MCP entry (lives only in the tab's 0600 MCP file): a remote server with the token as a bearer header, or
 * (v3.59) a stdio server with its command/args/env and no token.
 */
function serverConfig(s, token) {
  if (s.type === 'stdio') return { command: s.command, ...(s.args?.length ? { args: s.args } : {}), ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };
  return { type: s.type, url: s.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
}
/** `{ name: config }` of the app-added servers for a project's Claude Code session (tokenOf(id) → token or ''). */
function appConfigs(servers, projectId, tokenOf) {
  const out = {};
  for (const s of serversFor(servers.filter((x) => !x.held), projectId)) if (!out[s.name]) out[s.name] = serverConfig(s, tokenOf(s.id));
  return out;
}

/**
 * The app-added servers a session of `engine` gets (v3.44, engine-caps `appMcp`): only Claude Code; for any other
 * engine nothing, and no token is read (leak rule).
 */
const sessionServers = (engine, servers, projectId, tokenOf) => (engine === 'claude' ? appConfigs(servers, projectId, tokenOf) : {});

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
    /**
     * → { token, failed }: failed = a stored token is there but could not be read now (decrypt threw: the keychain is
     * locked or access was denied, a re-signed build, a locked keyring, DPAPI; or a read error). Its file is kept.
     * token '' with failed false = nothing stored, or stored empty.
     * @param {string} id
     */
    read(id) {
      let buf = null, failed = false;
      try { buf = fsx.readFileSync(file(id, 'bin')); } catch (e) { if (/** @type {any} */ (e)?.code !== 'ENOENT') failed = true; }
      if (buf) {
        if (buf.length) {
          try { return { token: String(safe.decryptString(buf) || ''), failed: false }; } catch { failed = true; }
        } // empty .bin: a .txt next to it still counts
      }
      try { return { token: fsx.readFileSync(file(id, 'txt'), 'utf8'), failed }; } catch (e) { if (/** @type {any} */ (e)?.code !== 'ENOENT') failed = true; }
      return { token: '', failed };
    },
    /** The token, or '' (nothing stored, or it cannot be read now). @param {string} id */
    load(id) { return this.read(id).token; },
    /** @param {string} id */
    has: (id) => fsx.existsSync(file(id, 'bin')) || fsx.existsSync(file(id, 'txt')),
    /** The ids with a stored token (file names, so ids as `save` wrote them). */
    ids() {
      try { return [...new Set(fsx.readdirSync(dir).filter((f) => /\.(bin|txt)$/.test(f)).map((f) => f.replace(/\.(bin|txt)$/, '')))]; } catch { return []; }
    },
    remove,
  };
}

/**
 * Moves a token between stores (migration). The old one is removed only once the new one is saved. → ok
 * A stored token that cannot be read now (decrypt threw, a read error) is kept and the move fails (→ false), so the
 * next start retries it. Only a token stored empty is final: its file goes, and `dropped` (when given) is called.
 */
function moveToken(from, to, fromId, toId, dropped = () => {}) {
  const { token, failed } = from.read ? from.read(fromId) : { token: from.load(fromId), failed: false };
  if (failed) return false;
  if (!token) {
    if (from.has(fromId)) { from.remove(fromId); dropped(); }
    return true;
  }
  if (!to.save(toId, token)) return false;
  from.remove(fromId);
  return true;
}

const oldIdOf = (pid) => String(pid).replace(/[^\w-]/g, '_');
/** Migrated servers (`c-<projectId>`) whose token is still in the v3.43 store and not yet in the new one. */
const pendingMoves = (servers, from, to) => servers
  .filter((s) => /^c-/.test(s.id) && s.scope !== 'all' && !to.has(s.id) && from.has(s.scope))
  .map((s) => ({ from: s.scope, to: s.id }));
/**
 * At every start (v3.44): retries each token move a previous start could not finish (idempotent; a token that does
 * not decrypt now is kept and counted `failed`, retried next start; one stored empty is dropped), then — with `sweep` (state.json was read whole) — removes the tokens no server
 * needs: new-store ids not in `servers`, old-store ids not waiting for a move (a v3.43 connection whose URL was
 * invalid had no server, so its token goes too). → { moved, failed, dropped, removed }
 */
function settleTokens(servers, from, to, { sweep = true } = {}) {
  let moved = 0, failed = 0, dropped = 0, removed = 0;
  for (const m of pendingMoves(servers, from, to)) {
    let lost = false;
    if (!moveToken(from, to, m.from, m.to, () => { lost = true; })) failed++; else if (lost) dropped++; else moved++;
  }
  if (!sweep) return { moved, failed, dropped, removed };
  const live = new Set(servers.map((s) => s.id));
  for (const id of to.ids()) if (!live.has(id)) { to.remove(id); removed++; }
  const waiting = new Set(pendingMoves(servers, from, to).map((m) => oldIdOf(m.from)));
  for (const id of from.ids()) if (!waiting.has(id)) { from.remove(id); removed++; }
  return { moved, failed, dropped, removed };
}

/**
 * What the MCP panel lists for one project's Claude Code sessions (v3.44). Names, transport, where each comes from
 * and the host of remote ones; never a URL path, header, env, argument or token.
 * source: 'user' (~/.claude.json mcpServers) | 'local' (~/.claude.json projects[dir]) | 'account' (the account's own
 * .claude.json) | 'project' (.mcp.json; approved: false = Claude Code asks before using it) | 'office' (another
 * project's, v3.9 share) | 'app' (added in Agent Office; scope 'all' | 'project'; shadowed: a server of that name
 * already reaches the session, so this one is not added; the same rule as SC.prepareShared: a .mcp.json server that
 * is not approved does not count; bossShadowed: named `agent-office`, so the project's boss tab (`boss`, manager
 * mode) uses Agent Office's own server of that name there, and the other tabs this one). Last, in every project's
 * list, the servers held for a handed-off project (scope 'held', away: true, folder: the folder's last part); no
 * session gets them, and they can be removed here.
 * @param {{ account: any, home: string, cwd: string | null, office?: any, servers?: any[], projectId: string,
 *   boss?: boolean, hasToken?: (id: string) => boolean, read?: (file: string) => any }} o
 */
function listing({ account, home, cwd, office = null, servers = [], projectId, boss = false, hasToken = () => false, read }) {
  const rd = read || ((/** @type {string} */ f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } });
  const plan = SC.mcpPlan({ account, home, cwd, office, read: rd });
  const isDefault = !account?.configDir || path.resolve(account.configDir) === path.resolve(path.join(home, '.claude'));
  const defaultConfig = rd(path.join(home, '.claude.json'));
  const defLocal = isObj(defaultConfig?.projects) && cwd ? defaultConfig.projects[cwd]?.mcpServers : null;
  const host = (c) => (typeOf(c) === 'stdio' ? '' : hostOf(c.url));
  const out = [];
  const seen = new Set();
  const shown = new Set();
  const push = (name, c, source, more = {}) => {
    if (shown.has(name)) return;
    shown.add(name);
    if (more.approved !== false) seen.add(name); // an unapproved .mcp.json server never runs: it shadows nothing
    out.push({ name, source, type: typeOf(c), host: host(c), readOnly: true, ...more });
  };
  const approved = (n) => SC.isApproved(plan.own.approvals, n);
  for (const [n, c] of Object.entries(plan.own.local)) push(n, c, isDefault ? 'local' : 'account');
  for (const [n, c] of Object.entries(plan.own.project)) push(n, c, 'project', { approved: approved(n) });
  for (const [n, c] of Object.entries(plan.own.user)) push(n, c, isDefault ? 'user' : 'account');
  for (const [n, c] of Object.entries(plan.servers)) push(n, c, isObj(defLocal) && isObj(defLocal[n]) ? 'local' : isObj(defaultConfig?.mcpServers?.[n]) ? 'user' : 'office');
  for (const s of serversFor(servers.filter((x) => !x.held), projectId)) {
    const shadowed = seen.has(s.name);
    const bossShadowed = !shadowed && boss && s.name === 'agent-office';
    if (!shadowed) seen.add(s.name);
    out.push({ name: s.name, source: 'app', type: s.type, host: s.type === 'stdio' ? '' : hostOf(s.url), readOnly: false, id: s.id, scope: s.scope === 'all' ? 'all' : 'project', hasToken: Boolean(hasToken(s.id)), ...(shadowed ? { shadowed: true } : {}), ...(bossShadowed ? { bossShadowed: true } : {}) });
  }
  for (const s of servers.filter((x) => x.held)) {
    out.push({ name: s.name, source: 'app', type: s.type, host: s.type === 'stdio' ? '' : hostOf(s.url), readOnly: false, id: s.id, scope: 'held', away: true, folder: path.basename(s.held), hasToken: Boolean(hasToken(s.id)) });
  }
  return out;
}

module.exports = {
  TYPES, serverName, cleanUrl, urlProblem, hostOf, cleanToken, typeOf, normalizeServers, validate, serversFor, addServer, removeServer,
  dropProject, dirKey, holdProject, adoptHeld, serverConfig, appConfigs, sessionServers, migrateConnections, tokenStore, moveToken,
  pendingMoves, settleTokens, listing,
};
