// What every account borrows from the Default account's ~/.claude (no Electron; tested with node --test).
//
// An account other than default runs with its own CLAUDE_CONFIG_DIR, so on its own it would see none of the
// plugins, skills and MCP servers the user installed for plain Claude Code. With the account's "Use Default's
// plugins, skills and MCP servers" setting on (the default), each session start re-syncs them. One mechanism per
// item, each the one Claude Code 2.1.296 loads without touching the user's ~/.claude:
//
// - User MCP servers (~/.claude.json top-level `mcpServers`, headers and tokens included): a `--mcp-config <file>`
//   (scope "dynamic"). Without --strict-mcp-config the account's own servers still load. A dynamic server replaces
//   a user or local one of the same name, so names the account already has (its own user servers, its local servers
//   for the folder) and names in the project's .mcp.json are left out: what the account set up for itself wins, and
//   the project's server wins as it does in Default. The file is 0600 under userData, never on the command line
//   (other processes could read the argv).
// - Plugins (~/.claude/plugins/installed_plugins.json, user scope, enabled in ~/.claude/settings.json): one
//   `--plugin-dir <installPath>` each, loading Default's installed copy directly (no network, no second install in
//   the account, nothing written to the account's plugin registry). A marketplace plugin with `strict: false` has no
//   .claude-plugin/plugin.json (its manifest lives in the marketplace entry, e.g. the LSP plugins) and --plugin-dir
//   would not load it; such a plugin gets a stage folder under userData: plugin.json made from the marketplace
//   entry plus links to the installed copy's files. A plugin the account enabled itself is skipped (--plugin-dir
//   would override it), and so is Agent Office's own plugin (the app passes it already).
//   enabledPlugins + extraKnownMarketplaces in --settings were tried: Claude Code does not install them on its own.
// - Personal skills, agents, commands and output styles (~/.claude/<dir>/<entry>) and ~/.claude/CLAUDE.md: links
//   in the account folder (<config>/<dir>/<entry> → ~/.claude/<dir>/<entry>; Windows: directory junctions, which
//   need no admin rights; files fall back to a hard link, then a copy). Claude Code reads them like its own; edits
//   made through them land in ~/.claude. --add-dir would also load skills, but only skills, and it widens file
//   access. Never linked: skills/synced (each claude.ai account syncs its own skills there) and dot entries. An entry
//   the account already has is never replaced; the links the app made are listed in <config>/MARKER, so a link whose
//   source is gone, or every link when the setting is off, is removed at the next start, and nothing else is.
//
// Other office projects (contract v3.9; every account, Default included, with the "Share MCP servers between
// projects" setting on and, for another account, its share setting on): each other project's local servers (the
// .claude.json of that project's account, plus Default's for an account sharing Default's) and the approved servers
// of its .mcp.json go into the same --mcp-config file. A config the session already has is not added again; a
// name clash with another config is renamed <server>-<project> (Claude Code allows only letters, digits, '-', '_').
// Nothing is ever written to a source file.
//
// Never shared: logins (.credentials.json, keychain, oauthAccount and primaryApiKey in .claude.json), the account's
// own synced skills and plugins, history, projects and transcripts, policy and remote settings, settings.json.
// (A project's own transcripts and state follow it when its account changes: project-data.js, contract v3.16.)
const fs = require('fs');
const path = require('path');

const LINK_DIRS = ['skills', 'agents', 'commands', 'output-styles'];
const LINK_FILES = ['CLAUDE.md'];
const SKIP = { skills: new Set(['synced']) };
const MARKER = '.agent-office-shared.json';
const OWN_PLUGIN = 'agent-office';
// Marketplace entry fields that are not plugin.json fields.
const ENTRY_ONLY = new Set(['source', 'category', 'strict', 'tags', '$schema']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const keysOf = (v) => (isObj(v) ? Object.keys(v) : []);

/** Does this account get Default's plugins, skills and MCP servers? (default: yes; never for Default itself) */
const shareEnabled = (account) => Boolean(account?.configDir) && account.shareDefault !== false;

/** The object-valued entries of an `mcpServers` field. */
function serversOf(v) {
  const out = {};
  for (const [name, server] of Object.entries(isObj(v) ? v : {})) if (isObj(server)) out[name] = server;
  return out;
}
/** A config file's local servers for a folder (`projects[dir].mcpServers`). */
const localServers = (config, dir) => serversOf(isObj(config?.projects) && dir ? config.projects[dir]?.mcpServers : undefined);

/**
 * The --mcp-config object for an account's session in cwd, or null when there is nothing to add: Default's user
 * servers and Default's local servers for cwd (local wins on a name, as in Claude Code).
 * defaultConfig: ~/.claude.json; accountConfig: <config>/.claude.json; projectMcp: <cwd>/.mcp.json.
 * @param {{ defaultConfig: any, accountConfig: any, cwd?: string | null, projectMcp?: any }} o
 */
function sharedMcpServers({ defaultConfig, accountConfig, cwd, projectMcp }) {
  const src = { ...serversOf(defaultConfig?.mcpServers), ...localServers(defaultConfig, cwd) };
  const taken = new Set([...keysOf(accountConfig?.mcpServers), ...keysOf(localServers(accountConfig, cwd)), ...keysOf(projectMcp?.mcpServers)]);
  const out = {};
  for (const [name, server] of Object.entries(src)) if (!taken.has(name)) out[name] = server;
  return Object.keys(out).length ? { mcpServers: out } : null;
}

// ---- MCP servers of the other projects in the office (contract v3.9)

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * The servers of <folder>/.mcp.json that the folder's own sessions run: approved (by name in
 * enabledMcpjsonServers, or enableAllProjectMcpServers) and not disabled (disabledMcpjsonServers) in any of
 * `sources` (the folder's .claude/settings.local.json, the account's settings.json, its .claude.json projects[dir]).
 * A server nobody approved is never run elsewhere: the project's .mcp.json may come from a cloned repository.
 */
function approvedProjectServers(projectMcp, sources = []) {
  const src = sources.filter(isObj);
  const all = src.some((s) => s.enableAllProjectMcpServers === true);
  const on = new Set(src.flatMap((s) => list(s.enabledMcpjsonServers)));
  const off = new Set(src.flatMap((s) => list(s.disabledMcpjsonServers)));
  const out = {};
  for (const [name, server] of Object.entries(serversOf(projectMcp?.mcpServers))) {
    if (!off.has(name) && (all || on.has(name))) out[name] = server;
  }
  return out;
}

/**
 * The project-level servers a project's own session has in dir: the account's local servers, Default's local
 * servers (only for an account other than Default that shares Default's; names the account has win) and the
 * approved servers of dir/.mcp.json; local wins over project, as in Claude Code.
 * accountConfig: the .claude.json of the project's account (Default: ~/.claude.json); defaultConfig: ~/.claude.json
 * when the account shares Default's, else null.
 * @param {{ dir: string, accountConfig: any, defaultConfig?: any, projectMcp?: any, approvals?: any[] }} o
 */
function projectServers({ dir, accountConfig, defaultConfig = null, projectMcp = null, approvals = [] }) {
  const own = localServers(accountConfig, dir);
  const fromDefault = {};
  const taken = new Set([...keysOf(accountConfig?.mcpServers), ...keysOf(own), ...keysOf(projectMcp?.mcpServers)]);
  for (const [name, server] of Object.entries(localServers(defaultConfig, dir))) if (!taken.has(name)) fromDefault[name] = server;
  return { ...approvedProjectServers(projectMcp, approvals), ...fromDefault, ...own };
}

// A stdio server runs in the folder of the session that starts it, so a relative command or path argument written
// for one project (`"command": "./venv/bin/python"`) fails with ENOENT in another project's tab. A server shared
// from a folder other than the session's own gets them made absolute against that folder: a command that starts
// with ./ or ../ or holds a path separator (bare names like npx, uvx or python3 are looked up on PATH and stay, and so
// do ~ and ${VAR} paths, which Claude Code expands itself), and an argument that starts with ./ or ../ and exists there. Claude Code's stdio config has no cwd field (2.1.296:
// type, command, args, env, timeout, alwaysLoad), so none is added. The source config is never changed.
const isRelativePath = (v) => /^\.\.?[\\/]/.test(v);
const isRelativeCommand = (v) =>
  !path.isAbsolute(v) && !path.win32.isAbsolute(v) && !/^~|\$/.test(v) && (isRelativePath(v) || /[\\/]/.test(v));
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/** A server config with its relative command and path arguments made absolute against dir (same object if none). */
function resolveServerPaths(server, dir, { exists: has = exists } = {}) {
  if (!isObj(server) || !dir || (server.type !== undefined && server.type !== 'stdio')) return server;
  const out = { ...server };
  let changed = false;
  if (typeof server.command === 'string' && server.command && isRelativeCommand(server.command)) {
    out.command = path.resolve(dir, server.command);
    changed = true;
  }
  if (Array.isArray(server.args)) {
    const args = server.args.map((a) => (typeof a === 'string' && isRelativePath(a) && has(path.resolve(dir, a)) ? path.resolve(dir, a) : a));
    if (args.some((a, i) => a !== server.args[i])) { out.args = args; changed = true; }
  }
  return changed ? out : server;
}
/** Every server of a { name: config } map resolved against dir (see resolveServerPaths). */
function resolveServers(servers, dir, opts) {
  const out = {};
  for (const [name, server] of Object.entries(servers)) out[name] = resolveServerPaths(server, dir, opts);
  return out;
}

/** JSON with sorted keys: two configs are the same server when these match. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

// Claude Code accepts letters, digits, '-' and '_' in a server name (`claude mcp add 'a@b'`: "Invalid name"; 2.1.296);
// tool names are mcp__<server>__<tool>, so a renamed server stays short.
const NAME_MAX = 48;
const slugOf = (name) => String(name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

/**
 * The other projects' servers for one session. have: every server the session already gets ({ name: config }:
 * its account's user servers, its local and project servers, what --mcp-config adds from Default). others:
 * [{ key, name, servers }] in office order. A server whose config the session already has is not added and keeps
 * that name; a new one keeps its name unless the session has that name with another config: then it becomes
 * `<server>-<project>` (`-2`, `-3`… if that is taken too).
 * → { servers: { name: config } to add, names: { [key]: string[] } each project's servers as the session sees them }
 * @param {{ have: Record<string, any>, others: { key: string, name: string, servers: Record<string, any> }[] }} o
 */
function officeMcpServers({ have, others }) {
  const taken = new Map();
  const byConfig = new Map();
  const take = (name, config) => {
    taken.set(name, config);
    if (!byConfig.has(config)) byConfig.set(config, name);
  };
  for (const [name, server] of Object.entries(have)) take(name, canonical(server));
  const servers = {};
  const names = {};
  for (const p of others) {
    const seen = [];
    for (const [name, server] of Object.entries(p.servers)) {
      const config = canonical(server);
      let as = taken.get(name) === config ? name : byConfig.get(config);
      if (!as) {
        as = name;
        if (taken.has(as)) {
          const base = `${name}-${slugOf(p.name)}`.slice(0, NAME_MAX);
          as = base;
          for (let i = 2; taken.has(as); i++) as = `${base}-${i}`;
        }
        servers[as] = server;
        take(as, config);
      }
      if (!seen.includes(as)) seen.push(as);
    }
    names[p.key] = seen;
  }
  return { servers, names };
}

const pluginName = (key) => (key.lastIndexOf('@') > 0 ? key.slice(0, key.lastIndexOf('@')) : key);
const pluginMarketplace = (key) => (key.lastIndexOf('@') > 0 ? key.slice(key.lastIndexOf('@') + 1) : '');
const enabled = (v) => Boolean(v) && v !== false;

/**
 * Default's user-scope plugins that are enabled, minus Agent Office's own and those the account enabled itself
 * (by name, as --plugin-dir overrides by name). installed: installed_plugins.json; settings: settings.json.
 * syncedDir: Default's claude.ai-synced plugins folder, never shared. → [{ key, name, marketplace, installPath }]
 * @param {{ installed: any, settings: any, accountInstalled?: any, accountSettings?: any, syncedDir?: string | null }} o
 */
function sharedPlugins({ installed, settings, accountInstalled, accountSettings, syncedDir = null }) {
  const on = isObj(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  const accOn = isObj(accountSettings?.enabledPlugins) ? accountSettings.enabledPlugins : {};
  const accInstalled = isObj(accountInstalled?.plugins) ? accountInstalled.plugins : {};
  const own = new Set(Object.keys(accInstalled).filter((k) => enabled(accOn[k])).map(pluginName));
  const inSynced = (p) => syncedDir && (p === syncedDir || p.startsWith(syncedDir + path.sep) || p.startsWith(syncedDir + '/'));
  const out = [];
  const seen = new Set();
  for (const [key, list] of Object.entries(isObj(installed?.plugins) ? installed.plugins : {})) {
    if (!enabled(on[key]) || !Array.isArray(list)) continue;
    const rec = list.find((r) => isObj(r) && r.scope === 'user' && typeof r.installPath === 'string' && r.installPath);
    const name = pluginName(key);
    if (!rec || name === OWN_PLUGIN || own.has(name) || seen.has(name) || inSynced(rec.installPath)) continue;
    seen.add(name);
    out.push({ key, name, marketplace: pluginMarketplace(key), installPath: rec.installPath });
  }
  return out;
}

/** plugin.json for a `strict: false` marketplace entry (its manifest is the entry itself). */
function pluginManifest(entry) {
  const out = {};
  for (const [k, v] of Object.entries(isObj(entry) ? entry : {})) if (!ENTRY_ONLY.has(k)) out[k] = v;
  return out;
}

/** Stage folder name for a plugin key: safe on every file system. */
const stageName = (key) => String(key).replace(/[^A-Za-z0-9._@-]/g, '-');

/**
 * Links to make in the account folder. listing: { skills: string[], agents: string[], commands: string[],
 * 'output-styles': string[], files: string[] } (entry names present in ~/.claude). → [{ rel, target }], rel with '/'.
 */
function linkPlan(listing, claudeDir) {
  const out = [];
  for (const dir of LINK_DIRS) {
    for (const name of Array.isArray(listing?.[dir]) ? listing[dir] : []) {
      if (typeof name !== 'string' || !name || name.startsWith('.') || SKIP[dir]?.has(name)) continue;
      out.push({ rel: `${dir}/${name}`, target: path.join(claudeDir, dir, name) });
    }
  }
  for (const f of LINK_FILES) if (listing?.files?.includes(f)) out.push({ rel: f, target: path.join(claudeDir, f) });
  return out;
}

// ---- file system

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
// Windows reports junction targets as \\?\C:\… on some versions.
const samePath = (a, b) => path.resolve(String(a).replace(/^\\\\\?\\/, '')) === path.resolve(String(b).replace(/^\\\\\?\\/, ''));

/** What linkPlan needs from ~/.claude. */
function listClaudeDir(claudeDir) {
  const listing = { files: LINK_FILES.filter((f) => lstat(path.join(claudeDir, f))) };
  for (const dir of LINK_DIRS) listing[dir] = names(path.join(claudeDir, dir));
  return listing;
}

/** Link (or, for a Windows file without symlink rights, hard link, then copy) abs → target. */
function makeLink(target, abs, platform = process.platform) {
  if (platform !== 'win32') return fs.symlinkSync(target, abs);
  let isDir = false;
  try { isDir = fs.statSync(target).isDirectory(); } catch {}
  if (isDir) return fs.symlinkSync(target, abs, 'junction');
  try { fs.symlinkSync(target, abs, 'file'); } catch {
    try { fs.linkSync(target, abs); } catch { fs.copyFileSync(target, abs); }
  }
}

/** Removes a link or file the app made; never follows a link into its target, never removes a real folder. */
function removeOwned(abs) {
  const st = lstat(abs);
  if (!st) return true;
  if (!st.isSymbolicLink() && st.isDirectory()) return false;
  try { fs.unlinkSync(abs); return true; } catch {}
  try { fs.rmdirSync(abs); return true; } catch { return false; } // a Windows junction
}

/**
 * Brings dir's links in line with plan ([{ rel, target }]); the links made here are listed in dir/marker.
 * An entry not made here is never touched. Returns the rels that are now links made here.
 */
function syncLinks(dir, plan, { marker = MARKER, platform = process.platform } = {}) {
  const markerFile = path.join(dir, marker);
  const prev = readJson(markerFile);
  const owned = new Set(Array.isArray(prev) ? prev.filter((r) => typeof r === 'string') : []);
  const abs = (rel) => path.join(dir, ...rel.split('/'));
  const want = new Map(plan.map((p) => [p.rel, p.target]));
  for (const rel of [...owned]) {
    if (want.has(rel)) continue;
    removeOwned(abs(rel)); // false: a real folder now, the user's, left alone
    owned.delete(rel);
  }
  for (const [rel, target] of want) {
    const p = abs(rel);
    const st = lstat(p);
    if (st && !owned.has(rel)) continue; // the account's own entry wins
    if (st) {
      if (st.isSymbolicLink()) {
        let cur = null;
        try { cur = fs.readlinkSync(p); } catch {}
        if (cur && samePath(path.resolve(path.dirname(p), cur), target)) continue;
      } else if (st.isDirectory()) { owned.delete(rel); continue; }
      if (!removeOwned(p)) continue;
    }
    if (!lstat(target)) { owned.delete(rel); continue; }
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      makeLink(target, p, platform);
      owned.add(rel);
    } catch { owned.delete(rel); }
  }
  const list = [...owned].sort();
  if (list.length || Array.isArray(prev)) {
    try {
      if (list.length) fs.writeFileSync(markerFile, JSON.stringify(list));
      else fs.rmSync(markerFile, { force: true });
    } catch {}
  }
  return list;
}

const hasManifest = (dir) => Boolean(lstat(path.join(dir, '.claude-plugin', 'plugin.json')));

/** The marketplace entry of a plugin, from the marketplace Default installed it from. */
function marketplaceEntry(pluginsDir, marketplace, name) {
  const known = readJson(path.join(pluginsDir, 'known_marketplaces.json'));
  const loc = known?.[marketplace]?.installLocation;
  if (typeof loc !== 'string') return null;
  const m = readJson(path.join(loc, '.claude-plugin', 'marketplace.json'));
  return Array.isArray(m?.plugins) ? m.plugins.find((p) => p?.name === name) || null : null;
}

/** Stage folder for a plugin without its own plugin.json: the manifest plus links to its files. */
function stagePlugin(stageRoot, plugin, entry, platform = process.platform) {
  const dir = path.join(stageRoot, stageName(plugin.key));
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  const json = JSON.stringify(pluginManifest(entry), null, 2);
  const mf = path.join(dir, '.claude-plugin', 'plugin.json');
  let cur = null;
  try { cur = fs.readFileSync(mf, 'utf8'); } catch {}
  if (cur !== json) fs.writeFileSync(mf, json);
  const plan = names(plugin.installPath)
    .filter((n) => n !== '.claude-plugin' && n !== '.git' && n !== MARKER)
    .map((n) => ({ rel: n, target: path.join(plugin.installPath, n) }));
  syncLinks(dir, plan, { platform });
  return dir;
}

/** Removes stage folders no longer needed (only what the app made: links, the manifest, the marker). */
function pruneStages(stageRoot, keep) {
  for (const n of names(stageRoot)) {
    if (keep.has(n)) continue;
    const dir = path.join(stageRoot, n);
    if (lstat(dir)?.isSymbolicLink()) continue;
    syncLinks(dir, []);
    try { fs.rmSync(path.join(dir, '.claude-plugin', 'plugin.json'), { force: true }); } catch {}
    try { fs.rmdirSync(path.join(dir, '.claude-plugin')); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
}

/** Default's plugins for an account sharing them: --plugin-dir folders (installed copies or stage folders). */
function sharedPluginDirs({ claudeDir, configDir, stageRoot, platform }) {
  const pluginsDir = path.join(claudeDir, 'plugins');
  const base = {
    installed: readJson(path.join(pluginsDir, 'installed_plugins.json')),
    settings: readJson(path.join(claudeDir, 'settings.json')),
    syncedDir: path.join(pluginsDir, 'synced'),
  };
  const all = sharedPlugins(base);
  const mine = new Set(sharedPlugins({
    ...base,
    accountInstalled: readJson(path.join(configDir, 'plugins', 'installed_plugins.json')),
    accountSettings: readJson(path.join(configDir, 'settings.json')),
  }).map((p) => p.key));
  const pluginDirs = [];
  const stages = new Set();
  for (const p of all) {
    if (!lstat(p.installPath)) continue;
    if (hasManifest(p.installPath)) { if (mine.has(p.key)) pluginDirs.push(p.installPath); continue; }
    const entry = marketplaceEntry(pluginsDir, p.marketplace, p.name);
    if (!entry) continue;
    stages.add(stageName(p.key));
    try {
      const dir = stagePlugin(stageRoot, p, entry, platform);
      if (mine.has(p.key)) pluginDirs.push(dir);
    } catch {}
  }
  pruneStages(stageRoot, stages);
  return pluginDirs;
}

/** The files a project's own session reads its project-level servers from (see projectServers). */
function readProjectServers({ home, dir, configDir, share, read = readJson }) {
  const claudeDir = path.join(home, '.claude');
  const isDefault = !configDir || samePath(configDir, claudeDir);
  const defaultFile = path.join(home, '.claude.json');
  const accountConfig = read(isDefault ? defaultFile : path.join(configDir, '.claude.json'));
  return projectServers({
    dir,
    accountConfig,
    defaultConfig: !isDefault && share ? read(defaultFile) : null,
    projectMcp: read(path.join(dir, '.mcp.json')),
    approvals: [
      read(path.join(dir, '.claude', 'settings.local.json')),
      read(path.join(isDefault ? claudeDir : configDir, 'settings.json')),
      isObj(accountConfig?.projects) ? accountConfig.projects[dir] : null,
    ],
  });
}

/**
 * The MCP side of prepareShared, reading only: what the tab's --mcp-config holds and the names for the office
 * directory. Also what a running tab's MCP fingerprint is made of (see mcpFingerprint).
 * → { servers: { name: config }, mcpNames, own: { user, local, project, approvals } } (own: the session's own
 * servers, which Claude Code loads by itself). Another project's servers come with their relative paths resolved
 * against that project's folder (resolveServerPaths).
 */
function mcpPlan({ account, home, cwd, office = null, read = readJson, exists: has = exists }) {
  const configDir = account?.configDir;
  const claudeDir = path.join(home, '.claude');
  const isDefault = !configDir || samePath(configDir, claudeDir);
  const on = !isDefault && shareEnabled(account);
  const defaultConfig = read(path.join(home, '.claude.json'));
  const accountConfig = isDefault ? defaultConfig : read(path.join(configDir, '.claude.json'));
  const projectMcp = cwd ? read(path.join(cwd, '.mcp.json')) : null;
  const shared = on ? sharedMcpServers({ defaultConfig, accountConfig, cwd, projectMcp })?.mcpServers || {} : {};
  const mcpNames = {};
  let added = {};
  const projects = Array.isArray(office?.projects) ? office.projects.filter((p) => isObj(p) && typeof p.dir === 'string' && p.dir) : [];
  if (office?.current && cwd) {
    mcpNames[office.current] = Object.keys(readProjectServers({ home, dir: cwd, configDir: isDefault ? null : configDir, share: on, read }));
  }
  if (office?.share && (isDefault || on)) {
    const have = {
      ...serversOf(accountConfig?.mcpServers), ...serversOf(projectMcp?.mcpServers), ...localServers(accountConfig, cwd), ...shared,
    };
    const others = projects
      .filter((p) => p.dir !== office.current)
      .map((p) => ({ key: p.dir, name: String(p.name || path.basename(p.dir)), servers: resolveServers(readProjectServers({ home, dir: p.dir, configDir: p.configDir, share: p.share !== false, read }), p.dir, { exists: has }) }));
    const r = officeMcpServers({ have, others });
    added = r.servers;
    Object.assign(mcpNames, r.names);
  }
  const entry = isObj(accountConfig?.projects) && cwd ? accountConfig.projects[cwd] : null;
  const pick = (o) => (isObj(o) ? { all: o.enableAllProjectMcpServers === true, on: list(o.enabledMcpjsonServers), off: list(o.disabledMcpjsonServers) } : null);
  const own = {
    user: serversOf(accountConfig?.mcpServers),
    local: localServers(accountConfig, cwd),
    project: serversOf(projectMcp?.mcpServers),
    approvals: [
      pick(entry),
      pick(cwd ? read(path.join(cwd, '.claude', 'settings.local.json')) : null),
      pick(read(path.join(isDefault ? claudeDir : configDir, 'settings.json'))),
    ],
  };
  return { servers: { ...shared, ...added }, mcpNames, own };
}

/**
 * A tab's MCP fingerprint (contract v3.11): a hash of the servers its claude loads (its own user, local and project
 * servers with their approvals, and the --mcp-config servers) and nothing else, so an unrelated edit of
 * ~/.claude.json (history, tips, window sizes) leaves it alone. Only the hash is kept, never the configs.
 */
const mcpFingerprint = (plan) =>
  require('crypto').createHash('sha256').update(canonical({ servers: plan.servers, own: plan.own })).digest('hex');

/**
 * Prepares one session (call at every pty start): for an account other than Default, syncs the links and the
 * plugin stages; for every account, writes the tab's MCP file. home: the user's home; cwd: the session's folder;
 * stageRoot: userData folder for plugin stages; mcpFile: where this tab's --mcp-config goes.
 * office (contract v3.9): { share, current, projects: [{ name, dir, configDir, share }] }: every office project
 * (configDir null for Default; share: its account uses Default's), current: this tab's project folder, share: the
 * "Share MCP servers between projects" setting. The other projects' servers are added when it is on and the
 * session's account takes shared servers (Default always; another account with its share setting on).
 * Off (or Default) for Default's set: removes what the app made in the account folder. No server to add: no file.
 * → { pluginDirs: string[], mcpConfig: string | null, mcpNames: { [projectDir]: string[] } } (mcpNames: each
 * project's servers by the names this session sees; the current project's own ones under `current`)
 * extra (contract v3.35): servers the app adds itself (the boss tab's `agent-office` server), after mcpPlan: never part
 * of the MCP fingerprint (mcpFingerprint reads mcpPlan only) and never in the office directory.
 * app (contract v3.44, src/mcp-servers.js): servers added in Agent Office. One is added only when no server of its
 * name reaches the session already (the account's user and local servers, the project's .mcp.json, Default's shared
 * ones, other projects', `extra`): what Claude Code's own files define wins. → also appShadowed (only when some): the names left out.
 */
function prepareShared({ account, home, cwd, stageRoot, mcpFile, office = null, platform = process.platform, extra = null, app = null }) {
  const configDir = account?.configDir;
  const claudeDir = path.join(home, '.claude');
  const isDefault = !configDir || samePath(configDir, claudeDir);
  const on = !isDefault && shareEnabled(account);
  let pluginDirs = [];
  if (!isDefault) {
    syncLinks(configDir, on ? linkPlan(listClaudeDir(claudeDir), claudeDir) : [], { platform });
    if (on) pluginDirs = sharedPluginDirs({ claudeDir, configDir, stageRoot, platform });
  }
  const { servers: planned, mcpNames, own } = mcpPlan({ account, home, cwd, office });
  const servers = { ...planned, ...(extra || {}) };
  const taken = new Set([...Object.keys(servers), ...keysOf(own.user), ...keysOf(own.local), ...keysOf(own.project)]);
  const appShadowed = [];
  for (const [name, server] of Object.entries(isObj(app) ? app : {})) {
    if (taken.has(name)) appShadowed.push(name); else { servers[name] = server; taken.add(name); }
  }
  let mcpConfig = null;
  try {
    if (Object.keys(servers).length) {
      fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
      const tmp = `${mcpFile}.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
      fs.renameSync(tmp, mcpFile);
      mcpConfig = mcpFile;
    } else fs.rmSync(mcpFile, { force: true });
  } catch {}
  return { pluginDirs, mcpConfig, mcpNames, ...(appShadowed.length ? { appShadowed } : {}) };
}

// ---- the per-tab MCP files hold tokens: each lives only while its tab's claude runs

const mcpFileName = (key) => `${key}.json`;

/** The files in the MCP folder that belong to no running tab (names: the folder's entries; liveKeys: tab keys). */
const staleMcpFiles = (names, liveKeys) => {
  const live = new Set([...liveKeys].map(mcpFileName));
  return names.filter((n) => !live.has(n));
};

/** Removes the MCP files of tabs that are not running (at app start: all of them). Returns the removed names. */
function pruneMcpFiles(dir, liveKeys = []) {
  const gone = [];
  for (const n of staleMcpFiles(names(dir), liveKeys)) {
    try { fs.rmSync(path.join(dir, n), { force: true }); gone.push(n); } catch {}
  }
  return gone;
}

/** The claude arguments for prepareShared's result. */
const sharedArgs = ({ pluginDirs = [], mcpConfig }) => [
  ...pluginDirs.flatMap((d) => ['--plugin-dir', d]),
  ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
];

module.exports = {
  MARKER, shareEnabled, sharedMcpServers, resolveServerPaths, resolveServers, approvedProjectServers, projectServers, officeMcpServers, canonical, slugOf,
  sharedPlugins, pluginManifest, stageName, linkPlan, listClaudeDir,
  syncLinks, stagePlugin, prepareShared, mcpPlan, mcpFingerprint, sharedArgs, mcpFileName, staleMcpFiles, pruneMcpFiles,
};
