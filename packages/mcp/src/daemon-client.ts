/**
 * The MCP server's (and the CLI's) view of the project's daemon: reads runtime.json, checks
 * /api/health before it sends the token, and starts the daemon (then retries once) when
 * it isn't running. Loopback only; the token goes in a header, never a URL or cookie.
 */
import type {
  DbDevice,
  DbDiff,
  DbErrorCode,
  DbList,
  DbSchema,
  Health,
  LogQuery,
  LoginWindowResult,
  LogsResult,
  QueryResult,
  Status,
} from '@project-deck/core';
import {
  DbDiffResponse,
  DbErrorResponse,
  DbListResponse,
  DbQueryResponse,
  DbSchemaResponse,
  DbSnapshotResponse,
  ErrorResponse,
  HealthResponse,
  LoginWindowResponse,
  LogsResponse,
  OkResponse,
  StatusResponse,
  TOKEN_HEADER,
} from '@project-deck/core';
import {
  StateDirError,
  checkStateDir,
  configPath,
  readProjectIdentity,
  readRegularFile,
  readRuntime,
} from '@project-deck/core/node';
import { access } from 'node:fs/promises';
import { pathScrubber } from '@project-deck/core/node';
import { daemonLogPath } from './spawn.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';

export const NOT_RUNNING = "Pitdeck daemon isn't running: run `pitdeck start`";
export const NOT_SET_UP = "Pitdeck isn't set up in this folder. Run `pitdeck init` first.";
/**
 * The daemon still answers /api/health but dropped the same call twice. Starting another
 * would only exit at once (one daemon per project), so the user has to stop this one.
 * Retry once, then this text, never a spawn: PM decision 27 Oct 2026. Kept here so the
 * wording is easy to change.
 */
export function droppedCallText(port: number, pid: number, route: string): string {
  return `Pitdeck daemon on port ${port} (pid ${pid}) answers but dropped ${route}. Run \`pitdeck stop\`, then try again.`;
}
/**
 * The daemon answers health but dropped POST /api/shutdown (R-O1-1). `stop` has no other
 * way to stop it, and Pitdeck never signals a process itself, so the user quits it.
 */
export function droppedShutdownText(port: number, pid: number): string {
  return `Pitdeck daemon on port ${port} (pid ${pid}) answers health but dropped POST /api/shutdown. Quit process ${pid} by hand, then try again.`;
}
const TOKEN_REJECTED =
  'Pitdeck daemon rejected the token in .pitdeck/runtime.json. Run `pitdeck stop`, then try again.';
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
/**
 * Database calls may copy a snapshot from a device first (adb `ls` 10 s plus `cat` 60 s,
 * design review S7), so they wait longer than the other routes.
 */
export const DEFAULT_DB_TIMEOUT_MS = 75_000;
const MAX_STARTS = 2;
/** The daemon's message is repeated to Claude: keep it short. */
const MAX_REASON = 300;

/** A message that is safe to show to Claude: it never holds the token. */
export class DaemonError extends Error {}

/** What a failed tool call tells Claude: the daemon's message, or that the server failed. */
export function errorText(err: unknown): string {
  if (err instanceof DaemonError) return err.message;
  return `Pitdeck MCP server failed: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * The program on the port can't be stopped through the API: it refused the token, or it
 * didn't say which project it serves (so it never got the token).
 */
export class ForeignDaemonError extends DaemonError {
  constructor(
    message: string,
    readonly port: number,
  ) {
    super(message);
  }
}

/**
 * A `/api/db` route answered with a database error. `reason` is the daemon's message,
 * which may hold untrusted app text (table names, SQLite's errors).
 */
export class DaemonDbError extends DaemonError {
  constructor(
    message: string,
    readonly code: DbErrorCode,
    readonly reason: string,
    readonly detail: string | undefined,
    readonly devices: DbDevice[] | undefined,
    /** Such as a version mismatch, shown with the tool's answer. */
    readonly warnings: string[] = [],
  ) {
    super(message);
  }
}

/** No daemon answered: nothing listens, or it isn't a Pitdeck. */
class Unreachable extends Error {
  constructor(readonly route: string) {
    super(route);
  }
}

export interface DaemonClientOptions {
  projectDir: string;
  /** This MCP server's version, compared with the daemon's. */
  version: string;
  /** Starts the daemon in the background, calling `onExit` if it ends. Must not wait for it. */
  spawnDaemon: (projectDir: string, onExit: (code: number | null) => void) => void;
  /** This project's id as /api/health shows it; undefined skips the check. */
  projectId?: () => Promise<string | undefined>;
  timeoutMs?: number;
  /** How long a database call may take (DEFAULT_DB_TIMEOUT_MS). */
  dbTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** How long `shutdown` waits for runtime.json to go. */
  stopTimeoutMs?: number;
  pollMs?: number;
}

export interface Answer<T> {
  value: T;
  /** Such as a version mismatch; shown with the tool output. */
  warnings: string[];
}

type StartResult = { kind: 'up' } | { kind: 'gone' } | { kind: 'failed'; reason: string };

/** Which daemon: runtime.json's port, token and pid together. */
interface DaemonId {
  port: number;
  token: string;
  pid: number;
}

interface Connection extends DaemonId {
  warnings: string[];
}

function sameDaemon(a: DaemonId, b: DaemonId): boolean {
  return a.port === b.port && a.token === b.token && a.pid === b.pid;
}

export class DaemonClient {
  private readonly timeoutMs: number;
  private readonly dbTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollMs: number;
  private ownId: string | undefined;
  private starting: Promise<StartResult> | undefined;
  /** Daemons that dropped a call of someone waiting on `starting`: never the new one. */
  private readonly startStale: DaemonId[] = [];

  private readonly scrub: (text: string) => string;

  constructor(private readonly opts: DaemonClientOptions) {
    this.scrub = pathScrubber(opts.projectDir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dbTimeoutMs = opts.dbTimeoutMs ?? DEFAULT_DB_TIMEOUT_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.pollMs = opts.pollMs ?? 100;
  }

  /**
   * `start: false` never starts a daemon: it fails with NOT_RUNNING instead, or with the
   * stuck-daemon text when a daemon answers health but drops the call twice.
   */
  status(opts: { start?: boolean } = {}): Promise<Answer<Status>> {
    const call = (c: Connection) => this.request(c, 'GET', '/api/status', StatusResponse);
    return opts.start === false ? this.withRunning(call) : this.withDaemon(call);
  }

  logs(query: LogQuery): Promise<Answer<LogsResult>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.size === 0 ? '' : `?${params.toString()}`;
    return this.withDaemon((c) => this.request(c, 'GET', `/api/logs${search}`, LogsResponse));
  }

  /** The attached app's databases (`GET /api/db`). The token makes the daemon treat us as Claude. */
  dbList(): Promise<Answer<DbList>> {
    return this.withDaemon((c) => this.request(c, 'GET', '/api/db', DbListResponse, this.db()));
  }

  /** Tables of one database, without CREATE text (token callers get none). */
  async dbSchema(db: string): Promise<Answer<DbSchema>> {
    const path = `/api/db/${pathSegment(db)}/schema`;
    return this.withDaemon((c) => this.request(c, 'GET', path, DbSchemaResponse, this.db()));
  }

  /** One read-only statement; the daemon's gate judges it with Claude's rules. */
  dbQuery(input: {
    db: string;
    sql: string;
    params?: unknown[] | undefined;
    limit?: number | undefined;
  }): Promise<Answer<QueryResult>> {
    return this.withDaemon((c) =>
      this.request(c, 'POST', '/api/db/query', DbQueryResponse, this.db(input)),
    );
  }

  dbSnapshot(input: {
    db: string;
    label?: string | undefined;
  }): Promise<Answer<z.infer<typeof DbSnapshotResponse>>> {
    return this.withDaemon((c) =>
      this.request(c, 'POST', '/api/db/snapshot', DbSnapshotResponse, this.db(input)),
    );
  }

  dbDiff(input: { db: string; snapshotId?: string | undefined }): Promise<Answer<DbDiff>> {
    return this.withDaemon((c) =>
      this.request(c, 'POST', '/api/db/diff', DbDiffResponse, this.db(input)),
    );
  }

  private db(body?: unknown): RequestOptions {
    return { timeoutMs: this.dbTimeoutMs, ...(body === undefined ? {} : { body }) };
  }

  /**
   * Called when the server starts, which also starts the daemon if needed: the dashboard
   * should be up, and able to log in, by the time the Browser pane opens (ADR 0002, 0003).
   */
  async openLoginWindow(opts: { start?: boolean } = {}): Promise<LoginWindowResult> {
    const call = (c: Connection) =>
      this.request(c, 'POST', '/api/login-window', LoginWindowResponse);
    const answer = opts.start === false ? this.withRunning(call) : this.withDaemon(call);
    return (await answer).value;
  }

  /** Like withDaemon, but a daemon that isn't running is an error, never started. */
  private async withRunning<T>(call: (c: Connection) => Promise<T>): Promise<Answer<T>> {
    const conn = await this.connectChecked();
    if (conn === undefined) throw new DaemonError(NOT_RUNNING);
    return this.callDaemon(call, conn, false);
  }

  /** Whether this project's daemon answers. Never starts one. */
  async running(): Promise<boolean> {
    return (await this.connectChecked()) !== undefined;
  }

  /**
   * Asks this project's daemon to stop and waits until its runtime.json is gone or holds
   * another daemon's details. False when none was running. Never starts one, and never
   * signals a process: the pid in runtime.json may belong to another program by now.
   */
  async shutdown(): Promise<boolean> {
    const conn = await this.connectChecked();
    if (conn === undefined) return false;
    try {
      await this.request(conn, 'POST', '/api/shutdown', OkResponse);
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
      // It went away between the health check and the call, unless the same daemon still
      // answers health: then it is alive, and "not running" would be wrong (R-O1-1).
      const again = await this.connect();
      if (again !== undefined && sameDaemon(again, conn)) {
        throw new DaemonError(droppedShutdownText(conn.port, conn.pid));
      }
      return false;
    }
    const deadline = Date.now() + this.stopTimeoutMs;
    while (Date.now() < deadline) {
      // Gone, or replaced by another daemon's (a new start): either way this one stopped.
      const now = await readRuntime(this.opts.projectDir);
      if (now === undefined || !sameDaemon(now, conn)) return true;
      await sleep(this.pollMs);
    }
    throw new DaemonError(
      `Pitdeck daemon on port ${conn.port} didn't stop within ${this.stopTimeoutMs / 1000} s.`,
    );
  }

  /** `connect`, after refusing a linked `.pitdeck` (its files would be read through it). */
  private async connectChecked(): Promise<Connection | undefined> {
    try {
      await checkStateDir(this.opts.projectDir);
    } catch (err) {
      if (err instanceof StateDirError) throw new DaemonError(err.message);
      throw err;
    }
    return this.connect();
  }

  private async withDaemon<T>(call: (c: Connection) => Promise<T>): Promise<Answer<T>> {
    // Lead decision 14 Oct 2026: only a folder `pitdeck init` set up gets a daemon,
    // so opening Claude in any other folder starts nothing and writes nothing there.
    if (!(await this.isSetUp())) throw new DaemonError(NOT_SET_UP);
    return this.callDaemon(call, await this.connect(), true);
  }

  /**
   * Makes the call on `first` (undefined when none answered), and handles a dropped call
   * the same way with or without `canStart` (T-O1-1): a daemon still alive is never
   * reported as not running. Only a gone daemon is started, and only with `canStart`.
   */
  private async callDaemon<T>(
    call: (c: Connection) => Promise<T>,
    first: Connection | undefined,
    canStart: boolean,
  ): Promise<Answer<T>> {
    // The daemon that last dropped this call. If health still finds that same one, it
    // is alive and starting another would only exit at once (one daemon per project):
    // retry it once, for a one-off keep-alive reset, then say it is stuck (finding O1).
    let dropped: DaemonId | undefined;
    // Each daemon gets the call at most twice, and a new one appears only through a start
    // (or someone else's), so this bounds the loop even if runtime.json keeps changing.
    let drops = 0;
    let conn = first;
    for (let starts = 0; ;) {
      if (conn !== undefined) {
        try {
          return { value: await call(conn), warnings: conn.warnings };
        } catch (err) {
          if (!(err instanceof Unreachable)) throw withWarnings(err, conn.warnings);
          drops++;
          if (
            (dropped !== undefined && sameDaemon(dropped, conn)) ||
            drops > 2 * (MAX_STARTS + 1)
          ) {
            throw withWarnings(
              new DaemonError(droppedCallText(conn.port, conn.pid, err.route)),
              conn.warnings,
            );
          }
          dropped = { port: conn.port, token: conn.token, pid: conn.pid };
          // Look again before starting anything: the same daemon gets one more try.
          conn = await this.connect();
          continue;
        }
      }
      // Gone: start it and retry. Twice at most, for a daemon that stopped again
      // between its start (perhaps one another call was waiting for) and this call.
      if (!canStart || starts >= MAX_STARTS) throw new DaemonError(NOT_RUNNING);
      starts++;
      const started = await this.start(dropped);
      // 'gone': it came up and stopped again, so this counts as a start and we look again.
      if (started.kind !== 'failed') {
        conn = await this.connect();
        continue;
      }
      // A failed start is judged by the daemons of every caller that shared it, and its
      // child may have failed only because a daemon was already up (R-O1-2). Look once
      // more and make the call on whatever answers. The daemon that dropped this call
      // gets its one retry like anywhere else, and the check above calls it stuck only
      // on a second drop (PM decision 27 Oct 2026, R-O1-6). Still bounded: starts and
      // drops are counted as above.
      const after = await this.connect();
      if (after === undefined) throw new DaemonError(started.reason);
      conn = after;
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
      // Nothing listens, it hangs, or it isn't a Pitdeck: either way not ours.
      return undefined;
    }
    const ours = await this.ownProjectId();
    if (ours !== undefined && health.projectId === undefined) {
      // Can't tell it is ours, so it doesn't get the token.
      throw new ForeignDaemonError(
        `The program on port ${info.port} didn't say which project it serves, so Pitdeck didn't send it the token. Run \`pitdeck stop\` and try again.`,
        info.port,
      );
    }
    if (ours !== undefined && health.projectId !== undefined && health.projectId !== ours) {
      throw new DaemonError(
        `Another project's Pitdeck (project ${health.projectId}) is on port ${info.port}, not this project's (project ${ours}). Stop it, or give this project another port in .pitdeck/config.json.`,
      );
    }
    const warnings =
      health.version === this.opts.version
        ? []
        : [
            `Pitdeck daemon version ${health.version} differs from this MCP server (${this.opts.version}). Run \`pitdeck stop\`; the next call starts the matching daemon.`,
          ];
    return { port: info.port, token: info.token, pid: info.pid, warnings };
  }

  private async isSetUp(): Promise<boolean> {
    try {
      // A linked .pitdeck is refused with its own message, before anything else.
      await checkStateDir(this.opts.projectDir);
    } catch (err) {
      if (err instanceof StateDirError) throw new DaemonError(err.message);
      throw err;
    }
    try {
      await access(configPath(this.opts.projectDir));
      return true;
    } catch {
      return false;
    }
  }

  /** Cached once known; read again while unknown (the registry may appear later). */
  private async ownProjectId(): Promise<string | undefined> {
    if (this.ownId !== undefined) return this.ownId;
    const id = await (this.opts.projectId?.() ?? readProjectIdentity(this.opts.projectDir));
    if (id !== undefined) this.ownId = id;
    return id;
  }

  /**
   * Starts the daemon once for any number of waiting calls. True once it answers;
   * otherwise why not, with the daemon's own last message when it exited.
   *
   * `stale` is the daemon that dropped the caller's call. runtime.json may still name it
   * until the new daemon replaces the file (slow on Windows), so it must not count as up.
   * Callers share one start, so the stale daemons of all of them are pooled: a daemon one
   * caller saw drop a call is broken for every caller, and a caller with none just waits
   * for the new daemon too. withDaemon checks the daemon itself again after 'up' anyway.
   */
  private start(stale?: DaemonId): Promise<StartResult> {
    if (stale !== undefined) this.startStale.push(stale);
    this.starting ??= (async (): Promise<StartResult> => {
      const child: { exitCode?: number | null } = {};
      try {
        this.opts.spawnDaemon(this.opts.projectDir, (code) => {
          child.exitCode = code;
        });
      } catch {
        return { kind: 'failed', reason: NOT_RUNNING };
      }
      const deadline = Date.now() + this.readyTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(this.pollMs);
        // Throws at once when the daemon that answers belongs to another project.
        const conn = await this.connect();
        if (conn !== undefined && !this.startStale.some((s) => sameDaemon(s, conn))) {
          return { kind: 'up' };
        }
        // Another daemon for this project may have won the start: the check above saw it.
        if ('exitCode' in child) break;
      }
      if (!('exitCode' in child)) return { kind: 'failed', reason: NOT_RUNNING };
      // A start-up failure exits 1 after writing its reason to stderr. Exit 0 (stopped)
      // or a crash without a reason means it was up and has gone again.
      if (child.exitCode === 0) return { kind: 'gone' };
      const line = await lastLogLine(daemonLogPath(this.opts.projectDir), this.scrub);
      return line === undefined
        ? { kind: 'gone' }
        : { kind: 'failed', reason: `Pitdeck daemon couldn't start: ${line}` };
    })().finally(() => {
      this.starting = undefined;
      this.startStale.length = 0;
    });
    return this.starting;
  }

  private async request<S extends z.ZodType>(
    conn: { port: number; token: string | undefined },
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    const route = `${method} ${path.split('?')[0] ?? path}`;
    let res: Response;
    let body: unknown;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> =
      conn.token === undefined ? {} : { [TOKEN_HEADER]: conn.token };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    try {
      // Fixed loopback address: never a host from a file, so the token stays local.
      res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
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
        throw new DaemonError(`Pitdeck daemon didn't answer ${route} within ${timeoutMs / 1000} s`);
      }
      throw new Unreachable(route);
    }
    if (res.status === 401) throw new ForeignDaemonError(TOKEN_REJECTED, conn.port);
    if (!res.ok) {
      const dbError = DbErrorResponse.safeParse(body);
      if (dbError.success) {
        const { error, code, detail, devices } = dbError.data;
        throw new DaemonDbError(
          `Pitdeck daemon refused ${route}: ${error} (${res.status})`,
          code,
          error,
          detail,
          devices,
        );
      }
      const error = ErrorResponse.safeParse(body);
      const reason = error.success ? error.data.error : 'no reason given';
      throw new DaemonError(`Pitdeck daemon refused ${route}: ${reason} (${res.status})`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new DaemonError(`Pitdeck daemon sent an unexpected answer to ${route}`);
    }
    return parsed.data;
  }
}

/**
 * One path segment. encodeURIComponent leaves `.` and `..` as they are, and fetch folds
 * them (and `%2E`) away, so the request would reach another route (MCP-5).
 */
export function pathSegment(value: string): string {
  if (value === '.' || value === '..') {
    throw new DaemonError(`"${value}" can't be used as a name here.`);
  }
  return encodeURIComponent(value);
}

interface RequestOptions {
  /** Sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

function withWarnings(err: unknown, warnings: string[]): DaemonError {
  // A database error keeps its code, so the tool can say what to do; warnings go along.
  if (err instanceof DaemonDbError) {
    return new DaemonDbError(
      [err.message, ...warnings].join('\n'),
      err.code,
      err.reason,
      err.detail,
      err.devices,
      [...err.warnings, ...warnings],
    );
  }
  const message =
    err instanceof DaemonError ? err.message : `Pitdeck daemon call failed: ${String(err)}`;
  return new DaemonError([message, ...warnings].join('\n'));
}

/** The last non-empty line of the daemon's start-up log: its reason for stopping. */
/** Paths are hidden before the line is cut, so no part of one is left to slip through. */
async function lastLogLine(
  path: string,
  scrub: (text: string) => string,
): Promise<string | undefined> {
  let text: string;
  try {
    // Never through a link: it could point at one of the user's files.
    text = await readRegularFile(path, { maxBytes: 16_384, tail: true });
  } catch {
    return undefined;
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);
  return line === undefined ? undefined : scrub(line).slice(0, MAX_REASON);
}
