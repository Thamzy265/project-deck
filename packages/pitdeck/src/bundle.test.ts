import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const run = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

const Meta = z.object({ inputs: z.record(z.string(), z.unknown()) });

describe('the bundled CLI (run pnpm build first)', () => {
  it('prints its usage', () => {
    expect(run('--help')).toMatch(/^Usage: pitdeck <command>/);
  });

  it('prints the package version', () => {
    const { version } = z
      .object({ version: z.string() })
      .parse(JSON.parse(readFileSync(`${PKG_DIR}/package.json`, 'utf8')));
    expect(run('--version').trim()).toBe(version);
  });

  it('bundles no test or QA helpers', () => {
    // Written by build.mjs next to the package, never published.
    const meta = Meta.parse(JSON.parse(readFileSync(`${PKG_DIR}/build-meta.json`, 'utf8')));
    const inputs = Object.keys(meta.inputs).map((p) => p.replaceAll('\\', '/'));
    expect(inputs.length).toBeGreaterThan(0);
    expect(
      inputs.filter((p) => /qa-client|testing\/fake-daemon|\.test\.|\/src\/.*\.tsx?$/.test(p)),
    ).toEqual([]);
  });
});
