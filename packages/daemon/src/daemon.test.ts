import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Daemon } from './daemon.js';
import { DaemonAlreadyRunningError, startDaemon } from './daemon.js';
import { readRuntime, runtimePath } from './runtime.js';

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

  it('reports an already-running daemon on the same port', async () => {
    const d = await start();
    const registry = new Registry();
    await expect(
      startDaemon({ projectDir, registry, port: d.port, log: () => undefined }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('removes the runtime file and resolves closed on shutdown', async () => {
    const d = await start();
    await fetch(`${d.url}/api/shutdown`, { method: 'POST', headers: { 'x-deck-token': d.token } });
    await d.closed;
    expect(await readRuntime(projectDir)).toBeUndefined();
  });
});
