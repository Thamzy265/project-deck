import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';
import { LOGIN_WINDOW_MS } from './login-window.js';

const dirs: string[] = [];
let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function startClosed(): Promise<Daemon> {
  const projectDir = await mkdtemp(join(tmpdir(), 'deck-login-page-'));
  dirs.push(projectDir);
  let t = 1_800_000_000_000;
  daemon = await startDaemon({
    projectDir,
    registry: new Registry(),
    port: 0,
    log: () => undefined,
    now: () => t,
  });
  t += LOGIN_WINDOW_MS + 1;
  return daemon;
}

function get(d: Daemon, path: string): Promise<{ csp: string; body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: d.port, path, headers: { host: `127.0.0.1:${d.port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            csp: String(res.headers['content-security-policy']),
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** QA B2-2: the "Login needed" page is readable, without weakening the CSP. */
describe('"Login needed" page', () => {
  it('is styled by one inline style that only its own hash allows', async () => {
    const d = await startClosed();
    const page = await get(d, '/');
    expect(page.body).toContain('Login needed');
    expect(page.body).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    const style = /<style>([^<]*)<\/style>/.exec(page.body)?.[1];
    expect(style).toBeDefined();
    expect(style).toContain('prefers-color-scheme: dark');
    const hash = createHash('sha256')
      .update(style ?? '')
      .digest('base64');
    expect(page.csp).toBe(
      `default-src 'self'; style-src 'sha256-${hash}'; connect-src 'self'; frame-ancestors 'none'`,
    );
    expect(page.csp).not.toContain('unsafe-inline');
  });

  it('leaves the CSP of every other answer as it was', async () => {
    const d = await startClosed();
    expect((await get(d, '/api/health')).csp).toBe(
      "default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
  });
});
