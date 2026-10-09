// ESLint (bug-catching rules only, no style rules): npx -y eslint@9 .
// The repo has no package dependencies: ESLint's "recommended" config comes from the @eslint/js of the eslint
// that runs it (npx cache); global names are listed by hand below (instead of the globals package).
import { createRequire } from 'node:module'

function eslintJs() {
  // process.argv[1]: eslint's bin/eslint.js; if not found (e.g. an editor extension), try the repo
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
const node = { ...shared, ...names('process Buffer Blob setImmediate clearImmediate global') }
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
      // an empty catch is a deliberate pattern in this repo: "if it can't be read, carry on with the default"
      'no-empty': ['error', { allowEmptyCatch: true }],
      // an argument starting with _ is unused on purpose (it documents the signature); dropping fields with { a, ...rest } is also a pattern
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  // Electron main, preload, main-process logic and its tests: CommonJS, Node
  {
    files: ['app/main.js', 'app/preload.js', 'app/src/**/*.js', 'app/test/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...node, ...commonjs } },
  },
  // UI: ES modules in the browser
  {
    files: ['app/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: browser },
  },
  // the shared office drawing code runs both in the browser and in Node: only names present in both
  {
    files: ['plugin/viewer/core.mjs', 'app/src/office/core.mjs'],
    languageOptions: { globals: shared },
  },
  // the terminal viewer strips ESC sequences from keyboard input and terminal replies with regexes: control characters are intended
  {
    files: ['plugin/viewer/office.mjs'],
    rules: { 'no-control-regex': 'off' },
  },
  // scripts, tests, terminal viewer: Node ES modules
  {
    files: ['app/scripts/**/*.mjs', 'app/test/**/*.mjs', 'plugin/viewer/office.mjs', 'plugin/viewer/gallery.mjs', 'plugin/tests/**/*.mjs', 'scripts/**/*.mjs', 'packaging/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: node },
  },
]
