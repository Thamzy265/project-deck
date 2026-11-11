/**
 * daemonMainPath's two places (M5 batch 2): `daemon.js` next to the code in the npm bundle,
 * else the daemon package's `./main` export. Only the code's own URL decides: never the
 * current folder, which is the user's project.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonMainPath } from './spawn.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(files: Record<string, string>, prefix = 'deck-spawn-bundle-'): Promise<string> {
  // realpath: macOS's tmpdir is a symlink, and createRequire returns real paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

/** A workspace-style `@project-deck/daemon` with the `./main` export, resolvable from `dir`. */
const WORKSPACE_DAEMON = {
  'node_modules/@project-deck/daemon/package.json': JSON.stringify({
    name: '@project-deck/daemon',
    exports: { './main': './dist/main.js' },
  }),
  'node_modules/@project-deck/daemon/dist/main.js': '',
};

const codeIn = (dir: string) => pathToFileURL(join(dir, 'pkg', 'dist', 'chunk-ABC.js'));

describe('daemonMainPath in the bundle layout', () => {
  it('takes the bundled daemon.js when the workspace package exists too', async () => {
    const dir = await tree({ 'pkg/dist/daemon.js': '', ...WORKSPACE_DAEMON });
    expect(daemonMainPath(codeIn(dir))).toBe(join(dir, 'pkg', 'dist', 'daemon.js'));
  });

  it('falls back to the daemon package when daemon.js is missing', async () => {
    const dir = await tree(WORKSPACE_DAEMON);
    expect(daemonMainPath(codeIn(dir))).toBe(
      join(dir, 'node_modules', '@project-deck', 'daemon', 'dist', 'main.js'),
    );
  });

  it('never takes daemon.js from the current folder (the user project)', async () => {
    const code = await tree({ 'pkg/dist/chunk-ABC.js': '' });
    const project = await tree({ 'daemon.js': 'evil', 'dist/daemon.js': 'evil' });
    const before = process.cwd();
    process.chdir(project);
    try {
      // Without a bundled daemon.js it may still resolve a workspace package (vitest's
      // NODE_PATH reaches this repo's), but never a file in the project's folder.
      let found: string | undefined;
      try {
        found = daemonMainPath(codeIn(code));
      } catch {
        found = undefined;
      }
      expect(found?.startsWith(project)).not.toBe(true);
    } finally {
      process.chdir(before);
    }
  });

  it('decodes a code URL whose path holds spaces, # and % (Windows profiles)', async () => {
    const dir = await tree({ 'pkg/dist/daemon.js': '' }, 'deck spawn #1 %41 ');
    expect(daemonMainPath(codeIn(dir))).toBe(join(dir, 'pkg', 'dist', 'daemon.js'));
    expect(daemonMainPath(codeIn(dir).href)).toBe(join(dir, 'pkg', 'dist', 'daemon.js'));
  });
});
