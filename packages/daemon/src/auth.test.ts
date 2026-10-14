import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';

interface Reply {
  status: number;
  setCookie: string[];
  body: string;
}

const dirs: string[] = [];
const daemons: Daemon[] = [];

beforeEach(() => undefined);

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(projectDir?: string): Promise<Daemon> {
  const dir = projectDir ?? (await mkdtemp(join(tmpdir(), 'deck-auth-')));
  if (projectDir === undefined) dirs.push(dir);
  const registry = new Registry();
  registry.connectors.register(new FakeAppConnector('fake', [fakeApp()]));
  const d = await startDaemon({ projectDir: dir, registry, port: 0, log: () => undefined });
  daemons.push(d);
  return d;
}

/** Raw request: fetch would replace Host and drop the fetch-metadata headers. */
function send(
  d: Daemon,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: d.port,
        path,
        method,
        headers: { host: `127.0.0.1:${d.port}`, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            setCookie: res.headers['set-cookie'] ?? [],
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const NAVIGATION = {
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

/** Loads the page as a browser tab would and returns the `name=value` cookie pair. */
async function login(d: Daemon): Promise<string> {
  const res = await send(d, '/', NAVIGATION);
  expect(res.status).toBe(200);
  const cookie = res.setCookie[0];
  if (cookie === undefined) throw new Error('no cookie set');
  return cookie.split(';')[0] ?? '';
}

function sameOriginFetch(d: Daemon, cookie: string): Record<string, string> {
  return {
    cookie,
    origin: `http://127.0.0.1:${d.port}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  };
}

describe('dashboard login cookie', () => {
  it('is set on a top-level navigation to / with strict attributes and a per-port name', async () => {
    const d = await start();
    const res = await send(d, '/', NAVIGATION);
    expect(res.status).toBe(200);
    expect(res.body).toContain('FlutterDeck');
    expect(res.setCookie).toHaveLength(1);
    const [pair, ...attrs] = (res.setCookie[0] ?? '').split(';').map((p) => p.trim());
    expect(pair).toMatch(new RegExp(`^deck_session_${d.port}=[A-Za-z0-9_-]{43,}$`));
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/']));
  });

  it('holds a session secret, not the runtime.json token', async () => {
    const d = await start();
    const cookie = await login(d);
    expect(cookie.split('=')[1]).not.toBe(d.token);
    const tokenAsCookie = `deck_session_${d.port}=${d.token}`;
    expect((await send(d, '/api/status', sameOriginFetch(d, tokenAsCookie))).status).toBe(401);
  });

  it.each([
    ['same-origin navigation', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }],
    ['no fetch metadata (older browser)', {}],
  ])('is set for a %s', async (_name, headers) => {
    const d = await start();
    expect((await send(d, '/', headers)).setCookie).toHaveLength(1);
  });

  it.each([
    [
      'a page on another 127.0.0.1 port',
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
    ],
    ['another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }],
    ['a script fetch', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }],
    ['an embedded frame', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'no-cors' }],
    ['only half the metadata', { 'sec-fetch-site': 'none' }],
  ])('is not set for %s', async (_name, headers) => {
    const d = await start();
    expect((await send(d, '/', headers)).setCookie).toEqual([]);
  });

  it('is never set for a foreign Host (DNS rebinding)', async () => {
    const d = await start();
    const res = await send(d, '/', { ...NAVIGATION, host: `evil.example:${d.port}` });
    expect(res.status).toBe(403);
    expect(res.setCookie).toEqual([]);
  });

  it('opens the API for same-origin requests from the dashboard', async () => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', sameOriginFetch(d, cookie))).status).toBe(200);
    // A request with no fetch metadata and no Origin (an older browser) is accepted too.
    expect((await send(d, '/api/status', { cookie })).status).toBe(200);
    const post = await send(d, '/api/reload', sameOriginFetch(d, cookie), 'POST');
    expect(post.status).toBe(200);
  });

  it('is refused from a page on another 127.0.0.1 port', async () => {
    const d = await start();
    const cookie = await login(d);
    const otherPage = `http://127.0.0.1:${d.port === 65535 ? 65534 : d.port + 1}`;
    // A no-cors request carries the cookie but no Origin; fetch metadata gives it away.
    const noCors = { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' };
    expect((await send(d, '/api/status', noCors)).status).toBe(401);
    expect((await send(d, '/api/reload', noCors, 'POST')).status).toBe(401);
    const cors = { cookie, origin: otherPage, 'sec-fetch-site': 'same-site' };
    expect((await send(d, '/api/reload', cors, 'POST')).status).toBe(403);
  });

  it('needs the exact Origin of the Host it was sent to', async () => {
    const d = await start();
    const cookie = await login(d);
    const viaLocalhost = {
      cookie,
      host: `127.0.0.1:${d.port}`,
      origin: `http://localhost:${d.port}`,
      'sec-fetch-site': 'same-origin',
    };
    expect((await send(d, '/api/status', viaLocalhost)).status).toBe(401);
  });

  it('keeps two daemons apart: separate names, and one port refuses the other cookie', async () => {
    const a = await start();
    const b = await start();
    const cookieA = await login(a);
    const cookieB = await login(b);
    expect(cookieA.split('=')[0]).not.toBe(cookieB.split('=')[0]);
    // The browser sends both cookies to both ports; each daemon reads only its own.
    const both = `${cookieA}; ${cookieB}`;
    expect((await send(a, '/api/status', sameOriginFetch(a, both))).status).toBe(200);
    expect((await send(b, '/api/status', sameOriginFetch(b, both))).status).toBe(200);
    const valueA = cookieA.split('=')[1] ?? '';
    const wrongPort = `deck_session_${b.port}=${valueA}`;
    expect((await send(b, '/api/status', sameOriginFetch(b, wrongPort))).status).toBe(401);
    expect((await send(b, '/api/status', sameOriginFetch(b, cookieA))).status).toBe(401);
  });

  it('accepts its own cookie even when a stale duplicate with the same name comes first', async () => {
    const d = await start();
    const cookie = await login(d);
    const stale = `deck_session_${d.port}=stale`;
    expect((await send(d, '/api/status', sameOriginFetch(d, `${stale}; ${cookie}`))).status).toBe(
      200,
    );
  });

  it('stops working after a daemon restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-auth-'));
    dirs.push(dir);
    const first = await start(dir);
    const cookie = await login(first);
    const port = first.port;
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);
    const registry = new Registry();
    const second = await startDaemon({ projectDir: dir, registry, port, log: () => undefined });
    daemons.push(second);
    expect(second.port).toBe(port);
    expect((await send(second, '/api/status', sameOriginFetch(second, cookie))).status).toBe(401);
    expect(
      (await send(second, '/api/status', sameOriginFetch(second, await login(second)))).status,
    ).toBe(200);
  });

  it('has no GET route that changes anything', async () => {
    const d = await start();
    const cookie = await login(d);
    for (const path of [
      '/api/reload',
      '/api/restart',
      '/api/detach',
      '/api/shutdown',
      '/api/apps/app-1/attach',
    ]) {
      expect((await send(d, path, sameOriginFetch(d, cookie))).status).toBe(404);
    }
  });
});

describe('WebSocket login', () => {
  function connect(d: Daemon, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}${path}`, { headers });
      ws.on('error', () => undefined);
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
  }

  it('accepts the cookie from the dashboard origin', async () => {
    const d = await start();
    const cookie = await login(d);
    const headers = {
      cookie,
      origin: `http://127.0.0.1:${d.port}`,
      'sec-fetch-site': 'same-origin',
    };
    expect(await connect(d, '/ws', headers)).toBe(101);
  });

  it('refuses the cookie when a wrong token header comes with it', async () => {
    const d = await start();
    const cookie = await login(d);
    const headers = {
      cookie,
      origin: `http://127.0.0.1:${d.port}`,
      'sec-fetch-site': 'same-origin',
      'x-deck-token': 'wrong',
    };
    expect(await connect(d, '/ws', headers)).toBe(401);
  });

  it('accepts the token header', async () => {
    const d = await start();
    expect(await connect(d, '/ws', { 'x-deck-token': d.token })).toBe(101);
  });

  it('refuses a socket with neither cookie nor token', async () => {
    const d = await start();
    expect(await connect(d, '/ws', {})).toBe(401);
  });

  it('never accepts the token in the query string', async () => {
    const d = await start();
    expect(await connect(d, `/ws?token=${encodeURIComponent(d.token)}`, {})).toBe(401);
  });

  it('refuses the cookie from a page on another 127.0.0.1 port', async () => {
    const d = await start();
    const cookie = await login(d);
    const other = `http://127.0.0.1:${d.port === 65535 ? 65534 : d.port + 1}`;
    expect(await connect(d, '/ws', { cookie, origin: other, 'sec-fetch-site': 'same-site' })).toBe(
      403,
    );
    expect(await connect(d, '/ws', { cookie, 'sec-fetch-site': 'same-site' })).toBe(401);
  });

  it('refuses an old cookie after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-auth-'));
    dirs.push(dir);
    const first = await start(dir);
    const cookie = await login(first);
    const port = first.port;
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);
    const second = await startDaemon({
      projectDir: dir,
      registry: new Registry(),
      port,
      log: () => undefined,
    });
    daemons.push(second);
    const headers = { cookie, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' };
    expect(await connect(second, '/ws', headers)).toBe(401);
  });
});
