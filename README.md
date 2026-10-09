# Agent Office

**A pixel-art office for Claude Code.** Run Claude Code in several projects at once and watch every subagent walk into one shared office, sit at a desk with its current tool, and carry its result to the boss when it is done.

![Agent Office: the boss at work, subagents at their desks](plugin/docs/office.png)

Agent Office is a macOS app (and a Claude Code plugin that powers it). It wraps the real `claude` CLI: nothing is re-implemented, your settings, MCP servers and permissions work as usual.

## Features

- **A terminal per project.** Add your project folders in the sidebar; each one gets its own `claude` session that keeps running in the background while you look at another.
- **One boss over every project.** All projects' agents share the office. Desks carry a colored project tag, the whiteboard counts today's deliveries per project, and the boss's sign shows which projects keep it busy.
- **See what an agent is doing.** Click any worker to open a live panel: its task, the command or file it is on right now (`Bash: npm test`, `Edit: src/app.ts`), its last 20 tool calls and, once done, its result. Click the boss for a summary of every project.
- **Several Claude accounts.** Add accounts in the sidebar, log in with one click, and pick which account each project uses. Each account has its own Claude Code config folder, so logins never mix.
- **Knows when Claude needs you.** A project waiting for your approval, or one that just finished while you were looking elsewhere, raises a macOS notification, shows on the Dock badge and gets a mark on its row; the boss's sign says NEEDS YOU. Click the notification to jump there.
- **Plan usage per account.** Under each account, the 5-hour and weekly usage of its Claude plan (Pro/Max) and when each one resets, taken from that account's last Claude session, with a notification at 80% and 95%.
- **Local only.** No server, no telemetry. Everything stays on your Mac.

> The app and the plugin speak English and Turkish. The app follows your system language; pick one with **Language** at the bottom of the sidebar. Other translations are welcome (see [Contributing](#contributing)).

## Install

Requirements: macOS 12 or newer, and [Claude Code](https://code.claude.com) installed and on your `PATH`.

### Homebrew

```sh
brew install --cask isisever/tap/agent-office
```

The app updates itself; remove everything, including app data, with `brew uninstall --zap --cask agent-office`.

### Download

Get the `.dmg` for your Mac from [Releases](https://github.com/isisever/agent-office/releases/latest):

| Mac | File |
| --- | --- |
| Apple Silicon (M1 and later) | `AgentOffice-<version>-arm64.dmg` |
| Intel | `AgentOffice-<version>-x64.dmg` |

Open it and drag **Agent Office** to Applications.

### Updates

Agent Office checks GitHub Releases at start and every few hours. A new version downloads in the background; then **⬆ … ready · restart** appears in the title bar (or it installs when you quit). You can also check from the app menu: **Check for Updates…**.

## Using it

| | |
| --- | --- |
| **Add a project** | **+ Add project** in the sidebar, or ⌘O |
| **Switch projects** | Click a project, or ⌘1 … ⌘9 |
| **Run several Claudes in a project** | Hover the terminal and click **+** (or ⌘T): pick the same folder or, in a git repository, a new git worktree (⇧⌘T). A worktree goes next to the repository as `<repo>-wt-<n>` on a new branch `agent-office/<n>`. Tabs appear above the terminal (⇧⌘[ / ⇧⌘] switch tabs). Closing a worktree tab asks whether to remove the worktree; git refuses if it has changes, and the branch is kept. The office counts a worktree's agents under its project. |
| **Choose a project's account** | The **Account ▾** picker on the project's row. Its last entry, **+ New account…**, creates an account for that project. |
| **Log in to an account** | **Log in** next to the account. A small terminal runs `claude auth login`; approve in the browser and it closes by itself. |
| **See an account's usage** | The **5 h** and **Week** bars under the account: percentage used and reset time. They fill in once a project on that account has talked to Claude; hover for how old the value is. |
| **See what an agent does** | Click the worker in the office. Esc closes the panel. |
| **Pick up where you left off** | **Continue last session** at the bottom of the sidebar (on by default): when the app starts, each project continues its last Claude session (`claude --continue`) |
| **See what got done today** | Click the whiteboard: every delivery of the day with its project, duration, tool count and whether it succeeded |
| **Change the language** | **Language** at the bottom of the sidebar: Auto (system language), English or Türkçe. The labels here are the English ones. |
| **Change the bots' color** | **Bot color** at the bottom of the sidebar (↺ resets it) |
| **Hide the sidebar** | ≡ in the title bar |

The **Default** account is your normal Claude Code login in `~/.claude`. A new account starts empty: it does not share settings, MCP servers or `CLAUDE.md` with your default one.

## How it works

```
 ┌──────────── Agent Office.app ─────────────┐
 │  sidebar   office (canvas)   agent panel  │
 │  terminal: claude ── one per project      │◄── reads ~/.claude/agent-office/sessions/*.json
 └──────────────────┬────────────────────────┘
                    │ starts claude --plugin-dir <bundled plugin>
                    ▼
        Claude Code + agent-office plugin ──► writes agents, tools, deliveries
```

1. The app starts `claude` for each project in a pseudo-terminal, with the bundled plugin and, for non-default accounts, `CLAUDE_CONFIG_DIR` pointing at that account's folder.
2. The plugin ([`plugin/`](plugin)) listens to Claude Code's hook events: subagents starting, calling tools and finishing. It writes a small state file per session.
3. The app reads those files twice a second and draws the office.

## Privacy

All data stays on your machine:

| Where | What |
| --- | --- |
| `~/.claude/agent-office/sessions/` | Per session: the agents, the first 600 characters of each agent's task and 4000 of its result, and a one-line summary of its last 20 tool calls (commands, file paths, search patterns, URLs). Removed automatically a day after the session ends. |
| `~/Library/Application Support/Agent Office/` | Your project list, the config folders of the accounts you added (each one holds that account's Claude Code login) and, under `usage/`, each project's latest Claude Code status line input (model, context and plan usage), used for the usage bars. |

Nothing is sent anywhere by Agent Office. Claude Code itself talks to Anthropic as usual.

## The plugin on its own

Without the app, the plugin draws the office right in your terminal (`/office`, best in Ghostty, kitty or WezTerm):

```
/plugin marketplace add isisever/agent-office
/plugin install agent-office@agent-office
```

See [plugin/README.md](plugin/README.md).

## Building from source

```sh
git clone https://github.com/isisever/agent-office
cd agent-office/app
npm install
npm start            # run the app from source
npm run dist         # build release/*.dmg and *.zip for arm64 and x64
```

Tests:

```sh
node --test app/test/main.test.cjs        # main process: projects, accounts
node app/test/office.test.mjs             # office renderer and session reading
claude plugin test plugin                 # plugin hooks
node plugin/tests/viewer-smoke.mjs        # terminal viewer
```

`app/renderer/index.html` also opens in a plain browser with a fake backend (`renderer/dev-mock.js`), handy for UI work: serve `app/` with any static server and open `/renderer/index.html`.

### Releasing

1. Bump `version` in `app/package.json` (and `plugin/.claude-plugin/plugin.json`).
2. `cd app && npm run dist:release` — signs with the maintainer's Developer ID and notarizes with Apple. It needs that certificate in the keychain and a notarytool profile stored once with `xcrun notarytool store-credentials agent-office --apple-id <apple id> --team-id <team id>` (override the names with `CSC_NAME` and `APPLE_KEYCHAIN_PROFILE`). Without them, `npm run dist` builds an ad-hoc-signed copy for local use.
3. `gh release create v<version> app/release/AgentOffice-<version>-* app/release/latest-mac.yml` (the zips, blockmaps and `latest-mac.yml` are what the in-app updater downloads)
4. `node packaging/homebrew/update-cask.mjs` and copy `packaging/homebrew/Casks/agent-office.rb` to the [tap](https://github.com/isisever/homebrew-tap).

## Contributing

Issues and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) explains the layout, the tests and the conventions. Some good places to start:

- More translations of the app interface (strings live in a `{ en, tr }` table at the top of each renderer module)
- Linux and Windows builds

The app's main process, UI and office renderer meet at the interfaces described in [`app/CONTRACT.md`](app/CONTRACT.md); please keep it up to date when you change them.

## License

[MIT](LICENSE)

Agent Office is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.
