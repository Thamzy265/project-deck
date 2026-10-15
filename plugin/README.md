# FlutterDeck Claude Code plugin

This folder is the FlutterDeck plugin for Claude Code (see [docs/PLAN.md](../docs/PLAN.md#plugin-commands-hooks-and-init)). It holds:

| File                                                       | What it does                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) | Name (`flutterdeck`), version and description.                                                                                         |
| [`.mcp.json`](.mcp.json)                                   | Starts two MCP servers: the official Dart MCP server and FlutterDeck's own.                                                            |
| [`hooks/hooks.json`](hooks/hooks.json)                     | Runs [`hooks/deck-hook.mjs`](hooks/deck-hook.mjs) when Claude finishes, waits for you, or reloads the app through the Dart MCP server. |

`package.json`, `tsconfig.json`, `vitest.config.ts` and `test/` only let this repo typecheck and test the plugin. Claude Code doesn't read them.

Slash commands come with the M3 and M4 tools. Findings about the plugin format are in [docs/notes/claude-code-plugin.md](../docs/notes/claude-code-plugin.md).

## Requirements

- Node.js 22.12 or later on your `PATH` (the hooks and the FlutterDeck MCP server run with `node`).
- Dart SDK **3.9 or later** on your `PATH` (Flutter ships one). Check with `dart --version`. Older SDKs need the extra `--experimental-mcp-server` flag; FlutterDeck doesn't support them.
- Until the M5 release, a built checkout of this repo: run `pnpm install` and `pnpm build` at its root. The plugin's FlutterDeck server runs `packages/cli/dist/main.js` from the same checkout.
- In your Flutter project, run `flutterdeck init` once (`node <this repo>/packages/cli/dist/main.js init`). The hooks do nothing in a folder without `.flutterdeck/config.json`.

## Load it from this checkout

The plugin must load **in place**, so that `${CLAUDE_PLUGIN_ROOT}/..` is this repo. Claude Code does that for `--plugin-dir` and for a marketplace added from a local folder. A plugin installed from any other marketplace is copied into a cache, where `../packages` doesn't exist.

**Claude Desktop (and the terminal).** The repo root holds a development marketplace, [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), named `flutterdeck-dev`. Add it and install the plugin once:

```bash
claude plugin marketplace add /path/to/project-deck
claude plugin install flutterdeck@flutterdeck-dev
```

Then start a new session in your Flutter project (in Claude Desktop, a new Code session; in the terminal, `claude`). Open **+ → Plugins** in Desktop, or run `/plugin` in the terminal, to check that `flutterdeck` is enabled. After you change files in `plugin/`, run `/reload-plugins` or start a new session. To remove it: `claude plugin uninstall flutterdeck@flutterdeck-dev`, then `claude plugin marketplace remove flutterdeck-dev`.

**Terminal only, for one session.** `claude --plugin-dir /path/to/project-deck/plugin` loads it for that session without installing anything.

## `.mcp.json`

```json
{
  "mcpServers": {
    "dart": { "type": "stdio", "command": "dart", "args": ["mcp-server"] },
    "flutterdeck": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../packages/cli/dist/main.js", "mcp"]
    }
  }
}
```

- **`dart`** is the official Dart MCP server (`dart mcp-server`), which ships with the Dart SDK. It gives Claude hot reload, hot restart, runtime errors and the other Dart and Flutter tools, so FlutterDeck doesn't build its own.
- **`flutterdeck`** is FlutterDeck's MCP server (`deck_status`, `get_logs`). It starts the project's daemon when it starts. In M2 it runs this checkout's CLI build; the M5 release changes it to `npx flutterdeck mcp`. JSON has no comments, which is why this note lives here.
- Claude Code names plugin tools `mcp__plugin_flutterdeck_<server>__<tool>`, for example `mcp__plugin_flutterdeck_dart__hot_reload`.
- If your Flutter project also has its own `.mcp.json` with a `dart` entry (the M1 instructions), Claude gets two Dart servers. Remove the project entry, or leave it: the hooks work with either.

### Check that it works

From the root of this repo, run:

```bash
node scripts/check-mcp-config.mjs
```

The script starts each server listed in `plugin/.mcp.json`, sends the MCP `initialize` and `tools/list` requests, prints the server name and its tools, and stops the server. It skips `flutterdeck`, because only Claude Code expands `${CLAUDE_PLUGIN_ROOT}`. Pass another path to check a different file, for example `node scripts/check-mcp-config.mjs ../my_app/.mcp.json`. It prints `FAILED` and exits with code 1 if a server doesn't start or answer within 30 seconds.

This runs the commands in the file. Only point it at files you trust. Before starting each server it prints the command and arguments it is about to run (never `env` values). A relative `command` (such as `./bin/server`) resolves against the directory you run the script from, not the directory of the JSON file, so run it from the folder that file expects.

**Windows:** the script starts commands without a shell, and Node refuses to run `.bat` files that way. Flutter's `dart` on Windows is `dart.bat`, so put the Dart SDK's `dart.exe` (in `<flutter>\bin\cache\dart-sdk\bin`) first on your `PATH` before running the check. The script prints this hint if it hits the problem.

To use the Dart MCP server without the plugin, copy the `dart` entry into your Flutter project's `.mcp.json`, or run `claude mcp add --transport stdio --scope project dart -- dart mcp-server`.

## Hooks

| Claude Code event                                                                       | Sent to the daemon                                                     | Shown as                                                                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Stop`, `SubagentStop`                                                                  | `claude.done`                                                          | Activity "Claude finished" (Claude Desktop sends its own OS notification)                                 |
| `Notification` (`permission_prompt`, `idle_prompt`)                                     | `claude.waiting` with Claude Code's message                            | Activity "Claude is waiting: …" and an OS notification                                                    |
| `PostToolUse` / `PostToolUseFailure` on the Dart server's `hot_reload` or `hot_restart` | `claude.reload` with `ok`, the kind and, when it failed, a short error | Activity "Reloaded (from Claude or the IDE)" or "Reload failed: …", and an OS notification when it failed |

The Dart MCP server answers a failed reload with an error result, which Claude Code reports as `PostToolUseFailure`, so both events are hooked. The hook matches any MCP server whose name contains `dart`, so it also works with a project `.mcp.json` entry or the Dart team's own plugin.

What the hook does:

- Reads the hook's JSON from stdin, finds the project from `CLAUDE_PROJECT_DIR` (or the hook's `cwd`), and reads the port and token from `.flutterdeck/runtime.json`. It never follows a link in `.flutterdeck/`.
- Checks `GET /api/health` on `127.0.0.1:<port>` first, so the token goes only to a FlutterDeck daemon, then sends `POST /api/events` with the token header.
- Sends only the fields above. Never `last_assistant_message`, `transcript_path`, `cwd` or the tool's input (whose app URI holds a VM service auth code). A reload error is cut to 300 characters, with addresses and absolute paths replaced by `[address]` and `[path]`.
- Runs in the background (`async`), gives up after 2 seconds, prints nothing and always exits with code 0, so it never holds up or interrupts Claude. It does nothing when the folder isn't set up or the daemon isn't running.

OS notifications come from the daemon, not the hook. Switch each one off in `.flutterdeck/config.json`: `"notifications": { "appCrashed": false, "reloadFailed": false, "claudeWaiting": false }`.

## What the Dart MCP server already covers

Checked on 13 Oct 2026 with Dart 3.12.2 (server `dart and flutter tooling` 0.1.4, MCP protocol `2025-06-18`). `tools/list` returned 13 tools:

`analyze_files`, `dtd`, `flutter_driver_command`, `get_runtime_errors`, `hot_reload`, `hot_restart`, `lsp`, `pub`, `pub_dev_search`, `read_package_uris`, `rip_grep_packages`, `roots`, `widget_inspector`.

FlutterDeck must never add a tool that duplicates one of these. In particular:

| Need                     | Dart MCP tool        | Notes                                               |
| ------------------------ | -------------------- | --------------------------------------------------- |
| Hot reload               | `hot_reload`         | Keeps app state. Needs a DTD connection.            |
| Hot restart              | `hot_restart`        | Resets app state. Flutter only. Needs DTD.          |
| Runtime errors           | `get_runtime_errors` | Most recent errors from the active app. Needs DTD.  |
| Finding and attaching    | `dtd`                | `listDtdUris`, then `connect`, to reach a live app. |
| Widget tree / inspection | `widget_inspector`   |                                                     |

Claude must connect with the `dtd` tool before the reload, restart and error tools work.

The server's `--help` also names `create_project`, `dart_fix`, `dart_format`, `get_active_location`, `get_app_logs`, `launch_app`, `list_devices`, `list_running_apps`, `run_tests` and `stop_app`. None of them appeared in `tools/list`; the [upstream README](https://github.com/dart-lang/ai/tree/main/pkgs/dart_mcp_server) marks them as off by default. FlutterDeck doesn't turn them on: `launch_app` and `stop_app` would go against its attach-only design. The upstream README also lists a `vm_service` tool that this SDK's server doesn't have. Rerun the check script after a Dart upgrade and update this list if it changes.
