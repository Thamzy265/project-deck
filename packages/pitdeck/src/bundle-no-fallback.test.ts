/**
 * Findings O1 and O2: a copy of dist/ that is missing one of its own files must fail with
 * a clear error, never load a look-alike `@project-deck/*` package (users don't own that
 * npm scope) or a source-folder file from outside the bundle. Every look-alike is put
 * where the workspace build's fallback would find it: on NODE_PATH, in a node_modules
 * folder up the tree, and at `../src/testing/fixtures/`. Only 127.0.0.1 is contacted;
 * HOME points into the scratch folder.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const LOOKALIKE = 'LOOKALIKE: loaded from outside the bundle';

const scratches: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((done) => child.once('exit', done));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
  }
  for (const dir of scratches.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Layout {
  scratch: string;
  bundle: string;
  project: string;
  home: string;
  /** Holds look-alike packages; given as NODE_PATH and also as node_modules up the tree. */
  modules: string;
}

/** A copy of dist/ at <scratch>/install/dist without `remove`, plus look-alike packages. */
async function layout(remove: string): Promise<Layout> {
  const scratch = await mkdtemp(join(tmpdir(), 'pitdeck-no-fallback-'));
  scratches.push(scratch);
  const bundle = join(scratch, 'install', 'dist');
  await cp(DIST, bundle, { recursive: true });
  await rm(join(bundle, remove), { recursive: true });
  const modules = join(scratch, 'node_modules');
  const files: Record<string, string> = {
    'node_modules/@project-deck/daemon/package.json': JSON.stringify({
      name: '@project-deck/daemon',
      type: 'module',
      exports: { './main': './dist/main.js' },
    }),
    // Leaves a marker if it is ever started.
    'node_modules/@project-deck/daemon/dist/main.js': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(scratch, 'lookalike-ran'))}, 'yes');\n`,
    'node_modules/@project-deck/dashboard/package.json': JSON.stringify({
      name: '@project-deck/dashboard',
      exports: { './package.json': './package.json' },
    }),
    'node_modules/@project-deck/dashboard/dist/index.html': LOOKALIKE,
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), body);
  }
  // The workspace build's fixture fallback, relative to a chunk in install/dist/.
  const sourceFixtures = join(scratch, 'src', 'testing', 'fixtures');
  await mkdir(sourceFixtures, { recursive: true });
  for (const name of ['snap.sqlite', 'snap.sqlite-wal', 'plain.sqlite']) {
    await copyFile(join(DIST, 'fixtures', name), join(sourceFixtures, name));
  }
  const project = join(scratch, 'project');
  await mkdir(join(project, '.pitdeck'), { recursive: true });
  await writeFile(join(project, '.pitdeck', 'config.json'), '{"version":1}\n');
  const home = join(scratch, 'home');
  await mkdir(home);
  return { scratch, bundle, project, home, modules };
}

function run(l: Layout, script: string, args: string[]): { child: ChildProcess; output: string[] } {
  const output: string[] = [];
  const child = spawn(process.execPath, [join(l.bundle, script), ...args], {
    cwd: l.project,
    env: { ...process.env, NODE_PATH: l.modules, HOME: l.home, USERPROFILE: l.home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.on('error', (err) => output.push(err.message));
  child.stdout.on('data', (d: Buffer) => output.push(String(d)));
  child.stderr.on('data', (d: Buffer) => output.push(String(d)));
  return { child, output };
}

async function exitCode(child: ChildProcess, ms: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const code = new Promise<number | null>((done) => child.once('exit', (c) => done(c)));
  return Promise.race([code, sleep(ms).then(() => 'timeout' as const)]).then((c) => {
    if (c === 'timeout') throw new Error('the process did not exit in time');
    return c;
  });
}

describe('the bundle with one of its own files missing (run pnpm build first)', () => {
  it('has the bundle flag compiled in', async () => {
    // build.mjs defines __PITDECK_BUNDLE__; a name left over means the define was lost.
    for (const name of await readdir(DIST)) {
      if (!name.endsWith('.js')) continue;
      const text = await readFile(join(DIST, name), 'utf8');
      expect(text.includes('__PITDECK_BUNDLE__'), name).toBe(false);
    }
  });

  it('refuses to start without dashboard/index.html, with a clear error', async () => {
    const l = await layout('dashboard');
    const { child, output } = run(l, 'daemon.js', ['--fake', '--port', '0']);
    expect(await exitCode(child, 20_000)).toBe(1);
    const text = output.join('');
    expect(text).toContain('The pitdeck package is incomplete');
    expect(text).toContain(join('dashboard', 'index.html'));
    expect(text).not.toContain('listening');
  });

  it('pitdeck start refuses to start a look-alike daemon without daemon.js', async () => {
    const l = await layout('daemon.js');
    const { child, output } = run(l, 'cli.js', ['start']);
    expect(await exitCode(child, 30_000)).toBe(1);
    expect(output.join('')).toContain('The pitdeck package is incomplete');
    await expect(readFile(join(l.scratch, 'lookalike-ran'))).rejects.toThrow();
  });

  // Was "answers not-found for that database": finding F7 makes a missing fixture fail the
  // start, like a missing dashboard, so the user sees what is wrong.
  it('never reads a fake-mode fixture from outside the bundle, and says so at start', async () => {
    const l = await layout(join('fixtures', 'plain.sqlite'));
    const { child, output } = run(l, 'daemon.js', ['--fake', '--port', '0']);
    expect(await exitCode(child, 20_000)).toBe(1);
    const text = output.join('');
    expect(text).toContain('The pitdeck package is incomplete');
    expect(text).toContain(join('fixtures', 'plain.sqlite'));
    expect(text).not.toContain('listening');
    await expect(readFile(join(l.project, '.pitdeck', 'runtime.json'))).rejects.toThrow();
  });
});
