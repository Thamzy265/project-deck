import { request as httpRequest } from 'node:http';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Daemon } from './daemon.js';
import { DEFAULT_PORT, DaemonAlreadyRunningError, startDaemon } from './daemon.js';
import { readRuntime, runtimePath, writeRuntime } from './runtime.js';
import { startupLockPath } from './startup-lock.js';

let projectDir: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-'));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await rm(projectDir, { recursive: true, force: true });
});

async function start(port = 0): Promise<Daemon> {
  const registry = new Registry();
  registry.connectors.register(new FakeAppConnector('fake', [fakeApp()]));
  daemon = await startDaemon({ projectDir, registry, port, log: () => undefined });
  return daemon;
}

/** Raw request so we can send a Host header fetch would overwrite. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function openWs(d: Daemon, token?: string, origin?: string) {
  return new WebSocket(`ws://127.0.0.1:${d.port}/ws`, {
    ...(token === undefined ? {} : { headers: { 'x-deck-token': token } }),
    ...(origin === undefined ? {} : { origin }),
  });
}

function nextMessage(ws: WebSocket): Promise<{ type: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) =>
      resolve(JSON.parse((data as Buffer).toString('utf8')) as { type: string; payload: unknown }),
    );
    ws.once('error', reject);
  });
}

function rejection(ws: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
  );
}

describe('startDaemon', () => {
  it('listens on loopback and writes a private runtime file', async () => {
    const d = await start();
    expect(d.url).toBe(`http://127.0.0.1:${d.port}`);
    const info = await readRuntime(projectDir);
    expect(info).toMatchObject({ port: d.port, token: d.token, pid: process.pid });
    if (process.platform !== 'win32') {
      expect((await stat(runtimePath(projectDir))).mode & 0o777).toBe(0o600);
    }
  });

  it('serves the API with the token and rejects foreign hosts', async () => {
    const d = await start();
    const res = await fetch(`${d.url}/api/status`, { headers: { 'x-deck-token': d.token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ projectName: basename(projectDir) });
    expect((await fetch(`${d.url}/api/status`)).status).toBe(401);
    expect(await rawGet(d.port, '/api/health', { host: `attacker.example:${d.port}` })).toBe(403);
  });

  it('streams bus events over WebSocket after a hello', async () => {
    const d = await start();
    const ws = openWs(d, d.token);
    const hello = await nextMessage(ws);
    expect(hello.type).toBe('hello');
    const next = nextMessage(ws);
    await fetch(`${d.url}/api/events`, {
      method: 'POST',
      headers: { 'x-deck-token': d.token, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'claude.done' }),
    });
    expect(await next).toEqual({ type: 'claude.done', payload: {} });
    ws.close();
  });

  it('pushes new Activity entries over WebSocket', async () => {
    const d = await start();
    const ws = openWs(d, d.token);
    await nextMessage(ws);
    const messages: { type: string; payload: unknown }[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse((data as Buffer).toString('utf8')) as (typeof messages)[number]);
    });
    await fetch(`${d.url}/api/events`, {
      method: 'POST',
      headers: { 'x-deck-token': d.token, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'claude.waiting', message: 'Allow edit?' }),
    });
    await vi.waitFor(() => expect(messages.map((m) => m.type)).toContain('activity'));
    const activity = messages.find((m) => m.type === 'activity');
    expect(activity?.payload).toMatchObject({ kind: 'claude.waiting', message: 'Allow edit?' });
    ws.close();
  });

  it('refuses WebSocket upgrades without a token or from other origins', async () => {
    const d = await start();
    expect(await rejection(openWs(d))).toBe(401);
    expect(await rejection(openWs(d, d.token, 'https://evil.example'))).toBe(403);
  });

  it('refuses a second daemon for the same project, naming its port', async () => {
    const d = await start();
    const second = startDaemon({ projectDir, registry: new Registry(), log: () => undefined });
    await expect(second).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await expect(second).rejects.toThrow(String(d.port));
  });

  it('starts normally over a runtime file whose daemon no longer answers', async () => {
    const deadPort = await freePort();
    await writeRuntime(projectDir, {
      pid: process.pid,
      port: deadPort,
      token: 't'.repeat(43),
      startedAt: 0,
    });
    const d = await start();
    expect((await readRuntime(projectDir))?.token).toBe(d.token);
  });

  it('starts normally over a runtime file whose pid is dead', async () => {
    // A daemon for another project answers on the recorded port; only the pid is stale.
    const otherDir = await mkdtemp(join(tmpdir(), 'deck-'));
    const other = await startDaemon({ projectDir: otherDir, registry: new Registry(), port: 0 });
    try {
      const pid = await exitedPid();
      await writeRuntime(projectDir, {
        pid,
        port: other.port,
        token: 't'.repeat(43),
        startedAt: 0,
      });
      const d = await start();
      expect(d.port).not.toBe(other.port);
    } finally {
      await other.stop();
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('removes the runtime file and resolves closed on shutdown', async () => {
    const d = await start();
    await fetch(`${d.url}/api/shutdown`, { method: 'POST', headers: { 'x-deck-token': d.token } });
    await d.closed;
    expect(await readRuntime(projectDir)).toBeUndefined();
  });

  it('survives a client sending an oversized frame', async () => {
    const d = await start();
    const ws = openWs(d, d.token);
    ws.on('error', () => undefined);
    await nextMessage(ws);
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send('x'.repeat(10_000));
    await closed;
    expect((await fetch(`${d.url}/api/health`)).status).toBe(200);
  });

  it('releases the port and the startup lock when the runtime file cannot be written', async () => {
    const port = await freePort();
    // A directory where runtime.json should go: the lock is taken, the rename fails.
    await mkdir(runtimePath(projectDir), { recursive: true });
    await expect(
      startDaemon({ projectDir, registry: new Registry(), port, log: () => undefined }),
    ).rejects.toThrow();
    await expect(access(startupLockPath(projectDir))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(runtimePath(projectDir), { recursive: true });
    const d = await start(port);
    expect(d.port).toBe(port);
  });

  it('removes the startup lock once runtime.json is written', async () => {
    await start();
    await expect(access(startupLockPath(projectDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails with one clear error when the project path is a file', async () => {
    const notADir = join(projectDir, 'file');
    await writeFile(notADir, '');
    await expect(
      startDaemon({ projectDir: notADir, registry: new Registry(), log: () => undefined }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('port selection', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /**
   * Occupies `count` consecutive ports and checks the one after them is free. They are
   * picked below every OS's ephemeral range (macOS and Windows from 49152, Linux from
   * 32768), so tests that listen on port 0 in parallel can't take the free one first.
   */
  async function occupy(count: number): Promise<number> {
    for (;;) {
      const base = 20_000 + Math.floor(Math.random() * 10_000);
      const taken: Server[] = [];
      for (let i = 0; i <= count; i++) {
        const srv = await tryListen(base + i);
        if (srv === undefined) break;
        taken.push(srv);
      }
      const next = taken.length === count + 1 ? taken.pop() : undefined;
      if (next !== undefined) {
        await new Promise((r) => next.close(r));
        servers.push(...taken);
        return base;
      }
      await Promise.all(taken.map((s) => new Promise((r) => s.close(r))));
    }
  }

  async function startOn(port: number, extra: { portAttempts?: number } = {}) {
    const messages: string[] = [];
    const registry = new Registry();
    daemon = await startDaemon({
      projectDir,
      registry,
      port,
      ...extra,
      log: (message) => messages.push(message),
    });
    return { d: daemon, messages };
  }

  it('defaults to port 9147', () => {
    expect(DEFAULT_PORT).toBe(9147);
  });

  it('uses the next port when the chosen one is busy, and says so', async () => {
    const busy = await occupy(1);
    const { d, messages } = await startOn(busy);
    expect(d.port).toBe(busy + 1);
    expect(messages).toContain(`Port ${busy} is in use; using ${busy + 1}`);
    expect((await readRuntime(projectDir))?.port).toBe(busy + 1);
  });

  it('keeps going past several busy ports', async () => {
    const busy = await occupy(3);
    const { d, messages } = await startOn(busy);
    expect(d.port).toBe(busy + 3);
    expect(messages).toContain(`Port ${busy} is in use; using ${busy + 3}`);
  });

  it('falls back to an OS-assigned port when every attempt is busy', async () => {
    const busy = await occupy(2);
    const { d, messages } = await startOn(busy, { portAttempts: 2 });
    expect(d.port).not.toBe(busy);
    expect(d.port).not.toBe(busy + 1);
    expect(d.port).toBeGreaterThan(0);
    expect(messages).toContain(`Port ${busy} is in use; using ${d.port}`);
  });

  it('says nothing when the chosen port is free', async () => {
    const port = await freePort();
    const { d, messages } = await startOn(port);
    expect(d.port).toBe(port);
    expect(messages).toEqual([]);
  });
});

function tryListen(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(undefined));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** The pid of a process that has already exited. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.once('error', reject);
    child.once('exit', () => resolve(child.pid ?? -1));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
