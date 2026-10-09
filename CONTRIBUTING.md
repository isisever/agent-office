# Contributing to Agent Office

Thanks for helping. Issues and pull requests are welcome, small ones especially.

## Layout

| Folder | What it is |
| --- | --- |
| `app/` | The Electron app for macOS and Linux: `main.js` (window, ptys, accounts, notifications), `preload.js` (the `window.agentOffice` bridge), `renderer/` (sidebar, terminals, agent panel), `src/` (pure logic, tested with `node --test`) |
| `plugin/` | The Claude Code plugin: `hooks/register.tsx` writes each session's state file; `viewer/office.mjs` draws the office in a terminal |
| `plugin/viewer/core.mjs` | **The** office renderer, shared by both. `app/src/office/core.mjs` is a copy: edit the plugin file, then run `node app/scripts/sync-core.mjs` (`npm start` and `npm run dist` do it for you) |
| `app/CONTRACT.md` | How the parts talk: the session file format, the `window.agentOffice` API, the office data. Update it when you change an interface |

## Run and test

```sh
cd app && npm install && npm start      # the app from source
node --test app/test/main.test.cjs       # main process logic
node --test app/test/locales.test.mjs    # locale files: same keys and placeholders, every key used in code exists
node app/test/office.test.mjs            # office renderer and session reading
node app/test/visual.test.mjs            # office pictures; UPDATE_SNAPSHOTS=1 to accept a deliberate change
claude plugin test plugin                # plugin hooks (Claude Code 2.1.295 or newer)
node --test plugin/tests/viewer-smoke.mjs
npx -p typescript@5.6.3 tsc -p app       # type-check (needs app/node_modules)
npx -y eslint@9 .                        # lint (eslint.config.mjs: recommended rules only, no formatting)
```

The renderer also opens in a plain browser with a fake backend: serve `app/` with any static server and open `/renderer/index.html` (`?lang=en`, `?asking`, `?select=m-1`, `?platform=linux`, `?theme=sakura` and more, see the top of `renderer/dev-mock.js`). The theme gallery is read from `themes/`, so for it serve the repository root and open `/app/renderer/index.html`.

Linux packages: `cd app && npm install && npm run dist:linux` on a Linux machine (node-pty is compiled from source there: `python3`, `make`, a C++ compiler). CI's `linux-build` job does the same on every push and keeps the AppImage and `.deb` as artifacts.

CI runs all of this on every push and pull request.

## Conventions

- **Strings**: every user-visible string of the app is in `app/locales/en.json` and `app/locales/tr.json`, read with `t('namespace.key', { var })` (renderer: `renderer/i18n.js`; main: `T(...)` in `main.js`). Add a new string to every locale file; `app/test/locales.test.mjs` fails otherwise. The words drawn in the office (`STRINGS` in `plugin/viewer/core.mjs`) and the plugin's hook messages are separate and stay in their files.
- **Comments** are in English (the user-visible strings stay bilingual, see Strings above).
- **No new runtime dependencies** without a good reason; the plugin has none at all.
- **Platforms**: macOS and Linux. Keep differences behind small `process.platform` checks: pure helpers in `app/src/platform.js` (default shell, Linux clipboard files, menu shortcuts), and in the renderer `renderer/platform.js` (`platform-darwin` / `platform-linux` class on `<html>`, ⌘ vs Ctrl+Shift shortcuts). macOS behaviour must not change when you touch Linux code, and the other way round.
- Keep `app/CONTRACT.md` and the READMEs in step with what you change.

## Adding a translation

1. Copy `app/locales/en.json` to `app/locales/<code>.json` (a language code: `de`, `fr`, `pt-BR`) and translate the values. Set `"_name"` to the language's name in that language (`"Deutsch"`): that is what the sidebar's language picker shows. Nothing else needs registering: the picker and the "Auto" (system language) setting list the files in `app/locales/`.
2. Keep the keys and the `{placeholders}` as they are; you can move a placeholder within the sentence. Plurals are objects with CLDR categories (`"one"`, `"few"`, `"many"`, `"other"`, ...; `"other"` is required) chosen by `{n}` with `Intl.PluralRules` for your language, e.g. `{ "one": "1 tool call", "other": "{n} tool calls" }`; if your language does not change the word, a plain string is fine.
3. Run `node --test app/test/locales.test.mjs` (same keys and placeholders as `en.json`). To see it, open the renderer in a browser with the fake backend: `/renderer/index.html?lang=<code>&langs=en,tr,<code>`.

A missing key falls back to English. The office's drawn words (boss, waiting, today...) come in English and Turkish only (`STRINGS` in `plugin/viewer/core.mjs`); with any other language the office uses English.

## Adding a theme to the gallery

1. Add `themes/<name>.json`: a `themes.json` fragment with one key, `{ "<name>": { "description": "<one line>", "match": "<name>", "sign": "<NAME>", "colors": { ... } } }`. The colour keys are those of `C` in `plugin/viewer/core.mjs` (`#rrggbb`); look at an existing theme for the ones that cover the walls, floors, desks, chairs, sign and bots.
2. Draw the preview: `node plugin/viewer/gallery.mjs <name>` writes `themes/previews/<name>.png` (the demo office at a fixed time and time zone, so it only changes when the theme or the renderer does). Look at it: the theme should read well and look different from the others.
3. Add it to the table in the "Theme gallery" section of `plugin/README.md` (and the list in the Turkish part), and commit the JSON and the PNG together. The app's sidebar picker lists it by itself (the JSON ships with the app); for the browser mock, add its name to `GALLERY` in `app/renderer/dev-mock.js`.
