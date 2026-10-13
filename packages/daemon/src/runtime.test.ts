import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeInfo } from './runtime.js';
import { STATE_DIR, readRuntime, removeRuntime, runtimePath, writeRuntime } from './runtime.js';

const info: RuntimeInfo = { pid: 1, port: 9100, token: 't'.repeat(43), startedAt: 0 };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-runtime-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runtime file', () => {
  it('replaces a wider-permission file with a private one and leaves no temp files', async () => {
    await mkdir(join(dir, STATE_DIR));
    await writeFile(runtimePath(dir), '{}', { mode: 0o644 });
    await writeRuntime(dir, info);
    expect(await readRuntime(dir)).toEqual(info);
    expect(await readdir(join(dir, STATE_DIR))).toEqual(['runtime.json']);
    if (process.platform !== 'win32') {
      expect((await stat(runtimePath(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it('only removes the file when the token matches', async () => {
    await writeRuntime(dir, info);
    await removeRuntime(dir, 'someone-else');
    expect(await readRuntime(dir)).toEqual(info);
    await removeRuntime(dir, info.token);
    expect(await readRuntime(dir)).toBeUndefined();
  });

  it.each([0, -1, 1.5])('treats a file with pid %s as absent', async (pid) => {
    // kill(0, 0) and kill(-1, 0) succeed, so such a pid would always look alive.
    await mkdir(join(dir, STATE_DIR));
    await writeFile(runtimePath(dir), JSON.stringify({ ...info, pid }));
    expect(await readRuntime(dir)).toBeUndefined();
  });

  it('treats a malformed file as absent', async () => {
    await mkdir(join(dir, STATE_DIR));
    await writeFile(runtimePath(dir), 'not json');
    expect(await readRuntime(dir)).toBeUndefined();
  });
});
