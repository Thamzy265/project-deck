/**
 * A bundle without its dashboard (finding F5): the daemon must fail before it claims a
 * port or writes the per-user port registry, so a failed start leaves nothing behind.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { IncompleteBundleError } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DashboardAssets from './dashboard-assets.js';
import { startDaemon } from './daemon.js';

vi.mock('./dashboard-assets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DashboardAssets>()),
  defaultDashboardDir: () => {
    throw new IncompleteBundleError('/bundle/dist/dashboard/index.html');
  },
}));

let homeDir: string;
let projectDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'deck-home-'));
  projectDir = await mkdtemp(join(tmpdir(), 'deck-'));
});

afterEach(async () => {
  for (const dir of [homeDir, projectDir]) await rm(dir, { recursive: true, force: true });
});

describe('startDaemon from a bundle without its dashboard', () => {
  it('fails before it writes the port registry', async () => {
    await mkdir(join(projectDir, '.pitdeck'));
    await writeFile(
      join(projectDir, '.pitdeck', 'config.json'),
      JSON.stringify({ version: 1, port: 9311 }),
    );
    await expect(
      startDaemon({ projectDir, registry: new Registry(), homeDir, log: () => undefined }),
    ).rejects.toBeInstanceOf(IncompleteBundleError);
    expect(await readdir(homeDir)).toEqual([]);
  });

  it('fails before it writes the port registry without a fixed port', async () => {
    await expect(
      startDaemon({ projectDir, registry: new Registry(), homeDir, log: () => undefined }),
    ).rejects.toBeInstanceOf(IncompleteBundleError);
    expect(await readdir(homeDir)).toEqual([]);
  });
});
