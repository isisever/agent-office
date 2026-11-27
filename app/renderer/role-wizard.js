// Team: the role wizard (contract v3.84). The person describes a job; main asks Claude Code (one `claude -p` turn per
// message, src/role-wizard.js) and the answer comes back as a message, open questions and, once the job is clear, a
// role draft shown as a card. "Save the role" puts it in the person's role library (roles:save); then a member can be
// added with it. The conversation lives only in this popup. In Studio (v3.124, c.studio) the same conversation opens
// as a right-side chat sheet in Studio's look (styles in studio.css, scoped to body.studio .rw-sheet) instead of the
// Office popup, and "Add a member" hands the saved role to Studio's hire sheet (c.addMember).
import { deptLabel } from '../src/staff-view.mjs';

/**
 * @param {{ h: Function, t: Function, lang: string, openModal: Function, closeModal: Function,
 *   ask: (req: any) => Promise<any>, saveRole: (form: any) => Promise<any>, listPacks?: () => Promise<any[]>,
 *   addMember: (roleId: string, role?: any) => void, studio?: boolean }} c
 */
export function openRoleWizard(c) {
  const { h, t } = c;
  /** @type {{ who: 'user' | 'wizard', text: string }[]} */
  const messages = [];
  /** @type {any} */
  let draft = null;
  let saved = null;
  /** @type {Map<string, string>} */
  const packNames = new Map();
  c.listPacks?.().then((packs) => { for (const p of packs || []) packNames.set(p.id, p.name); }).catch(() => {});

  const log = h('div', { class: 'rw-log', role: 'log', 'aria-live': 'polite' });
  const card = h('div', { class: 'rw-card', hidden: true });
  const input = h('textarea', { class: 'rw-input', rows: 3, maxLength: 4000, placeholder: t('staff.wizard.placeholder') });
  const status = h('div', { class: 'sb-field-hint rw-status' });
  const send = c.studio
    ? h('button', { class: 'rw-send', type: 'button', title: t('staff.wizard.send'), 'aria-label': t('staff.wizard.send'), onclick: () => ask() }, '↑')
    : h('button', { class: 'sb-btn primary', onclick: () => ask() }, t('staff.wizard.send'));
  const studio = c.studio ? studioSheet(c) : null;
  const close = () => (studio ? studio.close() : c.closeModal());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); } });

  const bubble = (who, text, questions = []) => h('div', { class: `rw-msg ${who}` },
    h('div', { class: 'rw-who' }, who === 'user' ? t('staff.wizard.you') : t('staff.wizard.name')),
    text ? h('div', { class: 'rw-text' }, text) : null,
    questions.length ? h('ol', { class: 'rw-questions' }, ...questions.map((q) => h('li', {}, q))) : null);
  const scroll = () => requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  log.append(bubble('wizard', t('staff.wizard.intro')));

  /** The draft as a card: what the member will be, and the save button. */
  function drawCard() {
    card.hidden = !draft;
    if (!draft) return;
    const row = (label, value) => (value ? h('div', { class: 'rw-row' }, h('span', { class: 'rw-label' }, label), h('span', {}, value)) : null);
    const saveBtn = h('button', { class: 'sb-btn primary', onclick: () => saveDraft(saveBtn) }, saved ? t('staff.wizard.saveAgain') : t('staff.wizard.save'));
    card.replaceChildren(
      h('div', { class: 'rw-card-head' }, draft.name, draft.short ? h('span', { class: 'rw-short' }, draft.short) : null),
      row(t('staff.department'), deptLabel(t, draft.department || '')),
      row(t('staff.description'), draft.description),
      row(t('staff.wizard.kind'), draft.writesCode ? t('staff.wizard.writesCode') : t('staff.noCode')),
      row(t('staff.skillPacks'), draft.skillPacks.map((id) => packNames.get(id) || id).join(', ')),
      row(t('staff.tools'), draft.tools.join(', ')),
      h('details', { class: 'rw-brief' }, h('summary', {}, t('staff.brief')), h('pre', {}, draft.brief)),
      h('div', { class: 'rw-card-foot' },
        saved ? h('span', { class: 'sb-field-hint' }, t('staff.wizard.saved', { name: saved.name.en })) : h('span', { class: 'sb-field-hint' }, t('staff.wizard.changeHint')),
        saved ? h('button', { class: 'sb-btn primary', onclick: () => { close(); c.addMember(saved.id, saved); } }, t('staff.wizard.addMember')) : null,
        saveBtn));
  }

  async function saveDraft(btn) {
    if (!draft) return;
    btn.disabled = true;
    const r = await c.saveRole({ ...(saved ? { id: saved.id } : {}), ...draft });
    btn.disabled = false;
    if (!r?.ok) {
      status.textContent = t(`staff.wizard.saveError.${['name', 'brief', 'name-used', 'too-many'].includes(r?.error) ? r.error : 'failed'}`);
      return;
    }
    saved = r.role;
    status.textContent = '';
    drawCard();
  }

  async function ask() {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    messages.push({ who: 'user', text });
    log.append(bubble('user', text));
    input.value = '';
    send.disabled = true;
    input.disabled = true;
    status.textContent = t('staff.wizard.thinking');
    scroll();
    const r = await c.ask({ messages, lang: c.lang });
    send.disabled = false;
    input.disabled = false;
    if (!r?.ok) {
      messages.pop();          // not answered: the person can send it again
      input.value = text;
      log.lastChild?.remove();
      status.textContent = t(`staff.wizard.error.${['busy', 'no-claude', 'timeout'].includes(r?.error) ? r.error : 'failed'}`);
      input.focus();
      return;
    }
    status.textContent = '';
    // the wizard's turn as the next turn's context: its message, its questions and the role it wrote
    const said = [r.say, ...(r.questions || []).map((q, i) => `${i + 1}. ${q}`), r.role ? `[role draft: ${JSON.stringify(r.role)}]` : ''].filter(Boolean).join('\n');
    messages.push({ who: 'wizard', text: said });
    log.append(bubble('wizard', r.say, r.questions || []));
    if (r.role) { draft = r.role; drawCard(); }
    scroll();
    input.focus();
  }

  if (studio) {
    // Studio: the composer is one rounded box with the round send button inside it; the header has the close button
    studio.open([log, card, h('div', { class: 'rw-compose' }, input, send), status]);
    requestAnimationFrame(() => input.focus());
    return;
  }
  c.openModal(t('staff.wizard.title'), [
    log, card,
    h('div', { class: 'rw-compose' }, input),
    status,
  ], [h('button', { class: 'sb-btn', onclick: () => c.closeModal() }, t('sidebar.close')), send], 'sb-modal-form rw-modal');
  requestAnimationFrame(() => input.focus());
}

/**
 * Studio's right-side sheet for the wizard (v3.124): a backdrop and an aside with a quiet "Role wizard" header and a
 * close button; Escape or a click on the backdrop closes it. One at a time.
 * @param {{ h: Function, t: Function }} c
 */
function studioSheet({ h, t }) {
  document.querySelector('.rw-sheet')?.remove();
  document.querySelector('.rw-sheet-back')?.remove();
  const back = h('div', { class: 'rw-sheet-back', onmousedown: () => close() });
  const body = h('div', { class: 'rw-sheet-body' });
  const sheet = h('aside', { class: 'rw-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('staff.wizard.title') },
    h('div', { class: 'rw-sheet-head' }, h('h2', { class: 'rw-sheet-title' }, t('staff.wizard.title')),
      h('button', { class: 'rw-sheet-close', type: 'button', title: t('sidebar.close'), 'aria-label': t('sidebar.close'), onclick: () => close() }, '×')),
    body);
  sheet.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  function close() { sheet.remove(); back.remove(); }
  return {
    open(/** @type {(Node | null)[]} */ kids) { body.replaceChildren(...kids.filter(Boolean)); document.body.append(back, sheet); },
    close,
  };
}
