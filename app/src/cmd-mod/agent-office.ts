// Agent Office's Command Code mod (contract v3.37). Shipped static with the app and loaded per run with
// `commandcode --mod <this file> --mod-option ao-spool=<dir> ...` (commandcode.ai/docs/mods: `--mod <path>` loads a mod
// for one session; `--mod-option name=value` sets a flag declared with `cmd.addFlag`, read with `cmd.getFlag`).
// API used, as documented there (experimental): `export default function (cmd: ModApi)`, `cmd.addFlag`,
// `cmd.getFlag`, `cmd.appendSystemPrompt(({state}) => string | undefined)`, `cmd.beforeToolCall(({toolName}) =>
// {block?, additionalContext?} | undefined)`, `cmd.onPermissionRequest(({toolName}) => 'allow'|'deny'|undefined)` and
// `cmd.on('subagent_start' | 'subagent_progress' | 'subagent_stop' | 'turn_start' | 'turn_end', handler)`.
//
// No-leak: the mod holds no user data and reads nothing (no file, no env, no office directory). It only APPENDS one
// JSON line per event to <spool>/events.jsonl, a folder the app made for this tab (userData/cmd-spool/<tab>). Lines
// hold ids, types, tool names and token counts: never a prompt, a tool input or a permission description.
// The types are declared here (a subset of '@commandcode/harness'), so the file type-checks without that package.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

type Disposable = { dispose(): void };
type Flag = { type: 'boolean' | 'string'; default?: boolean | string; description?: string };
type ToolHookResult = { block?: boolean; additionalContext?: string } | undefined;
type ModApi = {
  addFlag(name: string, flag: Flag): Disposable;
  getFlag(name: string): boolean | string | undefined;
  appendSystemPrompt(fn: (a: { state?: unknown }) => string | undefined): Disposable;
  beforeToolCall(fn: (a: { toolCallId?: string; toolName?: string }) => ToolHookResult): Disposable;
  onPermissionRequest(fn: (a: { toolName?: string; isSafetyPrompt?: boolean }) => 'allow' | 'deny' | undefined): Disposable;
  on(event: string, fn: (e: Record<string, unknown>) => void): Disposable;
};

// The static manager brief (no user data, no office directory, no project name).
export const MANAGER_BRIEF = [
  'Agent Office manager mode: you are the boss of this project.',
  'Split the work and hand each part to a subagent; keep the main conversation for planning, review and decisions.',
  'Give every subagent a clear goal, the files it may touch and the check that proves it is done.',
  'Ask each subagent for a report of at most 15 lines.',
  'Verify the result (tests, build, a look at the diff) before you call a task done.',
  'If the same error comes back twice, stop and rethink instead of retrying.',
].join('\n');

const clip = (v: unknown, n = 64): string => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
/** Only the numeric fields of a usage object (its field names are not documented). */
function usageOf(u: unknown): Record<string, number> | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(u as Record<string, unknown>).slice(0, 16)) {
    const n = num(v);
    if (n !== undefined && /^[A-Za-z_]{1,40}$/.test(k)) out[k] = n;
  }
  return out;
}

export default function agentOffice(cmd: ModApi): void {
  cmd.addFlag('ao-spool', { type: 'string', description: 'Agent Office: folder for the event spool' });
  cmd.addFlag('ao-manager', { type: 'boolean', default: false, description: 'Agent Office: manager brief' });
  cmd.addFlag('ao-step-budget', { type: 'string', description: 'Agent Office: tool calls per turn before wrap-up' });
  cmd.addFlag('ao-step-cap', { type: 'boolean', default: false, description: 'Agent Office: refuse calls past 2 x budget' });

  const spool = cmd.getFlag('ao-spool');
  const file = typeof spool === 'string' && spool ? join(spool, 'events.jsonl') : '';
  const write = (rec: Record<string, unknown>): void => {
    if (!file) return;
    try { appendFileSync(file, JSON.stringify({ ...rec, at: Date.now() }) + '\n', { mode: 0o600 }); } catch { /* the tab runs on */ }
  };

  const manager = cmd.getFlag('ao-manager');
  if (manager === true || manager === 'true') cmd.appendSystemPrompt(() => MANAGER_BRIEF); // byte-stable every round

  // Savings (v3.20 numbers, from the app): a wrap-up note at the budget and every budget/2 after it; strict refuses
  // calls past 2 x budget. Counted per turn of the main run (turn_start resets it).
  const budget = Number.parseInt(String(cmd.getFlag('ao-step-budget') ?? ''), 10);
  const capFlag = cmd.getFlag('ao-step-cap');
  const strict = capFlag === true || capFlag === 'true';
  let calls = 0;
  cmd.on('turn_start', () => { calls = 0; });
  if (Number.isInteger(budget) && budget > 0) {
    const half = Math.max(1, Math.floor(budget / 2));
    cmd.beforeToolCall(() => {
      calls++;
      if (strict && calls > 2 * budget) {
        write({ t: 'cap', calls });
        return { block: true, additionalContext: `Agent Office savings: the step cap (${2 * budget} tool calls) is reached. Stop and report in at most 15 lines.` };
      }
      if (calls >= budget && (calls - budget) % half === 0) {
        return { additionalContext: `Agent Office savings: ${calls} tool calls in this turn (budget ${budget}). Wrap up and report in at most 15 lines.` };
      }
      return undefined;
    });
  }

  cmd.on('subagent_start', (e) => write({ t: 'subagent_start', id: clip(e.toolCallId, 128), type: clip(e.subagentType) }));
  cmd.on('subagent_progress', (e) => write({ t: 'subagent_progress', id: clip(e.toolCallId, 128), tool: clip(e.toolName), tokens: num(e.tokensUsed) }));
  cmd.on('subagent_stop', (e) => write({ t: 'subagent_stop', id: clip(e.toolCallId, 128), type: clip(e.subagentType), tokens: num(e.tokensUsed) }));
  cmd.on('turn_end', (e) => write({ t: 'turn_end', turn: num(e.turnNumber), usage: usageOf(e.usage) }));
  cmd.onPermissionRequest((e) => { write({ t: 'permission', tool: clip(e.toolName) }); return undefined; }); // never answers
}
