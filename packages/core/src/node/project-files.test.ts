import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configPath, readConfig } from './config-file.js';
import { readRuntime, runtimePath } from './runtime.js';

let project: string;
let outside: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-files-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-outside-'));
  await mkdir(join(project, '.flutterdeck'));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const links = process.platform === 'win32' ? it.skip : it;

async function refusal(): Promise<string> {
  try {
    await readConfig(project);
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('config.json from a cloned repository', () => {
  it('never repeats the file text when it is not JSON', async () => {
    await writeFile(configPath(project), 'SECRET-TOKEN=abc123');
    const message = await refusal();
    expect(message).toMatch(/config\.json is not valid JSON\.$/);
    expect(message).not.toContain('SECRET');
  });

  links('is refused when it is a link, and the linked file is not read', async () => {
    const target = join(outside, 'secret.json');
    await writeFile(target, '{"version":1,"port":4242}');
    await symlink(target, configPath(project));
    const message = await refusal();
    expect(message).toMatch(/config\.json is not a regular file/);
    expect(message).not.toContain('4242');
  });

  it('is refused when it is a folder', async () => {
    await mkdir(configPath(project));
    expect(await refusal()).toMatch(/config\.json is not a regular file/);
  });
});

describe('runtime.json from a cloned repository', () => {
  links('is ignored when it is a link', async () => {
    const target = join(outside, 'runtime.json');
    await writeFile(
      target,
      JSON.stringify({ pid: 1, port: 9147, token: 't'.repeat(43), startedAt: 0 }),
    );
    await symlink(target, runtimePath(project));
    expect(await readRuntime(project)).toBeUndefined();
  });
});
