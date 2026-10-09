// Tek komutla sürüm: node scripts/release.mjs <sürüm> --notes <notlar.md> [--dry-run]
// Sırası (README "Releasing"):
//   1. denetim: main dalı, temiz çalışma ağacı, HEAD için CI (test.yml) başarılı, etiket yok
//   2. sürümü yaz: app/package.json, app/package-lock.json (kök + packages[""]), plugin/.claude-plugin/plugin.json → "Version X" commit'i
//   3. cd app && npm run dist:release (imzalı + noterli dmg/zip)
//   4. noter denetimi: her dmg bağlanır, içindeki .app için spctl -a -vv "Notarized Developer ID" demeli
//   5. commit'i gönder (etiket onu göstersin), gh release create vX (dmg, zip, blockmap, latest-mac.yml)
//   6. Homebrew cask'ı yaz, commit'le, gönder; tap deposuna (isisever/homebrew-tap) kopyala, commit'le, gönder
// --dry-run: denetimleri yapar (başarısızlıkları yalnız söyler), değişiklik yapan her adımı yazdırır ama çalıştırmaz.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = join(ROOT, 'app')
const RELEASE = join(APP, 'release')
const CASK = join(ROOT, 'packaging', 'homebrew', 'Casks', 'agent-office.rb')
const REPO = 'isisever/agent-office'
const TAP = 'isisever/homebrew-tap'
const WORKFLOW = 'test.yml'

// ---------- argümanlar ----------
const args = process.argv.slice(2)
const isDry = args.includes('--dry-run')
const notesAt = args.indexOf('--notes')
const notesArg = notesAt >= 0 ? args[notesAt + 1] : undefined
const version = args.filter((a, i) => !a.startsWith('--') && !(notesAt >= 0 && i === notesAt + 1))[0]?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || !notesArg) {
  console.error('usage: node scripts/release.mjs <version, e.g. 0.6.0> --notes <notes.md> [--dry-run]')
  process.exit(2)
}
const notes = resolve(process.cwd(), notesArg)
const tag = `v${version}`

// ---------- yardımcılar ----------
// depo içindeki yollar göreli, dışındakiler (tap klonu) mutlak yazılır
const rel = p => {
  const r = relative(ROOT, p)
  return r.startsWith('..') ? p : r || '.'
}
const show = (cmd, argv, cwd) => `$ ${cwd && cwd !== ROOT ? `(cd ${rel(cwd)}) ` : ''}${[cmd, ...argv].map(a => (/[\s"'$*]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`
let stepNo = 0
const step = title => console.log(`\n== ${++stepNo}. ${title}${isDry ? ' (dry run)' : ''}`)

// değişiklik yapan komut: dry run'da yalnız yazdırılır
function run(cmd, argv, { cwd = ROOT } = {}) {
  console.log(show(cmd, argv, cwd))
  if (!isDry) execFileSync(cmd, argv, { cwd, stdio: 'inherit' })
}
// salt okuyan komut: dry run'da da çalışır, çıktısını döndürür
function read(cmd, argv, { cwd = ROOT } = {}) {
  return execFileSync(cmd, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
// denetim: gerçek sürümde durdurur, dry run'da uyarır
function check(isOk, message) {
  if (isOk) return console.log(`ok: ${message}`)
  if (isDry) return console.log(`WARNING (a real release would stop here): ${message}`)
  console.error(`STOPPED: ${message}`)
  process.exit(1)
}

// ---------- 1. denetim ----------
step('Checks')
const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
check(branch === 'main', `on main (now: ${branch})`)
const dirty = read('git', ['status', '--porcelain'])
check(dirty === '', dirty ? `clean working tree (changed:\n${dirty})` : 'clean working tree')
const head = read('git', ['rev-parse', 'HEAD'])
let ci = null
try {
  const runs = JSON.parse(read('gh', ['run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--commit', head, '--json', 'status,conclusion,url']))
  ci = runs.find(r => r.status === 'completed' && r.conclusion === 'success') ?? runs[0] ?? null
} catch (e) {
  console.log(`(gh run list failed: ${String(e.stderr || e.message).trim()})`)
}
check(ci?.conclusion === 'success', `CI passed for HEAD ${head.slice(0, 7)} (${ci ? `${ci.status}/${ci.conclusion || '-'} ${ci.url}` : 'no run found'})`)
check(!read('git', ['tag', '--list', tag]), `tag ${tag} does not exist yet`)
check(existsSync(notes), `release notes ${notesArg}`)
const current = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).version
check(current !== version, `version changes (${current} → ${version})`)

// ---------- 2. sürüm ----------
step(`Set version ${version}`)
// biçim korunsun diye JSON baştan yazılmaz: yalnız sürüm alanları değişir, sonra JSON olarak doğrulanır
const edits = [
  [join(APP, 'package.json'), [/^(\s{2}"version": ")[^"]+(")/m], j => [j.version]],
  [join(APP, 'package-lock.json'), [/^(\s{2}"version": ")[^"]+(")/m, /("packages": \{\s*"": \{[^{}]*?"version": ")[^"]+(")/], j => [j.version, j.packages[''].version]],
  [join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), [/^(\s{2}"version": ")[^"]+(")/m], j => [j.version]],
]
for (const [file, patterns, versionsOf] of edits) {
  let text = readFileSync(file, 'utf8')
  for (const re of patterns) {
    if (!re.test(text)) throw new Error(`${rel(file)}: version field not found`)
    text = text.replace(re, `$1${version}$2`)
  }
  const got = versionsOf(JSON.parse(text))
  if (got.some(v => v !== version)) throw new Error(`${rel(file)}: version not set (${got.join(', ')})`)
  console.log(`${rel(file)}: ${versionsOf(JSON.parse(readFileSync(file, 'utf8'))).join(', ')} → ${version}`)
  if (!isDry) writeFileSync(file, text)
}
run('git', ['add', ...edits.map(([f]) => rel(f))])
run('git', ['commit', '-m', `Version ${version}`])

// ---------- 3. derleme ----------
step('Build, sign and notarize')
console.log(`$ rm -rf ${rel(RELEASE)}`)
if (!isDry) rmSync(RELEASE, { recursive: true, force: true })
run('npm', ['run', 'dist:release'], { cwd: APP })

// dry run'da derleme yok: beklenen dosya adları gösterilir
const ARCHS = ['arm64', 'x64']
const expected = ARCHS.flatMap(a => ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].map(ext => `AgentOffice-${version}-${a}.${ext}`))
const assets = isDry
  ? [...expected, 'latest-mac.yml']
  : readdirSync(RELEASE).filter(f => f === 'latest-mac.yml' || (f.startsWith(`AgentOffice-${version}-`) && /\.(dmg|zip|blockmap)$/.test(f)))
const dmgs = assets.filter(f => f.endsWith('.dmg'))
if (!isDry) {
  check(ARCHS.every(a => dmgs.includes(`AgentOffice-${version}-${a}.dmg`)), `dmgs built (${dmgs.join(', ')})`)
  check(assets.includes('latest-mac.yml') && assets.some(f => f.endsWith('.zip')), 'zips and latest-mac.yml built')
}

// ---------- 4. noter denetimi ----------
step('Verify notarization')
for (const dmg of dmgs) {
  const path = join(RELEASE, dmg)
  console.log(`$ hdiutil attach -nobrowse -readonly ${rel(path)}`)
  console.log(`$ spctl -a -vv "<mount>/Agent Office.app"   # must say: source=Notarized Developer ID`)
  console.log('$ hdiutil detach <mount>')
  if (isDry) continue
  const out = read('hdiutil', ['attach', '-nobrowse', '-readonly', path])
  const mount = out.split('\n').map(l => l.split('\t').pop().trim()).find(p => p.startsWith('/Volumes/'))
  if (!mount) throw new Error(`${dmg}: mount point not found in:\n${out}`)
  let verdict = ''
  try {
    // spctl sonucu stderr'e yazar; reddederse sıfırdan farklı çıkar (o da sonuçtur)
    const r = spawnSync('spctl', ['-a', '-vv', join(mount, 'Agent Office.app')], { encoding: 'utf8' })
    verdict = `${r.stdout ?? ''}${r.stderr ?? ''}`
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mount, '-quiet'])
    } catch {
      execFileSync('hdiutil', ['detach', mount, '-force', '-quiet'])
    }
  }
  console.log(verdict.trim())
  check(/accepted/.test(verdict) && /source=Notarized Developer ID/.test(verdict), `${dmg}: notarized`)
}

// ---------- 5. GitHub sürümü ----------
step(`Push and create GitHub release ${tag}`)
run('git', ['push', 'origin', 'main'])
const commit = isDry ? '<Version commit>' : read('git', ['rev-parse', 'HEAD'])
run('gh', ['release', 'create', tag, '--repo', REPO, '--target', commit, '--title', tag, '--notes-file', notes, ...assets.map(f => rel(join(RELEASE, f)))])

// ---------- 6. Homebrew ----------
step('Homebrew cask')
run('node', ['packaging/homebrew/update-cask.mjs'])
run('git', ['add', rel(CASK)])
run('git', ['commit', '-m', `Homebrew cask ${version}`])
run('git', ['push', 'origin', 'main'])

step(`Update the tap ${TAP}`)
const tapDir = isDry ? join(tmpdir(), 'agent-office-tap-XXXX') : mkdtempSync(join(tmpdir(), 'agent-office-tap-'))
try {
  run('gh', ['repo', 'clone', TAP, tapDir, '--', '--depth', '1'])
  console.log(`$ cp ${rel(CASK)} ${join(tapDir, 'Casks', 'agent-office.rb')}`)
  if (!isDry) copyFileSync(CASK, join(tapDir, 'Casks', 'agent-office.rb'))
  run('git', ['add', 'Casks/agent-office.rb'], { cwd: tapDir })
  run('git', ['commit', '-m', `agent-office ${version}`], { cwd: tapDir })
  run('git', ['push'], { cwd: tapDir })
} finally {
  if (!isDry) rmSync(tapDir, { recursive: true, force: true })
}

console.log(`\n${isDry ? 'Dry run done, nothing changed' : `Released ${tag}`}: https://github.com/${REPO}/releases/tag/${tag}`)
