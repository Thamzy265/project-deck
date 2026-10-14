import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';
import { LOGIN_WINDOW_MS } from './login-window.js';

const INDEX = '<!doctype html><title>FlutterDeck</title><div id="root"></div>';
const SCRIPT = 'console.log("dashboard")';

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function start(opts: { built?: boolean; now?: () => number } = {}): Promise<Daemon> {
  const dashboardDir = await tempDir('deck-dash-');
  if (opts.built !== false) {
    await mkdir(join(dashboardDir, 'assets'));
    await writeFile(join(dashboardDir, 'index.html'), INDEX);
    await writeFile(join(dashboardDir, 'assets', 'index-abc.js'), SCRIPT);
  }
  const d = await startDaemon({
    projectDir: await tempDir('deck-proj-'),
    registry: new Registry(),
    port: 0,
    dashboardDir,
    log: () => undefined,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  daemons.push(d);
  return d;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(d: Daemon, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: d.port,
        path,
        headers: { host: `127.0.0.1:${d.port}`, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const NAVIGATION = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' };

async function login(d: Daemon): Promise<Record<string, string>> {
  const page = await get(d, '/', NAVIGATION);
  const setCookie = page.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
  return { cookie, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${d.port}` };
}

describe('serving the built dashboard', () => {
  it('serves index.html at / with the login cookie and the security headers', async () => {
    const d = await start();
    const page = await get(d, '/', NAVIGATION);
    expect(page.status).toBe(200);
    expect(page.body).toBe(INDEX);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['set-cookie']).toBeDefined();
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    expect(page.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the scripts to a logged-in page with their content type', async () => {
    const d = await start();
    const res = await get(d, '/assets/index-abc.js', await login(d));
    expect(res.status).toBe(200);
    expect(res.body).toBe(SCRIPT);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('needs the cookie or token for assets too', async () => {
    const d = await start();
    expect((await get(d, '/assets/index-abc.js')).status).toBe(401);
    expect((await get(d, '/assets/index-abc.js', { 'x-deck-token': d.token })).status).toBe(200);
  });

  it('serves nothing outside the built files, and no page for other paths', async () => {
    const d = await start();
    const auth = await login(d);
    for (const path of [
      '/assets/missing.js',
      '/assets/../index.html',
      '/assets/%2e%2e/index.html',
      '/index.html',
      '/logs',
    ]) {
      const res = await get(d, path, auth);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('<div id="root">');
    }
  });

  it('keeps "Login needed" once the window has closed', async () => {
    let t = 1_800_000_000_000;
    const d = await start({ now: () => t });
    t += LOGIN_WINDOW_MS + 1;
    const page = await get(d, '/', NAVIGATION);
    expect(page.body).toContain('Login needed');
    expect(page.body).not.toContain('<div id="root">');
    expect(page.headers['set-cookie']).toBeUndefined();
  });

  it('falls back to a plain page when the dashboard is not built', async () => {
    const d = await start({ built: false });
    const page = await get(d, '/', NAVIGATION);
    expect(page.status).toBe(200);
    expect(page.body).toContain('FlutterDeck is running');
  });
});
