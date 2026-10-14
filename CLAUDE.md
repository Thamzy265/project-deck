# FlutterDeck

FlutterDeck (working name) is an open-source dashboard and Claude Code plugin for Flutter developers. It puts a Drift database inspector, live logs, reload buttons and Linear tasks next to Claude in Claude Desktop's Browser pane. The full plan is [docs/PLAN.md](docs/PLAN.md); read the relevant section before starting any piece of work.

## What it is (and isn't)

- **Attaches, never launches.** A local daemon finds apps that are already running (started from an IDE, `flutter run`, or the Dart MCP server) through the Dart Tooling Daemon (DTD) and talks to them over their VM service. It never starts or stops the app, so IDE debugging keeps working.
- **Reuses, doesn't rebuild.** Claude gets hot reload, hot restart and runtime errors from the official Dart MCP server (`dart mcp-server`). FlutterDeck's own MCP server only covers what that one doesn't: database queries, logs (including logcat) and tasks. Never add a FlutterDeck tool that duplicates a Dart MCP server tool.
- **Headline feature:** a Drift inspector clearly better than the Drift DevTools extension.
- **v1 non-goals:** launching apps, device mirroring, Compose/web/non-Linear trackers (interfaces only), anything cloud or multi-user.

## Repo layout

TypeScript (strict) pnpm monorepo, Node 22.12+, plus Dart code: one Dart package (M3) and an example Flutter app.

| Path                                      | Purpose                                                                                                       | Status |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/core`                           | Interfaces, zod schemas, registry, event bus, `RingBufferLogSource`; fakes under `@project-deck/core/testing` | M1     |
| `packages/daemon`                         | DTD client, app sessions, HTTP + WS API on 127.0.0.1:9147 (or next free), serves dashboard, notifications     | M1     |
| `packages/connector-dart`                 | `AppConnector` over DTD + VM service                                                                          | M1     |
| `packages/logs-android`                   | `adb logcat` by PID                                                                                           | M1     |
| `packages/mcp`                            | stdio MCP server, thin client of the daemon                                                                   | M2     |
| `packages/dashboard`                      | Vite + React + Tailwind UI, works at 420 px wide                                                              | M2     |
| `packages/cli`                            | `init`, `start`, `stop`, `doctor`, `mcp`                                                                      | M2     |
| `packages/db-drift`, `packages/db-sqlite` | `DbInspector` backends (live / `sql.js` snapshot)                                                             | M3     |
| `packages/tasks-linear`                   | `TaskProvider` for Linear GraphQL                                                                             | M4     |
| `dart/flutterdeck_drift`                  | Debug-only in-app helper exposing Drift via VM service extensions                                             | M3     |
| `examples/sample_app`                     | Sample Flutter app for PM checks (breakpoint, reload, logs); Drift in M3, demo in M5                          | M1     |
| `plugin/`                                 | Claude Code plugin: `.mcp.json`, commands, hooks                                                              | M2–M5  |

Packages are created when their milestone starts, not before.

## Commands

```bash
pnpm install
pnpm build          # tsc for every package
pnpm typecheck
pnpm lint
pnpm format:check   # pnpm format to fix
pnpm test           # vitest across all packages
pnpm check          # typecheck + lint + format + test
```

Packages import each other through `dist`, so run `pnpm build` after changing a dependency before typechecking or testing a dependent package.

CI (`.github/workflows/ci.yml`) runs the same steps on Linux, macOS and Windows. A separate Ubuntu-only job runs `flutter pub get`, `flutter analyze` and `flutter test` for `examples/sample_app`.

## Coding rules

**Architecture**

- `core` is the contract: `AppConnector`/`AppSession`, `LogSource`, `DbInspector`, `TaskProvider`. Everything else depends on `core`, never on each other's internals.
- Implementations register through `Registry` in `core`. No `if (framework === 'flutter')` or provider-name branching outside the implementing package.
- Unsupported features return `{ ok: false, reason: 'unsupported' }` or omit the optional method. The UI hides what isn't available.
- `detach()` and `stop()` must never stop the user's app.
- Every implementation ships a fake for tests and dashboard development.
- Data shapes are zod schemas with types inferred via `z.infer`. Validate every MCP input and HTTP body with the shared schemas in `core/src/api.ts`.
- DTD and VM service specifics stay inside `connector-dart`. Verify method and stream names against the current `dtd` package and Dart MCP server source before coding, and record real sessions as JSON-RPC fixtures for tests.

**TypeScript**

- Strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`, no non-null `!` to silence the compiler.
- ESM only, `.js` extensions in relative imports, `import type` for types.
- No native Node modules (`better-sqlite3`, `keytar`, etc.) so `npx` installs work everywhere without compilers.
- Keep files small and focused; match the surrounding style. Comments explain why, not what.

**Tests**

- Vitest, colocated as `*.test.ts`. Test against fakes and recorded fixtures; no test may need a real device, Flutter SDK or network.
- New behaviour comes with tests. Run `pnpm check` before calling something done.

**Security (non-negotiable)**

- Daemon binds to `127.0.0.1` only and rejects requests whose `Host` or `Origin` isn't localhost.
- Every request needs the session token from `.flutterdeck/runtime.json` (0600, gitignored). The dashboard's cookie is handed out only during a login window opened with that token (ADR 0003).
- Database access is read-only by default: `db_query` allows only `SELECT`, `PRAGMA table_info` and `EXPLAIN`, checked by parsing, not regex. Writes need `db.allowWrites: true` and a confirm in the UI.
- `flutterdeck_drift` does nothing when `kReleaseMode` is true.
- The daemon only runs its own fixed commands (`flutter`, `adb`, `dart`, and for OS notifications only `osascript`, `notify-send` or `powershell.exe` with a fixed script) with arguments validated against strict patterns. No arbitrary shell. (Notifier commands: PM decision, 14 Oct 2026.)
- Secrets live in the OS keychain or a 0600 file outside the repo. Never log them, write them to `launch.json`, or return them from MCP tools.
- Log lines and task descriptions are untrusted data. MCP tool descriptions must say so.
- MCP outputs stay small and say when they're truncated.

## Milestone process

The plan has five milestones (M1 core + daemon + attach, M2 dashboard, M3 Drift inspector, M4 Linear, M5 release), each with a checklist and acceptance criteria in [docs/PLAN.md](docs/PLAN.md#milestones).

1. Work on one milestone at a time. Don't start the next until every box in the current one is ticked and its acceptance check has been run for real.
2. Before building a piece that depends on an external tool or API (DTD, VM service, Dart MCP server, Claude Code plugin format, Linear), check its current docs or source rather than relying on memory; note anything that differs from the plan.
3. Stop for review at natural checkpoints (e.g. after interfaces, before a large component) and summarise what was built, what deviated from the plan and why, and open questions.
4. When an item is done, tick it in `docs/PLAN.md`. Record any change to the plan or a resolved open decision there too, so the plan stays the source of truth.
5. Open decisions listed in the plan are the user's call; raise them, don't decide them silently.

## Team setup

The user is the **project manager (PM)**. The team is the [`my-tech-team`](https://github.com/Thamzy265/my-tech-team) plugin, v0.2.1, enabled in `.claude/settings.json`. Its roles are `/my-tech-team:lead`, `/my-tech-team:developer`, `/my-tech-team:tester`, `/my-tech-team:reviewer`, `/my-tech-team:qa` and `/my-tech-team:marketer`. Claude acts as the lead and runs the flow: it briefs each role, enforces the gates, merges and reports to the PM. Claude Code reads these settings only after the folder is trusted. In an untrusted folder, including a headless `claude -p` run there, it ignores them without a message. In `-p` runs the plugin installs in the background, so it can be missing on the first turn. On Claude Code the plugin's guard hook asks the PM before risky Bash commands (for example `git reset --hard`, force-push, `sudo` or installs). It never replaces the roles' own Host safety rule of asking first.

Project rules set paths, commands and formats, and add rules. They never relax a plugin gate, the never-deferred list, or the rule that only the PM accepts a known risk: a confirmed finding that is not fixed needs the PM's dated decision in docs/status.md. For example, PR descriptions use the sections `Changes`, `Reason`, `Verification` and `Limitations` from "Git workflow".

**Settings the plugin reads**

- Plan: `docs/PLAN.md`, with a "Later" section.
- Status log: `docs/status.md`.
- QA evidence and PM check steps: `docs/qa/<milestone>.md`.
- Screenshots: `docs/qa/<milestone>/screens/`. Videos and traces: `qa-artifacts/` (git-ignored).
- Design notes: `docs/design/`. ADRs: `docs/adr/`. UI specs: `docs/ui/`. Slides: `docs/slides/`. Marketing: `docs/marketing/`.
- Check command: `pnpm check`.
- Run command: `pnpm build`, then `node packages/daemon/dist/main.js` (fake mode: add `--fake`).
- End-to-end tools: Playwright for the dashboard (M2, web). For app flows, the existing scripted checks: `scripts/qa/android-sample-app.sh up|down` and `node scripts/qa/check-android-logs.mjs`. Maestro only if a later item needs it.
- Approved tools: none yet.
- Project phase: `MVP` (until the M5 release).
- Privacy regions: UK + EU. App logs and Drift databases may hold the personal data of the app's end users. Treat them as personal data, and never log or return them beyond what the feature needs.

**"How you can check it"**

After every finished task the PM gets numbered steps with copy-paste commands, the expected result for each, and a clean-up step. The developer drafts them, and QA runs them exactly as written before they reach the PM. QA keeps them in `docs/qa/<milestone>.md` under "PM check".

**Project rules by role**

Lead:

- "Done" means ticked in `docs/PLAN.md` on `main`. Work on a branch is in progress.
- Merge through a PR. The lead merges a PR when the reviewer approves, CI passes and QA passes, then logs the merge in `docs/status.md` (PM decision, 14 Oct 2026). A confirmed finding that is not fixed still needs the PM's dated decision before the merge.
- After a merge, tick the box in `docs/PLAN.md` and update "Current status" in this file.
- Each PM update lists blockers for every role, with "none" where there are none.

Developer:

- Validate every MCP input and HTTP body with the shared zod schemas in `core/src/api.ts`.
- Contact loopback addresses only, and never stop the user's app.
- Every implementation ships a fake.
- Give every socket and emitter an `'error'` listener.
- Packages depend on `core`, not on each other's internals.
- Before using DTD, the VM service, the Dart MCP server, the Claude Code plugin format or Linear, check their current docs or source. Write down anything that differs from the plan.
- Read the relevant section of `docs/PLAN.md` and any notes in `docs/notes/` first.
- Run `pnpm build` before `pnpm check` (packages import each other through `dist`).

Tester:

- Probe these areas:
  - failure paths: peer disconnects mid-call, timeouts, malformed JSON, missing files;
  - concurrency: attach while stopping, events arriving during a backfill, overlapping scans;
  - security rules: wrong `Host` or `Origin`, missing token, non-loopback addresses, `javascript:` URLs;
  - protocol edges: empty `params`, unknown event kinds, truncated `@Instance` strings;
  - platform: Windows paths and permissions, file modes skipped on win32.
- Tests are colocated as `*.test.ts` and use fakes or recorded fixtures. No real device, Flutter SDK or network.
- Prefer real fixture shapes from the protocol spec or recorded sessions, and note the source in the fixture.
- No `any` and no non-null `!` in tests.
- Commit tests as `test(<scope>): <summary>` on the same branch.

Reviewer:

- Run the code-review skill at `high` effort and the security-review skill on the branch diff against `main`.
- security-review diffs against `origin/HEAD`. If that ref is missing, run `git remote set-head origin --auto`. Only if the repo has no remote, create it with `git update-ref refs/remotes/origin/HEAD main` and delete it afterwards with `git update-ref -d refs/remotes/origin/HEAD`.
- Always check:
  - Host, Origin and token checks on every new route or socket;
  - loopback-only connections;
  - no secret or auth code in ids, logs, responses or URLs;
  - `'error'` listeners on sockets;
  - unhandled promise rejections from timers;
  - atomic commits with Conventional Commit messages;
  - the lockfile matches each commit.

QA:

- Run the real flow: `pnpm build`, start the daemon with `node packages/daemon/dist/main.js`, and call it with `curl` and the token from `.flutterdeck/runtime.json`. `node scripts/dtd-apps.mjs` shows which apps the DTDs can see.
- For flows that need a running Android app, automate first: `scripts/qa/android-sample-app.sh up` boots a headless emulator (or reuses a booted one), creates a throwaway Flutter app in a scratch folder and runs it until DTD sees it. Then `node scripts/qa/check-android-logs.mjs` starts its own daemon on a free port, attaches, checks the native and app logs, and prints a PASS/FAIL table. Always finish with `scripts/qa/android-sample-app.sh down`. `down` stops only the processes `up` started and removes the scratch app. If `up` reused an already-booted emulator, the sample app stays installed on it: QA tells the lead rather than uninstalling it (uninstalling is a Host safety ask). The first run downloads Flutter and Gradle dependencies into the user's caches (`~/.pub-cache`, `~/.gradle`). Paste the table (it masks the token and URIs) into the evidence. If the Android SDK, an API 24+ AVD or Flutter is missing, don't install it: mark the line `NOT RUN — <tool> not installed` and ask the lead.
- Record the date, the OS and the Dart and Flutter versions with each result.
- Mask tokens, auth codes and VM service URIs in all evidence. They grant access.
- Steps the scripts can't cover and that need the PM's machine (start the app from Android Studio or VS Code, set a breakpoint, look at a physical device) go to the lead as a short numbered request. Never pretend they ran.
- Always run the "breakpoint still hits" check. It is the reason the product attaches instead of launching.
- When a real app session runs, record the JSON-RPC traffic as fixtures for the developer, with auth codes and personal data removed.

Marketer:

- Not active until M5. Then draft `docs/marketing/voice.md` first.

## Review gate

After each big piece of work (a package, a milestone item, or any change touching security-sensitive code) and **before** starting the next module:

1. `pnpm check` passes.
2. Run the code-review skill and the security-review skill on the branch diff against `main`.
3. Fix confirmed findings (or record why one is not being fixed), commit the fixes, and summarise the results to the user.

Don't start the next module until this is done.

## Git workflow

Follows [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow) and [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

- `main` stays releasable. Work happens on a short-lived branch per module or milestone item, named `<type>/<short-topic>` (e.g. `feat/connector-dart`, `fix/daemon-origin-check`).
- Commits are atomic: one logical change each, and the repo builds and passes tests after every commit.
- Message format: `<type>(<scope>): <imperative summary>`, at most about 72 characters, lower case, no trailing period. Add a body explaining why when it isn't obvious.
  - Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`.
  - Scope is the package or area: `core`, `daemon`, `connector-dart`, `mcp`, `dashboard`, `cli`, `plugin`, `scripts`, `deps`.
  - Breaking changes to a frozen interface use `!` (e.g. `feat(core)!: ...`) plus a `BREAKING CHANGE:` footer.
- A branch merges into `main` through a pull request. The review gate runs before the PR is opened.
- **PR descriptions** are written in [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English:
  - short sentences, active voice, present tense, one statement per sentence;
  - sections `Changes`, `Reason`, `Verification`, and `Limitations` when there are any.
  - They say only what changed, why and how it was verified. Never put the conversation, progress summaries, review history or blockers in a PR. Those go to the PM in the chat.
- Never commit secrets, `.flutterdeck/state.json` or `.flutterdeck/runtime.json`. Never force-push `main`. Only commit or push when the user has asked.

## Current status

- **M1 done** (14 Oct 2026): scaffold, `core`, daemon, `connector-dart`, `logs-android`, `.mcp.json` example, sample app, acceptance check.
- **M2 in progress.** Plan of record: `docs/design/m2-dashboard.md`, `docs/ui/m2-dashboard.md`, ADRs 0001–0002. Next: batch 1 `feat/dashboard-auth`.
