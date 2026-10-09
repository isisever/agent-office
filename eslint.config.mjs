// ESLint (yalnız hata yakalayan kurallar, biçim kuralı yok): npx -y eslint@9 .
// Depoda paket bağımlılığı yok: ESLint'in "recommended" ayarı, onu çalıştıran eslint'in kendi
// @eslint/js'inden alınır (npx önbelleği); global adlar aşağıda elle sayılır (globals paketi yerine).
import { createRequire } from 'node:module'

function eslintJs() {
  // process.argv[1]: eslint'in bin/eslint.js'i; bulunamazsa (ör. editör eklentisi) depodan dene
  for (const from of [process.argv[1], import.meta.url]) {
    try {
      return createRequire(from)('@eslint/js')
    } catch {}
  }
  throw new Error('@eslint/js not found: run with npx -y eslint@9 .')
}
const js = eslintJs()

const names = list => Object.fromEntries(list.split(/\s+/).filter(Boolean).map(n => [n, 'readonly']))
const shared = names(`
  console setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone
  URL URLSearchParams TextEncoder TextDecoder AbortController performance fetch
`)
const node = { ...shared, ...names('process Buffer setImmediate clearImmediate global') }
const commonjs = names('require module exports __dirname __filename')
const browser = {
  ...shared,
  ...names(`
    window document navigator location localStorage sessionStorage getComputedStyle matchMedia devicePixelRatio
    requestAnimationFrame cancelAnimationFrame ResizeObserver MutationObserver IntersectionObserver
    HTMLElement HTMLCanvasElement HTMLInputElement Element Node Event CustomEvent KeyboardEvent MouseEvent
    ImageData Image Blob FileReader DOMParser alert confirm
  `),
}

export default [
  { ignores: ['**/node_modules/**', 'app/release/**', 'plugin/.claude-plugin/types/**', 'plugin/types/**'] },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // boş catch bu depoda bilinçli bir kalıp: "okunamazsa varsayılanla devam et"
      'no-empty': ['error', { allowEmptyCatch: true }],
      // _ ile başlayan argüman bilerek kullanılmıyor (imzayı belgeler); { a, ...rest } ile alan atmak da bir kalıp
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  // Electron main, preload, main süreci mantığı ve testi: CommonJS, Node
  {
    files: ['app/main.js', 'app/preload.js', 'app/src/**/*.js', 'app/test/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...node, ...commonjs } },
  },
  // arayüz: tarayıcıda ES modülleri
  {
    files: ['app/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: browser },
  },
  // ortak ofis çizicisi hem tarayıcıda hem Node'da çalışır: yalnız ikisinde de olan adlar
  {
    files: ['plugin/viewer/core.mjs', 'app/src/office/core.mjs'],
    languageOptions: { globals: shared },
  },
  // terminal görüntüleyici klavye ve terminal yanıtlarındaki ESC dizilerini düzenli ifadeyle ayıklar: kontrol karakteri amaçlı
  {
    files: ['plugin/viewer/office.mjs'],
    rules: { 'no-control-regex': 'off' },
  },
  // betikler, testler, terminal görüntüleyici: Node ES modülleri
  {
    files: ['app/scripts/**/*.mjs', 'app/test/**/*.mjs', 'plugin/viewer/office.mjs', 'plugin/viewer/gallery.mjs', 'plugin/tests/**/*.mjs', 'scripts/**/*.mjs', 'packaging/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: node },
  },
]
