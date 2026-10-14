import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonClientOptions } from './daemon-client.js';
import { DaemonClient, DaemonError, NOT_RUNNING } from './daemon-client.js';
import { FakeDaemon } from './testing/fake-daemon.js';

let projectDir: string;
const fakes: FakeDaemon[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-'));
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
    spawnDaemon: () => undefined,
    readyTimeoutMs: 300,
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

describe('DaemonClient', () => {
  it('reads the status with the token header only, after checking health', async () => {
    const f = await fake();
    f.health = { ...f.health, projectId: 'aaaaaaaaaaaa' };
    const answer = await client().status();
    expect(answer.value.projectName).toBe('shop_app');
    expect(answer.warnings).toEqual([]);
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/health',
      'GET /api/status',
    ]);
    expect(f.requests[0]?.headers['x-deck-token']).toBeUndefined();
    expect(f.requests[1]?.headers['x-deck-token']).toBe(f.token);
    for (const r of f.requests) expect(r.headers.cookie).toBeUndefined();
  });

  it('passes log filters as query parameters', async () => {
    const f = await fake();
    f.logs = { entries: [{ ts: 1, level: 'warn', source: 'app', message: 'hi' }], truncated: true };
    const answer = await client().logs({ minLevel: 'warn', text: 'a b', limit: 5, since: 10 });
    expect(answer.value).toEqual(f.logs);
    const path = f.requests.at(-1)?.path ?? '';
    const params = new URL(path, 'http://x').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      minLevel: 'warn',
      text: 'a b',
      limit: '5',
      since: '10',
    });
  });

  it("refuses another project's daemon without sending it the token", async () => {
    const f = await fake();
    f.health = { ...f.health, projectId: 'bbbbbbbbbbbb' };
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toContain("Another project's FlutterDeck (project bbbbbbbbbbbb)");
    expect(err.message).toContain(`port ${f.port}`);
    expect(f.requests.every((r) => r.headers['x-deck-token'] === undefined)).toBe(true);
    expect(spawned).toBe(0);
  });

  it("sends no token to a daemon that doesn't say its project when ours is known", async () => {
    const f = await fake();
    f.health = { ok: true, name: 'project-deck', version: '0.0.0' };
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
      },
    });
    const err = await rejection(c.status());
    expect(err.message).toBe(
      `The program on port ${f.port} didn't say which project it serves, so FlutterDeck didn't send it the token. Run \`flutterdeck stop\` and try again.`,
    );
    expect(f.requests.every((r) => r.headers['x-deck-token'] === undefined)).toBe(true);
    expect(spawned).toBe(0);
  });

  it("reads this project's id again after it couldn't be read", async () => {
    const f = await fake();
    let calls = 0;
    const c = client({
      projectId: () => Promise.resolve(++calls === 1 ? undefined : 'aaaaaaaaaaaa'),
    });
    f.health = { ...f.health, projectId: 'bbbbbbbbbbbb' };
    // Unknown the first time: no check. Known the second time: the mismatch is found.
    expect((await c.status()).value.projectName).toBe('shop_app');
    expect((await rejection(c.status())).message).toContain("Another project's FlutterDeck");
  });

  it('skips the project check when either id is unknown', async () => {
    const f = await fake();
    f.health = { ...f.health, projectId: 'bbbbbbbbbbbb' };
    const answer = await client({ projectId: () => Promise.resolve(undefined) }).status();
    expect(answer.value.projectName).toBe('shop_app');
  });

  it('warns when the daemon has another version', async () => {
    const f = await fake();
    f.health = { ...f.health, version: '0.0.1' };
    const answer = await client({ version: '0.1.0' }).status();
    expect(answer.warnings).toEqual([
      'FlutterDeck daemon version 0.0.1 differs from this MCP server (0.1.0). Run `flutterdeck stop`; the next call starts the matching daemon.',
    ]);
  });

  it('adds the version warning to errors', async () => {
    const f = await fake();
    f.health = { ...f.health, version: '0.0.1' };
    f.route('GET', '/api/status', () => ({ status: 500, body: { error: 'boom' } }));
    const err = await rejection(client({ version: '0.1.0' }).status());
    expect(err.message).toContain('boom');
    expect(err.message).toContain('differs from this MCP server');
  });

  it('refuses an answer of the wrong shape', async () => {
    const f = await fake();
    f.route('GET', '/api/status', () => ({ status: 200, body: { version: 1 } }));
    const err = await rejection(client().status());
    expect(err.message).toBe('FlutterDeck daemon sent an unexpected answer to GET /api/status');
  });

  it('treats a non-FlutterDeck health answer as no daemon', async () => {
    const f = await fake();
    f.route('GET', '/api/health', () => ({ status: 200, body: { hello: 'world' } }));
    const err = await rejection(client().status());
    expect(err.message).toBe(NOT_RUNNING);
    expect(f.requests.every((r) => r.headers['x-deck-token'] === undefined)).toBe(true);
  });

  it('gives up on a call after the timeout', async () => {
    const f = await fake();
    f.route('GET', '/api/status', () => 'hang');
    const start = Date.now();
    const err = await rejection(client({ timeoutMs: 100 }).status());
    expect(Date.now() - start).toBeLessThan(2000);
    expect(err.message).toBe("FlutterDeck daemon didn't answer GET /api/status within 0.1 s");
  });

  it('reports a rejected token without showing it', async () => {
    const f = await fake();
    f.route('GET', '/api/status', () => ({
      status: 401,
      body: { error: 'Missing or invalid token' },
    }));
    const err = await rejection(client().status());
    expect(err.message).toContain('rejected the token in .flutterdeck/runtime.json');
    expect(err.message).not.toContain(f.token);
  });

  it("passes on the daemon's error text", async () => {
    const f = await fake();
    f.route('GET', '/api/logs', () => ({ status: 400, body: { error: 'Invalid request' } }));
    const err = await rejection(client().logs({}));
    expect(err.message).toBe('FlutterDeck daemon refused GET /api/logs: Invalid request (400)');
  });

  it('opens the login window with the token', async () => {
    const f = await fake();
    const result = await client().openLoginWindow();
    expect(result.ok).toBe(true);
    const post = f.requests.find((r) => r.path === '/api/login-window');
    expect(post?.method).toBe('POST');
    expect(post?.headers['x-deck-token']).toBe(f.token);
  });
});

describe('DaemonClient when the daemon is down', () => {
  it('starts it, waits until it is ready, and retries once', async () => {
    const spawned: string[] = [];
    const c = client({
      spawnDaemon: (dir) => {
        spawned.push(dir);
        setTimeout(() => void fake(), 50);
      },
    });
    const answer = await c.status();
    expect(answer.value.projectName).toBe('shop_app');
    expect(spawned).toEqual([projectDir]);
  });

  it('starts it when runtime.json is left over from a stopped daemon', async () => {
    const old = await fake();
    await old.stop();
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
        void fake();
      },
    });
    expect((await c.status()).value.projectName).toBe('shop_app');
    expect(spawned).toBe(1);
  });

  it('starts it only once for overlapping calls', async () => {
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
        setTimeout(() => void fake(), 50);
      },
    });
    await Promise.all([c.status(), c.logs({}), c.status()]);
    expect(spawned).toBe(1);
  });

  it("reports another project's daemon at once when one turns up after the start", async () => {
    const c = client({
      readyTimeoutMs: 5000,
      spawnDaemon: () => {
        void fake().then((f) => {
          f.health = { ...f.health, projectId: 'bbbbbbbbbbbb' };
        });
      },
    });
    const start = Date.now();
    const err = await rejection(c.status());
    expect(err.message).toContain("Another project's FlutterDeck (project bbbbbbbbbbbb)");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("says it isn't running when it doesn't come up in time", async () => {
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toBe(NOT_RUNNING);
    expect(NOT_RUNNING).toBe("FlutterDeck daemon isn't running: run `flutterdeck start`");
    expect(spawned).toBe(1);
  });

  it("says it isn't running when starting it throws", async () => {
    const c = client({
      spawnDaemon: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect((await rejection(c.status())).message).toBe(NOT_RUNNING);
  });

  it('starts it eagerly without a tool call, and opens the login window', async () => {
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
        void fake();
      },
    });
    await c.openLoginWindow();
    expect(spawned).toBe(1);
    expect(fakes[0]?.requests.some((r) => r.path === '/api/login-window')).toBe(true);
  });
});
