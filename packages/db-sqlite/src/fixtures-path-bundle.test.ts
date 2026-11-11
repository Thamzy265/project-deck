/**
 * fixturePath's two places (M5 batch 2): `fixtures/` next to the code in the npm bundle
 * (the daemon's --fake mode), else the source folder. Only the code's own URL decides:
 * never the current folder, which is the user's project.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(fixturePath('snap.sqlite', codeIn(dir))).toBe(
      join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite'),
    );
  });

  it('decides per file in a partial fixtures folder', async () => {
    const dir = await tree({ 'pkg/dist/fixtures/snap.sqlite': 'bundle' });
    expect(fixturePath('snap.sqlite', codeIn(dir))).toBe(
      join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite'),
    );
    // The missing file resolves against the code's URL, never the current folder.
    expect(fixturePath('plain.sqlite', codeIn(dir))).toBe(
      join(dir, 'src', 'testing', 'fixtures', 'plain.sqlite'),
    );
  });

  it('never takes a fixture from the current folder (the user project)', async () => {
    const code = await tree({ 'pkg/dist/chunk-ABC.js': '' });
    const project = await tree({ 'fixtures/snap.sqlite': 'evil' });
    const before = process.cwd();
    process.chdir(project);
    try {
      expect(fixturePath('snap.sqlite', codeIn(code)).startsWith(project)).toBe(false);
    } finally {
      process.chdir(before);
    }
  });

  it('decodes a code URL whose path holds spaces, # and % (Windows profiles)', async () => {
    const dir = await tree({ 'pkg/dist/fixtures/snap.sqlite': '' }, 'deck fx #1 %41 ');
    const want = join(dir, 'pkg', 'dist', 'fixtures', 'snap.sqlite');
    expect(fixturePath('snap.sqlite', codeIn(dir))).toBe(want);
    expect(fixturePath('snap.sqlite', codeIn(dir).href)).toBe(want);
  });
});
