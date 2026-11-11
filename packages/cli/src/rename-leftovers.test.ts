/**
 * The FlutterDeck -> Pitdeck rename (M5 batch 1) moved every state folder with no migration.
 * These tests pin what must stay true on a machine or project that still has the old names:
 * `init` writes only under the new names, never reads or writes the old folders, and the
 * `.gitignore` block it adds really ignores what the daemon and the hook use.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_DIR, RUNTIME_FILE, STATE_DIR } from '@project-deck/core/node';
import { DAEMON_LOG } from '@project-deck/mcp';
import { GITIGNORE_BEGIN, IGNORED, addIgnoreBlock } from './gitignore.js';
import { runInit } from './init.js';

// Old install, as an old CLI wrote it. The marker is the old CLI name.
const OLD_BLOCK = [
  '# >>> flutterdeck (added by `flutterdeck init`)',
  '.flutterdeck/state.json',
  '.flutterdeck/runtime.json',
  '.flutterdeck/daemon.log',
  '.flutterdeck/*.lock',
  '.flutterdeck/*.tmp',
  '.flutterdeck/*.stale',
  '# <<< flutterdeck',
  '',
].join('\n');
const OLD_TOKEN = 'old-secret-token-for-test';

let base: string;
let project: string;
let home: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'deck-rename-'));
  project = join(base, 'app');
  home = join(base, 'home');
  await mkdir(project);
  await mkdir(home);
  await writeFile(
    join(project, 'pubspec.yaml'),
    'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
  );
});

afterEach(() => rm(base, { recursive: true, force: true }));

const init = () =>
  runInit({
    projectDir: project,
    homeDir: home,
    run: () => Promise.reject(new Error('not installed')),
    cliMainPath: '/opt/deck/main.js',
    isFree: () => Promise.resolve(true),
    io: { out: () => undefined, err: () => undefined },
  });

// Without the caller's GIT_* variables (GIT_DIR from `git rebase --exec` or a hook), git
// works on the scratch project, never on the caller's repository (finding F1).
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (...args: string[]) =>
  spawnSync('git', args, { cwd: project, env: gitEnv(), encoding: 'utf8', windowsHide: true });
const hasGit = spawnSync('git', ['--version']).status === 0;
const ignored = (path: string): boolean => git('check-ignore', '-q', path).status === 0;

async function listAll(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    out.push(rel);
    if (entry.isDirectory()) out.push(...(await listAll(join(dir, entry.name), `${rel}/`)));
  }
  return out;
}

describe('names that must agree across packages', () => {
  it('uses .pitdeck for the project state folder and the per-user registry', () => {
    expect(STATE_DIR).toBe('.pitdeck');
    expect(REGISTRY_DIR).toBe('.pitdeck');
  });

  it('writes every .gitignore pattern under the folder the daemon uses', () => {
    for (const pattern of IGNORED) expect(pattern.startsWith(`${STATE_DIR}/`)).toBe(true);
  });

  it('names the runtime, log and lock files that the ignore block lists', () => {
    const listed = IGNORED.map((p) => p.slice(STATE_DIR.length + 1));
    expect(listed).toContain(RUNTIME_FILE);
    expect(listed).toContain(DAEMON_LOG);
    expect(listed).toContain('*.lock');
  });

  it('puts the same marker in the block and in `pitdeck init`', () => {
    expect(GITIGNORE_BEGIN).toBe('# >>> pitdeck (added by `pitdeck init`)');
  });
});

describe.skipIf(!hasGit)('the ignore block against real git', () => {
  beforeEach(() => {
    expect(git('init', '-q').status).toBe(0);
  });

  it('ignores the token, log, lock and temp files and keeps config.json visible', async () => {
    await writeFile(join(project, '.gitignore'), addIgnoreBlock(undefined) ?? '');
    for (const name of [
      RUNTIME_FILE,
      'state.json',
      DAEMON_LOG,
      'startup.lock',
      'init.lock',
      'x.tmp',
      'startup.lock.1.abcd.stale',
    ]) {
      expect(ignored(`${STATE_DIR}/${name}`), name).toBe(true);
    }
    expect(ignored(`${STATE_DIR}/config.json`)).toBe(false);
  });

  it('still ignores .pitdeck/runtime.json when the file holds the old FlutterDeck block', async () => {
    await writeFile(join(project, '.gitignore'), `build/\n${OLD_BLOCK}`);
    // The old block ignores the old folder only: the new one needs its own block.
    expect(ignored('.pitdeck/runtime.json')).toBe(false);
    const next = addIgnoreBlock(await readFile(join(project, '.gitignore'), 'utf8'));
    expect(next).toBeDefined();
    await writeFile(join(project, '.gitignore'), next ?? '');
    expect(ignored('.pitdeck/runtime.json')).toBe(true);
    expect(ignored('.flutterdeck/runtime.json')).toBe(true);
    expect(next?.startsWith(`build/\n${OLD_BLOCK}`)).toBe(true);
  });
});

describe('a leftover FlutterDeck install', () => {
  beforeEach(async () => {
    await mkdir(join(project, '.flutterdeck'));
    await writeFile(join(project, '.flutterdeck', 'runtime.json'), `{"token":"${OLD_TOKEN}"}`);
    await writeFile(join(project, '.flutterdeck', 'config.json'), '{"version":1,"port":9300}');
    await mkdir(join(home, '.flutterdeck'));
    await writeFile(join(home, '.flutterdeck', 'ports.json'), '{"version":1,"salt":"x"}');
    await writeFile(join(project, '.gitignore'), OLD_BLOCK);
  });

  it('runs init without a crash and leaves the old folders byte for byte alone', async () => {
    const oldProject = await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8');
    const oldRegistry = await readFile(join(home, '.flutterdeck', 'ports.json'), 'utf8');
    expect(await init()).toBe(0);
    expect(await listAll(join(project, '.flutterdeck'))).toEqual(['config.json', 'runtime.json']);
    expect(await listAll(join(home, '.flutterdeck'))).toEqual(['ports.json']);
    expect(await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8')).toBe(oldProject);
    expect(await readFile(join(home, '.flutterdeck', 'ports.json'), 'utf8')).toBe(oldRegistry);
  });

  it('creates the new state and registry under .pitdeck and writes no token to the old paths', async () => {
    expect(await init()).toBe(0);
    expect((await stat(join(project, '.pitdeck', 'config.json'))).isFile()).toBe(true);
    expect((await stat(join(home, '.pitdeck', 'ports.json'))).isFile()).toBe(true);
    const inProject = (await listAll(project)).filter((p) => p.includes('flutterdeck')).sort();
    const inHome = (await listAll(home)).filter((p) => p.includes('flutterdeck')).sort();
    expect(inProject).toEqual([
      '.flutterdeck',
      '.flutterdeck/config.json',
      '.flutterdeck/runtime.json',
    ]);
    expect(inHome).toEqual(['.flutterdeck', '.flutterdeck/ports.json']);
    // The new config does not inherit the old port or token.
    const config = await readFile(join(project, '.pitdeck', 'config.json'), 'utf8');
    expect(config).not.toContain(OLD_TOKEN);
  });

  it('adds one new ignore block on a second run, never a third, and keeps the old block', async () => {
    expect(await init()).toBe(0);
    const once = await readFile(join(project, '.gitignore'), 'utf8');
    expect(await init()).toBe(0);
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe(once);
    expect(once.startsWith(OLD_BLOCK)).toBe(true);
    expect(once.split(GITIGNORE_BEGIN).length - 1).toBe(1);
    expect(once).toContain('.pitdeck/runtime.json');
  });

  it('keeps init idempotent: a second run changes no file under .pitdeck or the home registry', async () => {
    expect(await init()).toBe(0);
    const config = await readFile(join(project, '.pitdeck', 'config.json'), 'utf8');
    const registry = await readFile(join(home, '.pitdeck', 'ports.json'), 'utf8');
    expect(await init()).toBe(0);
    expect(await readFile(join(project, '.pitdeck', 'config.json'), 'utf8')).toBe(config);
    expect(await readFile(join(home, '.pitdeck', 'ports.json'), 'utf8')).toBe(registry);
  });
});

describe.skipIf(!hasGit)('git under a caller that exports GIT_* variables', () => {
  // `git rebase --exec` and hooks export GIT_DIR and friends. A git spawned with them inherited
  // ran `init` against the caller's repository and rewrote its config (finding F1).
  const saved = { ...process.env };
  let outer: string;
  let outerConfig: string;

  beforeEach(async () => {
    outer = join(base, 'outer');
    await mkdir(outer);
    expect(git('-C', outer, 'init', '-q').status).toBe(0);
    outerConfig = await readFile(join(outer, '.git', 'config'), 'utf8');
    process.env.GIT_DIR = join(outer, '.git');
    process.env.GIT_WORK_TREE = outer;
    process.env.GIT_INDEX_FILE = join(outer, '.git', 'index');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_') && !(key in saved)) Reflect.deleteProperty(process.env, key);
    }
    Object.assign(process.env, saved);
  });

  it('runs git in the scratch project and leaves the outer repository config unchanged', async () => {
    expect(git('init', '-q').status).toBe(0);
    await writeFile(join(project, '.gitignore'), addIgnoreBlock(undefined) ?? '');
    expect(ignored(`${STATE_DIR}/${RUNTIME_FILE}`)).toBe(true);
    expect((await stat(join(project, '.git'))).isDirectory()).toBe(true);
    expect(await readFile(join(outer, '.git', 'config'), 'utf8')).toBe(outerConfig);
  });
});

describe.skipIf(!hasGit)("this repository's own .gitignore", () => {
  it('ignores the secret and runtime files under .pitdeck and none under the old folder name', async () => {
    const root = fileURLToPath(new URL('../../../.gitignore', import.meta.url));
    await writeFile(join(project, '.gitignore'), await readFile(root, 'utf8'));
    expect(git('init', '-q').status).toBe(0);
    for (const name of [
      RUNTIME_FILE,
      'state.json',
      DAEMON_LOG,
      'startup.lock',
      'x.tmp',
      'a.stale',
    ]) {
      expect(ignored(`${STATE_DIR}/${name}`), name).toBe(true);
    }
    expect(ignored(`${STATE_DIR}/config.json`)).toBe(false);
    // The root file also keeps the old .flutterdeck/ rules, so an old build's token is not committed.
    expect(await readFile(root, 'utf8')).toMatch(/^\.pitdeck\/runtime\.json$/m);
  });
});
