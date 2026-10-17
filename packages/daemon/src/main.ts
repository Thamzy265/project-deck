#!/usr/bin/env node
/**
 * Development entrypoint until the CLI exists (M2):
 *   node packages/daemon/dist/main.js [--port 9147] [--project <dir>]
 *     [--dtd-uri <ws://…>]... [--vm-service-uri <ws://…|http://…>]... [--fake]
 * A "port" in .flutterdeck/config.json wins over --port and is never moved: if it is busy
 * the daemon exits and says who holds it. Without one, a busy port means the next free one;
 * clients read it from runtime.json.
 * By default it discovers running Dart/Flutter apps through every local DTD, and streams
 * Android native logs (adb logcat) for an attached app on an Android device.
 * Addresses can also come from DECK_DTD_URIS and DECK_VM_SERVICE_URIS (comma-separated).
 * They carry auth codes, and env vars keep them out of `ps`, unlike the flags.
 * `--fake` uses an in-memory app instead, so the API can be exercised without Flutter: a
 * live database that gains an order every 5 s, and fake Android snapshot files.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Registry } from '@project-deck/core';
import { readConfig } from './config.js';
import { DEFAULT_PORT, startDaemon } from './daemon.js';
import { registerFake } from './fake-mode.js';
import { registerLive } from './live.js';
import { systemNotifier } from './notify-run.js';
import { formatStartupError } from './startup-error.js';
import { connectorUris } from './uri-options.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_PORT) },
    project: { type: 'string', default: process.cwd() },
    fake: { type: 'boolean', default: false },
    'dtd-uri': { type: 'string', multiple: true, default: [] },
    'vm-service-uri': { type: 'string', multiple: true, default: [] },
  },
});

// Digits only: Number() would read '' as 0 and accept '0x10' or ' 9147 '.
const port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : Number.NaN;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid --port: '${values.port}' (expected a number from 0 to 65535)`);
  process.exit(2);
}

const registry = new Registry();
if (values.fake) {
  registerFake(registry);
} else {
  // Read on each use, so an edit applies without a restart. A config that can't be
  // read is reported by startDaemon; here it just means no ids from config.
  const projectDir = resolve(values.project);
  const snapshotIds = async () => {
    const config = await readConfig(projectDir).catch(() => undefined);
    return {
      androidApplicationId: config?.android?.applicationId,
      iosBundleId: config?.ios?.bundleId,
    };
  };
  const uris = connectorUris(
    { dtdUris: values['dtd-uri'], vmServiceUris: values['vm-service-uri'] },
    process.env,
  );
  registerLive(
    registry,
    uris,
    (message, err) => console.error(message, err instanceof Error ? err.message : ''),
    snapshotIds,
  );
}

const daemon = await startDaemon({
  projectDir: resolve(values.project),
  registry,
  port,
  notifier: systemNotifier({ log: (message) => console.error(message) }),
}).catch((err: unknown) => {
  console.error(formatStartupError(err));
  process.exit(1);
});
console.log(`project-deck daemon listening on ${daemon.url}`);
console.log(`Token in ${resolve(values.project, '.flutterdeck/runtime.json')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    daemon.stop().catch((err: unknown) => console.error('Stopping failed:', String(err)));
  });
}
await daemon.closed;
process.exit(0);
