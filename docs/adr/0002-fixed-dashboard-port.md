# 0002. A fixed dashboard port per project

Date: 2026-10-14

## Status

Accepted (PM decision D2, 14 Oct 2026)

## Context

The Browser pane opens the dashboard from `.claude/launch.json`, which holds one fixed origin. In M1 the daemon moves to the next free port when 9147 is busy, so a saved link can go stale. Letting the pane start the daemon with any free port would race with the daemon the FlutterDeck MCP server starts when a Claude session opens.

## Decision

We will have `flutterdeck init` choose a free port (9147 first) and save it in `.flutterdeck/config.json`. When that file has a port, the daemon always uses it; if the port is busy it exits with a message that names the cause and how to change the port. `launch.json` gets an attach-only entry: `{ "name": "FlutterDeck", "url": "http://127.0.0.1:<port>" }`. The FlutterDeck MCP server starts the daemon when a Claude session starts. Projects without a config file keep the M1 next-free-port behaviour.

## Consequences

- The dashboard link never goes stale, and there is one way to start the daemon.
- If the daemon isn't running, the pane shows "can't connect" until a Claude session or `flutterdeck start` starts it.
- Changing the port means editing `config.json` and `launch.json`; `init` can do both.
