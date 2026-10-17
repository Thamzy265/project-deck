import type { AdbRunner } from '@project-deck/android-adb';
import { FIXTURE_PACKAGE, FIXTURE_SERIAL, FakeAdb } from '@project-deck/android-adb/testing';
import { describe, expect, it } from 'vitest';
import { AndroidSource } from './android.js';
import { copyDatabase } from './copy.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';

const MB = 1024 * 1024;
const NAME = 'app_flutter/app.sqlite';

function source(files: Record<string, Buffer> | 'not-debuggable'): AndroidSource {
  const adb = new FakeAdb({ files: { [FIXTURE_SERIAL]: { [FIXTURE_PACKAGE]: files } } });
  return new AndroidSource(adb, FIXTURE_SERIAL, FIXTURE_PACKAGE);
}

describe('AndroidSource over exec-out, which mixes stderr into stdout (R2)', () => {
  it('copies a database that has no -wal or -journal next to it', async () => {
    const image = await copyDatabase(source({ [NAME]: plainDbFixture() }), NAME, 50 * MB);
    expect(image.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('copies a database with its WAL', async () => {
    const files = { [NAME]: walDbFixture(), [`${NAME}-wal`]: walFixture() };
    await expect(copyDatabase(source(files), NAME, 50 * MB)).resolves.toBeDefined();
  });

  it('reads at most the bytes asked from head, whatever adb printed', async () => {
    const s = source({ [NAME]: plainDbFixture() });
    expect(await s.head(`${NAME}-journal`, 28)).toBeUndefined();
    expect((await s.head(NAME, 16))?.length).toBe(16);
  });

  it('says the app is not debuggable from ls, head and cat output alike', async () => {
    const s = source('not-debuggable');
    await expect(s.list()).rejects.toMatchObject({ code: 'not-debuggable' });
    await expect(s.head(NAME, 100)).rejects.toMatchObject({ code: 'not-debuggable' });
    await expect(s.read(NAME, 50 * MB)).rejects.toMatchObject({ code: 'not-debuggable' });
  });

  it('reports other cat or head complaints as a failed read, never as data', async () => {
    const said = (text: string): AdbRunner => ({
      exec: () => Promise.resolve(text),
      execBinary: () => Promise.resolve(Buffer.from(text)),
      stream: () => ({ kill: () => undefined }),
    });
    const s = new AndroidSource(
      said('cat: app_flutter/app.sqlite: Permission denied\n'),
      FIXTURE_SERIAL,
      FIXTURE_PACKAGE,
    );
    await expect(s.read(NAME, 50 * MB)).rejects.toMatchObject({ code: 'unavailable' });
    const h = new AndroidSource(
      said('head: app_flutter/app.sqlite: Is a directory\n'),
      FIXTURE_SERIAL,
      FIXTURE_PACKAGE,
    );
    await expect(h.head(NAME, 100)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
