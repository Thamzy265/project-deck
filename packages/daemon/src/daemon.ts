import { createServer } from 'node:http';
import type { Registry } from '@project-deck/core';
import { EventBus } from '@project-deck/core';
import { getRequestListener } from '@hono/node-server';
import { createApi } from './api.js';
import { AppManager } from './app-manager.js';
import { listenWithFallback } from './listen.js';
import { findRunningDaemon } from './running.js';
import { removeRuntime, writeRuntime } from './runtime.js';
import { generateToken } from './security.js';
import type { StartupLockOptions } from './startup-lock.js';
import { StartupLockBusyError, acquireStartupLock } from './startup-lock.js';
import { attachWebSocket } from './ws.js';

/** Not 9100: Dart DevTools, which Android Studio starts, listens there. */
export const DEFAULT_PORT = 9147;
export const VERSION = '0.0.0';
/** The daemon never listens anywhere else. */
const HOST = '127.0.0.1';

export interface DaemonOptions {
  /** Project root; `.flutterdeck/runtime.json` is written here. */
  projectDir: string;
  registry: Registry;
  /** Preferred port; the next free one is used if it is busy. 0 picks any free port. */
  port?: number;
  /** Ports tried from `port` upwards before falling back to an OS-assigned one. */
  portAttempts?: number;
  logCapacity?: number;
  /** Timings for the per-project startup lock; defaults suit real use. */
  startupLock?: StartupLockOptions;
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
  // Held from the "is one running?" check until runtime.json is written, so two daemons
  // started together for the same project can't both pass the check.
  let release: () => Promise<void>;
  try {
    release = await acquireStartupLock(opts.projectDir, opts.startupLock);
  } catch (err) {
    if (!(err instanceof StartupLockBusyError)) throw err;
    const running = await findRunningDaemon(opts.projectDir);
    throw running === undefined ? err : new DaemonAlreadyRunningError(running);
  }
  try {
    return await startLocked(opts);
  } finally {
    await release();
  }
}

async function startLocked(opts: DaemonOptions): Promise<Daemon> {
  const log =
    opts.log ??
    ((message, err) => (err === undefined ? console.error(message) : console.error(message, err)));
  const running = await findRunningDaemon(opts.projectDir);
  if (running !== undefined) throw new DaemonAlreadyRunningError(running);

  const token = generateToken();
  const bus = new EventBus((err, event) => log(`Listener for ${event} threw`, err));
  const manager = new AppManager(opts.registry, bus, {
    ...(opts.logCapacity === undefined ? {} : { logCapacity: opts.logCapacity }),
    onConnectorError: (id, err) => log(`Connector '${id}' failed to start`, err),
  });

  const requestedPort = opts.port ?? DEFAULT_PORT;
  let port = requestedPort;
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
    port = await listenWithFallback(server, HOST, requestedPort, opts.portAttempts);
  } catch (err) {
    ws.close();
    throw err;
  }
  if (requestedPort !== 0 && port !== requestedPort) {
    log(`Port ${requestedPort} is in use; using ${port}`);
  }
  try {
    await writeRuntime(opts.projectDir, { pid: process.pid, port, token, startedAt: Date.now() });
  } catch (err) {
    // Without the runtime file no client can authenticate, so don't keep the port.
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }

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
