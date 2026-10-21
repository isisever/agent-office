// OpenCode login in the Accounts section (contract v3.40). Pure functions (no Electron; tested with node --test).
// What OpenCode's CLI offers (opencode.ai/docs/cli, `opencode auth --help`): `opencode auth login` adds a
// provider's credentials (OAuth in the browser or an API key, it asks which), `auth logout` removes one,
// `auth list` shows them; they are stored in <data dir>/opencode/auth.json ({ "<provider>": { type: 'oauth' |
// 'api' | 'wellknown', ...secrets } }). OpenCode needs NO login to work: its free models (the `opencode/` provider,
// OpenCode Zen) run without credentials and it picks one itself. So here "not logged in" is a normal state, never a
// blocker. Only the provider names and types of auth.json are read; its secrets never leave the parser.
const path = require('node:path');

// The documented install line; shown as a hint, never run by the app.
const OC_INSTALL = 'curl -fsSL https://opencode.ai/install | bash';
const OC_INSTALL_WIN = 'npm i -g opencode-ai';

// The login and logout subcommands (the CLI's `auth` group: it asks which provider and how).
const OC_LOGIN_ARGS = ['auth', 'login'];
const OC_LOGOUT_ARGS = ['auth', 'logout'];

// The status check run by the user's login shell with ocEnv (so PATH and rc files apply as for an OpenCode tab).
const OC_STATUS_COMMAND = 'command -v opencode; true';

/**
 * The status command's output (rc files may print noise around it): where opencode is.
 * @param {string} stdout @returns {{ path: string | null }}
 */
function parseOcStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim());
  return { path: lines.find((l) => /^(\/|[A-Za-z]:\\).*[\\/]opencode(\.exe|\.cmd)?$/.test(l)) || null };
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
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'missing', providers?: { id: string, type: string }[] }} OcAuth
 * OpenCode's state: 'missing' (not installed), 'in' (at least one provider logged in; `providers` lists them) or 'out'
 * (none: the free models still work). @param {{ path: string | null }} status @param {string} credentialsText '' if none
 * @returns {OcAuth}
 */
function ocAuthState(status, credentialsText) {
  if (!status.path) return { installed: false, state: 'missing' };
  const providers = parseOcCredentials(credentialsText);
  return providers.length ? { installed: true, state: 'in', providers } : { installed: true, state: 'out' };
}

module.exports = { OC_INSTALL, OC_INSTALL_WIN, OC_LOGIN_ARGS, OC_LOGOUT_ARGS, OC_STATUS_COMMAND, parseOcStatus, ocAuthFile, parseOcCredentials, ocAuthState };
