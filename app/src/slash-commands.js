// Chat view slash commands (contract v3.80 amendment): what the chat's "/" list offers for a Claude Code tab, the way
// Claude Code's own input does. Pure apart from the fs it is given; tested in test/slash-commands.test.cjs.
// - Built-in commands of Claude Code (2.1.286, read off its own "/" list): `ui` ones open a screen of their own in the
//   terminal (settings, pickers, panels), so the chat switches to the terminal after sending them.
// - The tab's commands and skills on disk: the project's `.claude/commands` (sub folders as `dir:name`) and
//   `.claude/skills/*/SKILL.md`, the same in the account's folder (or ~/.claude), the account's claude.ai-synced skills,
//   enabled installed plugins (`plugin:name`), and the skill packs and the Agent Office plugin the tab is started with.
// Descriptions come from the file's frontmatter `description:` (or its first text line). Nothing is executed or sent.
'use strict';
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[\w][\w.-]{0,63}$/;
const MAX_FILES = 400;
const DESC_MAX = 160;

// [name, description, ui?] — Claude Code 2.1.286's built-in commands and bundled skills
const BUILTIN = [
  ['add-dir', 'Add a new working directory', true], ['agents', 'Manage agent configurations', true], ['clear', 'Start a new session with empty context'],
  ['compact', 'Free up context by summarizing the conversation so far'], ['config', 'Open settings', true], ['context', 'Visualize current context usage', true],
  ['copy', "Copy Claude's last response to clipboard"], ['cost', 'Show the session cost and duration', true], ['diff', 'Toggle the diff panel showing uncommitted changes', true],
  ['doctor', "Check the Claude Code installation's health", true], ['effort', 'Set effort level for model usage', true], ['export', 'Export the current conversation to a file or clipboard', true],
  ['fast', 'Toggle fast mode'], ['help', 'Show help and available commands', true], ['hooks', 'View hook configurations for tool events', true],
  ['ide', 'Manage IDE integrations and show status', true], ['init', 'Initialize a new CLAUDE.md file with codebase documentation'], ['login', 'Sign in with your Anthropic account', true],
  ['logout', 'Sign out from your Anthropic account', true], ['mcp', 'Manage MCP servers', true], ['memory', 'Edit CLAUDE.md files and memory settings', true],
  ['model', 'Set the AI model for Claude Code', true], ['output-style', 'List output styles or switch to one', true], ['permissions', 'Manage allow and deny tool permission rules', true],
  ['plan', 'Enable plan mode or view the current session plan'], ['plugin', 'Manage Claude Code plugins', true], ['recap', 'Generate a one-line session recap now'],
  ['release-notes', 'View release notes', true], ['reload-plugins', 'Activate pending plugin changes in the current session'], ['reload-skills', 'Pick up skills added or changed on disk during this session'],
  ['rename', 'Rename the current conversation'], ['resume', 'Resume a previous conversation', true], ['rewind', 'Restore the code and/or conversation to a previous point', true],
  ['skills', 'List available skills', true], ['status', 'Show Claude Code status: version, model, account, connectivity', true], ['statusline', "Set up Claude Code's status line UI"],
  ['tasks', 'View and manage everything running in the background', true], ['theme', 'Change the theme', true], ['usage', 'Show session cost, plan usage and activity stats', true],
  ['btw', 'Ask a quick side question without interrupting the main conversation'], ['subtask', 'Send a subagent off with your full context'],
  ['goal', 'Set a goal Claude checks before stopping'], ['branch', 'Create a branch of the current conversation at this point'],
  ['code-review', 'Review the current diff, a PR or a path for correctness bugs'], ['security-review', 'Complete a security review of the pending changes on the current branch'],
  ['simplify', 'Review the changed code for reuse, simplification and efficiency, then apply the fixes'], ['verify', 'Verify that a code change does what it is supposed to, end to end'],
  ['run', "Launch and drive this project's app to see a change working"], ['loop', 'Run a prompt or slash command on a recurring interval'],
  ['batch', 'Plan a large change, then execute it in parallel across isolated worktrees'], ['debug', 'Enable debug logging for this session and help diagnose issues'],
  ['insights', 'Generate a report analyzing your Claude Code sessions'], ['fewer-permission-prompts', 'Add an allowlist for common read-only tool calls'],
  ['schedule', 'Create, update, list or run scheduled cloud agents'],
].map(([name, description, ui]) => ({ name, description, source: 'builtin', ...(ui ? { ui: true } : {}) }));

/** Frontmatter `name:` / `description:` of a markdown file, else its first text line. */
function describe(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const fm = s.match(/^---\n([\s\S]*?)\n---/);
  const field = (k) => {
    const m = fm?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const body = fm ? s.slice(fm[0].length) : s;
  const first = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return { name: field('name'), description: (field('description') || first).replace(/\s+/g, ' ').slice(0, DESC_MAX) };
}

const read = (fsx, f) => { try { return fsx.readFileSync(f, 'utf8').slice(0, 8192); } catch { return ''; } };
const listDir = (fsx, d) => { try { return fsx.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

/** `<dir>/**.md` as commands: sub folders become `sub:name` (two levels at most). */
function commandsIn(dir, source, fsx = fs, prefix = '', depth = 0, out = []) {
  for (const e of listDir(fsx, dir)) {
    if (out.length >= MAX_FILES || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2 && NAME_RE.test(e.name)) commandsIn(full, source, fsx, `${prefix}${e.name}:`, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.md')) {
      const base = e.name.slice(0, -3);
      if (NAME_RE.test(base)) out.push({ name: `${prefix}${base}`, description: describe(read(fsx, full)).description, source });
    }
  }
  return out;
}

/** `<dir>/<skill>/SKILL.md` as commands (`prefix` for a plugin's skills). */
function skillsIn(dir, source, fsx = fs, prefix = '') {
  const out = [];
  for (const e of listDir(fsx, dir)) {
    if (out.length >= MAX_FILES || e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
    const text = read(fsx, path.join(dir, e.name, 'SKILL.md'));
    if (!text) continue;
    const d = describe(text);
    const name = NAME_RE.test(d.name) ? d.name : e.name;
    if (NAME_RE.test(name)) out.push({ name: `${prefix}${name}`, description: d.description, source });
  }
  return out;
}

/** A plugin folder's commands and skills, named `plugin:name`. */
const pluginCommands = (root, plugin, fsx = fs) => [
  ...commandsIn(path.join(root, 'commands'), 'plugin', fsx).map((c) => ({ ...c, name: `${plugin}:${c.name}` })),
  ...skillsIn(path.join(root, 'skills'), 'plugin', fsx, `${plugin}:`),
];

/**
 * Everything the "/" list offers for a tab. → [{ name, description, source, ui? }], one per name (the first wins:
 * project, then the account, then plugins, then built-ins).
 * @param {{ cwd?: string | null, claudeDir: string, packs?: { name: string, dir: string }[], extra?: { name: string, description: string }[] }} o
 *   packs: the skill packs (plugin name, folder) this tab is started with; extra: plugin commands main adds (/office)
 */
function commandsFor({ cwd = null, claudeDir, packs = [], extra = [] }, fsx = fs) {
  const all = [];
  if (cwd) all.push(...commandsIn(path.join(cwd, '.claude', 'commands'), 'project', fsx), ...skillsIn(path.join(cwd, '.claude', 'skills'), 'project', fsx));
  all.push(...commandsIn(path.join(claudeDir, 'commands'), 'user', fsx), ...skillsIn(path.join(claudeDir, 'skills'), 'user', fsx));
  // claude.ai-synced skills: one bucket per org and user (skills/synced/<bucket>/<name>/SKILL.md)
  for (const b of listDir(fsx, path.join(claudeDir, 'skills', 'synced'))) if (b.isDirectory()) all.push(...skillsIn(path.join(claudeDir, 'skills', 'synced', b.name), 'user', fsx));
  // installed plugins that are enabled in the account's settings
  let installed = {};
  let enabled = {};
  try { installed = JSON.parse(read(fsx, path.join(claudeDir, 'plugins', 'installed_plugins.json')) || '{}').plugins || {}; } catch { installed = {}; }
  try { enabled = JSON.parse(read(fsx, path.join(claudeDir, 'settings.json')) || '{}').enabledPlugins || {}; } catch { enabled = {}; }
  for (const [key, entries] of Object.entries(installed)) {
    if (enabled[key] !== true) continue;
    const plugin = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;
    const root = Array.isArray(entries) ? entries[0]?.installPath : entries?.installPath;
    if (NAME_RE.test(plugin) && typeof root === 'string') all.push(...pluginCommands(root, plugin, fsx));
  }
  for (const p of packs) if (NAME_RE.test(p.name)) all.push(...pluginCommands(p.dir, p.name, fsx));
  all.push(...extra.map((c) => ({ ...c, source: 'plugin' })), ...BUILTIN);
  const seen = new Set();
  return all.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

module.exports = { BUILTIN, describe, commandsIn, skillsIn, pluginCommands, commandsFor };
