import { DbError } from '@project-deck/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { SqliteSnapshotInspector } from './inspector.js';
import { FakeSnapshotSource } from './testing/fake-source.js';
import { plainDbFixture } from './testing/fixtures.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const NAME = 'app_flutter/app.sqlite';
const open: SqliteSnapshotInspector[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const devices = [
  { id: 'emulator-5554', name: 'emulator-5554' },
  { id: 'R58M123ABC', name: 'R58M123ABC' },
];

describe('SqliteSnapshotInspector.chooseDevice', { timeout: 20_000 }, () => {
  it('asks the source again with the device the user chose', async () => {
    const asked: (string | undefined)[] = [];
    const db = new SqliteSnapshotInspector(
      (chosen) => {
        asked.push(chosen);
        return chosen === 'R58M123ABC'
          ? Promise.resolve(new FakeSnapshotSource({ [NAME]: plainDbFixture() }))
          : Promise.reject(new DbError('choose-device', 'Pick one.', { devices }));
      },
      { engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }) },
    );
    open.push(db);
    await expect(db.listDatabases()).rejects.toMatchObject({ code: 'choose-device', devices });
    await db.chooseDevice('R58M123ABC');
    expect(await db.listDatabases()).toEqual([{ name: NAME, backend: 'snapshot' }]);
    expect(asked).toEqual([undefined, 'R58M123ABC']);
  });

  it('drops the copy from the old device', async () => {
    const sources = {
      a: new FakeSnapshotSource({ [NAME]: plainDbFixture() }),
      b: new FakeSnapshotSource({ [NAME]: plainDbFixture() }),
    };
    const db = new SqliteSnapshotInspector(
      (chosen) => Promise.resolve(chosen === 'b' ? sources.b : sources.a),
      { engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }) },
    );
    open.push(db);
    await db.query(NAME, 'SELECT 1');
    await db.chooseDevice('b');
    await db.query(NAME, 'SELECT 1');
    expect(sources.a.reads).toEqual([NAME]);
    expect(sources.b.reads).toEqual([NAME]);
  });

  it('refuses a device id that no device could have', async () => {
    const db = new SqliteSnapshotInspector(() =>
      Promise.resolve(new FakeSnapshotSource({ [NAME]: plainDbFixture() })),
    );
    open.push(db);
    for (const id of ['', 'a b', 'x'.repeat(129), '-s']) {
      await expect(db.chooseDevice(id), id).rejects.toMatchObject({ code: 'not-found' });
    }
  });
});
