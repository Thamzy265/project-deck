import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDashboardDir, loadDashboardAssets } from './dashboard-assets.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function built(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-dash-'));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

describe('loadDashboardAssets', () => {
  it('maps index.html to / and assets to their URL paths with content types', async () => {
    const dir = await built({
      'index.html': '<!doctype html><div id="root"></div>',
      'assets/index-abc.js': 'console.log(1)',
      'assets/index-abc.css': 'body{}',
      'assets/logo.svg': '<svg/>',
      'assets/notes.txt': 'not served',
    });
    const assets = await loadDashboardAssets(dir);
    expect([...(assets?.keys() ?? [])].sort()).toEqual([
      '/',
      '/assets/index-abc.css',
      '/assets/index-abc.js',
      '/assets/logo.svg',
    ]);
    expect(assets?.get('/')?.type).toBe('text/html; charset=utf-8');
    expect(assets?.get('/assets/index-abc.js')?.type).toBe('text/javascript; charset=utf-8');
    expect(assets?.get('/assets/index-abc.css')?.type).toBe('text/css; charset=utf-8');
    expect(Buffer.from(assets?.get('/assets/index-abc.js')?.body ?? []).toString()).toBe(
      'console.log(1)',
    );
  });

  it('returns undefined when the dashboard has not been built', async () => {
    expect(await loadDashboardAssets(await built({}))).toBeUndefined();
    expect(await loadDashboardAssets(join(tmpdir(), 'deck-missing-dir'))).toBeUndefined();
  });

  it('skips sub-folders inside assets', async () => {
    const dir = await built({ 'index.html': 'x', 'assets/deep/a.js': 'x' });
    expect([...((await loadDashboardAssets(dir))?.keys() ?? [])]).toEqual(['/']);
  });

  it('finds the dashboard package dist folder', () => {
    expect(defaultDashboardDir()).toMatch(/dashboard[\\/]dist$/);
  });
});
