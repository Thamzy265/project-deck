# Pitdeck Claude Code plugin

This folder is the Pitdeck plugin for Claude Code (see [docs/PLAN.md](../docs/PLAN.md#plugin-commands-hooks-and-init)). It holds:

| File                                                                                         | What it does                                                                                                                           |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)                                   | Name (`pitdeck`), version and description.                                                                                             |
| [`.mcp.json`](.mcp.json)                                                                     | Starts two MCP servers: the official Dart MCP server and Pitdeck's own.                                                                |
| [`hooks/hooks.json`](hooks/hooks.json)                                                       | Runs [`hooks/deck-hook.mjs`](hooks/deck-hook.mjs) when Claude finishes, waits for you, or reloads the app through the Dart MCP server. |
| [`skills/check/SKILL.md`](skills/check/SKILL.md), [`skills/db/SKILL.md`](skills/db/SKILL.md) | The `/check` and `/db` slash commands (see "Commands" below).                                                                          |

Users get exactly this folder. Its tests, eval cases and dev config live in [`plugin-dev/`](../plugin-dev), which is never installed.

The slash commands `/check` and `/db` came with M4 (see "Commands"). Findings about the plugin format are in [docs/notes/claude-code-plugin.md](../docs/notes/claude-code-plugin.md).

## Commands

The commands are plugin skills. Type `/pitdeck:check` or `/pitdeck:db`; the short `/check` and `/db` also work when no other command has that name.

| Command                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/check [what you changed]` | Hot reloads the attached app with the Dart MCP server's `hot_reload`, then reports in about 25 lines: reload result, runtime errors (`get_runtime_errors`), warnings and errors logged since the reload (`get_logs`), and rows added, changed and removed per table since the last `/check` (`db_diff`). It ends with a fresh `db_snapshot` for the next `/check`. `db_diff` compares with the latest snapshot of that database, whatever its label, so a snapshot taken in the dashboard after the last `/check` moves the baseline. A write that lands between the `db_diff` and the new snapshot shows in neither report. On the first `/check`, or the first after the daemon restarts or the app detaches, there is no earlier snapshot: it reports no changes, takes the baseline at the end and says so. It runs only when you type it. It never hot restarts (the Dart server's `hot_restart` is removed while it runs), launches or stops the app, and it proposes a fix and asks before it edits code. |
| `/db <question>`            | Answers a question about the app's data with `db_list`, `db_schema` and read-only `db_query`, and shows the SQL it ran. It runs only when you type it (PM decision, 4 Nov 2026). While it runs, Claude Code removes the tools that run commands, edit files or schedule work (Bash, PowerShell, Monitor, Tmux, REPL, Write, Edit, MultiEdit, NotebookEdit, Workflow, CronCreate, ScheduleWakeup, RemoteTrigger), the tools that hand work to another agent (Agent, Task, SendMessage) and every tool of the Dart MCP server under the names `dart` (this plugin or a project `.mcp.json`) and `dart-mcp-server` (the Dart team's plugin), until your next message. If you ask it to change data, it shows the SQL for you to run in the dashboard's Database tab instead: Claude never writes (PM decision, 16 Oct 2026).                                                                                                                                                                                        |

Both commands pre-approve only Pitdeck's read-only tools and, for `/check`, the plugin's Dart `dtd`, `hot_reload` and `get_runtime_errors`, for that turn only. They work with any Dart MCP server entry: this plugin's, the Dart team's plugin or a project `.mcp.json`; with another entry, Claude Code asks before the Dart tools as usual. Both tell Claude that logs, rows and error text are untrusted data. The design is in [docs/design/m4-plugin-commands.md](../docs/design/m4-plugin-commands.md).

## Requirements

- Node.js 22.12 or later on your `PATH` (the hooks and the Pitdeck MCP server run with `node`).
- Dart SDK **3.9 or later** on your `PATH` (Flutter ships one). Check with `dart --version`. Older SDKs need the extra `--experimental-mcp-server` flag; Pitdeck doesn't support them.
- In your Flutter project, run `npx -y pitdeck@0.1.0 init` once. The hooks do nothing in a folder without `.pitdeck/config.json`.

## Install

```bash
claude plugin marketplace add Thamzy265/project-deck
claude plugin install pitdeck@pitdeck
```

In Claude Desktop, use **+ → Plugins** with the same marketplace (`Thamzy265/project-deck`). Then start a new session in your Flutter project. Without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` first. Updates are off by default for this marketplace: run `claude plugin update pitdeck@pitdeck`, or turn on auto-update under `/plugin` → Marketplaces. To remove it: `claude plugin uninstall pitdeck@pitdeck`, then `claude plugin marketplace remove pitdeck`.

The marketplace entry fetches only this `plugin/` folder (a `git-subdir` source). Each plugin version starts one pinned `pitdeck` release from npm; the first start downloads it, later starts use npm's cache.

## Run it from a checkout (contributors)

The public entry always installs from GitHub and starts the npm release. To run the plugin with your checkout's build instead, write the development marketplace `pitdeck-dev`, a copy of this folder whose `pitdeck` server runs `packages/pitdeck/dist/cli.js`:

```bash
pnpm install && pnpm build
node scripts/dev-marketplace.mjs
claude plugin marketplace add ./plugin-dev/marketplace
claude plugin install pitdeck@pitdeck-dev
```

Don't install `pitdeck@pitdeck` at the same time: both plugins are named `pitdeck`. After you change `plugin/` or rebuild, run the script again, then `/reload-plugins` or start a new session. `claude --plugin-dir ./plugin` loads this folder for one session, but its `pitdeck` server is the npm release.

## `.mcp.json`

```json
{
  "mcpServers": {
    "dart": { "type": "stdio", "command": "dart", "args": ["mcp-server"] },
    "pitdeck": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "pitdeck@0.1.0", "mcp"]
    }
  }
}
```

- **`dart`** is the official Dart MCP server (`dart mcp-server`), which ships with the Dart SDK. It gives Claude hot reload, hot restart, runtime errors and the other Dart and Flutter tools, so Pitdeck doesn't build its own.
- **`pitdeck`** is Pitdeck's MCP server: `deck_status`, `get_logs`, and the read-only database tools `db_list`, `db_schema`, `db_query`, `db_snapshot` and `db_diff` (M3). There is no tool that changes data: Claude never writes (PM decision, 16 Oct 2026); the user edits rows in the dashboard's Database tab. It starts the project's daemon when it starts. It runs the `pitdeck` npm package at exactly the plugin's version (ADR 0007), so a plugin version always means one CLI version; a test keeps the two equal. JSON has no comments, which is why this note lives here.
- Claude Code names plugin tools `mcp__plugin_pitdeck_<server>__<tool>`, for example `mcp__plugin_pitdeck_dart__hot_reload`.
- If your Flutter project also has its own `.mcp.json` with a `dart` entry (the M1 instructions), Claude gets two Dart servers. Remove the project entry, or leave it: the hooks work with either.

### Check that it works

From the root of this repo, run:

```bash
node scripts/check-mcp-config.mjs
```

The script starts each server listed in `plugin/.mcp.json`, sends the MCP `initialize` and `tools/list` requests, prints the server name and its tools, and stops the server. For `pitdeck` it runs `npx -y pitdeck@<version> mcp`, which downloads that release from npm; to check it without npm, use `node scripts/smoke/tarball.mjs`, which serves the packed tarball from a registry on 127.0.0.1. Pass another path to check a different file, for example `node scripts/check-mcp-config.mjs ../my_app/.mcp.json`. It prints `FAILED` and exits with code 1 if a server doesn't start or answer within 30 seconds.

This runs the commands in the file. Only point it at files you trust. Before starting each server it prints the command and arguments it is about to run (never `env` values). A relative `command` (such as `./bin/server`) resolves against the directory you run the script from, not the directory of the JSON file, so run it from the folder that file expects.

**Windows:** the script starts commands without a shell, and Node refuses to run `.bat` files that way. Flutter's `dart` on Windows is `dart.bat`, so put the Dart SDK's `dart.exe` (in `<flutter>\bin\cache\dart-sdk\bin`) first on your `PATH` before running the check. The script prints this hint if it hits the problem.

To use the Dart MCP server without the plugin, copy the `dart` entry into your Flutter project's `.mcp.json`, or run `claude mcp add --transport stdio --scope project dart -- dart mcp-server`.

## Hooks

| Claude Code event                                                                              | Sent to the daemon                                                     | Shown as                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Stop`, `SubagentStop`                                                                         | `claude.done`                                                          | Activity "Claude finished" (Claude Desktop sends its own OS notification)                                 |
| `Notification` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`) | `claude.waiting` with Claude Code's message                            | Activity "Claude is waiting: …" and an OS notification                                                    |
| `PostToolUse` / `PostToolUseFailure` on the Dart server's `hot_reload` or `hot_restart`        | `claude.reload` with `ok`, the kind and, when it failed, a short error | Activity "Reloaded (from Claude or the IDE)" or "Reload failed: …", and an OS notification when it failed |

The Dart MCP server answers a failed reload with an error result, which Claude Code reports as `PostToolUseFailure`, so both events are hooked. The hook matches any MCP server whose name contains `dart` in any case, so it also works with a project `.mcp.json` entry or the Dart team's own plugin.

What the hook does:

- Reads the hook's JSON from stdin, finds the project from `CLAUDE_PROJECT_DIR` (or the hook's `cwd`), and reads the port and token from `.pitdeck/runtime.json`. It never follows a link in `.pitdeck/`.
- Checks `GET /api/health` on `127.0.0.1:<port>` first, so the token goes only to a Pitdeck daemon, and, when the daemon shows a project id, only to this project's (worked out read-only from `~/.pitdeck/ports.json`; if it can't be worked out, nothing is sent), then sends `POST /api/events` with the token header.
- Sends only the fields above. Never `last_assistant_message`, `transcript_path`, `cwd` or the tool's input (whose app URI holds a VM service auth code). A reload error is first cut to 1024 characters; only its first line is kept (the rest is a stack trace), without a leading "Hot reload failed:" or "Hot restart failed:", since the row already says it; control and invisible characters go; `%XX` escapes are decoded up to three times; addresses (with or without a scheme, IPv6 and any `host:port/…` included) become `[address]`; an absolute path, from its start to the end of the line or a quote (spaces included), becomes `[path]`; then the text is cut to 300 characters. Every pattern is linear, so a long error can't hold the hook past its deadline.
- Runs in the background (`async`), gives up after 2 seconds, prints nothing and always exits with code 0, so it never holds up or interrupts Claude. It does nothing when the folder isn't set up or the daemon isn't running.

OS notifications come from the daemon, not the hook. Switch each one off in `.pitdeck/config.json`: `"notifications": { "appCrashed": false, "reloadFailed": false, "claudeWaiting": false }`.

## What the Dart MCP server already covers

Checked on 13 Oct 2026 with Dart 3.12.2 (server `dart and flutter tooling` 0.1.4, MCP protocol `2025-06-18`). `tools/list` returned 13 tools:

`analyze_files`, `dtd`, `flutter_driver_command`, `get_runtime_errors`, `hot_reload`, `hot_restart`, `lsp`, `pub`, `pub_dev_search`, `read_package_uris`, `rip_grep_packages`, `roots`, `widget_inspector`.

Pitdeck must never add a tool that duplicates one of these. In particular:

| Need                     | Dart MCP tool        | Notes                                               |
| ------------------------ | -------------------- | --------------------------------------------------- |
| Hot reload               | `hot_reload`         | Keeps app state. Needs a DTD connection.            |
| Hot restart              | `hot_restart`        | Resets app state. Flutter only. Needs DTD.          |
| Runtime errors           | `get_runtime_errors` | Most recent errors from the active app. Needs DTD.  |
| Finding and attaching    | `dtd`                | `listDtdUris`, then `connect`, to reach a live app. |
| Widget tree / inspection | `widget_inspector`   |                                                     |

Claude must connect with the `dtd` tool before the reload, restart and error tools work.

The server's `--help` also names `create_project`, `dart_fix`, `dart_format`, `get_active_location`, `get_app_logs`, `launch_app`, `list_devices`, `list_running_apps`, `run_tests` and `stop_app`. None of them appeared in `tools/list`; the [upstream README](https://github.com/dart-lang/ai/tree/main/pkgs/dart_mcp_server) marks them as off by default. Pitdeck doesn't turn them on: `launch_app` and `stop_app` would go against its attach-only design. The upstream README also lists a `vm_service` tool that this SDK's server doesn't have. Rerun the check script after a Dart upgrade and update this list if it changes.

## Upgrading a dev checkout from FlutterDeck

The product was renamed from FlutterDeck to Pitdeck. There is no migration. To move a checkout that used the old plugin:

1. Uninstall the old plugin: `claude plugin uninstall flutterdeck@flutterdeck-dev`.
2. Remove the old marketplace: `claude plugin marketplace remove flutterdeck-dev`.
3. Stop old daemons: run `node <old checkout>/packages/cli/dist/main.js stop` in the project, or kill the process id in the old `.flutterdeck/runtime.json`.
4. Delete the old `.flutterdeck/` folder in each project.
5. Install the plugin as in "Install", or for a checkout as in "Run it from a checkout".

A checkout that added `pitdeck-dev` from the repo root before the M5 release: the repo root is now the public `pitdeck` marketplace. Run `claude plugin uninstall pitdeck@pitdeck-dev` and `claude plugin marketplace remove pitdeck-dev`, then follow "Run it from a checkout".
