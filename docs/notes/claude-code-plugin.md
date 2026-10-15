# Claude Code plugin: facts checked for M2

Date: 2026-10-15. Sources: code.claude.com/docs/en/plugins-reference (manifest), /plugins/loading, /plugins/marketplace-reference, /hooks and /desktop, read on 15 Oct 2026; the Dart MCP server source (`dart-lang/ai`, `pkgs/dart_mcp_server/lib/src/mixins/dtd.dart`, main branch, 15 Oct 2026); Claude Code CLI 2.1.236 on macOS for `claude plugin validate`.

## Layout and manifest

- `.claude-plugin/plugin.json` holds the manifest; everything else sits at the plugin root: `.mcp.json`, `hooks/hooks.json`, `commands/`. The manifest is optional; `name` is the only required field (kebab-case). `version` pins installs from a copied marketplace; it is ignored for a plugin loaded in place.
- `claude plugin validate ./plugin` and `claude plugin validate .` (the development marketplace) both pass with CLI 2.1.236. The validator checks `.mcp.json` entries only from v2.1.281, so the local run didn't check them; the plugin tests check their shape instead.
- `hooks/hooks.json` wraps the event map in a top-level `"hooks"` key, with an optional `description`.

## `${CLAUDE_PLUGIN_ROOT}` and loading from this repo

- `${CLAUDE_PLUGIN_ROOT}` is substituted in hook `command` and `args`, and in an MCP stdio server's `command`, `args` and `env`. Hooks also get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR` in their environment; MCP servers get only the first two.
- **In place or copied.** `--plugin-dir` plugins and relative-path plugins from a marketplace added from a local folder load **in place**: `${CLAUDE_PLUGIN_ROOT}` is the source folder, so `${CLAUDE_PLUGIN_ROOT}/../packages/cli/dist/main.js` reaches this repo's CLI build. Every other marketplace plugin is copied into `~/.claude/plugins/cache/…`, where `..` is not the repo. That is why the M2 `.mcp.json` works only from a checkout; M5 switches to `npx flutterdeck mcp`.
- Component paths in the manifest may not contain `..`; an argument inside `.mcp.json` is not a component path, and the validator accepts it.
- **Claude Desktop has no `--plugin-dir`.** It loads plugins from configured marketplaces (the **+ → Plugins** menu). For local development the repo root therefore holds a development marketplace, `.claude-plugin/marketplace.json` (`flutterdeck-dev`, one plugin with source `./plugin`). `claude plugin marketplace add <repo>` registers it for the user (in `~/.claude/settings.json`); `claude plugin install flutterdeck@flutterdeck-dev` installs it. Edits take effect after `/reload-plugins` or a new session.
- In the terminal, `claude --plugin-dir <repo>/plugin` loads it for one session.

## Hooks

- **Exec form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/deck-hook.mjs"]`) passes each argument as is, without a shell, on every OS. `node` is looked up on `PATH`.
- `"async": true` runs the hook in the background: Claude never waits for it, and `timeout` (seconds) isn't enforced, so the script keeps its own 2 s deadline. Async output is only read as JSON for `additionalContext`; the script prints nothing.
- Exit code 0 with no output has no effect. Exit 2 would block (Stop: keep Claude going; PostToolUse: show stderr to Claude), so the script always exits 0.
- Matchers: a value of only letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else is an **unanchored** JavaScript regular expression, so the reload matcher uses `^…$`.
- Common input fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` (plus `agent_id` and others on some events).
- `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. `SubagentStop` adds `agent_id`, `agent_type`, `agent_transcript_path`.
- `Notification`: `message`, optional `title`, `notification_type`. Types: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed` and three `quota_auto_resume_*` types. FlutterDeck treats `permission_prompt` and `idle_prompt` as "Claude is waiting", as the brief says. `elicitation_dialog` (an MCP server asks for input) and `agent_needs_input` could also count; that is the lead's call.
- `PostToolUse`: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`. The `tool_response` shape for MCP tools isn't documented; the script reads a string, a list of content blocks or an object with `content` and `isError`.
- **`PostToolUseFailure`** fires when a tool fails, **including an MCP tool that returns an error result**, with `error` (the text Claude gets) and `is_interrupt`. Different from the plan, which named `PostToolUse` only: the Dart MCP server answers a failed reload with `isError: true`, so the failure arrives here. Both events are hooked.

## MCP tool names

- Plugin MCP servers are named `mcp__plugin_<plugin>_<server>__<tool>`. The plugin's Dart server's tools are `mcp__plugin_flutterdeck_dart__hot_reload` and `…__hot_restart`. A project `.mcp.json` entry `dart` gives `mcp__dart__hot_reload`; the Dart team's `dart-flutter` plugin gives `mcp__plugin_dart-flutter_dart-mcp-server__hot_reload`. The hook matcher accepts any server whose name contains `dart`.
- Tool names `hot_reload` and `hot_restart` are confirmed in the Dart MCP server source and in the `tools/list` check of 13 Oct 2026 (plugin/README.md).
- Results: success is `Hot reload succeeded.` / `Hot restart succeeded.`; failure is `isError: true` with `Hot reload failed.` or, when the call threw, `Hot reload failed: <error>`. That error text can hold the VM service URI with its auth code, so the hook replaces addresses and absolute paths before it sends a message.

## Open points for QA

- The fixtures in `plugin/test/fixtures.ts` are built from the docs. Record real hook inputs in a Claude Desktop session (with the token, paths and personal data removed) and replace them.
- The FlutterDeck MCP server uses its working folder as the project (`--project` defaults to `process.cwd()`). The docs don't say which folder a plugin's stdio server starts in, and `CLAUDE_PROJECT_DIR` isn't exported to MCP servers. Check in Claude Desktop that `deck_status` names the right project.
- The hook looks for `.flutterdeck/` in `CLAUDE_PROJECT_DIR`, the folder the session started in. Check a Claude Desktop session that runs in a worktree: if that folder is the worktree, it has no `runtime.json` (git-ignored) and the hook does nothing.
