import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATE_DIR } from './runtime.js';
import {
  DEFAULT_STALE_MS,
  DEFAULT_WAIT_MS,
  StartupLockBusyError,
  acquireStartupLock,
  startupLockPath,
} from './startup-lock.js';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-lock-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const FAST = { retryMs: 10, waitMs: 300, staleMs: 15_000 };

async function plant(content: string, ageMs = 0): Promise<void> {
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  await writeFile(startupLockPath(projectDir), content);
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await utimes(startupLockPath(projectDir), then, then);
  }
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.once('error', reject);
    child.once('exit', () => resolve(child.pid ?? -1));
  });
}

describe('acquireStartupLock', () => {
  it('creates a private lock file holding this pid and removes it on release', async () => {
    const release = await acquireStartupLock(projectDir, FAST);
    const path = startupLockPath(projectDir);
    const lock = JSON.parse(await readFile(path, 'utf8')) as { pid: number; createdAt: number };
    expect(lock.pid).toBe(process.pid);
    expect(Math.abs(Date.now() - lock.createdAt)).toBeLessThan(5000);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    await release();
    expect(await exists(path)).toBe(false);
  });

  it('makes a second caller wait until the first releases', async () => {
    const release = await acquireStartupLock(projectDir, FAST);
    let second = false;
    const waiting = acquireStartupLock(projectDir, { ...FAST, waitMs: 2000 }).then((r) => {
      second = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second).toBe(false);
    await release();
    const releaseSecond = await waiting;
    expect(second).toBe(true);
    await releaseSecond();
  });

  it('gives up with StartupLockBusyError naming the holder when the lock stays held', async () => {
    const release = await acquireStartupLock(projectDir, FAST);
    try {
      const attempt = acquireStartupLock(projectDir, FAST);
      await expect(attempt).rejects.toBeInstanceOf(StartupLockBusyError);
      await expect(attempt).rejects.toMatchObject({ holderPid: process.pid });
    } finally {
      await release();
    }
  });

  it('waits past the stale age by default, so a crash-left lock never fails a start', () => {
    expect(DEFAULT_WAIT_MS).toBeGreaterThan(DEFAULT_STALE_MS);
  });

  it('with no waitMs, takes over a crash-left lock held by a live pid once it goes stale', async () => {
    // Small injected timings stand in for the real 15 s / 16 s.
    await plant(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const release = await acquireStartupLock(projectDir, { retryMs: 10, staleMs: 200 });
    const lock = JSON.parse(await readFile(startupLockPath(projectDir), 'utf8')) as {
      createdAt: number;
    };
    expect(Date.now() - lock.createdAt).toBeLessThan(1000);
    await release();
  });

  it('says in the busy error when the lock will be treated as stale', async () => {
    await plant(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const attempt = acquireStartupLock(projectDir, { retryMs: 10, waitMs: 50, staleMs: 15_000 });
    await expect(attempt).rejects.toThrow(/treated as stale in about 1[45] s/);
    await expect(attempt).rejects.toMatchObject({ staleInMs: expect.any(Number) as number });
  });

  it('takes over a lock whose pid is dead', async () => {
    await plant(JSON.stringify({ pid: await exitedPid(), createdAt: Date.now() }));
    const release = await acquireStartupLock(projectDir, FAST);
    const lock = JSON.parse(await readFile(startupLockPath(projectDir), 'utf8')) as {
      pid: number;
    };
    expect(lock.pid).toBe(process.pid);
    await release();
  });

  it('takes over a lock older than the stale limit even if its pid is alive', async () => {
    await plant(JSON.stringify({ pid: process.pid, createdAt: Date.now() - 20_000 }));
    const release = await acquireStartupLock(projectDir, FAST);
    await release();
  });

  it.each([0, -1, 1.5])(
    'judges a lock with pid %s by file age, since that pid can never be checked',
    async (pid) => {
      // kill(0) and kill(-1) signal process groups and succeed, so such a pid would look
      // alive forever. Rejecting it falls back to the file's age, which does go stale.
      await plant(JSON.stringify({ pid, createdAt: Date.now() }), 20_000);
      const release = await acquireStartupLock(projectDir, FAST);
      await release();
    },
  );

  it('takes over a lock whose createdAt is further in the future than the stale limit', async () => {
    // A clock that jumped back would otherwise make the lock look fresh for a long time.
    await plant(JSON.stringify({ pid: process.pid, createdAt: Date.now() + 20_000 }));
    const release = await acquireStartupLock(projectDir, FAST);
    await release();
  });

  it('waits on a fresh unreadable lock (still being written) instead of deleting it', async () => {
    await plant('');
    await expect(acquireStartupLock(projectDir, FAST)).rejects.toBeInstanceOf(StartupLockBusyError);
    expect(await readFile(startupLockPath(projectDir), 'utf8')).toBe('');
  });

  it('takes over an unreadable lock once its file is older than the stale limit', async () => {
    await plant('{ half-writ', 20_000);
    const release = await acquireStartupLock(projectDir, FAST);
    await release();
  });

  it('does not remove a lock that another daemon has since taken over', async () => {
    const release = await acquireStartupLock(projectDir, FAST);
    const theirs = JSON.stringify({ pid: process.pid, createdAt: Date.now() + 1 });
    await writeFile(startupLockPath(projectDir), theirs);
    await release();
    expect(await readFile(startupLockPath(projectDir), 'utf8')).toBe(theirs);
  });
});
