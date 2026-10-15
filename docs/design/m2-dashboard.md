# M2 — Dashboard in Claude Desktop — design note

Date: 2026-10-14 — Size: large — new UI, new browser trust boundary (dashboard login), new MCP server, Claude Code hooks, new commands the daemon runs (OS notifications), app logs that may hold personal data sent to Claude — Phase: MVP — Status: approved by PM 14 Oct 2026

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
  - Header: app picker (name, device, how started), Reload and Restart (shortcuts `r` / `R`, which can be switched off) with the last result (green with duration, or red "Reload failed" plus the latest error log lines), connection state.
  - Logs tab: live list (virtualised), filters for level, source (app / native), tag, text, "since last reload", clear, pause.
  - Activity tab: reloads (from the dashboard, Claude or the IDE when visible), app exit, Claude finished, Claude waiting.
  - MCP server (stdio, thin client of the daemon): `deck_status`, `get_logs`. Starts the daemon when it starts (see "Design details"), and again on a call if the daemon is gone, then retries once.
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

PM decisions, 14 Oct 2026: D1 A (cookie the page can't read, [ADR 0001](../adr/0001-dashboard-login-cookie.md)), D2 A (fixed port per project, [ADR 0002](../adr/0002-fixed-dashboard-port.md)), D3 A (three fixed notifier commands), D4 A (mask by default; documented as the developer's own processing).

## Design details (after the design review, 14 Oct 2026)

These make the chosen options safe. They don't change the PM's choices.

**D1 — cookie login**

- The cookie carries a separate random **session secret** made at daemon start, never the `runtime.json` token. The token stays for the MCP server, CLI and hooks (header only).
- The cookie name includes the port: `deck_session_<port>`. Browsers don't separate cookies by port, so this stops two FlutterDeck daemons (or any other server on 127.0.0.1) from overwriting each other's cookie. The daemon only reads its own name.
- A request authenticated by the cookie must also have `Sec-Fetch-Site: same-origin` (or no fetch metadata) and, when present, the exact Origin. This blocks pages on other 127.0.0.1 ports, which browsers treat as the same site.
- The cookie is set only on `GET /` as a top-level navigation (`Sec-Fetch-Site: none` or `same-origin`, `Sec-Fetch-Mode: navigate`, or no fetch metadata).
- No `GET` route has a side effect.
- Login window (PM decision 14 Oct 2026, [ADR 0003](../adr/0003-dashboard-login-window.md)): the cookie is handed out only during a 2-minute window opened at daemon start or by `POST /api/login-window` (token header only), which the MCP server calls when it starts and `flutterdeck open` calls. Outside the window `GET /` shows "Login needed: run `flutterdeck open`". This closes the gap where another OS user on the same machine could load `/` and get the cookie.
- Session expiry: the secret changes when the daemon restarts. Browsers don't show the status of a refused WebSocket handshake, so when the WebSocket fails the dashboard calls `GET /api/status`. A 401 there means the cookie is old: the dashboard reloads the page once (guarded by a flag in `sessionStorage`) to get a new cookie; if that also fails, it shows "Login refused". A connection error means the daemon is down: the normal retry banner. The flag is cleared after the first successful authenticated response, so the next restart in the same tab also recovers. Tests: a daemon restart while the dashboard is open, twice in one tab.
- Headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API JSON, `Content-Security-Policy: default-src 'self'; connect-src 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`.
- Tests: two daemons on two ports with both dashboards open; a page on another 127.0.0.1 port; a daemon restart while the dashboard is open; a cookie from the wrong port.

**D2 — fixed port per project**

- `init` picks the port from a per-user registry `~/.flutterdeck/ports.json` (project path → port, plus a random per-user salt; 0600), so two projects never get the same port, even when neither daemon is running. 9147 for the first project, then the next free unregistered port. The daemon also checks the registry when it starts, under a lock file next to `ports.json`. It first drops entries whose project folder no longer exists (moved, renamed or deleted). If the port in a committed `config.json` is registered to another existing project (for example a second clone or worktree) and the port is free, the daemon starts anyway, leaves the other project's registration alone, and warns on stderr: "Port <port> is also registered to another project (project <id>); if both run at once one will fail. Run `flutterdeck init` to pick a new port." If the port is busy, the health-probe messages below apply. _Changed 14 Oct 2026 after the review (lead decision, finding C1): the daemon used to refuse to start in this case, which blocked every second checkout._
- `/api/health` (no auth) returns a project id: the first 12 hex characters of SHA-256 of the per-user salt plus the project path, so the id doesn't reveal the path or the user name. The MCP server and `flutterdeck start` compare it with their own project and report "Another project's FlutterDeck is on this port" if it differs. The dashboard can't make this check (it is served by whichever daemon holds the port), so its header always shows the project folder name.
- If the port is busy at start, the daemon calls `GET /api/health` on it. It reports "Another FlutterDeck (project <id>) uses port <port>" or "Another program uses port <port>", with how to change the port. It never runs a process lookup command.
- Start: the MCP server starts the daemon **as soon as it starts** (non-blocking), so the dashboard is up when the pane opens. It also starts it on a tool call if the daemon has gone, then retries once. Spawn: fixed `node <cli> start` command, `detached: true`, `windowsHide: true`, `stdio: 'ignore'`, `unref()`, an `'error'` listener. The startup lock (M1) stops a second daemon.
- _Changed 15 Oct 2026 after the batch 3 reviews (lead):_ the MCP server starts or contacts a daemon only when `.flutterdeck/config.json` exists (the folder ran `flutterdeck init`); elsewhere both tools answer "FlutterDeck isn't set up in this folder. Run `flutterdeck init` first." and nothing is written. The spawn is `node <daemon package>/dist/main.js --project <dir>`, resolved through the daemon package's `./main` export without loading daemon code. _Decided 15 Oct 2026 (batch 4):_ it stays that way, and `flutterdeck start` uses the same spawn; switching the MCP server to the CLI's `start` would make the MCP package depend on the CLI, which depends on it (a cycle). The spawned daemon writes its own start-up messages (never log lines or tokens) to `.flutterdeck/daemon.log` (0600, truncated at each start, gitignored by `init`), and a failed start reports its last line to Claude.
- _Changed 15 Oct 2026 in batch 4:_ both the MCP server and `flutterdeck start` spawn `packages/daemon/dist/main.js --project <dir>` (see above). `init` checks `dart`, `flutter` and `adb`; `gh` is checked from M4, where `/ship` uses it (lead decision, 15 Oct 2026). The `.mcp.json` snippet `init` prints runs `node <repo>/packages/cli/dist/main.js mcp`. The `launch.json` entry is `{ "name": "FlutterDeck", "url": "http://127.0.0.1:<port>", "port": <port> }`: the docs say a localhost `url` must match the entry's `port`, and `port` defaults to 3000 when it is left out. `flutterdeck open` prints the address by default (in Claude Desktop the dashboard opens in the Browser pane); `--browser` also opens the default browser.
- The daemon keeps running after Claude exits; `flutterdeck stop` stops it. If `/api/health` reports an older version than the MCP server, the MCP server says so in `deck_status` and in the tool error, and suggests `flutterdeck stop`.

**D3 — notifier commands**

- Absolute paths, `shell: false`, an `'error'` listener, 5 s timeout:
  - macOS: `/usr/bin/osascript -e <fixed script>`, title and text passed as arguments after the script and read with `on run argv`.
  - Linux: `notify-send` found once in `/usr/bin` or `/usr/local/bin` only (never the project folder), `--` before the title and text, and `<`, `>`, `&` escaped (some notification servers render markup). Missing binary: skip quietly, note once in stderr.
  - Windows: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <fixed script>`. Title and text go **only in environment variables** (`DECK_NOTIFY_TITLE`, `DECK_NOTIFY_TEXT`), never in arguments, because arguments after `-Command` become script text. The fixed script builds the toast from the `ToastText02` template and adds the text only as XML text nodes (`CreateTextNode($env:DECK_NOTIFY_TEXT)`), never by putting it into an XML string, so the text can't add buttons or actions. Test payload: `</text></binding></visual><actions><action activationType="protocol" arguments="https://x"/></actions>` must show as literal text.
- Text: control characters removed, title ≤ 64 characters, text ≤ 200.
- Rate limit: at most one notification per kind per 30 s; extra events are counted in the next one ("Reload failed (3 times)").
- "App crashed" means the app's VM service went away without a detach or stop from FlutterDeck **and** an error-level log line arrived in the 5 s before. Any other exit is "App stopped", shown in Activity only, with no OS notification.
- Tests per OS path with quote, backtick, `$()`, `;`, newline, a leading `-` and markup payloads; the Windows test checks that no payload reaches the arguments.
- _Built 15 Oct 2026 in batch 5 (developer):_ the title is "FlutterDeck" and the text is the UI spec copy ("App crashed — <app>" (lead decision 15 Oct 2026; the UI spec said "App stopped"), "Reload failed — <app>", "Claude is waiting — <first 100 characters>"), with "(N times)" after the first part. The notifications are built from Activity entries, so the crash rule and the reload merge apply. A reload that never ran (`not-attached`, `unsupported`) is not "reload failed". A failed reload by Claude with no app attached shows in Activity only, without a notification. Held events count in the next notification only if it comes within two rate windows (60 s); later, the count starts again. macOS passes `--` before the title and text (osascript drops it and hands the rest to `on run argv`). The Windows toast uses PowerShell's own app id, because Windows shows toasts only for a registered app; it is untested on Windows so far. Only `main.js` passes the system notifier, so tests and other embedders never run a notifier command.

**D4 — masking for Claude**

- Masking runs in **one place: the MCP server's output layer**, for every FlutterDeck tool (`deck_status` too, because the last reload result includes error lines), before truncation. Nothing else leaves the machine.
- Masked values are replaced by a marker that says so, for example `[email masked]`, `[token masked]`.
- It is **best-effort pattern matching** of common patterns (emails, phone-like numbers, bearer tokens, JWT-shaped and long secret-like strings). It does not find names, addresses, IDs or free text. We say exactly this in the tool descriptions, the README and the dashboard settings, and never call it "private" or "safe".
- Claude can still see unmasked text through the Dart MCP server's `get_runtime_errors`. FlutterDeck can't change that; the README says so.
- User regex rules from config: at most 20 rules, each ≤ 200 characters, nested quantifiers rejected, each text cut to 4 kB before the user rules run, and a time budget of 200 ms per tool call for all user rules, enforced by running the user rules in a `worker_threads` Worker that is terminated when the budget runs out (a JavaScript regex can't be interrupted inside one match); when it runs out, the remaining user rules are skipped and the output says "Some masking rules were skipped (too slow)". The built-in patterns always run, on the first 64 kB of each text and before the 4 kB cut, so a value across the cut is still masked; the cut never splits a marker. _Changed 14 Oct 2026 after the tester's report (T3): the text used to be cut before any pattern ran._ Test: a catastrophic pattern such as `(a|a)*b` on a 4 kB line returns within the budget with the "skipped" note.
- VM service and DTD URIs: a path segment of padded base64 is an auth code on any host. _Changed 15 Oct 2026 (review N2, lead decision R6):_ on a loopback host with a port (any of `127.0.0.0/8`, `0.0.0.0`, `localhost` with or without a trailing dot, `[::1]` in short or full form, or `[::ffff:127.x.x.x]`; case doesn't matter), the first path segment is also an auth code when it has exactly the shape of an unpadded code: 11 base64url characters (8 random bytes, as the VM service, DDS and DTD all make them, see [notes/dtd.md](../notes/dtd.md#auth-codes)), a last character that 8 bytes can end in, and mixed case or a digit. So an 11-character random code is masked, and `/api/status`, `/devtools/`, `/healthcheck`, `/getUserProfile` and `/flutter_service_worker.js` are not. Known over-mask, accepted by the lead as failing closed: an 11-character route with mixed case or a digit, such as `/iPhone15Pro`. The rule is `isUnpaddedCode` in `packages/mcp/src/mask/builtins.ts`. A URI is decoded up to 3 times; a bare encoded URI whose `://` is encoded more times than that is masked whole without being read (fails closed, I3-1).
- If `logs.redact` is `false` (for example in a config committed to the repo), the daemon, `init` and `deck_status` say "Masking for Claude is off".

**Dashboard**

- WebSocket heartbeat: the server sends a WebSocket ping every 15 s and closes a socket with no pong in 10 s (finds dead clients). It also sends a `{"type":"heartbeat"}` message every 15 s, because browser code can't see pings. The client resets its timer on any message and reconnects if nothing arrives for 30 s. Test with fake timers and no log traffic: no reconnect.
- Single-key shortcuts `r` / `R` can be switched off in the dashboard (kept per browser in `localStorage`), as WCAG 2.2 SC 2.1.4 requires.

**Seeing reloads from Claude or the IDE**

- The acceptance check needs the dashboard to show a reload that Claude made through the Dart MCP server. The developer must confirm which VM service event marks it (expected: an `IsolateReload` event on the `Isolate` stream) against the current VM service protocol, and record a fixture from a real `hot_reload` call by the Dart MCP server in batch 1.

- QA recorded real traffic on 14 Oct 2026 (`packages/connector-dart/src/testing/fixtures/isolate-reload.recorded.json`, [qa/M2.md](../qa/M2.md)): a successful reload by someone else posts `IsolateReload` with `status: "success"`; a reload that fails to compile posts **no** event; a reload the VM rejects (for example an enum changed to a class) also posts `status: "success"`; a hot restart posts no `IsolateReload` but `IsolateExit`, `IsolateStart` and `IsolateRunnable` in a new isolate group.
- _Built 15 Oct 2026 in batch 5 (developer):_ the Dart MCP server answers a failed reload with an MCP error result, which Claude Code reports as **`PostToolUseFailure`**, not `PostToolUse`, so the plugin hooks both ([notes/claude-code-plugin.md](../notes/claude-code-plugin.md)). The hook sends `claude.reload` (`ok`, `hot-reload` or `hot-restart`, and for a failure the tool's error cut to 300 characters with addresses and absolute paths replaced). The daemon makes a `claude.reload` Activity entry with the attached app. _Changed 15 Oct 2026 (lead decision, tester findings T-P5-6/7):_ a **failed** hook result replaces a VM "success" of the same kind only if that VM event came within the 3 s **before** it (the VM-rejection case), under the same id; otherwise it is its own "Reload failed" entry, and it never hides a later VM event (a compile failure posts none, so a later one is another reload). A **successful** hook result is a duplicate of a VM "success" of the same kind within the 3 s before it and adds nothing (that row already reads "from Claude or the IDE"); otherwise it is its own entry, and the next VM "success" of the same kind within 3 s after it is dropped as a duplicate. A successful hook result never replaces an earlier row, and each VM row pairs with one hook result at most. _Changed 15 Oct 2026 (lead decision, review C1 and QA F-B5-2):_ the header result chip shows each `claude.reload` result too: "Reload failed" or "Restart failed" with its message, or "Reloaded (from Claude or the IDE)". The Activity row reads "Reloaded (from Claude or the IDE)", "Reload failed: <message>" or "Restart failed: <message>".
- Lead decision, 14 Oct 2026: the VM events are used for **successful** reloads and for hot restarts by others (Activity "Reloaded (from Claude or the IDE)", "Restarted (from Claude or the IDE)"). Failed reloads made **by Claude** come from a Claude Code `PostToolUse` hook on the Dart MCP server's `hot_reload` and `hot_restart` tools (batch 5), which knows whether the tool returned an error; a hook result within 3 s of a VM "success" for the same reload replaces it. Failed reloads started from the IDE are not shown; the README says so.

## Failure plan

- Dashboard ↔ daemon WebSocket: heartbeat (15 s ping and heartbeat message, 10 s pong timeout; client reconnects after 30 s with no message); reconnect with backoff (0.5 s, 1 s, 2 s, max 5 s, jitter); banner "Lost connection to FlutterDeck — retrying"; on reconnect, re-read state and the last 500 log lines (the `hello` message plus `GET /api/logs`), de-duplicated by id/timestamp.
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
  - As a crafted notification text I inject AppleScript/PowerShell — mitigation (D3 A): see "Design details" — fixed scripts, absolute paths, Windows data in environment variables only, `--` and markup escaping on Linux, length limits, tests with injection payloads.
  - As a page on another 127.0.0.1 port (another dev server) I send requests that carry the dashboard cookie — mitigation: per-port cookie name, a separate session secret (not the token), `Sec-Fetch-Site: same-origin` and exact Origin required for cookie-authenticated requests, no `GET` with side effects.
  - As a second FlutterDeck daemon I overwrite the first one's cookie — mitigation: per-port cookie name; test with two daemons.
  - As a cloned repo I commit a `.flutterdeck/config.json` or `.claude/launch.json` that turns masking off, adds a slow regex, or points the pane at another port — mitigation: masking-off notice, regex limits, project id check on `/api/health`.
  - As a cloned repo I put a `powershell.exe` or `notify-send` in the project folder so the daemon runs it — mitigation: absolute binary paths only.
  - As a crashing app I flood the notification centre — mitigation: one notification per kind per 30 s.
  - As a local program I listen on the configured port while the daemon is down, so the pane loads my page — accepted: same-user local programs are outside the threat model (as in M1); the dashboard header shows the project name, so a page for the wrong project is visible.
  - As a local user I read `runtime.json` — accepted, same as M1 (0600, same user only).
- The reviewer checks against this list.

## Privacy

Not legal advice. The PM decided D4 on 14 Oct 2026.

| Field                                                | Purpose                                                              | Lawful basis                                                                                                                                                             | Retention                                                                                    | Shared with                                                                         | Notes                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| App log lines (may contain end users' personal data) | Show the developer what the app does; let Claude debug               | PM decision 14 Oct 2026 (D4): the developer's own processing, documented in the README. FlutterDeck is a local tool; the developer decides what their debug logs contain | In memory only, ring buffer (existing cap), gone when the daemon stops or "Clear" is pressed | Claude (Anthropic) only when Claude calls `get_logs` or `deck_status`; nowhere else | Best-effort masking in the MCP output layer (D4); never written to disk; never in daemon stderr |
| Hook "waiting" message text                          | Show "Claude is waiting: <message>" in Activity and the notification | n/a — it's the developer's own session text, kept locally                                                                                                                | In memory, activity ring buffer (500)                                                        | OS notification centre (D3 A), local only                                           | `Stop`'s `last_assistant_message` is never sent to the daemon                                   |
| Session id from hooks                                | Group Activity entries per Claude session                            | n/a — local, not personal                                                                                                                                                | In memory                                                                                    | none                                                                                | Optional field                                                                                  |

- Fields removed: `last_assistant_message`, `transcript_path`, `cwd` from hook payloads (not needed).
- DPIA screening: none of the ICO triggers apply to FlutterDeck itself (no profiling, no new tech on end users, local only). The developer's own app may need one; out of our scope. — not needed because FlutterDeck stores nothing and only forwards on the developer's request.
- Children likely: no (developer tool).
- Automated decisions or profiling: none.
- Special category data: none collected; could appear in app logs → reduced by best-effort masking (D4) and kept in memory only.
- New vendors / SDKs / transfers: none new. Logs reaching Claude go through the developer's existing Claude account (their contract with Anthropic).
- Private defaults: best-effort masking on (D4 A); notifications show no log content, only "App crashed" / "Reload failed" / the waiting message.
- Export, delete, rectify: Clear button and `DELETE /api/logs` (exists); stopping the daemon deletes everything; nothing to export or rectify.
- Marketing consent: n/a.
- Record of processing and privacy notice updates: README "Privacy" section (M5) says what FlutterDeck keeps and sends.
- Escalated to PM: how to treat logs sent to Claude, and D4 — both decided 14 Oct 2026.

## Rollout and rollback

Small batches, one branch each, in this order (each goes through developer → tester → reviewer → QA → merge):

1. `feat/dashboard-auth` — config file, port registry and project id (D2), cookie login with session secret (D1), WS heartbeat, activity feed and reload events in the daemon (with a recorded `hot_reload` fixture), security headers. Daemon only.
2. `feat/dashboard` — `packages/dashboard` (Vite + React + Tailwind): header, Logs, Activity; served by the daemon; Playwright tests against `--fake`.
3. `feat/mcp` — `packages/mcp`: `deck_status`, `get_logs` (with D4), start-and-retry.
4. `feat/cli` — `packages/cli`: `init`, `start`, `stop`, `mcp`; writes `launch.json`.
5. `feat/plugin-hooks` — `plugin/.claude-plugin/plugin.json`, `.mcp.json` with `flutterdeck`, `hooks/hooks.json` + event script; notifications (D3).
6. M2 acceptance — QA in Claude Desktop, then the PM check.

Rollback: each batch is one merge commit; revert it. `init` only adds files and lines and prints what it changed; `flutterdeck init --undo` is a Later line. Confirm a rollback by `pnpm check` and the M1 QA scripts still passing.

## Later lines

- `flutterdeck init --undo` — `init` edits `.gitignore` and `launch.json`, and undoing by hand is error-prone — trigger: 3 user reports of needing to undo `init` — noted 2026-10-14 by lead
- Log search across daemon restarts (persisted logs) — today logs are memory only — trigger: 3 user requests for logs after restarting the daemon — noted 2026-10-14 by lead
- Dashboard for several projects at once — one daemon per project today — trigger: 3 user requests to see two projects in one pane — noted 2026-10-14 by lead
