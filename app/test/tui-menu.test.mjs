// Chat view menus (contract v3.78): src/tui-menu.mjs reads Claude Code's open menu off a terminal screen.
// The screens below were captured from Claude Code 2.1.286 in a pty (110 columns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMenu, isFreeOption, menuKey } from '../src/tui-menu.mjs';

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
