// FixCloud Anthropic↔OpenAI translation and the in-process proxy / claude-launch wiring (contract v3.60).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FC = require('../src/fixcloud.js');
const P = require('../src/projects.js');
const A = require('../src/accounts.js');

const mainSrc = () => fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('fixcloud (v3.60): anthropicToOpenAI forces the model, maps system/tools/tool_result, omits tool_choice for auto', () => {
  const body = {
    system: [{ type: 'text', text: 'be brief' }],
    max_tokens: 100, temperature: 0.2, stop_sequences: ['STOP'], stream: true,
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'out' }] }] },
    ],
  };
  const oai = FC.anthropicToOpenAI(body, 'deepseek-v4.1-flash');
  assert.equal(oai.model, 'deepseek-v4.1-flash');     // forced
  assert.equal(oai.stream, false);                    // never stream upstream
  assert.equal(oai.max_tokens, 100);
  assert.equal(oai.temperature, 0.2);
  assert.deepEqual(oai.stop, ['STOP']);
  // system first, then the user/assistant turns
  assert.deepEqual(oai.messages[0], { role: 'system', content: 'be brief' });
  assert.deepEqual(oai.messages[1], { role: 'user', content: 'hi' });
  const asst = oai.messages[2];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content, 'ok');
  assert.deepEqual(asst.tool_calls, [{ id: 'tu1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ cmd: 'ls' }) } }]);
  // tool_result → role:tool with tool_call_id (comes before the trailing user text, which here is empty so absent)
  assert.deepEqual(oai.messages[3], { role: 'tool', tool_call_id: 'tu1', content: 'out' });
  // tools mapped to function tools; tool_choice 'auto' is OMITTED (vLLM rejects the string)
  assert.deepEqual(oai.tools, [{ type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object' } } }]);
  assert.equal('tool_choice' in oai, false);
});

test('fixcloud (v3.60): anthropicToOpenAI forces a SPECIFIC named tool only', () => {
  const forced = FC.anthropicToOpenAI({ messages: [], tool_choice: { type: 'tool', name: 'Edit' } }, 'm');
  assert.deepEqual(forced.tool_choice, { type: 'function', function: { name: 'Edit' } });
  // 'required'/'any' as a string shape is still omitted
  assert.equal('tool_choice' in FC.anthropicToOpenAI({ messages: [], tool_choice: { type: 'any' } }, 'm'), false);
  // a plain string message passes through
  assert.deepEqual(FC.anthropicToOpenAI({ messages: [{ role: 'user', content: 'yo' }] }, 'm').messages, [{ role: 'user', content: 'yo' }]);
});

test('fixcloud (v3.60): openaiToAnthropic maps tool_calls→tool_use and the stop_reason/usage', () => {
  const oai = {
    id: 'cmpl-1', model: 'srv-model',
    choices: [{ finish_reason: 'tool_calls', message: { content: 'thinking', tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  };
  const a = FC.openaiToAnthropic(oai, 'fallback');
  assert.equal(a.type, 'message');
  assert.equal(a.role, 'assistant');
  assert.equal(a.model, 'srv-model');
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.usage, { input_tokens: 12, output_tokens: 7 });
  assert.deepEqual(a.content[0], { type: 'text', text: 'thinking' });
  assert.deepEqual(a.content[1], { type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } });
  // stop_reason map: length → max_tokens, else → end_turn; empty content → one empty text block
  assert.equal(FC.openaiToAnthropic({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }, 'm').stop_reason, 'max_tokens');
  assert.equal(FC.openaiToAnthropic({ choices: [{ finish_reason: 'stop', message: {} }] }, 'm').stop_reason, 'end_turn');
  assert.deepEqual(FC.openaiToAnthropic({ choices: [{ finish_reason: 'stop', message: {} }] }, 'm').content, [{ type: 'text', text: '' }]);
  assert.equal(FC.openaiToAnthropic({ choices: [{ finish_reason: 'stop', message: {} }], model: null }, 'fallback').model, 'fallback');
});

test('fixcloud (v3.60): anthropicSseString has the full event sequence incl. tool input_json_delta', () => {
  const msg = FC.openaiToAnthropic({
    choices: [{ finish_reason: 'tool_calls', message: { content: 'hi', tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }, 'm');
  const sse = FC.anthropicSseString(msg);
  assert.equal(typeof sse, 'string');
  assert.match(sse, /event: message_start/);
  assert.match(sse, /event: content_block_start/);
  assert.match(sse, /"type":"text_delta","text":"hi"/);
  assert.match(sse, /"type":"input_json_delta","partial_json":"\{\\"cmd\\":\\"ls\\"\}"/);
  assert.match(sse, /event: content_block_stop/);
  assert.match(sse, /event: message_delta/);
  assert.match(sse, /"stop_reason":"tool_use"/);
  assert.match(sse, /event: message_stop/);
  // every event parses as JSON
  for (const line of sse.split('\n')) if (line.startsWith('data: ')) JSON.parse(line.slice(6));
});

test('fixcloud (v3.60): the in-process proxy is wired and never leaks the real key', () => {
  const src = mainSrc();
  assert.match(src, /function startFixcloudProxy\(\)/);
  assert.match(src, /startFixcloudProxy\(\);/);                       // started at app startup
  assert.match(src, /srv\.listen\(0, '127\.0\.0\.1'/);               // ephemeral port, loopback only
  assert.match(src, /srv\.address\(\)/);
  assert.match(src, /fixcloudProxyPort = addr/);
  assert.match(src, /const tokenForAccount = new Map\(\)/);
  assert.match(src, /function fixcloudProxyToken\(accountId\)/);
  assert.match(src, /\/chat\/completions/);                          // forwards to the OpenAI-wire endpoint
  assert.match(src, /FC\.anthropicToOpenAI\(body, model\)/);
  assert.match(src, /FC\.openaiToAnthropic\(oai, model\)/);
  assert.match(src, /FC\.anthropicSseString\(msg\)/);
  // count_tokens is answered cheaply, unknown token → 401
  assert.match(src, /count_tokens/);
  assert.match(src, /401, 'authentication_error'/);
  // the real key is decrypted only in the proxy, never logged/returned/argv
  const body = src.slice(src.indexOf('function startFixcloudProxy'), src.indexOf('let officeSock = null;'));
  assert.match(body, /const key = providerTokens\(\)\.load\(accountId\)/);
  assert.equal(/console\.(log|error)\([^)]*\bkey\b/.test(body), false, 'the key must never be logged');
});

test('fixcloud (v3.60): the claude launch injects the proxy base URL + a non-key AUTH token and unsets ANTHROPIC_API_KEY', () => {
  const src = mainSrc();
  // env injection for a fixcloud account
  assert.match(src, /env\.ANTHROPIC_BASE_URL = fixcloudBase; env\.ANTHROPIC_AUTH_TOKEN = fixcloudTok; delete env\.ANTHROPIC_API_KEY;/);
  // and re-exported after the login-shell rc files (like CLAUDE_CONFIG_DIR), with the real key never present
  assert.match(src, /export ANTHROPIC_BASE_URL='\$\{fixcloudBase\}'/);
  assert.match(src, /export ANTHROPIC_AUTH_TOKEN='\$\{fixcloudTok\}'/);
  assert.match(src, /unset ANTHROPIC_API_KEY;/);
  assert.match(src, /const fixcloudTok = fixcloud \? fixcloudProxyToken\(account\.id\) : ''/);
});

test('fixcloud (v3.60): migrateFixcloudProjects moves old opencode+fixcloud projects to claude; leaves others alone; idempotent', () => {
  const raw = {
    accounts: [{ id: 'fc', configDir: '/u/fc', provider: 'fixcloud', model: 'deepseek-v4.1-flash', baseUrl: 'https://e/v1' }],
    projects: [
      { id: 'p', dir: '/p', accountId: 'fc', engine: 'opencode', bossModel: 'fixcloud/deepseek-v4.1-flash' },
      { id: 'q', dir: '/q', engine: 'opencode', bossModel: 'opencode/big-pickle' }, // non-fixcloud opencode: untouched
    ],
  };
  const st = P.normalizeState(raw);
  assert.equal(A.isFixcloud(st.accounts.find((a) => a.id === 'fc')), true);
  const out = P.migrateFixcloudProjects(st);
  const p = P.findProject(out, 'p');
  assert.equal(P.engineOf(p), 'claude');
  assert.equal('engine' in p, false);
  assert.equal('bossModel' in p, false);
  const q = P.findProject(out, 'q');
  assert.equal(P.engineOf(q), 'opencode');
  assert.equal(q.bossModel, 'opencode/big-pickle');
  // idempotent
  assert.equal(P.migrateFixcloudProjects(out), out);
  // main.js runs it at startup
  assert.match(mainSrc(), /state = P\.migrateFixcloudProjects\(state\)/);
});

test('fixcloud (v3.60): the default model is tool-capable (deepseek), not the non-tool qwen', () => {
  assert.equal(A.FIXCLOUD_DEFAULT_MODEL, 'deepseek-v4.1-flash');
});

test('fixcloud (v3.61): contextLength knows deepseek-v4.1-flash and falls back for unknown models', () => {
  assert.equal(FC.contextLength('deepseek-v4.1-flash'), 262144);
  assert.equal(FC.contextLength('something-unknown'), 131072);
});

test('fixcloud (v3.61): anthropicToOpenAI keeps max_tokens for a tiny prompt', () => {
  const out = FC.anthropicToOpenAI({ max_tokens: 64000, messages: [{ role: 'user', content: 'hi' }] }, 'deepseek-v4.1-flash');
  assert.equal(out.max_tokens, 64000);
});

test('fixcloud (v3.61): anthropicToOpenAI clamps max_tokens for a very large prompt', () => {
  const body = { max_tokens: 64000, messages: [{ role: 'user', content: 'word '.repeat(200000) }] };
  const out = FC.anthropicToOpenAI(body, 'deepseek-v4.1-flash');
  assert.ok(out.max_tokens < 64000, `expected a clamp, got ${out.max_tokens}`);
  assert.ok(out.max_tokens >= 512, `expected the near-wall floor, got ${out.max_tokens}`);
  assert.ok(out.max_tokens <= 262144);
});

test('fixcloud (v3.61): a request without max_tokens still gets a positive output budget', () => {
  const out = FC.anthropicToOpenAI({ messages: [{ role: 'user', content: 'hi' }] }, 'deepseek-v4.1-flash');
  assert.ok(out.max_tokens >= 1024);
});

test('fixcloud (v3.62): autoCompactWindow sits below the model context wall, with a 100000 floor', () => {
  const deepseek = FC.autoCompactWindow('deepseek-v4.1-flash');
  assert.equal(deepseek, 170000);
  assert.ok(deepseek < FC.contextLength('deepseek-v4.1-flash'));
  assert.equal(FC.autoCompactWindow('something-unknown'), 100000);          // 131072 default - 90000 -> floored to 100000
  assert.ok(FC.autoCompactWindow('something-unknown') < FC.contextLength('something-unknown'));
});

test('fixcloud (v3.62): main.js forces the auto-compact window for a fixcloud session', () => {
  const src = mainSrc();
  assert.match(src, /FC\.autoCompactWindow\(account\.model\)/);
  assert.match(src, /env\.CLAUDE_CODE_AUTO_COMPACT_WINDOW = win/);
});

test('fixcloud (v3.63): a near-wall prompt gets a sub-floor output that still fits the context', () => {
  // Near the wall the old code forced the 1024 floor, so prompt + 1024 overshot the context by a hair and 400'd.
  // Size a prompt whose budget falls below the comfortable floor but whose prompt is still under the wall.
  const ctx = FC.contextLength('deepseek-v4.1-flash');                 // 262144
  // Size the prompt so the budget lands in the near-wall band (0 < budget < 1024): estimate ~ ctx - 1724 -> budget ~ 700.
  const oai = { max_tokens: 64000, messages: [{ role: 'user', content: 'x'.repeat((ctx - 1724) * 3 - 44) }] };
  FC.clampOutputTokens(oai, 'deepseek-v4.1-flash');
  assert.ok(oai.max_tokens < 1024, `near the wall output must drop below the old 1024 floor, got ${oai.max_tokens}`);
  assert.ok(oai.max_tokens >= 512, `near the wall output should use the remaining room (>= 512), got ${oai.max_tokens}`);
  const estimate = Math.ceil(JSON.stringify({ m: oai.messages, t: oai.tools || [] }).length / 3);
  assert.ok(estimate + oai.max_tokens <= ctx, `prompt + output must fit the context: ${estimate} + ${oai.max_tokens} > ${ctx}`);
});
