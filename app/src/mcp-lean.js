'use strict';
// Lean MCP per session (contract v3.128; no Electron, tested with node --test).
//
// Every MCP server a session gets costs context in that session and in each of its sub-agents: its tool names (the
// deferred tool list) and its server instructions. This module decides which servers a session's --mcp-config file
// holds, by session kind:
// - boss (a project's own tabs): the shared set (Default's servers for another account; other projects' and accounts'
//   servers only when "Share MCP servers between projects" is on, globally or for this project), minus any entry
//   that is the same server (same transport, URL or command, args, headers and env) as one the session already has,
//   plus the app's own servers and the servers Agent Office adds (`extra`). Claude Code also loads the account's own
//   servers by itself.
// - desk (a staff member's tab, also one HQ started): only the project's own servers (local and approved .mcp.json),
//   the member's tools and the project's app servers, plus `extra`; never the shared set. It runs with
//   --strict-mcp-config, so the account's user servers and claude.ai connectors do not load either.
// - hq: only `extra` (the agent-office server), strict (contract v3.46).
// A server the person attached to the project (an app server scoped to it, a member tool) is never dropped here.

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A stable JSON text (sorted keys) of a value. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/** What makes two server entries the same server, whatever their names: transport, URL or command, args, headers, env. */
const identityOf = (s) => stable({
  type: isObj(s) && typeof s.type === 'string' ? s.type : isObj(s) && s.url ? 'http' : 'stdio',
  url: isObj(s) && typeof s.url === 'string' ? s.url : null,
  command: isObj(s) && typeof s.command === 'string' ? s.command : null,
  args: isObj(s) && Array.isArray(s.args) ? s.args : [],
  headers: isObj(s) && isObj(s.headers) ? s.headers : {},
  env: isObj(s) && isObj(s.env) ? s.env : {},
});

/**
 * Drops each entry of `servers` that is the same server as one in `keep` ({ name: config } or a list of configs) or
 * as an earlier entry of `servers`.
 * → { servers, dropped: names }
 */
function dedupeServers(servers, { keep = {} } = {}) {
  const kept = Array.isArray(keep) ? keep : Object.values(isObj(keep) ? keep : {});
  const seen = new Set(kept.map(identityOf));
  const out = {};
  const dropped = [];
  for (const [name, server] of Object.entries(isObj(servers) ? servers : {})) {
    const id = identityOf(server);
    if (seen.has(id)) { dropped.push(name); continue; }
    seen.add(id);
    out[name] = server;
  }
  return { servers: out, dropped };
}

/**
 * Whether a session gets the other projects' and accounts' servers (contract v3.9 "Share MCP servers between
 * projects"): the global setting or the project's own opt-in; never a desk or the HQ session.
 */
const officeShareOn = ({ global = false, project = null, desk = false, hq = false } = {}) =>
  !hq && !desk && (global === true || (isObj(project) && project.shareMcp === true));

/**
 * The global setting as read from state.json. Off unless the person chose it: before v3.128 the app wrote
 * `shareMcp: true` for everyone (the old default), so only a value set after the choice marker counts.
 */
const shareMcpFromFile = (raw) => isObj(raw) && raw.shareMcpChosen === true && raw.shareMcp === true;

/**
 * The app servers (src/mcp-servers.js list) a desk may get: the member's tools (toolIds) and servers scoped to
 * projects, never one attached to every project ('all') unless it is one of the member's tools.
 */
const deskAppServers = (servers, toolIds = []) => (Array.isArray(servers) ? servers : [])
  .filter((s) => isObj(s) && (s.scope !== 'all' || (Array.isArray(toolIds) && toolIds.includes(s.id))));

/**
 * A session's --mcp-config servers. kind: 'boss' | 'desk' | 'hq'. shared: the shared set (mcpPlan servers);
 * own: for a boss the servers Claude Code loads by itself (account user, local, approved project ones), for a desk
 * the project's own servers (they go into the file: a desk is strict); app: the app servers this session gets;
 * extra: the servers Agent Office adds (agent-office, mail).
 * → { servers, strict, dropped: shared names left out as duplicates, shadowed: app names left out (name taken) }
 */
function sessionMcp({ kind = 'boss', shared = {}, own = {}, app = {}, extra = {} } = {}) {
  const obj = (v) => (isObj(v) ? v : {});
  if (kind === 'hq') return { servers: { ...obj(extra) }, strict: true, dropped: [], shadowed: [] };
  const desk = kind === 'desk';
  let servers;
  let dropped = [];
  let taken;
  if (desk) {
    servers = { ...obj(own), ...obj(extra) };
    taken = new Set(Object.keys(servers));
  } else {
    const r = dedupeServers(shared, { keep: [...Object.values(obj(own)), ...Object.values(obj(extra)), ...Object.values(obj(app))] });
    dropped = r.dropped;
    servers = { ...r.servers, ...obj(extra) };
    taken = new Set([...Object.keys(servers), ...Object.keys(obj(own))]);
  }
  const shadowed = [];
  for (const [name, server] of Object.entries(obj(app))) {
    if (taken.has(name)) shadowed.push(name); else { servers[name] = server; taken.add(name); }
  }
  return { servers, strict: desk, dropped, shadowed };
}

module.exports = { identityOf, dedupeServers, officeShareOn, shareMcpFromFile, deskAppServers, sessionMcp };
