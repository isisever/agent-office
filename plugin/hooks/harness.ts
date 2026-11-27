// Harness gates (app contract v3.26): agents verify their work, stop looping on one error, and get a facts file.
// Pure functions and the gates' state, called from register.tsx's own handlers (an event takes one unmatched hook
// per module, and $ never crosses an import), like finish.ts. Keys: '' is the main loop, else a subagent's agentId.

// ── Verification gate ────────────────────────────────────────────────────────────────────────────────────────
// A loop that changed files (Edit/Write/NotebookEdit, or a Bash command that clearly writes) and ran no check since
// (tests, build, lint, typecheck) is blocked once when it stops (classic.Stop, classic.SubagentStop); its next stop
// stands. One block per change set: a new change after the block opens a new set. No block when nothing changed or
// when the final message says in so many words why no check applies. Only a change to code counts: a file that is
// not a doc (*.md, *.txt, ...), not in a temp folder outside the project (the session scratchpad), not in ~/.claude*
// or the office data folder (facts, memory), and not in a docs/ folder or a project's own .claude/ folder (memory,
// settings; a worktree under .claude/worktrees is code). A loop is blocked at most once per prompt of the person's:
// a notice the plugin submits to wake the boss (v3.129) does not open a new count, so a turn sequence gets one block.

export const VERIFY_REASON =
  "Agent Office: you changed files but ran no test/build/lint since. Run the project's check, or say in one line why none applies."
// at most this many verify blocks per loop between two prompts of the person's (each block costs a model turn)
export const VERIFY_BLOCKS_MAX = 1

// the checks: extend here. Each is matched at a command's start (after `cd …&&`, env assignments, `npx`/`bunx`)
export const VERIFY_COMMANDS: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck|type-check|tsc|verify|ci|e2e)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build)[:\w-]*/,
  /^(?:npm|pnpm)\s+(?:t|it|cit)\b/,
  /^(?:node|deno|bun)\s+(?:--\S+\s+)*(?:--test|test)\b/,
  /^(?:python3?\s+-m\s+)?(?:pytest|unittest|tox|nox|mypy|ruff|flake8|pylint|pyright)\b/,
  /^cargo\s+(?:test|build|check|clippy|nextest)\b/,
  /^go\s+(?:test|build|vet)\b/,
  /^golangci-lint\b/,
  /^(?:tsc|vue-tsc|eslint|biome|prettier\s+--check|vitest|jest|mocha|ava|playwright\s+test|cypress\s+run|rspec|phpunit|swift\s+(?:test|build)|xcodebuild|flutter\s+test|dart\s+test|mix\s+test|rake\s+test|bundle\s+exec\s+(?:rspec|rake))\b/,
  /^make\s+(?:test|check|lint|build|verify|ci|all)\b/,
  /^make\s*$/,
  /^(?:\.\/)?(?:gradlew|gradle|mvnw?)\b.*\b(?:test|check|build|verify|assemble)\b/,
  /^dotnet\s+(?:test|build)\b/,
  /^(?:claude\s+plugin\s+(?:test|validate))\b/,
]

// a command's segments (split on && || ; |), each with `cd x`, env assignments and runners in front taken off
function segmentsOf(command: string) {
  return command
    .split(/&&|\|\||;|\|(?!\|)|\n/)
    .map(part =>
      part
        .trim()
        .replace(/^\(+/, '')
        .replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, '')
        .replace(/^(?:time|env|sudo|npx\s+(?:-y\s+)?|bunx\s+|pnpm\s+exec\s+|yarn\s+exec\s+|uv\s+run\s+|poetry\s+run\s+)+/, '')
        .replace(/^(?:npx\s+(?:-y\s+)?)?(\S+?)@[\w.^~-]+(?=\s|$)/, '$1'),
    )
    .filter(Boolean)
}

/** True when the command runs one of the checks (VERIFY_COMMANDS). */
export function isVerifyCommand(command: string) {
  return segmentsOf(command).some(segment => VERIFY_COMMANDS.some(check => check.test(segment)))
}

// commands that clearly write a file: in-place edits, moves, copies, deletes, patches, git operations that rewrite
// the tree, and a redirection into a file (not /dev/null or a descriptor)
const WRITING = [
  /^(?:sed|perl)\s+(?:-\w*\s+)*-[a-z]*i/,
  /^(?:tee|mv|cp|rm|touch|mkdir|rmdir|ln|truncate|install|patch|unzip|tar\s+-?x)\b/,
  /^git\s+(?:apply|am|checkout|restore|reset\s+--hard|merge|rebase|cherry-pick|revert|stash\s+(?:pop|apply)|mv|rm)\b/,
]
const REDIRECT = /(?<![0-9&])>>?\s*(?!&|\/dev\/null)(?:"[^"]+"|'[^']+'|[^\s;&|)]+)/

/** True when the command clearly writes a file. */
export function isWritingCommand(command: string) {
  const unquoted = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  if (REDIRECT.test(unquoted.replace(/\d?>&\d/g, ' ').replace(/[<>]=?\s*\d+\b/g, ' '))) return true
  return segmentsOf(command).some(segment => WRITING.some(write => write.test(segment)))
}

// a final message that says why no check applies: "no tests in this repo", "docs-only change", "nothing to build"
const NO_CHECK = new RegExp(
  [
    String.raw`\bno (?:\w+ )?(?:tests?|test suite|test runner|build(?: step)?|lint(?:er)?|checks?|typecheck)\b`,
    String.raw`\bnothing to (?:test|build|lint|check|verify|run)\b`,
    String.raw`\b(?:none|no check) (?:applies|is needed|needed)\b`,
    String.raw`\bnot applicable\b`,
    String.raw`\b(?:docs?|documentation|comments?|markdown|readme|text|copy|config)[- ](?:only|change)\b`,
    String.raw`\bonly (?:docs|documentation|comments|markdown|readme|text)\b`,
    String.raw`\b(?:no|without) (?:a )?(?:verification|check) (?:applies|needed|is possible)\b`,
    String.raw`test(?:ler)? yok|derleme yok|kontrol (?:gerekmiyor|uygulanmaz)|doğrulama gerekmiyor|yalnızca (?:belge|doküman|metin)`,
  ].join('|'),
  'iu',
)
export function saysNoCheck(message: string) {
  return NO_CHECK.test(message)
}

// what counts as a code change
/** Where a loop works: its folder, the project folders, the home folder and the office data folder. */
export type VerifyPlace = { cwd: string; roots: string[]; home: string; dataDir?: string }

const DOC_FILE = /\.(?:md|mdx|markdown|txt|text|rst|adoc|asciidoc)$/i
const TEMP_DIR = /^(?:\/private)?\/(?:tmp|var\/folders|var\/tmp)(?:\/|$)|^[A-Za-z]:\/(?:Windows\/Temp|Users\/[^/]+\/AppData\/Local\/Temp)(?:\/|$)/i
// inside a project, these folders hold docs or Claude's memory and settings, never code (v3.129)
const NON_CODE_DIR = /(?:^|\/)(?:docs?\/|\.claude\/(?!worktrees\/))/
// a Claude Code session's own temp folder (its scratchpad and task outputs): never project code
const SESSION_TEMP = /\/claude-\d+\//

/** `path` made absolute against `cwd`, with `~`, `.` and `..` resolved and `/` separators; '' when it cannot be. */
export function resolvePath(path: string, cwd: string, home: string) {
  let at = path.trim().replace(/\\/g, '/')
  if (at === '~' || at.startsWith('~/')) at = home ? home.replace(/\\/g, '/') + at.slice(1) : ''
  if (!at) return ''
  const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p)
  if (!isAbsolute(at)) {
    const base = cwd.replace(/\\/g, '/')
    if (!isAbsolute(base)) return ''
    at = `${base}/${at}`
  }
  const drive = /^[A-Za-z]:/.test(at) ? at.slice(0, 2) : ''
  const parts: string[] = []
  for (const part of at.slice(drive.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

const isUnder = (path: string, dir: string) => {
  const folder = dir.replace(/\/+$/, '')
  return Boolean(folder) && (path === folder || path.startsWith(`${folder}/`))
}

/** True when a change to this file counts for the gate: code, not a doc, a scratch file or a Claude file. */
export function isCodePath(path: string, place: VerifyPlace) {
  const at = resolvePath(path, place.cwd, place.home)
  if (!at) return true // cannot tell where: counted
  if (DOC_FILE.test(at)) return false
  const home = place.home ? resolvePath(place.home, '/', '') : ''
  // inside a project folder (not the home folder itself): counts, even under ~/.claude or a temp folder
  const rootDir = place.roots
    .map(root => (root ? resolvePath(root, place.cwd, place.home) : ''))
    .find(dir => Boolean(dir) && dir !== home && dir !== '/' && isUnder(at, dir))
  if (rootDir && !SESSION_TEMP.test(at)) return !NON_CODE_DIR.test(at.slice(rootDir.length + 1))
  if (home && home !== '/' && isUnder(at, home) && /^\.claude/.test(at.slice(home.length + 1))) return false
  if (place.dataDir && isUnder(at, resolvePath(place.dataDir, place.cwd, place.home))) return false
  // a temp folder counts only when the project itself lives there (above)
  return !TEMP_DIR.test(at)
}

// a shell command's words, quotes taken off ("a b" is one word)
const wordsOf = (segment: string) => [...segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')

// heredoc bodies taken out: their text is data, not the files the command writes
function withoutHeredocs(command: string) {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    for (const tag of [...line.matchAll(/<<-?\s*["']?([\w.-]+)["']?/g)].map(m => m[1] ?? '')) {
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== tag) i++
      i++
    }
  }
  return kept.join('\n')
}

const SED_SCRIPT = /^[sy]([/|#,:]).*\1.*\1\w*$/
const looksLikePath = (word: string) =>
  Boolean(word) &&
  !word.startsWith('-') &&
  !/^[a-z]+:\/\//i.test(word) &&
  !SED_SCRIPT.test(word) &&
  (word === '.' || word === '..' || /[\\/]/.test(word) || word.startsWith('~') || /\.\w{1,8}$/.test(word))

/** True when a writing command may write code (isCodePath); a write whose targets cannot be told counts. */
export function commandWritesCode(command: string, place: VerifyPlace) {
  let cwd = place.cwd
  const targets: { path: string; cwd: string }[] = []
  for (const segment of withoutHeredocs(command).split(/&&|\|\||;|\|(?!\|)|\n/)) {
    const words = wordsOf(segment.trim().replace(/^\(+/, ''))
    if (words[0] === 'cd') {
      const to = words[1] && !words[1].startsWith('-') ? resolvePath(words[1], cwd, place.home) : place.home
      if (to) cwd = to
      continue
    }
    // redirections into a file: `> f`, `>> f`, `>f`, `2> f` (the word after a bare `>` is its target, not an argument)
    const redirected = new Set<number>()
    words.forEach((word, i) => {
      const redirect = /^\d?>>?(.*)$/.exec(word)
      if (!redirect) return
      redirected.add(i)
      if (word.includes('&')) return
      if (!redirect[1]) redirected.add(i + 1)
      const target = redirect[1] || words[i + 1] || ''
      if (target && target !== '/dev/null') targets.push({ path: target, cwd })
    })
    const plain = segment
      .trim()
      .replace(/^\(+/, '')
      .replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')
      .replace(/^(?:time|env|sudo)\s+/, '')
    if (!WRITING.some(write => write.test(plain))) continue
    const own = words.filter((word, i) => i > 0 && !redirected.has(i) && word !== '/dev/null' && looksLikePath(word))
    for (const word of own) targets.push({ path: word, cwd })
    // fail-safe: a write with no path of its own, and any git/unzip/tar write, may change the working folder
    if (!own.length || /^(?:git|unzip|tar)\b/.test(plain)) targets.push({ path: '.', cwd })
  }
  if (!targets.length) return true
  return targets.some(target => isCodePath(target.path, { ...place, cwd: target.cwd }))
}

type Gate = { changed: number; verified: number; blockedFor: number; blocks: number }
const gates = new Map<string, Gate>()
let seq = 0
const gateOf = (key: string) => {
  let gate = gates.get(key)
  if (!gate) gates.set(key, (gate = { changed: 0, verified: 0, blockedFor: 0, blocks: 0 }))
  return gate
}

const EDITING = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const COMMANDS = new Set(['Bash', 'PowerShell'])

/** Notes one tool call of a loop (before or after it runs; a refused call is not noted). With `place`, only a
 * change to code counts (isCodePath, commandWritesCode); without it, every change does. */
export function verifyNote(key: string, tool: string, input: Record<string, unknown>, isReadOnly = false, place?: VerifyPlace) {
  const gate = gateOf(key)
  if (EDITING.has(tool)) {
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (!place || !file || isCodePath(file, place)) gate.changed = ++seq
  } else if (COMMANDS.has(tool) && typeof input.command === 'string') {
    const command = input.command
    if (!isReadOnly && isWritingCommand(command) && (!place || commandWritesCode(command, place))) gate.changed = ++seq
    if (isVerifyCommand(command)) gate.verified = ++seq
  }
}

export type VerifyStop = { last_assistant_message?: string; background_tasks?: { status?: string }[] }

/** The block for a loop about to stop, or undefined to let it stop. Counts the block. */
export function verifyBlock(key: string, e: VerifyStop): string | undefined {
  const gate = gates.get(key)
  if (!gate || gate.changed === 0 || gate.verified > gate.changed) return undefined
  if (gate.blockedFor === gate.changed || gate.blocks >= VERIFY_BLOCKS_MAX) return undefined
  const message = typeof e.last_assistant_message === 'string' ? e.last_assistant_message : ''
  if (saysNoCheck(message)) return undefined
  gate.blockedFor = gate.changed
  gate.blocks++
  return VERIFY_REASON
}

/** A prompt of the person's: the main loop's block count starts afresh (its change set stays). */
export function verifyPrompt() {
  const gate = gates.get('')
  if (gate) gate.blocks = 0
}

/** A subagent that ended: its gate goes. */
export function verifyForget(key: string) {
  gates.delete(key)
}

// ── Same error twice ─────────────────────────────────────────────────────────────────────────────────────────
// A failed call's error is normalized (paths, numbers, timestamps, hex and quotes' contents dropped; the first
// meaningful lines kept) and hashed. The second time one loop hits the same error, a one-time reminder rides the
// result; from the third, in Strict, the next identical call (same tool and input) is refused.

export const REPEAT_TEXT =
  'Agent Office: same error twice. Stop retrying blindly: state the root cause hypothesis, change approach, or report back with the exact error. If this is a design question, consult the reviewer agent.'
export const REPEAT_DENY_TEXT =
  'Agent Office: this exact call already failed the same way 3 times, so it was not run. Do not retry it: report back with the exact error and your root cause hypothesis, or take a different approach.'
const ERROR_LINES = 3
const ERROR_CHARS = 400

/** The error's normalized form: what stays the same between two runs of the same failure. */
export function normalizeError(text: string) {
  const lines = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map(line =>
      line
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g, '<time>')
        .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+~-]+){2,}[\\/]?(?::\d+(?::\d+)?)?/g, '<path>')
        .replace(/[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|json|ya?ml|toml|md)(?::\d+(?::\d+)?)?\b/g, '<file>')
        .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
        .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
        .replace(/\d+(?:\.\d+)?/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase(),
    )
    // not meaningful: blank, the exit code line, a separator
    .filter(line => line && !/^(?:exit code <n>|error: exit code <n>|[-=*_~<n>\s]+)$/.test(line))
  return lines.slice(0, ERROR_LINES).join('\n').slice(0, ERROR_CHARS)
}

/** FNV-1a, 32 bits, as hex: enough to tell errors apart in one session. */
export function hashOf(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// a call's identity for the refusal: its tool and its input (the envelope left out)
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'description'])
export function callSignature(tool: string, input: Record<string, unknown>) {
  const kept = Object.keys(input)
    .filter(name => !ENVELOPE.has(name))
    .sort()
    .map(name => [name, input[name]])
  return `${tool} ${JSON.stringify(kept)}`
}

type Seen = { count: number; isReminded: boolean }
const errorsSeen = new Map<string, Seen>() // key + hash
const refusedCalls = new Map<string, Set<string>>() // key → call signatures refused from now on

export type RepeatAction = { kind: 'remind'; text: string } | { kind: 'refuse-next' } | undefined

/** Notes a failed call's error text; says what to do: a reminder (the 2nd time), mark the call refused (3rd+, Strict). */
export function repeatNote(key: string, errorText: string, signature: string, isStrict: boolean): RepeatAction {
  const normalized = normalizeError(errorText)
  if (!normalized) return undefined
  const id = `${key}\u0000${hashOf(normalized)}`
  const seen = errorsSeen.get(id) ?? { count: 0, isReminded: false }
  seen.count++
  errorsSeen.set(id, seen)
  if (seen.count >= 3 && isStrict) {
    const refused = refusedCalls.get(key) ?? new Set<string>()
    refused.add(signature)
    refusedCalls.set(key, refused)
    if (!seen.isReminded) {
      seen.isReminded = true
      return { kind: 'remind', text: REPEAT_TEXT }
    }
    return { kind: 'refuse-next' }
  }
  if (seen.count >= 2 && !seen.isReminded) {
    seen.isReminded = true
    return { kind: 'remind', text: REPEAT_TEXT }
  }
  return undefined
}

/** True when this call is one refused after its third identical failure. */
export function isRefusedCall(key: string, signature: string) {
  return refusedCalls.get(key)?.has(signature) ?? false
}

/** A failed call's error text, or '' when it did not fail: an error result, or a command with a non-zero exit. */
export function errorTextOf(done: unknown) {
  if (done === null || typeof done !== 'object') return ''
  const answer = done as { isError?: boolean; text?: string; result?: unknown; deny?: string }
  if (answer.deny !== undefined) return ''
  if (answer.isError) return typeof answer.text === 'string' ? answer.text : typeof answer.result === 'string' ? answer.result : 'error'
  const result = answer.result as { exitCode?: unknown; stderr?: unknown; stdout?: unknown } | undefined
  if (result && typeof result.exitCode === 'number' && result.exitCode !== 0) {
    return [result.stderr, result.stdout].filter(part => typeof part === 'string' && part).join('\n') || `exit ${result.exitCode}`
  }
  return ''
}

// ── Brief check ──────────────────────────────────────────────────────────────────────────────────────────────
// A brief (the Agent tool's prompt) that names no acceptance check gets a reminder after the call: no block.
export const BRIEF_TEXT =
  'Agent Office: that brief named no acceptance check. Give each agent the deliverable, non-goals (what not to touch) and the exact command or condition that proves it done.'
const ACCEPTANCE = /accept|done when|done means|proves? it|definition of done|verify|verif|check(?:s|ed)? (?:with|by|that)|must pass|should pass|passes|run(?:s|ning)? (?:the )?(?:tests?|build|lint)|`[^`]*(?:test|build|lint|tsc|check)[^`]*`|kabul|doğrula|bitti sayılır/i
export function briefLacksCheck(prompt: unknown) {
  return typeof prompt === 'string' && prompt.trim().length > 0 && !ACCEPTANCE.test(prompt)
}

// ── Project facts file ───────────────────────────────────────────────────────────────────────────────────────
// <office data dir>/facts/<project-slug>.md: layout, key commands, gotchas and decisions, each dated. Never in the
// person's repo. Seeded once from cheap signals; the boss gets its path in one line and appends verified facts.
export const FACTS_MAX_LINES = 40

export const factsLine = (path: string) =>
  `This project's facts file (layout, key commands, gotchas, dated decisions) is \`${path}\`: read it for orientation, pass its path in briefs, and append only verified facts there, a line or two each, never secrets.`

type Signals = { packageJson?: string; makefile?: string; cargo?: string; pyproject?: string; goMod?: string }

const SECRETISH = /(?:token|secret|password|passwd|api[_-]?key|auth|bearer|private[_-]?key)/i

/** The seed text from the project's files (headings only when they say nothing). */
export function factsSeed(project: string, date: string, s: Signals): string {
  const commands: string[] = []
  const layout: string[] = []
  if (s.packageJson) {
    try {
      const pkg = JSON.parse(s.packageJson) as { scripts?: Record<string, unknown>; workspaces?: unknown; packageManager?: unknown }
      const runner = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : 'npm'
      layout.push(`Node project (package.json${Array.isArray(pkg.workspaces) ? `, workspaces: ${(pkg.workspaces as unknown[]).slice(0, 5).join(', ')}` : ''})`)
      for (const [name, value] of Object.entries(pkg.scripts ?? {}).slice(0, 12)) {
        if (typeof value !== 'string' || SECRETISH.test(value) || SECRETISH.test(name)) continue
        commands.push(`\`${runner} run ${name}\`: ${value.replace(/\s+/g, ' ').slice(0, 80)}`)
      }
    } catch {
      // not JSON: nothing from it
    }
  }
  if (s.makefile) {
    const targets = [...s.makefile.matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)].map(m => m[1] ?? '').filter(name => name && !SECRETISH.test(name))
    if (targets.length) commands.push(`make targets: ${[...new Set(targets)].slice(0, 12).join(', ')}`)
  }
  if (s.cargo) {
    layout.push(`Rust crate (Cargo.toml${/\[workspace\]/.test(s.cargo) ? ', workspace' : ''})`)
    commands.push('`cargo build`, `cargo test`, `cargo clippy`')
  }
  if (s.pyproject) {
    const tool = /\[tool\.poetry\]/.test(s.pyproject) ? 'poetry' : /\[tool\.uv\]|uv\.lock/.test(s.pyproject) ? 'uv' : 'pip'
    layout.push(`Python project (pyproject.toml, ${tool})`)
    if (/pytest/.test(s.pyproject)) commands.push('`pytest`')
    for (const linter of ['ruff', 'mypy', 'black']) if (new RegExp(`\\[tool\\.${linter}`).test(s.pyproject)) commands.push(`\`${linter}\``)
  }
  if (s.goMod) {
    layout.push('Go module (go.mod)')
    commands.push('`go build ./...`, `go test ./...`, `go vet ./...`')
  }
  const lines = [
    `# ${project}: facts`,
    '',
    `Seeded by Agent Office on ${date} from the project's files; append verified facts as "- YYYY-MM-DD: …". No secrets.`,
    '',
    '## Layout',
    ...layout.map(line => `- ${date}: ${line}`),
    '',
    '## Commands',
    ...commands.map(line => `- ${date}: ${line}`),
    '',
    '## Gotchas',
    '',
    '## Decisions',
  ]
  return lines.slice(0, FACTS_MAX_LINES).join('\n') + '\n'
}
