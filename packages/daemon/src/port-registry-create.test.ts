import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectIdentity } from '@project-deck/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectIdentity, registryPath } from './port-registry.js';

let homeDir: string;
let projectDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'deck-reg-create-'));
  projectDir = await realpath(await mkdtemp(join(tmpdir(), 'deck-reg-proj-')));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

const VALID = JSON.stringify({ version: 1, salt: 's'.repeat(43), projects: {} });

/** An empty registry that another process fills in a moment later. */
async function beingCreated(): Promise<void> {
  await mkdir(join(homeDir, '.flutterdeck'), { recursive: true });
  await writeFile(registryPath(homeDir), '');
  setTimeout(() => void writeFile(registryPath(homeDir), VALID), 40);
}

describe('ports.json while it is being created', () => {
  it('is waited for by the daemon, not called damaged', async () => {
    await beingCreated();
    expect(await projectIdentity(projectDir, { homeDir })).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is waited for by clients too', async () => {
    await beingCreated();
    expect(await readProjectIdentity(projectDir, { homeDir })).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is created whole: concurrent first starts agree on one salt and leave no temp files', async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => projectIdentity(projectDir, { homeDir })),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await readdir(join(homeDir, '.flutterdeck'))).toEqual(['ports.json']);
  });
});
