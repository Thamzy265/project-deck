import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';

let projectDir: string;
let homeDir: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-notify-'));
  homeDir = await mkdtemp(join(tmpdir(), 'deck-notify-home-'));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await rm(projectDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

async function start(notifier?: (title: string, text: string) => void): Promise<Daemon> {
  const registry = new Registry();
  registry.connectors.register(new FakeAppConnector('fake', [fakeApp()]));
  daemon = await startDaemon({
    projectDir,
    homeDir,
    registry,
    port: 0,
    log: () => undefined,
    ...(notifier === undefined ? {} : { notifier }),
  });
  return daemon;
}

async function postWaiting(d: Daemon, message: string): Promise<number> {
  const res = await fetch(`${d.url}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deck-token': d.token },
    body: JSON.stringify({ type: 'claude.waiting', message }),
  });
  return res.status;
}

describe('daemon notifications', () => {
  it('shows a notification for a hook event through the given notifier', async () => {
    const notifier = vi.fn();
    const d = await start(notifier);
    expect(await postWaiting(d, 'Claude needs your permission to use Bash')).toBe(200);
    await vi.waitFor(() =>
      expect(notifier).toHaveBeenCalledWith(
        'FlutterDeck',
        'Claude is waiting — Claude needs your permission to use Bash',
      ),
    );
  });

  it('follows the switches in .flutterdeck/config.json', async () => {
    await mkdir(join(projectDir, '.flutterdeck'));
    await writeFile(
      join(projectDir, '.flutterdeck', 'config.json'),
      JSON.stringify({ version: 1, notifications: { claudeWaiting: false } }),
    );
    const notifier = vi.fn();
    const d = await start(notifier);
    expect(await postWaiting(d, 'Allow?')).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notifier).not.toHaveBeenCalled();
  });

  it('runs no notifier unless one is given (tests and embedders stay quiet)', async () => {
    const d = await start();
    expect(await postWaiting(d, 'Allow?')).toBe(200);
  });
});
