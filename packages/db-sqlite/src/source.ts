/**
 * Where snapshot copies come from: an Android app's private folder (adb run-as) or an
 * iOS simulator app's container. Paths are `<folder>/<file>`, with the folder from a
 * fixed list and the file name checked against the design note's pattern.
 */

/** Database file names (design review S7): no leading dot or dash, .sqlite or .db. */
export const SNAPSHOT_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.(sqlite|db)$/;

/** Android: drift_flutter's documents folder first (`app_flutter/`), then `databases/`. */
export const ANDROID_FOLDERS = ['app_flutter', 'databases'] as const;
/** iOS: path_provider's documents folder, then Application Support. */
export const IOS_FOLDERS = ['Documents', 'Library/Application Support'] as const;
const FOLDERS: readonly string[] = [...ANDROID_FOLDERS, ...IOS_FOLDERS];

/** Companion files a database can have next to it. */
export const COMPANIONS = ['-wal', '-journal'] as const;

/** A database name a source may serve: a fixed folder, then a checked file name. */
export function isSnapshotName(name: string): boolean {
  const slash = name.lastIndexOf('/');
  if (slash === -1 || name.length > 300) return false;
  return FOLDERS.includes(name.slice(0, slash)) && SNAPSHOT_FILE.test(name.slice(slash + 1));
}

export interface SnapshotSource {
  /** For messages, e.g. "Android emulator-5554". */
  readonly label: string;
  /** Database names (`<folder>/<file>`) found in the app's folders. */
  list(): Promise<string[]>;
  /** The first `bytes` bytes of a file, or undefined when it doesn't exist. */
  head(path: string, bytes: number): Promise<Buffer | undefined>;
  /**
   * The whole file, or undefined when it doesn't exist. Rejects with a `too-large`
   * DbError past `maxBytes` (without reading on).
   */
  read(path: string, maxBytes: number): Promise<Buffer | undefined>;
}
