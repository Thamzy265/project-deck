/**
 * Starts the project's daemon in the background (design D2). One fixed command: this
 * Node binary on the daemon package's built entry, so nothing is looked up on PATH or
 * in the project folder. The daemon's startup lock stops a second one.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, fchmodSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { STATE_DIR } from '@project-deck/core/node';

/** The daemon's own start-up messages (never log lines or tokens), new at each start. */
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
    stdio: 'ignore' | ['ignore', number, number];
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

/** A fresh, private log file for the daemon's stdout and stderr, or undefined. */
function openLog(projectDir: string): number | undefined {
  try {
    const fd = openSync(daemonLogPath(projectDir), 'w', 0o600);
    // 'w' keeps the mode of an existing file; make it private either way.
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    return fd;
  } catch {
    return undefined;
  }
}

/**
 * `packages/daemon/dist/main.js`, through the daemon package's `./main` export. Only the
 * path is resolved: no daemon code is loaded into this process.
 */
export function daemonMainPath(): string {
  return createRequire(import.meta.url).resolve('@project-deck/daemon/main');
}

/** Starts the daemon for `projectDir` and returns at once; it outlives this process. */
export function spawnDaemon(projectDir: string, opts: SpawnOptions = {}): void {
  const spawn = opts.spawn ?? nodeSpawn;
  const log = openLog(projectDir);
  try {
    const child = spawn(process.execPath, [daemonMainPath(), '--project', projectDir], {
      detached: true,
      windowsHide: true,
      stdio: log === undefined ? 'ignore' : ['ignore', log, log],
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
