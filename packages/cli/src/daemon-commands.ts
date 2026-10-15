/**
 * `start`, `stop` and `open`: the CLI as a client of the project's daemon. They use the
 * MCP server's DaemonClient, so the same checks run before the token is sent (the
 * daemon on the port must say it serves this project). Nothing here signals a process.
 */
import type { DaemonClientOptions } from '@project-deck/mcp';
import { DaemonClient, DaemonError, ForeignDaemonError } from '@project-deck/mcp';
import { DECK_VERSION } from '@project-deck/core';
import { isDashboardUrl } from './browser.js';
import type { Io } from './io.js';
import { messageOf } from './io.js';
import { CLI_NAME } from './name.js';

export interface DaemonCommandOptions {
  projectDir: string;
  io: Io;
  /** Starts the daemon in the background (spawnDaemon from the MCP package). */
  spawnDaemon: DaemonClientOptions['spawnDaemon'];
  /** Test seam: timeouts and polling of the client. */
  client?: Partial<Omit<DaemonClientOptions, 'projectDir' | 'spawnDaemon'>>;
}

export interface OpenOptions extends DaemonCommandOptions {
  /** Also show the dashboard in the default browser. */
  browser: boolean;
  openBrowser: (url: string) => boolean;
}

function clientFor(opts: DaemonCommandOptions): DaemonClient {
  return new DaemonClient({
    version: DECK_VERSION,
    ...opts.client,
    projectDir: opts.projectDir,
    spawnDaemon: opts.spawnDaemon,
  });
}

/** Runs a command body; a DaemonError (never holding the token) becomes exit code 1. */
async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (err) {
    io.err(err instanceof DaemonError ? err.message : `Failed: ${messageOf(err)}`);
    return 1;
  }
}

/** The dashboard address from the daemon, checked, plus any version warning. */
async function dashboard(client: DaemonClient, io: Io, start: boolean): Promise<string> {
  const status = await client.status({ start });
  for (const warning of status.warnings) io.err(`Warning: ${warning}`);
  const url = status.value.dashboardUrl;
  if (!isDashboardUrl(url)) throw new DaemonError('FlutterDeck daemon sent an unexpected address');
  return url;
}

function loginLines(url: string, until: number): string[] {
  const minutes = Math.max(1, Math.round((until - Date.now()) / 60_000));
  return [
    `Dashboard: ${url}`,
    `Open it within ${minutes} minute${minutes === 1 ? '' : 's'} to log in (in Claude Desktop: the Browser pane, "FlutterDeck"). After that, run \`${CLI_NAME} open\` again.`,
  ];
}

export function runStart(opts: DaemonCommandOptions): Promise<number> {
  return guarded(opts.io, async () => {
    const client = clientFor(opts);
    const wasRunning = await client.running();
    // Starts the daemon when it isn't running, and waits until it answers.
    const window = await client.openLoginWindow();
    const url = await dashboard(client, opts.io, true);
    opts.io.out(
      wasRunning
        ? 'FlutterDeck is already running for this project; the login window is open again.'
        : 'FlutterDeck started.',
    );
    for (const line of loginLines(url, window.until)) opts.io.out(line);
    return 0;
  });
}

export function runStop(opts: DaemonCommandOptions): Promise<number> {
  return guarded(opts.io, async () => {
    let stopped: boolean;
    try {
      stopped = await clientFor(opts).shutdown();
    } catch (err) {
      // `stop` can't help here, so say what can. FlutterDeck never kills a process itself:
      // the pid in runtime.json may belong to another program by now.
      if (err instanceof ForeignDaemonError) {
        opts.io.err(
          `The program on port ${err.port} doesn't accept this project's key, so \`${CLI_NAME} stop\` can't stop it. Stop it by quitting the process that runs packages/daemon/dist/main.js (port ${err.port}), or delete .flutterdeck/runtime.json if no FlutterDeck runs.`,
        );
        return 1;
      }
      throw err;
    }
    opts.io.out(stopped ? 'FlutterDeck stopped.' : "FlutterDeck isn't running for this project.");
    return 0;
  });
}

export function runOpen(opts: OpenOptions): Promise<number> {
  return guarded(opts.io, async () => {
    const client = clientFor(opts);
    // Never starts a daemon, also when it goes away between these two calls.
    const window = await client.openLoginWindow({ start: false });
    const url = await dashboard(client, opts.io, false);
    for (const line of loginLines(url, window.until)) opts.io.out(line);
    if (opts.browser && !opts.openBrowser(url)) {
      opts.io.out("Couldn't find a way to open the browser here; open the address above.");
    }
    return 0;
  });
}
