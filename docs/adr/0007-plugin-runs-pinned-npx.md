# 0007. The plugin starts a pinned CLI version with npx

Date: 2026-11-10

## Status

Accepted (PM, 10 Nov 2026, M5 decision D2)

## Context

The plugin's `.mcp.json` starts `${CLAUDE_PLUGIN_ROOT}/../packages/cli/dist/main.js`. That path exists only in a clone of this repo; an installed plugin is copied to `~/.claude/plugins/cache/`, where it breaks. The plugin must start a released CLI. See [design/m5-release.md](../design/m5-release.md).

## Decision

We will start the MCP server with `npx -y pitdeck@<exact version> mcp`. The plugin and the CLI release together, and each plugin version names exactly one CLI version.

## Consequences

- One CLI build serves npm users and plugin users; no build artifact in the repo.
- The first start downloads the CLI and needs the network once; later starts use npm's cache.
- Windows may need `cmd /c npx`; the smoke test decides.
- Changing the CLI for plugin users always needs a plugin release (a `version` bump).
