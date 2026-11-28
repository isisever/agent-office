// Account quota (Pro/Max plan): pure functions (no Electron; tested with node --test).
//
// Source (code.claude.com/docs/en/statusline): in the status line command's input,
// rate_limits.five_hour / seven_day → { used_percentage: 0-100, resets_at: Unix seconds }. Only
// with a claude.ai subscription and after the session's first API response; an expired window is dropped.
// The app starts each project's claude with its own status line via `--settings`: the script writes the input
// to usage/<accountId>/<projectId>.json and runs the user's own status line if there is one.
const path = require('path');

const LAST = 'last.json';

// Status line script: writes the input to a file (to a temp file first so a partial file is never read),
// then runs the user's status line command with the same input; its output is what shows on screen.
const SCRIPT = `# Agent Office: Claude Code status line girdisini (kota dahil) uygulamaya bırakır.
out=$1; tmp="$out.$$"
cat > "$tmp" || exit 0
mv -f "$tmp" "$out"
[ -n "$AGENT_OFFICE_STATUSLINE" ] && exec /bin/sh -c "$AGENT_OFFICE_STATUSLINE" < "$out"
exit 0
`;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The user's effective status line: --settings overrides it, the script runs it again. The order is Claude
// Code's: the project's settings.local.json, the project's settings.json, the account's settings.json.
// The first defined statusLine wins; if it isn't a command type (or has no command), there is nothing to run.
function userStatusLine(settingsList) {
  for (const s of settingsList) {
    const sl = s && typeof s === 'object' ? s.statusLine : undefined;
    if (sl === undefined) continue;
    if (!sl || sl.type !== 'command' || typeof sl.command !== 'string' || !sl.command.trim()) return null;
    return { command: sl.command, padding: Number.isFinite(sl.padding) ? sl.padding : undefined };
  }
  return null;
}

const settingsPaths = (projectDir, configDir, home) => [
  path.join(projectDir, '.claude', 'settings.local.json'),
  path.join(projectDir, '.claude', 'settings.json'),
  path.join(configDir || path.join(home, '.claude'), 'settings.json'),
];

// The --settings JSON passed to claude.
function statusLineSettings(scriptPath, outPath, user) {
  const statusLine = { type: 'command', command: `/bin/sh ${shq(scriptPath)} ${shq(outPath)}` };
  if (user?.padding !== undefined) statusLine.padding = user.padding;
  return JSON.stringify({ statusLine });
}

// ---- Windows. Claude Code runs status line commands through Git Bash, or PowerShell when there is no Git Bash
// (code.claude.com/docs/en/statusline#windows-configuration). A command both shells read the same way is one bare
// word: `agent-office-statusline.cmd`, found on PATH (main appends the folder to claude's PATH). No quoting, no
// backslashes (Git Bash would eat them), no /bin/sh. The .cmd runs the app's own executable as Node
// (ELECTRON_RUN_AS_NODE only inside the .cmd, not in claude's environment) with WIN_SCRIPT. The tab's quota file
// comes from the environment (AGENT_OFFICE_USAGE_OUT, one claude per tab), so the command has no arguments.
const WIN_CMD = 'agent-office-statusline.cmd';
const WIN_SCRIPT_NAME = 'statusline.js';

// Run as Node: stdin → the quota file (temp file, then rename), then the user's status line with the same input,
// through the shell Claude Code would use (AGENT_OFFICE_STATUSLINE_SHELL: Git Bash's path; empty → PowerShell).
const WIN_SCRIPT = `// Agent Office: leaves Claude Code's status line input (quota included) for the app.
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  const out = process.env.AGENT_OFFICE_USAGE_OUT;
  if (out) {
    const tmp = out + '.' + process.pid;
    try {
      fs.writeFileSync(tmp, input);
      try { fs.renameSync(tmp, out); } catch { fs.writeFileSync(out, input); fs.rmSync(tmp, { force: true }); }
    } catch {}
  }
  const cmd = process.env.AGENT_OFFICE_STATUSLINE;
  if (!cmd) return process.exit(0);
  const sh = process.env.AGENT_OFFICE_STATUSLINE_SHELL;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = sh
    ? spawnSync(sh, ['-c', cmd], { input, env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
    : spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { input, env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  process.exit(r.status ?? 0);
});
`;

/** The .cmd next to WIN_SCRIPT: runs exe (the app's executable) as Node on it. '%' is doubled for cmd. */
const windowsCmdFile = (exe) => [
  '@echo off',
  'rem Agent Office: Claude Code status line (see statusline.js)',
  'setlocal',
  'set ELECTRON_RUN_AS_NODE=1',
  `"${String(exe).replace(/%/g, '%%')}" "%~dp0${WIN_SCRIPT_NAME}"`,
  '',
].join('\r\n');

/** The --settings JSON passed to claude on Windows (the quota file comes from AGENT_OFFICE_USAGE_OUT). */
function windowsStatusLineSettings(user) {
  const statusLine = { type: 'command', command: WIN_CMD };
  if (user?.padding !== undefined) statusLine.padding = user.padding;
  return JSON.stringify({ statusLine });
}

// Status line input → AccountUsage (see CONTRACT.md), or null if there is no rate_limits.
function usageFromStatus(obj, updatedAt) {
  const rl = obj && typeof obj === 'object' ? obj.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => {
    if (!w || typeof w !== 'object' || !Number.isFinite(w.used_percentage)) return undefined;
    const out = { pct: Math.max(0, Math.min(100, w.used_percentage)) };
    if (Number.isFinite(w.resets_at)) out.resetsAt = w.resets_at * 1000;
    return out;
  };
  const usage = { updatedAt };
  const five = win(rl.five_hour);
  const week = win(rl.seven_day);
  if (five) usage.fiveHour = five;
  if (week) usage.sevenDay = week;
  return five || week ? usage : null;
}

// The cached record (last.json), or null if it is corrupt.
function usageFromCache(obj) {
  if (!obj || typeof obj !== 'object' || !Number.isFinite(obj.updatedAt)) return null;
  const ok = (w) => w && Number.isFinite(w.pct);
  if (!ok(obj.fiveHour) && !ok(obj.sevenDay) && !(obj.limited && Number.isFinite(obj.limited.resetsAt))) return null;
  return obj;
}

/**
 * v3.155: a usage-limit stop seen in a transcript ({ at, resetsAt (ms), type }) → the account's quota as the stop
 * implies: five_hour → fiveHour 100 %, seven_day → sevenDay 100 %, any other type → `limited: { type, resetsAt }`.
 * The status line stops arriving once requests are refused, so the last reading would stay low. `updatedAt` moves to
 * the stop's time, so a status line reading written after it replaces this (usageFromStatus + scanUsage's
 * newer-wins rule) and a reading from before it cannot. Returns `usage` itself when nothing changes: no reset
 * time, a reset already past, or a reading newer than the stop.
 */
function applyLimitHit(usage, hit, now = Date.now()) {
  if (!hit || !Number.isFinite(hit.at) || !Number.isFinite(hit.resetsAt) || hit.resetsAt <= now) return usage;
  if (usage && Number.isFinite(usage.updatedAt) && usage.updatedAt >= hit.at) return usage;
  const next = { ...(usage || {}), updatedAt: hit.at };
  if (hit.type === 'five_hour') next.fiveHour = { pct: 100, resetsAt: hit.resetsAt };
  else if (hit.type === 'seven_day') next.sevenDay = { pct: 100, resetsAt: hit.resetsAt };
  else next.limited = { type: typeof hit.type === 'string' ? hit.type : null, resetsAt: hit.resetsAt };
  return next;
}

module.exports = {
  LAST, SCRIPT, shq, userStatusLine, settingsPaths, statusLineSettings, usageFromStatus, usageFromCache, applyLimitHit,
  WIN_CMD, WIN_SCRIPT_NAME, WIN_SCRIPT, windowsCmdFile, windowsStatusLineSettings,
};
