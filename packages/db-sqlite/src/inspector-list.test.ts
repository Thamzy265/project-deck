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

/** A source whose whole-file reads wait until released. */
class SlowSource extends FakeSnapshotSource {
  release: () => void = () => undefined;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });

  override async read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    await this.gate;
    return super.read(path, maxBytes);
  }
}

describe('SqliteSnapshotInspector.listDatabases (R10)', { timeout: 20_000 }, () => {
  it('answers at once while a copy is still being taken, with only finished copies dated', async () => {
    const source = new SlowSource({ [NAME]: plainDbFixture() });
    const db = new SqliteSnapshotInspector(() => Promise.resolve(source), {
      engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }),
      now: () => 42,
    });
    open.push(db);
    const copying = db.query(NAME, 'SELECT 1');
    await new Promise((r) => setTimeout(r, 20));
    const listed = await Promise.race([
      db.listDatabases(),
      new Promise((r) => setTimeout(() => r('waited for the copy'), 1000)),
    ]);
    expect(listed).toEqual([{ name: NAME, backend: 'snapshot' }]);
    source.release();
    await copying;
    expect(await db.listDatabases()).toEqual([{ name: NAME, backend: 'snapshot', takenAt: 42 }]);
  });
});
