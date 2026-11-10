import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where a fixture file is: a `fixtures/` folder next to this code (the `pitdeck` npm
 * bundle copies them there for the daemon's fake mode), else the source folder, so they
 * work from `src` (tests) and `dist` alike. `here` is a test seam for this file's URL.
 */
export function fixturePath(name: string, here: URL | string = import.meta.url): string {
  const bundled = fileURLToPath(new URL(`fixtures/${name}`, here));
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL(`../../src/testing/fixtures/${name}`, here));
}

/**
 * Real database files made by the system sqlite3 with `fixtures/make-fixtures.sql`:
 * a WAL database copied while its connection was open (the base rows in the main
 * file, two more commits in the WAL), and a plain rollback-journal database.
 */
function fixture(name: string): Buffer {
  return readFileSync(fixturePath(name));
}

/** Main file of the WAL database: orders 1 Coffee pending, 2 Tea pending. */
export const walDbFixture = (): Buffer => fixture('snap.sqlite');
/** Its WAL: inserts 3 Cake and ships order 1, in two commits (5 frames, 1 KB pages). */
export const walFixture = (): Buffer => fixture('snap.sqlite-wal');
/** A rollback-journal database: orders 1 Coffee, 2 Tea. */
export const plainDbFixture = (): Buffer => fixture('plain.sqlite');
