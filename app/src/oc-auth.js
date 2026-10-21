// OpenCode login in the Accounts section (contract v3.40). Pure functions (no Electron; tested with node --test).
// What OpenCode's CLI offers (`opencode console --help`): `opencode console login` signs in to the OpenCode
// Console with a device code (opencode.ai/console/device), `opencode console logout` signs out;
// `opencode auth list` shows the credentials. The console login lives in OpenCode's own database
// (<data dir>/opencode/opencode.db, `auth.json` is not written), so the state is read from the CLI itself:
// `opencode auth list --format json` lists the logged in integrations ({ id, name, connections: [{ method, ... }] }).
// OpenCode needs NO login to work: its free models (the `opencode/` provider, OpenCode Zen) run without
// credentials and it picks one itself. So here "not logged in" is a normal state, never a blocker. Only
// integration ids and connection methods are read; the secrets never reach the parser.
const path = require('node:path');

// The documented install line; shown as a hint, never run by the app.
const OC_INSTALL = 'curl -fsSL https://opencode.ai/install | bash';
const OC_INSTALL_WIN = 'npm i -g opencode-ai';

// The login and logout subcommands. Login has two ways: the `console` group signs in to the OpenCode Console with a
// device code; the `auth` group logs in to one provider (OAuth or an API key, it asks which). Both log out via `console logout`.
const OC_LOGIN_ARGS = ['console', 'login'];
const OC_PROVIDER_LOGIN_ARGS = ['auth', 'login'];
const OC_LOGOUT_ARGS = ['console', 'logout'];
// v2.x (opencode.ai/v2) has one login and one logout: each names the OpenCode provider directly.
const OC_V2_LOGIN_ARGS = ['auth', 'login', 'opencode'];
const OC_V2_LOGOUT_ARGS = ['auth', 'logout', 'opencode'];

/**
 * The login pty's arguments: v2.x always `auth login opencode` / `auth logout opencode`; v1 (major unknown or 1)
 * keeps `console login` (the device code, the default), `auth login` (one provider) and `console logout`.
 * @param {string} mode 'login' | 'console' | 'auth' | 'logout' @param {number | null} major
 * @returns {string[]}
 */
function ocLoginArgs(mode, major) {
  if (major >= 2) return mode === 'logout' ? OC_V2_LOGOUT_ARGS : OC_V2_LOGIN_ARGS;
  if (mode === 'logout') return OC_LOGOUT_ARGS;
  if (mode === 'auth') return OC_PROVIDER_LOGIN_ARGS;
  return OC_LOGIN_ARGS;
}

// The status check runs in the user's login shell with ocEnv (so PATH, rc files and 1.19+ apply as for an OpenCode
// tab): where opencode is, its major version (v2.x has one login, `opencode auth login opencode`), and the CLI's own
// list of logged in integrations. rc noise around it is tolerated.
const OC_STATUS_COMMAND = 'command -v opencode; opencode --version; opencode auth list --format json; true';

/**
 * The CLI's major version, whatever its line looks like: a line that is (or starts with) the version itself
 * — '1.19.3', 'v2.0.0', 'opencode v2.1.2', 'opencode 1.2.3 (build)' — gives its number; anything else (rc noise,
 * an alias line) is null (unknown → the v1 ways). Not tied to one release's exact wording.
 * @param {string} text @returns {number | null}
 */
function parseOcVersion(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    const v = l.match(/^(?:opencode\s*)?[vV]?(\d+)\.\d+(?:\.\d+)?(?:\s|$)/i)
      || (/^opencode\b/i.test(l) && l.match(/\b[vV]?(\d+)\.\d+(?:\.\d+)?(?![\w.])/));
    if (v) return Number(v[1]);
  }
  return null;
}

/**
 * The status command's output (rc files may print noise around it): where opencode is and its major version.
 * @param {string} stdout @returns {{ path: string | null, major: number | null }}
 */
function parseOcStatus(stdout) {
  const text = String(stdout || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  return { path: lines.find((l) => /^(\/|[A-Za-z]:\\).*[\\/]opencode(\.exe|\.cmd)?$/.test(l)) || null, major: parseOcVersion(text) };
}

/**
 * OpenCode's credentials file: <XDG_DATA_HOME or ~/.local/share>/opencode/auth.json (also on Windows: the user's
 * profile, not %APPDATA%). @param {string} home @param {string} [xdgData]
 */
const ocAuthFile = (home, xdgData) => path.join(xdgData && path.isAbsolute(xdgData) ? xdgData : path.join(home, '.local', 'share'), 'opencode', 'auth.json');

// OpenCode's integration ids are short slugs ('opencode', 'openai', 'github-copilot'); anything else is not shown.
const PROVIDER_ID = /^[\w.-]{1,60}$/;
const TYPES = ['oauth', 'api', 'wellknown'];

/**
 * The CLI's own list (`opencode auth list --format json`, possibly with rc noise around it) → the logged in
 * integrations as [{ id, type }] (type = the first connection's method, or 'other'), in integration order;
 * an integration without a connection is not logged in. If the text holds no JSON array (an older CLI without
 * `--format`), the legacy auth.json form ({ "<provider>": { type: 'oauth' | 'api' | 'wellknown', ...secrets } })
 * of `legacyText` is parsed instead; broken text is []. Nothing but ids and methods is returned.
 * @param {string} text the status run's stdout (version output with the auth list, rc noise allowed)
 * @param {string} [legacyText] an older CLI's auth.json @returns {{ id: string, type: string }[]}
 */
function parseOcCredentials(text, legacyText = '') {
  const s = String(text || '');
  const start = s.indexOf('[');
  let a = null;
  if (start !== -1) {
    try { a = JSON.parse(s.slice(start, s.lastIndexOf(']') + 1)); } catch { a = null; }
  }
  if (Array.isArray(a)) {
    const out = [];
    for (const e of a) {
      const cs = e && typeof e === 'object' ? e.connections : null;
      if (!e || !PROVIDER_ID.test(e.id) || !Array.isArray(cs)) continue;
      const c = cs.find((c) => c && typeof c === 'object');
      if (c) out.push({ id: e.id, type: TYPES.includes(c.method) ? c.method : 'other' });
    }
    return out;
  }
  let d;
  try { d = JSON.parse(String(legacyText || '')); } catch { return []; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  return Object.entries(d)
    .filter(([id, v]) => PROVIDER_ID.test(id) && v && typeof v === 'object')
    .map(([id, v]) => ({ id, type: TYPES.includes(v.type) ? v.type : 'other' }));
}

/**
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'missing', major?: number | null, providers?: { id: string, type: string }[] }} OcAuth
 * OpenCode's state: 'missing' (not installed), 'in' (at least one integration logged in; `providers` lists them) or
 * 'out' (none: the free models still work); `major` is opencode's CLI version (null when it could not be read).
 * @param {{ path: string | null, major?: number | null, raw?: string }} status
 * @param {string} [credentialsText] the status run's stdout @param {string} [legacyText] an older CLI's auth.json
 * @returns {OcAuth}
 */
function ocAuthState(status, credentialsText = '', legacyText = '') {
  if (!status.path) return { installed: false, state: 'missing' };
  const providers = parseOcCredentials(credentialsText, legacyText);
  const major = typeof status.major === 'number' ? status.major : null;
  return providers.length
    ? { installed: true, state: 'in', major, providers }
    : { installed: true, state: 'out', major };
}

module.exports = { OC_INSTALL, OC_INSTALL_WIN, OC_LOGIN_ARGS, OC_PROVIDER_LOGIN_ARGS, OC_LOGOUT_ARGS, OC_V2_LOGIN_ARGS, OC_V2_LOGOUT_ARGS, OC_STATUS_COMMAND, parseOcStatus, parseOcVersion, ocAuthFile, ocLoginArgs, parseOcCredentials, ocAuthState };
