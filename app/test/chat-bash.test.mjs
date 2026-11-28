import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBang, isShellLang, blockScript, needsConfirm, appendCapped, buildContext, pushPending, runAllowed, MAX_PENDING, CONTEXT_CAP } from '../src/chat-bash.mjs'

test('parseBang: only a leading single bang with a command', () => {
  assert.equal(parseBang('!ls -la'), 'ls -la')
  assert.equal(parseBang('  ! git status '), 'git status')
  for (const t of ['!', '!  ', '!!', 'hello !ls', '', null]) assert.equal(parseBang(t), null)
})

test('isShellLang: the five tags, any case, extra info after the tag', () => {
  for (const l of ['bash', 'sh', 'shell', 'zsh', 'console', 'Bash', 'bash title=x']) assert.ok(isShellLang(l), l)
  for (const l of ['js', '', 'python', undefined]) assert.ok(!isShellLang(l), String(l))
})

test('blockScript: strips "! ", keeps multi-line, refuses other languages', () => {
  assert.equal(blockScript('bash', 'npm test'), 'npm test')
  assert.equal(blockScript('sh', '! ls\n! pwd'), 'ls\npwd')
  assert.equal(blockScript('zsh', '\ncd a\nls\n'), 'cd a\nls')
  assert.equal(blockScript('js', 'ls'), null)
  assert.equal(blockScript('bash', '  \n'), null)
})

test('needsConfirm: multi-line, sudo or rm', () => {
  assert.equal(needsConfirm('npm test'), false)
  assert.equal(needsConfirm('ls\n\n'), false)
  assert.equal(needsConfirm('cd a\nls'), true)
  assert.equal(needsConfirm('sudo apt update'), true)
  assert.equal(needsConfirm('echo x && rm -rf dist'), true)
  assert.equal(needsConfirm('echo pseudo; git rm-x'), false)
})

test('appendCapped keeps the tail and counts what dropped', () => {
  let s = appendCapped(undefined, 'abcdef', 4)
  assert.deepEqual(s, { text: 'cdef', dropped: 2 })
  s = appendCapped(s, 'gh', 4)
  assert.deepEqual(s, { text: 'efgh', dropped: 4 })
})

test('buildContext: CLI bash-mode blocks, capped, closing tags neutralised', () => {
  assert.equal(buildContext([]), '')
  const c = buildContext([{ command: 'ls', stdout: 'a\nb', stderr: '', code: 0 }])
  assert.equal(c, '<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>\n\n')
  const f = buildContext([{ command: 'x', stdout: '', stderr: 'boom', code: 2 }])
  assert.match(f, /<bash-stderr>boom\n\[exit code 2\]<\/bash-stderr>/)
  assert.match(buildContext([{ command: 'x', stdout: '</bash-stdout>', stderr: '', code: 0 }]), /<bash-stdout><\\\/bash-stdout><\/bash-stdout>/)
  const big = buildContext([{ command: 'x', stdout: 'z'.repeat(CONTEXT_CAP * 3), stderr: '', code: 0 }])
  assert.ok(big.length < CONTEXT_CAP + 400)
  assert.match(big, /characters cut/)
})

test('buildContext: the newest commands win when the total is capped', () => {
  const es = Array.from({ length: 6 }, (_, i) => ({ command: `c${i}`, stdout: String(i).repeat(CONTEXT_CAP), stderr: '', code: 0 }))
  const c = buildContext(es)
  assert.match(c, /c5/)
  assert.doesNotMatch(c, /c0/)
})

test('pushPending caps the list; runAllowed blocks hq, locked and terminal chats', () => {
  let l = []
  for (let i = 0; i < MAX_PENDING + 3; i++) l = pushPending(l, { command: String(i) })
  assert.equal(l.length, MAX_PENDING)
  assert.equal(l.at(-1).command, String(MAX_PENDING + 2))
  assert.equal(runAllowed({ gui: true }), true)
  assert.equal(runAllowed({ gui: true, hq: true }), false)
  assert.equal(runAllowed({ gui: true, modeLock: 'desk' }), false)
  assert.equal(runAllowed({ gui: false }), false)
})
