import { readRuntime } from './runtime.js';

const HEALTH_TIMEOUT_MS = 1000;

/**
 * Returns the port of a daemon already serving this project, if any. A runtime file
 * left behind by a crash (dead pid, or nothing answering on its port) doesn't count.
 */
export async function findRunningDaemon(projectDir: string): Promise<number | undefined> {
  const info = await readRuntime(projectDir);
  if (info === undefined || !isAlive(info.pid)) return undefined;
  return (await answersAsDaemon(info.port)) ? info.port : undefined;
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

async function answersAsDaemon(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: unknown };
    return body.name === 'project-deck';
  } catch {
    return false;
  }
}
