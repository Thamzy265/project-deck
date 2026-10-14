import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectIdentity, registryPath } from './project-id.js';

let home: string;
let project: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'deck-home-'));
  project = await mkdtemp(join(tmpdir(), 'deck-proj-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe('readProjectIdentity', () => {
  it('computes the id the daemon shows, from the salt and the real path', async () => {
    const salt = 's'.repeat(43);
    await mkdir(join(home, '.flutterdeck'));
    await writeFile(registryPath(home), JSON.stringify({ version: 1, salt, projects: {} }));
    const key = await realpath(project);
    const expected = createHash('sha256')
      .update(salt + (process.platform === 'win32' ? key.toLowerCase() : key))
      .digest('hex')
      .slice(0, 12);
    expect(await readProjectIdentity(project, { homeDir: home })).toBe(expected);
  });

  it('is unknown without a registry, and creates none', async () => {
    expect(await readProjectIdentity(project, { homeDir: home })).toBeUndefined();
    await expect(access(join(home, '.flutterdeck'))).rejects.toThrow();
  });

  it('is unknown for a damaged registry', async () => {
    await mkdir(join(home, '.flutterdeck'));
    await writeFile(registryPath(home), '{"version":1');
    expect(await readProjectIdentity(project, { homeDir: home })).toBeUndefined();
  });
});
