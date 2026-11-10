import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DashboardAsset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

/** URL path ('/' for the page) to file. Only these exact paths are ever served. */
export type DashboardAssets = ReadonlyMap<string, DashboardAsset>;

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function read(path: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(path));
}

/**
 * The built dashboard: a `dashboard/` folder next to this code (the `pitdeck` npm bundle
 * copies it there), else the dist folder of `@project-deck/dashboard` (the workspace), or
 * undefined if neither exists. `here` is a test seam for this file's URL.
 */
export function defaultDashboardDir(here: URL | string = import.meta.url): string | undefined {
  const bundled = fileURLToPath(new URL('dashboard', here));
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  try {
    const pkg = createRequire(here).resolve('@project-deck/dashboard/package.json');
    return join(dirname(pkg), 'dist');
  } catch {
    return undefined;
  }
}

/**
 * Reads the built dashboard into memory once at start: `index.html` and the files directly
 * in `assets/` with a known type. Serving from a fixed map means no request path ever
 * reaches the file system. Undefined when there is no `index.html` (not built).
 */
export async function loadDashboardAssets(dir: string): Promise<DashboardAssets | undefined> {
  let index: Uint8Array<ArrayBuffer>;
  try {
    index = await read(join(dir, 'index.html'));
  } catch {
    return undefined;
  }
  const assets = new Map<string, DashboardAsset>([
    ['/', { body: index, type: 'text/html; charset=utf-8' }],
  ]);
  const entries = await readdir(join(dir, 'assets'), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const type = TYPES[extname(entry.name)];
    if (!entry.isFile() || type === undefined) continue;
    assets.set(`/assets/${entry.name}`, {
      body: await read(join(dir, 'assets', entry.name)),
      type,
    });
  }
  return assets;
}
