// Mail (contract v3.85): the MAIL panel's rows and its popups, drawn into the sidebar (sidebar.js passes h / t /
// openModal / closeModal). Accounts: Gmail (app password), Microsoft 365 / Outlook (device code sign-in with the
// person's app registration) and Exchange or any IMAP/SMTP server. The outbox: drafts staff members made, each
// opened here, read whole, edited if needed and sent only by the person's Send (and a confirmation). Passwords go to
// main and never come back; nothing here can read one.

const PROVIDERS = ['gmail', 'exchange', 'm365', 'imap'];

/**
 * @param {{ h: Function, t: Function, api: any, openModal: Function, closeModal: Function }} c
 */
export function createMail(c) {
  const { h, t, api } = c;
  let accounts = [];
  let encryption = true;
  let drafts = [];
  const head = h('span', {});
  const list = h('ul', { class: 'sb-list', id: 'sb-mail' });
  const outboxHead = h('div', { class: 'sb-role-head sb-mail-outbox-head' });
  const outboxList = h('ul', { class: 'sb-list', id: 'sb-mail-outbox' });
  const note = h('div', { class: 'sb-note warn', hidden: true });
  const addBtn = h('button', { class: 'sb-add', id: 'sb-add-mail', onclick: () => accountForm(null) });
  const body = h('div', { class: 'sb-panel-body' }, note, list, addBtn, outboxHead, outboxList);
  const field = (label, input, hint) => h('label', { class: 'sb-field' }, h('span', { class: 'sb-field-label' }, label), input, hint ? h('span', { class: 'sb-field-hint' }, hint) : null);
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

  function draw() {
    const pending = drafts.filter((d) => d.status === 'pending').length;
    head.textContent = pending ? `${t('mail.title')} (${pending})` : t('mail.title');
    addBtn.textContent = t('mail.add');
    note.textContent = encryption ? '' : t('mail.noKeychain');
    note.hidden = encryption;
    list.replaceChildren(...(accounts.length ? accounts.map((a) => h('li', { class: 'sb-proj sb-mail-row', title: a.address },
      h('span', { class: `sb-dot${a.hasSecret ? ' live' : ''}`, title: a.hasSecret ? t('mail.signedIn') : t('mail.noSecret') }),
      h('span', { class: 'sb-name' }, a.label),
      h('span', { class: 'sb-icons' },
        h('button', { class: 'sb-x', title: t('mail.test'), onclick: (e) => { e.stopPropagation(); test(a, e.currentTarget); } }, '✓'),
        a.provider === 'm365' ? null : h('button', { class: 'sb-x sb-gear', title: t('mail.edit'), onclick: (e) => { e.stopPropagation(); accountForm(a); } }, '⚙'),
        h('button', { class: 'sb-x', title: t('mail.remove'), onclick: (e) => { e.stopPropagation(); remove(a); } }, '×')),
      h('div', { class: 'sb-staff-where' }, `${t(`mail.provider.${a.provider}`)} · ${a.address}`)))
      : [h('li', { class: 'sb-staff-empty' }, t('mail.empty'))]));
    const shown = drafts.filter((d) => d.status === 'pending' || d.status === 'failed').slice(0, 20);
    outboxHead.textContent = t('mail.outbox', { n: pending });
    outboxHead.hidden = !accounts.length && !shown.length;
    outboxList.replaceChildren(...shown.map((d) => h('li', { class: `sb-proj sb-draft ${d.status}`, onclick: () => review(d) },
      h('span', { class: 'sb-dot', title: t(`mail.status.${d.status}`) }),
      h('span', { class: 'sb-name' }, d.subject),
      d.warnings?.length ? h('span', { class: 'sb-icons sb-draft-warn', title: d.warnings.map((w) => t(`mail.warn.${w}`)).join('\n') }, '⚠') : null,
      h('div', { class: 'sb-staff-where' }, `→ ${d.to.join(', ')} · ${d.staffName} · ${when(d.createdAt)}`))));
  }

  async function test(a, btn) {
    btn.textContent = '…';
    const r = await api.test(a.id).catch(() => ({ ok: false, error: 'failed' }));
    btn.textContent = r?.ok ? '✓' : '!';
    btn.title = r?.ok ? t('mail.testOk') : failureText(r);
    if (!r?.ok) alert(failureText(r));
  }
  async function remove(a) {
    if (!confirm(t('mail.removeConfirm', { name: a.label }))) return;
    await api.remove(a.id).catch(() => null);
  }

  /** A failure as the person reads it: what went wrong, on which side, and the server's own words. */
  const failureText = (r) => [
    t(`mail.error.${r?.error || 'failed'}`),
    r?.where ? t('mail.where', { where: r.where.toUpperCase() }) : '',
    r?.detail ? t('mail.serverSaid', { text: r.detail }) : '',
  ].filter(Boolean).join(' ');

  /**
   * Add (a null) or edit a Gmail / Exchange / IMAP account: tested (IMAP and SMTP log in, nothing is sent) and saved
   * only when it worked. A certificate the system does not trust is shown with its fingerprint; the person may trust
   * it for this server. Microsoft 365 signs in through its own steps.
   */
  function accountForm(a) {
    const provider = h('select', { class: 'sb-acct', disabled: Boolean(a) }, ...PROVIDERS.map((p) => h('option', { value: p, selected: a?.provider === p }, t(`mail.provider.${p}`))));
    const label = h('input', { class: 'sb-input', maxLength: 40, value: a?.label || '', placeholder: t('mail.labelPh') });
    const address = h('input', { class: 'sb-input', type: 'email', maxLength: 254, value: a?.address || '', placeholder: 'ad@sirket.com' });
    const user = h('input', { class: 'sb-input', maxLength: 200, value: a && a.user !== a.address ? a.user || '' : '', placeholder: t('mail.userPh') });
    const password = h('input', { class: 'sb-input', type: 'password', autocomplete: 'off', placeholder: a?.hasSecret ? t('mail.passwordKeep') : '' });
    const server = h('input', { class: 'sb-input', value: a?.provider === 'exchange' ? a.imap?.host || '' : '', placeholder: 'mail.sirket.com', spellcheck: false });
    const imapHost = h('input', { class: 'sb-input', value: a?.imap?.host || '', placeholder: 'imap.sirket.com', spellcheck: false });
    const imapPort = h('input', { class: 'sb-input sb-port', type: 'number', value: String(a?.imap?.port || 993) });
    const smtpHost = h('input', { class: 'sb-input', value: a?.smtp?.host || '', placeholder: 'smtp.sirket.com', spellcheck: false });
    const smtpPort = h('input', { class: 'sb-input sb-port', type: 'number', value: String(a?.smtp?.port || (a?.provider === 'imap' ? 465 : 587)) });
    const smtpSec = h('select', { class: 'sb-acct' }, h('option', { value: 'starttls', selected: (a?.smtp?.security || 'starttls') === 'starttls' }, 'STARTTLS (587)'), h('option', { value: 'tls', selected: a?.smtp?.security === 'tls' }, 'SSL/TLS (465)'));
    const clientId = h('input', { class: 'sb-input', maxLength: 36, placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: false });
    const tenant = h('input', { class: 'sb-input', maxLength: 100, value: 'common', spellcheck: false });
    const help = h('div', { class: 'sb-note' });
    const codeBox = h('div', { class: 'sb-note sb-mail-code', hidden: true });
    const status = h('div', { class: 'sb-field-hint', hidden: true });
    const err = h('div', { class: 'sb-note warn', hidden: true });
    const certBox = h('div', { class: 'sb-note sb-mail-cert', hidden: true });
    /** fingerprints the person chose to trust in this form, by side */
    const trust = {};
    // Exchange: one server; the ports sit under "Advanced"
    const serverField = field(t('mail.server'), server, t('mail.serverHint'));
    const userField = field(t('mail.user'), user, t('mail.userHint'));
    const advanced = h('details', { class: 'sb-mail-advanced' }, h('summary', {}, t('mail.advanced')));
    const imapRow = field(t('mail.imap'), h('div', { class: 'sb-field-row' }, imapHost, imapPort));
    const smtpRow = field(t('mail.smtp'), h('div', { class: 'sb-field-row' }, smtpHost, smtpPort));
    const secRow = field(t('mail.smtpSecurity'), smtpSec);
    const pwField = field(t('mail.password'), password, t('mail.passwordHint'));
    const m365Fields = [field(t('mail.clientId'), clientId, t('mail.clientIdHint')), field(t('mail.tenant'), tenant, t('mail.tenantHint'))];
    const addrField = field(t('mail.address'), address);
    const sync = () => {
      const p = provider.value;
      const exchange = p === 'exchange';
      serverField.hidden = !exchange;
      userField.hidden = !(exchange || p === 'imap');
      // IMAP: the hosts in the open; Exchange: only the ports, folded
      advanced.hidden = !(exchange || p === 'imap');
      advanced.open = p === 'imap';
      imapHost.hidden = exchange;
      smtpHost.hidden = exchange;
      for (const f of m365Fields) f.hidden = p !== 'm365';
      pwField.hidden = p === 'm365';
      addrField.hidden = p === 'm365';
      help.textContent = t(`mail.help.${p}`);
      save.textContent = p === 'm365' ? t('mail.signIn') : t('mail.testSave');
    };
    advanced.append(imapRow, smtpRow, secRow);
    provider.addEventListener('change', () => {
      if (provider.value === 'imap' && smtpPort.value === '587' && !a) { smtpPort.value = '465'; smtpSec.value = 'tls'; }
      if (provider.value === 'exchange' && !a) { smtpPort.value = '587'; smtpSec.value = 'starttls'; imapPort.value = '993'; }
      sync();
    });
    // the usual Exchange name as a hint, never filled in for the person
    address.addEventListener('input', () => { const d = address.value.split('@')[1]; server.placeholder = d && d.includes('.') ? `mail.${d}` : 'mail.sirket.com'; });
    let off = null;
    const keepPin = (side, host) => (a?.[side]?.pin && a[side].host === host ? { pin: a[side].pin } : {});
    const formOf = () => {
      const p = provider.value;
      const ih = p === 'exchange' ? server.value.trim() : imapHost.value.trim();
      const sh = p === 'exchange' ? server.value.trim() : smtpHost.value.trim();
      return {
        ...(a ? { id: a.id } : {}), provider: p, label: label.value, address: address.value.trim(), password: password.value, trust,
        ...(p === 'exchange' || p === 'imap' ? {
          user: user.value.trim(),
          imap: { host: ih, port: Number(imapPort.value), ...keepPin('imap', ih) },
          smtp: { host: sh, port: Number(smtpPort.value), security: smtpSec.value, ...keepPin('smtp', sh) },
        } : {}),
      };
    };
    async function submit() {
      err.hidden = true;
      certBox.hidden = true;
      save.disabled = true;
      if (provider.value === 'm365') {
        const r = await api.m365Start({ clientId: clientId.value.trim(), tenant: tenant.value.trim() || 'common', label: label.value }).catch(() => ({ ok: false, error: 'failed' }));
        save.disabled = false;
        if (!r?.ok) { err.textContent = failureText(r); err.hidden = false; return; }
        codeBox.replaceChildren(h('div', {}, t('mail.codeStep', { url: r.verificationUri })), h('div', { class: 'sb-mail-usercode' }, r.userCode), h('div', { class: 'sb-field-hint' }, t('mail.codeWait')));
        codeBox.hidden = false;
        save.disabled = true;
        off?.();
        off = api.onM365((res) => {
          off?.(); off = null;
          if (res?.ok) { c.closeModal(); return; }
          save.disabled = false;
          codeBox.hidden = true;
          err.textContent = failureText(res);
          err.hidden = false;
        });
        return;
      }
      status.textContent = t('mail.testing');
      status.hidden = false;
      const r = await api.save(formOf()).catch(() => ({ ok: false, error: 'failed' }));
      status.hidden = true;
      save.disabled = false;
      if (r?.ok) { password.value = ''; c.closeModal(); return; }
      err.textContent = failureText(r);
      err.hidden = false;
      if (r?.error === 'cert' && r.cert && (r.where === 'imap' || r.where === 'smtp')) {
        const side = r.where;
        certBox.replaceChildren(
          h('div', {}, t('mail.certIntro', { where: side.toUpperCase() })),
          h('div', { class: 'sb-mail-certrow' }, `${t('mail.certSubject')}: ${r.cert.subject || '—'}`),
          h('div', { class: 'sb-mail-certrow' }, `${t('mail.certIssuer')}: ${r.cert.issuer || '—'}`),
          r.cert.altNames ? h('div', { class: 'sb-mail-certrow' }, `${t('mail.certNames')}: ${r.cert.altNames}`) : null,
          h('div', { class: 'sb-mail-certrow' }, `${t('mail.certValid')}: ${r.cert.validTo}`),
          h('div', { class: 'sb-mail-certrow sb-mail-fp' }, `SHA-256: ${r.cert.fingerprint}`),
          h('div', { class: 'sb-field-hint' }, t('mail.certHint')),
          h('button', { class: 'sb-btn', onclick: (e) => { e.preventDefault(); trust[side] = r.cert.fingerprint; submit(); } }, t('mail.certTrust')));
        certBox.hidden = false;
      }
    }
    const save = h('button', { class: 'sb-btn primary', onclick: () => submit() });
    const cancel = h('button', { class: 'sb-btn', onclick: () => { off?.(); if (provider.value === 'm365') api.m365Cancel?.(); c.closeModal(); } }, t('sidebar.cancel'));
    c.openModal(a ? t('mail.editTitle', { name: a.label }) : t('mail.addTitle'), [
      field(t('mail.providerLabel'), provider), help, field(t('mail.label'), label), addrField, serverField, userField, pwField, advanced, ...m365Fields, codeBox,
      h('div', { class: 'sb-field-hint' }, t('mail.safety')), status, err, certBox,
    ], [cancel, save], 'sb-modal-form');
    sync();
  }

  /** A draft, whole: the person reads it, may change it, and sends or discards it. */
  function review(d) {
    const to = h('input', { class: 'sb-input', value: d.to.join(', ') });
    const cc = h('input', { class: 'sb-input', value: d.cc.join(', ') });
    const subject = h('input', { class: 'sb-input', maxLength: 300, value: d.subject });
    const text = h('textarea', { rows: 14, class: 'sb-brief sb-mail-body', maxLength: 20000 });
    text.value = d.body;
    const editable = d.status === 'pending';
    for (const x of [to, cc, subject, text]) x.disabled = !editable;
    const err = h('div', { class: 'sb-note warn', hidden: true });
    const acct = accounts.find((a) => a.id === d.account);
    const form = () => ({ to: to.value, cc: cc.value, subject: subject.value, body: text.value });
    const changed = () => to.value !== d.to.join(', ') || cc.value !== d.cc.join(', ') || subject.value !== d.subject || text.value !== d.body;
    const fail = (e) => { err.textContent = t(`mail.error.${e || 'failed'}`); err.hidden = false; };
    const sendBtn = h('button', {
      class: 'sb-btn primary', onclick: async () => {
        err.hidden = true;
        if (changed()) { const r = await api.edit(d.id, form()).catch(() => ({ ok: false })); if (!r?.ok) return fail(r?.error); d = r.draft; }
        const n = d.to.length + d.cc.length;
        if (!confirm(t('mail.sendConfirm', { n, from: d.from, subject: d.subject }))) return;
        sendBtn.disabled = true;
        sendBtn.textContent = t('mail.sending');
        const r = await api.send(d.id).catch(() => ({ ok: false, error: 'failed' }));
        if (r?.ok) { c.closeModal(); return; }
        sendBtn.disabled = false;
        sendBtn.textContent = t('mail.send');
        err.textContent = failureText(r);
        err.hidden = false;
      },
    }, t('mail.send'));
    const discard = h('button', { class: 'sb-btn sb-warn', onclick: async () => { if (!confirm(t('mail.discardConfirm'))) return; const r = await api.discard(d.id).catch(() => null); if (r?.ok) c.closeModal(); } }, t('mail.discard'));
    const retry = h('button', { class: 'sb-btn', onclick: async () => { const r = await api.retry(d.id).catch(() => null); if (r?.ok) c.closeModal(); } }, t('mail.retry'));
    c.openModal(t('mail.reviewTitle'), [
      h('div', { class: 'sb-note' }, t('mail.reviewIntro', { name: d.staffName, project: d.projectName, when: when(d.createdAt) })),
      d.warnings?.length ? h('ul', { class: 'sb-mail-warnings' }, ...d.warnings.map((w) => h('li', {}, `⚠ ${t(`mail.warn.${w}`)}`))) : null,
      d.replyTo ? h('div', { class: 'sb-field-hint' }, t('mail.replyTo', { from: d.replyTo.from, subject: d.replyTo.subject })) : null,
      d.replyTo?.flags?.length ? h('div', { class: 'sb-note warn' }, t('mail.sourceFlags', { flags: d.replyTo.flags.map((f) => t(`mail.flag.${f}`)).join(', ') })) : null,
      field(t('mail.from'), h('div', { class: 'sb-mail-from' }, acct ? `${acct.label} <${d.from}>` : d.from)),
      field(t('mail.to'), to), field(t('mail.cc'), cc), field(t('mail.subject'), subject), field(t('mail.body'), text),
      d.status === 'failed' ? h('div', { class: 'sb-note warn' }, failureText({ error: d.error, detail: d.detail })) : null,
      err,
    ], [
      editable || d.status === 'failed' ? discard : null,
      h('button', { class: 'sb-btn', onclick: () => c.closeModal() }, t('sidebar.close')),
      d.status === 'failed' ? retry : null,
      editable ? sendBtn : null,
    ], 'sb-modal-form sb-mail-review');
  }

  return {
    head, body,
    setAccounts(v) { accounts = Array.isArray(v?.accounts) ? v.accounts : []; encryption = v?.encryption !== false; draw(); },
    setOutbox(v) { drafts = Array.isArray(v?.drafts) ? v.drafts : []; draw(); },
    /** For the member popup: [{ id, label, address }]. */
    accounts: () => accounts.map((a) => ({ id: a.id, label: a.label, address: a.address })),
    redraw: draw,
  };
}
