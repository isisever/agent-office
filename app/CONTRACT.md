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
agentOffice.pathForFile(file: File): string
```

The sidebar's add button adds projects; ⌘O = add project.

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
  result?: string                                     // the agent's final answer, first 600 chars, once done
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

## Language (v2.5)

The app speaks English and Turkish.

```ts
type LanguageInfo = { setting: 'auto' | 'en' | 'tr'; lang: 'en' | 'tr' }   // 'auto' → system language (tr* → 'tr', else 'en')
agentOffice.language.get(): Promise<LanguageInfo>
agentOffice.language.set(setting: 'auto' | 'en' | 'tr'): Promise<LanguageInfo>
agentOffice.language.onChange(cb: (info: LanguageInfo) => void): () => void   // 'language:changed'
```

- Main keeps the setting as `language` in `state.json`, builds the menu and dialogs in that language, and sends the default account's label (`Default` / `Varsayılan`) and known auth errors (`errorKey` from `src/accounts.js`, localized by `localizeAuth`) in it; it re-sends `accounts:changed` on a change.
- Renderer: `renderer/i18n.js` holds the current language (`getLang`, `setLang`, `onLang`, `pick`, `locale`). Each module keeps its own `{ en, tr }` string table and re-renders on `onLang`; the window is not reloaded, terminals keep running.
- Office: `core.mjs` `setLanguage('en' | 'tr')` switches the drawn words (boss, waiting/working, today/done, agent types), the uppercase rule (Turkish i→İ only in Turkish) and the default titles (`AGENT OFFICE` / `AGENT OFİS`; a theme's own `title` wins). Default is Turkish.
- Sidebar: a Language picker (Auto, English, Türkçe) next to the bot colour.
