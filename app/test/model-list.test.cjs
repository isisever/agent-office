'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const ML = require('../src/model-list.js');
const GS = require('../src/gui-session.js');
const { spawnGui } = require('../src/gui-proc.js');

// the shape claude 2.1.x answers initialize with (trimmed)
const INIT = {
  commands: [], output_style: 'default',
  models: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
    { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
    { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest' },
  ],
  account: { subscriptionType: 'max' },
};

test('parseModels: default becomes "" and comes first; labels, descriptions and resolved ids kept', () => {
  const m = ML.parseModels(INIT);
  assert.deepEqual(m.map((x) => x.value), ['', 'opus', 'fable', 'claude-haiku-4-5-20251001']);
  assert.deepEqual(m[0], { value: '', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', resolved: 'claude-opus-5-5' });
  assert.equal(m[2].label, 'Fable 5.2');
  assert.deepEqual(ML.parseModels(INIT.models), m, 'the models array alone works too');
});

test('parseModels: bad, repeated and odd entries are skipped; nothing listed → []', () => {
  assert.deepEqual(ML.parseModels(null), []);
  assert.deepEqual(ML.parseModels({}), []);
  assert.deepEqual(ML.parseModels({ models: 'x' }), []);
  const m = ML.parseModels({ models: [null, { value: 5 }, { value: 'a b' }, { value: '--model' }, { value: 'sonnet' }, { value: 'sonnet', displayName: 'again' }, { value: 'x', displayName: 'bad\nlabel' }] });
  assert.deepEqual(m.map((x) => x.value), ['sonnet', 'x']);
  assert.equal(m[0].label, 'sonnet', 'no displayName: the value');
  assert.equal(m[1].label, 'bad label', 'control characters removed');
  const many = ML.parseModels({ models: Array.from({ length: 100 }, (_, i) => ({ value: `m${i}` })) });
  assert.equal(many.length, ML.MAX_MODELS);
});

test('fallback: a session that reports nothing gets the short aliases; allowedModel checks the reported list', () => {
  assert.deepEqual(ML.pickerModels([]).map((x) => x.value), ['', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(ML.pickerModels(null), ML.FALLBACK);
  const m = ML.parseModels(INIT);
  assert.equal(ML.allowedModel(m, 'fable'), true);
  assert.equal(ML.allowedModel(m, ''), true);
  assert.equal(ML.allowedModel(m, 'sonnet'), false, 'not reported for this account');
  assert.equal(ML.allowedModel([], 'sonnet'), true, 'fallback');
  assert.equal(ML.allowedModel([], 'fable'), false);
  assert.equal(ML.allowedModel(m, undefined), false);
  assert.deepEqual(ML.modelValues(m), ['', 'opus', 'fable', 'claude-haiku-4-5-20251001']);
});

test('mergeCache: fills per account, ignores empty and identical lists, refreshes a different one', () => {
  const m = ML.parseModels(INIT);
  const a = ML.mergeCache({}, '', m, 1);
  assert.equal(a.changed, true);
  assert.deepEqual(a.cache[''], { models: m, at: 1 });
  assert.equal(ML.mergeCache(a.cache, '', [], 2).changed, false, 'a failed report never wipes a good list');
  assert.equal(ML.mergeCache(a.cache, '', ML.parseModels(INIT), 3).changed, false, 'same list');
  const b = ML.mergeCache(a.cache, '/acc/work', m.slice(0, 2), 4);
  assert.equal(b.changed, true);
  assert.deepEqual(Object.keys(b.cache).sort(), ['', '/acc/work']);
  assert.equal(a.cache['/acc/work'], undefined, 'never mutates the old cache');
  const c = ML.mergeCache(b.cache, '', m.slice(0, 1), 5);
  assert.equal(c.changed, true);
  assert.deepEqual(c.cache[''].models.map((x) => x.value), ['']);
  assert.equal(ML.mergeCache(null, 'k', m, 1).changed, true, 'a missing cache file');
  let big = {};
  for (let i = 0; i < ML.MAX_ACCOUNTS + 5; i++) big = ML.mergeCache(big, `k${i}`, m, i).cache;
  assert.equal(Object.keys(big).length, ML.MAX_ACCOUNTS);
  assert.equal(big.k0, undefined, 'the oldest goes');
});

test('cachedModels / startModels: cached list, loading default while probing, fallback after a failed probe', () => {
  const m = ML.parseModels(INIT);
  const { cache } = ML.mergeCache({}, '/acc', m, 1);
  assert.deepEqual(ML.cachedModels(cache, '/acc'), m, 'round trip through the stored shape');
  assert.equal(ML.cachedModels(cache, ''), null);
  assert.equal(ML.cachedModels({ x: { models: [{ value: 'a b' }] } }, 'x'), null, 'a tampered file is re-checked');
  assert.deepEqual(ML.startModels(cache, '/acc', false), { models: m, loading: false });
  assert.deepEqual(ML.startModels(cache, '', true), { models: [ML.FALLBACK[0]], loading: true });
  assert.deepEqual(ML.startModels(cache, '', false), { models: ML.FALLBACK, loading: false });
  assert.equal(ML.accountKey(undefined), '');
  assert.equal(ML.accountKey('/x'), '/x');
});

test('settingLine: model values come from the session list', () => {
  const p = (s) => JSON.parse(s);
  assert.equal(GS.settingLine('a', 'model', 'fable'), null, 'fallback list');
  assert.deepEqual(p(GS.settingLine('a', 'model', 'fable', ['', 'fable'])).request, { subtype: 'set_model', model: 'fable' });
  assert.equal(GS.settingLine('a', 'model', 'opus', ['', 'fable']), null);
});

test('GUI chat: initialize answer gives the models; set_model is checked against them', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 7, written: /** @type {any[]} */ ([]), stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  child.stdin = Object.assign(new EventEmitter(), { destroyed: false, write: (s) => { child.written.push(JSON.parse(s)); return true; } });
  const reported = [];
  const t = spawnGui(() => child, 'sh', [], { cwd: '/', env: {} }, { killGroup: () => {}, onModels: (m) => reported.push(m) });
  assert.equal(child.written[0].request.subtype, 'initialize');
  assert.deepEqual(t.models(), []);
  assert.equal(await t.setting('model', 'fable'), 'bad', 'fallback until claude answers');
  child.stdout.emit('data', `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'ao-initialize', response: INIT } })}\n`);
  assert.deepEqual(t.models().map((x) => x.value), ['', 'opus', 'fable', 'claude-haiku-4-5-20251001']);
  assert.equal(reported.length, 1);
  assert.equal(await t.setting('model', 'sonnet'), 'bad', 'not this account\'s');
  const p = t.setting('model', 'fable');
  const req = child.written.at(-1);
  assert.deepEqual(req.request, { subtype: 'set_model', model: 'fable' });
  child.stdout.emit('data', `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id } })}\n`);
  assert.equal(await p, 'ok');
});

test('GUI chat: an error or empty initialize answer keeps the fallback and reports nothing', () => {
  const child = Object.assign(new EventEmitter(), { pid: 8, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  child.stdin = Object.assign(new EventEmitter(), { destroyed: false, write: () => true });
  const reported = [];
  const t = spawnGui(() => child, 'sh', [], { cwd: '/', env: {} }, { killGroup: () => {}, onModels: (m) => reported.push(m) });
  child.stdout.emit('data', `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'ao-initialize', error: 'x' } })}\n`);
  assert.deepEqual(t.models(), []);
  assert.equal(reported.length, 0);
});

// v3.120 auto mode and the account's permission-mode list
const PROBE_ERROR = 'Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan';

test('v3.120 modes: the probe error and an initialize list parse; bad, repeated and the probe value are skipped', () => {
  assert.deepEqual(ML.parseModes(PROBE_ERROR), ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan']);
  assert.deepEqual(ML.parseModes('Cannot set permission mode: must be one of "default", plan or auto.'), ['default', 'plan', 'auto']);
  assert.deepEqual(ML.parseModes(['default', 'default', 'bad mode', '', 7, '__ao_probe__', 'plan']), ['default', 'plan']);
  assert.deepEqual(ML.parseModes('something else went wrong'), []);
  assert.deepEqual(ML.parseModes(null), []);
});

test('v3.120 modes: the picker shows every reported mode except bypassPermissions, Auto first; fallback = old list + auto', () => {
  const reported = ML.parseModes(PROBE_ERROR);
  assert.deepEqual(ML.pickerModes(reported), ['auto', 'default', 'acceptEdits', 'plan', 'dontAsk']);
  assert.deepEqual(ML.pickerModes(null), ['auto', 'default', 'acceptEdits', 'plan']);
  assert.deepEqual(ML.pickerModes([]), ML.pickerModes(undefined));
  assert.ok(ML.allowedMode(reported, 'dontAsk'));
  assert.ok(!ML.allowedMode(reported, 'bypassPermissions'), 'never chosen in a picker');
  assert.ok(!ML.allowedMode(null, 'dontAsk'), 'the fallback does not know it');
  assert.ok(ML.allowedMode(null, 'auto'));
  assert.ok(!ML.allowedMode(reported, 'nope'));
});

test('v3.120 modes: cached per account next to the models; a models update keeps them, an empty report never wipes them', () => {
  let { cache, changed } = ML.mergeCache({}, '', [{ value: 'opus', label: 'Opus', description: '', resolved: '' }], 1);
  ({ cache, changed } = ML.mergeModes(cache, '', ML.parseModes(PROBE_ERROR), 2));
  assert.ok(changed);
  assert.deepEqual(ML.cachedModes(cache, ''), ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan']);
  assert.equal(ML.mergeModes(cache, '', [], 3).changed, false);
  assert.equal(ML.mergeModes(cache, '', ML.parseModes(PROBE_ERROR), 3).changed, false);
  ({ cache } = ML.mergeCache(cache, '', [{ value: 'sonnet', label: 'Sonnet', description: '', resolved: '' }], 4));
  assert.ok(ML.cachedModes(cache, ''), 'a new model list keeps the modes');
  assert.equal(ML.cachedModes(cache, '/other'), null);
  assert.equal(ML.cachedModes({ '': { modes: ['bad mode'] } }, ''), null);
  const line = JSON.parse(ML.modeProbeLine('ao-probe-mode'));
  assert.deepEqual(line.request, { subtype: 'set_permission_mode', mode: '__ao_probe__' });
});

test('v3.120 modes: settingLine takes a mode from the list main passes, never bypassPermissions', () => {
  const modes = ML.pickerModes(ML.parseModes(PROBE_ERROR));
  assert.equal(JSON.parse(GS.settingLine('s1', 'mode', 'auto', undefined, modes)).request.mode, 'auto');
  assert.equal(JSON.parse(GS.settingLine('s1', 'mode', 'dontAsk', undefined, modes)).request.mode, 'dontAsk');
  assert.equal(GS.settingLine('s1', 'mode', 'dontAsk'), null, 'not in the fallback');
  assert.equal(GS.settingLine('s1', 'mode', 'bypassPermissions', undefined, ['bypassPermissions']), null);
  assert.ok(GS.settingLine('s1', 'mode', 'auto'), 'auto is in the fallback');
});

test('v3.120 modes: main probes only a throwaway session and wires Auto to the project\'s Auto-approve', () => {
  const MAIN = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  const fnBody = (name) => { const i = MAIN.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return MAIN.slice(i, MAIN.indexOf('\n}\n', i)); };
  // the mode probe line is written only by probeModels (its temp-folder session), never to a real tab
  assert.equal(MAIN.split('ML.modeProbeLine(').length - 1, 1);
  assert.match(fnBody('probeModels'), /ML\.modeProbeLine\('ao-probe-mode'\)/);
  assert.match(fnBody('probeModels'), /mkdtempSync/);
  // chat:setting checks the reported list, and only an ok auto turns Auto-approve on (never off)
  const i = MAIN.indexOf("ipcMain.handle('chat:setting'");
  const body = MAIN.slice(i, MAIN.indexOf('\n});\n', i));
  assert.match(body, /ML\.allowedMode\(modes, /);
  assert.match(body, /r === 'ok' && String\(key\) === 'mode' && STU\.turnsAutoApproveOn\(String\(value\)\) && project && !project\.hq\)/);
  // a late ok never turns Auto-approve back on after the person changed it (state read before the await)
  assert.ok(body.indexOf('const before = ') < body.indexOf('await t.setting('), 'Auto-approve noted before the await');
  assert.match(body, /STU\.autoApproveAfterSet\(\{ before, after: P\.autoApproveOf\(now\), epochBefore: epoch, epochAfter: autoApproveEpoch \}\)\) autoApproveOn\(project\.id\)/);
  assert.match(body, /STU\.modelListPending\(/);
  // the probe: no MCP servers, one per account, back-off also when the modes are missing; quit ends every probe
  assert.match(fnBody('probeModels'), /GS\.PROBE_FLAGS/);
  assert.ok(GS.PROBE_FLAGS.includes('--strict-mcp-config'));
  assert.match(fnBody('probeModels'), /ML\.probeDue\(/);
  assert.match(fnBody('probeModels'), /if \(!found \|\| !modesFound\) modelProbeFailed\.set/);
  assert.match(MAIN, /app\.on\('before-quit', \(\) => \{[^\n]*for \(const end of \[\.\.\.modelProbes\.values\(\)\]\) end\(\)/);
  // a GUI chat starts in auto only from the account's REPORTED modes (never the fallback list)
  assert.match(MAIN, /guiStartModeArgs\(\{[^\n]*modes: reportedModesOf\(project\)/);
  // a GUI chat never gets the plugin's start-time Auto-approve (main's guiAsk reads the live setting)
  assert.match(MAIN, /if \(gui\) delete env\.AGENT_OFFICE_AUTO_APPROVE;/);
  assert.match(fnBody('autoApproveOn'), /P\.setProjectAutoApprove\(state, projectId, true\)/);
  assert.doesNotMatch(fnBody('autoApproveOn'), /false/);
  // a GUI ask reads the project's current Auto-approve and goes through the same rules as the Office (GS.autoAllows)
  assert.match(MAIN, /onAsk: \(ask, input\) => guiAsk\(id, ask, input, \{ autoApprove: !project\.hq && P\.autoApproveOf\(P\.findProject\(state, project\.id\) \|\| project\)/);
  assert.match(fnBody('guiAsk'), /GS\.autoAllows\(\{ tool: ask\.tool, input, autoApprove, mailGuard, canAutoApprove: AA \? AA\.canAutoApprove : null \}\)/);
});

test('v3.120 GUI asks: Auto-approve answers only what the manager\'s rules allow', () => {
  const allow = (tool) => tool === 'Read';
  assert.equal(GS.autoAllows({ tool: 'Read', input: {}, autoApprove: true, mailGuard: false, canAutoApprove: allow }), true);
  assert.equal(GS.autoAllows({ tool: 'Bash', input: {}, autoApprove: true, mailGuard: false, canAutoApprove: allow }), false, 'the rules say no');
  assert.equal(GS.autoAllows({ tool: 'Read', input: {}, autoApprove: false, mailGuard: false, canAutoApprove: allow }), false, 'Auto-approve off');
  assert.equal(GS.autoAllows({ tool: 'Read', input: {}, autoApprove: true, mailGuard: true, canAutoApprove: allow }), false, 'a mail desk');
  assert.equal(GS.autoAllows({ tool: 'AskUserQuestion', input: {}, autoApprove: true, mailGuard: false, canAutoApprove: () => true }), false, 'a question is the person\'s');
  assert.equal(GS.autoAllows({ tool: 'Read', input: {}, autoApprove: true, mailGuard: false, canAutoApprove: null }), false, 'no rules: no answer');
});

test('GUI chat: modelsKnown turns true only when claude answers the initialize (success or error)', () => {
  for (const subtype of ['success', 'error']) {
    const child = Object.assign(new EventEmitter(), { pid: 9, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    child.stdin = Object.assign(new EventEmitter(), { destroyed: false, write: () => true });
    const t = spawnGui(() => child, 'sh', [], { cwd: '/', env: {} }, { killGroup: () => {} });
    assert.equal(t.modelsKnown(), false, 'a new tab: the list is not known yet');
    child.stdout.emit('data', `${JSON.stringify({ type: 'control_response', response: { subtype, request_id: 'ao-initialize', response: INIT, error: 'x' } })}\n`);
    assert.equal(t.modelsKnown(), true, subtype);
  }
});

test('parseModes: only the known modes; an unknown name from the error text is never offered', () => {
  assert.deepEqual(ML.parseModes('Cannot set permission mode: must be one of default, yolo, plan, superAuto, auto'), ['default', 'plan', 'auto']);
  assert.deepEqual(ML.parseModes(['dontAsk', 'acceptEdits', 'mystery']), ['dontAsk', 'acceptEdits']);
  assert.equal(ML.pickerModes(ML.parseModes(['yolo'])).includes('yolo'), false);
});

test('probeDue: one probe per account; the back-off holds when the models came but the modes did not', () => {
  const retry = 300000;
  assert.equal(ML.probeDue({ running: true, retry, now: 1e9 }), false, 'never two at a time');
  assert.equal(ML.probeDue({ hasModels: true, hasModes: true, retry, now: 1e9 }), false, 'nothing missing');
  assert.equal(ML.probeDue({ hasModels: true, hasModes: false, retry, now: 1e9 }), true, 'never probed: go');
  assert.equal(ML.probeDue({ hasModels: true, hasModes: false, failedAt: 1e9 - 1000, retry, now: 1e9 }), false, 'modes missing: still backs off');
  assert.equal(ML.probeDue({ hasModels: false, hasModes: false, failedAt: 1e9 - retry, retry, now: 1e9 }), true, 'after the back-off');
});
