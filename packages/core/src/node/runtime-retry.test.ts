import { readdir, rename as fsRename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retryWhileBusy } from './fs-retry.js';
import type { RuntimeInfo } from './runtime.js';
import { readRuntime, writeRuntime } from './runtime.js';

const info: RuntimeInfo = { pid: 1, port: 9147, token: 't'.repeat(43), startedAt: 0 };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-retry-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function busy(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe('writeRuntime on Windows, while a reader has runtime.json open', () => {
  it('tries the rename again and succeeds', async () => {
    let calls = 0;
    await writeRuntime(dir, info, {
      rename: (from, to) => {
        calls++;
        return calls <= 2 ? Promise.reject(busy('EPERM')) : fsRename(from, to);
      },
    });
    expect(calls).toBe(3);
    expect(await readRuntime(dir)).toEqual(info);
    expect(await readdir(join(dir, '.flutterdeck'))).toEqual(['runtime.json']);
  });

  it('gives up after about a second and leaves no temp file', async () => {
    const start = Date.now();
    await expect(
      writeRuntime(dir, info, { rename: () => Promise.reject(busy('EBUSY')) }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(await readdir(join(dir, '.flutterdeck'))).toEqual([]);
  });
});

describe('retryWhileBusy', () => {
  it('passes any other error on at once', async () => {
    let calls = 0;
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    await expect(
      retryWhileBusy(() => {
        calls++;
        return Promise.reject(missing);
      }),
    ).rejects.toBe(missing);
    expect(calls).toBe(1);
  });

  it('retries EACCES too', async () => {
    let calls = 0;
    const value = await retryWhileBusy(
      () => (++calls < 3 ? Promise.reject(busy('EACCES')) : Promise.resolve('ok')),
      [1, 1, 1],
    );
    expect(value).toBe('ok');
  });
});
