/**
 * The licences of the bundled libraries (dist/licenses.md, written by build.mjs through
 * licences.mjs). Apache-2.0 and similar licences require their text to travel with the
 * code, so a section that only names a licence or links to it is not enough (finding F2).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const LICENSES_DIR = join(PKG_DIR, 'licenses');

interface LicencesModule {
  licencesMarkdown: (
    inputs: readonly string[],
    base: string,
    licensesDir: string,
  ) => Promise<string>;
}

const isLicencesModule = (mod: unknown): mod is LicencesModule =>
  typeof mod === 'object' &&
  mod !== null &&
  'licencesMarkdown' in mod &&
  typeof mod.licencesMarkdown === 'function';

async function load(): Promise<LicencesModule> {
  const mod: unknown = await import(pathToFileURL(join(PKG_DIR, 'licences.mjs')).href);
  if (!isLicencesModule(mod)) throw new Error('licences.mjs exports no licencesMarkdown');
  return mod;
}

/** `## name - version (licence)` headings and the text under each. */
function sections(markdown: string): { heading: string; body: string }[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const [heading = '', ...rest] = part.split('\n');
      return { heading, body: rest.join('\n').trim() };
    });
}

describe('dist/licenses.md (run pnpm build first)', () => {
  it('holds licence text for every bundled library, not just a name or a URL', async () => {
    const all = sections(await readFile(join(PKG_DIR, 'dist/licenses.md'), 'utf8'));
    expect(all.length).toBeGreaterThan(0);
    for (const { heading, body } of all) {
      // The shortest licence here (ISC) is about 700 characters without its URLs.
      expect(body.replace(/https?:\/\/\S+/g, '').trim().length, heading).toBeGreaterThan(300);
      expect(body, heading).not.toMatch(/ships no licen[cs]e file/i);
    }
  });

  it('holds the full Apache-2.0 text for sqlite-wasm, which ships no licence file', async () => {
    const all = sections(await readFile(join(PKG_DIR, 'dist/licenses.md'), 'utf8'));
    const sqlite = all.find((s) => s.heading.startsWith('@sqlite.org/sqlite-wasm '));
    const apache = (await readFile(join(LICENSES_DIR, 'Apache-2.0.txt'), 'utf8')).trim();
    expect(sqlite?.body).toBe(apache);
  });
});

describe('licencesMarkdown', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'pitdeck-licences-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** A package under base/node_modules with one source file; returns that file's input path. */
  async function pkg(
    dir: string,
    manifest: Record<string, string>,
    licence?: string,
  ): Promise<string> {
    const root = join(base, dir);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'index.js'), '');
    if (licence !== undefined) await writeFile(join(root, 'LICENSE'), licence);
    return `${dir}/index.js`;
  }

  it('embeds the vendored text for a package that ships no licence file', async () => {
    const { licencesMarkdown } = await load();
    const input = await pkg('node_modules/nofile', {
      name: 'nofile',
      version: '1.0.0',
      license: 'Apache-2.0',
    });
    const md = await licencesMarkdown([input], base, LICENSES_DIR);
    const apache = (await readFile(join(LICENSES_DIR, 'Apache-2.0.txt'), 'utf8')).trim();
    expect(sections(md)).toEqual([{ heading: 'nofile - 1.0.0 (Apache-2.0)', body: apache }]);
  });

  it('fails when no licence text can be found', async () => {
    const { licencesMarkdown } = await load();
    const input = await pkg('node_modules/nofile', {
      name: 'nofile',
      version: '1.0.0',
      license: 'Made-Up-1.0',
    });
    await expect(licencesMarkdown([input], base, LICENSES_DIR)).rejects.toThrow(
      /No licence text for nofile@1\.0\.0 \(Made-Up-1\.0\)/,
    );
  });

  it('never reads a licence path outside the vendored folder', async () => {
    const { licencesMarkdown } = await load();
    const input = await pkg('node_modules/nofile', {
      name: 'nofile',
      version: '1.0.0',
      license: '../../package',
    });
    await expect(licencesMarkdown([input], base, LICENSES_DIR)).rejects.toThrow(
      /No licence text for nofile@1\.0\.0/,
    );
  });
});
