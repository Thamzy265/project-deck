#!/usr/bin/env node
// Writes the contributors' marketplace, `pitdeck-dev`: a copy of plugin/ whose pitdeck MCP
// server runs this checkout's build instead of the npm release. The public marketplace at
// the repo root installs plugin/ from GitHub and never points at a checkout.
//
// Usage: pnpm build && node scripts/dev-marketplace.mjs [--out <folder>] [--cli <cli.js>]
//   --out  default plugin-dev/marketplace (git-ignored)
//   --cli  default packages/pitdeck/dist/cli.js (the bundle that npm users get)
// Then, once: claude plugin marketplace add <out>; claude plugin install pitdeck@pitdeck-dev
// Run it again after changing plugin/ or rebuilding; a new session (or /reload-plugins)
// loads the change, because a marketplace added from a folder loads its plugins in place.
//
// Safety: it writes only <out>, and replaces <out> only if this script wrote it before.
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '.pitdeck-dev-marketplace';
const NAME = 'pitdeck-dev';

const { values } = parseArgs({
  options: { out: { type: 'string' }, cli: { type: 'string' } },
});
const out = resolve(values.out ?? join(ROOT, 'plugin-dev', 'marketplace'));
const cli = resolve(values.cli ?? join(ROOT, 'packages', 'pitdeck', 'dist', 'cli.js'));

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

function fail(message) {
  console.error(message);
  process.exit(1);
}

// True when `path` is `folder` or lies inside it.
const within = (folder, path) => {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const source = join(ROOT, 'plugin');

// Check every argument before anything is deleted or written.
if (within(source, out) || within(out, source))
  fail(`--out ${out} overlaps plugin/, which this script copies; pick a folder outside it.`);
if (within(out, cli))
  fail(`--cli ${cli} is inside --out ${out}, which this script replaces; pick another --cli.`);
if (!(await exists(cli))) fail(`No CLI build at ${cli}. Run \`pnpm build\` first.`);
if ((await exists(out)) && !(await exists(join(out, MARKER))))
  fail(`${out} exists and was not written by this script; pick another --out.`);

await rm(out, { recursive: true, force: true });
const plugin = join(out, 'pitdeck');
await mkdir(join(out, '.claude-plugin'), { recursive: true });
await cp(source, plugin, { recursive: true });

const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
mcp.mcpServers.pitdeck = { type: 'stdio', command: 'node', args: [cli, 'mcp'] };
await writeFile(join(plugin, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);

const market = {
  name: NAME,
  owner: { name: 'Pitdeck contributors' },
  description: `Development only: Pitdeck from the checkout at ${ROOT}, written by scripts/dev-marketplace.mjs.`,
  plugins: [
    {
      name: 'pitdeck',
      source: './pitdeck',
      description: 'Pitdeck from this checkout; its MCP server runs the local build.',
    },
  ],
};
await writeFile(
  join(out, '.claude-plugin', 'marketplace.json'),
  `${JSON.stringify(market, null, 2)}\n`,
);
await writeFile(join(out, MARKER), 'Written by scripts/dev-marketplace.mjs; safe to delete.\n');

console.log(`Wrote the ${NAME} marketplace to ${out}`);
console.log(`Its pitdeck MCP server runs: node ${cli} mcp`);
console.log('First time only (not with the public pitdeck@pitdeck installed):');
console.log(`  claude plugin marketplace add "${out}"`);
console.log(`  claude plugin install pitdeck@${NAME}`);
console.log('After a change: run this script again, then start a new session or /reload-plugins.');
