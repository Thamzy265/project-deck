import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { Registry } from '@project-deck/core';
import { EventBus } from '@project-deck/core';
import { getRequestListener } from '@hono/node-server';
import { ActivityFeed } from './activity.js';
import { createApi } from './api.js';
import { AppManager } from './app-manager.js';
import { readConfig } from './config.js';
import { listen, listenWithFallback } from './listen.js';
import { identifyPortHolder } from './port-busy.js';
import { claimConfigPort, projectIdentity } from './port-registry.js';
import { findRunningDaemon } from './running.js';
import { removeRuntime, writeRuntime } from './runtime.js';
import { generateToken } from './security.js';
import type { StartupLockOptions } from './startup-lock.js';
import { StartupLockBusyError, acquireStartupLock } from './startup-lock.js';
import { attachWebSocket } from './ws.js';

export { PortBusyError } from './port-busy.js';

/** Not 9100: Dart DevTools, which Android Studio starts, listens there. */
export const DEFAULT_PORT = 9147;
export const VERSION = '0.0.0';
/** The daemon never listens anywhere else. */
const HOST = '127.0.0.1';

export interface DaemonOptions {
  /** Project root; `.flutterdeck/runtime.json` is written here. */
  projectDir: string;
  registry: Registry;
  /**
   * Preferred port when `.flutterdeck/config.json` has none; the next free one is used
   * if it is busy. 0 picks any free port. A config port always wins and is never moved.
   */
  port?: number;
  /** Home folder holding the per-user port registry; defaults to the user's home. */
  homeDir?: string;
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
  readonly version: string;
  /** Salted hash of the project path, as shown on /api/health. */
  readonly projectId: string;
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

  const config = await readConfig(opts.projectDir);
  const registryOpts = opts.homeDir === undefined ? {} : { homeDir: opts.homeDir };
  const sharedWith =
    config.port === undefined
      ? undefined
      : await claimConfigPort(opts.projectDir, config.port, registryOpts);
  const projectId = await projectIdentity(opts.projectDir, registryOpts);

  const token = generateToken();
  const sessionSecret = generateToken();
  const bus = new EventBus((err, event) => log(`Listener for ${event} threw`, err));
  const activity = new ActivityFeed(bus);
  const stopActivity = activity.start();
  const manager = new AppManager(opts.registry, bus, {
    ...(opts.logCapacity === undefined ? {} : { logCapacity: opts.logCapacity }),
    onConnectorError: (id, err) => log(`Connector '${id}' failed to start`, err),
  });

  const requestedPort = config.port ?? opts.port ?? DEFAULT_PORT;
  let port = requestedPort;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let stopping: Promise<void> | undefined;

  const api = createApi({
    manager,
    bus,
    activity,
    token,
    sessionSecret,
    port: () => port,
    version: VERSION,
    projectId,
    shutdown: () => void stop(),
  });
  const listener = getRequestListener(api.fetch);
  const server = createServer((req, res) => void listener(req, res));
  const ws = attachWebSocket({
    server,
    bus,
    token,
    sessionSecret,
    port: () => port,
    hello: () => ({ apps: manager.apps(), attached: manager.attachedApp() ?? null }),
  });

  try {
    if (config.port === undefined) {
      port = await listenWithFallback(server, HOST, requestedPort, opts.portAttempts);
    } else {
      await listenFixed(server, config.port);
    }
  } catch (err) {
    ws.close();
    throw err;
  }
  if (requestedPort !== 0 && port !== requestedPort) {
    log(`Port ${requestedPort} is in use; using ${port}`);
  }
  if (sharedWith !== undefined) {
    log(
      `Port ${port} is also registered to another project (project ${sharedWith}); if both run at once one will fail. Run \`flutterdeck init\` to pick a new port.`,
    );
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
      stopActivity();
      await removeRuntime(opts.projectDir, token);
      resolveClosed();
    })();
    return stopping;
  }

  return {
    port,
    url: `http://${HOST}:${port}`,
    token,
    version: VERSION,
    projectId,
    bus,
    manager,
    closed,
    stop,
  };
}

/**
 * The dashboard URL in launch.json names this port, so moving would leave the pane on
 * someone else's server. Say who holds it instead.
 */
async function listenFixed(server: Server, port: number): Promise<void> {
  try {
    await listen(server, HOST, port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EACCES') throw await identifyPortHolder(port);
    throw err;
  }
}
