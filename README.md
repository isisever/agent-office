# Agent Office

**A pixel-art office for Claude Code.** Run Claude Code in several projects at once and watch every subagent walk into one shared office, sit at a desk with its current tool, and carry its result to the boss when it is done.

![Agent Office: the boss at work, subagents at their desks](plugin/docs/office.png)

Agent Office is a macOS app (and a Claude Code plugin that powers it). It wraps the real `claude` CLI: nothing is re-implemented, your settings, MCP servers and permissions work as usual.

## Features

- **A terminal per project.** Add your project folders in the sidebar; each one gets its own `claude` session that keeps running in the background while you look at another.
- **One boss over every project.** All projects' agents share the office. Desks carry a colored project tag, the whiteboard counts today's deliveries per project, and the boss's sign shows which projects keep it busy.
- **See what an agent is doing.** Click any worker to open a live panel: its task, the command or file it is on right now (`Bash: npm test`, `Edit: src/app.ts`), its last 20 tool calls and, once done, its result. Click the boss for a summary of every project.
- **Several Claude accounts.** Add accounts in the sidebar, log in with one click, and pick which account each project uses. Each account has its own Claude Code config folder, so logins never mix.
- **Local only.** No server, no telemetry. Everything stays on your Mac.

> The app's interface is currently in Turkish. The plugin's terminal view speaks English and Turkish. Translations are welcome (see [Contributing](#contributing)).

## Install

Requirements: macOS 12 or newer, and [Claude Code](https://code.claude.com) installed and on your `PATH`.

### Homebrew

```sh
brew install --cask isisever/tap/agent-office
```

Update with `brew upgrade --cask agent-office`; remove everything, including app data, with `brew uninstall --zap --cask agent-office`.

### Download

Get the `.dmg` for your Mac from [Releases](https://github.com/isisever/agent-office/releases/latest):

| Mac | File |
| --- | --- |
| Apple Silicon (M1 and later) | `AgentOffice-<version>-arm64.dmg` |
| Intel | `AgentOffice-<version>-x64.dmg` |

Open it and drag **Agent Office** to Applications.

### First launch

The app is not notarized by Apple yet, so macOS blocks it the first time. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Or, from a terminal:

```sh
xattr -dr com.apple.quarantine "/Applications/Agent Office.app"
```

## Using it

| | |
| --- | --- |
| **Add a project** | **+ Proje ekle** in the sidebar, or ⌘O |
| **Switch projects** | Click a project, or ⌘1 … ⌘9 |
| **Choose a project's account** | The **Hesap ▾** picker on the project's row. Its last entry, **+ Yeni hesap…**, creates an account for that project. |
| **Log in to an account** | **Giriş yap** next to the account. A small terminal runs `claude auth login`; approve in the browser and it closes by itself. |
| **See what an agent does** | Click the worker in the office. Esc closes the panel. |
| **Hide the sidebar** | ≡ in the title bar |

The **Varsayılan** (default) account is your normal Claude Code login in `~/.claude`. A new account starts empty: it does not share settings, MCP servers or `CLAUDE.md` with your default one.

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
| `~/.claude/agent-office/sessions/` | Per session: the agents, the first 600 characters of each agent's task and result, and a one-line summary of its last 20 tool calls (commands, file paths, search patterns, URLs). Removed automatically a day after the session ends. |
| `~/Library/Application Support/Agent Office/` | Your project list and the config folders of the accounts you added (each one holds that account's Claude Code login). |

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
2. `cd app && npm run dist`
3. `gh release create v<version> app/release/AgentOffice-<version>-*.dmg app/release/AgentOffice-<version>-*.zip`
4. `node packaging/homebrew/update-cask.mjs` and copy `packaging/homebrew/Casks/agent-office.rb` to the [tap](https://github.com/isisever/homebrew-tap).

## Contributing

Issues and pull requests are welcome. Some good places to start:

- English (and other) translations of the app interface
- Developer ID signing and notarization in the release build
- Linux and Windows builds

The app's main process, UI and office renderer meet at the interfaces described in [`app/CONTRACT.md`](app/CONTRACT.md); please keep it up to date when you change them.

## License

[MIT](LICENSE)

Agent Office is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.
