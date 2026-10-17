import { describe, expect, it } from 'vitest';
import { copyDatabase } from './copy.js';
import { FakeSnapshotSource } from './testing/fake-source.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';

const MB = 1024 * 1024;
const NAME = 'app_flutter/app.sqlite';

function hotJournal(): Buffer {
  const j = Buffer.alloc(512);
  Buffer.from('d9d505f920a163d7', 'hex').copy(j);
  return j;
}

describe('copyDatabase', () => {
  it('copies the main file and its WAL and merges them', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: walDbFixture(),
      [`${NAME}-wal`]: walFixture(),
    });
    const image = await copyDatabase(source, NAME, 50 * MB);
    expect(image.length).toBe(walDbFixture().length);
    expect([image[18], image[19]]).toEqual([1, 1]);
  });

  it('retries when the change counter moves during the copy, then succeeds', async () => {
    const source = new FakeSnapshotSource({ [NAME]: plainDbFixture() });
    let writes = 1;
    source.afterRead = (path) => {
      if (path === NAME && writes-- > 0) {
        const next = Buffer.from(plainDbFixture());
        next.writeUInt32BE(next.readUInt32BE(24) + 1, 24);
        source.files[NAME] = next;
      }
    };
    await expect(copyDatabase(source, NAME, 50 * MB)).resolves.toBeDefined();
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(2);
  });

  it('says the app is writing after three copies that kept changing', async () => {
    const source = new FakeSnapshotSource({ [NAME]: plainDbFixture() });
    let counter = 100;
    source.afterRead = (path) => {
      if (path !== NAME) return;
      const next = Buffer.from(plainDbFixture());
      next.writeUInt32BE(counter++, 24);
      source.files[NAME] = next;
    };
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({
      code: 'busy',
      message: 'The app is writing; try Refresh.',
    });
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(3);
  });

  it('retries while a hot rollback journal says a write is in progress', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: plainDbFixture(),
      [`${NAME}-journal`]: hotJournal(),
    });
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({ code: 'busy' });
    // Never copied: nothing partial is ever shown.
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(0);
    // A journal left with a zeroed header (PERSIST mode) is not a write in progress.
    source.files[`${NAME}-journal`] = Buffer.alloc(512);
    await expect(copyDatabase(source, NAME, 50 * MB)).resolves.toBeDefined();
  });

  it('retries when the WAL restarts (new salts) during the copy', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: walDbFixture(),
      [`${NAME}-wal`]: walFixture(),
    });
    let restarts = 1;
    source.afterRead = (path) => {
      if (path === `${NAME}-wal` && restarts-- > 0) {
        const wal = Buffer.from(walFixture());
        wal.writeUInt32BE((wal.readUInt32BE(16) + 1) >>> 0, 16);
        source.files[`${NAME}-wal`] = wal;
      }
    };
    await expect(copyDatabase(source, NAME, 50 * MB)).resolves.toBeDefined();
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(2);
  });

  it('counts the database and its WAL together in the cap', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: walDbFixture(),
      [`${NAME}-wal`]: walFixture(),
    });
    await expect(copyDatabase(source, NAME, walDbFixture().length + 100)).rejects.toMatchObject({
      code: 'too-large',
      message: expect.stringContaining('50 MB') as unknown,
    });
  });

  it('refuses a file that is not a SQLite database without retrying', async () => {
    const source = new FakeSnapshotSource({ [NAME]: Buffer.from('not a database'.repeat(20)) });
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('says the database is gone when the file disappeared', async () => {
    const source = new FakeSnapshotSource({});
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({ code: 'not-found' });
  });
});
