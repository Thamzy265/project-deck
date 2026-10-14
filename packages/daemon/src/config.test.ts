import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configPath, readConfig } from './config.js';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-config-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function write(content: string): Promise<void> {
  await mkdir(join(projectDir, '.flutterdeck'), { recursive: true });
  await writeFile(configPath(projectDir), content);
}

describe('readConfig', () => {
  it('returns the defaults when there is no file', async () => {
    expect(await readConfig(projectDir)).toEqual(DEFAULT_CONFIG);
  });

  it('reads a valid file', async () => {
    await write(JSON.stringify({ version: 1, port: 9150, logs: { redact: false } }));
    const config = await readConfig(projectDir);
    expect(config.port).toBe(9150);
    expect(config.logs).toEqual({ redact: false, rules: [] });
  });

  it('names the file and the problem for invalid JSON', async () => {
    await write('{ "version": 1, ');
    const err = await readConfig(projectDir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/\.flutterdeck[\\/]config\.json is not valid JSON/);
  });

  it('lists each invalid key with its path', async () => {
    await write(JSON.stringify({ version: 1, port: 80, logs: { redcat: true } }));
    const err = await readConfig(projectDir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toContain('port');
    expect(message).toContain('redcat');
  });

  it('refuses an unknown version and says the file was left as it is', async () => {
    await write(JSON.stringify({ version: 2 }));
    await expect(readConfig(projectDir)).rejects.toThrow(
      /version 2.*reads version 1.*left unchanged/,
    );
  });

  it('reports a file it cannot read', async () => {
    await mkdir(configPath(projectDir), { recursive: true });
    await expect(readConfig(projectDir)).rejects.toBeInstanceOf(ConfigError);
  });
});
