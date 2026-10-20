/**
 * The files `init` writes in the user's project: `.flutterdeck/config.json`, `.gitignore`
 * and `.claude/launch.json`. A cloned repository may have planted a link at any of them
 * (or at `.claude`) that points at one of the user's own files, so a link is refused
 * with a message, never followed (docs/notes/untrusted-project-files.md). Writes go to a
 * new temp file (in `.flutterdeck/` for init) that is renamed into place: a link that appears in between is replaced,
 * not written through, and readers never see half a file.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
export async function readProjectFile(
  path: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<ProjectFile> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (info.isSymbolicLink()) return { kind: 'link' };
  if (!info.isFile()) return { kind: 'not-file' };
  if (info.size > maxBytes) return { kind: 'too-large' };
  try {
    // Never through a link, even one that appeared since the lstat.
    const text = await readRegularFile(path, { maxBytes });
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

export interface WriteAtomicOptions {
  /**
   * Where the temp file goes. init passes `.flutterdeck`, whose `*.tmp` files are
   * git-ignored, so a crash never leaves a stray temp file git would pick up next to
   * `.gitignore` or `launch.json`. Defaults to the target's own folder, which is also
   * tried once when the rename from `tmpDir` fails with EXDEV (another mount).
   */
  tmpDir?: string;
  /** Test seam: the rename that puts the file in place. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Writes `text` whole: a fresh temp file, renamed over `path`. `mode` is the target's
 * own mode when it exists, so a read-only file the user made stays read-only (the
 * rename needs only the folder to be writable, which init checks first).
 */
export async function writeAtomic(
  path: string,
  text: string,
  mode: number,
  opts: WriteAtomicOptions = {},
): Promise<void> {
  const move = opts.rename ?? rename;
  const tmpDir = opts.tmpDir ?? dirname(path);
  try {
    await writeVia(tmpDir, path, text, mode, move);
  } catch (err) {
    // `.flutterdeck` may be a mount of its own (a bind mount, a synced folder). A rename
    // can't cross mounts, so try once more with the temp file next to the target.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV' || tmpDir === dirname(path)) throw err;
    await writeVia(dirname(path), path, text, mode, move);
  }
}

async function writeVia(
  tmpDir: string,
  path: string,
  text: string,
  mode: number,
  move: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const tmp = join(tmpDir, `${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' });
    // The umask may have narrowed the mode.
    await chmod(tmp, mode);
    // Windows refuses while another program reads the old file; that takes a moment only.
    await retryWhileBusy(() => move(tmp, path));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
