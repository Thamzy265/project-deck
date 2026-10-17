import {
  FIXTURE_PACKAGE,
  FIXTURE_PID,
  FIXTURE_SERIAL,
  FakeAdb,
} from '@project-deck/android-adb/testing';
import { Registry, diffTableHashes } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { SqliteSnapshotFactory, registerSqliteSnapshots } from './factory.js';
import { SqliteSnapshotInspector } from './inspector.js';
import { FakeSnapshotSource } from './testing/fake-source.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const engine = () => new SnapshotEngine({ workerUrl: BUILT_WORKER });
const NAME = 'app_flutter/app.sqlite';
const open: SqliteSnapshotInspector[] = [];

function inspector(
  source: FakeSnapshotSource,
  now = () => 1_760_000_000_000,
): SqliteSnapshotInspector {
  const db = new SqliteSnapshotInspector(() => Promise.resolve(source), { engine, now });
  open.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

describe('SqliteSnapshotInspector', { timeout: 20_000 }, () => {
  it('lists database files as snapshots, and copies one on first use', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: walDbFixture(),
      [`${NAME}-wal`]: walFixture(),
      'databases/legacy.db': plainDbFixture(),
    });
    const db = inspector(source);
    expect(db).toMatchObject({ id: 'sqlite-file', live: false, writable: false });
    expect('execute' in db).toBe(false);
    expect('watch' in db).toBe(false);
    expect(await db.listDatabases()).toEqual([
      { name: NAME, backend: 'snapshot' },
      { name: 'databases/legacy.db', backend: 'snapshot' },
    ]);
    expect((await db.schema(NAME)).map((t) => t.name)).toContain('orders');
    expect(await db.listDatabases()).toContainEqual({
      name: NAME,
      backend: 'snapshot',
      takenAt: 1_760_000_000_000,
    });
    expect((await db.query(NAME, 'SELECT count(*) FROM orders')).rows).toEqual([[3]]);
    expect(await db.schemaSql(NAME)).toContain('CREATE TABLE sqlite_sequence(name,seq)');
    // One copy served all of that.
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(1);
  });

  it('reads the same copy until Refresh, then takes a new one', async () => {
    const source = new FakeSnapshotSource({ [NAME]: plainDbFixture() });
    let now = 1000;
    const db = inspector(source, () => now);
    expect((await db.query(NAME, 'SELECT count(*) FROM orders')).rows).toEqual([[2]]);
    source.files[NAME] = Buffer.from(walDbFixture());
    source.files[`${NAME}-wal`] = walFixture();
    expect((await db.query(NAME, 'SELECT count(*) FROM orders')).rows).toEqual([[2]]);
    now = 2000;
    await db.refresh(NAME);
    expect((await db.query(NAME, 'SELECT count(*) FROM orders')).rows).toEqual([[3]]);
    expect(await db.listDatabases()).toContainEqual({
      name: NAME,
      backend: 'snapshot',
      takenAt: 2000,
    });
  });

  it('hashes a fresh copy for diffs, so a diff sees what changed since', async () => {
    const source = new FakeSnapshotSource({ [NAME]: walDbFixture() });
    const db = inspector(source);
    const before = await db.rowHashes(NAME);
    source.files[`${NAME}-wal`] = walFixture();
    const after = await db.rowHashes(NAME);
    const orders = (h: typeof before) => h.tables.find((t) => t.name === 'orders');
    const b = orders(before);
    const a = orders(after);
    if (b === undefined || a === undefined || 'error' in b || 'error' in a)
      throw new Error('no orders');
    expect(diffTableHashes(b, a)).toEqual({
      added: [3],
      removed: [],
      changed: [{ key: 1, columns: ['status'] }],
    });
    expect((await db.rowsByKey(NAME, 'orders', [3])).rows).toEqual([
      [3, [3, 'Cake', 'pending', 1760000002000]],
    ]);
  });

  it('refuses names that are not database files in the fixed folders', async () => {
    const db = inspector(new FakeSnapshotSource({ [NAME]: plainDbFixture() }));
    for (const name of ['app', '../x.db', 'app_flutter/x.txt', 'shared_prefs/x.db']) {
      await expect(db.schema(name), name).rejects.toMatchObject({ code: 'not-found' });
    }
  });

  it('passes on a source that cannot be found, and tries it again next time', async () => {
    let fail = true;
    const db = new SqliteSnapshotInspector(
      () =>
        fail
          ? Promise.reject(Object.assign(new Error('x'), { code: 'not-debuggable' }))
          : Promise.resolve(new FakeSnapshotSource({ [NAME]: plainDbFixture() })),
      { engine },
    );
    open.push(db);
    await expect(db.listDatabases()).rejects.toThrow();
    fail = false;
    expect(await db.listDatabases()).toHaveLength(1);
  });

  it('forgets every copy on close (nothing stays in memory)', async () => {
    const source = new FakeSnapshotSource({ [NAME]: plainDbFixture() });
    const db = inspector(source);
    await db.schema(NAME);
    await db.close();
    await expect(db.query(NAME, 'SELECT 1')).rejects.toMatchObject({ code: 'app-gone' });
  });
});

describe('SqliteSnapshotFactory', () => {
  it('serves Android apps through adb, and iOS apps only on macOS', async () => {
    const factory = new SqliteSnapshotFactory({
      adb: new FakeAdb({
        files: { [FIXTURE_SERIAL]: { [FIXTURE_PACKAGE]: { [NAME]: plainDbFixture() } } },
      }),
      engine,
      platform: 'linux',
    });
    const android = await factory.create(fakeApp({ pid: FIXTURE_PID }));
    if (android !== undefined) open.push(android as SqliteSnapshotInspector);
    expect(await android?.listDatabases()).toEqual([{ name: NAME, backend: 'snapshot' }]);
    expect(
      await factory.create(fakeApp({ device: { id: 'x', name: 'iPhone', platform: 'ios' } })),
    ).toBeUndefined();
    expect(
      await factory.create(fakeApp({ device: { id: 'x', name: 'Mac', platform: 'desktop' } })),
    ).toBeUndefined();
    const mac = new SqliteSnapshotFactory({ engine, platform: 'darwin' });
    const ios = await mac.create(fakeApp({ device: { id: 'x', name: 'iPhone', platform: 'ios' } }));
    expect(ios?.id).toBe('sqlite-file');
    await ios?.close?.();
  });

  it('reports a release build as not debuggable', async () => {
    const factory = new SqliteSnapshotFactory({
      adb: new FakeAdb({ files: { [FIXTURE_SERIAL]: { [FIXTURE_PACKAGE]: 'not-debuggable' } } }),
      engine,
    });
    const db = await factory.create(fakeApp({ pid: FIXTURE_PID }));
    await expect(db?.listDatabases()).rejects.toMatchObject({ code: 'not-debuggable' });
    await db?.close?.();
  });

  it('registers through the Registry', () => {
    const registry = new Registry();
    const undo = registerSqliteSnapshots(registry, { engine });
    expect(registry.dbInspectors.get('sqlite-file')).toBeInstanceOf(SqliteSnapshotFactory);
    undo();
    expect(registry.dbInspectors.get('sqlite-file')).toBeUndefined();
  });
});
