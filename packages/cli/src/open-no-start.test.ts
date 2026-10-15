/**
 * `open` never starts a daemon, even when the daemon goes away between its calls
 * (tester observation on batch 4).
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOpen } from './daemon-commands.js';

const PROJECT_ID = 'dddddddddddd';

let project: string;
let server: Server;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-open-'));
  await mkdir(join(project, '.flutterdeck'));
  await writeFile(join(project, '.flutterdeck', 'config.json'), '{"version":1}\n');
  // Answers health and the login window, then goes away before the status call.
  server = createServer((req, res) => {
    const route = `${req.method ?? ''} ${req.url ?? ''}`;
    if (route === 'GET /api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, name: 'project-deck', version: '0.0.0', projectId: PROJECT_ID }),
      );
      return;
    }
    if (route === 'POST /api/login-window') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, until: Date.now() + 120_000 }), () => {
        server.close();
        server.closeAllConnections();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await writeRuntime(project, {
    pid: process.pid,
    port,
    token: randomBytes(32).toString('base64url'),
    startedAt: Date.now(),
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(project, { recursive: true, force: true });
});

describe('open', () => {
  it('starts no daemon when the daemon goes away between its calls', async () => {
    let spawned = 0;
    const errors: string[] = [];
    const code = await runOpen({
      projectDir: project,
      io: { out: () => undefined, err: (l) => errors.push(l) },
      spawnDaemon: () => {
        spawned++;
      },
      client: { projectId: () => Promise.resolve(PROJECT_ID), readyTimeoutMs: 200, pollMs: 20 },
      browser: false,
      openBrowser: () => true,
    });
    expect(spawned).toBe(0);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('flutterdeck start');
  });
});
