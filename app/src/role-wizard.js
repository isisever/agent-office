// Team: the role wizard (contract v3.82): pure logic, no Electron; tested in test/role-wizard.test.cjs.
// The person describes a job in their own words; main runs one non-interactive Claude Code turn per message
// (`claude -p`, no tools, no MCP, no session kept, the Default account) with the system prompt below and the whole
// conversation so far on stdin, and gets back JSON: a short message, the questions still open and, once the job is
// clear, the role (name, short, department, description, instructions, writes code, skill packs, MCP tools). Nothing
// here reads a token or a project; the conversation lives in the renderer until the person saves the role.
const { DEPARTMENTS } = require('./staff.js');

const MAX_MESSAGES = 24;
const MESSAGE_MAX = 4000;
const NAME_MAX = 40;
const DESC_MAX = 400;
const BRIEF_MAX = 4000;

// eslint-disable-next-line no-control-regex
const line = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// eslint-disable-next-line no-control-regex
const block = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

/** The structured output Claude Code is asked for (`--json-schema`; the system prompt repeats it for Windows). */
const SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    role: {
      type: 'object',
      properties: {
        name: { type: 'string' }, short: { type: 'string' }, department: { type: 'string', enum: DEPARTMENTS },
        description: { type: 'string' }, brief: { type: 'string' }, writesCode: { type: 'boolean' },
        skillPacks: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'department', 'description', 'brief', 'writesCode'],
    },
  },
  required: ['say', 'questions'],
};

const LANG_NAMES = { tr: 'Turkish', en: 'English' };

/**
 * The wizard's instructions.
 * @param {{ lang: string, roles: { id: string, name: string, department?: string, description: string }[], packs: { id: string, name: string }[], tools: string[] }} c
 */
function systemPrompt({ lang, roles, packs, tools }) {
  const language = LANG_NAMES[lang] || 'the language the person writes in';
  return `You are the role wizard of Agent Office. In Agent Office a person runs a team of AI staff members: each member is a Claude Code session with a role (its instructions) that works in the person's project folders and gets tasks from the person or from HQ, the team's manager. The person describes a job they need done; you analyse it, ask what is missing, and write the role.

How to work:
1. Read what the person wrote. A role is clear enough when you know what the member produces, for whom and how often, which systems or tools it uses, what it must never do on its own, and which other team roles it hands work to. If something important is missing, ask at most 3 short questions per turn, the most important first, offering concrete choices when that helps. Ask in at most two rounds; after that make reasonable assumptions and name them in "say". Never ask what you can sensibly assume.
2. If an existing role already fits, say so in "say" (by its name) and ask whether the person still wants a separate one.
3. When you write the role, return all of its fields; after that the person may ask for changes: return the whole updated role each time.

Role fields:
- name: the job title in ${language}, at most ${NAME_MAX} characters.
- short: a label of at most 7 letters in ${language}, upper case, for the member's desk plate.
- department: the company function it belongs to, one of: management, marketing, sales, operations, hr, finance, rnd (research and development, software and IT).
- description: one or two sentences in ${language}, at most 300 characters: what the member does.
- brief: the member's instructions, in English (the model follows English best), written to the member in the second person ("You are the team's …"), 120 to 260 words: what it produces and in what form, how it works step by step, its quality bar, where its outputs go (files in the project unless a request says otherwise), what it never does without the person (sending, publishing, paying, signing, deleting, changing live systems), how it treats personal and company data, which team roles it hands work to, and what its report at the end of a task says.
- writesCode: true only when the job changes code, configuration or data in the project; false for roles that produce documents, designs or plans.
- skillPacks: ids from the skill pack list below that help this job (may be empty).
- tools: names of MCP servers the role should use: ones from the list below, or a well-known service the person names (for example "canva", "notion", "slack"), lower case. Empty when none.

Existing roles (id: name — department — description):
${roles.map((r) => `- ${r.id}: ${r.name} — ${r.department || 'none'} — ${r.description}`).join('\n') || '- none'}

Skill packs (id: name): ${packs.map((p) => `${p.id}: ${p.name}`).join(', ') || 'none'}
MCP servers added in Agent Office: ${tools.join(', ') || 'none'}

Reply with one JSON object only, no other text: {"say": your message to the person in ${language} (short and friendly), "questions": the questions still open in ${language} ([] when none), "role": the role object, only when you write it}.`;
}

/** The conversation for stdin: the person's and the wizard's messages, oldest first (the newest MAX_MESSAGES). */
function transcript(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.who === 'user' || m.who === 'wizard') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_MESSAGES);
  if (!list.length || list[list.length - 1].who !== 'user') return '';
  return list.map((m) => `${m.who === 'user' ? 'Person' : 'Wizard'}: ${block(m.text, MESSAGE_MAX)}`).join('\n\n')
    + '\n\nAnswer the person\'s last message as the role wizard, with the JSON object only.';
}

/** The first JSON object in a text (a code fence or words around it are tolerated), or null. */
function firstObject(text) {
  if (typeof text !== 'string') return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { const o = JSON.parse(text.slice(s, e + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

/**
 * The role in a reply, cleaned: unknown departments and packs dropped, tool names made plain; null without a name
 * or instructions. @param {any} raw @param {string[]} packIds
 */
function cleanRole(raw, packIds = []) {
  if (!raw || typeof raw !== 'object') return null;
  const name = line(raw.name, NAME_MAX);
  const brief = block(raw.brief, BRIEF_MAX);
  if (!name || !brief) return null;
  const department = DEPARTMENTS.includes(raw.department) ? raw.department : '';
  const list = (v, ok) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(ok))].slice(0, 12);
  return {
    name, short: [...line(raw.short, 7)].slice(0, 7).join(''), ...(department ? { department } : {}),
    description: line(raw.description, DESC_MAX), brief, writesCode: raw.writesCode === true,
    skillPacks: list(raw.skillPacks, (x) => packIds.includes(x)), tools: list(raw.tools, (x) => /^[a-z0-9][a-z0-9_-]{0,47}$/.test(x)),
  };
}

/**
 * Claude Code's `--output-format json` output → { say, questions, role } | { error: 'failed' }. The structured output
 * when there is one, else the JSON in the result text, else the text itself as the message.
 */
function parseReply(stdout, packIds = []) {
  const out = firstObject(stdout);
  if (!out || out.is_error === true || (out.type === 'result' && out.subtype && out.subtype !== 'success')) return { error: 'failed' };
  const data = out.structured_output && typeof out.structured_output === 'object' ? out.structured_output : firstObject(out.result);
  if (!data) {
    const say = block(out.result, 2000);
    return say ? { say, questions: [], role: null } : { error: 'failed' };
  }
  const questions = (Array.isArray(data.questions) ? data.questions : []).map((q) => line(q, 300)).filter(Boolean).slice(0, 5);
  const role = cleanRole(data.role, packIds);
  const say = block(data.say, 2000);
  if (!say && !questions.length && !role) return { error: 'failed' };
  return { say, questions, role };
}

module.exports = { SCHEMA, MAX_MESSAGES, systemPrompt, transcript, firstObject, cleanRole, parseReply };
