// Studio chat: "!" commands and Run buttons (contract v3.154). Pure logic only: parsing, block detection, the
// confirm rule, output caps and the context prefix. main.js spawns and kills the process; the renderer draws it.

/** Fence tags whose code blocks get a Run button. */
export const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'console'];
export const OUTPUT_CAP = 64 * 1024;       // characters kept per stream while a command runs (the bubble shows the tail)
export const TIMEOUT_MS = 10 * 60 * 1000;  // a command still running after this is killed
export const CONTEXT_CAP = 8000;           // characters of one stream that go to the model
export const CONTEXT_TOTAL = 24000;        // characters of all commands put in front of one message
export const MAX_PENDING = 8;              // commands kept for the next message (oldest drop)
export const MAX_RUNNING = 3;              // commands running at once in one chat
export const COMMAND_CAP = 8000;           // characters of one command or script

/** "!ls -la" → "ls -la"; null when the text is not a bang command ("!" alone, "!!", plain text). */
export function parseBang(text) {
  const m = /^\s*!(?!!)([\s\S]*)$/.exec(String(text ?? ''));
  const cmd = m ? m[1].trim() : '';
  return cmd && cmd.length <= COMMAND_CAP ? cmd : null;
}

/** Is a fence tag a shell one? ("bash title=x" and "Bash" count.) */
export function isShellLang(lang) {
  const tag = String(lang ?? '').trim().split(/[\s{,]/)[0].toLowerCase();
  return SHELL_LANGS.includes(tag);
}

/**
 * The script a shell code block runs, or null when the block is not runnable. A line that starts with "! " has the
 * "!" stripped (the terminal's bash-mode spelling). Blank leading/trailing lines go.
 */
export function blockScript(lang, text) {
  if (!isShellLang(lang)) return null;
  const script = String(text ?? '').split('\n').map((l) => l.replace(/^(\s*)!\s+/, '$1')).join('\n').replace(/^\s*\n+|\s+$/g, '');
  return script && script.length <= COMMAND_CAP ? script : null;
}

/** A one-line confirm is shown for a multi-line script or one with sudo or rm; otherwise a click runs it. */
export function needsConfirm(script) {
  const s = String(script ?? '');
  return s.split('\n').filter((l) => l.trim()).length > 1 || /(^|[\s;&|(])sudo(\s|$)/.test(s) || /(^|[\s;&|(])rm\s/.test(s);
}

/** Appends a chunk to a capped stream: keeps the tail, tells how much was dropped. → { text, dropped } */
export function appendCapped(prev, chunk, cap = OUTPUT_CAP) {
  const all = String(prev?.text ?? '') + String(chunk ?? '');
  const dropped = (prev?.dropped ?? 0) + Math.max(0, all.length - cap);
  return { text: all.length > cap ? all.slice(all.length - cap) : all, dropped };
}

const tail = (s, cap) => (s.length > cap ? `[... ${s.length - cap} characters cut]\n${s.slice(s.length - cap)}` : s);
// the output must not close the block it sits in
const safe = (s) => s.replace(/<\/(bash-input|bash-stdout|bash-stderr)>/g, '<\\/$1>');

/**
 * Commands that finished since the last message, as the blocks Claude Code's own bash mode writes:
 * <bash-input>cmd</bash-input><bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>, then a blank line.
 * entries: [{ command, stdout, stderr, code, killed }] oldest first; the newest are kept when the total is capped.
 */
export function buildContext(entries) {
  const out = [];
  let used = 0;
  for (const e of [...(entries || [])].reverse()) {
    const err = tail(String(e.stderr ?? ''), CONTEXT_CAP) + (e.killed ? '\n[stopped]' : e.code ? `\n[exit code ${e.code}]` : '');
    const block = `<bash-input>${safe(String(e.command ?? '').slice(0, COMMAND_CAP))}</bash-input>\n<bash-stdout>${safe(tail(String(e.stdout ?? ''), CONTEXT_CAP))}</bash-stdout><bash-stderr>${safe(err.trim())}</bash-stderr>`;
    if (used + block.length > CONTEXT_TOTAL && out.length) break;
    used += block.length;
    out.unshift(block);
  }
  return out.length ? `${out.join('\n')}\n\n` : '';
}

/** Puts a finished entry in a chat's pending list (capped, oldest drop). */
export function pushPending(list, entry) {
  return [...(list || []), entry].slice(-MAX_PENDING);
}

/** May this chat run commands? Not HQ, only a GUI chat, and not one whose mode is held (bypass or desk). */
export function runAllowed({ hq = false, gui = false, modeLock = '' } = {}) {
  return Boolean(gui) && !hq && !modeLock;
}
