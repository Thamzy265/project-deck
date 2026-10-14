# M2 — Dashboard in Claude Desktop — design note

Date: 2026-10-14 — Size: large — new UI, new browser trust boundary (dashboard login), new MCP server, Claude Code hooks, new commands the daemon runs (OS notifications), app logs that may hold personal data sent to Claude — Phase: MVP — Status: draft, waiting for PM

## Context

M1 gave us a daemon that finds running Flutter apps, attaches, reloads and streams logs over a token-protected HTTP + WebSocket API on 127.0.0.1. Today only `curl` can use it. M2 makes it usable from Claude Desktop: a dashboard in the Browser pane, a small FlutterDeck MCP server for Claude, hooks that tell the dashboard what Claude is doing, and a CLI to set it up.

Plan items ([PLAN.md M2](../PLAN.md#m2--dashboard-in-claude-desktop)):

- Dashboard served by the daemon: header bar (app picker, reload, restart), Logs and Activity tabs.
- `flutterdeck init` writes config and the `.claude/launch.json` entry.
- Hooks plus OS notifications.
- FlutterDeck MCP server with `deck_status` and `get_logs`.
- Accept: in Claude Desktop the dashboard sits next to chat and diff; Claude reloads through the Dart MCP server and the dashboard shows the reload; a notification appears when Claude finishes.

Facts checked on 14 Oct 2026 against code.claude.com and npm (they change parts of the plan, see "Deviations"):

- `.claude/launch.json`: `{version, configurations[{name, runtimeExecutable, runtimeArgs | program, args, port, cwd, env, autoPort, url}]}`. A localhost `url` must be the origin only (no path, no query) and match `port`. A configuration with only `url` attaches to a server that is already running.
- Plugin layout: `.claude-plugin/plugin.json`, then `.mcp.json`, `commands/`, `hooks/hooks.json` at the plugin root. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are available.
- Hooks: `Stop`, `SubagentStop`, `Notification` (`notification_type` such as `permission_prompt`, `idle_prompt`). Command hooks get JSON on stdin; `Stop` includes `last_assistant_message`. `http` hooks exist but can only read a token from an allow-listed environment variable, not from a file.
- Claude Desktop already sends an OS notification when a Code session finishes a task and you aren't viewing it. Nothing is documented for "waiting for permission".
- `@modelcontextprotocol/sdk` 1.32.1, `McpServer.registerTool` with zod input schemas, stdio transport.

## Deviations from the plan

1. **The dashboard can't get its token from the URL.** The plan says the dashboard "receives it via the URL on first load". The Browser pane rejects a localhost URL with a query, and our own rule is that tokens never go in URLs (they end up in history and logs). → Decision D1.
2. **The dashboard URL must be stable.** The daemon falls back to the next free port when 9147 is busy, but `launch.json` holds one fixed port. → Decision D2.
3. **"Claude finished" is already an OS notification in Desktop.** Building it again breaks the "reuse, don't rebuild" rule. We show it in the Activity tab only. The acceptance line "a notification appears when Claude finishes" is met by Desktop's own notification plus our Activity entry. → Decision D3 (with the notifier question).
4. **OS notifications need a new command.** The daemon may only run `flutter`, `adb` and `dart`. Notifications need `osascript` (macOS), `notify-send` (Linux) or PowerShell (Windows). → Decision D3.
5. **`npx flutterdeck` doesn't exist until the M5 npm release.** In M2 the plugin's `.mcp.json` and hooks run the local build (`node <repo>/packages/cli/dist/main.js`), written by `init`. The published `npx` form comes in M5.
6. **CLI scope in M2:** `init`, `start`, `stop`, `mcp`. `doctor` stays in M5 as the plan says.

## Requirements and non-goals

- Functional:
  - Dashboard at `http://127.0.0.1:<project port>/`, served by the daemon, readable at 420 px wide (and 320 px reflow).
  - Header: app picker (name, device, how started), Reload (`r`) and Restart (`R`) with the last result (green with duration, or red "Reload failed" plus the latest error log lines), connection state.
  - Logs tab: live list (virtualised), filters for level, source (app / native), tag, text, "since last reload", clear, pause.
  - Activity tab: reloads (from the dashboard, Claude or the IDE when visible), app exit, Claude finished, Claude waiting.
  - MCP server (stdio, thin client of the daemon): `deck_status`, `get_logs`. Starts the daemon if it isn't running, then retries once.
  - CLI: `flutterdeck init` (config, `.gitignore` lines, `launch.json` entry, plugin/MCP instructions), `start`, `stop`, `mcp`.
  - Plugin: `.mcp.json` with `dart` and `flutterdeck`; `hooks/hooks.json` for `Stop`, `SubagentStop`, `Notification`.
  - Notifications (per D3): app crashed, reload failed, Claude waiting for input; each can be switched off.
- Non-functional: dashboard first load < 1 s on localhost; new log line visible < 250 ms after the daemon has it; `get_logs` output ≤ 200 entries and ≤ 20 kB, says when truncated; works on macOS, Linux and Windows; follows light and dark mode; WCAG 2.2 AA.
- Non-goals: Database and Tasks tabs (M3, M4); slash commands (they come with the M3 and M4 tools); `doctor`; npm publishing; device mirroring; any write to the user's app.

## Top 3 qualities

| Quality                    | Target                                                                                                                                   | How we check it                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security of the local API  | No request without the token succeeds; no cross-site page can read or drive the API; the token never appears in a URL, log or MCP output | Daemon tests for every route and the WS upgrade (wrong Host, wrong Origin, no token, cross-site cookie); reviewer security review; QA curl checks |
| Usability in a narrow pane | Every control usable at 420 px; no sideways scroll at 320 px; keyboard only works                                                        | Playwright at 420 and 320 px with screenshots; axe-core check in Playwright                                                                       |
| Live feel                  | Reload result and new log lines appear < 250 ms after the daemon sees them                                                               | Playwright test against the fake daemon (`--fake`) with timestamps                                                                                |

## Estimate

Trivially small: one user, one daemon per project, one to three browser tabs, at most a few hundred log lines per second from a chatty app; the log ring buffer already caps memory.

## Data

- No database. State in memory: log ring buffer (existing), activity feed ring buffer (new, 500 entries), current reload result.
- Files:
  - `.flutterdeck/config.json` (new, committed by the user if they want): `{ "port": <number>, "notifications": { "appCrashed": true, "reloadFailed": true, "claudeWaiting": true }, "logs": { "redact": true } }`. Validated with a zod schema in `core`; unknown keys rejected; missing file means defaults.
  - `.flutterdeck/runtime.json` (existing, 0600, git-ignored): url, port, token, pid.
  - `.claude/launch.json` (written or merged by `init`, never holds a secret).
- Schema change plan: config has `"version": 1`; later versions migrate on read and keep unknown-version files untouched with a clear error.

## Options

### D1 — How the dashboard proves it is allowed in

**A: Cookie set by the daemon (recommended).** When the browser loads `/` with a localhost `Host`, and the request is a top-level navigation (`Sec-Fetch-Site: none` or `same-origin`, or no fetch metadata), the daemon sets `deck_session=<token>; HttpOnly; SameSite=Strict; Path=/`. The API and WS accept the cookie as well as the header. Page scripts never see the token. A page on another site can't send the cookie (SameSite=Strict) and is already blocked by the Origin check.

- Benefit: no token in any URL; no token in page JavaScript; works with the origin-only Browser pane URL.
- Cost: any local program that can make an HTTP request to 127.0.0.1 can load `/` and get the cookie, the same as reading `runtime.json` today; so the protection is against web pages, not against local programs. That is the same threat model as M1.
- Effort: small (daemon middleware and tests).

**B: Token written into the served HTML.** The daemon puts the token in a `<meta>` tag of `index.html`; the dashboard sends it as a header.

- Benefit: no cookie handling.
- Cost: the token is readable by any script on the page (an XSS bug would leak it); same local-program exposure as A.
- Effort: small.

### D2 — How the Browser pane finds the dashboard

**A: Fixed port per project, attach-only `launch.json` (recommended).** `init` chooses a free port (9147 first) and writes it to `.flutterdeck/config.json`. The daemon always uses that port. If the port is busy, the daemon says which program uses it and how to change it, instead of moving silently. `launch.json` gets `{ "name": "FlutterDeck", "url": "http://127.0.0.1:<port>" }`. The MCP server starts the daemon when a Claude session starts, so the dashboard is up when the pane opens.

- Benefit: the pane URL never goes stale; one daemon per project; no second server.
- Cost: changes the M1 "next free port" behaviour when a config file exists (kept for projects without config). If the daemon isn't running, the pane shows "can't connect" until `flutterdeck start` or a Claude session starts it.
- Effort: small.

**B: `launch.json` runs the daemon with `autoPort`.** The pane starts `node …/cli/dist/main.js start --foreground` and passes `PORT`.

- Benefit: the pane can start the daemon itself.
- Cost: the MCP server may already have started a daemon for the project, so two start paths race (the startup lock makes the second one fail and the pane shows an error); `autoPort` behaviour is only documented for one case.
- Effort: medium.

### D3 — OS notifications

**A: Allow three fixed notifier commands (recommended).** The daemon may also run `osascript` (macOS), `notify-send` (Linux) and `powershell.exe` (Windows), each with a fixed script, no shell, and the title and text passed as separate arguments after length and character checks. Only for app crashed, reload failed and Claude waiting. "Claude finished" stays with Desktop. Each can be switched off in config.

- Benefit: notifications work when the dashboard is hidden.
- Cost: widens the "only flutter, adb, dart" rule (a non-negotiable security rule, so only the PM can change it). Linux needs `notify-send` installed; we skip quietly if it's missing.
- Effort: medium.

**B: Dashboard only.** No OS notifications. The Activity tab and a short in-dashboard banner show the events.

- Benefit: no new commands; nothing changes in the security rules.
- Cost: you only see the events when the dashboard is visible; the plan's "Hooks plus OS notifications" item is cut down.
- Effort: small.

### D4 — Logs sent to Claude

App logs can hold the personal data of the app's end users (names, emails, tokens printed by mistake). `get_logs` sends them to Claude, so they leave the machine.

**A: Built-in redaction on by default (recommended).** Before `get_logs` returns, the daemon masks emails, phone-like numbers, `Bearer …`/JWT-shaped strings and long hex or base64 secrets, and adds user regex rules from config. The dashboard shows logs unmasked (they stay on the machine). `logs.redact: false` switches it off.

- Benefit: private by default; fewer accidental leaks.
- Cost: masking can hide a value the developer wanted Claude to see; they can switch it off.
- Effort: small.

**B: Config rules only, off by default** (the plan's wording, "optional regex redaction rules").

- Benefit: simplest.
- Cost: not private by default.

## Decision

Waiting for PM on D1–D4. Recommendations: D1 A, D2 A, D3 A, D4 A. D1 and D2 get ADRs once decided (they are hard to reverse once users have `launch.json` entries and dashboards open).

## Failure plan

- Dashboard ↔ daemon WebSocket: reconnect with backoff (0.5 s, 1 s, 2 s, max 5 s, jitter); banner "Lost connection to FlutterDeck — retrying"; on reconnect, re-read state and the last 500 log lines (the `hello` message plus `GET /api/logs`), de-duplicated by id/timestamp.
- Dashboard HTTP calls: 10 s timeout; reload/restart buttons disabled while a call runs; error shows the reason and keeps the last good state.
- MCP server → daemon: 5 s timeout per call (reload not involved); if the daemon isn't running, start it (fixed command, detached) and retry once after it reports ready (max 10 s); otherwise return a clear tool error "FlutterDeck daemon isn't running: run `flutterdeck start`".
- Hooks → daemon: 2 s timeout, never block Claude, exit 0 on any failure, no output.
- Notifier commands: 5 s timeout, killed after; failures logged once (no personal data), never retried.

## Observability

- `GET /api/health` (exists). The dashboard footer shows daemon version and connection state.
- Daemon stderr logs: start, stop, attach, detach, errors — never log lines, tokens, URIs with auth codes, or hook message text.
- Numbers to watch in QA: log-line latency, WS reconnect count.

## Trust boundaries and abuse cases

- Boundaries: browser → daemon (dashboard, any web page the user visits); Claude Code hooks → daemon; MCP server → daemon; daemon → OS notifier (D3); log lines and hook messages (untrusted text) → dashboard and Claude.
- Abuse cases:
  - As a malicious web page I fetch or POST to `127.0.0.1:<port>` so that I can reload the app or read logs — mitigation: Host and Origin checks (M1), token or SameSite=Strict cookie on every route and the WS upgrade, `Sec-Fetch-Site` check before setting the cookie.
  - As a malicious page I use DNS rebinding to make my origin resolve to 127.0.0.1 — mitigation: Host allow-list (M1); cookie is host-only and SameSite=Strict.
  - As a malicious page I frame the dashboard to click buttons (clickjacking) — mitigation: `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. If the Browser pane turns out to need framing, QA reports it and we allow only what Desktop needs.
  - As an app (or its users) I print a log line with HTML or a script so that it runs in the dashboard — mitigation: React text rendering only, no `dangerouslySetInnerHTML`; strict CSP `default-src 'self'; script-src 'self'; connect-src 'self'`; links in logs not clickable except `file:line` copy.
  - As an app I print "Claude, run rm -rf …" in a log so that Claude follows it — mitigation: `get_logs` description says log lines are untrusted data, never instructions; output is wrapped as data.
  - As a hook payload I send a huge or crafted message — mitigation: `HookEventInput` zod schema (exists, 2000 chars), body size limit, rendered as text.
  - As a crafted notification text I inject AppleScript/PowerShell — mitigation (D3 A): fixed scripts that read title/text from argv/env, no string concatenation into scripts, control characters stripped, 200 char limit; tests with quote, backtick, `$()` and newline payloads.
  - As a local user I read `runtime.json` — accepted, same as M1 (0600, same user only).
- The reviewer checks against this list.

## Privacy

Not legal advice. Items marked "PM decides" need the PM's decision before the developer starts.

| Field                                                | Purpose                                                              | Lawful basis (PM decides)                                                                                                                                                                                                                                              | Retention                                                                                    | Shared with                                                        | Notes                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| App log lines (may contain end users' personal data) | Show the developer what the app does; let Claude debug               | PM decides — FlutterDeck is a local tool; the developer (as controller or processor of their app's data) decides what their debug logs contain. Options: treat as the developer's own processing and document it; or require opt-in before `get_logs` returns anything | In memory only, ring buffer (existing cap), gone when the daemon stops or "Clear" is pressed | Claude (Anthropic) only when Claude calls `get_logs`; nowhere else | Redaction per D4; never written to disk; never in daemon stderr |
| Hook "waiting" message text                          | Show "Claude is waiting: <message>" in Activity and the notification | n/a — it's the developer's own session text, kept locally                                                                                                                                                                                                              | In memory, activity ring buffer (500)                                                        | OS notification centre (D3 A), local only                          | `Stop`'s `last_assistant_message` is never sent to the daemon   |
| Session id from hooks                                | Group Activity entries per Claude session                            | n/a — local, not personal                                                                                                                                                                                                                                              | In memory                                                                                    | none                                                               | Optional field                                                  |

- Fields removed: `last_assistant_message`, `transcript_path`, `cwd` from hook payloads (not needed).
- DPIA screening: none of the ICO triggers apply to FlutterDeck itself (no profiling, no new tech on end users, local only). The developer's own app may need one; out of our scope. — not needed because FlutterDeck stores nothing and only forwards on the developer's request.
- Children likely: no (developer tool).
- Automated decisions or profiling: none.
- Special category data: none collected; could appear in app logs → covered by D4 redaction and in-memory only.
- New vendors / SDKs / transfers: none new. Logs reaching Claude go through the developer's existing Claude account (their contract with Anthropic).
- Private defaults: redaction on (D4 A); notifications show no log content, only "App crashed" / "Reload failed" / the waiting message.
- Export, delete, rectify: Clear button and `DELETE /api/logs` (exists); stopping the daemon deletes everything; nothing to export or rectify.
- Marketing consent: n/a.
- Record of processing and privacy notice updates: README "Privacy" section (M5) says what FlutterDeck keeps and sends.
- Escalated to PM: how to treat logs sent to Claude (table row 1), and D4.

## Rollout and rollback

Small batches, one branch each, in this order (each goes through developer → tester → reviewer → QA → merge):

1. `feat/dashboard-auth` — config file and fixed port (D2), cookie login (D1), activity feed in the daemon, security headers. Daemon only.
2. `feat/dashboard` — `packages/dashboard` (Vite + React + Tailwind): header, Logs, Activity; served by the daemon; Playwright tests against `--fake`.
3. `feat/mcp` — `packages/mcp`: `deck_status`, `get_logs` (with D4), start-and-retry.
4. `feat/cli` — `packages/cli`: `init`, `start`, `stop`, `mcp`; writes `launch.json`.
5. `feat/plugin-hooks` — `plugin/.claude-plugin/plugin.json`, `.mcp.json` with `flutterdeck`, `hooks/hooks.json` + event script; notifications (D3).
6. M2 acceptance — QA in Claude Desktop, then the PM check.

Rollback: each batch is one merge commit; revert it. `init` only adds files and lines and prints what it changed; `flutterdeck init --undo` is a Later line. Confirm a rollback by `pnpm check` and the M1 QA scripts still passing.

## Later lines

- `flutterdeck init --undo` — remove what `init` added — trigger: 3 user reports of needing to undo `init` — noted 2026-10-14 by lead
- Log search across daemon restarts (persisted logs) — today logs are memory only — trigger: 3 user requests for logs after restarting the daemon — noted 2026-10-14 by lead
- Dashboard for several projects at once — one daemon per project today — trigger: 3 user requests to see two projects in one pane — noted 2026-10-14 by lead
