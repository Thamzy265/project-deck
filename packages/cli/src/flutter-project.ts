/**
 * Is this folder a Flutter app? `pubspec.yaml` with `flutter` under `dependencies`.
 * Parsed with the `yaml` package (core schema, no custom tags, aliases capped against
 * "billion laughs" expansion); nothing from the file is repeated except a checked name.
 */
import { join } from 'node:path';
import { ANDROID_APPLICATION_ID } from '@project-deck/core';
import { parseDocument } from 'yaml';
import { MAX_FILE_BYTES, isRealFolder, readProjectFile } from './project-files.js';

/** Dart package names: lower-case letters, digits and underscores. */
const PACKAGE_NAME = /^[a-z_][a-z0-9_]*$/;
/**
 * A plain `applicationId` line: dotted segments of letters, digits and underscores in
 * matching quotes. Checked again with core's ANDROID_APPLICATION_ID, which config.json uses.
 */
const APPLICATION_ID =
  /^[ \t]*applicationId[ \t]*=?[ \t]*(["'])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\1[ \t]*$/gm;
/** Longest id config.json accepts. */
const MAX_APPLICATION_ID = 255;

export type Detection = { ok: true; name?: string } | { ok: false; reason: string };

/** Far more than a real pubspec uses; beyond it, alias expansion is an attack. */
const MAX_ALIASES = 50;

type Pubspec = { valid: false } | { valid: true; flutter: boolean; name?: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  let file;
  try {
    file = await readProjectFile(join(projectDir, 'pubspec.yaml'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, reason: `pubspec.yaml can't be read (${code}).` };
  }
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
  if (file.kind !== 'file') {
    return {
      ok: false,
      reason:
        "No pubspec.yaml in the project folder. Run init in a Flutter app's folder, or pass --project <folder>.",
    };
  }
  const pubspec = parsePubspec(file.text);
  if (!pubspec.valid) {
    return { ok: false, reason: 'pubspec.yaml is not valid YAML. Fix it, then run init again.' };
  }
  if (!pubspec.flutter) {
    return {
      ok: false,
      reason: 'pubspec.yaml has no flutter dependency. FlutterDeck works with Flutter apps.',
    };
  }
  return pubspec.name === undefined ? { ok: true } : { ok: true, name: pubspec.name };
}

/** The Android applicationId when it is a plain literal; undefined otherwise. */
export async function readApplicationId(projectDir: string): Promise<string | undefined> {
  // O_NOFOLLOW guards only the file itself: a linked `android` or `android/app` folder
  // would still lead outside the project, so both must be real folders.
  for (const dir of [join(projectDir, 'android'), join(projectDir, 'android', 'app')]) {
    if (!(await isRealFolder(dir))) return undefined;
  }
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    // The id is only shown, so a file that can't be read is skipped.
    const found = await readProjectFile(join(projectDir, 'android', 'app', file)).catch(
      () => undefined,
    );
    if (found?.kind !== 'file') continue;
    return applicationIdFrom(found.text);
  }
  return undefined;
}

/**
 * The one id the file sets, outside block comments. Two different ids (flavors that set
 * their own) are a guess, so none is taken; snapshots then use the running app's id.
 */
export function applicationIdFrom(gradle: string): string | undefined {
  const ids = new Set<string>();
  for (const m of withoutComments(gradle).matchAll(APPLICATION_ID)) {
    if (m[2] !== undefined) ids.add(m[2]);
  }
  const [id] = ids;
  if (ids.size !== 1 || id === undefined) return undefined;
  return id.length <= MAX_APPLICATION_ID && ANDROID_APPLICATION_ID.test(id) ? id : undefined;
}

/**
 * Drops `/* … *\/` and `//` comments in one pass, keeping quoted strings as they are, so
 * a `/*` inside a string (`exclude 'META-INF/*.kotlin_module'`) opens no comment
 * (review R6). Linear: an unclosed comment or string runs to the end of the file.
 */
function withoutComments(text: string): string {
  const parts: string[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '*') {
      parts.push(text.slice(start, i), ' ');
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return parts.join('');
      i = start = close + 2;
    } else if (c === '/' && next === '/') {
      parts.push(text.slice(start, i));
      const eol = text.indexOf('\n', i);
      if (eol === -1) return parts.join('');
      i = start = eol;
    } else if (c === '"' && text.startsWith('"""', i)) {
      const close = text.indexOf('"""', i + 3);
      i = close === -1 ? text.length : close + 3;
    } else if (c === '"' || c === "'") {
      // To the closing quote, or the end of the line (an unclosed string ends there).
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else {
      i++;
    }
  }
  parts.push(text.slice(start));
  return parts.join('');
}
