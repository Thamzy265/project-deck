/**
 * `init` on unusual projects: odd files, odd folders, two runs at once. Tests marked
 * `it.fails` are repros of open bugs (BUG-CLI-Tn) and pass once the bug is fixed.
 */
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITIGNORE_BEGIN } from './gitignore.js';
import type { InitOptions } from './init.js';
import { runInit } from './init.js';
import { launchEntry } from './launch-json.js';

const posix = process.platform === 'win32' ? it.skip : it;

const PUBSPEC = 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n';

let base: string;
let project: string;
let home: string;
let outside: string;
let lines: string[];
let errors: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'deck-cli-edges-'));
  project = join(base, 'app');
  home = join(base, 'home');
  outside = join(base, 'outside');
  for (const dir of [project, home, outside]) await mkdir(dir);
  await writeFile(join(project, 'pubspec.yaml'), PUBSPEC);
  lines = [];
  errors = [];
});

afterEach(async () => {
  // A test may leave a read-only folder behind on failure.
  await chmod(join(project, '.claude'), 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

function init(opts: Partial<InitOptions> = {}): Promise<number> {
  return runInit({
    projectDir: project,
    homeDir: home,
    run: () => Promise.reject(new Error('not installed')),
    mcpMainPath: '/opt/deck/main.js',
    isFree: () => Promise.resolve(true),
    io: { out: (l) => lines.push(l), err: (l) => errors.push(l) },
    ...opts,
  });
}

const read = (...parts: string[]) => readFile(join(project, ...parts), 'utf8');

async function snapshot(dir = project): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    out[path] = e.isFile() ? await readFile(path, 'utf8') : e.isSymbolicLink() ? 'link' : 'dir';
  }
  return out;
}

async function writeLaunch(text: string): Promise<void> {
  await mkdir(join(project, '.claude'), { recursive: true });
  await writeFile(join(project, '.claude', 'launch.json'), text);
}

async function writeConfig(text: string): Promise<void> {
  await mkdir(join(project, '.flutterdeck'), { recursive: true });
  await writeFile(join(project, '.flutterdeck', 'config.json'), text);
}

const countBlocks = (text: string) =>
  text.split(/\r?\n/).filter((l) => l === GITIGNORE_BEGIN).length;

describe('init: pubspec.yaml variants', () => {
  it('refuses a pubspec with flutter only in dev_dependencies, and writes nothing', async () => {
    await writeFile(
      join(project, 'pubspec.yaml'),
      'name: tool\ndependencies:\n  args: any\ndev_dependencies:\n  flutter:\n    sdk: flutter\n',
    );
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('no flutter dependency');
    expect(await readdir(project)).toEqual(['pubspec.yaml']);
  });

  it('refuses a folder without pubspec.yaml with exit 1, and writes nothing', async () => {
    await rm(join(project, 'pubspec.yaml'));
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('No pubspec.yaml');
    expect(await readdir(project)).toEqual([]);
  });

  it('accepts a CRLF pubspec with comments on the dependency lines', async () => {
    await writeFile(
      join(project, 'pubspec.yaml'),
      'name: shop_app # the app\r\ndependencies: # deps\r\n  # sdk first\r\n  flutter: # yes\r\n    sdk: flutter\r\n',
    );
    expect(await init()).toBe(0);
    expect(lines.join('\n')).toContain('Flutter project: shop_app');
  });

  // BUG-CLI-T3: a pubspec over 1 MB is reported as missing.
  it('BUG-CLI-T3: says a pubspec.yaml over 1 MB is too large, not that it is missing', async () => {
    await writeFile(join(project, 'pubspec.yaml'), PUBSPEC + `#${'x'.repeat(1_100_000)}\n`);
    expect(await init()).toBe(1);
    expect(errors.join('\n')).not.toContain('No pubspec.yaml');
    expect(errors.join('\n')).toContain('pubspec.yaml is too large to read');
    expect(await readdir(project)).toEqual(['pubspec.yaml']);
  });

  // BUG-CLI-T8: valid YAML that Flutter accepts is refused as "not a Flutter app".
  it.each([
    ['an anchor on dependencies', 'name: a\ndependencies: &deps\n  flutter:\n    sdk: flutter\n'],
    ['a quoted key', 'name: a\ndependencies:\n  "flutter":\n    sdk: flutter\n'],
    ['a byte order mark', '﻿dependencies:\n  flutter:\n    sdk: flutter\nname: a\n'],
  ])('BUG-CLI-T8: accepts a pubspec with %s', async (_label, text) => {
    await writeFile(join(project, 'pubspec.yaml'), text);
    expect(await init()).toBe(0);
  });

  it('BUG-CLI-T8: refuses a pubspec that expands aliases without bound (billion laughs)', async () => {
    const rows = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i++) {
      const prev = String.fromCharCode(96 + i);
      const next = String.fromCharCode(97 + i);
      rows.push(`${next}: &${next} [${Array(9).fill(`*${prev}`).join(', ')}]`);
    }
    const text = `name: a\n${rows.join('\n')}\ndependencies:\n  flutter:\n    sdk: flutter\n`;
    await writeFile(join(project, 'pubspec.yaml'), text);
    const started = Date.now();
    expect(await init()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(errors.join('\n')).toContain('pubspec.yaml');
    expect(await readdir(project)).toEqual(['pubspec.yaml']);
  });

  it('BUG-CLI-T8: refuses invalid YAML without quoting it', async () => {
    const marker = ['odd', 'text'].join('-');
    await writeFile(join(project, 'pubspec.yaml'), `name: a\ndependencies: [${marker}\n`);
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('not valid YAML');
    expect(errors.join('\n')).not.toContain(marker);
  });

  // BUG-CLI-T4: pubspec.yaml is read through a link, and a line of the target is printed.
  posix(
    'BUG-CLI-T4: never reads pubspec.yaml through a link to a file outside the project',
    async () => {
      const target = join(outside, 'notes.yaml');
      const secret = ['private', 'value', 'from', 'outside'].join('_');
      await writeFile(target, `name: ${secret}\ndependencies:\n  flutter:\n    sdk: flutter\n`);
      await rm(join(project, 'pubspec.yaml'));
      await symlink(target, join(project, 'pubspec.yaml'));
      expect(await init()).toBe(1);
      expect([...lines, ...errors].join('\n')).not.toContain(secret);
      expect(errors.join('\n')).toContain('pubspec.yaml is a link');
      expect(await readdir(project)).toEqual(['pubspec.yaml']);
    },
  );

  posix('BUG-CLI-T4: never reads the Android application id through a link', async () => {
    const target = join(outside, 'build.gradle.kts');
    const secret = ['org', 'private', 'outside'].join('.');
    await writeFile(target, `applicationId = "${secret}"\n`);
    await mkdir(join(project, 'android', 'app'), { recursive: true });
    await symlink(target, join(project, 'android', 'app', 'build.gradle.kts'));
    expect(await init()).toBe(0);
    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('init: .gitignore variants', () => {
  it('appends once to a CRLF file without a final newline, in CRLF', async () => {
    await writeFile(join(project, '.gitignore'), 'build/\r\nnode_modules');
    expect(await init()).toBe(0);
    expect(await init()).toBe(0);
    const text = await read('.gitignore');
    expect(text.startsWith('build/\r\nnode_modules\r\n\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(countBlocks(text)).toBe(1);
  });

  it('leaves a block the user edited by hand alone', async () => {
    const edited = `build/\n${GITIGNORE_BEGIN}\n.flutterdeck/\n`;
    await writeFile(join(project, '.gitignore'), edited);
    expect(await init()).toBe(0);
    expect(await read('.gitignore')).toBe(edited);
  });

  posix('replaces a hard-linked .gitignore instead of writing through the link', async () => {
    const target = join(project, 'shared-ignore');
    await writeFile(target, 'build/\n');
    await link(target, join(project, '.gitignore'));
    expect(await init()).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('build/\n');
    expect(countBlocks(await read('.gitignore'))).toBe(1);
  });

  posix('refuses a dangling link at .gitignore and creates nothing at its target', async () => {
    const target = join(outside, 'created-by-init');
    await symlink(target, join(project, '.gitignore'));
    expect(await init()).toBe(1);
    expect(await readdir(outside)).toEqual([]);
    expect(errors.join('\n')).not.toContain(outside);
  });

  it('refuses a .gitignore that is a folder, and writes nothing', async () => {
    await mkdir(join(project, '.gitignore'));
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('.gitignore');
    expect(await snapshot()).toEqual(before);
  });
});

describe('init: launch.json variants', () => {
  it('accepts trailing commas and comments inside the list, keeping both', async () => {
    await writeLaunch(
      '{\n  "configurations": [\n    // web first\n    { "name": "web", "url": "http://localhost:3000" },\n    // end\n  ],\n}\n',
    );
    expect(await init()).toBe(0);
    const text = await read('.claude', 'launch.json');
    expect(text).toContain('// web first');
    expect(text).toContain('// end');
    expect(parse(text, [], { allowTrailingComma: true })).toEqual({
      configurations: [{ name: 'web', url: 'http://localhost:3000' }, launchEntry(9147)],
    });
  });

  it('replaces a FlutterDeck entry that points elsewhere, keeping its neighbours', async () => {
    await writeLaunch(
      JSON.stringify({
        configurations: [
          { name: 'api', port: 8080 },
          { name: 'FlutterDeck', url: 'http://example.invalid:80' },
        ],
      }),
    );
    expect(await init()).toBe(0);
    expect(parse(await read('.claude', 'launch.json'))).toEqual({
      configurations: [{ name: 'api', port: 8080 }, launchEntry(9147)],
    });
    expect(lines.join('\n')).toMatch(/updated +\.claude\/launch\.json/);
  });

  it('keeps entries that are not objects', async () => {
    await writeLaunch('{"configurations":[1,null,"FlutterDeck",[]]}');
    expect(await init()).toBe(0);
    expect(parse(await read('.claude', 'launch.json'))).toEqual({
      configurations: [1, null, 'FlutterDeck', [], launchEntry(9147)],
    });
  });

  it.each([
    ['a top-level list', '[]', 'is not a JSON object'],
    ['a null list', '{"configurations":null}', 'not a list'],
    [
      'two FlutterDeck entries',
      '{"configurations":[{"name":"FlutterDeck"},{"name":"FlutterDeck","url":"x"}]}',
      'keep one',
    ],
  ])('refuses %s and writes nothing anywhere', async (_label, text, reason) => {
    await writeLaunch(text);
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain(reason);
    expect(await snapshot()).toEqual(before);
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses a launch.json over 1 MB without quoting it', async () => {
    const marker = ['big', 'file', 'marker'].join('-');
    await writeLaunch(`{"configurations":[],"x":"${marker}${'y'.repeat(1_100_000)}"}`);
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).not.toContain(marker);
    expect(await snapshot()).toEqual(before);
  });

  it('never quotes an invalid launch.json in its message', async () => {
    const marker = ['quoted', 'text'].join('-');
    await writeLaunch(`{"configurations": [ ${marker} ]`);
    expect(await init()).toBe(1);
    expect(errors.join('\n')).not.toContain(marker);
  });

  posix('keeps the mode of a read-only launch.json it updates', async () => {
    await writeLaunch('{"configurations":[]}');
    await chmod(join(project, '.claude', 'launch.json'), 0o444);
    expect(await init()).toBe(0);
    expect((await stat(join(project, '.claude', 'launch.json'))).mode & 0o777).toBe(0o444);
  });

  // BUG-CLI-T5: with two "configurations" keys, JSON readers use the last one, but init
  // edits the first and reports success.
  it.each([
    [
      'two "configurations" keys',
      '{"configurations":[],"configurations":[{"name":"FlutterDeck","url":"http://example.invalid"}]}',
    ],
    ['two "version" keys', '{"version":"0.0.1","version":"9","configurations":[]}'],
    [
      'two "url" keys in the FlutterDeck entry',
      '{"configurations":[{"name":"FlutterDeck","url":"http://127.0.0.1:9147","port":9147,"url":"http://example.invalid"}]}',
    ],
    [
      'two "name" keys in one entry',
      '{"configurations":[{"name":"FlutterDeck","name":"web","url":"http://localhost:3000"}]}',
    ],
  ])('BUG-CLI-T5: refuses a launch.json with %s and writes nothing', async (_label, text) => {
    await writeLaunch(text);
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('twice');
    expect(await snapshot()).toEqual(before);
  });

  // BUG-CLI-T6: Windows editors save JSON with a byte order mark; config.json accepts it.
  it('BUG-CLI-T6: accepts a launch.json that starts with a byte order mark, and keeps it', async () => {
    await writeLaunch('﻿{"configurations":[]}');
    expect(await init()).toBe(0);
    const text = await read('.claude', 'launch.json');
    expect(text.startsWith('﻿{')).toBe(true);
    expect(parse(text.slice(1))).toEqual({ configurations: [launchEntry(9147)] });
    // Already right the second time, BOM and all.
    lines = [];
    expect(await init()).toBe(0);
    expect(lines.join('\n')).toMatch(/unchanged +\.claude\/launch\.json/);
  });

  // BUG-CLI-T7: an empty launch.json (from `touch`) holds no settings to protect.
  it.each([[''], [' \n\t\r\n'], ['﻿']])(
    'BUG-CLI-T7: fills an empty or blank launch.json (%j) with a fresh file',
    async (text) => {
      await writeLaunch(text);
      expect(await init()).toBe(0);
      expect(JSON.parse(await read('.claude', 'launch.json'))).toEqual({
        version: '0.0.1',
        configurations: [launchEntry(9147)],
      });
    },
  );
});

describe('init: config.json variants', () => {
  it('refuses an unknown version, quotes no value and writes nothing', async () => {
    const marker = ['user', 'value'].join('-');
    await writeConfig(`{"version":2,"port":9300,"extra":"${marker}"}`);
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('version 2');
    expect(errors.join('\n')).not.toContain(marker);
    expect(await snapshot()).toEqual(before);
  });

  it('adds the port to a CRLF config with a byte order mark, keeping both', async () => {
    await writeConfig('﻿{\r\n  "version": 1,\r\n  "logs": { "redact": true }\r\n}\r\n');
    expect(await init()).toBe(0);
    const text = await read('.flutterdeck', 'config.json');
    expect(text.startsWith('﻿{\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(JSON.parse(text.slice(1))).toEqual({ version: 1, logs: { redact: true }, port: 9147 });
  });

  it.each([['0'], ['65536'], ['"9147"'], ['1023']])(
    'refuses a config port of %s and writes nothing',
    async (port) => {
      await writeConfig(`{"version":1,"port":${port}}`);
      const before = await snapshot();
      expect(await init()).toBe(1);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('refuses a .flutterdeck that is a file', async () => {
    await writeFile(join(project, '.flutterdeck'), 'x');
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(await snapshot()).toEqual(before);
  });
});

describe('init: unusual project paths', () => {
  it.each([['with space'], ['ünïcødé-日本'], ['dollar $HOME'], [`quote ' and "`]])(
    'works in a folder named %s',
    async (name) => {
      if (process.platform === 'win32' && name.includes('"')) return;
      const dir = join(base, name);
      await mkdir(dir);
      await writeFile(join(dir, 'pubspec.yaml'), PUBSPEC);
      expect(await init({ projectDir: dir })).toBe(0);
      expect(errors).toEqual([]);
      expect(parse(await readFile(join(dir, '.claude', 'launch.json'), 'utf8'))).toEqual({
        version: '0.0.1',
        configurations: [launchEntry(9147)],
      });
    },
  );
});

describe('init: concurrency and partial failures', () => {
  // BUG-CLI-T1: both runs see .claude missing; the second mkdir throws EEXIST.
  it.fails('BUG-CLI-T1: two inits at once both succeed with one block and one entry', async () => {
    const codes = await Promise.all([init(), init()]);
    expect(errors).toEqual([]);
    expect(codes).toEqual([0, 0]);
    expect(countBlocks(await read('.gitignore'))).toBe(1);
  });

  it('two inits at once never leave two blocks, two entries or two ports', async () => {
    await Promise.all([init(), init(), init()]);
    expect(countBlocks(await read('.gitignore'))).toBe(1);
    const launch = parse(await read('.claude', 'launch.json')) as { configurations: unknown[] };
    expect(launch.configurations).toEqual([launchEntry(9147)]);
    expect(JSON.parse(await read('.flutterdeck', 'config.json'))).toEqual({
      version: 1,
      port: 9147,
    });
    // No temp file is left behind.
    const names = Object.keys(await snapshot()).filter((p) => p.endsWith('.tmp'));
    expect(names).toEqual([]);
  });

  // BUG-CLI-T2: a .claude folder init can't write to is found only after config.json
  // and .gitignore are already written.
  posix.each([['.claude'], ['.flutterdeck'], ['.']])(
    'BUG-CLI-T2: a read-only %s folder leaves the project and the registry unchanged',
    async (name) => {
      if (process.getuid?.() === 0) throw new Error('root can write anywhere');
      const dir = join(project, name);
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o555);
      try {
        const before = await snapshot();
        expect(await init()).toBe(1);
        expect(await snapshot()).toEqual(before);
        expect(await readdir(home)).toEqual([]);
        const shown = name === '.' ? 'the project folder' : name;
        expect(errors.join('\n')).toContain(`can't write to ${shown}`);
        // Project-relative names only, never an absolute path.
        expect(errors.join('\n')).not.toContain(base);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it('BUG-CLI-T2: names a damaged registry by ~, never by its absolute path', async () => {
    await mkdir(join(home, '.flutterdeck'));
    await writeFile(join(home, '.flutterdeck', 'ports.json'), '{ damaged');
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain(join('~', '.flutterdeck', 'ports.json'));
    expect(errors.join('\n')).not.toContain(base);
  });

  it('BUG-CLI-T2: names no absolute path when there is no Flutter app', async () => {
    await rm(join(project, 'pubspec.yaml'));
    expect(await init()).toBe(1);
    expect(errors.join('\n')).not.toContain(base);
  });

  it('BUG-CLI-T2: shows no absolute path in an unexpected error', async () => {
    // ~/.flutterdeck is a file, so the registry can't be created: the fs error names
    // absolute paths.
    await writeFile(join(home, '.flutterdeck'), 'not a folder');
    expect(await init()).toBe(1);
    expect(errors.join('\n')).not.toContain(base);
  });
});
