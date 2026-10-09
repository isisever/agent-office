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
  if (!ok(obj.fiveHour) && !ok(obj.sevenDay)) return null;
  return obj;
}

module.exports = { LAST, SCRIPT, shq, userStatusLine, settingsPaths, statusLineSettings, usageFromStatus, usageFromCache };
