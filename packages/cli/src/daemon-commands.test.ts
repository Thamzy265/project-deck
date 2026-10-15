/**
 * start, stop and open against the real daemon (built dist), started with --fake so no
 * Flutter, DTD or adb is needed. HOME is the scratch folder from the global setup.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntime } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonCommandOptions } from './daemon-commands.js';
import { runOpen, runStart, runStop } from './daemon-commands.js';

const DAEMON_MAIN = createRequire(import.meta.url).resolve('@project-deck/daemon/main');

let project: string;
let port: number;
let lines: string[];
let errors: string[];
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port: free } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return free;
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-daemon-'));
  port = await freePort();
  await mkdir(join(project, '.flutterdeck'));
  await writeFile(
    join(project, '.flutterdeck', 'config.json'),
    JSON.stringify({ version: 1, port }) + '\n',
  );
  lines = [];
  errors = [];
});

afterEach(async () => {
  // Stops a daemon a failed test left running, through its API like the CLI does.
  await runStop(options()).catch(() => undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      });
    }
  }
  await rm(project, { recursive: true, force: true });
});

function options(extra: Partial<DaemonCommandOptions> = {}): DaemonCommandOptions {
  return {
    projectDir: project,
    io: { out: (l) => lines.push(l), err: (l) => errors.push(l) },
    // The fixed spawn, plus --fake: an in-memory app instead of DTD discovery.
    spawnDaemon: (dir, onExit) => {
      const child = spawn(process.execPath, [DAEMON_MAIN, '--project', dir, '--fake'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.on('exit', (code) => onExit(code));
      children.push(child);
    },
    client: { readyTimeoutMs: 15_000, stopTimeoutMs: 10_000 },
    ...extra,
  };
}

async function health(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe('start, open and stop', () => {
  it('starts the daemon, reopens the window when already running, and stops it', async () => {
    expect(await runStart(options())).toBe(0);
    expect(errors).toEqual([]);
    expect(lines[0]).toBe('FlutterDeck started.');
    expect(lines).toContain(`Dashboard: http://127.0.0.1:${port}/`);
    expect(await health()).toBe(true);
    const info = await readRuntime(project);
    expect(info?.port).toBe(port);

    lines = [];
    expect(await runStart(options())).toBe(0);
    expect(lines[0]).toContain('already running');

    lines = [];
    let opened: string | undefined;
    const open = await runOpen({
      ...options(),
      browser: true,
      openBrowser: (url) => {
        opened = url;
        return true;
      },
    });
    expect(open).toBe(0);
    expect(opened).toBe(`http://127.0.0.1:${port}/`);
    expect(lines.join('\n')).toContain('within 2 minutes');

    lines = [];
    expect(await runStop(options())).toBe(0);
    expect(lines).toEqual(['FlutterDeck stopped.']);
    expect(await readRuntime(project)).toBeUndefined();
    expect(await health()).toBe(false);
    // Never the token in anything printed.
    for (const line of [...lines, ...errors]) expect(line).not.toContain(info?.token ?? '-');
  }, 30_000);

  it('prints the address only, without --browser', async () => {
    await runStart(options());
    let called = false;
    const open = await runOpen({
      ...options(),
      browser: false,
      openBrowser: () => (called = true),
    });
    expect(open).toBe(0);
    expect(called).toBe(false);
  }, 30_000);
});

describe('without a running daemon', () => {
  it('stop says so and succeeds', async () => {
    expect(await runStop(options())).toBe(0);
    expect(lines).toEqual(["FlutterDeck isn't running for this project."]);
    expect(children).toEqual([]);
  });

  it('open says to run start, and starts nothing', async () => {
    const code = await runOpen({ ...options(), browser: true, openBrowser: () => true });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('flutterdeck start');
    expect(children).toEqual([]);
  });

  it('start refuses a folder init never set up', async () => {
    await rm(join(project, '.flutterdeck'), { recursive: true });
    expect(await runStart(options())).toBe(1);
    expect(errors.join('\n')).toContain('flutterdeck init');
    expect(children).toEqual([]);
  });
});
