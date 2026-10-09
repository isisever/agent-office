// Ajan ayrıntıları: ofiste tıklanan botun ne yaptığını sağda bir panelde gösterir.
// mountAgentPanel(el, { onClose, onSelect, anchor }) → { show(id), update(data), hide(), shownId() }
// - update(OfficeData) her office:data'da çağrılır; panel açıksa canlı güncellenir.
// - Eski eklenti verisinde prompt/detail/history/toolCount/result yoktur: panel yine çalışır.
// - '@boss' (core.mjs BOSS_ID) müdürün özetini gösterir; oradaki ajan satırına tıklamak onSelect(id) çağırır.
// - anchor verilirse panel o öğenin (ofis tuvali) kutusunu kaplar.
// - 'shell:<id>' sunucu odasındaki bir arka plan komutunu gösterir (OfficeData.shells; eski veride yoktur).

import { onLang, pick, locale } from './i18n.js';

const BOSS_ID = '@boss';
const SHELL = 'shell:';
const CLAMP = 220; // bundan uzun görev/sonuç daraltılır

// Metinler (bkz. i18n.js): pick(S).anahtar, her çizimde okunur.
const S = {
  en: {
    types: { 'general-purpose': 'General', Explore: 'Explore', Plan: 'Plan', 'claude-code-guide': 'Guide' },
    agent: 'agent',
    sec: (n) => `${n}s`,
    minSec: (m, s) => `${m}m ${s}s`,
    hourMin: (h, m) => `${h}h ${m}m`,
    now: 'just now',
    secAgo: (n) => `${n}s ago`,
    minAgo: (n) => `${n}m ago`,
    hourAgo: (n) => `${n}h ago`,
    dayAgo: (n) => (n === 1 ? '1 day ago' : `${n} days ago`),
    working: 'working',
    killed: 'stopped ✗',
    failed: 'failed ✗',
    done: 'done ✓',
    copyTip: 'Copy to clipboard',
    copy: 'copy',
    copied: 'copied ✓',
    copyFailed: 'copy failed',
    collapse: 'collapse ▴',
    expand: 'more ▾',
    took: (d) => `took ${d}`,
    agentLeft: 'The agent left the office',
    description: 'Description',
    task: 'Task',
    nowLabel: 'Now',
    thinkingDots: 'thinking…',
    thinking: 'thinking',
    toolCalls: (n) => (n === 1 ? '1 tool call' : `${n} tool calls`),
    lastN: (n) => ` · last ${n}`,
    history: 'History',
    result: 'Result',
    resultError: 'Result (error)',
    noDetails: 'No details — update the plugin',
    commandLeft: 'The command left the office',
    command: 'Command',
    exitCode: 'Exit code',
    showAgent: 'Show the agent',
    agentGone: (id) => `agent ${id} · left the office`,
    showBoss: 'Show the boss',
    boss: 'Boss',
    mainSession: 'main session',
    startedBy: 'Started by',
    started: 'Started',
    bgCommand: 'Background command',
    bgCommands: 'Background commands',
    nRunning: (n) => `${n} running`,
    noBgCommands: 'No background commands running.',
    waiting: 'waiting',
    todayDelivered: (n) => `${n} delivered today`,
    projects: 'Projects',
    bossOnProject: 'the boss is working on this project',
    projStats: (w, d) => `${w} working · ${d} delivered`,
    workingAgents: 'Working agents',
    showDetails: 'Show details',
    noWorkers: 'No agents working right now.',
    agentTitle: 'Agent',
    project: 'Project',
    close: 'Close (Esc)',
    ariaLabel: 'Agent details',
  },
  tr: {
    types: { 'general-purpose': 'Genel', Explore: 'Keşif', Plan: 'Plan', 'claude-code-guide': 'Rehber' },
    agent: 'ajan',
    sec: (n) => `${n} sn`,
    minSec: (m, s) => `${m} dk ${s} sn`,
    hourMin: (h, m) => `${h} sa ${m} dk`,
    now: 'şimdi',
    secAgo: (n) => `${n} sn önce`,
    minAgo: (n) => `${n} dk önce`,
    hourAgo: (n) => `${n} sa önce`,
    dayAgo: (n) => `${n} gün önce`,
    working: 'çalışıyor',
    killed: 'durduruldu ✗',
    failed: 'başarısız ✗',
    done: 'bitti ✓',
    copyTip: 'Panoya kopyala',
    copy: 'kopyala',
    copied: 'kopyalandı ✓',
    copyFailed: 'kopyalanamadı',
    collapse: 'daralt ▴',
    expand: 'devamı ▾',
    took: (d) => `${d} sürdü`,
    agentLeft: 'Ajan ofisten ayrıldı',
    description: 'Açıklama',
    task: 'Görev',
    nowLabel: 'Şu an',
    thinkingDots: 'düşünüyor…',
    thinking: 'düşünüyor',
    toolCalls: (n) => `${n} araç çağrısı`,
    lastN: (n) => ` · son ${n}`,
    history: 'Geçmiş',
    result: 'Sonuç',
    resultError: 'Sonuç (hata)',
    noDetails: 'Ayrıntı yok — eklentiyi güncelle',
    commandLeft: 'Komut ofisten ayrıldı',
    command: 'Komut',
    exitCode: 'Çıkış kodu',
    showAgent: 'Ajanı göster',
    agentGone: (id) => `ajan ${id} · ofisten ayrıldı`,
    showBoss: 'Müdürü göster',
    boss: 'Müdür',
    mainSession: 'ana oturum',
    startedBy: 'Başlatan',
    started: 'Başladı',
    bgCommand: 'Arka plan komutu',
    bgCommands: 'Arka plan komutları',
    nRunning: (n) => `${n} çalışıyor`,
    noBgCommands: 'Çalışan arka plan komutu yok.',
    waiting: 'bekliyor',
    todayDelivered: (n) => `bugün ${n} teslim`,
    projects: 'Projeler',
    bossOnProject: 'müdür bu projede çalışıyor',
    projStats: (w, d) => `${w} çalışıyor · ${d} teslim`,
    workingAgents: 'Çalışan ajanlar',
    showDetails: 'Ayrıntıları göster',
    noWorkers: 'Şu an çalışan ajan yok.',
    agentTitle: 'Ajan',
    project: 'Proje',
    close: 'Kapat (Esc)',
    ariaLabel: 'Ajan ayrıntıları',
  },
};
const t = () => pick(S);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const shortTool = (t) => str(t).replace(/^mcp__(.*?)__/, '$1:');

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t().sec(s);
  const m = Math.floor(s / 60);
  if (m < 60) return t().minSec(m, String(s % 60).padStart(2, '0'));
  const h = Math.floor(m / 60);
  return t().hourMin(h, String(m % 60).padStart(2, '0'));
}
function ago(at, now) {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return t().now;
  if (s < 60) return t().secAgo(s);
  const m = Math.floor(s / 60);
  if (m < 60) return t().minAgo(m);
  const h = Math.floor(m / 60);
  if (h < 24) return t().hourAgo(h);
  return t().dayAgo(Math.floor(h / 24));
}
const clock = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function typeLabel(type) {
  const raw = str(type) || t().agent;
  const name = t().types[raw];
  return name && name !== raw ? `${name} · ${raw}` : raw;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

export function mountAgentPanel(el, { onClose, onSelect, anchor } = {}) {
  let data = null;
  let id = null;
  let last = null; // ofisten ayrılınca son bilinen hâli
  let lastHtml = '';
  let tick = 0;
  const expanded = new Set(); // `${id}:prompt` / `${id}:result`
  const copies = new Map(); // data-copy anahtarı → metin

  el.classList.add('agent-panel');
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t().ariaLabel);
  el.hidden = true;

  // terminale odak çalan belge düzeyi mouseup'a gitmesin (metin seçilebilsin)
  el.addEventListener('mouseup', (e) => e.stopPropagation());

  // ofis tuvalinin kutusunu kapla
  let ro = null;
  function place() {
    if (!anchor || el.hidden) return;
    const host = el.offsetParent;
    if (!host) return;
    const a = anchor.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    el.style.top = `${Math.round(a.top - h.top + 2)}px`;
    el.style.height = `${Math.max(120, Math.round(a.height - 4))}px`;
    el.style.right = `${Math.round(h.right - a.right + 2)}px`;
  }
  if (anchor && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(place);
    ro.observe(anchor);
  }

  function find(wid) {
    return (Array.isArray(data?.workers) ? data.workers : []).find((w) => w && w.id === wid) || null;
  }

  function findShell(sid) {
    return (Array.isArray(data?.shells) ? data.shells : []).find((s) => s && String(s.id) === sid) || null;
  }

  const shellDone = (s) => num(s.endAt) != null || (s.status != null && s.status !== 'running');
  function shellState(s) {
    if (!shellDone(s)) return { cls: 'busy', txt: t().working };
    if (s.status === 'killed') return { cls: 'bad', txt: t().killed };
    const code = num(s.exitCode);
    if (s.status === 'failed' || (code != null && code !== 0)) return { cls: 'bad', txt: t().failed };
    return { cls: 'ok', txt: t().done };
  }

  function block(key, label, text, { copy = false, clamp = false, mono = false } = {}) {
    const body = str(text);
    if (!body) return '';
    const long = clamp && (body.length > CLAMP || body.split('\n').length > 5);
    const open = expanded.has(`${id}:${key}`);
    const tools = [];
    if (copy) {
      copies.set(key, body);
      tools.push(`<button class="ap-mini" data-copy="${esc(key)}" title="${esc(t().copyTip)}">${esc(t().copy)}</button>`);
    }
    if (long) tools.push(`<button class="ap-mini" data-toggle="${esc(key)}">${open ? t().collapse : t().expand}</button>`);
    return `<section class="ap-sec">
      <div class="ap-label">${esc(label)}<span class="ap-tools">${tools.join('')}</span></div>
      <div class="ap-text${mono ? ' mono' : ''}${long && !open ? ' clamped' : ''}">${esc(body)}</div>
    </section>`;
  }

  function workerHtml(w, isGone) {
    const now = Date.now();
    const done = num(w.doneAt) != null;
    const failed = done && w.isOk === false;
    const spawnAt = num(w.spawnAt);
    const statusCls = failed ? 'bad' : done ? 'ok' : 'busy';
    const statusTxt = failed ? t().failed : done ? t().done : t().working;
    const elapsed = spawnAt == null ? '' : done
      ? `${t().took(span(w.doneAt - spawnAt))} · <time data-ago="${w.doneAt}"></time>`
      : `<time data-since="${spawnAt}"></time>`;
    const history = Array.isArray(w.history)
      ? w.history.filter((h) => h && typeof h === 'object' && (h.tool || h.detail)).slice(-20).reverse()
      : [];
    const toolCount = num(w.toolCount);
    const hasDetails = 'prompt' in w || 'detail' in w || 'history' in w || 'toolCount' in w || 'result' in w;

    let html = `<div class="ap-status ${statusCls}"><span class="ap-dot"></span>${statusTxt}<span class="ap-dim">${elapsed}</span></div>`;
    if (isGone) html += `<div class="ap-note">${t().agentLeft}</div>`;
    html += block('desc', t().description, w.description);
    html += block('prompt', t().task, w.prompt, { copy: true, clamp: true });
    if (!done) {
      const tool = str(w.tool);
      const detail = str(w.detail);
      if (detail) copies.set('detail', detail);
      html += `<section class="ap-sec">
        <div class="ap-label">${t().nowLabel}${detail ? `<span class="ap-tools"><button class="ap-mini" data-copy="detail" title="${esc(t().copyTip)}">${esc(t().copy)}</button></span>` : ''}</div>
        <div class="ap-now"><span class="ap-tool">${tool ? esc(shortTool(tool)) : t().thinkingDots}</span>${detail ? `<span class="ap-detail mono" title="${esc(detail)}">${esc(detail)}</span>` : ''}</div>
      </section>`;
    }
    if (history.length || toolCount != null) {
      const count = t().toolCalls(toolCount != null ? toolCount : history.length);
      const more = toolCount != null && toolCount > history.length ? t().lastN(history.length) : '';
      html += `<section class="ap-sec ap-hist-sec">
        <div class="ap-label">${t().history}<span class="ap-dim">${count}${more}</span></div>
        <ol class="ap-hist">${history.map((h) => {
          const at = num(h.at);
          const det = str(h.detail);
          return `<li>
            <time class="ap-when" ${at != null ? `data-ago="${at}" title="${esc(clock(at))}"` : ''}></time>
            <span class="ap-tool">${esc(shortTool(h.tool) || '?')}</span>
            <span class="ap-detail mono" title="${esc(det)}">${esc(det)}</span>
          </li>`;
        }).join('')}</ol>
      </section>`;
    }
    if (done) html += block('result', failed ? t().resultError : t().result, w.result, { copy: true, clamp: true });
    if (!hasDetails) html += `<div class="ap-note">${t().noDetails}</div>`;
    return { title: typeLabel(w.type), project: str(w.project), html, now };
  }

  function shellHtml(s, isGone) {
    const st = shellState(s);
    const startAt = num(s.startAt);
    const endAt = num(s.endAt);
    const elapsed = startAt == null ? '' : endAt != null
      ? `${t().took(span(endAt - startAt))} · <time data-ago="${endAt}"></time>`
      : shellDone(s) ? '' : `<time data-since="${startAt}"></time>`;
    let html = `<div class="ap-status ${st.cls}"><span class="ap-dot"></span>${st.txt}<span class="ap-dim">${elapsed}</span></div>`;
    if (isGone) html += `<div class="ap-note">${t().commandLeft}</div>`;
    html += block('command', t().command, s.command, { copy: true, mono: true });
    const code = num(s.exitCode);
    if (code != null) {
      html += `<section class="ap-sec"><div class="ap-label">${t().exitCode}</div><div class="ap-text mono">${code}</div></section>`;
    }
    html += block('desc', t().description, s.description);
    // başlatan: alt ajan (ofisteyse tıklanır) ya da ana oturum (müdür)
    const agentId = str(s.agentId);
    let who;
    if (agentId) {
      const w = find(agentId);
      who = w
        ? `<button class="ap-agent" data-pick="${esc(w.id)}" title="${esc(t().showAgent)}"><span class="ap-tool">${esc(typeLabel(w.type))}</span><span class="ap-detail">${esc(str(w.description))}</span></button>`
        : `<div class="ap-text"><span class="ap-dim">${esc(t().agentGone(agentId))}</span></div>`;
    } else {
      who = `<button class="ap-agent" data-pick="${BOSS_ID}" title="${esc(t().showBoss)}"><span class="ap-tool">${t().boss}</span><span class="ap-detail">${t().mainSession}</span></button>`;
    }
    html += `<section class="ap-sec"><div class="ap-label">${t().startedBy}</div>${who}</section>`;
    if (startAt != null) {
      html += `<section class="ap-sec"><div class="ap-label">${t().started}</div><div class="ap-text">${esc(clock(startAt))}${endAt != null ? ` → ${esc(clock(endAt))}` : ''}</div></section>`;
    }
    return { title: t().bgCommand, project: str(s.project), html };
  }

  function bossShells(d) {
    const running = (Array.isArray(d.shells) ? d.shells : []).filter((s) => s && s.id != null && !shellDone(s));
    let html = `<section class="ap-sec"><div class="ap-label">${t().bgCommands}<span class="ap-dim">${t().nRunning(running.length)}</span></div>`;
    if (!running.length) return html + `<div class="ap-empty">${t().noBgCommands}</div></section>`;
    const groups = new Map();
    for (const s of running) {
      const k = str(s.project);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [proj, list] of groups) {
      if (proj) html += `<div class="ap-shell-proj ap-dim">${esc(proj)}</div>`;
      html += `<ul class="ap-agents">${list.map((s) => `<li><button class="ap-agent" data-pick="${esc(SHELL + s.id)}" title="${esc(str(s.command))}"><span class="ap-detail mono">${esc(str(s.command) || '?')}</span>${num(s.startAt) != null ? `<time class="ap-dim" data-since="${s.startAt}"></time>` : ''}</button></li>`).join('')}</ul>`;
    }
    return html + '</section>';
  }

  function bossHtml() {
    const d = data || {};
    const workers = (Array.isArray(d.workers) ? d.workers : []).filter((w) => w && num(w.doneAt) == null);
    const projects = Array.isArray(d.projects) ? d.projects : [];
    let html = `<div class="ap-status ${d.isBossBusy ? 'busy' : 'ok'}"><span class="ap-dot"></span>${d.isBossBusy ? t().working : t().waiting}<span class="ap-dim">${t().todayDelivered(num(d.delivered) ?? 0)}</span></div>`;
    if (projects.length) {
      html += `<section class="ap-sec"><div class="ap-label">${t().projects}</div><ul class="ap-projs">${projects.map((p) =>
        `<li><span class="ap-dot ${p.isBossBusy ? 'on' : ''}" title="${p.isBossBusy ? esc(t().bossOnProject) : ''}"></span><span class="ap-pname">${esc(p.name)}</span><span class="ap-dim">${t().projStats(num(p.working) ?? 0, num(p.delivered) ?? 0)}</span></li>`).join('')}</ul></section>`;
    }
    html += `<section class="ap-sec"><div class="ap-label">${t().workingAgents}<span class="ap-dim">${workers.length}</span></div>`;
    html += workers.length
      ? `<ul class="ap-agents">${workers.map((w) => `<li><button class="ap-agent" data-pick="${esc(w.id)}" title="${esc(t().showDetails)}"><span class="ap-tool">${esc(shortTool(w.tool) || t().thinking)}</span><span class="ap-detail">${esc(str(w.description) || typeLabel(w.type))}</span>${w.project ? `<span class="ap-dim">${esc(w.project)}</span>` : ''}</button></li>`).join('')}</ul>`
      : `<div class="ap-empty">${t().noWorkers}</div>`;
    html += '</section>';
    html += bossShells(d);
    return { title: t().boss, project: '', html };
  }

  function fillTimes() {
    const now = Date.now();
    for (const t of el.querySelectorAll('time[data-ago]')) t.textContent = ago(Number(t.dataset.ago), now);
    for (const t of el.querySelectorAll('time[data-since]')) t.textContent = span(now - Number(t.dataset.since));
  }

  function render() {
    if (el.hidden || id == null) return;
    copies.clear();
    let view;
    if (id === BOSS_ID) view = bossHtml();
    else if (id.startsWith(SHELL)) {
      const s = findShell(id.slice(SHELL.length));
      if (s) last = s;
      view = last && SHELL + last.id === id
        ? shellHtml(last, !s)
        : { title: t().bgCommand, project: '', html: `<div class="ap-note">${t().commandLeft}</div>` };
    } else {
      const w = find(id);
      if (w) last = w;
      view = last && last.id === id
        ? workerHtml(last, !w)
        : { title: t().agentTitle, project: '', html: `<div class="ap-note">${t().agentLeft}</div>` };
    }
    const html = `<header class="ap-head">
        <span class="ap-title">${esc(view.title)}</span>
        ${view.project ? `<span class="ap-proj" title="${esc(t().project)}">${esc(view.project)}</span>` : ''}
        <button class="ap-close" data-close title="${esc(t().close)}">×</button>
      </header>
      <div class="ap-body">${view.html}</div>`;
    if (html !== lastHtml) {
      const body = el.querySelector('.ap-body');
      const scroll = body ? body.scrollTop : 0;
      el.innerHTML = html;
      lastHtml = html;
      const nb = el.querySelector('.ap-body');
      if (nb) nb.scrollTop = scroll;
    }
    fillTimes();
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    if (b.hasAttribute('data-close')) return api.hide();
    if (b.dataset.toggle) {
      const k = `${id}:${b.dataset.toggle}`;
      if (expanded.has(k)) expanded.delete(k);
      else expanded.add(k);
      return render();
    }
    if (b.dataset.copy) {
      const text = copies.get(b.dataset.copy);
      if (text == null) return;
      const ok = await copyText(text);
      b.textContent = ok ? t().copied : t().copyFailed;
      b.classList.add('done');
      setTimeout(() => { b.textContent = t().copy; b.classList.remove('done'); }, 1200);
      return;
    }
    if (b.dataset.pick) {
      const pick = b.dataset.pick;
      api.show(pick);
      try { onSelect?.(pick); } catch (err) { console.error(err); }
    }
  });

  function onKey(e) {
    if (e.key !== 'Escape' || el.hidden) return;
    // terminaldeki Esc Claude'a gider (kesme); orada yakalanmaz
    const a = document.activeElement;
    if (a && a !== el && !el.contains(a) && a.closest?.('.term-host, .xterm')) return;
    e.preventDefault();
    e.stopPropagation();
    api.hide();
  }
  window.addEventListener('keydown', onKey, true);

  // dil değişince açık görünüm yeniden çizilir
  const offLang = onLang(() => {
    el.setAttribute('aria-label', t().ariaLabel);
    lastHtml = '';
    render();
  });

  const api = {
    show(wid) {
      if (wid == null || wid === '') return api.hide();
      const next = String(wid);
      const wasHidden = el.hidden;
      if (next !== id) {
        id = next;
        last = null;
        lastHtml = '';
      }
      el.hidden = false;
      place();
      render();
      if (!tick) tick = setInterval(fillTimes, 1000);
      if (wasHidden || document.activeElement !== el) el.focus({ preventScroll: true });
    },
    update(d) {
      data = d && typeof d === 'object' ? d : null;
      render();
    },
    hide() {
      if (el.hidden && id == null) return;
      const was = id;
      el.hidden = true;
      id = null;
      last = null;
      lastHtml = '';
      el.innerHTML = '';
      clearInterval(tick);
      tick = 0;
      if (was != null) {
        try { onClose?.(); } catch (err) { console.error(err); }
      }
    },
    shownId() {
      return id;
    },
    destroy() {
      api.hide();
      window.removeEventListener('keydown', onKey, true);
      offLang();
      ro?.disconnect();
    },
  };
  return api;
}
