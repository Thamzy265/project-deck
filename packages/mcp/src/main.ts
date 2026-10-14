#!/usr/bin/env node
/**
 * FlutterDeck MCP server over stdio, for the project in the current folder:
 *   node packages/mcp/dist/main.js [--project <dir>]
 * It starts the project's daemon at once if it isn't running, so the dashboard is up
 * when the Browser pane opens, and opens the dashboard's login window (ADR 0002, 0003).
 * stdout carries the MCP protocol only; messages go to stderr.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '@project-deck/daemon';
import { DaemonClient } from './daemon-client.js';
import { createDeckServer } from './server.js';
import { spawnDaemon } from './spawn.js';

const { values } = parseArgs({
  options: { project: { type: 'string', default: process.cwd() } },
});
const projectDir = resolve(values.project);
const log = (message: string) => process.stderr.write(`flutterdeck mcp: ${message}\n`);

const daemon = new DaemonClient({
  projectDir,
  version: VERSION,
  spawnDaemon: (dir) =>
    spawnDaemon(dir, { onError: (err) => log(`Couldn't start the daemon: ${err.message}`) }),
});
const deck = createDeckServer({ projectDir, daemon });
await deck.server.connect(new StdioServerTransport());

// Not awaited: the client may list and call tools meanwhile. Tool calls start the daemon
// again if this fails. DaemonError messages never hold the token.
daemon
  .openLoginWindow()
  .catch((err: unknown) => log(err instanceof Error ? err.message : String(err)));

// Claude closes stdin when the session ends.
process.stdin.once('close', () => {
  void deck.close().finally(() => process.exit(0));
});
