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
