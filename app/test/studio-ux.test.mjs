import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionName, relativeParts, relativeTime, startPlan, modelName, contextLimit, contextUsage, shortTokens, firstName } from '../src/studio-ux.mjs';

test('sessionName: /rename, then Claude Code title, then the first prompt, else empty', () => {
  assert.equal(sessionName({ custom: 'Mine', ai: 'AI', prompt: 'p' }), 'Mine');
  assert.equal(sessionName({ ai: ' Fix   the\nbuild ', prompt: 'p' }), 'Fix the build');
  assert.equal(sessionName({ title: 'From list', prompt: 'p' }), 'From list');
  assert.equal(sessionName({ prompt: 'hello there' }), 'hello there');
  assert.equal(sessionName({}), '');
  assert.equal(sessionName(null), '');
  assert.equal(sessionName({ prompt: 'x'.repeat(100) }, 10), `${'x'.repeat(9)}…`);
});

test('relativeParts and relativeTime', () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeParts(0, now), null);
  assert.equal(relativeParts(NaN, now), null);
  assert.deepEqual(relativeParts(now - 10_000, now), { value: 0, unit: 'now' });
  assert.deepEqual(relativeParts(now + 60_000, now), { value: 0, unit: 'now' });
  assert.deepEqual(relativeParts(now - 5 * 60_000, now), { value: -5, unit: 'minute' });
  assert.deepEqual(relativeParts(now - 3 * 3600_000, now), { value: -3, unit: 'hour' });
  assert.deepEqual(relativeParts(now - 2 * 86400_000, now), { value: -2, unit: 'day' });
  assert.deepEqual(relativeParts(now - 14 * 86400_000, now), { value: -2, unit: 'week' });
  assert.deepEqual(relativeParts(now - 400 * 86400_000, now), { value: -1, unit: 'year' });
  assert.equal(relativeTime(now - 10_000, now, 'en', 'now'), 'now');
  assert.match(relativeTime(now - 5 * 60_000, now, 'en'), /5 min/);
  assert.equal(relativeTime(0, now), '');
  assert.ok(relativeTime(now - 86400_000, now, 'tr').length > 0);
});

test('startPlan maps the start screen choices to a tab mode and settings', () => {
  assert.deepEqual(startPlan({}), { tabMode: 'same', settings: [] });
  assert.deepEqual(startPlan(null), { tabMode: 'same', settings: [] });
  assert.deepEqual(startPlan({ worktree: true, model: 'opus', mode: 'plan' }), { tabMode: 'worktree', settings: [['model', 'opus'], ['mode', 'plan']] });
  assert.deepEqual(startPlan({ model: 'gpt', mode: 'bypassPermissions' }), { tabMode: 'same', settings: [] });
  assert.deepEqual(startPlan({ worktree: 'yes', mode: 'acceptEdits' }), { tabMode: 'same', settings: [['mode', 'acceptEdits']] });
});

test('modelName reads model ids', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(modelName('claude-opus-4-8[1m]'), 'Opus 4.8 (1M)');
  assert.equal(modelName('opus'), 'Opus');
  assert.equal(modelName('some-other-model'), 'some-other-model');
  assert.equal(modelName(''), '');
  assert.equal(modelName(null), '');
});

test('contextUsage and its limit', () => {
  assert.equal(contextLimit('claude-opus-5-5'), 200000);
  assert.equal(contextLimit('claude-opus-5-5[1m]'), 1000000);
  assert.equal(contextUsage(null), null);
  assert.equal(contextUsage({ input_tokens: 0 }), null);
  assert.deepEqual(contextUsage({ input_tokens: 10, cache_read_input_tokens: 49_990, cache_creation_input_tokens: 0, output_tokens: 999 }, 'claude-opus-5-5'), { used: 50_000, limit: 200_000, pct: 25 });
  assert.deepEqual(contextUsage({ input_tokens: 500_000 }, 'x', 400_000), { used: 500_000, limit: 400_000, pct: 100 });
  assert.equal(shortTokens(812), '812');
  assert.equal(shortTokens(12_400), '12k');
  assert.equal(shortTokens(1_500), '1.5k');
  assert.equal(shortTokens(1_200_000), '1.2M');
});

test('firstName', () => {
  assert.equal(firstName('Ada  Lovelace'), 'Ada');
  assert.equal(firstName(''), '');
  assert.equal(firstName(undefined), '');
});

test('startPlan takes a model only from the offered list (the account\'s reported models)', () => {
  assert.deepEqual(startPlan({ model: 'fable' }).settings, [], 'not in the fixed list');
  assert.deepEqual(startPlan({ model: 'fable' }, ['', 'fable']).settings, [['model', 'fable']]);
  assert.deepEqual(startPlan({ model: 'opus' }, ['', 'fable']).settings, []);
});
