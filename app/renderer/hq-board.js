// HQ (contract v3.46): the pinned HQ row above PROJECTS, the Board shown in place of the office while HQ is selected,
// and paired devices' projects as rows in the PROJECTS list (badge "remote", greyed when offline; watch, board,
// reports, dispatch through HQ, start/wake/sleep/stop only with manage; no terminal, gear, ×, handoff or settings).
// Every text from the board is put in with textContent: report text is data, never markup.

const COLS = [
  ['queued', ['queued']],
  ['running', ['delivered', 'running']],
  ['needs', ['needs-approval', 'awaiting-consent']],
  ['done', ['reported', 'partial']],
  ['failed', ['failed', 'rejected', 'expired', 'lost']],
];
const OPEN = new Set(['queued', 'delivered', 'running', 'needs-approval', 'awaiting-consent']);
const RUN_OPEN = new Set(['waiting', 'typed', 'running', 'awaiting-consent']);
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k != null) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

// engine names on a remote row's status line (brand names, not translated)
const ENGINE_NAMES = { claude: 'Claude Code', agy: 'Antigravity', commandcode: 'Command Code', opencode: 'OpenCode' };

/** @param {{ sidebar: HTMLElement, office: HTMLElement | null, api: any, t: (k: string, v?: any) => string, onSelect: () => void, isMac: boolean, link?: { view: () => any, onView: (cb: (v: any) => void) => void } }} o */
export function mountHq({ sidebar, office, api, t, onSelect, isMac, link }) {
  if (!api?.hq || !sidebar) return null;
  let view = { board: { tasks: [], requests: [] }, settings: { dispatchWithoutAsking: false, enabled: true }, running: false, stopped: false, remotes: [] };
  let selected = false;
  let openReport = '';
  const dot = el('span', { class: 'sb-dot' });
  const counts = el('span', { class: 'hq-counts' });
  const gear = el('button', { class: 'sb-gear', title: t('hq.settings'), onclick: (e) => { e.stopPropagation(); settings.hidden = !settings.hidden; } }, '⚙');
  const consent = el('input', { type: 'checkbox', onchange: async () => { view = await api.hq.setSettings({ dispatchWithoutAsking: consent.checked }); render(); } });
  // HQ on/off (default on): off = no HQ pty; the row says "off" and keeps this toggle
  const onOff = el('input', { type: 'checkbox', class: 'hq-toggle', title: t('hq.enabled'), onclick: (e) => e.stopPropagation(),
    onchange: async () => { view = await api.hq.setSettings({ enabled: onOff.checked }); render(); } });
  // v3.47 routines: quiet hours and the daily cap for all routines
  const quietOn = el('input', { type: 'checkbox', onchange: () => saveCfg() });
  const quietFrom = el('input', { type: 'time', value: '22:00', onchange: () => saveCfg() });
  const quietTo = el('input', { type: 'time', value: '07:00', onchange: () => saveCfg() });
  const dailyCap = el('input', { type: 'number', min: '1', max: '96', value: '48', onchange: () => saveCfg() });
  async function saveCfg() { rv = await api.routines.setCfg({ quiet: quietOn.checked ? { from: quietFrom.value, to: quietTo.value } : null, dailyCap: Number(dailyCap.value) }); render(); }
  const settings = el('div', { class: 'hq-settings', hidden: true },
    el('label', { title: t('hq.consentHint') }, consent, ` ${t('hq.consent')}`),
    ...(api.routines ? [el('label', {}, quietOn, ` ${t('routines.quiet')} `, quietFrom, '–', quietTo), el('label', {}, `${t('routines.dailyCap')} `, dailyCap)] : []),
    el('button', { class: 'hq-link', onclick: () => api.hq.openFolder() }, t('hq.openFolder')));
  const row = el('div', { class: 'hq-row', id: 'hq-row', role: 'button', tabindex: '0', title: t('hq.title'), onclick: () => onSelect() },
    dot, el('span', { class: 'hq-name' }, `♛ ${t('hq.name')}`), counts, onOff, gear);
  const rtList = el('div', { class: 'rt-list', id: 'rt-list' });
  sidebar.prepend(el('div', { class: 'hq-pinned' }, row, settings, ...(api.routines ? [rtList] : [])));
  const board = el('div', { id: 'hq-board', class: 'hq-board', hidden: true });
  office?.after(board);
  // remote rows sit right under the local rows of PROJECTS, with the local rows' look (.sb-proj)
  const remoteList = el('ul', { class: 'sb-list sb-rlist', id: 'sb-rprojects' });
  let openKey = '';                 // the remote row showing its command box
  const drafts = new Map();         // typed commands per row, kept across live updates
  const placeRemote = () => { const pl = document.getElementById('sb-projects'); if (pl && remoteList.parentElement !== pl.parentElement) pl.after(remoteList); };

  async function showReport(task) {
    openReport = openReport === task.id ? '' : task.id;
    if (openReport) { task.text = await api.hq.report(task.id); if (!task.read) view = await api.hq.markRead(task.id); }
    render();
  }
  // --- v3.47 Routines: list under the HQ row; the editor and history replace the Board while one is open
  /** @type {any} */ let rv = { routines: [], cfg: { quiet: null, dailyCap: 48 }, runs: [], next: {}, problems: {}, held: [], projects: [], remotes: [] };
  /** @type {string | null} */ let rtSel = null;
  let rtTab = 'edit'; let rtOpen = true; let rtBuilt = ''; let rtNote = ''; let boardFilter = ''; let summaryOf = ''; let summaryText = '';
  const friendly = (ms) => {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms); const n = new Date();
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 864e5);
    return `${days === 0 ? t('routines.today') : days === 1 ? t('routines.tomorrow') : d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(d)}`;
  };
  const runsOf = (id) => (rv.runs || []).filter((r) => r.routine === id);
  function dotOf(r) {
    const runs = runsOf(r.id); const open = runs.find((x) => RUN_OPEN.has(x.status)); const last = runs.find((x) => x.finishedAt);
    if (r.paused) return 'paused';
    if (open?.status === 'awaiting-consent' || (open?.held || []).some((h) => rv.held.includes(h))) return 'amber';
    if (open) return 'on';
    return last && (last.status === 'attention' || last.status === 'failed') ? 'red' : '';
  }
  function openRoutine(id) { rtSel = id; rtTab = 'edit'; rtBuilt = ''; rtNote = ''; onSelect(); render(); }
  function renderRoutines() {
    const list = rv.routines || [];
    rtList.replaceChildren(
      el('div', { class: 'rt-head', onclick: () => { rtOpen = !rtOpen; render(); } }, `${rtOpen ? '▾' : '▸'} ${t('routines.title')} (${list.length})`),
      ...(rtOpen ? [
        ...list.map((r) => el('div', { class: `rt-row${rtSel === r.id ? ' active' : ''}`, title: rv.problems?.[r.id] || r.name, onclick: () => openRoutine(r.id) },
          el('span', { class: `rt-dot ${dotOf(r)}` }), el('span', { class: 'rt-name' }, r.name),
          el('span', { class: 'rt-next' }, r.paused ? t('routines.paused') : rv.problems?.[r.id] || friendly(rv.next?.[r.id])),
          runsOf(r.id).some((x) => !x.read && x.finishedAt) ? el('span', { class: 'rt-unread' }) : null,
          el('button', { class: 'sb-gear', title: t('routines.runNow'), onclick: async (e) => { e.stopPropagation(); const o = await api.routines.runNow(r.id); if (o?.view) rv = o.view; render(); } }, '▶'),
          el('button', { class: 'sb-gear', title: r.paused ? t('routines.resume') : t('routines.pause'), onclick: async (e) => { e.stopPropagation(); rv = await api.routines.setPaused(r.id, !r.paused); render(); } }, r.paused ? '⏵' : '⏸'))),
        el('div', { class: 'rt-row', onclick: () => openRoutine('new') }, t('routines.new')),
        el('div', { class: 'rt-note' }, t('routines.appOpen'))] : []));
  }
  function field(label, input, cls = '') { return el('label', { class: cls }, label, input); }
  function buildEditor(r) {
    const o = r || { name: '', prompt: '', target: { kind: 'hq' }, schedule: { kind: 'daily', at: '09:00' }, missed: 'once', maxPerDay: 4, noAsk: false };
    const sc = o.schedule;
    const name = el('input', { type: 'text', maxlength: '60', value: o.name });
    const prompt = el('textarea', {}); prompt.value = o.prompt;
    const counter = el('span', { class: 'rt-note' });
    // v3.49 remote targets: a paired device's project, with its machine; greyed while the device is offline (still allowed:
    // an approved run waits in the outbox). A remote run always asks first, so the no-ask checkbox is off for it.
    const tvOf = (x) => (x.kind === 'hq' ? 'hq' : x.kind === 'remote' ? `r:${x.pub}:${x.projectId}` : `p:${x.projectId}`);
    const remotes = rv.remotes || [];
    const gone = o.target.kind === 'remote' && !remotes.some((x) => x.pub === o.target.pub && x.id === o.target.projectId);
    const target = el('select', {}, el('option', { value: 'hq' }, t('routines.targetHq')),
      ...(rv.projects || []).map((p) => el('option', { value: `p:${p.id}`, disabled: p.engine !== 'claude' }, p.engine === 'claude' ? p.name : `${p.name} (${t('routines.engineOnly')})`)),
      ...remotes.map((x) => el('option', { value: `r:${x.pub}:${x.id}`, class: x.online ? 'rt-remote' : 'rt-remote rt-off' }, `${x.name} · ${x.machine}${x.online ? '' : ` (${t('routines.offline')})`}`)),
      ...(gone ? [el('option', { value: tvOf(o.target), disabled: true }, t('routines.remoteGone'))] : []));
    target.value = tvOf(o.target);
    const kind = el('select', {}, ...['daily', 'weekdays', 'weekly', 'hours'].map((k) => el('option', { value: k }, t(`routines.${k}`))));
    kind.value = sc.kind;
    const at = el('input', { type: 'time', value: sc.at || '09:00' });
    const day = el('select', {}, ...[0, 1, 2, 3, 4, 5, 6].map((i) => el('option', { value: String(i) }, new Date(2026, 9, 25 + i, 12).toLocaleDateString(undefined, { weekday: 'long' }))));
    day.value = String(sc.day ?? 1);
    const every = el('input', { type: 'number', min: '1', max: '24', value: String(sc.every || 6) });
    const from = el('input', { type: 'time', value: sc.from || '' });
    const to = el('input', { type: 'time', value: sc.to || '' });
    const missedOnce = el('input', { type: 'radio', name: 'rt-missed', checked: o.missed !== 'skip' });
    const missedSkip = el('input', { type: 'radio', name: 'rt-missed', checked: o.missed === 'skip' });
    const maxPerDay = el('input', { type: 'number', min: '1', max: '24', value: String(o.maxPerDay || 4) });
    const noAsk = el('input', { type: 'checkbox', checked: Boolean(o.noAsk) });
    const preview = el('div', { class: 'rt-note' });
    const note = el('div', { class: 'rt-warn' }, rtNote);
    const fAt = field(t('routines.at'), at); const fDay = field(t('routines.day'), day); const fEvery = field(t('routines.every'), every);
    const fWin = el('div', { class: 'rt-actions' }, field(t('routines.from'), from), field(t('routines.to'), to));
    const schedule = () => (kind.value === 'hours' ? { kind: 'hours', every: Number(every.value), ...(from.value ? { from: from.value } : {}), ...(from.value && to.value ? { to: to.value } : {}) }
      : kind.value === 'weekly' ? { kind: 'weekly', day: Number(day.value), at: at.value } : { kind: kind.value, at: at.value });
    const sync = async () => {
      counter.textContent = t('routines.bytes', { n: new TextEncoder().encode(prompt.value).length });
      fAt.hidden = kind.value === 'hours'; fDay.hidden = kind.value !== 'weekly'; fEvery.hidden = kind.value !== 'hours'; fWin.hidden = kind.value !== 'hours';
      const next = await api.routines.preview(schedule());
      preview.textContent = `${t('routines.nextRuns')}: ${(next || []).map(friendly).join(' · ')}`;
    };
    const syncTarget = () => { const rem = target.value.startsWith('r:'); noAsk.disabled = rem; noAsk.closest('label')?.setAttribute('title', t(rem ? 'routines.noAskRemote' : 'routines.noAskHint')); };
    target.addEventListener('change', syncTarget);
    for (const x of [prompt, kind, at, day, every, from, to]) x.addEventListener('input', sync);
    const save = async () => {
      const tv = target.value;
      const rest = tv.slice(2); const cut = rest.lastIndexOf(':');
      const tg = tv === 'hq' ? { kind: 'hq' } : tv.startsWith('r:') ? { kind: 'remote', pub: rest.slice(0, cut), projectId: rest.slice(cut + 1) } : { kind: 'project', projectId: rest };
      const res = await api.routines.save({ id: r?.id, name: name.value, prompt: prompt.value, target: tg,
        schedule: schedule(), missed: missedSkip.checked ? 'skip' : 'once', maxPerDay: Number(maxPerDay.value), noAsk: noAsk.checked });
      if (!res?.ok) { note.textContent = t(res?.reason === 'too-many' ? 'routines.tooMany' : 'routines.invalid'); return; }
      rv = res.view; rtSel = res.id; rtBuilt = ''; rtNote = res.redacted ? t('routines.redacted') : ''; render();
    };
    sync();
    const ed = el('div', { class: 'rt-editor' },
      field(t('routines.name'), name), field(t('routines.prompt'), prompt), counter, field(t('routines.target'), target),
      field(t('routines.schedule'), kind), fAt, fDay, fEvery, fWin,
      el('div', {}, t('routines.missed'), el('label', { class: 'inline' }, missedOnce, t('routines.missedOnce')), el('label', { class: 'inline' }, missedSkip, t('routines.missedSkip'))),
      field(t('routines.maxPerDay'), maxPerDay), el('label', { class: 'inline', title: t('routines.noAskHint') }, noAsk, t('routines.noAsk')), preview, note,
      el('div', { class: 'rt-actions' }, el('button', { onclick: save }, t('routines.save')),
        ...(r ? [el('button', { onclick: async () => { rv = await api.routines.setPaused(r.id, !r.paused); rtBuilt = ''; render(); } }, r.paused ? t('routines.resume') : t('routines.pause')),
          el('button', { onclick: async () => { if (!window.confirm(t('routines.confirmDelete'))) return; rv = await api.routines.remove(r.id); rtSel = null; render(); } }, t('routines.delete'))] : [])));
    syncTarget();
    return ed;
  }
  function historyOf(r) {
    const runs = runsOf(r.id);
    for (const x of runs) if (!x.read && x.finishedAt) api.routines.markRead(x.id).then((v) => { if (v) rv = v; }).catch(() => {});
    return el('div', { class: 'rt-editor' }, ...(runs.length ? [] : [el('p', { class: 'hq-empty' }, t('routines.noRuns'))]),
      ...runs.map((x) => el('div', { class: 'rt-run' },
        el('div', {}, new Date(x.at).toLocaleString(), ` · ${t(`routines.trigger.${x.trigger}`)}`,
          el('span', { class: `rt-chip ${x.status}` }, `${t(`routines.status.${x.status}`)}${x.reason ? `: ${x.reason}` : ''}${x.missedCount ? ` ×${x.missedCount}` : ''}`),
          x.wait ? el('span', { class: 'rt-chip wait' }, t(`routines.wait.${x.wait}`)) : null),
        x.outcome ? el('div', {}, x.outcome) : null,
        el('div', { class: 'rt-actions' },
          ...(x.held || []).filter((h) => rv.held.includes(h)).flatMap((h) => [
            el('button', { onclick: async () => { await api.routines.approve(h, true); refresh(); } }, t('routines.allow')),
            el('button', { onclick: async () => { await api.routines.approve(h, false); refresh(); } }, t('routines.decline'))]),
          ...(x.request ? [
            el('button', { class: 'hq-link', onclick: async () => { summaryOf = summaryOf === x.id ? '' : x.id; summaryText = summaryOf ? await api.routines.summary(x.request) : ''; render(); } }, t('routines.openSummary')),
            el('button', { class: 'hq-link', onclick: () => { boardFilter = x.request; rtSel = null; render(); } }, t('routines.showBoard'))] : [])),
        summaryOf === x.id ? el('pre', { class: 'hq-report' }, summaryText || t('hq.noReport')) : null)));
  }
  function renderRoutine() {
    const r = rtSel === 'new' ? null : (rv.routines || []).find((x) => x.id === rtSel);
    if (rtSel !== 'new' && !r) { rtSel = null; return false; }
    const key = `${rtSel}:${rtTab}`;
    if (rtTab === 'edit' && rtBuilt === key) return true;   // keep what the person is typing
    rtBuilt = rtTab === 'edit' ? key : '';
    board.replaceChildren(el('div', { class: 'rt-tabs' },
      el('button', { class: 'hq-link', onclick: () => { rtSel = null; render(); } }, t('routines.back')),
      el('button', { class: rtTab === 'edit' ? 'active' : '', onclick: () => { rtTab = 'edit'; render(); } }, t('routines.edit')),
      ...(r ? [el('button', { class: rtTab === 'history' ? 'active' : '', onclick: () => { rtTab = 'history'; render(); } }, t('routines.history'))] : [])),
    rtTab === 'history' && r ? historyOf(r) : buildEditor(r));
    return true;
  }
  const refresh = () => api.routines?.get().then((v) => { if (v) { rv = v; render(); } }).catch(() => {});
  function renderBoard() {
    if (rtSel && renderRoutine()) return;
    rtBuilt = '';
    const tasks = (view.board.tasks || []).filter((x) => !boardFilter || x.request === boardFilter);
    board.replaceChildren(el('div', { class: 'hq-board-head' }, t('hq.board')), ...(tasks.length ? [] : [el('p', { class: 'hq-empty' }, t('hq.empty'))]),
      ...(boardFilter ? [el('button', { class: 'hq-link', onclick: () => { boardFilter = ''; render(); } }, `✕ ${boardFilter}`)] : []),
      el('div', { class: 'hq-cols' }, ...COLS.map(([key, sts]) => el('section', { class: 'hq-col' },
        el('h3', {}, t(`hq.col.${key}`)),
        ...tasks.filter((x) => sts.includes(x.status)).map((x) => el('div', { class: `hq-task${x.read ? '' : ' unread'}`, onclick: () => showReport(x) },
          el('div', { class: 'hq-task-title' }, x.title || x.id),
          el('div', { class: 'hq-task-meta' }, `${x.project} · ${x.machine === 'self' ? t('hq.here') : x.machineName || x.machine} · ${x.status}${x.reason ? ` (${x.reason})` : ''}`),
          waitLine(x),
          x.status === 'awaiting-consent' && api.routines ? el('div', { class: 'rt-actions' },
            el('button', { onclick: async (e) => { e.stopPropagation(); await api.routines.approve(x.id, true); refresh(); } }, t('routines.allow')),
            el('button', { onclick: async (e) => { e.stopPropagation(); await api.routines.approve(x.id, false); refresh(); } }, t('routines.decline'))) : null,
          openReport === x.id ? el('pre', { class: 'hq-report' }, x.text || t('hq.noReport')) : null))))));
  }
  /** v3.46 amendment: why a queued task of this machine waits (boss busy/starting/asleep/not running), its place in
   *  that project's queue, when it expires, and Cancel. */
  function waitLine(x) {
    const w = x.status === 'queued' ? view.waits?.[x.id] : null;
    if (!w) return null;
    const min = Math.max(0, Math.ceil((w.expiresAt - Date.now()) / 60000));
    return el('div', { class: 'hq-task-wait' },
      el('span', {}, [t(`hq.wait.${w.state}`, { project: w.project, machine: w.machine || '' }), w.len > 1 ? t('hq.wait.pos', { n: w.pos, len: w.len }) : '', t('hq.wait.expires', { min })].filter(Boolean).join(' · ')),
      w.cancel === false ? null : el('button', { class: 'hq-link', title: t('hq.wait.cancelTip'), onclick: async (e) => { e.stopPropagation(); const v = await api.hq.cancel(x.id); if (v) { view = v; render(); } } }, t('hq.wait.cancel')));
  }
  /** The link's live snapshot of one remote project (engine, counts) and the commands sent to it. */
  function liveOf(r) {
    const lv = link?.view?.();
    const pub = r.key.slice(0, r.key.indexOf(':'));
    const p = lv?.remotes?.find((x) => x.device === pub)?.projects?.find((x) => x.id === r.id) || null;
    const out = (lv?.outgoing || []).filter((o) => o.pub === pub && o.project === r.id).slice(0, 2);
    // the link's view is live; the HQ view behind r is refreshed only every 10 s
    const online = lv?.devices?.find((d) => d.id === pub)?.online ?? r.online;
    return { pub, p, out, online };
  }
  function remoteCmd(r, pub, p, out) {
    if (!r.online) return el('div', { class: 'sb-rbox sb-note' }, t('hq.offline'));
    if ((p?.engine || 'claude') !== 'claude' || !api.link?.send) return el('div', { class: 'sb-rbox sb-note' }, t('devices.claudeOnly'));
    const input = el('input', { name: 'text', maxlength: 8192, placeholder: t('devices.prompt', { project: r.name }), oninput: () => drafts.set(r.key, input.value), onblur: () => setTimeout(renderRemote, 0) });
    input.value = drafts.get(r.key) || '';
    return el('div', { class: 'sb-rbox', onclick: (e) => e.stopPropagation() },
      el('form', { class: 'sb-rcmd', onsubmit: (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        drafts.delete(r.key);
        api.link.send(pub, r.id, input.value).then(() => renderRemote()).catch((err) => console.error(err));
        input.value = '';
      } }, input, el('button', { class: 'sb-btn', type: 'submit' }, t('devices.send'))),
      ...out.map((o) => el('div', { class: `sb-note cmd-${o.status}` },
        `${o.firstLine} — ${o.status === 'rejected' ? t('devices.cmd.rejected', { reason: t(`devices.reason.${o.reason}`) }) : t(`devices.cmd.${o.status}`)}`)));
  }
  function remoteRow(r) {
    const { pub, p, out, online } = liveOf(r);
    r = { ...r, online };
    const st = !online ? 'offline' : p?.status || r.status || 'idle';
    const open = openKey === r.key;
    const op = (action) => (e) => { e.stopPropagation(); api.hq.remoteOp(r.key, action); };
    const status = st === 'offline' ? t('devices.offline')
      : [t(`devices.status.${st}`), p?.working ? t('devices.working', { n: p.working }) : '', p?.delivered ? t('devices.delivered', { n: p.delivered }) : ''].filter(Boolean).join(' · ');
    return el('li', {
      class: `sb-proj sb-rrow st-${st}${open ? ' open' : ''}${r.online ? '' : ' offline'}`, 'data-key': r.key,
      title: `${r.name} · ${r.machine}\n${r.online ? t('hq.remoteTip') : t('hq.offline')}`,
      tabindex: '0', role: 'button', 'aria-expanded': String(open),
      onclick: () => { openKey = open ? '' : r.key; renderRemote(); },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openKey = open ? '' : r.key; renderRemote(); } },
    },
    el('span', { class: `sb-dot${st === 'working' || st === 'approval' ? ' live' : ''}` }),
    el('span', { class: 'sb-rname' }, el('span', { class: 'sb-name' }, r.name), el('span', { class: 'hq-badge', title: t('hq.remoteTitle') }, t('hq.remote'))),
    el('span', { class: 'sb-icons' },
      st === 'approval' ? el('span', { class: 'sb-attn permission', title: t('devices.status.approval') }, '✋') : null,
      ...(r.online && r.actions.includes('wake') ? [
        el('button', { class: 'sb-x sb-rop', title: t('hq.start'), 'aria-label': t('hq.start'), onclick: op('wake') }, '▶'),
        el('button', { class: 'sb-x sb-rop', title: t('hq.sleep'), 'aria-label': t('hq.sleep'), onclick: op('sleep') }, '⏸')] : [])),
    el('div', { class: 'sb-meta' },
      el('span', { class: 'sb-tag sb-engine' }, ENGINE_NAMES[p?.engine || 'claude'] || p?.engine),
      el('span', { class: 'sb-stats' }, status),
      el('span', { class: 'sb-machine', title: `${r.machine} · ${t(r.online ? 'devices.online' : 'devices.offline')}` }, `⇄ ${r.machine}`)),
    open ? remoteCmd(r, pub, p, out) : null);
  }
  function renderRemote() {
    placeRemote();
    // keep focus and typed text in a command box across live updates
    const focused = document.activeElement;
    if (focused && remoteList.contains(focused) && focused.tagName === 'INPUT') return;
    const rows = view.remotes || [];
    if (openKey && !rows.some((r) => r.key === openKey)) openKey = '';
    remoteList.hidden = !rows.length;
    remoteList.replaceChildren(...rows.map(remoteRow));
  }
  function render() {
    const tasks = view.board.tasks || [];
    dot.className = `sb-dot${view.running ? ' on' : ''}`;
    const on = view.settings?.enabled !== false;
    onOff.checked = on;
    counts.textContent = !on ? t('hq.off') : view.stopped ? t('hq.stopped')
      : `▶ ${tasks.filter((x) => OPEN.has(x.status)).length}  ● ${tasks.filter((x) => !x.read && !OPEN.has(x.status)).length}`;
    consent.checked = Boolean(view.settings?.dispatchWithoutAsking);
    row.classList.toggle('active', selected);
    board.hidden = !selected;
    if (office) office.hidden = selected;
    if (api.routines) {
      quietOn.checked = Boolean(rv.cfg?.quiet);
      if (rv.cfg?.quiet && document.activeElement !== quietFrom && document.activeElement !== quietTo) { quietFrom.value = rv.cfg.quiet.from; quietTo.value = rv.cfg.quiet.to; }
      if (document.activeElement !== dailyCap) dailyCap.value = String(rv.cfg?.dailyCap || 48);
      renderRoutines();
    }
    renderBoard();
    renderRemote();
  }
  api.routines?.onChange((v) => { if (v) { rv = v; render(); } });
  refresh();
  link?.onView?.(() => renderRemote());
  api.hq.onBoard((v) => { if (v) { view = v; render(); } });
  api.hq.get().then((v) => { if (v) { view = v; render(); } }).catch(() => {});
  setInterval(() => { api.hq.get().then((v) => { if (v) { view = v; render(); } }).catch(() => {}); refresh(); }, 10000);
  window.addEventListener('keydown', (e) => { if (e.key === '0' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); onSelect(); } }, true);
  render();
  // lazy start: HQ's pty starts the first time the person opens HQ
  return { setSelected(on) { selected = Boolean(on); if (!selected) rtSel = null; if (selected) api.hq.open?.().then((v) => { if (v) { view = v; render(); } }).catch(() => {}); render(); } };
}
