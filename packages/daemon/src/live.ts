import { DartConnector } from '@project-deck/connector-dart';
import type { Registry } from '@project-deck/core';
import { registerDrift } from '@project-deck/db-drift';
import type { SnapshotIds } from '@project-deck/db-sqlite';
import { registerSqliteSnapshots } from '@project-deck/db-sqlite';
import { AndroidLogFeed } from '@project-deck/logs-android';
import type { ConnectorUris } from './uri-options.js';

/** The real implementations the daemon uses outside `--fake`. Constructing them starts nothing. */
export function registerLive(
  registry: Registry,
  uris: ConnectorUris,
  log: (message: string, err?: unknown) => void,
  snapshotIds: () => SnapshotIds = () => ({}),
): void {
  // Before the connector: it reads the allowed extension prefixes when it calls one.
  registerDrift(registry);
  registry.connectors.register(
    new DartConnector({ ...uris, log, extensionPrefixes: () => registry.extensionPrefixes() }),
  );
  registry.logFeeds.register(new AndroidLogFeed({ log }));
  registerSqliteSnapshots(registry, { ids: snapshotIds });
}
