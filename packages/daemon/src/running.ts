import { readRuntime } from './runtime.js';
import { TOKEN_HEADER } from './security.js';

/**
 * How long the authenticated probe may take. A daemon whose event loop is blocked for
 * longer than this is treated as not running, and a second one starts; that trade-off
 * is accepted so a hung or foreign peer can never block startup for long.
 */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * Returns the port of a daemon already serving this project, if any. A runtime file
 * left behind by a crash doesn't count: the pid must be alive and the port must accept
 * this project's token, since after a reboot the pid can be reused and every project
 * defaults to the same port.
 */
export async function findRunningDaemon(projectDir: string): Promise<number | undefined> {
  const info = await readRuntime(projectDir);
  if (info === undefined || !isAlive(info.pid)) return undefined;
  return (await acceptsToken(info.port, info.token)) ? info.port : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Only a 200 with a status-shaped JSON body counts. Any other status (401 from another
 * project's daemon), a timeout, a stalled body or a connection error means not running.
 */
async function acceptsToken(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { [TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && 'version' in body;
  } catch {
    return false;
  }
}
