import { DartConnector } from '@project-deck/connector-dart';
import type { Registry } from '@project-deck/core';
import { AndroidLogFeed } from '@project-deck/logs-android';
import type { ConnectorUris } from './uri-options.js';

/** The real implementations the daemon uses outside `--fake`. Constructing them starts nothing. */
export function registerLive(
  registry: Registry,
  uris: ConnectorUris,
  log: (message: string, err?: unknown) => void,
): void {
  registry.connectors.register(new DartConnector({ ...uris, log }));
  registry.logFeeds.register(new AndroidLogFeed({ log }));
}
