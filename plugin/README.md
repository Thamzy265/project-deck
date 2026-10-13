# FlutterDeck Claude Code plugin

This folder will become the FlutterDeck plugin for Claude Code (see [docs/PLAN.md](../docs/PLAN.md#plugin-commands-hooks-and-init)). For now it holds one file.

## `.mcp.json`

[`.mcp.json`](.mcp.json) tells Claude Code which MCP servers to start. It currently starts one: the official Dart MCP server (`dart mcp-server`), which ships with the Dart SDK. It gives Claude hot reload, hot restart, runtime errors and the other Dart and Flutter tools, so FlutterDeck doesn't build its own.

```json
{
  "mcpServers": {
    "dart": {
      "type": "stdio",
      "command": "dart",
      "args": ["mcp-server"]
    }
  }
}
```

The same shape works in two places:

- **Inside this plugin.** Claude Code reads `.mcp.json` at the plugin root and starts the servers when the plugin is enabled.
- **In a project.** A `.mcp.json` at the root of a Flutter project is shared with everyone who opens it. Claude Code asks each user to approve it the first time.

### Requirements

- Dart SDK **3.9 or later** on your `PATH` (Flutter ships one). Check with `dart --version`. Older SDKs need the extra `--experimental-mcp-server` flag; FlutterDeck doesn't support them.

### Use it now

Until the plugin is released, add the Dart MCP server to your Flutter project in one of two ways.

**Option A: copy the file.** Copy `plugin/.mcp.json` to the root of your Flutter project as `.mcp.json`. If the project already has one, add the `dart` entry to its `mcpServers` object.

**Option B: let Claude Code write it.** From the root of your Flutter project, run:

```bash
claude mcp add --transport stdio --scope project dart -- dart mcp-server
```

Use `--scope user` instead to enable it in all your projects. Then start Claude Code, run `/mcp`, and check that `dart` is listed as connected.

### Check that it works

From the root of this repo, run:

```bash
node scripts/check-mcp-config.mjs
```

The script starts each server listed in `plugin/.mcp.json`, sends the MCP `initialize` and `tools/list` requests, prints the server name and its tools, and stops the server. Pass another path to check a different file, for example `node scripts/check-mcp-config.mjs ../my_app/.mcp.json`. It prints `FAILED` and exits with code 1 if a server doesn't start or answer within 30 seconds.

This runs the commands in the file. Only point it at files you trust. Before starting each server it prints the command and arguments it is about to run (never `env` values).

**Windows:** the script starts commands without a shell, and Node refuses to run `.bat` files that way. Flutter's `dart` on Windows is `dart.bat`, so put the Dart SDK's `dart.exe` (in `<flutter>\bin\cache\dart-sdk\bin`) first on your `PATH` before running the check. The script prints this hint if it hits the problem.

### The FlutterDeck server comes in M2

The finished file will have a second entry, `"flutterdeck"`, that runs `npx flutterdeck mcp`. That server doesn't exist until milestone M2, so it isn't listed yet: an entry that can't start would only show up as a failed server in Claude Code. JSON has no comments, which is why this note lives here.

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
