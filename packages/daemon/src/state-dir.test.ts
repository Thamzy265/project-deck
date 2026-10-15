import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { StateDirError } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from './daemon.js';

let projectDir: string;
let elsewhere: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-statedir-'));
  elsewhere = await mkdtemp(join(tmpdir(), 'deck-elsewhere-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

describe('a .flutterdeck that is not a real folder', () => {
  it.skipIf(process.platform === 'win32')(
    'is refused when it is a link, and nothing is written where it points',
    async () => {
      await writeFile(join(elsewhere, 'config.json'), '{"version":1}');
      await symlink(elsewhere, join(projectDir, '.flutterdeck'));
      await expect(
        startDaemon({ projectDir, registry: new Registry(), port: 0, log: () => undefined }),
      ).rejects.toBeInstanceOf(StateDirError);
      expect(await readdir(elsewhere)).toEqual(['config.json']);
    },
  );

  it('is refused when it is a file', async () => {
    await writeFile(join(projectDir, '.flutterdeck'), '');
    await expect(
      startDaemon({ projectDir, registry: new Registry(), port: 0, log: () => undefined }),
    ).rejects.toThrow(/not a real folder/);
  });

  it('is fine as a real folder', async () => {
    await mkdir(join(projectDir, '.flutterdeck'));
    const d = await startDaemon({
      projectDir,
      registry: new Registry(),
      port: 0,
      log: () => undefined,
    });
    await d.stop();
  });
});
