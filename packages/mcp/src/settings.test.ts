import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMaskSettings } from './settings.js';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-settings-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('readMaskSettings warnings', () => {
  it('joins a reason that ends in a full stop with one full stop (C5)', async () => {
    await mkdir(join(projectDir, '.flutterdeck'));
    await writeFile(join(projectDir, '.flutterdeck', 'config.json'), 'not json');
    const { mask, warnings } = await readMaskSettings(projectDir);
    expect(mask).toEqual({ redact: true, rules: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/JSON\. Masking uses the built-in patterns only/);
    expect(warnings[0]).not.toContain('..');
  });

  it('joins the "not a real folder" reason with one full stop (C5)', async () => {
    await writeFile(join(projectDir, '.flutterdeck'), 'a file, not a folder');
    const { warnings } = await readMaskSettings(projectDir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/folder\. Masking uses the built-in patterns only/);
    expect(warnings[0]).not.toContain('..');
  });
});
