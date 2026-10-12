import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { isAlive } from './running.js';
import { STATE_DIR } from './runtime.js';

export const LOCK_FILE = 'startup.lock';
/** A lock older than this is left over from a crash, even if its pid is alive. */
export const DEFAULT_STALE_MS = 15_000;
/**
 * Waits past the stale age, so a lock left by a crash is taken over instead of failing
 * every start for the next 15 s. Starts are normally instant, so the long wait only
 * costs time after a crash.
 */
export const DEFAULT_WAIT_MS = DEFAULT_STALE_MS + 1000;

// pid 0 and negative pids name process groups, so kill(pid, 0) succeeds and they would
// look alive forever.
const LockSchema = z.object({ pid: z.number().int().positive(), createdAt: z.number() });

export interface StartupLockOptions {
  /** How often a held lock is checked again. */
  retryMs?: number;
  /** How long to wait for a held lock before giving up. Defaults to `staleMs` + 1 s. */
  waitMs?: number;
  /** A lock older than this is left over from a crash, even if its pid is alive. */
  staleMs?: number;
}

export class StartupLockBusyError extends Error {
  constructor(
    readonly holderPid: number | undefined,
    /** How long until the lock is treated as stale, when known. */
    readonly staleInMs: number | undefined,
  ) {
    const holder = holderPid === undefined ? '' : ` (pid ${holderPid})`;
    const when =
      staleInMs === undefined
        ? 'shortly'
        : `in about ${Math.max(1, Math.ceil(staleInMs / 1000))} s`;
    super(
      `Another project-deck daemon${holder} is still starting for this project. If it ` +
        `crashed, its startup lock is treated as stale ${when}; try again then.`,
    );
  }
}

export function startupLockPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, LOCK_FILE);
}

/**
 * Serialises daemon startup per project, so two daemons started at once can't both see
 * "nothing running" and both write runtime.json. Resolves with a release function, or
 * throws StartupLockBusyError when the lock stays held for `waitMs`.
 */
export async function acquireStartupLock(
  projectDir: string,
  opts: StartupLockOptions = {},
): Promise<() => Promise<void>> {
  const { retryMs = 100, staleMs = DEFAULT_STALE_MS } = opts;
  const waitMs = opts.waitMs ?? staleMs + 1000;
  const path = startupLockPath(projectDir);
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const content = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      return () => releaseIfOurs(path, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = await readLock(path);
    if (held !== undefined && (await isStale(path, held, staleMs))) {
      // Re-check just before removing, so a lock another waiter has just retaken is kept.
      if ((await readLock(path))?.raw === held.raw) await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new StartupLockBusyError(held?.lock?.pid, await staleIn(path, held, staleMs));
    }
    await sleep(retryMs);
  }
}

interface HeldLock {
  raw: string;
  lock: z.infer<typeof LockSchema> | undefined;
}

async function readLock(path: string): Promise<HeldLock | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const result = LockSchema.safeParse(parsed);
    return { raw, lock: result.success ? result.data : undefined };
  } catch {
    // Released between our create attempt and this read: just try again.
    return undefined;
  }
}

async function isStale(path: string, held: HeldLock, staleMs: number): Promise<boolean> {
  if (held.lock !== undefined) {
    // abs: a createdAt in the future (clock moved back) mustn't keep the lock fresh.
    return !isAlive(held.lock.pid) || Math.abs(Date.now() - held.lock.createdAt) > staleMs;
  }
  // Unreadable: maybe still being written, so judge it by age only.
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function staleIn(
  path: string,
  held: HeldLock | undefined,
  staleMs: number,
): Promise<number | undefined> {
  if (held?.lock !== undefined) return held.lock.createdAt + staleMs - Date.now();
  try {
    return (await stat(path)).mtimeMs + staleMs - Date.now();
  } catch {
    return undefined;
  }
}

async function releaseIfOurs(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) await rm(path, { force: true });
  } catch {
    // Already gone (treated as stale and removed by another daemon): nothing to release.
  }
}
