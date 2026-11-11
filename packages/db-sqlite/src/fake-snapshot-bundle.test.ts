/**
 * The daemon's fake mode in a bundle missing a fixture file (finding F7): the snapshot
 * factory fails when it is made, at daemon start, with the incomplete-bundle message,
 * instead of every query on that database answering "not found".
 */
import { IncompleteBundleError } from '@project-deck/core/node';
import { describe, expect, it, vi } from 'vitest';
import type * as Fixtures from './testing/fixtures.js';
import { fakeSnapshotFactory } from './testing/index.js';

const MISSING = new IncompleteBundleError('/bundle/dist/fixtures/plain.sqlite');

vi.mock('./testing/fixtures.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Fixtures>()),
  plainDbFixture: () => {
    throw MISSING;
  },
}));

describe('fakeSnapshotFactory with a fixture file missing from the bundle', () => {
  it('fails at once with the incomplete-bundle error', () => {
    expect(() => fakeSnapshotFactory()).toThrow(MISSING);
  });
});
