// Builds the publishable `pitdeck` package (ADR 0006) from the workspace packages'
// built dist folders: run after every other package has built (the root `pnpm build`
// does). Everything is bundled, so the package has no runtime dependencies to install.
//
// dist/ layout, flat on purpose: the code finds its files next to itself with
// `new URL('<name>', import.meta.url)`, whichever chunk it lands in.
//   cli.js              the `pitdeck` bin
//   daemon.js           started by `pitdeck start` and `pitdeck mcp`
//   guard-worker.js     sql-guard's worker thread
//   snapshot-worker.js  db-sqlite's worker thread
//   chunk-*.js          code shared between them
//   sqlite3.wasm        loaded by sqlite-wasm next to its own chunk
//   dashboard/          the dashboard's built files
//   fixtures/           the fake mode's database files (`daemon.js --fake`)
//   licenses.md         licences of the bundled libraries (the dashboard has its own)
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, '..');
const dist = join(here, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist);

const result = await build({
  entryPoints: {
    cli: join(packages, 'cli/dist/main.js'),
    daemon: join(packages, 'daemon/dist/main.js'),
    'guard-worker': join(packages, 'sql-guard/dist/guard-worker.js'),
    'snapshot-worker': join(packages, 'db-sqlite/dist/snapshot-worker.js'),
  },
  absWorkingDir: here,
  outdir: dist,
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  // jsonc-parser's "main" is a UMD build whose require() calls esbuild can't follow; its
  // "module" build is plain ESM.
  mainFields: ['module', 'main'],
  // Readable output, so users can read what they run. No source maps: they would double
  // the download and point at files that are not in the package.
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
  // ws loads these native speed-ups if present and works without them (no native modules).
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS libraries (ws, among others) call require(); ESM output has none.
  banner: {
    js: "import { createRequire as __pitdeckCreateRequire } from 'node:module';\nconst require = __pitdeckCreateRequire(import.meta.url);",
  },
});
await writeFile(join(here, 'build-meta.json'), JSON.stringify(result.metafile));

// sqlite-wasm finds its .wasm with new URL('sqlite3.wasm', import.meta.url).
const require = createRequire(join(packages, 'sql-guard/package.json'));
const sqliteDir = dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json'));
await copyFile(join(sqliteDir, 'dist/sqlite3.wasm'), join(dist, 'sqlite3.wasm'));

await cp(join(packages, 'dashboard/dist'), join(dist, 'dashboard'), { recursive: true });

await mkdir(join(dist, 'fixtures'));
for (const name of ['snap.sqlite', 'snap.sqlite-wal', 'plain.sqlite']) {
  await copyFile(
    join(packages, 'db-sqlite/src/testing/fixtures', name),
    join(dist, 'fixtures', name),
  );
}

await writeFile(join(dist, 'licenses.md'), await licences(Object.keys(result.metafile.inputs)));

/** The licence text of every npm package the bundle took code from. */
async function licences(inputs) {
  const roots = new Map();
  for (const input of inputs) {
    const parts = join(here, input).split(sep);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const name = parts[at + 1]?.startsWith('@')
      ? parts.slice(at + 1, at + 3).join('/')
      : parts[at + 1];
    const end = at + 1 + (name?.split('/').length ?? 0);
    if (name !== undefined) roots.set(name, parts.slice(0, end).join(sep));
  }
  const sections = [];
  for (const [name, root] of [...roots].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const file = (await readdir(root)).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    if (typeof pkg.license !== 'string') throw new Error(`No licence named by ${name}`);
    // A few packages (sqlite-wasm) ship no licence file: name the licence instead.
    const text =
      file === undefined
        ? `The package ships no licence file. Its package.json names ${pkg.license}: https://spdx.org/licenses/${pkg.license}.html`
        : (await readFile(join(root, file), 'utf8')).trim();
    sections.push(`## ${name} - ${pkg.version} (${pkg.license})\n\n${text}\n`);
  }
  return `# Licenses\n\nThe pitdeck command bundles these libraries. The dashboard's libraries are listed in dashboard/licenses.md.\n\n${sections.join('\n')}`;
}
