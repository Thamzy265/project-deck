import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixturePath } from './testing/fixtures.js';

describe('fixturePath', () => {
  it('reads the fixtures from the source folder in the workspace', () => {
    const path = fixturePath('snap.sqlite');
    expect(path.endsWith(['src', 'testing', 'fixtures', 'snap.sqlite'].join(sep))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('prefers a fixtures folder next to the code, as in the npm bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-fixtures-'));
    try {
      await mkdir(join(dir, 'fixtures'));
      await writeFile(join(dir, 'fixtures', 'snap.sqlite'), '');
      expect(fixturePath('snap.sqlite', pathToFileURL(join(dir, 'chunk-abc.js')))).toBe(
        join(dir, 'fixtures', 'snap.sqlite'),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
