/**
 * A daemon that stalls is still ours (C1): a health probe that times out says "didn't
 * answer", never "another program uses the port". And what one call finds must not leak
 * into another call that runs at the same time.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonClient, NOT_RUNNING, portTakenText } from './daemon-client.js';
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
  await writeRuntime(projectDir, { pid: 424_242, port, token, startedAt: Date.now() });
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

  it('is not another program: a tool call says not running', async () => {
    const err = await client()
      .status({ start: false })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(NOT_RUNNING);
  });

  it('is not another program: stop has no other-program port to report', async () => {
    const c = client();
    await expect(c.shutdown()).resolves.toBe(false);
    await expect(c.otherProgramPort()).resolves.toBeUndefined();
  });
});

describe('a program that answers health without being Pitdeck', () => {
  it('is still reported as another program', async () => {
    handler = (_req, res) => foreign(res);
    const c = client();
    const err = await c.status({ start: false }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(portTakenText(port));
    await expect(c.otherProgramPort()).resolves.toBe(port);
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
