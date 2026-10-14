import { createHash } from 'node:crypto';
import type { AppConnector, RunningApp } from '@project-deck/core';
import { parseAppName } from './app-name.js';
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
  /**
   * Try `dart tooling-daemon --list --machine` when the pid-file directory is missing
   * (SDKs before 3.12). It runs at most once a minute, scans in between reuse its answer.
   */
  useDartCli?: boolean;
  /** Replaces the `dart` CLI fallback (tests). */
  dartCli?: () => Promise<DtdInfo[]>;
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
/** Spawning `dart` costs far more than reading pid files, so don't do it on every scan. */
const DART_CLI_INTERVAL_MS = 60_000;

/** Stable, opaque id: VM service URIs contain auth codes and must not leak into URLs or logs. */
export function appIdFor(vmServiceUri: string): string {
  return 'dart-' + createHash('sha256').update(vmServiceUri).digest('base64url').slice(0, 16);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Dedupe key for a VM service address; undefined if we can't parse it (callers skip those).
 * Loopback spellings collapse to one so the same app isn't listed twice. Only the key:
 * we still connect to the address as advertised.
 */
export function normalise(uri: string): string | undefined {
  const ws = toVmServiceWsUri(uri);
  if (ws === undefined) return undefined;
  const url = new URL(ws);
  if (LOOPBACK_HOSTS.has(url.hostname)) url.hostname = '127.0.0.1';
  return url.toString().replace(/\/$/, '');
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
  /** DTD clients still being set up; stop() closes them so a stuck DTD can't hold it up. */
  private readonly inflight = new Set<DtdClient>();
  /** Cancels WebSocket handshakes still in progress when stop() runs. */
  private abort = new AbortController();
  private readonly listeners = new Set<(apps: RunningApp[]) => void>();
  private readonly sessions = new Set<DartAppSession>();
  private known = new Map<string, Known>();
  private lastNotified = '';
  private timer: NodeJS.Timeout | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = false;
  private dartCliCache: { at: number; found: DtdInfo[] } | undefined;

  constructor(private readonly opts: DartConnectorOptions = {}) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.abort = new AbortController();
    await this.scan();
    // stop() may have run during the first scan; an interval set now would never be cleared.
    if (this.isStopped()) return;
    const interval = this.opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        // A rejection here would be unhandled and take the whole daemon down.
        this.scan().catch((err: unknown) => this.opts.log?.('Background scan failed', err));
      }, interval);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    for (const client of this.inflight) client.close();
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
    const session = await DartAppSession.attach(known.vmServiceUri, known.app, {
      onListenerError: (err) => this.opts.log?.('VM service listener failed', err),
      ...this.opts.session,
    });
    // stop() ran while we were connecting and won't see this session, so it must not outlive it.
    if (this.stopped) {
      await session.detach();
      throw new Error('The Dart connector was stopped while attaching');
    }
    this.sessions.add(session);
    session.on('exit', () => this.sessions.delete(session));
    return session;
  }

  /** A method, so a check after an await isn't narrowed away by one made before it. */
  private isStopped(): boolean {
    return this.stopped;
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
    const discovered = fromFiles ?? (this.opts.useDartCli === false ? [] : await this.viaDartCli());
    return [...discovered, ...manual];
  }

  private async viaDartCli(): Promise<DtdInfo[]> {
    const cached = this.dartCliCache;
    if (cached !== undefined && Date.now() - cached.at < DART_CLI_INTERVAL_MS) return cached.found;
    const found = await (this.opts.dartCli ?? listViaDartCli)();
    this.dartCliCache = { at: Date.now(), found };
    return found;
  }

  private async connectDtd(info: DtdInfo): Promise<void> {
    this.connecting.add(info.wsUri);
    let client: DtdClient | undefined;
    try {
      client = await DtdClient.connect(info.wsUri, {
        connectTimeoutMs: 3000,
        timeoutMs: 5000,
        signal: this.abort.signal,
        onListenerError: (err) => this.opts.log?.('DTD listener failed', err),
      });
      this.inflight.add(client);
      // stop() may have run during the handshake, before this client was tracked.
      if (this.stopped) throw new Error('The Dart connector was stopped');
      if (!(await client.supportsConnectedApp()))
        throw new Error('DTD has no ConnectedApp service');
      const dtd: ConnectedDtd = { info, client, services: new Map() };
      // Subscribe first so a registration racing with the initial list is not lost.
      await client.watch((change) => {
        const key = normalise(change.kind === 'registered' ? change.service.uri : change.uri);
        if (key === undefined) return;
        if (change.kind === 'registered') dtd.services.set(key, change.service);
        else dtd.services.delete(key);
        this.recompute();
      });
      for (const s of await client.getVmServices()) {
        const key = normalise(s.uri);
        if (key !== undefined) dtd.services.set(key, s);
      }
      if (this.isStopped()) {
        client.close();
        return;
      }
      this.dtds.set(info.wsUri, dtd);
      this.failedAt.delete(info.wsUri);
      client.onClose(() => {
        this.dtds.delete(info.wsUri);
        this.recompute();
      });
      // Don't make this DTD's apps wait for slower DTDs in the same scan.
      this.recompute();
    } catch (err) {
      client?.close();
      // Shutting down is not the DTD's fault; don't hold it back from the next start().
      if (this.stopped) return;
      this.failedAt.set(info.wsUri, Date.now());
      this.opts.log?.(
        `Could not use DTD from ${info.source}${info.pid === undefined ? '' : ` (pid ${info.pid})`}`,
        err,
      );
    } finally {
      if (client !== undefined) this.inflight.delete(client);
      this.connecting.delete(info.wsUri);
    }
  }

  /** Merges apps from every DTD and pasted URI, de-duplicating by VM service address. */
  private recompute(): void {
    const next = new Map<string, Known>();
    for (const dtd of this.dtds.values()) {
      for (const [key, service] of dtd.services) {
        const vmServiceUri = toVmServiceWsUri(service.uri);
        if (vmServiceUri === undefined || !isLoopbackWsUri(vmServiceUri)) continue;
        const startedBy = dtd.info.ideName === undefined ? 'unknown' : 'ide';
        const existing = next.get(key);
        // The same app can be registered in both the IDE's DTD and its own; prefer the IDE's view.
        if (existing !== undefined && (existing.app.startedBy === 'ide' || startedBy !== 'ide'))
          continue;
        const { name, device } = parseAppName(service.name ?? undefined);
        next.set(key, {
          vmServiceUri,
          app: {
            id: appIdFor(key),
            name,
            ...(device === undefined ? {} : { device }),
            framework: 'flutter',
            startedBy,
          },
        });
      }
    }
    for (const uri of this.opts.vmServiceUris ?? []) {
      const vmServiceUri = toVmServiceWsUri(uri);
      const key = normalise(uri);
      if (vmServiceUri === undefined || key === undefined) continue;
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
