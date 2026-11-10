import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Every path the published tarball may hold. Anything else fails the test. */
const ALLOWED: readonly RegExp[] = [
  /^package\.json$/,
  /^LICENSE$/,
  // Entry points: the CLI (bin), the daemon it starts, and the two worker threads.
  /^dist\/(cli|daemon|guard-worker|snapshot-worker)\.js$/,
  // Code shared between the entry points.
  /^dist\/chunk-[A-Z0-9]+\.js$/,
  /^dist\/sqlite3\.wasm$/,
  /^dist\/licenses\.md$/,
  // The daemon's fake mode reads these (`--fake`, used by the smoke test).
  /^dist\/fixtures\/(snap\.sqlite|snap\.sqlite-wal|plain\.sqlite)$/,
  /^dist\/dashboard\/(index\.html|licenses\.md)$/,
  /^dist\/dashboard\/assets\/[\w-]+\.(js|css)$/,
];

/** The agreed cap (lead, M5 batch 2): the design estimates 4–5 MB unpacked. */
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

const PackResult = z.array(
  z.object({
    filename: z.string(),
    size: z.number(),
    unpackedSize: z.number(),
    files: z.array(z.object({ path: z.string() })),
  }),
);

function dryRunPack() {
  // A fixed command with fixed arguments. On Windows npm is npm.cmd, which Node runs only
  // through cmd.exe.
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const [command, argv] =
    process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'npm', ...args]] : ['npm', args];
  const out = execFileSync(command, argv, {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const [result] = PackResult.parse(JSON.parse(out));
  if (result === undefined) throw new Error('npm pack printed no result');
  return result;
}

describe('the pitdeck tarball (run pnpm build first)', () => {
  const pack = dryRunPack();
  const paths = pack.files.map((f) => f.path.replaceAll('\\', '/'));

  it('is named pitdeck-0.1.0.tgz', () => {
    expect(pack.filename).toBe('pitdeck-0.1.0.tgz');
  });

  it('holds only allowlisted files', () => {
    expect(paths.filter((p) => !ALLOWED.some((re) => re.test(p)))).toEqual([]);
  });

  it('holds every file the package needs at run time', () => {
    for (const path of [
      'dist/cli.js',
      'dist/daemon.js',
      'dist/guard-worker.js',
      'dist/snapshot-worker.js',
      'dist/sqlite3.wasm',
      'dist/licenses.md',
      'dist/dashboard/index.html',
      'dist/dashboard/licenses.md',
      'dist/fixtures/snap.sqlite',
      'LICENSE',
    ]) {
      expect(paths).toContain(path);
    }
    // Every asset the dashboard page links to is in the tarball.
    const html = readFileSync(`${PKG_DIR}/dist/dashboard/index.html`, 'utf8');
    const linked = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    for (const asset of linked) expect(paths).toContain(`dist/dashboard/${asset ?? ''}`);
  });

  it(`stays under ${MAX_UNPACKED_BYTES / 1024 / 1024} MB unpacked`, () => {
    expect(pack.unpackedSize).toBeLessThanOrEqual(MAX_UNPACKED_BYTES);
  });
});
