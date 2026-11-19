/**
 * A daemon that stalls is still ours (C1): a health probe that times out says "didn't
 * answer", never "another program uses the port" and never "not running": `stop` fails,
 * and a tool call starts nothing beside it (R2, R3). And what one call finds must not leak
 * into another call that runs at the same time.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DaemonClient,
  NOT_RUNNING,
  droppedShutdownText,
  portTakenText,
  stalledText,
} from './daemon-client.js';
import { FAKE_PROJECT_ID, initProject } from './testing/fake-daemon.js';

let projectDir: string;
let server: Server;
let port: number;
let handler: (req: IncomingMessage, res: ServerResponse, n: number) => void;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-probe-'));
  await initProject(projectDir);
  let n = 0;
  server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    handler(req, res, ++n);
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // Built at run time so it never looks like a real credential.
  const token = randomBytes(32).toString('base64url');
  await writeRuntime(projectDir, { pid: process.pid, port, token, startedAt: Date.now() });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function client(): DaemonClient {
  return new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve(FAKE_PROJECT_ID),
    spawnDaemon: () => undefined,
    timeoutMs: 100,
    readyTimeoutMs: 200,
    stopTimeoutMs: 200,
    pollMs: 10,
  });
}

const foreign = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, name: 'something-else' }));
};

describe('a health probe that times out', () => {
  beforeEach(() => {
    // Never answers: a daemon that stalled.
    handler = () => undefined;
  });

  it('says it stalled, not "not running" and not another program', async () => {
    const err = await client()
      .status({ start: false })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(stalledText(port, process.pid));
    expect((err as Error).message).not.toContain('Another program');
  });

  it('starts nothing beside it when a tool call may start a daemon', async () => {
    let spawned = 0;
    const c = new DaemonClient({
      projectDir,
      version: '0.0.0',
      projectId: () => Promise.resolve(FAKE_PROJECT_ID),
      spawnDaemon: () => {
        spawned++;
        return undefined;
      },
      timeoutMs: 100,
      readyTimeoutMs: 200,
      stopTimeoutMs: 200,
      pollMs: 10,
    });
    const err = await c.status().catch((e: unknown) => e);
    expect((err as Error).message).toBe(stalledText(port, process.pid));
    expect(spawned).toBe(0);
  });

  it('is not "isn\'t running" for stop: it fails and names the pid to quit', async () => {
    const err = await client()
      .shutdown()
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain(`pid ${process.pid}`);
    expect((err as Error).message).toContain(`port ${port}`);
    expect((err as Error).message).toContain("didn't answer");
    expect((err as Error).message).toContain(`Quit process ${process.pid} by hand`);
    expect((err as Error).message).not.toBe(droppedShutdownText(port, process.pid));
  });

  it('tells the user the way out when no Pitdeck runs', async () => {
    const err = await client()
      .status({ start: false })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('delete .pitdeck/runtime.json if no Pitdeck runs');
  });

  it('stop() fails the same way, after a single look', async () => {
    const result = await client()
      .stop()
      .catch((e: unknown) => e);
    expect((result as Error).message).toContain(`Quit process ${process.pid} by hand`);
  });
});

/** A pid that no process holds now: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid ?? 0;
}

describe('a health probe that times out when runtime.json is stale (R4)', () => {
  beforeEach(async () => {
    // Something unrelated listens on the old port and never answers.
    handler = () => undefined;
    const pid = await deadPid();
    await writeRuntime(projectDir, { pid, port, token: 'x'.repeat(43), startedAt: Date.now() });
  });

  it('is not a stalled daemon when its pid is gone: status says not running', async () => {
    const err = await client()
      .status({ start: false })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(NOT_RUNNING);
  });

  it('lets stop() finish instead of throwing', async () => {
    await expect(client().stop()).resolves.toEqual({ stopped: false });
  });

  it('lets a tool call start a daemon', async () => {
    let spawned = 0;
    const c = new DaemonClient({
      projectDir,
      version: '0.0.0',
      projectId: () => Promise.resolve(FAKE_PROJECT_ID),
      spawnDaemon: () => {
        spawned++;
      },
      timeoutMs: 100,
      readyTimeoutMs: 200,
      stopTimeoutMs: 200,
      pollMs: 10,
    });
    await c.status().catch(() => undefined);
    expect(spawned).toBe(1);
  });
});

describe('a program that answers health without being Pitdeck', () => {
  it('is still reported as another program', async () => {
    handler = (_req, res) => foreign(res);
    const err = await client()
      .status({ start: false })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(portTakenText(port));
    await expect(client().stop()).resolves.toEqual({ stopped: false, otherPort: port });
  });
});

describe('calls that overlap', () => {
  it('keep what each found: a slow "nothing listens" is not told "another program"', async () => {
    // The first request to arrive is dropped after a while; the second is answered
    // by a foreign program at once. Shared state would give both calls the port text.
    handler = (_req, res, n) => {
      if (n === 1) setTimeout(() => res.destroy(), 80);
      else foreign(res);
    };
    const c = client();
    const results = await Promise.all([
      c.status({ start: false }).catch((e: unknown) => (e as Error).message),
      c.status({ start: false }).catch((e: unknown) => (e as Error).message),
    ]);
    expect(results.sort()).toEqual([NOT_RUNNING, portTakenText(port)].sort());
  });
});
