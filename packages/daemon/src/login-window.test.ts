import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginWindowResponse, Registry } from '@project-deck/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';
import { LOGIN_WINDOW_MS, LoginWindow } from './login-window.js';

const dirs: string[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(): Clock {
  let t = 1_800_000_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function start(clock?: Clock, dir?: string): Promise<Daemon> {
  const projectDir = dir ?? (await mkdtemp(join(tmpdir(), 'deck-login-')));
  if (dir === undefined) dirs.push(projectDir);
  const d = await startDaemon({
    projectDir,
    registry: new Registry(),
    port: 0,
    log: () => undefined,
    ...(clock === undefined ? {} : { now: clock.now }),
  });
  daemons.push(d);
  return d;
}

interface Reply {
  status: number;
  setCookie: string[];
  body: string;
}

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

const NAVIGATION = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' };
const LOGIN_NEEDED =
  'Login needed. Run `flutterdeck open` in your project (or start a Claude session with the plugin), then reload this page.';

const cookieOf = (reply: Reply): string => (reply.setCookie[0] ?? '').split(';')[0] ?? '';
const sameOrigin = (d: Daemon, cookie: string) => ({
  cookie,
  origin: `http://127.0.0.1:${d.port}`,
  'sec-fetch-site': 'same-origin',
});

describe('LoginWindow', () => {
  it('is open for 2 minutes after it opens, by timestamps only', () => {
    const clock = fakeClock();
    const window = new LoginWindow(clock.now);
    expect(LOGIN_WINDOW_MS).toBe(120_000);
    expect(window.isOpen()).toBe(false);
    expect(window.open()).toBe(clock.now() + LOGIN_WINDOW_MS);
    clock.advance(LOGIN_WINDOW_MS);
    expect(window.isOpen()).toBe(true);
    clock.advance(1);
    expect(window.isOpen()).toBe(false);
  });
});

describe('dashboard login window', () => {
  it('hands out the cookie within 2 minutes of the daemon start', async () => {
    const clock = fakeClock();
    const d = await start(clock);
    clock.advance(LOGIN_WINDOW_MS - 1);
    const res = await send(d, '/', NAVIGATION);
    expect(res.status).toBe(200);
    expect(res.setCookie).toHaveLength(1);
    expect(res.body).not.toContain('Login needed');
  });

  it('shows "Login needed" and sets no cookie once the window has closed', async () => {
    const clock = fakeClock();
    const d = await start(clock);
    clock.advance(LOGIN_WINDOW_MS + 1);
    const res = await send(d, '/', NAVIGATION);
    expect(res.setCookie).toEqual([]);
    expect(res.body.replace(/<[^>]+>/g, '')).toContain(LOGIN_NEEDED.replaceAll('`', ''));
  });

  it('reopens for 2 minutes with the runtime.json token', async () => {
    const clock = fakeClock();
    const d = await start(clock);
    clock.advance(LOGIN_WINDOW_MS * 5);
    const res = await send(d, '/api/login-window', { 'x-deck-token': d.token }, 'POST');
    expect(res.status).toBe(200);
    expect(LoginWindowResponse.parse(JSON.parse(res.body))).toEqual({
      ok: true,
      until: clock.now() + LOGIN_WINDOW_MS,
    });
    expect((await send(d, '/', NAVIGATION)).setCookie).toHaveLength(1);
  });

  it('refuses to open the window with the cookie', async () => {
    const d = await start();
    const cookie = cookieOf(await send(d, '/', NAVIGATION));
    const res = await send(d, '/api/login-window', sameOrigin(d, cookie), 'POST');
    expect(res.status).toBe(403);
  });

  it('refuses to open the window without credentials', async () => {
    const d = await start();
    expect((await send(d, '/api/login-window', {}, 'POST')).status).toBe(401);
  });

  it('opens a fresh window when the daemon restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-login-'));
    dirs.push(dir);
    const clock = fakeClock();
    const first = await start(clock, dir);
    clock.advance(LOGIN_WINDOW_MS + 1);
    expect((await send(first, '/', NAVIGATION)).setCookie).toEqual([]);
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);
    const second = await start(clock, dir);
    expect((await send(second, '/', NAVIGATION)).setCookie).toHaveLength(1);
  });

  it('keeps a cookie handed out earlier valid after the window closes', async () => {
    const clock = fakeClock();
    const d = await start(clock);
    const cookie = cookieOf(await send(d, '/', NAVIGATION));
    clock.advance(LOGIN_WINDOW_MS * 10);
    expect((await send(d, '/api/status', sameOrigin(d, cookie))).status).toBe(200);
    // Loading the page again with that cookie shows the dashboard, not "Login needed".
    const page = await send(d, '/', { ...NAVIGATION, cookie });
    expect(page.body).not.toContain('Login needed');
  });
});
