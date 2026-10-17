/** Review R5: tagged integer parameters bind as 64-bit integers, never wrapped. */
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { FakeLiveDatabase } from './testing/fake-live.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const open: FakeLiveDatabase[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function make(): Promise<FakeLiveDatabase> {
  const db = await FakeLiveDatabase.create(
    'app',
    [
      'CREATE TABLE ids (k PRIMARY KEY, v TEXT) WITHOUT ROWID',
      "INSERT INTO ids VALUES (9223372036854775807, 'max')",
    ],
    { engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }) },
  );
  open.push(db);
  return db;
}

describe('tagged integer parameters', { timeout: 20_000 }, () => {
  it('bind the largest 64-bit integer exactly', async () => {
    const db = await make();
    const res = await db.query('app', 'SELECT v FROM ids WHERE k IS ?', [
      { type: 'int', value: '9223372036854775807' },
    ]);
    expect(res.rows).toEqual([['max']]);
  });

  it('refuse a value past the 64-bit range instead of wrapping it', async () => {
    const db = await make();
    for (const value of ['9223372036854775808', '-9223372036854775809', '18446744073709551615']) {
      await expect(
        db.query('app', 'SELECT v FROM ids WHERE k IS ?', [{ type: 'int', value }]),
        value,
      ).rejects.toMatchObject({ code: 'refused' });
    }
  });
});
