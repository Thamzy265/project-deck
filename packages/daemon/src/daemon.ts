import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Registry } from '@project-deck/core';
import { EventBus } from '@project-deck/core';
import { getRequestListener } from '@hono/node-server';
import { createApi } from './api.js';
import { AppManager } from './app-manager.js';
import { readRuntime, removeRuntime, writeRuntime } from './runtime.js';
import { generateToken } from './security.js';
import { attachWebSocket } from './ws.js';

export const DEFAULT_PORT = 9100;
export const VERSION = '0.0.0';
/** The daemon never listens anywhere else. */
const HOST = '127.0.0.1';

export interface DaemonOptions {
  /** Project root; `.flutterdeck/runtime.json` is written here. */
  projectDir: string;
  registry: Registry;
  /** 0 picks a free port (tests). */
  port?: number;
  logCapacity?: number;
  log?: (message: string, err?: unknown) => void;
}

export interface Daemon {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly bus: EventBus;
  readonly manager: AppManager;
  /** Resolves once the daemon has fully stopped. */
  readonly closed: Promise<void>;
  stop(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly port: number) {
    super(`A project-deck daemon is already running for this project on port ${port}`);
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const log = opts.log ?? ((message, err) => console.error(message, err ?? ''));
  const token = generateToken();
  const bus = new EventBus((err, event) => log(`Listener for ${event} threw`, err));
  const manager = new AppManager(opts.registry, bus, {
    ...(opts.logCapacity === undefined ? {} : { logCapacity: opts.logCapacity }),
    onConnectorError: (id, err) => log(`Connector '${id}' failed to start`, err),
  });

  let port = opts.port ?? DEFAULT_PORT;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let stopping: Promise<void> | undefined;

  const api = createApi({
    manager,
    bus,
    token,
    port: () => port,
    version: VERSION,
    shutdown: () => void stop(),
  });
  const listener = getRequestListener(api.fetch);
  const server = createServer((req, res) => void listener(req, res));
  const ws = attachWebSocket({
    server,
    bus,
    token,
    port: () => port,
    hello: () => ({ apps: manager.apps(), attached: manager.attachedApp() ?? null }),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    ws.close();
    const existing = await readRuntime(opts.projectDir);
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && existing?.port === port) {
      throw new DaemonAlreadyRunningError(port);
    }
    throw err;
  }
  port = (server.address() as AddressInfo).port;
  await writeRuntime(opts.projectDir, { pid: process.pid, port, token, startedAt: Date.now() });

  // Connectors may take a while (or fail); the API is already usable meanwhile.
  void manager.start();

  function stop(): Promise<void> {
    stopping ??= (async () => {
      ws.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await manager.stop();
      await removeRuntime(opts.projectDir, token);
      resolveClosed();
    })();
    return stopping;
  }

  return { port, url: `http://${HOST}:${port}`, token, bus, manager, closed, stop };
}
