import { DbError } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { SqliteSnapshotInspector } from './inspector.js';
import { FakeSnapshotSource } from './testing/fake-source.js';
import { plainDbFixture } from './testing/fixtures.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const NAME = 'app_flutter/app.sqlite';
const made: SnapshotEngine[] = [];
const open: SqliteSnapshotInspector[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
  made.length = 0;
});

function inspector(): SqliteSnapshotInspector {
  const db = new SqliteSnapshotInspector(
    () => Promise.resolve(new FakeSnapshotSource({ [NAME]: plainDbFixture() })),
    {
      engine: () => {
        const e = new SnapshotEngine({ workerUrl: BUILT_WORKER });
        made.push(e);
        return e;
      },
    },
  );
  open.push(db);
  return db;
}

describe('SqliteSnapshotInspector schema (R6)', { timeout: 20_000 }, () => {
  it('tries the schema again after a failed read instead of keeping the failure', async () => {
    const db = inspector();
    await db.query(NAME, 'SELECT 1');
    const [engine] = made;
    if (engine === undefined) throw new Error('no engine');
    const real = engine.schema.bind(engine);
    vi.spyOn(engine, 'schema')
      .mockRejectedValueOnce(new DbError('timeout', 'That query took too long and was stopped.'))
      .mockImplementation(real);
    await expect(db.schema(NAME)).rejects.toMatchObject({ code: 'timeout' });
    expect((await db.schema(NAME)).map((t) => t.name)).toEqual(['orders']);
  });

  it('serves the schema SQL for the gate without counting rows', async () => {
    const db = inspector();
    await db.query(NAME, 'SELECT 1');
    const [engine] = made;
    if (engine === undefined) throw new Error('no engine');
    const schema = vi.spyOn(engine, 'schema');
    expect(await db.schemaSql(NAME)).toEqual([
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, status TEXT NOT NULL)',
    ]);
    expect(schema).not.toHaveBeenCalled();
  });
});

describe('SqliteSnapshotInspector query pinning (R8)', { timeout: 20_000 }, () => {
  it('refuses a query when the copy no longer has the schema the gate checked', async () => {
    const db = inspector();
    const checked = await db.schemaSql(NAME);
    expect((await db.query(NAME, 'SELECT 1', [], { checkedSchemaSql: checked })).rows).toEqual([
      [1],
    ]);
    await expect(
      db.query(NAME, 'SELECT 1', [], { checkedSchemaSql: ['CREATE TABLE other(x)'] }),
    ).rejects.toMatchObject({ code: 'busy' });
  });
});
