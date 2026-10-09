# Contributing to Agent Office

Thanks for helping. Issues and pull requests are welcome, small ones especially.

## Layout

| Folder | What it is |
| --- | --- |
| `app/` | The Electron macOS app: `main.js` (window, ptys, accounts, notifications), `preload.js` (the `window.agentOffice` bridge), `renderer/` (sidebar, terminals, agent panel), `src/` (pure logic, tested with `node --test`) |
| `plugin/` | The Claude Code plugin: `hooks/register.tsx` writes each session's state file; `viewer/office.mjs` draws the office in a terminal |
| `plugin/viewer/core.mjs` | **The** office renderer, shared by both. `app/src/office/core.mjs` is a copy: edit the plugin file, then run `node app/scripts/sync-core.mjs` (`npm start` and `npm run dist` do it for you) |
| `app/CONTRACT.md` | How the parts talk: the session file format, the `window.agentOffice` API, the office data. Update it when you change an interface |

## Run and test

```sh
cd app && npm install && npm start      # the app from source
node --test app/test/main.test.cjs       # main process logic
node app/test/office.test.mjs            # office renderer and session reading
node app/test/visual.test.mjs            # office pictures; UPDATE_SNAPSHOTS=1 to accept a deliberate change
claude plugin test plugin                # plugin hooks (Claude Code 2.1.295 or newer)
node --test plugin/tests/viewer-smoke.mjs
npx -p typescript@5.6.3 tsc -p app       # type-check (needs app/node_modules)
npx -y eslint@9 .                        # lint (eslint.config.mjs: recommended rules only, no formatting)
```

The renderer also opens in a plain browser with a fake backend: serve `app/` with any static server and open `/renderer/index.html` (`?lang=en`, `?asking`, `?select=m-1` and more, see the top of `renderer/dev-mock.js`).

CI runs all of this on every push and pull request.

## Conventions

- **Translations**: every user-visible string sits in a `{ en, tr }` table at the top of its module (`S` in the renderer modules, `MSG` in `main.js`, `STRINGS` in the office renderer) and is read with `pick(S)` at render time. A new language is a new key in each table plus an option in the sidebar's language picker.
- **Comments** in the existing code are mostly Turkish. English comments are welcome in new code.
- **No new runtime dependencies** without a good reason; the plugin has none at all.
- Keep `app/CONTRACT.md` and the READMEs in step with what you change.

## Adding a theme to the gallery

1. Add `themes/<name>.json`: a `themes.json` fragment with one key, `{ "<name>": { "description": "<one line>", "match": "<name>", "sign": "<NAME>", "colors": { ... } } }`. The colour keys are those of `C` in `plugin/viewer/core.mjs` (`#rrggbb`); look at an existing theme for the ones that cover the walls, floors, desks, chairs, sign and bots.
2. Draw the preview: `node plugin/viewer/gallery.mjs <name>` writes `themes/previews/<name>.png` (the demo office at a fixed time and time zone, so it only changes when the theme or the renderer does). Look at it: the theme should read well and look different from the others.
3. Add it to the table in the "Theme gallery" section of `plugin/README.md` (and the list in the Turkish part), and commit the JSON and the PNG together.
