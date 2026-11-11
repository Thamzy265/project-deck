/**
 * defaultDashboardDir's two places (M5 batch 2): `dashboard/` next to the code in the npm
 * bundle, else, in the workspace build only, the workspace package. In the bundle a missing
 * `dashboard/index.html` is an error: users don't own the `@project-deck` scope, so a
 * look-alike package up the tree must never be served (finding O1). The lookup must depend only on the code's own URL:
 * never on the current folder, which is the user's project.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IncompleteBundleError } from '@project-deck/core/node';
import { defaultDashboardDir } from './dashboard-assets.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(files: Record<string, string>, prefix = 'deck-dash-bundle-'): Promise<string> {
  // realpath: macOS's tmpdir is a symlink, and createRequire returns real paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

/** A workspace-style `@project-deck/dashboard` that createRequire can resolve from `dir`. */
const WORKSPACE_DASHBOARD = {
  'node_modules/@project-deck/dashboard/package.json': JSON.stringify({
    name: '@project-deck/dashboard',
    exports: { './package.json': './package.json' },
  }),
  'node_modules/@project-deck/dashboard/dist/index.html': '<!doctype html>workspace',
};

const codeIn = (dir: string) => pathToFileURL(join(dir, 'pkg', 'dist', 'chunk-ABC.js'));

describe('defaultDashboardDir in the bundle layout', () => {
  it('takes the bundled folder when the workspace package exists too', async () => {
    const dir = await tree({
      'pkg/dist/dashboard/index.html': '<!doctype html>bundle',
      ...WORKSPACE_DASHBOARD,
    });
    expect(defaultDashboardDir(codeIn(dir), true)).toBe(join(dir, 'pkg', 'dist', 'dashboard'));
    expect(defaultDashboardDir(codeIn(dir), false)).toBe(join(dir, 'pkg', 'dist', 'dashboard'));
  });

  it('in the workspace build, falls back to the workspace package when the bundled folder is empty', async () => {
    const dir = await tree(WORKSPACE_DASHBOARD);
    await mkdir(join(dir, 'pkg', 'dist', 'dashboard'), { recursive: true });
    expect(defaultDashboardDir(codeIn(dir), false)).toBe(
      join(dir, 'node_modules', '@project-deck', 'dashboard', 'dist'),
    );
  });

  // Was "falls back to the workspace package" for both builds: finding O1 makes it an
  // error in the bundle.
  it('in the bundle, refuses a look-alike dashboard package when index.html is missing', async () => {
    const dir = await tree(WORKSPACE_DASHBOARD);
    await mkdir(join(dir, 'pkg', 'dist', 'dashboard'), { recursive: true });
    expect(() => defaultDashboardDir(codeIn(dir), true)).toThrow(IncompleteBundleError);
    expect(() => defaultDashboardDir(codeIn(dir), true)).toThrow(
      `The pitdeck package is incomplete: ${join(dir, 'pkg', 'dist', 'dashboard', 'index.html')} is missing`,
    );
  });

  it('never takes a dashboard folder from the current folder (the user project)', async () => {
    const code = await tree({ 'pkg/dist/chunk-ABC.js': '' });
    const project = await tree({
      'dashboard/index.html': 'evil',
      'dist/dashboard/index.html': 'evil',
    });
    const before = process.cwd();
    process.chdir(project);
    try {
      expect(() => defaultDashboardDir(codeIn(code), true)).toThrow(IncompleteBundleError);
      // The workspace build may still find a workspace package (vitest's NODE_PATH reaches
      // this repo's), but never the project's folder.
      expect(defaultDashboardDir(codeIn(code), false)?.startsWith(project)).not.toBe(true);
    } finally {
      process.chdir(before);
    }
  });

  it('decodes a code URL whose path holds spaces, # and % (Windows profiles)', async () => {
    const dir = await tree(
      { 'pkg/dist/dashboard/index.html': '<!doctype html>' },
      'deck dash #1 %41 ',
    );
    expect(defaultDashboardDir(codeIn(dir), true)).toBe(join(dir, 'pkg', 'dist', 'dashboard'));
    expect(defaultDashboardDir(codeIn(dir).href, true)).toBe(join(dir, 'pkg', 'dist', 'dashboard'));
  });
});
