/**
 * The SQL editor's saved queries, in `.flutterdeck/queries.json` (design note, Data).
 * The file can come with a cloned repository, so it is read without following a link
 * and replaced by a fresh file renamed into place, never written through one. Saved
 * queries run through the read-only gate like any other query.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SavedQueriesState, SavedQuery } from '@project-deck/core';
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

const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex');

const stale = (): DbError =>
  new DbError('conflict', 'The saved queries changed since you read them.');

export class SavedQueryStore {
  /** Saves run one at a time, so a revision check and its write can't interleave. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectDir: string) {}

  /** The file's text, or undefined when there is none. Never through a link. */
  private async text(): Promise<string | undefined> {
    try {
      await checkStateDir(this.projectDir);
      return await readRegularFile(this.path(), { maxBytes: MAX_FILE_BYTES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw broken();
    }
  }

  private parse(text: string): SavedQuery[] {
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

  /** The queries and the revision a save must name (review R1). */
  async state(): Promise<SavedQueriesState> {
    const text = await this.text();
    if (text === undefined) return { queries: [], revision: 'none' };
    return { queries: this.parse(text), revision: revisionOf(text) };
  }

  /**
   * Replaces the list only if the file is still at `revision`; otherwise `conflict`, so
   * a tab that read an older list (or none) can't wipe what another tab saved. A file
   * that can't be read is never replaced.
   */
  replace(queries: SavedQuery[], revision: string): Promise<SavedQueriesState> {
    const run = this.turn.then(async () => {
      let current: string;
      try {
        const text = await this.text();
        if (text !== undefined) this.parse(text);
        current = text === undefined ? 'none' : revisionOf(text);
      } catch {
        throw stale();
      }
      if (current !== revision) throw stale();
      return { queries, revision: revisionOf(await this.write(queries)) };
    });
    this.turn = run.catch(() => undefined);
    return run;
  }

  private path(): string {
    return join(this.projectDir, STATE_DIR, QUERIES_FILE);
  }

  async read(): Promise<SavedQuery[]> {
    return (await this.state()).queries;
  }

  /** Replaces the list whatever is there; answers the text written. */
  private async write(queries: SavedQuery[]): Promise<string> {
    const path = this.path();
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const text = `${JSON.stringify({ version: 1, queries }, null, 2)}\n`;
    try {
      await checkStateDir(this.projectDir);
      await mkdir(join(this.projectDir, STATE_DIR), { recursive: true });
      // A fresh file, then a rename: a link at `path` is replaced, never followed.
      await writeFile(tmp, text, {
        flag: 'wx',
        // Owner only, like runtime.json: saved SQL can name tables and values (TAB-4).
        mode: 0o600,
      });
      await retryWhileBusy(() => rename(tmp, path));
      return text;
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new DbError('internal', "Couldn't save queries.");
    }
  }
}
