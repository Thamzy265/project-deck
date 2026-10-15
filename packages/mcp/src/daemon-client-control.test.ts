import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimePath, writeRuntime } from '@project-deck/core/node';
import type { DaemonClientOptions } from './daemon-client.js';
import { DaemonClient, DaemonError, NOT_RUNNING } from './daemon-client.js';
import { FakeDaemon, initProject } from './testing/fake-daemon.js';

let projectDir: string;
let spawns: number;
const fakes: FakeDaemon[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-control-'));
  await initProject(projectDir);
  spawns = 0;
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await rm(projectDir, { recursive: true, force: true });
});

async function fake(): Promise<FakeDaemon> {
  const f = await FakeDaemon.start(projectDir);
  fakes.push(f);
  return f;
}

function client(opts: Partial<DaemonClientOptions> = {}): DaemonClient {
  return new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve('aaaaaaaaaaaa'),
    spawnDaemon: () => {
      spawns++;
    },
    readyTimeoutMs: 300,
    stopTimeoutMs: 300,
    pollMs: 20,
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

describe('DaemonClient.running', () => {
  it('is false without a daemon, and starts none', async () => {
    expect(await client().running()).toBe(false);
    expect(spawns).toBe(0);
  });

  it('is true for this project’s daemon after asking /api/health only', async () => {
    const f = await fake();
    expect(await client().running()).toBe(true);
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/health']);
    expect(f.requests[0]?.headers['x-deck-token']).toBeUndefined();
  });

  it('refuses a daemon of another project', async () => {
    const f = await fake();
    f.health = { ...f.health, projectId: 'bbbbbbbbbbbb' };
    expect((await rejection(client().running())).message).toContain('Another project');
  });

  it('refuses a linked .flutterdeck before reading anything', async () => {
    const other = await mkdtemp(join(tmpdir(), 'deck-mcp-control-other-'));
    try {
      await rm(join(projectDir, '.flutterdeck'), { recursive: true });
      await symlink(other, join(projectDir, '.flutterdeck'), 'dir');
      expect((await rejection(client().running())).message).toContain('not a real folder');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('DaemonClient.openLoginWindow without starting', () => {
  it('says the daemon is not running and starts none', async () => {
    const err = await rejection(client().openLoginWindow({ start: false }));
    expect(err.message).toBe(NOT_RUNNING);
    expect(spawns).toBe(0);
  });

  it('opens the window of a running daemon with the token', async () => {
    const f = await fake();
    const result = await client().openLoginWindow({ start: false });
    expect(result.ok).toBe(true);
    const call = f.requests.at(-1);
    expect(`${call?.method} ${call?.path}`).toBe('POST /api/login-window');
    expect(call?.headers['x-deck-token']).toBe(f.token);
  });
});

describe('DaemonClient.status without starting', () => {
  it('says the daemon is not running and starts none', async () => {
    const err = await rejection(client().status({ start: false }));
    expect(err.message).toBe(NOT_RUNNING);
    expect(spawns).toBe(0);
  });

  it('reads the status of a running daemon', async () => {
    await fake();
    const answer = await client().status({ start: false });
    expect(answer.value.projectName).toBe('shop_app');
  });
});

describe('DaemonClient.shutdown', () => {
  it('is false without a daemon, and starts none', async () => {
    expect(await client().shutdown()).toBe(false);
    expect(spawns).toBe(0);
  });

  it('asks the daemon to stop with the token, then waits for runtime.json to go', async () => {
    const f = await fake();
    f.route('POST', '/api/shutdown', () => {
      // The real daemon removes runtime.json a moment after it answers.
      setTimeout(() => void rm(runtimePath(projectDir), { force: true }), 50);
      return { status: 200, body: { ok: true } };
    });
    expect(await client().shutdown()).toBe(true);
    const call = f.requests.at(-1);
    expect(`${call?.method} ${call?.path}`).toBe('POST /api/shutdown');
    expect(call?.headers['x-deck-token']).toBe(f.token);
  });

  it('counts a runtime.json that now belongs to another daemon as stopped', async () => {
    const f = await fake();
    f.route('POST', '/api/shutdown', () => {
      // A new daemon (another start) replaced the file while this one stopped.
      setTimeout(() => {
        void writeRuntime(projectDir, {
          pid: process.pid + 1,
          port: f.port + 1,
          token: 'n'.repeat(43),
          startedAt: Date.now(),
        });
      }, 30);
      return { status: 200, body: { ok: true } };
    });
    expect(await client().shutdown()).toBe(true);
  });

  it('reports a daemon that answers but doesn’t stop in time', async () => {
    const f = await fake();
    f.route('POST', '/api/shutdown', () => ({ status: 200, body: { ok: true } }));
    const err = await rejection(client().shutdown());
    expect(err.message).toContain("didn't stop");
    expect(err.message).not.toContain(f.token);
  });

  it('works in a folder without config.json (a daemon started by hand)', async () => {
    await rm(join(projectDir, '.flutterdeck', 'config.json'));
    const f = await fake();
    f.route('POST', '/api/shutdown', () => {
      setTimeout(() => void rm(runtimePath(projectDir), { force: true }), 10);
      return { status: 200, body: { ok: true } };
    });
    expect(await client().shutdown()).toBe(true);
  });
});
