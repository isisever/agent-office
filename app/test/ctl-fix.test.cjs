'use strict';
// v3.178 review fixes: ctlOp answer mapping, HQ / personal workspace exclusion, ask flush on hello and on clear, iOS ctl2 gating.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const LINK = fs.readFileSync(path.join(__dirname, '..', 'src', 'link.js'), 'utf8');
const body = (src, head, tail) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, src.indexOf(tail, i)); };

test('ctlOp: a project that is HQ or a personal workspace is unknown-project', () => {
  const b = body(MAIN, 'function ctlOp(', 'const t = terms.get(id);');
  assert.match(b, /r\.project\.hq/);
  assert.match(b, /r\.project\.staffOwner/);
  assert.match(b, /return 'unknown-project'/);
});

test('ctlAskList skips HQ and personal workspaces', () => {
  assert.match(body(MAIN, 'function ctlAskList(', 'for (const a of t.asks())'), /p\.project\.hq \|\| p\.project\.staffOwner/);
});

test('ctlOp answer mapping: option only for a question; text on plan/permission is a denial with feedback', () => {
  const b = body(MAIN, '  let a;\n  if (answer.decision)', 'const res = t.answer(askId, a);');
  assert.match(b, /answer\.option != null\) \{[^]*ask\.kind !== 'question'\) return 'not-allowed'/);
  assert.match(b, /allow: false, message: String\(answer\.text/);
  assert.doesNotMatch(b, /allow: true, message/);
  assert.match(b, /answer\.decision\) a = \{ allow: answer\.decision === 'allow' \}/);
  // the same mapping against the real answer line: a denial carries the message
  const GS = require('../src/gui-session.js');
  const line = GS.answerLine({ id: 'r1', kind: 'plan' }, {}, { allow: false, message: 'use a smaller step' });
  assert.match(line, /deny/);
  assert.match(line, /use a smaller step/);
});

test('link: hello with ctl2 flushes the open asks to that phone; main dedupe does not gate the per-connection send', () => {
  const b = body(LINK, "if (raw?.t === 'hello') {", "if (raw?.t === 'sess-open'");
  assert.match(b, /peers\.set\([^]*flushCtlAsks\(\)/);
  const f = body(LINK, '  flushCtlAsks() {', '  flushCtl() {');
  assert.match(f, /c\.asks \|\| \(c\.asks = new Map\(\)\)/);   // sent per connection, independent of the sink's dedupe key
  const L = require('../src/link.js');
  const Cls = L.Link || L.LinkHost || Object.values(L).find((v) => typeof v === 'function' && v.prototype?.flushCtlAsks);
  assert.ok(Cls?.prototype?.flushCtlAsks);
  const written = [];
  const self = { ctlAsks: [{ project: 'p1', ask: { askId: 'a1', kind: 'permission', at: 1, tool: 'Bash', detail: 'ls' } }], ctlSeq: 0,
    ctlConns: new Map([['pub', { conn: {}, asks: new Map() }]]), ctl2: () => true, write: (_c, m) => written.push(m) };
  Cls.prototype.flushCtlAsks.call(self);
  Cls.prototype.flushCtlAsks.call(self);
  assert.deepEqual(written.map((m) => m.t), ['ctl-ask']);   // once per connection
  self.ctlAsks = [];
  Cls.prototype.flushCtlAsks.call(self);
  assert.deepEqual(written.map((m) => m.t), ['ctl-ask', 'ctl-ask-clear']);
});

test('asks clear promptly: result, withdrawn request, exit and a superseding send push the asks', () => {
  assert.match(MAIN, /m\.type === 'result' \|\| m\.type === 'control_cancel_request'\)\) setImmediate\(pushCtlAsks\)/);
  assert.match(MAIN, /terms\.delete\(id\);\n\s+setImmediate\(pushCtlAsks\)/);
  assert.match(MAIN, /if \(supersede\) setImmediate\(pushCtlAsks\)/);
});

test('iOS controller sends ctl2 messages only to a desktop that advertised ctl2', () => {
  const C = require('../../ios/core/controller.js');
  assert.deepEqual([...C.CTL2_ONLY].sort(), ['ctl-answer', 'ctl-proj', 'ctl-send', 'ctl-stop']);
  const { CtlClient } = require('../../ios/core/ctl-client.js');
  const self = { onEvent() {}, peerCaps: null };
  CtlClient.prototype.handle.call(self, { t: 'hello', v: 2, caps: ['ctl', 'sess'] });
  assert.deepEqual(self.peerCaps, ['ctl', 'sess']);
  CtlClient.prototype.handle.call(self, { t: 'hello', v: 2, caps: ['ctl', 'sess', 'ctl2'] });
  assert.ok(self.peerCaps.includes('ctl2'));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'core', 'controller.js'), 'utf8');
  assert.match(src, /CTL2_ONLY\.has\(msg\.t\) && !client\.peerCaps\?\.includes\('ctl2'\)[^]*mac-outdated/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'AgentOfficeRemote', 'tr.lproj', 'Localizable.strings'), 'utf8'), /"Update Agent Office on your Mac"/);
});
