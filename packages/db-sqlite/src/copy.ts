import { DbError, isDbError } from '@project-deck/core';
import type { SnapshotSource } from './source.js';
import { changeCounter, checkHeader, isHotJournal, mergeWal, walSalts } from './wal.js';

/** Copies before giving up on an app that keeps writing (design review D4). */
export const COPY_ATTEMPTS = 3;
/** Database plus WAL (design note: 50 MB). */
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

const busy = (): DbError => new DbError('busy', 'The app is writing; try Refresh.');
const tooLarge = (): DbError =>
  new DbError(
    'too-large',
    'The database is over 50 MB, too large to copy. Add flutterdeck_drift to read it live.',
  );

/**
 * Copies one database and its WAL so that they belong together, and returns the merged
 * image. A copy counts only when the header's change counter (offset 24) and the WAL's
 * salts are the same before and after it, and no rollback journal says a write is in
 * progress; otherwise it is tried again, up to three times, then "The app is writing;
 * try Refresh" (design review D4). Nothing partial is ever returned.
 */
export async function copyDatabase(
  source: SnapshotSource,
  name: string,
  maxBytes: number = MAX_SNAPSHOT_BYTES,
): Promise<Buffer> {
  const walPath = `${name}-wal`;
  const journalPath = `${name}-journal`;
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt++) {
    if (isHotJournal(await source.head(journalPath, 28))) continue;
    const before = await source.head(name, 100);
    if (before === undefined) throw new DbError('not-found', 'The database file is gone.');
    checkHeader(before);
    const walBefore = walSalts(await source.head(walPath, 32));
    const db = await read(source, name, maxBytes);
    if (db === undefined) throw new DbError('not-found', 'The database file is gone.');
    const wal = walBefore === '' ? undefined : await read(source, walPath, maxBytes - db.length);
    const after = await source.head(name, 100);
    const walAfter = walSalts(await source.head(walPath, 32));
    const counter = changeCounter(before);
    const consistent =
      counter !== undefined &&
      changeCounter(db) === counter &&
      changeCounter(after) === counter &&
      walSalts(wal) === walBefore &&
      walAfter === walBefore;
    if (!consistent) continue;
    try {
      return mergeWal(db, wal, maxBytes);
    } catch (err) {
      // A page size that changed mid-copy or a file cut mid-page: copy again.
      if (isDbError(err) && err.code === 'busy') continue;
      if (isDbError(err) && err.code === 'too-large') throw tooLarge();
      throw err;
    }
  }
  throw busy();
}

async function read(
  source: SnapshotSource,
  path: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (maxBytes <= 0) throw tooLarge();
  try {
    return await source.read(path, maxBytes);
  } catch (err) {
    if (isDbError(err) && err.code === 'too-large') throw tooLarge();
    throw err;
  }
}
