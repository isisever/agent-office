// Engine per project (contract v3.22): how a tab of an Antigravity project starts. Pure functions (no Electron;
// tested with node --test). Google Antigravity CLI (`agy`, 1.3.6 or newer) keeps its own login and data
// (~/.gemini/antigravity-cli), so nothing of Claude Code's setup (account folder, plugin, status line, memory, MCP
// config) nor of the office (directory, journal, savings, tokens) is passed to it.
// Command Code (`commandcode`, contract v3.25) is handled the same way: its own login and data (~/.commandcode), an
// env allowlist (cmdEnv) and no file, flag or variable of the office, except the documented items of v3.37 (the
// compact mode, the permission mode, MAX_MCP_OUTPUT_TOKENS from Savings, and the app's own mod with its spool path).
const { promptArg } = require('./resume.js');

// macOS/Linux launch line, run by the login shell like claude's (PATH and rc files apply); the arguments come via "$@".
// The env it starts with is agyEnv's allowlist, so the rc files have no carrier (AGENT_OFFICE_CONFIG_DIR and the like)
// to rebuild the app's Claude variables from; any AGENT_OFFICE_* an rc file still sets is dropped before exec. The
// user's own rc variables (theirs, whatever their name) are left alone.
const UNSET_OFFICE_ENV = 'for v in $(env | sed -n \'s/^\\(AGENT_OFFICE_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$v"; done; ';
// OpenCode (v3.40) also has an Anthropic provider that reads ANTHROPIC_API_KEY itself: its line also drops any
// ANTHROPIC_* and CLAUDE* an rc file set (sed -E: BSD and GNU).
const UNSET_OFFICE_CLAUDE_ENV = 'for v in $(env | sed -nE \'s/^((AGENT_OFFICE_|ANTHROPIC_|CLAUDE)[A-Za-z0-9_]*)=.*/\\1/p\'); do unset "$v"; done; ';
/**
 * A third-party engine's launch line (agy, Command Code, OpenCode): drops any AGENT_OFFICE_* first (with `claude`,
 * also ANTHROPIC_* and CLAUDE*), then `exec <bin> "$@"`.
 * @param {string} bin @param {{ claude?: boolean }} [o]
 */
const launchLine = (bin, { claude = false } = {}) => `${claude ? UNSET_OFFICE_CLAUDE_ENV : UNSET_OFFICE_ENV}exec ${bin} "$@"`;
const AGY_COMMAND = launchLine('agy');

/**
 * agy's arguments for a start: `--continue` (the most recent conversation of the folder agy starts in: agy keeps one
 * per workspace path) when resuming, then, only when resuming and a prompt is given, `-i <prompt>` (agy's initial
 * prompt, then interactive). model (the project's boss model, contract v3.36): `--model <slug>` first. A fresh start
 * with no model has no arguments.
 * @param {{ resume?: boolean, prompt?: string, model?: string | null }} [o]
 */
function agyArgs({ resume = false, prompt = '', model = null } = {}) {
  const p = resume && prompt ? promptArg(prompt) : '';
  return [...(model ? ['--model', model] : []), ...(resume ? ['--continue'] : []), ...(p ? ['-i', p] : [])];
}

// --- agy's environment: an allowlist (contract v3.22). Nothing else of the app's env reaches agy.
// Every platform: what a terminal program needs to find itself, its home, its locale and temp folder, and to open a
// browser for its Google login (Linux display and session bus). Proxies: the user's own network settings.
const AGY_ENV_NAMES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'AGY_ADC_AUTH', // agy's own documented switch to Google ADC sign-in (contract v3.24)
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
];
// Windows' own system variables (names compared without case, as Windows does).
const AGY_ENV_WINDOWS = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
  'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME', 'PSModulePath',
];
// Families passed by prefix: the locale, and agy's own Google / Gemini settings when the user has them.
const AGY_ENV_PREFIXES = ['LC_', 'GEMINI_', 'GOOGLE_'];
// Never passed, even when a rule above would match (belt and braces): Claude Code, Anthropic, the office, MCP.
const AGY_ENV_DENY = /^(ANTHROPIC|CLAUDE|AGENT_OFFICE)|MCP/i;

/**
 * The env agy starts with: only the allowlisted variables of base (the app's own env, i.e. the user's), plus the
 * terminal type. platform: process.platform (Windows names only on win32, compared without case there).
 * @param {Record<string, string | undefined>} base @param {string} [platform]
 * @returns {Record<string, string>}
 */
function agyEnv(base, platform = process.platform) {
  const win = platform === 'win32';
  const norm = (/** @type {string} */ n) => (win ? n.toUpperCase() : n);
  const names = new Set([...AGY_ENV_NAMES, ...(win ? AGY_ENV_WINDOWS : [])].map(norm));
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v !== 'string' || AGY_ENV_DENY.test(k)) continue;
    const key = norm(k);
    if (names.has(key) || AGY_ENV_PREFIXES.some((p) => key.startsWith(p))) out[k] = v;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  return out;
}

// --- Command Code (contract v3.25). The same rules as agy: an env allowlist, nothing of Claude Code or the office.
// The binary is `commandcode` on every OS (the npm package `command-code` also installs `cmd`, which on Windows is
// the shell's own System32\cmd.exe). Its sessions live in ~/.commandcode/projects/<slug>/<session id>.jsonl.
const CMD = {
  bin: 'commandcode',
  home: '.commandcode',
};

// Command Code's documented permission modes (commandcode.ai/docs/reference/cli `--permission-mode`), contract v3.37.

/**
 * Command Code's arguments for a start (contract v3.25, v3.36, v3.37), in this order:
 * - model (the project's boss model, v3.36): `-m <id>` first;
 * - `--config compactMode=fast` when the project's context cap is set (compact: commandcode.ai/docs/settings
 *   `compactMode: default | fast`, set per run with `--config key=value`; Command Code has no token window value);
 * - `--permission-mode <mode>` when the project has one of CMD_PERMISSION_MODES;
 * - mod: the app's own mod and its options (cmdModArgs in src/cmd-spool.js), passed through as given;
 * - `--continue` (the most recent session in the folder, commandcode.ai/docs/sessions) when resuming, then (only
 *   when resuming and a prompt is given) the prompt as the positional argument.
 * @param {{ resume?: boolean, prompt?: string, model?: string | null, compact?: boolean, mod?: string[] }} [o]
 */
function cmdArgs({ resume = false, prompt = '', model = null, compact = false, mod = [] } = {}) {
  const p = resume && prompt ? promptArg(prompt) : '';
  return [
    ...(model ? ['-m', model] : []),
    ...(compact ? ['--config', 'compactMode=fast'] : []),
    ...(Array.isArray(mod) ? mod.filter((a) => typeof a === 'string') : []),
    ...(resume ? ['--continue'] : []), ...(p ? [p] : []),
  ];
}

/** Command Code's launch line: drops any AGENT_OFFICE_* an rc file set (as AGY_COMMAND), then `commandcode "$@"`. */
const CMD_COMMAND = launchLine(CMD.bin);

// Command Code's own documented variables (commandcode.ai/docs/settings, /docs/sessions), passed only when the user
// has them: its API key, zero-data-retention and model-catalog switches, updater, scratchpad and the telemetry
// opt-out. MCP_TOOL_TIMEOUT / MAX_MCP_OUTPUT_TOKENS are documented too but the user's own values stay out (the MCP
// deny rule). The one narrow exception (v3.37): MAX_MCP_OUTPUT_TOKENS written by the app from the project's own
// Savings level (accounts.js SAVINGS mcpOutput), never a value passed through from the user's env.
const CMD_ENV_NAMES = ['COMMAND_CODE_API_KEY', 'CMD_ZDR', 'CMD_DISABLE_REMOTE_MODEL_CATALOG', 'DO_NOT_TRACK'];
const CMD_ENV_PREFIXES = ['COMMANDCODE_'];

// The largest MAX_MCP_OUTPUT_TOKENS the app writes (Command Code's default is 25000).
const CMD_MCP_OUTPUT_MAX = 100000;

/**
 * The env Command Code starts with: agyEnv's base allowlist (without agy's own names and families) plus Command
 * Code's documented variables; the same deny rule (Claude, Anthropic, the office, MCP). opts.mcpOutput (v3.37): the
 * app's own Savings value (a whole number of tokens, 1..CMD_MCP_OUTPUT_MAX) is then set as MAX_MCP_OUTPUT_TOKENS,
 * after the filter, so only the app's value is there. opts may also be the platform string (the v3.25 signature).
 * @param {Record<string, string | undefined>} base
 * @param {{ mcpOutput?: number | null, platform?: string } | string} [opts] @param {string} [platform]
 * @returns {Record<string, string>}
 */
function cmdEnv(base, opts = {}, platform = process.platform) {
  const o = typeof opts === 'string' ? { platform: opts } : (opts || {});
  const win = (o.platform || platform) === 'win32';
  const norm = (/** @type {string} */ n) => (win ? n.toUpperCase() : n);
  const names = new Set([...AGY_ENV_NAMES.filter((n) => n !== 'AGY_ADC_AUTH'), ...CMD_ENV_NAMES, ...(win ? AGY_ENV_WINDOWS : [])].map(norm));
  const prefixes = ['LC_', ...CMD_ENV_PREFIXES];
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v !== 'string' || AGY_ENV_DENY.test(k)) continue;
    const key = norm(k);
    if (names.has(key) || prefixes.some((p) => key.startsWith(p))) out[k] = v;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  const n = o.mcpOutput;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= CMD_MCP_OUTPUT_MAX) out.MAX_MCP_OUTPUT_TOKENS = String(n);
  return out;
}

// --- OpenCode (contract v3.40). The same rules again: an env allowlist, nothing of Claude Code or the office. The binary
// is `opencode`. It keeps its own providers and logins (`opencode auth list`, ~/.local/share/opencode/auth.json) and
// works without any login: its free models (the `opencode/` provider) need none, and it picks one by itself.
const OC = {
  bin: 'opencode',
};

/**
 * OpenCode's arguments for a start: the project's boss model first (`-m <provider/model>`, opencode.ai/docs/cli,
 * contract v3.36), then `--continue` (the last session of the folder; with none it simply starts a new one, checked
 * with opencode 1.18) when resuming, then (only when resuming and a prompt is given) `--prompt <prompt>`.
 * @param {{ resume?: boolean, prompt?: string, model?: string | null }} [o]
 */
function ocArgs({ resume = false, prompt = '', model = null } = {}) {
  const p = resume && prompt ? promptArg(prompt) : '';
  return [...(model ? ['-m', model] : []), ...(resume ? ['--continue'] : []), ...(p ? ['--prompt', p] : [])];
}

/** OpenCode's launch line: drops any AGENT_OFFICE_* an rc file set (as AGY_COMMAND), then `opencode "$@"`. */
const OC_COMMAND = launchLine(OC.bin, { claude: true }); // built from the binary, never by editing AGY_COMMAND (v3.40)

// What OpenCode reads from the environment, passed only when the user has it: its own OPENCODE_* switches and the
// API keys of the model providers it documents (opencode.ai/docs/providers), by exact name. Any other *_API_KEY in
// the user's shell (STRIPE_API_KEY, a company key, ...) stays out. The deny rule still wins: an ANTHROPIC_* or CLAUDE*
// variable never reaches it, and Anthropic's key is never on this list.
const OC_ENV_PREFIXES = ['OPENCODE_'];
const OC_PROVIDER_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'TOGETHER_AI_API_KEY',
  'FIREWORKS_API_KEY', 'CEREBRAS_API_KEY', 'DEEPINFRA_API_KEY', 'PERPLEXITY_API_KEY', 'MOONSHOT_API_KEY',
  'ZHIPU_API_KEY', 'AZURE_API_KEY', 'AZURE_RESOURCE_NAME',
];
// Set after the filter, so a user value can't unset them (contract v3.40): OpenCode's Claude Code compatibility
// (opencode.ai/docs/rules, /docs/skills) would otherwise read CLAUDE.md, ~/.claude/CLAUDE.md and ~/.claude/skills.
const OC_FORCED_ENV = {
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
};

/**
 * The env OpenCode starts with: agyEnv's base allowlist (without agy's own names and families) plus OpenCode's own
 * variables and provider API keys; the same deny rule (Claude, Anthropic, the office, MCP). `extra` (v3.55): values
 * forced in AFTER the filter, beside OC_FORCED_ENV, so the filter cannot drop them — main passes a fixcloud account's
 * decrypted FIXCLOUD_API_KEY here (engine.js never reads a key itself; the decryption happens only in main).
 * @param {Record<string, string | undefined>} base @param {string} [platform] @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function ocEnv(base, platform = process.platform, extra = {}) {
  const win = platform === 'win32';
  const norm = (/** @type {string} */ n) => (win ? n.toUpperCase() : n);
  const names = new Set([...AGY_ENV_NAMES.filter((n) => n !== 'AGY_ADC_AUTH'), ...OC_PROVIDER_KEYS, ...(win ? AGY_ENV_WINDOWS : [])].map(norm));
  const prefixes = ['LC_', ...OC_ENV_PREFIXES];
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v !== 'string' || AGY_ENV_DENY.test(k)) continue;
    const key = norm(k);
    if (names.has(key) || prefixes.some((p) => key.startsWith(p))) out[k] = v;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  // Forced after the filter, so a user value can't unset them (OC_FORCED_ENV) and the filter can't drop the injected
  // key (extra). Windows names ignore case: a user `Opencode_Disable_Claude_Code=0` must not sit beside a forced value.
  const forced = { ...OC_FORCED_ENV, ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}) };
  const forcedNorm = new Set(Object.keys(forced).map(norm));
  for (const k of Object.keys(out)) if (forcedNorm.has(norm(k))) delete out[k];
  Object.assign(out, forced);
  return out;
}

module.exports = {
  OC, ocArgs, OC_COMMAND, UNSET_OFFICE_CLAUDE_ENV, ocEnv, OC_ENV_PREFIXES, OC_PROVIDER_KEYS, OC_FORCED_ENV, launchLine,
  AGY_COMMAND, agyArgs, agyEnv, AGY_ENV_NAMES, AGY_ENV_WINDOWS, AGY_ENV_PREFIXES,
  CMD, cmdArgs, CMD_COMMAND, cmdEnv, CMD_ENV_NAMES, CMD_ENV_PREFIXES, CMD_MCP_OUTPUT_MAX,
};
