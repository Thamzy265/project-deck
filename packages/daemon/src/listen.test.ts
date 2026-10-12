import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenWithFallback } from './listen.js';

const HOST = '127.0.0.1';
const open: (Server | HttpServer)[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function httpServer(): HttpServer {
  const srv = createHttpServer();
  open.push(srv);
  return srv;
}

function tryListen(port: number, host = HOST): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(undefined));
    srv.listen(port, host, () => {
      open.push(srv);
      resolve(srv);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Replaces `listen` so every call fails with `code`, recording the ports asked for. */
function failingListen(server: HttpServer, code: string): number[] {
  const calls: number[] = [];
  server.listen = ((port: number) => {
    calls.push(port);
    process.nextTick(() =>
      server.emit('error', Object.assign(new Error(`listen ${code}: simulated`), { code })),
    );
    return server;
  }) as typeof server.listen;
  return calls;
}

describe('listenWithFallback', () => {
  it('falls back to an OS port when 65535 is busy instead of trying 65536', async () => {
    // Already taken by someone else is just as good for this test.
    await tryListen(65535);
    const port = await listenWithFallback(httpServer(), HOST, 65535);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(65535);
  });

  it('stops at 65535 when the attempts would run past it', async () => {
    const taken: number[] = [];
    for (let p = 65530; p <= 65535; p++) if ((await tryListen(p)) !== undefined) taken.push(p);
    const port = await listenWithFallback(httpServer(), HOST, 65530, 20);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    expect(taken).not.toContain(port);
  });

  it('takes an OS-assigned port for port 0', async () => {
    const srv = httpServer();
    const port = await listenWithFallback(srv, HOST, 0);
    expect(port).toBe((srv.address() as AddressInfo).port);
    expect(port).toBeGreaterThan(0);
  });

  it('rethrows a non-EADDRINUSE error without trying other ports', async () => {
    const srv = httpServer();
    const calls = failingListen(srv, 'EACCES');
    await expect(listenWithFallback(srv, HOST, 80)).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toEqual([80]);
  });

  it('rethrows EADDRINUSE from the OS-assigned attempt instead of looping', async () => {
    const srv = httpServer();
    const calls = failingListen(srv, 'EADDRINUSE');
    await expect(listenWithFallback(srv, HOST, 5000, 3)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(calls).toEqual([5000, 5001, 5002, 0]);
  });

  it('rejects a negative port rather than listening somewhere', async () => {
    await expect(listenWithFallback(httpServer(), HOST, -1)).rejects.toMatchObject({
      code: 'ERR_SOCKET_BAD_PORT',
    });
  });

  it.each([70000, 65536, 1.5, Number.NaN])(
    'rejects port %s with a RangeError before trying to listen',
    async (bad) => {
      const srv = httpServer();
      const calls = failingListen(srv, 'EADDRINUSE');
      const attempt = listenWithFallback(srv, HOST, bad);
      await expect(attempt).rejects.toBeInstanceOf(RangeError);
      await expect(attempt).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
      expect(calls).toEqual([]);
    },
  );

  it('leaves no stray error listeners after falling back', async () => {
    const busy = await freePort();
    await tryListen(busy);
    const srv = httpServer();
    const before = srv.listenerCount('error');
    await listenWithFallback(srv, HOST, busy, 3);
    expect(srv.listenerCount('error')).toBe(before);
  });

  it('gives two servers racing for the same port different ports', async () => {
    const port = await freePort();
    const [a, b] = await Promise.all([
      listenWithFallback(httpServer(), HOST, port),
      listenWithFallback(httpServer(), HOST, port),
    ]);
    expect(new Set([a, b]).size).toBe(2);
    expect([a, b]).toContain(port);
  });

  it('can still bind 127.0.0.1 when the port is taken on ::1 only', async () => {
    const port = await freePort();
    const v6 = await tryListen(port, '::1');
    // No IPv6 loopback on this machine: nothing to test.
    if (v6 === undefined) return;
    expect(await listenWithFallback(httpServer(), HOST, port)).toBe(port);
  });
});
