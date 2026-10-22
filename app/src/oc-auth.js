// OpenCode login in the Accounts section (contract v3.40, v3.41). Pure functions (no Electron; tested with node --test).
// What OpenCode's CLI offers (`opencode console --help`): `opencode console login` signs in to the OpenCode
// Console with a device code (opencode.ai/console/device), `opencode console logout` signs out;
// `opencode auth list` shows the credentials. The console login lives in OpenCode's own database
// (<data dir>/opencode/opencode.db, `auth.json` is not written), so the state is read from the CLI itself:
// `opencode auth list --format json` lists the logged in integrations ({ id, name, connections: [{ method, ... }] }).
// OpenCode needs NO login to work: its free models (the `opencode/` provider, OpenCode Zen) run without
// credentials and it picks one itself. So here "not logged in" is a normal state, never a blocker. Only
// integration ids and connection methods are read; the secrets never reach the parser.
const path = require('node:path');
const { UNSET_OFFICE_CLAUDE_ENV } = require('./engine.js');

// The documented install line; shown as a hint, never run by the app.
const OC_INSTALL = 'curl -fsSL https://opencode.ai/install | bash';
const OC_INSTALL_WIN = 'npm i -g opencode-ai';

// The login and logout subcommands. Login has two ways: the `console` group signs in to the OpenCode Console with a
// device code; the `auth` group logs in to one provider (OAuth or an API key, it asks which). Logout (v3.41): the
// Console entry (integration id 'opencode') with `console logout`; when it is not logged in, `auth logout` (it asks
// which provider), so a provider added with `auth login` can be removed too.
const OC_LOGIN_ARGS = ['console', 'login'];
const OC_PROVIDER_LOGIN_ARGS = ['auth', 'login'];
const OC_LOGOUT_ARGS = ['console', 'logout'];
const OC_PROVIDER_LOGOUT_ARGS = ['auth', 'logout'];
// v2.x (opencode.ai/v2) has one login and one logout: each names the OpenCode provider directly.
const OC_V2_LOGIN_ARGS = ['auth', 'login', 'opencode'];
const OC_V2_LOGOUT_ARGS = ['auth', 'logout', 'opencode'];
// The Console / OpenCode provider's integration id in `auth list`.
const OC_CONSOLE_ID = 'opencode';

// The modes the renderer may ask for (IPC `oc:login`, v3.41); anything else is the default, the device code login.
const OC_LOGIN_MODES = ['console', 'auth', 'logout'];
/** @param {unknown} mode @returns {'console' | 'auth' | 'logout'} */
const ocLoginMode = (mode) => /** @type {any} */ (OC_LOGIN_MODES.includes(/** @type {any} */ (mode)) ? mode : 'console');

/**
 * Which logout runs: the Console entry when it is logged in (or nothing is known), else `auth logout` (asks which).
 * @param {{ id: string }[] | null | undefined} providers @returns {'console' | 'provider'}
 */
const ocLogoutKind = (providers) => (!Array.isArray(providers) || !providers.length || providers.some((p) => p && p.id === OC_CONSOLE_ID) ? 'console' : 'provider');

/**
 * The login pty's arguments: v2.x `auth login opencode` / `auth logout opencode`; v1 (major unknown or 1)
 * keeps `console login` (the device code, the default), `auth login` (one provider) and `console logout`. On both,
 * logout falls back to `auth logout` (asks which provider) when the OpenCode entry is not among `providers`.
 * @param {string} mode 'console' | 'auth' | 'logout' (anything else: 'console') @param {number | null} major
 * @param {{ id: string }[]} [providers] the logged in integrations of the last check
 * @returns {string[]}
 */
function ocLoginArgs(mode, major, providers) {
  const m = ocLoginMode(mode);
  if (m === 'logout') {
    if (ocLogoutKind(providers) === 'provider') return OC_PROVIDER_LOGOUT_ARGS;
    return major >= 2 ? OC_V2_LOGOUT_ARGS : OC_LOGOUT_ARGS;
  }
  if (major >= 2) return OC_V2_LOGIN_ARGS;
  return m === 'auth' ? OC_PROVIDER_LOGIN_ARGS : OC_LOGIN_ARGS;
}

// The status check runs in the user's login shell with ocEnv (so PATH, rc files and 1.19+ apply as for an OpenCode
// tab): where opencode is, its major version (v2.x has one login, `opencode auth login opencode`), and the CLI's own
// list of logged in integrations. Before opencode runs, the same prelude as OC_COMMAND drops any AGENT_OFFICE_*,
// ANTHROPIC_* and CLAUDE* an rc file set (v3.41). Markers mark where each answer starts, so rc noise (`\x1b[?1034h`,
// banners, `[oh-my-zsh] …`) around them is not parsed as the answer.
const OC_VERSION_MARK = '__AO_OC_VERSION__';
const OC_AUTH_MARK = '__AO_OC_AUTH__';
const OC_STATUS_COMMAND = `command -v opencode; ${UNSET_OFFICE_CLAUDE_ENV}echo ${OC_VERSION_MARK}; opencode --version; echo ${OC_AUTH_MARK}; opencode auth list --format json; true`;

// Terminal control sequences (CSI such as `\x1b[?1034h`, OSC titles, single ESC codes) are dropped before parsing.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const stripAnsi = (s) => String(s || '').replace(ANSI, '');
/** The part of `text` after `mark` (up to `end` when given); the whole text when the mark is missing (Windows runs). */
function section(text, mark, end) {
  const i = text.lastIndexOf(mark);
  if (i === -1) return text;
  const rest = text.slice(i + mark.length);
  const j = end ? rest.indexOf(end) : -1;
  return j === -1 ? rest : rest.slice(0, j);
}

/**
 * The Windows status runs (v3.41): `--version` and `auth list --format json` of the found opencode, each through
 * OS.windowsCommand (npm's opencode.cmd needs cmd.exe) with ocEnv's env, never the app's.
 * @param {string} file @param {Record<string, string | undefined>} env
 * @param {(file: string, args: string[], env: any) => { file: string, args: string[], verbatim: boolean }} windowsCommand
 * @returns {{ file: string, args: string[], options: { env: any, timeout: number, windowsVerbatimArguments: boolean, windowsHide: boolean } }[]}
 */
function ocWindowsStatusRuns(file, env, windowsCommand) {
  return [['--version'], ['auth', 'list', '--format', 'json']].map((args) => {
    const w = windowsCommand(file, args, env);
    return { file: w.file, args: w.args, options: { env, timeout: 15000, windowsVerbatimArguments: w.verbatim, windowsHide: true } };
  });
}

/**
 * The CLI's major version, whatever its line looks like: a line that is (or starts with) the version itself
 * — '1.19.3', 'v2.0.0', 'opencode v2.1.2', 'opencode 1.2.3 (build)' — gives its number; anything else (rc noise,
 * an alias line) is null (unknown → the v1 ways). Not tied to one release's exact wording.
 * @param {string} text @returns {number | null}
 */
function parseOcVersion(text) {
  const t = section(stripAnsi(text), OC_VERSION_MARK, OC_AUTH_MARK);
  for (const line of t.split(/\r?\n/)) {
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
  const text = stripAnsi(stdout);
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
 * The first JSON array in `s` that starts a line and ends one (rc noise before or after it is skipped). null: none.
 * @param {string} s @returns {any[] | null}
 */
function jsonArray(s) {
  const starts = [];
  const ends = [];
  const re = /^[ \t]*\[|\][ \t]*$/gm;
  for (let m; (m = re.exec(s));) {
    if (m[0].trim() === '[') starts.push(m.index + m[0].indexOf('['));
    else ends.push(m.index + m[0].indexOf(']'));
  }
  for (const i of starts) {
    for (let k = ends.length - 1; k >= 0 && ends[k] > i; k--) {
      try { const a = JSON.parse(s.slice(i, ends[k] + 1)); if (Array.isArray(a)) return a; } catch {}
    }
  }
  return null;
}

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
  const a = jsonArray(section(stripAnsi(text), OC_AUTH_MARK));
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

module.exports = { OC_INSTALL, OC_INSTALL_WIN, OC_LOGIN_ARGS, OC_PROVIDER_LOGIN_ARGS, OC_LOGOUT_ARGS, OC_PROVIDER_LOGOUT_ARGS, OC_CONSOLE_ID,
  OC_LOGIN_MODES, ocLoginMode, ocLogoutKind, OC_VERSION_MARK, OC_AUTH_MARK, ocWindowsStatusRuns, stripAnsi, OC_V2_LOGIN_ARGS, OC_V2_LOGOUT_ARGS, OC_STATUS_COMMAND, parseOcStatus, parseOcVersion, ocAuthFile, ocLoginArgs, parseOcCredentials, ocAuthState };
