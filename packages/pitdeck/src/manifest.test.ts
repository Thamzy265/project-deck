import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const Manifest = z.object({
  name: z.string(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  license: z.string().optional(),
  type: z.string().optional(),
  bin: z.record(z.string(), z.string()).optional(),
  files: z.array(z.string()).optional(),
  engines: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

const manifest = (dir: string) =>
  Manifest.parse(JSON.parse(readFileSync(`${ROOT}${dir}/package.json`, 'utf8')));

describe('the pitdeck package manifest', () => {
  const pkg = manifest('packages/pitdeck');

  it('publishes one unscoped package with the pitdeck command (ADR 0006)', () => {
    expect(pkg).toMatchObject({
      name: 'pitdeck',
      version: '0.1.0',
      license: 'MIT',
      type: 'module',
      bin: { pitdeck: 'dist/cli.js' },
      files: ['dist'],
      engines: { node: '>=22.12.0' },
    });
    expect(pkg.private).toBeUndefined();
  });

  it('installs nothing else and runs no install scripts', () => {
    // Everything is bundled, so `npm install --ignore-scripts` has nothing to fetch.
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];
    expect(Object.keys(pkg.scripts ?? {}).filter((s) => lifecycle.includes(s))).toEqual([]);
  });

  it('ships the same licence as the repository', () => {
    expect(readFileSync(`${ROOT}packages/pitdeck/LICENSE`, 'utf8')).toBe(
      readFileSync(`${ROOT}LICENSE`, 'utf8'),
    );
  });
});

describe('the workspace packages', () => {
  const dirs = readdirSync(`${ROOT}packages`).filter((d) => d !== 'pitdeck');

  it('are all private, so only pitdeck can be published (ADR 0006)', () => {
    expect(dirs.length).toBeGreaterThan(5);
    const publishable = dirs
      .map((d) => manifest(`packages/${d}`))
      .filter((m) => m.private !== true)
      .map((m) => m.name);
    expect(publishable).toEqual([]);
  });
});
