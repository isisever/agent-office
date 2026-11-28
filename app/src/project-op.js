// Manual sleep / stop of a project's boss tab: the pure guard (no Electron; tested with node --test).
// One rule for both callers: a remote proj-op and the Studio "Sleep" menu item. It keeps the idle sleeper's safety
// guards: a tab sleeps only when nothing can be lost (no turn, no permission prompt, no unsent input).

/**
 * @param {'sleep'|'stop'} op
 * @param {{ engine?: string, running: boolean, tabState?: string, working?: boolean, hasDraft?: boolean, permission?: boolean, guiBusy?: boolean }} c
 * @returns {{ ok: true, action: 'do' | 'noop' } | { ok: false, reason: 'engine' | 'draft' | 'permission' | 'busy' }}
 */
function opGuard(op, c) {
  if (op === 'sleep' && (c.engine || 'claude') !== 'claude') return { ok: false, reason: 'engine' };
  if (!c.running) return { ok: true, action: 'noop' };   // already asleep or stopped
  if (c.hasDraft) return { ok: false, reason: 'draft' };
  if (c.permission) return { ok: false, reason: 'permission' };
  if (c.guiBusy) return { ok: false, reason: 'busy' };
  const ready = c.tabState === 'ready' || (c.tabState === 'starting' && !c.hasDraft);
  if (!ready || c.working) return { ok: false, reason: 'busy' };   // 'ready' includes a background shell: sleep/stop would kill it
  return { ok: true, action: 'do' };
}

module.exports = { opGuard };
