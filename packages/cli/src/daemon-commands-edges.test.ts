/**
 * start, stop and open when the port, runtime.json or the daemon's answers are not what
 * they should be. Real daemons run from the built dist with --fake; a hand-made HTTP
 * server stands in for a daemon that sends crafted answers. HOME is the scratch folder
 * from the global setup.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimePath, writeRuntime } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonCommandOptions } from './daemon-commands.js';
import { runOpen, runStart, runStop } from './daemon-commands.js';

const DAEMON_MAIN = createRequire(import.meta.url).resolve('@project-deck/daemon/main');

let dirs: string[];
let lines: string[];
let errors: string[];
const children: ChildProcess[] = [];
const servers: Server[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function newProject(port: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-cli-dedge-'));
  dirs.push(dir);
  await mkdir(join(dir, '.flutterdeck'));
  await writeFile(join(dir, '.flutterdeck', 'config.json'), JSON.stringify({ version: 1, port }));
  return dir;
}

beforeEach(() => {
  dirs = [];
  lines = [];
  errors = [];
});

afterEach(async () => {
  for (const dir of dirs) await runStop(options(dir)).catch(() => undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      });
    }
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function options(projectDir: string, extra: Partial<DaemonCommandOptions> = {}) {
  return {
    projectDir,
    io: { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) },
    spawnDaemon: (dir: string, onExit: (code: number | null) => void) => {
      // stderr to daemon.log, as the real spawnDaemon does: the client reads its reason.
      const log = openSync(join(dir, '.flutterdeck', 'daemon.log'), 'w', 0o600);
      const child = spawn(process.execPath, [DAEMON_MAIN, '--project', dir, '--fake'], {
        stdio: ['ignore', 'ignore', log],
        windowsHide: true,
      });
      closeSync(log);
      child.on('error', () => undefined);
      child.on('exit', (code) => onExit(code));
      children.push(child);
    },
    client: { readyTimeoutMs: 15_000, stopTimeoutMs: 10_000 },
    ...extra,
  } satisfies DaemonCommandOptions;
}

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
  } catch {
    return false;
  }
}

describe('start when the port is busy', () => {
  it('fails with exit 1 when another program holds the configured port', async () => {
    const sockets: Socket[] = [];
    // A plain TCP program: it accepts connections and never answers.
    const holder = createServer((socket) => {
      socket.on('error', () => undefined);
      sockets.push(socket);
    });
    holder.on('error', () => undefined);
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const { port } = holder.address() as AddressInfo;
    try {
      const project = await newProject(port);
      expect(await runStart(options(project))).toBe(1);
      expect(errors.join('\n')).toContain(String(port));
      expect(lines).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 30_000);

  it("refuses another project's daemon on the port and leaves it running", async () => {
    const port = await freePort();
    const first = await newProject(port);
    const second = await newProject(port);
    expect(await runStart(options(first))).toBe(0);
    errors = [];
    expect(await runStart(options(second))).toBe(1);
    expect(errors.join('\n')).not.toBe('');
    expect(await healthy(port)).toBe(true);
  }, 45_000);
});

describe('stop with a bad runtime.json', () => {
  it.each([
    ['corrupt JSON', '{"port": 9'],
    ['a wrong shape', '{"port":"x","token":1}'],
    ['an empty file', ''],
  ])('treats %s as not running, exit 0, and leaves the file', async (_label, text) => {
    const project = await newProject(await freePort());
    await writeFile(runtimePath(project), text);
    expect(await runStop(options(project))).toBe(0);
    expect(lines).toEqual(["FlutterDeck isn't running for this project."]);
    expect(await readFile(runtimePath(project), 'utf8')).toBe(text);
  });

  it('treats a stale runtime.json (nothing listens) as not running', async () => {
    const project = await newProject(await freePort());
    await writeRuntime(project, {
      pid: 999_999,
      port: await freePort(),
      token: randomBytes(32).toString('base64url'),
      startedAt: 1,
    });
    expect(await runStop(options(project))).toBe(0);
    expect(lines).toEqual(["FlutterDeck isn't running for this project."]);
    expect(children).toEqual([]);
  });

  it("never stops another project's daemon through a copied runtime.json", async () => {
    const port = await freePort();
    const first = await newProject(port);
    const second = await newProject(port);
    expect(await runStart(options(first))).toBe(0);
    // As after `cp -r first second`: the second project holds the first one's file.
    await writeFile(runtimePath(second), await readFile(runtimePath(first), 'utf8'));
    expect(await runStop(options(second))).toBe(1);
    expect(errors.join('\n')).toContain('Another project');
    expect(await healthy(port)).toBe(true);
  }, 45_000);
});

describe('open with crafted daemon answers', () => {
  const PROJECT_ID = 'bbbbbbbbbbbb';

  async function craftedDaemon(project: string, dashboardUrl: unknown): Promise<string[]> {
    const tokens: string[] = [];
    const server = createHttpServer((req, res) => {
      const header = req.headers['x-deck-token'];
      if (typeof header === 'string') tokens.push(header);
      const route = `${req.method ?? ''} ${req.url ?? ''}`;
      const body =
        route === 'GET /api/health'
          ? { ok: true, name: 'project-deck', version: '0.0.0', projectId: PROJECT_ID }
          : route === 'POST /api/login-window'
            ? { ok: true, until: Date.now() + 120_000 }
            : route === 'GET /api/status'
              ? {
                  version: '0.0.0',
                  dashboardUrl,
                  projectName: 'shop_app',
                  discovering: false,
                  apps: [],
                  attached: null,
                }
              : { error: 'not found' };
      res.writeHead('error' in body ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.on('error', () => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await writeRuntime(project, {
      pid: process.pid,
      port,
      token: randomBytes(32).toString('base64url'),
      startedAt: Date.now(),
    });
    return tokens;
  }

  it.each([
    ['another host', 'http://example.invalid/'],
    ['a shell suffix', 'http://127.0.0.1:9147/ & calc'],
    ['port 0', 'http://127.0.0.1:0/'],
    ['port 65536', 'http://127.0.0.1:65536/'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a trailing newline', 'http://127.0.0.1:9147/\n'],
  ])('refuses a dashboard address with %s and opens nothing', async (_label, url) => {
    const project = await newProject(await freePort());
    await craftedDaemon(project, url);
    const opened: string[] = [];
    const code = await runOpen({
      ...options(project, { client: { projectId: () => Promise.resolve(PROJECT_ID) } }),
      browser: true,
      openBrowser: (u) => {
        opened.push(u);
        return true;
      },
    });
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(lines.join('\n')).not.toContain(url.trim());
    expect(errors.join('\n')).toContain('unexpected address');
  });

  it('opens a well-formed dashboard address once', async () => {
    const project = await newProject(await freePort());
    await craftedDaemon(project, 'http://127.0.0.1:9300/');
    const opened: string[] = [];
    const code = await runOpen({
      ...options(project, { client: { projectId: () => Promise.resolve(PROJECT_ID) } }),
      browser: true,
      openBrowser: (u) => {
        opened.push(u);
        return true;
      },
    });
    expect(code).toBe(0);
    expect(opened).toEqual(['http://127.0.0.1:9300/']);
  });

  it('says so, with exit 0, when there is no way to open a browser', async () => {
    const project = await newProject(await freePort());
    await craftedDaemon(project, 'http://127.0.0.1:9300/');
    const code = await runOpen({
      ...options(project, { client: { projectId: () => Promise.resolve(PROJECT_ID) } }),
      browser: true,
      openBrowser: () => false,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain("Couldn't find a way to open the browser");
  });

  it('sends no token to a daemon that claims another project', async () => {
    const project = await newProject(await freePort());
    const tokens = await craftedDaemon(project, 'http://127.0.0.1:9300/');
    const code = await runOpen({
      ...options(project, { client: { projectId: () => Promise.resolve('cccccccccccc') } }),
      browser: true,
      openBrowser: () => true,
    });
    expect(code).toBe(1);
    expect(tokens).toEqual([]);
  });
});
