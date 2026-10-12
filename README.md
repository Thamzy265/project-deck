# FlutterDeck

[![CI](https://github.com/Thamzy265/project-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/Thamzy265/project-deck/actions/workflows/ci.yml)

> **Early development.** Nothing is installable yet. The name is a working title.

FlutterDeck is an open-source dashboard and Claude Code plugin for Flutter developers. It puts a Drift database inspector, live logs, hot reload controls and Linear tasks next to Claude in Claude Desktop, so you can work from one window.

It **attaches to apps you already run** from Android Studio, VS Code or `flutter run`, and never launches them itself. Your IDE keeps control, so breakpoints keep working. It also builds on the official [Dart MCP server](https://github.com/dart-lang/ai) instead of re-creating it.

## Status

| Milestone | What it delivers                                            | State       |
| --------- | ----------------------------------------------------------- | ----------- |
| M1        | Core, local daemon, attaching to running apps               | In progress |
| M2        | Dashboard in Claude Desktop, notifications, first MCP tools | Planned     |
| M3        | Drift database inspector (the headline feature)             | Planned     |
| M4        | Linear tasks and `/start`, `/ship` commands                 | Planned     |
| M5        | Plugin, npm and pub.dev releases                            | Planned     |

The full plan, with acceptance criteria for each milestone, is in [docs/PLAN.md](docs/PLAN.md).

## Trying the development build

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

To run the daemon with a built-in fake app (no Flutter needed):

```bash
node packages/daemon/dist/main.js --fake
```

It listens on `http://127.0.0.1:9147`. If that port is busy it uses the next free one and says so; the actual port is always in `.flutterdeck/runtime.json`. Every request except `/api/health` needs the session token from `.flutterdeck/runtime.json`. For example:

```bash
curl -s -H "x-deck-token: $(node -p "require('./.flutterdeck/runtime.json').token")" "http://127.0.0.1:$(node -p "require('./.flutterdeck/runtime.json').port")/api/status"
```

To see which running Dart and Flutter apps your tooling daemons know about:

```bash
node scripts/dtd-apps.mjs
```

## How it fits together

- **`packages/core`**: the shared interfaces (apps, logs, databases, tasks), validation schemas and test fakes.
- **`packages/daemon`**: a local server that tracks running apps, buffers their logs, and serves an HTTP and WebSocket API.
- **`packages/connector-dart`** (in review): finds running Flutter apps through the Dart Tooling Daemon and attaches over the VM service.
- Still to come: dashboard, CLI, MCP server, Drift inspector and the Linear integration.

## Security

The daemon only listens on `127.0.0.1`. It rejects requests whose `Host` or `Origin` isn't local, and it requires a random session token stored in a file only you can read. Database access will be read-only by default. Full rules are in [CLAUDE.md](CLAUDE.md#coding-rules).

## Contributing

Work follows [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow) and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Every change passes `pnpm check`, plus a code review and a security review, before it merges. See [CLAUDE.md](CLAUDE.md) for the conventions.

## Licence

[MIT](LICENSE)
