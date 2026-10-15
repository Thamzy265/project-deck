/**
 * Files under a project's `.flutterdeck/` come with the repository, so a cloned repo can
 * plant a symlink there that points at one of the user's own files. FlutterDeck never
 * follows one: reads refuse anything but a regular file, and writes create new files
 * exclusively (see the writers). Windows has no O_NOFOLLOW, so there an lstat check
 * comes first; the small race left is accepted there.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const STATE_DIR = '.flutterdeck';

/** Thrown for a symlink, a folder or anything else that isn't a plain file. */
export class NotRegularFileError extends Error {
  readonly code = 'ENOTREG';
  constructor(readonly path: string) {
    super(`${path} is not a regular file`);
  }
}

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

export interface ReadRegularOptions {
  /** Read at most this many bytes. */
  maxBytes?: number;
  /** With maxBytes: keep the end of the file rather than the start (for logs). */
  tail?: boolean;
}

/**
 * Reads a plain file as UTF-8 without following a symlink at `path`. Rejects with
 * NotRegularFileError for anything else, or with the usual fs error (ENOENT, …).
 */
export async function readRegularFile(
  path: string,
  opts: ReadRegularOptions = {},
): Promise<string> {
  if (NOFOLLOW === undefined && !(await lstat(path)).isFile()) {
    throw new NotRegularFileError(path);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (NOFOLLOW ?? 0));
  } catch (err) {
    // O_NOFOLLOW on a symlink fails with ELOOP (EMLINK on some BSDs).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new NotRegularFileError(path);
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new NotRegularFileError(path);
    const max = opts.maxBytes ?? stat.size;
    const length = Math.min(stat.size, max);
    const position = opts.tail === true ? stat.size - length : 0;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** A `.flutterdeck` that exists but is a symlink (or a file) in a cloned repository. */
export class StateDirError extends Error {}

/**
 * Checks the project's `.flutterdeck`: missing or a real folder is fine. A symlink would
 * send every read and write to wherever it points, so it is refused.
 */
export async function checkStateDir(projectDir: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(join(projectDir, STATE_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StateDirError(
      `${STATE_DIR} in this project is not a real folder (it is a link or a file). FlutterDeck doesn't follow links there: replace it with a folder.`,
    );
  }
}
