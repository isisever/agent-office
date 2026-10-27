// Device link UI (contract v3.28): the "Devices" section under Accounts and the remote desks merged into the office
// data. Remote projects are rows in PROJECTS (renderer/hq-board.js). Kept apart from sidebar.js on purpose.
import { onLang, t } from './i18n.js';

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...any} children @returns {HTMLElement} */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
/** @param {Event} e */
const val = (e) => /** @type {HTMLInputElement} */ (e.target).value;
/** Incoming handoff ids already answered from this window (a second click must not open a second folder picker). */
const hoClicked = new Set();

/** A small popup (the .sb-modal look of sidebar.js): title, body, one Close button; Escape or a click outside closes. */
function popup(/** @type {string} */ title, /** @type {HTMLElement[]} */ body) {
  const close = () => back.remove();
  const back = h('div', {
    class: 'sb-modal-backdrop',
    onmousedown: (/** @type {Event} */ e) => { if (e.target === back) close(); },
    onkeydown: (/** @type {KeyboardEvent} */ e) => { e.stopPropagation(); if (e.key === 'Escape') close(); },
  },
  h('div', { class: 'sb-modal sb-modal-global', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sb-modal-head' }, h('span', {}, title), h('button', { class: 'sb-x', title: t('sidebar.close'), onclick: close }, '×')),
    h('div', { class: 'sb-modal-body' }, body),
    h('div', { class: 'sb-modal-foot' }, h('button', { class: 'sb-btn primary', onclick: close }, t('sidebar.close')))));
  document.body.append(back);
  /** @type {HTMLElement | null} */ (back.querySelector('input, button.primary'))?.focus();
}

/**
 * @param {HTMLElement} sidebarEl the #sidebar element (already mounted by sidebar.js)
 * @param {any} api window.agentOffice
 * @param {{ onMachines?: () => void }} [o] onMachines: the Machines button (v3.32)
 */
export function mountDevices(sidebarEl, api, { onMachines = () => {} } = {}) {
  const watchers = new Set(); // v3.32 the Machines panel redraws on every view
  /** @type {any} */
  let view = { name: '', devices: [], remotes: [], outgoing: [], pairing: null, error: null };
  let joinState = /** @type {{ busy: boolean, error: string }} */ ({ busy: false, error: '' });
  let editing = /** @type {string | null} */ (null);

  const section = h('details', { class: 'sb-devices sb-panel', id: 'sb-devices' });   // a panel like the sidebar's others (v3.43)
  try { /** @type {HTMLDetailsElement} */ (section).open = localStorage.getItem('ao.panel.devices') === '1'; } catch {}
  section.addEventListener('toggle', () => { try { localStorage.setItem('ao.panel.devices', /** @type {HTMLDetailsElement} */ (section).open ? '1' : '0'); } catch {} });
  sidebarEl.querySelector('.sb-accounts')?.after(section);

  function renderDevices() {
    const wasOpen = /** @type {HTMLDetailsElement} */ (section).open;
    // The four opt-ins per device live in a popup (the row shows how many are on); every one is off by default.
    const perms = (/** @type {any} */ d) => [
      ['allow', 'allowCommands', 'setAllow', ''], ['allowHandoff', 'allowHandoff', 'setAllowHandoff', 'sb-dev-handoff'],
      ['allowManage', 'allowManage', 'setAllowManage', 'sb-dev-manage'], ['allowAccounts', 'allowAccounts', 'setAllowAccounts', 'sb-dev-accounts'],
    ].map(([label, field, call, cls]) => ({ label, field, call, cls, on: Boolean(d[field]) }));
    const openPerms = (/** @type {any} */ d) => popup(t('devices.permissions', { name: d.name }),
      perms(d).map((x) => h('label', { class: 'sb-botcolor sb-langrow' },
        h('span', {}, t(`devices.${x.label}`)),
        h('input', { type: 'checkbox', class: 'sb-check ' + x.cls, checked: x.on, onchange: (/** @type {Event} */ e) => apply(api.link[x.call](d.id, /** @type {HTMLInputElement} */ (e.target).checked)) }))));
    const list = view.devices.map((/** @type {any} */ d) => h('li', { class: 'sb-dev' + (d.online ? ' online' : '') },
      h('div', { class: 'sb-dev-top' },
        h('span', { class: 'sb-adot', title: t(d.online ? 'devices.online' : 'devices.offline') }),
        editing === d.id
          ? h('input', { class: 'sb-dev-name', value: d.name, maxlength: 40, onchange: (/** @type {Event} */ e) => { editing = null; apply(api.link.rename(d.id, val(e))); }, onblur: () => { editing = null; render(); } })
          : h('span', { class: 'sb-name', title: `${t(d.online ? 'devices.online' : 'devices.offline')} · ${new Date(d.addedAt).toLocaleDateString()}` }, d.name),
        h('button', { class: 'sb-x sb-gear', title: t('devices.permissionsTitle'), onclick: () => openPerms(d) }, '⚙'),
        h('button', { class: 'sb-x', title: t('devices.rename'), onclick: () => { editing = d.id; render(); } }, '✎'),
        h('button', { class: 'sb-x', title: t('devices.remove'), onclick: () => { if (confirm(t('devices.removeConfirm', { name: d.name }))) apply(api.link.remove(d.id)); } }, '×'),
      ),
      h('div', { class: 'sb-dev-sub' }, t(d.online ? 'devices.online' : 'devices.offline'), ' · ', t('devices.permCount', { n: perms(d).filter((x) => x.on).length, total: 4 })),
      d.online && d.v === 1 ? h('div', { class: 'sb-note warn' }, t('devices.updateThere', { device: d.name })) : null,
    ));
    // v3.29 handoffs: offers waiting for an answer, transfers in progress, projects handed off from here
    const pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? Math.min(100, Math.floor((a / b) * 100)) : 0);
    const ho = view.handoffs || { out: [], in: [] };
    const answer = (/** @type {string} */ id, /** @type {boolean} */ yes) => {
      if (hoClicked.has(id)) return;
      hoClicked.add(id);
      for (const b of document.querySelectorAll(`#sb-ho-${id} button`)) /** @type {HTMLButtonElement} */ (b).disabled = true;
      apply(api.link.handoffAnswer(id, yes));
    };
    const incoming = ho.in.map((/** @type {any} */ x) => h('div', { class: 'sb-handoff', id: `sb-ho-${x.id}` },
      h('div', { class: 'sb-note' }, t('devices.handoff.offer', { device: x.deviceName, project: x.name })),
      x.stage === 'asking' ? h('div', { class: 'sb-note sb-ho-target', title: x.target || x.dir }, x.target ? t('devices.handoff.target', { dir: x.target }) : t('devices.handoff.targetAsk')) : null,
      x.stage === 'asking'
        ? h('div', { class: 'sb-row' },
          // one answer per offer: both buttons go grey on the first click (no second folder picker)
          h('button', { class: 'sb-x', disabled: x.answered || hoClicked.has(x.id), onclick: () => answer(x.id, true) }, t('devices.handoff.accept')),
          h('button', { class: 'sb-x', disabled: x.answered || hoClicked.has(x.id), onclick: () => answer(x.id, false) }, t('devices.handoff.decline')))
        : h('div', { class: 'sb-note' }, x.stage === 'receiving' ? t('devices.handoff.receiving', { pct: pct(x.got, x.total) }) : t('devices.handoff.applying'))));
    const outgoing = ho.out.map((/** @type {any} */ x) => h('div', { class: `sb-note ho-${x.stage}` },
      `${t('devices.handoff.out', { project: x.name, device: x.deviceName })} — `,
      x.stage === 'sending' ? t('devices.handoff.sending', { pct: pct(x.sent, x.total) }) : x.stage === 'failed' ? t('devices.handoff.failed', { reason: t(`main.handoffReason.${x.reason}`) }) : t(`devices.handoff.${x.stage}`)));
    const owners = (view.owners || []).map((/** @type {any} */ o) => o.unknown
      ? h('div', { class: 'sb-handoff' },
        h('div', { class: 'sb-note warn', title: o.dir }, t('devices.handedOffUnknown', { project: o.project, device: o.deviceName })),
        h('div', { class: 'sb-row' },
          h('button', { class: 'sb-x', disabled: !o.online, title: o.online ? '' : t('devices.handoff.askOffline'), onclick: () => apply(api.link.handoffAsk(o.dir)) }, t('devices.handoff.askAgain')),
          h('button', { class: 'sb-x', onclick: () => apply(api.link.handoffKeep(o.dir)) }, t('devices.handoff.keepHere'))))
      : h('div', { class: 'sb-note', title: o.dir }, t('devices.handedOff', { project: o.project, device: o.deviceName })));
    const p = view.pairing;
    const pairing = p?.code
      ? h('div', { class: 'sb-pair' },
        h('div', { class: 'sb-pair-code', id: 'sb-pair-code' }, p.code),
        h('div', { class: 'sb-note' }, t('devices.codeHint', { min: Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 60000)) })),
        h('button', { class: 'sb-x', onclick: () => apply(api.link.cancel()) }, t('devices.cancel')))
      : h('button', { class: 'sb-add', id: 'sb-dev-add', disabled: Boolean(p) || Boolean(view.error && view.error !== 'off'), onclick: () => apply(api.link.invite()) }, t('devices.add'));
    const join = h('form', { class: 'sb-join', onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const input = /** @type {HTMLInputElement} */ (/** @type {HTMLFormElement} */ (e.target).elements.namedItem('code'));
      joinState = { busy: true, error: '' };
      render();
      api.link.join(input.value).then((/** @type {any} */ r) => { joinState = { busy: false, error: r.ok ? '' : r.error }; view = r.view; render(); });
    } },
    h('input', { name: 'code', id: 'sb-join-code', placeholder: t('devices.enterCode'), autocomplete: 'off', spellcheck: 'false', disabled: joinState.busy }),
    h('button', { class: 'sb-x', type: 'submit', disabled: joinState.busy }, t(joinState.busy ? 'devices.pairing' : 'devices.pair')));
    // summary and body like the sidebar's other panels (sb-head-row header, sb-panel-body content): see sidebar.js panel()
    const summary = h('summary', { class: 'sb-head sb-head-row' },
      h('span', {}, t('devices.title') + (view.devices.length ? ` (${view.devices.filter((/** @type {any} */ d) => d.online).length}/${view.devices.length})` : '')));
    const body = h('div', { class: 'sb-panel-body sb-dev-body' }, ...[
      view.error && view.error !== 'off' ? h('div', { class: 'sb-note warn' }, t(`devices.error.${view.error}`)) : null,
      h('label', { class: 'sb-row sb-dev-self' }, h('span', {}, t('devices.thisDevice')),
        h('input', { class: 'sb-dev-name', value: view.name, maxlength: 40, onchange: (/** @type {Event} */ e) => apply(api.link.setName(val(e))) })),
      view.devices.length ? h('ul', { class: 'sb-list' }, list) : h('div', { class: 'sb-note' }, t('devices.none')),
      view.devices.length ? h('button', { class: 'sb-add sb-machines', id: 'sb-machines', onclick: () => onMachines() }, t('devices.machines')) : null,
      ...incoming, ...outgoing,
      owners.length ? h('div', { class: 'sb-sub' }, t('devices.handedOffTitle')) : null, ...owners,
      h('div', { class: 'sb-dev-pair' }, pairing, p?.code ? null : join),
      joinState.error ? h('div', { class: 'sb-note warn' }, t('devices.pairFailed', { error: joinState.error })) : null,
    ].filter((c) => c != null));                   // replaceChildren would show a null as the text "null"
    section.replaceChildren(summary, body);
    /** @type {HTMLDetailsElement} */ (section).open = wasOpen || Boolean(p) || joinState.busy || ho.in.length > 0;
  }

  function render() {
    for (const cb of watchers) cb(view);
    renderDevices();
  }
  /** @param {Promise<any>} p */
  function apply(p) { p.then((v) => { if (v) { view = v; render(); } }).catch((e) => console.error(e)); }

  api.link?.onChange((/** @type {any} */ v) => { view = v; render(); });
  api.link?.get().then((/** @type {any} */ v) => { view = v; render(); }).catch(() => {});
  onLang(render);
  setInterval(() => { if (view.pairing) renderDevices(); }, 30000);
  render();
  return { view: () => view, /** @param {(v: any) => void} cb */ onView: (cb) => { watchers.add(cb); } };
}

/**
 * The office data with the remote desks added: each remote project appears as "<device> · <project>" with its
 * workers, so the office draws them next to the local ones. The boss's own sign stays local.
 * @param {any} d OfficeData @param {any} view LinkView
 */
export function mergeRemote(d, view) {
  if (!d || !view?.remotes?.length) return d;
  const projects = [...(d.projects || [])];
  const workers = [...(d.workers || [])];
  for (const r of view.remotes) {
    for (const p of r.projects) {
      const name = `${r.name} · ${p.name}`;
      projects.push({ name, working: p.working, delivered: p.delivered, isBossBusy: p.status === 'working', waiting: p.status === 'approval' ? { tool: p.tool || '', since: r.at } : null, remote: r.device });
      for (const w of r.workers.filter((/** @type {any} */ x) => x.project === p.id)) {
        workers.push({ ...w, id: `remote:${r.device.slice(0, 8)}:${w.id}`, project: name, spawnAt: w.spawnAt || r.at });
      }
    }
  }
  return { ...d, projects, workers };
}
