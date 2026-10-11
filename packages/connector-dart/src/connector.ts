import { createHash } from 'node:crypto';
import type { AppConnector, RunningApp } from '@project-deck/core';
import type { DtdInfo } from './discovery.js';
import { dartDataHome, listViaDartCli, readPidFiles, toVmServiceWsUri } from './discovery.js';
import type { DtdVmService } from './dtd-client.js';
import { DtdClient } from './dtd-client.js';
import { isLoopbackWsUri } from './json-rpc.js';
import type { DartAppSessionOptions } from './session.js';
import { DartAppSession } from './session.js';

export interface DartConnectorOptions {
  /** Override the Dart data directory (defaults to the platform location). */
  dataHome?: string;
  /** DTD URIs pasted by the user, e.g. from "Copy DTD URI" in the IDE. */
  dtdUris?: string[];
  /** VM service URIs pasted by the user, for apps with no reachable DTD. */
  vmServiceUris?: string[];
  /** How often to look for new DTDs (a terminal `flutter run` starts its own). 0 disables. */
  scanIntervalMs?: number;
  /** Try `dart tooling-daemon --list --machine` when the pid-file directory is missing. */
  useDartCli?: boolean;
  /** Replaces discovery entirely (tests). */
  discover?: () => Promise<DtdInfo[]>;
  session?: DartAppSessionOptions;
  log?: (message: string, err?: unknown) => void;
}

interface Known {
  app: RunningApp;
  /** The VM service WebSocket address. Kept private: it carries an auth code. */
  vmServiceUri: string;
}

interface ConnectedDtd {
  info: DtdInfo;
  client: DtdClient;
  /** Keyed by normalised VM service URI. */
  services: Map<string, DtdVmService>;
}

const DEFAULT_SCAN_INTERVAL_MS = 5000;
/** Don't hammer a DTD that refused us; try again after this long. */
const RETRY_AFTER_MS = 30_000;

/** Stable, opaque id: VM service URIs contain auth codes and must not leak into URLs or logs. */
export function appIdFor(vmServiceUri: string): string {
  return 'dart-' + createHash('sha256').update(vmServiceUri).digest('base64url').slice(0, 16);
}

function normalise(uri: string): string {
  return toVmServiceWsUri(uri).replace(/\/$/, '');
}

/**
 * Finds running Dart and Flutter apps through every reachable Dart Tooling Daemon
 * (IDE, `flutter run`, the Dart MCP server) plus any pasted URIs, and attaches
 * over the VM service. Never launches, registers or stops anything.
 */
export class DartConnector implements AppConnector {
  readonly id = 'dart';
  private readonly dtds = new Map<string, ConnectedDtd>();
  private readonly failedAt = new Map<string, number>();
  private readonly connecting = new Set<string>();
  private readonly listeners = new Set<(apps: RunningApp[]) => void>();
  private readonly sessions = new Set<DartAppSession>();
  private known = new Map<string, Known>();
  private lastNotified = '';
  private timer: NodeJS.Timeout | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly opts: DartConnectorOptions = {}) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.scan();
    const interval = this.opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => void this.scan(), interval);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.scanning;
    for (const dtd of this.dtds.values()) dtd.client.close();
    this.dtds.clear();
    await Promise.all([...this.sessions].map((s) => s.detach()));
    this.sessions.clear();
  }

  listApps(): Promise<RunningApp[]> {
    return Promise.resolve([...this.known.values()].map((k) => k.app));
  }

  onAppsChanged(cb: (apps: RunningApp[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async attach(appId: string): Promise<DartAppSession> {
    const known = [...this.known.values()].find((k) => k.app.id === appId);
    if (known === undefined) throw new Error(`No running Dart app with id '${appId}'`);
    const session = await DartAppSession.attach(known.vmServiceUri, known.app, this.opts.session);
    this.sessions.add(session);
    session.on('exit', () => this.sessions.delete(session));
    return session;
  }

  /** One discovery pass. Overlapping calls share the same pass. */
  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const found = await this.discover();
    await Promise.all(
      found
        .filter((info) => !this.dtds.has(info.wsUri) && !this.connecting.has(info.wsUri))
        .filter((info) => Date.now() - (this.failedAt.get(info.wsUri) ?? 0) > RETRY_AFTER_MS)
        .map((info) => this.connectDtd(info)),
    );
    this.recompute();
  }

  private async discover(): Promise<DtdInfo[]> {
    const manual: DtdInfo[] = (this.opts.dtdUris ?? [])
      .filter((uri) => isLoopbackWsUri(uri))
      .map((wsUri) => ({ wsUri, source: 'manual' }));
    if (this.opts.discover !== undefined) return [...(await this.opts.discover()), ...manual];
    const fromFiles = await readPidFiles(this.opts.dataHome ?? dartDataHome());
    const discovered = fromFiles ?? (this.opts.useDartCli === false ? [] : await listViaDartCli());
    return [...discovered, ...manual];
  }

  private async connectDtd(info: DtdInfo): Promise<void> {
    this.connecting.add(info.wsUri);
    let client: DtdClient | undefined;
    try {
      client = await DtdClient.connect(info.wsUri, { connectTimeoutMs: 3000, timeoutMs: 5000 });
      if (!(await client.supportsConnectedApp()))
        throw new Error('DTD has no ConnectedApp service');
      const dtd: ConnectedDtd = { info, client, services: new Map() };
      // Subscribe first so a registration racing with the initial list is not lost.
      await client.watch((change) => {
        if (change.kind === 'registered')
          dtd.services.set(normalise(change.service.uri), change.service);
        else dtd.services.delete(normalise(change.uri));
        this.recompute();
      });
      for (const s of await client.getVmServices()) dtd.services.set(normalise(s.uri), s);
      if (this.stopped) {
        client.close();
        return;
      }
      this.dtds.set(info.wsUri, dtd);
      this.failedAt.delete(info.wsUri);
      client.onClose(() => {
        this.dtds.delete(info.wsUri);
        this.recompute();
      });
    } catch (err) {
      client?.close();
      this.failedAt.set(info.wsUri, Date.now());
      this.opts.log?.(
        `Could not use DTD from ${info.source}${info.pid === undefined ? '' : ` (pid ${info.pid})`}`,
        err,
      );
    } finally {
      this.connecting.delete(info.wsUri);
    }
  }

  /** Merges apps from every DTD and pasted URI, de-duplicating by VM service address. */
  private recompute(): void {
    const next = new Map<string, Known>();
    for (const dtd of this.dtds.values()) {
      for (const [key, service] of dtd.services) {
        const vmServiceUri = toVmServiceWsUri(service.uri);
        if (!isLoopbackWsUri(vmServiceUri)) continue;
        const startedBy = dtd.info.ideName === undefined ? 'unknown' : 'ide';
        const existing = next.get(key);
        // The same app can be registered in both the IDE's DTD and its own; prefer the IDE's view.
        if (existing !== undefined && (existing.app.startedBy === 'ide' || startedBy !== 'ide'))
          continue;
        next.set(key, {
          vmServiceUri,
          app: {
            id: appIdFor(key),
            name: service.name ?? 'Dart app',
            framework: 'flutter',
            startedBy,
          },
        });
      }
    }
    for (const uri of this.opts.vmServiceUris ?? []) {
      const vmServiceUri = toVmServiceWsUri(uri);
      const key = normalise(uri);
      if (!isLoopbackWsUri(vmServiceUri) || next.has(key)) continue;
      next.set(key, {
        vmServiceUri,
        app: {
          id: appIdFor(key),
          name: 'Dart app (pasted address)',
          framework: 'flutter',
          startedBy: 'unknown',
        },
      });
    }
    this.known = next;
    const apps = [...next.values()].map((k) => k.app);
    const fingerprint = JSON.stringify(apps);
    if (fingerprint === this.lastNotified || this.stopped) return;
    this.lastNotified = fingerprint;
    for (const cb of [...this.listeners]) cb(apps);
  }
}
