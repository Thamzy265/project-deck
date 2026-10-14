import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './config.js';
import type { Daemon } from './daemon.js';
import { PortBusyError, startDaemon } from './daemon.js';
import { projectIdentity } from './port-registry.js';
import { readRuntime } from './runtime.js';

let homeDir: string;
let projectDir: string;
let otherDir: string;
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'deck-home-'));
  projectDir = await mkdtemp(join(tmpdir(), 'deck-'));
  otherDir = await mkdtemp(join(tmpdir(), 'deck-other-'));
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const dir of [homeDir, projectDir, otherDir])
    await rm(dir, { recursive: true, force: true });
});

async function writeConfig(dir: string, port: number): Promise<void> {
  await mkdir(join(dir, '.flutterdeck'), { recursive: true });
  await writeFile(join(dir, '.flutterdeck', 'config.json'), JSON.stringify({ version: 1, port }));
}

async function start(
  opts: { dir?: string; port?: number; messages?: string[] } = {},
): Promise<Daemon> {
  const d = await startDaemon({
    projectDir: opts.dir ?? projectDir,
    registry: new Registry(),
    homeDir,
    ...(opts.port === undefined ? {} : { port: opts.port }),
    log: (message) => opts.messages?.push(message),
  });
  cleanups.push(() => d.stop());
  return d;
}

async function occupy(): Promise<number> {
  const srv = await new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  // It accepts connections and never answers, like a program that doesn't speak HTTP.
  const sockets = new Set<Socket>();
  srv.on('connection', (socket) => sockets.add(socket));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((r) => srv.close(r));
  });
  return (srv.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

describe('fixed port from .flutterdeck/config.json', () => {
  it('uses exactly the configured port and reports the project id on /api/health', async () => {
    const port = await freePort();
    await writeConfig(projectDir, port);
    const d = await start({ port: 0 });
    expect(d.port).toBe(port);
    const health = (await (await fetch(`${d.url}/api/health`)).json()) as Record<string, unknown>;
    expect(health).toEqual({
      ok: true,
      name: 'project-deck',
      version: d.version,
      projectId: await projectIdentity(projectDir, { homeDir }),
    });
  });

  it('exits with "Another program uses port" when something else listens there', async () => {
    const port = await occupy();
    await writeConfig(projectDir, port);
    const err = await start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortBusyError);
    expect((err as Error).message).toBe(
      `Another program uses port ${port}. Stop it, or pick another port: run \`flutterdeck init\`, or change "port" in .flutterdeck/config.json and the url in .claude/launch.json.`,
    );
    expect((err as Error).message).toContain('flutterdeck init');
    expect(await readRuntime(projectDir)).toBeUndefined();
  });

  it('exits with "Another FlutterDeck (project <id>)" when another daemon holds the port', async () => {
    const other = await start({ dir: otherDir, port: 0 });
    await writeConfig(projectDir, other.port);
    const err = await start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortBusyError);
    const otherId = await projectIdentity(otherDir, { homeDir });
    expect((err as Error).message).toMatch(
      new RegExp(`^Another FlutterDeck \\(project ${otherId}\\) uses port ${other.port}\\b`),
    );
  });

  it('starts on a free port another checkout also registered, and warns', async () => {
    const port = await freePort();
    await writeConfig(otherDir, port);
    const other = await start({ dir: otherDir });
    await other.stop();
    await writeConfig(projectDir, port);
    const messages: string[] = [];
    const d = await start({ messages });
    expect(d.port).toBe(port);
    const otherId = await projectIdentity(otherDir, { homeDir });
    expect(messages).toContain(
      `Port ${port} is also registered to another project (project ${otherId}); if both run at once one will fail. Run \`flutterdeck init\` to pick a new port.`,
    );
  });

  it('says another FlutterDeck holds the port when the other checkout is running', async () => {
    const port = await freePort();
    await writeConfig(otherDir, port);
    await start({ dir: otherDir });
    await writeConfig(projectDir, port);
    const err = await start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortBusyError);
    const otherId = await projectIdentity(otherDir, { homeDir });
    expect((err as Error).message).toMatch(
      new RegExp(`^Another FlutterDeck \\(project ${otherId}\\) uses port ${port}\\b`),
    );
    expect(await readRuntime(projectDir)).toBeUndefined();
  });

  it('refuses to start with a broken config file', async () => {
    await mkdir(join(projectDir, '.flutterdeck'), { recursive: true });
    await writeFile(join(projectDir, '.flutterdeck', 'config.json'), '{"version":1,"prot":1}');
    await expect(start()).rejects.toBeInstanceOf(ConfigError);
  });

  it('keeps the next-free-port behaviour without a config file', async () => {
    const busy = await occupy();
    const d = await start({ port: busy });
    expect(d.port).not.toBe(busy);
  });

  it('reports a project id on /api/health without a config file too', async () => {
    const d = await start({ port: 0 });
    const health = (await (await fetch(`${d.url}/api/health`)).json()) as { projectId: string };
    expect(health.projectId).toBe(await projectIdentity(projectDir, { homeDir }));
  });
});
