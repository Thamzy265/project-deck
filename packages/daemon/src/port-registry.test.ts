import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PortRegistryError,
  allocatePort,
  claimConfigPort,
  projectIdentity,
  registryPath,
} from './port-registry.js';

let homeDir: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'deck-home-'));
  projectA = await mkdtemp(join(tmpdir(), 'deck-a-'));
  projectB = await mkdtemp(join(tmpdir(), 'deck-b-'));
});

afterEach(async () => {
  for (const dir of [homeDir, projectA, projectB]) await rm(dir, { recursive: true, force: true });
});

const allFree = () => Promise.resolve(true);

async function registryFile(): Promise<{
  salt: string;
  projects: Record<string, number>;
}> {
  return JSON.parse(await readFile(registryPath(homeDir), 'utf8')) as {
    salt: string;
    projects: Record<string, number>;
  };
}

describe('projectIdentity', () => {
  it('is 12 hex characters, stable across calls, and different per project', async () => {
    const a1 = await projectIdentity(projectA, { homeDir });
    const a2 = await projectIdentity(projectA, { homeDir });
    const b = await projectIdentity(projectB, { homeDir });
    expect(a1).toMatch(/^[0-9a-f]{12}$/);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
  });

  it('depends on the per-user salt, so the id reveals nothing about the path', async () => {
    const before = await projectIdentity(projectA, { homeDir });
    const otherHome = await mkdtemp(join(tmpdir(), 'deck-home-'));
    try {
      expect(await projectIdentity(projectA, { homeDir: otherHome })).not.toBe(before);
    } finally {
      await rm(otherHome, { recursive: true, force: true });
    }
    expect((await registryFile()).salt.length).toBeGreaterThanOrEqual(43);
  });

  it('gives the same id through a symlink to the project', async () => {
    const link = join(homeDir, 'link');
    // Junctions need no extra rights on Windows.
    await symlink(projectA, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await projectIdentity(link, { homeDir })).toBe(
      await projectIdentity(projectA, { homeDir }),
    );
  });

  it('writes the registry readable by the user only', async () => {
    await projectIdentity(projectA, { homeDir });
    if (process.platform !== 'win32') {
      expect((await stat(registryPath(homeDir))).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a corrupt registry instead of replacing it', async () => {
    await mkdir(join(homeDir, '.flutterdeck'), { recursive: true });
    await writeFile(registryPath(homeDir), '{ nope');
    await expect(projectIdentity(projectA, { homeDir })).rejects.toBeInstanceOf(PortRegistryError);
    expect(await readFile(registryPath(homeDir), 'utf8')).toBe('{ nope');
  });
});

describe('allocatePort', () => {
  it.skipIf(process.platform === 'win32')(
    'creates ~/.flutterdeck readable by the user only, also when the lock comes first',
    async () => {
      await allocatePort(projectA, { homeDir, isFree: allFree });
      expect((await stat(join(homeDir, '.flutterdeck'))).mode & 0o777).toBe(0o700);
    },
  );

  it('takes over a registry lock left behind by a crashed process', async () => {
    await mkdir(join(homeDir, '.flutterdeck'), { recursive: true });
    const lock = join(homeDir, '.flutterdeck', 'ports.json.lock');
    // pid 2^22 + 1 is above every default pid limit, so it is never alive.
    await writeFile(lock, JSON.stringify({ pid: 4_194_305, createdAt: Date.now() }));
    expect(await allocatePort(projectA, { homeDir, isFree: allFree })).toBe(9147);
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives the first project 9147 and the next one the next free unregistered port', async () => {
    expect(await allocatePort(projectA, { homeDir, isFree: allFree })).toBe(9147);
    const busy = new Set([9148]);
    const isFree = (port: number) => Promise.resolve(!busy.has(port));
    expect(await allocatePort(projectB, { homeDir, isFree })).toBe(9149);
    const projects = Object.values((await registryFile()).projects);
    expect(projects.sort()).toEqual([9147, 9149]);
  });

  it('keeps a project on its registered port', async () => {
    const first = await allocatePort(projectA, { homeDir, isFree: allFree });
    expect(await allocatePort(projectA, { homeDir, isFree: () => Promise.resolve(false) })).toBe(
      first,
    );
  });

  it('never hands out a registered port, even when it is free right now', async () => {
    await allocatePort(projectA, { homeDir, isFree: allFree });
    expect(await allocatePort(projectB, { homeDir, isFree: allFree })).toBe(9148);
  });
});

describe('claimConfigPort', () => {
  it('passes for the project that owns the port', async () => {
    const port = await allocatePort(projectA, { homeDir, isFree: allFree });
    await expect(claimConfigPort(projectA, port, { homeDir })).resolves.toBeUndefined();
  });

  it('registers an unclaimed port for a project cloned with a committed config', async () => {
    await claimConfigPort(projectA, 9200, { homeDir });
    expect(Object.values((await registryFile()).projects)).toEqual([9200]);
    expect(await allocatePort(projectB, { homeDir, isFree: allFree })).toBe(9147);
  });

  it('follows a port the user changed in the config, so init never hands out the old one twice', async () => {
    await claimConfigPort(projectA, 9200, { homeDir });
    await claimConfigPort(projectA, 9201, { homeDir });
    expect(Object.values((await registryFile()).projects)).toEqual([9201]);
    expect(await allocatePort(projectA, { homeDir, isFree: allFree })).toBe(9201);
  });

  it('names another existing project on the same port and leaves its registration alone', async () => {
    const port = await allocatePort(projectA, { homeDir, isFree: allFree });
    expect(await claimConfigPort(projectB, port, { homeDir })).toBe(
      await projectIdentity(projectA, { homeDir }),
    );
    expect(Object.values((await registryFile()).projects)).toEqual([port]);
    expect(await allocatePort(projectA, { homeDir, isFree: allFree })).toBe(port);
  });

  it('forgets projects whose folder is gone, so their port is free again', async () => {
    const port = await allocatePort(projectA, { homeDir, isFree: allFree });
    await rm(projectA, { recursive: true, force: true });
    expect(await claimConfigPort(projectB, port, { homeDir })).toBeUndefined();
    expect(Object.values((await registryFile()).projects)).toEqual([port]);
  });

  it('prunes gone projects when allocating too', async () => {
    await allocatePort(projectA, { homeDir, isFree: allFree });
    await rm(projectA, { recursive: true, force: true });
    expect(await allocatePort(projectB, { homeDir, isFree: allFree })).toBe(9147);
    expect(Object.keys((await registryFile()).projects)).toHaveLength(1);
  });
});
