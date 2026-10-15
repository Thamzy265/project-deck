/**
 * Is this folder a Flutter app? `pubspec.yaml` with `flutter` under `dependencies`.
 * Parsed with the `yaml` package (core schema, no custom tags, aliases capped against
 * "billion laughs" expansion); nothing from the file is repeated except a checked name.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { NotRegularFileError, readRegularFile } from '@project-deck/core/node';
import { parseDocument } from 'yaml';

const MAX_FILE_BYTES = 1_048_576;
/** Dart package names: lower-case letters, digits and underscores. */
const PACKAGE_NAME = /^[a-z_][a-z0-9_]*$/;
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

/** Far more than a real pubspec uses; beyond it, alias expansion is an attack. */
const MAX_ALIASES = 50;

type Pubspec = { valid: false } | { valid: true; flutter: boolean; name?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePubspec(text: string): Pubspec {
  let doc: unknown;
  try {
    // parseDocument collects errors instead of logging them (with parts of the file).
    const parsed = parseDocument(text, { schema: 'core', uniqueKeys: true });
    if (parsed.errors.length > 0) return { valid: false };
    doc = parsed.toJS({ maxAliasCount: MAX_ALIASES });
  } catch {
    // Too many aliases. The message quotes the file; it is never shown.
    return { valid: false };
  }
  if (!isRecord(doc)) return { valid: true, flutter: false };
  const deps = doc.dependencies;
  const flutter = isRecord(deps) && Object.hasOwn(deps, 'flutter');
  const name = typeof doc.name === 'string' && PACKAGE_NAME.test(doc.name) ? doc.name : undefined;
  return name === undefined ? { valid: true, flutter } : { valid: true, flutter, name };
}

export function hasFlutterDependency(pubspec: string): boolean {
  const parsed = parsePubspec(pubspec);
  return parsed.valid && parsed.flutter;
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
  const pubspec = parsePubspec(file.text);
  if (!pubspec.valid) {
    return { ok: false, reason: 'pubspec.yaml is not valid YAML. Fix it, then run init again.' };
  }
  if (!pubspec.flutter) {
    return {
      ok: false,
      reason: `pubspec.yaml in ${projectDir} has no flutter dependency. FlutterDeck works with Flutter apps.`,
    };
  }
  return pubspec.name === undefined ? { ok: true } : { ok: true, name: pubspec.name };
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
