/**
 * Starts the project's daemon in the background (design D2). One fixed command: this
 * Node binary on the daemon package's built entry, so nothing is looked up on PATH or
 * in the project folder. The daemon's startup lock stops a second one.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IN_PITDECK_BUNDLE, IncompleteBundleError, STATE_DIR } from '@project-deck/core/node';

/** The daemon's stderr: its errors and warnings, never log lines or tokens. New at each start. */
export const DAEMON_LOG = 'daemon.log';

interface Child {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    detached: true;
    windowsHide: true;
    stdio: 'ignore' | ['ignore', 'ignore', number];
    shell: false;
  },
) => Child;

export interface SpawnOptions {
  spawn?: SpawnFn;
  onError?: (err: Error) => void;
  /** The daemon process ended; while this process still runs, so it is noticed. */
  onExit?: (code: number | null) => void;
}

export function daemonLogPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, DAEMON_LOG);
}

/**
 * A fresh, private log file for the daemon's stderr, or undefined. A cloned repository
 * may have planted a symlink here: it is removed (never followed) and the new file is
 * created exclusively, which also refuses any link that appears in between.
 */
function openLog(projectDir: string): number | undefined {
  const path = daemonLogPath(projectDir);
  try {
    // Removes a file or a link itself; a folder makes this throw, and then no log.
    rmSync(path, { force: true });
    return openSync(path, 'wx', 0o600);
  } catch {
    return undefined;
  }
}

/**
 * The daemon entry: `daemon.js` next to this code in the `pitdeck` npm bundle, else, in
 * the workspace build only, `packages/daemon/dist/main.js` through the daemon package's
 * `./main` export. The bundle never resolves a package: a look-alike `@project-deck/daemon`
 * up the tree or on NODE_PATH would be started (finding O1). Only the path is resolved:
 * no daemon code is loaded into this process. `here` and `bundled` are test seams for
 * this file's URL and the build.
 */
export function daemonMainPath(
  here: URL | string = import.meta.url,
  bundled: boolean = IN_PITDECK_BUNDLE,
): string {
  const own = fileURLToPath(new URL('daemon.js', here));
  if (existsSync(own)) return own;
  if (bundled) throw new IncompleteBundleError(own);
  return createRequire(here).resolve('@project-deck/daemon/main');
}

/** Starts the daemon for `projectDir` and returns at once; it outlives this process. */
export function spawnDaemon(projectDir: string, opts: SpawnOptions = {}): void {
  const spawn = opts.spawn ?? nodeSpawn;
  const log = openLog(projectDir);
  try {
    const child = spawn(process.execPath, [daemonMainPath(), '--project', projectDir], {
      detached: true,
      windowsHide: true,
      // Errors only: stdout has the address and the token file's path, which Claude
      // must never see through a start-up failure message.
      stdio: log === undefined ? 'ignore' : ['ignore', 'ignore', log],
      shell: false,
    });
    // Without a listener a failed spawn (EACCES, ENOENT) would crash the server.
    child.on('error', (err) => opts.onError?.(err));
    child.on('exit', (code) => opts.onExit?.(code));
    child.unref();
  } finally {
    // The child has its own copy of the descriptor.
    if (log !== undefined) closeSync(log);
  }
}
