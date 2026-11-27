// Studio's Settings page (contract v3.122): a full page in Studio's main region, a nav of sections on the left and the
// settings on the right, with a search box over them. Every setting is drawn from the shared model
// (src/settings-model.mjs) and drives the Office's OWN control for it (sidebar.settingControl): a switch here sets the
// Office checkbox and fires its change event, so the Office's handler runs and nothing about a setting is forked.
// Texts from main (account and project names) go in with textContent.

import { templatesManager } from './templates-ui.js';
import { SECTIONS, SETTINGS, settingsOf, controlKind, filterSettings, firstMatchSection } from '../src/settings-model.mjs';
import { icon } from './studio-icons.js';

const SYNC_MS = 1000;   // the controls follow changes made elsewhere (the Office popup, main) within a second

/**
 * @param {{
 *   el: (tag: string, props?: Record<string, any>, ...kids: any[]) => HTMLElement,
 *   t: (key: string, vars?: Record<string, any>) => string,
 *   host: HTMLElement,
 *   studioTheme: () => string, setStudioTheme: (v: string) => void,
 *   hooks: {
 *     sidebar: () => any, showPanel: (selector: string) => boolean, selectHq: () => void, openBoard: () => void,
 *     appInfo: () => { version: string | null, ready: string | null }, installUpdate: () => void, openTeam?: () => void,
 *     openWhatsNew?: () => void,   // v3.123 About → What's new
 *   },
 * }} o
 */
export function mountSettingsPage({ el, t, host, studioTheme, setStudioTheme, hooks }) {
  let section = 'general';
  let query = '';
  let timer = 0;
  /** @type {(() => void)[]} */
  let syncers = [];
  let projectId = '';

  const search = /** @type {HTMLInputElement} */ (el('input', { type: 'search', class: 'st-set-search', oninput: () => { query = search.value.trim(); draw(); } }));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const to = firstMatchSection(matches()); if (to) { query = ''; search.value = ''; section = to; draw(); } }
  });
  const backBtn = el('button', { class: 'st-set-back', type: 'button', onclick: () => close() }, icon('back', 16));
  const title = el('h1', { class: 'st-set-title' });
  const nav = el('nav', { class: 'st-set-nav' });
  const content = el('div', { class: 'st-set-content' });
  const page = el('div', { id: 'studio-settings', hidden: true, role: 'region' },
    el('div', { class: 'st-set-top' }, backBtn, title, el('label', { class: 'st-set-searchbox' }, icon('search', 14), search)),
    el('div', { class: 'st-set-body' }, nav, content));
  host.append(page);

  const sb = () => hooks.sidebar();
  const ctlOf = (/** @type {string} */ key) => sb()?.settingControl?.(key) || null;
  /** A setting's label (the Office's own label text when it has one) and its description. */
  function textOf(/** @type {import('../src/settings-model.mjs').Setting} */ s) {
    const c = s.studioOnly ? null : ctlOf(s.key);
    const label = (c?.label?.textContent || '').trim() || t(`settings.label.${s.key}`);
    return { label, description: t(`settings.desc.${s.key}`) };
  }
  /** The settings that can be shown (voice only when this build has it). */
  const available = () => SETTINGS.filter((s) => !s.key.startsWith('voice') || ctlOf(s.key));
  const matches = () => filterSettings(available(), query, textOf);

  // ---- controls: each reads the Office control and drives it with its own event ----
  const fire = (/** @type {HTMLElement} */ c, type = 'change') => c.dispatchEvent(new Event(type, { bubbles: true }));
  function switchEl(/** @type {HTMLInputElement} */ box, /** @type {string} */ label) {
    const sw = el('button', { class: 'st-switch', type: 'button', role: 'switch', 'aria-label': label, onclick: () => {
      box.checked = !box.checked;
      fire(box);
      sync();
      // Rows that depend on this switch (Team → "Team members") are drawn from its value: redraw the page.
      if (box === ctlOf('team')?.control) setTimeout(draw, 0);
    } }, el('span', { class: 'st-switch-knob' }));
    const sync = () => { sw.setAttribute('aria-checked', String(box.checked)); /** @type {HTMLButtonElement} */ (sw).disabled = box.disabled; };
    sync();
    syncers.push(sync);
    return sw;
  }
  function choiceEl(/** @type {HTMLSelectElement} */ sel, /** @type {string} */ label, /** @type {{ value: string, text: string }[] | null} */ own = null, /** @type {((v: string) => void) | null} */ set = null, /** @type {(() => string) | null} */ get = null) {
    const opts = () => own || [...sel.options].map((o) => ({ value: o.value, text: o.textContent || o.value }));
    const value = () => (get ? get() : sel.value);
    const apply = (/** @type {string} */ v) => { if (set) set(v); else { sel.value = v; fire(sel); } };
    if (controlKind('choice', opts().length) === 'segmented') {
      const group = el('div', { class: 'st-seg', role: 'radiogroup', 'aria-label': label });
      const sync = () => group.replaceChildren(...opts().map((o) => el('button', {
        class: 'st-seg-opt', type: 'button', role: 'radio', 'aria-checked': String(o.value === value()), disabled: sel?.disabled || undefined,
        onclick: () => { apply(o.value); sync(); },
      }, o.text)));
      sync();
      syncers.push(() => { if (!group.contains(document.activeElement)) sync(); });
      return group;
    }
    const pick = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-set-select', 'aria-label': label, onchange: () => apply(pick.value) }));
    const sync = () => {
      const list = opts();
      if (pick.options.length !== list.length || list.some((o, i) => pick.options[i].value !== o.value || pick.options[i].textContent !== o.text)) {
        pick.replaceChildren(...list.map((o) => el('option', { value: o.value }, o.text)));
      }
      pick.value = value();
      pick.disabled = Boolean(sel?.disabled);
    };
    sync();
    syncers.push(() => { if (document.activeElement !== pick) sync(); });
    return pick;
  }
  const notice = (/** @type {string} */ text, kind = '') => el('div', { class: `st-notice ${kind}`, role: 'note' }, icon('info', 14), el('span', {}, text));
  const button = (/** @type {string} */ label, /** @type {() => void} */ run, primary = false) => el('button', { class: `st-set-btn${primary ? ' primary' : ''}`, type: 'button', onclick: run }, label);
  /** Close the page and show an Office panel over Studio (its own element and handlers). */
  const panel = (/** @type {string} */ sel) => () => { close(); hooks.showPanel(sel); };

  /** One row: title, a one-line description and the control on the right; extra lines (notices) below. */
  function row(/** @type {import('../src/settings-model.mjs').Setting} */ s) {
    const { label, description } = textOf(s);
    const c = s.studioOnly ? null : ctlOf(s.key);
    /** @type {Node | null} */
    let ctl = null;
    /** @type {Node[]} */
    const below = [];
    if (s.type === 'switch' && c) ctl = switchEl(c.control, label);
    else if (s.type === 'choice' && c) ctl = choiceEl(c.control, label);
    else if (s.type === 'color' && c) {
      const input = /** @type {HTMLInputElement} */ (el('input', { type: 'color', class: 'st-set-color', 'aria-label': label, oninput: () => { c.control.value = input.value; fire(c.control, 'input'); } }));
      input.value = c.control.value;
      syncers.push(() => { if (document.activeElement !== input) input.value = c.control.value; });
      ctl = el('div', { class: 'st-set-inline' }, input, c.reset ? el('button', { class: 'st-set-btn', type: 'button', title: c.reset.title || '', onclick: () => c.reset.click() }, '↺') : null);
    } else if (s.key === 'studioTheme') {
      const opts = [{ value: 'system', text: t('studio.themeSystem') }, { value: 'light', text: t('studio.themeLight') }, { value: 'dark', text: t('studio.themeDark') }];
      ctl = choiceEl(/** @type {any} */ (null), label, opts, setStudioTheme, studioTheme);
    } else return customRow(s, label, description);
    if (s.key === 'voiceModel' && c?.state) {
      const state = notice('');
      const dl = button('', () => c.download?.click());
      const sync = () => {
        state.lastElementChild && (state.lastElementChild.textContent = c.state.textContent || '');
        state.hidden = !c.state.textContent;
        dl.textContent = c.download?.textContent || '';
        dl.hidden = !c.download || c.download.hidden || !c.download.textContent;
        /** @type {HTMLButtonElement} */ (dl).disabled = Boolean(c.download?.disabled);
      };
      sync();
      syncers.push(sync);
      below.push(el('div', { class: 'st-set-inline' }, state, dl));
    }
    return el('div', { class: 'st-set-row', 'data-key': s.key },
      el('div', { class: 'st-set-text' }, el('div', { class: 'st-set-label' }, label, s.officeOnly ? el('span', { class: 'st-set-tag' }, t('studio.set.officeOnly')) : null),
        el('div', { class: 'st-set-desc' }, description), ...below),
      el('div', { class: 'st-set-ctl' }, ctl));
  }

  /** The rows that are lists or links: accounts, a project's settings, team, MCP, devices, HQ, version. */
  function customRow(/** @type {import('../src/settings-model.mjs').Setting} */ s, /** @type {string} */ label, /** @type {string} */ description) {
    const head = (/** @type {Node | null} */ ctl) => el('div', { class: 'st-set-row' },
      el('div', { class: 'st-set-text' }, el('div', { class: 'st-set-label' }, label), el('div', { class: 'st-set-desc' }, description)),
      el('div', { class: 'st-set-ctl' }, ctl));
    switch (s.key) {
      case 'accountList': {
        const list = sb()?.accountList?.() || [];
        return el('div', { class: 'st-set-block' }, head(button(t('studio.set.manageAccounts'), panel('.sb-accounts'))),
          ...list.map((/** @type {any} */ a) => el('div', { class: 'st-set-item' },
            el('span', { class: 'st-avatar', 'aria-hidden': 'true' }, (a.label.trim()[0] || '?').toLocaleUpperCase()),
            el('span', { class: 'st-set-item-name' }, a.label),
            a.state ? el('span', { class: 'st-badge' }, a.state) : null,
            a.engine === 'claude' ? button(t('sidebar.login'), () => sb()?.login?.(a.id)) : null)));
      }
      case 'projectSettings': {
        const list = sb()?.projectList?.() || [];
        if (!list.length) return el('div', { class: 'st-set-block' }, head(null), notice(t('studio.set.noProjects')));
        if (!list.some((/** @type {any} */ p) => p.id === projectId)) projectId = list[0].id;
        const pick = /** @type {HTMLSelectElement} */ (el('select', { class: 'st-set-select', 'aria-label': label, onchange: () => { projectId = pick.value; draw(); } },
          ...list.map((/** @type {any} */ p) => el('option', { value: p.id, selected: p.id === projectId || undefined }, p.name))));
        const inline = sb()?.projectInline?.(projectId);
        if (!inline) return el('div', { class: 'st-set-block' }, head(pick));
        const save = /** @type {HTMLButtonElement} */ (button(t('sidebar.save'), async () => { save.disabled = true; await inline.save(); draw(); }, true));
        inline.bindSave(save);
        return el('div', { class: 'st-set-block' }, head(pick), el('div', { class: 'st-set-project-body' }, inline.body),
          el('div', { class: 'st-set-actions' }, button(t('studio.set.allProjectSettings'), () => { close(); sb()?.openProjectSettings?.(projectId); }), save));
      }
      case 'teamOpen': {
        const on = Boolean(ctlOf('team')?.control?.checked);
        return head(on ? button(t('studio.set.openTeam'), () => { close(); if (hooks.openTeam) hooks.openTeam(); else hooks.showPanel('#sb-panel-team'); }) : el('span', { class: 'st-set-desc' }, t('studio.set.teamOff')));
      }
      case 'mcpServers': return head(button(t('studio.set.open'), panel('#sb-panel-mcp')));
      case 'skills': return el('div', { class: 'st-set-block st-set-skills' }, sb()?.skillsSection?.() || null);
      case 'devices': return head(button(t('studio.set.open'), panel('#sb-devices')));
      case 'usage': return head(button(t('studio.set.open'), panel('#usage-panel')));   // the current project's usage
      case 'machines': return head(button(t('studio.set.open'), panel('#machines-panel')));
      case 'hq': return head(button(t('studio.set.open'), () => { close(); hooks.selectHq(); }));
      case 'routines': return head(button(t('studio.set.open'), () => { close(); hooks.openBoard(); }));
      case 'templates': return el('div', { class: 'st-set-block' }, head(null), templatesManager({ t }));   // v3.134 rename, delete
      case 'version': {
        const info = hooks.appInfo();
        return el('div', { class: 'st-set-block' }, head(el('span', { class: 'st-set-version' }, info.version || '—')),
          info.ready ? el('div', { class: 'st-set-actions' }, notice(t('studio.set.updateReady', { version: info.ready })), button(t('studio.set.restart'), () => hooks.installUpdate(), true))
            : notice(t('studio.set.autoUpdate')),
          hooks.openWhatsNew ? el('div', { class: 'st-set-actions' }, button(t('sidebar.whatsNew'), () => { close(); hooks.openWhatsNew?.(); })) : null);
      }
      default: return head(null);
    }
  }

  function card(/** @type {Node[]} */ rows) { return el('div', { class: 'st-set-card' }, ...rows); }

  function draw() {
    syncers = [];
    title.textContent = t('studio.settings');
    search.placeholder = t('studio.set.search');
    backBtn.setAttribute('aria-label', t('studio.set.back'));
    backBtn.setAttribute('title', `${t('studio.set.back')} (Esc)`);
    const found = query ? matches() : null;
    const active = found ? firstMatchSection(found) || section : section;
    nav.replaceChildren(...SECTIONS.map((sec) => el('button', {
      class: `st-set-nav-item${sec.id === active ? ' active' : ''}${found && !found.some((s) => s.section === sec.id) ? ' dim' : ''}`, type: 'button',
      'aria-current': sec.id === active ? 'page' : undefined,
      onclick: () => { section = sec.id; query = ''; search.value = ''; draw(); },
    }, icon(sec.icon, 15), el('span', {}, t(`studio.set.section.${sec.id}`)))));
    if (found) {
      content.replaceChildren(...(found.length ? SECTIONS.filter((sec) => found.some((s) => s.section === sec.id)).flatMap((sec) => [
        el('h2', { class: 'st-set-head' }, t(`studio.set.section.${sec.id}`)), card(found.filter((s) => s.section === sec.id).map(row))])
        : [el('div', { class: 'st-none' }, t('studio.noResults'))]));
      return;
    }
    const list = settingsOf(section, available());
    /** @type {Node[]} */
    const extra = [];
    if (section === 'voice' && !list.length) extra.push(notice(t('studio.set.voiceOff')));
    if (section === 'office') extra.push(notice(t('studio.set.officeNote')));
    content.replaceChildren(el('h2', { class: 'st-set-head' }, t(`studio.set.section.${section}`)), ...extra, ...(list.length ? [card(list.map(row))] : []));
  }

  function open(/** @type {string} */ to = '') {
    if (to && SECTIONS.some((s) => s.id === to)) section = to;
    query = '';
    search.value = '';
    page.hidden = false;
    draw();
    clearInterval(timer);
    timer = window.setInterval(() => { for (const f of syncers) { try { f(); } catch (e) { console.error(e); } } }, SYNC_MS);
    search.focus();
  }
  function close() {
    page.hidden = true;
    clearInterval(timer);
    syncers = [];
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || page.hidden || document.querySelector('.sb-modal-backdrop')) return;
    if (document.activeElement === search && search.value) return;   // the search box clears itself first
    e.preventDefault();
    close();
  });
  return { open, close, isOpen: () => !page.hidden, redraw: () => { if (!page.hidden) draw(); } };
}
