import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionName, relativeParts, relativeTime, startPlan, modelName, contextLimit, contextUsage, shortTokens, firstName, startPickers, startStep, startFailure, renameText, START_WAIT_MS } from '../src/studio-ux.mjs';
import { readFileSync } from 'node:fs';

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

test('v3.120 startStep: only ok goes on; not-running and busy are tried again within the time bound; anything else fails', () => {
  assert.equal(startStep('ok', 0), 'ok');
  assert.equal(startStep('not-running', 100), 'retry');
  assert.equal(startStep('busy', START_WAIT_MS - 1), 'retry');
  assert.equal(startStep('busy', START_WAIT_MS), 'fail');
  assert.equal(startStep('not-running', 5000, 1000), 'fail');
  for (const r of ['locked', 'bad', 'gone', 'error:nope', 'error', 'moved', undefined, null, true]) assert.equal(startStep(r, 0), 'fail', String(r));
});

test('v3.120 startFailure names why a start step failed', () => {
  assert.deepEqual(startFailure('locked'), { why: 'locked', detail: '' });
  assert.deepEqual(startFailure('not-running'), { why: 'not-running', detail: '' });
  assert.deepEqual(startFailure('error: model not allowed '), { why: 'error', detail: 'model not allowed' });
  assert.deepEqual(startFailure(undefined), { why: 'other', detail: '' });
  assert.deepEqual(startFailure('error'), { why: 'other', detail: '' });
});

test('v3.120 startPickers: the chat pickers\' lock rule for a new tab; a terminal tab offers neither', () => {
  assert.deepEqual(startPickers(null), { model: true, mode: true, lock: '', shownMode: '' });
  assert.deepEqual(startPickers({ gui: true, modeLock: '' }), { model: true, mode: true, lock: '', shownMode: '' });
  assert.deepEqual(startPickers({ gui: true, modeLock: 'bypass' }), { model: true, mode: false, lock: 'bypass', shownMode: 'bypassPermissions' });
  assert.deepEqual(startPickers({ gui: true, modeLock: 'desk' }), { model: true, mode: false, lock: 'desk', shownMode: '' });
  assert.deepEqual(startPickers({ gui: false, modeLock: 'bypass' }), { model: false, mode: false, lock: '', shownMode: '' });
});

test('v3.120 startPlan drops a pick the new tab cannot apply (a held mode, a terminal tab)', () => {
  assert.deepEqual(startPlan({ model: 'opus', mode: 'plan' }, undefined, { gui: true, modeLock: 'bypass' }).settings, [['model', 'opus']]);
  assert.deepEqual(startPlan({ model: 'opus', mode: 'plan' }, undefined, { gui: false, modeLock: '' }).settings, []);
  assert.deepEqual(startPlan({ model: 'opus', mode: 'plan' }, undefined, { gui: true, modeLock: '' }).settings, [['model', 'opus'], ['mode', 'plan']]);
});

test('v3.120 renameText: one line, no control characters, at most 120 characters', () => {
  assert.equal(renameText('  a\n b\u0007c  '), 'a b c');
  assert.equal(renameText('x'.repeat(200)).length, 120);
  assert.equal(renameText(' \n '), '');
  assert.equal(renameText(5), '');
});

test('v3.120 the start screen sends the prompt only after every setting answered ok, and reuses a failed start\'s tab', () => {
  const app = readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('async function startStudioSession('), app.indexOf('async function closeTab('));
  assert.match(body, /startStep\(r, Date\.now\(\) - t0\)/);
  assert.match(body, /if \(failed\) return \{ ok: false, n, failed \};\n {2}\}\n {2}const failed = await until\('prompt'/);
  assert.match(body, /plan\.reuseN && p && tabsOf\(p\)\.some/);
  const studio = readFileSync(new URL('../renderer/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /startTab\.projectId === id && startTab\.tabMode === plan\.tabMode \? startTab\.n : 0/);
  assert.match(studio, /startLists\.get\(id\)\?\.caps \|\| null\)/);
});

test('v3.120 Studio renames a GUI session with chat:rename, never with chat:command (which restarts it)', () => {
  const studio = readFileSync(new URL('../renderer/studio.js', import.meta.url), 'utf8');
  const body = studio.slice(studio.indexOf('function renameStart('), studio.indexOf('const rel = ('));
  assert.match(body, /api\.chat\.rename\(pty, name\)/);
  assert.doesNotMatch(body, /chat\.command/);
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('chat:rename'"), main.indexOf('\n});\n', main.indexOf("ipcMain.handle('chat:rename'")));
  assert.match(h, /if \(!t\.gui\) return 'terminal';\n {2}return typePrompt\(id, cmd\)/);
  assert.doesNotMatch(h, /switchMode|startPty/);
});

test('v3.120 start screen: a mode from the account\'s list (Auto included), never bypassPermissions', () => {
  const caps = { gui: true, modeLock: '', modes: ['auto', 'default', 'dontAsk', 'bypassPermissions'] };
  assert.deepEqual(startPlan({ mode: 'auto' }, undefined, caps).settings, [['mode', 'auto']]);
  assert.deepEqual(startPlan({ mode: 'dontAsk' }, undefined, caps).settings, [['mode', 'dontAsk']]);
  assert.deepEqual(startPlan({ mode: 'bypassPermissions' }, undefined, caps).settings, []);
  assert.deepEqual(startPlan({ mode: 'auto' }, undefined, { gui: true, modeLock: '' }).settings, [['mode', 'auto']], 'fallback has auto');
  assert.deepEqual(startPlan({ mode: 'auto' }, undefined, { ...caps, modeLock: 'desk' }).settings, [], 'a desk keeps its mode');
});

test('defaultModelName: the default option names the resolved model, else the running one while on the default', async () => {
  const { defaultModelName } = await import('../src/studio-ux.mjs');
  const models = [{ value: '', label: 'Default (recommended)', resolved: 'claude-opus-5-5' }, { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5-5' }];
  assert.equal(defaultModelName(models), 'Opus 5.5');
  assert.equal(defaultModelName(models, 'claude-sonnet-5-5', 'sonnet'), 'Opus 5.5');
  assert.equal(defaultModelName([{ value: '', label: '', resolved: '' }], 'claude-opus-5-5'), 'Opus 5.5');
  assert.equal(defaultModelName([{ value: '', label: '', resolved: '' }], 'claude-sonnet-5-5', 'sonnet'), '');
  assert.equal(defaultModelName(undefined), '');
  assert.equal(defaultModelName(null, ''), '');
});
