import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotRegularFileError, StateDirError, checkStateDir, readRegularFile } from './safe-file.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-safe-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Creating symlinks on Windows needs a privilege CI may not have.
const links = process.platform === 'win32' ? it.skip : it;

describe('readRegularFile', () => {
  it('reads a plain file, or just its start or end', async () => {
    await writeFile(join(dir, 'f'), 'hello world');
    expect(await readRegularFile(join(dir, 'f'))).toBe('hello world');
    expect(await readRegularFile(join(dir, 'f'), { maxBytes: 5 })).toBe('hello');
    expect(await readRegularFile(join(dir, 'f'), { maxBytes: 5, tail: true })).toBe('world');
  });

  links('refuses a symlink to a file, without reading it', async () => {
    await writeFile(join(dir, 'secret'), 'top secret');
    await symlink(join(dir, 'secret'), join(dir, 'link'));
    await expect(readRegularFile(join(dir, 'link'))).rejects.toBeInstanceOf(NotRegularFileError);
  });

  links('refuses a dangling symlink', async () => {
    await symlink(join(dir, 'nowhere'), join(dir, 'link'));
    await expect(readRegularFile(join(dir, 'link'))).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it('refuses a folder', async () => {
    await mkdir(join(dir, 'd'));
    await expect(readRegularFile(join(dir, 'd'))).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it('passes on a missing file as ENOENT', async () => {
    await expect(readRegularFile(join(dir, 'none'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('checkStateDir', () => {
  it('accepts a missing or real .flutterdeck folder', async () => {
    await expect(checkStateDir(dir)).resolves.toBeUndefined();
    await mkdir(join(dir, '.flutterdeck'));
    await expect(checkStateDir(dir)).resolves.toBeUndefined();
  });

  links('refuses a .flutterdeck that is a symlink', async () => {
    await mkdir(join(dir, 'elsewhere'));
    await symlink(join(dir, 'elsewhere'), join(dir, '.flutterdeck'));
    await expect(checkStateDir(dir)).rejects.toBeInstanceOf(StateDirError);
  });

  it('refuses a .flutterdeck that is a file', async () => {
    await writeFile(join(dir, '.flutterdeck'), '');
    await expect(checkStateDir(dir)).rejects.toThrow(/not a real folder/);
  });
});
