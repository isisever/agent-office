// Ajan ayrıntıları: ofiste tıklanan botun ne yaptığını sağda bir panelde gösterir.
// mountAgentPanel(el, { onClose, onSelect, anchor }) → { show(id), update(data), hide(), shownId() }
// - update(OfficeData) her office:data'da çağrılır; panel açıksa canlı güncellenir.
// - Eski eklenti verisinde prompt/detail/history/toolCount/result yoktur: panel yine çalışır.
// - '@boss' (core.mjs BOSS_ID) müdürün özetini gösterir; oradaki ajan satırına tıklamak onSelect(id) çağırır.
// - anchor verilirse panel o öğenin (ofis tuvali) kutusunu kaplar.

const BOSS_ID = '@boss';
const CLAMP = 220; // bundan uzun görev/sonuç daraltılır
const TYPE_NAMES = { 'general-purpose': 'Genel', Explore: 'Keşif', Plan: 'Plan', 'claude-code-guide': 'Rehber' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const shortTool = (t) => str(t).replace(/^mcp__(.*?)__/, '$1:');

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${String(s % 60).padStart(2, '0')} sn`;
  const h = Math.floor(m / 60);
  return `${h} sa ${String(m % 60).padStart(2, '0')} dk`;
}
function ago(at, now) {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return 'şimdi';
  if (s < 60) return `${s} sn önce`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  return `${Math.floor(h / 24)} gün önce`;
}
const clock = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function typeLabel(type) {
  const t = str(type) || 'ajan';
  const tr = TYPE_NAMES[t];
  return tr && tr !== t ? `${tr} · ${t}` : t;
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
  el.setAttribute('aria-label', 'Ajan ayrıntıları');
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

  function block(key, label, text, { copy = false, clamp = false, mono = false } = {}) {
    const body = str(text);
    if (!body) return '';
    const long = clamp && (body.length > CLAMP || body.split('\n').length > 5);
    const open = expanded.has(`${id}:${key}`);
    const tools = [];
    if (copy) {
      copies.set(key, body);
      tools.push(`<button class="ap-mini" data-copy="${esc(key)}" title="Panoya kopyala">kopyala</button>`);
    }
    if (long) tools.push(`<button class="ap-mini" data-toggle="${esc(key)}">${open ? 'daralt ▴' : 'devamı ▾'}</button>`);
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
    const statusTxt = failed ? 'başarısız ✗' : done ? 'bitti ✓' : 'çalışıyor';
    const elapsed = spawnAt == null ? '' : done
      ? `${span(w.doneAt - spawnAt)} sürdü · <time data-ago="${w.doneAt}"></time>`
      : `<time data-since="${spawnAt}"></time>`;
    const history = Array.isArray(w.history)
      ? w.history.filter((h) => h && typeof h === 'object' && (h.tool || h.detail)).slice(-20).reverse()
      : [];
    const toolCount = num(w.toolCount);
    const hasDetails = 'prompt' in w || 'detail' in w || 'history' in w || 'toolCount' in w || 'result' in w;

    let html = `<div class="ap-status ${statusCls}"><span class="ap-dot"></span>${statusTxt}<span class="ap-dim">${elapsed}</span></div>`;
    if (isGone) html += `<div class="ap-note">Ajan ofisten ayrıldı</div>`;
    html += block('desc', 'Açıklama', w.description);
    html += block('prompt', 'Görev', w.prompt, { copy: true, clamp: true });
    if (!done) {
      const tool = str(w.tool);
      const detail = str(w.detail);
      if (detail) copies.set('detail', detail);
      html += `<section class="ap-sec">
        <div class="ap-label">Şu an${detail ? `<span class="ap-tools"><button class="ap-mini" data-copy="detail" title="Panoya kopyala">kopyala</button></span>` : ''}</div>
        <div class="ap-now"><span class="ap-tool">${tool ? esc(shortTool(tool)) : 'düşünüyor…'}</span>${detail ? `<span class="ap-detail mono" title="${esc(detail)}">${esc(detail)}</span>` : ''}</div>
      </section>`;
    }
    if (history.length || toolCount != null) {
      const count = toolCount != null ? `${toolCount} araç çağrısı` : `${history.length} araç çağrısı`;
      const more = toolCount != null && toolCount > history.length ? ` · son ${history.length}` : '';
      html += `<section class="ap-sec ap-hist-sec">
        <div class="ap-label">Geçmiş<span class="ap-dim">${count}${more}</span></div>
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
    if (done) html += block('result', failed ? 'Sonuç (hata)' : 'Sonuç', w.result, { copy: true, clamp: true });
    if (!hasDetails) html += `<div class="ap-note">Ayrıntı yok — eklentiyi güncelle</div>`;
    return { title: typeLabel(w.type), project: str(w.project), html, now };
  }

  function bossHtml() {
    const d = data || {};
    const workers = (Array.isArray(d.workers) ? d.workers : []).filter((w) => w && num(w.doneAt) == null);
    const projects = Array.isArray(d.projects) ? d.projects : [];
    let html = `<div class="ap-status ${d.isBossBusy ? 'busy' : 'ok'}"><span class="ap-dot"></span>${d.isBossBusy ? 'çalışıyor' : 'bekliyor'}<span class="ap-dim">bugün ${num(d.delivered) ?? 0} teslim</span></div>`;
    if (projects.length) {
      html += `<section class="ap-sec"><div class="ap-label">Projeler</div><ul class="ap-projs">${projects.map((p) =>
        `<li><span class="ap-dot ${p.isBossBusy ? 'on' : ''}" title="${p.isBossBusy ? 'müdür bu projede çalışıyor' : ''}"></span><span class="ap-pname">${esc(p.name)}</span><span class="ap-dim">${num(p.working) ?? 0} çalışıyor · ${num(p.delivered) ?? 0} teslim</span></li>`).join('')}</ul></section>`;
    }
    html += `<section class="ap-sec"><div class="ap-label">Çalışan ajanlar<span class="ap-dim">${workers.length}</span></div>`;
    html += workers.length
      ? `<ul class="ap-agents">${workers.map((w) => `<li><button class="ap-agent" data-pick="${esc(w.id)}" title="Ayrıntıları göster"><span class="ap-tool">${esc(shortTool(w.tool) || 'düşünüyor')}</span><span class="ap-detail">${esc(str(w.description) || typeLabel(w.type))}</span>${w.project ? `<span class="ap-dim">${esc(w.project)}</span>` : ''}</button></li>`).join('')}</ul>`
      : `<div class="ap-empty">Şu an çalışan ajan yok.</div>`;
    html += '</section>';
    return { title: 'Müdür', project: '', html };
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
    else {
      const w = find(id);
      if (w) last = w;
      view = last && last.id === id
        ? workerHtml(last, !w)
        : { title: 'Ajan', project: '', html: '<div class="ap-note">Ajan ofisten ayrıldı</div>' };
    }
    const html = `<header class="ap-head">
        <span class="ap-title">${esc(view.title)}</span>
        ${view.project ? `<span class="ap-proj" title="Proje">${esc(view.project)}</span>` : ''}
        <button class="ap-close" data-close title="Kapat (Esc)">×</button>
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
      b.textContent = ok ? 'kopyalandı ✓' : 'kopyalanamadı';
      b.classList.add('done');
      setTimeout(() => { b.textContent = 'kopyala'; b.classList.remove('done'); }, 1200);
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
      ro?.disconnect();
    },
  };
  return api;
}
