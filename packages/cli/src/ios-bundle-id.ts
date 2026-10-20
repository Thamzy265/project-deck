/**
 * The iOS bundle id for simulator snapshots, read from `ios/Runner.xcodeproj/project.pbxproj`
 * (docs/notes/untrusted-project-files.md): the Runner target's Debug configuration only,
 * a plain value matching core's IOS_BUNDLE_ID. Nothing in the project runs; the file is
 * parsed as an old-style property list by a small linear parser, and never quoted.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { IOS_BUNDLE_ID } from '@project-deck/core';
import { readProjectFile } from './project-files.js';

/** Far more than a real Flutter project file (about 25 kB). */
export const MAX_PBXPROJ_BYTES = 2 * 1024 * 1024;
/** Longest bundle id config.json accepts. */
const MAX_BUNDLE_ID = 155;
/** Real project files nest about 5 deep. */
const MAX_DEPTH = 64;

/**
 * found: a usable id. none: no iOS project to read (or a link, which is never followed).
 * unusable: there is one, but no plain id could be taken from it; the user sets it.
 */
export type BundleIdLookup =
  { kind: 'found'; id: string } | { kind: 'none' } | { kind: 'unusable' };

/** Maps keep keys such as `__proto__` as plain data. */
export type PlistValue = string | PlistValue[] | Map<string, PlistValue>;

class ParseError extends Error {}

/** An old-style (OpenStep) property list, as Xcode writes project.pbxproj; undefined if invalid. */
export function parsePbxproj(text: string): PlistValue | undefined {
  try {
    const parser = new Parser(text);
    const value = parser.value(0);
    parser.end();
    return value;
  } catch (err) {
    if (err instanceof ParseError) return undefined;
    throw err;
  }
}

/** Characters that end an unquoted string. */
const DELIMITERS = new Set(['{', '}', '(', ')', '=', ';', ',', '"', ' ', '\t', '\r', '\n']);

class Parser {
  private i = 0;

  constructor(private readonly text: string) {}

  value(depth: number): PlistValue {
    if (depth > MAX_DEPTH) throw new ParseError();
    this.skip();
    const c = this.text[this.i];
    if (c === '{') return this.dict(depth);
    if (c === '(') return this.array(depth);
    return this.string();
  }

  end(): void {
    this.skip();
    if (this.i !== this.text.length) throw new ParseError();
  }

  private dict(depth: number): Map<string, PlistValue> {
    this.i++;
    const out = new Map<string, PlistValue>();
    for (;;) {
      this.skip();
      if (this.text[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.string();
      this.expect('=');
      const value = this.value(depth + 1);
      this.expect(';');
      out.set(key, value);
    }
  }

  private array(depth: number): PlistValue[] {
    this.i++;
    const out: PlistValue[] = [];
    for (;;) {
      this.skip();
      if (this.text[this.i] === ')') {
        this.i++;
        return out;
      }
      out.push(this.value(depth + 1));
      this.skip();
      if (this.text[this.i] === ',') this.i++;
      else if (this.text[this.i] !== ')') throw new ParseError();
    }
  }

  private string(): string {
    this.skip();
    const { text } = this;
    if (text[this.i] === '"') {
      let out = '';
      for (this.i++; this.i < text.length; this.i++) {
        const c = text[this.i];
        if (c === '"') {
          this.i++;
          return out;
        }
        if (c === '\\') {
          this.i++;
          const e = text[this.i];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : (e ?? '');
        } else {
          out += c ?? '';
        }
      }
      throw new ParseError();
    }
    const start = this.i;
    while (this.i < text.length && !DELIMITERS.has(text[this.i] ?? '') && !this.atComment()) {
      this.i++;
    }
    if (this.i === start) throw new ParseError();
    return text.slice(start, this.i);
  }

  private expect(c: string): void {
    this.skip();
    if (this.text[this.i] !== c) throw new ParseError();
    this.i++;
  }

  private atComment(): boolean {
    return (
      this.text[this.i] === '/' && (this.text[this.i + 1] === '*' || this.text[this.i + 1] === '/')
    );
  }

  /** Whitespace and comments; each character is looked at once. */
  private skip(): void {
    const { text } = this;
    while (this.i < text.length) {
      const c = text[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.i++;
      } else if (c === '/' && text[this.i + 1] === '*') {
        const close = text.indexOf('*/', this.i + 2);
        if (close === -1) throw new ParseError();
        this.i = close + 2;
      } else if (c === '/' && text[this.i + 1] === '/') {
        const eol = text.indexOf('\n', this.i);
        this.i = eol === -1 ? text.length : eol + 1;
      } else {
        return;
      }
    }
  }
}

const isMap = (v: PlistValue | undefined): v is Map<string, PlistValue> => v instanceof Map;

/** The Runner target's Debug PRODUCT_BUNDLE_IDENTIFIER, when it is a plain, valid id. */
export function bundleIdFromPbxproj(text: string): BundleIdLookup {
  const root = parsePbxproj(text);
  const objects = isMap(root) ? root.get('objects') : undefined;
  if (!isMap(objects)) return { kind: 'unusable' };
  const object = (id: PlistValue | undefined) =>
    typeof id === 'string' ? objects.get(id) : undefined;
  // Flavors and test targets are ignored; two Runner targets would be a guess.
  const runners = [...objects.values()].filter(
    (o) => isMap(o) && o.get('isa') === 'PBXNativeTarget' && o.get('name') === 'Runner',
  );
  const [runner] = runners;
  if (runners.length !== 1 || !isMap(runner)) return { kind: 'unusable' };
  const list = object(runner.get('buildConfigurationList'));
  const ids = isMap(list) ? list.get('buildConfigurations') : undefined;
  if (!Array.isArray(ids)) return { kind: 'unusable' };
  const debug = ids
    .map(object)
    .filter(
      (c) => isMap(c) && c.get('isa') === 'XCBuildConfiguration' && c.get('name') === 'Debug',
    );
  const [config] = debug;
  if (debug.length !== 1 || !isMap(config)) return { kind: 'unusable' };
  const settings = config.get('buildSettings');
  const id = isMap(settings) ? settings.get('PRODUCT_BUNDLE_IDENTIFIER') : undefined;
  // A value holding `$(` is a build variable, which only Xcode can resolve.
  if (typeof id !== 'string' || id.length > MAX_BUNDLE_ID || !IOS_BUNDLE_ID.test(id)) {
    return { kind: 'unusable' };
  }
  return { kind: 'found', id };
}

async function isRealFolder(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads the bundle id without following a link anywhere on the way. */
export async function readBundleId(projectDir: string): Promise<BundleIdLookup> {
  const ios = join(projectDir, 'ios');
  const xcodeproj = join(ios, 'Runner.xcodeproj');
  for (const dir of [ios, xcodeproj]) {
    if (!(await isRealFolder(dir))) return { kind: 'none' };
  }
  const file = await readProjectFile(join(xcodeproj, 'project.pbxproj'), MAX_PBXPROJ_BYTES).catch(
    () => undefined,
  );
  switch (file?.kind) {
    case 'file':
      return bundleIdFromPbxproj(file.text);
    case 'too-large':
    case 'not-file':
      return { kind: 'unusable' };
    default:
      // Missing, a link, or unreadable: there is nothing of the project's own to read.
      return { kind: 'none' };
  }
}
