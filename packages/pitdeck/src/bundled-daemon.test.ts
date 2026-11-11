/**
 * The bundled daemon (dist/daemon.js, `--fake`) run from a copy of dist/ outside the
 * workspace, with the user's project as its current folder. The project holds look-alike
 * files for every asset the bundle finds next to itself (dashboard/, fixtures/,
 * sqlite3.wasm, the workers, daemon.js): the bundle must use its own and never these.
 * Only 127.0.0.1 is contacted; HOME points into the scratch folder.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const POISON = 'POISON: read from the current folder';

const DECOYS: Record<string, string> = {
  'dashboard/index.html': POISON,
  'dashboard/assets/index-AAAAAAAA.js': `throw new Error(${JSON.stringify(POISON)})`,
  'dist/dashboard/index.html': POISON,
  'fixtures/snap.sqlite': POISON,
  'fixtures/snap.sqlite-wal': POISON,
  'fixtures/plain.sqlite': POISON,
  'sqlite3.wasm': POISON,
  'guard-worker.js': `throw new Error(${JSON.stringify(POISON)})`,
  'snapshot-worker.js': `throw new Error(${JSON.stringify(POISON)})`,
  'daemon.js': `throw new Error(${JSON.stringify(POISON)})`,
};

const Runtime = z.object({ port: z.number(), token: z.string() });

/**
 * The test's environment without NODE_PATH: pnpm's vitest launcher sets it to this
 * workspace's packages, which would let the copied bundle resolve them and hide a
 * missing bundled file.
 */
function isolatedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env['NODE_PATH'];
  return env;
}

let scratch = '';
let project = '';
let bundle = '';
let daemon: ChildProcess | undefined;
let port = 0;
let token = '';
const output: string[] = [];

const api = (path: string, init: { method?: string; body?: string } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'x-deck-token': token, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

const query = async (db: string, sql: string): Promise<unknown> =>
  (await api('/api/db/query', { method: 'POST', body: JSON.stringify({ db, sql }) })).json();

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'pitdeck-bundled-daemon-'));
  bundle = join(scratch, 'install', 'dist');
  project = join(scratch, 'project');
  await cp(DIST, bundle, { recursive: true });
  for (const [path, body] of Object.entries(DECOYS)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), body);
  }
  await mkdir(join(project, '.pitdeck'), { recursive: true });
  await mkdir(join(scratch, 'home'));
  daemon = spawn(
    process.execPath,
    [join(bundle, 'daemon.js'), '--fake', '--port', '0', '--project', project],
    {
      cwd: project,
      env: isolatedEnv({ HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home') }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  daemon.on('error', (err) => output.push(err.message));
  daemon.stdout?.on('data', (d: Buffer) => output.push(String(d)));
  daemon.stderr?.on('data', (d: Buffer) => output.push(String(d)));
  const end = Date.now() + 20_000;
  for (;;) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited: ${output.join('')}`);
    try {
      const runtime = Runtime.parse(
        JSON.parse(await readFile(join(project, '.pitdeck', 'runtime.json'), 'utf8')),
      );
      ({ port, token } = runtime);
      break;
    } catch {
      if (Date.now() > end) throw new Error(`no runtime.json: ${output.join('')}`);
      await sleep(200);
    }
  }
  // The fake app attaches by itself shortly after start.
  for (;;) {
    const status = z
      .object({ attached: z.unknown().optional() })
      .parse(await (await api('/api/status')).json());
    if (status.attached !== undefined && status.attached !== null) break;
    if (Date.now() > end) throw new Error('the fake app never attached');
    await sleep(200);
  }
}, 30_000);

afterAll(async () => {
  if (daemon !== undefined && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise((done) => daemon?.once('exit', done));
    daemon.kill();
    await Promise.race([exited, sleep(5000)]);
  }
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

describe('the bundled daemon, run from the user project (run pnpm build first)', () => {
  it('serves its own dashboard, not one in the current folder', async () => {
    expect((await api('/api/login-window', { method: 'POST' })).ok).toBe(true);
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain('POISON');
    expect(html).toBe(await readFile(join(bundle, 'dashboard', 'index.html'), 'utf8'));
  });

  it('reads the fake snapshot databases from its own fixtures with its own wasm', async () => {
    // snap.sqlite plus its WAL holds 3 orders; plain.sqlite holds 2 (make-fixtures.sql).
    expect(await query('app_flutter/app.sqlite', 'SELECT count(*) FROM orders')).toMatchObject({
      rows: [[3]],
    });
    expect(await query('databases/legacy.db', 'SELECT count(*) FROM orders')).toMatchObject({
      rows: [[2]],
    });
  });

  it.each([
    ['app', 'DELETE FROM orders'],
    ['app', "ATTACH DATABASE 'x.db' AS x"],
    ['app', 'PRAGMA user_version = 3'],
    ['app', 'SELECT 1; DELETE FROM orders'],
    ['app_flutter/app.sqlite', 'DELETE FROM orders'],
    ['app_flutter/app.sqlite', 'PRAGMA journal_mode = DELETE'],
  ])('refuses %s: %s through its own guard worker', async (db, sql) => {
    expect(await query(db, sql)).toMatchObject({ code: 'refused' });
  });

  it('still has every order after the refused writes', async () => {
    const rows = await query('app', 'SELECT count(*) FROM orders');
    expect(rows).toMatchObject({ rows: [[expect.any(Number)]] });
    expect(
      z.object({ rows: z.array(z.tuple([z.number()])) }).parse(rows).rows[0]?.[0],
    ).toBeGreaterThanOrEqual(2);
    expect(output.join('')).not.toContain('POISON');
  });
});
