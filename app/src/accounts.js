// Claude Code hesapları: saf durum işlevleri ve pty ortamı (Electron yok; node --test ile sınanır).
//
// Girişler nasıl ayrılıyor (Claude Code 2.1.295, macOS; code.claude.com/docs/en/authentication):
// - Giriş bilgisi macOS Anahtar Zinciri'nde ("Claude Code-credentials" öğesi) durur; zincir yazmayı
//   reddederse <config>/.credentials.json'a (0600) düşer.
// - CLAUDE_CONFIG_DIR verilirse .credentials.json o klasöre gider VE zincir öğesi o klasöre göre
//   anahtarlanır: farklı CLAUDE_CONFIG_DIR farklı öğeyi okur. Belgelenmiş çoklu hesap yolu budur.
//   Denendi: boş bir CLAUDE_CONFIG_DIR ile `claude auth status` → loggedIn:false, varsayılan girişi görmüyor.
// - Ayrılmayanlar: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_PROFILE
//   ortamdaysa tüm hesaplarda girişin önüne geçer; API anahtarı olmadan yapılan Console girişi
//   (Anthropic profili, ~/.config/anthropic) klasör dışında durduğu için ayrılmaz.
// - Yeni klasör boş başlar: ~/.claude'daki ayarlar, eklentiler, MCP sunucuları, CLAUDE.md o hesapta yok.
const path = require('path');

const DEFAULT_ID = 'default';
const DEFAULT_ACCOUNT = Object.freeze({ id: DEFAULT_ID, label: 'Varsayılan', configDir: null });

// Varsayılan hesap her zaman ilk sırada ve configDir'i null.
function normalizeAccounts(list) {
  const out = [{ ...DEFAULT_ACCOUNT }];
  const seen = new Set([DEFAULT_ID]);
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.id !== 'string' || !a.id || seen.has(a.id)) continue;
    if (typeof a.configDir !== 'string' || !a.configDir) continue;
    seen.add(a.id);
    out.push({ id: a.id, label: cleanLabel(a.label, a.id), configDir: a.configDir });
  }
  return out;
}

const cleanLabel = (label, fallback) => (typeof label === 'string' && label.trim()) || fallback;

// configDir = <root>/<id>; root main'de userData/accounts. Klasörü main oluşturur.
function addAccount(state, label, { id, root }) {
  const account = { id, label: cleanLabel(label, `Hesap ${state.accounts.length}`), configDir: path.join(root, id) };
  return { state: { ...state, accounts: [...state.accounts, account] }, account };
}

function renameAccount(state, id, label) {
  const l = typeof label === 'string' ? label.trim() : '';
  if (!l || id === DEFAULT_ID) return state;
  return { ...state, accounts: state.accounts.map((a) => (a.id === id ? { ...a, label: l } : a)) };
}

// Hesap silinince projeleri varsayılana geçer; `moved` yeniden başlatılacak proje id'leri.
function removeAccount(state, id) {
  if (id === DEFAULT_ID || !state.accounts.some((a) => a.id === id)) return { state, moved: [] };
  const moved = state.projects.filter((p) => p.accountId === id).map((p) => p.id);
  return {
    state: {
      ...state,
      accounts: state.accounts.filter((a) => a.id !== id),
      projects: state.projects.map((p) => (p.accountId === id ? { ...p, accountId: DEFAULT_ID } : p)),
    },
    moved,
  };
}

const accountOf = (state, project) =>
  state.accounts.find((a) => a.id === project?.accountId) || state.accounts.find((a) => a.id === DEFAULT_ID) || DEFAULT_ACCOUNT;

// Uygulama bir claude oturumunun içinden açıldıysa iç içe oturum işaretlerini temizle; üst sürecin
// CLAUDE_CONFIG_DIR'ini de alma (varsayılan hesap sistemin ~/.claude'u). Hesabın klasörü varsa onu ver.
function ptyEnv(base, configDir = null) {
  const env = { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CONFIG_DIR$|AGENT_OFFICE_CONFIG_DIR$)/.test(k)) delete env[k];
  }
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir;
    // giriş kabuğunun rc dosyaları CLAUDE_CONFIG_DIR'i ezebilir; komut bunu son anda yeniden ayarlar
    env.AGENT_OFFICE_CONFIG_DIR = configDir;
  }
  return env;
}

// --- giriş durumu (`claude auth status --json`)

// Çıktıdaki son JSON nesnesi: rc dosyaları önüne/arkasına gürültü basabilir. Dizgelerdeki
// süslü parantezleri sayan bir tarama ile en dıştaki nesneler bulunur; ayrışan sonuncusu döner.
function lastJsonObject(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  let found = null;
  let i = s.indexOf('{');
  while (i >= 0) {
    const end = matchBrace(s, i);
    if (end < 0) break;
    let obj;
    try { obj = JSON.parse(s.slice(i, end + 1)); } catch { obj = undefined; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      found = obj;
      i = s.indexOf('{', end + 1);
    } else {
      i = s.indexOf('{', i + 1);
    }
  }
  return found;
}

// s[start] === '{' için eşleşen '}' konumu; yoksa -1.
function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return -1;
}

const shortError = (msg) => {
  const line = String(msg ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'bilinmeyen hata';
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
};

// `auth status --json` nesnesi → AccountAuth (bkz. CONTRACT.md).
function authFromStatus(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.loggedIn !== 'boolean') {
    return { state: 'error', errorKey: 'unreadable' };
  }
  if (!obj.loggedIn) return { state: 'out' };
  const auth = { state: 'in' };
  if (typeof obj.email === 'string' && obj.email) auth.email = obj.email;
  if (typeof obj.authMethod === 'string' && obj.authMethod) auth.method = obj.authMethod;
  return auth;
}

// execFile sonucu → AccountAuth. Çıkış kodu sıfır olmasa da stdout'ta JSON varsa o geçerlidir.
function authFromRun(err, stdout, stderr) {
  const obj = lastJsonObject(stdout);
  if (obj && typeof obj.loggedIn === 'boolean') return authFromStatus(obj);
  if (err && (err.killed || err.signal) && !err.code) return { state: 'error', errorKey: 'timeout' };
  if (err && err.code === 127) return { state: 'error', errorKey: 'noClaude' };
  if (err && err.code === 'ENOENT') return { state: 'error', errorKey: 'noShell' };
  if (err) return { state: 'error', error: shortError(stderr || err.message) };
  return { state: 'error', errorKey: 'unreadable' };
}

// Bilinen hatalar anahtarla saklanır, renderer'a o anki dilde gider (dil sonradan değişebilir).
const AUTH_ERRORS = {
  tr: { unreadable: 'giriş durumu okunamadı', timeout: 'zaman aşımı', noClaude: 'claude bulunamadı', noShell: 'kabuk bulunamadı' },
  en: { unreadable: 'could not read the login status', timeout: 'timed out', noClaude: 'claude not found', noShell: 'shell not found' },
};
function localizeAuth(auth, lang) {
  if (!auth?.errorKey) return auth;
  const { errorKey, ...rest } = auth;
  return { ...rest, error: (AUTH_ERRORS[lang] || AUTH_ERRORS.en)[errorKey] || errorKey };
}

// Giriş kabuğu (`$SHELL -l -i -c`) ile çalışan claude komutu; hesap klasörü rc'lerden sonra yeniden verilir.
const claudeCommand = (args) =>
  '[ -n "$AGENT_OFFICE_CONFIG_DIR" ] && export CLAUDE_CONFIG_DIR="$AGENT_OFFICE_CONFIG_DIR"; exec claude ' + args;

// Renderer'a giden hesaplar: auth bellekte tutulur, state.json'a yazılmaz; kota bilinmiyorsa alan yok.
const withAuth = (accounts, authOf, usageOf = () => undefined) =>
  accounts.map((a) => {
    const usage = usageOf(a.id);
    return { ...a, auth: authOf(a.id) || { state: 'checking' }, ...(usage ? { usage } : {}) };
  });

const LOGIN_PREFIX = 'login:';
const loginPtyId = (accountId) => LOGIN_PREFIX + accountId;
const loginAccountId = (ptyId) =>
  typeof ptyId === 'string' && ptyId.startsWith(LOGIN_PREFIX) ? ptyId.slice(LOGIN_PREFIX.length) : null;

module.exports = {
  DEFAULT_ID, DEFAULT_ACCOUNT, normalizeAccounts, addAccount, renameAccount, removeAccount, accountOf, ptyEnv,
  lastJsonObject, authFromStatus, authFromRun, localizeAuth, claudeCommand, withAuth, loginPtyId, loginAccountId,
};
