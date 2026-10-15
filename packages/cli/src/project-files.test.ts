import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnsafeFileError, inspectDir, inspectFile, writeAtomic } from './project-files.js';

/** Making a symlink on Windows needs extra rights; the lstat checks are the same there. */
const links = process.platform === 'win32' ? it.skip : it;

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-cli-files-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-cli-outside-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<UnsafeFileError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof UnsafeFileError) return err;
    throw err;
  }
  throw new Error('expected an UnsafeFileError');
}

describe('inspectFile', () => {
  it('reports a missing file', async () => {
    expect(await inspectFile(join(dir, 'a'), 'a')).toEqual({ kind: 'missing' });
  });

  it('reads a regular file with its mode', async () => {
    await writeFile(join(dir, 'a'), 'hello', { mode: 0o640 });
    const found = await inspectFile(join(dir, 'a'), 'a');
    expect(found).toMatchObject({ kind: 'file', text: 'hello' });
    if (process.platform !== 'win32' && found.kind === 'file') expect(found.mode).toBe(0o640);
  });

  links('refuses a symlink, naming the file and not its target', async () => {
    const target = join(outside, 'secret');
    await writeFile(target, 'top secret');
    await symlink(target, join(dir, 'a'));
    const err = await rejection(inspectFile(join(dir, 'a'), '.gitignore'));
    expect(err.message).toContain('.gitignore');
    expect(err.message).toContain('link');
    expect(err.message).not.toContain(outside);
    expect(err.message).not.toContain('top secret');
  });

  it('refuses a folder', async () => {
    await mkdir(join(dir, 'a'));
    expect((await rejection(inspectFile(join(dir, 'a'), 'a'))).message).toContain('folder');
  });
});

describe('inspectDir', () => {
  links('accepts a missing or real folder and refuses a link or a file', async () => {
    expect(await inspectDir(join(dir, 'x'), 'x')).toBe('missing');
    await mkdir(join(dir, 'x'));
    expect(await inspectDir(join(dir, 'x'), 'x')).toBe('dir');
    await symlink(outside, join(dir, 'l'), 'dir');
    expect((await rejection(inspectDir(join(dir, 'l'), '.claude'))).message).toContain('.claude');
    await writeFile(join(dir, 'f'), '');
    await rejection(inspectDir(join(dir, 'f'), 'f'));
  });
});

describe('writeAtomic temp files (review K4)', () => {
  it('writes its temp file in the given folder and renames it across', async () => {
    const tmpDir = join(dir, '.flutterdeck');
    await mkdir(tmpDir);
    const moves: string[] = [];
    await writeAtomic(join(dir, '.gitignore'), 'x\n', 0o644, {
      tmpDir,
      rename: async (from, to) => {
        moves.push(from);
        await rename(from, to);
      },
    });
    expect(moves).toHaveLength(1);
    expect(dirname(moves[0] ?? '')).toBe(tmpDir);
    expect(basename(moves[0] ?? '')).toMatch(/^\.gitignore\.[0-9a-f]+\.tmp$/);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('x\n');
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('removes its temp file when the rename fails', async () => {
    const tmpDir = join(dir, '.flutterdeck');
    await mkdir(tmpDir);
    const failure = Object.assign(new Error('nope'), { code: 'EXDEV' });
    await expect(
      writeAtomic(join(dir, 'a'), 'x', 0o644, { tmpDir, rename: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);
    expect(await readdir(tmpDir)).toEqual([]);
  });
});

describe('writeAtomic', () => {
  it('replaces the file whole and leaves no temp file', async () => {
    const path = join(dir, 'a.json');
    await writeFile(path, 'old');
    await writeAtomic(path, 'new\n', 0o644);
    expect(await readFile(path, 'utf8')).toBe('new\n');
    expect(await readdir(dir)).toEqual(['a.json']);
  });

  it('keeps the mode it is given', async () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'a.json');
    await writeAtomic(path, 'x', 0o600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  links('replaces a link that appeared in between, never writing through it', async () => {
    const target = join(outside, 'victim');
    await writeFile(target, 'untouched');
    await symlink(target, join(dir, 'a'));
    await writeAtomic(join(dir, 'a'), 'mine', 0o644);
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });
});
