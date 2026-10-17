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

/** Whole-file reads wait for `release()`, each time a new copy starts. */
class GatedSource extends FakeSnapshotSource {
  private gate: Promise<void> = Promise.resolve();
  private open: () => void = () => undefined;

  hold(): void {
    this.gate = new Promise((r) => {
      this.open = r;
    });
  }

  release(): void {
    this.open();
  }

  override async read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    await this.gate;
    return super.read(path, maxBytes);
  }
}

function inspector(source: FakeSnapshotSource): SqliteSnapshotInspector {
  const db = new SqliteSnapshotInspector(() => Promise.resolve(source), {
    engine: () => new SnapshotEngine({ workerUrl: BUILT_WORKER }),
  });
  open.push(db);
  return db;
}

describe('SqliteSnapshotInspector refresh while calls wait (R3)', { timeout: 20_000 }, () => {
  it('answers a call whose copy was replaced by Refresh, never with app-gone', async () => {
    const source = new GatedSource({ [NAME]: plainDbFixture() });
    const db = inspector(source);
    source.hold();
    const waiting = db.query(NAME, 'SELECT count(*) FROM orders');
    await new Promise((r) => setTimeout(r, 10));
    const refreshed = db.refresh(NAME);
    source.release();
    await refreshed;
    expect((await waiting).rows).toEqual([[2]]);
  });

  it('serves concurrent snapshots, diffs, schema reads and queries', async () => {
    const db = inspector(new FakeSnapshotSource({ [NAME]: plainDbFixture() }));
    const results = await Promise.allSettled([
      db.rowHashes(NAME),
      db.rowHashes(NAME),
      db.schema(NAME),
      db.query(NAME, 'SELECT 1'),
      db.rowHashes(NAME),
      db.rowsByKey(NAME, 'orders', [1]),
    ]);
    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures).toEqual([]);
  });

  it('still answers app-gone after close', async () => {
    const source = new GatedSource({ [NAME]: plainDbFixture() });
    const db = inspector(source);
    source.hold();
    const waiting = db.query(NAME, 'SELECT 1');
    await new Promise((r) => setTimeout(r, 10));
    const closing = db.close();
    source.release();
    await closing;
    await expect(waiting).rejects.toMatchObject({ code: 'app-gone' });
  });
});
