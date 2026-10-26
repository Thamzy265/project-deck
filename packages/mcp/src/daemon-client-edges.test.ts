/**
 * Tester probes of the daemon client: odd HTTP answers (redirect, HTML, slow or huge
 * body, a socket cut mid-answer), a damaged or hostile runtime.json, spawn storms, and
 * that the token only ever goes to 127.0.0.1 in a header, after a FlutterDeck health
 * answer. Local sockets only.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeRuntime } from '@project-deck/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClientOptions } from './daemon-client.js';
import { DaemonClient, DaemonError, NOT_RUNNING } from './daemon-client.js';
import { FAKE_STATUS, FakeDaemon, initProject } from './testing/fake-daemon.js';

/** Background work a test starts (a fake daemon, a log write): awaited after each test. */
const pending: Promise<unknown>[] = [];
function track(work: Promise<unknown>): void {
  pending.push(work.catch(() => undefined));
}

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];
/** Every token written to a runtime.json in this file. */
const tokens = new Set<string>();
/** Every URL fetch was asked for. */
const fetched: string[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-edges-'));
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
  for (const url of fetched.splice(0)) {
    // A string check: a bad port makes the URL itself invalid, which is fine.
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    for (const token of tokens) expect(url).not.toContain(token);
  }
});

async function fake(): Promise<FakeDaemon> {
  const f = await FakeDaemon.start(projectDir);
  tokens.add(f.token);
  cleanups.push(() => f.stop());
  return f;
}

/** `die` stops the server listening and drops its connections, like a daemon that exits. */
type Handler = (req: IncomingMessage, res: ServerResponse, die: () => void) => void;

interface RawDaemon {
  port: number;
  token: string;
  seen: { path: string; token: string | undefined }[];
}

/** A raw HTTP server on 127.0.0.1 with its runtime.json, for answers FakeDaemon can't give. */
async function raw(handler: Handler, health = true): Promise<RawDaemon> {
  const seen: RawDaemon['seen'] = [];
  const server: Server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const token = req.headers['x-deck-token'];
    seen.push({ path: req.url ?? '', token: typeof token === 'string' ? token : undefined });
    if (health && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The same project id the clients below know, so the token may go to it.
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
    handler(req, res, () => {
      server.close();
      server.closeAllConnections();
    });
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const token = randomBytes(32).toString('base64url');
  tokens.add(token);
  await writeRuntime(projectDir, { pid: process.pid, port, token, startedAt: Date.now() });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return { port, token, seen };
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

function expectNoSecret(text: string): void {
  for (const token of tokens) expect(text).not.toContain(token);
}

async function writeRawRuntime(content: string): Promise<void> {
  await mkdir(join(projectDir, '.flutterdeck'), { recursive: true });
  await writeFile(join(projectDir, '.flutterdeck', 'runtime.json'), content, { mode: 0o600 });
}

describe('odd answers from the daemon', () => {
  it('never follows a redirect, so the token never reaches the Location', async () => {
    const elsewhere = await raw(() => undefined, false);
    const d = await raw((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/steal` });
      res.end();
    });
    const err = await rejection(client().status());
    expect(err.message).toBe('FlutterDeck daemon refused GET /api/status: no reason given (302)');
    expect(elsewhere.seen).toEqual([]);
    expect(d.seen.map((s) => s.path)).toEqual(['/api/health', '/api/status']);
    expectNoSecret(err.message);
  });

  it('treats a redirect on /api/health as no daemon, and sends no token', async () => {
    const d = await raw((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      res.end();
    }, false);
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toBe(NOT_RUNNING);
    expect(spawned).toBe(1);
    expect(d.seen.every((s) => s.token === undefined)).toBe(true);
  });

  it('reports a 500 with an HTML body without echoing the page', async () => {
    await raw((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html><body>Internal error at /home/jane/secret</body></html>');
    });
    const err = await rejection(client().status());
    expect(err.message).toBe('FlutterDeck daemon refused GET /api/status: no reason given (500)');
  });

  it('reports a 200 with an HTML body as an unexpected answer', async () => {
    await raw((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    const err = await rejection(client().status());
    expect(err.message).toBe('FlutterDeck daemon sent an unexpected answer to GET /api/status');
  });

  async function slowBody(): Promise<void> {
    await raw((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"version":"0.0.0",');
    });
  }

  it('gives up on a body that starts but never ends, within the timeout', async () => {
    await slowBody();
    const start = performance.now();
    await rejection(client({ timeoutMs: 200 }).status());
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('BUG-MCP-T10: calls a body that never ends a timeout, not a wrong answer', async () => {
    await slowBody();
    const err = await rejection(client({ timeoutMs: 200 }).status());
    expect(err.message).toBe("FlutterDeck daemon didn't answer GET /api/status within 0.2 s");
  });

  it('refuses a huge answer of the wrong shape with a short message', async () => {
    const junk = JSON.stringify({ junk: 'j'.repeat(8_000_000) });
    await raw((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(junk);
    });
    const err = await rejection(client().status());
    expect(err.message.length).toBeLessThan(200);
  });

  it('passes on a long daemon error as given (the server masks it)', async () => {
    await raw((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad regex' }));
    });
    const err = await rejection(client().logs({ regex: '(' }));
    expect(err.message).toBe('FlutterDeck daemon refused GET /api/logs: bad regex (400)');
  });
});

describe('the daemon going away', () => {
  it('restarts a daemon that drops the connection mid-call, then retries once', async () => {
    // The daemon dies mid-call, so its port stops answering health too. Left answering,
    // the old runtime.json still points at it until the new daemon replaces the file,
    // and the client "finds" the dead one again (Windows CI, 26 Oct 2026).
    await raw((req, _res, die) => {
      req.socket.destroy();
      die();
    });
    let spawned = 0;
    const c = client({
      // A new runtime.json can take Windows more than the 0.3 s default to put in place.
      readyTimeoutMs: 3000,
      spawnDaemon: () => {
        spawned++;
        // A slow start, like Windows putting the new runtime.json in place.
        track(sleep(150).then(fake));
      },
    });
    expect((await c.status()).value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned).toBe(1);
  });

  it("says it isn't running when the restarted daemon drops the connection too", async () => {
    await raw((req) => req.socket.destroy());
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
      },
      readyTimeoutMs: 200,
    });
    const err = await rejection(c.status());
    // The first daemon still answers health, so each retry reaches it and fails again.
    // One call starts the daemon at most twice (QA B3-2, lead 14 Oct 2026).
    expect(err.message).toBe(NOT_RUNNING);
    expect(spawned).toBe(2);
  });

  it('spawns once for a storm of 20 calls, and never more than once per call', async () => {
    let spawned = 0;
    const c = client({
      spawnDaemon: () => {
        spawned++;
      },
      readyTimeoutMs: 200,
    });
    const calls = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? c.status() : c.logs({})));
    const results = await Promise.allSettled(calls);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(spawned).toBe(1);
    await rejection(c.status());
    expect(spawned).toBe(2);
  });
});

describe('a damaged or hostile runtime.json', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', '{"port":'],
    ['a JSON array', '[]'],
    ['a short token', JSON.stringify({ pid: 1, port: 9147, token: 'short', startedAt: 0 })],
    [
      'a string port',
      JSON.stringify({ pid: 1, port: '9147', token: 't'.repeat(43), startedAt: 0 }),
    ],
  ])('starts the daemon when the file is %s', async (_name, content) => {
    if (content !== undefined) await writeRawRuntime(content);
    let spawned = 0;
    const err = await rejection(
      client({
        spawnDaemon: () => {
          spawned++;
        },
      }).status(),
    );
    expect(err.message).toBe(NOT_RUNNING);
    expect(spawned).toBe(1);
  });

  it.each([0, -1, 65536, 99999])(
    'never connects anywhere but 127.0.0.1 for port %s',
    async (port) => {
      const token = 'p'.repeat(43);
      tokens.add(token);
      await writeRawRuntime(JSON.stringify({ pid: process.pid, port, token, startedAt: 0 }));
      const err = await rejection(client().status());
      expect(err.message).toBe(NOT_RUNNING);
    },
  );

  it('ignores host and url fields: only 127.0.0.1 is contacted', async () => {
    const f = await fake();
    await writeRawRuntime(
      JSON.stringify({
        pid: process.pid,
        port: f.port,
        token: f.token,
        startedAt: 0,
        host: '10.0.0.1',
        url: 'http://attacker.example/',
      }),
    );
    expect((await client().status()).value.projectName).toBe(FAKE_STATUS.projectName);
    expect(f.requests.map((r) => r.path)).toEqual(['/api/health', '/api/status']);
    // afterEach checks every fetched URL was on 127.0.0.1.
  });

  it('starts a new daemon when the pid is stale and nothing listens', async () => {
    const token = 's'.repeat(43);
    tokens.add(token);
    // A port nothing listens on: bind one, then close it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await writeRawRuntime(JSON.stringify({ pid: 999_999, port, token, startedAt: 0 }));
    let spawned = 0;
    const c = client({
      // A new runtime.json can take Windows more than the 0.3 s default to put in place.
      readyTimeoutMs: 3000,
      spawnDaemon: () => {
        spawned++;
        track(fake());
      },
    });
    expect((await c.status()).value.projectName).toBe(FAKE_STATUS.projectName);
    expect(spawned).toBe(1);
  });
});

describe('the token', () => {
  it("goes to no route at all on another project's daemon", async () => {
    const f = await fake();
    f.health = { ...f.health, projectId: 'bbbbbbbbbbbb' };
    for (const call of [
      () => client().status(),
      () => client().logs({}),
      () => client().openLoginWindow(),
    ]) {
      const err = await rejection(call());
      expect(err.message).toContain("Another project's FlutterDeck");
      expectNoSecret(err.message);
    }
    expect(f.requests.every((r) => r.path === '/api/health')).toBe(true);
    expect(f.requests.every((r) => r.headers['x-deck-token'] === undefined)).toBe(true);
  });

  it('travels only in the header, never in a query string, even with odd filters', async () => {
    const f = await fake();
    await client().logs({ text: '&token=x', tag: '?a=b#c', regex: 'x' });
    const logs = f.requests.find((r) => r.path.startsWith('/api/logs'));
    expect(logs?.headers['x-deck-token']).toBe(f.token);
    expect(logs?.path).not.toContain(f.token);
    const query = new URL(`http://127.0.0.1${logs?.path ?? ''}`).searchParams;
    expect(query.get('text')).toBe('&token=x');
    expect(query.get('tag')).toBe('?a=b#c');
    expect(query.get('token')).toBeNull();
  });
});
