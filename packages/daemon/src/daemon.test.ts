import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Daemon } from './daemon.js';
import { DaemonAlreadyRunningError, startDaemon } from './daemon.js';
import { readRuntime, runtimePath, writeRuntime } from './runtime.js';

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
  const url = `ws://127.0.0.1:${d.port}/ws${token === undefined ? '' : `?token=${token}`}`;
  return new WebSocket(url, origin === undefined ? {} : { origin });
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

  it('releases the port when the runtime file cannot be written', async () => {
    const port = await freePort();
    const notADir = join(projectDir, 'file');
    await writeFile(notADir, '');
    await expect(
      startDaemon({ projectDir: notADir, registry: new Registry(), port, log: () => undefined }),
    ).rejects.toThrow();
    const d = await start(port);
    expect(d.port).toBe(port);
  });
});

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
