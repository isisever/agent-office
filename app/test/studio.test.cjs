'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/studio.js');

test('experience: office unless it is studio', () => {
  assert.equal(S.normalizeExperience('studio'), 'studio');
  for (const v of [undefined, null, '', 'Studio', 'office', 1, {}]) assert.equal(S.normalizeExperience(v), 'office');
});

test('experience is persisted in state.json and read back (main.js wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /experience: STU\.normalizeExperience\(state\.experience\)/, 'prefs() reports it');
  assert.match(src, /raw\.experience === 'studio' \? \{ experience: 'studio' \} : \{\}/, 'loaded only when studio');
  assert.match(src, /STU\.EXPERIENCES\.includes\(p\.experience\)/, 'prefs:set accepts only the two values');
});

test('recent list: valid, unique, newest first, capped', () => {
  const ids = ['a', 'b'];
  const raw = [
    { projectId: 'a', sessionId: 's1', title: 'one', dir: '/x', at: 10 },
    { projectId: 'a', sessionId: 's1', title: 'dup', dir: '/x', at: 99 },
    { projectId: 'gone', sessionId: 's2', at: 20 },
    { projectId: 'b', sessionId: 'bad id!', at: 20 },
    { projectId: 'b', sessionId: 's3', at: 30 },
    { projectId: 'b', sessionId: 's4', at: Number.NaN },
    null, 'x',
  ];
  const out = S.normalizeRecent(raw, ids);
  assert.deepEqual(out.map((r) => r.sessionId), ['s3', 's1']);
  assert.equal(out[1].title, 'one', 'the first entry of a session wins');
  assert.deepEqual(S.normalizeRecent('nope', ids), []);
  const many = Array.from({ length: 80 }, (_, i) => ({ projectId: 'a', sessionId: `s${i}`, at: i }));
  assert.equal(S.normalizeRecent(many, ids).length, S.RECENT_MAX);
  const added = S.addRecent(out, { projectId: 'a', sessionId: 's1', title: 'new', dir: '/x', at: 100 }, ids);
  assert.deepEqual(added.map((r) => [r.sessionId, r.title]), [['s1', 'new'], ['s3', '']]);
  assert.deepEqual(S.dropRecent(added, 'a', 's1').map((r) => r.sessionId), ['s3']);
});

test('24 h rule: tracked from the first time asleep, closes only closable sessions past 24 h', () => {
  const since = new Map();
  const H = 60 * 60 * 1000;
  S.trackAsleep(since, ['p:1', 'p:2', 'p'], 0);
  S.trackAsleep(since, ['p:1', 'p:2', 'p'], 10 * H);
  assert.equal(since.get('p:1'), 0, 'the first time counts');
  S.trackAsleep(since, ['p:1', 'p'], 20 * H);
  assert.equal(since.has('p:2'), false, 'woke up: dropped');
  S.trackAsleep(since, ['p:1', 'p', 'p:2'], 21 * H);
  const closable = (id) => id.includes(':');
  assert.deepEqual(S.dueToClose(since, 24 * H, closable), [], 'exactly 24 h is not more than 24 h');
  assert.deepEqual(S.dueToClose(since, 24 * H + 1, closable), ['p:1'], 'the main tab never closes; p:2 restarted its clock');
  assert.deepEqual(S.dueToClose(since, 46 * H, closable).sort(), ['p:1', 'p:2']);
});

test('session listing: main tab first, tabs by number, no shells, recent newest first per project', () => {
  const projects = [
    { id: 'a', name: 'Alpha', dir: '/w/alpha', tabs: [{ n: 3, dir: '/w/alpha' }, { n: 2, worktree: { branch: 'agent-office/2' } }, { n: 4, shell: true, dir: '/w' }, { n: 5, staffId: 'm1' }] },
    { id: 'b', name: 'Beta', dir: '/w/beta', engine: 'agy' },
  ];
  const status = [{ id: 'a', isRunning: true, isAsleep: false, attention: 'permission', tabs: [{ n: 2, isRunning: false, isAsleep: true }, { n: 3, isRunning: true, isAsleep: false }] }];
  const recent = [{ projectId: 'a', sessionId: 'old', title: '', dir: '/w/alpha', at: 1 }, { projectId: 'a', sessionId: 'new', title: 'Fix', dir: '', at: 5 }];
  const out = S.listSessions({ projects, status, recent, activeId: 'a', staff: [{ id: 'm1', name: 'Ada' }] });
  assert.deepEqual(out[0].running.map((r) => [r.ptyId, r.title, r.isRunning, r.isAsleep]), [
    ['a', 'Alpha', true, false], ['a:2', 'agent-office/2', false, true], ['a:3', 'alpha', true, false], ['a:5', 'Ada', false, false]]);
  assert.deepEqual(out[0].recent.map((r) => [r.sessionId, r.title]), [['new', 'Fix'], ['old', 'alpha']]);
  assert.equal(out[0].active, true);
  assert.equal(out[0].attention, 'permission');
  assert.deepEqual(out[1].running.map((r) => r.ptyId), ['b'], 'a project without status still lists its main tab');
  assert.equal(out[1].engine, 'agy');
  const many = Array.from({ length: 30 }, (_, i) => ({ projectId: 'b', sessionId: `s${i}`, at: i }));
  assert.equal(S.listSessions({ projects, status, recent: many })[1].recent.length, S.RECENT_PER_PROJECT);
});

test('account display name from .claude.json', () => {
  assert.equal(S.accountDisplayName({ oauthAccount: { displayName: '  Ada  ' } }), 'Ada');
  for (const v of [null, {}, { oauthAccount: {} }, { oauthAccount: { displayName: 3 } }]) assert.equal(S.accountDisplayName(v), '');
});

test('hotkeys: the toggle everywhere, Studio keys only in Studio', async () => {
  const { studioKey, otherExperience } = await import('../src/studio-keys.mjs');
  const mac = { mac: true };
  const lin = { mac: false };
  assert.deepEqual(studioKey({ ...mac, meta: true, shift: true, code: 'KeyE' }, 'office'), { type: 'toggle' });
  assert.deepEqual(studioKey({ ...lin, ctrl: true, shift: true, code: 'KeyE' }, 'studio'), { type: 'toggle' });
  assert.equal(studioKey({ ...mac, meta: true, code: 'KeyE' }, 'office'), null, '⌘E alone is not the toggle');
  assert.equal(studioKey({ ...mac, meta: true, code: 'Digit1' }, 'office'), null, 'the Office keeps ⌘1');
  assert.equal(studioKey({ ...mac, meta: true, code: 'KeyN' }, 'office'), null);
  assert.deepEqual(studioKey({ ...mac, meta: true, code: 'Digit1' }, 'studio'), { type: 'session', index: 0 });
  assert.deepEqual(studioKey({ ...mac, meta: true, code: 'Digit9' }, 'studio'), { type: 'session', index: 8 });
  assert.equal(studioKey({ ...mac, meta: true, code: 'Digit0' }, 'studio'), null, '⌘0 stays HQ');
  assert.deepEqual(studioKey({ ...mac, meta: true, code: 'KeyN' }, 'studio'), { type: 'new' });
  assert.deepEqual(studioKey({ ...mac, meta: true, code: 'KeyK' }, 'studio'), { type: 'search' });
  assert.equal(studioKey({ ...mac, meta: true, alt: true, code: 'KeyK' }, 'studio'), null);
  assert.deepEqual(studioKey({ ...lin, ctrl: true, shift: true, code: 'Digit2' }, 'studio'), { type: 'session', index: 1 });
  assert.equal(studioKey({ ...lin, ctrl: true, code: 'Digit2' }, 'studio'), null, 'Ctrl+2 goes to the terminal on Linux');
  assert.equal(otherExperience('office'), 'studio');
  assert.equal(otherExperience('studio'), 'office');
});

test('guiEligible: Studio shows Claude Code tabs as a chat, except on Windows', () => {
  const GS = require('../src/gui-session.js');
  const base = { chatView: false, terminal: false, engine: 'claude', hq: false, shell: false, platform: 'darwin' };
  assert.equal(GS.guiEligible(base), false, 'Office without the chat view');
  assert.equal(GS.guiEligible({ ...base, studio: true }), true);
  assert.equal(GS.guiEligible({ ...base, studio: true, platform: 'win32' }), false, 'Windows: terminal-backed sessions');
  assert.equal(GS.guiEligible({ ...base, studio: true, terminal: true }), false, 'a tab switched to its terminal stays there');
  assert.equal(GS.guiEligible({ ...base, studio: true, hq: true }), false, 'HQ keeps its terminal');
});

test('studio IPC validates the sender and its arguments (main.js wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /ipcMain\.handle\('studio:sessions', \(e\) => \{\n {2}if \(!fromWin\(e\)\) return null;/);
  assert.match(src, /ipcMain\.handle\('studio:open', \(e, projectId, ref\) => \{\n {2}if \(!fromWin\(e\) \|\| typeof projectId !== 'string'/);
  assert.match(src, /studioRecent\(\)\.some\(\(r\) => r\.projectId === p\.id && r\.sessionId === sid\)/, 'only a listed recent session resumes');
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(pre, /ipcRenderer\.invoke\('studio:sessions'\)/);
  assert.match(pre, /ipcRenderer\.invoke\('studio:open', projectId, ref\)/);
});
