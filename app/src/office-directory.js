// The office directory (contract v3.9; no Electron, tested with node --test): every session in the app learns which
// projects the office holds, so "the X project" means X's folder and its MCP servers, without searching the disk.
//
// main writes it per tab to userData/directory/<tab>.json at every pty start and passes the path in
// AGENT_OFFICE_DIRECTORY; the plugin's prompt.compose turns it into a short system prompt section. Names, folders,
// account names and MCP server names only: never a config, header or token. The file lives while its tab's claude
// runs (removed with the tab's MCP file; at app start every one is removed).
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const PROJECTS_MAX = 40;
const MCP_MAX = 20;
const DEFAULT_ACCOUNT_NAME = 'Default'; // the prompt is English; the sidebar translates Default's label itself

/**
 * projects: [{ name, dir, account }] in office order (account: its name); current: this tab's project folder;
 * mcp: { [dir]: string[] } server names as the session sees them (shared-config.js prepareShared mcpNames).
 * The current project comes first and is marked; at most PROJECTS_MAX projects (`more` counts the rest) and
 * MCP_MAX server names each.
 * accounts (contract v3.114): [{ name, mcp }] the other accounts whose user servers the session got (shared-config.js
 * prepareShared accountNames), at most PROJECTS_MAX, MCP_MAX names each; listed only when some.
 * → { format, projects: [{ name, dir, account, mcp, current? }], more?, accounts? }
 * @param {{ projects: { name: string, dir: string, account: string }[], current?: string | null, mcp?: Record<string, string[]>, accounts?: { name: string, mcp: string[] }[] }} o
 */
function officeDirectory({ projects, current = null, mcp = {}, accounts = [] }) {
  const all = (Array.isArray(projects) ? projects : []).filter((p) => p && typeof p.dir === 'string' && p.dir);
  const ordered = [...all.filter((p) => p.dir === current), ...all.filter((p) => p.dir !== current)];
  const out = ordered.slice(0, PROJECTS_MAX).map((p) => ({
    name: String(p.name || path.basename(p.dir)),
    dir: p.dir,
    account: String(p.account || DEFAULT_ACCOUNT_NAME),
    mcp: (Array.isArray(mcp[p.dir]) ? mcp[p.dir] : []).filter((n) => typeof n === 'string' && n).slice(0, MCP_MAX),
    ...(p.dir === current ? { current: true } : {}),
  }));
  const more = ordered.length - out.length;
  const names = (v) => (Array.isArray(v) ? v : []).filter((n) => typeof n === 'string' && n).slice(0, MCP_MAX);
  const accs = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => a && names(a.mcp).length)
    .slice(0, PROJECTS_MAX)
    .map((a) => ({ name: String(a.name || DEFAULT_ACCOUNT_NAME), mcp: names(a.mcp) }));
  return { format: FORMAT, projects: out, ...(more > 0 ? { more } : {}), ...(accs.length ? { accounts: accs } : {}) };
}

/** The account name the directory shows: Default's in English, any other account's own label. */
const accountName = (account) => (!account?.configDir ? DEFAULT_ACCOUNT_NAME : String(account.label || account.id || DEFAULT_ACCOUNT_NAME));

/** Writes the directory (atomically, 0600: it names the user's folders). Returns the file, or null on failure. */
function writeDirectory(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

module.exports = { FORMAT, PROJECTS_MAX, MCP_MAX, DEFAULT_ACCOUNT_NAME, officeDirectory, accountName, writeDirectory };
