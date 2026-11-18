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
//   licenses.md         licence texts of the bundled libraries (the dashboard has its own);
//                       licenses/ holds the texts of the few that ship none
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { licencesMarkdown } from './licences.mjs';

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
  // Tells the code it runs from this bundle (IN_PITDECK_BUNDLE in core): its files must
  // then be next to it, and no @project-deck package is looked up through node_modules or
  // NODE_PATH (findings O1, O2). Set here at build time, so no file on the user's machine
  // can change it; tsc output leaves the name undeclared, which reads as false.
  define: { __PITDECK_BUNDLE__: 'true' },
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

await writeFile(
  join(dist, 'licenses.md'),
  await licencesMarkdown(Object.keys(result.metafile.inputs), here, join(here, 'licenses')),
);
