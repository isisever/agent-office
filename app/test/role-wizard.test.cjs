// The role wizard (contract v3.84): src/role-wizard.js prompt, conversation and reply parsing; main's IPC by source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const RW = require('../src/role-wizard.js');
const ST = require('../src/staff.js');

test('systemPrompt: the seven functions, the existing roles, packs and tools; answers in the person’s language', () => {
  const p = RW.systemPrompt({
    lang: 'tr', roles: [{ id: 'qa', name: 'QA / Test Uzmanı', department: 'rnd', description: 'Tests.' }],
    packs: [{ id: 'superpowers', name: 'superpowers' }], tools: ['canva'],
  });
  assert.match(p, /management, marketing, sales, operations, hr, finance, rnd/);
  assert.match(p, /- qa: QA \/ Test Uzmanı — rnd — Tests\./);
  assert.match(p, /superpowers: superpowers/);
  assert.match(p, /MCP servers added in Agent Office: canva/);
  assert.match(p, /in Turkish/);
  assert.match(p, /at most 3 short questions/);
  assert.deepEqual(RW.SCHEMA.properties.role.properties.department.enum, ST.DEPARTMENTS);
});

test('transcript: the conversation oldest first, only when the person spoke last; long ones cut to the newest', () => {
  assert.equal(RW.transcript([]), '');
  assert.equal(RW.transcript([{ who: 'user', text: 'a' }, { who: 'wizard', text: 'b' }]), '', 'nothing to answer');
  const t = RW.transcript([{ who: 'user', text: 'Tasarımcı lazım' }, { who: 'wizard', text: 'Hangi platform?' }, { who: 'user', text: 'Instagram' }, { who: 'x', text: 'ignored' }]);
  assert.match(t, /^Person: Tasarımcı lazım\n\nWizard: Hangi platform\?\n\nPerson: Instagram\n\nAnswer the person's last message/);
  const many = Array.from({ length: 40 }, (_, i) => ({ who: i % 2 ? 'wizard' : 'user', text: `m${i}` })).concat([{ who: 'user', text: 'last' }]);
  const cut = RW.transcript(many);
  assert.equal((cut.match(/^(Person|Wizard): /gm) || []).length, RW.MAX_MESSAGES);
  assert.doesNotMatch(cut, /Person: m0\n/);
});

test('parseReply: structured output, JSON in the text, plain text, errors; the role cleaned', () => {
  const role = { name: 'Sosyal Medya Tasarımcısı', short: 'SOSYALMEDYA', department: 'marketing', description: 'Tasarlar.', brief: 'You design.', writesCode: false, skillPacks: ['ui-ux-pro-max', 'nope'], tools: ['Canva', 'bad name!'] };
  const out = RW.parseReply(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { say: 'Tamam', questions: ['Q1', '', 'Q2'], role } }), ['ui-ux-pro-max']);
  assert.deepEqual(out, {
    say: 'Tamam', questions: ['Q1', 'Q2'],
    role: { name: 'Sosyal Medya Tasarımcısı', short: 'SOSYALM', department: 'marketing', description: 'Tasarlar.', brief: 'You design.', writesCode: false, skillPacks: ['ui-ux-pro-max'], tools: ['canva'] },
  });
  const fenced = RW.parseReply(JSON.stringify({ type: 'result', subtype: 'success', result: 'Here:\n```json\n{"say":"Hi","questions":["A?"]}\n```' }));
  assert.deepEqual(fenced, { say: 'Hi', questions: ['A?'], role: null });
  assert.deepEqual(RW.parseReply(JSON.stringify({ type: 'result', subtype: 'success', result: 'Just words.' })), { say: 'Just words.', questions: [], role: null });
  assert.deepEqual(RW.parseReply(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' })), { error: 'failed' });
  assert.deepEqual(RW.parseReply('not json'), { error: 'failed' });
  assert.equal(RW.cleanRole({ name: 'x', brief: '' }), null, 'no instructions: no role');
  assert.equal(RW.cleanRole({ name: 'x', brief: 'y', department: 'space' }).department, undefined, 'an unknown function is dropped');
});

test('main.js: roles IPC — library saved through staff.js, the wizard runs claude -p without tools, MCP or a kept session', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('roles:wizard'"), MAIN.indexOf("ipcMain.handle('roles:wizard'") + 3000);
  for (const flag of ["'-p'", "'--tools', ''", "'--strict-mcp-config'", "'--no-session-persistence'", "'--disable-slash-commands'", "'--system-prompt-file'"]) assert.ok(body.includes(flag), flag);
  assert.match(body, /if \(wizardBusy\) return \{ ok: false, error: 'busy' \}/);
  assert.match(body, /A\.accountOf\(state, null\)/);
  assert.match(MAIN, /ST\.saveCustomRole\(state\.customRoles \|\| \[\], /);
  assert.match(MAIN, /ST\.removeCustomRole\(state\.customRoles, state\.staff, /);
  assert.match(MAIN, /customRoles: ST\.normalizeCustomRoles\(raw\.customRoles\)/);
  // the stdin runner never logs or returns the output beyond the parsed reply
  const run = MAIN.slice(MAIN.indexOf('function runClaudeInput'), MAIN.indexOf('let wizardBusy'));
  assert.doesNotMatch(run, /console\.(log|error)/);
});
