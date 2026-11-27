// v3.134 Order templates in the window (contract "Order templates"): the Templates menu next to HQ's composer and the
// small list with rename and delete (Studio Settings → HQ & routines, the Office's HQ panel). Using a template only
// fills HQ's composer; the person edits it and sends it, so the send is an ordinary typed order. Nothing here sends.
import { fillText, fromText } from '../src/template-fill.mjs';

/** @param {string} tag @param {Record<string, any>} attrs @param {...any} kids */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'hidden') n.hidden = Boolean(v);
    else n.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
const tapi = () => window.agentOffice?.templates || null;
/** @param {any} r @param {(k: string, v?: any) => string} t */
const why = (r, t) => t(`templates.why.${['invalid', 'unknown', 'too-many', 'gone'].includes(r?.reason) ? r.reason : 'invalid'}`);

/**
 * "Save as template" from composer text: the type prefix and a "Targets:" line are read back out of it.
 * @param {string} text @param {(k: string, v?: any) => string} t @returns {Promise<string>} a line for the person
 */
export async function saveFromText(text, t) {
  const api = tapi();
  if (!api) return '';
  const d = fromText(text);
  if (!d.text) return t('templates.emptyText');
  const r = await api.save(d).catch(() => null);
  return r?.ok ? t('templates.saved', { name: d.name }) : why(r, t);
}
/** "Save as template" on an order card: its original text, type and targets (main reads them). */
export async function saveFromOrder(/** @type {string} */ cardId, /** @type {(k: string, v?: any) => string} */ t) {
  const api = tapi();
  if (!api) return '';
  const o = await api.fromOrder(cardId).catch(() => null);
  if (!o?.ok) return why(o, t);
  const r = await api.save(o.draft).catch(() => null);
  return r?.ok ? t('templates.saved', { name: o.draft.name }) : why(r, t);
}
/** The palette rows for ⌘K "Run template…": each fills HQ's composer through `fill`. */
export async function paletteRows(/** @type {(text: string) => void} */ fill) {
  const list = (await tapi()?.list().catch(() => null)) || [];
  return list.map((/** @type {any} */ x) => ({ id: `t:${x.id}`, kind: 'template', label: x.name, keywords: `${x.type} ${x.text}`, run: () => fill(fillText(x)) }));
}

/**
 * The Templates button next to HQ's composer: a menu with every template (picking one calls `fill` with its text) and
 * "Save as template" for the composer's current text (`getText`).
 * @param {{ t: (k: string, v?: any) => string, fill: (text: string) => void, getText?: () => string, note?: (s: string) => void }} o
 */
export function templatesButton({ t, fill, getText, note = () => {} }) {
  const menu = el('div', { class: 'tpl-menu', role: 'menu', hidden: true });
  const btn = el('button', { class: 'tpl-btn', type: 'button', 'aria-haspopup': 'menu', title: t('templates.tip'), onclick: async (/** @type {Event} */ e) => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return; }
    const list = (await tapi()?.list().catch(() => null)) || [];
    menu.replaceChildren(
      ...(list.length ? list.map((/** @type {any} */ x) => el('button', { class: 'tpl-item', role: 'menuitem', type: 'button', title: x.text,
        onclick: () => { menu.hidden = true; fill(fillText(x)); } }, el('span', { class: `bv-dot bv-${x.type}` }), ` ${x.name}`)) : [el('div', { class: 'tpl-none' }, t('templates.none'))]),
      getText ? el('button', { class: 'tpl-item tpl-save', role: 'menuitem', type: 'button',
        onclick: async () => { menu.hidden = true; note(await saveFromText(getText(), t)); } }, t('templates.saveAs')) : null);
    menu.hidden = false;
  } }, t('templates.button'));
  document.addEventListener('click', () => { menu.hidden = true; });
  return el('span', { class: 'tpl-wrap' }, btn, menu);
}

/**
 * The list with rename and delete (and Use when `fill` is given); follows templates:changed.
 * @param {{ t: (k: string, v?: any) => string, fill?: (text: string) => void }} o
 */
export function templatesManager({ t, fill }) {
  const root = el('div', { class: 'tpl-manage' });
  /** @type {any[]} */ let list = [];
  let editing = '';
  let line = '';
  const draw = () => {
    root.replaceChildren(el('div', { class: 'tpl-head' }, t('templates.title')),
      ...(list.length ? list.map((x) => {
        if (editing === x.id) {
          const name = /** @type {HTMLInputElement} */ (el('input', { class: 'tpl-name-in', maxlength: '80', 'aria-label': t('templates.name') }));
          name.value = x.name;
          const save = async () => {
            const r = await tapi()?.save({ ...x, name: name.value }).catch(() => null);
            editing = ''; line = r?.ok ? '' : why(r, t); if (r?.ok) list = r.list; draw();
          };
          name.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => { e.stopPropagation(); if (e.key === 'Enter') save(); else if (e.key === 'Escape') { editing = ''; draw(); } });
          window.setTimeout(() => name.focus(), 0);
          return el('div', { class: 'tpl-row' }, name, el('button', { class: 'hq-link', type: 'button', onclick: save }, t('templates.saveName')));
        }
        return el('div', { class: 'tpl-row', title: x.text },
          el('span', { class: `bv-dot bv-${x.type}` }), el('span', { class: 'tpl-row-name' }, x.name),
          fill ? el('button', { class: 'hq-link', type: 'button', onclick: () => fill(fillText(x)) }, t('templates.use')) : null,
          el('button', { class: 'hq-link', type: 'button', onclick: () => { editing = x.id; draw(); } }, t('templates.rename')),
          el('button', { class: 'hq-link', type: 'button', onclick: async () => {
            const r = await tapi()?.remove(x.id).catch(() => null);
            line = r?.ok ? '' : why(r, t); if (r?.ok) list = r.list; draw();
          } }, t('templates.delete')));
      }) : [el('div', { class: 'tpl-none' }, t('templates.noneManage'))]),
      line ? el('div', { class: 'tpl-note' }, line) : null);
  };
  const load = () => tapi()?.list().then((/** @type {any} */ v) => { if (Array.isArray(v)) { list = v; if (!editing) draw(); } }).catch(() => {});
  tapi()?.onChange?.((/** @type {any} */ v) => { if (Array.isArray(v)) { list = v; if (!editing) draw(); } });
  draw();
  load();
  return root;
}
