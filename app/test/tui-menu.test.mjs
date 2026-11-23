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

test('openDialog: never the draft in the prompt box, the footer under it, or ordinary output', async () => {
  const { openDialog } = await import('../src/tui-menu.mjs');
  // the person's own draft reads like a hint
  assert.equal(openDialog(['answer', RULE, '> Press Enter to continue', RULE, '  ? for shortcuts']), null);
  assert.equal(openDialog(['answer', RULE, '❯ Esc to cancel', RULE, '  ? for shortcuts']), null);
  assert.equal(openDialog(['answer', RULE, '❯ first line', '  Enter to confirm · Esc to cancel', RULE, '  ? for shortcuts']), null);
  assert.equal(openDialog(['answer', RULE, '❯ Press Enter to continue', RULE]), null);
  // a draft whose lower rule is not on screen
  assert.equal(openDialog(['answer', RULE, '❯ Press Enter to continue']), null);
  assert.equal(openDialog(['answer', RULE, '❯ first line', '  Enter to confirm · Esc to cancel']), null);
  // a status line under the prompt box that reads like a hint
  assert.equal(openDialog(['answer', RULE, '❯ ', RULE, '  Press Enter to continue']), null);
  assert.equal(openDialog(['answer', RULE, '❯ draft', RULE, '  my status', '  ↑/↓ to navigate · Esc to cancel']), null);
  // ordinary output above the prompt box
  assert.equal(openDialog(['Press Enter to continue', 'Esc to cancel', RULE, '❯ ', RULE, '  ? for shortcuts']), null);
  assert.equal(openDialog([]), null);
});

test('openDialog: a cut dialog and an approval-like one are flagged; keys and the terminal-only rule', async () => {
  const { openDialog, openOnScreen, screenKey, dialogKey, menuKey, mustUseTerminal, parseMenu } = await import('../src/tui-menu.mjs');
  const HINT = ' ↑/↓ to navigate · Enter to confirm · Esc to exit';
  const whole = openDialog(['answer', RULE, ' Select model', '   Sonnet', ' ❯ Opus', '', HINT]);
  assert.deepEqual([whole.truncated, whole.approval], [false, false]);
  assert.equal(mustUseTerminal({ dialog: true, ...whole }), false);
  // more lines than the card keeps
  const long = openDialog(['answer', RULE, ' Pick one', ...Array.from({ length: 20 }, (_, n) => `   item ${n}`), HINT]);
  assert.equal(long.truncated, true);
  assert.ok(long.lines.length <= 15);
  assert.equal(mustUseTerminal({ dialog: true, ...long }), true);
  // its start has scrolled off the screen (no rule above it)
  const noRule = openDialog([' Select model', '   Sonnet', ' ❯ Opus', HINT]);
  assert.equal(noRule.truncated, true);
  assert.notEqual(dialogKey(noRule), dialogKey({ ...noRule, truncated: false }), 'the cut is part of the key');
  // reads like an approval that parseMenu could not take (one numbered line): never answered from the card
  const ask = [RULE, ' Bash command', ' rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '', ' Enter to confirm · Esc to cancel'];
  assert.equal(parseMenu(ask), null);
  const a = openOnScreen(ask);
  assert.deepEqual([a.dialog, a.approval, a.truncated, a.numbers], [true, true, false, [1]]);
  assert.equal(mustUseTerminal(a), true);
  assert.equal(openDialog([RULE, ' Trust this folder?', ' ❯ 1. Yes, proceed', '', ' Enter to confirm · Esc to cancel']).approval, true);
  // openOnScreen: the menu first, the dialog otherwise; one key for the card and for the check before typing
  const menu = openOnScreen(PERMISSION);
  assert.equal(menu.dialog, undefined);
  assert.equal(screenKey(menu), menuKey(parseMenu(PERMISSION)));
  const d = openOnScreen(['answer', RULE, ' Select model', '   Sonnet', ' ❯ Opus', '', HINT]);
  assert.equal(screenKey(d), dialogKey(whole));
  assert.ok(screenKey(d) && screenKey(d) !== screenKey(menu));
  assert.equal(screenKey(openOnScreen(['answer', RULE, ' Select model', ' ❯ Sonnet', '   Opus', '', HINT])) === screenKey(d), false, 'a moved cursor is another screen');
  assert.equal(screenKey(null), '');
  assert.equal(openOnScreen(['answer', RULE, '> Press Enter to continue', RULE, '  ? for shortcuts']), null);
});

test('v3.117 promptReady: the prompt box is back; never while a menu, a dialog or a turn is on screen', async () => {
  const { promptReady } = await import('../src/tui-menu.mjs');
  const box = screen(`⏺ Set model to Opus
${RULE}
❯ 
${RULE}
  ⏵⏵ accept edits on (shift+tab to cycle)`);
  assert.equal(promptReady(box), true);
  assert.equal(promptReady(screen(`${RULE}
❯ a draft over
  two lines
${RULE}`)), true, 'a draft in the box is still the box (main refuses a draft itself)');
  assert.equal(promptReady(PERMISSION), false, 'an approval menu');
  assert.equal(promptReady(screen(`${RULE}
 Resume a session
 ❯ fix the login · 2h ago
   README setup · yesterday

 ↑/↓ to navigate · Enter to select · Esc to cancel`)), false, 'a picker');
  assert.equal(promptReady(screen(`✻ Working… (3s · esc to interrupt)
${RULE}
❯ 
${RULE}`)), false, 'a turn runs');
  assert.equal(promptReady(screen(`❯ 
${RULE}`)), false, 'no rule above the glyph: not the box');
  assert.equal(promptReady([]), false);
  assert.equal(promptReady(null), false);
});
