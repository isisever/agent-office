// Main's pure state logic: node --test test/main.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/projects.js');
const A = require('../src/accounts.js');
const L = require('../src/locales.js');
const UP = require('../src/updates.js');

const LOCALES = L.loadLocales();
/** a language's translator, as in main (src/i18n.mjs) */
const tFor = async (lang) => (await import('../src/i18n.mjs')).translator(LOCALES[lang], LOCALES.en, lang);

let n = 0;
const id = () => `p${++n}`;
const empty = () => P.normalizeState({}, { id });

test('boş durum: yalnız varsayılan hesap, proje yok', () => {
  const s = empty();
  assert.deepEqual(s.projects, []);
  assert.equal(s.activeId, null);
  assert.deepEqual(s.accounts, [{ id: 'default', label: 'Varsayılan', configDir: null }]);
});

test('göç: eski lastProject ilk proje ve etkin olur', () => {
  const s = P.normalizeState({ lastProject: '/a/b/proj' }, { id: () => 'x1' });
  assert.deepEqual(s.projects, [{ id: 'x1', dir: '/a/b/proj', name: 'proj', accountId: 'default' }]);
  assert.equal(s.activeId, 'x1');
});

test('göç: projeler varsa lastProject yok sayılır', () => {
  const s = P.normalizeState({ lastProject: '/old', projects: [{ id: 'k', dir: '/new', accountId: 'default' }], activeId: 'k' });
  assert.deepEqual(s.projects.map((p) => p.dir), ['/new']);
});

test('normalize: bozuk kayıtlar, yinelenen klasör, bilinmeyen hesap ve etkin id düzeltilir', () => {
  const s = P.normalizeState({
    projects: [null, { dir: '' }, { id: 'a', dir: '/x', accountId: 'gone' }, { id: 'b', dir: '/x' }, { dir: '/y', accountId: 'w' }],
    accounts: [{ id: 'default', label: 'eski', configDir: '/z' }, { id: 'w', label: ' İş ', configDir: '/acc/w' }, { id: 'bad' }],
    activeId: 'nope',
  }, { id });
  assert.equal(s.projects.length, 2);
  assert.equal(s.projects[0].accountId, 'default');
  assert.equal(s.projects[1].accountId, 'w');
  assert.ok(s.projects[1].id);
  assert.equal(s.activeId, 'a');
  assert.deepEqual(s.accounts, [A.DEFAULT_ACCOUNT, { id: 'w', label: 'İş', configDir: '/acc/w' }]);
});

test('ekle: yeni klasör eklenir ve etkinleşir; listedeki klasör yalnızca etkinleşir', () => {
  let r = P.addProject(empty(), '/p/one', { id: () => 'one' });
  assert.equal(r.isNew, true);
  assert.equal(r.state.activeId, 'one');
  assert.equal(r.project.name, 'one');
  r = P.addProject(r.state, '/p/two', { id: () => 'two' });
  assert.equal(r.state.activeId, 'two');
  const again = P.addProject(r.state, '/p/one', { id: () => 'dup' });
  assert.equal(again.isNew, false);
  assert.equal(again.project.id, 'one');
  assert.equal(again.state.activeId, 'one');
  assert.equal(again.state.projects.length, 2);
});

test('sil: etkin proje silinince komşusu etkinleşir; sonuncusu silinince null', () => {
  let s = empty();
  for (const d of ['a', 'b', 'c']) s = P.addProject(s, '/' + d, { id: () => d }).state;
  s = P.setActive(s, 'b');
  s = P.removeProject(s, 'b');
  assert.equal(s.activeId, 'c');
  s = P.removeProject(s, 'c');
  assert.equal(s.activeId, 'a');
  s = P.removeProject(s, 'zzz');
  assert.equal(s.projects.length, 1);
  s = P.removeProject(s, 'a');
  assert.equal(s.activeId, null);
});

test('etkinleştir / hesap ata: bilinmeyen id değişiklik yapmaz', () => {
  let s = P.addProject(empty(), '/a', { id: () => 'a' }).state;
  assert.equal(P.setActive(s, 'none'), s);
  assert.equal(P.setProjectAccount(s, 'a', 'none'), s);
  s = A.addAccount(s, 'İş', { id: 'w', root: '/u/accounts' }).state;
  s = P.setProjectAccount(s, 'a', 'w');
  assert.equal(s.projects[0].accountId, 'w');
});

test('hesap ekle / yeniden adlandır: configDir = root/id, varsayılan adlandırılamaz', () => {
  let r = A.addAccount(empty(), '  Kişisel ', { id: 'k1', root: '/u/accounts' });
  assert.deepEqual(r.account, { id: 'k1', label: 'Kişisel', configDir: '/u/accounts/k1' });
  const blank = A.addAccount(r.state, '   ', { id: 'k2', root: '/u/accounts' });
  assert.equal(blank.account.label, 'Hesap 2');
  let s = A.renameAccount(r.state, 'k1', 'Ev');
  assert.equal(s.accounts[1].label, 'Ev');
  assert.equal(A.renameAccount(s, 'default', 'X'), s);
  assert.equal(A.renameAccount(s, 'k1', '  '), s);
});

test('hesap sil: projeleri varsayılana geçer ve yeniden başlatılacaklar döner', () => {
  let s = empty();
  s = A.addAccount(s, 'İş', { id: 'w', root: '/r' }).state;
  for (const d of ['a', 'b', 'c']) s = P.addProject(s, '/' + d, { id: () => d }).state;
  s = P.setProjectAccount(s, 'a', 'w');
  s = P.setProjectAccount(s, 'c', 'w');
  const r = A.removeAccount(s, 'w');
  assert.deepEqual(r.moved, ['a', 'c']);
  assert.ok(r.state.projects.every((p) => p.accountId === 'default'));
  assert.deepEqual(r.state.accounts.map((a) => a.id), ['default']);
  assert.equal(A.removeAccount(r.state, 'default').state, r.state);
  assert.deepEqual(A.removeAccount(r.state, 'nope').moved, []);
});

test('accountOf: bilinmeyen hesap varsayılana düşer', () => {
  const s = A.addAccount(empty(), 'İş', { id: 'w', root: '/r' }).state;
  assert.equal(A.accountOf(s, { accountId: 'w' }).configDir, '/r/w');
  assert.equal(A.accountOf(s, { accountId: 'gone' }).configDir, null);
});

test('ptyEnv: iç içe işaretleri ve üst CLAUDE_CONFIG_DIR atılır, hesabın klasörü verilir', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: '/parent', CLAUDE_EFFORT: 'x', ANTHROPIC_MODEL: 'm' };
  const def = A.ptyEnv(base, null);
  assert.equal(def.PATH, '/bin');
  assert.equal(def.ANTHROPIC_MODEL, 'm');
  assert.equal(def.TERM, 'xterm-256color');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_PID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EFFORT', 'AGENT_OFFICE_CONFIG_DIR']) {
    assert.equal(k in def, false, k);
  }
  const acc = A.ptyEnv(base, '/u/accounts/w');
  assert.equal(acc.CLAUDE_CONFIG_DIR, '/u/accounts/w');
  assert.equal(acc.AGENT_OFFICE_CONFIG_DIR, '/u/accounts/w');
  assert.equal(base.CLAUDE_CONFIG_DIR, '/parent');
});

test('sessionEnv: AGENT_OFFICE_APP her zaman, AGENT_OFFICE_MANAGER yalnız müdür modu açıkken', () => {
  const base = A.ptyEnv({ PATH: '/bin', AGENT_OFFICE_MANAGER: '1' }, null);
  const on = A.sessionEnv(base, { manager: true });
  assert.equal(on.AGENT_OFFICE_APP, '1');
  assert.equal(on.AGENT_OFFICE_MANAGER, '1');
  assert.equal(on.PATH, '/bin');
  assert.equal(A.sessionEnv(base).AGENT_OFFICE_MANAGER, '1'); // varsayılan açık
  const off = A.sessionEnv(base, { manager: false });
  assert.equal(off.AGENT_OFFICE_APP, '1');
  assert.equal('AGENT_OFFICE_MANAGER' in off, false); // uygulamanın kendi ortamından gelse bile
  assert.equal(base.AGENT_OFFICE_MANAGER, '1'); // girdi değişmez
});

test('sessionEnv: müdür modu kapalıyken AGENT_OFFICE_FINISH=1 (bitirme bekçisi), açıkken yok (v3.10)', () => {
  const base = A.ptyEnv({ PATH: '/bin', AGENT_OFFICE_FINISH: '1' }, null);
  const on = A.sessionEnv(base, { manager: true });
  assert.equal(on.AGENT_OFFICE_MANAGER, '1');
  assert.equal('AGENT_OFFICE_FINISH' in on, false);
  const off = A.sessionEnv({ PATH: '/bin', AGENT_OFFICE_MANAGER: '1' }, { manager: false });
  assert.equal('AGENT_OFFICE_MANAGER' in off, false);
  assert.equal(off.AGENT_OFFICE_FINISH, '1');
});

test('proje başına müdür modu: normalizeState, setProjectManager, managerOf (v3.10)', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', manager: false },
      { id: 'b', dir: '/b', manager: true },
      { id: 'c', dir: '/c', manager: 'yes' },
      { id: 'd', dir: '/d' },
    ],
  });
  assert.deepEqual(s.projects.map((p) => p.manager), [false, true, undefined, undefined]);
  assert.equal('manager' in s.projects[2], false); // geçersiz değer yazılmaz
  // global ayar: açık (varsayılan), kapalı
  const of = (st, id) => P.managerOf(st, P.findProject(st, id));
  assert.deepEqual(['a', 'b', 'd'].map((id) => of(s, id)), [false, true, true]);
  assert.deepEqual(['a', 'b', 'd'].map((id) => of({ ...s, manager: false }, id)), [false, true, false]);
  // değiştirmek; aynı değer ya da bilinmeyen proje aynı state'i döndürür
  assert.equal(P.setProjectManager(s, 'a', false), s);
  assert.equal(P.setProjectManager(s, 'zz', true), s);
  assert.equal(P.setProjectManager(s, 'd', null), s);
  s = P.setProjectManager(s, 'd', false);
  assert.equal(of(s, 'd'), false);
  s = P.setProjectManager(s, 'b', null); // genel ayara dönüş: alan silinir
  assert.equal('manager' in P.findProject(s, 'b'), false);
  assert.deepEqual(P.setProjectManager(s, 'a', 'x'), P.setProjectManager(s, 'a', null)); // geçersiz = genel ayar
  // state.json'a yazılıp okununca aynı kalır
  const again = P.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(again.projects.map((p) => p.manager), [false, undefined, undefined, false]);
});

test('proje başına ajan modeli: normalizeState, setProjectAgentModel, agentModelOf (v3.14)', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', agentModel: 'sonnet' },
      { id: 'b', dir: '/b', agentModel: 'haiku' },
      { id: 'c', dir: '/c', agentModel: 'gpt' },
      { id: 'd', dir: '/d' },
    ],
  });
  assert.deepEqual(s.projects.map((p) => P.agentModelOf(p)), ['sonnet', 'haiku', null, null]);
  assert.equal('agentModel' in s.projects[2], false); // bilinmeyen değer yazılmaz (Otomatik)
  assert.equal(P.setProjectAgentModel(s, 'a', 'sonnet'), s);
  assert.equal(P.setProjectAgentModel(s, 'zz', 'opus'), s);
  assert.equal(P.setProjectAgentModel(s, 'd', null), s);
  assert.equal(P.setProjectAgentModel(s, 'd', 'fable'), s); // geçersiz = Otomatik
  s = P.setProjectAgentModel(s, 'd', 'opus');
  assert.equal(P.agentModelOf(P.findProject(s, 'd')), 'opus');
  s = P.setProjectAgentModel(s, 'b', null); // Otomatik'e dönüş: alan silinir
  assert.equal('agentModel' in P.findProject(s, 'b'), false);
  const again = P.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(again.projects.map((p) => p.agentModel), ['sonnet', undefined, undefined, 'opus']);
});

test('sessionEnv: sabitlenmiş ajan modeli CLAUDE_CODE_SUBAGENT_MODEL(+_FORCE) olur; Otomatik kullanıcınınkine dokunmaz (v3.14)', () => {
  const pinned = A.sessionEnv({ PATH: '/bin' }, { agentModel: 'haiku' });
  assert.equal(pinned.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
  assert.equal(pinned.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
  assert.equal(pinned.AGENT_OFFICE_AGENT_MODEL, 'haiku'); // the launch line re-exports it after the rc files
  const auto = A.sessionEnv({ PATH: '/bin', AGENT_OFFICE_AGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }, { agentModel: null });
  assert.equal(auto.AGENT_OFFICE_AGENT_MODEL, undefined);
  assert.equal(auto.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
  assert.equal(auto.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
  assert.equal(A.sessionEnv({ PATH: '/bin' }).AGENT_OFFICE_AGENT_MODEL, undefined);
});

test('proje başına bağlam sınırı: normalizeState, setProjectContextCap, contextCapOf (v3.15)', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', contextCap: 200000 },
      { id: 'b', dir: '/b', contextCap: 400000 },
      { id: 'c', dir: '/c', contextCap: 300000 },
      { id: 'd', dir: '/d', contextCap: '200000' },
      { id: 'e', dir: '/e' },
    ],
  }, { id });
  assert.deepEqual(s.projects.map((p) => P.contextCapOf(p)), [200000, 400000, null, null, null]);
  assert.equal('contextCap' in s.projects[2], false); // unknown values are not written (Auto)
  assert.equal('contextCap' in s.projects[3], false);
  assert.equal(P.setProjectContextCap(s, 'a', 200000), s);
  assert.equal(P.setProjectContextCap(s, 'zz', 400000), s);
  assert.equal(P.setProjectContextCap(s, 'e', null), s);
  assert.equal(P.setProjectContextCap(s, 'e', 123), s); // invalid = Auto
  s = P.setProjectContextCap(s, 'e', 400000);
  assert.equal(P.contextCapOf(P.findProject(s, 'e')), 400000);
  s = P.setProjectContextCap(s, 'b', null); // back to Auto: the field goes
  assert.equal('contextCap' in P.findProject(s, 'b'), false);
  const again = P.normalizeState(JSON.parse(JSON.stringify(s)), { id });
  assert.deepEqual(again.projects.map((p) => p.contextCap), [200000, undefined, undefined, undefined, 400000]);
});

test('sessionEnv: bağlam sınırı CLAUDE_CODE_AUTO_COMPACT_WINDOW olur; Otomatik kullanıcınınkine dokunmaz (v3.15)', () => {
  const capped = A.sessionEnv({ PATH: '/bin' }, { contextCap: 200000 });
  assert.equal(capped.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000'); // plain tokens: Claude Code reads no "200k"
  assert.equal(capped.AGENT_OFFICE_CONTEXT_CAP, '200000'); // the launch line re-exports it after the rc files
  const auto = A.sessionEnv({ PATH: '/bin', AGENT_OFFICE_CONTEXT_CAP: '400000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, { contextCap: null });
  assert.equal(auto.AGENT_OFFICE_CONTEXT_CAP, undefined);
  assert.equal(auto.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500000');
  assert.equal(A.sessionEnv({ PATH: '/bin' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  const both = A.sessionEnv({ PATH: '/bin' }, { agentModel: 'sonnet', contextCap: 400000 });
  assert.equal(both.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
  assert.equal(both.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
});

test('proje başına tasarruf: normalizeState, setProjectSavings, savingsOf; Normal yazılmaz (v3.20)', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', savings: 'off' },
      { id: 'b', dir: '/b', savings: 'strict' },
      { id: 'c', dir: '/c', savings: 'normal' },
      { id: 'd', dir: '/d', savings: 'max' },
      { id: 'e', dir: '/e' },
    ],
  }, { id });
  assert.deepEqual(s.projects.map((p) => P.savingsOf(p)), ['off', 'strict', 'normal', 'normal', 'normal']);
  assert.deepEqual(s.projects.map((p) => p.savings), ['off', 'strict', undefined, undefined, undefined]);
  assert.equal(P.setProjectSavings(s, 'e', 'normal'), s);
  assert.equal(P.setProjectSavings(s, 'e', null), s);
  assert.equal(P.setProjectSavings(s, 'zz', 'off'), s);
  s = P.setProjectSavings(s, 'e', 'strict');
  assert.equal(P.findProject(s, 'e').savings, 'strict');
  s = P.setProjectSavings(s, 'a', 'normal'); // back to the default: the field goes
  assert.equal('savings' in P.findProject(s, 'a'), false);
});

test('sessionEnv: tasarruf seviyesi başına ortam; Kapalı kullanıcınınkine dokunmaz (v3.20)', () => {
  const SAVINGS_VARS = ['AGENT_OFFICE_STEP_BUDGET', 'AGENT_OFFICE_STEP_CAP', 'AGENT_OFFICE_BASH_OUTPUT', 'AGENT_OFFICE_MCP_OUTPUT',
    'BASH_MAX_OUTPUT_LENGTH', 'MAX_MCP_OUTPUT_TOKENS'];
  const pick = (env) => SAVINGS_VARS.map((k) => env[k]);
  assert.deepEqual(pick(A.sessionEnv({ PATH: '/bin' }, { savings: 'normal' })), ['40', undefined, '15000', '15000', '15000', '15000']);
  assert.deepEqual(pick(A.sessionEnv({ PATH: '/bin' }, { savings: 'strict' })), ['25', '1', '8000', '8000', '8000', '8000']);
  assert.deepEqual(pick(A.sessionEnv({ PATH: '/bin' })), pick(A.sessionEnv({ PATH: '/bin' }, { savings: 'normal' }))); // default Normal
  assert.deepEqual(pick(A.sessionEnv({ PATH: '/bin' }, { savings: 'bogus' })), ['40', undefined, '15000', '15000', '15000', '15000']);
  // Off: the app's own carriers go (a tab started from a Strict one), the user's own caps stay
  const user = { PATH: '/bin', AGENT_OFFICE_STEP_BUDGET: '25', AGENT_OFFICE_STEP_CAP: '1', AGENT_OFFICE_BASH_OUTPUT: '8000',
    AGENT_OFFICE_MCP_OUTPUT: '8000', BASH_MAX_OUTPUT_LENGTH: '50000', MAX_MCP_OUTPUT_TOKENS: '30000' };
  assert.deepEqual(pick(A.sessionEnv(user, { savings: 'off' })), [undefined, undefined, undefined, undefined, '50000', '30000']);
  // Normal after Strict: no cap left behind
  assert.equal(A.sessionEnv(user, { savings: 'normal' }).AGENT_OFFICE_STEP_CAP, undefined);
  // the values live in one table
  assert.deepEqual(Object.keys(A.SAVINGS), ['off', 'normal', 'strict']);
  assert.equal(A.SAVINGS_DEFAULT, 'normal');
});

test('proje başına motor: normalizeState, setProjectEngine, engineOf (v3.22)', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', engine: 'agy' },
      { id: 'b', dir: '/b', engine: 'claude' },
      { id: 'c', dir: '/c', engine: 'gemini' },
      { id: 'd', dir: '/d' },
    ],
  }, { id });
  assert.deepEqual(s.projects.map((p) => P.engineOf(p)), ['agy', 'claude', 'claude', 'claude']);
  assert.equal('engine' in s.projects[1], false); // Claude Code (the default) is never written
  assert.equal('engine' in s.projects[2], false); // unknown values are dropped
  assert.equal(P.engineOf(null), 'claude');
  assert.deepEqual(P.ENGINES, ['claude', 'agy', 'commandcode', 'opencode']);
  assert.equal(P.setProjectEngine(s, 'a', 'agy'), s);
  assert.equal(P.setProjectEngine(s, 'zz', 'agy'), s);
  assert.equal(P.setProjectEngine(s, 'd', null), s);
  assert.equal(P.setProjectEngine(s, 'd', 'claude'), s); // 'claude' = null
  assert.equal(P.setProjectEngine(s, 'd', 'gemini'), s); // invalid = Claude Code
  s = P.setProjectEngine(s, 'd', 'agy');
  assert.equal(P.engineOf(P.findProject(s, 'd')), 'agy');
  s = P.setProjectEngine(s, 'a', 'claude'); // back to Claude Code: the field goes
  assert.equal('engine' in P.findProject(s, 'a'), false);
  const again = P.normalizeState(JSON.parse(JSON.stringify(s)), { id });
  assert.deepEqual(again.projects.map((p) => p.engine), [undefined, undefined, undefined, 'agy']);
});

test('Command Code motoru (v3.25): engine değerini anar; cmdArgs yalnız --continue ve istem, mod yok', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', engine: 'commandcode' },
      { id: 'b', dir: '/b', engine: 'cmd' }, // unknown: Claude Code
    ],
  }, { id });
  assert.deepEqual(s.projects.map((p) => P.engineOf(p)), ['commandcode', 'claude']);
  assert.equal('engine' in s.projects[1], false);
  s = P.setProjectEngine(s, 'b', 'commandcode');
  assert.equal(P.engineOf(P.findProject(s, 'b')), 'commandcode');
  s = P.setProjectEngine(s, 'a', 'claude'); // back: the field goes
  assert.equal('engine' in P.findProject(s, 'a'), false);

  const EN = require('../src/engine.js');
  assert.deepEqual(EN.cmdArgs(), []); // a fresh start: no arguments (the mod comes only via mod, v3.37)
  assert.deepEqual(EN.cmdArgs({ resume: true }), ['--continue']);
  assert.deepEqual(EN.cmdArgs({ prompt: 'hi' }), []); // the prompt only with a resume
  // promptArg makes it one line, never starting with '-', without cmd.exe's special characters (quotes included)
  assert.deepEqual(EN.cmdArgs({ resume: true, prompt: '  the "login" bug\n  is client-side ' }), ['--continue', 'the login bug is client-side']);
  assert.ok(EN.CMD_COMMAND.endsWith('exec commandcode "$@"'));
  assert.equal(EN.CMD.bin, 'commandcode');
  assert.equal(EN.CMD.home, '.commandcode');
});

test('agy başlatma: --continue yalnız devam ederken, -i istemi yalnız devam ederken; komut satırı (v3.22)', () => {
  const EN = require('../src/engine.js');
  assert.deepEqual(EN.agyArgs(), []);
  assert.deepEqual(EN.agyArgs({ resume: false, prompt: 'carry on' }), []); // a fresh start gets no prompt
  assert.deepEqual(EN.agyArgs({ resume: true }), ['--continue']);
  assert.deepEqual(EN.agyArgs({ resume: true, prompt: '  --carry\non "now"  ' }), ['--continue', '-i', 'carry on now']);
  assert.deepEqual(EN.agyArgs({ resume: true, prompt: '   ' }), ['--continue']); // nothing left of the prompt
  assert.ok(EN.AGY_COMMAND.endsWith('exec agy "$@"')); // arguments via "$@", argv0 'agy'; no CLAUDE_CONFIG_DIR export
  assert.equal(EN.AGY_COMMAND.includes('CLAUDE'), false);
});

// The user's hard rule (v3.22): nothing of Claude Code, Anthropic, the office or MCP reaches agy; its env is an allowlist.
const SECRET_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://proxy',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', CLAUDE_CONFIG_DIR: '/Users/a/Library/Application Support/Agent Office/accounts/x',
  CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', CLAUDECODE: '1', CLAUDE_PID: '42',
  AGENT_OFFICE_DIRECTORY: '/Users/a/Library/Application Support/Agent Office/directory/p.json', AGENT_OFFICE_APP: '1',
  AGENT_OFFICE_CONFIG_DIR: '/x', AGENT_OFFICE_STATUSLINE: 'cmd', AGENT_OFFICE_STEP_BUDGET: '40', AGENT_OFFICE_MANAGER: '1',
  GITHUB_MCP_TOKEN: 'ghp_secret', MCP_SERVER_TOKEN: 'mcp-secret', GOOGLE_MCP_TOKEN: 'g-mcp-secret',
  BASH_MAX_OUTPUT_LENGTH: '15000', MAX_MCP_OUTPUT_TOKENS: '15000', OPENAI_API_KEY: 'sk-openai', AWS_SECRET_ACCESS_KEY: 'aws',
  GH_TOKEN: 'gh', NODE_OPTIONS: '--require /evil.js', ELECTRON_RUN_AS_NODE: '1', npm_config_token: 'npm',
};
const SECRET_VALUES = Object.values(SECRET_ENV).filter((v) => v.length > 2);

test('agy ortamı: izin listesi; Claude, Anthropic, ofis, MCP ve uygulamanın başka hiçbir değişkeni geçmez (v3.22)', () => {
  const EN = require('../src/engine.js');
  const user = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/Users/a', USER: 'a', LOGNAME: 'a', SHELL: '/bin/zsh',
    LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TMPDIR: '/var/folders/x/', TERM: 'dumb',
    GEMINI_API_KEY: 'users-own-gemini', GOOGLE_CLOUD_PROJECT: 'proj' };
  const env = EN.agyEnv({ ...SECRET_ENV, ...user }, 'darwin');
  for (const k of Object.keys(SECRET_ENV)) assert.equal(k in env, false, `${k} reached agy`);
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|AGENT_OFFICE|MCP/i);
  const values = JSON.stringify(env);
  for (const v of SECRET_VALUES) assert.equal(values.includes(v), false, `a secret value reached agy: ${v}`);
  assert.equal(env.PATH, user.PATH);
  assert.equal(env.HOME, '/Users/a');
  assert.equal(env.LC_ALL, 'tr_TR.UTF-8');
  assert.equal(env.GEMINI_API_KEY, 'users-own-gemini'); // the user's own Google / Gemini settings, only when present
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'proj');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.deepEqual(Object.keys(EN.agyEnv({ PATH: '/bin', HOME: '/h' }, 'linux')).sort(), ['COLORTERM', 'HOME', 'PATH', 'TERM']);
  // Windows: its system variables, compared without case; the same secrets stay out
  const winUser = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a', LOCALAPPDATA: 'C:\\l', USERPROFILE: 'C:\\u',
    PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe', 'ProgramFiles(x86)': 'C:\\pf86', ProgramFiles: 'C:\\pf', TEMP: 'C:\\t' };
  const w = EN.agyEnv({ ...SECRET_ENV, claude_code_oauth_token: 'lower-secret', Agent_Office_Directory: 'x-secret', ...winUser }, 'win32');
  for (const k of Object.keys(winUser)) assert.equal(w[k], winUser[k], k);
  for (const k of Object.keys(w)) assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|AGENT_OFFICE|MCP/i);
  assert.equal(JSON.stringify(w).includes('secret'), false);
  // Windows-only names are not passed on macOS / Linux
  assert.equal('ComSpec' in EN.agyEnv(winUser, 'darwin'), false);
});

test('startAgy: ortam yalnız agyEnv; sessionEnv, ptyEnv, ofis dizini, eklenti ve MCP dosyası yok (v3.22)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf('function startAgy(');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n}\n', start)).replace(/\/\/.*$/gm, ''); // code only, no comments
  assert.match(body, /const env = EN\.agyEnv\(process\.env\);/);
  for (const banned of ['sessionEnv', 'ptyEnv', 'officeDirectoryFile', 'sharedConfig', 'pluginDir', 'usageStatusLine', 'AGENT_OFFICE_', 'CLAUDE_', 'env.', 'env[']) {
    assert.equal(body.includes(banned), false, `startAgy uses ${banned}`);
  }
});

test('agy başlatma satırı: rc dosyasının koyduğu AGENT_OFFICE_* gider, kullanıcınınki kalır; argv yalnız agy argümanları (v3.22)', { skip: process.platform === 'win32' }, () => {
  const EN = require('../src/engine.js');
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-agy-'));
  try {
    fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\nprintf "%s\\n" "$@"\necho ---\nenv\n', { mode: 0o755 });
    const env = EN.agyEnv({ ...SECRET_ENV, PATH: `${bin}:/usr/bin:/bin`, HOME: bin }, process.platform);
    // what a login shell's rc file might do: an office variable and a user's own variable
    const rc = 'export AGENT_OFFICE_DIRECTORY=/rc/dir AGENT_OFFICE_X=1 USERS_OWN=kept; ';
    const r = spawnSync('/bin/sh', ['-c', rc + EN.AGY_COMMAND, 'agy', ...EN.agyArgs({ resume: true, prompt: 'carry on' })], { env, encoding: 'utf8', cwd: bin });
    assert.equal(r.status, 0, r.stderr);
    const [argv, out] = r.stdout.split('---\n');
    assert.deepEqual(argv.trim().split('\n'), ['--continue', '-i', 'carry on']);
    assert.doesNotMatch(out, /^(ANTHROPIC|CLAUDE|AGENT_OFFICE)/m);
    assert.match(out, /^USERS_OWN=kept$/m);
    for (const v of SECRET_VALUES) assert.equal(out.includes(v), false, v);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

// v3.25: Command Code gets the same allowlist treatment as agy (the user's hard rule: no leaks to third-party CLIs).
test('Command Code ortamı: izin listesi; Claude, Anthropic, ofis, MCP, Savings geçmez; yalnız belgelenmiş kendi değişkenleri (v3.25)', () => {
  const EN = require('../src/engine.js');
  const user = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/Users/a', USER: 'a', SHELL: '/bin/zsh', LANG: 'tr_TR.UTF-8',
    LC_ALL: 'tr_TR.UTF-8', TMPDIR: '/var/folders/x/', COMMAND_CODE_API_KEY: 'users-own-cc-key', CMD_ZDR: '1',
    COMMANDCODE_SKIP_UPDATES: '1', DO_NOT_TRACK: '1', GEMINI_API_KEY: 'gem', AGY_ADC_AUTH: 'true', CMD_OTHER: 'x' };
  const env = EN.cmdEnv({ ...SECRET_ENV, ...user }, 'darwin');
  for (const k of Object.keys(SECRET_ENV)) assert.equal(k in env, false, `${k} reached Command Code`);
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|AGENT_OFFICE|MCP/i);
  const values = JSON.stringify(env);
  for (const v of SECRET_VALUES) assert.equal(values.includes(v), false, `a secret value reached Command Code: ${v}`);
  assert.equal(env.COMMAND_CODE_API_KEY, 'users-own-cc-key');
  assert.equal(env.CMD_ZDR, '1');
  assert.equal(env.COMMANDCODE_SKIP_UPDATES, '1');
  assert.equal(env.DO_NOT_TRACK, '1');
  for (const k of ['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'CMD_OTHER']) assert.equal(k in env, false, `${k} is not Command Code's`);
  assert.deepEqual(Object.keys(EN.cmdEnv({ PATH: '/bin', HOME: '/h' }, 'linux')).sort(), ['COLORTERM', 'HOME', 'PATH', 'TERM']);
  const winUser = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a', USERPROFILE: 'C:\\u', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' };
  const w = EN.cmdEnv({ ...SECRET_ENV, claude_code_oauth_token: 'lower-secret', Agent_Office_Directory: 'x-secret', agent_office_savings: 'strict-secret', ...winUser }, 'win32');
  for (const k of Object.keys(winUser)) assert.equal(w[k], winUser[k], k);
  for (const k of Object.keys(w)) assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|AGENT_OFFICE|MCP/i);
  assert.equal(JSON.stringify(w).includes('secret'), false);
});

test('startCommandCode: ortam yalnız cmdEnv (+ Savings MCP sınırı); sessionEnv, ptyEnv, ofis dizini, eklenti yok (v3.25, v3.37)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf('function startCommandCode(');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n}\n', start)).replace(/\/\/.*$/gm, '');
  assert.match(body, /const env = EN\.cmdEnv\(process\.env, \{ mcpOutput: saving \? saving\.mcpOutput : null \}\);/);
  for (const banned of ['sessionEnv', 'ptyEnv', 'officeDirectoryFile', 'AGENT_OFFICE_', 'sharedConfig', 'pluginDir', 'usageStatusLine', 'CLAUDE_', 'env.', 'env[', 'journal', 'directory']) {
    assert.equal(body.includes(banned), false, `startCommandCode uses ${banned}`);
  }
  // v3.37: the app's own mod only through cmdModArgs, with a fallback without it
  assert.match(body, /CS\.cmdModArgs\(\{ modPath, spoolDir, manager: P\.managerOf\(state, project\), saving \}\)/);
  assert.match(body, /cmdNoMod\.add\(id\); return startPty\(id/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'plugin', 'mods', 'agent-office.ts')), false);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'cmd-mod', 'agent-office.ts')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build.asarUnpack.includes('src/cmd-mod/**'));
});

test('Command Code v3.37: cmdArgs bağlam sınırı, izin modu, mod; cmdEnv yalnız uygulamanın MCP sınırı', () => {
  const EN = require('../src/engine.js');
  const CS = require('../src/cmd-spool.js');
  assert.deepEqual(EN.cmdArgs({ compact: true }), ['--config', 'compactMode=fast']);
  assert.deepEqual(EN.cmdArgs({ permissionMode: 'plan' }), []); // not supported: ignored
  const mod = CS.cmdModArgs({ modPath: '/app/src/cmd-mod/agent-office.ts', spoolDir: '/ud/cmd-spool/t1', manager: true, saving: { stepBudget: 25, stepCap: true } });
  assert.deepEqual(mod, ['--mod', '/app/src/cmd-mod/agent-office.ts', '--mod-option', 'ao-spool=/ud/cmd-spool/t1', '--mod-option', 'ao-manager=true',
    '--mod-option', 'ao-step-budget=25', '--mod-option', 'ao-step-cap=true']);
  assert.deepEqual(CS.cmdModArgs({ modPath: '/m.ts', spoolDir: '/s', manager: false, saving: null }), ['--mod', '/m.ts', '--mod-option', 'ao-spool=/s']);
  // order: compact, permission, mod, then --continue and the prompt (positional last)
  assert.deepEqual(EN.cmdArgs({ resume: true, prompt: 'go on', compact: true, mod: ['--mod', '/m.ts'] }), ['--config', 'compactMode=fast', '--mod', '/m.ts', '--continue', 'go on']);
  // fallback: no mod → no --mod at all
  assert.equal(EN.cmdArgs({ resume: true, compact: true, mod: [] }).includes('--mod'), false);
  assert.equal(CS.cmdModPath('/A/app.asar'), '/A/app.asar.unpacked/src/cmd-mod/agent-office.ts'.replace(/\//g, require('node:path').sep));
  assert.equal(require('node:path').basename(CS.spoolDirOf('/ud', 'p1:tab/2')), 'p1_tab_2');
  // env: the user's own MCP vars and Claude/Anthropic/office stay out; MAX_MCP_OUTPUT_TOKENS only from the app's value
  const base = { ...SECRET_ENV, PATH: '/bin', HOME: '/h', MAX_MCP_OUTPUT_TOKENS: '999999', MCP_TOOL_TIMEOUT: '1', MY_MCP_TOKEN: 'mcp-secret' };
  const env = EN.cmdEnv(base, { mcpOutput: 8000, platform: 'darwin' });
  assert.equal(env.MAX_MCP_OUTPUT_TOKENS, '8000');
  for (const k of Object.keys(env)) if (k !== 'MAX_MCP_OUTPUT_TOKENS') assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|AGENT_OFFICE|MCP/i);
  for (const v of SECRET_VALUES) assert.equal(JSON.stringify(env).includes(v), false);
  assert.equal('MCP_TOOL_TIMEOUT' in env || 'MY_MCP_TOKEN' in env, false);
  assert.equal('MAX_MCP_OUTPUT_TOKENS' in EN.cmdEnv(base, { mcpOutput: null }, 'darwin'), false); // Savings off: the user's own value is still dropped
  assert.equal('MAX_MCP_OUTPUT_TOKENS' in EN.cmdEnv(base, { mcpOutput: 1e9 }, 'darwin'), false);
  assert.deepEqual(EN.cmdEnv(base, 'linux'), EN.cmdEnv(base, {}, 'linux')); // the v3.25 signature still works
});

test('Command Code v3.37: spool ayrıştırıcı → işçiler, onay, token', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const CS = require('../src/cmd-spool.js');
  const AW = require('../src/agy-watch.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-spool-'));
  try {
    const file = path.join(dir, CS.SPOOL_FILE);
    const t0 = 1_800_000_000_000;
    const L = (o) => JSON.stringify(o) + '\n';
    fs.writeFileSync(file, L({ t: 'subagent_start', id: 'c1', type: 'explore', at: t0 }) + 'not json\n' + L({ t: 'evil', id: 'x', at: t0 })
      + L({ t: 'subagent_progress', id: 'c1', tool: 'read', tokens: 100, at: t0 + 1 }) + L({ t: 'permission', tool: 'bash', at: t0 + 2 }) + '{"t":"turn_end"');
    let r = CS.readSpool(file, null);
    assert.deepEqual(r.events.map((e) => e.t), ['subagent_start', 'subagent_progress', 'permission']);
    const w = AW.createAgyWatch(t0, { engine: 'commandcode', label: 'Command Code' });
    w.spool(r.events, t0 + 3);
    let s = w.session('proj', 'k', t0 + 3);
    assert.equal(s.workers.length, 1);
    assert.equal(s.workers[0].type, 'explore');
    assert.equal(s.workers[0].toolCount, 1);
    assert.equal(s.workers[0].tool, 'read');
    assert.deepEqual(s.stats.waiting, { kind: 'permission', tool: 'bash', since: t0 + 2 });
    assert.equal(s.stats.isBossBusy, true);
    w.input('1', t0 + 4); // the person answers the dialog
    fs.appendFileSync(file, ',"turn":1,"usage":{"inputTokens":300,"outputTokens":50,"evil key":5}}\n' + L({ t: 'subagent_stop', id: 'c1', type: 'explore', tokens: 400, at: t0 + 5 }));
    r = CS.readSpool(file, r.cursor);
    assert.deepEqual(r.events.map((e) => e.t), ['turn_end', 'subagent_stop']);
    assert.deepEqual(r.events[0].usage, { inputTokens: 300, outputTokens: 50 });
    w.spool(r.events, t0 + 6);
    s = w.session('proj', 'k', t0 + 6);
    assert.equal(s.stats.waiting, undefined);
    assert.equal(s.workers[0].doneAt, t0 + 5);
    assert.equal(s.stats.tokens.total, 750);
    assert.ok(s.stats.today.log.some((l) => l.id === 'c1' && l.type === 'explore'));
    assert.equal(w.session('proj', 'k', t0 + 120000).workers.length, 0); // a done worker leaves after a while
    assert.deepEqual(CS.readSpool(path.join(dir, 'missing.jsonl'), null).events, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Command Code modu (v3.37): yalnız spool\'a yazar; yönetici özeti statik; adım bütçesi', async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cmd-mod', 'agent-office.ts'), 'utf8');
  // writes only: no read, no env, no other file API
  for (const banned of ['readFile', 'readdir', 'process.env', 'existsSync', 'createReadStream', 'require(', 'fetch(']) assert.equal(src.includes(banned), false, banned);
  const modUrl = require('node:url').pathToFileURL(path.join(__dirname, '..', 'src', 'cmd-mod', 'agent-office.ts')).href;
  let mod;
  try { mod = await import(modUrl); } catch (e) { if (/Unknown file extension/.test(String(e))) return; throw e; } // node without type stripping: tsc checks it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mod-'));
  try {
    const flags = { 'ao-spool': dir, 'ao-manager': 'true', 'ao-step-budget': '4', 'ao-step-cap': 'true' };
    const h = { on: {}, prompt: [], before: null, perm: null };
    const d = { dispose() {} };
    mod.default({
      addFlag: () => d, getFlag: (n) => flags[n],
      appendSystemPrompt: (f) => { h.prompt.push(f); return d; },
      beforeToolCall: (f) => { h.before = f; return d; },
      onPermissionRequest: (f) => { h.perm = f; return d; },
      on: (ev, f) => { h.on[ev] = f; return d; },
    });
    assert.equal(h.prompt[0]({}), mod.MANAGER_BRIEF);
    assert.doesNotMatch(mod.MANAGER_BRIEF, /\/Users|\\\\|@|directory/i);
    h.on.turn_start({ turnNumber: 1 });
    const res = Array.from({ length: 9 }, () => h.before({ toolName: 'read' }));
    assert.equal(res[2], undefined);
    assert.match(res[3].additionalContext, /Wrap up/);
    assert.equal(res[8].block, true);
    assert.equal(h.perm({ toolName: 'bash', input: { cmd: 'cat secret' }, description: 'secret-desc' }), undefined);
    h.on.subagent_start({ toolCallId: 'c9', subagentType: 'general' });
    h.on.turn_end({ turnNumber: 1, usage: { inputTokens: 5 } });
    const text = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    assert.equal(text.includes('secret'), false);
    const evs = text.trim().split('\n').map((l) => CS_parse(l));
    assert.deepEqual(evs.map((e) => e && e.t), ['cap', 'permission', 'subagent_start', 'turn_end']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const CS_parse = (l) => require('../src/cmd-spool.js').parseSpoolLine(l);

test('Command Code başlatma satırı: rc dosyasının AGENT_OFFICE_*\'ı gider; argv yalnız Command Code argümanları (v3.25)', { skip: process.platform === 'win32' }, () => {
  const EN = require('../src/engine.js');
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ccl-'));
  try {
    fs.writeFileSync(path.join(bin, 'commandcode'), '#!/bin/sh\nprintf "%s\\n" "$@"\necho ---\nenv\n', { mode: 0o755 });
    const env = EN.cmdEnv({ ...SECRET_ENV, PATH: `${bin}:/usr/bin:/bin`, HOME: bin }, process.platform);
    const rc = 'export AGENT_OFFICE_DIRECTORY=/rc/dir AGENT_OFFICE_MANAGER=1 USERS_OWN=kept; ';
    const r = spawnSync('/bin/sh', ['-c', rc + EN.CMD_COMMAND, EN.CMD.bin, ...EN.cmdArgs({ resume: true, prompt: 'carry on' })], { env, encoding: 'utf8', cwd: bin });
    assert.equal(r.status, 0, r.stderr);
    const [argv, out] = r.stdout.split('---\n');
    assert.deepEqual(argv.trim().split('\n'), ['--continue', 'carry on']);
    assert.doesNotMatch(out, /^(ANTHROPIC|CLAUDE|AGENT_OFFICE)/m);
    assert.doesNotMatch(out, /MCP/);
    assert.match(out, /^USERS_OWN=kept$/m);
    for (const v of SECRET_VALUES) assert.equal(out.includes(v), false, v);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('Command Code klasör adı: tek yardımcı (ccSlugOf) hem geçmiş hem token hem izleme için (v3.25)', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const TUm = require('../src/token-usage.js');
  const AWm = require('../src/agy-watch.js');
  assert.equal(TUm.ccSlugOf('/Users/a/My Proj'), 'users-a-my-proj');
  assert.equal(AWm.cmdProjectDir('/h', '/Users/a/x'), path.join('/h', '.commandcode', 'projects', 'users-a-x'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cch-'));
  try {
    const d = path.join(home, '.commandcode', 'projects', 'users-a-x');
    fs.mkdirSync(d, { recursive: true });
    assert.equal(AWm.hasCmdSession(home, '/Users/a/x'), false);
    assert.equal(AWm.cmdTranscriptPath(home, '/Users/a/x'), null);
    fs.writeFileSync(path.join(d, 's1.prompts.jsonl'), '{}\n'); // a sidecar is not a session
    assert.equal(AWm.hasCmdSession(home, '/Users/a/x'), false);
    fs.writeFileSync(path.join(d, 'abc-1.jsonl'), '{"type":"message","message":{"role":"user"}}\n');
    assert.equal(AWm.hasCmdSession(home, '/Users/a/x'), true);
    assert.equal(AWm.hasCmdSession(home, '/Users/a/y'), false);
    // Claude Code's naming ('-Users-a-x') is not Command Code's
    fs.mkdirSync(path.join(home, '.commandcode', 'projects', '-Users-a-z'), { recursive: true });
    fs.writeFileSync(path.join(home, '.commandcode', 'projects', '-Users-a-z', 'q.jsonl'), '{}\n');
    assert.equal(AWm.hasCmdSession(home, '/Users/a/z'), false);
    assert.equal(AWm.cmdTranscriptPath(home, '/Users/a/x'), path.join(d, 'abc-1.jsonl'));
    const cur = AWm.readTranscript(path.join(d, 'abc-1.jsonl'), null, AWm.CMD_PROMPT_RE);
    assert.equal(cur.prompts, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  // main.js uses that one helper, never Claude Code's historyDir, for Command Code
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const hasCmdHistory = \(dir\) => AW\.hasCmdSession\(/);
  assert.match(src, /TU\.ccSlugOf/);
});

test('Command Code token okuma: yalnız projects/*.jsonl; auth.json asla okunmaz (v3.25)', async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const TUm = require('../src/token-usage.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cct-'));
  const realRead = fs.readFileSync, realOpen = fs.openSync, realCreate = fs.createReadStream;
  const touched = [];
  try {
    const root = path.join(home, '.commandcode');
    fs.mkdirSync(path.join(root, 'projects', 'tmp-p'), { recursive: true });
    fs.writeFileSync(path.join(root, 'auth.json'), '{"apiKey":"cc-secret"}');
    fs.writeFileSync(path.join(root, 'projects', 'tmp-p', 's.jsonl'), JSON.stringify({
      type: 'message', id: 'm1', timestamp: new Date().toISOString(), model: 'm',
      message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 } }) + '\n');
    const names = fs.readdirSync(path.join(root, 'projects'));
    const folders = TUm.projectFolders([...names, 'auth.json'], ['/tmp/p'], [], TUm.ccSlugOf).map((n) => path.join(root, 'projects', n));
    assert.deepEqual(folders, [path.join(root, 'projects', 'tmp-p')]);
    fs.readFileSync = (f, ...a) => { touched.push(String(f)); return realRead(f, ...a); };
    fs.openSync = (f, ...a) => { touched.push(String(f)); return realOpen(f, ...a); };
    fs.createReadStream = (f, ...a) => { touched.push(String(f)); return realCreate(f, ...a); };
    // every path the scanner's fs.promises touches is recorded
    const fsp = new Proxy(fs.promises, { get: (t, k) => (typeof t[k] === 'function' ? (f, ...a) => { touched.push(String(f)); return t[k](f, ...a); } : t[k]) });
    const recs = await new TUm.UsageScanner({ fsp }).scanFolders(folders, { since: 0 });
    assert.equal(recs.size, 1);
    assert.ok(touched.some((f) => f.endsWith('s.jsonl')));
    assert.equal(touched.some((f) => f.includes('auth.json')), false, 'auth.json was read');
  } finally {
    fs.readFileSync = realRead; fs.openSync = realOpen; fs.createReadStream = realCreate;
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const f of ['main.js', 'src/token-usage.js', 'src/agy-watch.js', 'src/engine.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(code.includes('auth.json'), false, `${f} names auth.json`);
  }
});

test('Command Code sekmesi gözlemlenir: agy-watch engine commandcode, uyku { cmd } ile --continue (v3.25)', () => {
  const AWm = require('../src/agy-watch.js');
  const Zm = require('../src/sleep.js');
  const w = AWm.createAgyWatch(1000, { engine: 'commandcode', label: 'Command Code' });
  w.input('fix it', 1100); w.input('\r', 1200);
  assert.equal(w.isBusy, true);
  w.output("Run npm test? Yes, don't ask again for this project", 1300);
  assert.equal(w.waiting?.kind, 'permission');
  w.input('1', 1400);
  assert.equal(w.tick(20000), true);
  const s = w.session('p', 'cmd-x', 20000);
  assert.equal(s.engine, 'commandcode');
  assert.equal(s.stats.today.log[0].type, 'commandcode');
  assert.equal(s.stats.today.log[0].description, 'Command Code');
  assert.deepEqual(Zm.wakeOptions({ cmd: true }, false), { resume: true });
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /asleep\.set\(id, isCmd\(r\.project\) \? \{ cmd: true \} : isOc\(r\.project\) \? \{ oc: true \} : \{ agy: true \}\)/);
});

test('lastJsonObject: gürültü arasındaki son nesne, dizgedeki parantezler, iç içe nesneler', () => {
  const pretty = JSON.stringify({ loggedIn: false, authMethod: 'none', nested: { a: 1 } }, null, 2);
  assert.deepEqual(A.lastJsonObject(`rc: hello {not json}\n${pretty}\nbye`), { loggedIn: false, authMethod: 'none', nested: { a: 1 } });
  assert.deepEqual(A.lastJsonObject('{"a":1}\n{"b":"x}{\\"y"}'), { b: 'x}{"y' });
  assert.deepEqual(A.lastJsonObject('{"a":1} trailing { broken'), { a: 1 });
  assert.equal(A.lastJsonObject(''), null);
  assert.equal(A.lastJsonObject('no json here [1,2]'), null);
  assert.equal(A.lastJsonObject(undefined), null);
});

test('authFromStatus: girişli, girişsiz, bozuk', () => {
  assert.deepEqual(A.authFromStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', configDirectory: '/x' }),
    { state: 'in', email: 'a@b.c', method: 'claude.ai' });
  assert.deepEqual(A.authFromStatus({ loggedIn: true }), { state: 'in' });
  assert.deepEqual(A.authFromStatus({ loggedIn: false, authMethod: 'none' }), { state: 'out' });
  assert.equal(A.authFromStatus({ loggedIn: 'yes' }).state, 'error');
  assert.equal(A.authFromStatus(null).state, 'error');
});

test('authFromRun: çıkış kodu sıfır değilse de JSON geçerli; zaman aşımı, claude yok, stderr', async () => {
  const tr = await tFor('tr');
  const en = await tFor('en');
  const code1 = Object.assign(new Error('Command failed'), { code: 1 });
  assert.deepEqual(A.authFromRun(code1, 'noise\n{"loggedIn": false}\n', ''), { state: 'out' });
  assert.deepEqual(A.authFromRun(null, '{"loggedIn": true, "email": "e@x"}', ''), { state: 'in', email: 'e@x' });
  const timeout = Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL', code: null });
  assert.deepEqual(A.authFromRun(timeout, '', ''), { state: 'error', errorKey: 'timeout' });
  assert.deepEqual(A.localizeAuth(A.authFromRun(timeout, '', ''), tr), { state: 'error', error: 'zaman aşımı' });
  assert.deepEqual(A.localizeAuth(A.authFromRun(Object.assign(new Error('x'), { code: 127 }), '', 'zsh: command not found: claude'), en),
    { state: 'error', error: 'claude not found' });
  assert.deepEqual(A.localizeAuth({ state: 'in', email: 'e' }, en), { state: 'in', email: 'e' });
  assert.deepEqual(A.localizeAuth({ state: 'error', errorKey: 'yeni' }, tr), { state: 'error', error: 'yeni' });
  assert.deepEqual(A.authFromRun(code1, '', 'warn\nboom: bad thing\n'), { state: 'error', error: 'boom: bad thing' });
  assert.equal(A.authFromRun(code1, '', 'x'.repeat(500)).error.length, 118);
  assert.equal(A.authFromRun(null, 'hello', '').state, 'error');
});

test('withAuth / login id: auth bellekten eklenir, yoksa checking; state değişmez', () => {
  const s = A.addAccount(empty(), 'İş', { id: 'w', root: '/r' }).state;
  const auths = new Map([['default', { state: 'in', email: 'e' }]]);
  const out = A.withAuth(s.accounts, (id) => auths.get(id));
  assert.deepEqual(out.map((a) => a.auth.state), ['in', 'checking']);
  assert.equal('auth' in s.accounts[0], false);
  assert.equal(A.loginPtyId('w'), 'login:w');
  assert.equal(A.loginAccountId('login:w'), 'w');
  assert.equal(A.loginAccountId('p1'), null);
  assert.match(A.claudeCommand('auth status --json'), /export CLAUDE_CONFIG_DIR="\$AGENT_OFFICE_CONFIG_DIR"; exec claude auth status --json$/);
});

const U = require('../src/usage.js');

test('withAuth: kota varsa eklenir, yoksa alan yok', () => {
  const usage = { updatedAt: 1, fiveHour: { pct: 5 } };
  const out = A.withAuth([{ id: 'a' }, { id: 'b' }], () => ({ state: 'in' }), (id) => (id === 'a' ? usage : undefined));
  assert.deepEqual(out[0].usage, usage);
  assert.equal('usage' in out[1], false);
});

test('usageFromStatus: rate_limits → yüzde ve ms cinsinden sıfırlanma; yoksa null', () => {
  const st = { model: {}, rate_limits: { five_hour: { used_percentage: 6.4, resets_at: 1791586200 }, seven_day: { used_percentage: 124 } } };
  assert.deepEqual(U.usageFromStatus(st, 99), {
    updatedAt: 99, fiveHour: { pct: 6.4, resetsAt: 1791586200000 }, sevenDay: { pct: 100 },
  });
  assert.deepEqual(U.usageFromStatus({ rate_limits: { seven_day: { used_percentage: 0, resets_at: 2 } } }, 1),
    { updatedAt: 1, sevenDay: { pct: 0, resetsAt: 2000 } });
  assert.equal(U.usageFromStatus({ model: {} }, 1), null);
  assert.equal(U.usageFromStatus({ rate_limits: {} }, 1), null);
  assert.equal(U.usageFromStatus(undefined, 1), null);
});

test('usageFromCache: geçerli kayıt döner, bozuk olan null', () => {
  const u = { updatedAt: 5, sevenDay: { pct: 3 } };
  assert.equal(U.usageFromCache(u), u);
  assert.equal(U.usageFromCache({ updatedAt: 5 }), null);
  assert.equal(U.usageFromCache({ fiveHour: { pct: 1 } }), null);
  assert.equal(U.usageFromCache(undefined), null);
});

test('userStatusLine: ilk tanımlı statusLine kazanır; komut değilse null', () => {
  const cmd = { statusLine: { type: 'command', command: '~/sl.sh', padding: 0 } };
  assert.deepEqual(U.userStatusLine([undefined, {}, cmd]), { command: '~/sl.sh', padding: 0 });
  assert.deepEqual(U.userStatusLine([{ statusLine: { type: 'command', command: 'a' } }, cmd]), { command: 'a', padding: undefined });
  assert.equal(U.userStatusLine([{ statusLine: null }, cmd]), null);
  assert.equal(U.userStatusLine([{ statusLine: { type: 'command', command: ' ' } }, cmd]), null);
  assert.equal(U.userStatusLine([]), null);
});

test('settingsPaths: proje yerel, proje, hesap (yoksa ~/.claude)', () => {
  assert.deepEqual(U.settingsPaths('/p', null, '/h'), ['/p/.claude/settings.local.json', '/p/.claude/settings.json', '/h/.claude/settings.json']);
  assert.equal(U.settingsPaths('/p', '/acc', '/h')[2], '/acc/settings.json');
});

test('statusLineSettings: tırnaklı yollar, padding taşınır', () => {
  const s = JSON.parse(U.statusLineSettings("/x/Application Support/sl.sh", "/o/it's.json", { padding: 2 }));
  assert.deepEqual(s.statusLine, { type: 'command', command: `/bin/sh '/x/Application Support/sl.sh' '/o/it'\\''s.json'`, padding: 2 });
  assert.equal('padding' in JSON.parse(U.statusLineSettings('/a', '/b', null)).statusLine, false);
});

test('status line betiği: girdiyi dosyaya yazar, kullanıcının komutunu aynı girdiyle çalıştırır', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sl-'));
  const script = path.join(dir, "s l.sh");
  fs.writeFileSync(script, U.SCRIPT);
  const out = path.join(dir, 'p.json');
  const cmd = JSON.parse(U.statusLineSettings(script, out, null)).statusLine.command;
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1 } } });
  const env = { PATH: process.env.PATH };
  assert.equal(execFileSync('/bin/sh', ['-c', cmd], { input, env }).toString(), '');
  assert.equal(fs.readFileSync(out, 'utf8'), input);
  const shown = execFileSync('/bin/sh', ['-c', cmd], { input, env: { ...env, AGENT_OFFICE_STATUSLINE: 'wc -c | tr -d " "' } }).toString();
  assert.equal(shown.trim(), String(input.length));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['p.json', 's l.sh']);
  fs.rmSync(dir, { recursive: true });
});

const N = require('../src/attention.js');

test('nextAttention: izin ve bitiş bildirimi yalnız değişince, bakılan projede hiç; işaretler', () => {
  const projects = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }];
  const off = (aBusy, bWait) => [
    { name: 'alpha', isBossBusy: aBusy, waiting: null },
    { name: 'beta', isBossBusy: true, waiting: bWait },
  ];
  // first read: no event, but the open permission is marked
  let r = N.nextAttention(N.emptyAttention(), projects, off(true, { tool: 'Bash', since: 1 }), null);
  assert.deepEqual(r.events, []);
  assert.deepEqual([...r.attention], [['b', 'permission']]);
  // same permission: no event; new permission: event
  r = N.nextAttention(r.state, projects, off(true, { tool: 'Bash', since: 1 }), null);
  assert.deepEqual(r.events, []);
  r = N.nextAttention(r.state, projects, off(true, { tool: 'Edit', since: 2 }), null);
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'b', tool: 'Edit' }]);
  // alpha's turn ended, not being looked at: 'done' event and marker; reading again gives no event, the marker stays
  r = N.nextAttention(r.state, projects, off(false, null), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.deepEqual([...r.attention], [['a', 'done']]);
  r = N.nextAttention(r.state, projects, off(false, null), null);
  assert.deepEqual(r.events, []);
  assert.deepEqual([...r.attention], [['a', 'done']]);
  // looking at alpha clears the marker
  r = N.nextAttention(r.state, projects, off(false, null), 'a');
  assert.deepEqual([...r.attention], []);
  // no permission or done notification for the looked-at project
  r = N.nextAttention(r.state, projects, off(true, null), 'a');
  r = N.nextAttention(r.state, projects, off(false, { tool: 'Bash', since: 3 }), 'b');
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.deepEqual([...r.attention], [['a', 'done'], ['b', 'permission']]);
});

test('nextAttention: tur arka plan ajanları çalışırken biterse bitiş yok; ajanlar bitince bir kez', () => {
  const projects = [{ id: 'a', name: 'alpha' }];
  const off = (isBossBusy, working, waiting = null) => [{ name: 'alpha', working, delivered: 0, isBossBusy, waiting }];
  let r = N.nextAttention(N.emptyAttention(), projects, off(true, 2), null);
  // the main turn ends while two background agents still run: the boss waits for its agents, not for the user
  r = N.nextAttention(r.state, projects, off(false, 2), null);
  assert.deepEqual(r.events, []);
  assert.equal(r.attention.size, 0);
  r = N.nextAttention(r.state, projects, off(false, 1), null);
  assert.deepEqual(r.events, []);
  // a permission prompt from an agent still counts
  r = N.nextAttention(r.state, projects, off(false, 1, { tool: 'Bash', since: 4 }), null);
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'a', tool: 'Bash' }]);
  r = N.nextAttention(r.state, projects, off(false, 1), null);
  assert.deepEqual(r.events, []);
  // the last agent finishes and the boss stays idle: 'done' once
  r = N.nextAttention(r.state, projects, off(false, 0), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.deepEqual([...r.attention], [['a', 'done']]);
  r = N.nextAttention(r.state, projects, off(false, 0), null);
  assert.deepEqual(r.events, []);
  // the last agent finishes and Claude resumes a turn by itself: no 'done' until that turn ends
  r = N.nextAttention(N.emptyAttention(), projects, off(false, 1), null);
  r = N.nextAttention(r.state, projects, off(true, 0), null);
  assert.deepEqual(r.events, []);
  r = N.nextAttention(r.state, projects, off(false, 0), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
});

test('usageAlerts: %80 ve %95 bir kez, sıfırlanınca yeniden; açılışta yalnız işaretler', () => {
  const NOW = 1000;
  const alerted = new Map();
  const u = (pct, resetsAt = 5000) => ({ updatedAt: 1, fiveHour: { pct, resetsAt }, sevenDay: { pct: 10, resetsAt: 9000 } });
  assert.deepEqual(N.usageAlerts('a', u(50), alerted, { now: NOW }), []);
  assert.deepEqual(N.usageAlerts('a', u(81), alerted, { now: NOW }), [{ window: 'fiveHour', pct: 81, level: 80, resetsAt: 5000 }]);
  assert.deepEqual(N.usageAlerts('a', u(85), alerted, { now: NOW }), []);
  assert.deepEqual(N.usageAlerts('a', u(96), alerted, { now: NOW }).map((x) => x.level), [95]);
  assert.deepEqual(N.usageAlerts('a', u(97), alerted, { now: NOW }), []);
  // a new window (different reset time) warns again; an expired window doesn't warn
  assert.deepEqual(N.usageAlerts('a', u(82, 8000), alerted, { now: NOW }).map((x) => x.level), [80]);
  assert.deepEqual(N.usageAlerts('a', u(99, 500), alerted, { now: NOW }), []);
  // seed: marks but doesn't announce
  const fresh = new Map();
  assert.deepEqual(N.usageAlerts('b', u(90), fresh, { seed: true, now: NOW }), []);
  assert.deepEqual(N.usageAlerts('b', u(91), fresh, { now: NOW }), []);
});

test('historyDir: Claude Code oturum klasörü, harf/rakam dışı karakterler "-"', () => {
  assert.equal(P.historyDir('/Users/a/Documents/my.app', null, '/Users/a'), '/Users/a/.claude/projects/-Users-a-Documents-my-app');
  assert.equal(P.historyDir('/Users/a/.claude/x_y', '/acc', '/Users/a'), '/acc/projects/-Users-a--claude-x-y');
});

const OS = require('../src/platform.js');

test('platform: kabuk $SHELL, yoksa macOS zsh, Linux bash', () => {
  assert.equal(OS.defaultShell({ SHELL: '/usr/bin/fish' }, 'linux'), '/usr/bin/fish');
  assert.equal(OS.defaultShell({}, 'darwin'), '/bin/zsh');
  assert.equal(OS.defaultShell({}, 'linux'), '/bin/bash');
  assert.equal(OS.isMac('darwin'), true);
  assert.equal(OS.isMac('linux'), false);
});

test('platform: Linux panosundaki dosyalar (uri-list, gnome-copied-files)', () => {
  assert.deepEqual(OS.filesFromUriList('copy\nfile:///home/a/b%20c.png\nfile:///tmp/x'), ['/home/a/b c.png', '/tmp/x']);
  assert.deepEqual(OS.filesFromUriList('# yorum\r\nfile://localhost/etc/hosts\r\nhttps://example.com/a\r\nfile://other-host/x\r\n'), ['/etc/hosts']);
  assert.deepEqual(OS.filesFromUriList(''), []);
  assert.deepEqual(OS.filesFromUriList('düz metin /home/a'), []);
});

test('platform: pano komutları Wayland\'de önce wl-paste, X11\'de önce xclip', () => {
  assert.equal(OS.linuxClipboardCommands({ WAYLAND_DISPLAY: 'wayland-0' })[0].cmd, 'wl-paste');
  assert.equal(OS.linuxClipboardCommands({})[0].cmd, 'xclip');
});

test('platform: kısayollar macOS ⌘ (rol kısayolları), Linux Ctrl+Shift', () => {
  assert.deepEqual(OS.shortcuts('darwin'), { paste: 'CmdOrCtrl+V', copy: null, cut: null });
  assert.deepEqual(OS.shortcuts('linux'), { paste: 'Ctrl+Shift+V', copy: 'Ctrl+Shift+C', cut: 'Ctrl+Shift+X' });
});

// ---- tabs and worktrees (contract v3.0)
const path = require('path');

test('normalize: eski dosyada tabs yok; bozuk, yinelenen ve ana (1) sekme atılır, worktree eksikse düz sekme', () => {
  const old = P.normalizeState({ projects: [{ id: 'a', dir: '/r/shop', accountId: 'default' }] });
  assert.equal('tabs' in old.projects[0], false);
  const wt = { root: '/r/shop-wt-3', repo: '/r/shop', branch: 'agent-office/3' };
  const s = P.normalizeState({ projects: [{ id: 'a', dir: '/r/shop', tabs: [
    null, { n: 1 }, { n: 'x' }, { n: 2 }, { n: 2, dir: '/dup' }, { n: 3, dir: '/r/shop-wt-3', worktree: wt, extra: 1 },
    { n: 4, dir: '/r/half', worktree: { root: '/r/half' } }, { n: 0 }, { n: 2.5 },
  ] }, { id: 'b', dir: '/r/x', tabs: 'bozuk' }] });
  assert.deepEqual(s.projects[0].tabs, [{ n: 2 }, { n: 3, dir: '/r/shop-wt-3', worktree: wt }, { n: 4 }]);
  assert.equal('tabs' in s.projects[1], false);
});

test('pty kimlikleri: ana sekme projectId, ek sekme <id>:<n>; giriş pty\'si ve bozuk kimlik null', () => {
  assert.equal(P.tabPtyId('abc'), 'abc');
  assert.equal(P.tabPtyId('abc', 1), 'abc');
  assert.equal(P.tabPtyId('abc', 3), 'abc:3');
  assert.deepEqual(P.parsePtyId('abc'), { projectId: 'abc', n: 1 });
  assert.deepEqual(P.parsePtyId('abc:3'), { projectId: 'abc', n: 3 });
  assert.equal(P.parsePtyId('abc:1'), null);
  assert.equal(P.parsePtyId('login:abc'), null);
  assert.equal(P.parsePtyId('login:abc:2'), null);
  assert.equal(P.parsePtyId(''), null);
  assert.deepEqual(P.ptyIdsOf({ id: 'abc', tabs: [{ n: 2 }, { n: 5 }] }), ['abc', 'abc:2', 'abc:5']);
  assert.deepEqual(P.ptyIdsOf({ id: 'abc' }), ['abc']);
});

test('sekme ekle / kaldır / çöz: ana sekme kaldırılamaz, son sekme gidince tabs alanı silinir', () => {
  let s = P.addProject(empty(), '/r/shop', { id: () => 'a' }).state;
  assert.equal(P.nextTabNumber(P.findProject(s, 'a')), 2);
  s = P.addTab(s, 'a', { n: 2 });
  const wt = { root: '/r/shop-wt-3', repo: '/r/shop', branch: 'agent-office/3' };
  s = P.addTab(s, 'a', { n: 3, dir: '/r/shop-wt-3', worktree: wt });
  assert.equal(P.addTab(s, 'a', { n: 3 }), s, 'aynı numara yok sayılır');
  assert.equal(P.addTab(s, 'a', { n: 1 }), s, 'ana sekme eklenmez');
  assert.equal(P.addTab(s, 'zz', { n: 9 }), s);
  assert.equal(P.nextTabNumber(P.findProject(s, 'a')), 4);
  assert.equal(P.nextTabNumber(P.findProject(s, 'a'), (k) => k < 6), 6, 'dolu numaralar atlanır');
  assert.deepEqual(P.resolvePty(s, 'a'), { project: P.findProject(s, 'a'), tab: null, dir: '/r/shop' });
  assert.equal(P.resolvePty(s, 'a:2').dir, '/r/shop', 'düz sekme proje klasöründe');
  assert.equal(P.resolvePty(s, 'a:3').dir, '/r/shop-wt-3');
  assert.equal(P.resolvePty(s, 'a:9'), null);
  assert.equal(P.resolvePty(s, 'login:a'), null);
  assert.equal(P.removeTab(s, 'a', 1), s, 'ana sekme kapanmaz');
  s = P.removeTab(s, 'a', 2);
  assert.deepEqual(P.findProject(s, 'a').tabs.map((t) => t.n), [3]);
  s = P.removeTab(s, 'a', 3);
  assert.equal('tabs' in P.findProject(s, 'a'), false);
  // account change and normalize keep the tabs
  s = P.addTab(s, 'a', { n: 2 });
  assert.deepEqual(P.setProjectAccount({ ...s, accounts: [...s.accounts, { id: 'w', label: 'w', configDir: '/w' }] }, 'a', 'w').projects[0].tabs, [{ n: 2 }]);
  assert.deepEqual(P.normalizeState(JSON.parse(JSON.stringify(s))).projects[0].tabs, [{ n: 2 }]);
});

test('worktree adlandırması: deponun yanında <depo>-wt-<n>, dal agent-office/<n>, alt klasör korunur', () => {
  assert.equal(P.worktreeRoot('/u/p/shop', 2), path.join('/u/p', 'shop-wt-2'));
  assert.equal(P.worktreeBranch(2), 'agent-office/2');
  assert.equal(P.worktreeDir('/u/p/shop', '/u/p/shop-wt-2', '/u/p/shop'), '/u/p/shop-wt-2');
  assert.equal(P.worktreeDir('/u/p/shop', '/u/p/shop-wt-2', '/u/p/shop/app'), '/u/p/shop-wt-2/app');
  assert.equal(P.worktreeDir('/u/p/shop', '/u/p/shop-wt-2', '/elsewhere'), '/u/p/shop-wt-2');
});

test('sessionAliases: worktree klasörünün adı projesine; aynı adlı ve başka projenin adıyla çakışan eşlenmez', () => {
  const wt = (root) => ({ root, repo: '/r/shop', branch: 'agent-office/2' });
  const projects = [
    { id: 'a', dir: '/r/shop', name: 'shop', tabs: [{ n: 2 }, { n: 3, dir: '/r/shop-wt-3', worktree: wt('/r/shop-wt-3') }, { n: 4, dir: '/r/other', worktree: wt('/r/other') }] },
    { id: 'b', dir: '/r/mono/app', name: 'app', tabs: [{ n: 2, dir: '/r/mono-wt-2/app', worktree: wt('/r/mono-wt-2') }] },
    { id: 'c', dir: '/r/other', name: 'other' },
  ];
  assert.deepEqual(P.sessionAliases(projects), { 'shop-wt-3': 'shop' });
  assert.deepEqual(P.sessionAliases([]), {});
});

test('nextAttention: worktree oturumu (eşlenen ad) projesinin onayı ve bitişi sayılır', () => {
  const projects = [{ id: 'a', name: 'shop' }];
  const aliases = { 'shop-wt-2': 'shop' };
  const office = (busy, waiting) => [
    { name: 'shop', working: 0, delivered: 0, isBossBusy: false, waiting: null },
    { name: 'shop-wt-2', working: busy ? 1 : 0, delivered: 0, isBossBusy: busy, waiting },
  ];
  let r = N.nextAttention(N.emptyAttention(), projects, office(true, null), null, aliases);
  assert.equal(r.attention.size, 0);
  r = N.nextAttention(r.state, projects, office(true, { tool: 'Bash', since: 5 }), null, aliases);
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'a', tool: 'Bash' }]);
  assert.equal(r.attention.get('a'), 'permission');
  r = N.nextAttention(r.state, projects, office(true, null), null, aliases);
  r = N.nextAttention(r.state, projects, office(false, null), null, aliases);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  // without a map the worktree entry counts toward no project
  const plain = N.nextAttention(N.emptyAttention(), projects, office(true, { tool: 'Bash', since: 5 }), null);
  assert.equal(plain.attention.size, 0);
  // merging: oldest approval, busy OR
  const m = N.mergeAliases([
    { name: 'shop', working: 1, delivered: 2, isBossBusy: false, waiting: { tool: 'Edit', since: 9 } },
    { name: 'shop-wt-2', working: 2, delivered: 1, isBossBusy: true, waiting: { tool: 'Bash', since: 3 } },
  ], aliases);
  assert.deepEqual(m.get('shop'), { name: 'shop', working: 3, delivered: 3, isBossBusy: true, waiting: { tool: 'Bash', since: 3 } });
});

test('diller: locales/*.json bulunur, adları kendi dilinde; sistem dili dosyası olan koda çözülür', async () => {
  const langs = L.languagesOf(LOCALES);
  assert.deepEqual(langs.filter((l) => l.code === 'en' || l.code === 'tr'), [{ code: 'en', name: 'English' }, { code: 'tr', name: 'Türkçe' }]);
  assert.deepEqual(langs.map((l) => l.code), [...langs.map((l) => l.code)].sort());
  const codes = ['en', 'pt-BR', 'tr'];
  assert.equal(L.resolveLang('tr-TR', codes), 'tr');
  assert.equal(L.resolveLang('TR', codes), 'tr');
  assert.equal(L.resolveLang('pt_BR', codes), 'pt-BR');
  assert.equal(L.resolveLang('de-DE', codes), 'en');
  assert.equal(L.resolveLang('', codes), 'en');
  assert.equal(L.resolveLang(undefined, codes), 'en');
  const tr = await tFor('tr');
  const en = await tFor('en');
  assert.equal(tr('main.upToDate', { version: '1.2.3' }), 'Agent Office güncel (1.2.3).');
  assert.equal(en('panel.toolCalls', { n: 1 }), '1 tool call');
  assert.equal(en('panel.toolCalls', { n: 3 }), '3 tool calls');
  assert.equal(tr('panel.toolCalls', { n: 1 }), '1 araç çağrısı');
  assert.equal(en('no.such.key'), 'no.such.key');
  assert.equal(en.has('main.cancel'), true);
  assert.equal(en.has('main'), false);
  // a missing key falls back to English
  const { translator } = await import('../src/i18n.mjs');
  const de = translator({ main: { cancel: 'Abbrechen' } }, LOCALES.en, 'de');
  assert.equal(de('main.cancel'), 'Abbrechen');
  assert.equal(de('main.edit'), 'Edit');
});

test('güncelleme: sürüm karşılaştırma sayısal (0.10.0 > 0.9.1), sürüm olmayan → null', () => {
  assert.equal(UP.compareVersions('0.10.0', '0.9.1'), 1);
  assert.equal(UP.compareVersions('0.9.1', '0.10.0'), -1);
  assert.equal(UP.compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(UP.compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(UP.compareVersions(null, '1.0.0'), null);
  assert.equal(UP.compareVersions('', '1.0.0'), null);
  assert.equal(UP.compareVersions('1.0', '1.0.0'), null);
});

test('güncelleme: elle denetimin iletisi', () => {
  const current = '0.9.1';
  assert.deepEqual(UP.updateMessage({ current, latest: '0.10.0' }), { kind: 'downloading', version: '0.10.0' });
  assert.deepEqual(UP.updateMessage({ current, latest: '0.9.1' }), { kind: 'upToDate', version: '0.9.1' });
  assert.deepEqual(UP.updateMessage({ current, latest: '0.9.0' }), { kind: 'upToDate', version: '0.9.1' });
  // no answer is not "up to date"
  assert.deepEqual(UP.updateMessage({ current, latest: null }), { kind: 'unknown', version: '0.9.1' });
  assert.deepEqual(UP.updateMessage({ current }), { kind: 'unknown', version: '0.9.1' });
  // a download in progress or finished wins over the check result
  assert.deepEqual(UP.updateMessage({ current, downloading: '0.10.0', latest: null }), { kind: 'downloading', version: '0.10.0' });
  assert.deepEqual(UP.updateMessage({ current, ready: '0.10.0', downloading: '0.10.1', latest: '0.10.1' }), { kind: 'ready', version: '0.10.0' });
});

test('güncelleme: odakta denetim yalnız son denetim 30 dakikadan eskiyse; saatte bir', () => {
  const now = 10 * 3600e3;
  assert.equal(UP.UPDATE_EVERY_MS, 3600e3);
  assert.equal(UP.shouldCheckOnFocus(0, now), true);
  assert.equal(UP.shouldCheckOnFocus(now - 29 * 60e3, now), false);
  assert.equal(UP.shouldCheckOnFocus(now - 30 * 60e3, now), true);
});

// ---- theme picker (contract v3.1): src/themes.mjs ----
const themesLib = () => import('../src/themes.mjs');
const fs = require('node:fs');
const GALLERY_DIR = path.join(__dirname, '..', '..', 'themes');
const galleryFiles = () => fs.readdirSync(GALLERY_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, f), 'utf8')));

test('tema galerisi: match atılır, açıklama ve renkler kalır; bozuk girdiler atlanır', async () => {
  const TH = await themesLib();
  const g = TH.galleryThemes([{ sakura: { description: 'pink', match: 'sakura', sign: 'SAKURA', colors: { accent: '#ff6f9c' } } }, null, [], { bad: 3, nocolors: { sign: 'X' } }]);
  assert.deepEqual(g.sakura, { description: 'pink', sign: 'SAKURA', colors: { accent: '#ff6f9c' } });
  assert.deepEqual(g.nocolors, { sign: 'X', colors: {} });
  assert.equal('bad' in g, false);
  // the real gallery: eight themes, none with match, each with a description
  const real = TH.galleryThemes(galleryFiles());
  assert.ok(Object.keys(real).length >= 8);
  for (const [name, t] of Object.entries(real)) {
    assert.equal('match' in t, false, `${name} kept match`);
    assert.equal(typeof t.description, 'string', `${name} has no description`);
  }
});

test('tema birleştirme: kullanıcının themes.json\'u çakışmada kazanır (renkler tek tek), match yalnız kullanıcıdan', async () => {
  const TH = await themesLib();
  const gallery = TH.galleryThemes([{ sakura: { description: 'pink', match: 'sakura', sign: 'SAKURA', colors: { accent: '#ff6f9c', body: '#f2f2f2' } } }]);
  const user = { sakura: { match: 'shop', colors: { accent: '#000000' } }, acme: { match: 'acme', colors: { frame: '#111111' } }, junk: 'x' };
  const m = TH.mergeThemes(gallery, user);
  assert.deepEqual(m.sakura, { description: 'pink', sign: 'SAKURA', match: 'shop', colors: { accent: '#000000', body: '#f2f2f2' } });
  assert.deepEqual(m.acme, { match: 'acme', colors: { frame: '#111111' } });
  assert.equal('junk' in m, false);
  // no user file, or a broken one ({} from sessions.js; anything not an object): the gallery alone
  assert.deepEqual(TH.mergeThemes(gallery, {}), gallery);
  assert.deepEqual(TH.mergeThemes(gallery, null), gallery);
  assert.equal(TH.mergeThemes(gallery, {}).sakura.match, undefined);
  // the input is not changed
  assert.equal(gallery.sakura.colors.accent, '#ff6f9c');
});

test('tema seçenekleri: önce yerleşikler (classic, forest), sonra diğerleri sırayla; açıklama temadan', async () => {
  const TH = await themesLib();
  const m = TH.mergeThemes(TH.galleryThemes([{ sakura: { description: 'pink' }, ocean: { colors: {} } }]), { forest: { colors: { accent: '#00ff00' } } });
  assert.deepEqual(TH.themeChoices(m), [
    { name: 'classic', description: '', isBuiltin: true },
    { name: 'forest', description: '', isBuiltin: true },
    { name: 'sakura', description: 'pink', isBuiltin: false },
    { name: 'ocean', description: '', isBuiltin: false },
  ]);
  assert.deepEqual(TH.themeChoices({}).map((c) => c.name), ['classic', 'forest']);
});

test('tema ayarı: auto ya da ad; bilinmeyen ad saklanır ama ofise boş (projeye göre) gider', async () => {
  const TH = await themesLib();
  for (const v of [undefined, null, 3, '', '   ', 'x'.repeat(101)]) assert.equal(TH.normalizeThemeSetting(v), 'auto');
  assert.equal(TH.normalizeThemeSetting(' sakura '), 'sakura');
  assert.equal(TH.normalizeThemeSetting('gone'), 'gone');
  const m = TH.galleryThemes([{ sakura: { colors: {} } }]);
  assert.equal(TH.effectiveTheme('auto', m), '');
  assert.equal(TH.effectiveTheme('sakura', m), 'sakura');
  assert.equal(TH.effectiveTheme('forest', m), 'forest');
  assert.equal(TH.effectiveTheme('classic', {}), 'classic');
  assert.equal(TH.effectiveTheme('gone', m), '');
  assert.equal(TH.effectiveTheme(undefined, m), '');
});

const M = require('../src/memory.js');
const fsT = require('fs');
const osT = require('os');
const pathT = require('path');

test('hafıza: slug Claude Code gibi, worktree ana klasörün hafızasını kullanır', () => {
  assert.equal(M.memorySlug('/Users/a/My Proj.x'), '-Users-a-My-Proj-x');
  assert.equal(M.memorySlug('/' + 'a'.repeat(250)), null);
  assert.equal(M.memorySlug('/a/s\u0327'), M.memorySlug('/a/\u015f')); // NFD path: same slug as NFC
  assert.equal(M.sharedMemoryDir({ configDir: null, home: '/h', base: '/r' }), null);
  assert.equal(M.sharedMemoryDir({ configDir: '/acc/w', home: '/h', base: '/r' }), '/h/.claude/projects/-r/memory');
  assert.equal(M.accountMemoryDir({ configDir: '/acc/w', base: '/r' }), '/acc/w/projects/-r/memory');
});

test('hafıza: anahtar klasör diskten bulunur (git root, worktree → ana kopya, symlink çözülür)', () => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-base-')));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, txt) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, txt); };
  // main working copy and a linked worktree, laid out as git writes them
  fsT.mkdirSync(j('r', '.git', 'worktrees', 'r-wt'), { recursive: true });
  fsT.mkdirSync(j('r', 'sub'));
  w(j('r-wt', '.git'), `gitdir: ${j('r', '.git', 'worktrees', 'r-wt')}\n`);
  w(j('r', '.git', 'worktrees', 'r-wt', 'commondir'), '../..\n');
  w(j('r', '.git', 'worktrees', 'r-wt', 'gitdir'), `${j('r-wt', '.git')}\n`);
  fsT.mkdirSync(j('r-wt', 'deep', 'er'), { recursive: true });
  assert.equal(M.memoryBase(j('r')), j('r'));
  assert.equal(M.memoryBase(j('r', 'sub')), j('r'));
  assert.equal(M.memoryBase(j('r-wt', 'deep', 'er')), j('r'));
  // submodule: .git file into .git/modules (no commondir) → its own root
  w(j('r', 'mod', '.git'), 'gitdir: ../.git/modules/mod\n');
  fsT.mkdirSync(j('r', '.git', 'modules', 'mod'), { recursive: true });
  assert.equal(M.memoryBase(j('r', 'mod')), j('r', 'mod'));
  // worktree of a bare repository → the bare repository folder
  fsT.mkdirSync(j('b.git', 'worktrees', 'bw'), { recursive: true });
  w(j('bw', '.git'), `gitdir: ${j('b.git', 'worktrees', 'bw')}\n`);
  w(j('b.git', 'worktrees', 'bw', 'commondir'), '../..\n');
  assert.equal(M.memoryBase(j('bw')), j('b.git'));
  // not a repository; reached through a symlink → the real path, as Claude Code's cwd
  fsT.mkdirSync(j('plain'));
  fsT.symlinkSync(j('plain'), j('link'));
  if (!fsT.existsSync(pathT.join(pathT.parse(root).root, '.git'))) {
    assert.equal(M.memoryBase(j('link')), j('plain'));
    assert.equal(M.memoryBase(j('missing')), j('missing'));
  }
  fsT.rmSync(root, { recursive: true, force: true });
});

test('hafıza: --settings JSON\'una autoMemoryDirectory eklenir', () => {
  assert.equal(M.withMemorySetting(null, null), null);
  assert.equal(M.withMemorySetting('{"a":1}', null), '{"a":1}');
  assert.deepEqual(JSON.parse(M.withMemorySetting('{"statusLine":{"type":"command"}}', '/m')), { statusLine: { type: 'command' }, autoMemoryDirectory: '/m' });
  assert.deepEqual(JSON.parse(M.withMemorySetting(null, '/m')), { autoMemoryDirectory: '/m' });
});

test('hafıza: hesabın hafızası ~/.claude\'a birleşir, mevcut olan ezilmez', () => {
  const root = fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-mem-'));
  const from = pathT.join(root, 'acc'); const to = pathT.join(root, 'home');
  fsT.mkdirSync(from); fsT.mkdirSync(to);
  fsT.writeFileSync(pathT.join(to, 'MEMORY.md'), '# Memory Index\n\n- [Commit](commit.md) — no attribution');
  fsT.writeFileSync(pathT.join(to, 'commit.md'), 'home');
  fsT.writeFileSync(pathT.join(from, 'commit.md'), 'account');
  fsT.writeFileSync(pathT.join(from, 'new.md'), 'new');
  fsT.writeFileSync(pathT.join(from, 'MEMORY.md'), '- [New](new.md) — x\n- [Commit](commit.md) — old\n');
  assert.deepEqual(M.mergeMemory(from, to), ['new.md']);
  assert.equal(fsT.readFileSync(pathT.join(to, 'commit.md'), 'utf8'), 'home');
  assert.equal(fsT.readFileSync(pathT.join(to, 'new.md'), 'utf8'), 'new');
  assert.equal(fsT.readFileSync(pathT.join(to, 'MEMORY.md'), 'utf8'), '# Memory Index\n\n- [Commit](commit.md) — no attribution\n- [New](new.md) — x\n');
  // idempotent; a memory deleted from ~/.claude is not copied back; a new account memory still is
  assert.deepEqual(M.mergeMemory(from, to), []);
  fsT.rmSync(pathT.join(to, 'new.md'));
  fsT.writeFileSync(pathT.join(from, 'later.md'), 'later');
  assert.deepEqual(M.mergeMemory(from, to), ['later.md']);
  assert.equal(fsT.existsSync(pathT.join(to, 'new.md')), false);
  fsT.rmSync(pathT.join(from, 'later.md'));
  // a missing source or target folder is fine
  assert.deepEqual(M.mergeMemory(pathT.join(root, 'none'), to), []);
  const fresh = pathT.join(root, 'fresh', 'memory');
  fsT.rmSync(pathT.join(from, '.agent-office-merged.json'));
  assert.deepEqual(M.mergeMemory(from, fresh).sort(), ['commit.md', 'new.md']);
  assert.equal(fsT.readFileSync(pathT.join(fresh, 'MEMORY.md'), 'utf8'), '- [New](new.md) — x\n- [Commit](commit.md) — old\n');
  fsT.rmSync(root, { recursive: true, force: true });
});

test('terminal: ⌘Enter (macOS) ve Ctrl+Enter claude\'a ctrl+enter (hemen gönder) olarak gider', async () => {
  const K = await import('../src/terminal-keys.mjs');
  const enter = (m = {}) => ({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  assert.equal(K.CTRL_ENTER, '\x1b[13;5u');
  assert.equal(K.translateKey(enter({ metaKey: true }), true), K.CTRL_ENTER);
  assert.equal(K.translateKey(enter({ ctrlKey: true }), true), K.CTRL_ENTER);
  assert.equal(K.translateKey(enter({ ctrlKey: true }), false), K.CTRL_ENTER);
  // plain Enter, Shift/Option+Enter and ⌘ on Linux stay with xterm
  assert.equal(K.translateKey(enter(), true), null);
  assert.equal(K.translateKey(enter({ shiftKey: true }), true), null);
  assert.equal(K.translateKey(enter({ altKey: true }), true), null);
  assert.equal(K.translateKey(enter({ ctrlKey: true, isComposing: true }), false), null);
  assert.equal(K.translateKey(enter({ metaKey: true }), false), null);
  assert.equal(K.translateKey(enter({ metaKey: true, ctrlKey: true }), true), null);
  assert.equal(K.translateKey({ key: 's', ctrlKey: true }, true), null);
});

test('uyku: ayar seçenekleri, varsayılan 30 dk, claude\'un pid dosyası hesabın klasöründe', () => {
  const Z = require('../src/sleep.js');
  assert.deepEqual(Z.SLEEP_CHOICES, [0, 15, 30, 60]);
  assert.equal(Z.normalizeSleep(undefined), 30);
  assert.equal(Z.normalizeSleep(0), 0);
  assert.equal(Z.normalizeSleep(60), 60);
  assert.equal(Z.normalizeSleep(7), 30);
  assert.equal(Z.normalizeSleep('15'), 30);
  assert.equal(Z.claudePidFile(null, '/h', 42), '/h/.claude/sessions/42.json');
  assert.equal(Z.claudePidFile('/u/accounts/a', '/h', 42), '/u/accounts/a/sessions/42.json');
});

test('uyku: gönderilmemiş yazı (Enter gönderir, Ctrl+C siler, kaçış dizileri saymaz)', () => {
  const { draftAfter } = require('../src/sleep.js');
  assert.equal(draftAfter(false, 'merhaba'), true);
  assert.equal(draftAfter(true, '\r'), false);
  assert.equal(draftAfter(false, 'fix the bug\r'), false);
  assert.equal(draftAfter(false, 'a\rb'), true);
  assert.equal(draftAfter(true, '\x03'), false);
  // arrows, focus in/out, SS3 keys, Alt+key and paste brackets alone are not text
  assert.equal(draftAfter(false, '\x1b[A\x1b[B\x1b[I\x1b[O\x1bOP\x1bb'), false);
  assert.equal(draftAfter(false, '\x1b[200~\x1b[201~'), false);
  // pasted text is a draft; a trailing Enter sends it
  assert.equal(draftAfter(false, '\x1b[200~long paste\x1b[201~'), true);
  assert.equal(draftAfter(false, '\x1b[200~long paste\x1b[201~\r'), false);
  // backspace and Escape keep what was there (safe side)
  assert.equal(draftAfter(true, '\x7f\x7f'), true);
  assert.equal(draftAfter(false, '\x7f'), false);
  assert.equal(draftAfter(true, '\x1b'), true);
  assert.equal(draftAfter(false, ''), false);
});

test('uyku: yalnız hiçbir şey kaybolmayacaksa (boşta, ajan/kabuk/onay/zamanlama yok, etkin proje değil)', () => {
  const { sleepBlocker, hasScheduleTool } = require('../src/sleep.js');
  const now = 10_000_000;
  const idle = {
    now, idleMs: 30 * 60000, lastActivityAt: now - 31 * 60000,
    claude: { pid: 1, sessionId: 's1', status: 'idle' },
    office: { format: 2, project: 'p', updatedAt: now, workers: [{ id: 'w', doneAt: now - 1 }], shells: [{ id: 'b', endAt: now - 1 }], stats: { isBossBusy: false } },
  };
  assert.equal(sleepBlocker(idle), '');
  assert.equal(sleepBlocker({ ...idle, idleMs: 0 }), 'off');
  assert.equal(sleepBlocker({ ...idle, isActive: true }), 'active');
  assert.equal(sleepBlocker({ ...idle, lastActivityAt: now - 29 * 60000 }), 'recent');
  assert.equal(sleepBlocker({ ...idle, hasDraft: true }), 'draft');
  // unknown session (no pid file, an odd one, no office file, an ended one): stays awake
  assert.equal(sleepBlocker({ ...idle, claude: undefined }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, claude: { status: 'idle' } }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, office: undefined }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, endedAt: now } }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, claude: { ...idle.claude, status: 'busy' } }), 'busy');
  assert.equal(sleepBlocker({ ...idle, claude: { ...idle.claude, status: undefined } }), 'busy');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, stats: { isBossBusy: true } } }), 'busy');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, stats: { waiting: { kind: 'permission', tool: 'Bash', since: now } } } }), 'waiting');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, workers: [{ id: 'w2' }] } }), 'agents');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, shells: [{ id: 'b2', status: 'running' }] } }), 'shells');
  assert.equal(sleepBlocker({ ...idle, hasSchedule: true }), 'scheduled');
  assert.equal(hasScheduleTool('{"type":"tool_use","name":"CronCreate","input":{}}'), true);
  assert.equal(hasScheduleTool('{"type":"tool_use","name":"ScheduleWakeup"}'), true);
  assert.equal(hasScheduleTool('{"type":"tool_use","name":"Bash"} CronCreate in prose'), false);
  assert.equal(hasScheduleTool(undefined), false);
});

test('uyku: readSession oturum dosyasını kimliğiyle okur, garip kimlik ya da bozuk dosya undefined', () => {
  const fsT = require('fs');
  const pathT = require('path');
  const S = require('../src/sessions.js');
  const root = fsT.mkdtempSync(pathT.join(require('os').tmpdir(), 'ao-sleep-'));
  fsT.mkdirSync(pathT.join(root, 'sessions'));
  fsT.writeFileSync(pathT.join(root, 'sessions', 'abc-1.json'), '{"format":2,"stats":{"isBossBusy":false}}');
  fsT.writeFileSync(pathT.join(root, 'sessions', 'bad.json'), '{');
  assert.deepEqual(S.readSession('abc-1', root), { format: 2, stats: { isBossBusy: false } });
  assert.equal(S.readSession('bad', root), undefined);
  assert.equal(S.readSession('missing', root), undefined);
  assert.equal(S.readSession('../sessions/abc-1', root), undefined);
  assert.equal(S.readSession(undefined, root), undefined);
  fsT.rmSync(root, { recursive: true, force: true });
});

// ---- Windows (decisions are pure and take the platform/env as arguments, so they run on any OS)
const W = require('path').win32;
const filesAt = (...files) => (f) => files.includes(f);

test('Windows: claude PATH\'te (PATHEXT sırası, Path anahtarı), yoksa kurulum klasörleri; hiç yoksa null', () => {
  const env = { Path: 'C:\\Windows;C:\\Users\\a\\AppData\\Roaming\\npm;"C:\\Users\\a\\.local\\bin"', PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' };
  // .exe comes before .cmd in PATHEXT, but PATH order wins: npm's folder is earlier
  assert.equal(OS.findClaude(env, filesAt('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\a\\.local\\bin\\claude.exe')),
    'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(OS.findClaude(env, filesAt('C:\\Users\\a\\.local\\bin\\claude.exe')), 'C:\\Users\\a\\.local\\bin\\claude.exe');
  // an extensionless npm shim (a shell script) or a .ps1 is never picked
  assert.equal(OS.findClaude(env, filesAt('C:\\Users\\a\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.ps1')), null);
  // not on PATH: the native installer's folder, then npm's
  const bare = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\b', APPDATA: 'C:\\Users\\b\\AppData\\Roaming' };
  assert.equal(OS.findClaude(bare, filesAt('C:\\Users\\b\\.local\\bin\\claude.exe')), 'C:\\Users\\b\\.local\\bin\\claude.exe');
  assert.equal(OS.findClaude(bare, filesAt('C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd')), 'C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(OS.findClaude(bare, () => false), null);
  assert.equal(OS.findOnPath('git.exe', { PATH: 'C:\\Git\\cmd' }, filesAt('C:\\Git\\cmd\\git.exe')), 'C:\\Git\\cmd\\git.exe');
});

test('Command Code motoru (v3.25): Windows\'ta yalnız `commandcode` aranır, `cmd` (System32\\cmd.exe) asla', () => {
  const ComSpec = 'C:\\Windows\\system32\\cmd.exe';
  assert.equal(OS.findCommandCode({ PATH: 'C:\\Users\\a\\bin', ComSpec }, filesAt('C:\\Users\\a\\bin\\commandcode.cmd')),
    'C:\\Users\\a\\bin\\commandcode.cmd');
  assert.equal(OS.findCommandCode({ PATH: 'C:\\Windows\\system32;C:\\Users\\a\\bin', ComSpec }, filesAt(ComSpec, 'C:\\Users\\a\\bin\\cmd.exe')), null);
});

test('Windows: agy yalnız PATH\'te aranır; yoksa null (v3.22)', () => {
  const env = { Path: 'C:\\Windows;C:\\Users\\a\\.local\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' };
  assert.equal(OS.findAgy(env, filesAt('C:\\Users\\a\\.local\\bin\\agy.exe')), 'C:\\Users\\a\\.local\\bin\\agy.exe');
  assert.equal(OS.findAgy(env, filesAt('C:\\Users\\a\\.local\\bin\\agy.ps1')), null);
  assert.equal(OS.findAgy(env, filesAt('C:\\Users\\a\\.local\\bin\\claude.exe')), null);
  assert.equal(OS.findAgy({ PATH: 'C:\\Windows' }, () => false), null);
});

test('Windows: .exe doğrudan, .cmd cmd.exe /d /s /c ile tek satır (tırnaklar korunur)', () => {
  const args = ['--plugin-dir', 'C:\\Users\\a b\\AppData\\Roaming\\Agent Office\\plugin\\agent-office', '--settings', 'C:\\s\\p.json', '--continue'];
  assert.deepEqual(OS.windowsCommand('C:\\Users\\a\\.local\\bin\\claude.exe', args, {}), { file: 'C:\\Users\\a\\.local\\bin\\claude.exe', args, verbatim: false });
  const c = OS.windowsCommand('C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd', args, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(c.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(c.verbatim, true);
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(c.args[3], '""C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd" --plugin-dir "C:\\Users\\a b\\AppData\\Roaming\\Agent Office\\plugin\\agent-office" --settings C:\\s\\p.json --continue"');
  assert.equal(OS.windowsCommand('C:\\x\\claude.BAT', [], {}).file, 'cmd.exe');
  assert.equal(OS.cmdQuote('a&b'), '"a&b"');
  assert.equal(OS.cmdQuote('say "hi"'), '"say ""hi"""');
});

test('Windows: PATH\'e klasör eklenir (mevcut anahtar, bir kez); env değişken adı büyük/küçük harf duyarsız', () => {
  assert.deepEqual(OS.withPathDir({ Path: 'C:\\A;C:\\B' }, 'C:\\U s'), { Path: 'C:\\A;C:\\B;C:\\U s' });
  assert.deepEqual(OS.withPathDir({ Path: 'C:\\A;c:\\u s' }, 'C:\\U s'), { Path: 'C:\\A;c:\\u s' });
  assert.deepEqual(OS.withPathDir({}, 'C:\\U'), { PATH: 'C:\\U' });
  assert.equal(OS.envGet({ ComSpec: 'x' }, 'COMSPEC'), 'x');
  assert.equal(OS.envGet({}, 'COMSPEC'), undefined);
});

test('Windows: Git Bash CLAUDE_CODE_GIT_BASH_PATH, git.exe\'nin yanı, sonra varsayılan klasörler', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(OS.findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\g\\bash.exe' }, filesAt('D:\\g\\bash.exe', bash)), 'D:\\g\\bash.exe');
  assert.equal(OS.findGitBash({ PATH: 'C:\\Program Files\\Git\\cmd' }, filesAt('C:\\Program Files\\Git\\cmd\\git.exe', bash)), bash);
  assert.equal(OS.findGitBash({ ProgramFiles: 'C:\\Program Files' }, filesAt(bash)), bash);
  assert.equal(OS.findGitBash({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, filesAt('C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')),
    'C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  assert.equal(OS.findGitBash({ PATH: 'C:\\Windows' }, () => false), null);
});

test('Windows: Gezgin\'den kopyalanan dosyalar (CF_HDROP, FileNameW, uri-list, PowerShell çıktısı)', () => {
  const names = ['C:\\Users\\a\\b c.png', 'D:\\x.txt'];
  const wide = Buffer.concat([Buffer.alloc(20), Buffer.from(names.join('\0') + '\0\0', 'utf16le')]);
  wide.writeUInt32LE(20, 0);
  wide.writeUInt32LE(1, 16);
  assert.deepEqual(OS.filesFromDropFiles(wide), names);
  const ansi = Buffer.concat([Buffer.alloc(20), Buffer.from('C:\\a.txt\0\0', 'latin1')]);
  ansi.writeUInt32LE(20, 0);
  assert.deepEqual(OS.filesFromDropFiles(ansi), ['C:\\a.txt']);
  assert.deepEqual(OS.filesFromDropFiles(Buffer.alloc(4)), []);
  assert.deepEqual(OS.filesFromFileNameW(Buffer.from('C:\\ç d.png\0', 'utf16le')), ['C:\\ç d.png']);
  assert.deepEqual(OS.filesFromFileNameW(Buffer.alloc(0)), []);
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="CF_HDROP"'), 'drop');
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="FileNameW"'), 'name');
  assert.equal(OS.windowsClipboardKind('text/uri-list'), 'uri');
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="HTML Format"'), null);
  assert.equal(OS.windowsClipboardKind('text/plain'), null);
  assert.deepEqual(OS.filesFromUriList('file:///C:/Users/a%20b/x.png\r\nfile://srv/share/y.txt\r\nhttps://e.com/z', 'win32'),
    ['C:\\Users\\a b\\x.png', '\\\\srv\\share\\y.txt']);
  assert.deepEqual(OS.filesFromLines('C:\\a b.txt\r\n\\\\srv\\s\\c.txt\r\nWARNING: x\r\n'), ['C:\\a b.txt', '\\\\srv\\s\\c.txt']);
});

test('Windows: kısayollar Linux gibi Ctrl+Shift; güncelleyici macOS, Windows ve AppImage\'da', () => {
  assert.deepEqual(OS.shortcuts('win32'), OS.shortcuts('linux'));
  assert.equal(OS.isWindows('win32'), true);
  assert.equal(OS.isWindows('darwin'), false);
  assert.equal(OS.canSelfUpdate('darwin', {}), true);
  assert.equal(OS.canSelfUpdate('win32', {}), true);
  assert.equal(OS.canSelfUpdate('linux', {}), false);
  assert.equal(OS.canSelfUpdate('linux', { APPIMAGE: '/x.AppImage' }), true);
});

test('Windows: görev çubuğu rozeti geçerli bir PNG', () => {
  const png = OS.dotPng(32, 0xe5484d);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
});

test('Windows: status line komutu tek çıplak sözcük; .cmd uygulamayı Node olarak çalıştırır', () => {
  const s = JSON.parse(U.windowsStatusLineSettings({ padding: 1 }));
  assert.deepEqual(s.statusLine, { type: 'command', command: 'agent-office-statusline.cmd', padding: 1 });
  assert.equal('padding' in JSON.parse(U.windowsStatusLineSettings(null)).statusLine, false);
  // no quotes, spaces or backslashes: Git Bash and PowerShell read it the same way
  assert.match(U.WIN_CMD, /^[\w.-]+$/);
  const cmd = U.windowsCmdFile('C:\\Users\\a 100%\\AppData\\Local\\Programs\\Agent Office\\Agent Office.exe');
  assert.equal(cmd.split('\r\n')[3], 'set ELECTRON_RUN_AS_NODE=1');
  assert.equal(cmd.split('\r\n')[4], '"C:\\Users\\a 100%%\\AppData\\Local\\Programs\\Agent Office\\Agent Office.exe" "%~dp0statusline.js"');
});

test('Windows: status line betiği (Node) girdiyi dosyaya yazar, kullanıcının komutunu aynı girdiyle çalıştırır', { skip: process.platform === 'win32' && 'runs the user command with /bin/sh here' }, () => {
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-slw-'));
  const script = path.join(dir, U.WIN_SCRIPT_NAME);
  fs.writeFileSync(script, U.WIN_SCRIPT);
  const out = path.join(dir, 'p.json');
  const input = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 3 } } });
  const env = { PATH: process.env.PATH, AGENT_OFFICE_USAGE_OUT: out };
  assert.equal(execFileSync(process.execPath, [script], { input, env }).toString(), '');
  assert.equal(fs.readFileSync(out, 'utf8'), input);
  const shown = execFileSync(process.execPath, [script], { input, env: { ...env, AGENT_OFFICE_STATUSLINE: 'wc -c | tr -d " "', AGENT_OFFICE_STATUSLINE_SHELL: '/bin/sh' } }).toString();
  assert.equal(shown.trim(), String(input.length));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['p.json', U.WIN_SCRIPT_NAME]);
  fs.rmSync(dir, { recursive: true });
});

test('Windows: hafıza ve geçmiş slug\'ı C:\\ yollarında da Claude Code gibi', () => {
  assert.equal(M.memorySlug('C:\\Users\\a\\proj'), 'C--Users-a-proj');
  // a .git file's gitdir on Windows uses forward slashes: the same slug
  assert.equal(M.memorySlug('C:/Users/a/proj'), 'C--Users-a-proj');
  assert.equal(W.basename(P.historyDir('C:\\Users\\a\\my.proj', null, 'C:\\Users\\a')), 'C--Users-a-my-proj');
});

test('terminal: resim yapıştırma tuşu ve yol tırnakları (Windows çift tırnak)', async () => {
  const K = await import('../src/terminal-keys.mjs');
  assert.equal(K.imagePasteKey('darwin'), '\x16');
  assert.equal(K.imagePasteKey('linux'), '\x16');
  assert.equal(K.imagePasteKey('win32'), '\x1bv');
  assert.equal(K.quotePath('/a/b c', 'darwin'), "'/a/b c'");
  assert.equal(K.quotePath("/a/it's", 'linux'), "'/a/it'\\''s'");
  assert.equal(K.quotePath('/a/b', 'darwin'), '/a/b');
  assert.equal(K.quotePath('C:\\Users\\a\\b.png', 'win32'), 'C:\\Users\\a\\b.png');
  assert.equal(K.quotePath('C:\\Users\\a b\\c.png', 'win32'), '"C:\\Users\\a b\\c.png"');
  assert.equal(K.quotePath('C:\\R&D\\x', 'win32'), '"C:\\R&D\\x"');
});

test('terminal: macOS Option ile klavye düzeninin ürettiği ASCII işaret yazılır, diğerleri Meta kalır', async () => {
  const K = await import('../src/terminal-keys.mjs');
  const opt = (key, code, m = {}) => ({ key, code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, ...m });
  // TR Q layout: Option+Q @, Option+7 {, Option+8 [; DE: Option+Shift+7 is a backslash
  assert.equal(K.translateKey(opt('@', 'KeyQ'), true), '@');
  assert.equal(K.translateKey(opt('{', 'Digit7'), true), '{');
  assert.equal(K.translateKey(opt('[', 'Digit8'), true), '[');
  assert.equal(K.translateKey(opt('\\', 'Digit7', { shiftKey: true }), true), '\\');
  assert.equal(K.translateKey(opt('~', 'KeyN'), true), '~');
  // US Option+p (π), letters/digits, keys without a character, dead keys: Meta (xterm sends ESC+key)
  assert.equal(K.translateKey(opt('π', 'KeyP'), true), null);
  assert.equal(K.translateKey(opt('p', 'KeyP'), true), null);
  assert.equal(K.translateKey(opt('1', 'Digit1'), true), null);
  assert.equal(K.translateKey(opt(' ', 'Space'), true), null);
  assert.equal(K.translateKey(opt('ArrowLeft', 'ArrowLeft'), true), null);
  assert.equal(K.translateKey(opt('Backspace', 'Backspace'), true), null);
  assert.equal(K.translateKey(opt('Enter', 'Enter'), true), null);
  assert.equal(K.translateKey(opt('Dead', 'KeyE'), true), null);
  // IME composition, Linux Alt, Cmd/Ctrl held with Option: left to xterm
  assert.equal(K.translateKey(opt('@', 'KeyQ', { isComposing: true }), true), null);
  assert.equal(K.translateKey(opt('@', 'KeyQ'), false), null);
  assert.equal(K.translateKey(opt('@', 'KeyQ', { metaKey: true }), true), null);
  assert.equal(K.translateKey(opt('@', 'KeyQ', { ctrlKey: true }), true), null);
});

test('uyku: uyanış seçenekleri (kendi oturumu, açılışta "son oturumdan devam et" o anki ayarı, hesap değişince temiz)', () => {
  const { wakeOptions } = require('../src/sleep.js');
  assert.deepEqual(wakeOptions({ sessionId: 's1' }, false), { sessionId: 's1' });
  assert.deepEqual(wakeOptions({ resume: true }, true), { resume: true });
  assert.deepEqual(wakeOptions({ resume: true }, false), { resume: false });
  assert.deepEqual(wakeOptions({}, true), { resume: false });
  assert.deepEqual(wakeOptions(undefined, true), { resume: false });
});

// --- moving a session to another computer (contract v3.4): src/transfer.js (pure) and src/transfer-io.js (files, git)
const TR = require('../src/transfer.js');
const TIO = require('../src/transfer-io.js');

const manifestOf = (over = {}) => ({
  format: TR.FORMAT, version: TR.VERSION, createdAt: '2026-10-12T00:00:00.000Z',
  source: { platform: 'darwin', projectDir: '/Users/a/proj', historyDir: '/Users/a/.claude/projects/-Users-a-proj' },
  session: { id: 'abc-123' }, git: null, ...over,
});
const archiveOf = (extra = [], manifest = manifestOf()) => [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
  { name: `transcript/${manifest.session?.id}.jsonl`, data: Buffer.from('{"type":"user"}\n') },
  ...extra,
];
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('transfer: tar.gz round trip keeps names (long, non-ASCII) and bytes', () => {
  const long = `memory/${'x'.repeat(150)}.md`;
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{}') },
    { name: 'transcript/abc/subagents/agent-1.jsonl', data: Buffer.from('a\nb\n') },
    { name: long, data: Buffer.alloc(0) },
    { name: 'memory/çalışma_notları.md', data: Buffer.from('ğüş') },
    { name: 'git/handoff.bundle', data: Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]) },
    { name: 'big', data: Buffer.alloc(70000, 7) },
  ];
  const back = TR.unpackArchive(TR.packArchive(entries, 1700000000));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data), entries[i].name);
  assert.equal(codeOf(() => TR.unpackArchive(Buffer.from('not gzip'))), 'notArchive');
  assert.equal(codeOf(() => TR.unpackArchive(TR.packArchive([{ name: 'a', data: Buffer.alloc(5000) }]), 1000)), 'tooLarge');
  assert.equal(codeOf(() => TR.tarPack([{ name: '../evil', data: Buffer.alloc(1) }])), 'unsafeEntry');
});

test('transfer: the archive is refused for unknown formats, traversal, absolute paths, links and credentials', () => {
  const ok = TR.readArchive(archiveOf([{ name: 'memory/MEMORY.md', data: Buffer.from('- x') }, { name: 'office/abc-123.json', data: Buffer.from('{}') }, { name: 'transcript/abc-123/tool-results/x.txt', data: Buffer.from('t') }]));
  assert.equal(ok.manifest.session.id, 'abc-123');
  assert.equal(ok.memory[0].name, 'MEMORY.md');
  assert.equal(ok.sidecar[0].rel, 'tool-results/x.txt');
  assert.ok(ok.office);
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], { ...manifestOf(), format: 'zip' }))), 'unknownFormat');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], { ...manifestOf(), version: TR.VERSION + 1 }))), 'newerFormat');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], { ...manifestOf(), session: { id: 'a b' } }))), 'badManifest');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], manifestOf({ git: { head: 'a'.repeat(40), branch: '--upload-pack=x' } })))), 'badManifest');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], manifestOf({ git: { head: 'nothex' } })))), 'badManifest');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], manifestOf({ source: { platform: 'darwin' } })))), 'badManifest');
  for (const name of ['../x', 'memory/../../x.md', '/etc/passwd', 'C:/x', 'c:\\x', 'memory\\..\\x.md', 'a//b', './a', 'a/./b', 'x\0y']) {
    assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name, data: Buffer.alloc(1) }]))), 'unsafeEntry', name);
  }
  for (const name of ['transcript/abc-123/.credentials.json', 'memory/.claude.json', 'transcript/abc-123/login.keychain-db']) {
    assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name, data: Buffer.alloc(1) }]))), 'secret', name);
  }
  assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name: 'settings.json', data: Buffer.alloc(1) }]))), 'unexpectedEntry');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name: 'memory/sub/x.md', data: Buffer.alloc(1) }]))), 'unexpectedEntry');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name: 'manifest.json', data: Buffer.from('{}') }]))), 'duplicate');
  assert.equal(codeOf(() => TR.readArchive(archiveOf().slice(0, 1))), 'missingTranscript');
  assert.equal(codeOf(() => TR.readArchive([])), 'notArchive');
  // a symlink entry (type 2) in a hand-made tar is refused while reading
  const tar = TR.tarPack([{ name: 'manifest.json', data: Buffer.from('{}') }]);
  tar[156] = '2'.charCodeAt(0);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i];
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  assert.equal(codeOf(() => TR.tarUnpack(tar)), 'unsafeEntry');
});

test('transfer: path prefixes in transcript lines (POSIX→POSIX, macOS→Windows, Windows→macOS)', () => {
  const src = { platform: 'darwin', projectDir: '/Users/a/proj', realDir: '/Users/a/proj', historyDir: '/Users/a/.claude/projects/-Users-a-proj', memoryDir: '/Users/a/.claude/projects/-Users-a-proj/memory' };
  const ids = { from: 's1', to: 's1' };
  // POSIX → POSIX
  let rw = TR.makeRewriter(TR.moveMaps(src, { projectDir: '/home/b/code/proj', historyDir: '/home/b/.claude/projects/-home-b-code-proj', memoryDir: '/home/b/.claude/projects/-home-b-code-proj/memory' }, ids), 'posix');
  const line = JSON.stringify({ type: 'user', cwd: '/Users/a/proj', sessionId: 's1', message: { content: [{ type: 'tool_use', input: { file_path: '/Users/a/proj/src/a b.js', command: 'cat /Users/a/proj/x.txt; ls /Users/a/project /x/Users/a/proj' } }, { type: 'text', text: 'saved to /Users/a/.claude/projects/-Users-a-proj/s1/tool-results/r.txt.' }] } });
  const out = JSON.parse(TR.rewriteJsonl(line, rw, ids));
  assert.equal(out.cwd, '/home/b/code/proj');
  assert.equal(out.message.content[0].input.file_path, '/home/b/code/proj/src/a b.js');
  assert.equal(out.message.content[0].input.command, 'cat /home/b/code/proj/x.txt; ls /Users/a/project /x/Users/a/proj');
  assert.equal(out.message.content[1].text, 'saved to /home/b/.claude/projects/-home-b-code-proj/s1/tool-results/r.txt.');
  // lines without a path stay byte for byte; broken lines too
  const plain = '{"type":"x",  "a":1.0}\nnot json /Users/a/proj\n';
  assert.equal(TR.rewriteJsonl(plain, rw, ids), plain);
  // macOS → Windows: separators follow, a whole-path field converts spaces and all
  rw = TR.makeRewriter(TR.moveMaps(src, { projectDir: 'C:\\Users\\b\\proj', historyDir: 'C:\\Users\\b\\.claude\\projects\\C--Users-b-proj', memoryDir: null }, ids), 'win32');
  const w = JSON.parse(TR.rewriteJsonl(JSON.stringify({ cwd: '/Users/a/proj', input: { file_path: '/Users/a/proj/my dir/a.js' }, text: 'edit /Users/a/proj/src/b.ts now' }), rw, ids));
  assert.equal(w.cwd, 'C:\\Users\\b\\proj');
  assert.equal(w.input.file_path, 'C:\\Users\\b\\proj\\my dir\\a.js');
  assert.equal(w.text, 'edit C:\\Users\\b\\proj\\src\\b.ts now');
  // Windows → macOS: any case, / or \ or JSON-escaped \\ between parts
  const wsrc = { platform: 'win32', projectDir: 'C:\\Users\\a\\proj', historyDir: 'C:\\Users\\a\\.claude\\projects\\C--Users-a-proj' };
  rw = TR.makeRewriter(TR.moveMaps(wsrc, { projectDir: '/Users/b/proj', historyDir: '/Users/b/.claude/projects/-Users-b-proj' }, ids), 'posix');
  const m = JSON.parse(TR.rewriteJsonl(JSON.stringify({ cwd: 'C:\\Users\\a\\proj', a: 'c:\\users\\A\\Proj\\src\\x.js', b: 'C:/Users/a/proj/y.js', c: '{"p":"C:\\\\Users\\\\a\\\\proj\\\\z.js"}', d: 'C:\\Users\\a\\project2' }), rw, ids));
  assert.equal(m.cwd, '/Users/b/proj');
  assert.equal(m.a, '/Users/b/proj/src/x.js');
  assert.equal(m.b, '/Users/b/proj/y.js');
  assert.equal(m.c, '{"p":"/Users/b/proj/z.js"}');
  assert.equal(m.d, 'C:\\Users\\a\\project2');
  // a new session id: the id fields and the session's own folder follow
  const ids2 = { from: 's1', to: 's2' };
  rw = TR.makeRewriter(TR.moveMaps(src, { projectDir: '/p', historyDir: '/h' }, ids2), 'posix');
  const r = JSON.parse(TR.rewriteJsonl(JSON.stringify({ sessionId: 's1', session_id: 's1', other: 's1', t: '/Users/a/.claude/projects/-Users-a-proj/s1/tool-results/a.txt' }), rw, ids2));
  assert.deepEqual(r, { sessionId: 's2', session_id: 's2', other: 's1', t: '/h/s2/tool-results/a.txt' });
});

test('transfer: the new folder\'s Claude Code slug (real path; Windows drive; too long → refused)', () => {
  const path = require('path');
  assert.equal(P.historyDir('C:\\Users\\b\\proj', null, 'C:\\Users\\b').replace(/\\/g, '/').split('/').pop(), 'C--Users-b-proj');
  assert.equal(path.basename(P.historyDir('/home/b/my proj.v2', null, '/home/b')), '-home-b-my-proj-v2');
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-slug-')));
  try {
    assert.equal(TIO.historyDirOf(tmp, null, '/h'), P.historyDir(tmp, null, '/h'));
    if (process.platform !== 'win32') {
      fs.symlinkSync(tmp, path.join(tmp, 'link'));
      assert.equal(TIO.historyDirOf(path.join(tmp, 'link'), '/cfg', '/h'), P.historyDir(tmp, '/cfg', '/h'));
    }
    const long = path.join(tmp, 'x'.repeat(210));
    fs.mkdirSync(long);
    const parsed = TR.readArchive(archiveOf());
    assert.equal(codeOf(() => TIO.placeSession(parsed, { targetDir: long, configDir: path.join(tmp, 'cfg'), home: tmp })), 'longPath');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('transfer: secrets stay out (Claude login files, untracked .env, keys), remote URLs lose their passwords', () => {
  for (const f of ['.credentials.json', 'x/.claude.json', '.env', '.env.local', 'config/.env.production', 'id_rsa', 'certs/server.key', 'a.pem', '.claude/settings.local.json', '.netrc', 'login.keychain-db']) assert.equal(TR.isSecretFile(f), true, f);
  for (const f of ['.env.example', 'src/env.js', 'id_rsa.pub', 'README.md', 'keys.ts', '.claude/agents/x.md']) assert.equal(TR.isSecretFile(f), false, f);
  assert.equal(TR.redactRemote('https://user:ghp_secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(TR.redactRemote('https://x-access-token:abc@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(TR.redactRemote('https://ghp_abcdef@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(TR.redactRemote('https://me@gitlab.com/a/b'), 'https://me@gitlab.com/a/b');
  assert.equal(TR.redactRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.ok(TR.remotesMatch(['git@github.com:Isisever/Agent-Office.git'], ['https://github.com/isisever/agent-office']));
  assert.ok(TR.remotesMatch(['ssh://git@github.com:22/a/b.git'], ['https://tok@github.com/a/b/']));
  assert.ok(!TR.remotesMatch(['git@github.com:a/b.git'], ['git@github.com:a/c.git']));
  assert.ok(!TR.remotesMatch([], ['git@github.com:a/b.git']));
});

test('transfer: only an idle session goes (sleep rules: busy boss, prompt, agents, shells, draft)', () => {
  const idle = { sessionId: 's', status: 'idle' };
  const office = { stats: {}, workers: [{ doneAt: 1 }], shells: [{ endAt: 2 }] };
  assert.equal(TR.exportBlocker({ running: false }), '');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office }), '');
  assert.equal(TR.exportBlocker({ running: true, claude: { sessionId: 's', status: 'busy' }, office }), 'busy');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: { isBossBusy: true } } }), 'busy');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: { waiting: { tool: 'Bash' } } } }), 'waiting');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: {}, workers: [{ doneAt: null }] } }), 'agents');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: {}, shells: [{}] } }), 'shells');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office, hasDraft: true }), 'draft');
  assert.equal(TR.exportBlocker({ running: true, claude: undefined, office }), 'unknown');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: undefined }), 'unknown');
});

test('transfer: checkout plan, file name, versions', () => {
  const base = { base: 'b', isClean: true, branches: ['main', 'feat'], sourceBranch: 'feat', sessionId: '12345678-aaaa' };
  assert.deepEqual(TR.planCheckout({ ...base, head: 'b' }), { action: 'apply' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'b', isClean: false }), { action: 'dirty' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x' }), { action: 'branch', branch: 'agent-office/handoff-12345678' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x', sourceBranch: 'new' }), { action: 'branch', branch: 'new' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x', branches: ['feat', 'agent-office/handoff-12345678'] }), { action: 'branch', branch: 'agent-office/handoff-12345678-2' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x', sourceBranch: null }), { action: 'branch', branch: 'agent-office/handoff-12345678' });
  assert.equal(TR.archiveName('shop', new Date(2026, 9, 2)), 'shop-2026-10-02.agentoffice');
  assert.equal(TR.archiveName('a:b/c', new Date(2026, 0, 1)), 'a-b-c-2026-01-01.agentoffice');
  assert.ok(TR.compareVersions('2.1.200 (Claude Code)', '2.1.296') < 0);
  assert.equal(TR.compareVersions('2.1.296', '2.1.296 (Claude Code)'), 0);
  assert.equal(TR.compareVersions(null, '2.1.296'), 0);
  assert.ok(TR.compareVersions('3.0.0', '2.9.9') > 0);
});

test('transfer: export → file → import into another home at another path (git, memory, office, new id)', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  try { execFileSync('git', ['--version']); } catch { return t.skip('git not installed'); }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-move-')));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  try {
    // origin with one pushed commit; the source clone has one unpushed commit, a change, a new file, an ignored file and a .env
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', origin);
    const homeA = path.join(tmp, 'a');
    const src = path.join(homeA, 'code', 'shop');
    fs.mkdirSync(src, { recursive: true });
    git(src, 'init', '-q');
    write(path.join(src, 'app.txt'), 'one\n');
    write(path.join(src, 'gone.txt'), 'bye\n');
    write(path.join(src, '.gitignore'), 'build/\n');
    git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'first');
    git(src, 'remote', 'add', 'origin', origin);
    git(src, 'push', '-q', '-u', 'origin', 'main');
    git(src, 'checkout', '-q', '-b', 'feature');
    write(path.join(src, 'app.txt'), 'one\ntwo\n');
    git(src, 'commit', '-q', '-am', 'unpushed');
    write(path.join(src, 'app.txt'), 'one\ntwo\nthree (uncommitted)\n');
    fs.rmSync(path.join(src, 'gone.txt'));
    write(path.join(src, 'new.txt'), 'untracked\n');
    write(path.join(src, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255]));
    write(path.join(src, 'build', 'out.js'), 'ignored');
    write(path.join(src, '.env'), 'TOKEN=secret');
    const indexBefore = fs.readFileSync(path.join(src, '.git', 'index'));
    // Claude Code's files for the session in home A
    const id = '0f0e0d0c-1111-4222-8333-444455556666';
    const hist = P.historyDir(src, null, homeA);
    write(path.join(hist, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', cwd: src, sessionId: id, message: { role: 'user', content: 'remember the word banana' } }),
      JSON.stringify({ type: 'assistant', cwd: src, sessionId: id, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(src, 'app.txt') } }] } }),
    ].join('\n') + '\n');
    write(path.join(hist, id, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ cwd: src, sessionId: id }) + '\n');
    write(path.join(hist, id, 'subagents', 'agent-a1.meta.json'), '{"agentType":"Explore"}');
    write(path.join(hist, id, 'tool-results', 'r1.txt'), `listing of ${src}\n`);
    write(path.join(hist, id, '.credentials.json'), '{"secret":1}');
    write(path.join(hist, 'other-session.jsonl'), '{}\n');
    const mem = TIO.memoryDirOf(src, homeA);
    write(path.join(mem, 'MEMORY.md'), '- [Rule](rule.md) — a rule\n');
    write(path.join(mem, 'rule.md'), 'always test');
    write(TIO.officeSessionFile(homeA, id), JSON.stringify({ format: 2, project: 'shop', workers: [], shells: [], stats: { delivered: 2 } }));

    const ex = await TIO.collectExport({ dir: src, sessionId: id, configDir: null, home: homeA, appVersion: '0.7.0', claudeVersion: '2.1.296', accountLabel: 'Default', hostname: 'mac-a' });
    const names = ex.entries.map((e) => e.name);
    assert.ok(names.includes(`transcript/${id}.jsonl`));
    assert.ok(names.includes(`transcript/${id}/subagents/agent-a1.jsonl`));
    assert.ok(names.includes(`transcript/${id}/tool-results/r1.txt`));
    assert.ok(!names.some((n) => n.includes('credentials')), 'no credentials');
    assert.ok(!names.some((n) => n.includes('other-session')), 'only this session');
    assert.ok(names.includes('memory/rule.md') && names.includes('memory/MEMORY.md'));
    assert.ok(names.includes(`office/${id}.json`));
    assert.ok(names.includes('git/handoff.bundle') && names.includes('git/changes.patch'));
    assert.equal(ex.manifest.git.branch, 'feature');
    assert.equal(ex.manifest.git.unpushed, 1);
    assert.equal(ex.manifest.git.upstream, null);
    assert.deepEqual(ex.notes.skipped, ['.env']);
    const patch = ex.entries.find((e) => e.name === 'git/changes.patch').data.toString();
    assert.match(patch, /three \(uncommitted\)/);
    assert.match(patch, /new\.txt/);
    assert.doesNotMatch(patch, /TOKEN=secret|out\.js/);
    // the source repository is untouched: same index, no leftover ref, same status
    assert.ok(fs.readFileSync(path.join(src, '.git', 'index')).equals(indexBefore));
    assert.equal(git(src, 'for-each-ref', 'refs/agent-office'), '');

    const file = path.join(tmp, TR.archiveName('shop'));
    TIO.writeArchive(file, ex.entries);
    const parsed = TIO.loadArchive(file);
    assert.equal(parsed.manifest.session.id, id);

    // home B: a clone of origin (without the unpushed commit) at another path, a separate config dir (an account)
    const homeB = path.join(tmp, 'b');
    const dst = path.join(homeB, 'work', 'shop-copy');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    git(tmp, 'clone', '-q', origin, dst);
    const cfgB = path.join(homeB, 'accounts', 'x');
    write(TIO.memoryDirOf(dst, homeB) + '/rule.md', 'existing rule wins');
    const target = await TIO.inspectTarget(parsed, dst);
    assert.equal(target.isRepo, true);
    assert.equal(target.remoteMatches, true); // both clones of the same origin
    assert.deepEqual(target.plan, { action: 'branch', branch: 'feature' });
    // a dirty tree is refused
    write(path.join(dst, 'app.txt'), 'local edit\n');
    assert.equal((await TIO.inspectTarget(parsed, dst)).plan.action, 'dirty');
    git(dst, 'checkout', '-q', '--', 'app.txt');
    assert.deepEqual(await TIO.prepareGit(parsed, target.top), { ok: true });
    const applied = await TIO.applyGit(parsed, target.top, target.plan);
    assert.deepEqual(applied, { ok: true, branch: 'feature' });
    assert.equal(fs.readFileSync(path.join(dst, 'app.txt'), 'utf8'), 'one\ntwo\nthree (uncommitted)\n');
    assert.equal(fs.readFileSync(path.join(dst, 'new.txt'), 'utf8'), 'untracked\n');
    assert.ok(fs.readFileSync(path.join(dst, 'bin.dat')).equals(Buffer.from([0, 1, 2, 3, 255])));
    assert.ok(!fs.existsSync(path.join(dst, 'gone.txt')));
    assert.ok(!fs.existsSync(path.join(dst, '.env')));
    assert.equal(git(dst, 'rev-parse', 'HEAD'), parsed.manifest.git.head);
    assert.deepEqual(execFileSync('git', ['status', '--porcelain'], { cwd: dst, encoding: 'utf8' }).split('\n').filter(Boolean).sort(), [' D gone.txt', ' M app.txt', '?? bin.dat', '?? new.txt']);
    assert.equal(git(dst, 'for-each-ref', 'refs/agent-office'), '');

    const placed = TIO.placeSession(parsed, { targetDir: dst, configDir: cfgB, home: homeB, gitTop: target.top });
    assert.equal(placed.sessionId, id);
    assert.equal(placed.historyDir, P.historyDir(fs.realpathSync(dst), cfgB, homeB));
    const lines = fs.readFileSync(placed.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, fs.realpathSync(dst));
    assert.equal(lines[1].message.content[0].input.file_path, path.join(fs.realpathSync(dst), 'app.txt'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(placed.historyDir, id, 'subagents', 'agent-a1.jsonl'), 'utf8')).cwd, fs.realpathSync(dst));
    assert.equal(fs.readFileSync(path.join(placed.historyDir, id, 'tool-results', 'r1.txt'), 'utf8'), `listing of ${fs.realpathSync(dst)}\n`);
    assert.ok(!fs.existsSync(path.join(placed.historyDir, id, '.credentials.json')));
    assert.equal(fs.readFileSync(path.join(TIO.memoryDirOf(dst, homeB), 'rule.md'), 'utf8'), 'existing rule wins');
    assert.equal(JSON.parse(fs.readFileSync(TIO.officeSessionFile(homeB, id), 'utf8')).project, 'shop-copy');
    // the same id again: refused, never overwritten; under a new id it goes in beside it
    assert.equal(codeOf(() => TIO.placeSession(parsed, { targetDir: dst, configDir: cfgB, home: homeB })), 'sessionExists');
    const id2 = '99999999-1111-4222-8333-444455556666';
    const again = TIO.placeSession(parsed, { targetDir: dst, configDir: cfgB, home: homeB, newId: id2 });
    const l2 = fs.readFileSync(again.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(l2[0].sessionId, id2);
    assert.ok(fs.existsSync(path.join(again.historyDir, id2, 'subagents', 'agent-a1.jsonl')));
    assert.equal(TIO.findSessionFiles(id, cfgB, homeB).length, 1);
    // a target already at the recorded commit: applied in place, no branch
    const dst2 = path.join(homeB, 'work', 'shop-2');
    git(tmp, 'clone', '-q', origin, dst2);
    assert.deepEqual(await TIO.prepareGit(parsed, dst2), { ok: true });
    git(dst2, 'checkout', '-q', '--detach', parsed.manifest.git.head);
    const t2 = await TIO.inspectTarget(parsed, dst2);
    assert.deepEqual(t2.plan, { action: 'apply' });
    assert.deepEqual(await TIO.applyGit(parsed, t2.top, t2.plan), { ok: true, branch: null });
    assert.equal(fs.readFileSync(path.join(dst2, 'new.txt'), 'utf8'), 'untracked\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- work across projects (contract v3.5) ----------
const SS = require('../src/sessions.js');

test('normPath: mutlak yollar tek biçimde; Windows yolları küçük harf ve / ile; göreli yol boş', () => {
  assert.equal(SS.normPath('/a//b/./c/../d/'), '/a/b/d');
  assert.equal(SS.normPath('C:\\Users\\Me\\Shop\\src'), 'c:/users/me/shop/src');
  assert.equal(SS.normPath('c:/Users/me/../..'), 'c:');
  assert.equal(SS.normPath('\\\\Server\\Share\\Repo'), '//server/share/repo');
  assert.equal(SS.normPath('src/a.ts'), '');
  assert.equal(SS.normPath(''), '');
  assert.equal(SS.normPath(undefined), '');
});

test('placeFinder: yolu tutan projenin adı, iç içe projelerde en derini; dışarıdaki ve göreli yol yok sayılır', () => {
  const placeOf = SS.placeFinder([
    { dir: '/w/mono', name: 'mono' },
    { dir: '/w/mono/apps/web', name: 'web' },
    { dir: '/w/shop', name: 'shop' },
    { dir: '/w/shop-wt-2', name: 'shop' },
    { dir: 'C:\\Code\\Blog', name: 'blog' },
    { dir: '', name: 'empty' },
    null,
  ]);
  assert.equal(placeOf('/w/mono/apps/web/src'), 'web');
  assert.equal(placeOf('/w/mono/apps/api'), 'mono');
  assert.equal(placeOf('/w/mono'), 'mono');
  assert.equal(placeOf('/w/shop-wt-2/src'), 'shop');
  assert.equal(placeOf('/w/shopping'), undefined, 'adı yalnız önek olan klasör projenin değil');
  assert.equal(placeOf('/elsewhere/x'), undefined);
  assert.equal(placeOf('relative/dir'), undefined);
  assert.equal(placeOf('c:/code/blog/posts'), 'blog');
  assert.equal(placeOf('C:\\CODE\\Blog\\posts\\a'), 'blog');
  assert.equal(placeOf('D:\\code\\blog'), undefined);
  assert.equal(SS.placeFinder(null)('/w/shop'), undefined);
});

test('projectPlaces: proje klasörü ve worktree sekmelerinin klasörleri projenin adıyla', () => {
  const wt = (root) => ({ root, repo: '/r/shop', branch: 'agent-office/3' });
  assert.deepEqual(P.projectPlaces([
    { id: 'a', dir: '/r/shop', name: 'shop', tabs: [{ n: 2 }, { n: 3, dir: '/r/shop-wt-3', worktree: wt('/r/shop-wt-3') }] },
    { id: 'b', dir: '/r/blog', name: 'blog' },
  ]), [
    { dir: '/r/shop', name: 'shop' },
    { dir: '/r/shop-wt-3', name: 'shop' },
    { dir: '/r/blog', name: 'blog' },
  ]);
});

test('kenar çubuğu durumu: başka projeden çalışılan proje çalışıyor görünür, nereden olduğu yazar', async () => {
  const { projectStatus, isBossHere } = await import('../src/project-status.mjs');
  const en = await tFor('en');
  const tr = await tFor('tr');
  assert.equal(projectStatus(undefined, tr), 'boşta');
  assert.equal(projectStatus({ working: 0, delivered: 0 }, en), 'idle');
  assert.equal(projectStatus({ working: 2, delivered: 5 }, tr), '2 çalışan · 5 teslim');
  const remote = { working: 0, delivered: 0, remote: { working: 2, isBossBusy: false, from: ['shop'] } };
  assert.equal(projectStatus(remote, tr), '2 çalışan · shop projesinden çalışılıyor');
  assert.equal(projectStatus(remote, en), '2 working · worked on from shop');
  const both = { working: 1, delivered: 3, remote: { working: 1, isBossBusy: true, from: ['shop', 'blog'] } };
  assert.equal(projectStatus(both, en), 'boss working · 2 working · 3 delivered · worked on from shop, blog');
  // only the boss works there: no agents to count, still not idle
  const boss = { working: 0, delivered: 0, isBossBusy: false, remote: { working: 0, isBossBusy: true, from: ['shop'] } };
  assert.equal(projectStatus(boss, en), 'boss working · worked on from shop');
  assert.equal(isBossHere(boss), true);
  assert.equal(isBossHere({ isBossBusy: false }), false);
  assert.equal(isBossHere(undefined), false);
});

test('kenar çubuğu durumu: ajansız çalışan müdür projeyi boşta göstermez, önce yazılır', async () => {
  const { projectStatus } = await import('../src/project-status.mjs');
  const en = await tFor('en');
  const tr = await tFor('tr');
  assert.equal(projectStatus({ working: 0, delivered: 0, isBossBusy: true }, tr), 'patron çalışıyor');
  assert.equal(projectStatus({ working: 0, delivered: 4, isBossBusy: true }, tr), 'patron çalışıyor · 4 teslim');
  assert.equal(projectStatus({ working: 0, delivered: 4, isBossBusy: true }, en), 'boss working · 4 delivered');
  assert.equal(projectStatus({ working: 2, delivered: 1, isBossBusy: true }, tr), 'patron çalışıyor · 2 çalışan · 1 teslim');
  assert.equal(projectStatus({ working: 0, delivered: 4, isBossBusy: false }, tr), '4 teslim');
  assert.equal(projectStatus({ working: 0, delivered: 0, isBossBusy: false }, tr), 'boşta');
});


test('readOffice: müdür hiçbir projede olmayan bir klasöre (scratchpad worktree) geçse de kendi projesinde meşgul sayılır', async () => {
  const { projectStatus, isBossHere } = await import('../src/project-status.mjs');
  const tr = await tFor('tr');
  const root = fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-bossdir-'));
  const now = Date.now();
  fsT.mkdirSync(pathT.join(root, 'sessions'), { recursive: true });
  fsT.writeFileSync(pathT.join(root, 'sessions', 'sess-1.json'), JSON.stringify({
    format: 2, project: 'shop', updatedAt: now - 1000, workers: [],
    stats: { isBossBusy: true, bossDir: '/private/tmp/claude-501/x/scratchpad/wt-boss', today: { date: SS.dayKey(now), ids: ['a', 'b', 'c', 'd'] } },
  }));
  const places = [{ dir: '/w/shop', name: 'shop' }, { dir: '/w/blog', name: 'blog' }];
  const d = SS.readOffice(['shop', 'blog'], now, root, null, places);
  const byName = Object.fromEntries(d.projects.map((p) => [p.name, p]));
  assert.equal(d.isBossBusy, true);
  assert.equal(byName.shop.isBossBusy, true);
  assert.equal(isBossHere(byName.shop), true);
  assert.equal(projectStatus(byName.shop, tr), 'patron çalışıyor · 4 teslim');
  assert.equal(byName.blog.remote, undefined);
  assert.equal(projectStatus(byName.blog, tr), 'boşta');
  fsT.rmSync(root, { recursive: true });
});

test('nextAttention: başka projeden çalışılan proje meşgul sayılmaz; bitiş bildirimi sahibinden gelir', () => {
  const projects = [{ id: 'a', name: 'shop' }, { id: 'b', name: 'blog' }];
  const office = (busy) => [
    { name: 'shop', working: busy ? 1 : 0, delivered: 0, isBossBusy: busy, waiting: null },
    { name: 'blog', working: 0, delivered: 0, isBossBusy: false, waiting: null, ...(busy ? { remote: { working: 1, isBossBusy: true, from: ['shop'] } } : {}) },
  ];
  let r = N.nextAttention(N.emptyAttention(), projects, office(true), null);
  r = N.nextAttention(r.state, projects, office(true), null);
  r = N.nextAttention(r.state, projects, office(false), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.equal(r.attention.has('b'), false);
});

const SC = require('../src/shared-config.js');

test('shared config: setting per account, default on, never for Default; kept by normalize', () => {
  assert.equal(SC.shareEnabled({ id: 'default', configDir: null }), false);
  assert.equal(SC.shareEnabled({ id: 'w', configDir: '/a/w' }), true);
  assert.equal(SC.shareEnabled({ id: 'w', configDir: '/a/w', shareDefault: false }), false);
  let s = P.normalizeState({ accounts: [{ id: 'w', label: 'W', configDir: '/a/w' }] });
  assert.equal(A.setAccountShare(s, 'default', false), s);
  assert.equal(A.setAccountShare(s, 'w', true), s);
  s = A.setAccountShare(s, 'w', false);
  assert.equal(s.accounts[1].shareDefault, false);
  assert.equal(P.normalizeState(JSON.parse(JSON.stringify(s))).accounts[1].shareDefault, false);
  s = A.setAccountShare(s, 'w', true);
  assert.equal('shareDefault' in s.accounts[1], false);
});

test('shared config: MCP servers from ~/.claude.json minus the names the account or the project has', () => {
  const defaultConfig = { mcpServers: { a: { type: 'http', url: 'u', headers: { Authorization: 'Bearer t' } }, own: { command: 'x' }, loc: { command: 'y' }, proj: { command: 'z' }, bad: 1 }, oauthAccount: { email: 'e' } };
  const accountConfig = { mcpServers: { own: { command: 'mine' } }, projects: { '/p': { mcpServers: { loc: {} } } } };
  assert.deepEqual(SC.sharedMcpServers({ defaultConfig, accountConfig, cwd: '/p', projectMcp: { mcpServers: { proj: {} } } }),
    { mcpServers: { a: defaultConfig.mcpServers.a } });
  assert.deepEqual(Object.keys(SC.sharedMcpServers({ defaultConfig, accountConfig: null, cwd: '/q', projectMcp: null }).mcpServers), ['a', 'own', 'loc', 'proj']);
  assert.equal(SC.sharedMcpServers({ defaultConfig: {}, accountConfig: null }), null);
  assert.equal(SC.sharedMcpServers({ defaultConfig: { mcpServers: { own: {} } }, accountConfig }), null);
});

test('shared config: enabled user plugins, not Agent Office, not synced, not those the account enabled itself', () => {
  const rec = (p, scope = 'user') => [{ scope, installPath: p }];
  const installed = { plugins: {
    'a@m': rec('/c/a'), 'off@m': rec('/c/off'), 'proj@m': rec('/c/proj', 'project'), 'agent-office@t': rec('/c/ao'),
    'mine@m': rec('/c/mine'), 'syn@s': rec('/h/plugins/synced/syn'), 'v@m': rec('/c/v'),
  } };
  const settings = { enabledPlugins: { 'a@m': true, 'off@m': false, 'proj@m': true, 'agent-office@t': true, 'mine@m': true, 'syn@s': true, 'v@m': ['1.0'] } };
  const accountInstalled = { plugins: { 'mine@other': rec('/acc/mine') } };
  const accountSettings = { enabledPlugins: { 'mine@other': true } };
  assert.deepEqual(SC.sharedPlugins({ installed, settings, accountInstalled, accountSettings, syncedDir: '/h/plugins/synced' }).map((p) => p.key), ['a@m', 'v@m']);
  assert.deepEqual(SC.sharedPlugins({ installed, settings, syncedDir: '/h/plugins/synced' }).map((p) => p.key), ['a@m', 'mine@m', 'v@m']);
  assert.deepEqual(SC.sharedPlugins({ installed, settings, accountInstalled, accountSettings: {} }).find((p) => p.key === 'mine@m'),
    { key: 'mine@m', name: 'mine', marketplace: 'm', installPath: '/c/mine' });
  assert.deepEqual(SC.pluginManifest({ name: 'swift-lsp', version: '1', source: './p', category: 'd', strict: false, tags: [], lspServers: { s: { command: 'x' } } }),
    { name: 'swift-lsp', version: '1', lspServers: { s: { command: 'x' } } });
  assert.equal(SC.stageName('a b/c@m'), 'a-b-c@m');
});

test('shared config: link plan skips skills/synced and dot entries', () => {
  const plan = SC.linkPlan({ skills: ['synced', '.DS_Store', 'tidy'], agents: ['r.md'], commands: [], files: ['CLAUDE.md'] }, '/h/.claude');
  assert.deepEqual(plan.map((p) => p.rel), ['skills/tidy', 'agents/r.md', 'CLAUDE.md']);
  assert.equal(plan[0].target, pathT.join('/h/.claude', 'skills', 'tidy'));
});

test('shared config: a session start links, stages and writes the MCP file; never clobbers; off undoes only its own', (t) => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-shared-')));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, txt) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, txt); };
  const home = j('home'); const cd = j('home', '.claude'); const acc = j('acc'); const proj = j('proj');
  w(pathT.join(cd, 'skills', 'tidy', 'SKILL.md'), 'tidy');
  w(pathT.join(cd, 'skills', 'mine', 'SKILL.md'), 'default mine');
  w(pathT.join(cd, 'skills', 'synced', 'x', 'SKILL.md'), 'default synced');
  w(pathT.join(cd, 'agents', 'r.md'), 'agent');
  w(pathT.join(cd, 'CLAUDE.md'), 'rules');
  w(pathT.join(cd, '.credentials.json'), 'secret');
  const cache = (n) => pathT.join(cd, 'plugins', 'cache', 'm', n, '1');
  w(pathT.join(cache('fd'), '.claude-plugin', 'plugin.json'), '{"name":"fd"}');
  w(pathT.join(cache('lsp'), 'README.md'), 'readme');
  w(pathT.join(cd, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'fd@m': [{ scope: 'user', installPath: cache('fd') }], 'lsp@m': [{ scope: 'user', installPath: cache('lsp') }],
  } }));
  w(pathT.join(cd, 'plugins', 'known_marketplaces.json'), JSON.stringify({ m: { installLocation: j('mkt') } }));
  w(j('mkt', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'lsp', strict: false, source: './x', lspServers: { s: { command: 'sk' } } }] }));
  w(pathT.join(cd, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fd@m': true, 'lsp@m': true } }));
  w(pathT.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { email: 'e' }, primaryApiKey: 'k', mcpServers: { s1: { type: 'http', url: 'u', headers: { Authorization: 'Bearer t' } }, own: { command: 'd' } } }));
  w(pathT.join(acc, 'skills', 'mine', 'SKILL.md'), 'account mine');
  w(pathT.join(acc, 'skills', 'synced', 'y', 'SKILL.md'), 'account synced');
  w(pathT.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { own: { command: 'a' } } }));
  fsT.mkdirSync(proj);
  const opts = (account) => ({ account, home, cwd: proj, stageRoot: j('ud', 'shared-plugins'), mcpFile: j('ud', 'mcp', 'p1.json') });
  const account = { id: 'w', configDir: acc };

  const r = SC.prepareShared(opts(account));
  const stage = j('ud', 'shared-plugins', 'lsp@m');
  assert.deepEqual(r.pluginDirs, [cache('fd'), stage]);
  assert.deepEqual(SC.sharedArgs(r), ['--plugin-dir', cache('fd'), '--plugin-dir', stage, '--mcp-config', j('ud', 'mcp', 'p1.json')]);
  assert.deepEqual(JSON.parse(fsT.readFileSync(pathT.join(stage, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'lsp', lspServers: { s: { command: 'sk' } } });
  assert.equal(fsT.readFileSync(pathT.join(stage, 'README.md'), 'utf8'), 'readme');
  const mcp = JSON.parse(fsT.readFileSync(r.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['s1']);
  assert.equal(JSON.stringify(mcp).includes('oauthAccount') || JSON.stringify(mcp).includes('primaryApiKey'), false);
  if (process.platform !== 'win32') assert.equal(fsT.statSync(r.mcpConfig).mode & 0o777, 0o600);
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'tidy', 'SKILL.md'), 'utf8'), 'tidy');
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'account mine');
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'synced', 'y', 'SKILL.md'), 'utf8'), 'account synced');
  assert.equal(fsT.existsSync(pathT.join(acc, 'skills', 'synced', 'x')), false);
  assert.equal(fsT.readFileSync(pathT.join(acc, 'agents', 'r.md'), 'utf8'), 'agent');
  assert.equal(fsT.readFileSync(pathT.join(acc, 'CLAUDE.md'), 'utf8'), 'rules');
  assert.equal(fsT.existsSync(pathT.join(acc, '.credentials.json')), false);
  assert.deepEqual(JSON.parse(fsT.readFileSync(pathT.join(acc, SC.MARKER), 'utf8')), ['CLAUDE.md', 'agents/r.md', 'skills/tidy']);

  // the same start again changes nothing; a skill removed from ~/.claude loses its link
  assert.deepEqual(SC.prepareShared(opts(account)), r);
  fsT.rmSync(pathT.join(cd, 'skills', 'tidy'), { recursive: true });
  SC.prepareShared(opts(account));
  assert.equal(fsT.existsSync(pathT.join(acc, 'skills', 'tidy')), false);
  // a plugin the account enabled itself is not passed (its stage stays for other accounts)
  w(pathT.join(acc, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'lsp@m': [{ scope: 'user', installPath: '/x' }] } }));
  w(pathT.join(acc, 'settings.json'), JSON.stringify({ enabledPlugins: { 'lsp@m': true } }));
  assert.deepEqual(SC.prepareShared(opts(account)).pluginDirs, [cache('fd')]);
  assert.equal(fsT.existsSync(stage), true);

  // off: the app's links, marker and MCP file go; the account's own entries and every source stay
  assert.deepEqual(SC.prepareShared(opts({ ...account, shareDefault: false })), { pluginDirs: [], mcpConfig: null, mcpNames: {} });
  assert.equal(fsT.existsSync(pathT.join(acc, 'agents', 'r.md')), false);
  assert.equal(fsT.existsSync(pathT.join(acc, 'CLAUDE.md')), false);
  assert.equal(fsT.existsSync(pathT.join(acc, SC.MARKER)), false);
  assert.equal(fsT.existsSync(j('ud', 'mcp', 'p1.json')), false);
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'account mine');
  assert.equal(fsT.readFileSync(pathT.join(cd, 'agents', 'r.md'), 'utf8'), 'agent');
  assert.equal(fsT.readFileSync(pathT.join(cd, 'CLAUDE.md'), 'utf8'), 'rules');
  assert.equal(fsT.readFileSync(pathT.join(cache('lsp'), 'README.md'), 'utf8'), 'readme');
  // Default: nothing at all
  assert.deepEqual(SC.prepareShared(opts({ id: 'default', configDir: null })), { pluginDirs: [], mcpConfig: null, mcpNames: {} });
  // a plugin uninstalled from Default: its stage is removed, its source untouched
  w(pathT.join(cd, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fd@m': true } }));
  SC.prepareShared(opts(account));
  assert.equal(fsT.existsSync(stage), false);
  assert.equal(fsT.readFileSync(pathT.join(cache('lsp'), 'README.md'), 'utf8'), 'readme');
});

test('shared config: MCP files with tokens live only while their tab runs; Default and off leave none', (t) => {
  assert.deepEqual(SC.staleMcpFiles(['p1.json', 'p1-2.json', 'old.json', 'p1.json.123'], ['p1', 'p1-2']), ['old.json', 'p1.json.123']);
  const root = fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-mcp-'));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const dir = pathT.join(root, 'mcp');
  fsT.mkdirSync(dir);
  for (const n of ['a.json', 'b-2.json', 'gone.json']) fsT.writeFileSync(pathT.join(dir, n), '{"mcpServers":{}}');
  assert.deepEqual(SC.pruneMcpFiles(dir, ['a', 'b-2']).sort(), ['gone.json']);
  assert.deepEqual(fsT.readdirSync(dir).sort(), ['a.json', 'b-2.json']);
  assert.deepEqual(SC.pruneMcpFiles(dir).sort(), ['a.json', 'b-2.json']); // app start: no tab runs yet
  assert.deepEqual(SC.pruneMcpFiles(pathT.join(root, 'missing')), []);
  // a tab whose project moved to Default: its old file goes at the next start
  const mcpFile = pathT.join(dir, 'p.json');
  fsT.writeFileSync(mcpFile, '{"mcpServers":{"s":{"headers":{"Authorization":"Bearer t"}}}}');
  assert.deepEqual(SC.prepareShared({ account: { id: 'default', configDir: null }, home: root, cwd: null, stageRoot: pathT.join(root, 'st'), mcpFile }), { pluginDirs: [], mcpConfig: null, mcpNames: {} });
  assert.equal(fsT.existsSync(mcpFile), false);
});

// --- the other office projects' MCP servers and the office directory (contract v3.9)
test('office MCP: Default\'s local servers for the folder are shared too, minus names the account or the project has', () => {
  const defaultConfig = { mcpServers: { u: { url: 'u' } }, projects: { '/p': { mcpServers: { loc: { url: 'dl' }, own: { url: 'x' }, u: { url: 'local wins' } } } } };
  const accountConfig = { projects: { '/p': { mcpServers: { own: { url: 'mine' } } } } };
  assert.deepEqual(SC.sharedMcpServers({ defaultConfig, accountConfig, cwd: '/p', projectMcp: null }),
    { mcpServers: { u: { url: 'local wins' }, loc: { url: 'dl' } } });
  assert.deepEqual(SC.sharedMcpServers({ defaultConfig, accountConfig, cwd: '/q', projectMcp: null }), { mcpServers: { u: { url: 'u' } } });
});

test('office MCP: a project\'s .mcp.json servers count only when approved and not disabled', () => {
  const projectMcp = { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' }, bad: 'x' } };
  assert.deepEqual(SC.approvedProjectServers(projectMcp, []), {});
  assert.deepEqual(Object.keys(SC.approvedProjectServers(projectMcp, [null, { enabledMcpjsonServers: ['a', 'c'] }, { disabledMcpjsonServers: ['c'] }])), ['a']);
  assert.deepEqual(Object.keys(SC.approvedProjectServers(projectMcp, [{ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['b'] }])), ['a', 'c']);
});

test('office MCP: a project\'s own servers: account local, Default local when the account shares, approved .mcp.json', () => {
  const accountConfig = { mcpServers: { top: {} }, projects: { '/b': { mcpServers: { onprem: { url: 'acc' } }, enabledMcpjsonServers: ['flow'] } } };
  const defaultConfig = { projects: { '/b': { mcpServers: { onprem: { url: 'def' }, top: { url: 'def' }, live: { url: 'live' } } } } };
  const projectMcp = { mcpServers: { flow: { command: 'f' }, onprem: { command: 'p' }, other: { command: 'o' } } };
  const approvals = [accountConfig.projects['/b']];
  assert.deepEqual(SC.projectServers({ dir: '/b', accountConfig, defaultConfig, projectMcp, approvals }),
    { flow: { command: 'f' }, live: { url: 'live' }, onprem: { url: 'acc' } });
  assert.deepEqual(SC.projectServers({ dir: '/b', accountConfig, defaultConfig: null, projectMcp, approvals }), { flow: { command: 'f' }, onprem: { url: 'acc' } });
  // Default: its own .claude.json is the account's
  assert.deepEqual(SC.projectServers({ dir: '/b', accountConfig: defaultConfig }), defaultConfig.projects['/b'].mcpServers);
});

test('office MCP: identical configs are not added again, a clash is renamed <server>-<project>, every name is valid', () => {
  const have = { onprem: { type: 'http', url: 'https://a', headers: { Authorization: 'Bearer 1' } }, nodesyai: { url: 'n' } };
  const others = [
    { key: '/b', name: 'nodesyai connect', servers: {
      onprem: { type: 'http', url: 'https://b' }, // same name, other config → renamed
      flow: { command: 'f' },
      nodes: { url: 'n' }, // another name, the same config as nodesyai → listed as nodesyai
    } },
    { key: '/c', name: 'c.d', servers: {
      onprem: { headers: { Authorization: 'Bearer 1' }, url: 'https://a', type: 'http' }, // same config, keys reordered
      flow: { command: 'f' }, // the same as /b's: added once
      'onprem-nodesyai-connect': { url: 'z' }, // taken by /b's renamed one
    } },
  ];
  const r = SC.officeMcpServers({ have, others });
  assert.deepEqual(r.servers, {
    'onprem-nodesyai-connect': { type: 'http', url: 'https://b' },
    flow: { command: 'f' },
    'onprem-nodesyai-connect-c-d': { url: 'z' },
  });
  assert.deepEqual(r.names, { '/b': ['onprem-nodesyai-connect', 'flow', 'nodesyai'], '/c': ['onprem', 'flow', 'onprem-nodesyai-connect-c-d'] });
  for (const n of Object.keys(r.servers)) assert.match(n, /^[A-Za-z0-9_-]+$/);
  assert.equal(SC.slugOf('çok güzel/proje'), 'ok-g-zel-proje');
  assert.equal(SC.slugOf('...'), 'project');
  const twice = SC.officeMcpServers({ have: { s: { a: 1 }, 's-p': { a: 2 } }, others: [{ key: 'k', name: 'p', servers: { s: { a: 3 } } }] });
  assert.deepEqual(Object.keys(twice.servers), ['s-p-2']);
  assert.equal(SC.canonical({ b: [1, { d: 1, c: 2 }], a: null }), SC.canonical({ a: null, b: [1, { c: 2, d: 1 }] }));
});

test('office MCP: a session start adds the other projects\' servers from each project\'s account; sources untouched', (t) => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-office-mcp-')));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, v) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
  const home = j('home'); const acc = j('acc'); const bpm = j('bpm'); const conn = j('conn'); const notes = j('notes');
  for (const d of [bpm, conn, notes]) fsT.mkdirSync(d, { recursive: true });
  const onpremBpm = { type: 'http', url: 'https://onprem/bpm', headers: { Authorization: 'Bearer bpm' } };
  const onpremConn = { type: 'http', url: 'https://onprem/conn', headers: { Authorization: 'Bearer conn' } };
  w(pathT.join(home, '.claude.json'), {
    mcpServers: { nodesyai: { type: 'http', url: 'https://n' } },
    projects: { [bpm]: { mcpServers: { onprem: onpremBpm } }, [conn]: { mcpServers: { onprem: onpremConn, live: { type: 'http', url: 'https://live' } } } },
  });
  w(pathT.join(acc, '.claude.json'), { mcpServers: { odoo: { url: 'o' } }, projects: { [conn]: { mcpServers: { accsrv: { url: 'acc' } } } } });
  w(pathT.join(conn, '.mcp.json'), { mcpServers: { flow: { command: 'node', args: ['flow.js'] }, unapproved: { command: 'evil' } } });
  w(pathT.join(conn, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['flow'] });
  w(pathT.join(notes, '.mcp.json'), { mcpServers: { nodes: { type: 'http', url: 'https://n' } } }); // = Default's nodesyai
  w(pathT.join(notes, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });
  const sources = [pathT.join(home, '.claude.json'), pathT.join(acc, '.claude.json'), pathT.join(conn, '.mcp.json'), pathT.join(notes, '.mcp.json')];
  const before = sources.map((f) => fsT.readFileSync(f, 'utf8'));
  const nodesy = { id: 'n', label: 'NodesyAI', configDir: acc };
  const office = (share = true) => ({ share, current: bpm, projects: [
    { name: 'bpm', dir: bpm, configDir: null, share: false },
    { name: 'nodesyai-connect', dir: conn, configDir: acc, share: true },
    { name: 'notes', dir: notes, configDir: null, share: false },
  ] });
  const mcpFile = j('ud', 'mcp', 'bpm.json');
  const opts = (account, o, cwd = bpm) => ({ account, home, cwd, stageRoot: j('ud', 'st'), mcpFile, office: o });
  const dflt = { id: 'default', configDir: null };

  // Default's session in bpm
  let r = SC.prepareShared(opts(dflt, office()));
  assert.equal(r.mcpConfig, mcpFile);
  if (process.platform !== 'win32') assert.equal(fsT.statSync(mcpFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fsT.readFileSync(mcpFile, 'utf8')).mcpServers, {
    accsrv: { url: 'acc' }, flow: { command: 'node', args: ['flow.js'] }, live: { type: 'http', url: 'https://live' }, 'onprem-nodesyai-connect': onpremConn,
  });
  assert.deepEqual(r.mcpNames, { [bpm]: ['onprem'], [conn]: ['flow', 'onprem-nodesyai-connect', 'live', 'accsrv'], [notes]: ['nodesyai'] });
  assert.deepEqual(sources.map((f) => fsT.readFileSync(f, 'utf8')), before);

  // the setting off: nothing from other projects, no file; the own project's names stay listed
  r = SC.prepareShared(opts(dflt, office(false)));
  assert.deepEqual(r, { pluginDirs: [], mcpConfig: null, mcpNames: { [bpm]: ['onprem'] } });
  assert.equal(fsT.existsSync(mcpFile), false);

  // the NodesyAI account's session in conn: Default's set (user + local for conn), plus bpm's onprem renamed
  const o2 = { ...office(), current: conn };
  r = SC.prepareShared(opts(nodesy, o2, conn));
  const servers = JSON.parse(fsT.readFileSync(mcpFile, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['live', 'nodesyai', 'onprem', 'onprem-bpm']);
  assert.deepEqual(servers.onprem, onpremConn);
  assert.deepEqual(servers['onprem-bpm'], onpremBpm);
  assert.deepEqual(r.mcpNames[conn], ['flow', 'onprem', 'live', 'accsrv']);
  assert.deepEqual(r.mcpNames[bpm], ['onprem-bpm']);
  assert.deepEqual(r.mcpNames[notes], ['nodesyai']);
  // an account that keeps apart from Default's set gets no other project's servers either
  r = SC.prepareShared(opts({ ...nodesy, shareDefault: false }, o2, conn));
  assert.equal(r.mcpConfig, null);
  assert.deepEqual(r.mcpNames, { [conn]: ['flow', 'accsrv'] });
  assert.deepEqual(sources.map((f) => fsT.readFileSync(f, 'utf8')), before);
});

test('office MCP: a relative command or path argument is resolved against its own project\'s folder', () => {
  const B = pathT.resolve('/work/b');
  const has = (p) => p === pathT.join(B, 'server.py') || p === pathT.resolve('/work/shared/x.json');
  const r = (server) => SC.resolveServerPaths(server, B, { exists: has });
  assert.deepEqual(r({ command: './venv/bin/python', args: ['./server.py', '--config', '../shared/x.json', './missing.py', '-m'] }),
    { command: pathT.join(B, 'venv', 'bin', 'python'), args: [pathT.join(B, 'server.py'), '--config', pathT.resolve('/work/shared/x.json'), './missing.py', '-m'] });
  assert.deepEqual(r({ type: 'stdio', command: 'venv/bin/python' }), { type: 'stdio', command: pathT.join(B, 'venv', 'bin', 'python') });
  assert.equal(r({ command: '../tools/run' }).command, pathT.resolve('/work/tools/run'));
  // bare names (PATH lookups), absolute paths, ~ and ${VAR} paths and remote servers stay as they are (same object)
  for (const server of [
    { command: 'npx', args: ['-y', '@scope/pkg'] }, { command: 'uvx', args: ['tool'] }, { command: 'python3', args: ['-m', 'srv'] },
    { command: '/usr/local/bin/node', args: ['/abs/srv.js'] }, { command: '~/bin/srv' }, { command: '${HOME}/bin/srv' },
    { type: 'http', url: 'https://x', command: './nope' }, { type: 'sse', url: 'https://x' },
  ]) assert.equal(r(server), server);
  const noDir = { command: './x' };
  assert.equal(SC.resolveServerPaths(noDir, ''), noDir); // no folder: untouched
});

test('office MCP: another project\'s relative stdio server is shared with absolute paths; the session\'s own are untouched', (t) => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-office-rel-')));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, v) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, JSON.stringify(v)); };
  const home = j('home'); const a = j('a'); const b = j('b');
  w(pathT.join(b, 'server.py'), '');
  const rel = { command: './venv/bin/python', args: ['./server.py', './gone.py'] };
  w(pathT.join(home, '.claude.json'), { projects: { [a]: { mcpServers: { mine: rel } }, [b]: { mcpServers: { py: rel } } } });
  w(pathT.join(b, '.mcp.json'), { mcpServers: { tool: { command: 'uvx', args: ['tool'] } } });
  w(pathT.join(b, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });
  const office = { share: true, current: a, projects: [{ name: 'a', dir: a, configDir: null }, { name: 'b', dir: b, configDir: null }] };
  const plan = SC.mcpPlan({ account: { id: 'default', configDir: null }, home, cwd: a, office });
  // same relative config as a's own "mine", but a different server once resolved: added, not deduplicated away
  assert.deepEqual(plan.servers, {
    py: { command: pathT.join(b, 'venv', 'bin', 'python'), args: [pathT.join(b, 'server.py'), './gone.py'] },
    tool: { command: 'uvx', args: ['tool'] },
  });
  assert.deepEqual(plan.own.local, { mine: rel }); // Claude Code runs the session's own servers in its folder
  assert.deepEqual(JSON.parse(fsT.readFileSync(pathT.join(home, '.claude.json'), 'utf8')).projects[b].mcpServers.py, rel); // source untouched
});

test('office directory: the current project first and marked, account names, MCP names, short lists', () => {
  const OD = require('../src/office-directory.js');
  const projects = [
    { name: 'a', dir: '/a', account: 'Default' },
    { name: 'b', dir: '/b', account: 'NodesyAI' },
    { name: '', dir: '/x/c', account: '' },
    { name: 'bad' },
  ];
  assert.deepEqual(OD.officeDirectory({ projects, current: '/b', mcp: { '/b': ['onprem', 3, ''], '/a': ['onprem-b'] } }), {
    format: 1,
    projects: [
      { name: 'b', dir: '/b', account: 'NodesyAI', mcp: ['onprem'], current: true },
      { name: 'a', dir: '/a', account: 'Default', mcp: ['onprem-b'] },
      { name: 'c', dir: '/x/c', account: 'Default', mcp: [] },
    ],
  });
  const many = Array.from({ length: 45 }, (_, i) => ({ name: `p${i}`, dir: `/p${i}`, account: 'A' }));
  const d = OD.officeDirectory({ projects: many, current: '/p44', mcp: { '/p44': Array.from({ length: 30 }, (_, i) => `s${i}`) } });
  assert.equal(d.projects.length, OD.PROJECTS_MAX);
  assert.equal(d.more, 5);
  assert.equal(d.projects[0].name, 'p44');
  assert.equal(d.projects[0].mcp.length, OD.MCP_MAX);
  assert.equal(OD.accountName({ id: 'default', label: 'Varsayılan', configDir: null }), 'Default');
  assert.equal(OD.accountName({ id: 'n', label: 'NodesyAI', configDir: '/acc' }), 'NodesyAI');
  // no secret in the directory: only names, folders and server names
  assert.equal(JSON.stringify(d).includes('Bearer'), false);
});

test('office directory: written 0600 and atomically; pruned like the MCP files', (t) => {
  const OD = require('../src/office-directory.js');
  const root = fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-dir-'));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const file = pathT.join(root, 'directory', 'p1.json');
  assert.equal(OD.writeDirectory(file, { format: 1, projects: [] }), file);
  assert.deepEqual(JSON.parse(fsT.readFileSync(file, 'utf8')), { format: 1, projects: [] });
  if (process.platform !== 'win32') assert.equal(fsT.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fsT.readdirSync(pathT.dirname(file)), ['p1.json']);
  assert.deepEqual(SC.pruneMcpFiles(pathT.dirname(file)), ['p1.json']);
});

// --- Enter-restart keeps the conversation; tabs reload when their MCP servers change (contract v3.11)
const MR = require('../src/mcp-reload.js');

test('Enter-restart: the session the tab was in, else --continue for main/worktree tabs, else fresh; argv follows', () => {
  assert.deepEqual(MR.restartOptions({ sessionId: 'abc-123', continues: false }), { sessionId: 'abc-123' });
  assert.deepEqual(MR.restartOptions({ sessionId: null, continues: true }), { resume: true });
  assert.deepEqual(MR.restartOptions({ sessionId: 'bad id; rm', continues: false }), {});
  assert.deepEqual(MR.restartOptions(), {});
  // the start's argv (startPty: sessionId → --resume <id>)
  assert.deepEqual(require('../src/resume.js').claudeArgs(['--plugin-dir', '/p'], ['--resume', 'abc-123'], ''), ['--plugin-dir', '/p', '--resume', 'abc-123']);
});

test('MCP reload: watched files, stat key, a change acts once it has settled', () => {
  const files = MR.watchFiles({ home: '/h', configDirs: [null, '/acc', '/acc'], dirs: ['/p', '/p', '/q'] });
  assert.deepEqual(files, [
    pathT.join('/h', '.claude.json'), pathT.join('/h', '.claude', 'settings.json'),
    pathT.join('/acc', '.claude.json'), pathT.join('/acc', 'settings.json'),
    pathT.join('/p', '.mcp.json'), pathT.join('/p', '.claude', 'settings.local.json'),
    pathT.join('/q', '.mcp.json'), pathT.join('/q', '.claude', 'settings.local.json'),
  ]);
  assert.equal(MR.statKey(['a', 'b'], (f) => (f === 'a' ? { size: 3, mtimeMs: 7 } : null)), '3:7|-');
  let st = { seen: '', pending: '' };
  let r = MR.settle(st, 'k1'); assert.equal(r.settled, false); st = r.state;
  r = MR.settle(st, 'k1'); assert.equal(r.settled, true); st = r.state;
  r = MR.settle(st, 'k1'); assert.equal(r.settled, false); st = r.state; // nothing new
  r = MR.settle(st, 'k2'); assert.equal(r.settled, false); st = r.state; // still being written
  r = MR.settle(st, 'k3'); assert.equal(r.settled, false); st = r.state;
  r = MR.settle(st, 'k3'); assert.equal(r.settled, true);
});

test('MCP reload: a changed idle tab reloads, a busy one waits, an unchanged one or the setting off does nothing', () => {
  const base = { enabled: true, running: true, started: 'a', current: 'b', blocker: '' };
  assert.equal(MR.reloadAction(base), 'reload');
  for (const blocker of ['busy', 'agents', 'shells', 'waiting', 'draft', 'unknown']) assert.equal(MR.reloadAction({ ...base, blocker }), 'wait');
  assert.equal(MR.reloadAction({ ...base, current: 'a' }), 'none');
  assert.equal(MR.reloadAction({ ...base, current: null }), 'none');
  assert.equal(MR.reloadAction({ ...base, enabled: false }), 'none');
  assert.equal(MR.reloadAction({ ...base, running: false }), 'none');
  // the idle rule is the export rule (busy, agents, shells, permission prompt, unsent text)
  const claude = { sessionId: 's', status: 'idle' };
  const office = { stats: {}, workers: [], shells: [] };
  assert.equal(TR.exportBlocker({ running: true, claude, office }), '');
  assert.equal(TR.exportBlocker({ running: true, claude, office, hasDraft: true }), 'draft');
  assert.equal(TR.exportBlocker({ running: true, claude: { ...claude, status: 'busy' }, office }), 'busy');
  assert.equal(TR.exportBlocker({ running: true, claude, office: { ...office, workers: [{ id: 'w' }] } }), 'agents');
  assert.equal(TR.exportBlocker({ running: true, claude, office: { ...office, shells: [{ id: 'x' }] } }), 'shells');
});

test('MCP fingerprint: changes only with the servers a tab loads, never with unrelated ~/.claude.json edits', (t) => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-mcp-print-')));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, v) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, JSON.stringify(v)); };
  const home = j('home'); const a = j('a'); const b = j('b');
  fsT.mkdirSync(a); fsT.mkdirSync(b);
  const cfg = { numStartups: 1, tipsHistory: {}, mcpServers: { u: { url: 'u' } }, projects: { [a]: { mcpServers: { la: { url: 'la' } }, lastCost: 1 }, [b]: { mcpServers: { lb: { url: 'lb' } } } } };
  w(pathT.join(home, '.claude.json'), cfg);
  const office = { share: true, current: a, projects: [{ name: 'a', dir: a, configDir: null, share: false }, { name: 'b', dir: b, configDir: null, share: false }] };
  const print = (o = office) => SC.mcpFingerprint(SC.mcpPlan({ account: { id: 'default', configDir: null }, home, cwd: a, office: o }));
  const p0 = print();
  assert.match(p0, /^[0-9a-f]{64}$/);
  // unrelated edits: startups, tips, costs, history
  w(pathT.join(home, '.claude.json'), { ...cfg, numStartups: 9, tipsHistory: { x: 3 }, projects: { ...cfg.projects, [a]: { ...cfg.projects[a], lastCost: 5, history: ['hi'] } } });
  assert.equal(print(), p0);
  // a user server added (claude mcp add --scope user)
  w(pathT.join(home, '.claude.json'), { ...cfg, mcpServers: { ...cfg.mcpServers, v: { url: 'v' } } });
  const p1 = print();
  assert.notEqual(p1, p0);
  w(pathT.join(home, '.claude.json'), cfg);
  assert.equal(print(), p0);
  // another project's local server (shared in, v3.9) and a token change count too
  w(pathT.join(home, '.claude.json'), { ...cfg, projects: { ...cfg.projects, [b]: { mcpServers: { lb: { url: 'lb', headers: { Authorization: 'Bearer 2' } } } } } });
  assert.notEqual(print(), p0);
  w(pathT.join(home, '.claude.json'), cfg);
  // the folder's .mcp.json and its approval
  w(pathT.join(a, '.mcp.json'), { mcpServers: { pm: { command: 'x' } } });
  const p2 = print();
  assert.notEqual(p2, p0);
  w(pathT.join(a, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['pm'], permissions: { allow: [] } });
  const p3 = print();
  assert.notEqual(p3, p2);
  w(pathT.join(a, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['pm'], permissions: { allow: ['Bash(ls)'] } });
  assert.equal(print(), p3); // permissions are not MCP
  // the sharing setting
  assert.notEqual(print({ ...office, share: false }), p3);
});

// --- interrupted work (src/resume.js)
test('yarım iş: işaretler state.json\'dan okunur, garip olanlar ve olmayan sekmeler atılır', () => {
  const R = require('../src/resume.js');
  assert.deepEqual(R.normalizeInterrupted(undefined), {});
  assert.deepEqual(R.normalizeInterrupted([]), {});
  assert.deepEqual(R.normalizeInterrupted('x'), {});
  assert.deepEqual(R.normalizeInterrupted({ a: 'sid-1', 'a:2': 42, b: '../x' }), { a: 'sid-1', 'a:2': '', b: '' });
  assert.deepEqual(R.normalizeInterrupted({ a: 'sid-1', gone: 's' }, ['a', 'a:2']), { a: 'sid-1' });
});

test('yarım iş: meşgul mü (claude pid dosyası önce, yoksa ofis dosyasının isBossBusy\'si)', () => {
  const { isTurnBusy } = require('../src/resume.js');
  assert.equal(isTurnBusy({ claude: { status: 'busy' } }), true);
  assert.equal(isTurnBusy({ claude: { status: 'waiting' } }), true);
  assert.equal(isTurnBusy({ claude: { status: 'idle' }, office: { stats: { isBossBusy: true } } }), false, 'a killed claude\'s stale office file does not count');
  assert.equal(isTurnBusy({ claude: {}, office: { stats: { isBossBusy: true } } }), true);
  assert.equal(isTurnBusy({ claude: undefined, office: { stats: { isBossBusy: false } } }), false);
  assert.equal(isTurnBusy({ office: { endedAt: 1, stats: { isBossBusy: true } } }), false);
  assert.equal(isTurnBusy({}), false);
});

test('yarım iş: meşgulken işaretlenir, tur bitince silinir; değişiklik yoksa aynı nesne', () => {
  const { nextInterrupted, clearInterrupted } = require('../src/resume.js');
  const none = {};
  assert.equal(nextInterrupted(none, 'p', { busy: false }), none);
  const a = nextInterrupted(none, 'p', { busy: true });
  assert.deepEqual(a, { p: '' });
  assert.deepEqual(none, {}, 'not mutated');
  const b = nextInterrupted(a, 'p', { busy: true, sessionId: 'abc-1' });
  assert.deepEqual(b, { p: 'abc-1' });
  assert.equal(nextInterrupted(b, 'p', { busy: true, sessionId: 'abc-1' }), b);
  assert.equal(nextInterrupted(b, 'p', { busy: true }), b, 'a known session id is kept');
  assert.deepEqual(nextInterrupted(b, 'p', { busy: true, sessionId: '$(rm)' }), { p: 'abc-1' }, 'odd ids are ignored');
  const c = nextInterrupted(b, 'p:2', { busy: true, sessionId: 'def' });
  assert.deepEqual(c, { p: 'abc-1', 'p:2': 'def' });
  assert.deepEqual(nextInterrupted(c, 'p', { busy: false }), { 'p:2': 'def' });
  assert.deepEqual(clearInterrupted(c, ['p', 'p:2', 'x']), {});
  assert.equal(clearInterrupted(c, ['x']), c);
});

test('yarım iş: açılışta yalnız iki ayar da açıkken ve var olan sekmeler devam eder', () => {
  const { resumeTargets } = require('../src/resume.js');
  const m = { a: 's1', 'a:2': '', gone: 's3' };
  assert.deepEqual(resumeTargets(m, ['a', 'a:2', 'b'], { resume: true, resumeWork: true }), ['a', 'a:2']);
  assert.deepEqual(resumeTargets(m, ['a', 'b'], {}), ['a'], 'both default on');
  assert.deepEqual(resumeTargets(m, ['a'], { resume: false, resumeWork: true }), []);
  assert.deepEqual(resumeTargets(m, ['a'], { resume: true, resumeWork: false }), []);
  assert.deepEqual(resumeTargets({}, ['a'], {}), []);
});

test('yarım iş: istem tek satır, cmd.exe özel karakterleri yok, - ile başlamaz', () => {
  const { promptArg, RESUME_PROMPT } = require('../src/resume.js');
  assert.equal(promptArg(RESUME_PROMPT), RESUME_PROMPT, 'the real prompt needs no change');
  assert.ok(RESUME_PROMPT.length > 80 && !/["%!^\n]/.test(RESUME_PROMPT));
  assert.equal(promptArg('a\nb\r\n\tc'), 'a b c');
  assert.equal(promptArg('say "hi" 100% now! ^x'), 'say hi 100 now x');
  assert.equal(promptArg('--help me'), 'help me');
  assert.equal(promptArg(' - x'), 'x');
  assert.equal(promptArg(undefined), '');
});

test('yarım iş: istem yalnız devam ederken, devam argümanlarından sonra en sona eklenir', () => {
  const { claudeArgs, RESUME_PROMPT } = require('../src/resume.js');
  const base = ['--plugin-dir', '/p', '--mcp-config', '/m.json', '--settings', '{"a":1}'];
  assert.deepEqual(claudeArgs(base, [], RESUME_PROMPT), base, 'a fresh start gets no prompt');
  assert.deepEqual(claudeArgs(base, ['--continue']), [...base, '--continue']);
  assert.deepEqual(claudeArgs(base, ['--continue'], RESUME_PROMPT), [...base, '--continue', RESUME_PROMPT]);
  assert.deepEqual(claudeArgs(base, ['--resume', 'abc'], RESUME_PROMPT), [...base, '--resume', 'abc', RESUME_PROMPT]);
  assert.deepEqual(claudeArgs(base, ['--resume', 'abc'], '"%!'), [...base, '--resume', 'abc'], 'nothing left: no empty argument');
});

test('yarım iş: macOS/Linux kabuğu istemi tek argüman olarak aynen geçirir ("$@")', { skip: process.platform === 'win32' }, () => {
  const { execFileSync } = require('child_process');
  const { claudeArgs, RESUME_PROMPT } = require('../src/resume.js');
  const args = claudeArgs(['--settings', '{"statusLine":{"command":"x $HOME `id`"}}'], ['--resume', 'abc-1'], RESUME_PROMPT);
  // the same shape as startPty: $SHELL -c '<cmd>' claude ...args; printf stands in for claude
  const out = execFileSync('/bin/sh', ['-c', 'exec printf "%s\\0" "$@"', 'claude', ...args], { encoding: 'utf8' });
  assert.deepEqual(out.split('\0').slice(0, -1), args);
});

test('yarım iş: Windows — claude.exe argümanları olduğu gibi, claude.cmd satırında istem tırnak içinde tek parça', () => {
  const OSw = require('../src/platform.js');
  const { claudeArgs, RESUME_PROMPT } = require('../src/resume.js');
  const args = claudeArgs(['--settings', 'C:\\u\\s.json'], ['--resume', 'abc-1'], RESUME_PROMPT);
  const exe = OSw.windowsCommand('C:\\bin\\claude.exe', args, {});
  assert.equal(exe.verbatim, false);
  assert.deepEqual(exe.args, args);
  const cmd = OSw.windowsCommand('C:\\npm\\claude.cmd', args, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(cmd.verbatim, true);
  assert.equal(cmd.args[3], `"C:\\npm\\claude.cmd --settings C:\\u\\s.json --resume abc-1 "${RESUME_PROMPT}""`);
  // inside the quotes cmd.exe leaves (), &, | alone; the prompt has no " % ! ^ that it would still act on
  assert.ok(!/["%!^]/.test(RESUME_PROMPT));
});

// --- "Resume unfinished work" (contract v3.8): the last turn of a transcript, and what each tab gets
const jl = (...entries) => entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
const uPrompt = (text) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const aMsg = (stop, content = [{ type: 'text', text: 'ok' }]) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', stop_reason: stop, content } });
const toolResult = { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } };
const noise = [
  { type: 'system', subtype: 'turn_duration', isSidechain: false, isMeta: false },
  { type: 'last-prompt' }, { type: 'cost-state' }, { type: 'attachment', isSidechain: false }, { type: 'summary', summary: 'x' },
  { type: 'file-history-snapshot' }, { type: 'permission-mode' },
  { type: 'system', subtype: 'local_command', content: '<local-command-stdout>hi</local-command-stdout>' },
];

test('yarım iş butonu: transkriptin son turu', () => {
  const { transcriptState } = require('../src/resume.js');
  // end_turn: done, whatever bookkeeping follows it
  assert.equal(transcriptState(jl(uPrompt('fix it'), aMsg('tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]), toolResult, aMsg('end_turn'), ...noise)), 'finished');
  // a tool call waiting for its result
  assert.equal(transcriptState(jl(uPrompt('fix it'), aMsg('tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]), ...noise)), 'unfinished');
  // a tool result the model never answered
  assert.equal(transcriptState(jl(uPrompt('fix it'), aMsg('tool_use'), toolResult, { type: 'attachment' })), 'unfinished');
  // a prompt the model never answered (string or blocks; an image alone is a prompt too)
  assert.equal(transcriptState(jl(aMsg('end_turn'), uPrompt('next step'), ...noise)), 'unfinished');
  assert.equal(transcriptState(jl(aMsg('end_turn'), uPrompt([{ type: 'text', text: 'next' }]))), 'unfinished');
  assert.equal(transcriptState(jl(aMsg('end_turn'), uPrompt([{ type: 'image', source: {} }]))), 'unfinished');
  // an assistant message cut off while streaming (no stop_reason)
  assert.equal(transcriptState(jl(uPrompt('go'), aMsg(null))), 'unfinished');
  // stop_sequence (an API error message) ends the turn
  assert.equal(transcriptState(jl(uPrompt('go'), aMsg('stop_sequence'))), 'finished');
  // the user interrupted on purpose: not unfinished (both forms Claude Code writes)
  assert.equal(transcriptState(jl(uPrompt('go'), aMsg('tool_use'), toolResult, uPrompt([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))), 'finished');
  assert.equal(transcriptState(jl(uPrompt('go'), aMsg(null), uPrompt('[Request interrupted by user]'), ...noise)), 'finished');
  // a background task's notification the model never saw: unfinished
  assert.equal(transcriptState(jl(aMsg('end_turn'), uPrompt('<task-notification> <task-id>a1</task-id> done </task-notification>'))), 'unfinished');
});

test('yarım iş butonu: yan zincir, meta, özet ve yerel komut satırları sayılmaz', () => {
  const { transcriptState } = require('../src/resume.js');
  const side = { ...aMsg('tool_use'), isSidechain: true };
  const sideUser = { ...toolResult, isSidechain: true };
  assert.equal(transcriptState(jl(uPrompt('go'), aMsg('end_turn'), side, sideUser)), 'finished');
  assert.equal(transcriptState(jl(uPrompt('go'), aMsg('end_turn'), { ...uPrompt('Caveat: local'), isMeta: true })), 'finished');
  assert.equal(transcriptState(jl(aMsg('end_turn'), uPrompt('<command-name>/office</command-name>'), uPrompt('<local-command-stdout>ok</local-command-stdout>'))), 'finished');
  assert.equal(transcriptState(jl(aMsg('end_turn'), { ...uPrompt('This session is being continued…'), isCompactSummary: true })), 'finished');
  // a cut first line (tail read) and broken lines are skipped; nothing that counts → none
  assert.equal(transcriptState('"stop_reason":"end_turn"}}\n' + jl(aMsg('tool_use'))), 'unfinished');
  assert.equal(transcriptState(jl(...noise, side)), 'none');
  assert.equal(transcriptState(''), 'none');
});

test('yarım iş butonu: dosyanın yalnız sonu okunur; uzun son satırda daha fazlası', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { transcriptFileState } = require('../src/resume.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-unfinished-'));
  try {
    const f = path.join(dir, 's.jsonl');
    // a long history before the end: only the tail decides
    fs.writeFileSync(f, jl(...Array.from({ length: 3000 }, (_, i) => (i % 2 ? aMsg('end_turn') : uPrompt('x'.repeat(50)))), uPrompt('last'), aMsg('tool_use')));
    assert.equal(transcriptFileState(f), 'unfinished');
    // the last counting line is longer than the first tail step (a big tool result): read on
    fs.writeFileSync(f, jl(uPrompt('go'), aMsg('end_turn'), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(200 * 1024) }] } }, { type: 'last-prompt' }));
    assert.equal(transcriptFileState(f), 'unfinished');
    fs.writeFileSync(f, jl(uPrompt('go'), aMsg('end_turn'), { type: 'attachment', big: 'z'.repeat(200 * 1024) }));
    assert.equal(transcriptFileState(f), 'finished');
    assert.equal(transcriptFileState(path.join(dir, 'missing.jsonl')), 'none');
    assert.equal(transcriptFileState(null), 'none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('yarım iş butonu: hangi sekmeye ne yapılır', () => {
  const { unfinishedActions } = require('../src/resume.js');
  const r = unfinishedActions([
    { id: 'done', running: true, sessionId: 's1', transcript: 'finished', continues: true },
    { id: 'busy', running: true, busy: true, marked: true, sessionId: 's2', transcript: 'unfinished', continues: true },
    { id: 'idle', running: true, sessionId: 's3', transcript: 'unfinished', continues: true },
    { id: 'draft', running: true, draft: true, sessionId: 's4', transcript: 'unfinished', continues: true },
    { id: 'lazy', running: false, sessionId: 's5', transcript: 'unfinished', continues: true },
    { id: 'marked', running: false, marked: true, markSid: 's6', sessionId: 'other', transcript: 'finished', continues: true },
    { id: 'marked-nosid', running: false, marked: true, markSid: '', transcript: 'none', continues: true },
    { id: 'same-folder-nosid', running: false, marked: true, markSid: '', transcript: 'none', continues: false },
    { id: 'nosession', running: false, sessionId: '', transcript: 'unfinished', continues: true },
    { id: 'bad-sid', running: false, sessionId: '--evil', transcript: 'unfinished', continues: true },
  ]);
  assert.deepEqual(r.actions, [
    { id: 'idle', how: 'type', sessionId: 's3' },
    { id: 'lazy', how: 'start', sessionId: 's5' },
    { id: 'marked', how: 'start', sessionId: 's6' },
    { id: 'marked-nosid', how: 'start', sessionId: '' },
  ]);
  assert.deepEqual(r.skipped, ['draft']);
  assert.deepEqual(unfinishedActions([]), { actions: [], skipped: [] });
});

test('yarım iş butonu: istem tek satır, köşeli yapıştırma içinde; Enter ayrı gönderilir', () => {
  const { typedPrompt, UNFINISHED_PROMPT, claudeArgs, promptArg } = require('../src/resume.js');
  const typed = typedPrompt(UNFINISHED_PROMPT);
  assert.ok(typed.startsWith('\x1b[200~') && typed.endsWith('\x1b[201~'));
  assert.ok(!/[\r\n]/.test(typed));
  assert.equal(typedPrompt('a\r\nb\x1b[201~c'), '\x1b[200~a b [201~c\x1b[201~');
  assert.equal(promptArg(UNFINISHED_PROMPT), UNFINISHED_PROMPT);
  assert.ok(!/["%!^]/.test(UNFINISHED_PROMPT));
  assert.deepEqual(claudeArgs(['--x'], ['--resume', 's1'], UNFINISHED_PROMPT), ['--x', '--resume', 's1', UNFINISHED_PROMPT]);
});

// ---- token usage per project (contract v3.13, src/token-usage.js)
const TU = require('../src/token-usage.js');
const tuFs = require('fs');
const tuPath = require('path');
const tuOs = require('os');

/** One transcript line of an assistant response. */
function aLine({ id = 'msg_1', req = 'req_1', t = '2026-10-13T10:00:00.000Z', model = 'claude-opus-5-5', input = 10, w5 = 100, w1 = 0, read = 1000, output = 50, side = false, cc = true } = {}) {
  const usage = { input_tokens: input, cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: read, output_tokens: output };
  if (cc) usage.cache_creation = { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 };
  return JSON.stringify({ type: 'assistant', timestamp: t, requestId: req, isSidechain: side, message: { id, model, role: 'assistant', usage, content: [] } });
}

test('token kullanımı: satır okuma, 5 dk / 1 sa ayrımı, sentetik ve kullanıcı satırları atlanır', () => {
  const r = TU.parseLine(aLine({ w5: 30, w1: 70 }));
  assert.deepEqual({ ...r }, { key: 'msg_1|req_1', t: Date.parse('2026-10-13T10:00:00.000Z'), model: 'claude-opus-5-5', sub: false, input: 10, w5: 30, w1: 70, read: 1000, output: 50 });
  // no cache_creation split: every write counts as 5 minutes
  const old = TU.parseLine(aLine({ w5: 40, w1: 0, cc: false }));
  assert.equal(old.w5, 40);
  assert.equal(old.w1, 0);
  assert.equal(TU.parseLine(aLine({ model: '<synthetic>' })), null);
  assert.equal(TU.parseLine(JSON.stringify({ type: 'user', timestamp: '2026-10-13T10:00:00Z', message: { usage: {} } })), null);
  assert.equal(TU.parseLine('{"type":"assistant","usage" broken'), null);
  assert.equal(TU.parseLine(aLine({ side: true })).sub, true);
});

test('token kullanımı: fiyat tablosu ve tam fiyat karşılığı', () => {
  assert.deepEqual(TU.priceOf('claude-opus-5-5'), { input: 4, read: 0.05 });
  assert.deepEqual(TU.priceOf('claude-opus-5[1m]'), { input: 5, read: 0.1 });
  assert.deepEqual(TU.priceOf('claude-fable-5-1'), { input: 10, read: 0.025 });
  assert.deepEqual(TU.priceOf('claude-haiku-4-5-20251001'), { input: 1, read: 0.1 });
  assert.deepEqual(TU.priceOf('something-new'), { input: 5, read: 0.1 });
  assert.deepEqual(TU.WEIGHTS, { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 });
  // opus 5: 1000 input + 1000×1.25 + 1000×2 + 10000×0.1 + 100×5 = 5750 full-price tokens, $5/M
  const w = TU.weigh({ model: 'claude-opus-5', input: 1000, w5: 1000, w1: 1000, read: 10000, output: 100 });
  assert.equal(Math.round(w.fpt), 5750);
  assert.ok(Math.abs(w.usd - 5750 * 5 / 1e6) < 1e-12);
  assert.ok(Math.abs(w.cost.read - 1000 * 5 / 1e6) < 1e-12);
});

test('token kullanımı: Command Code kaydı (v3.25) — camelCase usage, kendi $ karşılığı, başlıksız klasör adı', () => {
  const line = JSON.stringify({
    type: 'message', id: 'cc1', timestamp: '2026-10-19T19:39:39.879Z', model: 'z-ai/glm-5.3-flash',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    usage: { inputTokens: 20434, outputTokens: 3, cacheReadTokens: 8704, cacheWriteTokens: 0, costUsd: 0.00202212 },
  });
  const r = TU.parseLine(line);
  assert.deepEqual({ ...r }, {
    key: 'cc1|', t: Date.parse('2026-10-19T19:39:39.879Z'), model: 'z-ai/glm-5.3-flash', sub: false,
    input: 20434, w5: 0, w1: 0, read: 8704, output: 3, usd: 0.00202212,
  });
  // a user line or a message without usage or model reads nothing
  assert.equal(TU.parseLine(JSON.stringify({ type: 'message', timestamp: '2026-10-19T19:39:39.879Z', message: { role: 'user', content: [] }, usage: {} })), null);
  assert.equal(TU.parseLine(JSON.stringify({ type: 'message', id: 'x', timestamp: '2026-10-19T19:39:39.879Z', message: { role: 'assistant', content: [] } })), null);
  assert.equal(TU.parseLine(JSON.stringify({ type: 'message', id: 'x', timestamp: '2026-10-19T19:39:39.879Z', message: { role: 'assistant', content: [] }, usage: {}, model: '' })), null);
  // the CLI's own $ wins: $ exact, the kind shares scaled to it, $ full-price via the fallback table
  const w = TU.weigh(r);
  assert.ok(Math.abs(w.usd - 0.00202212) < 1e-15);
  assert.ok(Math.abs(w.cost.input + w.cost.write5m + w.cost.write1h + w.cost.read + w.cost.output - w.usd) < 1e-15);
  assert.ok(Math.abs(w.fpt - 0.00202212 / (5 / 1e6)) < 1e-15);
  // a $0 record falls back to the price estimate
  assert.ok(TU.weigh({ ...r, usd: 0 }).usd > 0);
  // Command Code names its transcript folders without the leading dash
  assert.deepEqual(TU.projectFolders(['private-tmp', 'private-tmp-wt-1', 'other'], ['/private/tmp'], [], TU.ccSlugOf),
    ['private-tmp', 'private-tmp-wt-1']);
  assert.deepEqual(TU.projectFolders(['-private-tmp', 'other'], ['/private/tmp'], []), ['-private-tmp']); // Claude Code's slug
});

test('token kullanımı: aynı yanıt (message.id, requestId) bir kez sayılır, en çok çıktılı kopya kalır', () => {
  const m = new Map();
  for (const out of [5, 50, 20]) TU.keep(m, TU.parseLine(aLine({ output: out })));
  TU.keep(m, TU.parseLine(aLine({ req: 'req_2', output: 7 })));
  assert.equal(m.size, 2);
  assert.equal(m.get('msg_1|req_1').output, 50);
  // across files: the sub-agent copy marks it as a sub-agent's
  const a = new Map([['k', { key: 'k', output: 9, sub: false }]]);
  const b = new Map([['k', { key: 'k', output: 3, sub: true }]]);
  const merged = TU.mergeRecords([a, b]);
  assert.equal(merged.size, 1);
  assert.deepEqual(merged.get('k'), { key: 'k', output: 9, sub: true });
});

test('token kullanımı: bugün / 7 gün / eklendiğinden beri, saatlik kovalar, ana oturum ve alt ajanlar, modeller', () => {
  const now = new Date(2026, 9, 13, 15, 30).getTime();
  const H = 3600e3;
  const rec = (key, t, extra = {}) => ({ key, t, model: 'claude-opus-5', sub: false, input: 100, w5: 0, w1: 0, read: 0, output: 0, ...extra });
  const recs = new Map([
    ['a', rec('a', now - 10 * 60e3)],                                      // this hour
    ['b', rec('b', now - 2 * H, { sub: true, model: 'claude-haiku-5-5' })], // today, 13:xx, sub-agent
    ['c', rec('c', TU.startOfDay(now) - H)],                               // yesterday 23:xx: last 24 h, not today
    ['d', rec('d', now - 3 * 24 * H)],                                     // this week
    ['e', rec('e', now - 20 * 24 * H)],                                    // before the week
    ['f', rec('f', now - 40 * 24 * H)],                                    // before the project was added
  ]);
  const r = TU.summarize(recs, { now, since: now - 30 * 24 * H });
  assert.equal(r.today.total, 200);
  assert.equal(r.week.total, 400);
  assert.equal(r.all.total, 500);
  assert.equal(r.today.main.total, 100);
  assert.equal(r.today.sub.total, 100);
  assert.equal(r.today.sub.requests, 1);
  assert.deepEqual(r.today.models.map((m) => m.model), ['claude-opus-5', 'claude-haiku-5-5']); // by $
  assert.equal(r.hours.length, 24);
  assert.equal(r.hours[23].at, new Date(2026, 9, 13, 15, 0).getTime());
  assert.equal(r.hours[23].total, 100);
  assert.equal(r.hours[21].total, 100);
  assert.equal(r.hours.reduce((n, h) => n + h.total, 0), 300);
  assert.ok(Math.abs(r.today.fpt - 200) < 1e-9); // input only: full price
  assert.equal(r.firstAt, now - 20 * 24 * H);
  // without `since`: everything in the transcripts
  assert.equal(TU.summarize(recs, { now }).all.total, 600);
  assert.equal(TU.summarize(recs, { now }).since, null);
  assert.deepEqual(TU.brief(r), { usd: r.today.usd, total: 200, pct: 1 });
});

test('token kullanımı: projenin klasörleri (sekmeler, worktree’ler; başka projenin klasörü değil)', () => {
  const names = ['-r-shop', '-r-shop-wt-2', '-r-shop--claude-worktrees-x', '-r-shop-api', '-r-shop-wt-other', '-r-notes', '-tmp-tab'];
  assert.deepEqual(TU.projectFolders(names, ['/r/shop', '/tmp/tab'], ['/r/shop-api', '/r/shop-wt-other']),
    ['-r-shop', '-r-shop-wt-2', '-r-shop--claude-worktrees-x', '-tmp-tab']);
  assert.equal(TU.slugOf('/Users/a/.claude'), '-Users-a--claude');
});

test('token kullanımı: artımlı okuma, yarım satır, alt ajan dosyası, kısalan ve değişen dosya', async () => {
  const root = tuFs.mkdtempSync(tuPath.join(tuOs.tmpdir(), 'ao-tokens-'));
  const dir = tuPath.join(root, '-r-shop');
  tuFs.mkdirSync(tuPath.join(dir, 'sess1', 'subagents'), { recursive: true });
  const main = tuPath.join(dir, 'sess1.jsonl');
  const sub = tuPath.join(dir, 'sess1', 'subagents', 'agent-a1.jsonl');
  const user = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(5000) } });
  tuFs.writeFileSync(main, `${user}\n${aLine({ id: 'm1', output: 5 })}\n${aLine({ id: 'm1', output: 40 })}\n`);
  tuFs.writeFileSync(sub, `${aLine({ id: 's1', req: 'rs1' })}\n`);
  const sc = new TU.UsageScanner({ chunkSize: 1024 }); // small chunks: lines cross chunk borders
  let recs = await sc.scanFolders([dir]);
  assert.equal(recs.size, 2);
  assert.equal(recs.get('m1|req_1').output, 40);
  assert.equal(recs.get('s1|rs1').sub, true);
  assert.equal(recs.get('m1|req_1').sub, false);
  const first = sc.bytesRead;
  assert.equal(first, tuFs.statSync(main).size + tuFs.statSync(sub).size);

  // nothing new: nothing is read
  await sc.scanFolders([dir]);
  assert.equal(sc.bytesRead, first);

  // a half-written line is not counted and is read again once finished
  const next = aLine({ id: 'm2', req: 'req_9', output: 7 });
  tuFs.appendFileSync(main, next.slice(0, 40));
  recs = await sc.scanFolders([dir]);
  assert.equal(recs.size, 2);
  tuFs.appendFileSync(main, next.slice(40) + '\n');
  const before = sc.bytesRead;
  recs = await sc.scanFolders([dir]);
  assert.equal(recs.size, 3);
  assert.equal(sc.bytesRead - before, next.length + 1); // only the new line (from its start)

  // truncated (smaller than what was read): read again from the start
  tuFs.writeFileSync(main, `${aLine({ id: 'm9', req: 'r9', output: 1 })}\n`);
  recs = await sc.scanFolders([dir]);
  assert.deepEqual([...recs.keys()].sort(), ['m9|r9', 's1|rs1']);

  // replaced by another file (rotation, same or larger size): read again from the start
  const repl = `${aLine({ id: 'mA', req: 'rA', output: 1 })}\n${aLine({ id: 'mB', req: 'rB', output: 1 })}\n`;
  tuFs.writeFileSync(main + '.new', repl);
  tuFs.renameSync(main + '.new', main);
  recs = await sc.scanFolders([dir]);
  assert.deepEqual([...recs.keys()].sort(), ['mA|rA', 'mB|rB', 's1|rs1']);

  // a deleted transcript is forgotten
  tuFs.rmSync(sub);
  recs = await sc.scanFolders([dir]);
  assert.deepEqual([...recs.keys()].sort(), ['mA|rA', 'mB|rB']);

  // a file last written before `since` is not read at all
  const sc2 = new TU.UsageScanner();
  const recs2 = await sc2.scanFolders([dir], { since: Date.now() + 3600e3 });
  assert.equal(recs2.size, 0);
  assert.equal(sc2.bytesRead, 0);
  tuFs.rmSync(root, { recursive: true, force: true });
});

// ---- costliest sub-agent runs and the fixed prefix (contract v3.21)
/** An assistant line with content blocks (one line per block, as Claude Code writes them). */
function bLine({ id, req, t, model = 'claude-opus-5-5', input = 0, w5 = 0, read = 0, output = 10, block = { type: 'text', text: 'x' }, side = false }) {
  const usage = { input_tokens: input, cache_creation_input_tokens: w5, cache_read_input_tokens: read, output_tokens: output, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: 0 } };
  return JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), requestId: req, isSidechain: side, message: { id, model, role: 'assistant', usage, content: [block] } });
}
/** n steps of a run: the first writes the prefix, every later one reads it (plus `grow` per step) and calls a tool. */
function runLines(tag, n, { t0, prefix = 1000, grow = 100, model, side = false }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = { id: `${tag}-m${i}`, req: `${tag}-r${i}`, t: t0 + i * 1000, model, side };
    const usage = i === 0 ? { input: 10, w5: prefix - 10 } : { input: 1, w5: grow, read: prefix + (i - 1) * grow };
    out.push(bLine({ ...base, ...usage, output: 5 }));                                                       // thinking/text block
    out.push(bLine({ ...base, ...usage, output: 20, block: { type: 'tool_use', id: `${tag}-tu${i}`, name: 'Read', input: {} } })); // the tool call
  }
  return out;
}

test('alt ajanlar (v3.21): adım, araç, açıklama, en pahalı 10, 40 adım üstü payı ve sabit önek', async () => {
  const root = tuFs.mkdtempSync(tuPath.join(tuOs.tmpdir(), 'ao-agents-'));
  const dir = tuPath.join(root, '-r-shop');
  const subs = tuPath.join(dir, 'sess1', 'subagents');
  tuFs.mkdirSync(subs, { recursive: true });
  const now = new Date(2026, 9, 13, 15, 30).getTime();
  const t0 = now - 3600e3; // today
  const user = (text) => JSON.stringify({ type: 'user', isSidechain: true, timestamp: new Date(t0).toISOString(), message: { role: 'user', content: text } });
  // the boss: 3 steps, prefix 5000
  tuFs.writeFileSync(tuPath.join(dir, 'sess1.jsonl'), runLines('boss', 3, { t0, prefix: 5000 }).join('\n') + '\n');
  // a long agent with meta.json: 45 steps
  tuFs.writeFileSync(tuPath.join(subs, 'agent-long.jsonl'), [user('ignored prompt'), ...runLines('long', 45, { t0, side: true })].join('\n') + '\n');
  tuFs.writeFileSync(tuPath.join(subs, 'agent-long.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Audit the parser' }));
  // a short agent without meta: its label is the first prompt line; haiku
  tuFs.writeFileSync(tuPath.join(subs, 'agent-short.jsonl'),
    [user('\n  Find the config loader\nthen report'), ...runLines('short', 4, { t0, model: 'claude-haiku-5-5', side: true })].join('\n') + '\n');
  // an agent from 3 days ago: only in 7 days
  tuFs.writeFileSync(tuPath.join(subs, 'agent-old.jsonl'), runLines('old', 2, { t0: now - 3 * 86400e3, side: true }).join('\n') + '\n');

  const sc = new TU.UsageScanner({ chunkSize: 512 });
  const recs = await sc.scanFolders([dir]);
  const sessions = sc.sessions([dir]);
  assert.equal(sessions.length, 4);
  const long = sessions.find((x) => x.id === 'long');
  assert.equal(long.sub, true);
  assert.equal(long.session, 'sess1');
  assert.equal(long.label, 'Audit the parser');
  assert.equal(long.agentType, 'general-purpose');
  assert.equal(long.steps, 45); // one request per step, though written as two lines
  assert.equal(long.tools, 45);
  assert.equal(long.prefix, 1000);
  assert.equal(long.tokens.output, 45 * 20); // the copy with the most output
  const short = sessions.find((x) => x.id === 'short');
  assert.equal(short.label, 'Find the config loader');
  assert.equal(short.model, 'claude-haiku-5-5');
  assert.equal(sessions.find((x) => x.id === 'sess1').sub, false);

  const r = TU.summarize(recs, { now, sessions });
  const a = r.agents.today;
  assert.equal(a.count, 2);
  assert.deepEqual(a.top.map((x) => x.id), ['long', 'short']); // by $
  assert.equal(a.steps, 49);
  assert.equal(a.avgSteps, 24.5);
  assert.equal(a.long.limit, 40);
  assert.equal(a.long.count, 1);
  const wantShare = long.usd / (long.usd + short.usd);
  assert.ok(Math.abs(a.long.share - wantShare) < 1e-12);
  const top = a.top[0];
  assert.deepEqual(Object.keys(top).sort(), ['agentType', 'at', 'id', 'label', 'model', 'session', 'steps', 'tokens', 'tools', 'usd']);
  assert.equal(top.at, t0);
  assert.equal(r.agents.week.count, 3);
  assert.equal(r.agents.all.count, 3);

  // prefix: boss 5000 × 3 steps, but it only read 2 × 5000 + 100 → capped at its reads
  const px = r.prefix.today;
  assert.equal(px.main.sessions, 1);
  assert.equal(px.main.avg, 5000);
  assert.equal(px.main.reads, 5000 + 5100);
  assert.equal(px.main.prefixReads, 5000 + 5100);
  assert.equal(px.sub.sessions, 2);
  assert.equal(px.sub.avg, 1000);
  const readsOf = (n) => { let x = 0; for (let i = 1; i < n; i++) x += 1000 + (i - 1) * 100; return x; };
  assert.equal(px.sub.reads, readsOf(45) + readsOf(4));
  assert.equal(px.sub.prefixReads, 1000 * 45 + readsOf(4)); // the short run read less than 4 × its prefix: capped
  assert.ok(Math.abs(px.share - px.prefixReads / px.reads) < 1e-12);
  assert.equal(px.sessions, 3);
  assert.equal(r.prefix.week.sessions, 4);

  // a session that started before the window counts only its requests inside it
  const part = TU.prefixStats([long], t0 + 40 * 1000, now);
  assert.equal(part.requests, 5);

  // the panel's row (sidebar) report has no per-agent detail
  assert.equal(TU.summarize(recs, { now }).agents, undefined);

  // incremental: new steps refresh the cached summary; files that did not change keep theirs
  const shortBefore = short;
  tuFs.appendFileSync(tuPath.join(subs, 'agent-long.jsonl'), runLines('long2', 2, { t0: t0 + 60e3, side: true }).join('\n') + '\n');
  const read0 = sc.bytesRead;
  await sc.scanFolders([dir]);
  const again = sc.sessions([dir]);
  assert.equal(again.find((x) => x.id === 'long').steps, 47);
  assert.equal(again.find((x) => x.id === 'long').tools, 47);
  assert.equal(again.find((x) => x.id === 'short'), shortBefore);
  assert.ok(sc.bytesRead - read0 < 4000); // only the appended lines
  tuFs.rmSync(root, { recursive: true, force: true });
});

test('alt ajanlar (v3.21): istem satırı kısaltılır, metin blokları da okunur', () => {
  assert.equal(TU.firstLine('\n\n  hello world  \nmore'), 'hello world');
  assert.equal(TU.firstLine([{ type: 'image' }, { type: 'text', text: 'from block\nx' }]), 'from block');
  assert.equal(TU.firstLine(null), '');
  const long = TU.firstLine('y'.repeat(500));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
});

test('proje eklenme zamanı (v3.13): addProject yazar, normalizeState korur, eskilerde yok', () => {
  const r = P.addProject(empty(), '/p/when', { id: () => 'w', now: () => 1234 });
  assert.equal(r.project.addedAt, 1234);
  const again = P.normalizeState(JSON.parse(JSON.stringify(r.state)));
  assert.equal(again.projects[0].addedAt, 1234);
  const old = P.normalizeState({ projects: [{ id: 'o', dir: '/o', accountId: 'default', addedAt: 'x' }] });
  assert.equal('addedAt' in old.projects[0], false);
});

// ---- a project's Claude Code data follows it to another account (contract v3.16, src/project-data.js)
const PD = require('../src/project-data.js');
const pdFs = require('fs');
const pdOs = require('os');
const pdPath = require('path');

/** A temp home with Default (~/.claude) and accounts A and B, and project folders; every path real (macOS /private). */
function pdSetup() {
  const root = pdFs.realpathSync(pdFs.mkdtempSync(pdPath.join(pdOs.tmpdir(), 'ao-move-')));
  const home = pdPath.join(root, 'home');
  const A = pdPath.join(root, 'accounts', 'a');
  const B = pdPath.join(root, 'accounts', 'b');
  const shop = pdPath.join(root, 'work', 'shop');
  const other = pdPath.join(root, 'work', 'shop-api');
  for (const d of [pdPath.join(home, '.claude'), A, B, shop, other]) pdFs.mkdirSync(d, { recursive: true });
  const put = (file, text) => { pdFs.mkdirSync(pdPath.dirname(file), { recursive: true }); pdFs.writeFileSync(file, text); return file; };
  const read = (file) => { try { return pdFs.readFileSync(file, 'utf8'); } catch { return null; } };
  const slug = (d) => d.replace(/[^a-zA-Z0-9]/g, '-');
  return { root, home, A, B, shop, other, put, read, slug, done: () => pdFs.rmSync(root, { recursive: true, force: true }) };
}
const pdLines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

test('hesap değişince (v3.16): projenin konuşmaları, oturum durumu, istem geçmişi ve .claude.json kaydı yeni hesaba gelir', () => {
  const t = pdSetup();
  const { A, B, shop, other, put, read, slug } = t;
  const sid = '11111111-aaaa-4bbb-8ccc-000000000001';
  const pa = pdPath.join(A, 'projects', slug(shop));
  put(pdPath.join(pa, `${sid}.jsonl`), pdLines({ type: 'user', uuid: 'u1', sessionId: sid }, { type: 'assistant', uuid: 'u2', parentUuid: 'u1' }));
  put(pdPath.join(pa, sid, 'subagents', 'agent-x.jsonl'), pdLines({ type: 'assistant', uuid: 's1' }));
  put(pdPath.join(pa, sid, 'tool-results', 'r1.txt'), 'out');
  put(pdPath.join(A, 'projects', `${slug(shop)}-wt-2`, 'wt-sess.jsonl'), pdLines({ uuid: 'w1' }));
  put(pdPath.join(A, 'projects', slug(other), 'other-sess.jsonl'), pdLines({ uuid: 'o1' }));
  put(pdPath.join(A, 'file-history', sid, 'abc@v1'), 'v1');
  put(pdPath.join(A, 'file-history', 'other-sess', 'x@v1'), 'no');
  put(pdPath.join(A, 'tasks', sid, '1.json'), '{}');
  put(pdPath.join(A, 'todos', `${sid}-agent-${sid}.json`), '[]');
  put(pdPath.join(A, 'session-env', sid, 'sessionstart-hook-0.sh'), 'export TOKEN=x');
  put(pdPath.join(A, 'history.jsonl'), pdLines(
    { display: 'fix the cart', pastedContents: { 1: { id: 1, type: 'text', contentHash: 'abc123' } }, project: shop, sessionId: sid },
    { display: 'api thing', pastedContents: {}, project: other },
  ));
  put(pdPath.join(A, 'paste-cache', 'abc123.txt'), 'pasted');
  put(pdPath.join(A, 'paste-cache', 'zzz.txt'), 'not referenced');
  put(pdPath.join(A, '.credentials.json'), '{"claudeAiOauth":{}}');
  put(pdPath.join(A, 'settings.json'), '{"model":"opus"}');
  put(pdPath.join(A, 'skills', 'mine', 'SKILL.md'), 'x');
  put(pdPath.join(A, '.claude.json'), JSON.stringify({
    userID: 'uid-a', oauthAccount: { emailAddress: 'a@x' }, primaryApiKey: 'sk-a', numStartups: 9,
    projects: {
      [shop]: { allowedTools: ['Bash(npm test)'], hasTrustDialogAccepted: true, mcpServers: { db: { command: 'db' } }, enabledMcpjsonServers: ['x'] },
      [other]: { allowedTools: ['Bash(rm)'] },
    },
  }));
  put(pdPath.join(B, '.claude.json'), JSON.stringify({ userID: 'uid-b', oauthAccount: { emailAddress: 'b@x' }, numStartups: 2, projects: { [shop]: { allowedTools: ['Read'], enabledMcpjsonServers: ['y'], hasTrustDialogAccepted: false } } }));

  const r = PD.moveProjectData({ from: A, to: B, home: t.home, dirs: [shop, pdPath.join(pdPath.dirname(shop), 'shop-wt-2')], otherDirs: [other] });
  const pb = pdPath.join(B, 'projects', slug(shop));
  assert.equal(read(pdPath.join(pb, `${sid}.jsonl`)), read(pdPath.join(pa, `${sid}.jsonl`)));
  assert.equal(read(pdPath.join(pb, sid, 'subagents', 'agent-x.jsonl')) !== null, true);
  assert.equal(read(pdPath.join(pb, sid, 'tool-results', 'r1.txt')), 'out');
  assert.equal(read(pdPath.join(B, 'projects', `${slug(shop)}-wt-2`, 'wt-sess.jsonl')) !== null, true);
  assert.equal(pdFs.existsSync(pdPath.join(B, 'projects', slug(other))), false, 'another project’s folder stays');
  assert.equal(read(pdPath.join(B, 'file-history', sid, 'abc@v1')), 'v1');
  assert.equal(pdFs.existsSync(pdPath.join(B, 'file-history', 'other-sess')), false);
  assert.equal(read(pdPath.join(B, 'tasks', sid, '1.json')), '{}');
  assert.equal(read(pdPath.join(B, 'todos', `${sid}-agent-${sid}.json`)), '[]');
  assert.equal(pdFs.existsSync(pdPath.join(B, 'session-env')), false, 'hook environments are not copied');
  const hist = read(pdPath.join(B, 'history.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(hist.map((h) => h.display), ['fix the cart']);
  assert.equal(read(pdPath.join(B, 'paste-cache', 'abc123.txt')), 'pasted');
  assert.equal(pdFs.existsSync(pdPath.join(B, 'paste-cache', 'zzz.txt')), false);
  // never: logins and the account's own settings
  for (const f of ['.credentials.json', 'settings.json', 'skills']) assert.equal(pdFs.existsSync(pdPath.join(B, f)), false, f);
  const cfg = JSON.parse(read(pdPath.join(B, '.claude.json')));
  assert.equal(cfg.userID, 'uid-b');
  assert.deepEqual(cfg.oauthAccount, { emailAddress: 'b@x' });
  assert.equal('primaryApiKey' in cfg, false);
  assert.equal(cfg.numStartups, 2);
  assert.deepEqual(cfg.projects[shop], {
    allowedTools: ['Read', 'Bash(npm test)'], enabledMcpjsonServers: ['y', 'x'], hasTrustDialogAccepted: true, mcpServers: { db: { command: 'db' } },
  });
  assert.equal(other in cfg.projects, false);
  assert.equal(r.sessions, 2);
  assert.equal(r.config, true);
  assert.equal(r.history, 1);
  // the old account keeps its copy
  assert.equal(pdFs.existsSync(pdPath.join(pa, `${sid}.jsonl`)), true);
  // a second move changes nothing
  const again = PD.moveProjectData({ from: A, to: B, home: t.home, dirs: [shop], otherDirs: [other] });
  assert.deepEqual([again.copied, again.merged, again.history, again.config], [0, 0, 0, false]);
  assert.equal(read(pdPath.join(B, 'history.jsonl')).trim().split('\n').length, 1);
  t.done();
});

test('hesap değişince (v3.16): ortak konuşma birleşir, yenisi kalır, eskisi yenisini ezmez', () => {
  const t = pdSetup();
  const { put, read } = t;
  const a = put(pdPath.join(t.root, 'x', 'a.jsonl'), pdLines({ uuid: '1' }, { uuid: '2' }));
  const b = put(pdPath.join(t.root, 'y', 'a.jsonl'), pdLines({ uuid: '1' }, { uuid: '2' }));
  assert.equal(PD.mergeJsonl(a, b), 'same');
  pdFs.appendFileSync(b, pdLines({ uuid: '3' }));
  assert.equal(PD.mergeJsonl(a, b), 'kept', 'the new account already holds every line');
  assert.equal(read(b), pdLines({ uuid: '1' }, { uuid: '2' }, { uuid: '3' }));
  pdFs.appendFileSync(a, pdLines({ uuid: '3' }, { uuid: '4' }));
  assert.equal(PD.mergeJsonl(a, b), 'replaced', 'continued in the old account: its longer copy wins');
  assert.equal(read(b), read(a));
  pdFs.appendFileSync(b, pdLines({ uuid: '5b' }));
  pdFs.appendFileSync(a, pdLines({ uuid: '5a' }));
  assert.equal(PD.mergeJsonl(a, b), 'joined', 'both went on: a union of the records');
  assert.equal(read(b), pdLines({ uuid: '1' }, { uuid: '2' }, { uuid: '3' }, { uuid: '4' }, { uuid: '5b' }, { uuid: '5a' }));
  // another file: only a newer one replaces it
  const fa = put(pdPath.join(t.root, 'x', 'meta.json'), 'old');
  const fb = put(pdPath.join(t.root, 'y', 'meta.json'), 'new');
  pdFs.utimesSync(fa, new Date(1000), new Date(1000));
  assert.equal(PD.mergeFile(fa, fb), 'older');
  assert.equal(read(fb), 'new');
  pdFs.utimesSync(fa, new Date(), new Date(Date.now() + 60000));
  assert.equal(PD.mergeFile(fa, fb), 'newer');
  assert.equal(read(fb), 'old');
  t.done();
});

test('hesap değişince (v3.16): .claude.json kaydı birleşir; okunamayan dosyaya dokunulmaz; yalnız proje klasörleri', () => {
  assert.deepEqual(PD.mergeEntry({ a: 1, list: ['x'], o: { k: 1 }, hasTrustDialogAccepted: false, lastCost: 2 }, { a: 2, list: ['x', 'y'], o: { k: 9, j: 2 }, hasTrustDialogAccepted: true, lastCost: 5, extra: true }),
    { a: 1, list: ['x', 'y'], o: { k: 1, j: 2 }, hasTrustDialogAccepted: true, lastCost: 2, extra: true });
  const { config, changed } = PD.mergeProjectEntries({ keep: 1 }, { oauthAccount: { e: 1 }, primaryApiKey: 'k', projects: { '/p': { t: 1 }, '/q': { t: 2 } } }, ['/p']);
  assert.equal(changed, true);
  assert.deepEqual(config, { keep: 1, projects: { '/p': { t: 1 } } });
  assert.equal(PD.mergeProjectEntries({ projects: { '/p': { t: 1 } } }, { projects: { '/p': { t: 1 } } }, ['/p']).changed, false);
  const t = pdSetup();
  const from = t.put(pdPath.join(t.A, '.claude.json'), JSON.stringify({ projects: { [t.shop]: { hasTrustDialogAccepted: true } } }));
  const to = t.put(pdPath.join(t.B, '.claude.json'), '{ broken');
  assert.equal(PD.mergeClaudeJson(from, to, [t.shop]), false);
  assert.equal(t.read(to), '{ broken');
  // a new account without .claude.json gets one with only the project's entry (0600)
  pdFs.rmSync(to);
  assert.equal(PD.mergeClaudeJson(from, to, [t.shop]), true);
  assert.deepEqual(JSON.parse(t.read(to)), { projects: { [t.shop]: { hasTrustDialogAccepted: true } } });
  if (process.platform !== 'win32') assert.equal(pdFs.statSync(to).mode & 0o777, 0o600);
  t.done();
});

test('hesap değişince (v3.16): Default’a ve Default’tan; hafıza ~/.claude’da birleşir, hesap klasörüne kopyalanmaz', () => {
  const t = pdSetup();
  const { home, A, B, shop, put, read, slug } = t;
  const claude = pdPath.join(home, '.claude');
  const sid = '22222222-aaaa-4bbb-8ccc-000000000002';
  // account A → Default: ~/.claude/projects and ~/.claude.json
  put(pdPath.join(A, 'projects', slug(shop), `${sid}.jsonl`), pdLines({ uuid: '1' }));
  put(pdPath.join(A, 'projects', slug(shop), 'memory', 'MEMORY.md'), '- [Rule](rule.md) — a rule\n');
  put(pdPath.join(A, 'projects', slug(shop), 'memory', 'rule.md'), 'rule');
  put(pdPath.join(A, '.claude.json'), JSON.stringify({ projects: { [shop]: { hasTrustDialogAccepted: true } } }));
  put(pdPath.join(home, '.claude.json'), JSON.stringify({ userID: 'me', projects: {} }));
  const r = PD.moveProjectData({ from: A, to: null, home, dirs: [shop] });
  assert.equal(read(pdPath.join(claude, 'projects', slug(shop), `${sid}.jsonl`)), pdLines({ uuid: '1' }));
  assert.equal(read(pdPath.join(claude, 'projects', slug(shop), 'memory', 'rule.md')), 'rule', 'merged by memory.js mergeMemory');
  assert.match(read(pdPath.join(claude, 'projects', slug(shop), 'memory', 'MEMORY.md')), /rule\.md/);
  assert.equal(r.memory, 1);
  assert.deepEqual(JSON.parse(read(pdPath.join(home, '.claude.json'))), { userID: 'me', projects: { [shop]: { hasTrustDialogAccepted: true } } });
  // Default → account B: the transcripts go, the memory stays in ~/.claude (every account uses it there)
  const r2 = PD.moveProjectData({ from: null, to: B, home, dirs: [shop] });
  assert.equal(read(pdPath.join(B, 'projects', slug(shop), `${sid}.jsonl`)), pdLines({ uuid: '1' }));
  assert.equal(pdFs.existsSync(pdPath.join(B, 'projects', slug(shop), 'memory')), false);
  assert.equal(JSON.parse(read(pdPath.join(B, '.claude.json'))).projects[shop].hasTrustDialogAccepted, true);
  assert.equal(r2.memory, 0);
  // the same folder on both sides: nothing
  assert.deepEqual(PD.moveProjectData({ from: B, to: B, home, dirs: [shop] }), { folders: 0, copied: 0, merged: 0, sessions: 0, history: 0, config: false, memory: 0 });
  t.done();
});

test('hesap değişince (v3.16): kopyalanan konuşma yaşını korur (--continue en yenisini seçer)', () => {
  const t = pdSetup();
  const { A, B, shop, put, slug } = t;
  const old = put(pdPath.join(A, 'projects', slug(shop), 'old.jsonl'), pdLines({ uuid: '1' }));
  put(pdPath.join(B, 'projects', slug(shop), 'mid.jsonl'), pdLines({ uuid: '2' }));
  pdFs.utimesSync(old, new Date(1e12), new Date(1e12));
  PD.moveProjectData({ from: A, to: B, home: t.home, dirs: [shop] });
  const st = pdFs.statSync(pdPath.join(B, 'projects', slug(shop), 'old.jsonl'));
  assert.equal(Math.round(st.mtimeMs), 1e12);
  assert.equal(TIO.newestSession(shop, B, t.home), 'mid');
  t.done();
});

test('hesap değişince (v3.16): sekme kendi konuşmasında yeniden başlar; yarıda kalan tura devam istemi', () => {
  assert.deepEqual(PD.restartAfterMove({ sessionId: 'abc-1', continues: false }, 'go on'), { sessionId: 'abc-1' });
  assert.deepEqual(PD.restartAfterMove({ sessionId: null, continues: true }, 'go on'), { resume: true });
  assert.deepEqual(PD.restartAfterMove({ sessionId: null, continues: false, busy: true }, 'go on'), {});
  assert.deepEqual(PD.restartAfterMove({ sessionId: 'abc-1', busy: true }, 'go on'), { sessionId: 'abc-1', prompt: 'go on' });
  assert.deepEqual(PD.restartAfterMove({ sessionId: 'bad id!', continues: true }), { resume: true });
});

// --- backup account at the usage limit (v3.17, src/fallback.js)
const FB = require('../src/fallback.js');
const limitEntry = (o = {}) => JSON.stringify({
  type: 'assistant', uuid: 'u2', timestamp: o.timestamp || '2026-10-17T10:00:05.000Z', isApiErrorMessage: true, error: 'rate_limit',
  ...(o.apiError === null ? {} : { apiError: o.apiError || 'usage_limit_reached' }),
  ...(o.info === null ? {} : { apiErrorParams: { rate_limit_info: o.info || { status: 'rejected', resetsAt: 1792252800, rateLimitType: 'five_hour' } } }),
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: o.text || "You've hit your session limit · resets 3pm (Europe/Istanbul)" }] },
});
const userEntry = (text, ts = '2026-10-17T10:00:00.000Z', extra = {}) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra });

test('yedek hesap (v3.17): Claude Code’un limit iletileri tanınır, benzerleri değil', () => {
  for (const s of [
    "You've hit your session limit · resets 3pm (Europe/Istanbul)",
    "You've hit your weekly limit · resets Oct 20, 9am (Europe/Istanbul) · progress saved",
    "You've hit your Opus limit · resets 5pm", "You've hit your usage limit · contact your admin to increase it",
    "You've hit your limit · resets 3pm", 'You’ve hit your Sonnet limit', "You're out of usage credits · resets 3pm",
    "You're out of extra usage", 'Claude AI usage limit reached|1792252800',
  ]) assert.ok(FB.isUsageLimitText(s), s);
  for (const s of [
    "You've hit your fast limit", 'Server is temporarily limiting requests (not your usage limit)', 'Opus is experiencing high load, please use /model to switch to Sonnet',
    "You've used 90% of your session limit · resets 3pm", 'the usage limit is described in README', '',
  ]) assert.ok(!FB.isUsageLimitText(s), s);
});

test('yedek hesap (v3.17): iletideki sıfırlanma saati (yerel saat; yarın, tarih, yıl, eski biçim)', () => {
  const now = new Date(2026, 9, 17, 10, 0).getTime();
  assert.equal(FB.parseResetText("You've hit your session limit · resets 3pm (Europe/Istanbul)", now), new Date(2026, 9, 17, 15, 0).getTime());
  assert.equal(FB.parseResetText('resets 3:30pm', now), new Date(2026, 9, 17, 15, 30).getTime());
  assert.equal(FB.parseResetText('resets 9am', now), new Date(2026, 9, 18, 9, 0).getTime());
  assert.equal(FB.parseResetText('resets 12am', now), new Date(2026, 9, 18, 0, 0).getTime());
  assert.equal(FB.parseResetText('resets Oct 20, 9am (UTC)', now), new Date(2026, 9, 20, 9, 0).getTime());
  assert.equal(FB.parseResetText('resets Jan 3, 2027, 9am', now), new Date(2027, 0, 3, 9, 0).getTime());
  assert.equal(FB.parseResetText('resets Jan 3, 9am', now), new Date(2027, 0, 3, 9, 0).getTime());
  assert.equal(FB.parseResetText('Claude AI usage limit reached|1792252800', now), 1792252800000);
  assert.equal(FB.parseResetText("You've hit your usage limit", now), null);
});

test('yedek hesap (v3.17): döküm limitte bitiyorsa limit; sonra yazılan, eski ya da başka hata değil', () => {
  const since = Date.parse('2026-10-17T10:00:00.000Z');
  const tail = `{"partial line from the middle"\n${userEntry('do the thing')}\n${limitEntry()}\n{"type":"system","subtype":"x"}\n`;
  assert.deepEqual(FB.limitFromTranscript(tail, { since }), {
    at: Date.parse('2026-10-17T10:00:05.000Z'), resetsAt: 1792252800000, type: 'five_hour', text: "You've hit your session limit · resets 3pm (Europe/Istanbul)",
  });
  // written before this run of the tab (the conversation resumed after a move): not this run's limit
  assert.equal(FB.limitFromTranscript(tail, { since: since + 60000 }), null);
  // the user went on: a newer prompt or answer
  assert.equal(FB.limitFromTranscript(`${limitEntry()}\n${userEntry('carry on', '2026-10-17T10:01:00.000Z')}\n`, { since }), null);
  // another API error, or the model / the user merely writing the words
  assert.equal(FB.limitFromTranscript(limitEntry({ apiError: null, info: null, text: 'API Error: 529 overloaded' }), { since }), null);
  const said = JSON.stringify({ type: 'assistant', timestamp: '2026-10-17T10:00:05.000Z', message: { content: [{ type: 'text', text: "You've hit your session limit" }] } });
  assert.equal(FB.limitFromTranscript(said, { since }), null);
  assert.equal(FB.limitFromTranscript(userEntry("You've hit your session limit · resets 3pm", '2026-10-17T10:00:05.000Z'), { since }), null);
  // meta user lines do not count as the user going on; without rate_limit_info the text gives the reset
  const noInfo = limitEntry({ info: null, apiError: null, text: "You've hit your weekly limit · resets Oct 20, 9am" });
  const r = FB.limitFromTranscript(`${noInfo}\n${userEntry('<caveat>', '2026-10-17T10:00:06.000Z', { isMeta: true })}`, { since });
  assert.equal(r.type, null);
  assert.equal(r.resetsAt, new Date(2026, 9, 20, 9, 0).getTime());
  assert.equal(FB.limitFromTranscript('', { since }), null);
});

test('yedek hesap (v3.17): terminal ipucu renkli ve parça parça gelen iletiyi bulur, bir kez', () => {
  let r = FB.scanPty({ tail: '' }, '\x1b[31mYou\'ve hit your \x1b[1m');
  assert.equal(r.hit, null);
  r = FB.scanPty(r.scan, 'session limit\x1b[0m \x1b[2m· resets 3pm\x1b[0m\r\n');
  assert.equal(r.hit, "You've hit your session limit");
  assert.equal(FB.scanPty(r.scan, ' more output\r\n').hit, null);
  assert.equal(FB.scanPty({ tail: '' }, "\x1b[33mYou've hit your fast limit · resets in 8m").hit, null);
  assert.equal(FB.scanPty({ tail: '' }, 'Usage limit reached · continuing automatically at 3pm · esc to cancel').hit, 'Usage limit reached · continuing automatically');
  assert.equal(FB.plainText('a\x1b]0;title\x07b\x1b[2Cc'), 'ab c');
});

test('yedek hesap (v3.17): hesabın limitte olduğu süre (kota %100, görülen limit, yeni kota okuması)', () => {
  const now = 1_000_000_000_000;
  assert.equal(FB.limitedUntil({ now }), 0);
  assert.equal(FB.limitedUntil({ usage: { updatedAt: now - 1000, fiveHour: { pct: 100, resetsAt: now + 3600e3 } }, now }), now + 3600e3);
  assert.equal(FB.limitedUntil({ usage: { updatedAt: now - 1000, fiveHour: { pct: 100, resetsAt: now - 1 } }, now }), 0);
  assert.equal(FB.limitedUntil({ usage: { updatedAt: now - 1000, fiveHour: { pct: 99 }, sevenDay: { pct: 100, resetsAt: now + 5 } }, now }), now + 5);
  assert.equal(FB.limitedUntil({ usage: { updatedAt: now - 1000, fiveHour: { pct: 100 } }, now }), now - 1000 + FB.DEFAULT_LIMIT_MS);
  const mark = { at: now - 60000, until: now + 600000 };
  assert.equal(FB.limitedUntil({ mark, now }), now + 600000);
  assert.equal(FB.limitedUntil({ mark, usage: { updatedAt: now - 120000, fiveHour: { pct: 40 } }, now }), now + 600000);
  // a reading newer than the mark with room left: the limit is gone (it reset early, or the mark was wrong)
  assert.equal(FB.limitedUntil({ mark, usage: { updatedAt: now - 1000, fiveHour: { pct: 40 } }, now }), 0);
  assert.equal(FB.limitedUntil({ mark: { at: 0, until: now - 1 }, now }), 0);
  assert.deepEqual(FB.markFor(now + 5000, now), { at: now, until: now + 5000 });
  assert.deepEqual(FB.markFor(null, now), { at: now, until: now + FB.DEFAULT_LIMIT_MS });
  assert.deepEqual(FB.normalizeMarks({ a: { at: 1, until: now + 1 }, b: { until: now - 1 }, gone: { until: now + 1 }, c: 'x' }, ['a', 'b', 'c'], now), { a: { at: 1, until: now + 1 } });
});

test('yedek hesap (v3.17): yedek seçimi: yok, girişsiz, limitte, boştaki herhangi biri, eve dönüş', () => {
  const now = 1_000_000_000_000;
  const full = { updatedAt: now, fiveHour: { pct: 100, resetsAt: now + 3600e3 } };
  const accounts = [
    { id: 'default', auth: { state: 'in' } },
    { id: 'b', auth: { state: 'in' }, usage: { updatedAt: now, fiveHour: { pct: 70 } } },
    { id: 'c', auth: { state: 'in' }, usage: { updatedAt: now, fiveHour: { pct: 10 } } },
    { id: 'out', auth: { state: 'out' } },
    { id: 'full', auth: { state: 'in' }, usage: full },
  ];
  const pick = (o) => FB.pickBackup({ accounts, now, current: 'default', ...o });
  assert.deepEqual(pick({ choice: null }), { reason: 'off' });
  assert.deepEqual(pick({ choice: 'b' }), { id: 'b' });
  assert.deepEqual(pick({ choice: 'out' }), { reason: 'notLoggedIn' });
  assert.deepEqual(pick({ choice: 'full' }), { reason: 'allLimited' });
  assert.deepEqual(pick({ choice: 'b', marks: { b: { at: now, until: now + 1000 } } }), { reason: 'allLimited' });
  assert.deepEqual(pick({ choice: 'gone' }), { reason: 'none' });
  // auto: the emptier quota first (unknown counts as empty), never the current account or one at its limit
  assert.deepEqual(pick({ choice: 'auto' }), { id: 'c' });
  assert.deepEqual(pick({ choice: 'auto', current: 'c' }), { id: 'default' });
  // the home first, when it reset
  assert.deepEqual(pick({ choice: 'auto', current: 'c', home: 'b' }), { id: 'b' });
  assert.deepEqual(pick({ choice: 'auto', current: 'c', home: 'b', marks: { b: { at: now, until: now + 1 } } }), { id: 'default' });
  // already on its set backup: only the home can take over, and only after its reset (no ping-pong)
  assert.deepEqual(pick({ choice: 'b', current: 'b' }), { reason: 'none' });
  assert.deepEqual(pick({ choice: 'b', current: 'b', home: 'default', marks: { default: { at: now, until: now + 5 } } }), { reason: 'allLimited' });
  assert.deepEqual(pick({ choice: 'b', current: 'b', home: 'default' }), { id: 'default' });
  // everyone at the limit: stay put
  const allFull = accounts.map((a) => ({ ...a, auth: { state: 'in' }, usage: full }));
  assert.deepEqual(FB.pickBackup({ choice: 'auto', current: 'default', accounts: allFull, now }), { reason: 'allLimited' });
});

test('yedek hesap (v3.17): döngü yok: çok sık geçiş durur; eve yalnız boşta ve sıfırlanınca dönülür', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(FB.switchAllowed([], now), { ok: true, history: [] });
  assert.equal(FB.switchAllowed([now - 30000], now).reason, 'soon');
  const many = [now - 50 * 60e3, now - 40 * 60e3, now - 30 * 60e3, now - 20 * 60e3];
  assert.equal(FB.switchAllowed(many, now).reason, 'loop');
  assert.deepEqual(FB.switchAllowed([now - 2 * 3600e3, now - 10 * 60e3], now), { ok: true, history: [now - 10 * 60e3] });
  const home = { id: 'a', auth: { state: 'in' }, usage: { updatedAt: now - 1000, fiveHour: { pct: 100, resetsAt: now - 1 } } };
  const base = { home, current: 'b', idle: true, lastSwitch: now - 10 * 60e3, now };
  assert.equal(FB.shouldReturn(base), true);
  assert.equal(FB.shouldReturn({ ...base, idle: false }), false);
  assert.equal(FB.shouldReturn({ ...base, lastSwitch: now - 1000 }), false);
  assert.equal(FB.shouldReturn({ ...base, mark: { at: now - 5000, until: now + 1000 } }), true, 'a quota reading newer than the mark wins');
  assert.equal(FB.shouldReturn({ ...base, home: { ...home, usage: undefined }, mark: { at: now - 5000, until: now + 1000 } }), false);
  assert.equal(FB.shouldReturn({ ...base, home: { ...home, auth: { state: 'out' } } }), false);
  assert.equal(FB.shouldReturn({ ...base, current: 'a' }), false);
  assert.equal(FB.shouldReturn({ ...base, home: null }), false);
});

test('yedek hesap (v3.17): proje durumu: yedek seçimi, otomatik geçiş, eve dönüş, elle değişim, hesap silme', () => {
  let s = P.normalizeState({
    accounts: [{ id: 'b', label: 'B', configDir: '/b' }, { id: 'c', label: 'C', configDir: '/c' }],
    projects: [
      { id: 'x', dir: '/x', backupAccount: 'b' },
      { id: 'y', dir: '/y', backupAccount: 'gone', homeAccount: 'gone' },
      { id: 'z', dir: '/z', accountId: 'b', backupAccount: 'auto', homeAccount: 'b' },
    ],
  });
  assert.equal(P.backupOf(P.findProject(s, 'x')), 'b');
  assert.deepEqual(P.findProject(s, 'y'), { id: 'y', dir: '/y', name: 'y', accountId: 'default' });
  assert.equal(P.findProject(s, 'z').homeAccount, undefined, 'a home equal to the account is dropped');
  assert.equal(P.findProject(s, 'z').backupAccount, 'auto');
  assert.equal(P.setProjectBackup(s, 'x', 'b'), s);
  assert.equal(P.setProjectBackup(s, 'x', 'nope').projects[0].backupAccount, undefined);
  s = P.setProjectBackup(s, 'y', 'auto');
  assert.equal(P.backupOf(P.findProject(s, 'y')), 'auto');
  assert.equal(P.backupOf(P.findProject(P.setProjectBackup(s, 'y', null), 'y')), null);
  // default → b → c: the home stays the first account; back on it, the home is forgotten
  s = P.fallbackTo(s, 'x', 'b');
  assert.deepEqual([P.findProject(s, 'x').accountId, P.findProject(s, 'x').homeAccount], ['b', 'default']);
  s = P.fallbackTo(s, 'x', 'c');
  assert.deepEqual([P.findProject(s, 'x').accountId, P.findProject(s, 'x').homeAccount], ['c', 'default']);
  assert.equal(P.fallbackTo(s, 'x', 'c'), s);
  const back = P.returnHome(s, 'x');
  assert.deepEqual([P.findProject(back, 'x').accountId, 'homeAccount' in P.findProject(back, 'x')], ['default', false]);
  assert.equal(P.returnHome(back, 'x'), back);
  // the user's own change wins: no going back later
  const manual = P.setProjectAccount(s, 'x', 'b');
  assert.deepEqual([P.findProject(manual, 'x').accountId, 'homeAccount' in P.findProject(manual, 'x')], ['b', false]);
  // normalize keeps a running fallback across a restart
  assert.equal(P.findProject(P.normalizeState(s), 'x').homeAccount, 'default');
  // removing an account drops it as a backup and as a home
  const r = A.removeAccount(P.fallbackTo(P.setProjectBackup(s, 'y', 'c'), 'y', 'b'), 'b');
  assert.deepEqual(P.findProject(r.state, 'y'), { id: 'y', dir: '/y', name: 'y', accountId: 'default', backupAccount: 'c' });
  const r2 = A.removeAccount(s, 'c');
  assert.deepEqual(r2.moved, ['x']);
  assert.deepEqual(P.findProject(r2.state, 'x'), { id: 'x', dir: '/x', name: 'x', accountId: 'default', backupAccount: 'b' });
});

test('pencere başlığı ve kenar çubuğu bölmesi (v3.18): ~ ile klasör, başlık, bölme sınırları', async () => {
  const L = await import('../src/layout.mjs');
  assert.equal(L.tildePath('/Users/me/Projects/x', '/Users/me'), '~/Projects/x');
  assert.equal(L.tildePath('/Users/me', '/Users/me/'), '~');
  assert.equal(L.tildePath('/Users/meow/x', '/Users/me'), '/Users/meow/x');
  assert.equal(L.tildePath('/opt/x', '/Users/me'), '/opt/x');
  assert.equal(L.tildePath('/opt/x', null), '/opt/x');
  assert.equal(L.tildePath('C:\\Users\\Me\\code\\x', 'c:\\users\\me'), '~\\code\\x');
  assert.equal(L.windowTitle({ name: 'x', dir: '/Users/me/Projects/x' }, '/Users/me', 'Agent Office'), 'x — ~/Projects/x — Agent Office');
  assert.equal(L.windowTitle(null, '/Users/me', 'Agent Office'), 'Agent Office');
  // wanted height kept within both minimums; no wanted height → the default share
  assert.equal(L.clampSplit(300, 900, 2), 300);
  assert.equal(L.clampSplit(10, 900, 2), L.SPLIT_MIN_BOTTOM);
  assert.equal(L.clampSplit(5000, 900, 2), 900 - 2 - L.SPLIT_MIN_TOP);
  assert.equal(L.clampSplit(NaN, 1000), Math.round(1000 * L.SPLIT_DEFAULT));
  // too short for both: the projects part keeps its minimum
  assert.equal(L.clampSplit(200, 200, 2), 48);
});

test('Windows yapıştırma (v3.19): Ctrl+V terminalde yapıştırır, macOS ve Linux değişmez', async () => {
  const K = await import('../src/terminal-keys.mjs');
  const k = (m = {}) => ({ key: 'v', code: 'KeyV', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  // Windows: Ctrl+V and Ctrl+Shift+V; not AltGr (Ctrl+Alt), not Alt+V (claude's image key), not plain V
  assert.equal(K.isPasteKey(k({ ctrlKey: true }), 'win32'), true);
  assert.equal(K.isPasteKey(k({ ctrlKey: true, shiftKey: true, key: 'V' }), 'win32'), true);
  assert.equal(K.isPasteKey(k({ ctrlKey: true, altKey: true }), 'win32'), false);
  assert.equal(K.isPasteKey(k({ altKey: true }), 'win32'), false);
  assert.equal(K.isPasteKey(k(), 'win32'), false);
  assert.equal(K.isPasteKey(k({ ctrlKey: true, code: 'KeyC', key: 'c' }), 'win32'), false);
  // the key in V's place on another layout (code KeyV) pastes
  assert.equal(K.isPasteKey(k({ ctrlKey: true, key: 'м' }), 'win32'), true);
  // Linux: only Ctrl+Shift+V (Ctrl+V stays claude's image paste)
  assert.equal(K.isPasteKey(k({ ctrlKey: true }), 'linux'), false);
  assert.equal(K.isPasteKey(k({ ctrlKey: true, shiftKey: true }), 'linux'), true);
  // macOS: ⌘V and ⌘⇧V; Ctrl+V goes to claude
  assert.equal(K.isPasteKey(k({ metaKey: true }), 'darwin'), true);
  assert.equal(K.isPasteKey(k({ metaKey: true, shiftKey: true, key: 'V' }), 'darwin'), true);
  assert.equal(K.isPasteKey(k({ ctrlKey: true }), 'darwin'), false);
  assert.equal(K.isPasteKey(k({ metaKey: true, altKey: true }), 'darwin'), false);
});

test('Windows yapıştırma (v3.19): dosyalar tırnaklı yollar, görsel Alt+V, metin önce (Windows)', async () => {
  const K = await import('../src/terminal-keys.mjs');
  const files = ['C:\\Users\\a b\\x.png', 'D:\\y.txt', '\\\\srv\\share\\R&D\\z.md'];
  assert.deepEqual(K.pasteAction({ files, hasImage: false, text: '' }, 'win32'),
    { pty: '"C:\\Users\\a b\\x.png" D:\\y.txt "\\\\srv\\share\\R&D\\z.md" ' });
  assert.deepEqual(K.pasteAction({ files: ['/a b/c', '/d'] }, 'darwin'), { pty: "'/a b/c' /d " });
  // image only: Claude Code's image key (Alt+V on Windows, Ctrl+V elsewhere)
  assert.deepEqual(K.pasteAction({ files: [], hasImage: true, text: '' }, 'win32'), { pty: '\x1bv' });
  assert.deepEqual(K.pasteAction({ files: [], hasImage: true, text: '' }, 'darwin'), { pty: '\x16' });
  // text and a picture (Excel, Word): Windows pastes the text, macOS and Linux keep the image first
  assert.deepEqual(K.pasteAction({ files: [], hasImage: true, text: 'a\tb' }, 'win32'), { text: 'a\tb' });
  assert.deepEqual(K.pasteAction({ files: [], hasImage: true, text: 'a' }, 'linux'), { pty: '\x16' });
  assert.deepEqual(K.pasteAction({ files: [], hasImage: false, text: 'x\r\ny' }, 'win32'), { text: 'x\r\ny' });
  assert.equal(K.pasteAction({ files: [], hasImage: false, text: '' }, 'win32'), null);
  assert.equal(K.pasteAction(null, 'win32'), null);
  // quotePath on Windows: spaces and cmd characters get "…", a bare path, a drive root and a UNC path stay bare
  assert.equal(K.quotePath('D:\\', 'win32'), 'D:\\');
  assert.equal(K.quotePath('\\\\srv\\share\\a.txt', 'win32'), '\\\\srv\\share\\a.txt');
  assert.equal(K.quotePath('C:\\Program Files (x86)\\a', 'win32'), '"C:\\Program Files (x86)\\a"');
  assert.equal(K.quotePath('C:\\Belgeler\\çalışma 1\\ö.pdf', 'win32'), '"C:\\Belgeler\\çalışma 1\\ö.pdf"');
  assert.equal(K.quotePath('C:\\a;b', 'win32'), '"C:\\a;b"');
});

test('Windows pano (v3.19): CF_HDROP tam liste, FileNameW yalnız ilk dosya, görsel biçimleri', () => {
  // CF_HDROP as GlobalSize returns it: rounded up, junk after the double NUL; an odd byte at the end
  const names = ['C:\\Users\\Şule\\Masaüstü\\ekran görüntüsü.png', 'E:\\a.txt', '\\\\srv\\s\\b.md'];
  const body = Buffer.from(names.join('\0') + '\0\0', 'utf16le');
  const drop = Buffer.concat([Buffer.alloc(20), body, Buffer.from('JUNK', 'utf16le'), Buffer.from([0x41])]);
  drop.writeUInt32LE(20, 0);
  drop.writeUInt32LE(1, 16);
  assert.deepEqual(OS.filesFromDropFiles(drop), names);
  // a larger header offset (pFiles) is honoured; a bad offset gives nothing
  const off = Buffer.concat([Buffer.alloc(24), body]);
  off.writeUInt32LE(24, 0);
  off.writeUInt32LE(1, 16);
  assert.deepEqual(OS.filesFromDropFiles(off), names);
  const bad = Buffer.from(drop);
  bad.writeUInt32LE(9999, 0);
  assert.deepEqual(OS.filesFromDropFiles(bad), []);
  assert.deepEqual(OS.filesFromDropFiles(null), []);
  // FileNameW: one NUL-terminated UTF-16LE name, junk after it ignored
  assert.deepEqual(OS.filesFromFileNameW(Buffer.from(names[0] + '\0xx', 'utf16le')), [names[0]]);
  assert.deepEqual(OS.filesFromFileNameW(Buffer.from('\0', 'utf16le')), []);
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format=FileNameW'), 'name');
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="15"'), 'drop');
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="FileName"'), null);
  // the full list wins whatever order read() lists the types in; FileNameW alone is incomplete
  assert.deepEqual(OS.pickWindowsFiles({ name: [names[0]], drop: names }), { files: names, complete: true });
  assert.deepEqual(OS.pickWindowsFiles({ name: [names[0]], uri: names }), { files: names, complete: true });
  assert.deepEqual(OS.pickWindowsFiles({ name: [names[0]], drop: [] }), { files: [names[0]], complete: false });
  assert.deepEqual(OS.pickWindowsFiles({}), { files: [], complete: true });
  // images: MIME types and the raw formats of a screenshot
  for (const t of ['image/png', 'image/bmp', 'electron application/osclipboard;format="PNG"',
    'electron application/osclipboard;format="CF_DIB"', 'electron application/osclipboard;format="CF_DIBV5"',
    'electron application/osclipboard;format="8"']) assert.equal(OS.windowsImageType(t), true, t);
  for (const t of ['text/plain', 'text/html', 'electron application/osclipboard;format="FileNameW"',
    'electron application/osclipboard;format="CF_HDROP"']) assert.equal(OS.windowsImageType(t), false, t);
});

// --- Antigravity in the office (contract v3.23, src/agy-watch.js). Fixtures: the approval prompts are agy's
// documented ones (antigravity.google/docs/cli/modes, /features, /subagents); the busy line (spinner + "esc to
// cancel") and the screen around them are guessed (Gemini CLI's look), as is the transcript's record content.
const AW = require('../src/agy-watch.js');
const AGY = {
  banner: '\x1b[?25l\x1b[2J\x1b[H\x1b[1mAntigravity CLI\x1b[0m 1.3.6\r\n\x1b[2m~/Projects/shop-api\x1b[0m\r\n> ',
  echo: (s) => s,
  spin: (n) => `\x1b[2K\r\x1b[36m${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[n % 10]}\x1b[0m Thinking… \x1b[2m(esc to cancel, ${n}s)\x1b[0m`,
  answer: '\x1b[2K\r\x1b[0mDone. I added the refund endpoint and its test.\r\n\r\n> ',
  createFile: '\x1b[2K\r\x1b[33m●\x1b[0m Create file: src/utils/formatter.ts\r\n\x1b[1mAllow create this file? [y/n/f]\x1b[0m ',
  sandbox: '\r\n\x1b[1mRun command:\x1b[0m npm test\r\n  1. Yes, and run in sandbox\r\n  2. Yes, and run without sandbox restrictions\r\n  3. No\r\n',
  subagent: '\x1b[s\x1b[1;1H\x1b[43m Subagent 12 asks to run "npm test" (ctrl+k) \x1b[0m\x1b[u',
};

test('agy izleyici: plainText kaçış dizilerini atar; desenler belgelenmiş onay istemlerini tanır (v3.23)', () => {
  assert.equal(AW.plainText('\x1b[1mA\x1b[0m\x1b]0;title\x07B\r\nC'), 'AB\nC');
  for (const s of [AGY.createFile, AGY.sandbox, AGY.subagent, 'Allow execution of: rm? ', '● Allow once']) assert.equal(AW.ASK_RE.test(AW.plainText(s)), true, s);
  for (const s of [AGY.banner, AGY.answer, 'Do you want me to add tests?', 'I will allow the user to retry.']) assert.equal(AW.ASK_RE.test(AW.plainText(s)), false, s);
  assert.equal(AW.BUSY_RE.test(AW.plainText(AGY.spin(3))), true);
  assert.equal(AW.BUSY_RE.test(AW.plainText(AGY.banner + AGY.answer)), false);
});

test('agy izleyici: gönderilen istem tur başlatır, sessizlik bitirir; tur sayısı ve teslim; yazarken meşgul değil (v3.23)', () => {
  const t0 = 1_000_000;
  const w = AW.createAgyWatch(t0);
  w.output(AGY.banner, t0 + 100);
  for (const [i, ch] of [...'add a refund endpoint'].entries()) { w.input(ch, t0 + 1000 + i * 50); w.output(AGY.echo(ch), t0 + 1010 + i * 50); }
  assert.equal(w.isBusy, false, 'typing echo is not work');
  assert.equal(w.blocker(), 'draft');
  w.input('\r', t0 + 3000);
  assert.equal(w.isBusy, true);
  assert.equal(w.tick(t0 + 3000 + AW.QUIET_MS + 10), false, 'the model may take a while to start');
  for (let n = 0; n < 6; n++) w.output(AGY.spin(n), t0 + 4000 + n * 1000);
  assert.equal(w.tick(t0 + 9500), false);
  w.output(AGY.answer, t0 + 9600);
  assert.equal(w.tick(t0 + 9600 + 1000), false);
  assert.equal(w.tick(t0 + 9600 + AW.QUIET_MS + 1), true);
  assert.equal(w.isBusy, false);
  assert.equal(w.turns, 1);
  const s = w.session('shop-api', 'agy-p1-1', t0 + 20000);
  assert.equal(s.engine, 'agy');
  assert.equal(s.stats.isBossBusy, false);
  assert.equal(s.stats.turns, 1);
  assert.deepEqual(s.stats.today.ids, ['turn-1']);
  assert.equal(s.updatedAt, t0 + 20000, 'live while agy runs');
  assert.equal(w.blocker(), '');
  // Enter on an empty prompt starts nothing
  w.input('\r', t0 + 30000);
  assert.equal(w.isBusy, false);
});

test('agy izleyici: belgelenmiş onay istemi bekleyen onay olur, bir tuş yanıtlar; çalışma kendiliğinden başlarsa da tur (v3.23)', () => {
  const t0 = 2_000_000;
  const w = AW.createAgyWatch(t0);
  // started with -i <prompt>: the busy line alone opens the turn
  w.output(AGY.spin(0), t0 + 500);
  assert.equal(w.isBusy, true);
  w.output(AGY.createFile, t0 + 2000);
  assert.deepEqual(w.waiting, { kind: 'permission', tool: 'Edit', since: t0 + 2000 });
  assert.equal(w.tick(t0 + 60_000), false, 'a dialog holds the turn, however long');
  w.output(AGY.createFile, t0 + 61_000); // redrawn: same dialog
  assert.equal(w.waiting?.since, t0 + 2000);
  assert.equal(w.blocker(), 'busy');
  w.input('y', t0 + 62_000);
  assert.equal(w.waiting, null);
  w.output('\x1b[2K\ry\r\n', t0 + 62_100); // the dialog's last frame: not a new dialog
  assert.equal(w.waiting, null);
  w.output(AGY.spin(1), t0 + 63_000);
  w.output(AGY.sandbox, t0 + 64_000);
  assert.equal(w.waiting?.tool, 'Shell');
  w.input('1', t0 + 65_000);
  w.output(AGY.answer, t0 + 66_000);
  assert.equal(w.tick(t0 + 70_000), true);
  assert.equal(w.turns, 1, 'one turn, however many dialogs');
  // a sub-agent's request between turns
  w.output(AGY.subagent, t0 + 80_000);
  assert.equal(w.waiting?.tool, 'Shell');
  w.input('\x0b', t0 + 81_000);
  w.exit(t0 + 82_000);
  const s = w.session('shop-api', 'x', t0 + 90_000);
  assert.equal(s.endedAt, t0 + 82_000);
  assert.equal(s.stats.waiting, undefined);
  assert.equal(w.turns, 2);
});

test('agy izleyici: döküm büyümesi meşgul işareti; ilk okuma taban; döküm yolu last_conversations.json\'dan (v3.23)', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  try {
    const dir = '/Users/me/Projects/shop-api';
    const base = path.join(home, '.gemini', 'antigravity-cli');
    assert.equal(AW.agyTranscriptPath(home, dir), null, 'no map');
    fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(base, 'cache', 'last_conversations.json'), JSON.stringify({ [`${dir}/`]: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '/x': '../../etc' }));
    const file = AW.agyTranscriptPath(home, dir);
    assert.equal(file, path.join(base, 'brain', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '.system_generated', 'logs', 'transcript.jsonl'));
    assert.equal(AW.agyTranscriptPath(home, '/x'), null, 'odd id');
    assert.equal(AW.readTranscript(file, null), null, 'missing file');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"step_index":0,"type":"USER_INPUT","content":"hi"}\n{"step_index":1,"type":"PLANNER_RESPONSE","content":"hello"}\n');
    const t0 = 3_000_000;
    const w = AW.createAgyWatch(t0);
    let cur = AW.readTranscript(file, null);
    assert.equal(cur.prompts, 1);
    w.transcript(cur, t0 + 100);
    assert.equal(w.isBusy, false, 'the first read is the baseline (--continue)');
    fs.appendFileSync(file, '{"step_index":2,"type":"USER_INPUT","content":"add tests"}\n');
    cur = AW.readTranscript(file, cur);
    assert.equal(cur.prompts, 2);
    w.transcript(cur, t0 + 1000);
    assert.equal(w.isBusy, true);
    fs.appendFileSync(file, '{"step_index":3,"type":"run_command","content":"npm test"}\n');
    w.transcript(cur = AW.readTranscript(file, cur), t0 + 5000);
    assert.equal(w.tick(t0 + 5000 + AW.QUIET_MS - 1), false, 'growth keeps it busy');
    w.transcript(cur = AW.readTranscript(file, cur), t0 + 9000);
    assert.equal(w.tick(t0 + 9000), true);
    assert.equal(w.turns, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('agy ofiste: izlenen oturum readOffice ve nextAttention\'dan Claude oturumu gibi geçer (v3.23)', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const S = require('../src/sessions.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-office-'));
  try {
    const t0 = new Date(2026, 9, 19, 11, 0, 0).getTime();
    const w = AW.createAgyWatch(t0);
    const projects = [{ id: 'p1', name: 'shop-api' }];
    const read = (now) => S.readOffice(['shop-api'], now, root, null, null, [w.session('shop-api', 'agy-p1-1', now)]);
    let d = read(t0 + 10);
    assert.equal(d.projects[0].engine, 'agy');
    assert.equal(d.isBossBusy, false);
    let a = N.nextAttention(N.emptyAttention(), projects, d.projects, null);
    w.input('fix it', t0 + 100); w.input('\r', t0 + 200);
    d = read(t0 + 300);
    assert.equal(d.isBossBusy, true);
    assert.equal(d.projects[0].isBossBusy, true);
    a = N.nextAttention(a.state, projects, d.projects, null);
    w.output(AGY.createFile, t0 + 1000);
    d = read(t0 + 1100);
    assert.equal(d.isBossAsking, true);
    assert.deepEqual(d.projects[0].waiting, { tool: 'Edit', since: t0 + 1000 });
    a = N.nextAttention(a.state, projects, d.projects, null);
    assert.deepEqual(a.events, [{ kind: 'permission', id: 'p1', tool: 'Edit' }]);
    assert.equal(a.attention.get('p1'), 'permission');
    w.input('y', t0 + 5000);
    w.output(AGY.answer, t0 + 5100);
    w.tick(t0 + 5100 + AW.QUIET_MS + 1);
    d = read(t0 + 10_000);
    assert.equal(d.isBossBusy, false);
    assert.equal(d.delivered, 1);
    assert.equal(d.projects[0].delivered, 1);
    a = N.nextAttention(a.state, projects, d.projects, null);
    assert.deepEqual(a.events, [{ kind: 'done', id: 'p1' }]);
    // ended run: still counted today, and in the end-of-day summary
    w.exit(t0 + 20_000);
    const ended = w.session('shop-api', 'agy-p1-1', t0 + 30_000);
    d = S.readOffice(['shop-api'], t0 + 30_000, root, null, null, [ended]);
    assert.equal(d.delivered, 1);
    assert.equal(d.isBossBusy, false);
    const today = S.readToday(['shop-api'], t0 + 30_000, root, null, [ended]);
    assert.equal(today.deliveries.length, 1);
    assert.equal(today.deliveries[0].type, 'agy');
    // an odd id is ignored
    assert.equal(S.readOffice(['shop-api'], t0, root, null, null, [{ ...ended, id: '../x' }]).delivered, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agy uyku: { agy } her zaman --continue ile uyanır; izleyici dosya yazmaz, agy\'ye bir şey vermez (v3.23)', () => {
  assert.deepEqual(require('../src/sleep.js').wakeOptions({ agy: true }, false), { resume: true });
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'agy-watch.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const banned of ['writeFile', 'appendFile', 'mkdir', 'rmSync', 'unlink', 'rename', "'w'", 'child_process', 'process.env']) assert.equal(src.includes(banned), false, `agy-watch uses ${banned}`);
});

// --- Antigravity login in the Accounts section (v3.24, src/agy-auth.js)
test('agy durumu: komut çıktısı; rc gürültüsü, yol, API anahtarı ve ADC yalnız var/yok olarak (v3.24)', () => {
  const AG = require('../src/agy-auth.js');
  assert.deepEqual(AG.parseAgyStatus('Welcome to zsh\n/Users/a/.local/bin/agy\n'), { path: '/Users/a/.local/bin/agy', apiKey: false, adc: false });
  assert.deepEqual(AG.parseAgyStatus('/opt/x/agy\r\nAGY_STATUS_KEY=1\nAGY_STATUS_ADC=1\n'), { path: '/opt/x/agy', apiKey: true, adc: true });
  assert.deepEqual(AG.parseAgyStatus('zsh: agy not found\n'), { path: null, apiKey: false, adc: false });
  assert.equal(AG.parseAgyStatus('agy: aliased to /x/agy').path, null); // an alias line is not a path
  assert.equal(AG.parseAgyStatus('').path, null);
  // the command prints only markers, never a key's value
  assert.doesNotMatch(AG.AGY_STATUS_COMMAND, /echo "?\$GEMINI_API_KEY/);
});

test('agy durumu: macOS anahtar zinciri ve log e-postası (v3.39)', () => {
  const AG = require('../src/agy-auth.js');
  const path = require('node:path');
  const home = '/h';
  const logDir = path.join(home, '.gemini', 'antigravity-cli', 'log');
  const files = { [path.join(logDir, 'cli-20261020_162341.log')]: 'x\nOAuth: authenticated successfully as old@gmail.com\n',
    [path.join(logDir, 'cli-20261020_163340.log')]: 'I OAuth: authenticated successfully as me@gmail.com\nmore',
    [path.join(logDir, 'notes.txt')]: 'OAuth: authenticated successfully as no@gmail.com' };
  const read = (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
  const dir = () => Object.keys(files).map((f) => path.basename(f));
  const inst = { path: '/b/agy', apiKey: false, adc: false };
  assert.equal(AG.parseAgyLogEmail('OAuth: authenticated successfully as a@b.co\nOAuth: authenticated successfully as c@d.co'), 'c@d.co');
  assert.equal(AG.parseAgyLogEmail('nothing'), null);
  assert.equal(AG.readAgyFiles(home, read, dir).logEmail, 'me@gmail.com');   // the newest log, not notes.txt
  assert.equal(AG.readAgyFiles(home, read).logEmail, null);                  // no folder listing: no hint
  assert.equal(AG.readAgyFiles(home, read, () => { throw new Error('ENOENT'); }).logEmail, null);
  assert.deepEqual(AG.keychainResult(0), true);
  assert.deepEqual(AG.keychainResult(44), false);
  assert.deepEqual(AG.keychainResult(1), null);
  assert.deepEqual(AG.keychainResult(-1), null);
  const f = AG.readAgyFiles(home, read, dir);
  assert.deepEqual(AG.agyAuthState({ ...inst, keychain: true }, f), { installed: true, state: 'in', method: 'google', email: 'me@gmail.com' });
  assert.deepEqual(AG.agyAuthState({ ...inst, keychain: true }, AG.readAgyFiles(home, read)), { installed: true, state: 'in', method: 'google' });
  assert.equal(AG.agyAuthState({ ...inst, keychain: false }, f).state, 'unknown');   // a guessed item name never shows "logged out"
  assert.equal(AG.agyAuthState({ ...inst, keychain: false }, { modelProvider: null, account: { active: null } }).state, 'out'); // an account file without an active one: as before
  assert.deepEqual(AG.AGY_KEYCHAIN_ARGS, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity']);
  for (const a of AG.AGY_KEYCHAIN_ARGS) assert.doesNotMatch(a, /^-[A-Za-z]*[wg]/, 'no -w / -g (the secret is never asked for)');
  assert.equal(AG.parseAgyLogEmail('OAuth: authenticated successfully as me@gmail.com.'), 'me@gmail.com');
  assert.equal(AG.parseAgyLogEmail('OAuth: authenticated successfully as me@gmail.com,'), 'me@gmail.com');
  const seen = [];
  AG.readAgyFiles(home, read, () => ['cli-20261020_000001.log', 'cli-20261020_000002.log', 'cli-20261020_000003.log', 'cli-20261020_000004.log'], (p) => { seen.push(p); return ''; });
  assert.equal(seen.length, 3);   // at most 3 logs
  assert.equal(AG.readAgyFiles(home, read, dir, () => 'OAuth: authenticated successfully as '.padEnd(AG.LOG_HEAD_BYTES + 10, ' ') + 'x@y.co').logEmail, null);   // nothing past the first 64 KB
  assert.equal(AG.agyAuthState({ ...inst, keychain: null }, f).state, 'unknown');
  assert.equal(AG.agyAuthState(inst, f).state, 'unknown');
});

test('agy durumu: dosyalar (settings.json modelProvider, google_accounts.json active) ve durum (v3.24)', () => {
  const AG = require('../src/agy-auth.js');
  const path = require('node:path');
  const home = '/h';
  const fs = (files) => (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
  const dir = path.join(home, '.gemini', 'antigravity-cli');
  const settings = path.join(dir, 'settings.json');
  const acc = path.join(dir, 'google_accounts.json');
  const shared = path.join(home, '.gemini', 'google_accounts.json');
  const read = [];
  const spy = (files) => (f) => { read.push(f); return fs(files)(f); };
  const inst = { path: '/b/agy', apiKey: false, adc: false };

  assert.deepEqual(AG.agyAuthState({ path: null, apiKey: true, adc: true }, AG.readAgyFiles(home, fs({}))), { installed: false, state: 'missing' });
  assert.deepEqual(AG.agyAuthState(inst, AG.readAgyFiles(home, spy({ [acc]: '{"active":"me@gmail.com","old":["x@y.z"]}' }))),
    { installed: true, state: 'in', email: 'me@gmail.com', method: 'google' });
  assert.deepEqual(AG.agyAuthState(inst, AG.readAgyFiles(home, fs({ [shared]: '{"active":"s@g.com"}' }))).email, 's@g.com');
  assert.deepEqual(AG.agyAuthState(inst, AG.readAgyFiles(home, fs({ [acc]: '{"active":null,"old":["me@gmail.com"]}' }))), { installed: true, state: 'out' });
  assert.deepEqual(AG.agyAuthState(inst, AG.readAgyFiles(home, fs({ [acc]: '{"active":"not an email"}' }))).state, 'out');
  assert.deepEqual(AG.agyAuthState(inst, AG.readAgyFiles(home, fs({ [acc]: 'broken{' }))), { installed: true, state: 'unknown' });
  assert.deepEqual(AG.agyAuthState(inst, AG.readAgyFiles(home, fs({}))), { installed: true, state: 'unknown' });
  // API key: documented as modelProvider "gemini" + GEMINI_API_KEY; one without the other is not a login
  const gem = fs({ [settings]: '{"modelProvider":"gemini","theme":"dark"}' });
  assert.deepEqual(AG.agyAuthState({ ...inst, apiKey: true }, AG.readAgyFiles(home, gem)), { installed: true, state: 'in', method: 'apikey' });
  assert.equal(AG.agyAuthState(inst, AG.readAgyFiles(home, gem)).state, 'unknown');
  assert.equal(AG.agyAuthState({ ...inst, apiKey: true }, AG.readAgyFiles(home, fs({}))).state, 'unknown');
  assert.deepEqual(AG.agyAuthState({ ...inst, adc: true }, AG.readAgyFiles(home, fs({}))), { installed: true, state: 'in', method: 'adc' });
  // only these files are read: no token, credential or keyring file
  for (const f of read) assert.match(path.basename(f), /^(settings|google_accounts)\.json$/);
});

test('agy giriş ortamı: AGY_ADC_AUTH geçer, Claude/ofis geçmez; giriş ve kontrol agyEnv ile (v3.24)', () => {
  const EN = require('../src/engine.js');
  const env = EN.agyEnv({ ...SECRET_ENV, PATH: '/bin', HOME: '/h', AGY_ADC_AUTH: 'true', AGY_OTHER: 'x' }, 'darwin');
  assert.equal(env.AGY_ADC_AUTH, 'true');
  assert.equal('AGY_OTHER' in env, false);
  for (const k of Object.keys(SECRET_ENV)) assert.equal(k in env, false, `${k} reached agy`);
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('// --- Antigravity login (contract v3.24'), main.indexOf('// --- account quota'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /accountEnv|ptyEnv|sessionEnv|process\.env(?!\))/, 'agy login/check must use agyEnv(process.env) only');
  assert.equal((block.match(/EN\.agyEnv\(process\.env\)/g) || []).length, 2);
});

test('proje başına müdür modeli: normalizeState, setProjectBossModel, bossModelOf (v3.27)', () => {
  let s = P.normalizeState({
    projects: [
      { id: 'a', dir: '/a', bossModel: 'sonnet' },
      { id: 'b', dir: '/b', bossModel: 'opus' },
      { id: 'c', dir: '/c', bossModel: 'gpt' },
      { id: 'd', dir: '/d' },
    ],
  });
  assert.deepEqual(P.BOSS_MODELS, ['sonnet', 'opus', 'haiku']);
  assert.deepEqual(s.projects.map((p) => P.bossModelOf(p)), ['sonnet', 'opus', null, null]);
  assert.equal('bossModel' in s.projects[2], false);
  assert.equal(P.setProjectBossModel(s, 'a', 'sonnet'), s);
  assert.equal(P.setProjectBossModel(s, 'zz', 'opus'), s);
  assert.equal(P.setProjectBossModel(s, 'd', 'fable'), s); // geçersiz = Otomatik
  s = P.setProjectBossModel(s, 'd', 'haiku');
  assert.equal(P.bossModelOf(P.findProject(s, 'd')), 'haiku');
  s = P.setProjectBossModel(s, 'a', null); // Otomatik'e dönüş: alan silinir
  assert.equal('bossModel' in P.findProject(s, 'a'), false);
  // Ajan modelinden bağımsız: Müdür Sonnet + Ajan Haiku
  s = P.setProjectAgentModel(P.setProjectBossModel(s, 'a', 'sonnet'), 'a', 'haiku');
  const a = P.findProject(s, 'a');
  assert.deepEqual([P.bossModelOf(a), P.agentModelOf(a)], ['sonnet', 'haiku']);
});

test('müdür modeli: her seçim için başlatma argümanları; Otomatik ve diğer motorlar için yok (v3.27)', () => {
  assert.deepEqual(P.bossModelArgs({ bossModel: 'sonnet' }), ['--model', 'sonnet']);
  assert.deepEqual(P.bossModelArgs({ bossModel: 'opus' }), ['--model', 'opus']);
  assert.deepEqual(P.bossModelArgs({ bossModel: 'haiku' }), ['--model', 'haiku']);
  assert.deepEqual(P.bossModelArgs({}), []); // Otomatik: hiçbir şey değişmez
  assert.deepEqual(P.bossModelArgs({ bossModel: 'x' }), []);
  assert.deepEqual(P.bossModelArgs({ engine: 'claude', bossModel: 'opus' }), ['--model', 'opus']);
  // diğer motorlar: Claude takma adı onların modeli değil, argüman yok (v3.36: kendi modelleri engine-caps.test.mjs)
  assert.deepEqual(P.bossModelArgs({ engine: 'agy', bossModel: 'opus' }), []);
  assert.deepEqual(P.bossModelArgs({ engine: 'commandcode', bossModel: 'haiku' }), []);
  // ortam değişkeni değil bayrak: sessionEnv ANTHROPIC_MODEL'e dokunmaz
  const env = A.sessionEnv({ PATH: '/bin' }, { agentModel: 'haiku' });
  assert.equal('ANTHROPIC_MODEL' in env, false);
  // başlatma satırı: --model, --resume'dan önce ve ana/worktree sekmelerinin ortak yolunda
  const R = require('../src/resume.js');
  assert.deepEqual(R.claudeArgs([...P.bossModelArgs({ bossModel: 'opus' }), '--plugin-dir', '/p'], ['--resume', 'sid']),
    ['--model', 'opus', '--plugin-dir', '/p', '--resume', 'sid']);
});

test('müdür modeli: kenar çubuğunda her motorda, Ajan modelinden önce (v3.27, v3.36)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sb = fs.readFileSync(path.join(__dirname, '../renderer/sidebar.js'), 'utf8');
  const boss = sb.indexOf('bossModelSelect(p), agentModelSelect(p)');
  const agent = sb.indexOf('agentModelSelect(p)', boss);
  assert.ok(boss > 0 && agent > boss, 'Boss model dropdown must be in the project popup for every engine, right before Agent model (v3.42)');
  assert.doesNotMatch(sb, /claude \? (account|manager|bossModel|agentModel|contextCap|savings|backup)Select\(p\) : null/, 'no control is hidden for another engine (v3.36)');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /R\.claudeArgs\(\[\.\.\.P\.bossModelArgs\(project\)/);
  assert.match(main, /projects:setBossModel[\s\S]{0,300}restartIdle\(p\)/);
  for (const lang of ['en', 'tr']) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${lang}.json`), 'utf8')).sidebar;
    for (const k of ['bossModel', 'bossModelTitle', 'bossModelAuto', 'bossModelSonnet', 'bossModelOpus', 'bossModelHaiku']) assert.ok(j[k], `${lang}.${k}`);
  }
});

// --- Command Code login in the Accounts section (contract v3.30)
test('cmd-auth: giriş = yalnız ~/.commandcode/auth.json var mı (içeriği okunmaz), geçici HOME ile (v3.30)', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const CA = require('../src/cmd-auth.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cmd-home-'));
  try {
    const status = { path: '/usr/local/bin/commandcode' };
    assert.equal(CA.cmdAuthFile(home), path.join(home, '.commandcode', 'auth.json'));
    assert.deepEqual(CA.cmdAuthState(status, home, (f) => fs.existsSync(f)), { installed: true, state: 'out' });
    fs.mkdirSync(path.join(home, '.commandcode'));
    fs.writeFileSync(path.join(home, '.commandcode', 'auth.json'), '{"apiKey":"secret-value"}');
    const real = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (...a) => { reads++; return real(...a); };
    try {
      const st = CA.cmdAuthState(status, home, (f) => fs.existsSync(f));
      assert.deepEqual(st, { installed: true, state: 'in' });
      assert.equal(JSON.stringify(st).includes('secret'), false);
    } finally { fs.readFileSync = real; }
    assert.equal(reads, 0);
    assert.deepEqual(CA.cmdAuthState({ path: null }, home, () => true), { installed: false, state: 'missing' });
    assert.deepEqual(CA.cmdAuthState(status, home, () => { throw new Error('x'); }), { installed: true, state: 'out' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cmd-auth: durum çıktısı ve kurulum satırı (v3.30)', () => {
  const CA = require('../src/cmd-auth.js');
  assert.deepEqual(CA.parseCmdStatus('rc noise\n/opt/homebrew/bin/commandcode\n'), { path: '/opt/homebrew/bin/commandcode' });
  assert.deepEqual(CA.parseCmdStatus('commandcode not found\n'), { path: null });
  assert.equal(CA.parseCmdStatus('C:\\npm\\commandcode.cmd').path, 'C:\\npm\\commandcode.cmd');
  assert.equal(CA.CMD_INSTALL, 'npm i -g command-code');
  assert.deepEqual(CA.CMD_LOGIN_ARGS, ['login']);
  assert.doesNotMatch(CA.CMD_STATUS_COMMAND, /auth\.json|cat |\$[A-Z]/);
});

test('checkCmdAuth / startCmdLogin: ortam yalnız cmdEnv; auth.json okunmaz, Claude/ofis yok (v3.30)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  for (const name of ['function checkCmdAuth(', 'function startCmdLogin(', 'function cmdStatus(']) {
    const start = src.indexOf(name);
    assert.ok(start > 0, name);
    const body = src.slice(start, src.indexOf('\n}\n', start)).replace(/\/\/.*$/gm, '');
    if (name !== 'function cmdStatus(') assert.match(body, /const env = EN\.cmdEnv\(process\.env\);/, name);
    for (const banned of ['sessionEnv', 'ptyEnv', 'agyEnv', 'officeDirectoryFile', 'sharedConfig', 'pluginDir', 'usageStatusLine', 'AGENT_OFFICE_', 'CLAUDE_', 'readFileSync', 'process.env.', 'env[']) {
      assert.equal(body.includes(banned), false, `${name} uses ${banned}`);
    }
  }
  assert.match(src, /EN\.CMD_COMMAND, EN\.CMD\.bin, \.\.\.CA\.CMD_LOGIN_ARGS/);
  assert.match(src, /const CMD_LOGIN = 'login:cmd';/);
});

// --- v3.34 remote Claude login relay: the URL / prompt parser against Claude Code 2.1.304's strings, host and code checks
test('login relay: parser finds the allowlisted URL and the code prompt in a stub claude auth login (v3.34)', async () => {
  const LC = require('../src/link-core.js');
  const path = require('path');
  const { execFile } = require('child_process');
  const run = (env) => new Promise((resolve) => {
    const p = execFile(process.execPath, [path.join(__dirname, 'claude-login-stub.cjs')], { env: { ...process.env, ...env } }, (_e, stdout) => resolve(stdout));
    setTimeout(() => p.stdin.end('\n'), 200);   // answer the prompt with nothing: the stub exits
  });
  const out = await run({});
  assert.match(LC.stripAnsi(out), /Browser didn't open\? Use the url below to sign in/);
  const got = LC.parseLoginOutput(out);
  assert.ok(got.url.startsWith('https://claude.ai/oauth/authorize?'));
  assert.ok(got.url.includes('redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback'));
  assert.ok(!/[\x1b\x07\s]/.test(got.url));   // eslint-disable-line no-control-regex
  assert.equal(got.prompt, 'Paste code here if prompted >');
  // host rejection: the same output from another host yields no URL
  assert.equal(LC.parseLoginOutput(await run({ STUB_HOST: 'claude.ai.evil.example' })).url, null);
  assert.equal(LC.parseLoginOutput(await run({ STUB_HOST: 'evil.example' })).url, null);
  const cb = 'redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';
  for (const h of ['claude.ai', 'platform.claude.com', 'console.anthropic.com']) assert.ok(LC.loginUrlOk(`https://${h}/oauth/authorize?${cb}`), h);
  for (const bad of [`http://claude.ai/oauth/authorize?${cb}`, `https://claude.ai:444/x?${cb}`, `https://u:p@claude.ai/x?${cb}`, 'https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb',
    'https://claude.ai/oauth/authorize', `https://claude.ai.evil.example/x?${cb}`, `https://claude.ai/x?${cb} x`, 'javascript:alert(1)', null]) assert.equal(LC.loginUrlOk(bad), false, String(bad));
  // the code: <code>#<state> from the callback page only
  assert.ok(LC.loginCodeOk('AbCdEf0123-_.~xyz#state_123ABC'));
  for (const bad of ['short#state123', 'AbCdEf0123456', 'AbCdEf0123456#st', 'AbCdEf0123456#state 1234', 'AbCdEf0123456#state\n1234', `${'a'.repeat(401)}#state1234`, '', null]) assert.equal(LC.loginCodeOk(bad), false, String(bad));
  assert.equal(LC.validateMessage({ t: 'login-code', id: 'r1', code: 'nope' }), null);
  assert.equal(LC.validateMessage({ t: 'login-result', id: 'r1', ok: false, reason: 'whatever' }), null);
  assert.deepEqual(LC.validateMessage({ t: 'acct-view', accounts: [{ id: 'work', label: 'Work\x1b[31m', state: 'out', email: 'me@example.com', token: 'sk-ant-x', configDir: '/Users/me/.claude-work' }] }),
    { t: 'acct-view', accounts: [{ id: 'work', label: 'Work', state: 'out', email: 'me@example.com' }], shared: true });   // labels, state, email only
});

// --- OpenCode (v3.40)
test('OpenCode motoru (v3.40): engine değeri, ocArgs, ocEnv izin listesi, başlatma satırı', () => {
  const EN = require('../src/engine.js');
  let s = P.normalizeState({ projects: [{ id: 'a', dir: '/a', engine: 'opencode' }, { id: 'b', dir: '/b' }] }, { id });
  assert.equal(P.engineOf(s.projects[0]), 'opencode');
  s = P.setProjectEngine(s, 'b', 'opencode');
  assert.equal(P.engineOf(P.findProject(s, 'b')), 'opencode');
  s = P.setProjectEngine(s, 'b', 'claude');
  assert.equal('engine' in P.findProject(s, 'b'), false);
  assert.deepEqual(EN.ocArgs(), []);
  assert.deepEqual(EN.ocArgs({ prompt: 'x' }), []);                                  // a fresh start never carries a prompt
  assert.deepEqual(EN.ocArgs({ resume: true }), ['--continue']);
  assert.deepEqual(EN.ocArgs({ resume: true, prompt: 'carry on' }), ['--continue', '--prompt', 'carry on']);
  const env = EN.ocEnv({
    PATH: '/b', HOME: '/h', XDG_DATA_HOME: '/d', LC_ALL: 'tr_TR', OPENCODE_CONFIG: '/c', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'g',
    ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: '/x', AGENT_OFFICE_HOME: '/o', MY_MCP_API_KEY: 'm', SECRET: 's', AGY_ADC_AUTH: 'true',
  });
  assert.deepEqual(Object.keys(env).sort(), ['COLORTERM', 'GEMINI_API_KEY', 'HOME', 'LC_ALL', 'OPENAI_API_KEY', 'OPENCODE_CONFIG',
    'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'PATH', 'TERM', 'XDG_DATA_HOME']);
  assert.match(EN.OC_COMMAND, /exec opencode "\$@"$/);
  assert.equal(EN.OC.bin, 'opencode');
});

test('OpenCode ortamı (v3.40): yalnız belgelenmiş sağlayıcı anahtarları; Claude Code uyumluluğu kapalı, kullanıcı açamaz', () => {
  const EN = require('../src/engine.js');
  const env = EN.ocEnv({
    PATH: '/b', OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'r', GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', XAI_API_KEY: 'x',
    DEEPSEEK_API_KEY: 'd', TOGETHER_API_KEY: 't', GOOGLE_GENERATIVE_AI_API_KEY: 'gg',
    STRIPE_API_KEY: 's', SENDGRID_API_KEY: 's', DATADOG_API_KEY: 's', ACME_API_KEY: 's', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'a',
    OPENCODE_DISABLE_CLAUDE_CODE: '0', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false',
  });
  for (const k of ['STRIPE_API_KEY', 'SENDGRID_API_KEY', 'DATADOG_API_KEY', 'ACME_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(k in env, false, k);
  for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) assert.equal(typeof env[k], 'string', k);
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1'); assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, '1'); assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, '1');
  assert.equal(EN.OC_PROVIDER_KEYS.some((k) => /ANTHROPIC|CLAUDE/.test(k)), false);
  assert.ok(EN.OC_PROVIDER_KEYS.every((k) => /^[A-Z][A-Z0-9_]+$/.test(k)));
  // Windows: names compare upper-case, the same result
  const w = EN.ocEnv({ Path: 'C:\\b', openai_api_key: 'k', stripe_api_key: 's' }, 'win32');
  assert.equal('openai_api_key' in w, true); assert.equal('stripe_api_key' in w, false); assert.equal(w.OPENCODE_DISABLE_CLAUDE_CODE, '1');
});

test('OpenCode başlatma satırı ve boss modeli (v3.40, v3.36): launchLine, -m provider/model, eksik tablo çökertmez', () => {
  const EN = require('../src/engine.js');
  assert.equal(EN.OC_COMMAND, EN.launchLine('opencode', { claude: true }));
  assert.equal(EN.CMD_COMMAND, EN.launchLine('commandcode'));
  assert.equal(EN.AGY_COMMAND, EN.launchLine('agy'));
  assert.ok(EN.OC_COMMAND.endsWith('exec opencode "$@"')); assert.equal(EN.OC_COMMAND.includes('exec agy'), false);
  assert.ok(EN.OC_COMMAND.startsWith('for v in $(env | sed -nE'));
  // the line really drops ANTHROPIC_* / CLAUDE* / AGENT_OFFICE_* an rc file set, and keeps the rest
  if (process.platform !== 'win32') {
    const line = EN.OC_COMMAND.replace('exec opencode "$@"', 'env');
    const out = require('node:child_process').execFileSync('/bin/sh', ['-c', 'export ANTHROPIC_API_KEY=a CLAUDE_CONFIG_DIR=c CLAUDECODE=1 AGENT_OFFICE_X=o OPENAI_API_KEY=k; ' + line], { env: { PATH: '/usr/bin:/bin' } }).toString();
    assert.equal(/^(ANTHROPIC_|CLAUDE|AGENT_OFFICE_)/m.test(out), false); assert.match(out, /^OPENAI_API_KEY=k$/m);
  }
  // Windows: a user's case variant of a forced name is dropped, not kept beside it
  const wf = EN.ocEnv({ Path: 'C:\\b', Opencode_Disable_Claude_Code: '0' }, 'win32');
  assert.equal('Opencode_Disable_Claude_Code' in wf, false); assert.equal(wf.OPENCODE_DISABLE_CLAUDE_CODE, '1');
  // the wider busy pattern is OpenCode's only; agy/Command Code keep "esc to …"
  const AW = require('../src/agy-watch.js');
  assert.equal(AW.OC_BUSY_RE.test('esc interrupt'), true); assert.equal(AW.BUSY_RE.test('esc interrupt'), false);
  assert.equal(AW.BUSY_RE.test('esc to cancel'), true);
  assert.deepEqual(EN.ocArgs({ model: 'opencode/big-pickle' }), ['-m', 'opencode/big-pickle']);
  assert.deepEqual(EN.ocArgs({ model: 'opencode/big-pickle', resume: true, prompt: 'go' }), ['-m', 'opencode/big-pickle', '--continue', '--prompt', 'go']);
  // D1 regression: an OpenCode project's boss model lookup must not throw
  assert.equal(P.bossModelOf({ engine: 'opencode', bossModel: 'opus' }), null);
  assert.deepEqual(P.bossModelArgs({ engine: 'opencode' }), []);
  assert.deepEqual(P.bossModelArgs({ engine: 'opencode', bossModel: 'opencode/big-pickle' }), ['-m', 'opencode/big-pickle']);
  let st = P.normalizeState({ projects: [{ id: 'o', dir: '/o', engine: 'opencode' }] }, { id: 'x' });
  st = P.setProjectBossModel(st, 'o', 'opencode/big-pickle');
  assert.equal(P.findProject(st, 'o').bossModel, 'opencode/big-pickle');
  assert.equal(P.setProjectBossModel(st, 'o', 'pro').projects[0].bossModel, undefined); // agy's tier doesn't fit: Auto
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /EN\.ocArgs\(\{ resume: isResume, prompt, model: P\.bossModelOf\(project\) \}\)/);
});

test('OpenCode proje dosyaları (v3.38, v3.40): hiçbir dosya yazılmaz', () => {
  const PF = require('../src/project-files.js');
  assert.deepEqual(PF.desiredFiles({ engine: 'opencode', enabled: true, manager: true, agentModel: 'opus' }), []);
});

test('OpenCode girişi (v3.40): giriş yok normal durum; yalnız entegrasyon adı ve yöntemi okunur, anahtar asla', () => {
  const OA = require('../src/oc-auth.js');
  assert.deepEqual(OA.ocAuthState({ path: null }, '[{"id":"opencode","connections":[{}]}]'), { installed: false, state: 'missing' });
  // the CLI's own list (`opencode auth list --format json`, rc noise allowed around it): the console login lives in the db
  const list = 'rc banner\nopencode v2.1.2\n[\n { "id": "opencode", "name": "OpenCode Console", "connections": [ { "type": "credential", "id": "cred_1", "label": "Default", "method": "oauth" } ] },\n { "id": "openai", "connections": [] }\n]\n';
  assert.deepEqual(OA.ocAuthState({ path: '/b/opencode', major: 2, raw: list }, list), {
    installed: true, state: 'in', major: 2, providers: [{ id: 'opencode', type: 'oauth' }],
  });
  assert.deepEqual(OA.ocAuthState({ path: '/b/opencode' }, '[ { "id": "opencode", "connections": [] } ]'), { installed: true, state: 'out', major: null });
  assert.deepEqual(OA.ocAuthState({ path: '/b/opencode' }, 'not json at all'), { installed: true, state: 'out', major: null });
  // legacy: an older CLI without `--format json`, credentials in auth.json
  assert.deepEqual(OA.ocAuthState({ path: '/b/opencode' }, 'no array here', '{"openai":{"type":"oauth"}}'), { installed: true, state: 'in', major: null, providers: [{ id: 'openai', type: 'oauth' }] });
  assert.deepEqual(OA.ocAuthState({ path: '/b/opencode' }, '', '{}'), { installed: true, state: 'out', major: null });
  assert.deepEqual(OA.ocAuthState({ path: '/b/opencode' }, 'broken{'), { installed: true, state: 'out', major: null });
  const secret = 'sk-SECRET-VALUE';
  const st = OA.ocAuthState({ path: '/b/opencode', major: 1 }, JSON.stringify([{
    id: 'openai', name: 'OpenAI', connections: [{ method: 'api', apiKey: secret, refresh: secret }, 'bad'],
  }]), JSON.stringify({ google: { type: 'api', key: secret }, 'bad id!': { type: 'api' } }));
  assert.deepEqual(st, { installed: true, state: 'in', major: 1, providers: [{ id: 'openai', type: 'api' }] });
  assert.equal(JSON.stringify(st).includes(secret), false);
  assert.deepEqual(OA.parseOcCredentials('rc noise\n[1,2]\n'), []);
  assert.equal(OA.parseOcStatus('rc noise\n/opt/homebrew/bin/opencode\n').path, '/opt/homebrew/bin/opencode');
  assert.equal(OA.parseOcStatus('opencode: aliased to x').path, null);
  assert.equal(OA.parseOcVersion('1.19.3'), 1);
  assert.equal(OA.parseOcVersion('v2.0.0'), 2);
  assert.equal(OA.parseOcVersion('opencode v2.1.2'), 2);
  assert.equal(OA.parseOcVersion('opencode 1.2.3 (build)'), 1); // any wording of a version line is caught
  assert.equal(OA.parseOcVersion('rc noise\n2.1.0\n'), 2);
  assert.equal(OA.parseOcVersion('rc noise\noptFor 1.0\n'), null); // rc noise without an opencode line: unknown
  assert.equal(OA.parseOcStatus('rc noise\n1.19.3\n').major, 1);
  assert.equal(OA.parseOcStatus('no version here\n').major, null);
  assert.equal(OA.ocAuthFile('/h'), require('node:path').join('/h', '.local', 'share', 'opencode', 'auth.json'));
  assert.equal(OA.ocAuthFile('/h', '/data'), require('node:path').join('/data', 'opencode', 'auth.json'));
  assert.equal(OA.ocAuthFile('/h', 'relative'), require('node:path').join('/h', '.local', 'share', 'opencode', 'auth.json'));
  assert.deepEqual(OA.OC_LOGIN_ARGS, ['console', 'login']);
  assert.deepEqual(OA.OC_LOGOUT_ARGS, ['console', 'logout']);
  assert.deepEqual(OA.OC_V2_LOGIN_ARGS, ['auth', 'login', 'opencode']);
  assert.deepEqual(OA.OC_V2_LOGOUT_ARGS, ['auth', 'logout', 'opencode']);
  assert.deepEqual(OA.ocLoginArgs('console', null), OA.OC_LOGIN_ARGS);      // v1 / unknown: the chooser ways
  assert.deepEqual(OA.ocLoginArgs('auth', null), OA.OC_PROVIDER_LOGIN_ARGS);
  assert.deepEqual(OA.ocLoginArgs('logout', null), OA.OC_LOGOUT_ARGS);
  assert.deepEqual(OA.ocLoginArgs('console', 2), OA.OC_V2_LOGIN_ARGS);      // v2.x: one login, named provider
  assert.deepEqual(OA.ocLoginArgs('auth', 2), OA.OC_V2_LOGIN_ARGS);
  assert.deepEqual(OA.ocLoginArgs('logout', 2), OA.OC_V2_LOGOUT_ARGS);
});

test('OpenCode durum komutu (v3.41): rc-unset, Windows windowsCommand + ocEnv, işaretli ayrıştırma, mod listesi, çıkış seçimi', () => {
  const OA = require('../src/oc-auth.js');
  const EN = require('../src/engine.js');
  const OS = require('../src/platform.js');
  const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  // D2: the same prelude as OC_COMMAND, before the first opencode call
  const cmd = OA.OC_STATUS_COMMAND;
  assert.ok(EN.OC_COMMAND.startsWith(EN.UNSET_OFFICE_CLAUDE_ENV));
  assert.ok(cmd.indexOf(EN.UNSET_OFFICE_CLAUDE_ENV) !== -1 && cmd.indexOf(EN.UNSET_OFFICE_CLAUDE_ENV) < cmd.indexOf('opencode --version'));
  assert.equal(cmd.slice(0, cmd.indexOf(EN.UNSET_OFFICE_CLAUDE_ENV)).includes('opencode '), false);
  if (process.platform !== 'win32') {
    // run it for real with a fake opencode that prints its env: the rc-set Claude/office variables never reach it
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-oc-'));
    try {
      fs.writeFileSync(path.join(dir, 'opencode'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "\\033[?1034h1.19.3\\n"; else env; echo \'[{"id":"opencode","connections":[{"method":"oauth"}]}]\'; echo "[done]"; fi\n', { mode: 0o755 });
      const out = cp.execFileSync('/bin/sh', ['-c', 'printf "\\033[?1034h[oh-my-zsh] banner\\n"; export ANTHROPIC_API_KEY=a CLAUDE_CONFIG_DIR=c CLAUDECODE=1 AGENT_OFFICE_X=o OPENAI_API_KEY=k; ' + cmd],
        { env: { PATH: `${dir}:/usr/bin:/bin` } }).toString();
      assert.equal(/^(ANTHROPIC_|CLAUDE|AGENT_OFFICE_)/m.test(out), false); assert.match(out, /^OPENAI_API_KEY=k$/m);
      const st = { ...OA.parseOcStatus(out), raw: out };
      assert.equal(st.path, path.join(dir, 'opencode')); assert.equal(st.major, 1);
      assert.deepEqual(OA.ocAuthState(st, out), { installed: true, state: 'in', major: 1, providers: [{ id: 'opencode', type: 'oauth' }] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // D4: rc noise with brackets before or after the answer, with and without markers
  const json = '[{"id":"opencode","connections":[{"method":"oauth"}]}]';
  const want = [{ id: 'opencode', type: 'oauth' }];
  assert.deepEqual(OA.parseOcCredentials('\x1b[?1034h' + json), want);
  assert.deepEqual(OA.parseOcCredentials(json + '\n[done]\n'), want);
  assert.deepEqual(OA.parseOcCredentials('\x1b[?1034h[oh-my-zsh] hi\n' + json + '\n[done]\n'), want);
  assert.deepEqual(OA.parseOcCredentials(`[x] noise\n${OA.OC_AUTH_MARK}\n\x1b[1m${json}\x1b[0m\n[done]`), want);
  assert.deepEqual(OA.parseOcCredentials(`${OA.OC_AUTH_MARK}\n[\n {"id":"openai","connections":[{"method":"api"}]}\n]\n`), [{ id: 'openai', type: 'api' }]);
  assert.equal(OA.parseOcVersion('\x1b[?1034h1.19.3'), 1);
  assert.equal(OA.parseOcVersion(`noise 9.9.9\n${OA.OC_VERSION_MARK}\n\x1b[?1034hopencode v2.1.2\n${OA.OC_AUTH_MARK}\n3.0.0\n`), 2);
  assert.equal(OA.parseOcStatus('\x1b[?1034h/usr/local/bin/opencode\n').path, '/usr/local/bin/opencode');
  // D1: Windows runs go through windowsCommand (npm's opencode.cmd needs cmd.exe) with ocEnv's env only
  const env = EN.ocEnv({ Path: 'C:\\b', ComSpec: 'C:\\Windows\\cmd.exe', ANTHROPIC_API_KEY: 'x', CLAUDE_CONFIG_DIR: 'c', AGENT_OFFICE_X: 'o' }, 'win32');
  const runs = OA.ocWindowsStatusRuns('C:\\npm\\opencode.cmd', env, OS.windowsCommand);
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.file, 'C:\\Windows\\cmd.exe'); assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(r.options.env, env); assert.equal(r.options.windowsVerbatimArguments, true); assert.equal(r.options.windowsHide, true);
    assert.equal(Object.keys(r.options.env).some((k) => /^(ANTHROPIC|CLAUDE|AGENT_OFFICE)/i.test(k)), false);
  }
  assert.match(runs[0].args[3], /opencode\.cmd.*--version/); assert.match(runs[1].args[3], /auth list --format json/);
  const exe = OA.ocWindowsStatusRuns('C:\\oc\\opencode.exe', env, OS.windowsCommand);
  assert.deepEqual(exe.map((r) => [r.file, r.args, r.options.windowsVerbatimArguments]), [['C:\\oc\\opencode.exe', ['--version'], false], ['C:\\oc\\opencode.exe', ['auth', 'list', '--format', 'json'], false]]);
  // D3: the IPC mode allowlist
  assert.equal(OA.ocLoginMode('console'), 'console'); assert.equal(OA.ocLoginMode('auth'), 'auth'); assert.equal(OA.ocLoginMode('logout'), 'logout');
  for (const bad of ['login', undefined, null, '', 'auth; rm -rf /', ['auth'], { mode: 'auth' }, 'AUTH']) assert.equal(OA.ocLoginMode(bad), 'console');
  assert.deepEqual(OA.ocLoginArgs('auth', 1), ['auth', 'login']); // the "Provider or API key" item really runs auth login
  assert.deepEqual(OA.ocLoginArgs('whatever', 1), ['console', 'login']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /ipcMain\.handle\('oc:login', \(_e, mode\) => \{ startOcLogin\(OCA\.ocLoginMode\(mode\)\); \}\);/);
  assert.match(src, /OCA\.ocWindowsStatusRuns\(path, env, OS\.windowsCommand\)/);
  // D5: logout removes what is logged in: the OpenCode entry first, else a provider (auth logout asks which)
  const con = [{ id: 'opencode', type: 'oauth' }], prov = [{ id: 'openai', type: 'api' }];
  assert.deepEqual(OA.ocLoginArgs('logout', 1, con), ['console', 'logout']);
  assert.deepEqual(OA.ocLoginArgs('logout', 1, [...prov, ...con]), ['console', 'logout']);
  assert.deepEqual(OA.ocLoginArgs('logout', 1, prov), ['auth', 'logout']);
  assert.deepEqual(OA.ocLoginArgs('logout', 2, con), ['auth', 'logout', 'opencode']);
  assert.deepEqual(OA.ocLoginArgs('logout', 2, prov), ['auth', 'logout']);
  assert.deepEqual(OA.ocLoginArgs('logout', null, []), ['console', 'logout']); // nothing known: as before
});

test('startOpenCode: ortam yalnız ocEnv; Claude Code ve ofis hiçbir şey vermez; transkript okunmaz (v3.40)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf('function startOpenCode(');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n}\n', start)).replace(/\/\/.*$/gm, '');
  assert.match(body, /const env = EN\.ocEnv\(process\.env\);/);
  assert.match(body, /engine: 'opencode', label: 'OpenCode'/);
  for (const banned of ['sessionEnv', 'ptyEnv', 'officeDirectoryFile', 'AGENT_OFFICE_', 'sharedConfig', 'pluginDir', 'usageStatusLine', 'managerOf', 'savings', 'CLAUDE_', 'env.', 'env['])
    assert.equal(body.includes(banned), false, `startOpenCode uses ${banned}`);
  // the login pty gets the same allowlist, and the app never reads anything but auth.json's provider names
  const login = src.slice(src.indexOf('function startOcLogin('), src.indexOf('// --- account quota'));
  assert.match(login, /const env = EN\.ocEnv\(process\.env\);/);
  assert.match(src, /if \(isOc\(r\.project\)\) return startOpenCode\(id, r, \{ resume, prompt \}\);/);
  assert.match(src, /const file = !dir \|\| isOc\(r\.project\) \? null/);
});

test('OpenCode sekmesi gözlemlenir: agy-watch engine opencode ("esc interrupt" meşgul çizgisi), uyku { oc } ile --continue (v3.40)', () => {
  const AWm = require('../src/agy-watch.js');
  const Zm = require('../src/sleep.js');
  const w = AWm.createAgyWatch(1000, { engine: 'opencode', label: 'OpenCode' });
  assert.equal(w.isBusy, false);
  w.output('█ working…  esc interrupt', 1100);
  assert.equal(w.isBusy, true);
  w.output('Permission required  Allow once  Allow always  Reject', 1300);
  assert.equal(w.waiting?.kind, 'permission');
  w.input('\r', 1400);
  assert.equal(w.tick(20000), true);
  const s = w.session('p', 'oc-x', 20000);
  assert.equal(s.engine, 'opencode');
  assert.equal(s.stats.today.log[0].description, 'OpenCode');
  assert.deepEqual(Zm.wakeOptions({ oc: true }, false), { resume: true });
});

// --- opt-in project files (contract v3.38, src/project-files.js)
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const PF = require('../src/project-files.js');
  const repo = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pf-')));
    fs.mkdirSync(path.join(d, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n');
    return d;
  };
  const list = (d) => {
    const out = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (r === '.git') continue;
        if (e.isDirectory()) walk(r); else out.push(r);
      }
    };
    walk('');
    return out.sort();
  };
  const mcp = { mcpServers: {
    db: { command: 'npx', args: ['db-mcp'], env: { DB: 'x' }, cwd: '.' },
    web: { type: 'http', url: 'https://example.com/mcp', headers: { A: 'b' } },
    nope: { command: 'evil' },
  } };
  const all = { engine: 'agy', enabled: true, manager: true, agentModel: 'opus', projectMcp: mcp, approved: ['db', 'web'] };

  test('project files: off writes nothing; agy on writes exactly our files, marked, and excludes them', () => {
    assert.deepEqual(PF.desiredFiles({ ...all, enabled: false }), []);
    assert.deepEqual(PF.desiredFiles({ engine: 'claude', enabled: true, manager: true, agentModel: 'opus' }), []);
    const d = repo();
    const r = PF.syncProjectFiles(d, PF.desiredFiles(all));
    const ours = ['.agents/agents/ao-worker.md', '.agents/hooks.json', '.agents/mcp_config.json', '.agents/rules/agent-office-manager.md'];
    assert.deepEqual(r.written.sort(), ours);
    assert.deepEqual(list(d), [...ours.slice(0, 2), '.agents/.agent-office-files.json', ...ours.slice(2)].sort());
    const rule = fs.readFileSync(path.join(d, ours[3]), 'utf8');
    assert.match(rule, /^---\ntrigger: always_on\n/); // docs/rules: the frontmatter comes first
    assert.match(rule, new RegExp(PF.MARKER));
    assert.match(fs.readFileSync(path.join(d, ours[0]), 'utf8'), /\nname: ao-worker\n[\s\S]*\nmodel: pro\n/);
    const hooks = JSON.parse(fs.readFileSync(path.join(d, ours[1]), 'utf8'));
    assert.deepEqual(Object.keys(hooks), [PF.HOOK_NAME]);
    assert.equal(hooks[PF.HOOK_NAME].Stop[0].type, 'command');
    const ex = fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8');
    assert.match(ex, /^# git ls-files[^\n]*\n\*\.log\n/); // the user's lines stay
    for (const f of [...ours, '.agents/.agent-office-files.json']) assert.ok(ex.includes(`\n/${f}\n`), f);
    const out = execFileSync('git', ['-C', d, 'init', '-q'], { encoding: 'utf8' }) + execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    assert.equal(out.trim(), ''); // git sees none of them
    // the same again changes nothing
    assert.deepEqual(PF.syncProjectFiles(d, PF.desiredFiles(all)), { written: [], removed: [], refused: [] });
    // off: exactly our files go, the exclude block too, the user's lines stay
    const off = PF.syncProjectFiles(d, []);
    assert.deepEqual(off.removed.sort(), ours);
    assert.deepEqual(list(d), []);
    assert.equal(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n');
  });

  test('project files: a user file of the same name is never overwritten or removed; nor ours once the user edits it', () => {
    const d = repo();
    fs.mkdirSync(path.join(d, '.agents', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(d, '.agents', 'rules', 'agent-office-manager.md'), 'mine');
    fs.writeFileSync(path.join(d, '.agents', 'mcp_config.json'), '{"mcpServers":{}}');
    fs.writeFileSync(path.join(d, '.agents', 'rules', 'style.md'), 'keep');
    const r = PF.syncProjectFiles(d, PF.desiredFiles(all));
    assert.deepEqual(r.refused.sort(), ['.agents/mcp_config.json', '.agents/rules/agent-office-manager.md']);
    assert.equal(fs.readFileSync(path.join(d, '.agents', 'rules', 'agent-office-manager.md'), 'utf8'), 'mine');
    assert.equal(fs.readFileSync(path.join(d, '.agents', 'mcp_config.json'), 'utf8'), '{"mcpServers":{}}');
    assert.ok(!fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8').includes('mcp_config.json')); // not ours: not excluded
    fs.writeFileSync(path.join(d, '.agents', 'hooks.json'), '{"edited":{}}'); // the user edits ours
    const off = PF.syncProjectFiles(d, []);
    assert.deepEqual(off.removed, ['.agents/agents/ao-worker.md']);
    assert.ok(off.refused.includes('.agents/hooks.json'));
    assert.deepEqual(list(d), ['.agents/hooks.json', '.agents/mcp_config.json', '.agents/rules/agent-office-manager.md', '.agents/rules/style.md']);
  });

  test('project files: MCP comes only from the project\'s own approved .mcp.json, translated to agy\'s schema', () => {
    assert.deepEqual(PF.agyMcpServers(mcp, ['db', 'web']), {
      db: { command: 'npx', args: ['db-mcp'], env: { DB: 'x' }, cwd: '.' },
      web: { serverUrl: 'https://example.com/mcp', headers: { A: 'b' } },
    });
    assert.deepEqual(PF.agyMcpServers(mcp, []), {}); // nothing approved: nothing goes
    assert.deepEqual(PF.agyMcpServers(null, ['db']), {});
    const files = PF.desiredFiles({ ...all, approved: ['db'] });
    const m = files.find((f) => f.rel === '.agents/mcp_config.json');
    assert.deepEqual(JSON.parse(m.content), { mcpServers: { db: mcp.mcpServers.db } });
    assert.ok(!PF.desiredFiles({ ...all, approved: [] }).some((f) => f.rel.endsWith('mcp_config.json')));
    // no leak: nothing of Claude Code's or the office's setup in any file
    for (const f of files) assert.doesNotMatch(f.content, /CLAUDE_|AGENT_OFFICE_|office-mcp|office\.json|\.claude|userData|journal/i, f.rel);
    // manager off: no brief, no Stop gate; Auto agent model: no worker
    assert.deepEqual(PF.desiredFiles({ ...all, manager: false, agentModel: null, approved: [] }), []);
  });

  test('project files: Command Code gets only the worker agent; switching engine swaps the files', () => {
    const cc = PF.desiredFiles({ engine: 'commandcode', enabled: true, manager: true, agentModel: 'haiku', projectMcp: mcp, approved: ['db'] });
    assert.deepEqual(cc.map((f) => f.rel), ['.commandcode/agents/ao-worker.md']);
    assert.match(cc[0].content, /\nmodel: claude-haiku-5-5\ntools: "\*"\n/);
    const d = repo();
    PF.syncProjectFiles(d, PF.desiredFiles(all));
    const r = PF.syncProjectFiles(d, cc);
    assert.deepEqual(r.written, ['.commandcode/agents/ao-worker.md']);
    assert.equal(r.removed.length, 4);
    assert.deepEqual(list(d), ['.commandcode/.agent-office-files.json', '.commandcode/agents/ao-worker.md']);
  });

  test('project files: a project inside a repository or a worktree gets its exclude entries in the common git dir', () => {
    const d = repo();
    const sub = path.join(d, 'pkg');
    fs.mkdirSync(sub);
    PF.syncProjectFiles(sub, PF.desiredFiles({ engine: 'commandcode', enabled: true, agentModel: 'opus' }));
    assert.ok(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8').includes('\n/pkg/.commandcode/agents/ao-worker.md\n'));
    const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wt-')));
    fs.mkdirSync(path.join(d, '.git', 'worktrees', 'w'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'worktrees', 'w', 'commondir'), '../..\n');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(d, '.git', 'worktrees', 'w')}\n`);
    assert.equal(PF.gitExclude(wt).file, path.join(d, '.git', 'info', 'exclude'));
  });

  test('project files: the Stop gate sends the agent back once per execution (docs/hooks Stop output)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stop-'));
    const run = (n) => JSON.parse(execFileSync('sh', ['-c', PF.STOP_COMMAND], {
      input: JSON.stringify({ executionNum: n, conversationId: 'c-1', fullyIdle: true }, null, 2), env: { PATH: process.env.PATH, TMPDIR: tmp }, encoding: 'utf8',
    }));
    assert.deepEqual(run(1), { decision: 'continue', reason: PF.STOP_REASON });
    assert.equal(run(1).decision, 'stop');
    assert.equal(run(2).decision, 'continue');
    assert.equal(run(3).decision, 'stop');
    assert.equal(JSON.parse(execFileSync('sh', ['-c', PF.STOP_COMMAND], { input: '{}', encoding: 'utf8' })).decision, 'stop');
  });

  test('project files toggle: off by default, only true is stored', () => {
    const s = { projects: [{ id: 'a', dir: '/a', engine: 'agy' }], accounts: [] };
    assert.equal(P.projectFilesOf(P.findProject(s, 'a')), false);
    assert.equal(P.setProjectFiles(s, 'a', false), s);
    const on = P.setProjectFiles(s, 'a', true);
    assert.equal(P.findProject(on, 'a').projectFiles, true);
    assert.equal('projectFiles' in P.findProject(P.setProjectFiles(on, 'a', false), 'a'), false);
    assert.deepEqual(P.normalizeState({ projects: [{ dir: '/x', projectFiles: true }, { dir: '/y', projectFiles: 'yes' }] }).projects.map((p) => p.projectFiles ?? null), [true, null]);
  });
}

test('review fixes: bossModel survives another engine, exclude merge, secret file mode, symlinked roots', () => {
  const s = P.normalizeState({ projects: [{ id: 'a', dir: '/a', engine: 'agy', bossModel: 'opus' }, { id: 'b', dir: '/b', bossModel: 'nonsense' }] });
  assert.equal(s.projects[0].bossModel, 'opus'); // kept while agy is active
  assert.deepEqual(P.bossModelArgs(s.projects[0]), []); // but no flag for agy
  assert.equal('bossModel' in s.projects[1], false);
  const PF = require('../src/project-files.js');
  const own = [PF.EXCLUDE_BEGIN, '/a/.agents/x', PF.EXCLUDE_END].join('\n') + '\n';
  const merged = PF.mergeExclude(own, 'b', ['.agents/y']);
  assert.match(merged, /\/a\/\.agents\/x\n\/b\/\.agents\/y\n/); // other project's line kept
  assert.equal(PF.mergeExclude(merged, 'b', []).includes('/b/'), false);
  assert.match(PF.mergeExclude(merged, 'b', []), /\/a\/\.agents\/x/);
  const noEnd = ['user-line', PF.EXCLUDE_BEGIN, '/.agents/old', 'keep-me'].join('\n') + '\n';
  const out = PF.mergeExclude(noEnd, '', ['.agents/new']);
  assert.match(out, /keep-me/); assert.match(out, /user-line/); assert.equal(out.includes('/.agents/old'), false);
  const os2 = require('os'); const fs2 = require('fs'); const pa = require('path');
  const d = fs2.mkdtempSync(pa.join(os2.tmpdir(), 'ao-pf-'));
  const r = PF.syncProjectFiles(d, PF.desiredFiles({ engine: 'agy', enabled: true, projectMcp: { mcpServers: { s: { command: 'x', env: { K: 'v' } } } }, approved: ['s'] }));
  assert.ok(r.written.includes('.agents/mcp_config.json'));
  if (process.platform !== 'win32') assert.equal(fs2.statSync(pa.join(d, '.agents/mcp_config.json')).mode & 0o077, 0);
  const d2 = fs2.mkdtempSync(pa.join(os2.tmpdir(), 'ao-pf-')); const out2 = fs2.mkdtempSync(pa.join(os2.tmpdir(), 'ao-out-'));
  fs2.symlinkSync(out2, pa.join(d2, '.agents'));
  const r2 = PF.syncProjectFiles(d2, PF.desiredFiles({ engine: 'agy', enabled: true, manager: true }));
  assert.deepEqual(fs2.readdirSync(out2), []); assert.ok(r2.warnings.includes('.agents'));
});

// --- plain terminal tab (contract v3.42)
test('düz terminal sekmesi: shell:true + dir saklanır, motor id\'lerinde yok, allPtyIdsOf\'ta var (v3.42)', () => {
  const P = require('../src/projects.js');
  const tabs = P.normalizeTabs([{ n: 2, dir: '/x/y', shell: true }, { n: 3, shell: true }, { n: 4 }]);
  assert.deepEqual(tabs, [{ n: 2, dir: '/x/y', shell: true }, { n: 4 }]); // a shell without a folder is dropped
  const p = { id: 'p1', name: 'p', dir: '/p', tabs };
  assert.deepEqual(P.ptyIdsOf(p), ['p1', 'p1:4']);
  assert.deepEqual(P.allPtyIdsOf(p), ['p1', 'p1:2', 'p1:4']);
  assert.equal(P.resolvePty({ projects: [p] }, 'p1:2').dir, '/x/y');
  assert.deepEqual(P.sessionAliases([{ ...p, tabs: [{ n: 2, dir: '/other/zed', shell: true }] }]), {});
});
test('düz terminal sekmesi: main.js başlatır, uyutmaz, motor mantığına sokmaz (v3.42)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  assert.match(src, /if \(r\.tab\?\.shell\) return startShell\(id, r\)/);
  const body = src.slice(src.indexOf('function startShell'), src.indexOf('function startOpenCode'));
  assert.match(body, /const env = A\.shellEnv\(process\.env\)/); // the env builder tested below is the one it uses
  assert.doesNotMatch(body, /sessionEnv|claudeArgs|plugin/);
});
test('düz terminal sekmesi: ortamdan CLAUDE*/ANTHROPIC_*/AGENT_OFFICE_* düşer, kullanıcınınki kalır (v3.42)', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/h', OPENAI_API_KEY: 'k', LANG: 'tr_TR.UTF-8', MY_CLAUDE_NOTE: 'x',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/c', CLAUDE_PID: '9', CLAUDE_FOO: 'y',
    ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'u', AGENT_OFFICE_CONFIG_DIR: '/c', AGENT_OFFICE_TOKEN: 't',
  };
  const env = A.shellEnv(base);
  assert.deepEqual(Object.keys(env).filter((k) => /^(CLAUDE|ANTHROPIC_|AGENT_OFFICE_)/.test(k)), []);
  for (const k of ['PATH', 'HOME', 'OPENAI_API_KEY', 'LANG', 'MY_CLAUDE_NOTE']) assert.equal(env[k], base[k], k);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(base.CLAUDECODE, '1'); // the input is not changed
});

// --- connectors (contract v3.43)
test('bağlantı: adres ve ad doğrulanır, sunucu girdisi bearer başlığı taşır, token dosyada yok (v3.43)', () => {
  const C = require('../src/connectors.js');
  assert.equal(C.validate({ label: '', url: 'https://x.io/mcp' }), 'name');
  assert.equal(C.validate({ label: 'N', url: 'ftp://x' }), 'url');
  assert.equal(C.validate({ label: 'N', url: 'https://x.io/mcp' }), null);
  const s = C.serverFor({ mcp: { label: 'My Notion', url: 'https://x.io/mcp' } }, 'tok');
  assert.deepEqual(s, { 'conn-my-notion': { type: 'http', url: 'https://x.io/mcp', headers: { Authorization: 'Bearer tok' } } });
  assert.equal(C.serverFor({}, 'tok'), null);
  assert.deepEqual(C.serverFor({ mcp: { label: 'A', url: 'https://x.io/' } }, '')['conn-a'], { type: 'http', url: 'https://x.io/' });
});
test('bağlantı: Türkçe harfler klasör adında korunur, "Bearer " ile yapıştırılan token tek Bearer olur (v3.43)', () => {
  const C = require('../src/connectors.js');
  assert.equal(C.slug('Kişisel Notlar'), 'kisisel-notlar');
  assert.equal(C.slug('IŞIK Ğüzöç Çay'), 'isik-guzoc-cay');
  assert.equal(C.defaultDir('/r', 'Şirket Ağı', () => false), '/r/sirket-agi');
  assert.equal(C.serverName('Müşteri'), 'conn-musteri');
  assert.equal(C.cleanToken('  Bearer abc123 '), 'abc123');
  assert.equal(C.cleanToken('bearer   abc'), 'abc');
  assert.equal(C.cleanToken('abc'), 'abc');
  assert.equal(C.cleanToken(undefined), '');
  const s = C.serverFor({ mcp: { label: 'A', url: 'https://x.io/' } }, C.cleanToken('Bearer tok'));
  assert.equal(s['conn-a'].headers.Authorization, 'Bearer tok');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  assert.equal((src.match(/C\.cleanToken\(f\?\.token\)/g) || []).length, 2, 'connectors:add and connectors:update clean the token');
});
test('bağlantı: yalnız Claude Code; başka motor reddedilir, seçicide gösterilir ama kapalı (v3.43)', () => {
  const P = require('../src/projects.js');
  const st = { projects: [{ id: 'p', dir: '/r/p', name: 'p', accountId: 'default' }], accounts: [{ id: 'default', label: 'V' }], activeId: 'p' };
  const a = P.addConnector(st, '/r/conn', { label: 'Notion', url: 'https://x.io/mcp' });
  for (const eng of ['agy', 'commandcode', 'opencode']) {
    assert.equal(P.engineRefused(a.project, eng), true);
    assert.equal(P.setProjectEngine(a.state, a.project.id, eng), a.state, `a connector must not switch to ${eng}`);
    assert.equal(P.engineRefused(P.findProject(a.state, 'p'), eng), false);
    assert.equal(P.engineOf(P.findProject(P.setProjectEngine(a.state, 'p', eng), 'p')), eng); // a plain project still can
  }
  assert.equal(P.engineRefused(a.project, null), false);
  assert.equal(P.engineRefused(a.project, 'claude'), false);
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(src, /projects:setEngine'[\s\S]{0,200}P\.engineRefused\(p, value\)\) return \{ restarted: \[\], refused: 'connector' \}/);
  const sb = fs.readFileSync(path.join(__dirname, '../renderer/sidebar.js'), 'utf8');
  assert.match(sb, /const connOnly = Boolean\(p\.mcp\)/);
  assert.match(sb, /disabled: connOnly && !selected/);
  for (const l of ['en', 'tr']) assert.ok(require(`../locales/${l}.json`).sidebar.connClaudeOnly, `${l}: sidebar.connClaudeOnly`);
});
test('bağlantı: adres proje klasörüne yazılmaz; sunucu yalnız userData altındaki 0600 sekme MCP dosyasında (v3.43)', () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const C = require('../src/connectors.js');
  const SC = require('../src/shared-config.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-conn-'));
  try {
    const home = path.join(root, 'home'); const cwd = path.join(root, 'repo'); const userData = path.join(root, 'userData');
    fs.mkdirSync(home); fs.mkdirSync(cwd);
    const mcpFile = path.join(userData, 'mcp', SC.mcpFileName('k1'));
    const extra = C.serverFor({ mcp: { label: 'Notion', url: 'https://x.io/s/secret/mcp' } }, 'tok');
    const r = SC.prepareShared({ account: { id: 'default' }, home, cwd, stageRoot: path.join(userData, 'stage'), mcpFile, extra });
    assert.equal(r.mcpConfig, mcpFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers['conn-notion'].url, 'https://x.io/s/secret/mcp');
    if (process.platform !== 'win32') assert.equal(fs.statSync(mcpFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing is written into the project folder');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(C.META_FILE, undefined);
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.doesNotMatch(src, /writeConnectorMeta|agent-office-mcp\.json|META_FILE/);
});
test('bağlantı: varsayılan klasör kararlı, başkasının klasörünü almaz; düzenleme klasörü (geçmişi) korur (v3.43)', () => {
  const C = require('../src/connectors.js');
  const P = require('../src/projects.js');
  assert.equal(C.defaultDir('/r', 'My Notion', () => false), '/r/my-notion');
  assert.equal(C.defaultDir('/r', 'My Notion', (d) => d === '/r/my-notion'), '/r/my-notion-2');
  const st = { projects: [], accounts: [{ id: 'default', label: 'Varsayılan' }], activeId: null };
  const a = P.addConnector(st, '/r/my-notion', { label: 'My Notion', url: 'https://x.io/mcp' });
  assert.ok(a.project.mcp && a.project.name === 'my-notion');
  assert.equal(P.addConnector(a.state, '/r/my-notion', { label: 'X', url: 'https://y.io' }), null); // the folder is taken
  const b = P.setConnector(a.state, a.project.id, { label: 'Notion 2', url: 'https://z.io/mcp' });
  const p = P.findProject(b, a.project.id);
  assert.equal(p.dir, '/r/my-notion'); assert.equal(p.id, a.project.id); assert.equal(p.mcp.label, 'Notion 2');
  assert.equal(P.setConnector(b, a.project.id, { label: 'Notion 2', url: 'https://z.io/mcp' }), b); // nothing changed
  const n = P.normalizeState({ projects: [{ id: 'a', dir: '/r/my-notion', mcp: { label: 'N', url: 'javascript:1' } }] });
  assert.equal(n.projects[0].mcp, undefined); // a bad address is dropped
});
test('bağlantı: token şifreli saklanır, yazılamazsa eskisi kalır ve false döner; kaldırılınca silinir (v3.43)', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const C = require('../src/connectors.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tok-'));
  try {
    const dir = path.join(root, 'connector-tokens');
    const safe = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc:${t}`), decryptString: (b) => String(b).replace(/^enc:/, '') };
    const st = C.tokenStore(dir, safe);
    assert.equal(st.has('p1'), false);
    assert.equal(st.save('p1', 'sekret-1'), true);
    assert.equal(st.has('p1'), true); assert.equal(st.load('p1'), 'sekret-1');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'p1.bin'), 'utf8'), /^sekret/); // the stored bytes are the encrypted form
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'p1.bin')).mode & 0o777, 0o600);
    // the write fails: false, the old token stays
    const failing = C.tokenStore(dir, safe, { ...fs, writeFileSync: () => { throw new Error('disk full'); } });
    assert.equal(failing.save('p1', 'sekret-2'), false);
    assert.equal(st.load('p1'), 'sekret-1');
    // encryption itself fails: false too
    assert.equal(C.tokenStore(dir, { ...safe, encryptString: () => { throw new Error('keyring locked'); } }).save('p1', 'x'), false);
    assert.equal(st.load('p1'), 'sekret-1');
    // no keyring: a 0600 plain file; the old encrypted one goes
    const plain = C.tokenStore(dir, { ...safe, isEncryptionAvailable: () => false });
    assert.equal(plain.save('p1', 'sekret-3'), true);
    assert.equal(fs.existsSync(path.join(dir, 'p1.bin')), false); assert.equal(plain.load('p1'), 'sekret-3');
    assert.equal(st.save('p1', ''), true); assert.equal(st.has('p1'), false); // empty = cleared
    st.save('p2', 'z'); st.remove('p2'); assert.equal(st.has('p2'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('bağlantı: main.js anahtarı kaydedemezse hiçbir şeyi değiştirmez; her kaldırma yolu anahtarı siler (v3.43)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  assert.match(src, /const tokens = \(\) => C\.tokenStore\(tokenDir\(\), safeStorage\)/);
  assert.match(src, /C\.serverFor\(project, loadConnectorToken\(project\.id\)\)/);
  const add = src.slice(src.indexOf("ipcMain.handle('connectors:add'"), src.indexOf("ipcMain.handle('connectors:update'"));
  assert.ok(add.indexOf("error: 'token'") > 0 && add.indexOf("error: 'token'") < add.indexOf('commit(r.state)'));
  const upd = src.slice(src.indexOf("ipcMain.handle('connectors:update'"), src.indexOf("ipcMain.handle('projects:openFolder'"));
  assert.ok(upd.indexOf("error: 'token'") > 0 && upd.indexOf("error: 'token'") < upd.indexOf('commit(next)'));
  // every path that removes a project: projects:remove and the handoff release
  const removals = src.split('commit(P.removeProject(').length - 1;
  assert.equal(removals, 2);
  assert.equal((src.match(/if \(p\??\.mcp\) deleteConnectorToken\(p\.id\)/g) || []).length, 2);
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '../preload.js'), 'utf8'), /loadConnectorToken|token\s*:\s*\(/);
});
test('bağlantı: renderer anlık görüntüsünde adres yok; adres yalnız connectors:get ile (v3.43)', () => {
  const st = P.addConnector({ projects: [{ id: 'x', dir: '/x', name: 'x', accountId: 'default' }], accounts: [{ id: 'default', label: 'D' }], activeId: 'x' }, '/r/n', { label: 'N', url: 'https://srv.example/s/KEY123/mcp' }).state;
  const out = P.forRenderer(st.projects);
  assert.doesNotMatch(JSON.stringify(out), /srv\.example|KEY123|"url"/);
  const c = out.find((p) => p.mcp);
  assert.deepEqual(c.mcp, { label: 'N', hasUrl: true });
  assert.equal(out.find((p) => p.id === 'x'), st.projects.find((p) => p.id === 'x')); // other projects untouched
  assert.ok(st.projects.find((p) => p.mcp).mcp.url); // state itself keeps it
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  assert.match(src, /const snapshot = \(\) => \(\{\n {2}projects: P\.forRenderer\(state\.projects\)/);
  assert.match(src, /ipcMain\.handle\('connectors:get'[\s\S]{0,200}url: p\.mcp\.url/);
});
test('bağlantı: devredilmez (v3.29 nedeni connection, en+tr); normalizeState motoru düşürür (v3.43)', () => {
  const H = require('../src/handoff.js');
  assert.equal(H.refusal({ connection: true, engine: 'claude', git: true, online: true }), 'connection');
  assert.equal(H.refusal({ connection: false, engine: 'claude', git: true, online: true }), null);
  assert.equal(H.refusal({ connection: true, engine: 'claude', git: true, online: false }), 'offline');
  for (const l of ['en', 'tr']) {
    const j = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, `../locales/${l}.json`), 'utf8'));
    const reasons = Object.values(j).find((v) => v && typeof v === 'object' && v.handoffReason)?.handoffReason;
    assert.ok(reasons?.connection, l);
  }
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/link-host.js'), 'utf8');
  assert.match(src, /H\.refusal\(\{ connection: info\.connection,/);
  const n = P.normalizeState({ projects: [{ id: 'a', dir: '/c', engine: 'opencode', mcp: { label: 'N', url: 'https://x.io/mcp' } }, { id: 'b', dir: '/d', engine: 'opencode' }] });
  assert.equal(n.projects[0].engine, undefined); assert.ok(n.projects[0].mcp);
  assert.equal(n.projects[1].engine, 'opencode');
});
