# 0002. A fixed dashboard port per project

Date: 2026-10-14

## Status

Accepted (PM decision D2, 14 Oct 2026)

## Context

The Browser pane opens the dashboard from `.claude/launch.json`, which holds one fixed origin. In M1 the daemon moves to the next free port when 9147 is busy, so a saved link can go stale. Letting the pane start the daemon with any free port would race with the daemon the FlutterDeck MCP server starts when a Claude session opens.

## Decision

We will have `flutterdeck init` choose a port from a per-user registry (`~/.flutterdeck/ports.json`, 9147 for the first project, then the next free unregistered port) and save it in `.flutterdeck/config.json`. When that file has a port, the daemon always uses it. If the port is busy, the daemon asks `GET /api/health` on it and exits with "another FlutterDeck (project <id>)" or "another program", and how to change the port; it never runs a process lookup command. `/api/health` returns a non-reversible project id, and the dashboard and MCP server warn when it isn't theirs. `launch.json` gets an attach-only entry: `{ "name": "FlutterDeck", "url": "http://127.0.0.1:<port>" }`. The FlutterDeck MCP server starts the daemon as soon as it starts (when a Claude session opens), and again on a tool call if it has gone. Projects without a config file keep the M1 next-free-port behaviour.

## Consequences

- The dashboard link never goes stale, and there is one way to start the daemon.
- If the daemon isn't running, the pane shows "can't connect" until a Claude session or `flutterdeck start` starts it.
- Changing the port means editing `config.json` and `launch.json`; `init` can do both.
