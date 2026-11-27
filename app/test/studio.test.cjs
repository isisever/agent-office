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
  assert.match(src, /const vx = STU\.prefsPatch\(prefs\(\), p\);/, 'prefs:set goes through prefsPatch');
  assert.match(src, /if \(vx\.clearSince\) studioSince\.clear\(\);/, 'an experience change restarts the 24 h clocks');
  assert.match(src, /if \(vx\.switchIdle\) guiSwitchIdle\(\);/, 'entering Studio moves idle tabs');
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

test('closable: only a plain extra Claude Code tab in the project folder, unlocked, with no open task', () => {
  const project = { id: 'p', name: 'P', dir: '/w/p' };
  const ok = { sid: 'abc-1', handoffLocked: false, guiTaskOpen: false };
  const tab = { n: 2 };
  assert.equal(S.closable({ project, tab }, ok), true, 'a plain extra Claude tab');
  assert.equal(S.closable({ project, tab: { n: 2, dir: '/w/p/' } }, ok), true, 'its dir is the project dir');
  assert.equal(S.closable({ project }, ok), false, 'the main tab');
  assert.equal(S.closable(null, ok), false);
  assert.equal(S.closable({ project: { ...project, hq: true }, tab }, ok), false, 'HQ');
  assert.equal(S.closable({ project: { ...project, engine: 'agy' }, tab }, ok), false, 'another engine');
  assert.equal(S.closable({ project, tab: { n: 2, staffId: 'm1' } }, ok), false, 'a desk');
  assert.equal(S.closable({ project, tab: { n: 2, worktree: { branch: 'b' } } }, ok), false, 'a worktree');
  assert.equal(S.closable({ project, tab: { n: 2, shell: true } }, ok), false, 'a shell');
  assert.equal(S.closable({ project, tab }, { ...ok, handoffLocked: true }), false, 'handoff locked');
  assert.equal(S.closable({ project, tab }, { ...ok, guiTaskOpen: true }), false, 'a task is open');
  assert.equal(S.closable({ project, tab: { n: 2, dir: '/w/other' } }, ok), false, 'its own dir (Recent resumes in the project folder)');
  assert.equal(S.closable({ project, tab }, { ...ok, sid: '' }), false, 'no session to resume');
});

test('sweepStep: only time asleep in Studio counts', () => {
  const H = 60 * 60 * 1000;
  const since = new Map();
  assert.deepEqual(S.sweepStep(since, ['p:2'], 0, 'office'), []);
  assert.equal(since.size, 0, 'nothing tracked in the Office');
  S.sweepStep(since, ['p:2'], 1 * H, 'studio');
  since.set('p:3', 0);
  assert.deepEqual(S.sweepStep(since, ['p:2', 'p:3'], 30 * H, 'office'), [], 'nothing closes in the Office');
  assert.equal(since.size, 0, 'the Office clears the clocks');
  assert.deepEqual(S.sweepStep(since, ['p:2', 'p:3'], 40 * H, 'studio'), [], 'back in Studio: the clock starts again');
  assert.equal(since.get('p:2'), 40 * H);
  assert.deepEqual(S.sweepStep(since, ['p:2', 'p:3'], 64 * H + 1, 'studio', (id) => id === 'p:2'), ['p:2']);
});

test('prefsPatch and idleMoveTarget: entering Studio moves idle tabs once, leaving moves nothing back', () => {
  const none = { patch: {}, switchIdle: false, clearSince: false, leftStudio: false };
  assert.deepEqual(S.prefsPatch({ chatView: false, experience: 'office' }, { experience: 'studio' }),
    { patch: { experience: 'studio' }, switchIdle: true, clearSince: true, leftStudio: false }, 'entering: idle tabs move');
  assert.deepEqual(S.prefsPatch({ chatView: false, experience: 'studio' }, { experience: 'office' }),
    { patch: { experience: 'office' }, switchIdle: false, clearSince: true, leftStudio: true }, 'leaving: nothing moves');
  assert.deepEqual(S.prefsPatch({ experience: 'studio' }, { experience: 'studio' }), none);
  assert.deepEqual(S.prefsPatch({ experience: 'office' }, { experience: 'nope' }), none);
  assert.deepEqual(S.prefsPatch({ chatView: false }, { chatView: true }), { ...none, patch: { chatView: true }, switchIdle: true });
  assert.deepEqual(S.prefsPatch({}, null), none);
  const m = (o) => S.idleMoveTarget({ gui: false, studio: false, studioStarted: false, chatTarget: false, studioTarget: true, ...o });
  // in Studio: an idle terminal tab moves to the chat (once: then it is one), unless Studio would start it in a terminal
  assert.equal(m({ studio: true }), true, 'entering Studio: an Office terminal tab moves');
  assert.equal(m({ studio: true, gui: true }), null, 'already a chat: no second move');
  assert.equal(m({ studio: true, studioTarget: false }), null, 'switched to its terminal by the person, HQ, Windows');
  assert.equal(m({ studio: true, gui: true, chatTarget: false }), null, 'the chat view going off in Studio moves nothing');
  // in the Office: a tab that ran as a chat in Studio keeps it; others follow the chat view (v3.108, unchanged)
  assert.equal(m({ gui: true, studioStarted: true }), null, 'leaving Studio: no move back');
  assert.equal(m({ gui: true, studioStarted: true, chatTarget: true }), null);
  assert.equal(m({}), null, 'an Office terminal stays one');
  assert.equal(m({ chatTarget: true }), true, 'the chat view turned on');
  assert.equal(m({ gui: true, chatTarget: false }), false, 'the chat view turned off (a tab not from Studio)');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /STU\.idleMoveTarget\(\{ gui: Boolean\(t\.gui\), studio, studioStarted: studioStarted\.has\(pid\), chatTarget: guiTab\(pid, r, \{ studio: false \}\), studioTarget: guiTab\(pid, r, \{ studio: true \}\) \}\) === null \|\| handoffLocked\(pid\) \|\| guiHolds\(pid\)\) continue;\n {6}const sid = idleSession\(pid\);\n {6}if \(!sid \|\| \(t\.gui && \(t\.asks\(\)\.length > 0 \|\| t\.live\(\)\.busy\)\)\) continue;/, 'busy tabs are never restarted');
  assert.match(src, /if \(vx\.leftStudio\) for \(const \[pid, t\] of terms\) if \(t\.gui\) studioStarted\.add\(pid\);/);
  assert.match(src, /guiSwitchIdle\(\); {3}\/\/ v3\.108 a tab left in the other mode/, 'the tick moves busy tabs once idle');
});

test('chat view: a GUI tab always shows its chat; Studio offers the Chat button over a terminal tab', async () => {
  const { chatShownFor, chatButtonFor } = await import('../src/chat-view.mjs');
  const f = { chatView: false, studio: false, win: false, isGui: false, chatOff: false };
  assert.equal(chatShownFor(f), false, 'Office, chat view off, a terminal tab');
  assert.equal(chatShownFor({ ...f, isGui: true }), true, 'a GUI tab started in Studio, now in the Office: its chat, not an empty terminal');
  assert.equal(chatShownFor({ ...f, isGui: true, chatView: true }), true, 'chat view on');
  assert.equal(chatShownFor({ ...f, studio: true }), false, 'Studio: a tab running in a terminal shows it');
  assert.equal(chatShownFor({ ...f, studio: true, chatOff: true }), true, 'switched from its chat: chat mode (the button brings it back)');
  assert.equal(chatShownFor({ ...f, studio: true, win: true, chatOff: true }), false, 'Windows: terminals');
  assert.equal(chatShownFor({ ...f, studio: true, hq: true }), true, 'HQ in Studio: its chat');
  assert.equal(chatShownFor({ ...f, hq: true }), false, 'HQ in the Office without the chat view');
  const b = { ...f, capable: true, hq: false };
  assert.equal(chatButtonFor(b), false, 'Office, chat view off');
  assert.equal(chatButtonFor({ ...b, chatView: true, chatOff: true }), true);
  assert.equal(chatButtonFor({ ...b, studio: true }), true, 'Studio: a terminal tab can move on a click');
  assert.equal(chatButtonFor({ ...b, studio: true, isGui: true }), false, 'already a GUI chat');
  assert.equal(chatButtonFor({ ...b, studio: true, hq: true }), false, 'HQ switches the view only');
  assert.equal(chatButtonFor({ ...b, studio: true, win: true }), false, 'Windows');
  assert.equal(chatButtonFor({ ...b, studio: true, capable: false }), false, 'a shell or another engine');
});

test('status isGui: a stopped tab reports the mode it would start in (main.js wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /function guiMode\(id\) \{\n {2}const t = terms\.get\(id\);\n {2}if \(t\) return Boolean\(t\.gui\);/);
  assert.match(src, /isGui: guiMode\(P\.tabPtyId\(p\.id, t\.n\)\)/);
});
