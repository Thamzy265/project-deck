/**
 * Tester's edge cases for serving the built dashboard: path traversal variants, methods
 * other than GET, file types and links in the build folder, missing builds, assets
 * without login, and the headers on every answer.
 */
import { Agent, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';

const INDEX = '<!doctype html><title>FlutterDeck</title><div id="root"></div>';
const SCRIPT = 'console.log("dashboard")';
const SECRET = 'SECRET-OUTSIDE-ASSETS';

const dirs: string[] = [];
const daemons: Daemon[] = [];
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

afterAll(async () => {
  agent.destroy();
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Build = 'full' | 'none' | 'index-only';

async function start(build: Build = 'full'): Promise<Daemon> {
  const dashboardDir = await tempDir('deck-dash-edges-');
  const projectDir = await tempDir('deck-proj-edges-');
  await writeFile(join(projectDir, 'secret.txt'), SECRET);
  await writeFile(join(dashboardDir, 'secret.txt'), SECRET);
  if (build !== 'none') await writeFile(join(dashboardDir, 'index.html'), INDEX);
  if (build === 'full') {
    const assets = join(dashboardDir, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'index-abc.js'), SCRIPT);
    await writeFile(join(assets, 'index-abc.css'), 'body{}');
    for (const name of ['page.html', 'index-abc.js.map', 'data.json', 'x.mjs', 'noext', 'UP.JS']) {
      await writeFile(join(assets, name), SECRET);
    }
    if (process.platform !== 'win32') {
      await symlink(join(projectDir, 'secret.txt'), join(assets, 'linked.js'));
    }
  }
  const d = await startDaemon({
    projectDir,
    registry: new Registry(),
    port: 0,
    dashboardDir,
    log: () => undefined,
  });
  daemons.push(d);
  return d;
}

let shared: Daemon | undefined;
async function full(): Promise<Daemon> {
  shared ??= await start('full');
  return shared;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
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
        agent,
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

async function cookieAuth(d: Daemon): Promise<{ cookie: string; 'sec-fetch-site': string }> {
  const page = await send(d, '/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' });
  const setCookie = page.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
  expect(cookie).toMatch(/^deck_session_\d+=/);
  return { cookie, 'sec-fetch-site': 'same-origin' };
}

const TRAVERSALS = [
  '/assets/..%2findex.html',
  '/assets/..%2Fsecret.txt',
  '/assets/%2e%2e/secret.txt',
  '/assets/%2E%2E/%2E%2E/secret.txt',
  '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
  '/assets/%252e%252e/secret.txt',
  '/assets/%252e%252e%252fsecret.txt',
  '/assets/..\\secret.txt',
  '/assets/%5c..%5csecret.txt',
  '/assets\\..\\secret.txt',
  '/assets/index-abc.js%00.png',
  '/assets/index-abc.js%00',
  '/assets/%00',
  '/assets/%c0%ae%c0%ae/secret.txt',
  '/assets/..;/secret.txt',
  '/assets/....//secret.txt',
  '/secret.txt',
  '/assets/secret.txt',
  '/assets/',
  '/assets',
  '/assets/index-abc.js/',
  '/assets/index-abc.js/..',
  '/ASSETS/index-abc.js',
  '/assets/INDEX-ABC.JS',
  '//assets/index-abc.js',
];

describe('asset paths', () => {
  it('serves no file outside the build and no page for traversal variants', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    for (const path of TRAVERSALS) {
      const res = await send(d, path, auth);
      expect(res.body, path).not.toContain(SECRET);
      expect(res.body, path).not.toContain('<div id="root">');
      expect([400, 404], path).toContain(res.status);
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
    }
  });

  it('serves the exact file with a query string or a percent-encoded letter', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    for (const path of ['/assets/index-abc.js?v=1', '/assets/%69ndex-abc.js']) {
      const res = await send(d, path, auth);
      // Either the same file or nothing: never another file.
      if (res.status === 200) expect(res.body, path).toBe(SCRIPT);
      else expect(res.status, path).toBe(404);
    }
  });

  it('skips HTML, source maps, JSON, unknown and missing extensions, and links', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    for (const name of [
      'page.html',
      'index-abc.js.map',
      'data.json',
      'x.mjs',
      'noext',
      'UP.JS',
      'linked.js',
    ]) {
      const res = await send(d, `/assets/${name}`, auth);
      expect(res.status, name).toBe(404);
      expect(res.body, name).not.toContain(SECRET);
    }
  });

  it('answers 401 for every asset name without a login, so it reveals no file names', async () => {
    const d = await full();
    for (const path of ['/assets/index-abc.js', '/assets/missing.js', '/assets/page.html']) {
      const res = await send(d, path);
      expect(res.status, path).toBe(401);
      expect(res.body, path).not.toContain(SCRIPT);
    }
    // Traversal variants without a login: refused or not found, never served.
    for (const path of TRAVERSALS) {
      const res = await send(d, path);
      expect([400, 401, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain(SECRET);
      expect(res.body, path).not.toContain(SCRIPT);
    }
  });

  it('refuses the cookie on a cross-site script load (another site including the asset)', async () => {
    const d = await full();
    const { cookie } = await cookieAuth(d);
    for (const site of ['cross-site', 'same-site']) {
      const res = await send(d, '/assets/index-abc.js', { cookie, 'sec-fetch-site': site });
      expect(res.status, site).toBe(401);
    }
    const ok = await send(d, '/assets/index-abc.js', { cookie });
    expect(ok.status).toBe(200);
  });

  it('refuses a wrong Host or Origin on assets', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    expect((await send(d, '/assets/index-abc.js', { ...auth, host: 'evil.test' })).status).toBe(
      403,
    );
    expect(
      (await send(d, '/assets/index-abc.js', { ...auth, origin: 'http://evil.test' })).status,
    ).toBe(403);
    expect(
      (await send(d, '/assets/index-abc.js', { ...auth, origin: 'http://127.0.0.1:1' })).status,
    ).toBe(403);
  });
});

describe('asset methods', () => {
  it('HEAD gives the type and no body, and needs a login', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    const res = await send(d, '/assets/index-abc.js', auth, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.body).toBe('');
    expect((await send(d, '/assets/index-abc.js', {}, 'HEAD')).status).toBe(401);
  });

  it('OPTIONS, POST, PUT and DELETE on assets serve nothing and allow no CORS', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    for (const method of ['OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await send(
        d,
        '/assets/index-abc.js',
        { ...auth, 'access-control-request-method': 'GET' },
        method,
      );
      expect(res.status, method).toBeGreaterThanOrEqual(400);
      expect(res.body, method).not.toContain(SCRIPT);
      expect(res.headers['access-control-allow-origin'], method).toBeUndefined();
    }
  });

  it('HEAD / during the login window sets no cookie for a non-navigation', async () => {
    const d = await full();
    const res = await send(
      d,
      '/',
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
      'HEAD',
    );
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('headers', () => {
  it('asset answers carry the security headers and never set a cookie', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    for (const path of ['/assets/index-abc.js', '/assets/index-abc.css', '/assets/missing.js']) {
      const res = await send(d, path, auth);
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['x-frame-options'], path).toBe('DENY');
      expect(res.headers['referrer-policy'], path).toBe('no-referrer');
      expect(res.headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
      expect(res.headers['set-cookie'], path).toBeUndefined();
    }
    const css = await send(d, '/assets/index-abc.css', auth);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('the page is never cached, with or without a cookie', async () => {
    const d = await full();
    const auth = await cookieAuth(d);
    const first = await send(d, '/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' });
    const again = await send(d, '/', auth);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(again.headers['cache-control']).toBe('no-store');
    expect(again.body).toBe(INDEX);
  });

  it('the page CSP allows no inline script, eval or other origins', async () => {
    const d = await full();
    const res = await send(d, '/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
  });
});

describe('missing builds', () => {
  it('with no build at all: placeholder page, assets 404 with login, 401 without', async () => {
    const d = await start('none');
    const auth = await cookieAuth(d);
    const page = await send(d, '/', auth);
    expect(page.body).toContain('FlutterDeck is running');
    expect((await send(d, '/assets/index-abc.js', auth)).status).toBe(404);
    expect((await send(d, '/assets/index-abc.js')).status).toBe(401);
  });

  it('with index.html but no assets folder: the page, and no assets', async () => {
    const d = await start('index-only');
    const auth = await cookieAuth(d);
    expect((await send(d, '/', auth)).body).toBe(INDEX);
    expect((await send(d, '/assets/index-abc.js', auth)).status).toBe(404);
  });
});
