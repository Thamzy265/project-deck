import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from './daemon.js';
import { DaemonAlreadyRunningError, startDaemon } from './daemon.js';
import { findRunningDaemon } from './running.js';
import { STATE_DIR, readRuntime, runtimePath, writeRuntime } from './runtime.js';

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-running-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(projectDir, { recursive: true, force: true });
});

function launch(dir: string, port = 0): Promise<Daemon> {
  return startDaemon({ projectDir: dir, registry: new Registry(), port, log: () => undefined });
}

async function daemonFor(dir: string): Promise<Daemon> {
  const d = await launch(dir);
  cleanups.push(() => d.stop());
  return d;
}

async function otherProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-running-other-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An HTTP server on a free loopback port; closed after the test. */
async function httpOn(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const srv: HttpServer = createHttpServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections();
        srv.close(() => resolve());
      }),
  );
  return (srv.address() as AddressInfo).port;
}

/** A TCP server that accepts connections and never writes or closes them. */
async function silentTcp(): Promise<number> {
  const sockets: Socket[] = [];
  const srv: Server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        srv.close(() => resolve());
      }),
  );
  return (srv.address() as AddressInfo).port;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const TOKEN = 't'.repeat(43);

function record(port: number, pid = process.pid): Promise<void> {
  return writeRuntime(projectDir, { pid, port, token: TOKEN, startedAt: 0 });
}

/** Answers like a daemon's /api/status, but only for this project's token. */
function status(delayMs = 0) {
  return (req: IncomingMessage, res: ServerResponse) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/api/status' || req.headers['x-deck-token'] !== TOKEN) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Missing or invalid token' }));
        return;
      }
      res.end(JSON.stringify({ version: '0.0.0', apps: [], attached: null }));
    }, delayMs);
  };
}

function health(name: unknown, delayMs = 0) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, name }));
    }, delayMs);
  };
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await work;
  return { value, ms: Date.now() - t0 };
}

describe('findRunningDaemon', () => {
  it('returns undefined without a runtime file', async () => {
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
  });

  it('finds a live daemon for the project', async () => {
    const d = await daemonFor(projectDir);
    expect(await findRunningDaemon(projectDir)).toBe(d.port);
  });

  it.each([
    ['not JSON', '{ this is not json'],
    ['empty', ''],
    ['wrong types', JSON.stringify({ pid: 'x', port: 'y', token: 1, startedAt: null })],
    ['a JSON array', '[]'],
  ])('treats a %s runtime file as absent', async (_label, content) => {
    await mkdir(join(projectDir, STATE_DIR), { recursive: true });
    await writeFile(runtimePath(projectDir), content);
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
  });

  it('starts a daemon over a malformed runtime file and replaces it', async () => {
    await mkdir(join(projectDir, STATE_DIR), { recursive: true });
    await writeFile(runtimePath(projectDir), '{ broken');
    const d = await daemonFor(projectDir);
    expect((await readRuntime(projectDir))?.token).toBe(d.token);
  });

  it('ignores a server that answers health as project-deck but rejects the token', async () => {
    await record(await httpOn(health('project-deck')));
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
  });

  it('ignores a server on the recorded port that names another product', async () => {
    await record(await httpOn(health('something-else')));
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
  });

  it('ignores a server that answers health with non-JSON or an error status', async () => {
    await record(
      await httpOn((_req, res) => {
        res.end('<html>hello</html>');
      }),
    );
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
    await record(
      await httpOn((_req, res) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ name: 'project-deck' }));
      }),
    );
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
  });

  it('sends the recorded token and accepts a 200 status answer', async () => {
    const port = await httpOn(status());
    await record(port);
    expect(await findRunningDaemon(projectDir)).toBe(port);
  });

  it('accepts a daemon that answers just under the 2 s limit', async () => {
    const port = await httpOn(status(1500));
    await record(port);
    expect(await findRunningDaemon(projectDir)).toBe(port);
  });

  it('gives up on a daemon that answers just over the 2 s limit', async () => {
    await record(await httpOn(status(2300)));
    const { value, ms } = await timed(findRunningDaemon(projectDir));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(2800);
  });

  it('does not hang on a peer that accepts the connection and never answers', async () => {
    await record(await silentTcp());
    const { value, ms } = await timed(findRunningDaemon(projectDir));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(3000);
  });

  it('does not hang on a peer that sends headers and then stalls the body', async () => {
    await record(
      await httpOn((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"name":"proj');
      }),
    );
    const { value, ms } = await timed(findRunningDaemon(projectDir));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(3000);
  });

  it('lets startup proceed promptly past a silent peer on the recorded port', async () => {
    await record(await silentTcp());
    const { value, ms } = await timed(daemonFor(projectDir));
    expect(value.port).toBeGreaterThan(0);
    expect(ms).toBeLessThan(3500);
  });

  it.skipIf(process.platform === 'win32')(
    'counts a pid owned by another user (EPERM) as alive',
    async () => {
      // pid 1 is init/launchd: signalling it as a normal user gives EPERM.
      const d = await daemonFor(projectDir);
      const info = await readRuntime(projectDir);
      if (info === undefined) throw new Error('runtime file missing');
      await writeRuntime(projectDir, { ...info, pid: 1 });
      expect(await findRunningDaemon(projectDir)).toBe(d.port);
    },
  );

  it("starts over a stale runtime file whose reused pid points at another project's daemon", async () => {
    // After a crash or reboot the recorded pid can belong to an unrelated live process,
    // and with every project defaulting to 9147 the port can now be another project's
    // daemon. That daemon rejects this project's token, so it doesn't count.
    const other = await daemonFor(await otherProject());
    await record(other.port, process.pid);
    expect(await findRunningDaemon(projectDir)).toBeUndefined();
    const d = await daemonFor(projectDir);
    expect(d.port).not.toBe(other.port);
  });
});

describe('two daemons started at the same moment', () => {
  it('for different projects get different ports even when both ask for the same one', async () => {
    const port = await freePort();
    const dirA = await otherProject();
    const dirB = await otherProject();
    const [a, b] = await Promise.all([launch(dirA, port), launch(dirB, port)]);
    cleanups.push(
      () => a.stop(),
      () => b.stop(),
    );
    expect(a.port).not.toBe(b.port);
    expect((await readRuntime(dirA))?.port).toBe(a.port);
    expect((await readRuntime(dirB))?.port).toBe(b.port);
  });

  it('for the same project only one starts; the other is refused with its port', async () => {
    const results = await Promise.allSettled([launch(projectDir), launch(projectDir)]);
    const started: Daemon[] = [];
    for (const r of results) if (r.status === 'fulfilled') started.push(r.value);
    for (const d of started) cleanups.push(() => d.stop());
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((rejected[0]?.reason as DaemonAlreadyRunningError).port).toBe(started[0]?.port);
    expect((await readRuntime(projectDir))?.token).toBe(started[0]?.token);
  });

  it('for the same project, five at once still leave exactly one running', async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => launch(projectDir)));
    const started: Daemon[] = [];
    for (const r of results) if (r.status === 'fulfilled') started.push(r.value);
    for (const d of started) cleanups.push(() => d.stop());
    expect(started).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DaemonAlreadyRunningError);
    }
  });
});
