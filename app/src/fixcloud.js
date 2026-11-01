// FixCloud wiring (contract v3.60): pure logic plus the opencode.json merge and the Anthropic↔OpenAI translation used
// by the in-process proxy (no Electron; tested with node --test). A FixCloud account (src/accounts.js provider:'fixcloud')
// serves two paths:
//   - PROJECT SESSIONS (v3.60) run on the CLAUDE CODE engine against an in-process Anthropic→OpenAI proxy (main.js) that
//     forwards to the FixCloud OpenAI-wire endpoint. FixCloud answers POST /v1/chat/completions only (POST /v1/messages
//     is 404), so Claude Code cannot talk to it directly — the proxy translates with anthropicToOpenAI / openaiToAnthropic
//     and synthesizes the Anthropic SSE stream with anthropicSseString. This restores Claude Code's manager mode / plugins
//     / skills / clawd-office viewer for FixCloud projects.
//   - ao-delegate (the delegate CLI, unchanged) still launches OpenCode under a fixcloud account. On Save the app
//     deep-merges a `fixcloud` provider into the user's opencode.json whose apiKey is the LITERAL env reference
//     {env:FIXCLOUD_API_KEY} (never the real key); at launch the decrypted key is injected into the OpenCode env as
//     FIXCLOUD_API_KEY after the engine's env filter (engine.js ocEnv's forced-env).
// The real key lives only in providerTokens (safeStorage); it is never logged, returned, put in argv or written to state.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// --- Anthropic Messages API ↔ OpenAI chat/completions translation (contract v3.60).
// Pure and testable; the in-process proxy (main.js) uses these to talk to FixCloud's OpenAI-wire endpoint on behalf of
// Claude Code. Adapted from the proven feasibility proxy: non-streaming upstream, synthesized Anthropic SSE downstream.

/** Anthropic Messages request body → OpenAI chat/completions request object. `model` is forced (the account's model).
 *  system + messages (incl. tool_use / tool_result blocks) are mapped; tools → function tools. tool_choice is OMITTED
 *  unless a SPECIFIC tool is forced (body.tool_choice.type === 'tool' with a name): FixCloud/vLLM rejects the strings
 *  "auto"/"required" unless started with --enable-auto-tool-choice/--tool-call-parser. Non-streaming (stream:false). */
function anthropicToOpenAI(body, model) {
  const b = body && typeof body === 'object' ? body : {};
  const msgs = [];
  if (b.system) {
    const sys = Array.isArray(b.system) ? b.system.map((x) => x.text || '').join('\n') : String(b.system);
    if (sys) msgs.push({ role: 'system', content: sys });
  }
  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      for (const tr of blocks.filter((x) => x.type === 'tool_result')) {
        const c = Array.isArray(tr.content)
          ? tr.content.map((x) => (x.type === 'text' ? x.text : JSON.stringify(x))).join('\n')
          : typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
        msgs.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: c });
      }
      const t = blocks.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      if (t) msgs.push({ role: 'user', content: t });
    } else if (m.role === 'assistant') {
      const texts = blocks.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      const toolUses = blocks.filter((x) => x.type === 'tool_use');
      const msg = { role: 'assistant', content: texts || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }));
      }
      msgs.push(msg);
    }
  }
  const out = { model, messages: msgs, stream: false };
  if (b.max_tokens) out.max_tokens = b.max_tokens;
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.stop_sequences) out.stop = b.stop_sequences;
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  if (b.tool_choice && b.tool_choice.type === 'tool' && b.tool_choice.name) {
    out.tool_choice = { type: 'function', function: { name: b.tool_choice.name } };
  }
  return out;
}

/** OpenAI chat/completions response → Anthropic message object. text + tool_use blocks (from tool_calls); stop_reason
 *  tool_calls→tool_use, length→max_tokens, else end_turn; usage from prompt/completion_tokens. `model` is the fallback. */
function openaiToAnthropic(oai, model) {
  const o = oai && typeof oai === 'object' ? oai : {};
  const choice = (Array.isArray(o.choices) && o.choices[0]) || {};
  const m = choice.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id || ('toolu_' + crypto.randomBytes(8).toString('hex')), name: tc.function?.name, input });
  }
  // If the model emitted tool calls, the stop reason is tool_use regardless of finish_reason: some OpenAI-compatible
  // servers return finish_reason 'stop' alongside tool_calls, and Claude Code would otherwise skip running the tools.
  const hasToolUse = content.some((b) => b.type === 'tool_use');
  const stop = hasToolUse ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: o.id || ('msg_' + Date.now()), type: 'message', role: 'assistant', model: o.model || model,
    content: content.length ? content : [{ type: 'text', text: '' }], stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: o.usage?.prompt_tokens || 0, output_tokens: o.usage?.completion_tokens || 0 },
  };
}

/** The full Anthropic SSE text for a (non-streamed) message: message_start, per-block content_block_start / _delta
 *  (text_delta | input_json_delta) / _stop, message_delta (stop_reason + usage), message_stop. Pure (returns a string). */
function anthropicSseString(msg) {
  const a = msg && typeof msg === 'object' ? msg : { content: [], usage: {}, stop_reason: 'end_turn' };
  const blocks = Array.isArray(a.content) ? a.content : [];
  const usage = a.usage || {};
  let out = '';
  const ev = (type, data) => { out += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; };
  ev('message_start', { type: 'message_start', message: { ...a, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens || 0, output_tokens: 0 } } });
  blocks.forEach((block, i) => {
    if (block.type === 'text') {
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
    } else {
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    ev('content_block_stop', { type: 'content_block_stop', index: i });
  });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: a.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens || 0 } });
  ev('message_stop', { type: 'message_stop' });
  return out;
}

module.exports = {
  parseModels,
  FIXCLOUD, FIXCLOUD_KEY_ENV, FIXCLOUD_API_KEY_REF,
  fixcloudBossModel, isFixcloudModel, ocConfigPath, fixcloudProvider, mergeFixcloud, writeFixcloudProvider,
  anthropicToOpenAI, openaiToAnthropic, anthropicSseString,
};
