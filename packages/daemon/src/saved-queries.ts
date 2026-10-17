/**
 * The SQL editor's saved queries, in `.flutterdeck/queries.json` (design note, Data).
 * The file can come with a cloned repository, so it is read without following a link
 * and replaced by a fresh file renamed into place, never written through one. Saved
 * queries run through the read-only gate like any other query.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SavedQuery } from '@project-deck/core';
import { DbError, SavedQueriesSchema } from '@project-deck/core';
import { STATE_DIR, checkStateDir, readRegularFile, retryWhileBusy } from '@project-deck/core/node';
import { z } from 'zod';

export const QUERIES_FILE = 'queries.json';
/** 200 queries of a few kB each fit many times over. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const FileSchema = SavedQueriesSchema.extend({ version: z.literal(1) });

const broken = (): DbError =>
  new DbError(
    'internal',
    `Couldn't read saved queries: ${STATE_DIR}/${QUERIES_FILE} is not valid.`,
  );

export class SavedQueryStore {
  constructor(private readonly projectDir: string) {}

  private path(): string {
    return join(this.projectDir, STATE_DIR, QUERIES_FILE);
  }

  async read(): Promise<SavedQuery[]> {
    let text: string;
    try {
      await checkStateDir(this.projectDir);
      text = await readRegularFile(this.path(), { maxBytes: MAX_FILE_BYTES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw broken();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw broken();
    }
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) throw broken();
    return parsed.data.queries;
  }

  async write(queries: SavedQuery[]): Promise<void> {
    const path = this.path();
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await checkStateDir(this.projectDir);
      await mkdir(join(this.projectDir, STATE_DIR), { recursive: true });
      // A fresh file, then a rename: a link at `path` is replaced, never followed.
      await writeFile(tmp, `${JSON.stringify({ version: 1, queries }, null, 2)}\n`, {
        flag: 'wx',
        // Owner only, like runtime.json: saved SQL can name tables and values (TAB-4).
        mode: 0o600,
      });
      await retryWhileBusy(() => rename(tmp, path));
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new DbError('internal', "Couldn't save queries.");
    }
  }
}
