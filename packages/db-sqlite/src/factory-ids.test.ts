import { FIXTURE_SERIAL, FakeAdb } from '@project-deck/android-adb/testing';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import type { SnapshotIds } from './factory.js';
import { SqliteSnapshotFactory } from './factory.js';
import { plainDbFixture } from './testing/fixtures.js';

describe('SqliteSnapshotFactory ids (R11)', () => {
  it('reads config.json ids when the backend is used, so an edit applies without a restart', async () => {
    let ids: SnapshotIds = {};
    let reads = 0;
    const adb = new FakeAdb({
      devices: `List of devices attached\n${FIXTURE_SERIAL}\tdevice\n\n`,
      files: { [FIXTURE_SERIAL]: { 'com.example.later': { 'databases/a.db': plainDbFixture() } } },
    });
    const factory = new SqliteSnapshotFactory({
      adb,
      ids: () => {
        reads++;
        return Promise.resolve(ids);
      },
    });
    // No pid and no id yet: the app can't be found.
    const app = fakeApp({ name: 'shop' });
    const db = await factory.create(app);
    await expect(db?.listDatabases()).rejects.toMatchObject({ code: 'unavailable' });
    // The user sets android.applicationId; the next use reads it.
    ids = { androidApplicationId: 'com.example.later' };
    expect(await db?.listDatabases()).toEqual([{ name: 'databases/a.db', backend: 'snapshot' }]);
    expect(reads).toBeGreaterThanOrEqual(2);
    await db?.close?.();
  });
});
