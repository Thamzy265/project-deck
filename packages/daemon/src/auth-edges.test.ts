/**
 * Tester's edge cases for the dashboard login (ADR 0001) and the Host/Origin checks:
 * odd Cookie headers, Origin and Host variants, fetch metadata, every route, and the
 * WebSocket upgrade. Each "refused" case first shows the same cookie works when the
 * request is right, so the refusal is about the edge, not a broken login.
 */
import { Agent, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  setCookie: string[];
  body: string;
}

const dirs: string[] = [];
let shared: Daemon | undefined;
/**
 * One kept-alive connection: hundreds of fresh client sockets would compete for local
 * ports with the port-selection tests that run in parallel.
 */
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

afterAll(async () => {
  agent.destroy();
  await shared?.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fresh(): Promise<Daemon> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-auth-edges-'));
  dirs.push(dir);
  const registry = new Registry();
  registry.connectors.register(new FakeAppConnector('fake', [fakeApp()]));
  return startDaemon({ projectDir: dir, registry, port: 0, log: () => undefined });
}

/** One daemon for the whole file: no test here changes what the others check. */
async function start(): Promise<Daemon> {
  shared ??= await fresh();
  return shared;
}

/** Raw request: fetch would replace Host and drop the fetch-metadata headers. */
function send(
  d: Daemon,
  path: string,
  headers: Record<string, string | string[]> = {},
  method = 'GET',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: d.port,
        path,
        method,
        agent,
        headers: { host: `127.0.0.1:${d.port}`, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
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

async function login(d: Daemon, host = `127.0.0.1:${d.port}`): Promise<string> {
  const res = await send(d, '/', { ...NAVIGATION, host });
  const cookie = res.setCookie[0];
  if (cookie === undefined) throw new Error('no cookie set');
  return cookie.split(';')[0] ?? '';
}

function secretOf(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

function sameOrigin(d: Daemon, cookie: string): Record<string, string> {
  return {
    cookie,
    origin: `http://127.0.0.1:${d.port}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  };
}

function otherPort(d: Daemon): number {
  return d.port === 65535 ? 65534 : d.port + 1;
}

describe('cookie header edge cases', () => {
  it('accepts its cookie when a stale duplicate comes after it', async () => {
    const d = await start();
    const cookie = await login(d);
    const stale = `deck_session_${d.port}=stale`;
    const res = await send(d, '/api/status', sameOrigin(d, `${cookie}; ${stale}`));
    expect(res.status).toBe(200);
  });

  it('refuses when every copy of its cookie is stale', async () => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', sameOrigin(d, cookie))).status).toBe(200);
    const stale = `deck_session_${d.port}=old1; deck_session_${d.port}=old2`;
    expect((await send(d, '/api/status', sameOrigin(d, stale))).status).toBe(401);
  });

  it('finds its cookie among many deck_session_* cookies for other ports', async () => {
    const d = await start();
    const cookie = await login(d);
    const others = Array.from({ length: 50 }, (_, i) => `deck_session_${i + 1}=x${i}`);
    const header = [...others.slice(0, 25), cookie, ...others.slice(25)].join('; ');
    expect((await send(d, '/api/status', sameOrigin(d, header))).status).toBe(200);
  });

  it.each([
    ['a longer port number', (p: number) => `deck_session_${p}0`],
    ['a shorter port number', (p: number) => `deck_session_${String(p).slice(0, -1)}`],
    ['upper case', (p: number) => `DECK_SESSION_${p}`],
    ['no port', () => 'deck_session_'],
    ['another prefix', (p: number) => `x_deck_session_${p}`],
  ])('ignores its secret under a name with %s', async (_name, nameFor) => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', sameOrigin(d, cookie))).status).toBe(200);
    const renamed = `${nameFor(d.port)}=${secretOf(cookie)}`;
    expect((await send(d, '/api/status', sameOrigin(d, renamed))).status).toBe(401);
  });

  it.each([
    ['only separators', () => ';;;'],
    ['a bare equals sign', () => '='],
    ['its name without a value', (p: number) => `deck_session_${p}`],
    ['its name with an empty value', (p: number) => `deck_session_${p}=`],
    ['its name with a quoted value', (p: number, s: string) => `deck_session_${p}="${s}"`],
    ['its secret with a suffix', (p: number, s: string) => `deck_session_${p}=${s}x`],
    ['its secret cut short', (p: number, s: string) => `deck_session_${p}=${s.slice(0, -1)}`],
    ['commas, spaces and tabs', (p: number) => `deck_session_${p}=a,b c\td`],
    ['a huge value', (p: number) => `deck_session_${p}=${'a'.repeat(8000)}`],
  ])('refuses a Cookie header with %s, without an error', async (_name, build) => {
    const d = await start();
    const cookie = await login(d);
    const header = build(d.port, secretOf(cookie));
    const res = await send(d, '/api/status', sameOrigin(d, header));
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing or invalid token' });
  });

  it('finds its cookie in the second of two Cookie header lines', async () => {
    const d = await start();
    const cookie = await login(d);
    const twoLines = {
      ...sameOrigin(d, cookie),
      cookie: [`deck_session_${d.port}=stale`, cookie],
    };
    expect((await send(d, '/api/status', twoLines)).status).toBe(200);
  });

  it('accepts its cookie with spaces around the pair', async () => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', sameOrigin(d, `  ${cookie}  ;`))).status).toBe(200);
  });

  // Lead decision (14 Oct 2026): a wrong credential is never ignored, even when a valid
  // cookie comes with it.
  it('refuses a valid cookie when a wrong token header comes with it', async () => {
    const d = await start();
    const cookie = await login(d);
    const withWrongToken = { ...sameOrigin(d, cookie), 'x-deck-token': 'wrong' };
    expect((await send(d, '/api/status', withWrongToken)).status).toBe(401);
    const withWrongBearer = { ...sameOrigin(d, cookie), authorization: 'Bearer wrong' };
    expect((await send(d, '/api/status', withWrongBearer)).status).toBe(401);
    const withRightToken = { ...sameOrigin(d, cookie), 'x-deck-token': d.token };
    expect((await send(d, '/api/status', withRightToken)).status).toBe(200);
  });

  it('never accepts the session secret as a token header', async () => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', { 'x-deck-token': secretOf(cookie) })).status).toBe(401);
    const bearer = { authorization: `Bearer ${secretOf(cookie)}` };
    expect((await send(d, '/api/status', bearer)).status).toBe(401);
  });

  it('accepts the token header with no fetch-metadata rules (MCP server, CLI)', async () => {
    const d = await start();
    const crossSite = {
      'x-deck-token': d.token,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'no-cors',
    };
    expect((await send(d, '/api/status', crossSite)).status).toBe(200);
  });
});

describe('Origin edge cases with a valid cookie', () => {
  it.each([
    ['null (sandboxed frame, file: page)', () => 'null'],
    ['a trailing slash', (p: number) => `http://127.0.0.1:${p}/`],
    ['upper case', (p: number) => `http://LOCALHOST:${p}`],
    ['https', (p: number) => `https://127.0.0.1:${p}`],
    ['no port', () => 'http://127.0.0.1'],
    ['an IPv6 loopback', (p: number) => `http://[::1]:${p}`],
    ['a userinfo part', (p: number) => `http://a@127.0.0.1:${p}`],
    ['a path', (p: number) => `http://127.0.0.1:${p}/api`],
    ['another site', () => 'https://evil.example'],
  ])('refuses an Origin with %s', async (_name, originFor) => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', sameOrigin(d, cookie))).status).toBe(200);
    const res = await send(d, '/api/status', {
      ...sameOrigin(d, cookie),
      origin: originFor(d.port),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a localhost Origin on a 127.0.0.1 Host, and the reverse', async () => {
    const d = await start();
    const cookie = await login(d);
    const ipHost = {
      ...sameOrigin(d, cookie),
      host: `127.0.0.1:${d.port}`,
      origin: `http://localhost:${d.port}`,
    };
    expect((await send(d, '/api/status', ipHost)).status).toBe(401);
    const nameHost = {
      ...sameOrigin(d, cookie),
      host: `localhost:${d.port}`,
      origin: `http://127.0.0.1:${d.port}`,
    };
    expect((await send(d, '/api/status', nameHost)).status).toBe(401);
  });

  it('works on localhost when Host and Origin both say localhost', async () => {
    const d = await start();
    const cookie = await login(d, `localhost:${d.port}`);
    const headers = {
      ...sameOrigin(d, cookie),
      host: `localhost:${d.port}`,
      origin: `http://localhost:${d.port}`,
    };
    expect((await send(d, '/api/status', headers)).status).toBe(200);
  });
});

describe('Host edge cases', () => {
  /** HTTP/1.0 lets a request leave out Host; Node only insists on it for HTTP/1.1. */
  function rawStatus(d: Daemon, lines: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(d.port, '127.0.0.1');
      let data = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => (data += chunk.toString('utf8')));
      socket.on('end', () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0)));
      socket.write([...lines, '', ''].join('\r\n'));
    });
  }

  it('refuses a request with no Host header', async () => {
    const d = await start();
    // Node or the Host check refuses it; either way it never reaches a route.
    expect([400, 403]).toContain(await rawStatus(d, ['GET /api/health HTTP/1.0']));
    expect([400, 403]).toContain(await rawStatus(d, ['GET / HTTP/1.0', 'Sec-Fetch-Site: none']));
    expect(await rawStatus(d, ['GET /api/health HTTP/1.0', `Host: 127.0.0.1:${d.port}`])).toBe(200);
  });

  it.each([
    ['an IPv6 loopback', (p: number) => `[::1]:${p}`],
    ['no port', () => '127.0.0.1'],
    ['another port', (p: number) => `127.0.0.1:${p === 65535 ? 65534 : p + 1}`],
    ['upper case', (p: number) => `LOCALHOST:${p}`],
    ['a trailing dot', (p: number) => `localhost.:${p}`],
    ['a subdomain of localhost', (p: number) => `evil.localhost:${p}`],
    ['0.0.0.0', (p: number) => `0.0.0.0:${p}`],
    ['127.0.0.2', (p: number) => `127.0.0.2:${p}`],
  ])('refuses a Host with %s on every path, including / and health', async (_name, hostFor) => {
    const d = await start();
    const host = hostFor(d.port);
    for (const path of ['/', '/api/health', '/api/status']) {
      const res = await send(d, path, { ...NAVIGATION, host, 'x-deck-token': d.token });
      expect(res.status).toBe(403);
      expect(res.setCookie).toEqual([]);
    }
  });
});

describe('fetch metadata with a valid cookie', () => {
  it.each([
    ['same-site (a page on another 127.0.0.1 port)', 'same-site'],
    ['cross-site', 'cross-site'],
    ['none (typed into the address bar)', 'none'],
    ['an upper-case value', 'SAME-ORIGIN'],
    ['an empty value', ''],
  ])('refuses Sec-Fetch-Site %s', async (_name, site) => {
    const d = await start();
    const cookie = await login(d);
    expect((await send(d, '/api/status', sameOrigin(d, cookie))).status).toBe(200);
    const res = await send(d, '/api/status', { ...sameOrigin(d, cookie), 'sec-fetch-site': site });
    expect(res.status).toBe(401);
  });

  it('never sets the cookie on a cross-site navigation, but still serves the page', async () => {
    const d = await start();
    const res = await send(d, '/', { ...NAVIGATION, 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(200);
    expect(res.setCookie).toEqual([]);
    // The control: the same navigation from the address bar does get it.
    expect((await send(d, '/', NAVIGATION)).setCookie).toHaveLength(1);
  });

  it('never sets the cookie when only Sec-Fetch-Mode is sent', async () => {
    const d = await start();
    expect((await send(d, '/', { 'sec-fetch-mode': 'navigate' })).setCookie).toEqual([]);
  });

  it('never sets the cookie on a foreign Origin, even with navigation metadata', async () => {
    const d = await start();
    const res = await send(d, '/', { ...NAVIGATION, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.setCookie).toEqual([]);
  });
});

describe('methods on /', () => {
  it('answers HEAD like GET, with no body', async () => {
    const d = await start();
    const res = await send(d, '/', NAVIGATION, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.setCookie).toHaveLength(1);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(['OPTIONS', 'POST', 'PUT', 'DELETE'])(
    'answers %s with 404 and never sets the cookie',
    async (method) => {
      const d = await start();
      const res = await send(d, '/', NAVIGATION, method);
      expect(res.status).toBe(404);
      expect(res.setCookie).toEqual([]);
    },
  );
});

/** Every route behind auth. Shutdown is checked only for refusals, then once at the end. */
const ROUTES: [method: string, path: string][] = [
  ['GET', '/api/status'],
  ['GET', '/api/apps'],
  ['POST', '/api/apps/app-1/attach'],
  ['POST', '/api/detach'],
  ['POST', '/api/reload'],
  ['POST', '/api/restart'],
  ['GET', '/api/logs'],
  ['DELETE', '/api/logs'],
  ['GET', '/api/activity'],
  ['POST', '/api/events'],
  ['POST', '/api/shutdown'],
];

describe('auth on every route', () => {
  it.each(ROUTES)('%s %s needs auth', async (method, path) => {
    const d = await start();
    expect((await send(d, path, {}, method)).status).toBe(401);
  });

  it.each(ROUTES)('%s %s refuses the cookie with bad fetch metadata', async (method, path) => {
    const d = await start();
    const cookie = await login(d);
    const cases: Record<string, string>[] = [
      { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
      { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' },
      { cookie, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
      { ...sameOrigin(d, cookie), origin: `http://localhost:${d.port}` },
    ];
    for (const headers of cases) expect((await send(d, path, headers, method)).status).toBe(401);
    const foreign = { ...sameOrigin(d, cookie), origin: `http://127.0.0.1:${otherPort(d)}` };
    expect((await send(d, path, foreign, method)).status).toBe(403);
  });

  it('keeps running after refused shutdowns and DELETE /api/logs keeps the logs', async () => {
    const d = await start();
    const cookie = await login(d);
    d.bus.emit('claude.done', {});
    const bad = { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
    expect((await send(d, '/api/shutdown', bad, 'POST')).status).toBe(401);
    expect((await send(d, '/api/logs', bad, 'DELETE')).status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect((await send(d, '/api/health')).status).toBe(200);
  });

  it.each(ROUTES.filter(([, path]) => path !== '/api/shutdown'))(
    '%s %s opens for a same-origin cookie request',
    async (method, path) => {
      const d = await start();
      const cookie = await login(d);
      const res = await send(d, path, sameOrigin(d, cookie), method);
      expect([401, 403]).not.toContain(res.status);
    },
  );

  it('shuts down for a same-origin cookie request', async () => {
    const d = await fresh();
    const cookie = await login(d);
    expect((await send(d, '/api/shutdown', sameOrigin(d, cookie), 'POST')).status).toBe(200);
    await d.closed;
  });
});

describe('path variants never skip auth', () => {
  it.each([
    '/api/status/',
    '/API/status',
    '//api/status',
    '/api//status',
    '/%61pi/status',
    '/api/%73tatus',
    '/api/../api/status',
    '/./api/status',
    '/x/../api/status',
    '/api/status?token=x',
    '/api/status#x',
    '/api/health/../status',
  ])('%s', async (path) => {
    const d = await start();
    const res = await send(d, path);
    expect([401, 404]).toContain(res.status);
    expect(res.body).not.toContain('dashboardUrl');
  });
});

describe('security headers on refusals and errors', () => {
  async function replies(d: Daemon): Promise<[string, Reply][]> {
    return [
      ['401', await send(d, '/api/status')],
      ['403 host', await send(d, '/api/status', { host: `evil.example:${d.port}` })],
      ['403 origin', await send(d, '/api/status', { origin: 'https://evil.example' })],
      ['404', await send(d, '/nope')],
      ['404 api', await send(d, '/api/nope', { 'x-deck-token': d.token })],
      [
        '400',
        await send(
          d,
          '/api/events',
          { 'x-deck-token': d.token, 'content-type': 'application/json' },
          'POST',
        ),
      ],
    ];
  }

  it('sends nosniff, no-referrer, CSP and frame denial on every one', async () => {
    const d = await start();
    for (const [name, res] of await replies(d)) {
      expect(res.headers['x-content-type-options'], name).toBe('nosniff');
      expect(res.headers['referrer-policy'], name).toBe('no-referrer');
      expect(res.headers['x-frame-options'], name).toBe('DENY');
      expect(String(res.headers['content-security-policy']), name).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.setCookie, name).toEqual([]);
    }
  });

  it('marks every /api answer no-store, including errors and health', async () => {
    const d = await start();
    const health = await send(d, '/api/health');
    expect(health.headers['cache-control']).toBe('no-store');
    for (const [name, res] of await replies(d)) {
      if (name === '404') continue;
      expect(res.headers['cache-control'], name).toBe('no-store');
    }
  });

  it('shows nothing but name, version and project id on health', async () => {
    const d = await start();
    const res = await send(d, '/api/health');
    expect(Object.keys(JSON.parse(res.body) as object).sort()).toEqual([
      'name',
      'ok',
      'projectId',
      'version',
    ]);
    expect(res.body).not.toContain(d.token);
    expect(res.setCookie).toEqual([]);
  });
});

describe('WebSocket upgrade edge cases', () => {
  function upgrade(d: Daemon, path: string, headers: Record<string, string>): Promise<number> {
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

  function wsSameOrigin(d: Daemon, cookie: string): Record<string, string> {
    return { cookie, origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'same-origin' };
  }

  it('refuses a valid cookie from a cross-site Origin', async () => {
    const d = await start();
    const cookie = await login(d);
    expect(await upgrade(d, '/ws', wsSameOrigin(d, cookie))).toBe(101);
    const crossSite = {
      cookie,
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    };
    expect(await upgrade(d, '/ws', crossSite)).toBe(403);
  });

  it.each([
    ['Origin null', () => ({ origin: 'null' }), 403],
    [
      'Origin with a trailing slash',
      (d: Daemon) => ({ origin: `http://127.0.0.1:${d.port}/` }),
      403,
    ],
    ['an IPv6 Host', (d: Daemon) => ({ host: `[::1]:${d.port}` }), 403],
    ['a foreign Host', (d: Daemon) => ({ host: `evil.example:${d.port}` }), 403],
    ['Sec-Fetch-Site cross-site', () => ({ 'sec-fetch-site': 'cross-site' }), 401],
    ['Sec-Fetch-Site same-site', () => ({ 'sec-fetch-site': 'same-site' }), 401],
    [
      'a localhost Origin on a 127.0.0.1 Host',
      (d: Daemon) => ({ origin: `http://localhost:${d.port}` }),
      401,
    ],
  ])('refuses a valid cookie with %s', async (_name, extra, status) => {
    const d = await start();
    const cookie = await login(d);
    expect(await upgrade(d, '/ws', { ...wsSameOrigin(d, cookie), ...extra(d) })).toBe(status);
  });

  it('refuses the right secret under another port name', async () => {
    const d = await start();
    const cookie = await login(d);
    const renamed = `deck_session_${otherPort(d)}=${secretOf(cookie)}`;
    expect(await upgrade(d, '/ws', wsSameOrigin(d, renamed))).toBe(401);
  });

  it('refuses the session secret in the query string', async () => {
    const d = await start();
    const cookie = await login(d);
    const path = `/ws?session=${secretOf(cookie)}&token=${secretOf(cookie)}`;
    expect(await upgrade(d, path, { origin: `http://127.0.0.1:${d.port}` })).toBe(401);
  });

  it.each(['/ws/', '/WS', '/ws/x', '//ws'])(
    'answers 404 for %s even with a cookie',
    async (path) => {
      const d = await start();
      const cookie = await login(d);
      expect(await upgrade(d, path, wsSameOrigin(d, cookie))).toBe(404);
    },
  );

  it('accepts /ws with an unrelated query string', async () => {
    const d = await start();
    const cookie = await login(d);
    expect(await upgrade(d, '/ws?v=1', wsSameOrigin(d, cookie))).toBe(101);
  });
});
