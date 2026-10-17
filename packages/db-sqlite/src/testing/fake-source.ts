import { DbError } from '@project-deck/core';
import type { SnapshotSource } from '../source.js';
import { isSnapshotName } from '../source.js';

/**
 * In-memory device files for tests and the daemon's fake mode. `afterRead` runs after
 * every whole-file read, so a test can change a file mid-copy like a writing app.
 */
export class FakeSnapshotSource implements SnapshotSource {
  readonly label = 'fake device';
  readonly reads: string[] = [];
  afterRead: ((path: string) => void) | undefined;

  constructor(readonly files: Record<string, Buffer>) {}

  list(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.files).filter(isSnapshotName).sort());
  }

  head(path: string, bytes: number): Promise<Buffer | undefined> {
    return Promise.resolve(this.files[path]?.subarray(0, bytes));
  }

  read(path: string, maxBytes: number): Promise<Buffer | undefined> {
    const file = this.files[path];
    if (file === undefined) return Promise.resolve(undefined);
    if (file.length > maxBytes) {
      return Promise.reject(
        new DbError('too-large', 'The database is over 50 MB, too large to copy.'),
      );
    }
    this.reads.push(path);
    const copy = Buffer.from(file);
    this.afterRead?.(path);
    return Promise.resolve(copy);
  }
}
