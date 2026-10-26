# FlutterDeck

[![CI](https://github.com/Thamzy265/project-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/Thamzy265/project-deck/actions/workflows/ci.yml)

> **Early preview.** The Drift database inspector works today. You install it from a git checkout. It is not on npm or pub.dev yet.

FlutterDeck is an open source (MIT) dashboard and Claude Code plugin for Flutter developers. It shows your app's Drift database live in a Database tab in Claude Desktop's Browser pane, next to Claude. Claude can read the database to answer questions, and gets your app's logs. It works with the official [Dart MCP server](https://github.com/dart-lang/ai) for hot reload and runtime errors.

It **attaches to apps you already run** from Android Studio, VS Code or `flutter run`, and never launches or stops them. Your IDE keeps control, so breakpoints keep working.

Tested on Android (emulator) and the iOS Simulator; real iPhones are untested. The install steps were run on macOS only. Windows and Linux are untested.

## Try it

- [Try it without a device](https://github.com/Thamzy265/project-deck/wiki/Try-without-a-device): fake mode, about 5 minutes, no Flutter or IDE needed.
- [Install guide](https://github.com/Thamzy265/project-deck/wiki/Install-guide): from a git checkout to your own app, with a sample app.
- [Wiki](https://github.com/Thamzy265/project-deck/wiki): the guide, FAQ, and safety and privacy notes.

## Safety

- FlutterDeck's database tools for Claude only read: every query is checked with the real SQLite engine and anything that changes data is refused. You can hide columns from these tools.
- These rules cover FlutterDeck's tools only. Claude Code's other tools (shell, file reads, the Browser pane) can still reach your database, so keep Claude Code's permission prompts on.

The daemon only listens on `127.0.0.1`, rejects requests whose `Host` or `Origin` isn't local, and needs a random session token stored in a file only you can read. Full rules are in [CLAUDE.md](CLAUDE.md#coding-rules).

## Status

| Milestone | What it delivers                                                 | State                                                   |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| M1        | Core, local daemon, attaching to running apps                    | Done                                                    |
| M2        | Dashboard in Claude Desktop, notifications, first MCP tools      | Done                                                    |
| M3        | Drift database inspector (the headline feature)                  | Done, except the validation checkpoint (feedback round) |
| M4        | Plugin commands: `/check` and `/db`                              | Planned                                                 |
| M5        | Plugin and marketplace entry, npm and pub.dev releases, `doctor` | Planned                                                 |

Linear support is not planned for v1: ask Claude to use Linear's own MCP server. It is in the "Later" list of the plan. The full plan, with acceptance criteria for each milestone, is in [docs/PLAN.md](docs/PLAN.md).

## Feedback

Tell us what is missing or wrong in GitHub Discussions: <https://github.com/Thamzy265/project-deck/discussions/46>. Replies are public, so don't paste app data, logs or personal data.

## Building from source

You need Node.js 22.12 or newer and pnpm 10. Finding running apps automatically needs Dart 3.12 or newer.

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm check
```

To try FlutterDeck with a built-in fake app and no Flutter, follow [Try it without a device](https://github.com/Thamzy265/project-deck/wiki/Try-without-a-device). To see which running Dart and Flutter apps your tooling daemons know about:

```bash
node scripts/dtd-apps.mjs
```

## How it fits together

- **`packages/core`**: the shared interfaces (apps, logs, databases, tasks), validation schemas and test fakes.
- **`packages/daemon`**: a local server that tracks running apps, buffers their logs, and serves an HTTP and WebSocket API and the dashboard.
- **`packages/connector-dart`**: finds running Flutter apps through the Dart Tooling Daemon and attaches over the VM service.
- **`packages/cli`**, **`packages/mcp`**, **`packages/dashboard`**: the `flutterdeck` command, the MCP server for Claude, and the dashboard UI.
- **`packages/db-drift`**, **`packages/db-sqlite`**, **`packages/sql-guard`** and **`dart/flutterdeck_drift`**: the Drift inspector, snapshot reads and the read-only SQL gate.
- **`examples/sample_app`**: a one-screen Flutter app for trying FlutterDeck by hand, with a marked breakpoint line and logs on every tap. See its [README](examples/sample_app/README.md).
- Still to come: the `/check` and `/db` plugin commands and the packaged release.

## Contributing

Work follows [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow) and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Every change passes `pnpm check`, plus a code review and a security review, before it merges. See [CLAUDE.md](CLAUDE.md) for the conventions.

## Licence

[MIT](LICENSE)
