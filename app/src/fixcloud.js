// FixCloud ↔ OpenCode wiring (contract v3.55): pure logic plus the opencode.json merge (no Electron; tested with
// node --test). A FixCloud account (src/accounts.js provider:'fixcloud') runs its projects on the OpenCode engine
// against a FixCloud OpenAI-compatible endpoint — no proxy, no Claude/Anthropic path. On Save the app deep-merges a
// `fixcloud` provider into the user's opencode.json whose apiKey is the LITERAL env reference {env:FIXCLOUD_API_KEY}
// (never the real key); at launch the decrypted key is injected into the OpenCode env as FIXCLOUD_API_KEY after the
// engine's env filter (engine.js ocEnv's forced-env). The real key lives only in providerTokens (safeStorage).
const fs = require('fs');
const path = require('path');

const FIXCLOUD = 'fixcloud';
const FIXCLOUD_KEY_ENV = 'FIXCLOUD_API_KEY';
const FIXCLOUD_API_KEY_REF = '{env:FIXCLOUD_API_KEY}';

/** The project's OpenCode boss model for a fixcloud account: `fixcloud/<model>` (OpenCode `-m provider/model`). */
const fixcloudBossModel = (model) => `${FIXCLOUD}/${model}`;
/** A `fixcloud/<model>` boss-model value (any model after the slash). */
const isFixcloudModel = (v) => typeof v === 'string' && v.startsWith(FIXCLOUD + '/') && v.length > FIXCLOUD.length + 1;

// OpenCode reads its config from $XDG_CONFIG_HOME/opencode/opencode.json, else ~/.config/opencode/opencode.json.
function ocConfigPath(env = {}, home = '') {
  const xdg = env && typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME : '';
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, 'opencode', 'opencode.json');
}

// The fixcloud provider block for opencode.json. apiKey is the env reference, NOT the real key.
function fixcloudProvider(baseUrl, model) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'FixCloud',
    options: { baseURL: baseUrl, apiKey: FIXCLOUD_API_KEY_REF },
    models: { [model]: { name: `${model} (FixCloud)` } },
  };
}

// Deep-merge the fixcloud provider into an OpenCode config object: never clobber other providers, models or top-level
// keys. Returns a new object (the input is not mutated); the one model merges into any existing fixcloud models.
function mergeFixcloud(config, baseUrl, model) {
  const cur = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const provider = cur.provider && typeof cur.provider === 'object' && !Array.isArray(cur.provider) ? cur.provider : {};
  const prevFix = provider[FIXCLOUD] && typeof provider[FIXCLOUD] === 'object' && !Array.isArray(provider[FIXCLOUD]) ? provider[FIXCLOUD] : {};
  const prevOpts = prevFix.options && typeof prevFix.options === 'object' && !Array.isArray(prevFix.options) ? prevFix.options : {};
  const prevModels = prevFix.models && typeof prevFix.models === 'object' && !Array.isArray(prevFix.models) ? prevFix.models : {};
  const block = fixcloudProvider(baseUrl, model);
  return {
    ...cur,
    provider: {
      ...provider,
      [FIXCLOUD]: {
        ...prevFix,
        ...block,
        options: { ...prevOpts, ...block.options },
        models: { ...prevModels, ...block.models },
      },
    },
  };
}

// Read (if present), deep-merge, and write opencode.json at `file`, creating the dir/file. The file holds no secret —
// only the {env:FIXCLOUD_API_KEY} reference — so it keeps OpenCode's normal mode. Returns the written config object.
function writeFixcloudProvider(file, baseUrl, model) {
  let cur = {};
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch {}   // missing file: start from {}
  // an existing non-empty file that doesn't parse (malformed / JSONC) is NOT overwritten: throw, write nothing
  if (raw.trim()) {
    try { cur = JSON.parse(raw); } catch (e) { throw new Error(`opencode.json is not valid JSON, left untouched: ${e.message}`); }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('opencode.json is not a JSON object, left untouched');
  }
  const next = mergeFixcloud(cur, baseUrl, model);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** Pure: the model ids from a parsed `<baseUrl>/models` response. OpenAI shape `{ data: [{ id }] }`; also `{ models: [...] }`
 *  or a bare array (entries may be `{ id }` objects or plain strings). De-duplicated, order kept; [] for anything else. */
function parseModels(json) {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' ? (Array.isArray(json.data) ? json.data : json.models) : null;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    const id = typeof e === 'string' ? e : e && typeof e === 'object' ? e.id : null;
    if (typeof id === 'string' && id.trim() && !out.includes(id.trim())) out.push(id.trim());
  }
  return out;
}

module.exports = {
  parseModels,
  FIXCLOUD, FIXCLOUD_KEY_ENV, FIXCLOUD_API_KEY_REF,
  fixcloudBossModel, isFixcloudModel, ocConfigPath, fixcloudProvider, mergeFixcloud, writeFixcloudProvider,
};
