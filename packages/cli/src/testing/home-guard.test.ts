import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedEntries, snapshotDir } from './home-guard.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-guard-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('home guard', () => {
  it('sees no change when nothing was written', async () => {
    await writeFile(join(dir, 'ports.json'), '{}');
    expect(changedEntries(snapshotDir(dir), snapshotDir(dir))).toEqual([]);
  });

  it('names a file that was created or changed', async () => {
    const before = snapshotDir(join(dir, 'missing'));
    expect(before.size).toBe(0);
    await writeFile(join(dir, 'a.json'), '{}');
    const middle = snapshotDir(dir);
    expect(changedEntries(before, middle)).toEqual(['a.json']);
    await writeFile(join(dir, 'a.json'), '{"x":1}');
    expect(changedEntries(middle, snapshotDir(dir))).toEqual(['a.json']);
  });
});
