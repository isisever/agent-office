// Main'in saf durum mantığı: node --test test/main.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/projects.js');
const A = require('../src/accounts.js');

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

test('authFromRun: çıkış kodu sıfır değilse de JSON geçerli; zaman aşımı, claude yok, stderr', () => {
  const code1 = Object.assign(new Error('Command failed'), { code: 1 });
  assert.deepEqual(A.authFromRun(code1, 'noise\n{"loggedIn": false}\n', ''), { state: 'out' });
  assert.deepEqual(A.authFromRun(null, '{"loggedIn": true, "email": "e@x"}', ''), { state: 'in', email: 'e@x' });
  const timeout = Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL', code: null });
  assert.deepEqual(A.authFromRun(timeout, '', ''), { state: 'error', errorKey: 'timeout' });
  assert.deepEqual(A.localizeAuth(A.authFromRun(timeout, '', ''), 'tr'), { state: 'error', error: 'zaman aşımı' });
  assert.deepEqual(A.localizeAuth(A.authFromRun(Object.assign(new Error('x'), { code: 127 }), '', 'zsh: command not found: claude'), 'en'),
    { state: 'error', error: 'claude not found' });
  assert.deepEqual(A.localizeAuth({ state: 'in', email: 'e' }, 'en'), { state: 'in', email: 'e' });
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
