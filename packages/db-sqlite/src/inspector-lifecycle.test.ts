/**
 * Tester probes for the snapshot inspector: copies dropped on refresh and close even
 * when a copy is still being taken (design note, Privacy: memory only, gone on detach).
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from './engine.js';
import { SqliteSnapshotInspector } from './inspector.js';
import { FakeSnapshotSource } from './testing/fake-source.js';
import { plainDbFixture } from './testing/fixtures.js';

const BUILT_WORKER = new URL('../dist/worker.js', import.meta.url);
const NAME = 'app_flutter/app.sqlite';
const made: SnapshotEngine[] = [];
const engine = (): SnapshotEngine => {
  const e = new SnapshotEngine({ workerUrl: BUILT_WORKER });
  made.push(e);
  return e;
};
const workerOf = (e: SnapshotEngine): Worker | undefined =>
  Reflect.get(e, 'worker') as Worker | undefined;
const bytesOf = (e: SnapshotEngine): Uint8Array | undefined =>
  Reflect.get(e, 'bytes') as Uint8Array | undefined;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A source whose whole-file reads wait until `release()` is called. */
class SlowSource extends FakeSnapshotSource {
  private gate: Promise<void>;
  release: () => void = () => undefined;

  constructor(files: Record<string, Buffer>) {
    super(files);
    this.gate = new Promise((r) => {
      this.release = r;
    });
  }

  override async read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    await this.gate;
    return super.read(path, maxBytes);
  }
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((e) => e.close()));
});

describe('SqliteSnapshotInspector lifecycle (tester probes)', { timeout: 30_000 }, () => {
  it('DB-5: drops a copy that finishes after close: no engine keeps the bytes', async () => {
    const source = new SlowSource({ [NAME]: plainDbFixture() });
    const db = new SqliteSnapshotInspector(() => Promise.resolve(source), { engine });
    const pending = db.query(NAME, 'SELECT count(*) FROM orders').then(
      () => 'answered after close',
      (err: unknown) => (err as { code?: string }).code,
    );
    await tick(5);
    const closing = db.close();
    source.release();
    await closing;
    const outcome = await pending;
    await tick(50);
    expect(outcome).not.toBe('answered after close');
    for (const e of made) {
      expect(workerOf(e)).toBeUndefined();
      expect(bytesOf(e)).toBeUndefined();
    }
  });

  it('drops the old copy on refresh and reads a new one next time', async () => {
    const source = new FakeSnapshotSource({ [NAME]: plainDbFixture() });
    const db = new SqliteSnapshotInspector(() => Promise.resolve(source), { engine });
    await db.query(NAME, 'SELECT 1');
    expect(made).toHaveLength(1);
    const [first] = made;
    await db.refresh(NAME);
    expect(first === undefined ? 'none' : bytesOf(first)).toBeUndefined();
    expect(first === undefined ? 'none' : workerOf(first)).toBeUndefined();
    await db.query(NAME, 'SELECT 1');
    expect(made).toHaveLength(2);
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(2);
    await db.close();
  });

  it('closes every engine it made on close, with no worker left running', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: plainDbFixture(),
      'databases/legacy.db': plainDbFixture(),
    });
    const db = new SqliteSnapshotInspector(() => Promise.resolve(source), { engine });
    await db.query(NAME, 'SELECT 1');
    await db.query('databases/legacy.db', 'SELECT 1');
    await db.close();
    expect(made).toHaveLength(2);
    for (const e of made) {
      expect(workerOf(e)).toBeUndefined();
      expect(bytesOf(e)).toBeUndefined();
    }
    await expect(db.listDatabases()).rejects.toMatchObject({ code: 'app-gone' });
  });

  it('takes one copy for calls that overlap, not one each', async () => {
    const source = new SlowSource({ [NAME]: plainDbFixture() });
    const db = new SqliteSnapshotInspector(() => Promise.resolve(source), { engine });
    const calls = [db.schema(NAME), db.query(NAME, 'SELECT 1'), db.schemaSql(NAME)];
    source.release();
    await Promise.all(calls);
    expect(source.reads.filter((r) => r === NAME)).toHaveLength(1);
    expect(made).toHaveLength(1);
    await db.close();
  });
});
