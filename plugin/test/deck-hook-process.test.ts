/**
 * Runs the hook as Claude Code does (node, JSON on stdin) against a fake daemon on a real
 * socket, and checks what reaches the daemon, the exit code and that nothing is printed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectIdFor, projectKey, readProjectIdentity } from '@project-deck/core/node';
import { ownProjectId } from '../hooks/deck-hook.mjs';
import * as fx from './fixtures.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'deck-hook.mjs');
const TOKEN = 'tok-0123456789abcdef0123456789abcdef0123456789';
const links = process.platform === 'win32' ? it.skip : it;

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Mode = 'ok' | 'unauthorised' | 'other-program' | 'hang';

interface FakeDaemon {
  port: number;
  received: Received[];
  close(): Promise<void>;
}

async function fakeDaemon(mode: Mode = 'ok', projectId?: string): Promise<FakeDaemon> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (mode === 'hang') return;
      if (req.url === '/api/health') {
        answer(
          res,
          200,
          mode === 'other-program'
            ? { hello: 'world' }
            : {
                ok: true,
                name: 'project-deck',
                version: '0.0.0',
                ...(projectId === undefined ? {} : { projectId }),
              },
        );
        return;
      }
      answer(
        res,
        mode === 'unauthorised' ? 401 : 200,
        mode === 'unauthorised' ? { error: 'Unauthorized' } : { ok: true },
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(
  stdin: string | Buffer | undefined,
  env: Record<string, string | undefined>,
  opts: { keepStdinOpen?: boolean; cwd?: string } = {},
): Promise<RunResult> {
  const started = Date.now();
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!('CLAUDE_PROJECT_DIR' in env)) delete childEnv.CLAUDE_PROJECT_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    // The hook may stop reading a huge input; that is fine.
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    if (stdin !== undefined) child.stdin.write(stdin);
    if (opts.keepStdinOpen !== true) child.stdin.end();
  });
}

let projectDir: string;
let daemon: FakeDaemon | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-hook-'));
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(projectDir, { recursive: true, force: true });
});

async function initProject(port: number, opts: { config?: boolean } = {}): Promise<void> {
  await mkdir(join(projectDir, '.flutterdeck'), { recursive: true });
  if (opts.config !== false) {
    await writeFile(join(projectDir, '.flutterdeck', 'config.json'), '{"version":1}\n');
  }
  await writeFile(
    join(projectDir, '.flutterdeck', 'runtime.json'),
    JSON.stringify({ pid: process.pid, port, token: TOKEN, startedAt: 1 }),
    { mode: 0o600 },
  );
}

const expectSilentSuccess = (r: RunResult) => {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
};

const events = (d: FakeDaemon) => d.received.filter((r) => r.url === '/api/events');

describe('the hook process', () => {
  it.each([
    ['Stop', fx.stop, { type: 'claude.done', sessionId: 'abc123' }],
    ['SubagentStop', fx.subagentStop, { type: 'claude.done', sessionId: 'abc123' }],
    [
      'Notification',
      fx.permissionPrompt,
      {
        type: 'claude.waiting',
        sessionId: 'abc123',
        message: 'Claude needs your permission to use Bash',
      },
    ],
    [
      'PostToolUse',
      fx.reloadSucceeded,
      { type: 'claude.reload', sessionId: 'abc123', ok: true, kind: 'hot-reload' },
    ],
    [
      'PostToolUseFailure',
      fx.reloadFailed,
      {
        type: 'claude.reload',
        sessionId: 'abc123',
        ok: false,
        kind: 'hot-reload',
        message: 'RPCError: connection to [address] closed while compiling [path]',
      },
    ],
  ])('sends %s to the daemon with the token header, and nothing else', async (_, input, body) => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    const r = await runHook(JSON.stringify(input), { CLAUDE_PROJECT_DIR: projectDir });
    expectSilentSuccess(r);
    expect(daemon.received.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/health',
      'POST /api/events',
    ]);
    const [health, sent] = daemon.received;
    // The token goes only with the event, after the health check said it is FlutterDeck.
    expect(health?.headers['x-deck-token']).toBeUndefined();
    expect(sent?.headers['x-deck-token']).toBe(TOKEN);
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(sent?.headers.host).toBe(`127.0.0.1:${daemon.port}`);
    expect(sent?.headers.origin).toBeUndefined();
    expect(JSON.parse(sent?.body ?? '')).toEqual(body);
    for (const needle of [fx.SECRET_ASSISTANT_TEXT, 'jsonl', 'cwd', 'AbCdEf123', '/Users/dev']) {
      expect(sent?.body).not.toContain(needle);
    }
  });

  it("falls back to the hook's working folder when CLAUDE_PROJECT_DIR is not set", async () => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    const r = await runHook(JSON.stringify({ ...fx.stop, cwd: projectDir }), {});
    expectSilentSuccess(r);
    expect(events(daemon)).toHaveLength(1);
  });

  it('sends nothing for events it does not handle', async () => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    for (const input of [fx.authSuccess, fx.otherMcpTool, fx.reloadInterrupted]) {
      expectSilentSuccess(await runHook(JSON.stringify(input), { CLAUDE_PROJECT_DIR: projectDir }));
    }
    expect(daemon.received).toEqual([]);
  });

  it('does nothing in a folder FlutterDeck was never set up in', async () => {
    daemon = await fakeDaemon();
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    // runtime.json without config.json: not set up by `flutterdeck init`.
    await initProject(daemon.port, { config: false });
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.received).toEqual([]);
  });

  it('does nothing when the daemon is not running (no runtime.json)', async () => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    await rm(join(projectDir, '.flutterdeck', 'runtime.json'));
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.received).toEqual([]);
  });

  links('never follows a link at runtime.json', async () => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    const elsewhere = join(projectDir, 'planted.json');
    await writeFile(
      elsewhere,
      JSON.stringify({ pid: 1, port: daemon.port, token: TOKEN, startedAt: 1 }),
    );
    await rm(join(projectDir, '.flutterdeck', 'runtime.json'));
    await symlink(elsewhere, join(projectDir, '.flutterdeck', 'runtime.json'));
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.received).toEqual([]);
  });

  links('never follows a linked .flutterdeck folder', async () => {
    daemon = await fakeDaemon();
    const real = await mkdtemp(join(tmpdir(), 'deck-hook-real-'));
    try {
      await writeFile(join(real, 'config.json'), '{"version":1}');
      await writeFile(
        join(real, 'runtime.json'),
        JSON.stringify({ pid: 1, port: daemon.port, token: TOKEN, startedAt: 1 }),
      );
      await symlink(real, join(projectDir, '.flutterdeck'), 'dir');
      expectSilentSuccess(
        await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }),
      );
      expect(daemon.received).toEqual([]);
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  it.each([
    ['not JSON', '{"version":1,'],
    ['a port out of range', JSON.stringify({ pid: 1, port: 70000, token: TOKEN, startedAt: 1 })],
    ['a short token', JSON.stringify({ pid: 1, port: 1234, token: 'x', startedAt: 1 })],
    [
      'a token with a newline',
      JSON.stringify({ pid: 1, port: 1234, token: `${TOKEN}\r\nx: y`, startedAt: 1 }),
    ],
  ])('does nothing when runtime.json holds %s', async (_, text) => {
    await initProject(1);
    await writeFile(join(projectDir, '.flutterdeck', 'runtime.json'), text);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
  });

  it('exits 0 quietly when the daemon is down', async () => {
    daemon = await fakeDaemon();
    const { port } = daemon;
    await daemon.close();
    daemon = undefined;
    await initProject(port);
    const r = await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir });
    expectSilentSuccess(r);
    // Windows retries a refused loopback connection for about 2 s; the deadline still holds.
    expect(r.ms).toBeLessThan(3500);
  });

  it('exits 0 quietly when the daemon answers 401', async () => {
    daemon = await fakeDaemon('unauthorised');
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(events(daemon)).toHaveLength(1);
  });

  it('never sends the token to a program that is not FlutterDeck', async () => {
    daemon = await fakeDaemon('other-program');
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.received.map((r) => r.url)).toEqual(['/api/health']);
    expect(daemon.received.every((r) => r.headers['x-deck-token'] === undefined)).toBe(true);
  });

  it('gives up after 2 s when the daemon never answers', async () => {
    daemon = await fakeDaemon('hang');
    await initProject(daemon.port);
    const r = await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir });
    expectSilentSuccess(r);
    expect(r.ms).toBeGreaterThanOrEqual(1900);
    expect(r.ms).toBeLessThan(3500);
  });

  it('gives up after 2 s when stdin never ends', async () => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    const r = await runHook(
      JSON.stringify(fx.stop),
      { CLAUDE_PROJECT_DIR: projectDir },
      { keepStdinOpen: true },
    );
    expectSilentSuccess(r);
    expect(r.ms).toBeLessThan(3500);
    expect(daemon.received).toEqual([]);
  });

  it.each([
    ['not JSON', 'Stop'],
    ['empty', ''],
    ['JSON that is not an object', '[1,2]'],
  ])('exits 0 quietly on stdin that is %s', async (_, stdin) => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(stdin, { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.received).toEqual([]);
  });

  it('exits 0 quietly on a huge stdin and sends nothing', async () => {
    daemon = await fakeDaemon();
    await initProject(daemon.port);
    const huge = JSON.stringify({
      ...fx.stop,
      last_assistant_message: 'x'.repeat(5 * 1024 * 1024),
    });
    const r = await runHook(huge, { CLAUDE_PROJECT_DIR: projectDir });
    expectSilentSuccess(r);
    expect(daemon.received).toEqual([]);
  });
});

describe('the hook process: project id (S2)', () => {
  // The hook runs with the test's scratch HOME (vitest.global-setup.ts).
  const registryDir = () => join(homedir(), '.flutterdeck');
  const salt = () => randomBytes(32).toString('base64url');

  async function writeRegistry(text: string): Promise<void> {
    await mkdir(registryDir(), { recursive: true });
    await writeFile(join(registryDir(), 'ports.json'), text, { mode: 0o600 });
  }

  afterEach(async () => {
    await rm(registryDir(), { recursive: true, force: true });
  });

  it("sends when /api/health names this project's id", async () => {
    const s = salt();
    await writeRegistry(JSON.stringify({ version: 1, salt: s, projects: {} }));
    daemon = await fakeDaemon('ok', projectIdFor(s, await projectKey(projectDir)));
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(events(daemon)).toHaveLength(1);
  });

  it("never sends the token to another project's daemon on the port", async () => {
    const s = salt();
    await writeRegistry(JSON.stringify({ version: 1, salt: s, projects: {} }));
    daemon = await fakeDaemon('ok', projectIdFor(s, '/some/other/project'));
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.received.map((r) => r.url)).toEqual(['/api/health']);
    expect(daemon.received.every((r) => r.headers['x-deck-token'] === undefined)).toBe(true);
  });

  it.each([
    ['there is no registry', undefined],
    ['the registry is not JSON', '{ nope'],
    ['the registry has no salt', JSON.stringify({ version: 1, projects: {} })],
  ])('sends nothing when it cannot work out its own id: %s', async (_, text) => {
    if (text !== undefined) await writeRegistry(text);
    daemon = await fakeDaemon('ok', 'a1b2c3d4e5f6');
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(events(daemon)).toEqual([]);
  });

  links('never follows a link at ports.json', async () => {
    const s = salt();
    const real = join(projectDir, 'ports-real.json');
    await writeFile(real, JSON.stringify({ version: 1, salt: s, projects: {} }));
    await mkdir(registryDir(), { recursive: true });
    await symlink(real, join(registryDir(), 'ports.json'));
    daemon = await fakeDaemon('ok', projectIdFor(s, await projectKey(projectDir)));
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(events(daemon)).toEqual([]);
  });

  it("works out the same id as core's readProjectIdentity", async () => {
    await writeRegistry(JSON.stringify({ version: 1, salt: salt(), projects: {} }));
    const id = await ownProjectId(projectDir);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).toBe(await readProjectIdentity(projectDir, { homeDir: homedir() }));
  });

  it('R2-1 matches core for a project path spelled in another case than on disk', async (ctx) => {
    const real = join(projectDir, 'Shop_App');
    await mkdir(real);
    const other = join(projectDir, 'sHOP_aPP');
    // Only a case-insensitive file system (the macOS and Windows defaults) has this case.
    if (!existsSync(other)) ctx.skip();
    await writeRegistry(JSON.stringify({ version: 1, salt: salt(), projects: {} }));
    expect(await ownProjectId(other)).toBe(
      await readProjectIdentity(other, { homeDir: homedir() }),
    );
  });

  it('still sends when the daemon shows no project id (no registry on its side)', async () => {
    daemon = await fakeDaemon('ok');
    await initProject(daemon.port);
    expectSilentSuccess(await runHook(JSON.stringify(fx.stop), { CLAUDE_PROJECT_DIR: projectDir }));
    expect(events(daemon)).toHaveLength(1);
  });
});
