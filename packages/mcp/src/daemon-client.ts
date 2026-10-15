/**
 * The MCP server's (and the CLI's) view of the project's daemon: reads runtime.json, checks
 * /api/health before it sends the token, and starts the daemon (then retries once) when
 * it isn't running. Loopback only; the token goes in a header, never a URL or cookie.
 */
import type { Health, LogQuery, LoginWindowResult, LogsResult, Status } from '@project-deck/core';
import {
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
import { pathScrubber } from './paths.js';
import { daemonLogPath } from './spawn.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';

export const NOT_RUNNING = "FlutterDeck daemon isn't running: run `flutterdeck start`";
export const NOT_SET_UP = "FlutterDeck isn't set up in this folder. Run `flutterdeck init` first.";
const TOKEN_REJECTED =
  'FlutterDeck daemon rejected the token in .flutterdeck/runtime.json. Run `flutterdeck stop`, then try again.';
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const MAX_STARTS = 2;
/** The daemon's message is repeated to Claude: keep it short. */
const MAX_REASON = 300;

/** A message that is safe to show to Claude: it never holds the token. */
export class DaemonError extends Error {}

/** No daemon answered: nothing listens, or it isn't a FlutterDeck. */
class Unreachable extends Error {}

export interface DaemonClientOptions {
  projectDir: string;
  /** This MCP server's version, compared with the daemon's. */
  version: string;
  /** Starts the daemon in the background, calling `onExit` if it ends. Must not wait for it. */
  spawnDaemon: (projectDir: string, onExit: (code: number | null) => void) => void;
  /** This project's id as /api/health shows it; undefined skips the check. */
  projectId?: () => Promise<string | undefined>;
  timeoutMs?: number;
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

interface Connection {
  port: number;
  token: string;
  warnings: string[];
}

export class DaemonClient {
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollMs: number;
  private ownId: string | undefined;
  private starting: Promise<StartResult> | undefined;

  private readonly scrub: (text: string) => string;

  constructor(private readonly opts: DaemonClientOptions) {
    this.scrub = pathScrubber(opts.projectDir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.pollMs = opts.pollMs ?? 100;
  }

  /** `start: false` never starts a daemon: it fails with NOT_RUNNING instead. */
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
    try {
      return { value: await call(conn), warnings: conn.warnings };
    } catch (err) {
      if (err instanceof Unreachable) throw new DaemonError(NOT_RUNNING);
      throw withWarnings(err, conn.warnings);
    }
  }

  /** Whether this project's daemon answers. Never starts one. */
  async running(): Promise<boolean> {
    return (await this.connectChecked()) !== undefined;
  }

  /**
   * Asks this project's daemon to stop and waits until its runtime.json is gone. False
   * when none was running. Never starts one, and never signals a process: the pid in
   * runtime.json may belong to another program by now.
   */
  async shutdown(): Promise<boolean> {
    const conn = await this.connectChecked();
    if (conn === undefined) return false;
    try {
      await this.request(conn, 'POST', '/api/shutdown', OkResponse);
    } catch (err) {
      // It went away between the health check and the call.
      if (err instanceof Unreachable) return false;
      throw err;
    }
    const deadline = Date.now() + this.stopTimeoutMs;
    while (Date.now() < deadline) {
      if ((await readRuntime(this.opts.projectDir)) === undefined) return true;
      await sleep(this.pollMs);
    }
    throw new DaemonError(
      `FlutterDeck daemon on port ${conn.port} didn't stop within ${this.stopTimeoutMs / 1000} s.`,
    );
  }

  /** `connect`, after refusing a linked `.flutterdeck` (its files would be read through it). */
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
    // Lead decision 14 Oct 2026: only a folder `flutterdeck init` set up gets a daemon,
    // so opening Claude in any other folder starts nothing and writes nothing there.
    if (!(await this.isSetUp())) throw new DaemonError(NOT_SET_UP);
    for (let starts = 0; ; starts++) {
      const conn = await this.connect();
      if (conn !== undefined) {
        try {
          return { value: await call(conn), warnings: conn.warnings };
        } catch (err) {
          if (!(err instanceof Unreachable)) throw withWarnings(err, conn.warnings);
        }
      }
      // Gone: start it and retry. Twice at most, for a daemon that stopped again
      // between its start (perhaps one another call was waiting for) and this call.
      if (starts >= MAX_STARTS) throw new DaemonError(NOT_RUNNING);
      const started = await this.start();
      // 'gone': it came up and stopped again, so this counts as a start and we look again.
      if (started.kind === 'failed') throw new DaemonError(started.reason);
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
    if (ours !== undefined && health.projectId === undefined) {
      // Can't tell it is ours, so it doesn't get the token.
      throw new DaemonError(
        `The program on port ${info.port} didn't say which project it serves, so FlutterDeck didn't send it the token. Run \`flutterdeck stop\` and try again.`,
      );
    }
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

  private async isSetUp(): Promise<boolean> {
    try {
      // A linked .flutterdeck is refused with its own message, before anything else.
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
   */
  private start(): Promise<StartResult> {
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
        if ((await this.connect()) !== undefined) return { kind: 'up' };
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
        : { kind: 'failed', reason: `FlutterDeck daemon couldn't start: ${line}` };
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
