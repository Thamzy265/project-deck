/**
 * A daemon that still answers /api/health but drops calls (finding O1, 27 Oct 2026): the
 * client retries it once and then says so, instead of starting daemons that exit at once.
 * And a start ignores a runtime.json that still names the daemon that dropped the call.
 * Local sockets only; ordering is driven by the servers' own requests, not by sleeps.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonClientOptions } from './daemon-client.js';
import { DaemonClient, DaemonError, droppedCallText } from './daemon-client.js';
import { FAKE_PROJECT_ID, FAKE_STATUS, FakeDaemon, initProject } from './testing/fake-daemon.js';

const pending: Promise<unknown>[] = [];
function track(work: Promise<unknown>): void {
  pending.push(work.catch(() => undefined));
}

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-stale-'));
  await initProject(projectDir);
});

afterEach(async () => {
  // Closing the old daemons first cancels any replacement still waiting for a poll;
  // replacements that did start add their own clean-up, run in the second pass.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(pending.splice(0));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(projectDir, { recursive: true, force: true });
});

interface HalfAlive {
  port: number;
  token: string;
  pid: number;
  /** Whether /api/health answers; off, the client sees no daemon. */
  healthy: boolean;
  /** /api/status calls that reached it. */
  calls: number;
  /** Resolves on the next /api/health request. */
  nextHealth(): Promise<void>;
}

/**
 * A daemon on 127.0.0.1 that answers /api/health while `healthy`, and hands every
 * /api/status call to `onStatus` (which drops it unless told otherwise).
 */
async function halfAlive(
  onStatus: (n: number, res: ServerResponse, req: IncomingMessage, d: HalfAlive) => void = (
    _n,
    _res,
    req,
  ) => req.socket.destroy(),
): Promise<HalfAlive> {
  const waiters: { wake: () => void; cancel: (err: Error) => void }[] = [];
  const d: HalfAlive = {
    port: 0,
    token: randomBytes(32).toString('base64url'),
    // Not this process, so it can't be mistaken for a FakeDaemon's runtime.json.
    pid: 424_242,
    healthy: true,
    calls: 0,
    nextHealth: () => new Promise<void>((wake, cancel) => waiters.push({ wake, cancel })),
  };
  const server: Server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    if (req.url === '/api/health') {
      for (const w of waiters.splice(0)) w.wake();
      if (!d.healthy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          name: 'project-deck',
          version: '0.0.0',
          projectId: FAKE_PROJECT_ID,
        }),
      );
      return;
    }
    if (req.url === '/api/status') {
      d.calls++;
      onStatus(d.calls, res, req, d);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  d.port = (server.address() as AddressInfo).port;
  await writeRuntime(projectDir, {
    pid: d.pid,
    port: d.port,
    token: d.token,
    startedAt: Date.now(),
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        // A replacement still waiting for a poll is never started.
        for (const w of waiters.splice(0)) w.cancel(new Error('closed'));
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return d;
}

function client(opts: Partial<DaemonClientOptions> = {}): DaemonClient {
  return new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve(FAKE_PROJECT_ID),
    spawnDaemon: () => undefined,
    readyTimeoutMs: 3000,
    pollMs: 10,
    ...opts,
  });
}

async function rejection(p: Promise<unknown>): Promise<DaemonError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DaemonError) return err;
    throw err;
  }
  throw new Error('expected a DaemonError');
}

/**
 * A spawn that, once the start has polled the old daemon with its health back on (and so
 * had the chance to take it for the new one), starts a FakeDaemon in its place.
 */
function replaceAfterStalePoll(
  old: HalfAlive,
  spawned: { n: number },
): DaemonClientOptions['spawnDaemon'] {
  return () => {
    spawned.n++;
    old.healthy = true;
    // Two polls: the first may have been sent before health came back.
    track(
      old
        .nextHealth()
        .then(() => old.nextHealth())
        .then(() => {
          const f = FakeDaemon.start(projectDir);
          cleanups.push(async () => (await f).stop());
          return f;
        }),
    );
  };
}

describe('a daemon that answers health but drops calls', () => {
  it('retries it once, starts nothing, and says so without the token', async () => {
    const d = await halfAlive();
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toBe(droppedCallText(d.port, d.pid, 'GET /api/status'));
    expect(err.message).not.toContain(d.token);
    expect(spawned).toBe(0);
    expect(d.calls).toBe(2);
  });

  it('succeeds on the same daemon after a one-off drop, starting nothing', async () => {
    const d = await halfAlive((n, res, req) => {
      if (n === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FAKE_STATUS));
    });
    let spawned = 0;
    const answer = await client({
      spawnDaemon: () => {
        spawned++;
      },
    }).status();
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned).toBe(0);
    expect(d.calls).toBe(2);
  });
});

describe('starting after a dropped call', () => {
  /** Drops the call and stops answering health, as if it died; the test brings it back. */
  function dropAndGoQuiet(
    _n: number,
    _res: ServerResponse,
    req: IncomingMessage,
    d: HalfAlive,
  ): void {
    d.healthy = false;
    req.socket.destroy();
  }

  it("doesn't take the old runtime.json's daemon for the new one", async () => {
    const old = await halfAlive(dropAndGoQuiet);
    const spawned = { n: 0 };
    const answer = await client({ spawnDaemon: replaceAfterStalePoll(old, spawned) }).status();
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned.n).toBe(1);
    // Only the first call went to the old daemon: the start never reported it as up.
    expect(old.calls).toBe(1);
  });

  it('shares one start between concurrent calls that dropped on the same daemon', async () => {
    let dropped = 0;
    const old = await halfAlive((_n, _res, req, d) => {
      // Health goes quiet only once both calls have been dropped, so both look again.
      dropped++;
      if (dropped === 2) d.healthy = false;
      req.socket.destroy();
    });
    const spawned = { n: 0 };
    const c = client({ spawnDaemon: replaceAfterStalePoll(old, spawned) });
    const answers = await Promise.all([c.status(), c.status()]);
    for (const a of answers) expect(a.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned.n).toBe(1);
  });

  it('a call that arrives during the start waits for the new daemon too', async () => {
    const old = await halfAlive(dropAndGoQuiet);
    const spawned = { n: 0 };
    const c = client({
      spawnDaemon: (dir, onExit) => {
        replaceAfterStalePoll(old, spawned)(dir, onExit);
        // Joins the start while runtime.json still names the old daemon, which now
        // answers health again: its first call there drops, and it must not start twice.
        track(late.run());
      },
    });
    const late = {
      result: undefined as Promise<unknown> | undefined,
      run(): Promise<unknown> {
        this.result = c.status();
        return this.result;
      },
    };
    const first = await c.status();
    expect(first.value.projectName).toBe(FAKE_STATUS.projectName);
    const second = await late.result;
    expect(second).toMatchObject({ value: { projectName: FAKE_STATUS.projectName } });
    expect(spawned.n).toBe(1);
  });
});
