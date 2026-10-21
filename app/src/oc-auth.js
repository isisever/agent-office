// OpenCode login in the Accounts section (contract v3.40). Pure functions (no Electron; tested with node --test).
// What OpenCode's CLI offers (`opencode console --help`, opencode 1.19): `opencode console login` signs in to the
// OpenCode Console with a device code (opencode.ai/console/device), `opencode console logout` signs out;
// `opencode auth list` shows the credentials; they are stored in <data dir>/opencode/auth.json ({ "<provider>": { type: 'oauth' |
// 'api' | 'wellknown', ...secrets } }). OpenCode needs NO login to work: its free models (the `opencode/` provider,
// OpenCode Zen) run without credentials and it picks one itself. So here "not logged in" is a normal state, never a
// blocker. Only the provider names and types of auth.json are read; its secrets never leave the parser.
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

// The status check run by the user's login shell with ocEnv (so PATH and rc files apply as for an OpenCode tab).
// `opencode --version` decides the login spelling: v2.x has one login (`opencode auth login opencode`), v1 has two.
const OC_STATUS_COMMAND = 'command -v opencode; opencode --version; true';

/**
 * The CLI's major version: a full line like '1.19.3', 'v2.0.0' or 'opencode v2.1.2' → its number, else null
 * (unknown → v1 ways). @param {string} text @returns {number | null}
 */
function parseOcVersion(text) {
  const m = String(text || '').match(/^(?:opencode\s+)?[vV]?(\d+)\.\d+(?:\.\d+)?\s*$/im);
  return m ? Number(m[1]) : null;
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

// OpenCode's provider ids are short slugs ('openai', 'github-copilot', 'google'); anything else is not shown.
const PROVIDER_ID = /^[\w.-]{1,60}$/;
const TYPES = ['oauth', 'api', 'wellknown'];

/**
 * The providers an auth.json text holds: [{ id, type }] (type 'oauth' | 'api' | 'wellknown' | 'other'), in file
 * order; broken text or a non-object is []. Nothing but ids and types is returned.
 * @param {string} text @returns {{ id: string, type: string }[]}
 */
function parseOcCredentials(text) {
  let d;
  try { d = JSON.parse(String(text || '')); } catch { return []; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  return Object.entries(d)
    .filter(([id, v]) => PROVIDER_ID.test(id) && v && typeof v === 'object')
    .map(([id, v]) => ({ id, type: TYPES.includes(v.type) ? v.type : 'other' }));
}

/**
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'missing', major?: number | null, providers?: { id: string, type: string }[] }} OcAuth
 * OpenCode's state: 'missing' (not installed), 'in' (at least one provider logged in; `providers` lists them) or 'out'
 * (none: the free models still work); `major` is opencode's CLI version (null when it could not be read). @param {{ path: string | null, major?: number | null }} status @param {string} credentialsText '' if none
 * @returns {OcAuth}
 */
function ocAuthState(status, credentialsText) {
  if (!status.path) return { installed: false, state: 'missing' };
  const providers = parseOcCredentials(credentialsText);
  const major = typeof status.major === 'number' ? status.major : null;
  return providers.length
    ? { installed: true, state: 'in', major, providers }
    : { installed: true, state: 'out', major };
}

module.exports = { OC_INSTALL, OC_INSTALL_WIN, OC_LOGIN_ARGS, OC_PROVIDER_LOGIN_ARGS, OC_LOGOUT_ARGS, OC_V2_LOGIN_ARGS, OC_V2_LOGOUT_ARGS, OC_STATUS_COMMAND, parseOcStatus, parseOcVersion, ocAuthFile, ocLoginArgs, parseOcCredentials, ocAuthState };
