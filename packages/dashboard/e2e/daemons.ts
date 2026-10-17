/**
 * Daemons for the end-to-end tests. Both use scratch project and home folders, so no test
 * touches the real ~/.flutterdeck or a real project.
 * - `spawnFakeDaemon`: the real entry point, `node packages/daemon/dist/main.js --fake`.
 * - `startScriptedDaemon`: the same daemon started in-process with scriptable fake apps
 *   and a fake clock, for states main.js can't produce (several apps, a stopped app, a
 *   failed reload, a closed login window). Test-only: nothing in the product exposes it.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '@project-deck/core';
import type { DbInspectorFactory, RunningApp } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import type { Daemon } from '../../daemon/dist/index.js';
import { readRuntime, startDaemon } from '../../daemon/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
const MAIN = join(REPO, 'packages/daemon/dist/main.js');
const DASHBOARD = join(REPO, 'packages/dashboard/dist');
export const ARTIFACTS = join(REPO, 'qa-artifacts/m2-dashboard');

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** `.flutterdeck/config.json` in a scratch project, e.g. `{ db: { allowWrites: true } }`. */
async function writeConfig(project: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(join(project, '.flutterdeck'), { recursive: true });
  await writeFile(
    join(project, '.flutterdeck', 'config.json'),
    JSON.stringify({ version: 1, ...config }),
  );
}

export interface SpawnedDaemon {
  url: string;
  port: number;
  token: string;
  /** SIGTERM and wait for exit. */
  stop(): Promise<void>;
  /** Starts a new daemon process for the same project on the same port. */
  restart(): Promise<void>;
  cleanup(): Promise<void>;
}

function waitForListening(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let out = '';
    const onData = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes('listening on')) {
        child.stdout?.off('data', onData);
        resolveReady();
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    child.once('exit', (code) => reject(new Error(`daemon exited (${String(code)}): ${out}`)));
  });
}

export async function spawnFakeDaemon(
  opts: { config?: Record<string, unknown> } = {},
): Promise<SpawnedDaemon> {
  const project = await scratch('deck-e2e-proj-');
  const home = await scratch('deck-e2e-home-');
  if (opts.config !== undefined) await writeConfig(project, opts.config);
  let child: ChildProcess | undefined;
  let port = 0;
  let token = '';

  const launch = async () => {
    const proc = spawn(
      process.execPath,
      [MAIN, '--fake', '--project', project, '--port', String(port)],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    proc.on('error', () => undefined);
    proc.stderr.resume();
    child = proc;
    await waitForListening(proc);
    const info = await readRuntime(project);
    if (info === undefined) throw new Error('no runtime.json');
    port = info.port;
    token = info.token;
  };
  const stop = async () => {
    const proc = child;
    child = undefined;
    if (proc === undefined || proc.exitCode !== null) return;
    proc.removeAllListeners('exit');
    await new Promise<void>((done) => {
      proc.once('exit', () => done());
      proc.kill('SIGTERM');
    });
  };
  await launch();
  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    get token() {
      return token;
    },
    stop,
    restart: launch,
    async cleanup() {
      await stop();
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

export interface ScriptedDaemon {
  daemon: Daemon;
  connector: ScriptedConnector;
  url: string;
  /** Moves the login window's clock on. */
  advance(ms: number): void;
  cleanup(): Promise<void>;
}

/** A connector whose attach can be made to fail, for the "Couldn't attach" state. */
export class ScriptedConnector extends FakeAppConnector {
  failAttach: string | undefined;
  /** While set, start() waits, so the daemon stays "discovering". */
  private hold: Promise<void> | undefined;
  private release: () => void = () => undefined;

  holdDiscovery(): void {
    this.hold = new Promise((resolve) => (this.release = resolve));
  }

  finishDiscovery(): void {
    this.release();
  }

  override async start(): Promise<void> {
    await this.hold;
    return super.start();
  }

  override attach(appId: string) {
    if (this.failAttach !== undefined) return Promise.reject(new Error(this.failAttach));
    return super.attach(appId);
  }
}

export async function startScriptedDaemon(
  apps: RunningApp[] = [fakeApp()],
  opts: {
    holdDiscovery?: boolean;
    dbInspectors?: DbInspectorFactory[];
    config?: Record<string, unknown>;
  } = {},
): Promise<ScriptedDaemon & { connector: ScriptedConnector }> {
  const project = await scratch('deck-e2e-proj-');
  const home = await scratch('deck-e2e-home-');
  if (opts.config !== undefined) await writeConfig(project, opts.config);
  let offset = 0;
  const registry = new Registry();
  for (const factory of opts.dbInspectors ?? []) registry.dbInspectors.register(factory);
  const connector = new ScriptedConnector('fake', apps);
  registry.connectors.register(connector);
  if (opts.holdDiscovery === true) connector.holdDiscovery();
  const daemon = await startDaemon({
    projectDir: project,
    homeDir: home,
    registry,
    port: 0,
    dashboardDir: DASHBOARD,
    now: () => Date.now() + offset,
    log: () => undefined,
  });
  return {
    daemon,
    connector,
    url: daemon.url,
    advance: (ms) => (offset += ms),
    async cleanup() {
      await daemon.stop();
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

export { fakeApp };
