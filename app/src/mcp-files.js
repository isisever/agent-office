// Edit an MCP server in Claude Code's own files (contract v3.69). Pure helpers plus one atomic file write; no Electron.
//
// The MCP panel lists servers from Claude Code's files (v3.44): the account's .claude.json (top-level `mcpServers` =
// user, `projects[dir].mcpServers` = local), Default's ~/.claude.json shared into another account, and the project's
// .mcp.json. Those rows carry `where` ('user' | 'local' | 'default-user' | 'default-local' | 'project'), and main edits
// exactly that one entry: it reads the file again right before writing, changes only that key (every other key and
// every other field of the entry stay), and writes it atomically (temp file + rename, the file's mode kept).
// Servers of another office project (v3.9 share) are edited in that project.
//
// Secrets never reach the renderer: header and env VALUES are sent as MASK (their names only), a URL with a
// user:password@ part or a query comes back as '' (urlHidden). A value still MASK on save, a blank address, keep the
// stored one. Args are sent as they are (the form needs them; they are the user's own command line).
const fs = require('fs');
const path = require('path');
const MS = require('./mcp-servers.js');

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const WHERE = ['user', 'local', 'default-user', 'default-local', 'project'];
/** What the form shows instead of a stored header or env value. */
const MASK = '••••••';
/** A server name as Claude Code keys it (letters, digits, _ . -); unlike app servers, the case is kept. */
const NAME_RE = /^[\w.-]{1,64}$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The file and the key path of the server map for `where`. → { file, keys } or null (no folder for a local/project
 * server, unknown where). keys: ['mcpServers'] or ['projects', cwd, 'mcpServers'].
 * @param {{ where: string, account: any, home: string, cwd: string | null }} o
 */
function target({ where, account, home, cwd }) {
  const def = path.join(home, '.claude.json');
  const own = account?.configDir ? path.join(account.configDir, '.claude.json') : def;
  switch (where) {
    case 'user': return { file: own, keys: ['mcpServers'] };
    case 'default-user': return { file: def, keys: ['mcpServers'] };
    case 'local': return cwd ? { file: own, keys: ['projects', cwd, 'mcpServers'] } : null;
    case 'default-local': return cwd ? { file: def, keys: ['projects', cwd, 'mcpServers'] } : null;
    case 'project': return cwd ? { file: path.join(cwd, '.mcp.json'), keys: ['mcpServers'] } : null;
    default: return null;
  }
}

/** The server map at `keys` in a parsed config, or null. */
function mapAt(config, keys) {
  let o = config;
  for (const k of keys) { if (!isObj(o)) return null; o = o[k]; }
  return isObj(o) ? o : null;
}

const masked = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([, v]) => typeof v === 'string').map(([k]) => [k, MASK]));

/**
 * What the edit form is filled with for one file server: never a header or env value, never an address with a key.
 * remote { name, type, url, urlHidden?, headers: { Name: MASK } } | stdio { name, type: 'stdio', command, args, env: { KEY: MASK } }
 */
function editable(name, conf) {
  if (MS.typeOf(conf) === 'stdio') {
    return { name, type: 'stdio', command: typeof conf.command === 'string' ? conf.command : '', args: Array.isArray(conf.args) ? conf.args.filter((a) => typeof a === 'string') : [], env: masked(conf.env) };
  }
  const url = typeof conf.url === 'string' ? conf.url : '';
  const hidden = Boolean(url) && MS.urlDisplaySecret(url);
  return { name, type: conf.type === 'sse' ? 'sse' : 'http', url: hidden ? '' : url, ...(hidden ? { urlHidden: true } : {}), headers: masked(conf.headers) };
}

/** { k: v } from the form, MASK values replaced by the stored ones (a MASK with nothing stored is dropped). */
function unmask(typed, stored, re) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isObj(typed)) return { out };
  for (const [k, v] of Object.entries(typed)) {
    if (!re.test(k) || typeof v !== 'string') return { bad: k };
    if (v === MASK) { if (isObj(stored) && typeof stored[k] === 'string') out[k] = stored[k]; } else out[k] = v;
  }
  return { out };
}

/**
 * Applies the form to the server `name` in `config` (a parsed file; not changed). → { config, name } (the next
 * config and the server's name in it) | { error }: 'unknown' (no such server), 'name', 'name-used' (another server
 * in the same map has it), 'command', 'url', 'url-http', 'url-secret', 'header', 'env'. The entry keeps every field
 * the form does not show (timeout, oauth…); a change of transport drops the old transport's fields.
 * @param {any} config @param {string[]} keys @param {string} name @param {any} f
 */
function applyEdit(config, keys, name, f) {
  const map = mapAt(config, keys);
  const before = map?.[name];
  if (!isObj(before)) return { error: 'unknown' };
  const next = String(f?.name || '').trim();
  if (!NAME_RE.test(next)) return { error: 'name' };
  if (next !== name && Object.prototype.hasOwnProperty.call(map, next)) return { error: 'name-used' };
  /** @type {Record<string, any>} */
  let entry;
  if (f?.type === 'stdio') {
    const command = typeof f.command === 'string' ? f.command.trim() : '';
    if (!command) return { error: 'command' };
    const args = Array.isArray(f.args) ? f.args.filter((a) => typeof a === 'string').map((a) => a.trim()).filter(Boolean) : [];
    const env = unmask(f.env, before.env, ENV_RE);
    if (env.bad !== undefined) return { error: 'env' };
    const { url, headers, type, ...rest } = before;
    entry = { ...rest, type: 'stdio', command, args, env: env.out };
    if (!args.length) delete entry.args;
    if (!Object.keys(env.out).length) delete entry.env;
    if (before.type === undefined) delete entry.type; // Claude Code's own default spelling: no type means stdio
  } else {
    const typed = String(f?.url || '').trim();
    const stored = MS.typeOf(before) !== 'stdio' && typeof before.url === 'string' ? before.url : '';
    const kept = Boolean(stored) && (!typed || typed === stored);
    const url = kept ? stored : typed;
    const bad = kept ? null : MS.urlProblem(url);
    if (bad) return { error: bad };
    const headers = unmask(f?.headers, before.headers, HEADER_RE);
    if (headers.bad !== undefined) return { error: 'header' };
    const { command, args, env, ...rest } = before;
    entry = { ...rest, type: f?.type === 'sse' ? 'sse' : 'http', url, headers: headers.out };
    if (!Object.keys(headers.out).length) delete entry.headers;
  }
  const out = structuredClone(config);
  const m = mapAt(out, keys);
  // the same key order, the renamed one in its old place
  const rebuilt = Object.fromEntries(Object.entries(m).map(([k, v]) => (k === name ? [next, entry] : [k, v])));
  for (const k of Object.keys(m)) delete m[k];
  Object.assign(m, rebuilt);
  return { config: out, name: next };
}

/** The indent the file is written with (two spaces when it cannot tell), so an edit does not reformat the whole file. */
function indentOf(text) {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : 2;
}

/** How many times editFile re-applies the edit when the file changes under it before giving up. */
const MAX_ATTEMPTS = 4;

/**
 * Reads `file` again, applies the form, writes it back atomically (temp + rename, its mode kept; a link is written
 * through to its target). Claude Code writes the same files continuously, so this is a compare-and-swap: right before
 * the rename the file is read once more, and if its bytes differ from the copy that was edited, the edit is re-applied
 * to the fresh content (bounded retries; then it throws, the file untouched) so a concurrent write is never clobbered.
 * → { ok: true, name } | { ok: false, error } ('read' when the file is not there or not JSON, 'write' when it could not
 * be written; the file is then unchanged by us). Throws when the file kept changing for MAX_ATTEMPTS reads.
 * @param {string} file @param {string[]} keys @param {string} name @param {any} f @param {typeof fs} [fsx]
 */
function editFile(file, keys, name, f, fsx = fs) {
  let real = file;
  try { real = fsx.realpathSync(file); } catch { return { ok: false, error: 'read' }; }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let text;
    try { text = fsx.readFileSync(real, 'utf8'); } catch { return { ok: false, error: 'read' }; }
    let config;
    try { config = JSON.parse(text); } catch { return { ok: false, error: 'read' }; }
    const r = applyEdit(config, keys, name, f);
    if (!r.config) return { ok: false, error: r.error };
    let mode = 0o600;
    try { mode = fsx.statSync(real).mode & 0o777; } catch {}
    const tmp = `${real}.agent-office-${process.pid}.tmp`;
    let unchanged = false;
    try {
      fsx.writeFileSync(tmp, JSON.stringify(r.config, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : ''), { mode });
      fsx.chmodSync(tmp, mode); // writeFileSync's mode is masked by the umask
      unchanged = fsx.readFileSync(real, 'utf8') === text; // the compare of the compare-and-swap, as late as possible
      // A sub-millisecond window stays open between this compare and the rename; rename is the only atomic primitive
      // (POSIX has no compare-and-rename) and Claude Code takes no lock here, so this cannot be fully closed.
      if (unchanged) fsx.renameSync(tmp, real);
    } catch { try { fsx.rmSync(tmp, { force: true }); } catch {} return { ok: false, error: 'write' }; }
    if (unchanged) return { ok: true, name: r.name };
    try { fsx.rmSync(tmp, { force: true }); } catch {}
  }
  throw new Error(`${real} kept changing while it was edited (${MAX_ATTEMPTS} attempts); nothing was written`);
}

module.exports = { WHERE, MASK, target, mapAt, editable, applyEdit, editFile };
