// Sol kenar çubuğu: PROJELER (her satır bir proje) ve HESAPLAR.
// Yapı yalnızca proje/hesap listesi değişince yeniden kurulur; ofis istatistikleri yerinde güncellenir
// (açık <select> ya da yazılan ad 500 ms'lik veriyle bozulmasın).

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

/** Projenin satır altı özeti: "2 çalışıyor · 5 teslim". */
function statsText(s) {
  if (!s) return 'boşta';
  const parts = [];
  if (s.working) parts.push(`${s.working} çalışan`);
  if (s.delivered) parts.push(`${s.delivered} teslim`);
  return parts.length ? parts.join(' · ') : 'boşta';
}

const DEFAULT_NOTE = 'Varsayılan hesap, sistemdeki normal Claude Code girişidir; buradan çıkış yapılmaz.';
const AUTH_DOT = {
  in: 'Giriş yapıldı',
  out: 'Giriş yapılmadı',
  checking: 'Giriş durumu kontrol ediliyor',
  error: 'Giriş durumu okunamadı',
};

const pad2 = (n) => String(n).padStart(2, '0');
const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
/** Sıfırlanma zamanı: 24 saat içindeyse "14:30", değilse "Pzt 09:00". */
function resetText(ms, now) {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return ms - now < 24 * 3600e3 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}
/** "3 dk önce", "2 sa önce", "1 gün önce". */
function agoText(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return 'az önce';
  if (m < 60) return `${m} dk önce`;
  const hr = Math.round(m / 60);
  return hr < 24 ? `${hr} sa önce` : `${Math.round(hr / 24)} gün önce`;
}
const STALE_MS = 30 * 60e3;

export function mountSidebar(el, on) {
  let projects = [];
  let accounts = [];
  let activeId = null;
  let status = new Map();
  let stats = new Map();
  let projKey = '';
  let acctKey = '';
  let editing = null; // { id: string | null } — hesap adı düzenleniyor (null id = yeni hesap)

  // bot rengi: ofisteki botların gövde rengi (↺ = temanın varsayılanı)
  const botInput = h('input', { type: 'color', class: 'sb-color', title: 'Botların rengi', oninput: (e) => on.setBotColor?.(e.target.value) });
  const botRow = h('div', { class: 'sb-botcolor' },
    h('span', {}, 'Bot rengi'), botInput,
    h('button', { class: 'sb-x', title: 'Varsayılan renk', onclick: () => on.setBotColor?.(null) }, '↺'));
  const projList = h('ul', { class: 'sb-list', id: 'sb-projects' });
  const acctList = h('ul', { class: 'sb-list', id: 'sb-accounts' });
  el.append(
    h('div', { class: 'sb-head' }, h('span', {}, 'PROJELER')),
    projList,
    h('button', { class: 'sb-add', id: 'sb-add-project', title: 'Proje ekle (⌘O)', onclick: () => on.addProject() }, '+ Proje ekle'),
    h('div', { class: 'sb-accounts' },
      h('div', { class: 'sb-head' }, h('span', {}, 'HESAPLAR')),
      acctList,
    ),
    botRow,
  );

  // Projenin hesabı: açıkça "Hesap" etiketli açılır liste; son seçenek yeni hesap açıp bu projeye atar.
  const NEW_ACCOUNT = '__new__';
  function accountSelect(p) {
    const sel = h('select', {
      class: 'sb-acct',
      title: 'Bu projede kullanılacak Claude hesabı (değiştirince Claude yeniden başlar)',
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.value !== NEW_ACCOUNT) return on.setAccount(p.id, e.target.value);
        e.target.value = p.accountId;
        editing = { id: null, forProject: p.id };
        renderAccounts();
      },
    }, accounts.map((a) => h('option', { value: a.id, selected: a.id === p.accountId }, a.label)));
    if (!accounts.some((a) => a.id === p.accountId)) {
      sel.append(h('option', { value: p.accountId, selected: true }, '?'));
    }
    sel.append(h('option', { value: NEW_ACCOUNT }, '+ Yeni hesap…'));
    return h('label', { class: 'sb-acct-wrap', onclick: (e) => e.stopPropagation() },
      h('span', { class: 'sb-acct-label' }, 'Hesap'), sel);
  }

  /** Hesabında giriş yoksa proje satırında uyarı; tıklayınca giriş katmanı açılır. */
  function loginBadge(p) {
    const a = accounts.find((x) => x.id === p.accountId);
    if (a?.auth?.state !== 'out') return null;
    return h('button', {
      class: 'sb-warn',
      title: `“${a.label}” hesabında giriş yapılmamış; Claude bu projede çalışamaz.\nTıkla: giriş yap`,
      onclick: (e) => { e.stopPropagation(); on.login(a.id); },
    }, '⚠ giriş yok');
  }

  function renderProjects() {
    projList.replaceChildren(...projects.map((p, i) => {
      const s = stats.get(p.name);
      const live = status.get(p.id);
      return h('li', {
        class: 'sb-proj' + (p.id === activeId ? ' active' : ''),
        'data-id': p.id,
        title: p.dir + (i < 9 ? `\n⌘${i + 1}` : ''),
        onclick: () => on.select(p.id),
      },
        h('span', { class: 'sb-dot' + (live ? ' live' : ''), title: live ? 'Claude çalışıyor' : 'Claude kapalı' }),
        h('span', { class: 'sb-name' }, p.name),
        h('span', { class: 'sb-boss', hidden: !s?.isBossBusy, title: 'Patron meşgul' }, '★'),
        h('button', {
          class: 'sb-x', title: 'Listeden kaldır',
          onclick: (e) => { e.stopPropagation(); on.removeProject(p); },
        }, '×'),
        h('div', { class: 'sb-meta' },
          accountSelect(p),
          loginBadge(p),
          h('span', { class: 'sb-stats', title: statsText(s) }, statsText(s)),
        ),
      );
    }));
    if (!projects.length) projList.append(h('li', { class: 'sb-empty' }, 'Henüz proje yok'));
  }

  function nameInput(initial, done) {
    let finished = false;
    const finish = (val) => { if (finished) return; finished = true; editing = null; done(val); renderAccounts(); };
    const input = h('input', {
      class: 'sb-input', value: initial, maxLength: 40, placeholder: 'Hesap adı',
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(input.value.trim());
        else if (e.key === 'Escape') finish('');
      },
      onblur: () => finish(input.value.trim()),
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }

  /** Hesabın giriş satırı: e-posta + yöntem ya da durum, yanında Giriş yap / Çıkış yap. */
  function authRow(a, isDefault) {
    const auth = a.auth;
    if (!auth?.state) return null;
    const btn = (cls, text, title, fn) => h('button', { class: 'sb-btn ' + cls, title, onclick: (e) => { e.stopPropagation(); fn(); } }, text);
    const loginBtn = () => btn('primary', 'Giriş yap', `“${a.label}” hesabına giriş yap`, () => on.login(a.id));
    switch (auth.state) {
      case 'in':
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text sb-email', title: (auth.email || '') + (isDefault ? `\n${DEFAULT_NOTE}` : '') }, auth.email || 'giriş yapıldı'),
          auth.method ? h('span', { class: 'sb-method', title: 'Giriş yöntemi' }, auth.method) : h('span', { class: 'sb-method' }),
          isDefault ? null : btn('', 'Çıkış yap', `“${a.label}” hesabından çıkış yap`, () => on.logout(a)),
        );
      case 'checking':
        return h('div', { class: 'sb-auth' }, h('span', { class: 'sb-auth-text' }, 'kontrol ediliyor…'));
      case 'error':
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text', title: auth.error || 'Bilinmeyen hata' }, 'hata'),
          loginBtn());
      default:
        return h('div', { class: 'sb-auth' },
          h('span', { class: 'sb-auth-text', title: isDefault ? DEFAULT_NOTE : '' }, 'giriş yapılmadı'),
          loginBtn());
    }
  }

  /** Hesabın plan kotası: 5 saatlik ve haftalık kullanım, sıfırlanma zamanı (son açık oturumdan). */
  function usageRows(a) {
    const u = a.usage;
    if (!u || a.auth?.state !== 'in') return null;
    const now = Date.now();
    const ago = agoText(u.updatedAt, now);
    const row = (label, name, w) => {
      if (!w) return null;
      const isReset = w.resetsAt != null && w.resetsAt <= now;
      const pct = isReset ? 0 : Math.round(w.pct);
      const when = w.resetsAt == null ? '' : isReset ? 'sıfırlandı' : resetText(w.resetsAt, now);
      const level = pct >= 90 ? ' hi' : pct >= 70 ? ' mid' : '';
      const tip = `${name}: %${pct} kullanıldı`
        + (w.resetsAt == null ? '' : isReset ? '\nSıfırlandı' : `\nSıfırlanma: ${new Date(w.resetsAt).toLocaleString('tr-TR', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`)
        + `\nSon bilgi: ${ago} (bu hesapta açık bir Claude oturumundan)`;
      return h('div', { class: 'sb-usage' + level, title: tip },
        h('span', { class: 'sb-usage-label' }, label),
        h('span', { class: 'sb-usage-bar' }, h('span', { style: `width:${pct}%` })),
        h('span', { class: 'sb-usage-pct' }, `%${pct}`),
        h('span', { class: 'sb-usage-when' }, when));
    };
    return h('div', { class: 'sb-usages' + (now - u.updatedAt > STALE_MS ? ' stale' : '') },
      row('5 sa', '5 saatlik kullanım', u.fiveHour),
      row('Hafta', 'Haftalık kullanım', u.sevenDay));
  }

  function renderAccounts() {
    const rows = accounts.map((a) => {
      const isDefault = a.id === 'default';
      if (editing && editing.id === a.id) {
        return h('li', { class: 'sb-acc editing' }, nameInput(a.label, (label) => {
          if (label && label !== a.label) on.renameAccount(a.id, label);
        }));
      }
      const state = a.auth?.state;
      return h('li', { class: 'sb-acc' + (state ? ` auth-${state}` : ''), 'data-id': a.id },
        h('div', { class: 'sb-acc-top', title: isDefault ? `Sistemdeki ~/.claude girişi.\n${DEFAULT_NOTE}` : (a.configDir || '') },
          h('span', { class: 'sb-adot', title: AUTH_DOT[state] || '' }),
          h('span', { class: 'sb-name' }, a.label),
          isDefault ? h('span', { class: 'sb-tag' }, 'sistem') : null,
          h('button', {
            class: 'sb-x', title: 'Giriş durumunu yenile', disabled: state === 'checking',
            onclick: () => on.refreshAuth(a.id),
          }, '↻'),
          isDefault ? null : [
            h('button', { class: 'sb-x', title: 'Yeniden adlandır', onclick: () => { editing = { id: a.id }; renderAccounts(); } }, '✎'),
            h('button', { class: 'sb-x', title: 'Hesabı kaldır', onclick: () => on.removeAccount(a) }, '×'),
          ],
        ),
        authRow(a, isDefault),
        usageRows(a),
      );
    });
    if (editing && editing.id === null) {
      const forProject = editing.forProject;
      rows.push(h('li', { class: 'sb-acc editing' }, nameInput('', (label) => {
        if (label) on.addAccount(label, forProject);
      })));
    }
    acctList.replaceChildren(...rows,
      h('li', {}, h('button', {
        class: 'sb-add', title: 'Yeni Claude hesabı',
        onclick: () => { editing = { id: null }; renderAccounts(); },
      }, '+ Hesap ekle')));
  }

  // sıfırlanma zamanları ve "x dk önce" kendiliğinden eskir: dakikada bir yeniden çiz
  setInterval(() => { if (!editing && accounts.some((a) => a.usage)) renderAccounts(); }, 60000);

  return {
    /** Seçicide gösterilen bot rengi. */
    setBotColor(hex) { botInput.value = hex || '#3fb6a8'; },
    /** Proje listesi, etkin proje, çalışma durumu ve hesaplar. */
    setState(s) {
      projects = s.projects || [];
      accounts = s.accounts || [];
      activeId = s.activeId;
      status = new Map((s.status || []).map((x) => [x.id, x.isRunning]));
      const pk = JSON.stringify([projects, activeId, [...status], accounts.map((a) => [a.id, a.label, a.auth?.state])]);
      if (pk !== projKey) { projKey = pk; renderProjects(); }
      const ak = JSON.stringify(accounts);
      if (ak !== acctKey && !editing) { acctKey = ak; renderAccounts(); }
    },
    /** OfficeData.projects: proje adına göre çalışan / teslim / patron. */
    setStats(list) {
      stats = new Map((list || []).map((s) => [s.name, s]));
      for (const li of projList.querySelectorAll('.sb-proj')) {
        const p = projects.find((x) => x.id === li.dataset.id);
        const s = p && stats.get(p.name);
        const t = statsText(s);
        const st = li.querySelector('.sb-stats');
        if (st.textContent !== t) { st.textContent = t; st.title = t; }
        li.querySelector('.sb-boss').hidden = !s?.isBossBusy;
      }
    },
  };
}
