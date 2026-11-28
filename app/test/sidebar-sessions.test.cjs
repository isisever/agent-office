'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/chat.js');
const S = require('../src/studio.js');

const user = (text, extra) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, ...extra });

test('sessionInfo: headless when the first user record has an sdk entrypoint or is a sidechain; strips markdown heading markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-side-'));
  const mk = (name, line) => { const f = path.join(dir, name); fs.writeFileSync(f, line + '\n'); return [f, fs.statSync(f).size]; };
  const sdk = C.sessionInfo(...mk('a.jsonl', user('# Script options - reels 023', { entrypoint: 'sdk-cli' })));
  assert.equal(sdk.headless, true);
  assert.equal(sdk.prompt, 'Script options - reels 023');
  assert.equal(C.sessionInfo(...mk('b.jsonl', user('hello', { entrypoint: 'cli' }))).headless, false);
  assert.equal(C.sessionInfo(...mk('c.jsonl', user('hello', { entrypoint: 'cli', isSidechain: true }))).headless, true);
  assert.equal(C.stripHeading('### Title # not this'), 'Title # not this');
  assert.equal(C.stripHeading('#hashtag'), '#hashtag');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mergeRecent: a headless transcript is hidden unless the app opened it or the person named it', () => {
  const hist = [
    { id: 'human', title: 'typed', at: 5 },
    { id: 'script', title: 'tpl', at: 4, headless: true },
    { id: 'kept-gui', title: 'gui chat', at: 3, headless: true },
    { id: 'named', title: 'x', at: 2, headless: true },
  ];
  const out = S.mergeRecent([], hist, { known: ['kept-gui'], names: { named: 'My name' } });
  assert.deepEqual(out.map((r) => r.sessionId), ['human', 'kept-gui', 'named']);
});

test('sidebar CSS: hover keeps the row layout (time stays in flow) and the title is clamped to 2 lines', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/studio.css'), 'utf8');
  assert.match(css, /\.st-session:hover \.st-time \{ visibility: hidden; \}/);
  assert.doesNotMatch(css, /\.st-session:hover \.st-time \{ display: none/);
  assert.match(css, /\.st-group \.st-session \.st-title \{[^}]*-webkit-line-clamp: 2[^}]*overflow: hidden/);
});
