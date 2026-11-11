// Writes dist/licenses.md for build.mjs: the licence text of every npm package the bundle
// took code from. Not published (only dist/ is).
import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

/**
 * @param {readonly string[]} inputs esbuild metafile input paths, relative to `base`
 * @param {string} base esbuild's working directory
 * @param {string} licensesDir vendored licence texts, named `<SPDX id>.txt`
 * @returns {Promise<string>}
 */
export async function licencesMarkdown(inputs, base, licensesDir) {
  // Every package folder the bundle took code from. Two versions of one package (one
  // nested under another's node_modules) are both bundled, so both are listed.
  const roots = new Set();
  for (const input of inputs) {
    const parts = join(base, input).split(sep);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const name = parts[at + 1]?.startsWith('@')
      ? parts.slice(at + 1, at + 3).join('/')
      : parts[at + 1];
    if (name !== undefined) roots.add(parts.slice(0, at + 1 + name.split('/').length).join(sep));
  }
  // Keyed by name@version: one version found at two paths is listed once.
  const packages = new Map();
  for (const root of roots) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    if (typeof pkg.license !== 'string') throw new Error(`No licence named by ${id} (${root})`);
    if (!packages.has(id)) packages.set(id, { root, pkg });
  }
  const sections = [];
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...packages.values()].sort(
    (a, b) => order(a.pkg.name, b.pkg.name) || order(a.pkg.version, b.pkg.version),
  );
  for (const { root, pkg } of sorted) {
    const text = await licenceText(root, pkg, licensesDir);
    sections.push(`## ${pkg.name} - ${pkg.version} (${pkg.license})\n\n${text}\n`);
  }
  return `# Licenses\n\nThe pitdeck command bundles these libraries. The dashboard's libraries are listed in dashboard/licenses.md.\n\n${sections.join('\n')}`;
}

/**
 * The package's own licence file, or, for the few that ship none (sqlite-wasm), the
 * vendored text of the licence its package.json names. Apache-2.0 and the like require the
 * text itself to travel with the code, so a name or a URL alone fails the build.
 */
async function licenceText(root, pkg, licensesDir) {
  const file = (await readdir(root)).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (file !== undefined) return (await readFile(join(root, file), 'utf8')).trim();
  const missing = new Error(
    `No licence text for ${pkg.name}@${pkg.version} (${pkg.license}): it ships no licence file; add the official text as packages/pitdeck/licenses/<SPDX id>.txt`,
  );
  // A plain SPDX id only: an expression or a path never picks a file.
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(pkg.license)) throw missing;
  try {
    return (await readFile(join(licensesDir, `${pkg.license}.txt`), 'utf8')).trim();
  } catch (err) {
    if (err?.code === 'ENOENT') throw missing;
    throw err;
  }
}
