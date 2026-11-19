/**
 * A daemon from a dev checkout that predates the rename still answers /api/health with
 * the name `project-deck` (M5 batch 3). The MCP client must not take it for a Pitdeck:
 * it never gets the token, a shutdown or a tool call. Shape: /api/health before 44bd5f8.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonClient, DaemonError, NOT_RUNNING, portTakenText } from './daemon-client.js';
import { FAKE_PROJECT_ID, initProject } from './testing/fake-daemon.js';

let projectDir: string;
let server: Server;
let token: string;
let seen: { route: string; token: string | undefined }[];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-oldname-'));
  await initProject(projectDir);
  seen = [];
  // Built at run time so it never looks like a real credential.
  token = randomBytes(32).toString('base64url');
  server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const sent = req.headers['x-deck-token'];
    seen.push({
      route: `${req.method ?? ''} ${req.url ?? ''}`,
      token: typeof sent === 'string' ? sent : undefined,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        name: 'project-deck',
        version: '0.0.0',
        projectId: FAKE_PROJECT_ID,
      }),
    );
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await writeRuntime(projectDir, { pid: 424_242, port, token, startedAt: Date.now() });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function client(): { client: DaemonClient; spawned: () => number } {
  let spawned = 0;
  const c = new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve(FAKE_PROJECT_ID),
    spawnDaemon: () => {
      spawned++;
    },
    readyTimeoutMs: 300,
    stopTimeoutMs: 300,
    pollMs: 10,
  });
  return { client: c, spawned: () => spawned };
}

const onlyUntokenedHealth = (): void => {
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((s) => s.route !== 'GET /api/health')).toEqual([]);
  expect(seen.every((s) => s.token === undefined)).toBe(true);
};

describe('the MCP client against a daemon that still says project-deck', () => {
  it('status without starting: says another program holds the port, and the token stays home', async () => {
    const { client: c, spawned } = client();
    const err = await c.status({ start: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    const { port } = server.address() as AddressInfo;
    expect((err as DaemonError).message).toBe(portTakenText(port));
    expect((err as DaemonError).message).not.toBe(NOT_RUNNING);
    expect(spawned()).toBe(0);
    onlyUntokenedHealth();
  });

  it('status that may start a daemon: tries to start, still never sends the token', async () => {
    const { client: c, spawned } = client();
    await expect(c.status()).rejects.toBeInstanceOf(DaemonError);
    expect(spawned()).toBeGreaterThan(0);
    onlyUntokenedHealth();
  });

  it('shutdown and the other calls never reach the old daemon with the token', async () => {
    const { client: c } = client();
    await expect(c.shutdown()).resolves.toBe(false);
    await expect(c.logs({ limit: 5 })).rejects.toBeInstanceOf(DaemonError);
    onlyUntokenedHealth();
  });

  it('never puts the token in an error message', async () => {
    const { client: c } = client();
    const err = await c.status().catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(token);
  });
});
