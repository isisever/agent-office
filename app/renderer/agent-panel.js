// Ajan ayrıntıları: ofiste tıklanan botun ne yaptığını sağda bir panelde gösterir.
// mountAgentPanel(el, { onClose, onSelect, onOpenProject, loadToday, anchor }) → { show(id), update(data), hide(), shownId() }
// - update(OfficeData) her office:data'da çağrılır; panel açıksa canlı güncellenir.
// - Eski eklenti verisinde prompt/detail/history/toolCount/result yoktur: panel yine çalışır.
// - '@boss' (core.mjs BOSS_ID) müdürün özetini gösterir; oradaki ajan satırına tıklamak onSelect(id) çağırır.
// - anchor verilirse panel o öğenin (ofis tuvali) kutusunu kaplar.
// - '@today' (core.mjs TODAY_ID, beyaz tahta) günün teslimlerini gösterir; veri loadToday() ile istenir (sözleşme v2.9).
// - 'shell:<id>' sunucu odasındaki bir arka plan komutunu gösterir (OfficeData.shells; eski veride yoktur).

import { onLang, t, hasText, locale } from './i18n.js';

const BOSS_ID = '@boss';
const TODAY_ID = '@today';
const TODAY_REFRESH_MS = 3000;
const SHELL = 'shell:';
const CLAMP = 220; // bundan uzun görev/sonuç daraltılır

// Metinler locales/*.json'da ("panel" altında), her çizimde okunur: t('panel.anahtar', { değişken }).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const shortTool = (t) => str(t).replace(/^mcp__(.*?)__/, '$1:');

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('panel.sec', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('panel.minSec', { m, s: String(s % 60).padStart(2, '0') });
  const h = Math.floor(m / 60);
  return t('panel.hourMin', { h, m: String(m % 60).padStart(2, '0') });
}
function ago(at, now) {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return t('panel.now');
  if (s < 60) return t('panel.secAgo', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('panel.minAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('panel.hourAgo', { n: h });
  return t('panel.dayAgo', { n: Math.floor(h / 24) });
}
const clock = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// saat:dakika, her dilde 24 saat (gün sonu listesi)
const hm = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};

function typeLabel(type) {
  const raw = str(type) || t('panel.agent');
  const name = hasText(`panel.types.${raw}`) ? t(`panel.types.${raw}`) : '';
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

/**
 * @param {HTMLElement} el
 * @param {{ onClose?: () => void, onSelect?: (id: string) => void, onOpenProject?: (name: string) => void, loadToday?: () => Promise<any>, anchor?: HTMLElement }} [opts]
 */
export function mountAgentPanel(el, { onClose, onSelect, onOpenProject, loadToday, anchor } = {}) {
  let data = null;
  let id = null;
  let last = null; // ofisten ayrılınca son bilinen hâli
  let lastHtml = '';
  let tick = 0;
  let today = null; // son loadToday() sonucu
  let todayAt = 0;
  let isTodayLoading = false;
  const expanded = new Set(); // `${id}:prompt` / `${id}:result`
  const copies = new Map(); // data-copy anahtarı → metin

  el.classList.add('agent-panel');
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('panel.ariaLabel'));
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
    if (!shellDone(s)) return { cls: 'busy', txt: t('panel.working') };
    if (s.status === 'killed') return { cls: 'bad', txt: t('panel.killed') };
    const code = num(s.exitCode);
    if (s.status === 'failed' || (code != null && code !== 0)) return { cls: 'bad', txt: t('panel.failed') };
    return { cls: 'ok', txt: t('panel.done') };
  }

  function block(key, label, text, { copy = false, clamp = false, mono = false } = {}) {
    const body = str(text);
    if (!body) return '';
    const long = clamp && (body.length > CLAMP || body.split('\n').length > 5);
    const open = expanded.has(`${id}:${key}`);
    const tools = [];
    if (copy) {
      copies.set(key, body);
      tools.push(`<button class="ap-mini" data-copy="${esc(key)}" title="${esc(t('panel.copyTip'))}">${esc(t('panel.copy'))}</button>`);
    }
    if (long) tools.push(`<button class="ap-mini" data-toggle="${esc(key)}">${open ? t('panel.collapse') : t('panel.expand')}</button>`);
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
    const statusTxt = failed ? t('panel.failed') : done ? t('panel.done') : t('panel.working');
    const elapsed = spawnAt == null ? '' : done
      ? `${t('panel.took', { time: span(w.doneAt - spawnAt) })} · <time data-ago="${w.doneAt}"></time>`
      : `<time data-since="${spawnAt}"></time>`;
    const history = Array.isArray(w.history)
      ? w.history.filter((h) => h && typeof h === 'object' && (h.tool || h.detail)).slice(-20).reverse()
      : [];
    const toolCount = num(w.toolCount);
    const hasDetails = 'prompt' in w || 'detail' in w || 'history' in w || 'toolCount' in w || 'result' in w;

    let html = `<div class="ap-status ${statusCls}"><span class="ap-dot"></span>${statusTxt}<span class="ap-dim">${elapsed}</span></div>`;
    if (isGone) html += `<div class="ap-note">${t('panel.agentLeft')}</div>`;
    html += block('desc', t('panel.description'), w.description);
    html += block('prompt', t('panel.task'), w.prompt, { copy: true, clamp: true });
    if (!done) {
      const tool = str(w.tool);
      const detail = str(w.detail);
      if (detail) copies.set('detail', detail);
      html += `<section class="ap-sec">
        <div class="ap-label">${t('panel.nowLabel')}${detail ? `<span class="ap-tools"><button class="ap-mini" data-copy="detail" title="${esc(t('panel.copyTip'))}">${esc(t('panel.copy'))}</button></span>` : ''}</div>
        <div class="ap-now"><span class="ap-tool">${tool ? esc(shortTool(tool)) : t('panel.thinkingDots')}</span>${detail ? `<span class="ap-detail mono" title="${esc(detail)}">${esc(detail)}</span>` : ''}</div>
      </section>`;
    }
    if (history.length || toolCount != null) {
      const count = t('panel.toolCalls', { n: toolCount != null ? toolCount : history.length });
      const more = toolCount != null && toolCount > history.length ? t('panel.lastN', { n: history.length }) : '';
      html += `<section class="ap-sec ap-hist-sec">
        <div class="ap-label">${t('panel.history')}<span class="ap-dim">${count}${more}</span></div>
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
    if (done) html += block('result', failed ? t('panel.resultError') : t('panel.result'), w.result, { copy: true, clamp: true });
    if (!hasDetails) html += `<div class="ap-note">${t('panel.noDetails')}</div>`;
    return { title: typeLabel(w.type), project: str(w.project), html, now };
  }

  function shellHtml(s, isGone) {
    const st = shellState(s);
    const startAt = num(s.startAt);
    const endAt = num(s.endAt);
    const elapsed = startAt == null ? '' : endAt != null
      ? `${t('panel.took', { time: span(endAt - startAt) })} · <time data-ago="${endAt}"></time>`
      : shellDone(s) ? '' : `<time data-since="${startAt}"></time>`;
    let html = `<div class="ap-status ${st.cls}"><span class="ap-dot"></span>${st.txt}<span class="ap-dim">${elapsed}</span></div>`;
    if (isGone) html += `<div class="ap-note">${t('panel.commandLeft')}</div>`;
    html += block('command', t('panel.command'), s.command, { copy: true, mono: true });
    const code = num(s.exitCode);
    if (code != null) {
      html += `<section class="ap-sec"><div class="ap-label">${t('panel.exitCode')}</div><div class="ap-text mono">${code}</div></section>`;
    }
    html += block('desc', t('panel.description'), s.description);
    // başlatan: alt ajan (ofisteyse tıklanır) ya da ana oturum (müdür)
    const agentId = str(s.agentId);
    let who;
    if (agentId) {
      const w = find(agentId);
      who = w
        ? `<button class="ap-agent" data-pick="${esc(w.id)}" title="${esc(t('panel.showAgent'))}"><span class="ap-tool">${esc(typeLabel(w.type))}</span><span class="ap-detail">${esc(str(w.description))}</span></button>`
        : `<div class="ap-text"><span class="ap-dim">${esc(t('panel.agentGone', { id: agentId }))}</span></div>`;
    } else {
      who = `<button class="ap-agent" data-pick="${BOSS_ID}" title="${esc(t('panel.showBoss'))}"><span class="ap-tool">${t('panel.boss')}</span><span class="ap-detail">${t('panel.mainSession')}</span></button>`;
    }
    html += `<section class="ap-sec"><div class="ap-label">${t('panel.startedBy')}</div>${who}</section>`;
    if (startAt != null) {
      html += `<section class="ap-sec"><div class="ap-label">${t('panel.started')}</div><div class="ap-text">${esc(clock(startAt))}${endAt != null ? ` → ${esc(clock(endAt))}` : ''}</div></section>`;
    }
    return { title: t('panel.bgCommand'), project: str(s.project), html };
  }

  function bossShells(d) {
    const running = (Array.isArray(d.shells) ? d.shells : []).filter((s) => s && s.id != null && !shellDone(s));
    let html = `<section class="ap-sec"><div class="ap-label">${t('panel.bgCommands')}<span class="ap-dim">${t('panel.nRunning', { n: running.length })}</span></div>`;
    if (!running.length) return html + `<div class="ap-empty">${t('panel.noBgCommands')}</div></section>`;
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
    let html = `<div class="ap-status ${d.isBossBusy ? 'busy' : 'ok'}"><span class="ap-dot"></span>${d.isBossBusy ? t('panel.working') : t('panel.waiting')}<span class="ap-dim">${t('panel.todayDelivered', { n: num(d.delivered) ?? 0 })}</span></div>`;
    if (projects.length) {
      html += `<section class="ap-sec"><div class="ap-label">${t('panel.projects')}</div><ul class="ap-projs">${projects.map((p) =>
        `<li><span class="ap-dot ${p.isBossBusy ? 'on' : ''}" title="${p.isBossBusy ? esc(t('panel.bossOnProject')) : ''}"></span><span class="ap-pname">${esc(p.name)}</span><span class="ap-dim">${t('panel.projStats', { working: num(p.working) ?? 0, delivered: num(p.delivered) ?? 0 })}</span></li>`).join('')}</ul></section>`;
    }
    html += `<section class="ap-sec"><div class="ap-label">${t('panel.workingAgents')}<span class="ap-dim">${workers.length}</span></div>`;
    html += workers.length
      ? `<ul class="ap-agents">${workers.map((w) => `<li><button class="ap-agent" data-pick="${esc(w.id)}" title="${esc(t('panel.showDetails'))}"><span class="ap-tool">${esc(shortTool(w.tool) || t('panel.thinking'))}</span><span class="ap-detail">${esc(str(w.description) || typeLabel(w.type))}</span>${w.project ? `<span class="ap-dim">${esc(w.project)}</span>` : ''}</button></li>`).join('')}</ul>`
      : `<div class="ap-empty">${t('panel.noWorkers')}</div>`;
    html += '</section>';
    html += bossShells(d);
    return { title: t('panel.boss'), project: '', html };
  }

  // gün sonu özeti: bugünün teslimleri (en yenisi önce), proje başına sayı ve ajan süresi
  function todayHtml() {
    if (Date.now() - todayAt > TODAY_REFRESH_MS && !isTodayLoading && loadToday) {
      isTodayLoading = true;
      loadToday()
        .then((d) => { today = d; })
        .catch((e) => console.error(e))
        .finally(() => { isTodayLoading = false; todayAt = Date.now(); render(); });
    }
    const list = Array.isArray(today?.deliveries) ? today.deliveries : [];
    const dur = (d) => Math.max(0, (num(d.doneAt) ?? 0) - (num(d.spawnAt) ?? num(d.doneAt) ?? 0));
    const ok = list.filter((d) => d.isOk !== false).length;
    const total = list.reduce((n, d) => n + dur(d), 0);
    let html = `<div class="ap-status ok"><span class="ap-dot"></span>${esc(t('panel.todaySummary', { n: list.length }) + (list.length - ok ? t('panel.todayFailed', { n: list.length - ok }) : ''))}${list.length ? `<span class="ap-dim">${esc(t('panel.agentTime', { time: span(total) }))}</span>` : ''}</div>`;
    const per = new Map();
    for (const d of list) {
      const k = str(d.project);
      const p = per.get(k) || { n: 0, ms: 0 };
      p.n++;
      p.ms += dur(d);
      per.set(k, p);
    }
    if (per.size > 1) {
      html += `<section class="ap-sec"><div class="ap-label">${t('panel.projects')}</div><ul class="ap-projs">${[...per].sort((a, b) => b[1].n - a[1].n).map(([name, p]) =>
        `<li><span class="ap-pname">${esc(name || '?')}</span><span class="ap-dim">${esc(t('panel.todayProj', { n: p.n, time: span(p.ms) }))}</span></li>`).join('')}</ul></section>`;
    }
    html += `<section class="ap-sec"><div class="ap-label">${t('panel.deliveries')}<span class="ap-dim">${list.length}</span></div>`;
    html += list.length
      ? `<ul class="ap-day">${list.map((d) => `<li class="${d.isOk === false ? 'bad' : ''}">
          <span class="ap-when ap-dim">${esc(hm(d.doneAt))}</span>
          <span class="ap-mark">${d.isOk === false ? '✗' : '✓'}</span>
          <span class="ap-what"><span class="ap-tool">${esc(typeLabel(d.type))}</span> ${esc(str(d.description))}</span>
          <span class="ap-dim">${esc(span(dur(d)))}${num(d.toolCount) ? ` · ${esc(t('panel.tools', { n: d.toolCount }))}` : ''}${per.size > 1 && d.project ? ` · ${esc(d.project)}` : ''}</span>
        </li>`).join('')}</ul>`
      : `<div class="ap-empty">${t('panel.noDeliveries')}</div>`;
    if (num(today?.untracked)) html += `<div class="ap-note">${esc(t('panel.untracked', { n: today.untracked }))}</div>`;
    return { title: t('panel.todayTitle'), project: '', html: html + '</section>' };
  }

  function fillTimes() {
    const now = Date.now();
    for (const t of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll('time[data-ago]'))) t.textContent = ago(Number(t.dataset.ago), now);
    for (const t of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll('time[data-since]'))) t.textContent = span(now - Number(t.dataset.since));
  }

  function render() {
    if (el.hidden || id == null) return;
    copies.clear();
    let view;
    if (id === BOSS_ID) view = bossHtml();
    else if (id === TODAY_ID) view = todayHtml();
    else if (id.startsWith(SHELL)) {
      const s = findShell(id.slice(SHELL.length));
      if (s) last = s;
      view = last && SHELL + last.id === id
        ? shellHtml(last, !s)
        : { title: t('panel.bgCommand'), project: '', html: `<div class="ap-note">${t('panel.commandLeft')}</div>` };
    } else {
      const w = find(id);
      if (w) last = w;
      view = last && last.id === id
        ? workerHtml(last, !w)
        : { title: t('panel.agentTitle'), project: '', html: `<div class="ap-note">${t('panel.agentLeft')}</div>` };
    }
    const html = `<header class="ap-head">
        <span class="ap-title">${esc(view.title)}</span>
        ${view.project ? `<span class="ap-proj" title="${esc(t('panel.project'))}">${esc(view.project)}</span>` : ''}
        ${view.project && onOpenProject ? `<button class="ap-go" data-go="${esc(view.project)}" title="${esc(t('panel.toTerminalTitle'))}">${esc(t('panel.toTerminal'))}</button>` : ''}
        <button class="ap-close" data-close title="${esc(t('panel.close'))}">×</button>
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
    const b = /** @type {Element} */ (e.target).closest('button');
    if (!b || !el.contains(b)) return;
    if (b.hasAttribute('data-close')) return api.hide();
    if (b.dataset.go) {
      const name = b.dataset.go;
      api.hide();
      try { onOpenProject?.(name); } catch (err) { console.error(err); }
      return;
    }
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
      b.textContent = ok ? t('panel.copied') : t('panel.copyFailed');
      b.classList.add('done');
      setTimeout(() => { b.textContent = t('panel.copy'); b.classList.remove('done'); }, 1200);
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
    el.setAttribute('aria-label', t('panel.ariaLabel'));
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
