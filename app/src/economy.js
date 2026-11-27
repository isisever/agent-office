'use strict';
// Economy mode (contract v3.133): one global switch (state.economy) plus a per-project override (Project.economy
// 'on' | 'off'; absent = inherit). While it is on for a project, the settings the person left at their default take
// the economy value; an explicit per-project value always wins. Pure, no Electron.

const ECONOMY = Object.freeze({
  contextCap: 150000,    // the auto-compact window (Project.contextCap)
  agentModel: 'sonnet',  // the sub-agent default; the manager brief still asks for haiku on read/search/report agents
  savings: 'strict',     // the Savings level (accounts.js SAVINGS)
  shareMcp: false,       // the office's shared MCP servers
  sleepMinMinutes: 60,   // idle sleep is raised to at least this: a sleeping tab rebuilds its whole cache on wake
});
const OVERRIDES = ['inherit', 'on', 'off'];

/** Project.economy: 'on' | 'off' are kept; anything else is inherit (absent). */
const economyValue = (v) => (v === 'on' || v === 'off' ? v : 'inherit');
const withEconomy = (v) => (economyValue(v) !== 'inherit' ? { economy: v } : {});

/** Whether economy applies to the project: its own override, else the global switch. */
function economyOn(globalOn, project) {
  const v = economyValue(project?.economy);
  return v === 'inherit' ? globalOn === true : v === 'on';
}

/**
 * The idle sleep a tab of an economy project runs with. 0 (off) stays off: a tab that never sleeps never restarts.
 * Otherwise at least ECONOMY.sleepMinMinutes: the 1 h cache has expired by then anyway, so the restart costs nothing extra.
 */
function sleepMinutesFor(globalMinutes, on) {
  const m = Number(globalMinutes) || 0;
  if (!on || m === 0) return m;
  return Math.max(m, ECONOMY.sleepMinMinutes);
}

/**
 * The project as its sessions see it: an economy project gets the economy value for every setting it left at the
 * default. Same object when economy is off.
 */
function applyEconomy(project, on) {
  if (!on || !project) return project;
  return {
    ...project,
    ...(project.contextCap ? {} : { contextCap: ECONOMY.contextCap }),
    ...(project.savings ? {} : { savings: ECONOMY.savings }),
  };
}

/**
 * What the project's settings show: each value and where it comes from ('project' = the person set it, 'economy',
 * 'default'). defaults: { contextCap, agentModel, savings, shareMcp, sleepMinutes } with no economy.
 */
function effectiveView(project, { globalOn = false, defaults }) {
  const on = economyOn(globalOn, project);
  const p = project || {};
  const pick = (own, eco, def) => (own !== undefined && own !== null ? { value: own, source: 'project' }
    : on ? { value: eco, source: 'economy' } : { value: def, source: 'default' });
  const sleep = sleepMinutesFor(defaults.sleepMinutes, on);
  return {
    on,
    override: economyValue(p.economy),
    contextCap: pick(p.contextCap, ECONOMY.contextCap, defaults.contextCap),
    agentModel: pick(p.agentModel, ECONOMY.agentModel, defaults.agentModel),
    savings: pick(p.savings, ECONOMY.savings, defaults.savings),
    shareMcp: p.shareMcp === true ? { value: true, source: 'project' } : pick(undefined, ECONOMY.shareMcp, defaults.shareMcp),
    sleepMinutes: { value: sleep, source: sleep !== defaults.sleepMinutes ? 'economy' : 'default' },
  };
}

module.exports = { ECONOMY, OVERRIDES, economyValue, withEconomy, economyOn, sleepMinutesFor, applyEconomy, effectiveView };
