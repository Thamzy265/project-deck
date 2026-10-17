/**
 * Tester probe: a NULL parameter. The dashboard binds null when the user ticks "null"
 * in the row editor, and when a row's key holds NULL (row details reads it again by key).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { FakeLiveDatabase } from './testing/fake-live.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const TOKEN = 'a'.repeat(43);
const open: FakeLiveDatabase[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function make(): Promise<FakeLiveDatabase> {
  const db = await FakeLiveDatabase.create(
    'app',
    [
      'CREATE TABLE codes (code TEXT PRIMARY KEY, v TEXT)',
      "INSERT INTO codes VALUES (NULL, 'a'), ('x', 'c')",
    ],
    { engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }) },
  );
  open.push(db);
  return db;
}

describe('null parameters', { timeout: 20_000 }, () => {
  it('a confirmed edit can set a value to NULL', async () => {
    const db = await make();
    await expect(
      db.execute('app', 'UPDATE "codes" SET "v" = ? WHERE "code" IS ?', [null, 'x'], {
        token: TOKEN,
      }),
    ).resolves.toEqual({ changes: 1 });
  });

  it('the snapshot engine reads with a NULL parameter', async () => {
    const db = await make();
    const res = await db.query('app', 'SELECT "v" FROM "codes" WHERE "code" IS ?', [null]);
    expect(res.rows).toEqual([['a']]);
  });
});
