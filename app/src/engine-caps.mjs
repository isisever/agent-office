// What each engine can do with the project row's controls (contract v3.36). Pure data, no DOM, no Electron:
// the sidebar renders EVERY control for every engine and disables the ones an engine can't honour, with a one-line
// reason (the locale key `sidebar.na.<reason>`). Tested with node --test (app/test/engine-caps.test.mjs).

export const ENGINES = ['claude', 'agy', 'commandcode', 'opencode'];

/** The features of a project row, in the order the sidebar shows them. */
export const FEATURES = ['account', 'login', 'manager', 'bossModel', 'agentModel', 'contextCap', 'savings', 'autoApprove', 'skipPermissions', 'backup', 'workers', 'approvals', 'cost', 'projectFiles', 'appMcp', 'skillPacks', 'delegate'];

const OK = Object.freeze({ ok: true });
const no = (reason) => Object.freeze({ ok: false, reason });

// Command Code: manager mode, context cap, savings, workers and approvals arrive with its launch config and mod
// (contract v3.37). Antigravity: what it can't take without files in the project or ~/.gemini stays off (v3.36), except
// what the opt-in project files bring (WITH_FILES, v3.38).
const TABLE = {
  claude: { projectFiles: no('claudeProjectFiles') },
  agy: {
    contextCap: no('agyContextCap'),
    savings: no('agySavings'),
    backup: no('agyBackup'),
    workers: no('agyWorkers'),
    cost: no('agyCost'),
    appMcp: no('claudeOnlyMcp'),
    skillPacks: no('claudeOnlySkills'),
    delegate: no('claudeOnlyDelegate'), // v3.56 ao-delegate is a Claude-boss feature
    autoApprove: no('claudeOnlyAutoApprove'), // v3.71: the Claude Code plugin answers the dialogs
    skipPermissions: no('claudeOnlySkipPermissions'), // v3.72: a flag of the claude CLI
  },
  commandcode: {
    backup: no('cmdBackup'),
    appMcp: no('claudeOnlyMcp'),
    skillPacks: no('claudeOnlySkills'),
    delegate: no('claudeOnlyDelegate'), // v3.56
    autoApprove: no('claudeOnlyAutoApprove'), // v3.71
    skipPermissions: no('claudeOnlySkipPermissions'), // v3.72
  },
  // OpenCode (contract v3.40): observed from its terminal only; no launch config or files from the app, no token counts.
  opencode: {
    manager: no('ocManager'),
    agentModel: no('ocAgentModel'),
    contextCap: no('ocContextCap'),
    savings: no('ocSavings'),
    backup: no('ocBackup'),
    workers: no('ocWorkers'),
    cost: no('ocCost'),
    projectFiles: no('ocProjectFiles'),
    appMcp: no('claudeOnlyMcp'),
    skillPacks: no('claudeOnlySkills'),
    delegate: no('claudeOnlyDelegate'), // v3.56
    autoApprove: no('claudeOnlyAutoApprove'), // v3.71
    skipPermissions: no('claudeOnlySkipPermissions'), // v3.72
  },
};

// With the project's "Let Agent Office add its files" toggle on (contract v3.38, src/project-files.js) these come from
// files in the project; off, they are disabled with the reason "turn on Agent Office files".
const WITH_FILES = { agy: ['manager', 'agentModel'], commandcode: ['agentModel'] };

// MCP servers added in Agent Office (contract v3.44, src/mcp-servers.js) and their tokens go only to Claude Code
// sessions: the other engines get no token and no office data (the leak rule). The MCP panel says "Claude Code only".
// Bundled skill packs (contract v3.45, src/skill-packs.js) are Claude Code plugins: passed as --plugin-dir to Claude
// Code sessions only; the Skills settings say "Claude Code only" for the other engines.
const engineOf = (e) => (ENGINES.includes(e) ? e : 'claude');

/**
 * The engine's capabilities: { [feature]: { ok: true } | { ok: false, reason } } for every feature.
 * opts.projectFiles: the project's opt-in toggle (contract v3.38).
 */
export function caps(engine, { projectFiles = false } = {}) {
  const e = engineOf(engine);
  const row = TABLE[e];
  const files = WITH_FILES[e] || [];
  return Object.fromEntries(FEATURES.map((f) => [f, files.includes(f) ? (projectFiles ? OK : no('filesOff')) : row[f] || OK]));
}

/** One feature of one engine (opts as caps). */
export const cap = (engine, feature, opts) => caps(engine, opts)[feature] || OK;

// The boss model choices per engine (contract v3.27, v3.36): value + label. Auto ('auto', stored as nothing) comes
// first everywhere. Claude: claude's aliases (the sidebar shows their locale strings). Antigravity: its documented model tiers
// (antigravity.google/docs/subagents). Command Code: full model ids (commandcode.ai/docs/reference/cli/models).
// projects.js BOSS_MODELS_BY_ENGINE holds the same values (the test checks it).
export const BOSS_MODEL_CHOICES = {
  claude: [
    { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' }, // v3.73
    // v3.68: explicit ids pin the 5.5 models (an alias resolves to Claude Code's default of the family); v3.73: Fable 5.2
    { value: 'claude-fable-5-2', label: 'Fable 5.2' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
  agy: [{ value: 'flash', label: 'Gemini Flash' }, { value: 'pro', label: 'Gemini Pro' }],
  commandcode: [
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }, { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
  opencode: [{ value: 'opencode/big-pickle', label: 'Big Pickle (free)' }], // v3.40: `-m provider/model`
};

// Custom model id (contract v3.73), Claude Code engine only: the pickers' "Custom…" field checks what is typed with the
// same pattern as projects.js CUSTOM_MODEL_RE (the test compares them); main validates again and is the authority.
export const CUSTOM_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;
/** @param {unknown} v */
export const isCustomModelId = (v) => typeof v === 'string' && CUSTOM_MODEL_RE.test(v);

/** The boss model choices of an engine. */
export const bossModelChoices = (engine) => BOSS_MODEL_CHOICES[engineOf(engine)];
