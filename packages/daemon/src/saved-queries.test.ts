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
    await store.replace(queries, 'none');
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
      // A file it can't read is never replaced: the link stays, and so do the notes.
      await expect(store.replace([{ name: 'a', sql: 'SELECT 1' }], 'none')).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await readFile(target, 'utf8')).toBe('my notes\n');
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a .flutterdeck that is a link', async () => {
    await symlink(outside, join(projectDir, '.flutterdeck'));
    const store = new SavedQueryStore(projectDir);
    await expect(store.replace([{ name: 'a', sql: 'SELECT 1' }], 'none')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('SavedQueryStore: file mode, races and odd files (tester probes)', () => {
  it.skipIf(process.platform === 'win32')(
    'writes queries.json readable by its owner only (0600), like runtime.json',
    async () => {
      const { stat } = await import('node:fs/promises');
      await new SavedQueryStore(projectDir).replace([{ name: 'a', sql: 'SELECT 1' }], 'none');
      expect((await stat(path())).mode & 0o777).toBe(0o600);
    },
  );

  it('keeps one whole list when many saves race, with no temp files left', async () => {
    const store = new SavedQueryStore(projectDir);
    const lists = Array.from({ length: 20 }, (_, i) => [{ name: `q${i}`, sql: `SELECT ${i}` }]);
    // From one revision: one save wins, the others are refused, none is torn.
    await Promise.allSettled(lists.map((l) => store.replace(l, 'none')));
    const read = await store.read();
    expect(lists).toContainEqual(read);
    expect(await readdir(join(projectDir, '.flutterdeck'))).toEqual([QUERIES_FILE]);
  });

  it('says the file is broken for a directory, a huge file or a wrong version', async () => {
    await mkdir(join(projectDir, '.flutterdeck'));
    await mkdir(path());
    await expect(new SavedQueryStore(projectDir).read()).rejects.toMatchObject({
      code: 'internal',
    });
    await rm(path(), { recursive: true });
    await writeFile(path(), `{"version":1,"queries":[],"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    await expect(new SavedQueryStore(projectDir).read()).rejects.toMatchObject({
      code: 'internal',
    });
    await writeFile(path(), JSON.stringify({ version: 2, queries: [] }));
    await expect(new SavedQueryStore(projectDir).read()).rejects.toMatchObject({
      code: 'internal',
    });
  });
});

describe('SavedQueryStore: revisions (review R1)', () => {
  it('names the file by a revision, and replaces it only from that revision', async () => {
    const store = new SavedQueryStore(projectDir);
    const empty = await store.state();
    expect(empty).toEqual({ queries: [], revision: 'none' });
    const a = await store.replace([{ name: 'a', sql: 'SELECT 1' }], empty.revision);
    expect(a.queries).toEqual([{ name: 'a', sql: 'SELECT 1' }]);
    expect(a.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.state()).toEqual(a);
    // A tab that read the empty list can't overwrite what another tab saved since.
    await expect(store.replace([{ name: 'b', sql: 'SELECT 2' }], 'none')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await store.state()).queries).toEqual([{ name: 'a', sql: 'SELECT 1' }]);
  });

  it('lets one of two saves from the same revision win, and refuses the other', async () => {
    const store = new SavedQueryStore(projectDir);
    const results = await Promise.allSettled([
      store.replace([{ name: 'a', sql: 'SELECT 1' }], 'none'),
      store.replace([{ name: 'b', sql: 'SELECT 2' }], 'none'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('never replaces a file it can not read', async () => {
    await mkdir(join(projectDir, '.flutterdeck'));
    await writeFile(path(), '{"broken');
    const store = new SavedQueryStore(projectDir);
    await expect(store.state()).rejects.toMatchObject({ code: 'internal' });
    await expect(store.replace([{ name: 'a', sql: 'SELECT 1' }], 'none')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await readFile(path(), 'utf8')).toBe('{"broken');
  });
});

describe('SavedQueryStore: callers (review N2)', () => {
  it('offers only the conditional save', () => {
    const store = new SavedQueryStore(projectDir);
    // @ts-expect-error -- write() is the store's own: callers save with replace().
    expect(typeof store.write).toBe('function');
  });
});
