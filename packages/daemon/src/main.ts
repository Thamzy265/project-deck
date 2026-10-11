#!/usr/bin/env node
/**
 * Development entrypoint until the CLI exists (M2):
 *   node packages/daemon/dist/main.js [--port 9100] [--project <dir>]
 *     [--dtd-uri <ws://…>]... [--vm-service-uri <ws://…|http://…>]... [--fake]
 * By default it discovers running Dart/Flutter apps through every local DTD.
 * `--fake` uses an in-memory app instead, so the API can be exercised without Flutter.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DartConnector } from '@project-deck/connector-dart';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { DEFAULT_PORT, startDaemon } from './daemon.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_PORT) },
    project: { type: 'string', default: process.cwd() },
    fake: { type: 'boolean', default: false },
    'dtd-uri': { type: 'string', multiple: true, default: [] },
    'vm-service-uri': { type: 'string', multiple: true, default: [] },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid --port: ${values.port}`);
  process.exit(2);
}

const registry = new Registry();
if (values.fake) {
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  registry.connectors.register(connector);
  setInterval(() => {
    connector.sessions.get('app-1')?.logs().push({
      ts: Date.now(),
      level: 'info',
      source: 'app',
      message: 'Heartbeat from the fake app',
    });
  }, 2000).unref();
} else {
  registry.connectors.register(
    new DartConnector({
      dtdUris: values['dtd-uri'],
      vmServiceUris: values['vm-service-uri'],
      log: (message, err) => console.error(message, err instanceof Error ? err.message : ''),
    }),
  );
}

const daemon = await startDaemon({ projectDir: resolve(values.project), registry, port });
console.log(`project-deck daemon listening on ${daemon.url}`);
console.log(`Token in ${resolve(values.project, '.flutterdeck/runtime.json')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void daemon.stop());
}
await daemon.closed;
process.exit(0);
