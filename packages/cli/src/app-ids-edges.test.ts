/**
 * Tester probes of how `init` reads app ids from project files it must not trust
 * (docs/notes/untrusted-project-files.md): Gradle text tricks, odd project files, links,
 * existing configs, and that init runs nothing and writes only its own files.
 */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationIdFrom } from './flutter-project.js';
import type { InitOptions } from './init.js';
import { runInit } from './init.js';
import { bundleIdFromPbxproj } from './ios-bundle-id.js';
import type { RunTool, Tool } from './prerequisites.js';

const posix = process.platform === 'win32' ? it.skip : it;

const PUBSPEC = 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n';
const SAMPLE_PBXPROJ = fileURLToPath(
  new URL('./testing/fixtures/sample-app.pbxproj', import.meta.url),
);
const SAMPLE_ID = 'dev.flutterdeck.flutterdeckSample';

/** A minimal project file: one Runner target with the given Debug configurations. */
function pbxproj(configs: string, ids = 'C1') {
  return `{ objects = {
    T1 = { isa = PBXNativeTarget; buildConfigurationList = L1; name = Runner; };
    L1 = { isa = XCConfigurationList; buildConfigurations = ( ${ids} ); };
    ${configs}
  }; }`;
}
const debug = (key: string, id: string) =>
  `${key} = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = ${id}; }; name = Debug; };`;

describe('applicationIdFrom: Gradle text it must not misread', () => {
  it.each([
    [
      'CRLF line endings (a Windows checkout)',
      'defaultConfig {\r\n  applicationId = "com.example.app"\r\n}\r\n',
    ],
    ['Groovy with no equals sign', 'defaultConfig {\n    applicationId "com.example.app"\n}\n'],
    ['Groovy single quotes', "defaultConfig {\n    applicationId 'com.example.app'\n}\n"],
    ['tabs', '\tapplicationId\t=\t"com.example.app"\t\n'],
    [
      'a flavor that repeats the same id',
      'applicationId = "com.example.app"\nproductFlavors { create("x") {\n  applicationId = "com.example.app"\n} }\n',
    ],
    [
      'a line comment with an old id',
      '// applicationId = "com.old.app"\napplicationId = "com.example.app"\n',
    ],
  ])('reads the id with %s', (_name, gradle) => {
    expect(applicationIdFrom(gradle)).toBe('com.example.app');
  });

  // Regression locks: each of these fails safe (no id, so snapshots use the running
  // app's process name). A looser parser could start taking a wrong or crafted id.
  it.each([
    [
      'an id in a string literal on the same line',
      'val note = "applicationId = \\"com.evil.app\\""\n',
    ],
    ['a trailing line comment', 'applicationId = "com.example.app" // prod\n'],
    ['a trailing semicolon', 'applicationId "com.example.app";\n'],
    ['a call form', 'applicationId("com.example.app")\n'],
    ['the setter form', 'setApplicationId("com.example.app")\n'],
    ['one-line block', 'defaultConfig { applicationId = "com.example.app" }\n'],
    ['a Cyrillic letter', 'applicationId = "com.exаmple.app"\n'],
    ['a zero-width space', 'applicationId = "com.ex​ample.app"\n'],
    ['an RTL override', 'applicationId = "com.‮ppa.elpmaxe"\n'],
    ['a NUL byte', 'applicationId = "com.example.app\u0000"\n'],
    ['an applicationIdSuffix only', 'applicationIdSuffix = ".debug"\n'],
    ['a project property', 'applicationId = project.property("appId")\n'],
    ['Groovy interpolation', 'applicationId "com.example.${flavor}"\n'],
    ['Kotlin template', 'applicationId = "$base.app"\n'],
    [
      'a block comment opener inside a string',
      'val c = "/*"\napplicationId = "com.example.app"\nval d = "*/"\n',
    ],
    [
      'a block comment opener inside a line comment',
      '// see /* old\napplicationId = "com.example.app"\n',
    ],
    ['an id over 255 characters', `applicationId = "com.${'a'.repeat(260)}"\n`],
    ['a single segment', 'applicationId = "example"\n'],
  ])('takes no id from %s', (_name, gradle) => {
    expect(applicationIdFrom(gradle)).toBeUndefined();
  });

  it('takes the base id when a build type adds a suffix (process name wins at run time)', () => {
    // The debug app is com.example.app.debug on the device; db-sqlite prefers the
    // running process name (notes/db-backends.md item 5) and uses this only as a fallback.
    const gradle =
      'applicationId = "com.example.app"\nbuildTypes { getByName("debug") {\n  applicationIdSuffix = ".debug"\n} }\n';
    expect(applicationIdFrom(gradle)).toBe('com.example.app');
  });

  // MCP-8 (fixed): the opening and closing quotes must match, so `"com.example.app'` is not
  // read as an id: neither Groovy nor Kotlin would build it.
  it('takes no id from mismatched quotes', () => {
    expect(applicationIdFrom('applicationId "com.example.app\'\n')).toBeUndefined();
  });

  it('reads a 1 MB file of unmatched quotes and ids quickly', () => {
    const gradle = 'applicationId = "a.b'.repeat(50_000);
    const start = performance.now();
    expect(applicationIdFrom(gradle)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('bundleIdFromPbxproj: project files it must not misread', () => {
  it('reads the sample with CRLF line endings', async () => {
    const text = (await readFile(SAMPLE_PBXPROJ, 'utf8')).replaceAll('\n', '\r\n');
    expect(bundleIdFromPbxproj(text)).toEqual({ kind: 'found', id: SAMPLE_ID });
  });

  it.each([
    [
      'a Release-only id',
      `C1 = { isa = XCBuildConfiguration; buildSettings = { }; name = Debug; }; C2 = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.app; }; name = Release; };`,
      'C1, C2',
    ],
    [
      'a $(PRODUCT_NAME) variable',
      debug('C1', '"com.example.$(PRODUCT_NAME:rfc1034identifier)"'),
      'C1',
    ],
    ['${} variables', debug('C1', '"com.example.${PRODUCT_NAME}"'), 'C1'],
    ['a non-ASCII letter', debug('C1', 'com.éxample.app'), 'C1'],
    ['an escaped quote', debug('C1', '"com.ex\\"ample"'), 'C1'],
    ['a newline in a quoted id', debug('C1', '"com.example.app\\n"'), 'C1'],
    ['a leading dash', debug('C1', '-com.example'), 'C1'],
    ['a Debug config of another target only', debug('C9', 'com.example.app'), 'C1'],
  ])('finds no usable id with %s', (_name, configs, ids) => {
    expect(bundleIdFromPbxproj(pbxproj(configs, ids)).kind).toBe('unusable');
  });

  it('finds no usable id when the configuration list is not a list', () => {
    const text = pbxproj(debug('C1', 'com.example.app')).replace('( C1 )', 'C1');
    expect(bundleIdFromPbxproj(text).kind).toBe('unusable');
  });

  it('finds no usable id in a file with a byte order mark (Xcode never writes one)', () => {
    expect(bundleIdFromPbxproj(`\uFEFF${pbxproj(debug('C1', 'com.example.app'))}`).kind).toBe(
      'unusable',
    );
  });

  it('refuses 2 MB of nested lists without overflowing the stack', () => {
    expect(bundleIdFromPbxproj('('.repeat(2 * 1024 * 1024)).kind).toBe('unusable');
  });

  // MCP-9: an escape the parser doesn't know loses its backslash, so `\U00e9`
  // (Xcode's unicode escape) becomes the text "U00e9" and a made-up id is taken.
  it.fails('takes no id from a quoted value with an unknown escape', () => {
    expect(bundleIdFromPbxproj(pbxproj(debug('C1', '"com.\\U00e9xample"'))).kind).toBe('unusable');
  });

  // MCP-10: a repeated object key silently replaces the first, so a second "C1" later in
  // the file decides the id. Xcode files never repeat keys; two values are a guess.
  it.fails('takes no id when an object key is repeated', () => {
    const text = pbxproj(`${debug('C1', 'com.example.app')}\n${debug('C1', 'com.evil.app')}`);
    expect(bundleIdFromPbxproj(text).kind).toBe('unusable');
  });
});

describe('init with untrusted project files', () => {
  let project: string;
  let home: string;
  let outside: string;
  let lines: string[];
  let errors: string[];
  let runs: [Tool, readonly string[]][];

  beforeEach(async () => {
    // Spaces and non-ASCII letters, as in many Windows and macOS user folders.
    const base = await mkdtemp(join(tmpdir(), 'deck ids édge '));
    project = join(base, 'My App (copy)');
    await mkdir(project);
    home = await mkdtemp(join(tmpdir(), 'deck-ids-home-'));
    outside = await mkdtemp(join(tmpdir(), 'deck-ids-outside-'));
    await writeFile(join(project, 'pubspec.yaml'), PUBSPEC);
    lines = [];
    errors = [];
    runs = [];
  });

  afterEach(async () => {
    for (const dir of [join(project, '..'), home, outside]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const run: RunTool = (tool, args) => {
    runs.push([tool, args]);
    return Promise.reject(new Error('ENOENT'));
  };

  function init(opts: Partial<InitOptions> = {}): Promise<number> {
    return runInit({
      projectDir: project,
      homeDir: home,
      run,
      cliMainPath: '/opt/deck/packages/cli/dist/main.js',
      isFree: () => Promise.resolve(true),
      io: { out: (l) => lines.push(l), err: (l) => errors.push(l) },
      ...opts,
    });
  }

  async function tree(dir: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      out.set(relative(project, path), (await stat(path)).mtimeMs);
    }
    return out;
  }

  async function androidAndIos(): Promise<void> {
    await mkdir(join(project, 'android', 'app'), { recursive: true });
    await writeFile(
      join(project, 'android', 'app', 'build.gradle'),
      'android {\n  defaultConfig {\n    applicationId "com.example.shop_app"\n  }\n}\n',
    );
    await mkdir(join(project, 'ios', 'Runner.xcodeproj'), { recursive: true });
    await copyFile(SAMPLE_PBXPROJ, join(project, 'ios', 'Runner.xcodeproj', 'project.pbxproj'));
  }

  it('reads both ids in a folder with spaces and non-ASCII letters', async () => {
    await androidAndIos();
    expect(await init()).toBe(0);
    const config: unknown = parse(
      await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8'),
    );
    expect(config).toMatchObject({
      android: { applicationId: 'com.example.shop_app' },
      ios: { bundleId: SAMPLE_ID },
    });
  });

  it('runs only the fixed version checks and writes only its own files', async () => {
    await androidAndIos();
    const before = await tree(project);
    expect(await init()).toBe(0);
    for (const [tool, args] of runs) {
      expect(['dart', 'flutter', 'adb']).toContain(tool);
      expect(args.length).toBe(1);
      expect(args[0]).toMatch(/^(--version|version)$/);
    }
    const after = await tree(project);
    for (const [path, mtime] of before) expect(after.get(path), path).toBe(mtime);
    const added = [...after.keys()].filter((p) => !before.has(p)).sort();
    for (const path of added) {
      expect(path.split(/[\\/]/)[0], path).toMatch(/^(\.flutterdeck|\.claude|\.gitignore)$/);
    }
  });

  it('adds only the missing iOS id next to an Android id the user set', async () => {
    await androidAndIos();
    await mkdir(join(project, '.flutterdeck'));
    const before =
      '{\r\n  "version": 1,\r\n  "port": 9300,\r\n  "android": { "applicationId": "com.mine.app" }\r\n}\r\n';
    await writeFile(join(project, '.flutterdeck', 'config.json'), before);
    expect(await init()).toBe(0);
    const text = await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8');
    expect(parse(text)).toEqual({
      version: 1,
      port: 9300,
      android: { applicationId: 'com.mine.app' },
      ios: { bundleId: SAMPLE_ID },
    });
    expect(text).toContain('"android": { "applicationId": "com.mine.app" }');
    expect(lines.join('\n')).not.toMatch(/android\.applicationId com\.example/);
  });

  it('refuses a malformed config.json, writes nothing and repeats no id', async () => {
    await androidAndIos();
    await mkdir(join(project, '.flutterdeck'));
    const broken = '{ "version": 1, "port": ';
    await writeFile(join(project, '.flutterdeck', 'config.json'), broken);
    expect(await init()).not.toBe(0);
    expect(await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8')).toBe(broken);
    expect([...lines, ...errors].join('\n')).not.toMatch(
      /com\.example\.shop_app|flutterdeckSample/,
    );
  });

  it('reads the id from a Gradle file that is not UTF-8 elsewhere', async () => {
    await mkdir(join(project, 'android', 'app'), { recursive: true });
    const latin1 = Buffer.concat([
      Buffer.from('// Auteur: '),
      Buffer.from([0xe9, 0xe8, 0xff, 0xfe]),
      Buffer.from('\napplicationId = "com.example.shop_app"\n'),
    ]);
    await writeFile(join(project, 'android', 'app', 'build.gradle.kts'), latin1);
    expect(await init()).toBe(0);
    const config: unknown = parse(
      await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8'),
    );
    expect(config).toMatchObject({ android: { applicationId: 'com.example.shop_app' } });
  });

  it('skips a Gradle file over 1 MB without reading an id from it', async () => {
    await mkdir(join(project, 'android', 'app'), { recursive: true });
    await writeFile(
      join(project, 'android', 'app', 'build.gradle.kts'),
      `applicationId = "com.example.shop_app"\n${'/'.repeat(1024 * 1024)}\n`,
    );
    expect(await init()).toBe(0);
    const config: unknown = parse(
      await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({ version: 1, port: 9147 });
  });

  posix('never reads through a linked android or ios folder', async () => {
    const secret = ['org', 'private', 'outside'].join('.');
    await mkdir(join(outside, 'android', 'app'), { recursive: true });
    await writeFile(
      join(outside, 'android', 'app', 'build.gradle.kts'),
      `applicationId = "${secret}"\n`,
    );
    await mkdir(join(outside, 'ios', 'Runner.xcodeproj'), { recursive: true });
    await writeFile(
      join(outside, 'ios', 'Runner.xcodeproj', 'project.pbxproj'),
      (await readFile(SAMPLE_PBXPROJ, 'utf8')).replaceAll(SAMPLE_ID, secret),
    );
    await symlink(join(outside, 'android'), join(project, 'android'), 'dir');
    await symlink(join(outside, 'ios'), join(project, 'ios'), 'dir');
    expect(await init()).toBe(0);
    const written = await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8');
    expect(written).not.toContain(secret);
    expect([...lines, ...errors].join('\n')).not.toContain(secret);
    // Nothing was written through the links either.
    expect((await readdir(join(outside, 'android', 'app'))).sort()).toEqual(['build.gradle.kts']);
  });

  posix('skips a project.pbxproj that is a folder or a link to a device file', async () => {
    await mkdir(join(project, 'ios', 'Runner.xcodeproj', 'project.pbxproj'), { recursive: true });
    expect(await init()).toBe(0);
    await rm(join(project, 'ios'), { recursive: true });
    await mkdir(join(project, 'ios', 'Runner.xcodeproj'), { recursive: true });
    await symlink('/dev/zero', join(project, 'ios', 'Runner.xcodeproj', 'project.pbxproj'));
    expect(await init()).toBe(0);
    const config: unknown = parse(
      await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({ version: 1, port: 9147 });
  });
});
