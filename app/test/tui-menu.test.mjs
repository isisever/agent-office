// Chat view menus (contract v3.80): src/tui-menu.mjs reads Claude Code's open menu off a terminal screen.
// The screens below were captured from Claude Code 2.1.286 in a pty (110 columns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMenu, isFreeOption, isApproval, menuKey } from '../src/tui-menu.mjs';

const RULE = '─'.repeat(110);
const DASH = '╌'.repeat(110);
const screen = (s) => s.split('\n');

const PERMISSION = screen(`⏺ Creating probe-file.txt
  ⎿  $ touch probe-file.txt
${RULE}
 Bash command
 Create probe-file.txt
${DASH}
 touch probe-file.txt
${DASH}
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /private/tmp/claude-501/x/
      scratchpad/probe from this project
   3. No
 Esc to cancel · Tab to amend`);

const QUESTION = screen(`❯ Use AskUserQuestion
${RULE}
 ☐ Color
Which color?
❯ 1. Red (warm)
     A warm color
  2. Blue (cool)
     A cool color
  3. Type something.
${RULE}
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`);

const MULTI = screen(`${RULE}
←  ☐ Fruits  ✔ Submit  →
Which fruits?
❯ 1. [✔] Apple
         A crisp red or green fruit
  2. [ ] Pear
         A sweet green or yellow fruit
  3. [✔] Plum
         A small purple or yellow stone fruit
  4. [ ] Type something
     Submit
${RULE}
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`);

const REVIEW = screen(`${RULE}
←  ☒ Fruits  ✔ Submit  →
Review your answers
 ● Which fruits?
   → Apple, Plum
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel`);

test('parseMenu: an approval, with its command as the title', () => {
  const m = parseMenu(PERMISSION);
  assert.deepEqual(m.title, ['Bash command', 'Create probe-file.txt', 'touch probe-file.txt', 'Do you want to proceed?']);
  assert.deepEqual(m.options.map((o) => [o.n, o.label]), [[1, 'Yes'], [2, 'Yes, and always allow access to /private/tmp/claude-501/x/'], [3, 'No']]);
  assert.equal(m.options[1].desc, 'scratchpad/probe from this project');
  assert.deepEqual([m.cursor, m.multi, m.tabs], [1, false, false]);
});

test('parseMenu: a question, its descriptions, the free-text option and the one past the rule', () => {
  const m = parseMenu(QUESTION);
  assert.deepEqual(m.title, ['☐ Color', 'Which color?']);
  assert.deepEqual(m.options.map((o) => o.label), ['Red (warm)', 'Blue (cool)', 'Type something.', 'Chat about this']);
  assert.equal(m.options[0].desc, 'A warm color');
  assert.deepEqual(m.options.map(isFreeOption), [false, false, true, false]);
});

test('parseMenu: a multi-select shows its checkboxes; the tab row and the Submit row are flags', () => {
  const m = parseMenu(MULTI);
  assert.deepEqual(m.title, ['Which fruits?']);
  assert.deepEqual(m.options.map((o) => o.checked), [true, false, true, false, undefined]);
  assert.deepEqual([m.multi, m.tabs, m.submitRow], [true, true, true]);
  assert.equal(isFreeOption(m.options[3]), true);
  assert.notEqual(menuKey(m), menuKey(parseMenu(QUESTION)));
});

test('parseMenu: no menu without the key hint (a numbered answer, the prompt), except the review step', () => {
  const review = parseMenu([...REVIEW, '', '']);
  assert.deepEqual(review.options.map((o) => o.label), ['Submit answers', 'Cancel'], 'the review step has no hint: taken by its title');
  assert.equal(parseMenu(REVIEW.map((l) => l.replace('Ready to submit your answers?', 'Ready?'))), null, 'other hintless lists are not');
  assert.equal(parseMenu(screen(`⏺ Steps:
  1. Install
  2. Run
${RULE}
❯
${RULE}
  ⏸ manual mode on · ? for shortcuts`)), null);
  assert.equal(parseMenu([]), null);
  assert.equal(parseMenu(screen(` 1. Only one
 Esc to cancel`)), null, 'one option is not a menu');
  assert.equal(parseMenu(screen(` 1. a
 3. b
 Esc to cancel`)), null, 'numbers must run 1…n');
});

test('parseMenu: truncated says when the text above the options is not all in the title', () => {
  assert.equal(parseMenu(PERMISSION).truncated, false);
  assert.equal(parseMenu(QUESTION).truncated, false);
  const body = Array.from({ length: 12 }, (_, n) => ` line ${n + 1} of the command`);
  const tail = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend'];
  const long = parseMenu([RULE, ' Bash command', DASH, ...body, DASH, ...tail]);
  assert.equal(long.truncated, true, 'more than 8 lines above the options');
  assert.equal(long.title.length, 8);
  assert.equal(long.title[7], 'Do you want to proceed?', 'the lines nearest the options are kept');
  assert.equal(long.title[0], 'line 6 of the command');
  // exactly 8 lines under the rule: nothing is cut
  const exact = parseMenu([RULE, ' Bash command', ...body.slice(0, 6), ...tail]);
  assert.equal(exact.truncated, false);
  assert.equal(exact.title.length, 8);
  // the start of the request has scrolled off the top of the screen (no rule above it)
  const offTop = parseMenu([...body.slice(0, 3), DASH, ...tail]);
  assert.equal(offTop.truncated, true);
  assert.equal(offTop.title.length, 4);
  assert.notEqual(menuKey(offTop), menuKey({ ...offTop, truncated: false }), 'the card is redrawn when the cut changes');
});

test('isApproval: a permission prompt, not a question or the review step', () => {
  assert.equal(isApproval(parseMenu(PERMISSION)), true);
  assert.equal(isApproval(parseMenu(QUESTION)), false);
  assert.equal(isApproval(parseMenu(REVIEW)), false);
  assert.equal(isApproval({ title: ['Would you like to proceed?'], options: [{ n: 1, label: 'Yes, and auto-accept edits' }, { n: 2, label: 'No, keep planning' }] }), true);
  assert.equal(isApproval({ title: ['Do you want to make this edit to a.js?'], options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }), true);
  assert.equal(isApproval({ title: ['Select model'], options: [{ n: 1, label: 'Default' }, { n: 2, label: 'Opus' }] }), false);
  assert.equal(isApproval(null), false);
});

test('liveStatus: the spinner row while Claude Code works, nothing when idle', async () => {
  const { liveStatus } = await import('../src/tui-menu.mjs');
  const working = ['⏺ Here is a poem', '', '✻ Creating… (10s · ↓ 875 tokens · thinking)', '', RULE, '❯ ', RULE, '  ⏸ manual mode on · esc to interrupt'];
  assert.deepEqual(liveStatus(working), { busy: true, text: 'Creating… (10s · ↓ 875 tokens · thinking)' });
  assert.deepEqual(liveStatus(['· Channeling…', '  esc to interrupt']), { busy: true, text: 'Channeling…' });
  assert.deepEqual(liveStatus(['✻ Worked for 12s', RULE, '❯ ', RULE, '  ? for shortcuts']), { busy: false, text: '' });
  assert.deepEqual(liveStatus(['· a bullet in an answer…', 'esc to interrupt']).busy, true);
  assert.deepEqual(liveStatus([]), { busy: false, text: '' });
});

test('openDialog: a dialog parseMenu does not read is shown as its text, never the prompt or a working row', async () => {
  const { openDialog, parseMenu } = await import('../src/tui-menu.mjs');
  const d = openDialog(['answer text', RULE, ' Select model', '   Sonnet', ' ❯ Opus', '', ' ↑/↓ to navigate · Enter to confirm · Esc to exit']);
  assert.deepEqual(d.lines, ['Select model', 'Sonnet', '❯ Opus', '↑/↓ to navigate · Enter to confirm · Esc to exit']);
  assert.deepEqual(d.numbers, []);
  assert.equal(openDialog(['✻ Creating… (3s)', RULE, '❯ ', RULE, '  ⏸ manual mode on · esc to interrupt']), null);
  assert.equal(openDialog([RULE, '❯ ', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)']), null);
  assert.equal(openDialog([RULE, '❯ ', RULE, '  ? for shortcuts']), null);
  // a numbered approval: parseMenu reads it; openDialog also sees it (the chat uses it only when parseMenu gives null)
  const ap = PERMISSION;
  assert.ok(parseMenu(ap));
  assert.ok(openDialog(ap).numbers.includes(1));
});
