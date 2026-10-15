/**
 * Tester edge cases for the hook process: many hooks at once, a daemon that goes away or
 * misbehaves between the health check and the event, and project folder discovery. Runs
 * the script as Claude Code does (node, JSON on stdin) against local sockets only.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fx from './fixtures.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'deck-hook.mjs');
const posix = process.platform === 'win32' ? it.skip : it;

interface Seen {
  method: string;
  url: string;
  token: string | undefined;
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, server: Server) => void;

interface Fake {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

const healthy = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, name: 'project-deck', version: '0.0.0' }));
};

const okDaemon: Handler = (req, res) => {
  if (req.url === '/api/health') return healthy(res);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
};

async function fake(handler: Handler = okDaemon): Promise<Fake> {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const token = req.headers['x-deck-token'];
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        token: typeof token === 'string' ? token : undefined,
        body,
      });
      handler(req, res, body, server);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => sockets.delete(s));
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

interface Run {
  code: number | null;
  out: string;
  ms: number;
}

function runHook(
  input: unknown,
  env: Record<string, string | undefined>,
  cwd?: string,
): Promise<Run> {
  const started = Date.now();
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!('CLAUDE_PROJECT_DIR' in env)) delete childEnv.CLAUDE_PROJECT_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

let projectDir: string;
let token: string;
let daemon: Fake | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-hook-edge-'));
  token = randomBytes(24).toString('hex');
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(projectDir, { recursive: true, force: true });
});

async function initProject(dir: string, port: number): Promise<void> {
  await mkdir(join(dir, '.flutterdeck'), { recursive: true });
  await writeFile(join(dir, '.flutterdeck', 'config.json'), '{"version":1}\n');
  await writeFile(
    join(dir, '.flutterdeck', 'runtime.json'),
    JSON.stringify({ pid: process.pid, port, token, startedAt: 1 }),
    { mode: 0o600 },
  );
}

const quiet = (r: Run) => {
  expect(r.code).toBe(0);
  expect(r.out).toBe('');
};
const events = (d: Fake) => d.seen.filter((s) => s.url === '/api/events');

describe('the hook process under load and failure', () => {
  it('delivers every event when 20 hooks run at once', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const inputs = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { ...fx.stop, session_id: `s${i}` }
        : { ...fx.reloadFailed, session_id: `s${i}` },
    );
    const runs = await Promise.all(
      inputs.map((input) => runHook(input, { CLAUDE_PROJECT_DIR: projectDir })),
    );
    for (const r of runs) quiet(r);
    const sent = events(daemon).map((e) => {
      const body: unknown = JSON.parse(e.body);
      return typeof body === 'object' && body !== null && 'sessionId' in body ? body.sessionId : '';
    });
    expect(sent.sort()).toEqual(inputs.map((i) => i.session_id).sort());
    expect(events(daemon).every((e) => e.token === token)).toBe(true);
  }, 20_000);

  it('exits quietly when the daemon stops between the health check and the event', async () => {
    daemon = await fake((req, res, _body, server) => {
      if (req.url !== '/api/health') return;
      healthy(res);
      // A restart: the old daemon stops listening right after it answers.
      server.close();
    });
    await initProject(projectDir, daemon.port);
    const r = await runHook(fx.stop, { CLAUDE_PROJECT_DIR: projectDir });
    quiet(r);
    expect(r.ms).toBeLessThan(3500);
    expect(events(daemon)).toEqual([]);
  });

  it('exits quietly when the daemon drops the connection mid-event', async () => {
    daemon = await fake((req, res) => {
      if (req.url === '/api/health') return healthy(res);
      req.socket.destroy();
    });
    await initProject(projectDir, daemon.port);
    const r = await runHook(fx.reloadFailed, { CLAUDE_PROJECT_DIR: projectDir });
    quiet(r);
    expect(r.ms).toBeLessThan(3500);
    expect(events(daemon)).toHaveLength(1);
  });

  it('exits quietly when the health answer stops half way', async () => {
    daemon = await fake((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      res.write('{"ok":true,"name":"proj');
      setTimeout(() => req.socket.destroy(), 50);
    });
    await initProject(projectDir, daemon.port);
    const r = await runHook(fx.stop, { CLAUDE_PROJECT_DIR: projectDir });
    quiet(r);
    expect(r.ms).toBeLessThan(3500);
    expect(events(daemon)).toEqual([]);
  });

  it('keeps the 2 s deadline across a slow health check and a hanging event', async () => {
    daemon = await fake((req, res) => {
      if (req.url === '/api/health') {
        setTimeout(() => healthy(res), 1500);
        return;
      }
      // Never answers the event.
    });
    await initProject(projectDir, daemon.port);
    const r = await runHook(fx.stop, { CLAUDE_PROJECT_DIR: projectDir });
    quiet(r);
    expect(r.ms).toBeLessThan(3000);
  });

  it.each([
    [
      'a redirect',
      (res: ServerResponse) => {
        res.writeHead(302, { location: '/api/health2' });
        res.end();
      },
    ],
    [
      'a health body over 64 kB',
      (res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'project-deck', pad: 'x'.repeat(70_000) }));
      },
    ],
    [
      'a name that only starts like FlutterDeck',
      (res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'project-deck-evil' }));
      },
    ],
    [
      'a health answer that is a JSON array',
      (res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[{"name":"project-deck"}]');
      },
    ],
  ])('never sends the token after %s', async (_, answer) => {
    daemon = await fake((req, res, body, server) => {
      if (req.url === '/api/health') return answer(res);
      okDaemon(req, res, body, server);
    });
    await initProject(projectDir, daemon.port);
    quiet(await runHook(fx.stop, { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.seen.every((s) => s.token === undefined)).toBe(true);
    expect(events(daemon)).toEqual([]);
  });

  it('sends a waiting message with control, bidi and JSON-breaking characters as one JSON string', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const message = '"}],"type":"claude.done"‮\u0000\r\n end';
    quiet(await runHook({ ...fx.permissionPrompt, message }, { CLAUDE_PROJECT_DIR: projectDir }));
    const [sent] = events(daemon);
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      type: 'claude.waiting',
      sessionId: 'abc123',
      message,
    });
  });

  // T-P5-2: a long reload error keeps the hook busy far past its deadline.
  it('T-P5-2 exits within the deadline on an 80 kB reload error', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const r = await runHook(
      { ...fx.reloadFailed, error: `Hot reload failed: ${'a.'.repeat(40_000)}` },
      { CLAUDE_PROJECT_DIR: projectDir },
    );
    quiet(r);
    expect(r.ms).toBeLessThan(3500);
  }, 30_000);

  it('T-P5-2 exits within the deadline on a 4 MB reload error and still sends the event', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const r = await runHook(
      { ...fx.reloadFailed, error: `Hot reload failed: ${'a.'.repeat(2_000_000)}` },
      { CLAUDE_PROJECT_DIR: projectDir },
    );
    quiet(r);
    expect(r.ms).toBeLessThan(3500);
    expect(events(daemon)).toHaveLength(1);
  }, 30_000);
});

describe('the hook process: finding the project', () => {
  it('does nothing when CLAUDE_PROJECT_DIR is a subfolder of the project', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const lib = join(projectDir, 'lib');
    await mkdir(lib);
    quiet(await runHook(fx.stop, { CLAUDE_PROJECT_DIR: lib }));
    expect(daemon.seen).toEqual([]);
  });

  it('uses CLAUDE_PROJECT_DIR over cwd, even when only cwd is set up (a worktree)', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const worktree = await mkdtemp(join(tmpdir(), 'deck-hook-worktree-'));
    try {
      quiet(await runHook({ ...fx.stop, cwd: projectDir }, { CLAUDE_PROJECT_DIR: worktree }));
      expect(daemon.seen).toEqual([]);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('falls back to cwd when CLAUDE_PROJECT_DIR is empty or relative', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    for (const value of ['', '.', 'project']) {
      quiet(await runHook({ ...fx.stop, cwd: projectDir }, { CLAUDE_PROJECT_DIR: value }));
    }
    expect(events(daemon)).toHaveLength(3);
  });

  it("ignores the process's own working folder: only the hook input's cwd counts", async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    quiet(await runHook({ ...fx.stop, cwd: undefined }, {}, projectDir));
    expect(daemon.seen).toEqual([]);
  });

  posix('works when cwd reaches the project through a link', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const parent = await mkdtemp(join(tmpdir(), 'deck-hook-cwdlink-'));
    try {
      const linked = join(parent, 'shop_app');
      await symlink(projectDir, linked, 'dir');
      quiet(await runHook({ ...fx.stop, cwd: linked }, {}));
      expect(events(daemon)).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  posix('never follows a linked config.json', async () => {
    daemon = await fake();
    await initProject(projectDir, daemon.port);
    const real = join(projectDir, 'elsewhere.json');
    await writeFile(real, '{"version":1}');
    await rm(join(projectDir, '.flutterdeck', 'config.json'));
    await symlink(real, join(projectDir, '.flutterdeck', 'config.json'));
    quiet(await runHook(fx.stop, { CLAUDE_PROJECT_DIR: projectDir }));
    expect(daemon.seen).toEqual([]);
  });
});
