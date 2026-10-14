/**
 * The MCP server's view of the project's daemon: reads runtime.json, checks
 * /api/health before it sends the token, and starts the daemon (then retries once) when
 * it isn't running. Loopback only; the token goes in a header, never a URL or cookie.
 */
import type { Health, LogQuery, LoginWindowResult, LogsResult, Status } from '@project-deck/core';
import {
  ErrorResponse,
  HealthResponse,
  LoginWindowResponse,
  LogsResponse,
  StatusResponse,
  TOKEN_HEADER,
} from '@project-deck/core';
import { readProjectIdentity, readRuntime } from '@project-deck/core/node';
import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';

export const NOT_RUNNING = "FlutterDeck daemon isn't running: run `flutterdeck start`";
const TOKEN_REJECTED =
  'FlutterDeck daemon rejected the token in .flutterdeck/runtime.json. Run `flutterdeck stop`, then try again.';
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 10_000;

/** A message that is safe to show to Claude: it never holds the token. */
export class DaemonError extends Error {}

/** No daemon answered: nothing listens, or it isn't a FlutterDeck. */
class Unreachable extends Error {}

export interface DaemonClientOptions {
  projectDir: string;
  /** This MCP server's version, compared with the daemon's. */
  version: string;
  /** Starts the daemon in the background. Must not wait for it. */
  spawnDaemon: (projectDir: string) => void;
  /** This project's id as /api/health shows it; undefined skips the check. */
  projectId?: () => Promise<string | undefined>;
  timeoutMs?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export interface Answer<T> {
  value: T;
  /** Such as a version mismatch; shown with the tool output. */
  warnings: string[];
}

interface Connection {
  port: number;
  token: string;
  warnings: string[];
}

export class DaemonClient {
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private ownId: Promise<string | undefined> | undefined;
  private starting: Promise<boolean> | undefined;

  constructor(private readonly opts: DaemonClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.pollMs = opts.pollMs ?? 100;
  }

  status(): Promise<Answer<Status>> {
    return this.withDaemon((c) => this.request(c, 'GET', '/api/status', StatusResponse));
  }

  logs(query: LogQuery): Promise<Answer<LogsResult>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.size === 0 ? '' : `?${params.toString()}`;
    return this.withDaemon((c) => this.request(c, 'GET', `/api/logs${search}`, LogsResponse));
  }

  /**
   * Called when the server starts, which also starts the daemon if needed: the dashboard
   * should be up, and able to log in, by the time the Browser pane opens (ADR 0002, 0003).
   */
  async openLoginWindow(): Promise<LoginWindowResult> {
    const answer = await this.withDaemon((c) =>
      this.request(c, 'POST', '/api/login-window', LoginWindowResponse),
    );
    return answer.value;
  }

  private async withDaemon<T>(call: (c: Connection) => Promise<T>): Promise<Answer<T>> {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connect();
      if (conn !== undefined) {
        try {
          return { value: await call(conn), warnings: conn.warnings };
        } catch (err) {
          if (!(err instanceof Unreachable)) throw withWarnings(err, conn.warnings);
        }
      }
      // Gone: start it and retry once.
      if (attempt > 0 || !(await this.start())) throw new DaemonError(NOT_RUNNING);
    }
  }

  /** The daemon for this project, or undefined when none answers. */
  private async connect(): Promise<Connection | undefined> {
    const info = await readRuntime(this.opts.projectDir);
    if (info === undefined) return undefined;
    let health: Health;
    try {
      health = await this.request(
        { ...info, token: undefined },
        'GET',
        '/api/health',
        HealthResponse,
      );
    } catch {
      // Nothing listens, it hangs, or it isn't a FlutterDeck: either way not ours.
      return undefined;
    }
    const ours = await this.ownProjectId();
    if (ours !== undefined && health.projectId !== undefined && health.projectId !== ours) {
      throw new DaemonError(
        `Another project's FlutterDeck (project ${health.projectId}) is on port ${info.port}, not this project's (project ${ours}). Stop it, or give this project another port in .flutterdeck/config.json.`,
      );
    }
    const warnings =
      health.version === this.opts.version
        ? []
        : [
            `FlutterDeck daemon version ${health.version} differs from this MCP server (${this.opts.version}). Run \`flutterdeck stop\`; the next call starts the matching daemon.`,
          ];
    return { port: info.port, token: info.token, warnings };
  }

  private ownProjectId(): Promise<string | undefined> {
    this.ownId ??= this.opts.projectId?.() ?? readProjectIdentity(this.opts.projectDir);
    return this.ownId;
  }

  /** Starts the daemon once for any number of waiting calls; true once it answers. */
  private start(): Promise<boolean> {
    this.starting ??= (async () => {
      try {
        this.opts.spawnDaemon(this.opts.projectDir);
      } catch {
        return false;
      }
      const deadline = Date.now() + this.readyTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(this.pollMs);
        // Throws at once when the daemon that answers belongs to another project.
        if ((await this.connect()) !== undefined) return true;
      }
      return false;
    })().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async request<S extends z.ZodType>(
    conn: { port: number; token: string | undefined },
    method: 'GET' | 'POST',
    path: string,
    schema: S,
  ): Promise<z.infer<S>> {
    const route = `${method} ${path.split('?')[0] ?? path}`;
    let res: Response;
    let body: unknown;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      // Fixed loopback address: never a host from a file, so the token stays local.
      res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
        method,
        headers: conn.token === undefined ? {} : { [TOKEN_HEADER]: conn.token },
        // fetch would forward the token header to wherever a redirect points.
        redirect: 'manual',
        signal,
      });
      // A body that is not JSON is a wrong answer; one that stalls is a timeout.
      body = await res.json().catch((err: unknown) => {
        if (signal.aborted) throw err;
        return undefined;
      });
    } catch {
      if (signal.aborted) {
        throw new DaemonError(
          `FlutterDeck daemon didn't answer ${route} within ${this.timeoutMs / 1000} s`,
        );
      }
      throw new Unreachable();
    }
    if (res.status === 401) throw new DaemonError(TOKEN_REJECTED);
    if (!res.ok) {
      const error = ErrorResponse.safeParse(body);
      const reason = error.success ? error.data.error : 'no reason given';
      throw new DaemonError(`FlutterDeck daemon refused ${route}: ${reason} (${res.status})`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new DaemonError(`FlutterDeck daemon sent an unexpected answer to ${route}`);
    }
    return parsed.data;
  }
}

function withWarnings(err: unknown, warnings: string[]): DaemonError {
  const message =
    err instanceof DaemonError ? err.message : `FlutterDeck daemon call failed: ${String(err)}`;
  return new DaemonError([message, ...warnings].join('\n'));
}
