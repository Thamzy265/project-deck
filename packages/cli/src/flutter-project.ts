/**
 * Is this folder a Flutter app? `pubspec.yaml` with `flutter` under `dependencies`.
 * A line-based check of the top two levels, not a YAML parser: enough to tell a Flutter
 * app from a Dart package, and nothing from the file is repeated except a checked name.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { NotRegularFileError, readRegularFile } from '@project-deck/core/node';

const MAX_FILE_BYTES = 1_048_576;
/** Dart package names: lower-case letters, digits and underscores. */
const PACKAGE_NAME = /^name:\s*["']?([a-z_][a-z0-9_]*)["']?\s*(#.*)?$/m;
/** An Android application id: dotted segments of letters, digits and underscores. */
const APPLICATION_ID =
  /^\s*applicationId\s*=?\s*["']([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)["']\s*$/m;

export type Detection = { ok: true; name?: string } | { ok: false; reason: string };

type SmallFile =
  { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'too-large' } | { kind: 'link' };

/**
 * A small text file's contents, never through a link: a cloned repository could link
 * pubspec.yaml to one of the user's own files (docs/notes/untrusted-project-files.md).
 * A folder or other non-file counts as missing.
 */
async function readSmall(path: string): Promise<SmallFile> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { kind: 'missing' };
  }
  if (info.isSymbolicLink()) return { kind: 'link' };
  if (!info.isFile()) return { kind: 'missing' };
  if (info.size > MAX_FILE_BYTES) return { kind: 'too-large' };
  try {
    return { kind: 'text', text: await readRegularFile(path, { maxBytes: MAX_FILE_BYTES }) };
  } catch (err) {
    // A link that appeared since the lstat.
    return err instanceof NotRegularFileError ? { kind: 'link' } : { kind: 'missing' };
  }
}

export function hasFlutterDependency(pubspec: string): boolean {
  let inDependencies = false;
  let childIndent: number | undefined;
  for (const raw of pubspec.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inDependencies = /^dependencies:\s*$/.test(line);
      childIndent = undefined;
      continue;
    }
    if (!inDependencies) continue;
    childIndent ??= indent;
    if (indent === childIndent && /^\s*flutter:/.test(line)) return true;
  }
  return false;
}

export async function detectFlutterProject(projectDir: string): Promise<Detection> {
  const file = await readSmall(join(projectDir, 'pubspec.yaml'));
  if (file.kind === 'too-large') {
    return {
      ok: false,
      reason: `pubspec.yaml is too large to read (over ${MAX_FILE_BYTES} bytes).`,
    };
  }
  if (file.kind === 'link') {
    return {
      ok: false,
      reason:
        "pubspec.yaml is a link. FlutterDeck doesn't follow links in a project; run init where the real file is.",
    };
  }
  if (file.kind === 'missing') {
    return {
      ok: false,
      reason: `No pubspec.yaml in ${projectDir}. Run init in a Flutter app's folder, or pass --project <folder>.`,
    };
  }
  const pubspec = file.text;
  if (!hasFlutterDependency(pubspec)) {
    return {
      ok: false,
      reason: `pubspec.yaml in ${projectDir} has no flutter dependency. FlutterDeck works with Flutter apps.`,
    };
  }
  const name = PACKAGE_NAME.exec(pubspec)?.[1];
  return name === undefined ? { ok: true } : { ok: true, name };
}

/** The Android applicationId when it is a plain literal; undefined otherwise. */
export async function readApplicationId(projectDir: string): Promise<string | undefined> {
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    const found = await readSmall(join(projectDir, 'android', 'app', file));
    if (found.kind !== 'text') continue;
    return APPLICATION_ID.exec(found.text)?.[1];
  }
  return undefined;
}
