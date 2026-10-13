# FlutterDeck: Build Plan for an AI Dev Cockpit

Oct 6, 2026 · @William Nason

## Overview

FlutterDeck (working name) is an open-source dashboard and Claude Code plugin that puts a Drift database inspector, live logs, reload controls and Linear tasks next to Claude, so a Flutter developer works from one window. It builds on the official Dart MCP server and the Dart Tooling Daemon (DTD) instead of re-creating them.

**Revised plan (8 Oct 2026).** The first version had FlutterDeck launch the app and implement its own hot reload. That duplicated the official Dart MCP server, broke IDE debugging and tied the project to Flutter internals. This version only connects to apps that are already running, and spends its effort on what nobody else offers.

What already exists and is reused:

- **Claude Desktop's Code tab:** chat, terminal, diff, files, background tasks, PR checks, Browser pane.
- **The official Dart MCP server** (`dart mcp-server`): gives Claude hot reload, hot restart, runtime errors and more.
- **The Dart Tooling Daemon:** knows which Flutter apps are running, including ones started from Android Studio or VS Code, so breakpoints keep working.

What FlutterDeck adds:

- **A dashboard** in Desktop's Browser pane: reload buttons, filtered logs, the Drift inspector, Linear tasks, an activity feed.
- **A Drift inspector** that is clearly better than the existing DevTools extension. This is the headline feature.
- **A small MCP server** for what the official one doesn't cover: database queries and Linear tasks.
- **Notifications** when Claude finishes or the app crashes.

**How to use this doc with Claude:** export it to Markdown, save it in the repo as `docs/PLAN.md`, and reference it from `CLAUDE.md`. Build one milestone at a time; each has acceptance criteria to verify before moving on.

## Goals, non-goals and v1 scope

v1 succeeds when a Flutter developer can pick a Linear task, let Claude implement it, reload, read logs and inspect the Drift database without leaving Claude Desktop, while still launching and debugging the app from their own IDE if they want.

**Goals**

- One window: everything visible in Claude Desktop's pane layout.
- Work with apps however they were started: IDE, terminal, or the Dart MCP server's own launch tool.
- A Drift inspector clearly better than the existing Drift DevTools extension.
- Framework-neutral core so Compose and web support can be added later.
- Install in under five minutes with one `init` command.
- Validate demand early: a public demo of the inspector before the Linear work starts.

**Non-goals for v1**

- Launching or owning the app process.
- Re-implementing anything the Dart MCP server or Claude Desktop already provides (reload tools for Claude, runtime errors, chat, diff, terminal, PR review).
- Device screen mirroring.
- Compose, web, and task trackers other than Linear (interfaces only).
- Cloud or multi-user features. Everything runs on localhost.

**v1 platforms:** macOS, Linux and Windows hosts; Android emulator and devices first; iOS simulator for logs and reload.

## Architecture

FlutterDeck never launches the app. A local daemon finds running apps through the Dart Tooling Daemon, talks to them over their VM service, and serves the dashboard and a small MCP server. Claude uses the official Dart MCP server for reload and errors, and FlutterDeck's MCP server for the database and tasks.

&#91;embedded content: FlutterDeck architecture · Desktop, MCP server, daemon, adapters\]

Because both MCP servers and the IDE attach to the same running app, you can set a breakpoint in Android Studio, have Claude reload through the Dart MCP server, and watch new rows appear in the dashboard, all at once.

Components:

- **Daemon** (`packages/daemon`): connects to DTD, tracks running apps, attaches to each app's VM service, buffers logs, holds the current task, serves the dashboard and HTTP/WS API, raises OS notifications.
- **MCP server** (`packages/mcp`): thin client of the daemon; only database and task tools.
- **Dashboard** (`packages/dashboard`): human UI over WebSocket.
- **CLI** (`packages/cli`): `init`, `start`, `stop`, `doctor`, `mcp`.
- **Connectors and inspectors**: `connector-dart` (DTD + VM service), `logs-android` (logcat), `db-drift`, `db-sqlite`, `tasks-linear`.
- **In-app helper** (`dart/flutterdeck_drift`): optional, debug-only, gives live Drift access.
- **Reused, not built:** the official Dart MCP server (configured by `init`), DTD, Claude Desktop.

## Tech stack and repo layout

The project is a TypeScript monorepo plus one small Dart package that runs inside the user's app in debug builds.

| Area | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict), Node 20+ | Mature MCP SDK, easy for web and Compose contributors |
| Workspace | pnpm workspaces | Fast, simple package linking |
| MCP | `@modelcontextprotocol/sdk`, stdio | Standard for Claude Code plugins |
| DTD and VM service | JSON-RPC 2.0 over WebSocket (`ws`) | Same protocol DevTools and IDEs use |
| Daemon HTTP + WS | Hono or Fastify | Small, typed, fast |
| Dashboard | Vite + React + TypeScript, Tailwind | Static build served by the daemon |
| Tables and editor | TanStack Table, CodeMirror 6 (SQL) | Virtualised grids for big tables and logs |
| SQLite snapshot mode | `sql.js` (WebAssembly) | No native build, so `npx` installs don't break |
| Validation | `zod` | Shared schemas for MCP inputs and the HTTP API |
| Tests | Vitest | Fake connectors and recorded JSON-RPC fixtures |
| In-app helper | Dart package `flutterdeck_drift` | Live Drift queries via a VM service extension |

Avoid native Node modules (`better-sqlite3`, `keytar`) so installs work on every OS without compilers. For secrets, use the OS credential tool through a small pure-JS wrapper or a 0600 file.

```
flutterdeck/
  packages/
    core/            # interfaces, shared types, zod schemas, event bus
    daemon/          # local server: DTD client, app sessions, HTTP + WS, serves dashboard
    mcp/             # MCP server (stdio): database + task tools only
    dashboard/       # React app for the Browser pane
    cli/             # flutterdeck init | start | stop | doctor | mcp
    connector-dart/  # AppConnector: DTD discovery + VM service (reload, logs, extensions)
    logs-android/    # adb logcat helper (reused by Compose later)
    db-drift/        # DbInspector via flutterdeck_drift extension
    db-sqlite/       # DbInspector via pulled SQLite file (fallback)
    tasks-linear/    # TaskProvider for Linear
  dart/
    flutterdeck_drift/
  plugin/            # Claude Code plugin
  docs/
    PLAN.md
    ADAPTERS.md
```

## Core interfaces

Four interfaces in `packages/core` are the contract every framework and tracker implements. The main change from the first draft: `RunAdapter` (which launched apps) is replaced by `AppConnector`, which only discovers and attaches to apps that are already running. Treat these as a draft; refine in M1, then freeze.

```ts
// packages/core/src/apps.ts

export type DeviceInfo = { id: string; name: string; platform: 'android' | 'ios' | 'web' | 'desktop' };

export interface RunningApp {
  id: string;                    // stable for the life of the app
  name: string;                  // e.g. package name
  device?: DeviceInfo;
  pid?: number;                  // process id on its device, once known (after attach)
  framework: 'flutter' | 'compose' | 'web';
  startedBy: 'ide' | 'terminal' | 'mcp' | 'unknown';
}

export type ReloadResult =
  | { ok: true; kind: 'hot-reload' | 'hot-restart' | 'rebuild'; durationMs: number }
  | { ok: false; reason: 'compile-error' | 'needs-restart' | 'not-attached' | 'unsupported'; message: string };

export interface AppConnector {
  readonly id: string;                                   // 'dart'
  start(): Promise<void>;                                // e.g. connect to DTD
  listApps(): Promise<RunningApp[]>;
  onAppsChanged(cb: (apps: RunningApp[]) => void): () => void;
  attach(appId: string): Promise<AppSession>;
}

export interface AppSession {
  readonly app: RunningApp;
  reload(): Promise<ReloadResult>;
  restart(): Promise<ReloadResult>;
  logs(): LogSource;
  db(): DbInspector | undefined;
  detach(): Promise<void>;                               // never kills the app
  on(event: 'reloaded' | 'exit' | 'error', cb: (e: unknown) => void): () => void;
}

// LogSource, DbInspector, TaskProvider
export type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export interface LogEntry { ts: number; level: LogLevel; source: 'app' | 'framework' | 'native' | 'tool'; tag?: string; message: string; stack?: string }
export interface LogQuery { since?: number; minLevel?: LogLevel; text?: string; regex?: string; tag?: string; limit?: number }
export interface LogSource {
  query(q: LogQuery): Promise<LogEntry[]>;
  subscribe(cb: (e: LogEntry) => void): () => void;
  clear(): void;
}

export interface TableInfo { name: string; columns: { name: string; type: string; nullable: boolean; pk: boolean }[]; rowCount?: number; foreignKeys: { from: string; table: string; to: string }[] }
export interface QueryResult { columns: string[]; rows: unknown[][]; truncated: boolean; durationMs: number }
export interface DbInspector {
  readonly id: string;           // 'drift' | 'sqlite-file' | later 'room'
  readonly live: boolean;
  readonly writable: boolean;
  listDatabases(): Promise<{ name: string }[]>;
  schema(db: string): Promise<TableInfo[]>;
  query(db: string, sql: string, params?: unknown[], opts?: { limit?: number }): Promise<QueryResult>;
  execute?(db: string, sql: string, params?: unknown[]): Promise<{ changes: number }>;
  watch?(db: string, table: string, cb: () => void): () => void;
}

export interface Task {
  id: string; key: string; title: string; description?: string; url: string;
  status: string; statusType: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
  priority?: number; labels: string[]; branchName?: string;
}
export interface TaskProvider {
  readonly id: string;
  isConfigured(): Promise<boolean>;
  myTasks(filter?: { statusTypes?: Task['statusType'][] }): Promise<Task[]>;
  getTask(idOrKey: string): Promise<Task>;
  setStatus?(idOrKey: string, statusType: Task['statusType']): Promise<void>;
}
```

Rules:

- Connectors, inspectors and providers register through a registry in `core`. No `if (framework === 'flutter')` outside their packages.
- Unsupported features return `unsupported` or omit optional methods. The UI hides what isn't available.
- `detach()` must never stop the user's app.
- Every implementation ships a fake for tests and dashboard development.

## Connecting to Flutter apps

The daemon attaches to apps that are already running; it never launches or stops them. Users keep starting apps from Android Studio, VS Code, `flutter run`, or the Dart MCP server's launch tool, and keep their debugger.

**Finding apps (`connector-dart`)**

- Connect to the Dart Tooling Daemon (DTD), which IDEs start and which tracks running Flutter apps and their VM service URIs. Subscribe to its connected-app events so the dashboard updates when apps start or stop.
- Getting the DTD URI: auto-detect where possible; otherwise accept it from the IDE's “copy DTD URI” command or from `flutter run` output (check the exact flag in the current Flutter CLI). Store it per session.
- Fallback: let the user paste a VM service URI directly.
- Verify all DTD method and stream names against the current `dtd` package and Dart MCP server source before coding. Record real sessions as test fixtures.

**Reload and restart**

- Call the reload and restart services the Flutter tool registers on the app's VM service (the same ones IDEs and DevTools call). This keeps the Flutter tool in charge of recompiling, so results match what the IDE does.
- Map results to `ReloadResult`. If the reload can't apply a change (edits to `main()`, enums, static initialisers), return `needs-restart`.
- Claude itself uses the Dart MCP server's `hot_reload` and `hot_restart` tools, not FlutterDeck's. The dashboard buttons exist for the human.
- Optional: run `dart run build_runner build` before reload when generated files are stale (config `codegen: auto | off`).

**Logs**

- Subscribe to the VM service `Stdout`, `Stderr` and `Logging` streams for app output and `developer.log` entries with levels.
- Android native logs via `adb logcat -v threadtime -v epoch --pid=<pid>` (`logs-android`; plain threadtime below API 24, read from `getprop ro.build.version.sdk`). The PID comes from the VM service (`getVM`), since the connector rarely knows the applicationId; the device is the one whose `ps -o NAME= -p <pid>` names the app (first plausible match if ambiguous). A full restart is a new app, so the PID is re-read on attach. adb is taken from `ANDROID_HOME`/`ANDROID_SDK_ROOT`, Android Studio's default SDK, then the PATH.
- Ring buffer per app (default 20,000 entries); group repeated exceptions by first stack frame.

**Drift: two backends**

1. **Live (preferred), `flutterdeck_drift`.** One line in the app's debug startup:

   ```dart
   if (kDebugMode) FlutterDeckDrift.register(db, name: 'app');
   ```

   It registers VM service extensions (`ext.flutterdeck.drift.schema`, `.query`, `.execute`, `.watch`) using `dart:developer`, runs queries through Drift's `customSelect` / `customStatement`, and forwards table-change events with `postEvent`. It does nothing in release builds.
2. **Snapshot fallback, `db-sqlite`.** No setup, Android only: copy the DB (plus `-wal` and `-shm`) with `adb exec-out run-as <applicationId> cat databases/<file>` and open it read-only with `sql.js`. Show a “Snapshot from 14:02, refresh” banner.

Before finalising the live backend, check how the Drift DevTools extension talks to the app; reusing its mechanism could remove the need for the extra package.

## MCP tools

Claude gets two MCP servers, and each tool lives in exactly one of them. `flutterdeck init` configures both.

**From the official Dart MCP server (reused, not built):** hot reload, hot restart, runtime errors, connecting to DTD, and the other Dart and Flutter tools it offers. Check its current tool list when writing the slash commands.

**From FlutterDeck's MCP server (built):** only what the official one doesn't cover. It is a thin stdio process that forwards calls to the daemon.

| Tool | Input | Returns | Notes |
| --- | --- | --- | --- |
| `deck_status` | — | attached app, DB backends, task provider, dashboard URL | Claude calls this first |
| `get_logs` | `since?`, `minLevel?`, `text?`, `regex?`, `tag?`, `limit?` (default 200) | `LogEntry[]` | Includes Android logcat, which the Dart server doesn't read |
| `db_list` | — | databases, backend, live flag |  |
| `db_schema` | `db` | `TableInfo[]` |  |
| `db_query` | `db`, `sql`, `params?`, `limit?` (default 100) | `QueryResult` | Read-only statements only |
| `db_execute` | `db`, `sql`, `params?` | changes | Only when writes are enabled; otherwise a clear refusal |
| `db_snapshot` / `db_diff` | `db`, `label?` | snapshot id / rows added, changed, removed | Lets Claude verify what an action changed |
| `tasks_mine` | `status?` | `Task[]` |  |
| `task_get` | `key` | `Task` |  |
| `task_current` | — | the task selected in the dashboard, or null | Dashboard-to-Claude bridge |
| `task_set_current` | `key` | ok | Keeps the dashboard in sync with `/start` |
| `task_set_status` | `key`, `statusType` | ok |  |

Guidelines:

- Keep outputs small and say when they're truncated, so Claude narrows the query instead of flooding its context.
- Tool descriptions should say when to use them, e.g. “After a hot reload with the Dart MCP server, call db\_diff to check what the action saved.”
- If the daemon isn't running, the MCP server starts it and retries once.
- All inputs are validated with the shared zod schemas.

## Dashboard

The dashboard is a single-page React app the daemon serves at `http://127.0.0.1:<port>` (default 9147; *changed 12 Oct 2026* from 9100, which Dart DevTools uses. If the port is busy, the daemon uses the next free port and records it in `.flutterdeck/runtime.json`). It must work well in a narrow pane (420 px wide), so it uses tabs rather than side-by-side panels.

**Opening it in Claude Desktop:** `flutterdeck init` adds an entry to `.claude/launch.json` so the dashboard opens in the Browser pane. Confirm the exact schema in the Claude Code docs (“Configure preview servers”). It also works in any browser.

**Header bar**

- App picker: running apps found through DTD, with device and how each was started. “No app running” shows a short hint on how to start one.
- Hot reload and hot restart buttons (`r` / `R` keys), plus the last result: green with duration, or red with the first compile error. *Changed 11 Oct 2026:* the Flutter tool's reload service only reports success or failure, so on failure show “Reload failed” plus the most recent error-level log lines.
- Current task chip, linking to the Tasks tab.

**Tabs**

1. **Database** (first tab, the headline feature).
   - Sidebar of databases and tables with row counts.
   - Table view: paginated grid, per-column sort and filter, foreign-key cells link to the referenced row.
   - Schema view: generated diagram of tables and relations.
   - SQL editor: CodeMirror with schema autocomplete, run with Cmd/Ctrl+Enter, saved queries in `.flutterdeck/queries.json`.
   - Live mode: open tables refresh and changed rows flash when the backend supports `watch`.
   - Snapshot diff: snapshot, act in the app, then see rows added, changed and removed per table.
   - Editing off by default; when on, every write shows its SQL and needs a confirm.
   - Export a table or result as CSV or JSON.
2. **Logs.** Live virtualised list; filters by level, source, tag, text/regex; “since last reload” toggle; grouped errors with counts; copy `file:line` from a stack frame.
3. **Tasks.** My Linear issues by status, search, open in Linear, **Work on this**, status changes.
4. **Activity.** Reloads, crashes, and “Claude finished” events from hooks, so you can see what happened while away.

**Notifications.** OS notifications for Claude finished, Claude waiting for input, app crashed, reload failed. Each can be switched off.

**Theme.** Follow `prefers-color-scheme` to match Claude Desktop's light and dark modes.

## Task providers and the Linear handoff

The dashboard can't type into Claude's chat, so the handoff works through shared state: the dashboard sets a current task in the daemon, and Claude reads it with `task_current`. This costs the user one short command and is reliable.

**Flow**

1. User clicks **Work on this** on `ENG-123` in the dashboard (or types `/start ENG-123` in Claude).
2. Daemon stores `currentTask = ENG-123` in `.flutterdeck/state.json`.
3. User types `/start` in Claude. The command tells Claude to call `task_current`, read the issue, create or switch to the issue's branch (`branchName` from Linear, or `<key>-<slug>`), move the issue to In Progress, and plan the work.
4. `/ship` tells Claude to run checks, commit, push and open a PR with `gh pr create` whose title and body include `ENG-123`, so Linear's GitHub integration links the PR and updates the status.

**`tasks-linear` implementation**

- Talk to Linear's GraphQL API at `https://api.linear.app/graphql` directly from the daemon (the dashboard needs data even when no Claude session is open).
- `myTasks`: query `viewer.assignedIssues` filtered by state type, returning identifier, title, description, url, state, priority, labels and `branchName`.
- Auth for v1: a Linear personal API key, stored in the OS keychain (`through the OS credential tool, no native modules`) or `~/.config/flutterdeck/credentials.json` with 0600 permissions. Never in the repo. OAuth can come later.
- Cache results for 60 seconds; a refresh button bypasses the cache.
- Users who already have Linear's official MCP server connected in Claude can still use it alongside; FlutterDeck's task tools exist so the dashboard and `/start` work the same for everyone.

Future providers (Jira, GitHub Issues, ClickUp) implement the same `TaskProvider` interface. Selecting the provider is a config setting.

## Plugin, commands, hooks and init

The Claude Code plugin is the main way users get FlutterDeck. It bundles both MCP server configs, the slash commands and the hooks. Confirm the current plugin layout and marketplace format in the Claude Code docs before building.

```
plugin/
  .claude-plugin/plugin.json   # name, version, description
  .mcp.json                    # "dart": dart mcp-server  +  "flutterdeck": npx flutterdeck mcp
  commands/
    tasks.md                   # /tasks
    start.md                   # /start [KEY]
    check.md                   # /check
    db.md                      # /db <question>
    ship.md                    # /ship
  hooks/hooks.json             # Stop, SubagentStop, Notification → daemon
```

**Slash commands**

| Command | What it tells Claude to do |
| --- | --- |
| `/tasks` | `tasks_mine`, show a short list, ask which to start |
| `/start [KEY]` | Use KEY or `task_current`; read the task; switch to its branch; set status to started; outline a plan |
| `/check` | Hot reload with the Dart MCP server, read runtime errors, then `get_logs` and `db_diff`; fix and repeat if something is wrong |
| `/db <question>` | Answer using `db_schema` and `db_query`, read-only |
| `/ship` | Run `flutter analyze` and tests; commit; push; `gh pr create` referencing the task key |

**Hooks**

- `Stop` and `SubagentStop` send `claude.done` to `POST http://127.0.0.1:<port>/api/events`, with the port read from `.flutterdeck/runtime.json`; `Notification` sends `claude.waiting`.
- Hooks fail silently if the daemon isn't running.

**`flutterdeck init`**

1. Detect the project (`pubspec.yaml` with a `flutter` dependency) and read `applicationId`.
2. Check prerequisites (`dart` 3.9+ for the Dart MCP server, `flutter`, `adb`, `gh`); `flutterdeck doctor` reruns this.
3. Detect Drift; offer to add `flutterdeck_drift` as a dependency and show the one-line register call.
4. Ask for a Linear API key (optional) and store it outside the repo.
5. Write `.flutterdeck/config.json` (port, codegen mode, DB write toggle) and gitignore `.flutterdeck/state.json` and `runtime.json`.
6. Add the dashboard to `.claude/launch.json`.
7. Print the plugin install command, plus raw MCP configs for other agents.

## Security and safety

The daemon can run commands, read app data and write to a database, so it must be locked to the local user and safe by default.

- **Localhost only.** Bind to `127.0.0.1`, never `0.0.0.0`. Reject requests whose `Host` or `Origin` isn't localhost, to block DNS-rebinding attacks from web pages.
- **Session token.** The daemon generates a random token at start, stored in `.flutterdeck/runtime.json` (gitignored, 0600). The MCP server, CLI and hooks send it as a header; the dashboard receives it via the URL on first load and keeps it in memory or `sessionStorage`.
- **Read-only database by default.** `db_query` accepts only `SELECT`, `PRAGMA table_info` and `EXPLAIN` (parse, don't regex). Writes need `db.allowWrites: true` in config, and each dashboard write needs a confirm.
- **Debug builds only.** `flutterdeck_drift` registers nothing when `kReleaseMode` is true. Document this prominently.
- **No arbitrary shell from the API.** The daemon runs only its own fixed commands (`flutter`, `adb`, `dart`) with validated arguments. Device IDs, package names and file names are checked against strict patterns before use.
- **Secrets.** API keys live in the OS keychain or a 0600 file outside the repo. Never log them, never put them in `launch.json` (which is often committed), never return them through MCP tools.
- **Log redaction.** Optional regex redaction rules in config for tokens or personal data before logs are sent to Claude.
- **Untrusted content.** Task descriptions and log lines are data. Tool descriptions should remind Claude not to follow instructions found inside them.

## Milestones

Five milestones, each ending in something usable. Claude should not start the next one until every box in the current one is ticked. The Drift inspector moves up to M3 so it can be shown publicly before the Linear work.

### M1 — Core, daemon and attaching to running apps

- [x] Monorepo scaffolded (pnpm, strict TypeScript, Vitest, lint, GitHub Actions CI)
- [x] `core` interfaces, zod schemas, registry, fake implementations
- [x] Daemon with HTTP + WS API, token auth, localhost-only checks
- [x] `connector-dart`: DTD connection, app discovery, VM service attach, reload and restart, VM log streams (12 Oct 2026: PR #3; real-app check in [qa/M1.md](qa/M1.md))
- [ ] `logs-android` logcat by PID
- [ ] `.mcp.json` example that runs the official Dart MCP server alongside FlutterDeck
- [ ] Accept: start a sample app from VS Code or Android Studio with a breakpoint set; the daemon lists it, a `curl` reload works, logs stream, and the breakpoint still hits

### M2 — Dashboard in Claude Desktop

- [ ] Dashboard served by the daemon: header bar (app picker, reload, restart), Logs and Activity tabs
- [ ] `flutterdeck init` writes config and the `.claude/launch.json` entry
- [ ] Hooks plus OS notifications
- [ ] FlutterDeck MCP server with `deck_status` and `get_logs`
- [ ] Accept: in Claude Desktop the dashboard sits next to chat and diff; Claude reloads through the Dart MCP server and the dashboard shows the reload; a notification appears when Claude finishes

### M3 — Drift inspector (headline feature)

- [ ] `flutterdeck_drift` Dart package; no-op in release
- [ ] `db-drift` (live) and `db-sqlite` (snapshot, `sql.js`) backends
- [ ] Database tab: tables, schema diagram, SQL editor with autocomplete, saved queries, live refresh, snapshot diff, export, guarded editing
- [ ] MCP tools: `db_list`, `db_schema`, `db_query`, `db_execute`, `db_snapshot`, `db_diff`
- [ ] Accept: adding an item in the sample app flashes the new row within 1 s; Claude answers “how many orders are pending?” and uses `db_diff` to confirm what a change saved
- [ ] **Validation checkpoint:** publish a 60-second demo and an early install guide; gather feedback from Flutter developers before M4

### M4 — Linear tasks

- [ ] `tasks-linear` provider with key stored outside the repo
- [ ] Tasks tab, current task chip, `task_*` MCP tools
- [ ] `/tasks`, `/start`, `/check`, `/db`, `/ship` commands
- [ ] Accept: click Work on this, type `/start`, and Claude is on the right branch with the issue In Progress; `/ship` opens a PR Linear links to the issue

### M5 — Packaging and public release

- [ ] Claude Code plugin and marketplace entry; npm release of the CLI; pub.dev release of `flutterdeck_drift`
- [ ] `flutterdeck doctor`; smoke tests on Windows, macOS and Linux
- [ ] README with demo GIF, `ADAPTERS.md`, `CONTRIBUTING.md`, licence
- [ ] Accept: a fresh machine with Flutter installed reaches a working dashboard in under five minutes using only the README

## Risks, open decisions and future adapters

The remaining risks are known and each has a mitigation; the open decisions don't block M1–M2.

| Risk | Mitigation |
| --- | --- |
| Small audience (Flutter + Claude Code + Drift) | Validation checkpoint after M3; Linear and Drift stay optional |
| Claude Desktop changes panes or plugins | Dashboard is a normal web page that also runs in any browser |
| DTD or VM service details change | Isolate them in `connector-dart`; recorded fixtures catch breakage early |
| Inspector needs an in-app package | No-setup snapshot mode on Android |
| Too much for one maintainer | Five small milestones; Compose and web left to contributors |

**Open decisions**

- [ ] **Project name.** Check npm, pub.dev and GitHub availability (before M5). 9 Oct 2026: npm packages use the `@project-deck/*` scope; the product name, CLI binary and `.flutterdeck/` folder are still open.
- [ ] **Live Drift mechanism.** Own `flutterdeck_drift` package vs. reusing the Drift DevTools extension's hooks (before M3).
- [x] **DTD URI discovery.** How much can be auto-detected vs. pasted by the user (during M1). Decided 11 Oct 2026 (research in [notes/dtd.md](notes/dtd.md)): scan Dart 3.12+ DTD pid files, fall back to `dart tooling-daemon --list --machine`, then a user-pasted DTD URI, then a user-pasted VM service URI.
- [ ] **Also ship the inspector as a DevTools extension?** Would reach developers who don't use Claude (after M5).
- [ ] **Device mirroring.** Embedded scrcpy view vs. a docked window (after M5).
- [x] **Licence.** MIT vs. Apache-2.0 (before M5). Decided 9 Oct 2026: MIT.

**Future adapters** (after v1, ideally with contributors):

| Adapter | Attach and reload | Logs | Database |
| --- | --- | --- | --- |
| Jetpack Compose | Find the app with adb; reload means rebuild and reinstall (no true hot reload outside Android Studio) | Reuse `logs-android` | Room via the snapshot backend, or a small debug library like `flutterdeck_drift` |
| Web (Vite, Next.js) | Attach to the running dev server; HMR is automatic | Dev server output + browser console | SQLite file, Postgres via connection string |
| Jira, GitHub Issues | — | — | New `TaskProvider` implementations |
