/**
 * Starts the project's daemon in the background (design D2). One fixed command: this
 * Node binary on the daemon package's built entry, so nothing is looked up on PATH or
 * in the project folder. The daemon's startup lock stops a second one.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';

interface Child {
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: true; windowsHide: true; stdio: 'ignore'; shell: false },
) => Child;

export interface SpawnOptions {
  spawn?: SpawnFn;
  onError?: (err: Error) => void;
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
  const child = spawn(process.execPath, [daemonMainPath(), '--project', projectDir], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    shell: false,
  });
  // Without a listener a failed spawn (EACCES, ENOENT) would crash the server.
  child.on('error', (err) => opts.onError?.(err));
  child.unref();
}
