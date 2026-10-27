/**
 * Tester probes of the restart after a daemon dies mid-call: how late the new daemon
 * writes its runtime.json (0 ms, 150 ms, 1 s), and a daemon that dies before it answers
 * health. The old daemon's port is closed, as for a real exit.
 * Local sockets only; the delays are the test's own and no assertion measures time.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from './daemon-client.js';
import { FAKE_STATUS, FakeDaemon, initProject } from './testing/fake-daemon.js';

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];
/** Why a fake daemon didn't start: without it, a test only sees "isn't running". */
const startErrors: unknown[] = [];
/** Every token written to a runtime.json in this file. */
const tokens = new Set<string>();
/** Every URL fetch was asked for. */
const fetched: string[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-restart-'));
  await initProject(projectDir);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  });
});

afterEach(async () => {
  await Promise.all(pending.splice(0));
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(projectDir, { recursive: true, force: true });
  expect(startErrors.splice(0)).toEqual([]);
  for (const url of fetched.splice(0)) {
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    for (const token of tokens) expect(url).not.toContain(token);
  }
});

/** A server that answers health only when `healthy`, and dies on its first other call. */
async function dyingDaemon(healthy: boolean): Promise<void> {
  const server: Server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    if (healthy && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          name: 'project-deck',
          version: '0.0.0',
          projectId: 'aaaaaaaaaaaa',
        }),
      );
      return;
    }
    req.socket.destroy();
    server.close();
    server.closeAllConnections();
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const token = 'r'.repeat(43);
  tokens.add(token);
  await writeRuntime(projectDir, { pid: process.pid, port, token, startedAt: Date.now() });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
}

function restartingClient(startDelayMs: number, readyTimeoutMs: number) {
  const state = { spawned: 0 };
  const client = new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve('aaaaaaaaaaaa'),
    readyTimeoutMs,
    pollMs: 20,
    spawnDaemon: () => {
      state.spawned++;
      pending.push(
        sleep(startDelayMs)
          .then(() => FakeDaemon.start(projectDir))
          .then((f) => {
            tokens.add(f.token);
            cleanups.push(() => f.stop());
          })
          .catch((err: unknown) => {
            startErrors.push(err);
          }),
      );
    },
  });
  return { client, state };
}

describe('restarting a daemon that died mid-call', () => {
  it.each([
    ['at once', 0, 3000],
    ['after 150 ms', 150, 3000],
    // A 3 s ready timeout like the others: on Windows the rename of runtime.json can be
    // retried for more than 0.6 s (core's retryWhileBusy), so 0.5 s to spare wasn't enough.
    ['after 1 s', 1000, 3000],
  ])(
    'spawns once and answers when the new daemon starts %s (health was answered)',
    async (_name, startDelayMs, readyTimeoutMs) => {
      await dyingDaemon(true);
      const { client, state } = restartingClient(startDelayMs, readyTimeoutMs);
      expect((await client.status()).value.projectName).toBe(FAKE_STATUS.projectName);
      expect(state.spawned).toBe(1);
    },
  );

  it('spawns once and answers when the daemon died before it answered health', async () => {
    await dyingDaemon(false);
    const { client, state } = restartingClient(150, 3000);
    expect((await client.status()).value.projectName).toBe(FAKE_STATUS.projectName);
    expect(state.spawned).toBe(1);
  });

  it('spawns once for two calls that both hit the dying daemon', async () => {
    await dyingDaemon(true);
    const { client, state } = restartingClient(150, 3000);
    const [a, b] = await Promise.all([client.status(), client.status()]);
    expect(a.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(b.value.projectName).toBe(FAKE_STATUS.projectName);
    expect(state.spawned).toBe(1);
  });
});
