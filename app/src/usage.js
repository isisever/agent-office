// Hesap kotası (Pro/Max planı): saf işlevler (Electron yok; node --test ile sınanır).
//
// Kaynak (code.claude.com/docs/en/statusline): status line komutunun girdisindeki
// rate_limits.five_hour / seven_day → { used_percentage: 0-100, resets_at: Unix saniye }. Yalnız
// claude.ai aboneliğinde ve oturumun ilk API yanıtından sonra gelir; süresi geçen pencere düşer.
// Uygulama her projenin claude'unu `--settings` ile kendi status line'ıyla başlatır: betik girdiyi
// usage/<accountId>/<projectId>.json'a yazar, kullanıcının kendi status line'ı varsa onu çalıştırır.
const path = require('path');

const LAST = 'last.json';

// Status line betiği: girdiyi dosyaya yazar (yarım dosya okunmasın diye önce geçici dosyaya),
// ardından kullanıcının status line komutunu aynı girdiyle çalıştırır; onun çıktısı ekranda görünür.
const SCRIPT = `# Agent Office: Claude Code status line girdisini (kota dahil) uygulamaya bırakır.
out=$1; tmp="$out.$$"
cat > "$tmp" || exit 0
mv -f "$tmp" "$out"
[ -n "$AGENT_OFFICE_STATUSLINE" ] && exec /bin/sh -c "$AGENT_OFFICE_STATUSLINE" < "$out"
exit 0
`;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Kullanıcının etkin status line'ı: --settings bunu ezer, betik yeniden çalıştırır. Sıra Claude
// Code'unki: projenin settings.local.json'ı, projenin settings.json'ı, hesabın settings.json'ı.
// İlk tanımlı statusLine kazanır; komut türünde değilse (ya da komutsuzsa) çalıştırılacak bir şey yok.
function userStatusLine(settingsList) {
  for (const s of settingsList) {
    const sl = s && typeof s === 'object' ? s.statusLine : undefined;
    if (sl === undefined) continue;
    if (!sl || sl.type !== 'command' || typeof sl.command !== 'string' || !sl.command.trim()) return null;
    return { command: sl.command, padding: Number.isFinite(sl.padding) ? sl.padding : undefined };
  }
  return null;
}

const settingsPaths = (projectDir, configDir, home) => [
  path.join(projectDir, '.claude', 'settings.local.json'),
  path.join(projectDir, '.claude', 'settings.json'),
  path.join(configDir || path.join(home, '.claude'), 'settings.json'),
];

// claude'a verilecek --settings JSON'u.
function statusLineSettings(scriptPath, outPath, user) {
  const statusLine = { type: 'command', command: `/bin/sh ${shq(scriptPath)} ${shq(outPath)}` };
  if (user?.padding !== undefined) statusLine.padding = user.padding;
  return JSON.stringify({ statusLine });
}

// Status line girdisi → AccountUsage (bkz. CONTRACT.md) ya da rate_limits yoksa null.
function usageFromStatus(obj, updatedAt) {
  const rl = obj && typeof obj === 'object' ? obj.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => {
    if (!w || typeof w !== 'object' || !Number.isFinite(w.used_percentage)) return undefined;
    const out = { pct: Math.max(0, Math.min(100, w.used_percentage)) };
    if (Number.isFinite(w.resets_at)) out.resetsAt = w.resets_at * 1000;
    return out;
  };
  const usage = { updatedAt };
  const five = win(rl.five_hour);
  const week = win(rl.seven_day);
  if (five) usage.fiveHour = five;
  if (week) usage.sevenDay = week;
  return five || week ? usage : null;
}

// Önbellekteki kayıt (last.json) ya da bozuksa null.
function usageFromCache(obj) {
  if (!obj || typeof obj !== 'object' || !Number.isFinite(obj.updatedAt)) return null;
  const ok = (w) => w && Number.isFinite(w.pct);
  if (!ok(obj.fiveHour) && !ok(obj.sevenDay)) return null;
  return obj;
}

module.exports = { LAST, SCRIPT, shq, userStatusLine, settingsPaths, statusLineSettings, usageFromStatus, usageFromCache };
