/**
 * The tarball checks themselves (M5 batch 2): a stray file in dist/ must fail them, and
 * the manifest must give npm nothing to run or fetch at install time.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strayPaths } from './tarball-paths.js';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

/** Files a careless build or a developer's machine could leave in dist/. */
const STRAYS = [
  'dist/cli.js.map',
  'dist/chunk-ABC123.js.map',
  'dist/dashboard/assets/index-abc.js.map',
  'dist/main.ts',
  'dist/index.d.ts',
  'dist/chunk-ABC123.d.mts',
  'dist/cli.test.js',
  'dist/dashboard/assets/index.test.js',
  'dist/qa-client.js',
  'dist/dashboard/assets/qa-client.js',
  'dist/dashboard/assets/qa-client-abc.js',
  'dist/fake-daemon.js',
  'dist/dashboard/assets/fake-daemon.js',
  'dist/.env',
  'dist/.env.local',
  'dist/.pitdeck/runtime.json',
  'dist/.pitdeck/state.json',
  'dist/fixtures/other.sqlite',
  'dist/binding.gyp',
  'dist/build-meta.json',
  'dist/node_modules/x/index.js',
];

describe('strayPaths', () => {
  it.each(STRAYS)('flags %s', (path) => {
    expect(strayPaths([path])).toEqual([path]);
  });

  it.each(['.env', '.pitdeck/runtime.json', 'build-meta.json', 'src/cli.ts', 'build.mjs'])(
    'flags %s at the package root',
    (path) => {
      expect(strayPaths([path])).toEqual([path]);
    },
  );

  it('passes the files a real build makes', () => {
    expect(
      strayPaths([
        'package.json',
        'LICENSE',
        'dist/cli.js',
        'dist/chunk-6QCEN6ZF.js',
        'dist/sqlite3.wasm',
        'dist/dashboard/index.html',
        'dist/dashboard/assets/SqlEditor-CHGDhYC_.js',
        'dist/dashboard/assets/index-CzDjYW-A.css',
        'dist/dashboard/assets/search-worker-BqpBRmLa.js',
      ]),
    ).toEqual([]);
  });
});

const PackResult = z.array(
  z.object({ unpackedSize: z.number(), files: z.array(z.object({ path: z.string() })) }),
);

describe('npm pack of a dist folder with stray files (run pnpm build first)', () => {
  let scratch = '';
  let paths: string[] = [];
  let unpackedSize = 0;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pitdeck-strays-'));
    const pkg = join(scratch, 'pkg');
    await mkdir(pkg);
    await cp(join(PKG_DIR, 'dist'), join(pkg, 'dist'), { recursive: true });
    await cp(join(PKG_DIR, 'package.json'), join(pkg, 'package.json'));
    await cp(join(PKG_DIR, 'LICENSE'), join(pkg, 'LICENSE'));
    for (const path of STRAYS) {
      await mkdir(dirname(join(pkg, path)), { recursive: true });
      await writeFile(join(pkg, path), 'x');
    }
    // An allowlisted name that only the size cap catches.
    await writeFile(join(pkg, 'dist', 'chunk-HUGE.js'), Buffer.alloc(MAX_UNPACKED_BYTES));
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
    const [command, argv] =
      process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'npm', ...args]] : ['npm', args];
    const out = execFileSync(command, argv, {
      cwd: pkg,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      // A scratch cache and user config: nothing of the real home is read or written.
      env: {
        ...process.env,
        HOME: scratch,
        USERPROFILE: scratch,
        npm_config_cache: join(scratch, 'npm-cache'),
        npm_config_userconfig: join(scratch, 'npmrc'),
        npm_config_update_notifier: 'false',
      },
    });
    const [result] = PackResult.parse(JSON.parse(out));
    if (result === undefined) throw new Error('npm pack printed no result');
    paths = result.files.map((f) => f.path.replaceAll('\\', '/'));
    unpackedSize = result.unpackedSize;
  });

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true });
  });

  it('flags every stray file npm would publish', () => {
    // npm drops a few names itself (node_modules); every other stray must be packed and flagged.
    const packed = STRAYS.filter((s) => paths.includes(s));
    expect(packed.length).toBeGreaterThan(STRAYS.length - 3);
    expect(strayPaths(paths).sort()).toEqual(packed.sort());
  });

  it('goes over the size cap with an oversized chunk', () => {
    expect(unpackedSize).toBeGreaterThan(MAX_UNPACKED_BYTES);
  });
});

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const Manifest = z.looseObject({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

describe('the pitdeck manifest at install time', () => {
  const read = async () =>
    Manifest.parse(JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8')));

  it('has no script npm runs on install, pack or publish', async () => {
    // npm's lifecycle scripts (docs.npmjs.com, "Life Cycle Scripts"), pre and post forms too.
    const hooks = [
      'install',
      'prepare',
      'pack',
      'publish',
      'prepublish',
      'prepublishOnly',
      'version',
      'dependencies',
    ];
    const lifecycle = hooks.flatMap((h) => [h, `pre${h}`, `post${h}`]);
    const scripts = Object.keys((await read()).scripts ?? {});
    expect(scripts.filter((s) => lifecycle.includes(s))).toEqual([]);
  });

  it('has no bundled, workspace, link or file dependency', async () => {
    const pkg = await read();
    expect(pkg['bundleDependencies']).toBeUndefined();
    expect(pkg['bundledDependencies']).toBeUndefined();
    expect(pkg['gypfile']).toBeUndefined();
    const specs = DEP_FIELDS.flatMap((f) => Object.entries(pkg[f] ?? {}));
    expect(specs.filter(([, v]) => /^(workspace|link|file|portal|git|github):/.test(v))).toEqual(
      [],
    );
  });
});
