// Contract v3.110: a tab with an open task (a paired device's, or this machine's queue) is held from a mode switch
// restart; a failed chat:mode keeps the tab's mode; the tabs switched to the terminal are kept in state.json.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/link-core.js');
const { Link } = require('../src/link.js');
const LH = require('../src/link-host.js');
const GS = require('../src/gui-session.js');

const PA = C.hex(Buffer.alloc(32, 1));
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const bodyOf = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, src.indexOf('\n}\n', i)); };

/** A real link host (src/link-host.js) with one paired device and two tabs: p1 and p2. */
function host(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-guiholds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tabs = { p1: 'busy', p2: 'ready' };
  const typed = [];
  let captured = null;
  const realOn = Link.prototype.on;
  Link.prototype.on = function (ev, fn) { captured = this; return realOn.call(this, ev, fn); };
  t.after(() => { Link.prototype.on = realOn; });
  const reportsDir = path.join(dir, 'reports');
  const h = LH.setupLink({
    app: { getPath: () => dir, getVersion: () => '0.22.0' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: () => {} }, send: () => {}, notify: () => {}, T: (k) => k, loginOf: () => 'in', reportsDir,
    projects: () => [{ id: 'p1', name: 'one', engine: 'claude' }, { id: 'p2', name: 'two', engine: 'claude' }],
    tabState: (id) => tabs[id] || 'gone',
    type: (id, text) => { typed.push([id, text]); },
  });
  t.after(() => h.destroy());
  h.devices();   // starts the link
  const link = captured;
  link.devices = [{ pub: PA, name: 'Laptop', addedAt: 0, own: true, allowHandoff: false, allowAccounts: false }];
  link.secrets = { [PA]: 'ab'.repeat(32) };
  const report = (id) => { fs.mkdirSync(reportsDir, { recursive: true }); fs.writeFileSync(path.join(reportsDir, `${id}.json`), JSON.stringify({ summary: 'done' })); h.scanReports(); };
  return { h, link, tabs, typed, report };
}

test('v3.110 a paired device\'s task holds its tab while queued and after it is typed, until it reports', (t) => {
  const { h, link, tabs, typed, report } = host(t);
  assert.equal(h.taskOpenIn('p1'), false);
  const replies = [];
  link.emit('command', { device: { pub: PA, name: 'Laptop' }, id: 'rt1', project: 'p1', text: 'remote task', report: true, reply: (s) => replies.push(s) });
  h.pump();
  assert.deepEqual(replies, ['queued'], 'the tab is busy: the task waits in the queue');
  assert.equal(h.taskOpenIn('p1'), true, 'held while queued');
  assert.equal(h.taskOpenIn('p2'), false, 'another tab is not held');

  tabs.p1 = 'ready';
  h.pump();
  assert.deepEqual(replies, ['queued', 'delivered']);
  assert.equal(typed.length, 1);
  assert.equal(link.owesReport('rt1'), true);
  assert.equal(h.taskOpenIn('p1'), true, 'typed, not reported: an idle-looking tab is still held (the gap this closes)');

  report('rt1');
  assert.equal(link.owesReport('rt1'), false);
  assert.equal(h.taskOpenIn('p1'), false, 'reported: free to switch');

  // a plain command (no report) never holds the tab
  link.emit('command', { device: { pub: PA, name: 'Laptop' }, id: 'c1', project: 'p1', text: 'plain', report: false, reply: () => {} });
  h.pump();
  assert.equal(h.taskOpenIn('p1'), false);
});

test('v3.110 a task of this machine\'s queue (HQ, a routine) holds its tab until its report; the hold expires', (t) => {
  const { h, tabs, report } = host(t);
  tabs.p1 = 'ready';
  const mine = h.dispatchLocal('p2', 'local task', 'HQ', () => {});
  h.pump();
  assert.equal(mine.status, 'delivered');
  assert.equal(h.taskOpenIn('p2'), true);
  assert.equal(h.taskOpenIn('p1'), false);
  report(mine.id);
  assert.equal(h.taskOpenIn('p2'), false);

  // the pure check: a local entry older than LOCAL_OPEN_MS no longer holds (and is dropped)
  const into = new Map([['x', { tab: 'p2', at: 0 }]]);
  assert.equal(LH.taskOpenIn(new Map(), null, into, 'p2', LH.LOCAL_OPEN_MS - 1), true);
  assert.equal(LH.taskOpenIn(new Map(), null, into, 'p2', LH.LOCAL_OPEN_MS), false);
  assert.equal(into.size, 0);
  assert.equal(LH.taskOpenIn(new Map([['p2', [{ report: true, device: { pub: 'self' } }]]]), null, new Map(), 'p2', 0), true, 'a queued local task holds too');
});

test('v3.110 wiring: guiHolds asks the link host; the terminal choice is saved, pruned and seeded', () => {
  const holds = bodyOf(MAIN, 'function guiHolds(');
  assert.match(holds, /if \(linkHost\?\.taskOpenIn\(pid\)\) return true;/);
  // termTabs: kept in state on every save, read back at load, offered to the renderer
  assert.match(bodyOf(MAIN, 'function saveState('), /keepTermTabs\(\);/);
  assert.match(bodyOf(MAIN, 'function keepTermTabs('), /GS\.cleanTermTabs\(\[\.\.\.termTabs\], state\.projects\.flatMap\(\(p\) => P\.ptyIdsOf\(p\)\)\)/);
  assert.match(MAIN, /for \(const id of GS\.cleanTermTabs\(raw\.termTabs, /);
  assert.match(MAIN, /termTabs: \[\.\.\.termTabs\]/);
  const mode = MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:mode'"), MAIN.indexOf("ipcMain.on('pty:wake'"));
  assert.equal((mode.match(/saveState\(\)/g) || []).length, 2, 'saved on ok and on moved, never on a refused switch');
  assert.ok(mode.indexOf('undo(); return \'busy\'') < mode.lastIndexOf('saveState()'));

  assert.deepEqual(GS.cleanTermTabs(['p1', 'p1', 'gone', 3, null, 'p1:2'], ['p1', 'p1:2', 'p2']), ['p1', 'p1:2']);
  assert.deepEqual(GS.cleanTermTabs('p1', ['p1']), []);
  assert.equal(GS.cleanTermTabs(Array.from({ length: 600 }, (_, i) => `t${i}`), Array.from({ length: 600 }, (_, i) => `t${i}`)).length, 500);

  // the renderer: an IPC error keeps the mode and shows the error; chatOff starts from main's list once
  const set = bodyOf(APP, 'async function setChatMode(');
  assert.doesNotMatch(set, /r = 'ok'; \}/, 'an error is no longer taken for ok');
  assert.match(set, /if \(failed \|\| r === 'busy' \|\| r === 'locked'\)/);
  assert.match(set, /t\('chat\.gui\.switchFailed', \{ error: failed \}\)/);
  assert.ok(set.indexOf('return;') < set.indexOf('chatOff.add(id)'), 'returns before the view flips');
  assert.match(bodyOf(APP, 'function applyChatView('), /if \(!chatOffSeeded && Array\.isArray\(p\?\.termTabs\)\)/);
  for (const lang of ['en', 'tr']) {
    const L = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'));
    assert.match(L.chat.gui.switchFailed, /\{error\}/, lang);
  }
});
