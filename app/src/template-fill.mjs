// v3.134 Order templates in the renderer: the text a template puts into HQ's composer, and a default name for
// "Save as template". Pure; renderer/templates-ui.js uses them. The filled text is only a draft: nothing is sent.

export const TYPES = ['bugfix', 'hotfix', 'feature'];
const PREFIX_RE = /^\s*(bugfix|hotfix|feature)\s*:\s*/i;

/**
 * The composer text for a template: "<type>: <text>", then a "Targets: a, b" line when it has targets.
 * A text that already starts with a type prefix gets the template's type instead of a second prefix.
 */
export function fillText(/** @type {{ text?: unknown, type?: unknown, targets?: unknown }} */ tpl) {
  const type = TYPES.includes(String(tpl?.type)) ? String(tpl?.type) : 'feature';
  const body = String(tpl?.text ?? '').replace(PREFIX_RE, '').trim();
  const targets = Array.isArray(tpl?.targets) ? tpl.targets.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
  return `${type}: ${body}${targets.length ? `\nTargets: ${targets.join(', ')}` : ''}`;
}

/**
 * Composer text → a template draft { name, text, type, targets }: a leading type prefix becomes the type (else
 * `fallbackType`, else feature), a trailing "Targets: a, b" line becomes the targets, the name is the first line.
 */
export function fromText(/** @type {string} */ raw, fallbackType = '') {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  const m = PREFIX_RE.exec(text);
  const type = m ? m[1].toLowerCase() : TYPES.includes(fallbackType) ? fallbackType : 'feature';
  if (m) text = text.slice(m[0].length);
  /** @type {string[]} */
  let targets = [];
  const tm = /\n\s*Targets:\s*([^\n]*)\s*$/i.exec(text);
  if (tm) { targets = tm[1].split(',').map((x) => x.trim()).filter(Boolean); text = text.slice(0, tm.index).trim(); }
  const first = text.split('\n')[0].trim();
  const name = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return { name, text, type, targets };
}
