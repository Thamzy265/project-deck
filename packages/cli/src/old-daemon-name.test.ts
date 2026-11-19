/**
 * A daemon from a dev checkout that predates the rename still answers /api/health with
 * the name `project-deck` (M5 batch 3). This release must not take it for its own:
 * no command may send it the token, ask it to shut down, or signal its pid. The answer
 * shape is the one /api/health returned before 44bd5f8.
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
import type { DaemonCommandOptions } from './daemon-commands.js';
import { runOpen, runStart, runStop } from './daemon-commands.js';

const PROJECT_ID = 'abababababab';
/** Not this process: nothing may ever signal it. */
const PID = 424_242;

let project: string;
let server: Server;
let token: string;
let seen: { route: string; token: string | undefined }[];

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-oldname-'));
  await mkdir(join(project, '.pitdeck'));
  await writeFile(join(project, '.pitdeck', 'config.json'), '{"version":1}\n');
  seen = [];
  // Built at run time so it never looks like a real credential.
  token = randomBytes(32).toString('base64url');
  server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const route = `${req.method ?? ''} ${req.url ?? ''}`;
    const sent = req.headers['x-deck-token'];
    seen.push({ route, token: typeof sent === 'string' ? sent : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      route === 'GET /api/health'
        ? JSON.stringify({
            ok: true,
            name: 'project-deck',
            version: '0.0.0',
            projectId: PROJECT_ID,
          })
        : JSON.stringify({ ok: true, until: Date.now() + 120_000 }),
    );
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await writeRuntime(project, { pid: PID, port, token, startedAt: Date.now() });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Outcome {
  code: number;
  text: string;
  spawned: number;
}

async function run(
  command: (
    opts: DaemonCommandOptions & { browser: boolean; openBrowser: () => boolean },
  ) => Promise<number>,
): Promise<Outcome> {
  const lines: string[] = [];
  let spawned = 0;
  const code = await command({
    projectDir: project,
    io: { out: (l) => lines.push(l), err: (l) => lines.push(l) },
    spawnDaemon: () => {
      spawned++;
    },
    browser: false,
    openBrowser: () => {
      throw new Error('no browser in tests');
    },
    client: {
      projectId: () => Promise.resolve(PROJECT_ID),
      readyTimeoutMs: 300,
      stopTimeoutMs: 300,
      pollMs: 20,
    },
  });
  return { code, text: lines.join('\n'), spawned };
}

describe.each([
  ['stop', runStop],
  ['open', runOpen],
  ['start', runStart],
] as const)('%s against a daemon that still says project-deck', (name, command) => {
  it('never sends it the token, a shutdown or a login window', async () => {
    const outcome = await run(command);
    // Only health was asked, and without the token.
    expect(seen.map((s) => s.route).filter((r) => r !== 'GET /api/health')).toEqual([]);
    expect(seen.every((s) => s.token === undefined)).toBe(true);
    expect(outcome.text).not.toContain(token);
    // `open` and `stop` never start a daemon; `start` may try once the old one is "gone".
    if (name !== 'start') expect(outcome.spawned).toBe(0);
  });

  it('says it is not running or not usable, never that it started or stopped', async () => {
    const outcome = await run(command);
    expect(outcome.text).not.toMatch(/Pitdeck started|Pitdeck stopped|Dashboard: http/);
    if (name === 'open') expect(outcome.code).toBe(1);
    if (name === 'start') expect(outcome.code).toBe(1);
  });
});

// Repro of a message gap, not a security gap: the old daemon still holds the port, yet
// `stop` says nothing runs. Marked as expected to fail until the developer words it.
describe('stop against a daemon that still says project-deck, the message', () => {
  it.fails(
    'does not claim "isn\'t running" while something answers health on the port',
    async () => {
      const outcome = await run(runStop);
      const { port } = server.address() as AddressInfo;
      expect(outcome.text).not.toMatch(/isn't running/);
      expect(outcome.text).toContain(String(port));
    },
  );
});
