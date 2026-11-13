// Auto-approve (contract v3.71): which permission requests Agent Office may answer "allow" for the person when the
// project's switch is on. Pure and dependency-free. The list of refusals is short on purpose: it is not a sandbox,
// only a net under the clearly destructive commands, and when in doubt the dialog goes to the person as before.

// A question to the person, not a permission: answering it for them would pick an option or approve a plan unseen.
const QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode']

// Whole-command shapes that a split into segments would hide: a fork bomb, and a download piped or fed into a shell.
const FORK_BOMB = /:\s*\(\s*\)\s*\{/
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:ba|z|da|k|fi)?sh\b/
const SHELL_FROM_DOWNLOAD = /\b(?:ba|z|da|k|fi)?sh\b[^;&|\n]*<\(\s*(?:curl|wget)\b/

// `;`, `&&`, `||`, `|`, `&`, newlines, and where a subshell or command substitution starts or ends (not `{`: `${HOME}`)
const SEGMENT_BREAK = /\|\||&&|[;|&\n]|\$\(|[`()]/

// Words that only run the command after them (with their options): the next word is still a command
const WRAPPERS = ['{', 'env', 'exec', 'command', 'builtin', 'nohup', 'time', 'nice', 'xargs', 'sh', 'bash', 'zsh', '-c']
const POWER_COMMANDS = ['shutdown', 'reboot', 'halt', 'poweroff']
const DISK_VERBS = /^(?:erase|secureerase|zerodisk|randomdisk|partitiondisk|reformat)/i

/** The word without quotes, a leading backslash (`\rm`) and its folder (`/bin/rm`). */
const bare = (word: string): string => word.replace(/['"]/g, '').replace(/^\\/, '')
const nameOf = (word: string): string => bare(word).replace(/^.*\//, '')

/** `-r`, `-Rf`, `--recursive`: a short flag cluster holding one of `letters`, or one of the long flags. */
const hasFlag = (words: string[], letters: string, long: string[]): boolean =>
  words.some(w => (w.startsWith('--') ? long.some(l => w === l || w.startsWith(`${l}=`)) : w.startsWith('-') && [...letters].some(c => w.includes(c))))

/** `/`, `~`, `$HOME`, `.`, `..` or a bare `*`, with or without a trailing `/` or `/*`: everything, or everything here. */
function isBroadTarget(word: string): boolean {
  const target = bare(word).replace(/\/\*?$/, '')
  return ['', '~', '$HOME', '${HOME}', '.', '..', '*'].includes(target)
}

function isDestructiveSegment(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean).map(bare)
  const names = words.map(nameOf)
  // anywhere in the segment, `echo "sudo"` too: the person decides what runs as root
  if (names.some(n => n === 'sudo' || n === 'doas')) return true
  if (names.some(n => n.startsWith('mkfs'))) return true

  // the power commands only where a command stands: `git commit -m "fix reboot"` is not one
  const first = words.findIndex((w, i) => !(/^\w+=/.test(w) || WRAPPERS.includes(names[i] ?? '') || w.startsWith('-')))
  if (POWER_COMMANDS.includes(names[first] ?? '')) return true

  for (const [i, name] of names.entries()) {
    const rest = words.slice(i + 1)
    const flags = rest.filter(w => w.startsWith('-'))
    const targets = rest.filter(w => !w.startsWith('-'))
    if (name === 'rm' && hasFlag(flags, 'rR', ['--recursive']) && targets.some(isBroadTarget)) return true
    if ((name === 'chmod' || name === 'chown') && hasFlag(flags, 'R', ['--recursive']) && targets.some(isBroadTarget)) return true
    if (name === 'dd' && rest.some(w => w.startsWith('of='))) return true
    if (name === 'diskutil' && rest.some(w => DISK_VERBS.test(w))) return true
    if (name === 'git') {
      if (rest.includes('push') && (hasFlag(flags, 'f', ['--force', '--force-with-lease', '--force-if-includes']) || targets.some(w => w.startsWith('+')))) return true
      if (rest.includes('reset') && rest.includes('--hard')) return true
      if (rest.includes('clean') && hasFlag(flags, 'f', ['--force'])) return true
    }
  }
  return false
}

/** Whether a shell command is one of the clearly destructive ones the person must still approve. */
export function isDestructiveCommand(command: string): boolean {
  if (FORK_BOMB.test(command) || PIPE_TO_SHELL.test(command) || SHELL_FROM_DOWNLOAD.test(command)) return true
  return command.split(SEGMENT_BREAK).some(isDestructiveSegment)
}

/**
 * Whether Agent Office may answer this permission request with "allow". False for a question to the person, for a
 * Bash call whose command cannot be read, and for a destructive command (any tool that carries a `command`).
 */
export function canAutoApprove(toolName: unknown, toolInput: unknown): boolean {
  if (typeof toolName !== 'string' || !toolName || QUESTION_TOOLS.includes(toolName)) return false
  const command = toolInput && typeof toolInput === 'object' ? (toolInput as { command?: unknown }).command : undefined
  if (typeof command === 'string') return command.trim() !== '' && !isDestructiveCommand(command)
  return toolName !== 'Bash'
}
