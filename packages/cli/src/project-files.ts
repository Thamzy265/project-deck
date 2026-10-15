/**
 * The files `init` writes in the user's project: `.flutterdeck/config.json`, `.gitignore`
 * and `.claude/launch.json`. A cloned repository may have planted a link at any of them
 * (or at `.claude`) that points at one of the user's own files, so a link is refused
 * with a message, never followed (docs/notes/untrusted-project-files.md). Writes go to a
 * new temp file that is renamed into place: a link that appears in between is replaced,
 * not written through, and readers never see half a file.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { NotRegularFileError, readRegularFile, retryWhileBusy } from '@project-deck/core/node';

/** Far more than any real .gitignore or launch.json. */
const MAX_FILE_BYTES = 1_048_576;

/** A file or folder `init` won't touch. The message names it by its project path only. */
export class UnsafeFileError extends Error {}

export type FileState = { kind: 'missing' } | { kind: 'file'; text: string; mode: number };

function linkRefused(shown: string): UnsafeFileError {
  return new UnsafeFileError(
    `${shown} is a link. FlutterDeck doesn't follow links in a project; replace it with a regular file or folder, then run init again. Nothing was changed.`,
  );
}

/** A regular file's text and mode, or missing. Refuses a link, a folder or a huge file. */
export async function inspectFile(path: string, shown: string): Promise<FileState> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (info.isSymbolicLink()) throw linkRefused(shown);
  if (!info.isFile()) {
    throw new UnsafeFileError(`${shown} is a folder or a special file, not a regular file.`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new UnsafeFileError(
      `${shown} is larger than ${MAX_FILE_BYTES} bytes; init left it alone.`,
    );
  }
  try {
    // Never through a link, even one that appeared since the lstat.
    const text = await readRegularFile(path, { maxBytes: MAX_FILE_BYTES });
    return { kind: 'file', text, mode: info.mode & 0o777 };
  } catch (err) {
    if (err instanceof NotRegularFileError) throw linkRefused(shown);
    throw err;
  }
}

/** A folder `init` may create files in: missing or real. Refuses a link or a file. */
export async function inspectDir(path: string, shown: string): Promise<'missing' | 'dir'> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
  if (info.isSymbolicLink()) throw linkRefused(shown);
  if (!info.isDirectory()) throw new UnsafeFileError(`${shown} is a file, not a folder.`);
  return 'dir';
}

/** Writes `text` whole: a fresh temp file next to `path`, renamed over it. */
export async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' });
    // The umask may have narrowed the mode; an existing file keeps the one it had.
    await chmod(tmp, mode);
    // Windows refuses while another program reads the old file; that takes a moment only.
    await retryWhileBusy(() => rename(tmp, path));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
