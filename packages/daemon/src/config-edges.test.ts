import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configPath, readConfig } from './config.js';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-config-edges-'));
  await mkdir(join(projectDir, '.flutterdeck'), { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function write(content: string | Buffer): Promise<void> {
  await writeFile(configPath(projectDir), content);
}

async function refusal(): Promise<string> {
  const err: unknown = await readConfig(projectDir).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigError);
  return err instanceof Error ? err.message : '';
}

describe('readConfig: file contents', () => {
  it('refuses an empty file and names it', async () => {
    await write('');
    expect(await refusal()).toMatch(/^\.flutterdeck[/\\]config\.json is not valid JSON/);
  });

  it('refuses a file of only whitespace', async () => {
    await write('  \n\t\n');
    expect(await refusal()).toContain('is not valid JSON');
  });

  // BUG-T4: Windows editors (PowerShell 5 Set-Content -Encoding UTF8, older Notepad) save a
  // UTF-8 byte order mark. The file is refused with an invisible "Unexpected token".
  it('reads a file that starts with a UTF-8 byte order mark (BUG-T4)', async () => {
    await write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":1}')]));
    expect(await readConfig(projectDir)).toEqual(DEFAULT_CONFIG);
  });

  it('refuses comments (JSON, not JSONC)', async () => {
    await write('// mine\n{"version":1}');
    expect(await refusal()).toContain('is not valid JSON');
    await write('{"version":1 /* port later */}');
    expect(await refusal()).toContain('is not valid JSON');
  });

  it('refuses a trailing comma', async () => {
    await write('{"version":1,}');
    expect(await refusal()).toContain('is not valid JSON');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[{"version":1}]'],
    ['a string', '"version 1"'],
    ['a number', '1'],
    ['true', 'true'],
  ])('refuses %s at the top level and says where', async (_name, text) => {
    await write(text);
    expect(await refusal()).toContain('(top level)');
  });

  it('refuses an object without a version', async () => {
    await write('{"port":9147}');
    expect(await refusal()).toMatch(/version/);
  });

  it.each([
    ['2', '2'],
    ['the string "1"', '"1"'],
    ['0', '0'],
    ['a fraction', '1.5'],
    ['null', 'null'],
  ])('refuses version %s as unknown and leaves the file as it is', async (_name, version) => {
    const text = `{"version":${version}}`;
    await write(text);
    expect(await refusal()).toContain('this FlutterDeck reads version 1');
    expect(await readFile(configPath(projectDir), 'utf8')).toBe(text);
  });

  it('accepts version written as 1.0', async () => {
    await write('{"version":1.0}');
    expect(await readConfig(projectDir)).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ['1023 (privileged)', '1023'],
    ['0', '0'],
    ['-1', '-1'],
    ['65536', '65536'],
    ['a string', '"9147"'],
    ['a fraction', '9147.5'],
    ['null', 'null'],
    ['true', 'true'],
    ['an array', '[9147]'],
    ['1e309 (Infinity)', '1e309'],
  ])('refuses port %s and names the key', async (_name, port) => {
    await write(`{"version":1,"port":${port}}`);
    expect(await refusal()).toMatch(/is invalid: port:/);
  });

  it.each([
    [1024, 1024],
    [65535, 65535],
    [9147, 9147],
  ])('accepts port %i', async (port, expected) => {
    await write(JSON.stringify({ version: 1, port }));
    expect((await readConfig(projectDir)).port).toBe(expected);
  });

  it.each([
    ['notifications.appCrashed', '{"version":1,"notifications":{"appCrashed":"yes"}}'],
    ['notifications', '{"version":1,"notifications":true}'],
    ['logs.redact', '{"version":1,"logs":{"redact":0}}'],
    ['logs.rules', '{"version":1,"logs":{"rules":"a+"}}'],
    ['logs.rules.0', '{"version":1,"logs":{"rules":[1]}}'],
  ])('refuses a wrong type at %s and names the path', async (path, text) => {
    await write(text);
    expect(await refusal()).toContain(`${path}:`);
  });

  it('turns masking off only with an explicit false', async () => {
    await write('{"version":1,"logs":{"redact":null}}');
    expect(await refusal()).toContain('logs.redact:');
    await write('{"version":1,"logs":{}}');
    expect((await readConfig(projectDir)).logs.redact).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'prototype', 'toString'])(
    'refuses a %s key instead of merging it',
    async (key) => {
      await write(`{"version":1,"${key}":{"port":1}}`);
      expect(await refusal()).toContain(key);
      expect(({} as Record<string, unknown>).port).toBeUndefined();
    },
  );

  it('refuses a duplicate key that would turn masking off (last one wins in JSON.parse)', async () => {
    await write('{"version":1,"logs":{"redact":true,"redact":"no"}}');
    expect(await refusal()).toContain('logs.redact:');
  });

  it('refuses a huge file of rules quickly, by count, without echoing the rules', async () => {
    const rules = Array.from({ length: 50_000 }, (_, i) => `secret-${i}-[a-z]+`);
    await write(JSON.stringify({ version: 1, logs: { rules } }));
    const started = performance.now();
    const message = await refusal();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(message).toContain('logs.rules:');
    expect(message).not.toContain('secret-49999');
    expect(message.length).toBeLessThan(2000);
  });

  it('refuses an invalid rule and a rule that is too long', async () => {
    await write(JSON.stringify({ version: 1, logs: { rules: ['(unclosed'] } }));
    expect(await refusal()).toContain('Invalid regular expression');
    await write(JSON.stringify({ version: 1, logs: { rules: ['a'.repeat(201)] } }));
    expect(await refusal()).toContain('logs.rules.0:');
  });

  // BUG-T5: the design note (D4) says nested quantifiers in user rules are rejected; the
  // config schema accepts them. Lead to confirm whether the masking item will add this.
  it.fails('refuses a rule with nested quantifiers such as (a+)+ (BUG-T5)', async () => {
    await write(JSON.stringify({ version: 1, logs: { rules: ['(a+)+b'] } }));
    expect(await refusal()).toContain('logs.rules.0:');
  });
});

describe('readConfig: the file system', () => {
  it('reports a folder where the file should be', async () => {
    await mkdir(configPath(projectDir));
    expect(await refusal()).toMatch(/can't be read \((EISDIR|EPERM|EACCES)\)/);
  });

  it('uses the defaults when .flutterdeck itself is missing', async () => {
    await rm(join(projectDir, '.flutterdeck'), { recursive: true });
    expect(await readConfig(projectDir)).toEqual(DEFAULT_CONFIG);
  });

  it('uses the defaults for a project folder that does not exist', async () => {
    expect(await readConfig(join(projectDir, 'nope'))).toEqual(DEFAULT_CONFIG);
  });

  it.skipIf(process.platform === 'win32')('treats a dangling symlink as missing', async () => {
    await symlink(join(projectDir, 'gone.json'), configPath(projectDir));
    expect(await readConfig(projectDir)).toEqual(DEFAULT_CONFIG);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a file it may not read, without its contents',
    async () => {
      await write('{"version":1,"port":9147}');
      await chmod(configPath(projectDir), 0o000);
      try {
        const message = await refusal();
        expect(message).toContain("can't be read (EACCES)");
        expect(message).not.toContain('9147');
      } finally {
        await chmod(configPath(projectDir), 0o600);
      }
    },
  );

  it('never writes the file, also after reading defaults', async () => {
    await rm(join(projectDir, '.flutterdeck'), { recursive: true });
    await readConfig(projectDir);
    await expect(readFile(configPath(projectDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
