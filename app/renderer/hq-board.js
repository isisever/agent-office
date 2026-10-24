// HQ (contract v3.46): the pinned HQ row above PROJECTS, the Board shown in place of the office while HQ is selected,
// and paired devices' projects as rows in the PROJECTS list (badge "remote", greyed when offline; watch, board,
// reports, dispatch through HQ, start/wake/sleep/stop only with manage; no terminal, gear, ×, handoff or settings).
// Every text from the board is put in with textContent: report text is data, never markup.

const COLS = [
  ['queued', ['queued']],
  ['running', ['delivered', 'running']],
  ['needs', ['needs-approval']],
  ['done', ['reported', 'partial']],
  ['failed', ['failed', 'rejected', 'expired', 'lost']],
];
const OPEN = new Set(['queued', 'delivered', 'running', 'needs-approval']);

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

/** @param {{ sidebar: HTMLElement, office: HTMLElement | null, api: any, t: (k: string, v?: any) => string, onSelect: () => void, isMac: boolean }} o */
export function mountHq({ sidebar, office, api, t, onSelect, isMac }) {
  if (!api?.hq || !sidebar) return null;
  let view = { board: { tasks: [], requests: [] }, settings: { dispatchWithoutAsking: false }, running: false, remotes: [] };
  let selected = false;
  let openReport = '';
  const dot = el('span', { class: 'sb-dot' });
  const counts = el('span', { class: 'hq-counts' });
  const gear = el('button', { class: 'sb-gear', title: t('hq.settings'), onclick: (e) => { e.stopPropagation(); settings.hidden = !settings.hidden; } }, '⚙');
  const consent = el('input', { type: 'checkbox', onchange: async () => { view = await api.hq.setSettings({ dispatchWithoutAsking: consent.checked }); render(); } });
  const settings = el('div', { class: 'hq-settings', hidden: true },
    el('label', { title: t('hq.consentHint') }, consent, ` ${t('hq.consent')}`),
    el('button', { class: 'hq-link', onclick: () => api.hq.openFolder() }, t('hq.openFolder')));
  const row = el('div', { class: 'hq-row', id: 'hq-row', role: 'button', tabindex: '0', title: t('hq.title'), onclick: () => onSelect() },
    dot, el('span', { class: 'hq-name' }, `♛ ${t('hq.name')}`), counts, gear);
  sidebar.prepend(el('div', { class: 'hq-pinned' }, row, settings));
  const board = el('div', { id: 'hq-board', class: 'hq-board', hidden: true });
  office?.after(board);
  const remoteList = el('ul', { class: 'sb-list', id: 'sb-remote' });
  const placeRemote = () => { const pl = document.getElementById('sb-projects'); if (pl && remoteList.parentElement !== pl.parentElement) pl.after(remoteList); };

  async function showReport(task) {
    openReport = openReport === task.id ? '' : task.id;
    if (openReport) { task.text = await api.hq.report(task.id); if (!task.read) view = await api.hq.markRead(task.id); }
    render();
  }
  function renderBoard() {
    const tasks = view.board.tasks || [];
    board.replaceChildren(el('div', { class: 'hq-board-head' }, t('hq.board')), ...(tasks.length ? [] : [el('p', { class: 'hq-empty' }, t('hq.empty'))]),
      el('div', { class: 'hq-cols' }, ...COLS.map(([key, sts]) => el('section', { class: 'hq-col' },
        el('h3', {}, t(`hq.col.${key}`)),
        ...tasks.filter((x) => sts.includes(x.status)).map((x) => el('div', { class: `hq-task${x.read ? '' : ' unread'}`, onclick: () => showReport(x) },
          el('div', { class: 'hq-task-title' }, x.title || x.id),
          el('div', { class: 'hq-task-meta' }, `${x.project} · ${x.machine === 'self' ? t('hq.here') : x.machineName || x.machine} · ${x.status}${x.reason ? ` (${x.reason})` : ''}`),
          openReport === x.id ? el('pre', { class: 'hq-report' }, x.text || t('hq.noReport')) : null))))));
  }
  function renderRemote() {
    placeRemote();
    remoteList.replaceChildren(...(view.remotes || []).map((r) => el('li', { class: `sb-item sb-remote${r.online ? '' : ' offline'}`, title: r.online ? r.name : t('hq.offline') },
      el('span', { class: `sb-dot${r.online && r.status === 'working' ? ' on' : ''}` }),
      el('span', { class: 'sb-name' }, r.name),
      el('span', { class: 'hq-badge' }, `${t('hq.remote')} · ${r.machine}`),
      ...(r.online && r.actions.includes('wake') ? [
        el('button', { class: 'sb-gear', title: t('hq.start'), onclick: () => api.hq.remoteOp(r.key, 'wake') }, '▶'),
        el('button', { class: 'sb-gear', title: t('hq.sleep'), onclick: () => api.hq.remoteOp(r.key, 'sleep') }, '⏸')] : []))));
  }
  function render() {
    const tasks = view.board.tasks || [];
    dot.className = `sb-dot${view.running ? ' on' : ''}`;
    counts.textContent = `▶ ${tasks.filter((x) => OPEN.has(x.status)).length}  ● ${tasks.filter((x) => !x.read && !OPEN.has(x.status)).length}`;
    consent.checked = Boolean(view.settings?.dispatchWithoutAsking);
    row.classList.toggle('active', selected);
    board.hidden = !selected;
    if (office) office.hidden = selected;
    renderBoard();
    renderRemote();
  }
  api.hq.onBoard((v) => { if (v) { view = v; render(); } });
  api.hq.get().then((v) => { if (v) { view = v; render(); } }).catch(() => {});
  setInterval(() => api.hq.get().then((v) => { if (v) { view = v; render(); } }).catch(() => {}), 10000);
  window.addEventListener('keydown', (e) => { if (e.key === '0' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); onSelect(); } }, true);
  render();
  return { setSelected(on) { selected = Boolean(on); render(); } };
}
