import type { DbInspectorFactory } from '@project-deck/core';
import { SqliteSnapshotInspector } from '../inspector.js';
import { FakeSnapshotSource } from './fake-source.js';
import { plainDbFixture, walDbFixture, walFixture } from './fixtures.js';

export * from './fake-source.js';
export * from './image.js';
export * from './fixtures.js';

/**
 * A snapshot factory for the daemon's fake mode: every app gets the fixture files of a
 * fake device, read with the real engine.
 */
export function fakeSnapshotFactory(): DbInspectorFactory {
  return {
    id: 'sqlite-file',
    create: () =>
      Promise.resolve(
        new SqliteSnapshotInspector(() =>
          Promise.resolve(
            new FakeSnapshotSource({
              'app_flutter/app.sqlite': walDbFixture(),
              'app_flutter/app.sqlite-wal': walFixture(),
              'databases/legacy.db': plainDbFixture(),
            }),
          ),
        ),
      ),
  };
}
export * from './fake-live.js';
