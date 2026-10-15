import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { readProjectIdentity, registryPath } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from './daemon.js';
import { PortRegistryError, allocatePort, projectIdentity } from './port-registry.js';

let projectDir: string;
let homeDir: string;
let outside: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-locklink-'));
  homeDir = await mkdtemp(join(tmpdir(), 'deck-locklink-home-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-locklink-out-'));
  await mkdir(join(projectDir, '.flutterdeck'));
  await mkdir(join(homeDir, '.flutterdeck'));
});

afterEach(async () => {
  for (const dir of [projectDir, homeDir, outside]) await rm(dir, { recursive: true, force: true });
});

/** A file of the user's that a planted link points at; it must never change. */
async function usersFile(name: string, content: string): Promise<string> {
  const path = join(outside, name);
  await writeFile(path, content);
  return path;
}

describe.skipIf(process.platform === 'win32')('links planted where FlutterDeck keeps state', () => {
  it('a startup.lock link is removed, not followed, and the daemon starts at once', async () => {
    const target = await usersFile('notes.txt', 'my notes\n');
    await symlink(target, join(projectDir, '.flutterdeck', 'startup.lock'));
    const d = await startDaemon({
      projectDir,
      homeDir,
      registry: new Registry(),
      port: 0,
      log: () => undefined,
    });
    await d.stop();
    expect(await readFile(target, 'utf8')).toBe('my notes\n');
  }, 4000);

  it('a ports.json.lock link is removed, not followed', async () => {
    const target = await usersFile('notes.txt', 'my notes\n');
    await symlink(target, join(homeDir, '.flutterdeck', 'ports.json.lock'));
    expect(await allocatePort(projectDir, { homeDir, isFree: () => Promise.resolve(true) })).toBe(
      9147,
    );
    expect(await readFile(target, 'utf8')).toBe('my notes\n');
  }, 4000);

  it('a ports.json link is never read', async () => {
    const target = await usersFile(
      'registry.json',
      JSON.stringify({ version: 1, salt: 's'.repeat(43), projects: {} }),
    );
    await symlink(target, registryPath(homeDir));
    expect(await readProjectIdentity(projectDir, { homeDir })).toBeUndefined();
    await expect(projectIdentity(projectDir, { homeDir })).rejects.toThrow(PortRegistryError);
    await expect(projectIdentity(projectDir, { homeDir })).rejects.toThrow(/not a regular file/);
  });
});
