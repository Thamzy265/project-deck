import type { DbInspectorFactory } from '@project-deck/core';
import { SqliteSnapshotInspector } from '../inspector.js';
import { FakeSnapshotSource } from './fake-source.js';
import { plainDbFixture, walDbFixture, walFixture } from './fixtures.js';

export * from './fake-source.js';
export * from './image.js';
export * from './fixtures.js';

/**
 * A snapshot factory for the daemon's fake mode: every app gets the fixture files of a
 * fake device, read with the real engine. The files are read here, at daemon start, so a
 * bundle missing one fails with IncompleteBundleError instead of a database that answers
 * "not found" (finding F7).
 */
export function fakeSnapshotFactory(): DbInspectorFactory {
  const files: Record<string, Buffer> = {
    'app_flutter/app.sqlite': walDbFixture(),
    'app_flutter/app.sqlite-wal': walFixture(),
    'databases/legacy.db': plainDbFixture(),
  };
  // Each source gets its own copies, as it did when it read the files itself.
  const copies = () =>
    Object.fromEntries(Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]));
  return {
    id: 'sqlite-file',
    create: () =>
      Promise.resolve(
        new SqliteSnapshotInspector(() => Promise.resolve(new FakeSnapshotSource(copies()))),
      ),
  };
}
export * from './fake-live.js';
