// The settings model (contract v3.122): one list of every app setting, shared by the Office's Settings popup
// (renderer/sidebar.js openSettings, which lays its rows out in OFFICE_ORDER) and Studio's Settings page
// (renderer/studio-settings.js, which groups them by section). The model holds no setting logic: each entry names a
// control the Office already has, and both views drive that same control, so a change made in Studio is the change the
// Office sees. Pure, so it can be tested.

/** The Studio page's sections, in nav order, with their icon (renderer/studio-icons.js). */
export const SECTIONS = Object.freeze([
  { id: 'general', icon: 'gear' },
  { id: 'sessions', icon: 'chat' },
  { id: 'accounts', icon: 'user' },
  { id: 'projects', icon: 'folder' },
  { id: 'team', icon: 'team' },
  { id: 'voice', icon: 'mic' },
  { id: 'mcp', icon: 'plug' },
  { id: 'devices', icon: 'device' },
  { id: 'hq', icon: 'home' },
  { id: 'office', icon: 'office' },
  { id: 'about', icon: 'info' },
]);

/**
 * @typedef {'switch' | 'choice' | 'color' | 'custom'} SettingType
 * @typedef {{ key: string, section: string, type: SettingType, office?: string, officeOnly?: boolean, studioOnly?: boolean }} Setting
 * key: the setting's id (its description is settings.desc.<key>; a Studio-only one's label is settings.label.<key>).
 * office: the Office popup row it is (OFFICE_ORDER); the voice rows share the 'voice' slot. officeOnly: it changes
 * the Office's look only (Studio labels it so). studioOnly: Studio's page has it, the Office popup does not.
 */

/** @type {readonly Setting[]} */
export const SETTINGS = Object.freeze([
  // General
  { key: 'lang', section: 'general', type: 'choice', office: 'lang' },
  { key: 'studioTheme', section: 'general', type: 'choice', studioOnly: true },
  { key: 'experience', section: 'general', type: 'choice', office: 'experience' },
  { key: 'resume', section: 'general', type: 'switch', office: 'resume' },
  { key: 'resumeWork', section: 'general', type: 'switch', office: 'resumeWork' },
  // Sessions
  { key: 'sleep', section: 'sessions', type: 'choice', office: 'sleep' },
  { key: 'keepAwake', section: 'sessions', type: 'choice', office: 'keepAwake' },
  { key: 'chatView', section: 'sessions', type: 'switch', office: 'chatView' },
  { key: 'manager', section: 'sessions', type: 'switch', office: 'manager' },
  // Accounts
  { key: 'accountList', section: 'accounts', type: 'custom', studioOnly: true },
  { key: 'fallback', section: 'accounts', type: 'switch', office: 'fallback' },
  // Projects
  { key: 'projectSettings', section: 'projects', type: 'custom', studioOnly: true },
  // Team
  { key: 'team', section: 'team', type: 'switch', office: 'team' },
  { key: 'teamOpen', section: 'team', type: 'custom', studioOnly: true },
  // Voice (the Office shows the five as one block of rows)
  { key: 'voiceEnabled', section: 'voice', type: 'switch', office: 'voice' },
  { key: 'voiceLang', section: 'voice', type: 'choice', office: 'voice' },
  { key: 'voiceModel', section: 'voice', type: 'choice', office: 'voice' },
  { key: 'voiceSend', section: 'voice', type: 'switch', office: 'voice' },
  { key: 'voiceKey', section: 'voice', type: 'choice', office: 'voice' },
  // MCP & skills
  { key: 'shareMcp', section: 'mcp', type: 'switch', office: 'shareMcp' },
  { key: 'reloadMcp', section: 'mcp', type: 'switch', office: 'reloadMcp' },
  { key: 'mcpServers', section: 'mcp', type: 'custom', studioOnly: true },
  { key: 'skills', section: 'mcp', type: 'custom', office: 'skills' },
  // Devices & phone
  { key: 'devices', section: 'devices', type: 'custom', studioOnly: true },
  // HQ & routines
  { key: 'hq', section: 'hq', type: 'custom', studioOnly: true },
  { key: 'routines', section: 'hq', type: 'custom', studioOnly: true },
  // Office (the Office's look only)
  { key: 'office3d', section: 'office', type: 'switch', office: 'office3d', officeOnly: true },
  { key: 'theme', section: 'office', type: 'choice', office: 'theme', officeOnly: true },
  { key: 'look', section: 'office', type: 'choice', office: 'look', officeOnly: true },
  { key: 'mode', section: 'office', type: 'choice', office: 'mode', officeOnly: true },
  { key: 'bot', section: 'office', type: 'color', office: 'bot', officeOnly: true },
  // About & updates
  { key: 'version', section: 'about', type: 'custom', studioOnly: true },
]);

/** The Office popup's rows, top to bottom (unchanged since v3.120); 'voice' is the voice block, 'skills' the packs. */
export const OFFICE_ORDER = Object.freeze([
  'resume', 'resumeWork', 'manager', 'team', 'shareMcp', 'reloadMcp', 'fallback', 'sleep', 'keepAwake', 'voice',
  'lang', 'look', 'mode', 'office3d', 'experience', 'chatView', 'theme', 'bot', 'skills',
]);

/** The settings of one section, in model order. */
export const settingsOf = (/** @type {string} */ section, list = SETTINGS) => list.filter((s) => s.section === section);

/**
 * How Studio draws a choice: a segmented control for 2–4 options, else a quiet select.
 * @param {SettingType} type @param {number} optionCount
 * @returns {'switch' | 'segmented' | 'select' | 'color' | 'custom'}
 */
export function controlKind(type, optionCount = 0) {
  if (type !== 'choice') return type;
  return optionCount >= 2 && optionCount <= 4 ? 'segmented' : 'select';
}

/**
 * The search box: the settings whose label or description holds every word of the query (case and accents of the
 * locale ignored). An empty query keeps them all.
 * @template {Setting} S
 * @param {readonly S[]} list
 * @param {string} query
 * @param {(s: S) => { label: string, description: string }} textOf
 * @returns {S[]}
 */
export function filterSettings(list, query, textOf) {
  const words = String(query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((s) => {
    const { label, description } = textOf(s);
    const hay = `${label} ${description}`.toLocaleLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The section a search jumps to: the first section (nav order) with a match, or null. */
export function firstMatchSection(/** @type {readonly Setting[]} */ matches) {
  const ids = new Set(matches.map((s) => s.section));
  return SECTIONS.find((s) => ids.has(s.id))?.id || null;
}

/**
 * v3.122 the title bar's keep-awake control: the keepAwake setting's options as menu items (the current one checked),
 * and whether it is active (anything but 'off'), so the button can show its state at a glance.
 * @param {readonly { value: string, text: string }[]} options
 * @param {string} value
 */
export function keepAwakeView(options, value) {
  const items = options.map((o) => ({ value: o.value, text: o.text, checked: o.value === value }));
  const current = items.find((o) => o.checked) || null;
  return { items, active: Boolean(current) && value !== 'off', currentText: current?.text || '' };
}
