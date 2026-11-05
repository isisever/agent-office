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

test('fixcloud (v3.64): fileReadCap bounds a Read and never raises a smaller existing cap', () => {
  assert.equal(FC.fileReadCap(undefined), 15000);        // unset -> the FixCloud cap
  assert.equal(FC.fileReadCap(0), 15000);                // 0/invalid -> the cap
  assert.equal(FC.fileReadCap(25000), 15000);            // default 25000 -> lowered to the cap
  assert.equal(FC.fileReadCap(8000), 8000);              // a smaller explicit value is kept, not raised
  assert.ok(FC.fileReadCap(undefined) < FC.contextLength('deepseek-v4.1-flash'));
});

test('fixcloud (v3.64): main.js caps the file-read output for a fixcloud session and defends it after rc', () => {
  const src = mainSrc();
  assert.match(src, /env\.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = fileRead/);
  assert.match(src, /env\.AGENT_OFFICE_FILE_READ = fileRead/);
  // the cmd wrapper re-exports it from the AGENT_OFFICE_ indirection after the login-shell rc, like the sibling caps
  assert.match(src, /AGENT_OFFICE_FILE_READ"?\s*\] && export CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS="\$AGENT_OFFICE_FILE_READ"/);
});

test('fixcloud (v3.69): main.js disables the 1M context so auto-compaction fires, and defends it after rc', () => {
  const src = mainSrc();
  assert.match(src, /env\.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'/);
  assert.match(src, /env\.AGENT_OFFICE_DISABLE_1M = '1'/);
  assert.match(src, /AGENT_OFFICE_DISABLE_1M"?\s*\] && export CLAUDE_CODE_DISABLE_1M_CONTEXT="\$AGENT_OFFICE_DISABLE_1M"/);
});

test('fixcloud (v3.67): main.js gives a slow completion generous client timeouts and a proxy abort above them', () => {
  const src = mainSrc();
  const client = Number((src.match(/const FIXCLOUD_CLIENT_TIMEOUT_MS = (\d+)/) || [])[1]);
  const upstream = Number((src.match(/const FIXCLOUD_UPSTREAM_TIMEOUT_MS = (\d+)/) || [])[1]);
  assert.ok(client > 0 && upstream > 0, 'both timeout consts must exist');
  assert.ok(upstream > client, 'the proxy abort must stay above the client timeout so the client governs');
  // the proxy abort uses the const, not the old 120s literal
  assert.match(src, /setTimeout\(\(\) => ac\.abort\(\), FIXCLOUD_UPSTREAM_TIMEOUT_MS\)/);
  assert.doesNotMatch(src, /ac\.abort\(\), 120000/);
  // set only when the env carries no positive value, mirrored to the AGENT_OFFICE_ indirection
  assert.match(src, /apiTimeout = String\(Number\(env\.API_TIMEOUT_MS\) > 0 \? env\.API_TIMEOUT_MS : FIXCLOUD_CLIENT_TIMEOUT_MS\)/);
  assert.match(src, /env\.API_TIMEOUT_MS = apiTimeout/);
  assert.match(src, /env\.AGENT_OFFICE_API_TIMEOUT = apiTimeout/);
  assert.match(src, /streamIdle = String\(Number\(env\.CLAUDE_STREAM_IDLE_TIMEOUT_MS\) > 0 \? env\.CLAUDE_STREAM_IDLE_TIMEOUT_MS : FIXCLOUD_CLIENT_TIMEOUT_MS\)/);
  assert.match(src, /env\.CLAUDE_STREAM_IDLE_TIMEOUT_MS = streamIdle/);
  assert.match(src, /env\.AGENT_OFFICE_STREAM_IDLE = streamIdle/);
  // the cmd wrapper re-exports both after the login-shell rc, like the sibling caps
  assert.match(src, /AGENT_OFFICE_API_TIMEOUT"?\s*\] && export API_TIMEOUT_MS="\$AGENT_OFFICE_API_TIMEOUT"/);
  assert.match(src, /AGENT_OFFICE_STREAM_IDLE"?\s*\] && export CLAUDE_STREAM_IDLE_TIMEOUT_MS="\$AGENT_OFFICE_STREAM_IDLE"/);
});

// v3.70: a single IMAGE block (e.g. a ~627 KB browser screenshot) must never contribute more than a small bounded
// amount to the OpenAI request. The real pixel resize needs Electron nativeImage (main.js); here a FAKE resizeFn is
// injected so the walking/threshold/placeholder logic runs under plain node --test.
const bigB64 = 'A'.repeat(200000);   // ~150 KB of base64 -> well over the 16000-char cap
const tinyResize = () => ({ data: 'QUJD', mediaType: 'image/jpeg' });   // returns a 4-char base64 (fits any cap)
const noMaxBase64 = (body) => {   // assert no base64 blob longer than a few KB survives anywhere in the OpenAI body
  const s = JSON.stringify(body);
  for (const m of s.match(/[A-Za-z0-9+/]{4000,}={0,2}/g) || []) assert.fail(`a base64 blob of ${m.length} chars leaked into the OpenAI body`);
};

test('fixcloud (v3.70): a tool_result-nested image becomes a short [image omitted] note, not base64; the tool message is small', () => {
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Browser', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
      { type: 'text', text: 'screenshot:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigB64 } },
    ] }] },
  ] };
  const oai = FC.anthropicToOpenAI(body, 'deepseek-v4.1-flash');   // translated DIRECTLY (no capImageBlocks pre-pass)
  const tool = oai.messages.find((m) => m.role === 'tool');
  assert.ok(tool, 'the tool_result becomes a role:tool message');
  assert.equal(typeof tool.content, 'string', 'an OpenAI tool message content must be a string');
  assert.match(tool.content, /\[image omitted: image\/png, ~\d+ KB\]/);
  assert.ok(!tool.content.includes(bigB64), 'the base64 must NOT be JSON.stringify\'d into the tool text');
  assert.ok(tool.content.length < 4000, `the tool message must stay small, got ${tool.content.length} chars`);
  noMaxBase64(oai);
});

test('fixcloud (v3.70): a top-level user image over the cap is downscaled and emitted as an OpenAI image_url', () => {
  const body = { messages: [{ role: 'user', content: [
    { type: 'text', text: 'what is this?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigB64 } },
  ] }] };
  const info = FC.capImageBlocks(body, tinyResize, { maxB64Chars: 16000 });
  assert.deepEqual(info, { scanned: 1, reduced: 1, removed: 0 });
  const oai = FC.anthropicToOpenAI(body, 'deepseek-v4.1-flash');
  const user = oai.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user.content), 'a user message carrying an image uses the OpenAI parts array');
  const img = user.content.find((p) => p.type === 'image_url');
  assert.ok(img, 'the downscaled image is forwarded as image_url');
  assert.equal(img.image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.ok(user.content.some((p) => p.type === 'text' && p.text === 'what is this?'));
  noMaxBase64(oai);
});

test('fixcloud (v3.70): an image whose base64 is under the cap passes through unchanged (resizeFn not called)', () => {
  const small = 'B'.repeat(100);
  const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: small } }] }] };
  const info = FC.capImageBlocks(body, () => assert.fail('resizeFn must not run for a small image'), { maxB64Chars: 16000 });
  assert.deepEqual(info, { scanned: 1, reduced: 0, removed: 0 });
  assert.equal(body.messages[0].content[0].source.data, small, 'the small image is untouched');
});

test('fixcloud (v3.70): capImageBlocks with resizeFn returning null replaces the oversized image with the note', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bigB64 } }] }] };
  const info = FC.capImageBlocks(body, () => null, { maxB64Chars: 16000 });
  assert.deepEqual(info, { scanned: 1, reduced: 0, removed: 1 });
  const block = body.messages[0].content[0];
  assert.equal(block.type, 'text');
  assert.match(block.text, /\[image omitted: image\/jpeg, ~\d+ KB\]/);
  // and such a note-only user message still translates cleanly (no image_url, plain string content), no base64 leak
  const oai = FC.anthropicToOpenAI(body, 'deepseek-v4.1-flash');
  noMaxBase64(oai);
});

test('fixcloud (v3.70): main.js runs capImageBlocks before the translation with an Electron nativeImage resizeFn', () => {
  const src = mainSrc();
  assert.match(src, /FC\.capImageBlocks\(body, resizeFn, \{ maxB64Chars: 16000 \}\)/);
  assert.match(src, /nativeImage\.createFromBuffer\(Buffer\.from\(data, 'base64'\)\)/);
  assert.match(src, /\.toJPEG\(70\)/);
  // the pre-pass must come BEFORE the anthropicToOpenAI translation
  assert.ok(src.indexOf('FC.capImageBlocks(body') < src.indexOf('FC.anthropicToOpenAI(body, model)'));
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
