import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  /** Test seams for interleavings and platform errors that timing can't produce. */
  hooks?: StartupLockHooks;
}

export interface StartupLockHooks {
  /** Replaces the exclusive create of the lock file. */
  create?: (path: string, content: string) => Promise<void>;
  /** Runs after a lock has been judged stale, just before it is removed. */
  beforeStaleRemove?: (path: string) => Promise<void>;
}

/**
 * Codes from the exclusive create that mean "someone else has it". Windows gives EPERM
 * or EBUSY instead of EEXIST while another process is creating or deleting the file.
 */
const HELD_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY']);

function createExclusive(path: string, content: string): Promise<void> {
  return writeFile(path, content, { flag: 'wx', mode: 0o600 });
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
  const create = opts.hooks?.create ?? createExclusive;
  const waitMs = opts.waitMs ?? staleMs + 1000;
  const path = startupLockPath(projectDir);
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const content = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
    try {
      await create(path, content);
      await sweepLeftovers(join(projectDir, STATE_DIR), staleMs);
      return () => releaseIfOurs(path, content);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !HELD_CODES.has(code)) throw err;
    }
    const held = await readLock(path);
    if (held !== undefined && (await isStale(path, held, staleMs))) {
      await opts.hooks?.beforeStaleRemove?.(path);
      if (await removeStale(path, held.raw)) continue;
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

/**
 * Removes the lock only if it still holds `staleRaw`. A read-then-delete could delete a
 * fresh lock another waiter took in between, so the lock is first renamed to a name
 * only we know (atomic), then checked there. Returns false when the lock couldn't be
 * moved for now, so the caller waits instead of spinning.
 */
async function removeStale(path: string, staleRaw: string): Promise<boolean> {
  const aside = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
  try {
    await rename(path, aside);
  } catch (err) {
    // ENOENT: another waiter removed it first, so try the create again at once.
    // EPERM/EBUSY (Windows): it is being replaced right now, so wait and look again.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code !== undefined && HELD_CODES.has(code)) return false;
    throw err;
  }
  let moved: string | undefined;
  try {
    moved = await readFile(aside, 'utf8');
  } catch {
    moved = undefined;
  }
  if (moved !== staleRaw) {
    // We moved another waiter's fresh lock. Put it back without overwriting: link fails
    // if a newer lock already exists, and then that one wins.
    try {
      await link(aside, path);
    } catch {
      // A newer lock took its place, or the file system can't link: leave it.
    }
  }
  await rm(aside, { force: true });
  return true;
}

/**
 * A crash between renaming a stale lock aside and deleting it leaves a `.stale` file.
 * Only old ones are removed, so a waiter still checking its own aside file is unaffected.
 */
async function sweepLeftovers(dir: string, staleMs: number): Promise<void> {
  try {
    const prefix = `${LOCK_FILE}.`;
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.stale')) continue;
      const file = join(dir, name);
      try {
        if (Date.now() - (await stat(file)).mtimeMs > staleMs) await rm(file, { force: true });
      } catch {
        // Removed by another daemon, or not ours to remove: leave it.
      }
    }
  } catch {
    // Cleanup is best effort and must never fail a start.
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
