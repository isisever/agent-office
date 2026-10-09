# Module contract (shell ↔ office), v2: several projects, one boss, several accounts

Three parts are built in parallel; this file fixes the seams between them. Change it only together with every side.

## Owners

| Part | Files |
| --- | --- |
| Main | `main.js`, `preload.js`, `src/projects.js` (new), `src/accounts.js` (new) |
| UI | `renderer/index.html`, `renderer/app.js`, `renderer/terminal.js`, `renderer/style.css`, `renderer/sidebar.js` (new) |
| Office | `src/sessions.js`, `src/office/core.mjs`, `renderer/office-view.js` |

All UI text is Turkish.

## Model

```ts
type Project = { id: string; dir: string; name: string; accountId: string }   // name = basename(dir); id stable (random)
type Account = { id: string; label: string; configDir: string | null; auth: AccountAuth }  // 'default': label 'Varsayılan', configDir null (system ~/.claude)
type AccountAuth = { state: 'checking' | 'in' | 'out' | 'error'; email?: string; method?: string; error?: string }
// from `claude auth status --json` run with that account's CLAUDE_CONFIG_DIR: loggedIn → 'in' (email, authMethod), else 'out'
type ProjectStatus = { id: string; isRunning: boolean }                       // claude pty alive
```

- Main keeps `projects`, `accounts` and `activeId` in `userData/state.json`. The old `lastProject` becomes the first project on upgrade.
- Every project has its own `claude` pty, started when the project is added or the app opens, and kept running in the background while another project is shown. Removing a project kills its pty (does not touch the folder).
- An account other than default has `configDir = userData/accounts/<id>`; its ptys start with `CLAUDE_CONFIG_DIR=<configDir>`, so claude keeps that account's login and settings apart. Logging in: the sidebar's "Giriş yap" (see v2.1); `/login` in a project terminal also works. Changing a project's account restarts its pty.
- The office always shows all projects at once (the boss oversees all of them); the active project only picks the theme and is highlighted.

## `window.agentOffice` (preload)

```ts
agentOffice.projects.list(): Promise<{ projects: Project[]; activeId: string | null; status: ProjectStatus[] }>
agentOffice.projects.add(): Promise<Project | null>                  // folder dialog; starts its claude; makes it active
agentOffice.projects.remove(id: string): Promise<void>
agentOffice.projects.setActive(id: string): Promise<void>
agentOffice.projects.setAccount(id: string, accountId: string): Promise<void>   // restarts that project's claude
agentOffice.projects.onChange(cb: (s: { projects: Project[]; activeId: string | null; status: ProjectStatus[] }) => void): () => void

agentOffice.accounts.list(): Promise<Account[]>
agentOffice.accounts.add(label: string): Promise<Account>
agentOffice.accounts.rename(id: string, label: string): Promise<void>
agentOffice.accounts.remove(id: string): Promise<void>                // not 'default'; its projects move to 'default' (restarted)
agentOffice.accounts.onChange(cb: (accounts: Account[]) => void): () => void   // after add / rename / remove and every auth change ('accounts:changed')
agentOffice.accounts.refreshAuth(id?: string): Promise<Account[]>     // re-run auth status (one account, or all)
agentOffice.accounts.login(id: string): Promise<void>                 // starts a login pty with id `login:<accountId>` running `claude auth login`
agentOffice.accounts.logout(id: string): Promise<void>                // runs `claude auth logout` for that account, then refreshes

agentOffice.pty.write(projectId: string, data: string): void
agentOffice.pty.resize(projectId: string, cols: number, rows: number): void
agentOffice.pty.onData(cb: (projectId: string, data: string) => void): () => void
agentOffice.pty.onExit(cb: (projectId: string, code: number) => void): () => void
agentOffice.pty.restart(projectId: string): void

agentOffice.office.onData(cb: (data: OfficeData) => void): () => void
agentOffice.office.themes(): Promise<Record<string, ThemeSpec>>
agentOffice.clipboard.hasImage(): Promise<boolean>
agentOffice.clipboard.read(): Promise<{ hasImage: boolean, text: string, files: string[] }>  // files: copied in Finder (osascript) or, on Linux, a file manager (text/uri-list via Electron, wl-paste or xclip)
agentOffice.platform: 'darwin' | 'linux'                               // process.platform; renderer/platform.js sets <html class="platform-…"> and picks the shortcuts
agentOffice.pathForFile(file: File): string
```

The sidebar's add button adds projects; ⌘O = add project, ⌘1…9 = switch, ⌘V = paste into the focused terminal. On Linux the same keys are Ctrl+Shift+O, Ctrl+Shift+1…9 and Ctrl+Shift+V (Ctrl+Shift+C / X copy and cut from the menu), because plain Ctrl+… keys belong to Claude Code in the terminal. Linux windows use the system title bar (no traffic-light inset), and the in-app updater runs only in the AppImage.

## `src/sessions.js` (main)

```ts
readOffice(projects: string[] | null, now = Date.now()): OfficeData   // project names to include; null = all live sessions
readThemes(): Record<string, ThemeSpec>                                 // also records themesError

type OfficeData = {
  workers: (Worker & { project: string })[]          // every worker carries its project name
  delivered: number                                    // TODAY, all projects: doneAt or stats.today ids on the local day, ended sessions included
  isBossBusy: boolean                                  // any project busy
  projects: { name: string; working: number; delivered: number; isBossBusy: boolean }[]   // per project, same rules
  project: string; sessionId: string                   // newest session (theme fallback)
  themesError?: string                                 // themes.json present but unreadable
}
```

Main polls every 500 ms with the names of all open projects and sends the result on `office:data`.

## `renderer/office-view.js`

```ts
mountOffice(canvas, opts: { onTheme(t: ThemeInfo): void }): {
  setData(d: OfficeData): void
  setThemes(t): void
  setFocus(projectName: string | null): void   // theme comes from this project; its desks are highlighted
  destroy(): void
}
```

## CSS variables (set by app.js from ThemeInfo)

`--frame`, `--accent`, `--status-bg`, `--status-text`; the xterm theme uses the same colors (background = statusBg).

## Account login (v2.1)

- Main checks every account's auth at start (state 'checking' until done), after a login pty exits, after logout, when the window regains focus (at most once a minute) and on `refreshAuth`. Checks run through the user's login shell (`$SHELL -l -c`) so `claude` is on PATH, with the same env rules and shell flags (`$SHELL -l -i -c`) as the project ptys (`ptyEnv`).
- A login pty uses the normal pty channel with projectId `login:<accountId>`: `pty.onData`, `pty.write`, `pty.resize`, `pty.onExit` work as for projects. Only one login pty per account; `login` while one is running replaces it (the old one is killed without an exit event). `logout` is refused for the default account. When it exits, main refreshes that account's auth and sends `accounts:changed`. It is never listed in `projects:changed`.
- UI: every account row shows its auth (email, "giriş yapılmadı", "kontrol ediliyor…", or the error). Non-logged-in accounts get "Giriş yap"; logged-in non-default accounts get "Çıkış yap" (confirm). Adding an account immediately offers "Giriş yap". "Giriş yap" opens an overlay with an xterm attached to `login:<id>` that closes itself shortly after the pty exits. A project whose account is 'out' shows a warning on its row with a "Giriş yap" shortcut.

## Agent details (v2.2)

Clicking a bot in the office opens a panel with what that agent is doing.

Worker (written by the plugin in `sessions/<session>.json`, passed through by `readOffice`) gains optional fields; old files without them keep working:

```ts
type Worker = {
  id: string; type: string; description: string; spawnAt: number; tool?: string; doneAt?: number; isOk?: boolean
  prompt?: string                                     // the task given to the agent, first 600 chars
  detail?: string                                     // the current tool's input in one line, ≤ 160 chars (Bash: command; Read/Edit/Write: file path; Grep/Glob: pattern [in path]; WebFetch: url; WebSearch: query; other: compact JSON)
  history?: { at: number; tool: string; detail: string }[]   // last 20 tool calls, oldest first
  toolCount?: number                                  // all tool calls so far
  result?: string                                     // the agent's final answer, first 4000 chars (v2.6; 600 before), once done
}
```

Office (`renderer/office-view.js`): `mountOffice(canvas, { onTheme, onSelect(id: string | null) })`; clicking a bot calls `onSelect(worker.id)`, clicking empty floor calls `onSelect(null)`; `setSelected(id | null)` draws a marker over the selected bot (at its desk, walking, at the boss or dancing). `core.mjs` exports `hitTest(px, py)` in canvas pixels → worker id or null, using the positions of the last rendered frame; the cursor is a pointer over a bot.

Panel (`renderer/agent-panel.js`, new): `mountAgentPanel(el, { onClose })` → `{ show(id), update(data: OfficeData), hide() }`. Shows project, type, status (working / done ✓ / failed ✗) with elapsed time, description, prompt, current tool + detail, the history list (newest first, relative times), tool count and, when done, the result. It updates live from `update` and says "Ajan ofisten ayrıldı" when the id disappears. Esc closes it. All text Turkish.

Implementation notes (v2.2):

- `core.mjs`: the selection is passed per frame as `render(now, data, { focus, selected })` (no separate core `setSelected`); office-view keeps it and redraws on `setSelected`. The marker is accent-coloured corner brackets around the bot plus a bobbing arrow above it (above its tag when it has one); an id that is not drawn draws nothing.
- `hitTest(px, py)` maps canvas backing-store pixels (the `drawImage` space: the frame is centred in the canvas given to `setGeometry`) to the top-most bot or its tag, with 3 logical px of slack; `hitBoxes()` returns the last frame's boxes (tests). Party dancers keep their worker id, so they stay clickable after the worker has left the data (the panel then says "Ajan ofisten ayrıldı").
- The boss is selectable too: `BOSS_ID = '@boss'` (exported by `core.mjs`). The panel shows a summary for it (busy/idle, today's count, per-project working/delivered, working agents; clicking an agent switches to it).
- Panel options: `mountAgentPanel(el, { onClose, onSelect(id), anchor })`; `onSelect` fires when the panel itself switches agents (boss list), `anchor` (the office canvas) makes the panel cover exactly that box. Extra methods: `shownId()`, `destroy()`. Esc closes it unless focus is in a terminal (Esc there belongs to Claude); the panel takes focus when it opens. Clicking empty floor closes it.
- `dev-mock.js`: `?select=<id|@boss>` clicks that bot through the real click path after a few seconds (mock workers `m-1`…`m-4`; `m-3` is old data without the new fields).

## Background shells (v2.3)

Background shell commands (Bash with `run_in_background`, and similar long-running background tasks Claude starts) are shown in the office's server room.

The plugin adds to the session state file:

```ts
type Shell = {
  id: string            // stable id (the background task id if the engine gives one, else the tool_use_id)
  command: string       // one line, ≤ 160 chars (same rule as Worker.detail)
  description?: string  // the tool call's description, if any
  agentId?: string      // set when a subagent started it
  startAt: number
  endAt?: number        // when it finished (or was killed); omitted while running
  exitCode?: number
  status?: 'running' | 'completed' | 'failed' | 'killed'
}
// session file: { ..., shells?: Shell[] }  — running ones plus those finished in the last forgetMinutes; at most 20
```

`readOffice` passes them through as `OfficeData.shells: (Shell & { project: string })[]`.

Office: each running shell lights one rack slot in the server room (blinking LEDs, the rack's label shows a short command), finished ones show a green (exit 0) or red light until they are forgotten. Clicking a rack slot calls `onSelect('shell:<id>')`; the agent panel shows the command, project, status, elapsed time, exit code and which agent started it. When more shells run than slots exist, the last slot shows "+n".

Implementation notes (v2.3, app):

- `readOffice`: live sessions pass all their shells; a session that is not live passes only shells that finished within the forget window (`settings.json` `forgetMinutes`, 1-60, default 5, same rule as the plugin). A shell still "running" in an ended session is passed as `status: 'killed'`, `endAt = endedAt`; running shells of a stale but not ended session are left out. Sorted by `startAt`; the project filter applies. Old session files without `shells` give `shells: []`.
- `core.mjs`: 3 slots per rack (9 in all), filled across the racks' top row first; running shells first, then finished ones. A lit slot shows 3 LEDs (accent colour, blinking with a per-shell phase; steady green for exit 0 / completed, red for failed / killed / non-zero exit) and the first 3 letters of the command's program (`shellLabel`, exported; `cd …&&`, `VAR=x`, `sudo` are skipped). In multi-project view the slot's left edge has the project colour. With more shells than slots the last slot shows "+n" and selects the first hidden shell. Hit boxes `shell:<id>` are recorded before the bots (bots stay on top); the selection marker's arrow sits above the rack. No shells → the frame is pixel-identical to before.
- Panel: `shell:<id>` shows status with elapsed time, command (copy), exit code, description, the starting agent (clickable if still in the office; no `agentId` → the boss, clickable) and start/end times; "Komut ofisten ayrıldı" when it disappears. The boss summary lists running shells per project (clickable).
- `dev-mock.js`: shells `sh-1`…`sh-4` (two running, one completed, one failed); `?select=shell:sh-2` works; `?noShells` sends old data.

## Plan usage per account (v2.4)

Each account row shows its claude.ai plan usage: the 5-hour and weekly windows with the time each one resets.

```ts
type UsageWindow = { pct: number; resetsAt?: number }   // pct 0-100; resetsAt in ms
type AccountUsage = { updatedAt: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
// Account gains `usage?: AccountUsage` (absent until a session of that account has reported it)
```

- Source: the status line input's `rate_limits` (code.claude.com/docs/en/statusline). Claude Code sends it only for Pro/Max subscriptions and only after the session's first API response, so an account's usage is the last value reported by any of its project sessions.
- Main starts each project's claude with `--settings '{"statusLine":…}'` running `userData/usage/statusline.sh <userData/usage/<accountId>/<projectId>.json>` (written at start, `src/usage.js` `SCRIPT`). The script stores its stdin there and, when the user has a command status line of their own (first `statusLine` found in the project's `.claude/settings.local.json`, `.claude/settings.json`, then the account's `settings.json`), runs it with the same input via `AGENT_OFFICE_STATUSLINE`, so the terminal shows the user's status line as before. Its `padding` is carried over.
- Main scans those files every 3 s; the newest one with `rate_limits` becomes the account's usage, is kept in `usage/<accountId>/last.json` (loaded at start) and sent with `accounts:changed`. A project's file is removed from other accounts' folders when its pty starts, and when the project is removed; an account's folder goes with the account.
- UI: under a logged-in account, one line per window: label (`5 sa`, `Hafta`), a bar (accent; yellow from 70%, red from 90%), the percentage and the reset time (`14:30` within 24 h, else `Pzt 09:00`; `sıfırlandı` once passed, shown as 0%). The tooltip says how old the value is; values older than 30 minutes are dimmed. Redrawn every minute.

## Language (v2.5; one file per language)

The app speaks English and Turkish; each language is one file, `app/locales/<code>.json`.

```ts
type Language = { code: string; name: string }                        // name: the file's "_name", in its own language
type LanguageInfo = { setting: 'auto' | string; lang: string; languages: Language[] }
// setting: 'auto' or a code with a file; 'auto' → the system language (exact code, then its base language: tr-TR → tr), else 'en'
agentOffice.language.get(): Promise<LanguageInfo>
agentOffice.language.set(setting: 'auto' | string): Promise<LanguageInfo>   // unknown codes are ignored
agentOffice.language.onChange(cb: (info: LanguageInfo) => void): () => void   // 'language:changed'
```

- Locale files: one JSON object per language with namespaces `app`, `sidebar`, `panel`, `login`, `terminal` (renderer), `main` (menus, dialogs, notifications) and `auth` (known login errors). Values are strings with named placeholders (`"{n} working"`), nested objects (`sidebar.days.0`…`6`, `sidebar.authDot.<state>`, `panel.types.<agent type>`) or a plural group (`{ "one": "1 tool call", "other": "{n} tool calls" }`: CLDR categories, `other` required, chosen by `vars.n` with `Intl.PluralRules` for the language). Keys starting with `_` are metadata (`_name`). Every file has the same keys and the same placeholders per key as `en.json` (a plural group counts as one key); a key a file lacks falls back to English, an unknown key shows as the key itself. `app/test/locales.test.mjs` checks this, and that every key used in code exists and every key is used.
- Formatter (`app/src/i18n.mjs`, pure ES module, shared): `translator(dict, fallbackDict, lang)` → `t(key, vars?)` with `t.has(key)`; also `format`, `lookup`, `placeholders`, `isPluralGroup`. Conditionals are composed in code from two keys (e.g. `panel.todaySummary` + `panel.todayFailed`, `main.notifyPermission` / `main.notifyPermissionTool`).
- Main: `src/locales.js` reads `locales/*.json` at start (`loadLocales`, `languagesOf`, `resolveLang`); the picker's list and the valid settings come from the files present. Main keeps the setting as `language` in `state.json`, loads the formatter with `import()` before the window opens, and uses `T('main.key', vars)` for the menu, dialogs and notifications. It sends the default account's label (`main.defaultAccount`) and known auth errors (`errorKey` from `src/accounts.js`, localized by `localizeAuth(auth, T)` from `auth.<errorKey>`) in the current language; it re-sends `accounts:changed` on a change.
- Renderer: `renderer/i18n.js` loads `../locales/<code>.json` with `fetch` (English at start, another language when it is chosen) and exports `t(key, vars)`, `hasText(key)`, `getLang`, `setLang` (async: resolves once the file is loaded), `onLang`, `locale` (the code, for `Intl` dates). Modules read `t('ns.key')` at render time and re-render on `onLang`; the window is not reloaded, terminals keep running. The dev mock lists `?langs=en,tr` (the browser cannot list a folder).
- Office: `core.mjs` `setLanguage('en' | 'tr')` switches the drawn words (boss, waiting/working, today/done, agent types), the uppercase rule (Turkish i→İ only in Turkish) and the default titles (`AGENT OFFICE` / `AGENT OFİS`; a theme's own `title` wins). Default is Turkish. Its words stay in `STRINGS` in `core.mjs`; the app passes `'tr'` for Turkish and `'en'` for every other language.
- Sidebar: a Language picker (Auto, then each locale file's `_name`, sorted by code) next to the bot colour.
- Packaging: `locales/*.json` is in `build.files`.

## Waiting on you (v2.6)

When Claude needs the person, the app says so: a desktop notification, the Dock badge (on Linux `app.setBadgeCount`, where the desktop supports it), a mark on the project's row and the boss's sign.

The plugin adds to the session state file:

```ts
type Waiting = { kind: 'permission'; tool: string; since: number }
// session file stats: { ..., waiting?: Waiting }  — set by classic.PermissionRequest (main session or a subagent),
// removed when a call of that tool returns (allowed or denied), on a typed prompt and when the main turn completes
```

`readOffice` passes it on: each project gets `waiting: { tool, since } | null` (its oldest open dialog) and the data `isBossAsking: boolean`.

- Main (`src/attention.js`, pure): a project needs the person when it has an open dialog (`'permission'`), or when its boss went from busy to idle while the person was not looking at it (`'done'`; looking = window focused and project active; it clears once looked at or busy again). A new dialog or a finished turn in a project not being looked at raises one notification (clicking it focuses the window and activates the project). The first read after start raises none. The Dock badge counts the projects that need the person. `projects:changed` `status[]` items gain `attention: 'permission' | 'done' | null`; the sidebar shows ✋ (blinking) or ● on the row.
- Usage alerts: when an account's 5-hour or weekly window reaches 80% and again 95%, one notification each, per window and reset time; values already past a threshold at start are not announced.
- Office (`core.mjs` and the plugin viewer): with `isBossAsking` the boss's sign reads `NEEDS YOU` / `ONAY BEKLİYOR`, blinking; in a multi-project office it lists the projects asking.
- Agent panel: a `Terminal ›` button next to the project (option `onOpenProject(name)`) activates that project and focuses its terminal.
- Worker `result` is now kept up to 4000 characters (was 600).

## Continue the last session (v2.7)

```ts
agentOffice.prefs.get(): Promise<{ resume: boolean }>
agentOffice.prefs.set(p: { resume?: boolean }): Promise<{ resume: boolean }>
```

- Main keeps `resume` in `state.json` (default true). When the window loads, each project whose claude is not running starts with `--continue` if it has a session to continue: a `.jsonl` in `<account config dir or ~/.claude>/projects/<project dir with every non-alphanumeric character as '-'>` (`projects.js` `historyDir`). Restarts, account changes and new projects start fresh.
- If a `--continue` start exits non-zero within 8 s, main starts it again without `--continue` and sends no `pty:exit`.
- Sidebar: a "Continue last session" checkbox above the language picker.

## Shared renderer (v2.8)

- One drawing implementation: the source is `plugin/viewer/core.mjs` (pure ES module, no Node APIs). The plugin's terminal viewer (`plugin/viewer/office.mjs`) imports it and keeps only the Node parts (settings, `themes.json` → `setThemes`, session files, PNG, terminal, transcript feed).
- `app/src/office/core.mjs` is a byte-identical copy, so the renderer can load it from inside the asar (`../plugin` is outside it). Edit the plugin file, then run `node app/scripts/sync-core.mjs`; `npm start`, `npm run dist` and `npm run dist:release` run it first (`prestart`, `predist`, `predist:release`). `app/test/office.test.mjs` fails when the two differ.
- Additions for the viewer: `setPartyMinutes(minutes)` (how long a bot dances; default 10, the viewer uses `forgetMinutes - 0.5`) and `themeColors()` (the current palette as `0xrrggbb` numbers). The auto theme's wall sign is the full project folder name (`my-app` → `MY-APP`).
- Session file format: the plugin stamps each session file with `format: 2` (`FORMAT` in `register.tsx`); fields are only ever added within a format. `readOffice` skips a file whose `format` is above its own (`sessions.js` `FORMAT`) and sets `newerFormat` on the data; the title bar then shows "⚠ update" / "⚠ güncelle" instead of reading it wrong. Files without `format` are read as format 2. The terminal viewer also passes live sessions' `shells` to the core now, so its server room shows them.

## End-of-day summary (v2.9)

Clicking the whiteboard opens the day's deliveries in the agent panel.

- Plugin: each delivery is also appended to the session file's `stats.today.log` (types: `Delivery = { id, type, description (≤ 200 chars), spawnAt, doneAt, isOk, toolCount }`, at most 300 per session and day). Unlike `workers`, the log outlives FORGET_MS, so the day's list stays complete.
- `sessions.js` `readToday(projects, now, root)` → `{ date, deliveries: (Delivery & { project, sessionId })[], untracked }`: today's logs from the session files changed today, newest first, filtered to the app's projects; `untracked` counts deliveries of today with no log entry (older plugin). Files of a newer `format` are skipped.
- Bridge: `agentOffice.office.today(): Promise<…>` (`office:today`).
- Office: the whiteboard records the hit box `@today` (`core.mjs` `TODAY_ID`), the board's own size in single- and multi-project offices; bots stay on top of it.
- Panel: `mountAgentPanel(el, { …, loadToday })`; `@today` shows the totals (delivered, failed, agent time), per-project counts and time when there are several projects, then each delivery (time, ✓/✗, type, description, duration, tool count, project). It reloads at most every 3 s while open.

## Tabs and worktrees (v3.0)

A project can run several Claude terminals at once. Each extra one can work in the same folder or in a new git worktree.

```ts
type Tab = {
  n: number                                                // ≥ 2; the main terminal is tab 1, implicit and never stored
  dir?: string                                             // worktree tabs only: where claude runs
  worktree?: { root: string; repo: string; branch: string } // worktree tabs only
}
// Project gains `tabs?: Tab[]` (extra tabs only; absent when there are none, so old state.json files keep working)
// ProjectStatus gains `tabs?: { n: number; isRunning: boolean }[]`

agentOffice.tabs.add(projectId: string, mode?: 'same' | 'worktree'): Promise<Tab | null>
  // no mode: in a git repo main pops up a native menu (same folder / new git worktree), otherwise same folder
agentOffice.tabs.close(projectId: string, n: number): Promise<{ closed: boolean; restarted?: boolean }>
```

- **Pty ids.** The main terminal keeps the id `<projectId>`; tab `n` uses `<projectId>:<n>` (`projects.js` `tabPtyId` / `parsePtyId`). The existing channels (`pty:write`, `pty:resize`, `pty:restart`, `pty:data`, `pty:exit`) take either id, so size, restart, exit, paste and focus are per tab. `login:<accountId>` ids are never parsed as tabs. A new tab's number is one above the highest in the project (worktree tabs also skip numbers whose folder or branch already exists).
- **Starting.** Every tab starts with the project's account (`CLAUDE_CONFIG_DIR`), `--plugin-dir` and the usage `--settings` (status line file `usage/<accountId>/<projectId>-<n>.json`; the user's own status line is looked up from the tab's folder). At app start, `--continue` follows the v2.7 rule for the main terminal and for worktree tabs (history of the tab's own folder). Same-folder extra tabs always start fresh, so two claudes never continue the same session. Changing the project's account restarts all its tabs; removing the project kills them and leaves every folder (worktrees included) alone.
- **Worktrees.** Offered only when the project folder is inside a git repository (`git rev-parse --show-toplevel`). Main runs `git -C <repo> worktree add -b agent-office/<n> <repo>-wt-<n>` from `HEAD`: the folder sits next to the repository root (`/x/shop` → `/x/shop-wt-3`, branch `agent-office/3`). If the project is a subfolder of the repository, the tab runs in the same subfolder of the worktree.
- **Closing.** The main terminal has no ×. Closing a same-folder tab asks first. Closing a worktree tab gives three choices: close and remove the worktree, close and keep the folder, or cancel. Removing runs `git worktree remove <root>` (never `--force`) after the tab's claude is stopped. If git refuses (changes or untracked files), the user sees git's message, the tab stays and its claude starts again with `--continue` (`restarted: true`). The branch is always kept.
- **Office and attention.** The plugin names a session after its folder's basename. Same-folder tabs therefore already carry the project's name. A worktree tab's folder (`shop-wt-3`) has its own name. Main maps it back with `projects.js` `sessionAliases(projects)` → `{ "shop-wt-3": "shop" }`, and passes that map to `readOffice(projects, now, root, aliases)` and `readToday(…, aliases)`. A mapped session counts as its project: its workers, shells and deliveries carry the project's name, and its busy state and permission dialogs are the project's. `attention.js` `nextAttention(…, aliases)` merges the same way (busy if any session is busy; the project's dialog is the oldest one). A folder name that equals another project's name is never mapped (that name belongs to that project). Attention stays per project, not per tab.
- **UI.** A project with one terminal looks exactly as before. Its only addition is a "+" at the terminal's top right that shows on hover. With extra tabs, a strip above the terminal shows `1 <folder>` for the main terminal, `n <folder>` for same-folder tabs and `n ⎇ <branch>` for worktree tabs (tooltip: kind and folder), each extra tab with a ×, then "+". The visible tab per project is kept only in the window. Shortcuts: ⌘T new tab (asks in a git repository), ⇧⌘T new worktree tab, ⇧⌘[ and ⇧⌘] previous and next tab; on Linux Ctrl+Shift+T new tab (worktree from the menu it opens) and Ctrl+Shift+PageUp/PageDown previous and next.
- `dev-mock.js`: `?tabs` gives the first project a same-folder tab and a worktree tab and shows the worktree tab.

## Theme picker (v3.1)

The repository's theme gallery (`themes/*.json`) ships with the app, and the sidebar picks one theme for the whole office.

```ts
agentOffice.prefs.get(): Promise<{ resume: boolean; theme: 'auto' | string }>
agentOffice.prefs.set(p: { resume?: boolean; theme?: 'auto' | string }): Promise<{ resume: boolean; theme: string }>
agentOffice.office.themes(): Promise<Record<string, ThemeSpec>>   // now: gallery themes, then the user's themes.json over them
```

- **Packaging.** `package.json` `build.extraResources` copies `../themes/*.json` to `Resources/themes`; under `npm start` main reads `../themes`. The previews are not shipped. Main reads the gallery once (sorted by file name).
- **Merging** (`src/themes.mjs`, pure, shared by main and the renderer). `galleryThemes(files)` turns the parsed files into one map and drops each gallery theme's `match`, so a gallery theme never applies because a project name contains it; it applies only when picked. `mergeThemes(gallery, user)` lays the user's `~/.claude/agent-office/themes.json` over the gallery: on a name clash the user's fields win and colours merge key by key, and a `match` comes only from the user's file. A missing or broken `themes.json` gives the gallery alone (`themesError` is unchanged).
- **Setting.** Main keeps `theme` in `state.json` next to `language` and `resume`: `'auto'` (default) or a theme name (`normalizeThemeSetting`: a non-empty string of at most 100 characters, else `'auto'`). A name that no longer exists is kept but treated as Auto (`effectiveTheme(setting, themes)` → `''`), so the choice comes back with the theme.
- **Office.** `renderer/office-view.js` `setTheme(name | '')` calls `core.mjs` `setTheme`: a name forces that theme in every project, `''` is today's pick by project (a `match` from `themes.json`, else colours from the project name). The frame, accent and terminal colours follow through `onTheme` → `applyTheme` as before. The user's **Bot color** is applied after the theme's colours, so it still wins over a theme's `body`/`bodyHi`/`shade`.
- **Sidebar.** A **Theme** / **Tema** select between Language and Bot color: **Auto (per project)**, then the built-ins `classic` and `forest`, then the other themes in map order (`themeChoices(themes)`), each by its name. Each option's tooltip is the theme's `description` (the built-ins' come from the locale files: `sidebar.themeClassicTitle`, `sidebar.themeForestTitle`); the closed select shows the chosen one's. Choosing switches the office at once (no reload) and saves through `prefs.set({ theme })`.
- `dev-mock.js`: `?theme=<name>` sets the stored choice (e.g. `?theme=sakura`); the mock reads the gallery from `../../themes/*.json`, so it is there under Electron's `loadFile` or a static server at the repository root (`/app/renderer/index.html`).
