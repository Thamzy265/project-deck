import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUERIES_FILE, SavedQueryStore } from './saved-queries.js';

let projectDir: string;
let outside: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-queries-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-queries-out-'));
});

afterEach(async () => {
  for (const dir of [projectDir, outside]) await rm(dir, { recursive: true, force: true });
});

const path = () => join(projectDir, '.flutterdeck', QUERIES_FILE);

describe('SavedQueryStore (.flutterdeck/queries.json)', () => {
  it('reads no queries when the file is missing, then keeps what it wrote', async () => {
    const store = new SavedQueryStore(projectDir);
    expect(await store.read()).toEqual([]);
    const queries = [{ name: 'Pending', sql: "SELECT * FROM orders WHERE status = 'pending'" }];
    await store.write(queries);
    expect(await store.read()).toEqual(queries);
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({ version: 1, queries });
    // No temp files left behind.
    expect(await readdir(join(projectDir, '.flutterdeck'))).toEqual([QUERIES_FILE]);
  });

  it('says the file is broken instead of guessing, and never quotes it', async () => {
    await mkdir(join(projectDir, '.flutterdeck'));
    await writeFile(path(), '{"queries": "secret text"');
    const err: unknown = await new SavedQueryStore(projectDir).read().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal' });
    expect((err as Error).message).not.toContain('secret');
    await writeFile(path(), JSON.stringify({ version: 1, queries: [{ name: '', sql: '' }] }));
    await expect(new SavedQueryStore(projectDir).read()).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'never reads or writes through a link planted by a cloned repo',
    async () => {
      const target = join(outside, 'notes.txt');
      await writeFile(target, 'my notes\n');
      await mkdir(join(projectDir, '.flutterdeck'));
      await symlink(target, path());
      const store = new SavedQueryStore(projectDir);
      await expect(store.read()).rejects.toMatchObject({ code: 'internal' });
      await store.write([{ name: 'a', sql: 'SELECT 1' }]);
      expect(await readFile(target, 'utf8')).toBe('my notes\n');
      expect(await store.read()).toEqual([{ name: 'a', sql: 'SELECT 1' }]);
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a .flutterdeck that is a link', async () => {
    await symlink(outside, join(projectDir, '.flutterdeck'));
    const store = new SavedQueryStore(projectDir);
    await expect(store.write([{ name: 'a', sql: 'SELECT 1' }])).rejects.toMatchObject({
      code: 'internal',
    });
    expect(await readdir(outside)).toEqual([]);
  });
});
