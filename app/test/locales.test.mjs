// Language files: node --test app/test/locales.test.mjs
// - app/locales/*.json: "_name" in every file; the same keys as English and the same placeholders per key
//   ({n}, {label}...). A plural group ({ "one": ..., "other": ... }) counts as one key: the language uses its own
//   categories or gives a plain string.
// - Every key in the code (the strings in t('…'), T('…'), hasText('…'), t.has('…') calls) exists in en.json;
//   every key in en.json is used in the code. A template like `sidebar.days.${n}` covers keys starting with that prefix.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPluralGroup, placeholders } from '../src/i18n.mjs'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(APP, 'locales')
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
const locales = Object.fromEntries(files.map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(DIR, f), 'utf8'))]))
const en = locales.en

/** Flat key list: { 'sidebar.working': '{n} working', 'panel.tools': { one, other }, ... } (excluding those starting with "_"). */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (!prefix && k.startsWith('_')) continue
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string' || isPluralGroup(v)) out[key] = v
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v // wrong type: caught below
  }
  return out
}

test('dil dosyaları: geçerli kodlu adlar, "_name", yalnız metin, iç içe nesne ya da çoğul grubu', () => {
  assert.ok(en, 'app/locales/en.json yok')
  for (const [code, dict] of Object.entries(locales)) {
    assert.match(code, /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, `${code}.json: dosya adı bir dil kodu olmalı (en, tr, pt-BR)`)
    assert.equal(typeof dict._name, 'string', `${code}.json: "_name" (dilin kendi dilindeki adı) eksik`)
    for (const [key, v] of Object.entries(flatten(dict))) {
      assert.ok(typeof v === 'string' || isPluralGroup(v), `${code}.json ${key}: metin, nesne ya da "other"lı çoğul grubu olmalı`)
    }
  }
})

for (const code of Object.keys(locales).filter((c) => c !== 'en')) {
  test(`${code}.json: en.json ile aynı anahtarlar ve yer tutucular`, () => {
    const a = flatten(en)
    const b = flatten(locales[code])
    const missing = Object.keys(a).filter((k) => !(k in b))
    const extra = Object.keys(b).filter((k) => !(k in a))
    assert.deepEqual(missing, [], `${code}.json'da eksik anahtarlar`)
    assert.deepEqual(extra, [], `${code}.json'da en.json'da olmayan anahtarlar`)
    for (const k of Object.keys(a)) {
      assert.deepEqual(placeholders(b[k]), placeholders(a[k]), `${code}.json ${k}: yer tutucular en.json'dakiyle aynı olmalı`)
    }
  })
}

// keys in the code: strings in the first argument of translation calls (including inside ternaries)
const NAMESPACES = Object.keys(en).filter((k) => !k.startsWith('_'))
const SOURCES = ['main.js', 'preload.js', ...readdirSync(join(APP, 'src')).filter((f) => /\.(m?js)$/.test(f)).map((f) => `src/${f}`),
  ...readdirSync(join(APP, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`)]
const CALL = /\b(?:t|T|hasText|has)\(([^()]*)/g
const LITERAL = /(['"`])([A-Za-z][\w.-]*?)(\1|\$\{)/g

function usedKeys() {
  const exact = new Map() // key → file
  const prefixes = new Map()
  for (const rel of SOURCES) {
    // comment lines (which may contain example keys) are skipped
    const src = readFileSync(join(APP, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const call of src.matchAll(CALL)) {
      for (const m of call[1].matchAll(LITERAL)) {
        const key = m[2]
        if (!NAMESPACES.includes(key.split('.')[0]) || !key.includes('.')) continue
        if (m[3] === '${' || key.endsWith('.')) prefixes.set(key, rel)
        else exact.set(key, rel)
      }
    }
  }
  return { exact, prefixes }
}

test('koddaki her anahtar en.json\'da, en.json\'daki her anahtar kodda', () => {
  const keys = Object.keys(flatten(en))
  const { exact, prefixes } = usedKeys()
  assert.ok(exact.size > 100, `kodda çok az anahtar bulundu (${exact.size}): arama ifadesi bozuk olabilir`)
  for (const [key, rel] of exact) assert.ok(keys.includes(key), `${rel}: "${key}" en.json'da yok`)
  for (const [p, rel] of prefixes) assert.ok(keys.some((k) => k.startsWith(p)), `${rel}: "${p}…" ile başlayan anahtar en.json'da yok`)
  const unused = keys.filter((k) => !exact.has(k) && ![...prefixes.keys()].some((p) => k.startsWith(p)))
  assert.deepEqual(unused, [], 'en.json\'da kodda kullanılmayan anahtarlar')
})
