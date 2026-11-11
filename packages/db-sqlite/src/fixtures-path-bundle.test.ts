/**
 * fixturePath's two places (M5 batch 2): `fixtures/` next to the code in the npm bundle
 * (the daemon's --fake mode), else, in the workspace build only, the source folder. In the
 * bundle a missing fixture is an error, never a file looked up outside the bundle
 * (finding O2). Only the code's own URL decides:
 * never the current folder, which is the user's project.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IncompleteBundleError } from '@project-deck/core/node';
import { fixturePath } from './testing/fixtures.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(
  files: Record<string, string>,
  prefix = 'deck-fixtures-bundle-',
): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

const codeIn = (dir: string) => pathToFileURL(join(dir, 'pkg', 'dist', 'chunk-ABC.js'));

describe('fixturePath in the bundle layout', () => {
  it('takes each bundled file when the source copy exists too', async () => {
    const dir = await tree({
      'pkg/dist/fixtures/snap.sqlite': 'bundle',
      'pkg/src/testing/fixtures/snap.sqlite': 'source',
    });
    for (const bundled of [true, false]) {
      expect(fixturePath('snap.sqlite', codeIn(dir), bundled)).toBe(
        join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite'),
      );
    }
  });

  it('in the workspace build, decides per file in a partial fixtures folder', async () => {
    const dir = await tree({ 'pkg/dist/fixtures/snap.sqlite': 'bundle' });
    expect(fixturePath('snap.sqlite', codeIn(dir), false)).toBe(
      join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite'),
    );
    // The missing file resolves against the code's URL, never the current folder.
    expect(fixturePath('plain.sqlite', codeIn(dir), false)).toBe(
      join(dir, 'src', 'testing', 'fixtures', 'plain.sqlite'),
    );
  });

  // Was "decides per file" for both builds: finding O2 makes a missing file an error in
  // the bundle, even when a source copy sits where the workspace fallback would look.
  it('in the bundle, refuses a missing fixture instead of the source folder', async () => {
    const dir = await tree({
      'pkg/dist/fixtures/snap.sqlite': 'bundle',
      'pkg/src/testing/fixtures/plain.sqlite': 'source',
      'src/testing/fixtures/plain.sqlite': 'source',
    });
    expect(fixturePath('snap.sqlite', codeIn(dir), true)).toBe(
      join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite'),
    );
    expect(() => fixturePath('plain.sqlite', codeIn(dir), true)).toThrow(IncompleteBundleError);
    expect(() => fixturePath('plain.sqlite', codeIn(dir), true)).toThrow(
      `The pitdeck package is incomplete: ${join(dir, 'pkg', 'dist', 'fixtures', 'plain.sqlite')} is missing`,
    );
  });

  it('never takes a fixture from the current folder (the user project)', async () => {
    const code = await tree({ 'pkg/dist/chunk-ABC.js': '' });
    const project = await tree({ 'fixtures/snap.sqlite': 'evil' });
    const before = process.cwd();
    process.chdir(project);
    try {
      expect(() => fixturePath('snap.sqlite', codeIn(code), true)).toThrow(IncompleteBundleError);
      expect(fixturePath('snap.sqlite', codeIn(code), false).startsWith(project)).toBe(false);
    } finally {
      process.chdir(before);
    }
  });

  it('decodes a code URL whose path holds spaces, # and % (Windows profiles)', async () => {
    const dir = await tree({ 'pkg/dist/fixtures/snap.sqlite': '' }, 'deck fx #1 %41 ');
    const want = join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite');
    expect(fixturePath('snap.sqlite', codeIn(dir), true)).toBe(want);
    expect(fixturePath('snap.sqlite', codeIn(dir).href, true)).toBe(want);
  });
});
