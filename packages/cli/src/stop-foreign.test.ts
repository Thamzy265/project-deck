/**
 * `stop` against a daemon it can't stop through the API: one that refuses the token, or
 * one that doesn't say which project it serves. The message must give a way out, and
 * nothing is killed (review C1).
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntime, writeRuntime } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStop } from './daemon-commands.js';

const PROJECT_ID = 'eeeeeeeeeeee';

let project: string;
let server: Server;
let port: number;
let shutdowns: number;

async function startServer(health: Record<string, unknown>): Promise<void> {
  server = createServer((req, res) => {
    const route = `${req.method ?? ''} ${req.url ?? ''}`;
    res.writeHead(route === 'GET /api/health' ? 200 : 401, {
      'content-type': 'application/json',
    });
    if (route === 'POST /api/shutdown') shutdowns++;
    res.end(
      JSON.stringify(route === 'GET /api/health' ? health : { error: 'Missing or invalid token' }),
    );
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  await writeRuntime(project, {
    pid: process.pid,
    port,
    token: randomBytes(32).toString('base64url'),
    startedAt: Date.now(),
  });
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-foreign-'));
  await mkdir(join(project, '.flutterdeck'));
  await writeFile(join(project, '.flutterdeck', 'config.json'), '{"version":1}\n');
  shutdowns = 0;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(project, { recursive: true, force: true });
});

async function stop(): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const code = await runStop({
    projectDir: project,
    io: { out: () => undefined, err: (l) => errors.push(l) },
    spawnDaemon: () => {
      throw new Error('stop must never start a daemon');
    },
    client: { projectId: () => Promise.resolve(PROJECT_ID), stopTimeoutMs: 300, pollMs: 20 },
  });
  return { code, errors };
}

describe('stop with a daemon it can’t stop', () => {
  it.each([
    [
      'refuses the token',
      { ok: true, name: 'project-deck', version: '0.0.0', projectId: PROJECT_ID },
    ],
    ['names no project', { ok: true, name: 'project-deck', version: '0.0.0' }],
  ])('gives a way out when the daemon %s, and kills nothing', async (_label, health) => {
    await startServer(health);
    const { code, errors } = await stop();
    expect(code).toBe(1);
    const text = errors.join('\n');
    expect(text).toContain(`port ${port}`);
    expect(text).toContain('packages/daemon/dist/main.js');
    expect(text).toContain('delete .flutterdeck/runtime.json');
    expect(text).not.toContain('run `flutterdeck stop`');
    // Still running, and its runtime.json is left for the user to decide.
    expect(server.listening).toBe(true);
    expect(await readRuntime(project)).toBeDefined();
    expect(shutdowns).toBeLessThanOrEqual(1);
  });
});
