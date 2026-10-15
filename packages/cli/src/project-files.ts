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

/** Far more than any real pubspec.yaml, .gitignore or launch.json. */
export const MAX_FILE_BYTES = 1_048_576;

/** A file or folder `init` won't touch. The message names it by its project path only. */
export class UnsafeFileError extends Error {}

export type FileState = { kind: 'missing' } | { kind: 'file'; text: string; mode: number };

function linkRefused(shown: string): UnsafeFileError {
  return new UnsafeFileError(
    `${shown} is a link. FlutterDeck doesn't follow links in a project; replace it with a regular file or folder, then run init again. Nothing was changed.`,
  );
}

/** What a project path holds, read without ever following a link. */
export type ProjectFile =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'not-file' }
  | { kind: 'too-large' }
  | { kind: 'file'; text: string; mode: number };

/**
 * Reads a small regular file in the project: lstat first, then readRegularFile
 * (O_NOFOLLOW, or lstat on Windows), so a link is reported, never followed.
 */
export async function readProjectFile(path: string): Promise<ProjectFile> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (info.isSymbolicLink()) return { kind: 'link' };
  if (!info.isFile()) return { kind: 'not-file' };
  if (info.size > MAX_FILE_BYTES) return { kind: 'too-large' };
  try {
    // Never through a link, even one that appeared since the lstat.
    const text = await readRegularFile(path, { maxBytes: MAX_FILE_BYTES });
    return { kind: 'file', text, mode: info.mode & 0o777 };
  } catch (err) {
    if (err instanceof NotRegularFileError) return { kind: 'link' };
    throw err;
  }
}

/** A regular file's text and mode, or missing. Refuses a link, a folder or a huge file. */
export async function inspectFile(path: string, shown: string): Promise<FileState> {
  const found = await readProjectFile(path);
  switch (found.kind) {
    case 'missing':
    case 'file':
      return found;
    case 'link':
      throw linkRefused(shown);
    case 'not-file':
      throw new UnsafeFileError(`${shown} is a folder or a special file, not a regular file.`);
    case 'too-large':
      throw new UnsafeFileError(
        `${shown} is larger than ${MAX_FILE_BYTES} bytes; init left it alone.`,
      );
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
