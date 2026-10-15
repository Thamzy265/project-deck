/**
 * Runs the FlutterDeck MCP server over stdio for one project, until Claude closes stdin.
 * It starts the project's daemon at once if it isn't running, so the dashboard is up
 * when the Browser pane opens, and opens the dashboard's login window (ADR 0002, 0003).
 * stdout carries the MCP protocol only; messages go to stderr.
 * Used by this package's main.js and by `flutterdeck mcp`.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DECK_VERSION } from '@project-deck/core';
import { DaemonClient } from './daemon-client.js';
import { createDeckServer } from './server.js';
import { spawnDaemon } from './spawn.js';

export async function runMcpServer(projectDir: string): Promise<void> {
  const log = (message: string) => process.stderr.write(`flutterdeck mcp: ${message}\n`);
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // A stray rejection would end the process, and with it every FlutterDeck tool in Claude.
  process.on('unhandledRejection', (err) => log(`Unexpected error: ${reason(err)}`));

  const daemon = new DaemonClient({
    projectDir,
    version: DECK_VERSION,
    spawnDaemon: (dir, onExit) =>
      spawnDaemon(dir, {
        onError: (err) => log(`Couldn't start the daemon: ${err.message}`),
        onExit,
      }),
  });
  const deck = createDeckServer({ projectDir, daemon });
  await deck.server.connect(new StdioServerTransport());

  // Not awaited: the client may list and call tools meanwhile. Tool calls start the daemon
  // again if this fails. DaemonError messages never hold the token.
  daemon.openLoginWindow().catch((err: unknown) => log(reason(err)));

  // Claude closes stdin when the session ends.
  process.stdin.once('close', () => {
    void deck
      .close()
      .catch((err: unknown) => log(reason(err)))
      .finally(() => process.exit(0));
  });
}
