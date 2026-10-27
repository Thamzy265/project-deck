/**
 * A daemon that still answers /api/health but drops calls (finding O1, 27 Oct 2026): the
 * client retries it once and then says so, instead of starting daemons that exit at once.
 * And a start ignores a runtime.json that still names the daemon that dropped the call.
 * Local sockets only; ordering is driven by the servers' own requests, not by sleeps.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClientOptions } from './daemon-client.js';
import { DaemonClient, DaemonError, NOT_RUNNING, droppedCallText } from './daemon-client.js';
import { daemonLogPath } from './spawn.js';
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
  /** Changeable, to model a restart on the same port. */
  token: string;
  pid: number;
  /** Whether /api/health answers; off, the client sees no daemon. */
  healthy: boolean;
  /** /api/status calls that reached it. */
  calls: number;
  /** Resolves on the next /api/health request. */
  nextHealth(): Promise<void>;
  /** /api/health requests so far, answered or not. */
  probes: number;
  /** Resolves once `probes` has reached `n` (at once if it already has). */
  probesReached(n: number): Promise<void>;
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
    probes: 0,
    probesReached: (n) =>
      d.probes >= n
        ? Promise.resolve()
        : new Promise<void>((wake, cancel) => {
            const check = { wake: () => undefined, cancel };
            const waitFor = (): void => {
              waiters.push({
                wake: () => (d.probes >= n ? wake() : waitFor()),
                cancel: check.cancel,
              });
            };
            waitFor();
          }),
  };
  const server: Server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    if (req.url === '/api/health') {
      d.probes++;
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
  started: (f: FakeDaemon) => void = () => undefined,
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
          return FakeDaemon.start(projectDir).then((f) => {
            cleanups.push(() => f.stop());
            started(f);
          });
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
    // A barrier: both first calls are held until both have arrived, then dropped together
    // with health going quiet, so neither call's retry can reach the old daemon.
    const held: IncomingMessage[] = [];
    const old = await halfAlive((_n, _res, req, d) => {
      held.push(req);
      if (held.length < 2) return;
      d.healthy = false;
      for (const r of held) r.socket.destroy();
    });
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
        // Health stays quiet: turned back on, it could answer the second call's look
        // after its drop, and a second drop on the same daemon is (rightly) an error.
        // The replacement comes after the start has polled the old daemon once.
        track(
          old.nextHealth().then(async () => {
            const f = await FakeDaemon.start(projectDir);
            cleanups.push(() => f.stop());
          }),
        );
      },
    });
    const answers = await Promise.all([c.status(), c.status()]);
    for (const a of answers) expect(a.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned).toBe(1);
    expect(old.calls).toBe(2);
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

/** Makes runtime.json name `d` (as a daemon replacing the file does). */
function point(d: HalfAlive): Promise<void> {
  return writeRuntime(projectDir, {
    pid: d.pid,
    port: d.port,
    token: d.token,
    startedAt: Date.now(),
  });
}

function ok(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(FAKE_STATUS));
}

describe('status and login window with start: false (O1 probe)', () => {
  it('start: false never starts a daemon, whatever the half-alive one does', async () => {
    await halfAlive();
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
      },
    });
    await rejection(c.status({ start: false }));
    await rejection(c.openLoginWindow({ start: false }));
    expect(spawned).toBe(0);
  });

  it('start: false says the daemon is stuck, not that it is not running (T-O1-1)', async () => {
    const d = await halfAlive();
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
      },
    });
    expect(await c.running()).toBe(true);
    const err = await rejection(c.status({ start: false }));
    // The daemon is alive, so "run `flutterdeck start`" would be wrong: the same
    // stuck-daemon text as the default path, after one retry, and never a start.
    expect(err.message).toBe(droppedCallText(d.port, d.pid, 'GET /api/status'));
    expect(err.message).not.toContain(d.token);
    expect(d.calls).toBe(2);
    expect(spawned).toBe(0);
  });

  it('start: false succeeds after a one-off drop on the same daemon', async () => {
    const d = await halfAlive((n, res, req) => {
      if (n === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FAKE_STATUS));
    });
    const answer = await client().status({ start: false });
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(d.calls).toBe(2);
  });

  it("start: false still says it isn't running when the daemon died with the call", async () => {
    const d = await halfAlive((_n, _res, req, daemon) => {
      daemon.healthy = false;
      req.socket.destroy();
    });
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status({ start: false }),
    );
    expect(err.message).toBe(NOT_RUNNING);
    expect(d.calls).toBe(1);
    expect(spawned).toBe(0);
  });
});

describe('a daemon that drops, then runtime.json names another one', () => {
  it('a new daemon that also drops is retried once, then reported, starting nothing', async () => {
    const second = await halfAlive();
    const first = await halfAlive((_n, _res, req) => {
      // The file names the second daemon by the time the client looks again.
      track(point(second).then(() => req.socket.destroy()));
    });
    await point(first);
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toBe(droppedCallText(second.port, second.pid, 'GET /api/status'));
    expect(err.message).not.toContain(first.token);
    expect(err.message).not.toContain(second.token);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(2);
    expect(spawned).toBe(0);
  });

  it('a runtime.json that names a new daemon after every drop stops at the drop cap', async () => {
    // 2 * (MAX_STARTS + 1) = 6 drops are allowed, so the 7th daemon is the one reported.
    const chain: HalfAlive[] = [];
    for (let i = 0; i < 9; i++) {
      const index = i;
      chain.push(
        await halfAlive((_n, _res, req) => {
          const next = chain[index + 1];
          if (next === undefined) req.socket.destroy();
          else track(point(next).then(() => req.socket.destroy()));
        }),
      );
    }
    const head = chain[0];
    if (head === undefined) throw new Error('no daemon');
    await point(head);
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    const total = chain.reduce((sum, d) => sum + d.calls, 0);
    expect(total).toBe(7);
    const last = chain[6];
    if (last === undefined) throw new Error('no daemon');
    expect(err.message).toBe(droppedCallText(last.port, last.pid, 'GET /api/status'));
    expect(chain[7]?.calls).toBe(0);
    expect(spawned).toBe(0);
  });

  it('the same port and pid with a new token is another daemon, so it gets a fresh call', async () => {
    const seenTokens: (string | string[] | undefined)[] = [];
    const d = await halfAlive((n, res, req, self) => {
      seenTokens.push(req.headers['x-deck-token']);
      if (n === 1) {
        self.token = randomBytes(32).toString('base64url');
        track(point(self).then(() => req.socket.destroy()));
        return;
      }
      ok(res);
    });
    const firstToken = d.token;
    let spawned = 0;
    const answer = await client({
      spawnDaemon: () => {
        spawned++;
      },
    }).status();
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(seenTokens).toEqual([firstToken, d.token]);
    expect(d.token).not.toBe(firstToken);
    expect(spawned).toBe(0);
  });

  it('the same port and token with a new pid is another daemon, so it gets a fresh call', async () => {
    const d = await halfAlive((n, res, req, self) => {
      if (n === 1) {
        self.pid = 515_151;
        track(point(self).then(() => req.socket.destroy()));
        return;
      }
      ok(res);
    });
    const answer = await client().status();
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(d.calls).toBe(2);
  });
});

describe('the dropping daemon dies', () => {
  it('starts exactly one replacement, which is not asked for health before it exists', async () => {
    const old = await halfAlive((_n, _res, req, d) => {
      d.healthy = false;
      req.socket.destroy();
    });
    let spawned = 0;
    const answer = await client({
      spawnDaemon: () => {
        spawned++;
        track(
          FakeDaemon.start(projectDir).then((f) => {
            cleanups.push(async () => f.stop());
          }),
        );
      },
    }).status();
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned).toBe(1);
    expect(old.calls).toBe(1);
  });

  it('a call that joins the start with no stale daemon of its own waits for the new one too', async () => {
    const spawned = { n: 0 };
    const joiner: { p?: Promise<unknown> | undefined } = {};
    const holder: { c?: DaemonClient } = {};
    const old = await halfAlive((_n, _res, req, d) => {
      // Health is off from here, so this second call finds no daemon and joins the start.
      d.healthy = false;
      joiner.p = holder.c?.status();
      if (joiner.p !== undefined) track(joiner.p);
      req.socket.destroy();
    });
    holder.c = client({
      spawnDaemon: (dir, onExit) => {
        // Health comes back only once both callers have probed it while off (the first
        // call's, the retry's and the joiner's) and the start has polled at least twice,
        // so neither can take the old daemon for a live one.
        track(old.probesReached(5).then(() => replaceAfterStalePoll(old, spawned)(dir, onExit)));
      },
    });
    const answer = await holder.c.status();
    expect(answer.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(await joiner.p).toMatchObject({ value: { projectName: FAKE_STATUS.projectName } });
    // Only the first call ever reached the old daemon.
    expect(old.calls).toBe(1);
    expect(spawned.n).toBe(1);
  });

  it("doesn't carry the stale daemon into a later start", async () => {
    let mode: 'drop' | 'ok' = 'drop';
    const old = await halfAlive((_n, res, req, d) => {
      if (mode === 'ok') {
        ok(res);
        return;
      }
      d.healthy = false;
      req.socket.destroy();
    });
    const spawned = { n: 0 };
    const replacement: { f?: FakeDaemon } = {};
    const c = client({
      spawnDaemon: (dir, onExit) => {
        if (spawned.n === 0) {
          replaceAfterStalePoll(old, spawned, (f) => (replacement.f = f))(dir, onExit);
          return;
        }
        // Second start: the old daemon comes back (same port, token and pid). A start
        // must accept it now, since no caller has it as stale any more.
        spawned.n++;
        mode = 'ok';
        old.healthy = true;
      },
    });
    expect((await c.status()).value.projectName).toBe(FAKE_STATUS.projectName);
    // The replacement goes away and the file names the old daemon again, still silent.
    await replacement.f?.stop();
    old.healthy = false;
    await point(old);
    expect((await c.status()).value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned.n).toBe(2);
  });
});

describe('the new daemon exits at once while the stale one is still there', () => {
  async function stuckWithExitingChild(log: string | undefined): Promise<{
    err: DaemonError;
    spawned: number;
  }> {
    const old = await halfAlive((_n, _res, req, d) => {
      d.healthy = false;
      req.socket.destroy();
    });
    let spawned = 0;
    const err = await rejection(
      client({
        readyTimeoutMs: 500,
        spawnDaemon: (dir, onExit) => {
          spawned++;
          old.healthy = true;
          track(
            (log === undefined ? Promise.resolve() : writeFile(daemonLogPath(dir), log)).then(() =>
              onExit(1),
            ),
          );
        },
      }).status(),
    );
    return { err, spawned };
  }

  it('says why when its log has a reason, never the token', async () => {
    const { err, spawned } = await stuckWithExitingChild(
      // The daemon's own DaemonAlreadyRunning message (packages/daemon/src/daemon.ts).
      'A project-deck daemon is already running for this project on port 9147\n',
    );
    // Only seen when the stale daemon's health flickers off and on during the start. The
    // text gives the reason but not what to do (flutterdeck stop): observation T-O1-2.
    expect(err.message).toBe(
      "FlutterDeck daemon couldn't start: A project-deck daemon is already running for this project on port 9147",
    );
    expect(err.message).not.toContain('flutterdeck stop');
    expect(spawned).toBe(1);
  });

  it('says the daemon is stuck when its log has no reason, after one spawn', async () => {
    const { err, spawned } = await stuckWithExitingChild(undefined);
    expect(err.message).toContain('answers but dropped GET /api/status');
    expect(err.message).not.toBe(NOT_RUNNING);
    expect(spawned).toBe(1);
  });
});

describe('errors that are not a dropped call', () => {
  it('a timeout keeps the timeout text and starts nothing', async () => {
    const d = await halfAlive(() => undefined);
    let spawned = 0;
    const err = await rejection(
      client({
        timeoutMs: 100,
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toBe("FlutterDeck daemon didn't answer GET /api/status within 0.1 s");
    expect(err.message).not.toContain('dropped');
    expect(d.calls).toBe(1);
    expect(spawned).toBe(0);
  });

  it('a drop and then a timeout on the retry gives the timeout text', async () => {
    const d = await halfAlive((n, _res, req) => {
      if (n === 1) req.socket.destroy();
    });
    const err = await rejection(client({ timeoutMs: 100 }).status());
    expect(err.message).toBe("FlutterDeck daemon didn't answer GET /api/status within 0.1 s");
    expect(d.calls).toBe(2);
  });

  it('a 500 is reported once, with its reason, not retried', async () => {
    const d = await halfAlive((_n, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    const err = await rejection(client().status());
    expect(err.message).toBe('FlutterDeck daemon refused GET /api/status: boom (500)');
    expect(d.calls).toBe(1);
  });

  it('a 401 says the token was rejected, without the token, and is not retried', async () => {
    const d = await halfAlive((_n, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid token' }));
    });
    const err = await rejection(client().status());
    expect(err.message).toContain('rejected the token');
    expect(err.message).not.toContain(d.token);
    expect(d.calls).toBe(1);
  });
});

describe('where the client connects', () => {
  it('sends every request, drops and retries included, to 127.0.0.1 only', async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return real(input, init);
    });
    try {
      await halfAlive();
      const err = await rejection(client().status());
      expect(err.message).toContain('dropped GET /api/status');
    } finally {
      spy.mockRestore();
    }
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) expect(url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
