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
node app/test/office.test.mjs            # office renderer and session reading
node app/test/visual.test.mjs            # office pictures; UPDATE_SNAPSHOTS=1 to accept a deliberate change
claude plugin test plugin                # plugin hooks (Claude Code 2.1.295 or newer)
node --test plugin/tests/viewer-smoke.mjs
npx -p typescript@5.6.3 tsc -p app       # type-check (needs app/node_modules)
```

The renderer also opens in a plain browser with a fake backend: serve `app/` with any static server and open `/renderer/index.html` (`?lang=en`, `?asking`, `?select=m-1`, `?platform=linux` and more, see the top of `renderer/dev-mock.js`).

Linux packages: `cd app && npm install && npm run dist:linux` on a Linux machine (node-pty is compiled from source there: `python3`, `make`, a C++ compiler). CI's `linux-build` job does the same on every push and keeps the AppImage and `.deb` as artifacts.

CI runs all of this on every push and pull request.

## Conventions

- **Translations**: every user-visible string sits in a `{ en, tr }` table at the top of its module (`S` in the renderer modules, `MSG` in `main.js`, `STRINGS` in the office renderer) and is read with `pick(S)` at render time. A new language is a new key in each table plus an option in the sidebar's language picker.
- **Comments** in the existing code are mostly Turkish. English comments are welcome in new code.
- **No new runtime dependencies** without a good reason; the plugin has none at all.
- **Platforms**: macOS and Linux. Keep differences behind small `process.platform` checks: pure helpers in `app/src/platform.js` (default shell, Linux clipboard files, menu shortcuts), and in the renderer `renderer/platform.js` (`platform-darwin` / `platform-linux` class on `<html>`, ⌘ vs Ctrl+Shift shortcuts). macOS behaviour must not change when you touch Linux code, and the other way round.
- Keep `app/CONTRACT.md` and the READMEs in step with what you change.
